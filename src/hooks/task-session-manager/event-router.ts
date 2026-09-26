/**
 * Event router for task session manager.
 *
 * Routes lifecycle events (session.created, server.instance.disposed,
 * session.idle, session.error, session.status, session.deleted) to
 * the appropriate subsystems.
 */
import type { BackgroundJobExecution } from '../../utils/background-job-board';
import type { BackgroundJobStore } from '../../utils/background-job-store';
import type { BackgroundJobSupervisor } from '../../utils/background-job-supervisor';
import { log } from '../../utils/logger';
import {
  isFailoverError,
  isInlineFailoverError,
} from '../foreground-fallback/index';
import type {
  InjectedTerminalJobs,
  RetainedBoardSnapshotState,
} from './board-injection';
import {
  type ChildInputWaitKind,
  type ChildInputWaitNotification,
  clearChildInputWait,
  clearChildInputWaitsForSession,
  getChildInputWait,
  noteChildInputWait,
} from './child-input-wait';
import type {
  EarlyTaskRegistration,
  PendingTaskCall,
} from './pending-call-tracker';
import type { RevivedRunTracker } from './revived-run-tracker';

type BackgroundJobRecord = NonNullable<ReturnType<BackgroundJobStore['get']>>;

/**
 * Extract a human-readable message from a serialized session error.
 *
 * The core publishes session errors through NamedError.toObject(), whose
 * wire shape is `{ name: string; data: ... }` — the message lives in
 * `data.message` (APIError, ProviderAuthError, ...), not at the top
 * level. Reading only `error.message` yields undefined for every
 * serialized NamedError and the board fell back to the generic
 * "Session error" even when the detail existed two levels down (#1200
 * diagnostics). Plain `{ message }` shapes are still honored for
 * non-NamedError payloads.
 */
