/**
 * Event router for task session manager.
 *
 * Routes lifecycle events (session.created, server.instance.disposed,
 * session.idle, session.error, session.status, session.deleted) to
 * the appropriate subsystems.
 */
import type { BackgroundJobStore } from '../../utils/background-job-store';
import { log } from '../../utils/logger';
import { isFailoverError } from '../foreground-fallback/index';
import type { PendingTaskCall } from './pending-call-tracker';

export async function handleEvent(
  input: {
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
    continuationTokens: {
      clearContinuation(sessionID: string): void;
      invalidateContinuation(sessionID: string): void;
      sessionTokens: Map<string, symbol>;
      evaluations: Map<string, Set<symbol>>;
      consumed: Set<string>;
    };
    options: {
      shouldManageSession: (sessionID: string) => boolean;
      registerSessionAsOrchestrator?: (sessionID: string) => void;
      isFallbackInProgress?: (sessionID: string) => boolean;
    };
    idleReconciler: {
      scheduleIdleReconciliation(sessionID: string): void;
      scheduleChildIdleReconciliation(
        sessionID: string,
        idleObservedAt: number,
      ): void;
      clearIdleTimers(sessionID: string): void;
      clearAllTimers(): string[];
    };
    backgroundJobBoard: BackgroundJobStore;
    pendingCallTracker: {
      peekByParentAndAgent(
        parentSessionID: string,
        agentHint?: string,
      ): PendingTaskCall | undefined;
      clearSession(sessionID: string): void;
    };
    taskContextTracker: {
      pendingManagedTaskIds: Set<string>;
      clearSession(sessionID: string): void;
      prune(board: { taskIDs(): Set<string> }): void;
    };
    terminalJobsInjectedByParent: Map<string, Set<string>>;
  },
): Promise<void> {
  deps.inputWaits.trackInputWait(input.event);

  if (input.event.type === 'session.created') {
    const info = input.event.properties?.info;
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
      if (
        pending &&
        !pending.resumedTaskId &&
        !deps.backgroundJobBoard.get(info.id)
      ) {
        const record = deps.backgroundJobBoard.registerLaunch({
          taskID: info.id,
          parentSessionID: pending.parentSessionId,
          agent: pending.agentType,
          description: pending.label,
          objective: pending.label,
        });
        log(
          '[task-session-manager] early board registration from session.created',
          {
            taskID: record.taskID,
            alias: record.alias,
            parentSessionID: record.parentSessionID,
            agent: record.agent,
          },
        );
      }
    }
    return;
  }

  if (input.event.type === 'server.instance.disposed') {
    const idleSessionIds = deps.idleReconciler.clearAllTimers();
    const continuationSessionIDs = new Set([
      ...idleSessionIds,
      ...deps.continuationTokens.sessionTokens.keys(),
      ...deps.continuationTokens.evaluations.keys(),
      ...deps.continuationTokens.consumed,
      ...deps.inputWaits.waitsByParent.keys(),
    ]);
    for (const sessionID of continuationSessionIDs) {
      deps.continuationTokens.clearContinuation(sessionID);
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
    const job = sessionId ? deps.backgroundJobBoard.get(sessionId) : undefined;
    log('[task-session-manager] idle/status idle observed', {
      sessionID: sessionId,
      managesSession: sessionId
        ? deps.options.shouldManageSession(sessionId)
        : false,
      terminalJobsPending: sessionId
        ? (deps.terminalJobsInjectedByParent.get(sessionId)?.size ?? 0)
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
      deps.idleReconciler.scheduleChildIdleReconciliation(
        sessionId,
        Date.now(),
      );
    }
    return;
  }

  if (input.event.type === 'session.error') {
    const sessionId =
      input.event.properties?.info?.id || input.event.properties?.sessionID;
    if (sessionId) {
      deps.continuationTokens.invalidateContinuation(sessionId);
    }
    if (sessionId && deps.options.shouldManageSession(sessionId)) {
      // Only clear injected terminal jobs for fatal errors.
      // Rate-limit errors are recovered by ForegroundFallbackManager
      // (abort + reprompt with fallback model); clearing the injected
      // job state here would make the orchestrator lose track of
      // completed background tasks and unable to dispatch follow-ups.
      const props = input.event.properties as { error?: unknown } | undefined;
      if (!props?.error || !isFailoverError(props.error)) {
        deps.terminalJobsInjectedByParent.delete(sessionId);
        // Record non-retryable errors on the job board so the
        // orchestrator sees the failure instead of a false completion.
        const job = deps.backgroundJobBoard.get(sessionId);
        if (job && job.state === 'running') {
          deps.backgroundJobBoard.updateStatus({
            taskID: sessionId,
            state: 'error',
            resultSummary:
              (props?.error as { message?: string } | undefined)?.message ??
              'Session error',
          });
        }
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
      const job = deps.backgroundJobBoard.get(sessionId);
      if (job && job.state === 'running') {
        deps.backgroundJobBoard.updateStatus({
          taskID: sessionId,
          state: 'error',
          resultSummary:
            (props?.error as { message?: string } | undefined)?.message ??
            'Session error',
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
    if (sessionId) deps.continuationTokens.invalidateContinuation(sessionId);
    if (statusType !== 'busy') {
      return;
    }
    // Live busy cancels a pending child idle-reconcile — the session
    // recovered (FG re-prompt or continued work).
    // Note: invalidateContinuation above already cleared the parent
    // idle-reconcile timer; clearIdleTimers handles the child timer.
    if (sessionId) {
      deps.idleReconciler.clearIdleTimers(sessionId);
    }
    const before = sessionId
      ? deps.backgroundJobBoard.get(sessionId)
      : undefined;
    const updated = sessionId
      ? deps.backgroundJobBoard.markRunningFromLiveSession(sessionId)
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

  deps.continuationTokens.clearContinuation(sessionId);
  deps.inputWaits.clearInputWaits(sessionId);

  log('[task-session-manager] session.deleted observed', {
    sessionID: sessionId,
  });
}
