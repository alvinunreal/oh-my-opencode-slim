import type { PluginInput } from '@opencode-ai/plugin';
import {
  BackgroundJobBoard,
  type BackgroundJobExecution,
  type BackgroundJobStore,
  type BackgroundJobSupervisor,
  type BackgroundTaskConcurrency,
  clearBackgroundJobSuppression,
  deriveFullObjective,
  deriveTaskSessionLabel,
  getBackgroundJobLifecycleLedger,
  isInternalInitiatorPart,
  log,
  parseTaskIdFromTaskOutput,
  parseTaskStateFromOutput,
  recordBackgroundJobSuppression,
} from '../../utils';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
  readSessionInfoForObservation,
} from '../../utils/background-job-terminal-gate';
import { fetchChildTranscript } from '../../utils/child-transcript';
import { isRecord as isObjectRecord } from '../../utils/guards';
import { getClient } from '../../utils/opencode-client';
import { isGenuineOperatorMessage } from '../orchestrator-wake/index';
import type { SessionLifecycle } from '../session-lifecycle';
import { isMessageWithParts, isUserMessageWithParts } from '../types';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  type InjectedTerminalJobs,
  type InjectionState,
  injectBackgroundJobBoard,
  observeSyntheticTerminalPart,
  pruneReopenCorrectionState,
  reconcileInjectedTerminalJobs,
  stabilizeRunningTaskParts,
  updateFromInjectedCompletion,
} from './board-injection';
import { handleEvent } from './event-router';
import { createIdleReconciler } from './idle-reconciliation';
import { createIdleSessionTokens } from './idle-session-tokens';
import { createInputWaitTracker } from './input-wait-tracker';
import {
  createPendingCallTracker,
  type PendingCallTracker,
} from './pending-call-tracker';
import type { RevivedRunTracker } from './revived-run-tracker';
import { createRuntimeStatusReconciler } from './runtime-status-reconciliation';
import { createTaskContextTracker } from './task-context-tracker';
import {
  handleToolExecuteAfter,
  handleToolExecuteBefore,
} from './tool-execute-hooks';

export { BACKGROUND_JOB_BOARD_METADATA_KEY } from './board-injection';

/**
 * Delay for the parent's acknowledgement of already confirmed publications.
 * Child evidence retries belong exclusively to the terminal gate.
 */
const IDLE_RECONCILE_DELAY_MS = 2_000;

const RECOVERED_TASK_AGENT_FALLBACK = 'unknown';

