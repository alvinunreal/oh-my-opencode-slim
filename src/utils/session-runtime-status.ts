import type { PluginInput } from '@opencode-ai/plugin';
import type { CurrentRoundClassification } from './child-transcript';
import { isRecord } from './guards';
import { getClient } from './opencode-client';
import { raceEvidenceDeadline, readHostSessionInfo } from './session-info-read';
import type { TimerHandle, TimerSeam } from './timer-seam';

export type RuntimeSessionStatus = 'busy' | 'retry' | 'idle';
const DEFAULT_RUNTIME_SESSION_STATUS_TIMEOUT_MS = 5_000;
/** Default bound for the one host-info classification read (v2 hosts). */
const DEFAULT_LIVE_SESSION_CLASSIFY_TIMEOUT_MS = 1_500;

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

type LiveSession =
  | { kind: RuntimeSessionStatus | 'absent' }
  | { kind: 'unknown'; reason: string };

/** Host terminal outcome literals the classifier surfaces. */
type HostTerminalOutcome = 'succeeded' | 'failed' | 'interrupted';

const HOST_TERMINAL_OUTCOMES: readonly string[] = [
  'succeeded',
  'failed',
  'interrupted',
];

/** Reduce a session-info payload to the probe verdict. Parsing is shared
 *  with recovery triage through `hostRoundStateOf`; the reason strings are
 *  the classifier's own (they are rendered by task_status). */
function classifySessionInfo(
  info: Record<string, unknown>,
): LiveSessionClassification {
  const state = hostRoundStateOf(info);
  if (state.kind === 'terminal') {
    return {
      kind: 'outcome',
      outcome: state.outcome,
      idleAt: state.idleAt,
      ...(typeof info.id === 'string' && typeof info.parentID === 'string'
        ? { sessionID: info.id, parentID: info.parentID }
        : {}),
    };
  }
  if (state.kind === 'pending') {
    return { kind: 'unknown', reason: 'no host terminal outcome' };
  }
  const outcome = info.idleOutcome ?? info.idle_outcome ?? info.outcome;
  if (outcome === undefined || outcome === null) {
    return { kind: 'unknown', reason: 'no host terminal outcome' };
  }
  return {
    kind: 'unknown',
    reason:
      typeof outcome === 'string' && !HOST_TERMINAL_OUTCOMES.includes(outcome)
        ? `unrecognized host outcome: ${outcome}`
        : 'host outcome has no valid idle time',
  };
}

/**
 * One bounded classification of a live child session, reduced to what a
 * task-status probe can act on. Pure: no tool text, no board writes.
 */
type LiveSessionClassification =
  | { kind: 'running' }
  | { kind: 'idle' }
  | {
      kind: 'outcome';
      outcome: HostTerminalOutcome;
      idleAt?: number;
      sessionID?: string;
      parentID?: string;
    }
  | { kind: 'unknown'; reason: string };

function classificationFromSnapshot(
  snapshot: RuntimeSessionStatusSnapshot,
  sessionID: string,
): LiveSessionClassification {
  if (
    snapshot.error !== undefined ||
    snapshot.malformedSessionIDs.has(sessionID)
  ) {
    return {
      kind: 'unknown',
      reason: snapshot.error ?? 'malformed entry',
    };
  }
  const status = snapshot.statuses.get(sessionID);
  return status === 'busy' || status === 'retry'
    ? { kind: 'running' }
    : { kind: 'idle' };
}

/** One fresh read, reduced to what a single session's decision needs. */
async function readLiveSession(
  input: PluginInput,
  sessionID: string,
  options: { timeoutMs?: number } = {},
): Promise<LiveSession> {
  const snapshot = await getRuntimeSessionStatusSnapshot(input, options);
  if (
    snapshot.error !== undefined ||
    snapshot.malformedSessionIDs.has(sessionID)
  )
    return { kind: 'unknown', reason: snapshot.error ?? 'malformed entry' };
  return { kind: snapshot.statuses.get(sessionID) ?? 'absent' };
}

/**
 * Classify one child session ONCE for a task-status probe.
 *
 * Reuses the live session-status map where the host exposes it (v1). On
 * hosts without that map (v2) one bounded host `session.get` read surfaces
 * the terminal outcome (`succeeded|failed|interrupted`) together with
 * `time.idle` — the same host-clock timestamp the terminal gate attributes
 * against. Anything unreadable or unrecognized stays `unknown`, never a
 * fabricated state. Callers that already read the session info pass it as
 * `hostInfo` so the probe never issues a duplicate read.
 */
