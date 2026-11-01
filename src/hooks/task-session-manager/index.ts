import type { PluginInput } from '@opencode-ai/plugin';
import {
  BackgroundJobBoard,
  type BackgroundJobSupervisor,
  type BackgroundTaskConcurrency,
  clearBackgroundJobSuppression,
  deriveFullObjective,
  deriveTaskSessionLabel,
  getBackgroundJobLifecycleLedger,
  isInternalInitiatorPart,
  isNativeBackgroundLaunchOutput,
  log,
  markPersistedBackgroundChildDelivered,
  parseTaskIdFromTaskOutput,
  parseTaskStateFromOutput,
  persistedBackgroundChildren,
  recordBackgroundJobSuppression,
} from '../../utils';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
  readSessionInfoForObservation,
} from '../../utils/background-job-terminal-gate';
import {
  classifyTerminalEvidence,
  fetchChildTranscript,
} from '../../utils/child-transcript';
import { isRecord as isObjectRecord } from '../../utils/guards';
import { getClient } from '../../utils/opencode-client';
import { withTimeout } from '../../utils/session';
import {
  DEFAULT_RUNTIME_SESSION_STATUS_TIMEOUT_MS,
  readLiveSession,
} from '../../utils/session-runtime-status';
import {
  type MessageTransformView,
  resolveView,
} from '../message-transform-view';
import { isGenuineOperatorMessage } from '../orchestrator-wake/index';
import type { SessionLifecycle } from '../session-lifecycle';
import { isMessageWithParts } from '../types';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  type InjectionState,
  injectBackgroundJobBoard,
  observeSyntheticTerminalPart,
  pruneReopenCorrectionState,
  stabilizeRunningTaskParts,
  updateFromInjectedCompletion,
} from './board-injection';
import type { ChildInputWaitNotification } from './child-input-wait';
import { clearChildInputWaitsForSession } from './child-input-wait';
import { handleEvent } from './event-router';
import { createIdleReconciler } from './idle-reconciliation';
import { createIdleSessionTokens } from './idle-session-tokens';
import { createInputWaitTracker } from './input-wait-tracker';
import { messageCreatedAt, parseNativeDelivery } from './native-delivery';
import {
  nativeDelegationToolName,
  nativeToolCallID,
  nativeToolResultText,
} from './native-tool-parts';
import {
  createPendingCallTracker,
  type PendingCallTracker,
} from './pending-call-tracker';
import type { RevivedRunTracker } from './revived-run-tracker';
import { createRuntimeStatusReconciler } from './runtime-status-reconciliation';
import { createTaskContextTracker } from './task-context-tracker';
import {
  type DelegatedLaunchFromStructuredInput,
  handleToolExecuteAfter,
  handleToolExecuteBefore,
  registerDelegatedLaunchFromStructured,
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
  backgroundJobBoard: BackgroundJobBoard,
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
  const managedSessionIDs = new Set<string>();

  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;
    const parentSessionID = message.info.sessionID;
    if (!parentSessionID) continue;
    if (!shouldManageSession(parentSessionID)) {
      if (message.info.agent !== 'orchestrator') continue;
      registerSessionAsOrchestrator?.(parentSessionID);
      if (!shouldManageSession(parentSessionID)) continue;
    }
    managedSessionIDs.add(parentSessionID);
  }

  const deliveryInHistory = (
    parentSessionID: string,
    taskID: string,
    runStartedAt: number,
  ): { state: 'completed' | 'error' | 'cancelled'; at: number } | undefined => {
    let latest:
      | { state: 'completed' | 'error' | 'cancelled'; at: number }
      | undefined;
    const cutoff = runStartedAt;
    for (const message of messages) {
      if (!isMessageWithParts(message)) continue;
      if (
        message.info.sessionID !== undefined &&
        message.info.sessionID !== parentSessionID
      ) {
        continue;
      }
      const at = messageCreatedAt(message);
      if (at === undefined || at < cutoff) continue;
      if (latest !== undefined && at < latest.at) continue;
      for (const part of message.parts) {
        if (!isObjectRecord(part)) continue;
        const delivery = parseNativeDelivery(
          part as Parameters<typeof parseNativeDelivery>[0],
        );
        if (!delivery || delivery.taskID !== taskID) continue;
        if (latest === undefined || at >= latest.at) {
          latest = { state: delivery.state, at };
        }
      }
    }
    return latest;
  };

  const recoverTask = (
    taskID: string,
    parentSessionID: string,
    input: Record<string, unknown>,
    launchAt?: number,
  ): void => {
    if (rehydrateTombstones?.has(taskID)) {
      // A real session.deleted already invalidated this run. Do not turn its
      // persisted running tool part into a fresh alias on the next request.
      return;
    }
    if (backgroundJobBoard.get(taskID)) return;
    const persisted = persistedBackgroundChildren().get(taskID);
    if (persisted && persisted.parentSessionID !== parentSessionID) {
      // A child identity belongs only to the parent that launched it.
      return;
    }
    if (persisted?.deliveredAt !== undefined) {
      // A restart already delivered this child's terminal outcome. A stale
      // running history part must not resurrect it as a fresh run.
      return;
    }
    const runStartedAt = persisted?.launchedAt ?? launchAt;
    if (runStartedAt !== undefined) {
      const delivered = deliveryInHistory(
        parentSessionID,
        taskID,
        runStartedAt,
      );
      if (delivered) {
        // Trusted current-run delivery already reached the parent before the
        // restart. Re-owning this stale running launch would replay it.
        if (persisted) {
          markPersistedBackgroundChildDelivered(
            taskID,
            delivered.at,
            runStartedAt,
          );
        }
        return;
      }
    }

    const agentType = input.subagent_type ?? input.agent;
    const agent =
      typeof agentType === 'string' && agentType.trim() !== ''
        ? agentType.trim()
        : RECOVERED_TASK_AGENT_FALLBACK;
    const description =
      typeof input.description === 'string' ? input.description : undefined;
    const prompt = typeof input.prompt === 'string' ? input.prompt : undefined;
    const label = deriveTaskSessionLabel({
      description,
      prompt,
      agentType: agent,
    });

    const adopted = backgroundJobBoard.registerLaunch({
      taskID,
      parentSessionID,
      agent,
      description: label,
      objective: deriveFullObjective({ description, prompt }) ?? label,
      background: true,
      preserveRun: true,
      adopted: true,
      // Prefer the persisted launch fence. A transcript timestamp is the
      // best remaining evidence; zero stays the last-resort marker when no
      // trustworthy time exists.
      now: runStartedAt ?? 0,
    });
    adopted.recoveredAtStartup = true;
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
  };

  // v2 context history reaches the transform as native tool-call/tool-result
  // parts. Pair the call's input with the result's host-authored background
  // launch sentence; the sentence, not input.background, proves the child
  // actually runs in the background (omitted background defaults to native
  // background, while a foreground call has no result until it completes).
  const nativeCalls = new Map<
    string,
    {
      parentSessionID: string;
      input: Record<string, unknown>;
      at?: number;
    }
  >();
  const nativeCallKey = (parentSessionID: string, callID: string) =>
    `${parentSessionID}\u0000${callID}`;
  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;
    const parentSessionID = message.info.sessionID;
    if (!parentSessionID || !managedSessionIDs.has(parentSessionID)) continue;
    for (const part of message.parts) {
      if (!isObjectRecord(part) || part.type !== 'tool-call') continue;
      const toolName = nativeDelegationToolName(part);
      if (toolName !== 'task' && toolName !== 'subagent') continue;
      const callID = nativeToolCallID(part);
      if (!callID || !isObjectRecord(part.input)) continue;
      nativeCalls.set(nativeCallKey(parentSessionID, callID), {
        parentSessionID,
        input: part.input,
        at: messageCreatedAt(message),
      });
    }
  }

  for (const message of messages) {
    if (!isMessageWithParts(message)) continue;

    const parentSessionID = message.info.sessionID;
    if (!parentSessionID || !managedSessionIDs.has(parentSessionID)) {
      continue;
    }

    for (const part of message.parts) {
      if (!isObjectRecord(part)) continue;
      if (part.type === 'tool-result') {
        const toolName = nativeDelegationToolName(part);
        if (toolName !== 'task' && toolName !== 'subagent') continue;
        const callID = nativeToolCallID(part);
        if (!callID) continue;
        const call = nativeCalls.get(nativeCallKey(parentSessionID, callID));
        if (!call) continue;
        const output = nativeToolResultText(part);
        if (!output || !isNativeBackgroundLaunchOutput(output)) continue;
        const taskID = parseTaskIdFromTaskOutput(output);
        if (!taskID || parseTaskStateFromOutput(output) !== 'running') {
          continue;
        }
        const explicitID = call.input.task_id ?? call.input.sessionID;
        if (
          typeof explicitID === 'string' &&
          explicitID !== '' &&
          explicitID !== taskID
        ) {
          continue;
        }
        recoverTask(taskID, call.parentSessionID, call.input, call.at);
        continue;
      }

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
      recoverTask(
        taskID,
        parentSessionID,
        state.input,
        messageCreatedAt(message),
      );
    }
  }

  return rehydrated;
}