function structuredErrorMessage(error: unknown): string | undefined {
  if (!isRecordLike(error)) return undefined;
  const data = error.data;
  if (isRecordLike(data)) {
    const inner = data.message;
    // Whitespace-only strings must not bypass the generic fallback
    // (an empty board summary is worse than "Session error").
    if (typeof inner === 'string' && inner.trim().length > 0) return inner;
  }
  const direct = error.message;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct;
  return undefined;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface SessionEventGenerationFence {
  generation: number;
  /** A new generation must see a live activity fence before lifecycle events. */
  awaitingActivity: boolean;
}

interface SessionEventObservation {
  sessionID: string;
  job?: BackgroundJobRecord;
  generation?: number;
  observedAt: number;
  stale: boolean;
  /** Busy establishes the new local fence but does not mutate the board. */
  activityFenceOnly: boolean;
}

/**
 * OpenCode's v1 lifecycle events do not carry a run generation or a CAS token.
 * Keep the strongest local fence available: a board generation transition
 * quarantines the first unproven lifecycle sequence, while explicit host
 * provenance/timestamps (when present) are checked against the current run.
 * This cannot prove the origin of a same-ID event after the host has omitted
 * that provenance; callers must not treat this as remote atomicity.
 */
const sessionEventFences = new WeakMap<
  object,
  Map<string, SessionEventGenerationFence>
>();

function eventFenceMap(
  backgroundJobBoard: BackgroundJobStore,
): Map<string, SessionEventGenerationFence> {
  const key = backgroundJobBoard as object;
  const existing = sessionEventFences.get(key);
  if (existing) return existing;
  const created = new Map<string, SessionEventGenerationFence>();
  sessionEventFences.set(key, created);
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function eventGeneration(input: {
  event: { properties?: Record<string, unknown> };
}): number | undefined {
  const properties = input.event.properties;
  const info = isRecord(properties?.info) ? properties.info : undefined;
  const direct = properties?.generation;
  if (finiteNumber(direct)) return direct;
  return finiteNumber(info?.generation) ? info.generation : undefined;
}

function eventActivityAt(
  input: { event: { properties?: Record<string, unknown> } },
  fallback: number,
): number {
  const properties = input.event.properties;
  const info = isRecord(properties?.info) ? properties.info : undefined;
  const infoTime = isRecord(info?.time) ? info.time : undefined;
  const directCandidates = [
    properties?.activityAt,
    properties?.timestamp,
    properties?.time,
    info?.activityAt,
    info?.timestamp,
    infoTime?.updated,
  ];
  const observed = directCandidates.find(finiteNumber);
  return observed === undefined ? fallback : observed;
}

function rememberSessionGeneration(
  backgroundJobBoard: BackgroundJobStore,
  sessionID: string,
): void {
  const job = backgroundJobBoard.get(sessionID);
  if (!job) return;
  const fences = eventFenceMap(backgroundJobBoard);
  const previous = fences.get(sessionID);
  if (!previous || previous.generation !== job.generation) {
    fences.set(sessionID, {
      generation: job.generation,
      awaitingActivity: previous !== undefined,
    });
  }
}

function observeSessionEvent(
  backgroundJobBoard: BackgroundJobStore,
  input: { event: { properties?: Record<string, unknown> } },
  sessionID: string,
  observedAt: number,
  isBusy: boolean,
): SessionEventObservation {
  const job = backgroundJobBoard.get(sessionID);
  if (!job) {
    eventFenceMap(backgroundJobBoard).delete(sessionID);
    return {
      sessionID,
      observedAt,
      stale: false,
      activityFenceOnly: false,
    };
  }

  const fences = eventFenceMap(backgroundJobBoard);
  const previous = fences.get(sessionID);
  const generationChanged =
    previous !== undefined && previous.generation !== job.generation;
  const fence = generationChanged
    ? {
        generation: job.generation,
        awaitingActivity: true,
      }
    : (previous ?? {
        generation: job.generation,
        awaitingActivity: false,
      });
  fences.set(sessionID, fence);

  const suppliedGeneration = eventGeneration(input);
  const suppliedCurrentGeneration =
    suppliedGeneration !== undefined && suppliedGeneration === job.generation;
  const activityIsBeforeRun = observedAt < job.runStartedAt;
  const activityIsBeforeCurrentBusy =
    job.lastLiveBusyAt !== undefined && job.lastLiveBusyAt > observedAt;
  const stale =
    (suppliedGeneration !== undefined && !suppliedCurrentGeneration) ||
    activityIsBeforeRun ||
    activityIsBeforeCurrentBusy ||
    (fence.awaitingActivity && !isBusy && !suppliedCurrentGeneration);

  // A host event without provenance can only establish a local activity
  // boundary. Do not let that first post-relaunch busy observation mutate G2;
  // a later event runs after the boundary has been established.
  const activityFenceOnly =
    !stale && fence.awaitingActivity && isBusy && !suppliedCurrentGeneration;
  if (!stale && (activityFenceOnly || suppliedCurrentGeneration)) {
    fence.awaitingActivity = false;
  }

  return {
    sessionID,
    job,
    generation: job.generation,
    observedAt,
    stale,
    activityFenceOnly,
  };
}

function isCurrentSessionObservation(
  backgroundJobBoard: BackgroundJobStore,
  observation: SessionEventObservation,
): boolean {
  if (!observation.job || observation.generation === undefined) return true;
  const current = backgroundJobBoard.get(observation.sessionID);
  if (!current || current.generation !== observation.generation) return false;
  if (current.runStartedAt > observation.observedAt) return false;
  return !(
    current.lastLiveBusyAt !== undefined &&
    current.lastLiveBusyAt > observation.observedAt
  );
}

export async function handleEvent(
  input: {
    event: {
      type: string;
      properties?: {
        info?: {
          id?: string;
          parentID?: string;
          agent?: string;
          title?: string;
          generation?: number;
          activityAt?: number;
          timestamp?: number;
          time?: { updated?: number };
        };
        id?: string;
        requestID?: string;
        sessionID?: string;
        generation?: number;
        activityAt?: number;
        timestamp?: number;
        time?: { updated?: number };
        status?: { type?: string };
        error?: { name?: string };
        part?: unknown;
      };
    };
  },
  deps: {
    inputWaits: {
      trackInputWait(event: {
        type: string;
        properties?: {
          id?: string;
          requestID?: string;
          sessionID?: string;
        };
      }): void;
      clearInputWaits(sessionID: string): void;
      waitsByParent: Map<string, Set<string | symbol>>;
    };
    idleSessionTokens: {
      clearSession(sessionID: string): void;
      invalidate(sessionID: string): void;
      /** Drop local idle-token bookkeeping; keep process-global wait_for_user. */
      disposeLocalState(): void;
      sessionTokens: Map<string, symbol>;
    };
    options: {
      shouldManageSession: (sessionID: string) => boolean;
      registerSessionAsOrchestrator?: (sessionID: string) => void;
      isFallbackInProgress?: (sessionID: string) => boolean;
      /** True when foreground fallback could still recover the session. */
      willAttemptFallback?: (sessionID: string) => boolean;
      /** Test seam; production uses event-arrival wall-clock time. */
      now?: () => number;
    };
    idleReconciler: {
      scheduleIdleReconciliation(sessionID: string): void;
      scheduleChildIdleReconciliation(
        sessionID: string,
        idleObservedAt: number,
        observedGeneration: number,
        error?: string,
      ): void;
      clearIdleTimers(sessionID: string): void;
      clearAllTimers(): string[];
    };
    /** Sessions with a deferred failover error awaiting the fallback
     *  outcome, mapped to the summary the idle backstop publishes when
     *  no recovery happens (managed inline 401/410, background children
     *  with an armed fallback chain). */
    deferredInlineErrors: Map<string, string>;
    backgroundJobBoard: BackgroundJobStore;
    terminalGate: import('../../utils/background-job-terminal-gate').BackgroundJobTerminalGate;
    pendingCallTracker: {
      peekByParentAndAgent(
        parentSessionID: string,
        agentHint?: string,
        title?: string,
      ): PendingTaskCall | undefined;
      clearSession(sessionID: string): void;
      clearAll?(): void;
    };
    taskContextTracker: {
      pendingManagedTaskIds: Set<string>;
      clearSession(sessionID: string): void;
      prune(board: { taskIDs(): Set<string> }): void;
    };
    terminalJobsInjectedByParent: Map<string, InjectedTerminalJobs>;
    pendingInjectedTerminalJobsByParent: Map<
      string,
      Map<string, BackgroundJobExecution>
    >;
    retainedBoardSnapshots: Map<string, RetainedBoardSnapshotState>;
    backgroundJobSupervisor?: BackgroundJobSupervisor;
    bindConcurrencyTicket?: (taskID: string, pending: PendingTaskCall) => void;
    releaseConcurrencyTask?: (taskID: string) => void;
    observeSyntheticTerminalPart?: (part: unknown) => void;
    revivedRunTracker?: RevivedRunTracker;
    /** Surface a background child's newly opened input wait to the parent. */
    onChildInputWait?: (notification: ChildInputWaitNotification) => void;
    /** Test seam; production uses event-arrival wall-clock time. */
    now?: () => number;
  },
): Promise<void> {
  deps.inputWaits.trackInputWait(input.event);
  routeChildInputWait(input, deps);

  if (input.event.type === 'message.part.updated') {
    deps.observeSyntheticTerminalPart?.(input.event.properties?.part);
    return;
  }

  if (input.event.type === 'session.created') {
    const info = input.event.properties?.info;
    if (info?.id) deps.retainedBoardSnapshots.delete(info.id);
    if (info?.id) {
      rememberSessionGeneration(deps.backgroundJobBoard, info.id);
    }
    log('[task-session-manager] session.created observed', {
      sessionID: info?.id,
      parentSessionID: info?.parentID,
      managesParent: info?.parentID
        ? deps.options.shouldManageSession(info.parentID)
        : false,
    });
    if (
      info?.id &&
      info.parentID &&
      deps.options.shouldManageSession(info.parentID)
    ) {
      deps.taskContextTracker.pendingManagedTaskIds.add(info.id);
      // Early board registration: if the parent tool call is cancelled
      // before tool.execute.after (e.g. foreground fallback abort), the
      // after-hook never fires and the job is never tracked — idle then
      // reports runningJobForSession:false and the orchestrator sees
      // "Task cancelled" while the child is still working (#765).
      // Peek (don't take) so tool.execute.after can still re-register.
      //
      // When the parent has multiple task calls in flight at once (e.g.
      // parallel council reviewers), `info.agent` on the child session
      // identifies which subagent started it; prefer the matching
      // pending call so we don't attribute the child to the wrong agent.
      const pending = deps.pendingCallTracker.peekByParentAndAgent(
        info.parentID,
        info.agent,
        typeof info.title === 'string' ? info.title : undefined,
      );
      if (pending && !pending.resumedTaskId && !pending.earlyRegisteredTaskID) {
        if (deps.backgroundJobBoard.get(info.id)) {
          // The child is already registered — its own tool.execute.after
          // won the race. Fencing the peeked pending here punished an
          // unrelated call and caused its later output to be dropped
          // (incident 2026-09-12); the existing board record already
          // prevents double registration.
          log(
            '[task-session-manager] skipped early registration for an already-registered task ID',
            { taskID: info.id, parentSessionID: info.parentID },
          );
        } else {
          try {
            const record = deps.backgroundJobBoard.registerLaunch({
              taskID: info.id,
              parentSessionID: pending.parentSessionId,
              agent: pending.agentType,
              description: pending.label,
              objective: pending.fullObjective ?? pending.label,
              // session.created has no reliable call identity. Keep this
              // registration tentative so an unrelated foreground call cannot
              // accidentally arm wall-clock supervision.
              background: false,
            });
            pending.earlyRegisteredTaskID = record.taskID;
            pending.earlyRegistration = {
              taskID: record.taskID,
              generation: record.generation,
              backgroundJobBoard: deps.backgroundJobBoard,
              backgroundJobSupervisor: deps.backgroundJobSupervisor,
            } satisfies EarlyTaskRegistration;
            deps.bindConcurrencyTicket?.(record.taskID, pending);
            log(
              '[task-session-manager] tentative early board registration from session.created',
              {
                taskID: record.taskID,
                alias: record.alias,
                parentSessionID: record.parentSessionID,
                agent: record.agent,
              },
            );
          } catch (error) {
            pending.earlyRegistrationRejected = true;
            log(
              '[task-session-manager] refused fenced early registration from session.created',
              {
                taskID: info.id,
                parentSessionID: info.parentID,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
      }

      if (!pending && !deps.backgroundJobBoard.get(info.id)) {
        // No pending call can be attributed to this child (ambiguous
        // parallel launches, or the owning pending was consumed).
        // Register a placeholder so task_status/task_result always
        // resolve it; the matching tool.execute.after corrects the
        // description via registerLaunch's existing-record update path
        // when it fires.
        const agent =
          typeof info.agent === 'string' && info.agent ? info.agent : 'unknown';
        try {
          const record = deps.backgroundJobBoard.registerLaunch({
            taskID: info.id,
            parentSessionID: info.parentID,
            agent,
            description: `unattributed ${agent} task`,
            objective: `unattributed ${agent} task`,
            background: false,
            provisional: true,
          });
          log(
            '[task-session-manager] placeholder board registration for unattributed child session',
            {
              taskID: record.taskID,
              alias: record.alias,
              parentSessionID: info.parentID,
              agent,
            },
          );
        } catch (error) {
          log(
            '[task-session-manager] refused placeholder registration for child session',
            {
              taskID: info.id,
              parentSessionID: info.parentID,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
    }
    return;
  }

  if (input.event.type === 'server.instance.disposed') {
    deps.backgroundJobSupervisor?.dispose();
    deps.revivedRunTracker?.dispose();
    deps.retainedBoardSnapshots.clear();
    eventFenceMap(deps.backgroundJobBoard).clear();
    const idleSessionIds = deps.idleReconciler.clearAllTimers();
    // Local-only: drop idle tokens. Process-global wait_for_user stays armed.
    const waitSessionIDs = new Set([
      ...idleSessionIds,
      ...deps.idleSessionTokens.sessionTokens.keys(),
      ...deps.inputWaits.waitsByParent.keys(),
    ]);
    deps.idleSessionTokens.disposeLocalState();
    for (const sessionID of waitSessionIDs) {
      deps.inputWaits.clearInputWaits(sessionID);
    }
    return;
  }

  if (
    input.event.type === 'session.idle' ||
    (input.event.type === 'session.status' &&
      (input.event.properties as { status?: { type?: string } } | undefined)
        ?.status?.type === 'idle')
  ) {
    const sessionId =
      input.event.properties?.info?.id || input.event.properties?.sessionID;
    const observedAt = eventActivityAt(
      input,
      deps.options.now?.() ?? Date.now(),
    );
    const observation = sessionId
      ? observeSessionEvent(
          deps.backgroundJobBoard,
          input,
          sessionId,
          observedAt,
          false,
        )
      : undefined;
    if (observation?.stale || observation?.activityFenceOnly) return;
    const job = observation?.job;
    const runningJobForSession = job?.state === 'running' || false;
    // Warn elevation: a tracked managed child (session.created-observed,
    // not yet settled by its terminal output) reporting idle while the
    // board holds no running record for it is the host/board drift
    // signature — without the warn prefix these hid inside the routine
    // idle log line. The logger is single-level text, so the severity
    // rides the `[task-session-manager] WARN:` prefix (same convention
    // as the `[plugin] WARN:` lines in src/index.ts).
    const trackedManagedChildWithoutJob =
      sessionId !== undefined &&
      !runningJobForSession &&
      deps.taskContextTracker.pendingManagedTaskIds.has(sessionId);
    log(
      trackedManagedChildWithoutJob
        ? '[task-session-manager] WARN: idle observed for tracked managed child with no running board record'
        : '[task-session-manager] idle/status idle observed',
      {
        sessionID: sessionId,
        managesSession: sessionId
          ? deps.options.shouldManageSession(sessionId)
          : false,
        terminalJobsPending: sessionId
          ? (deps.terminalJobsInjectedByParent.get(sessionId)?.executions
              .size ?? 0) +
            (deps.pendingInjectedTerminalJobsByParent.get(sessionId)?.size ?? 0)
          : 0,
        runningJobForSession,
      },
    );
    if (sessionId && deps.options.shouldManageSession(sessionId)) {
      deps.idleReconciler.scheduleIdleReconciliation(sessionId);
    }

    // Fallback: for background child sessions that go idle without
    // an injected completion, reconcile the board entry since the
    // session being idle is itself the completion signal.
    // Delayed so FG can claim the session before we mark completed.
    if (job && sessionId && job.state === 'running') {
      const deferredError = deps.deferredInlineErrors.get(sessionId);
      if (deferredError !== undefined) {
        // A failover-worthy error was deferred for fallback recovery but
        // the session ended without one: terminalize as error instead of
        // the false completion the child-idle path would record.
        deps.idleReconciler.scheduleChildIdleReconciliation(
          sessionId,
          observedAt,
          job.generation,
          deferredError,
        );
      } else {
        deps.idleReconciler.scheduleChildIdleReconciliation(
          sessionId,
          observedAt,
          job.generation,
        );
      }
    }
    return;
  }

  if (input.event.type === 'session.error') {
    const sessionId =
      input.event.properties?.info?.id || input.event.properties?.sessionID;
    const observedAt = eventActivityAt(
      input,
      deps.options.now?.() ?? Date.now(),
    );
    const observation = sessionId
      ? observeSessionEvent(
          deps.backgroundJobBoard,
          input,
          sessionId,
          observedAt,
          false,
        )
      : undefined;
    if (
      observation?.stale ||
      observation?.activityFenceOnly ||
      (observation &&
        !isCurrentSessionObservation(deps.backgroundJobBoard, observation))
    ) {
      return;
    }
    if (sessionId) {
      deps.idleSessionTokens.invalidate(sessionId);
    }
    if (sessionId && deps.options.shouldManageSession(sessionId)) {
      const props = input.event.properties as { error?: unknown } | undefined;
      // Only clear injected terminal jobs for fatal errors.
      // Rate-limit errors are recovered by ForegroundFallbackManager
      // (abort + reprompt with fallback model); clearing the injected
      // job state here would make the orchestrator lose track of
      // completed background tasks and unable to dispatch follow-ups.
      // Persistent 401/410 (auth, model gone) may ALSO be recovered by a
      // fallback reprompt, so defer while recovery is still possible:
      // record the deferred error in the map so an idle with no recovery
      // terminalizes the job as 'error' instead of a false completion.
      // When no chain exists, fallback is disabled, or the chain is
      // exhausted the error is final — record it now.
      if (
        !props?.error ||
        !isFailoverError(props.error) ||
        (isInlineFailoverError(props.error) &&
          !deps.options.willAttemptFallback?.(sessionId))
      ) {
        deps.deferredInlineErrors.delete(sessionId);
        deps.terminalJobsInjectedByParent.delete(sessionId);
        deps.pendingInjectedTerminalJobsByParent.delete(sessionId);
        // Record non-retryable errors on the job board so the
        // orchestrator sees the failure instead of a false completion.
        const job = observation?.job ?? deps.backgroundJobBoard.get(sessionId);
        if (job && job.state === 'running') {
          // BackgroundJobStore has no expected-generation/CAS form for
          // updateStatus. The check immediately above is the strongest
          // synchronous boundary available; a remote event cannot be made
          // atomic with a later relaunch through this API.
          if (
            observation &&
            !isCurrentSessionObservation(deps.backgroundJobBoard, observation)
          ) {
            return;
          }
          await deps.terminalGate.reconcile(job, {
            kind: 'session-error',
            message: structuredErrorMessage(props?.error) ?? 'Session error',
          });
        }
      } else if (isInlineFailoverError(props.error)) {
        // Recovery possible: defer. The idle backstop terminalizes this
        // if the fallback fails silently; busy/deleted clears it.
        deps.deferredInlineErrors.set(
          sessionId,
          'Session error after failed model fallback (auth/model unavailable)',
        );
      }
    } else if (sessionId) {
      // Child subagent sessions are not orchestrators, so the block
      // above never runs for them. Without this, a failed background
      // subagent leaves its job in `running` and the idle-reconciliation
      // path (which has no shouldManageSession guard) marks it
      // `completed` — a false success. A child with no fallback chain has
      // nothing to retry into, so surface the failure on the board.
      const props = input.event.properties as { error?: unknown } | undefined;
      if (deps.options.isFallbackInProgress?.(sessionId)) return;
      const job = observation?.job ?? deps.backgroundJobBoard.get(sessionId);
      // This router sees session.error BEFORE ForegroundFallbackManager
      // does (event-hook dispatch order in src/index.ts), so the
      // isFallbackInProgress guard above cannot cover the fallback this
      // error is about to trigger. Reconciling a failover-worthy error
      // now would publish it to the parent while the fallback re-prompt
      // is still coming: the substituted run's result is delivered
      // through the observation handoff, which only arms while the
      // record is still 'running' (fallback-observation-transfer prepare
      // guard) — an early terminal state orphans the retried run's
      // result. Defer instead, mirroring the managed branch's 401/410
      // contract: live busy from the re-prompt clears the deferral; an
      // idle without recovery terminalizes the deferred error, so the
      // parent still sees the failure.
      if (
        job &&
        job.state === 'running' &&
        props?.error &&
        isFailoverError(props.error) &&
        deps.options.willAttemptFallback?.(sessionId)
      ) {
        deps.deferredInlineErrors.set(
          sessionId,
          structuredErrorMessage(props.error) ?? 'Session error',
        );
        return;
      }
      deps.deferredInlineErrors.delete(sessionId);
      if (job && job.state === 'running') {
        // This is a final synchronous generation check, not a claim that
        // updateStatus is a CAS operation; the store API cannot provide that.
        if (
          observation &&
          !isCurrentSessionObservation(deps.backgroundJobBoard, observation)
        ) {
          return;
        }
        await deps.terminalGate.reconcile(job, {
          kind: 'session-error',
          message: structuredErrorMessage(props?.error) ?? 'Session error',
        });
      }
    }

    return;
  }

  if (input.event.type === 'session.status') {
    const sessionId =
      input.event.properties?.info?.id || input.event.properties?.sessionID;
    const statusType = (
      input.event.properties as { status?: { type?: string } } | undefined
    )?.status?.type;
    if (statusType !== 'busy' && statusType !== 'retry') {
      if (sessionId) deps.idleSessionTokens.invalidate(sessionId);
      return;
    }
    const observedAt = eventActivityAt(
      input,
      deps.options.now?.() ?? Date.now(),
    );
    const observation = sessionId
      ? observeSessionEvent(
          deps.backgroundJobBoard,
          input,
          sessionId,
          observedAt,
          true,
        )
      : undefined;
    if (observation?.stale || observation?.activityFenceOnly) return;
    if (
      observation &&
      !isCurrentSessionObservation(deps.backgroundJobBoard, observation)
    ) {
      return;
    }
    if (sessionId) deps.idleSessionTokens.invalidate(sessionId);
    // Live busy cancels a pending child idle-reconcile — the session
    // recovered (FG re-prompt or continued work).
    // Note: invalidate above already cleared the parent idle-reconcile
    // timer; clearIdleTimers handles the child timer.
    if (sessionId) {
      deps.idleReconciler.clearIdleTimers(sessionId);
      // Live busy after a deferred failover error means the fallback
      // re-prompt (or continued work) recovered the session — the error
      // is not final.
      deps.deferredInlineErrors.delete(sessionId);
    }
    const before = sessionId
      ? (observation?.job ?? deps.backgroundJobBoard.get(sessionId))
      : undefined;
    const token = before ? deps.terminalGate.capture(before) : undefined;
    const eventAt = eventActivityAt(input, Number.NaN);
    if (before && token) {
      const result = deps.terminalGate.observe(token, {
        kind: statusType,
        origin: 'session.status-event',
        readStartedAt: token.readStartedAt,
        observedAt: Number.isFinite(eventAt) ? eventAt : undefined,
      });
      // Deferred without recorded activity means the gate needs a contrast.
      // A stale identity never gets upgraded into a request for the current run.
      if (
        result.kind === 'deferred' &&
        result.record.activityRevision === before.activityRevision
      )
        await deps.terminalGate.reconcile(before);
    }
    const updated = sessionId
      ? deps.backgroundJobBoard.get(sessionId)
      : undefined;
    if (before?.cancellationRequested) {
      log('[task-session-manager] busy observed after cancel request', {
        sessionID: sessionId,
        previousState: before.state,
        previousTerminalState: before.terminalState,
        terminalUnreconciled: before.terminalUnreconciled,
        resultSummary: before.resultSummary,
      });
    }
    log('[task-session-manager] busy/status busy observed', {
      sessionID: sessionId,
      managesSession: sessionId
        ? deps.options.shouldManageSession(sessionId)
        : false,
      previousState: before?.state,
      previousTerminalState: before?.terminalState,
      previousCancellationRequested: before?.cancellationRequested ?? false,
      previousLastLiveBusyAt: before?.lastLiveBusyAt,
      updatedState: updated?.state,
      updatedCancellationRequested: updated?.cancellationRequested ?? false,
      updatedLastLiveBusyAt: updated?.lastLiveBusyAt,
    });
    return;
  }

  if (input.event.type !== 'session.deleted') return;
  const sessionId =
    input.event.properties?.info?.id || input.event.properties?.sessionID;
  if (!sessionId) return;

  const observedAt = eventActivityAt(input, deps.options.now?.() ?? Date.now());
  const observation = observeSessionEvent(
    deps.backgroundJobBoard,
    input,
    sessionId,
    observedAt,
    false,
  );
  const suppliedGeneration = eventGeneration(input);
  const hasCurrentGenerationProvenance =
    suppliedGeneration !== undefined &&
    observation.generation !== undefined &&
    suppliedGeneration === observation.generation;
  const ambiguousRelaunchDeletion =
    observation.job !== undefined &&
    observation.job.generation > 1 &&
    !hasCurrentGenerationProvenance;
  if (
    observation.stale ||
    observation.activityFenceOnly ||
    !isCurrentSessionObservation(deps.backgroundJobBoard, observation) ||
    ambiguousRelaunchDeletion
  ) {
    log(
      '[task-session-manager] ignored session.deleted without current-generation proof',
      {
        sessionID: sessionId,
        currentGeneration: observation.generation,
        eventGeneration: suppliedGeneration,
        observedAt,
        reason: ambiguousRelaunchDeletion
          ? 'OpenCode event has no generation/CAS provenance after relaunch'
          : 'generation or activity fence rejected deletion',
      },
    );
    return;
  }

  // Foreground-fallback teardown recreates the session; keep process-global
  // wait_for_user. Genuine deletion clears wait state for the session.
  if (deps.options.isFallbackInProgress?.(sessionId)) {
    deps.idleSessionTokens.invalidate(sessionId);
  } else {
    deps.idleSessionTokens.clearSession(sessionId);
  }
  deps.inputWaits.clearInputWaits(sessionId);
  deps.pendingCallTracker.clearSession(sessionId);
  deps.retainedBoardSnapshots.delete(sessionId);
  clearChildInputWaitsForSession(sessionId);
  const fallbackInProgress =
    deps.options.isFallbackInProgress?.(sessionId) === true;
  const job = deps.backgroundJobBoard.get(sessionId);
  if (!fallbackInProgress || job?.deadlineExceededAt !== undefined) {
    deps.backgroundJobSupervisor?.onSessionDeleted(sessionId);
  }

  log('[task-session-manager] session.deleted observed', {
    sessionID: sessionId,
  });
  eventFenceMap(deps.backgroundJobBoard).delete(sessionId);
}

/**
 * Surface a background child's pending question/permission to its parent.
 *
 * The per-session input-wait tracker arms a wait for the asking session
 * only; a background child's ask never reaches the parent whose turn
 * already ended. When the asking session is a RUNNING board-tracked
 * BACKGROUND child, record the ask in the child-input-wait sidecar
 * (idempotent per request id) and notify so the parent can be woken with
 * the ask content. Replies/rejections clear the entry. Foreground children
 * (background !== true), unknown sessions, and id-less asks are ignored.
 */
function routeChildInputWait(
  input: {
    event: {
      type: string;
      properties?: {
        id?: string;
        requestID?: string;
        sessionID?: string;
        questions?: unknown;
        permission?: unknown;
        patterns?: unknown;
      };
    };
  },
  deps: {
    backgroundJobBoard: BackgroundJobStore;
    onChildInputWait?: (notification: ChildInputWaitNotification) => void;
    now?: () => number;
  },
): void {
  const type = input.event.type;
  const properties = input.event.properties;
  const sessionID = properties?.sessionID;
  if (!sessionID) return;

  if (
    type === 'question.asked' ||
    type === 'question.v2.asked' ||
    type === 'permission.asked'
  ) {
    const kind: ChildInputWaitKind =
      type === 'permission.asked' ? 'permission' : 'question';
    const requestID =
      typeof properties?.id === 'string' ? properties.id : undefined;
    if (!requestID || requestID.trim() === '') return;
    const job = deps.backgroundJobBoard.get(sessionID);
    if (
      job?.state !== 'running' ||
      job.background !== true ||
      job.provisional === true
    ) {
      return;
    }
    const existingWait = getChildInputWait(sessionID, requestID);
    const existingSnapshot = existingWait
      ? {
          questionsLength: existingWait.questions?.length ?? 0,
          permission: existingWait.permission ?? '',
          patternsLength: existingWait.patterns?.length ?? 0,
        }
      : undefined;
    const isDuplicate = existingWait !== undefined;
    const record = noteChildInputWait({
      taskID: sessionID,
      parentSessionID: job.parentSessionID,
      kind,
      requestID,
      questions: properties?.questions,
      permission: properties?.permission,
      patterns: properties?.patterns,
      now: deps.now?.(),
    });
    if (record) {
      // The hook instance also subscribes to the sidecar globally (for asks
      // observed by other instances); notify the direct dep here so callers
      // that only hold this hook still see the ask. noteChildInputWait only
      // notifies global subscribers on the FIRST ask per request id, and
      // this direct call mirrors that for true duplicates. A raw v2
      // permission.asked can arrive before its normalized v1-shaped copy;
      // when the duplicate enriches the stored wait with action/resources,
      // re-notify so the queued parent wake can replace its stale
      // "unknown" delta before delivery.
      const enrichedDuplicate =
        existingSnapshot !== undefined &&
        (existingSnapshot.questionsLength < (record.questions?.length ?? 0) ||
          (!existingSnapshot.permission && !!record.permission) ||
          existingSnapshot.patternsLength < (record.patterns?.length ?? 0));
      if (!isDuplicate || enrichedDuplicate) {
        deps.onChildInputWait?.({
          parentSessionID: record.parentSessionID,
          taskID: record.taskID,
          kind: record.kind,
          requestID: record.requestID,
        });
      }
      log('[task-session-manager] background child input wait opened', {
        taskID: record.taskID,
        parentSessionID: record.parentSessionID,
        kind: record.kind,
        requestID: record.requestID,
      });
    }
    return;
  }

  if (
    type === 'question.replied' ||
    type === 'question.v2.replied' ||
    type === 'question.rejected' ||
    type === 'question.v2.rejected' ||
    type === 'permission.replied'
  ) {
    const requestID =
      typeof properties?.requestID === 'string'
        ? properties.requestID
        : undefined;
    if (!requestID || requestID.trim() === '') return;
    if (
      clearChildInputWait(sessionID, requestID) &&
      deps.backgroundJobBoard.get(sessionID)
    ) {
      log('[task-session-manager] background child input wait resolved', {
        taskID: sessionID,
        requestID,
      });
    }
  }
}
