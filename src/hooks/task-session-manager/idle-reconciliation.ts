import type { BackgroundJobStore, ContextFile } from '../../utils';
import { log } from '../../utils/logger';
import {
  COMPLETED_WITHOUT_TEXT_DIAGNOSTIC,
  isHostTerminalOutcome,
} from '../../utils/task';
import type { RevivedRunTracker } from './revived-run-tracker';
import {
  observeNonBusyRuntime,
  STOP_CONFIRMATION_GRACE_MS,
} from './stop-confirmation';

/** Wall-clock slack before the post-grace self-observation fires. */
const QUIESCENT_CONFIRM_SLACK_MS = 25;

/** Default stabilization probes for a succeeded-but-textless outcome
 * (incident #1115 precedent: never reconcile a completed job without
 * usable result text). */
const DEFAULT_OUTCOME_STABILIZATION_PROBES = 3;
const DEFAULT_OUTCOME_STABILIZATION_INTERVAL_MS = 300;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  /** Host-native terminal outcome probe (v2 Session.Info.outcome via
   * session.get). Quiescent jobs settle to the accurate terminal state
   * instead of lingering 'running + statusUncertain' on hosts without a
   * live session-status map. Return undefined when unavailable. */
  readSessionOutcome?: (
    sessionID: string,
  ) => Promise<{ outcome?: string; resultText?: string } | undefined>;
  /** Stabilization retries for a succeeded-but-textless outcome. */
  outcomeStabilization?: { probes: number; intervalMs: number };
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
  const quiescentConfirmTimers = new Map<
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
        graceMs: options.stopConfirmationGraceMs ?? STOP_CONFIRMATION_GRACE_MS,
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

      // Host-native outcome confirmation (v2: no session.status map, but
      // Session.Info.outcome publishes the terminal transition). Settles
      // the quiescent job to its accurate terminal state instead of the
      // cancellation-flavored 'stopped' below. A succeeded outcome is only
      // reconciled once usable result text exists — stabilization probes
      // cover the outcome-before-text race, and textless completions are
      // rejected per the incident #1115 precedent (never reconcile a
      // completed job without a usable answer).
      if (options.readSessionOutcome) {
        const guardsIntact = (): boolean => {
          const latest = options.backgroundJobBoard.get(sessionID);
          return (
            latest !== undefined &&
            latest.state === 'running' &&
            latest.generation === observedGeneration &&
            !(
              latest.lastLiveBusyAt !== undefined &&
              latest.lastLiveBusyAt > idleObservedAt
            )
          );
        };
        const stabilization = options.outcomeStabilization ?? {
          probes: DEFAULT_OUTCOME_STABILIZATION_PROBES,
          intervalMs: DEFAULT_OUTCOME_STABILIZATION_INTERVAL_MS,
        };
        let outcome: string | undefined;
        let resultText: string | undefined;
        for (
          let attempt = 0;
          attempt <= stabilization.probes && guardsIntact();
          attempt += 1
        ) {
          if (attempt > 0) await delay(stabilization.intervalMs);
          try {
            const probe = await options.readSessionOutcome(sessionID);
            outcome = probe?.outcome;
            resultText = probe?.resultText;
          } catch (error) {
            log('[task-session-manager] host outcome probe failed', {
              sessionID,
              error: error instanceof Error ? error.message : String(error),
            });
            break;
          }
          if (outcome !== 'succeeded') break;
          if (resultText !== undefined && resultText.length > 0) break;
        }
        if (guardsIntact() && isHostTerminalOutcome(outcome)) {
          const settled = options.backgroundJobBoard.updateStatus({
            taskID: sessionID,
            expectedGeneration: observedGeneration,
            state:
              outcome === 'succeeded' && resultText ? 'completed' : 'error',
            resultSummary:
              outcome === 'succeeded'
                ? resultText || COMPLETED_WITHOUT_TEXT_DIAGNOSTIC
                : `Host reported outcome: ${outcome}.`,
          });
          if (
            settled !== undefined &&
            settled.generation === observedGeneration &&
            settled.state !== 'running'
          ) {
            options.backgroundJobBoard.markReconciled(sessionID);
            log(
              '[task-session-manager] confirmed terminal outcome from host session info',
              {
                sessionID,
                alias: settled.alias,
                parentSessionID: settled.parentSessionID,
                outcome,
                hasResultText: Boolean(resultText),
              },
            );
            return;
          }
        }
      }

      // No host outcome (or probe unavailable): schedule the post-grace
      // stop-confirmation re-observation ourselves. The v1 design relied on
      // the periodic runtime-status reconciler to make the second
      // observation; that reconciler is disabled on hosts without
      // session.status (v2), which left quiescent jobs 'running' with an
      // unconfirmed status forever (#1157 follow-up).
      scheduleQuiescentStopConfirmation(
        sessionID,
        observedGeneration,
        idleObservedAt,
      );
      log('[task-session-manager] observed quiescent job from idle', {
        sessionID,
        alias: job.alias,
        parentSessionID: job.parentSessionID,
      });
    }, options.idleReconcileDelayMs).unref?.();
    childIdleReconcileTimers.set(sessionID, timer);
  }

  /**
   * One-shot post-grace stop confirmation for quiescent jobs. Uses a
   * synthetic re-observation timestamp (idle + grace + 1) so the existing
   * observeNonBusyRuntime grace logic confirms the stop; the busy guard
   * still protects against a session that recovered in the meantime.
   */
  function scheduleQuiescentStopConfirmation(
    sessionID: string,
    observedGeneration: number,
    idleObservedAt: number,
  ): void {
    if (quiescentConfirmTimers.has(sessionID)) return;
    const graceMs =
      options.stopConfirmationGraceMs ?? STOP_CONFIRMATION_GRACE_MS;
    const timer = setTimeout(() => {
      quiescentConfirmTimers.delete(sessionID);
      if (options.isFallbackInProgress?.(sessionID)) return;
      const job = options.backgroundJobBoard.get(sessionID);
      if (job?.state !== 'running' || job.generation !== observedGeneration) {
        return;
      }
      if (
        job.lastLiveBusyAt !== undefined &&
        job.lastLiveBusyAt > idleObservedAt
      ) {
        return;
      }
      const updated = observeNonBusyRuntime({
        backgroundJobBoard: options.backgroundJobBoard,
        taskID: sessionID,
        observedAt: idleObservedAt + graceMs + 1,
        generation: observedGeneration,
        graceMs,
        lastStatusError:
          'Runtime session is idle; task termination is unconfirmed.',
        taskContextTracker: options.taskContextTracker,
      });
      if (updated?.state === 'stopped') {
        log(
          '[task-session-manager] confirmed runtime-stopped job after self-observed grace',
          {
            sessionID,
            alias: updated.alias,
            parentSessionID: updated.parentSessionID,
          },
        );
      }
    }, graceMs + QUIESCENT_CONFIRM_SLACK_MS).unref?.();
    quiescentConfirmTimers.set(sessionID, timer);
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

    // Schedule even when a fallback is already in flight: the timer
    // callback reschedules until the fallback outcome is known.
    schedule();
  }

  function clearIdleTimers(sessionID: string): void {
    const pendingChildIdle = childIdleReconcileTimers.get(sessionID);
    if (pendingChildIdle) {
      clearTimeout(pendingChildIdle);
      childIdleReconcileTimers.delete(sessionID);
    }
    const pendingQuiescentConfirm = quiescentConfirmTimers.get(sessionID);
    if (pendingQuiescentConfirm) {
      clearTimeout(pendingQuiescentConfirm);
      quiescentConfirmTimers.delete(sessionID);
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

    for (const timer of quiescentConfirmTimers.values()) {
      clearTimeout(timer);
    }
    quiescentConfirmTimers.clear();

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
