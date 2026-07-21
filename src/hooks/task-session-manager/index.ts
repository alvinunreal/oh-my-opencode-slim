import type { PluginInput } from '@opencode-ai/plugin';
import {
  BackgroundJobBoard,
  type BackgroundJobStore,
  isInternalInitiatorPart,
} from '../../utils';
import { isRecord as isObjectRecord } from '../../utils/guards';
import type { SessionLifecycle } from '../session-lifecycle';
import { isUserMessageWithParts } from '../types';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  type InjectionState,
  injectBackgroundJobBoard,
  MAX_PROCESSED_INJECTED_COMPLETIONS,
  reconcileInjectedTerminalJobs,
  updateFromInjectedCompletion,
} from './board-injection';
import { evaluateContinuation as evaluateContinuationFn } from './continuation-evaluator';
import { createContinuationTokenManager } from './continuation-token-manager';
import { handleEvent } from './event-router';
import { createIdleReconciler } from './idle-reconciliation';
import { createInputWaitTracker } from './input-wait-tracker';
import { createPendingCallTracker } from './pending-call-tracker';
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
const IDLE_RECONCILE_DELAY_MS = 2_000;

export function createTaskSessionManagerHook(
  _ctx: PluginInput,
  options: {
    strategy?: 'latest' | 'checkpoint-compatible';
    maxSessionsPerAgent: number;
    maxRetainedSnapshots: number;
    readContextMinLines?: number;
    readContextMaxFiles?: number;
    backgroundJobBoard?: BackgroundJobStore;
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
    coordinator?: SessionLifecycle;
    /** Test seam only; production always uses the reconciliation delay. */
    idleReconcileDelayMs?: number;
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
  const terminalJobsInjectedByParent = new Map<string, Set<string>>();

  // Forward refs for circular deps — set after corresponding managers exist.
  // These are captured by closure in createIdleReconciler and only called
  // at runtime (event handlers), well after initialization completes.
  let evaluateContinuation: (
    parentSessionID: string,
    sessionToken: symbol,
  ) => Promise<void>;
  let getContinuationSessionToken: (sessionID: string) => symbol = () => {
    throw new Error('unreachable: getContinuationSessionToken not initialized');
  };
  let isCurrentContinuation: (
    sessionID: string,
    sessionToken: symbol,
    evaluationToken?: symbol,
  ) => boolean = () => false;
  let hasInputWait: (sessionID: string) => boolean = () => false;

  const idleReconciler = createIdleReconciler({
    backgroundJobBoard,
    evaluateContinuation: (s, t) => evaluateContinuation(s, t),
    reconcileInjectedTerminalJobs: (parentSessionID: string) =>
      reconcileInjectedTerminalJobs(injectionState, parentSessionID),
    idleReconcileDelayMs:
      options.idleReconcileDelayMs ?? IDLE_RECONCILE_DELAY_MS,
    isFallbackInProgress: options.isFallbackInProgress,
    hasInputWait: (s) => hasInputWait(s),
    getContinuationSessionToken: (s) => getContinuationSessionToken(s),
    isCurrentContinuation: (s, t, e) => isCurrentContinuation(s, t, e),
    taskContextTracker,
  });

  const continuationTokens = createContinuationTokenManager({
    onInvalidateContinuation: idleReconciler.onInvalidateContinuation,
  });
  getContinuationSessionToken = (s) =>
    continuationTokens.getContinuationSessionToken(s);
  isCurrentContinuation = (s, t, e) =>
    continuationTokens.isCurrentContinuation(s, t, e);

  const inputWaits = createInputWaitTracker({
    shouldManageSession: options.shouldManageSession,
    invalidateContinuation: (sessionID) =>
      continuationTokens.invalidateContinuation(sessionID),
  });
  hasInputWait = (s) => inputWaits.hasInputWait(s);

  type SdkResponse = { data?: unknown };
  type SessionSdk = {
    todo?: (input: unknown) => Promise<SdkResponse>;
    children?: (input: unknown) => Promise<SdkResponse>;
    status?: (input: unknown) => Promise<SdkResponse>;
    promptAsync?: (input: unknown) => Promise<unknown>;
  };
  const sessionSdk = (_ctx.client as unknown as { session?: SessionSdk })
    .session;

  evaluateContinuation = (parentSessionID, sessionToken) =>
    evaluateContinuationFn(parentSessionID, sessionToken, {
      backgroundJobBoard,
      continuationTokens,
      inputWaits,
      options,
      sessionSdk,
    });

  if (options.coordinator) {
    options.coordinator.onSessionDeleted((sessionId) => {
      continuationTokens.clearContinuation(sessionId);
      inputWaits.clearInputWaits(sessionId);
      idleReconciler.clearIdleTimers(sessionId);
      // During a foreground fallback abort/re-prompt cycle, the session
      // is being torn down and immediately recreated with a fallback model.
      // Dropping the job from the board here would make the orchestrator
      // lose track of the task and report it as cancelled even though the
      // oracle actually completed.
      if (!options.isFallbackInProgress?.(sessionId)) {
        backgroundJobBoard.drop(sessionId);
        backgroundJobBoard.clearParent(sessionId);
      }
      terminalJobsInjectedByParent.delete(sessionId);
      injectionState.retainedBoardSnapshots.delete(sessionId);
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
    maxProcessedInjectedCompletions: MAX_PROCESSED_INJECTED_COMPLETIONS,
    metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
    shouldManageSession: options.shouldManageSession,
    taskContextTracker,
    retainedBoardSnapshots: new Map(),
  };

  return {
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
      if (
        !sessionID ||
        (typeof outputMessage?.role === 'string' &&
          outputMessage.role !== 'user') ||
        !options.shouldManageSession(sessionID) ||
        !Array.isArray(parts) ||
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
      continuationTokens.clearContinuation(sessionID);
    },

    'tool.execute.before': (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args?: unknown },
    ): Promise<void> =>
      handleToolExecuteBefore(input, output, {
        shouldManageSession: options.shouldManageSession,
        registerSessionAsOrchestrator: options.registerSessionAsOrchestrator,
        backgroundJobBoard,
        pendingCallTracker,
        taskContextTracker,
      }),

    'tool.execute.after': (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { output: unknown; metadata?: unknown },
    ): Promise<void> =>
      handleToolExecuteAfter(input, output, {
        directory: _ctx.directory,
        backgroundJobBoard,
        pendingCallTracker,
        taskContextTracker,
      }),

    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];

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
    }): Promise<void> =>
      handleEvent(input, {
        inputWaits,
        continuationTokens,
        options,
        idleReconciler,
        backgroundJobBoard,
        pendingCallTracker,
        taskContextTracker,
        terminalJobsInjectedByParent,
        retainedBoardSnapshots: injectionState.retainedBoardSnapshots,
      }),
  };
}
