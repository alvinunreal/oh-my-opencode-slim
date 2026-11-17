import type { PluginInput } from '@opencode-ai/plugin';
import type { CurrentRoundClassification } from './child-transcript';
import { isRecord } from './guards';
import { getClient } from './opencode-client';
import type { TimerHandle, TimerSeam } from './timer-seam';

type RuntimeSessionStatus = 'busy' | 'retry' | 'idle';
const DEFAULT_RUNTIME_SESSION_STATUS_TIMEOUT_MS = 5_000;

const openStatusReads = new WeakMap<object, Promise<void>>();

export interface RuntimeSessionStatusSnapshot {
  statuses: ReadonlyMap<string, RuntimeSessionStatus>;
  malformedSessionIDs: ReadonlySet<string>;
  error?: string;
  /** Slot availability only: never exposes the open read's evidence. */
  retryAfter?: Promise<void>;
}

/**
 * Reads OpenCode's single live session-status map. An absent session in a
 * valid response is quiescent, not terminal. The gate still requires result
 * attribution or stable valid absence before publishing a terminal state.
 */
export async function getRuntimeSessionStatusSnapshot(
  input: PluginInput,
  options: { timeoutMs?: number } = {},
): Promise<RuntimeSessionStatusSnapshot> {
  try {
    const client =
      typeof input.client?.session?.status === 'function'
        ? input.client
        : getClient(input);
    if (typeof client?.session?.status !== 'function') {
      return {
        statuses: new Map(),
        malformedSessionIDs: new Set(),
        error: 'session-status capability unavailable on this host',
      };
    }
    const openRead = openStatusReads.get(client.session);
    if (openRead)
      return {
        statuses: new Map(),
        malformedSessionIDs: new Set(),
        error: 'Previous session-status read is still open',
        retryAfter: openRead,
      };
    const controller = new AbortController();
    const request = client.session.status({
      query: { directory: input.directory },
      signal: controller.signal,
    });
    const release = () => {
      if (openStatusReads.get(client.session) === settled)
        openStatusReads.delete(client.session);
    };
    const settled = request.then(release, release);
    openStatusReads.set(client.session, settled);
    const response = await withTimeout(
      request,
      options.timeoutMs ?? DEFAULT_RUNTIME_SESSION_STATUS_TIMEOUT_MS,
    ).catch((error) => {
      controller.abort();
      throw error;
    });
    if (
      (response.error !== undefined && response.error !== null) ||
      !isRecord(response.data)
    ) {
      return {
        statuses: new Map(),
        malformedSessionIDs: new Set(),
        error: 'invalid session-status response',
      };
    }
    if (
      Object.hasOwn(response.data, 'type') ||
      Object.hasOwn(response.data, 'status')
    ) {
      return {
        statuses: new Map(),
        malformedSessionIDs: new Set(),
        error: 'invalid session-status map response',
      };
    }

    const statuses = new Map<string, RuntimeSessionStatus>();
    const malformedSessionIDs = new Set<string>();
    for (const [sessionID, value] of Object.entries(response.data)) {
      if (
        isRecord(value) &&
        (value.type === 'busy' ||
          value.type === 'retry' ||
          value.type === 'idle')
      ) {
        statuses.set(sessionID, value.type);
      } else {
        malformedSessionIDs.add(sessionID);
      }
    }
    return { statuses, malformedSessionIDs };
  } catch (error) {
    return {
      statuses: new Map(),
      malformedSessionIDs: new Set(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** v2 host round evidence derived from the `session.get` info projection.
 *  `outcome` and `time.idle` are written atomically with the idle message;
 *  both absent means the latest round has no terminal transition. */
export type HostRoundState =
  | {
      kind: 'terminal';
      outcome: 'succeeded' | 'failed' | 'interrupted';
      idleAt: number;
    }
  | { kind: 'pending' }
  | { kind: 'unknown'; reason: string };

export function isHostTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A shutdown leaves this execution open until the host resumes or fails it. */
export function hostRunningSince(
  info: Record<string, unknown> | undefined,
): number | undefined {
  const time = isRecord(info?.time) ? info.time : undefined;
  const busy = time?.busy;
  if (!isHostTimestamp(busy) || !Number.isFinite(new Date(busy).getTime()))
    return undefined;
  const idle = time?.idle;
  return idle === undefined || (isHostTimestamp(idle) && busy > idle)
    ? busy
    : undefined;
}

/** Parse the host round state from a session info payload. A partially
 *  projected round (one of outcome/time.idle present) is abnormal data and
 *  fails closed; both absent is pending. */
export function hostRoundStateOf(
  info: Record<string, unknown> | undefined,
): HostRoundState {
  const outcome = info?.idleOutcome ?? info?.idle_outcome ?? info?.outcome;
  const time = isRecord(info?.time) ? info.time : undefined;
  const idleAt = time?.idle;
  const outcomePresent = outcome !== undefined && outcome !== null;
  if (!outcomePresent && idleAt === undefined) return { kind: 'pending' };
  if (
    !outcomePresent ||
    !isHostTimestamp(idleAt) ||
    (outcome !== 'succeeded' &&
      outcome !== 'failed' &&
      outcome !== 'interrupted')
  ) {
    return { kind: 'unknown', reason: 'host outcome and idle time disagree' };
  }
  return { kind: 'terminal', outcome, idleAt };
}

/** A terminal verdict requires an idle time strictly after the latest input,
 *  or a finished host execution when compaction removed that input. Service-level
 *  claims survive a graceful shutdown on purpose, so the host may still
 *  resume the latest round after a restart. */
export function hostRoundVerdict(
  state: HostRoundState,
  latestInputAt: number | undefined,
  busyAt?: number,
): 'terminal' | 'pending' | 'unknown' {
  if (state.kind === 'unknown') return 'unknown';
  if (state.kind === 'pending') return 'pending';
  return (
    latestInputAt !== undefined
      ? state.idleAt > latestInputAt
      : busyAt !== undefined && busyAt <= state.idleAt
  )
    ? 'terminal'
    : 'pending';
}

/** Legacy classification shape: pending is incomplete; unknown is unreadable. */
export function composeHostRound(
  state: HostRoundState,
  latestInputAt: number | undefined,
  busyAt?: number,
): CurrentRoundClassification {
  const verdict = hostRoundVerdict(state, latestInputAt, busyAt);
  if (verdict === 'unknown') {
    return {
      verdict: 'unreadable',
      reason: state.kind === 'unknown' ? state.reason : 'host state is unknown',
    };
  }
  if (verdict !== 'terminal' || state.kind !== 'terminal') {
    return { verdict: 'incomplete', startedAt: latestInputAt };
  }
  switch (state.outcome) {
    case 'succeeded':
      return {
        verdict: 'completed',
        startedAt: latestInputAt,
        completedAt: state.idleAt,
      };
    case 'failed':
      return {
        verdict: 'error',
        text: 'The historical round failed before an assistant result.',
        startedAt: latestInputAt,
        completedAt: state.idleAt,
      };
    case 'interrupted':
      return {
        verdict: 'interrupted',
        startedAt: latestInputAt,
        completedAt: state.idleAt,
      };
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timers?: TimerSeam,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Session status lookup timed out');
  }
  const setTimer =
    timers?.setTimeout ??
    ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const clearTimer =
    timers?.clearTimeout ?? ((timer: TimerHandle) => clearTimeout(timer));
  let timer: TimerHandle | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        const scheduled = setTimer(() => {
          reject(new Error('Session status lookup timed out'));
        }, timeoutMs);
        timer = scheduled;
        if (typeof scheduled !== 'number') scheduled.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimer(timer);
  }
}
