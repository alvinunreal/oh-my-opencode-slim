import type { PluginInput } from '@opencode-ai/plugin';
import { getClient } from './opencode-client';
import type { TimerSeam } from './timer-seam';

type TimerFns = TimerSeam;

/** Wait for a host read with a deadline: the deadline only releases the
 *  WAITER (to undefined), never the underlying read. */
export function raceEvidenceDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timers?: TimerFns,
): Promise<T | undefined> {
  const settled = promise.catch(() => undefined);
  if (timeoutMs <= 0) return settled;
  const setTimer =
    timers?.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer =
    timers?.clearTimeout ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const deadline = Promise.withResolvers<undefined>();
  const timer = setTimer(() => deadline.resolve(undefined), timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  return Promise.race([settled, deadline.promise]).finally(() =>
    clearTimer(timer),
  );
}

/** In-flight raw session-info reads, scoped to the client session domain,
 *  then task ID: a timed-out or failed waiter never releases the slot, so
 *  concurrent consumers share the one underlying host read. */
const sessionInfoReads = new WeakMap<
  object,
  Map<
    string,
    { identity: string; promise: Promise<unknown>; settled: Promise<void> }
  >
>();

/** The settle signal of an occupant whose identity differs from the
 *  caller's, or undefined when the slot is idle or held by the same
 *  identity. Resolves (never rejects) only after the slot is released, and
 *  carries no evidence — callers re-enter {@link readHostSessionInfo} to
 *  read under their own identity. */
export function pendingForeignRead(
  input: PluginInput,
  key: { taskID: string; identity: string },
): Promise<void> | undefined {
  const session = getClient(input)?.session;
  const entry = sessionInfoReads.get(session)?.get(key.taskID);
  return entry && entry.identity !== key.identity ? entry.settled : undefined;
}

/** Share the raw, still-open host `session.get` across consumers of one
 *  task. A consumer deadline must not release this slot or authorize a new
 *  read; the entry clears only when the underlying read settles. A caller
 *  holding a different identity never receives the occupant's evidence:
 *  it waits for the occupant to settle and re-issues its own fresh read
 *  under its own identity (serialized, never concurrent). Hosts without
 *  `session.get` resolve undefined (capability absence, not evidence). */
export function readHostSessionInfo(
  input: PluginInput,
  key: { taskID: string; identity: string },
): Promise<unknown> {
  const client = getClient(input);
  const session = client?.session;
  if (typeof session?.get !== 'function') return Promise.resolve(undefined);
  let reads = sessionInfoReads.get(session);
  if (!reads) {
    reads = new Map();
    sessionInfoReads.set(session, reads);
  }
  const existing = reads.get(key.taskID);
  if (existing) {
    if (existing.identity === key.identity) return existing.promise;
    // Serialize, never share: the re-issue happens through the public
    // reader after the occupant settles, so a same-identity join, slot
    // release, or a newer foreign read is re-evaluated against current
    // state at every hop.
    const settled = existing.settled;
    return settled.then(() => readHostSessionInfo(input, key));
  }
  const promise = Promise.resolve().then(() =>
    session.get({
      path: { id: key.taskID },
      query: { directory: input.directory },
    }),
  );
  // Release first, then resolve: foreign waiters and the gate's deferred
  // retries must never see the slot as occupied behind a settled read.
  const release = () => {
    if (reads.get(key.taskID)?.promise === promise) reads.delete(key.taskID);
  };
  const settled = promise.then(release, release);
  reads.set(key.taskID, { identity: key.identity, promise, settled });
  return promise;
}
