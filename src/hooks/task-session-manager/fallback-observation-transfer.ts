import type { BackgroundJobStore } from '../../utils/background-job-store';
import type { FallbackNotice, RevivedRunTracker } from './revived-run-tracker';

/**
 * Terminal-observation handoff for background children re-prompted by
 * the foreground fallback (false-stop incident): the host's native task
 * notifier is bound to the original background job and never re-arms
 * for the re-prompted execution, so slim owns observing the
 * substituted run.
 *
 * Three-phase contract — the handoff brackets the fallback's
 * ADMISSION await instead of following it:
 *
 * - `prepare` runs BEFORE `promptAsync` is awaited (baseline in hand
 *   from the same transcript read that produced the replay). While the
 *   admission is pending, the stop-evidence gate DEFERS terminal
 *   publication (`isObservationPending`) — the job may already hold
 *   the re-prompted result, but no delivery owner exists yet, and
 *   publishing then would strand the result without a parent
 *   notification (the exact incident shape). Preparing also SUPPLANTS
 *   the previous publisher (its in-flight probe fences out).
 * - `admit` converts the preparation into a tracked run (register +
 *   immediate probe) once the host accepts the re-prompt — including a
 *   v2 `switched: false` delivery (prompt admitted on the current
 *   model is still admitted work).
 * - `reject` releases ownership on an EXPLICIT host refusal (error
 *   envelope, typed capability rejection): nothing was admitted.
 * - `settleUnresolved` handles unknown outcomes (transport failed
 *   without a response — the host may still have accepted the replay):
 *   the prepared ownership CONVERTS into a tracked run instead of being
 *   dropped. The gate fence lifts after one more expiry window if
 *   admit/reject never arrive; the owner stays.
 *
 * Guards: only confirmed BACKGROUND jobs (`background === true`,
 * `state === 'running'`) participate; the generation is REQUIRED (never
 * a wildcard) and must still match the board record at prepare time.
 * Expiry does not drop a pending preparation — it converts it into the
 * owning run, so a late admission finds delivery already owned.
 */
export function createBackgroundFallbackHandoff(options: {
  backgroundJobBoard: BackgroundJobStore;
  revivedRunTracker: RevivedRunTracker;
}): {
  isEligible: (sessionID: string, generation: number | undefined) => boolean;
  prepare: (
    sessionID: string,
    preparedGeneration: number | undefined,
    baselineMessageID: string | undefined,
  ) => boolean;
  admit: (
    sessionID: string,
    preparedGeneration: number | undefined,
    notice?: FallbackNotice,
  ) => void;
  /** Explicit host refusal (error envelope / typed capability
   * rejection): nothing was admitted, ownership is released. */
  reject: (sessionID: string, preparedGeneration: number | undefined) => void;
  /** Unknown admission outcome (transport failed without a response —
   * the host may still have accepted the replay): the prepared
   * ownership CONVERTS into a tracked run instead of being dropped. */
  settleUnresolved: (
    sessionID: string,
    preparedGeneration: number | undefined,
  ) => void;
} {
  const resolveEligibleRecord = (
    sessionID: string,
    preparedGeneration: number | undefined,
  ) => {
    if (preparedGeneration === undefined) return undefined;
    const record = options.backgroundJobBoard.get(sessionID);
    if (
      record?.state !== 'running' ||
      record.background !== true ||
      record.generation !== preparedGeneration
    ) {
      return undefined;
    }
    return record;
  };

  return {
    isEligible: (sessionID, generation) =>
      resolveEligibleRecord(sessionID, generation) !== undefined,
    prepare: (sessionID, preparedGeneration, baselineMessageID) => {
      const record = resolveEligibleRecord(sessionID, preparedGeneration);
      if (!record) return false;
      return options.revivedRunTracker.prepareObservation({
        taskID: sessionID,
        generation: record.generation,
        parentSessionID: record.parentSessionID,
        baselineMessageID,
        description: record.description,
      });
    },
    admit: (sessionID, preparedGeneration, notice) => {
      if (preparedGeneration === undefined) return;
      // Resolve the preparation for the SAME generation idempotently
      // even when the board record already left 'running' — a promoted
      // owner may have found and delivered the result BEFORE this ack
      // arrived; the entry must still be cleaned (no reinstall, no
      // notification reset — that is the tracker's promoted-admit
      // contract).
      options.revivedRunTracker.admitObservation(
        sessionID,
        preparedGeneration,
        notice,
      );
    },
    reject: (sessionID, preparedGeneration) => {
      if (preparedGeneration === undefined) return;
      options.revivedRunTracker.rejectObservation(
        sessionID,
        preparedGeneration,
      );
    },
    settleUnresolved: (sessionID, preparedGeneration) => {
      if (preparedGeneration === undefined) return;
      options.revivedRunTracker.settleObservationUnresolved(
        sessionID,
        preparedGeneration,
      );
    },
  };
}
