import type { BackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import { log } from '../../utils/logger';

/**
 * Bounded renewals for the deferred-error backstop: a fallback that is
 * still in flight when the timer fires gets at most this many extensions
 * before the deferred error must terminalize. Without a bound, a silently
 * hung fallback would defer the failure forever.
 */
const MAX_DEFERRED_ERROR_RENEWALS = 5;

/** Only parent prompt-lifecycle timers live here. Child terminal policy and
 * its one retry timer belong to the shared terminal gate; the one
 * exception is the deferred-error backstop below, whose whole job is to
 * outlive the fallback window that gate observations cannot see. */
export function createIdleReconciler(options: {
  terminalGate: BackgroundJobTerminalGate;
  reconcileInjectedTerminalJobs: (parentSessionID: string) => void;
  idleReconcileDelayMs: number;
  isFallbackInProgress?: (sessionID: string) => boolean;
  hasInputWait: (sessionID: string) => boolean;
  getIdleSessionToken: (sessionID: string) => symbol;
  isCurrentIdleSessionToken: (sessionID: string, token: symbol) => boolean;
  /** Read-and-clear the deferred error summary for a session. Returns
   *  undefined when nothing is deferred; consuming at fire time keeps a
   *  newer deferral authoritative and leaves no stale entries behind. */
  consumeDeferredError?: (sessionID: string) => string | undefined;
}) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleIdleReconciliation(parentSessionID: string): void {
    if (
      timers.has(parentSessionID) ||
      options.hasInputWait(parentSessionID) ||
      options.isFallbackInProgress?.(parentSessionID)
    )
      return;
    const token = options.getIdleSessionToken(parentSessionID);
    const timer = setTimeout(() => {
      timers.delete(parentSessionID);
      if (!options.isCurrentIdleSessionToken(parentSessionID, token)) return;
      options.reconcileInjectedTerminalJobs(parentSessionID);
    }, options.idleReconcileDelayMs);
    timer.unref?.();
    timers.set(parentSessionID, timer);
  }

  function scheduleChildIdleReconciliation(
    sessionID: string,
    idleObservedAt: number,
    generation: number,
    error?: string,
  ): void {
    const run = { taskID: sessionID, generation };
    const token = options.terminalGate.capture(run);
    if (!token) return;
    // A host event is a candidate, not a substitute for the current runtime.
    const observation = options.terminalGate.observe(token, {
      kind: 'quiescent',
      origin: 'session.idle',
      readStartedAt: token.readStartedAt,
      observedAt: idleObservedAt,
    });
    if (observation.kind === 'stale') return;
    // Background reconciliation is fail-soft: a failure must be logged
    // and swallowed, never escape as an unhandled rejection.
    void options.terminalGate
      .reconcile(
        run,
        error ? { kind: 'session-error', message: error } : { kind: 'inspect' },
      )
      .catch((err) => {
        log('[idle-reconciliation] background reconcile failed', String(err));
      });
  }

  /**
   * Deferred-error backstop for the fallback-preparation window: the
   * failed prompt's idle can arrive while ForegroundFallbackManager is
   * still preparing the re-prompt (the host dispatches events without
   * awaiting the plugin hook). Committing the deferred error inside that
   * window terminalizes the record before the observation handoff can arm
   * and orphans the retried run's result — so the backstop waits instead.
   * Each fire re-checks the fallback state: still in flight → bounded
   * renewal; no longer in flight → consume the deferred error and
   * terminalize it. Live busy cancels the timer through clearIdleTimers
   * and the deferral through the busy path, so a landed re-prompt never
   * sees the error publish; the renewal bound keeps a silently hung
   * fallback from deferring the failure forever.
   */
  function scheduleDeferredErrorBackstop(
    sessionID: string,
    idleObservedAt: number,
    generation: number,
  ): void {
    if (timers.has(sessionID)) return;
    const run = { taskID: sessionID, generation };
    const token = options.terminalGate.capture(run);
    if (!token) return;
    let renewals = 0;
    const fire = () => {
      timers.delete(sessionID);
      if (options.isFallbackInProgress?.(sessionID)) {
        if (renewals < MAX_DEFERRED_ERROR_RENEWALS) {
          renewals += 1;
          arm();
          return;
        }
        // Bounded: fall through and terminalize despite the in-flight
        // claim — the fallback window cannot extend the deferral forever.
      }
      const error = options.consumeDeferredError?.(sessionID);
      if (error === undefined) return;
      // A host event is a candidate, not a substitute for the current
      // runtime; a stale token (relaunch, live busy) skips the publish.
      const observation = options.terminalGate.observe(token, {
        kind: 'quiescent',
        origin: 'session.idle',
        readStartedAt: token.readStartedAt,
        observedAt: idleObservedAt,
      });
      if (observation.kind === 'stale') return;
      // Background reconciliation is fail-soft: a failure must be logged
      // and swallowed, never escape as an unhandled rejection.
      void options.terminalGate
        .reconcile(run, { kind: 'session-error', message: error })
        .catch((err) => {
          log(
            '[idle-reconciliation] deferred-error backstop failed',
            String(err),
          );
        });
    };
    const arm = () => {
      const timer = setTimeout(fire, options.idleReconcileDelayMs);
      timer.unref?.();
      timers.set(sessionID, timer);
    };
    arm();
  }

  function clearIdleTimers(sessionID: string): void {
    const timer = timers.get(sessionID);
    if (timer) clearTimeout(timer);
    timers.delete(sessionID);
  }

  return {
    scheduleIdleReconciliation,
    scheduleChildIdleReconciliation,
    scheduleDeferredErrorBackstop,
    clearIdleTimers,
    clearAllTimers() {
      const sessions = [...timers.keys()];
      for (const sessionID of sessions) clearIdleTimers(sessionID);
      return sessions;
    },
    onInvalidateIdle: clearIdleTimers,
  };
}
