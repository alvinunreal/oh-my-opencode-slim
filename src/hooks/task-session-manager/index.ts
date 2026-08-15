import type { PluginInput } from '@opencode-ai/plugin';
import {
  BackgroundJobBoard,
  type BackgroundJobExecution,
  type BackgroundJobStore,
  type BackgroundJobSupervisor,
  deriveTaskSessionLabel,
  isInternalInitiatorPart,
  parseTaskIdFromTaskOutput,
  parseTaskStateFromOutput,
} from '../../utils';
import { isRecord as isObjectRecord } from '../../utils/guards';
import type { SessionLifecycle } from '../session-lifecycle';
import { isMessageWithParts, isUserMessageWithParts } from '../types';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  type InjectedTerminalJobs,
  type InjectionState,
  injectBackgroundJobBoard,
  MAX_PROCESSED_INJECTED_COMPLETIONS,
  reconcileInjectedTerminalJobs,
  stabilizeRunningTaskParts,
  updateFromInjectedCompletion,
} from './board-injection';
import { handleEvent } from './event-router';
import { createIdleReconciler } from './idle-reconciliation';
import { createIdleSessionTokens } from './idle-session-tokens';
import { createInputWaitTracker } from './input-wait-tracker';
import { createPendingCallTracker } from './pending-call-tracker';
import { createRuntimeStatusReconciler } from './runtime-status-reconciliation';
import { createTaskContextTracker } from './task-context-tracker';
import {
  handleToolExecuteAfter,
  handleToolExecuteBefore,
} from './tool-execute-hooks';

export { BACKGROUND_JOB_BOARD_METADATA_KEY } from './board-injection';

/**
 * Delay before reconciling idle sessions.
 * Gives late injected completions time to arrive within this window.
 * Completions arriving after the window are still dropped (the race is reduced, not eliminated).
 * ponytail: fixed timeout — event-driven confirmation would fully close the race but adds
 * significant complexity for a case that rarely exceeds this window in practice.
 */
const IDLE_RECONCILE_DELAY_MS = 15_000;

const RECOVERED_TASK_AGENT_FALLBACK = 'unknown';

function rehydrateHistoricalRunningTasks(
  messages: unknown[],
  backgroundJobBoard: BackgroundJobStore,
  shouldManageSession: (sessionID: string) => boolean,
  registerSessionAsOrchestrator?: (sessionID: string) => void,
): number {
  let rehydrated = 0;
  const managedOrchestratorSessionIDs = new Set<string>();

  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;
    if (message.info.agent !== 'orchestrator') continue;

    const parentSessionID = message.info.sessionID;
    if (!parentSessionID) continue;
    if (!shouldManageSession(parentSessionID)) {
      registerSessionAsOrchestrator?.(parentSessionID);
      if (!shouldManageSession(parentSessionID)) continue;
    }
    managedOrchestratorSessionIDs.add(parentSessionID);
  }

  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;

    const parentSessionID = message.info.sessionID;
    if (
      !parentSessionID ||
      !managedOrchestratorSessionIDs.has(parentSessionID)
    ) {
      continue;
    }

    for (const part of message.parts) {
      if (part.type !== 'tool' || part.tool !== 'task') continue;
      if (!isObjectRecord(part.state)) continue;

      const state = part.state;
      if (typeof state.output !== 'string') continue;
      if (!isObjectRecord(state.input) || state.input.background !== true) {
        continue;
      }

      const taskID = parseTaskIdFromTaskOutput(state.output);
      if (!taskID || parseTaskStateFromOutput(state.output) !== 'running') {
        continue;
      }
      if (backgroundJobBoard.get(taskID)) continue;

      const agent =
        typeof state.input.subagent_type === 'string' &&
        state.input.subagent_type.trim() !== ''
          ? state.input.subagent_type.trim()
          : RECOVERED_TASK_AGENT_FALLBACK;
      const description =
        typeof state.input.description === 'string'
          ? state.input.description
          : undefined;
      const prompt =
        typeof state.input.prompt === 'string' ? state.input.prompt : undefined;
      const label = deriveTaskSessionLabel({
        description,
        prompt,
        agentType: agent,
      });

      backgroundJobBoard.registerLaunch({
        taskID,
        parentSessionID,
        agent,
        description: label,
        objective: label,
        background: true,
        preserveRun: true,
        // Historical parts do not carry a trustworthy launch timestamp. Zero
        // also prevents this registration from looking like a live observation
        // to the first runtime-status reconciliation.
        now: 0,
      });
      rehydrated += 1;
    }
  }

  return rehydrated;
}