export function createTaskSessionManagerHook(
  _ctx: PluginInput,
  options: {
    maxSessionsPerAgent: number;
    backgroundJobBoard?: BackgroundJobBoard;
    terminalGate?: BackgroundJobTerminalGate;
    hostOutcomeClock?: 'shared-unix-ms';
    backgroundJobSupervisor?: BackgroundJobSupervisor;
    backgroundTaskConcurrency?: BackgroundTaskConcurrency;
    /** Whether a completed-job push for this exact run is still queued and
     *  undelivered in the wake scheduler; consulted by the stale-timestamp
     *  retirement fallback so an undelivered answer is never acked first. */
    hasUndeliveredTerminalPush?: (
      parentSessionID: string,
      taskID: string,
      generation: number,
    ) => boolean;
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
    /** Host flavor marker ('v2' on OpenCode v2 hosts); selects the native
     *  delegation vocabulary in model-visible tool guidance. Defaults v1. */
    hostFlavor?: string;
    /** Per-instance pairing flag for the background-default flip (v2 only);
     *  see BackgroundDefaultFlipState in v2/delegation. */
    isBackgroundDefaultFlipArmed?: () => boolean;
    recoverRetainedSession?: (request: {
      parentSessionID: string;
      requested: string;
      agent?: string;
    }) => Promise<import('./session-recovery').RetainedRecoveryResult>;
    resolveCanonicalTaskRef?: (
      parentSessionID: string,
      requested: string,
    ) => Promise<import('./session-recovery').CanonicalTaskReference>;
    isDisposed?: () => boolean;
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
    fallbackFailureReason?: (sessionID: string) => string;
    coordinator?: SessionLifecycle;
    /** Surface a background child's newly opened input wait to the parent
     * (question/permission that would otherwise park the child forever with
     * the parent's turn already ended). */
    onChildInputWait?: (notification: ChildInputWaitNotification) => void;
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
    });
  const rehydrateState = getBackgroundJobLifecycleLedger(backgroundJobBoard);
  const rehydrateTombstones = rehydrateState.tombstones;
  // Only adoptRequested reads boundaries, and v2 hosts never wire it.
  const adoptionEnabled = options.hostFlavor !== 'v2';
  const historyBoundaries = new Map<string, number>();
  const adoptRequested = async (
    parent: string,
    requested: string,
    agent: string,
  ): Promise<'adopted' | 'unchecked' | 'rejected'> => {
    const boundary = historyBoundaries.get(parent);
    if (boundary === undefined) return 'unchecked';
    if (options.isDisposed?.()) return 'rejected';
    try {
      const client = getClient(_ctx);
      const query = { directory: _ctx.directory };
      // Only the reads run under the deadline; adoption cannot run late.
      const [{ data: info }, transcript, live] = await withTimeout(
        Promise.all([
          client.session.get({
            path: { id: requested },
            query,
            throwOnError: true,
          }),
          client.session.messages({
            path: { id: requested },
            query: { ...query, limit: 1 },
            throwOnError: true,
          }),
          readLiveSession(_ctx, requested),
        ]),
        DEFAULT_RUNTIME_SESSION_STATUS_TIMEOUT_MS,
        'Host child adoption timed out',
      );
      const suffix = info.title.match(/ \(@([^()]+) subagent\)$/);
      const evidence = classifyTerminalEvidence(transcript);
      // Adopt only if every gate holds (else the caller's refusal stands),
      // in condition order:
      //  1. the host child's parent is this session;
      //  2. it was created before the parent's oldest visible message, so
      //     the call that launched it is no longer in the visible history;
      //  3. its title suffix names the requested agent;
      //  4. its last message is a terminal result (completed or error) per
      //     classifyTerminalEvidence, the terminal gate's own classifier;
      //  5. fresh live status confirms quiescence (idle or valid absence);
      //  6. no foreground fallback is pending for the child;
      //  7. the parent's boundary did not change during the reads;
      //  8. no deletion tombstone suppresses the child.
      if (
        info.parentID !== parent ||
        !(info.time.created < boundary) ||
        suffix?.[1] !== agent ||
        (evidence.verdict !== 'completed' && evidence.verdict !== 'error') ||
        (live.kind !== 'idle' && live.kind !== 'absent') ||
        options.isFallbackInProgress?.(requested) ||
        historyBoundaries.get(parent) !== boundary ||
        options.isDisposed?.() ||
        rehydrateTombstones.has(requested)
      )
        return 'rejected';
      const adopted = backgroundJobBoard.adoptTerminal({
        taskID: requested,
        parentSessionID: parent,
        agent,
        description: info.title.slice(0, -suffix[0].length),
        createdAt: info.time.created,
        updatedAt: info.time.updated,
        terminalState: evidence.verdict,
        resultSummary: evidence.text,
      });
      return adopted ? 'adopted' : 'rejected';
    } catch (error) {
      log('[task-session-manager] host child adoption failed', String(error));
      return 'rejected';
    }
  };

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
      readTerminalEvidence: async (taskID, historyBoundary) =>
        fetchChildTranscript(
          getClient(_ctx),
          taskID,
          _ctx.directory,
          undefined,
          undefined,
          historyBoundary,
        ).catch(() => undefined),
      baselineFor: (taskID, generation) =>
        options.revivedRunTracker?.baselineFor(taskID, generation),
      attemptStartedAtFor: (taskID, generation) =>
        options.revivedRunTracker?.attemptStartedAtFor(taskID, generation),
      observationRevisionFor: (taskID, generation) =>
        options.revivedRunTracker?.revisionFor(taskID, generation),
      isObservationPending: (taskID, generation) =>
        deferredInlineErrors.has(taskID) ||
        (options.revivedRunTracker?.isObservationPending(taskID, generation) ??
          false),
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
          // FIRST: its onSessionDeleted clears the run's watchdog timer
          // while the record still identifies it (same ordering as the
          // event-router/coordinator deletion paths). All four are
          // idempotent but all are required — a missing releaseTask would
          // leak an admission slot forever. The canonical full cleanup
          // (input waits, idle tokens, pending-call tracker, clearParent,
          // task-context tracker, snapshots) runs via the session.deleted
          // event path.
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

  /** Sessions with a deferred failover error awaiting the fallback
   *  outcome (managed inline 401/410, or a background child's
   *  failover-worthy error with an armed fallback chain), mapped to the
   *  summary the idle backstop publishes when no recovery happens. */
  const deferredInlineErrors = new Map<string, string>();
  const withFallbackReason = (sessionID: string, text: string): string =>
    [text, options.fallbackFailureReason?.(sessionID)]
      .filter(Boolean)
      .join('\n');

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
    idleReconcileDelayMs:
      options.idleReconcileDelayMs ?? IDLE_RECONCILE_DELAY_MS,
    isFallbackInProgress: options.isFallbackInProgress,
    hasInputWait: (s) => hasInputWait(s),
    getIdleSessionToken: (s) => getIdleSessionToken(s),
    isCurrentIdleSessionToken: (s, t) => isCurrentIdleSessionToken(s, t),
    // Read-and-clear for the deferred-error backstop: consuming at fire
    // time keeps a newer deferral authoritative and leaves no stale
    // entries to poison a later reuse of the session.
    consumeDeferredError: (sessionID) => {
      const message = deferredInlineErrors.get(sessionID);
      if (message === undefined) return;
      deferredInlineErrors.delete(sessionID);
      return withFallbackReason(sessionID, message);
    },
  });
  const runtimeStatusReconciler = createRuntimeStatusReconciler({
    input: _ctx,
    backgroundJobBoard,
    delayMs: options.runtimeStatusReconcileDelayMs,
    terminalGate,
  });

  const idleSessionTokens = createIdleSessionTokens({
    // Parent lifecycle invalidation must not strand a deferred child error.
    // Live busy explicitly cancels its backstop and clears the deferral.
    onInvalidate: (sessionID) => {
      if (!deferredInlineErrors.has(sessionID))
        idleReconciler.onInvalidateIdle(sessionID);
    },
  });
  getIdleSessionToken = (s) => idleSessionTokens.getSessionToken(s);
  isCurrentIdleSessionToken = (s, t) =>
    idleSessionTokens.isCurrentSessionToken(s, t);

  const inputWaits = createInputWaitTracker({
    shouldManageSession: options.shouldManageSession,
    invalidateIdle: (sessionID) => idleSessionTokens.invalidate(sessionID),
  });
  hasInputWait = (s) => inputWaits.hasInputWait(s);

  // A background child's open question/permission must wake the parent even
  // though the parent session itself has no input wait. The event router
  // forwards new asks through the options.onChildInputWait dep (exactly one
  // notification per new request id).

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
      // During a foreground fallback abort/re-prompt cycle, the session
      // is being torn down and immediately recreated with a fallback model.
      // Dropping the job from the board here would make the orchestrator
      // lose track of the task and report it as cancelled even though the
      // oracle actually completed.
      if (!options.isFallbackInProgress?.(sessionId)) {
        idleReconciler.clearIdleTimers(sessionId);
        deferredInlineErrors.delete(sessionId);
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
        rememberDeletedSession(sessionId);
        backgroundJobBoard.drop(sessionId);
        options.backgroundJobSupervisor?.clearParent(sessionId);
        backgroundJobBoard.clearParent(sessionId);
        options.backgroundJobSupervisor?.drop(sessionId);
      }
      historyBoundaries.delete(sessionId);
      // Orphaned reopen corrections must never surface in a recreated
      // session; the board entries they referenced are being dropped too.
      pruneReopenCorrectionState(injectionState, sessionId);
      taskContextTracker.clearSession(sessionId);
      taskContextTracker.prune(backgroundJobBoard);
      pendingCallTracker.clearSession(sessionId);
      clearChildInputWaitsForSession(sessionId);
    });
  }

  const injectionState: InjectionState = {
    backgroundJobBoard,
    terminalGate,
    hostFlavor: options.hostFlavor,
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
    hasUndeliveredTerminalPush: options.hasUndeliveredTerminalPush,
    metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
    shouldManageSession: options.shouldManageSession,
    taskContextTracker,
  };

  // Early session.created registrations belong to the pending native call,
  // not to the factory-local board that first observed them. Move them before
  // this generation can receive the task after-hook.
  pendingCallTracker.adoptEarlyRegistrations(
    backgroundJobBoard,
    options.backgroundJobSupervisor,
  );

  return {
    scheduleRuntimeStatusReconciliation: runtimeStatusReconciler.schedule,
    /**
     * v2-only extension handle (consumed by src/v2/setup.ts's executor
     * wrapper): register a delegated `subagent` launch from its STRUCTURED
     * executor result — sessionID/status/background, no prose parsing. The
     * pending for this callID is looked up (NOT consumed, so the after-hook
     * still takes and releases it) and routed through the SAME shared fence
     * pipeline the after-hook's launch branch uses; the pending is marked
     * handled-by-wrapper so the after-hook gates its launch-output and
     * background-promotion branches off (exactly-once registration on v2).
     * Registration/fence errors are logged and swallowed; the tool result
     * passes through untouched.
     */
    'v2.registerDelegatedLaunchFromStructured': (
      input: Omit<DelegatedLaunchFromStructuredInput, 'pending'> & {
        parentSessionID: string;
      },
    ): Promise<ReturnType<BackgroundJobBoard['get']>> => {
      const pending = pendingCallTracker.peekByCallId(
        input.callID,
        input.parentSessionID,
      );
      if (!pending) {
        log('[task-session-manager] v2 wrapper: pending call not found', {
          callID: input.callID,
        });
        return Promise.resolve(undefined);
      }
      return registerDelegatedLaunchFromStructured(
        { ...input, pending, handledByWrapper: true },
        {
          directory: _ctx.directory,
          backgroundJobBoard,
          terminalGate,
          backgroundJobSupervisor: options.backgroundJobSupervisor,
          backgroundTaskConcurrency: options.backgroundTaskConcurrency,
          getModelForAgent: options.getModelForAgent,
          taskContextTracker,
          isStaleDeletedTaskOutput: (taskID, lifecycleEpoch) => {
            const deletionEpoch = rehydrateState.deletionEpochs.get(taskID);
            return (
              deletionEpoch !== undefined && lifecycleEpoch < deletionEpoch
            );
          },
          bindConcurrencyTicket: (taskID, tracked) =>
            tracked.concurrencyTicket?.bind(taskID),
          firstAdmission: (sessionID) =>
            pendingCallTracker.firstAdmission(sessionID),
          clearRehydrateTombstone: (taskID) =>
            clearBackgroundJobSuppression(backgroundJobBoard, taskID),
        },
      );
    },

    hasDeferredError: (sessionID: string): boolean =>
      deferredInlineErrors.has(sessionID),
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
        hostFlavor: options.hostFlavor,
        isBackgroundDefaultFlipArmed: options.isBackgroundDefaultFlipArmed,
        recoverRetainedSession: options.recoverRetainedSession,
        resolveCanonicalTaskRef: options.resolveCanonicalTaskRef,
        isDisposed: options.isDisposed,
        adoptRequested: adoptionEnabled ? adoptRequested : undefined,
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
        backgroundTaskConcurrency: options.backgroundTaskConcurrency,
        getModelForAgent: options.getModelForAgent,
        bindConcurrencyTicket: (taskID, pending) =>
          pending.concurrencyTicket?.bind(taskID),
        recordLifecycleSuppression: (taskID) =>
          recordBackgroundJobSuppression(backgroundJobBoard, taskID),
        pendingCallTracker,
        firstAdmission: (sessionID) =>
          pendingCallTracker.firstAdmission(sessionID),
        taskContextTracker,
        clearRehydrateTombstone: (taskID) => {
          clearBackgroundJobSuppression(backgroundJobBoard, taskID);
        },
        isStaleDeletedTaskOutput: (taskID, lifecycleEpoch) => {
          const deletionEpoch = rehydrateState.deletionEpochs.get(taskID);
          return deletionEpoch !== undefined && lifecycleEpoch < deletionEpoch;
        },
        hostFlavor: options.hostFlavor,
      });
      runtimeStatusReconciler.schedule();
    },

    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
      view?: MessageTransformView,
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];
      const resolved = resolveView(view, messages);
      if (adoptionEnabled) {
        let viewSession: unknown;
        let viewStart = Number.POSITIVE_INFINITY;
        for (const message of messages) {
          if (!isObjectRecord(message) || !isObjectRecord(message.info))
            continue;
          viewSession ??= message.info.sessionID;
          const { time } = message.info;
          if (isObjectRecord(time) && typeof time.created === 'number')
            viewStart = Math.min(viewStart, time.created);
        }
        if (typeof viewSession === 'string' && viewStart !== Infinity)
          historyBoundaries.set(viewSession, viewStart);
      }

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

      // The view's user entries carry the source-array indices: the
      // injected-completion occurrence IDs below key on part indices and
      // must see the same positions the transcript array holds. Part reads
      // stay live — stabilize/rehydrate above mutate parts in place, and
      // nothing here adds or removes messages, so the indices hold.
      for (const { index: messageIndex, message } of resolved.userEntries) {
        if (!message.info.sessionID) {
          continue;
        }
        if (!options.shouldManageSession(message.info.sessionID)) {
          const sessionID = message.info.sessionID;
          if (message.info.agent !== 'orchestrator') {
            continue;
          }
          options.registerSessionAsOrchestrator?.(sessionID);
          if (!options.shouldManageSession(sessionID)) continue;
        }

        for (const [partIndex, part] of message.parts.entries()) {
          // The host's native completion commits the terminal state. Its
          // retirement is NOT observed here: on v1 the native delivery is
          // untagged (the plugin cannot see it as one of its own deltas), so
          // the run retires through the tagged-delta observation or the
          // stale-terminal fallback (issue #1647).
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
          // deferredInlineErrors is intentionally NOT cleared here: the
          // event router's session.deleted branch owns the deferral —
          // it publishes the deferred error for genuine deletions and
          // keeps it (with a re-armed backstop) through fallback
          // teardown. An unconditional clear would swallow the error
          // and strand a mid-fallback record in `running` forever.
          if (!options.isFallbackInProgress?.(sessionID)) {
            rememberDeletedSession(sessionID);
          }
        }
      }

      if (input.event.type === 'server.instance.disposed') {
        runtimeStatusReconciler.dispose();
        if (!options.terminalGate) terminalGate.dispose();
      }
      return handleEvent(input, {
        input: _ctx,
        inputWaits,
        idleSessionTokens,
        options,
        idleReconciler,
        withFallbackReason,
        deferredInlineErrors,
        backgroundJobBoard,
        terminalGate,
        pendingCallTracker,
        taskContextTracker,
        backgroundJobSupervisor: options.backgroundJobSupervisor,
        bindConcurrencyTicket: (taskID, pending) =>
          pending.concurrencyTicket?.bind(taskID),
        observeSyntheticTerminalPart: (part) =>
          observeSyntheticTerminalPart(injectionState, part),
        revivedRunTracker: options.revivedRunTracker,
        onChildInputWait: options.onChildInputWait,
      }).then(() => runtimeStatusReconciler.schedule());
    },
  };
}