export async function classifyLiveSession(
  input: PluginInput,
  sessionID: string,
  options: {
    timeoutMs?: number;
    timers?: TimerSeam;
    /** Reuse a status-map read already performed for this query. */
    snapshot?: RuntimeSessionStatusSnapshot;
    /** Reuse a session-info read already performed for this query. */
    hostInfo?: Record<string, unknown>;
  } = {},
): Promise<LiveSessionClassification> {
  const timeoutMs =
    options.timeoutMs ?? DEFAULT_LIVE_SESSION_CLASSIFY_TIMEOUT_MS;
  const client =
    typeof input.client?.session?.status === 'function'
      ? input.client
      : getClient(input);
  if (typeof client?.session?.status === 'function') {
    if (options.snapshot) {
      return classificationFromSnapshot(options.snapshot, sessionID);
    }
    const live = await readLiveSession(input, sessionID, { timeoutMs });
    if (live.kind === 'unknown') {
      return { kind: 'unknown', reason: live.reason };
    }
    return live.kind === 'busy' || live.kind === 'retry'
      ? { kind: 'running' }
      : { kind: 'idle' };
  }
  if (options.hostInfo !== undefined) {
    return classifySessionInfo(options.hostInfo);
  }
  if (typeof client?.session?.get !== 'function') {
    return {
      kind: 'unknown',
      reason: 'session-status and session-get unavailable on this host',
    };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { kind: 'unknown', reason: 'Session status lookup timed out' };
  }
  // One shared raw read per client+session; the deadline releases only this
  // waiter, so a stalled host read is never re-issued behind itself.
  const tagged = readHostSessionInfo(input, {
    taskID: sessionID,
    identity: `standalone:${sessionID}`,
  }).then(
    (value) => ({ value, failed: false as const }),
    (error) => ({ error, failed: true as const }),
  );
  const raced = await raceEvidenceDeadline(tagged, timeoutMs, options.timers);
  if (raced === undefined) {
    return { kind: 'unknown', reason: 'Session status lookup timed out' };
  }
  if (raced.failed) {
    return {
      kind: 'unknown',
      reason:
        raced.error instanceof Error
          ? raced.error.message
          : String(raced.error),
    };
  }
  const response = raced.value;
  if (
    !isRecord(response) ||
    (response.error !== undefined && response.error !== null)
  ) {
    return { kind: 'unknown', reason: 'invalid session info response' };
  }
  return classifySessionInfo(
    isRecord(response.data) ? response.data : response,
  );
}

export function runtimeSessionStatus(
  snapshot: RuntimeSessionStatusSnapshot,
  sessionID: string,
): RuntimeSessionStatus | undefined {
  if (snapshot.error) return undefined;
  if (snapshot.malformedSessionIDs.has(sessionID)) return undefined;
  return snapshot.statuses.get(sessionID);
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
    typeof idleAt !== 'number' ||
    !Number.isSafeInteger(idleAt) ||
    idleAt < 0 ||
    (outcome !== 'succeeded' &&
      outcome !== 'failed' &&
      outcome !== 'interrupted')
  ) {
    return { kind: 'unknown', reason: 'host outcome and idle time disagree' };
  }
  return { kind: 'terminal', outcome, idleAt };
}

/** A terminal verdict requires an idle time strictly after the latest input;
 *  otherwise the round is pending — never a guessed stop. Service-level
 *  claims survive a graceful shutdown on purpose, so the host may still
 *  resume the latest round after a restart. */
export function hostRoundVerdict(
  state: HostRoundState,
  latestInputAt: number | undefined,
): 'terminal' | 'pending' | 'unknown' {
  if (state.kind === 'unknown') return 'unknown';
  if (state.kind === 'pending') return 'pending';
  return latestInputAt !== undefined && state.idleAt > latestInputAt
    ? 'terminal'
    : 'pending';
}

/** Legacy classification shape: pending is incomplete; unknown is unreadable. */
export function composeHostRound(
  state: HostRoundState,
  latestInputAt: number | undefined,
): CurrentRoundClassification {
  const verdict = hostRoundVerdict(state, latestInputAt);
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