function rehydrateHistoricalRunningTasks(
  messages: unknown[],
  backgroundJobBoard: BackgroundJobStore,
  shouldManageSession: (sessionID: string) => boolean,
  registerSessionAsOrchestrator?: (sessionID: string) => void,
  rehydrateTombstones?: ReadonlySet<string>,
  backgroundTaskConcurrency?: BackgroundTaskConcurrency,
  getModelForAgent?: (
    agentType: string,
    parentSessionID?: string,
  ) => string | undefined,
): string[] {
  const rehydrated: string[] = [];
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
      if (rehydrateTombstones?.has(taskID)) {
        // A real session.deleted already invalidated this run. Do not turn its
        // persisted running tool part into a fresh alias on the next request.
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
        objective: deriveFullObjective({ description, prompt }) ?? label,
        background: true,
        preserveRun: true,
        // Historical parts do not carry a trustworthy launch timestamp. Zero
        // also prevents this registration from looking like a live observation
        // to the first runtime-status reconciliation.
        now: 0,
      });
      // Re-claim the admission slot this still-running task already holds.
      // The scheduler is recreated on every plugin re-init (the factory re-
      // runs on config updates), so without this restore a fresh scheduler
      // would admit a second concurrent task past the configured cap. The
      // model resolution mirrors admission so provider/model caps stay
      // correct. Idempotent per taskID.
      backgroundTaskConcurrency?.restoreTask(
        taskID,
        getModelForAgent?.(agent, parentSessionID),
      );
      rehydrated.push(taskID);
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
    terminalGate?: BackgroundJobTerminalGate;
    hostOutcomeClock?: 'shared-unix-ms';
    backgroundJobSupervisor?: BackgroundJobSupervisor;
    backgroundTaskConcurrency?: BackgroundTaskConcurrency;
    /** Shared by plugin generations for one admission runtime. */
    pendingCallTracker?: PendingCallTracker;
    getModelForAgent?: (
      agentType: string,
      parentSessionID?: string,
    ) => string | undefined;
    /** Current "provider/model" for a session. Feeds same-provider
     *  background conversion. */
    getSessionModel?: (sessionID: string) => string | undefined;
    /** Opt-in provider → "foreground" map for same-provider background
     *  conversion. */
    sameProviderPolicy?: Record<string, 'foreground'>;
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
    revivedRunTracker?: RevivedRunTracker;
  },
) {
  const backgroundJobBoard =
    options.backgroundJobBoard ??
    new BackgroundJobBoard({
      maxReusablePerAgent: options.maxSessionsPerAgent,
      readContextMinLines: options.readContextMinLines,
      readContextMaxFiles: options.readContextMaxFiles,
    });
  const rehydrateState = getBackgroundJobLifecycleLedger(backgroundJobBoard);
  const rehydrateTombstones = rehydrateState.tombstones;

  // Transcript-backed stop gate (false-stop incident): shared by the
  // quiescent stop-confirmation timer and the periodic runtime-status
  // reconciler so neither can publish `stopped` while the child's
  // transcript already holds the terminal result. Unknown reads never
  // terminate into stopped; the #1157 guarantee lives on a valid
  // transcript that provably holds no result for this run.
  const terminalGate =
    options.terminalGate ??
    createBackgroundJobTerminalGate({
      backgroundJobBoard,
      input: _ctx,
      hostOutcomeClock: options.hostOutcomeClock,
      readTerminalEvidence: async (taskID) =>
        fetchChildTranscript(getClient(_ctx), taskID, _ctx.directory).catch(
          () => undefined,
        ),
      baselineFor: (taskID, generation) =>
        options.revivedRunTracker?.baselineFor(taskID, generation),
      attemptStartedAtFor: (taskID, generation) =>
        options.revivedRunTracker?.attemptStartedAtFor(taskID, generation),
      observationRevisionFor: (taskID, generation) =>
        options.revivedRunTracker?.revisionFor(taskID, generation),
      isObservationPending: (taskID, generation) =>
        options.revivedRunTracker?.isObservationPending(taskID, generation) ??
        false,
    });

  const rememberDeletedSession = (sessionID: string): void => {
    const remember = (taskID: string): void => {
      recordBackgroundJobSuppression(backgroundJobBoard, taskID);
    };

    // The delete event itself is the lifecycle boundary. Keep a tombstone
    // even if an earlier cleanup already removed the board record.
    remember(sessionID);
    for (const job of backgroundJobBoard.list(sessionID)) {
      remember(job.taskID);
    }
  };

  /**
   * Existence probe for a task registered by rehydrate: persisted running
   * tool parts carry no host-side liveness, so a session deleted while the
   * plugin was down would otherwise resurrect as a forever-running ghost
   * on the next transform. Fire-and-forget from the transform hook; never
   * awaited there. Classification is strictly by the host's typed `_tag`
   * property (never instanceof — the SDK error class identity is not
   * stable across host builds — and never message matching).
   *
   * wait()-discipline: never `await ctx.session.wait` (or any host wait
   * API) inside chat.transform — a busy child would hang the transform
   * for its entire run. This probe uses session.get only. If a wait ever
   * becomes necessary outside transforms, wrap it in Promise.race with a
   * timeout and attach a no-op `.catch` to the abandoned promise (a later
   * NotFoundError rejection must not surface as unhandled).
   */
  const probeRehydratedTaskSession = (taskID: string): void => {
    void (async () => {
      const client = getClient(_ctx);
      // Same presence gate as readSessionOutcome: capability is probed,
      // not assumed, and deliberately NOT gated on hostFlavor. The probe
      // is v2-effective: the dotted `_tag === 'Session.NotFoundError'`
      // classification only crosses the v2 plugin boundary (the host
      // passes the raw core effect in-process). The v1 SDK wraps 4xx
      // responses as plain `Error` with a `.cause` (or returns an
      // `{error}` tuple when `throwOnError: false`), so on v1 the probe
      // runs but harmlessly never tombstones — transient-error fail-open
      // swallows the wrapped rejection. Absent method → skip silently.
      if (typeof client.session?.get !== 'function') return;
      // Freshness anchor: the generation of the record rehydrate just
      // registered (captured synchronously, before the async get). A
      // legitimate same-ID relaunch while the get is in flight takes a
      // NEW generation and clears the tombstone — a stale NotFound must
      // not tombstone+drop the live relaunched record.
      const generationAtProbeStart = backgroundJobBoard.get(taskID)?.generation;
      if (generationAtProbeStart === undefined) return;
      const token = terminalGate.capture({
        taskID,
        generation: generationAtProbeStart,
      });
      if (!token) return;
      try {
        await readSessionInfoForObservation(_ctx, token);
        await terminalGate.reconcile({
          taskID,
          generation: generationAtProbeStart,
        });
        return;
      } catch (err) {
        if ((err as { _tag?: string })?._tag === 'Session.NotFoundError') {
          // Freshness guard: only clean up when the board still holds the
          // generation the probe started against. A record replaced by a
          // same-ID relaunch (or already dropped) is not ours to delete.
          const current = backgroundJobBoard.get(taskID);
          if (current?.generation !== generationAtProbeStart) {
            log(
              '[task-session-manager] skipped stale NotFound cleanup after same-ID relaunch',
              {
                taskID,
                generationAtProbeStart,
                currentGeneration: current?.generation,
              },
            );
            return;
          }
          // The session no longer exists on the host. The four probe
          // cleanup actions run as one synchronous block — supervisor
          // FIRST: its onSessionDeleted needs the record to still exist
          // so deadline-exceeded runs finalize their wall-clock timeout
          // (same ordering as the event-router/coordinator deletion
          // paths). All four are idempotent but all are required — a
          // missing releaseTask would leak an admission slot forever.
          // The canonical full cleanup (input waits, idle tokens,
          // pending-call tracker, clearParent, task-context tracker,
          // snapshots) runs via the session.deleted event path.
          options.backgroundJobSupervisor?.onSessionDeleted(taskID);
          recordBackgroundJobSuppression(backgroundJobBoard, taskID);
          backgroundJobBoard.drop(taskID);
          options.backgroundTaskConcurrency?.releaseTask(taskID);
          log(
            '[task-session-manager] rehydrated task no longer exists on host; tombstoned',
            { taskID },
          );
          return;
        }
        // Transient/unknown errors fail open: the job stays registered and
        // the normal reconciliation paths keep their chance. Swallowed —
        // the fire-and-forget probe must never reject unhandled.
      }
    })();
  };

  const pendingCallTracker =
    options.pendingCallTracker ??
    createPendingCallTracker({
      releaseLease: (lease) => backgroundJobBoard.releaseLease(lease),
    });
  const taskContextTracker = createTaskContextTracker();

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
    terminalGate,
    reconcileInjectedTerminalJobs: (parentSessionID: string) =>
      reconcileInjectedTerminalJobs(injectionState, parentSessionID),
    idleReconcileDelayMs:
      options.idleReconcileDelayMs ?? IDLE_RECONCILE_DELAY_MS,
    isFallbackInProgress: options.isFallbackInProgress,
    hasInputWait: (s) => hasInputWait(s),
    getIdleSessionToken: (s) => getIdleSessionToken(s),
    isCurrentIdleSessionToken: (s, t) => isCurrentIdleSessionToken(s, t),
  });
  const runtimeStatusReconciler = createRuntimeStatusReconciler({
    input: _ctx,
    backgroundJobBoard,
    delayMs: options.runtimeStatusReconcileDelayMs,
    terminalGate,
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
        options.backgroundTaskConcurrency?.releaseTask(sessionId);
        // The parent's child tasks are about to be dropped from the board.
        // Normally each child's own session.deleted releases its admission
        // slot, but a recursive delete can arrive parent-first, and a child
        // mid-fallback is skipped entirely — release every child's slot here
        // so none is left holding capacity forever. Idempotent per taskID.
        for (const child of backgroundJobBoard.list(sessionId)) {
          options.backgroundTaskConcurrency?.releaseTask(child.taskID);
        }
        options.backgroundJobSupervisor?.onSessionDeleted(sessionId);
        const hardTimedOut =
          backgroundJobBoard.field(sessionId, 'deadlineExceededAt') !==
          undefined;
        if (!hardTimedOut) {
          rememberDeletedSession(sessionId);
          backgroundJobBoard.drop(sessionId);
        }
        options.backgroundJobSupervisor?.clearParent(sessionId);
        backgroundJobBoard.clearParent(sessionId);
        if (!hardTimedOut) options.backgroundJobSupervisor?.drop(sessionId);
      }
      terminalJobsInjectedByParent.delete(sessionId);
      pendingInjectedTerminalJobsByParent.delete(sessionId);
      injectionState.retainedBoardSnapshots.delete(sessionId);
      injectionState.retainedTailBoards.delete(sessionId);
      // Orphaned reopen corrections must never surface in a recreated
      // session; the board entries they referenced are being dropped too.
      pruneReopenCorrectionState(injectionState, sessionId);
      taskContextTracker.clearSession(sessionId);
      taskContextTracker.prune(backgroundJobBoard);
      pendingCallTracker.clearSession(sessionId);
    });
  }

  const injectionState: InjectionState = {
    backgroundJobBoard,
    terminalGate,
    maxRetainedSnapshots: options.maxRetainedSnapshots,
    strategy: options.strategy ?? 'latest',
    lifecycleLedger: rehydrateState,
    processedInjectedCompletions: rehydrateState.processedInjectedCompletions,
    processedInjectedCompletionOrder:
      rehydrateState.processedInjectedCompletionOrder,
    injectedCompletionFences: rehydrateState.injectedCompletionFences,
    syntheticTerminalOccurrences: rehydrateState.syntheticTerminalOccurrences,
    syntheticTerminalOccurrenceOrder:
      rehydrateState.syntheticTerminalOccurrenceOrder,
    getLifecycleEpoch: () => rehydrateState.nextEpoch,
    getDeletionEpoch: (taskID) => rehydrateState.deletionEpochs.get(taskID),
    terminalJobsInjectedByParent,
    pendingInjectedTerminalJobsByParent,
    metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
    shouldManageSession: options.shouldManageSession,
    taskContextTracker,
    retainedBoardSnapshots: new Map(),
    retainedTailBoards: new Map(),
  };

  // Early session.created registrations belong to the pending native call,
  // not to the factory-local board that first observed them. Move them before
  // this generation can receive the task after-hook.
  pendingCallTracker.adoptEarlyRegistrations(
    backgroundJobBoard,
    options.backgroundJobSupervisor,
  );

  return {
    markRevivedRunPending: (taskID: string): void => {
      taskContextTracker.pendingManagedTaskIds.add(taskID);
    },
    clearRevivedRunPending: (taskID: string): void => {
      taskContextTracker.pendingManagedTaskIds.delete(taskID);
    },
    contextFilesForTask: (taskID: string) =>
      taskContextTracker.contextFilesForPrompt(taskID),
    pruneTaskContext: (): void => {
      taskContextTracker.prune(backgroundJobBoard);
    },
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
        // Shared genuine-operator gate with orchestrator-wake (single
        // source of truth in ../orchestrator-wake/index.ts): noReply
        // injections, identity-less v2 command-marker submits, and
        // board/phase-tagged injections must not clear wait_for_user or
        // invalidate idle timers. The local direct-synthetic and
        // messageIdentity checks above stay as cheap pre-filters and the
        // defense-in-depth identity seam (callers must still compute a
        // messageIdentity); the shared helper owns the full genuineness
        // verdict that neither seam reaches alone.
        !isGenuineOperatorMessage(inputMessage, outputMessage, parts) ||
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
        backgroundTaskConcurrency: options.backgroundTaskConcurrency,
        getModelForAgent: options.getModelForAgent,
        getSessionModel: options.getSessionModel,
        sameProviderPolicy: options.sameProviderPolicy,
        pendingCallTracker,
        taskContextTracker,
        getLifecycleEpoch: () => rehydrateState.nextEpoch,
      }),

    'tool.execute.after': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { output: unknown; metadata?: unknown },
    ): Promise<void> => {
      await handleToolExecuteAfter(input, output, {
        directory: _ctx.directory,
        backgroundJobBoard,
        terminalGate,
        backgroundJobSupervisor: options.backgroundJobSupervisor,
        bindConcurrencyTicket: (taskID, pending) =>
          pending.concurrencyTicket?.bind(taskID),
        recordLifecycleSuppression: (taskID) =>
          recordBackgroundJobSuppression(backgroundJobBoard, taskID),
        pendingCallTracker,
        taskContextTracker,
        clearRehydrateTombstone: (taskID) => {
          clearBackgroundJobSuppression(backgroundJobBoard, taskID);
        },
        isStaleDeletedTaskOutput: (taskID, lifecycleEpoch) => {
          const deletionEpoch = rehydrateState.deletionEpochs.get(taskID);
          return deletionEpoch !== undefined && lifecycleEpoch < deletionEpoch;
        },
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

      const rehydratedTaskIDs = rehydrateHistoricalRunningTasks(
        messages,
        backgroundJobBoard,
        options.shouldManageSession,
        options.registerSessionAsOrchestrator,
        rehydrateTombstones,
        options.backgroundTaskConcurrency,
        options.getModelForAgent,
      );
      for (const taskID of rehydratedTaskIDs) {
        probeRehydratedTaskSession(taskID);
      }

      if (rehydratedTaskIDs.length > 0) {
        await runtimeStatusReconciler.reconcile();
      }

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
          await updateFromInjectedCompletion(
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
          part?: unknown;
        };
      };
    }): Promise<void> => {
      if (input.event.type === 'session.deleted') {
        const sessionID =
          input.event.properties?.info?.id ?? input.event.properties?.sessionID;
        if (sessionID) {
          deferredInlineErrors.delete(sessionID);
          if (!options.isFallbackInProgress?.(sessionID)) {
            const hardTimedOut =
              backgroundJobBoard.field(sessionID, 'deadlineExceededAt') !==
              undefined;
            if (!hardTimedOut) rememberDeletedSession(sessionID);
          }
        }
      }

      if (input.event.type === 'server.instance.disposed') {
        runtimeStatusReconciler.dispose();
        if (!options.terminalGate) terminalGate.dispose();
      }
      return handleEvent(input, {
        inputWaits,
        idleSessionTokens,
        options,
        idleReconciler,
        deferredInlineErrors,
        backgroundJobBoard,
        terminalGate,
        pendingCallTracker,
        taskContextTracker,
        terminalJobsInjectedByParent,
        pendingInjectedTerminalJobsByParent,
        retainedBoardSnapshots: injectionState.retainedBoardSnapshots,
        backgroundJobSupervisor: options.backgroundJobSupervisor,
        bindConcurrencyTicket: (taskID, pending) =>
          pending.concurrencyTicket?.bind(taskID),
        observeSyntheticTerminalPart: (part) =>
          observeSyntheticTerminalPart(injectionState, part),
        revivedRunTracker: options.revivedRunTracker,
      }).then(() => runtimeStatusReconciler.schedule());
    },
  };
}
