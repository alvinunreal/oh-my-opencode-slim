/**
 * Terminal-session GC host delete (#1387). Removes the host child session of
 * an evicted board record only after proving it is still this plugin's own
 * idle background child: eligibility by board provenance, the board not
 * tracking it again, a bounded host read confirming the session's parentID
 * still matches the record's parent, and a bounded host status read showing
 * it idle. The delete itself is bounded, so the returned promise always
 * settles and the pending-prune fence never blocks recovery indefinitely.
 */
import type { PluginInput } from '@opencode-ai/plugin';
import {
  type BackgroundJobEvictedSession,
  isPrunableEvictedSession,
} from '../background-jobs';
import { responseError, stringifyError } from './child-transcript';
import { log } from './logger';
import { withTimeout } from './session';
import {
  getRuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from './session-runtime-status';

interface PruneSessionClient {
  get?: (request: {
    path: { id: string };
    query: { directory: string };
    signal?: AbortSignal;
  }) => Promise<unknown>;
  status?: (request: {
    query: { directory: string };
    signal?: AbortSignal;
  }) => Promise<unknown>;
  delete: (request: {
    path: { id: string };
    query: { directory: string };
    signal?: AbortSignal;
  }) => Promise<unknown>;
}

export type EvictedSessionPruneOutcome =
  | 'deleted'
  | 'ineligible'
  | 'tracked'
  | 'read-failed'
  | 'parent-mismatch'
  | 'not-idle'
  | 'delete-failed';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read the host session's parentID; undefined when the read is unusable. */
async function readHostParentID(
  session: PruneSessionClient,
  taskID: string,
  directory: string,
  timeoutMs: number,
): Promise<string | undefined> {
  if (typeof session.get !== 'function') return undefined;
  const controller = new AbortController();
  try {
    const response = await withTimeout(
      session.get({
        path: { id: taskID },
        query: { directory },
        signal: controller.signal,
      }),
      timeoutMs,
      'Evicted session parent lookup timed out',
    );
    if (!isRecord(response) || responseError(response) !== undefined)
      return undefined;
    const data = response.data;
    if (!isRecord(data)) return undefined;
    if (data.id !== undefined && data.id !== taskID) return undefined;
    return typeof data.parentID === 'string' ? data.parentID : undefined;
  } catch (error) {
    controller.abort();
    log('[plugin] terminal-session prune parent read failed', {
      taskID,
      error: errorMessage(error),
    });
    return undefined;
  }
}

/** True only for a valid status snapshot showing the session idle or
 * absent (quiescent). Busy, retry, malformed, or failed reads are doubt. */
async function isHostSessionIdle(
  session: PruneSessionClient,
  taskID: string,
  directory: string,
  timeoutMs: number,
): Promise<boolean> {
  if (typeof session.status !== 'function') return false;
  const snapshot = await getRuntimeSessionStatusSnapshot(
    { client: { session }, directory } as unknown as PluginInput,
    { timeoutMs },
  );
  if (snapshot.error) return false;
  if (snapshot.malformedSessionIDs.has(taskID)) return false;
  const status = runtimeSessionStatus(snapshot, taskID);
  return status === undefined || status === 'idle';
}

/** Never rejects and always settles within the read/delete deadlines: every
 * failure resolves to a skip outcome and is logged. */
export async function pruneEvictedHostSession(input: {
  session: PruneSessionClient;
  directory: string;
  evicted: BackgroundJobEvictedSession;
  readTimeoutMs: number;
  deleteTimeoutMs: number;
  /** True when the board tracks the task again (re-registered, revived,
   * adopted, or leased); such a session is live work and is never deleted. */
  isTracked: (taskID: string) => boolean;
}): Promise<EvictedSessionPruneOutcome> {
  const { session, directory, evicted } = input;
  const taskID = evicted.taskID;
  if (!isPrunableEvictedSession(evicted)) return 'ineligible';
  const skip = (
    outcome: EvictedSessionPruneOutcome,
    details: Record<string, unknown> = {},
  ) => {
    log(`[plugin] terminal-session prune skipped: ${outcome}`, {
      taskID,
      ...details,
    });
    return outcome;
  };
  if (input.isTracked(taskID)) return skip('tracked');
  const parentID = await readHostParentID(
    session,
    taskID,
    directory,
    input.readTimeoutMs,
  );
  if (parentID === undefined) return skip('read-failed');
  if (parentID !== evicted.parentSessionID) {
    return skip('parent-mismatch', {
      expected: evicted.parentSessionID,
      actual: parentID,
    });
  }
  if (
    !(await isHostSessionIdle(session, taskID, directory, input.readTimeoutMs))
  ) {
    return skip('not-idle');
  }
  // Re-check after the awaits: a revive or relaunch may have re-registered
  // the task while the host reads were in flight.
  if (input.isTracked(taskID)) return skip('tracked');
  const controller = new AbortController();
  try {
    // `query.directory` pins the delete to this project: on a shared v1 host
    // an unpinned call can route to the server's working directory and miss
    // the child session.
    const response = await withTimeout(
      session.delete({
        path: { id: taskID },
        query: { directory },
        signal: controller.signal,
      }),
      input.deleteTimeoutMs,
      'Evicted session delete timed out',
    );
    const error = responseError(response);
    if (error !== undefined) throw new Error(stringifyError(error));
    if (!response) throw new Error('empty delete response');
    if (isRecord(response) && response.data === false) {
      throw new Error('host reported the session was not deleted');
    }
    return 'deleted';
  } catch (error) {
    controller.abort();
    log('[plugin] terminal-session prune remove failed', {
      taskID,
      error: errorMessage(error),
    });
    return 'delete-failed';
  }
}
