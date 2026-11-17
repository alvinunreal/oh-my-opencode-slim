import type { TimerHandle, TimerSeam } from './timer-seam';

/** Wait for a host read with a deadline: the deadline only releases the
 *  WAITER (to undefined), never the underlying read. */
export function raceEvidenceDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timers?: TimerSeam,
): Promise<T | undefined> {
  const settled = promise.catch(() => undefined);
  if (timeoutMs <= 0) return settled;
  const setTimer =
    timers?.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer =
    timers?.clearTimeout ?? ((timer: TimerHandle) => clearTimeout(timer));
  const deadline = Promise.withResolvers<undefined>();
  const timer = setTimer(() => deadline.resolve(undefined), timeoutMs);
  if (typeof timer !== 'number') timer.unref();
  return Promise.race([settled, deadline.promise]).finally(() =>
    clearTimer(timer),
  );
}
