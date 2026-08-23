import type { BackgroundJobStore, ContextFile } from '../../utils';
import { log } from '../../utils/logger';
import type { RevivedRunTracker } from './revived-run-tracker';
import {
  DEFAULT_STOP_CONFIRMATION_MS,
  observeNonBusyRuntime,
} from './stop-confirmation';

export function createIdleReconciler(options: {
  backgroundJobBoard: BackgroundJobStore;
  reconcileInjectedTerminalJobs: (parentSessionID: string) => void;
  /** Called when a deferred inline error is terminalized at idle. */
  onErrorTerminalize?: (sessionID: string) => void;
  idleReconcileDelayMs: number;
  stopConfirmationGraceMs?: number;
  isFallbackInProgress?: (sessionID: string) => boolean;
  hasInputWait: (sessionID: string) => boolean;
  getIdleSessionToken: (sessionID: string) => symbol;
  isCurrentIdleSessionToken: (
    sessionID: string,
    sessionToken: symbol,
  ) => boolean;
  taskContextTracker: {
    pendingManagedTaskIds: Set<string>;
    contextFilesForPrompt(taskId: string): ContextFile[];
    prune(board: { taskIDs(): Set<string> }): void;
  };
  revivedRunTracker?: RevivedRunTracker;
}) {
  const idleReconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const childIdleReconcileTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  const errorTerminalizeTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  function scheduleIdleReconciliation(parentSessionID: string): void {
    if (
      idleReconcileTimers.has(parentSessionID) ||
      options.hasInputWait(parentSessionID) ||
      options.isFallbackInProgress?.(parentSessionID)
    ) {
      return;
    }
    const sessionToken = options.getIdleSessionToken(parentSessionID);
    const timer = setTimeout(() => {
      idleReconcileTimers.delete(parentSessionID);
      if (!options.isCurrentIdleSessionToken(parentSessionID, sessionToken)) {
        return;
      }
      options.reconcileInjectedTerminalJobs(parentSessionID);
    }, options.idleReconcileDelayMs).unref?.();
    idleReconcileTimers.set(parentSessionID, timer);
  }

  function scheduleChildIdleReconciliation(
    sessionID: string,
    idleObservedAt: number,
    observedGeneration: number,
  ): void {
    if (childIdleReconcileTimers.has(sessionID)) return;
    if (options.isFallbackInProgress?.(sessionID)) return;

    const timer = setTimeout(async () => {
      childIdleReconcileTimers.delete(sessionID);
      if (options.isFallbackInProgress?.(sessionID)) return;

      const job = options.backgroundJobBoard.get(sessionID);
      if (job?.state !== 'running' || job.generation !== observedGeneration) {
        return;
      }

      // Busy after the idle means the session recovered (e.g. FG re-prompt).
      if (
        job.lastLiveBusyAt !== undefined &&
        job.lastLiveBusyAt > idleObservedAt
      ) {
        return;
      }

      if (options.revivedRunTracker?.isTracked(sessionID, observedGeneration)) {
        const terminalPublished = await options.revivedRunTracker.probe(
          sessionID,
          observedGeneration,
        );
        if (terminalPublished) return;
      }

      const updated = observeNonBusyRuntime({
        backgroundJobBoard: options.backgroundJobBoard,
        taskID: sessionID,
        observedAt: idleObservedAt,
        generation: observedGeneration,
        graceMs:
          options.stopConfirmationGraceMs ?? DEFAULT_STOP_CONFIRMATION_MS,
        lastStatusError:
          'Runtime session is idle; task termination is unconfirmed.',
        taskContextTracker: options.taskContextTracker,
      });
      if (updated?.state === 'stopped') {
        log('[task-session-manager] confirmed runtime-stopped job from idle', {
          sessionID,
          alias: updated.alias,
          parentSessionID: updated.parentSessionID,
        });
        return;
      }
      log('[task-session-manager] observed quiescent job from idle', {
        sessionID,
        alias: job.alias,
        parentSessionID: job.parentSessionID,
      });
    }, options.idleReconcileDelayMs).unref?.();
    childIdleReconcileTimers.set(sessionID, timer);
  }

  /**
   * Terminalize a managed job as 'error' after it idled with a deferred
   * inline 401/410 error that the foreground fallback could not (or did
   * not) recover. Mirrors scheduleChildIdleReconciliation: delayed so a
   * fallback re-prompt can claim the session first, and cancelled by
   * live-busy recovery. Without this, a silent fallback failure leaves
   * the job 'running' indefinitely.
   */
  function scheduleErrorTerminalize(
    sessionID: string,
    idleObservedAt: number,
    observedGeneration: number,
  ): void {
    if (errorTerminalizeTimers.has(sessionID)) return;
    // If a fallback attempt is still in flight, defer to the timer
    // callback: the fallback may recover the session (busy cancels us)
    // or fail silently (execFallback catch only logs).  Rescheduling
    // here rather than bailing ensures we keep watching until the
    // fallback completes and the outcome is known.
    const schedule = (): void => {
      const timer = setTimeout(() => {
        errorTerminalizeTimers.delete(sessionID);
        if (options.isFallbackInProgress?.(sessionID)) {
          // Fallback still in flight — reschedule and keep watching.
          schedule();
          return;
        }

        const job = options.backgroundJobBoard.get(sessionID);
        if (job?.state !== 'running' || job.generation !== observedGeneration) {
          return;
        }

        // Busy after the idle means the session recovered (e.g. FG re-prompt).
        if (
          job.lastLiveBusyAt !== undefined &&
          job.lastLiveBusyAt > idleObservedAt
        ) {
          return;
        }

        log(
          '[task-session-manager] terminalized job from idle after deferred error',
          {
            sessionID,
            alias: job.alias,
            parentSessionID: job.parentSessionID,
          },
        );
        options.backgroundJobBoard.updateStatus({
          taskID: sessionID,
          state: 'error',
          resultSummary:
            'Session error after failed model fallback (auth/model unavailable)',
        });
        options.onErrorTerminalize?.(sessionID);
      }, options.idleReconcileDelayMs).unref?.();
      errorTerminalizeTimers.set(sessionID, timer);
    };

    if (options.isFallbackInProgress?.(sessionID)) {
      // Fallback in flight when we first schedule — start watching anyway.
      schedule();
      return;
    }
    schedule();
  }

  function clearIdleTimers(sessionID: string): void {
    const pendingChildIdle = childIdleReconcileTimers.get(sessionID);
    if (pendingChildIdle) {
      clearTimeout(pendingChildIdle);
      childIdleReconcileTimers.delete(sessionID);
    }
    const pendingIdle = idleReconcileTimers.get(sessionID);
    if (pendingIdle) {
      clearTimeout(pendingIdle);
      idleReconcileTimers.delete(sessionID);
    }
    const pendingErrorTerminalize = errorTerminalizeTimers.get(sessionID);
    if (pendingErrorTerminalize) {
      clearTimeout(pendingErrorTerminalize);
      errorTerminalizeTimers.delete(sessionID);
    }
  }

  /**
   * Clears all timers and returns the session IDs that had
   * idle-reconcile timers (used by server.instance.disposed).
   */
  function clearAllTimers(): string[] {
    for (const timer of childIdleReconcileTimers.values()) {
      clearTimeout(timer);
    }
    childIdleReconcileTimers.clear();

    for (const timer of errorTerminalizeTimers.values()) {
      clearTimeout(timer);
    }
    errorTerminalizeTimers.clear();

    const idleSessionIds = [...idleReconcileTimers.keys()];
    for (const timer of idleReconcileTimers.values()) {
      clearTimeout(timer);
    }
    idleReconcileTimers.clear();

    return idleSessionIds;
  }

  return {
    scheduleIdleReconciliation,
    scheduleChildIdleReconciliation,
    scheduleErrorTerminalize,
    clearIdleTimers,
    clearAllTimers,
    /** Callback for idle-session-tokens invalidate. */
    onInvalidateIdle: (sessionID: string) => {
      const timer = idleReconcileTimers.get(sessionID);
      if (timer) {
        clearTimeout(timer);
        idleReconcileTimers.delete(sessionID);
      }
    },
  };
}