export function createTaskSessionManagerHook(
  _ctx: PluginInput,
  options: {
    strategy?: 'latest' | 'checkpoint-compatible';
    maxSessionsPerAgent: number;
    maxRetainedSnapshots: number;
    readContextMinLines?: number;
    readContextMaxFiles?: number;
    backgroundJobBoard?: BackgroundJobStore;
    backgroundJobSupervisor?: BackgroundJobSupervisor;
    shouldManageSession: (sessionID: string) => boolean;
    /** Register a session as orchestrator when the transform hook detects
     *  an orchestrator message but the session isn't in the agent map yet. */
    registerSessionAsOrchestrator?: (sessionID: string) => void;
    /** Optional guard: when provided, idle events for a session that is
     *  currently undergoing a foreground-fallback abort/re-prompt cycle
     *  will NOT trigger idle reconciliation. prevents marking a still-
     *  active child job as completed when the session was aborted for
     *  model fallback rather than natural completion. */
    isFallbackInProgress?: (sessionID: string) => boolean;
    /** True when foreground fallback could still recover the session
     *  (enabled, chain exists, chain not exhausted). Lets the event
     *  router defer terminal bookkeeping for persistent 401/410 errors
     *  until recovery is impossible. */
    willAttemptFallback?: (sessionID: string) => boolean;
    coordinator?: SessionLifecycle;
    /** Test seam only; production always uses the reconciliation delay. */
    idleReconcileDelayMs?: number;
    /** Test seam only; production uses the runtime reconciliation delay. */
    runtimeStatusReconcileDelayMs?: number;
  },
) {
  const backgroundJobBoard =
    options.backgroundJobBoard ??
    new BackgroundJobBoard({
      maxReusablePerAgent: options.maxSessionsPerAgent,
      readContextMinLines: options.readContextMinLines,
      readContextMaxFiles: options.readContextMaxFiles,
    });

  const pendingCallTracker = createPendingCallTracker();
  const taskContextTracker = createTaskContextTracker();

  const processedInjectedCompletions = new Set<string>();
  const processedInjectedCompletionOrder: string[] = [];
  const terminalJobsInjectedByParent = new Map<string, InjectedTerminalJobs>();
  const pendingInjectedTerminalJobsByParent = new Map<
    string,
    Map<string, BackgroundJobExecution>
  >();
  /** Managed sessions with a deferred inline 401/410 awaiting fallback outcome. */
  const deferredInlineErrors = new Set<string>();

  // Forward refs for circular deps — set after corresponding managers exist.
  // These are captured by closure in createIdleReconciler and only called
  // at runtime (event handlers), well after initialization completes.
  let getIdleSessionToken: (sessionID: string) => symbol = () => {
    throw new Error('unreachable: getIdleSessionToken not initialized');
  };
  let isCurrentIdleSessionToken: (
    sessionID: string,
    sessionToken: symbol,
  ) => boolean = () => false;
  let hasInputWait: (sessionID: string) => boolean = () => false;

  const idleReconciler = createIdleReconciler({
    backgroundJobBoard,
    reconcileInjectedTerminalJobs: (parentSessionID: string) =>
      reconcileInjectedTerminalJobs(injectionState, parentSessionID),
    // Fallback could not recover a deferred 401/410; drop the deferred
    // error and its injected-terminal tracking so the board shows the
    // failure and follow-up reconciliation keeps consistent state.
    onErrorTerminalize: (sessionID: string) => {
      deferredInlineErrors.delete(sessionID);
      terminalJobsInjectedByParent.delete(sessionID);
      pendingInjectedTerminalJobsByParent.delete(sessionID);
    },
    idleReconcileDelayMs:
      options.idleReconcileDelayMs ?? IDLE_RECONCILE_DELAY_MS,
    isFallbackInProgress: options.isFallbackInProgress,
    hasInputWait: (s) => hasInputWait(s),
    getIdleSessionToken: (s) => getIdleSessionToken(s),
    isCurrentIdleSessionToken: (s, t) => isCurrentIdleSessionToken(s, t),
    taskContextTracker,
  });
  const runtimeStatusReconciler = createRuntimeStatusReconciler({
    input: _ctx,
    backgroundJobBoard,
    delayMs: options.runtimeStatusReconcileDelayMs,
    taskContextTracker,
  });

  const idleSessionTokens = createIdleSessionTokens({
    onInvalidate: idleReconciler.onInvalidateIdle,
  });
  getIdleSessionToken = (s) => idleSessionTokens.getSessionToken(s);
  isCurrentIdleSessionToken = (s, t) =>
    idleSessionTokens.isCurrentSessionToken(s, t);

  const inputWaits = createInputWaitTracker({
    shouldManageSession: options.shouldManageSession,
    invalidateIdle: (sessionID) => idleSessionTokens.invalidate(sessionID),
  });
  hasInputWait = (s) => inputWaits.hasInputWait(s);

  if (options.coordinator) {
    options.coordinator.onSessionDeleted((sessionId) => {
      // Fallback teardown keeps process-global wait_for_user; genuine delete
      // clears it via clearSession.
      if (options.isFallbackInProgress?.(sessionId)) {
        idleSessionTokens.invalidate(sessionId);
      } else {
        idleSessionTokens.clearSession(sessionId);
      }
      inputWaits.clearInputWaits(sessionId);
      idleReconciler.clearIdleTimers(sessionId);
      // During a foreground fallback abort/re-prompt cycle, the session
      // is being torn down and immediately recreated with a fallback model.
      // Dropping the job from the board here would make the orchestrator
      // lose track of the task and report it as cancelled even though the
      // oracle actually completed.
      if (!options.isFallbackInProgress?.(sessionId)) {
        options.backgroundJobSupervisor?.onSessionDeleted(sessionId);
        const hardTimedOut =
          backgroundJobBoard.field(sessionId, 'deadlineExceededAt') !==
          undefined;
        if (!hardTimedOut) backgroundJobBoard.drop(sessionId);
        options.backgroundJobSupervisor?.clearParent(sessionId);
        backgroundJobBoard.clearParent(sessionId);
        if (!hardTimedOut) options.backgroundJobSupervisor?.drop(sessionId);
      }
      terminalJobsInjectedByParent.delete(sessionId);
      pendingInjectedTerminalJobsByParent.delete(sessionId);
      injectionState.retainedBoardSnapshots.delete(sessionId);
      injectionState.retainedTailBoards.delete(sessionId);
      taskContextTracker.clearSession(sessionId);
      taskContextTracker.prune(backgroundJobBoard);
      pendingCallTracker.clearSession(sessionId);
    });
  }

  const injectionState: InjectionState = {
    backgroundJobBoard,
    maxRetainedSnapshots: options.maxRetainedSnapshots,
    strategy: options.strategy ?? 'latest',
    processedInjectedCompletions,
    processedInjectedCompletionOrder,
    terminalJobsInjectedByParent,
    pendingInjectedTerminalJobsByParent,
    maxProcessedInjectedCompletions: MAX_PROCESSED_INJECTED_COMPLETIONS,
    metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
    shouldManageSession: options.shouldManageSession,
    taskContextTracker,
    retainedBoardSnapshots: new Map(),
    retainedTailBoards: new Map(),
  };

  return {
    beginUserWait: (sessionID: string): void => {
      inputWaits.beginUserWait(sessionID);
    },

    /**
     * Narrow exposure for the orchestrator-wake scheduler: true while a
     * question/permission is open or wait_for_user is latched.
     */
    hasInputWait: (sessionID: string): boolean => hasInputWait(sessionID),

    observeChatMessage: (input: unknown, output: unknown): void => {
      const inputMessage = isObjectRecord(input) ? input : undefined;
      const outputRecord = isObjectRecord(output) ? output : undefined;
      const outputMessage = isObjectRecord(outputRecord?.message)
        ? outputRecord.message
        : undefined;
      const sessionID =
        typeof outputMessage?.sessionID === 'string'
          ? outputMessage.sessionID
          : typeof inputMessage?.sessionID === 'string'
            ? inputMessage.sessionID
            : undefined;
      const parts = Array.isArray(outputRecord?.parts)
        ? outputRecord.parts
        : inputMessage?.parts;
      // Safe identity order (Oracle): input.messageID → output.message.id →
      // same-process output.message object → fail closed.
      const messageIdentity: string | object | undefined =
        typeof inputMessage?.messageID === 'string' &&
        inputMessage.messageID.length > 0
          ? inputMessage.messageID
          : typeof outputMessage?.id === 'string' && outputMessage.id.length > 0
            ? outputMessage.id
            : outputMessage;
      if (
        !sessionID ||
        messageIdentity === undefined ||
        (typeof outputMessage?.role === 'string' &&
          outputMessage.role !== 'user') ||
        !options.shouldManageSession(sessionID) ||
        !Array.isArray(parts) ||
        parts.some(isInternalInitiatorPart) ||
        !parts.some(
          (part) =>
            isObjectRecord(part) &&
            part.synthetic !== true &&
            !isInternalInitiatorPart(part) &&
            ((part.type === 'text' && typeof part.text === 'string') ||
              part.type === 'file' ||
              part.type === 'image'),
        )
      ) {
        return;
      }
      idleSessionTokens.onExternalUserMessage(sessionID, messageIdentity);
    },

    'tool.execute.before': (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args?: unknown },
    ): Promise<void> =>
      handleToolExecuteBefore(input, output, {
        shouldManageSession: options.shouldManageSession,
        registerSessionAsOrchestrator: options.registerSessionAsOrchestrator,
        backgroundJobBoard,
        backgroundJobSupervisor: options.backgroundJobSupervisor,
        pendingCallTracker,
        taskContextTracker,
      }),

    'tool.execute.after': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { output: unknown; metadata?: unknown },
    ): Promise<void> => {
      await handleToolExecuteAfter(input, output, {
        directory: _ctx.directory,
        backgroundJobBoard,
        backgroundJobSupervisor: options.backgroundJobSupervisor,
        pendingCallTracker,
        taskContextTracker,
      });
      runtimeStatusReconciler.schedule();
    },

    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];

      // Keep still-running task tool results byte-stable so a live background
      // lane never rewrites mid-history bytes and invalidates the prompt
      // cache. Terminal results are left untouched (they materialize once).
      stabilizeRunningTaskParts(messages);

      const rehydratedCount = rehydrateHistoricalRunningTasks(
        messages,
        backgroundJobBoard,
        options.shouldManageSession,
        options.registerSessionAsOrchestrator,
      );

      for (const [messageIndex, message] of messages.entries()) {
        if (!isUserMessageWithParts(message)) continue;
        if (message.info.agent && message.info.agent !== 'orchestrator') {
          continue;
        }
        if (
          !message.info.sessionID ||
          !options.shouldManageSession(message.info.sessionID)
        ) {
          const sessionID = message.info.sessionID;
          if (!sessionID || message.info.agent !== 'orchestrator') {
            continue;
          }
          options.registerSessionAsOrchestrator?.(sessionID);
          if (!options.shouldManageSession(sessionID)) continue;
        }

        for (const [partIndex, part] of message.parts.entries()) {
          updateFromInjectedCompletion(
            injectionState,
            part,
            message,
            messageIndex,
            partIndex,
          );
        }
      }

      if (rehydratedCount > 0) {
        await runtimeStatusReconciler.reconcile();
      }
    },

    injectBackgroundJobBoard: (
      input: Record<string, never>,
      output: { messages?: unknown },
    ) => injectBackgroundJobBoard(injectionState, input, output),

    event: (input: {
      event: {
        type: string;
        properties?: {
          info?: { id?: string; parentID?: string; agent?: string };
          id?: string;
          requestID?: string;
          sessionID?: string;
          status?: { type?: string };
          error?: { name?: string };
        };
      };
    }): Promise<void> => {
      if (input.event.type === 'session.deleted') {
        const sessionID =
          input.event.properties?.info?.id ?? input.event.properties?.sessionID;
        if (sessionID) {
          deferredInlineErrors.delete(sessionID);
        }
      }

      if (input.event.type === 'server.instance.disposed') {
        runtimeStatusReconciler.dispose();
      }
      return handleEvent(input, {
        inputWaits,
        idleSessionTokens,
        options,
        idleReconciler,
        deferredInlineErrors,
        backgroundJobBoard,
        pendingCallTracker,
        taskContextTracker,
        terminalJobsInjectedByParent,
        pendingInjectedTerminalJobsByParent,
        retainedBoardSnapshots: injectionState.retainedBoardSnapshots,
        backgroundJobSupervisor: options.backgroundJobSupervisor,
      }).then(() => runtimeStatusReconciler.schedule());
    },
  };
}
