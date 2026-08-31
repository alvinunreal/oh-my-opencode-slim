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
  RevivalCorrection,
} from './board-injection';
import type { PendingTaskCall } from './pending-call-tracker';
import type { RevivedRunTracker } from './revived-run-tracker';

type BackgroundJobRecord = NonNullable<ReturnType<BackgroundJobStore['get']>>;

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
      ): void;
      scheduleErrorTerminalize(
        sessionID: string,
        idleObservedAt: number,
        observedGeneration: number,
      ): void;
      clearIdleTimers(sessionID: string): void;
      clearAllTimers(): string[];
    };
    /** Sessions with a deferred inline 401/410 awaiting fallback outcome. */
    deferredInlineErrors: Set<string>;
    backgroundJobBoard: BackgroundJobStore;
    pendingCallTracker: {
      peekByParentAndAgent(
        parentSessionID: string,
        agentHint?: string,
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
    observeSyntheticTerminalPart?: (part: unknown) => void;
    /** Called when a stopped job revives to running on live activity. */
    enqueueRevivalCorrection?: (correction: RevivalCorrection) => void;
    revivedRunTracker?: RevivedRunTracker;
  },
): Promise<void> {
  deps.inputWaits.trackInputWait(input.event);

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
      );
      if (pending && !pending.resumedTaskId && !pending.earlyRegisteredTaskID) {
        if (deps.backgroundJobBoard.get(info.id)) {
          pending.earlyRegistrationRejected = true;
          log(
            '[task-session-manager] refused early registration for an existing task ID',
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
    }
    return;
  }

  if (input.event.type === 'server.instance.disposed') {
    deps.backgroundJobSupervisor?.dispose();
    deps.revivedRunTracker?.dispose();
    deps.pendingCallTracker.clearAll?.();
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
    log('[task-session-manager] idle/status idle observed', {
      sessionID: sessionId,
      managesSession: sessionId
        ? deps.options.shouldManageSession(sessionId)
        : false,
      terminalJobsPending: sessionId
        ? (deps.terminalJobsInjectedByParent.get(sessionId)?.executions.size ??
            0) +
          (deps.pendingInjectedTerminalJobsByParent.get(sessionId)?.size ?? 0)
        : 0,
      runningJobForSession: job?.state === 'running' || false,
    });
    if (sessionId && deps.options.shouldManageSession(sessionId)) {
      deps.idleReconciler.scheduleIdleReconciliation(sessionId);
    }

    // Fallback: for background child sessions that go idle without
    // an injected completion, reconcile the board entry since the
    // session being idle is itself the completion signal.
    // Delayed so FG can claim the session before we mark completed.
    if (job && sessionId && job.state === 'running') {
      if (deps.deferredInlineErrors.has(sessionId)) {
        // A persistent 401/410 was deferred for fallback recovery but the
        // session ended without one: terminalize as error instead of the
        // false completion the child-idle path would record.
        deps.idleReconciler.scheduleErrorTerminalize(
          sessionId,
          observedAt,
          job.generation,
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
      // record the deferred error in the set so an idle with no recovery
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
          const updated = deps.backgroundJobBoard.updateStatus({
            taskID: sessionId,
            state: 'error',
            expectedGeneration: observation?.generation,
            resultSummary:
              (props?.error as { message?: string } | undefined)?.message ??
              'Session error',
          });
          if (updated) deps.revivedRunTracker?.onTerminal(updated);
        }
      } else if (isInlineFailoverError(props.error)) {
        // Recovery possible: defer. The idle backstop terminalizes this
        // if the fallback fails silently; busy/deleted clears it.
        deps.deferredInlineErrors.add(sessionId);
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
      if (job && job.state === 'running') {
        // This is a final synchronous generation check, not a claim that
        // updateStatus is a CAS operation; the store API cannot provide that.
        if (
          observation &&
          !isCurrentSessionObservation(deps.backgroundJobBoard, observation)
        ) {
          return;
        }
        const updated = deps.backgroundJobBoard.updateStatus({
          taskID: sessionId,
          state: 'error',
          expectedGeneration: observation?.generation,
          resultSummary:
            (props?.error as { message?: string } | undefined)?.message ??
            'Session error',
        });
        if (updated) deps.revivedRunTracker?.onTerminal(updated);
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
    if (statusType !== 'busy') {
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
      // Live busy after a deferred 401/410 means the fallback re-prompt
      // (or continued work) recovered the session — the error is not final.
      deps.deferredInlineErrors.delete(sessionId);
    }
    const before = sessionId
      ? (observation?.job ?? deps.backgroundJobBoard.get(sessionId))
      : undefined;
    const updated = sessionId
      ? deps.backgroundJobBoard.markRunningFromLiveSession(
          sessionId,
          observedAt,
          observation?.generation,
        )
      : undefined;
    if (
      before?.state === 'stopped' &&
      before.terminalUnreconciled &&
      updated?.state === 'running'
    ) {
      deps.enqueueRevivalCorrection?.({
        parentSessionID: before.parentSessionID,
        taskID: before.taskID,
        alias: before.alias,
      });
    }
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
