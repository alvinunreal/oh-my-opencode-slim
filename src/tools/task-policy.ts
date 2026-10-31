import type { BackgroundJobRecord } from '../utils/background-job-board';
import {
  type RuntimeSessionStatus,
  type RuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../utils/session-runtime-status';
import type { TaskActivityTracker } from './task-activity';

/** A live child is reported possibly stuck after this much time without activity. */
const STUCK_IDLE_THRESHOLD_MS = 120_000;

/** Preserve the timestamp fallback chain; provenance is not proof of progress. */
export function resolveLastActivity(
  record: BackgroundJobRecord,
  tracker?: TaskActivityTracker,
) {
  const observed = tracker?.lastActivityAt(record.taskID);
  const at = observed ?? record.lastLiveBusyAt ?? record.runStartedAt;
  const source =
    observed !== undefined
      ? 'observed-activity'
      : record.lastLiveBusyAt !== undefined &&
          record.lastLiveBusyAt > record.runStartedAt
        ? 'host-busy'
        : at !== undefined
          ? 'launch-time'
          : 'unknown';
  // Equality can also occur on a reopened run: launch-time means no activity
  // evidence beyond the run start time, not that the child did nothing.
  return { at, source };
}

/**
 * Bounded, explicit observation of a tracked child's live session status.
 *
 * `ok` is true only when the host status map was read successfully (within
 * the bounded timeout). An absent session in a valid map is unknown;
 * a malformed entry is also `status: undefined` but carries `error`; a
 * failed or timed-out read is `ok: false` with `error`.
 */
export interface LiveStatusObservation {
  ok: boolean;
  status?: RuntimeSessionStatus;
  error?: string;
}

export interface TaskStatusReport {
  /** Effective state: the live-confirmed host status, or the board state. */
  state: string;
  /** Where `state` came from: 'live' host read or 'board' record. */
  source: 'live' | 'board';
  /** True when the live status could not be confirmed. */
  uncertain: boolean;
  lastStatusError?: string;
  idleSeconds: number;
  possiblyStuck: boolean;
}

/**
 * Converts a bounded snapshot into a single-session observation. A failed
 * read becomes `ok: false`; a malformed entry becomes `ok: true` with
 * `status: undefined` and an error; a valid map reports the entry's status.
 * A valid map without the requested session is an unknown/quiescent
 * observation, not an idle or terminal observation.
 */
export function observationFromSnapshot(
  snapshot: RuntimeSessionStatusSnapshot,
  taskID: string,
): LiveStatusObservation {
  if (snapshot.error) {
    return { ok: false, error: snapshot.error };
  }
  if (snapshot.malformedSessionIDs.has(taskID)) {
    return {
      ok: true,
      status: undefined,
      error: 'malformed live status entry for session',
    };
  }
  return { ok: true, status: runtimeSessionStatus(snapshot, taskID) };
}

/**
 * Shared status/activity policy used by task_status. The board state is only
 * reported with explicit uncertainty when the live read is unavailable, so a
 * stale board record is never presented as a confident live status.
 */
export function summarizeTaskStatus(
  job: BackgroundJobRecord,
  observation: LiveStatusObservation,
  lastActivityAt: number | undefined,
  now: number,
): TaskStatusReport {
  let state: string;
  let source: 'live' | 'board';
  let uncertain: boolean;
  if (observation.ok && observation.status !== undefined) {
    state = observation.status;
    source = 'live';
    uncertain = false;
  } else {
    // Board state is only reported with explicit uncertainty when the live
    // read is unavailable, so a stale board record is never presented as a
    // confident live status.
    state = job.state;
    source = 'board';
    uncertain = true;
  }
  const lastStatusError = uncertain
    ? (observation.error ??
      (observation.ok && observation.status === undefined
        ? 'no live status entry for session'
        : 'live status unavailable'))
    : undefined;
  const idleSeconds = Math.max(
    0,
    Math.floor((now - (lastActivityAt ?? now)) / 1000),
  );
  // possibly_stuck requires a live-confirmed busy/retry signal: an
  // uncertain board fallback must never report a positive stuck state.
  const possiblyStuck =
    !uncertain &&
    (state === 'busy' || state === 'retry') &&
    idleSeconds >= STUCK_IDLE_THRESHOLD_MS / 1000;
  return {
    state,
    source,
    uncertain,
    lastStatusError,
    idleSeconds,
    possiblyStuck,
  };
}
