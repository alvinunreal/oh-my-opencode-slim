import {
  POLL_INTERVAL_MS,
  MAX_POLL_TIME_MS,
  STABLE_POLLS_THRESHOLD,
} from "../config";

export interface PollOptions {
  pollInterval?: number;
  maxPollTime?: number;
  stableThreshold?: number;
  signal?: AbortSignal;
}

export interface PollResult<T> {
  success: boolean;
  data?: T;
  timedOut?: boolean;
  aborted?: boolean;
}

/**
 * Generic polling utility that waits for a condition to be met.
 * Returns when the condition is satisfied or timeout/abort occurs.
 */
export async function pollUntilStable<T>(
  fetchFn: () => Promise<T>,
  isStable: (current: T, previous: T | null, stableCount: number) => boolean,
  opts: PollOptions = {}
): Promise<PollResult<T>> {
  const pollInterval = opts.pollInterval ?? POLL_INTERVAL_MS;
  const maxPollTime = opts.maxPollTime ?? MAX_POLL_TIME_MS;
  const stableThreshold = opts.stableThreshold ?? STABLE_POLLS_THRESHOLD;

  const pollStart = Date.now();
  let previousData: T | null = null;
  let stablePolls = 0;

  while (Date.now() - pollStart < maxPollTime) {
    if (opts.signal?.aborted) {
      return { success: false, aborted: true };
    }

    await sleep(pollInterval);

    const currentData = await fetchFn();

    if (isStable(currentData, previousData, stablePolls)) {
      stablePolls++;
      if (stablePolls >= stableThreshold) {
        return { success: true, data: currentData };
      }
    } else {
      stablePolls = 0;
    }

    previousData = currentData;
  }

  return { success: false, timedOut: true, data: previousData ?? undefined };
}

/**
 * Delays execution for a specified number of milliseconds.
 * @param ms - The number of milliseconds to sleep.
 * @returns A promise that resolves after the delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
