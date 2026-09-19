import type { PluginInput } from '@opencode-ai/plugin';
import type {
  BackgroundJobLease,
  BackgroundJobRecord,
  BackgroundJobTerminalInput,
} from './background-job-board';
import type { BackgroundJobStore } from './background-job-store';
import {
  classifyTerminalEvidence,
  fetchChildTranscript,
  responseError,
} from './child-transcript';
import { isRecord } from './guards';
import { log } from './logger';
import { getClient } from './opencode-client';
import {
  getRuntimeSessionStatusSnapshot,
  type RuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from './session-runtime-status';
import {
  COMPLETED_WITHOUT_TEXT_DIAGNOSTIC,
  guardCompletedStatusText,
  type TaskStatusOutput,
} from './task';

export const STOP_CONFIRMATION_GRACE_MS = 5_000;
export const DEFAULT_EVIDENCE_READ_TIMEOUT_MS = 5_000;
export const STOPPED_WITHOUT_TERMINAL_RESULT =
  'Background session stopped before a terminal task result was received.';
export const EVIDENCE_UNAVAILABLE_DIAGNOSTIC =
  'Terminal evidence could not be read after repeated attempts; task termination is unconfirmed (observation unavailable).';
const UNATTRIBUTABLE_HOST_OUTCOME =
  'Host outcome is not attributable to this run/attempt; task termination is unconfirmed.';

/** Origin of the terminal evidence behind a publication. Log field only. */
type TerminalAttribution = 'host-outcome' | 'transcript' | 'event';

export type RunRef = { taskID: string; generation: number };
export type ObservationToken = Readonly<
  RunRef & {
    activityRevision: number;
    terminalRevision: number;
    attemptRevision: number | undefined;
    attemptStartedAt: number | undefined;
    baselineMessageID: string | undefined;
    episode: number;
    readStartedAt: number;
  }
>;
export type RuntimeObservation = {
  kind: 'busy' | 'retry' | 'quiescent' | 'unknown' | 'deleted';
  origin: string;
  readStartedAt: number;
  /** Timestamp supplied by an event, distinct from reception/read time. */
  observedAt?: number;
  diagnostic?: string;
  /** A collided runtime request can retry after this slot is released. */
  retryAfter?: Promise<void>;
  /** A cancellation verifier already checked its stable interval. */
  stable?: boolean;
  terminalOutcome?: string;
};
export type TaskOutputOrigin =
  | {
      kind: 'native';
      run: RunRef;
      callID: string;
      /** Host matched this pending by exact callID; parsed identity is not enough. */
      callIDConfirmed?: boolean;
    }
  | {
      kind: 'synthetic';
      occurrenceID: string;
      run?: RunRef;
      provenance: string;
    };
export type TerminalSignal =
  | { kind: 'inspect' }
  | { kind: 'output'; status: TaskStatusOutput; origin: TaskOutputOrigin }
  | { kind: 'session-error'; message: string }
  | { kind: 'cancel'; lease: BackgroundJobLease; reason?: string }
  | { kind: 'deadline' };
export type GateResult =
  | { kind: 'deferred'; record: BackgroundJobRecord }
  | { kind: 'committed'; record: BackgroundJobRecord }
  | { kind: 'stale' };
export interface BackgroundJobTerminalGate {
  capture(run: RunRef): ObservationToken | undefined;
  observe(token: ObservationToken, runtime: RuntimeObservation): GateResult;
  reconcile(run: RunRef, signal?: TerminalSignal): Promise<GateResult>;
  dispose(): void;
}

const terminalCommitBrand = Symbol('terminal-commit');
/** Opaque, single-use, bound to the issuing gate, record and exact transition. */
export type TerminalCommitToken = Readonly<{ [terminalCommitBrand]: true }>;
interface TerminalAuthorization {
  record: BackgroundJobRecord;
  input: BackgroundJobTerminalInput;
  validate(): boolean;
}
const authorizedByGate = new WeakMap<
  BackgroundJobTerminalGate,
  WeakMap<TerminalCommitToken, TerminalAuthorization>
>();

/** Board-side consumption only. There is intentionally no exported issuer. */
export function consumeTerminalCommitToken(
  gate: BackgroundJobTerminalGate | undefined,
  token: TerminalCommitToken,
  record: BackgroundJobRecord,
  input: BackgroundJobTerminalInput,
): boolean {
  const authorizations = gate && authorizedByGate.get(gate);
  const authorization = authorizations?.get(token);
  if (!authorization) return false;
  authorizations?.delete(token);
  return (
    authorization.record === record &&
    authorization.input === input &&
    authorization.validate()
  );
}

export function raceEvidenceDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  const settled = promise.catch(() => undefined);
  if (timeoutMs <= 0) return settled;
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    settled,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export function runtimeObservationFromSnapshot(
  snapshot: RuntimeSessionStatusSnapshot,
  taskID: string,
  readStartedAt: number,
): RuntimeObservation {
  const status = runtimeSessionStatus(snapshot, taskID);
  return {
    kind:
      snapshot.error || snapshot.malformedSessionIDs.has(taskID)
        ? 'unknown'
        : status === 'busy' || status === 'retry'
          ? status
          : 'quiescent',
    origin: 'session.status',
    readStartedAt,
    diagnostic: snapshot.error,
    retryAfter: snapshot.retryAfter,
  };
}

interface Observation {
  generation: number;
  activityRevision: number;
  episode: number;
  runtime?: RuntimeObservation;
  pendingRuntime?: boolean;
  pendingRuntimeContrast?: {
    token: ObservationToken;
    readSettled: Promise<void>;
  };
  idleCandidate?: RuntimeObservation;
  quiescentSince?: number;
  candidate?: { signal: TerminalSignal; token: ObservationToken };
  retries: number;
  timer?: ReturnType<typeof setTimeout>;
}

type ReadResult =
  | { kind: 'ready'; value: unknown }
  | { kind: 'blocked'; retryAfter: Promise<void> };

/** A foreground run's synchronous native terminal return is itself
 * terminal evidence — the host call bound to this exact run has already
 * come back — but only when the host attributed the output by its exact
 * callID (callIDConfirmed); text-parsed identity could be a quoted
 * foreign task header. Background runs never qualify. */
function isForegroundNativeTerminal(
  signal: TerminalSignal | undefined,
  background: boolean,
): boolean {
  return (
    signal?.kind === 'output' &&
    signal.origin.kind === 'native' &&
    signal.origin.callIDConfirmed === true &&
    signal.status.state !== 'running' &&
    !background
  );
}

function validHostTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Host `session.outcome` literals the gate treats as attributable
 * terminal outcomes. Intentionally a SUPERSET of the host schema's
 * emitted literals (packages/schema session.ts `Info.outcome`): the
 * extra `'cancelled'` is the plugin's stop-family fail-safe so a
 * cancel-shaped row never publishes as an error. Host literals MUST
 * stay a subset — pinned against the cloned host schema by
 * src/terminal-gate.integration.test.ts (runbook §6 drift contract);
 * anything outside this set routes to the unrecognized-outcome
 * rejection, never a publication. */
export const ACCEPTED_HOST_OUTCOMES: readonly string[] = [
  'succeeded',
  'failed',
  'interrupted',
  'cancelled',
];

function attributableHostOutcome(
  response: unknown,
  bounds: {
    lowerBound: number;
    readCompletedAt: number;
    clockComparable: boolean;
  },
): { outcome: string; idleAt: number } | undefined {
  if (!isRecord(response) || responseError(response) !== undefined)
    return undefined;
  const info = 'data' in response ? response.data : response;
  if (!isRecord(info)) return;
  const outcome = info.outcome;
  const idleAt = isRecord(info.time) ? info.time.idle : undefined;
  if (
    !bounds.clockComparable ||
    !validHostTime(idleAt) ||
    !validHostTime(bounds.lowerBound) ||
    !validHostTime(bounds.readCompletedAt) ||
    typeof outcome !== 'string' ||
    !ACCEPTED_HOST_OUTCOMES.includes(outcome) ||
    !(bounds.lowerBound < idleAt && idleAt <= bounds.readCompletedAt)
  )
    return;
  return { outcome, idleAt };
}

/** Log-only mirror of attributableHostOutcome's rejection cascade. The
 * check order mirrors the binding decision so the logged reason always
 * matches why the outcome was rejected; it never gates behavior. */
function hostOutcomeRejectionReason(
  response: unknown,
  bounds: {
    lowerBound: number;
    readCompletedAt: number;
    clockComparable: boolean;
  },
): string {
  if (!isRecord(response)) return 'response-unreadable';
  if (responseError(response) !== undefined) return 'host-error';
  const info = 'data' in response ? response.data : response;
  if (!isRecord(info)) return 'malformed-info';
  const outcome = info.outcome;
  const idleAt = isRecord(info.time) ? info.time.idle : undefined;
  if (!bounds.clockComparable) return 'clock-not-comparable';
  if (!validHostTime(idleAt)) return 'invalid-idle-time';
  if (!validHostTime(bounds.lowerBound)) return 'invalid-window-lower';
  if (!validHostTime(bounds.readCompletedAt)) return 'invalid-read-completion';
  if (typeof outcome !== 'string') return 'outcome-missing';
  if (!ACCEPTED_HOST_OUTCOMES.includes(outcome))
    return `unrecognized-outcome:${String(outcome)}`;
  if (!(bounds.lowerBound < idleAt)) return 'idle-not-after-window-lower';
  return 'idle-after-read-completion';
}

function observationIdentity(token: ObservationToken): string {
  return JSON.stringify([
    token.generation,
    token.activityRevision,
    token.terminalRevision,
    token.attemptRevision,
    token.attemptStartedAt,
    token.baselineMessageID,
    token.episode,
  ]);
}

const sessionInfoReads = new WeakMap<
  object,
  Map<string, { identity: string; promise: Promise<unknown> }>
>();

/** Share the raw, still-open host read with the rehydration existence probe.
 * A consumer deadline must not release this slot or authorize a new read. */
export function readSessionInfoForObservation(
  input: PluginInput,
  token: ObservationToken,
): Promise<unknown> {
  const client = getClient(input);
  const session = client?.session;
  if (typeof session?.get !== 'function') return Promise.resolve(undefined);
  let reads = sessionInfoReads.get(session);
  if (!reads) {
    reads = new Map();
    sessionInfoReads.set(session, reads);
  }
  const identity = observationIdentity(token);
  const existing = reads.get(token.taskID);
  if (existing)
    return existing.identity === identity
      ? existing.promise
      : Promise.reject(
          new Error('An earlier session-info observation is still in flight.'),
        );
  const promise = Promise.resolve().then(() =>
    session.get({
      path: { id: token.taskID },
      query: { directory: input.directory },
    }),
  );
  reads.set(token.taskID, { identity, promise });
  const release = () => {
    if (reads.get(token.taskID)?.promise === promise)
      reads.delete(token.taskID);
  };
  void promise.then(release, release);
  return promise;
}

export function createBackgroundJobTerminalGate(options: {
  backgroundJobBoard: BackgroundJobStore;
  input?: PluginInput;
  readRuntime?: (run: RunRef, startedAt: number) => Promise<RuntimeObservation>;
  readTerminalEvidence?: (taskID: string) => Promise<unknown>;
  baselineFor?: (taskID: string, generation: number) => string | undefined;
  attemptStartedAtFor?: (
    taskID: string,
    generation: number,
  ) => number | undefined;
  /** Explicit integration contract; never inferred from host flavor/capabilities. */
  hostOutcomeClock?: 'shared-unix-ms';
  observationRevisionFor?: (
    taskID: string,
    generation: number,
  ) => number | undefined;
  isObservationPending?: (taskID: string, generation: number) => boolean;
  onRunning?: (record: BackgroundJobRecord) => void;
  onTerminal?: (record: BackgroundJobRecord) => void;
  graceMs?: number;
  readTimeoutMs?: number;
  maxEvidenceRetries?: number;
  now?: () => number;
}): BackgroundJobTerminalGate {
  const board = options.backgroundJobBoard;
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? STOP_CONFIRMATION_GRACE_MS;
  const timeoutMs = options.readTimeoutMs ?? DEFAULT_EVIDENCE_READ_TIMEOUT_MS;
  const observations = new Map<string, Observation>();
  const tokens = new WeakSet<ObservationToken>();
  const openReads = new Map<
    string,
    { identity: string; underlying: Promise<unknown>; settled: Promise<void> }
  >();
  const inFlight = new Map<string, Promise<GateResult>>();
  const authorizations = new WeakMap<
    TerminalCommitToken,
    TerminalAuthorization
  >();
  let disposed = false;

  function observation(run: RunRef): Observation | undefined {
    const record = board.get(run.taskID);
    if (disposed || record?.generation !== run.generation) return;
    let value = observations.get(run.taskID);
    if (!value || value.generation !== run.generation) {
      if (value?.timer) clearTimeout(value.timer);
      value = {
        generation: run.generation,
        activityRevision: record.activityRevision,
        episode: 0,
        retries: 0,
      };
      observations.set(run.taskID, value);
    }
    if (value.activityRevision !== record.activityRevision) {
      if (value.timer) clearTimeout(value.timer);
      value = {
        generation: run.generation,
        activityRevision: record.activityRevision,
        episode: value.episode + 1,
        retries: 0,
      };
      observations.set(run.taskID, value);
    }
    return value;
  }

  function capture(run: RunRef): ObservationToken | undefined {
    const value = observation(run);
    if (!value) return;
    const token = Object.freeze({
      taskID: run.taskID,
      generation: run.generation,
      activityRevision: value.activityRevision,
      terminalRevision: board.get(run.taskID)?.terminalRevision ?? 0,
      attemptRevision: options.observationRevisionFor?.(
        run.taskID,
        run.generation,
      ),
      baselineMessageID: options.baselineFor?.(run.taskID, run.generation),
      attemptStartedAt: options.attemptStartedAtFor?.(
        run.taskID,
        run.generation,
      ),
      episode: value.episode,
      readStartedAt: now(),
    });
    tokens.add(token);
    return token;
  }

  function current(token: ObservationToken): boolean {
    const value = observation(token);
    return (
      tokens.has(token) &&
      value !== undefined &&
      value.activityRevision === token.activityRevision &&
      board.get(token.taskID)?.terminalRevision === token.terminalRevision &&
      value.episode === token.episode &&
      options.attemptStartedAtFor?.(token.taskID, token.generation) ===
        token.attemptStartedAt &&
      options.baselineFor?.(token.taskID, token.generation) ===
        token.baselineMessageID &&
      options.observationRevisionFor?.(token.taskID, token.generation) ===
        token.attemptRevision
    );
  }

  function deferred(run: RunRef, diagnostic?: string): GateResult {
    const record = diagnostic
      ? board.markStatusUncertain(run.taskID, diagnostic, run.generation)
      : board.get(run.taskID);
    return record?.generation === run.generation
      ? { kind: 'deferred', record }
      : { kind: 'stale' };
  }

  function retry(run: RunRef, diagnostic: string): GateResult {
    const value = observation(run);
    if (!value) return { kind: 'stale' };
    if (
      !value.timer &&
      value.retries <= (options.maxEvidenceRetries ?? 3) &&
      board.get(run.taskID)?.state === 'running'
    ) {
      value.timer = setTimeout(
        () => {
          value.timer = undefined;
          if (observation(run) !== value) return;
          // Background reconciliation is fail-soft: a failure must be
          // logged and swallowed, never escape as an unhandled rejection.
          void reconcile(run).catch((err) => {
            log('[terminal-gate] scheduled reconcile failed', String(err));
          });
        },
        Math.max(1, graceMs),
      );
      value.timer.unref?.();
    }
    if (diagnostic === EVIDENCE_UNAVAILABLE_DIAGNOSTIC) {
      // Give-up branch: the evidence retry budget is exhausted and no
      // further reconcile is scheduled. Observation only.
      log('[terminal-gate] terminal evidence unavailable', {
        taskID: run.taskID,
        generation: run.generation,
        state: board.get(run.taskID)?.state,
        attempt: value.retries,
        verdict: 'gave-up',
        reason: diagnostic,
      });
    }
    return deferred(run, diagnostic);
  }

  function commit(
    token: ObservationToken,
    state: 'completed' | 'error' | 'cancelled' | 'stopped',
    text: string,
    lease?: BackgroundJobLease,
    attribution: TerminalAttribution = 'event',
  ): GateResult {
    const value = observation(token);
    const before = board.get(token.taskID);
    if (!before || !value || !current(token)) return { kind: 'stale' };
    if (before.state !== 'running') {
      const terminal =
        before.state === 'reconciled' ? before.terminalState : before.state;
      return terminal === state && before.resultSummary === text
        ? { kind: 'committed', record: before }
        : deferred(token);
    }
    const input: BackgroundJobTerminalInput = Object.freeze({
      taskID: token.taskID,
      state,
      resultSummary: text,
      cancellationLease: lease,
      now: now(),
    });
    const candidateSignal = value.candidate?.signal;
    const foregroundNativeEvidence = isForegroundNativeTerminal(
      candidateSignal,
      before.background,
    );
    const authorization: TerminalCommitToken = Object.freeze({
      [terminalCommitBrand]: true,
    });
    authorizations.set(authorization, {
      input,
      record: before,
      validate: () =>
        current(token) &&
        (value.runtime?.kind === 'deleted' ||
          !options.isObservationPending?.(token.taskID, token.generation)) &&
        (value.runtime?.kind === 'quiescent' ||
          value.runtime?.kind === 'deleted' ||
          foregroundNativeEvidence),
    });
    const record = board.commitTerminal(input, authorization);
    if (record === before || !record) return deferred(token);
    const latest = board.get(token.taskID);
    if (
      latest?.generation !== record.generation ||
      latest.terminalRevision !== record.terminalRevision ||
      latest.state === 'running'
    )
      return { kind: 'stale' };
    if (value.timer) clearTimeout(value.timer);
    value.timer = undefined;
    value.candidate = undefined;
    options.onTerminal?.(record);
    log('[terminal-gate] terminal published', {
      taskID: token.taskID,
      generation: token.generation,
      state,
      attribution,
      parentSessionID: record.parentSessionID,
    });
    return { kind: 'committed', record };
  }

  function observe(
    token: ObservationToken,
    runtime: RuntimeObservation,
  ): GateResult {
    if (!current(token) || runtime.readStartedAt < token.readStartedAt)
      return { kind: 'stale' };
    const value = observation(token);
    if (!value) return { kind: 'stale' };
    const before = board.get(token.taskID);
    if (!before) return { kind: 'stale' };
    if (
      runtime.observedAt !== undefined &&
      runtime.observedAt < (before.lastLiveBusyAt ?? before.runStartedAt)
    )
      return { kind: 'stale' };
    const predatesPublication =
      runtime.observedAt !== undefined &&
      before.completedAt !== undefined &&
      runtime.observedAt <= before.completedAt;
    if (
      runtime.origin === 'session.status-event' &&
      (runtime.observedAt === undefined || predatesPublication)
    ) {
      // completedAt is local publication time, not proven host termination.
      // An ambiguous event needs fresh runtime, never an immediate reopen or
      // reuse of the observation that authorized the publication.
      value.episode += 1;
      value.pendingRuntime = false;
      value.runtime = undefined;
      value.quiescentSince = undefined;
      // Ambiguous busy/retry is live activity: drop held candidates.
      value.candidate = undefined;
      value.idleCandidate = undefined;
      if (value.timer) clearTimeout(value.timer);
      value.timer = undefined;
      return deferred(token);
    }
    if (predatesPublication) return { kind: 'stale' };
    if (runtime.origin === 'session.idle') {
      value.idleCandidate = runtime;
      value.pendingRuntime = false;
      value.retries = 0;
      return deferred(token);
    }
    value.pendingRuntime =
      runtime.origin === 'session.status' ||
      runtime.origin === 'cancel-verifier';
    if (runtime.kind === 'busy' || runtime.kind === 'retry') {
      value.episode += 1;
      value.quiescentSince = undefined;
      value.retries = 0;
      value.candidate = undefined;
      value.idleCandidate = undefined;
      if (value.timer) clearTimeout(value.timer);
      value.timer = undefined;
      value.runtime = runtime;
      const record = board.markRunningFromLiveSession(
        token.taskID,
        runtime.observedAt ?? runtime.readStartedAt,
        token.generation,
        runtime.observedAt === undefined ? token.terminalRevision : undefined,
      );
      if (!record) return { kind: 'stale' };
      value.activityRevision = record.activityRevision;
      options.onRunning?.(record);
      return { kind: 'deferred', record };
    }
    // Recovering runtime starts a fresh evidence budget. Repeated quiescent
    // reads must not replenish it while transcript stabilization is pending.
    if (runtime.kind === 'quiescent' && value.runtime?.kind !== 'quiescent')
      value.retries = 0;
    value.runtime = runtime;
    if (runtime.kind === 'unknown') {
      if (runtime.retryAfter) {
        // A collision is not a new runtime observation. Retain the current
        // identity and the request, even when repairing a terminal record.
        value.pendingRuntime = false;
        return requestRuntimeContrastAfterRead(
          token,
          runtime.retryAfter,
          runtime.diagnostic,
        );
      }
      value.episode += 1;
      // Unknown invalidates open evidence, but never replenishes retries.
      // inspect accounts for the failed attempt, including missing APIs.
      value.quiescentSince = undefined;
      if (value.timer) clearTimeout(value.timer);
      value.timer = undefined;
      return deferred(
        token,
        runtime.diagnostic ??
          'Runtime observation unavailable; task termination is unconfirmed.',
      );
    }
    value.quiescentSince ??= now();
    if (
      runtime.kind === 'deleted' &&
      board.get(token.taskID)?.deadlineExceededAt !== undefined
    ) {
      return commit(
        token,
        'error',
        'Background task exceeded its wall-clock deadline; session deletion confirmed the abort.',
      );
    }
    return deferred(token);
  }

  function requestRuntimeContrastAfterRead(
    token: ObservationToken,
    readSettled: Promise<void>,
    diagnostic = 'Previous evidence read is still open; task termination is unconfirmed.',
  ): GateResult {
    const value = observation(token);
    if (!value || !current(token)) return { kind: 'stale' };
    if (value.pendingRuntimeContrast?.readSettled === readSettled) {
      // Coalesce repeated requests against the same open read to the latest
      // requested episode, without adding another completion callback.
      value.pendingRuntimeContrast.token = token;
      return deferred(token, diagnostic);
    }
    const pending = { token, readSettled };
    value.pendingRuntimeContrast = pending;
    void readSettled
      .then(async () => {
        if (!current(pending.token)) return;
        const key = JSON.stringify([
          pending.token.taskID,
          observationIdentity(pending.token),
        ]);
        // The slot can be released before the deferred inspection's finally.
        // Wait for that existing flight, so reconcile cannot just rejoin it.
        await inFlight.get(key);
        if (value.pendingRuntimeContrast !== pending || !current(pending.token))
          return;
        value.pendingRuntimeContrast = undefined;
        value.pendingRuntime = false;
        await reconcile(pending.token);
      })
      .catch((err) => {
        // Background reconciliation is fail-soft: a failure must be
        // logged and swallowed, never escape as an unhandled rejection.
        log('[terminal-gate] runtime-contrast reconcile failed', String(err));
      });
    return deferred(token, diagnostic);
  }

  // Timeout releases the consumer, NEVER the underlying operation. Identity
  // changes cannot join old evidence or start another read while it is open.
  async function read(
    key: string,
    token: ObservationToken,
    operation: () => Promise<unknown>,
  ): Promise<ReadResult> {
    const identity = observationIdentity(token);
    let entry = openReads.get(key);
    if (entry && entry.identity !== identity)
      return { kind: 'blocked', retryAfter: entry.settled };
    if (!entry) {
      const underlying = Promise.resolve().then(operation);
      const release = () => {
        if (openReads.get(key)?.underlying === underlying)
          openReads.delete(key);
      };
      // Share availability, never the previous identity's response. As with
      // the SDK registry, consumer timeout does not release this slot.
      const settled = underlying.then(release, release);
      entry = { identity, underlying, settled };
      openReads.set(key, entry);
    }
    return {
      kind: 'ready',
      value: await raceEvidenceDeadline(entry.underlying, timeoutMs),
    };
  }

  function outcomeFromRead(
    response: unknown,
    token: ObservationToken,
    attempt: number,
  ) {
    const job = board.get(token.taskID);
    if (!job) return;
    const boundaries = [
      job.runStartedAt,
      token.attemptStartedAt ?? job.runStartedAt,
      job.lastLiveBusyAt ?? job.runStartedAt,
    ];
    const lowerBound = boundaries.every(validHostTime)
      ? Math.max(...boundaries)
      : NaN;
    const readCompletedAt = now();
    const bounds = {
      lowerBound,
      readCompletedAt,
      clockComparable: options.hostOutcomeClock === 'shared-unix-ms',
    };
    const attribution = attributableHostOutcome(response, bounds);
    // Observation only: the read window, the outcome value seen, and the
    // attribution verdict (with a reason on rejection) land in the log so
    // a gate that never publishes stays diagnosable from the plugin log.
    const envelope = isRecord(response)
      ? 'data' in response
        ? response.data
        : response
      : undefined;
    const outcomeRead =
      isRecord(envelope) && typeof envelope.outcome === 'string'
        ? envelope.outcome
        : undefined;
    log('[terminal-gate] host-outcome attribution', {
      taskID: token.taskID,
      generation: token.generation,
      state: job.state,
      attribution: 'host-outcome',
      attempt,
      readStartedAt: token.readStartedAt,
      readCompletedAt,
      outcome: attribution ? attribution.outcome : outcomeRead,
      windowLower: lowerBound,
      windowUpper: readCompletedAt,
      verdict: attribution ? 'accepted' : 'rejected',
      reason: attribution
        ? undefined
        : hostOutcomeRejectionReason(response, bounds),
    });
    return attribution;
  }

  async function inspect(run: RunRef): Promise<GateResult> {
    let token = capture(run);
    if (!token) return { kind: 'stale' };
    const value = observation(run);
    if (!value) return { kind: 'stale' };
    const cancellation = value.candidate?.signal.kind === 'cancel';
    // A sealed cancellation verification is consumed as-is. Polling adapters
    // likewise pass their fresh batched observation without a second lookup.
    const suppliedRuntime = value.pendingRuntime;
    value.pendingRuntime = false;
    if (!suppliedRuntime && !(cancellation && value.runtime?.stable)) {
      if (
        options.readRuntime ||
        (options.input &&
          typeof getClient(options.input)?.session?.status === 'function')
      ) {
        const hostInput = options.input;
        const startedAt = token.readStartedAt;
        const response = await read(
          `runtime:${run.taskID}`,
          token,
          async () => {
            if (options.readRuntime) return options.readRuntime(run, startedAt);
            if (hostInput)
              return runtimeObservationFromSnapshot(
                await getRuntimeSessionStatusSnapshot(hostInput),
                run.taskID,
                startedAt,
              );
            return undefined;
          },
        );
        if (!current(token)) return { kind: 'stale' };
        if (response.kind === 'blocked')
          return requestRuntimeContrastAfterRead(token, response.retryAfter);
        const result = observe(
          token,
          (response.value as RuntimeObservation) ?? {
            kind: 'unknown',
            origin: 'timeout',
            readStartedAt: token.readStartedAt,
          },
        );
        value.pendingRuntime = false;
        if (result.kind === 'stale') return result;
        token = capture(run);
        if (!token) return { kind: 'stale' };
      } else if (options.input) {
        const client = getClient(options.input);
        const input = options.input;
        const observation = token;
        if (typeof client?.session?.get === 'function') {
          const response = await read(`outcome:${run.taskID}`, token, () => {
            // The closure runs exactly when a fresh underlying host read
            // starts (joins/blocked attempts do not re-run it).
            log('[terminal-gate] host-outcome read initiated', {
              taskID: run.taskID,
              generation: run.generation,
              state: board.get(run.taskID)?.state,
              attribution: 'host-outcome',
              attempt: value.retries,
              readStartedAt: observation.readStartedAt,
            });
            return readSessionInfoForObservation(input, observation);
          });
          if (!current(token)) return { kind: 'stale' };
          if (response.kind === 'blocked')
            return requestRuntimeContrastAfterRead(token, response.retryAfter);
          const attributable = outcomeFromRead(
            response.value,
            token,
            value.retries,
          );
          if (attributable) {
            observe(token, {
              kind: 'quiescent',
              origin: 'host-outcome',
              readStartedAt: token.readStartedAt,
              observedAt: attributable.idleAt,
              terminalOutcome: attributable.outcome,
            });
          } else if (
            !value.runtime ||
            value.runtime.origin === 'host-outcome'
          ) {
            observe(token, {
              kind: 'unknown',
              origin: 'host-outcome',
              readStartedAt: token.readStartedAt,
              diagnostic: UNATTRIBUTABLE_HOST_OUTCOME,
            });
          }
          // As with session.status, our own unknown observation advances the
          // episode. Continue with its token rather than losing the retry as stale.
          token = capture(run);
          if (!token) return { kind: 'stale' };
        }
      }
    }
    if (!current(token)) return { kind: 'stale' };
    const runtime = value.runtime;
    const job = board.get(run.taskID);
    if (!job || job.generation !== run.generation) return { kind: 'stale' };
    const candidate = value.candidate;
    let signal =
      candidate && current(candidate.token) ? candidate.signal : undefined;
    // Re-arm only a local episode bump with every other identity barrier
    // intact. Foreground only; a genuine busy already cleared the candidate.
    if (
      !signal &&
      candidate &&
      !job.background &&
      candidate.signal.kind === 'output' &&
      candidate.signal.origin.kind === 'native' &&
      candidate.signal.origin.run.taskID === run.taskID &&
      candidate.signal.origin.run.generation === run.generation &&
      candidate.token.baselineMessageID === token.baselineMessageID &&
      candidate.token.attemptRevision === token.attemptRevision &&
      candidate.token.terminalRevision === token.terminalRevision
    ) {
      value.candidate = { signal: candidate.signal, token };
      signal = candidate.signal;
    }
    const foregroundNativeTerminal = isForegroundNativeTerminal(
      signal,
      job.background,
    );
    if (
      !foregroundNativeTerminal &&
      (runtime?.kind === 'busy' || runtime?.kind === 'retry')
    )
      return deferred(run);
    if (!foregroundNativeTerminal && (!runtime || runtime.kind === 'unknown')) {
      // Occupied readers already own an availability-driven continuation;
      // they neither consume the diagnostic budget nor need a second timer.
      if (runtime?.retryAfter) return deferred(run);
      value.retries += 1;
      return retry(
        run,
        value.retries > (options.maxEvidenceRetries ?? 3)
          ? EVIDENCE_UNAVAILABLE_DIAGNOSTIC
          : (runtime?.diagnostic ??
              'Runtime observation unavailable; task termination is unconfirmed.'),
      );
    }
    if (options.isObservationPending?.(run.taskID, run.generation))
      return retry(
        run,
        'Fallback handoff pending; task termination is unconfirmed.',
      );
    if (
      job.state !== 'running' &&
      (job.state === 'reconciled' ? job.terminalState : job.state) !==
        'completed'
    )
      return { kind: 'committed', record: job };
    if (
      signal?.kind === 'cancel' &&
      runtime?.stable === true &&
      board.validateLease(signal.lease)
    ) {
      return commit(
        token,
        'cancelled',
        signal.reason ?? 'cancelled',
        signal.lease,
      );
    }
    if (job.deadlineExceededAt !== undefined) {
      return commit(
        token,
        'error',
        'Background task exceeded its wall-clock deadline; quiescence confirmed the abort.',
      );
    }
    if (signal?.kind === 'session-error')
      return commit(token, 'error', signal.message);
    // Capability absence, not a pending read: fetchChildTranscript
    // resolves undefined ONLY when the host exposes no session.messages
    // endpoint. A host that HAS the source keeps its pending/textless
    // retry semantics — a timed-out or failed read there is transient
    // and must never masquerade as source absence.
    const transcriptSourceAbsent =
      options.input !== undefined &&
      typeof getClient(options.input)?.session?.messages !== 'function';
    const transcriptRead = await read(`transcript:${run.taskID}`, token, () =>
      options.readTerminalEvidence
        ? options.readTerminalEvidence(run.taskID)
        : options.input
          ? fetchChildTranscript(
              getClient(options.input),
              run.taskID,
              options.input.directory,
            )
          : Promise.resolve(undefined),
    );
    if (!current(token)) return { kind: 'stale' };
    if (transcriptRead.kind === 'blocked')
      return requestRuntimeContrastAfterRead(token, transcriptRead.retryAfter);
    const response = transcriptRead.value;
    if (options.isObservationPending?.(run.taskID, run.generation))
      return retry(
        run,
        'Fallback handoff pending; task termination is unconfirmed.',
      );
    let terminalOutcome = runtime?.terminalOutcome;
    let outcomeDiagnostic: string | undefined;
    let evidence = classifyTerminalEvidence(response, {
      baselineMessageID: token.baselineMessageID,
      runStartedAt: job.runStartedAt,
      terminalOutcomeConfirmed: terminalOutcome === 'succeeded',
    });
    if (
      evidence.verdict !== 'completed' &&
      evidence.verdict !== 'error' &&
      !terminalOutcome &&
      options.input
    ) {
      const client = getClient(options.input);
      const input = options.input;
      const observation = token;
      if (typeof client?.session?.get === 'function') {
        const outcomeResponse = await read(
          `outcome:${run.taskID}`,
          token,
          () => {
            log('[terminal-gate] host-outcome read initiated', {
              taskID: run.taskID,
              generation: run.generation,
              state: board.get(run.taskID)?.state,
              attribution: 'host-outcome',
              attempt: value.retries,
              readStartedAt: observation.readStartedAt,
            });
            return readSessionInfoForObservation(input, observation);
          },
        );
        if (!current(token)) return { kind: 'stale' };
        if (outcomeResponse.kind === 'blocked')
          return requestRuntimeContrastAfterRead(
            token,
            outcomeResponse.retryAfter,
          );
        if (options.isObservationPending?.(run.taskID, run.generation))
          return retry(
            run,
            'Fallback handoff pending; task termination is unconfirmed.',
          );
        terminalOutcome = outcomeFromRead(
          outcomeResponse.value,
          token,
          value.retries,
        )?.outcome;
        if (!terminalOutcome) outcomeDiagnostic = UNATTRIBUTABLE_HOST_OUTCOME;
        if (terminalOutcome === 'succeeded')
          evidence = classifyTerminalEvidence(response, {
            baselineMessageID: token.baselineMessageID,
            runStartedAt: job.runStartedAt,
            terminalOutcomeConfirmed: true,
          });
      }
    }
    if (evidence.verdict === 'completed' || evidence.verdict === 'error')
      return commit(
        token,
        evidence.verdict,
        evidence.text,
        undefined,
        'transcript',
      );
    // Native return is attributable only when no transcript exists. Foreground
    // still publishes when the transcript is pending; empty result uses a
    // placeholder instead of the original whitespace.
    if (
      response === undefined &&
      signal?.kind === 'output' &&
      signal.origin.kind === 'native' &&
      signal.status.result?.trim() &&
      signal.status.state !== 'running'
    ) {
      return commit(token, signal.status.state, signal.status.result);
    }
    if (
      foregroundNativeTerminal &&
      signal?.kind === 'output' &&
      signal.status.state !== 'running'
    ) {
      const { state, result } = signal.status;
      // A textless completion is an error, same rule as every other
      // completed publication (guardCompletedStatusText): never invent a
      // success summary for a finished run that produced no text.
      const guarded = guardCompletedStatusText(
        state,
        result,
        board.get(run.taskID)?.resultSummary,
      );
      return commit(
        token,
        guarded.state,
        guarded.resultSummary ??
          `Foreground task ended with state ${guarded.state}.`,
      );
    }
    const stable = now() - (value.quiescentSince ?? now()) >= graceMs;
    // Stop-family host outcomes are not failures: the host stopped the
    // run (user interrupt/abort) without a plugin-verified cancel
    // lease — the same stop policy as the absent-evidence branch below.
    // Surfacing them as 'error' would report a user-stopped task as a
    // false failure.
    if (terminalOutcome === 'interrupted' || terminalOutcome === 'cancelled')
      return commit(
        token,
        'stopped',
        `Host reported outcome: ${terminalOutcome}.`,
        undefined,
        'host-outcome',
      );
    if (terminalOutcome === 'failed')
      return commit(
        token,
        'error',
        'Host reported outcome: failed.',
        undefined,
        'host-outcome',
      );
    // A host that exposes no transcript source can never produce
    // transcript evidence — the 'transcript source unavailable' retry
    // verdict is a dead end, not a pending read. With the #1225 window
    // already attributing the outcome to this run, a succeeded outcome
    // publishes through the same host-outcome commit path as the error
    // family. Guards: the transcript source must be genuinely absent
    // (a present-but-unfinalized transcript keeps waiting exactly as
    // before), and only the window-attributed terminalOutcome reaches
    // here — an unattributable success publishes nothing.
    if (
      terminalOutcome === 'succeeded' &&
      transcriptSourceAbsent &&
      evidence.verdict === 'retry' &&
      evidence.reason === 'transcript source unavailable'
    )
      return commit(
        token,
        'completed',
        `Host reported outcome: ${terminalOutcome}.`,
        undefined,
        'host-outcome',
      );
    if (evidence.verdict === 'absent' && stable)
      return commit(
        token,
        'stopped',
        STOPPED_WITHOUT_TERMINAL_RESULT,
        undefined,
        'transcript',
      );
    value.retries += 1;
    if (
      terminalOutcome === 'succeeded' &&
      stable &&
      evidence.verdict === 'retry' &&
      evidence.reason === 'textless' &&
      value.retries > (options.maxEvidenceRetries ?? 3)
    )
      return commit(
        token,
        'error',
        COMPLETED_WITHOUT_TEXT_DIAGNOSTIC,
        undefined,
        'host-outcome',
      );
    // A parsed completed label is not independent termination evidence.
    // Even an empty assistant placeholder remains unknown indefinitely.
    return retry(
      run,
      value.retries > (options.maxEvidenceRetries ?? 3)
        ? EVIDENCE_UNAVAILABLE_DIAGNOSTIC
        : (outcomeDiagnostic ??
            (evidence.verdict === 'retry' && evidence.reason === 'textless'
              ? COMPLETED_WITHOUT_TEXT_DIAGNOSTIC
              : 'Runtime session is idle; task termination is unconfirmed.')),
    );
  }

  function reconcile(
    run: RunRef,
    signal: TerminalSignal = { kind: 'inspect' },
  ): Promise<GateResult> {
    const token = capture(run);
    if (!token) return Promise.resolve({ kind: 'stale' });
    const value = observation(run);
    if (!value) return Promise.resolve({ kind: 'stale' });
    if (signal.kind !== 'inspect') {
      const origin = signal.kind === 'output' ? signal.origin.run : run;
      if (
        origin?.taskID === run.taskID &&
        origin.generation === run.generation
      ) {
        value.retries = 0;
        value.candidate = { signal, token };
        if (signal.kind === 'output' && signal.status.state === 'running')
          board.updateStatus({
            taskID: run.taskID,
            state: 'running',
            expectedGeneration: run.generation,
            timedOut: signal.status.timedOut,
          });
      }
    }
    const key = JSON.stringify([run.taskID, observationIdentity(token)]);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const pending = inspect(run).finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    });
    inFlight.set(key, pending);
    return pending;
  }

  const gate: BackgroundJobTerminalGate = {
    capture,
    observe,
    reconcile,
    dispose() {
      disposed = true;
      authorizedByGate.delete(gate);
      for (const value of observations.values())
        if (value.timer) clearTimeout(value.timer);
      observations.clear();
      inFlight.clear();
    },
  };
  authorizedByGate.set(gate, authorizations);
  board.bindTerminalGate(gate);
  return gate;
}
