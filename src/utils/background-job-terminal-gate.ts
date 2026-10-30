import type { PluginInput } from '@opencode-ai/plugin';
import type {
  BackgroundJobBoard,
  BackgroundJobLease,
  BackgroundJobRecord,
  BackgroundJobTerminalInput,
} from './background-job-board';
import {
  classifyTerminalEvidence,
  fetchChildTranscript,
  responseError,
} from './child-transcript';
import { isRecord } from './guards';
import { log } from './logger';
import { getClient } from './opencode-client';
import {
  pendingForeignRead,
  raceEvidenceDeadline,
  readHostSessionInfo,
} from './session-info-read';
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
/** Slow-tier base delay for the bounded evidence re-arm (see
 * `scheduleEvidenceRearm`). Internal seam: no user-facing config. */
export const DEFAULT_EVIDENCE_REARM_MS = 30_000;
/** Cap on the slow tier's exponential backoff. */
export const REARM_CAP_MS = 300_000;
/** How many slow re-arms one observation episode may arm. */
export const DEFAULT_MAX_EVIDENCE_REARMS = 12;
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
    promptMessageID: string | undefined;
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
  | { kind: 'cancel'; lease: BackgroundJobLease; reason?: string };
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

/** Platform timer handle; fake harnesses may return bare numeric ids. */
type TimerHandle = Timer;

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
  quiescentSince?: number;
  candidate?: { signal: TerminalSignal; token: ObservationToken };
  /**
   * Last idle delivery seen, kept solely so `idleContradictsBusy` can decide
   * whether a busy runtime observation was contradicted by a later idle
   * (#1561). Upstream `478251a0` deleted this field as write-only dead state;
   * this consumer is what makes it live again — do not delete it without
   * replacing the predicate.
   */
  idleCandidate?: RuntimeObservation;
  retries: number;
  /** Slow-tier arms used in this episode (#1561). Resets only on genuine
   * live activity, never on idle redelivery. */
  rearms: number;
  /**
   * Set once the first exhaustion of the CURRENT recovery budget has been
   * logged. Keyed to the budget's lifetime, not to `episode`: the unknown
   * branch bumps `episode` on every failed read, so an episode-keyed guard
   * would re-log on each slow read — exactly the case it must bound. Reset
   * only where the budgets reset (live activity / new Observation).
   */
  gaveUpLogged?: boolean;
  /** Same lifetime rule, for the final-give-up line. */
  rearmExhaustedLogged?: boolean;
  timer?: TimerHandle;
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

/**
 * Does a held idle candidate contradict a busy runtime observation? (#1561)
 *
 * A busy runtime observation usually means the child is genuinely executing,
 * and a rejected outcome read then is normal — polling it would be
 * busy-spinning. But when the host has since delivered an idle that is
 * provably *later* than the busy observation, the host proved termination
 * after it: that busy is stale, and the defer is suspicious rather than
 * healthy.
 *
 * Conservative by construction: uncomparable timestamps are NOT a
 * contradiction. An uncomparable busy stays authoritative, which preserves
 * the double-idle invariant's redelivery safety.
 */
export function idleContradictsBusy(
  idleCandidate: RuntimeObservation | undefined,
  runtime: RuntimeObservation | undefined,
): boolean {
  const idleAt = idleCandidate?.observedAt;
  const busyAt = runtime?.observedAt;
  if (!validHostTime(idleAt) || !validHostTime(busyAt)) return false;
  if (idleAt > busyAt) return true;
  // `activityAt` comes from `event.created` at millisecond resolution, so a
  // sub-millisecond execution can share the busy timestamp. Fall back to
  // delivery order: any surviving candidate was delivered after the busy
  // observation, because the busy branch of `observe()` clears it.
  return (
    idleAt === busyAt &&
    (idleCandidate?.readStartedAt ?? -1) >= (runtime?.readStartedAt ?? Infinity)
  );
}

/** Host terminal-outcome literals the gate treats as attributable
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

function hostTerminalOutcome(info: Record<string, unknown>): unknown {
  return info.idleOutcome ?? info.idle_outcome ?? info.outcome;
}

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
  const outcome = hostTerminalOutcome(info);
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
  const outcome = hostTerminalOutcome(info);
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

/** Log-only corroboration helper: maps a window-attributed host outcome to
 * the terminal state the host-outcome commit policy would publish from it
 * (interrupted/cancelled → stopped, failed → error, succeeded → completed). */
function hostOutcomeImpliedState(outcome: string): string {
  if (outcome === 'succeeded') return 'completed';
  if (outcome === 'failed') return 'error';
  return 'stopped';
}

/** Stop-family normalization for the corroboration compare: a verified
 * cancel lease publishes 'cancelled' where a host outcome would imply
 * 'stopped' — same stop family, must not log as a divergence. */
function terminalStateFamily(state: string): 'completed' | 'error' | 'stopped' {
  if (state === 'completed') return 'completed';
  if (state === 'error') return 'error';
  return 'stopped';
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

/** Share the raw, still-open host read with the rehydration existence probe.
 * A consumer deadline must not release this slot or authorize a new read. */
export function readSessionInfoForObservation(
  input: PluginInput,
  token: ObservationToken,
): Promise<unknown> {
  return readHostSessionInfo(input, {
    taskID: token.taskID,
    identity: observationIdentity(token),
  });
}

export function createBackgroundJobTerminalGate(options: {
  backgroundJobBoard: BackgroundJobBoard;
  input?: PluginInput;
  readRuntime?: (run: RunRef, startedAt: number) => Promise<RuntimeObservation>;
  readTerminalEvidence?: (
    taskID: string,
    historyBoundary?: string,
  ) => Promise<unknown>;
  baselineFor?: (taskID: string, generation: number) => string | undefined;
  promptMessageIDFor?: (
    taskID: string,
    generation: number,
  ) => string | undefined;
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
  /**
   * Final give-up only: the gate can never establish a terminal outcome for
   * this task (no evidence source left to poll). The task stays `running` on
   * the board, so anything it holds must be released here — otherwise a host
   * that cannot read terminal evidence leaks one resource per such task.
   */
  onGiveUp?: (taskID: string, generation: number) => void;
  graceMs?: number;
  readTimeoutMs?: number;
  maxEvidenceRetries?: number;
  /** Slow-tier base delay for the bounded evidence re-arm (#1561). */
  evidenceRearmMs?: number;
  /** Slow-tier arm budget per observation episode (#1561). */
  maxEvidenceRearms?: number;
  now?: () => number;
  /** Test seam: defaults to the platform timers. */
  setTimeout?: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
}): BackgroundJobTerminalGate {
  const board = options.backgroundJobBoard;
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
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
      if (value?.timer) clearTimer(value.timer);
      value = {
        generation: run.generation,
        activityRevision: record.activityRevision,
        episode: 0,
        retries: 0,
        rearms: 0,
      };
      observations.set(run.taskID, value);
    }
    if (value.activityRevision !== record.activityRevision) {
      if (value.timer) clearTimer(value.timer);
      value = {
        generation: run.generation,
        activityRevision: record.activityRevision,
        episode: value.episode + 1,
        retries: 0,
        rearms: 0,
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
      promptMessageID: options.promptMessageIDFor?.(run.taskID, run.generation),
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
      options.promptMessageIDFor?.(token.taskID, token.generation) ===
        token.promptMessageID &&
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

  /**
   * Arm the slow-tier evidence re-arm for one observation episode (#1561).
   *
   * The fast tier (this file's `retry()`) only arms while the evidence budget
   * lasts. Once it is exhausted the gate used to stop reading forever, and a
   * host outcome that became attributable afterwards stranded the board entry
   * at `running`. This timer is the bounded continuation.
   *
   * Returns why no arm was scheduled, so the caller can distinguish "recovery
   * is still on its way" (a timer is already pending) from "the budget is
   * genuinely spent" — logging them the same way would report a final
   * give-up while a re-arm is still scheduled, and would burn the
   * once-per-budget log flag on it.
   */
  type RearmRefusal =
    | 'armed'
    | 'timer-pending'
    | 'no-polling-capability'
    | 'no-evidence-source'
    | 'not-running'
    | 'budget-exhausted';

  function scheduleEvidenceRearm(run: RunRef): RearmRefusal {
    const value = observation(run);
    if (!value) return 'not-running';
    const client = options.input ? getClient(options.input) : undefined;
    // Guard 1: a host that exposes `session.status` already has a poller.
    // `createRuntimeStatusReconciler` re-passes every delayMs while
    // `board.hasRunningJobs()` and reconciles each running record, so it
    // retries this read forever on its own. Arming a second scheduler would
    // give one fact two owners; the reconciler wins because it also covers
    // every other running record in one batched read.
    if (typeof client?.session?.status === 'function')
      return 'no-polling-capability';
    // Guard 2: no readable evidence source means no read can ever improve the
    // verdict — arming would burn timers for nothing.
    const hasEvidenceSource =
      options.readRuntime !== undefined ||
      typeof client?.session?.get === 'function' ||
      typeof client?.session?.messages === 'function';
    if (!hasEvidenceSource) return 'no-evidence-source';
    // Guard 3: a terminal record needs no evidence.
    if (board.get(run.taskID)?.state !== 'running') return 'not-running';
    // Guard 4: one timer slot per observation. A pending timer means recovery
    // is ALREADY scheduled — not that the budget is spent.
    if (value.timer) return 'timer-pending';
    // Guard 5: bounded.
    const max = options.maxEvidenceRearms ?? DEFAULT_MAX_EVIDENCE_REARMS;
    if (value.rearms >= max) return 'budget-exhausted';
    const base = options.evidenceRearmMs ?? DEFAULT_EVIDENCE_REARM_MS;
    const delay = Math.min(base * 2 ** value.rearms, REARM_CAP_MS);
    value.rearms += 1;
    value.timer = setTimer(
      () => {
        value.timer = undefined;
        if (observation(run) !== value) return;
        // Background reconciliation is fail-soft: a failure must be logged and
        // swallowed, never escape as an unhandled rejection.
        void reconcile(run).catch((err) => {
          log('[terminal-gate] evidence re-arm reconcile failed', String(err));
        });
      },
      Math.max(1, delay),
    );
    value.timer.unref?.();
    return 'armed';
  }

  function retry(run: RunRef, diagnostic?: string): GateResult {
    const value = observation(run);
    if (!value) return { kind: 'stale' };
    if (
      !value.timer &&
      value.retries <= (options.maxEvidenceRetries ?? 3) &&
      board.get(run.taskID)?.state === 'running'
    ) {
      value.timer = setTimer(
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
      // Give-up branch: the fast evidence budget is exhausted. Hand the
      // episode to the bounded slow tier; only when that refuses is this
      // final. Both logs are episode-scoped because re-arms re-enter here.
      const refusal = scheduleEvidenceRearm(run);
      const armed = refusal === 'armed';
      const maxEvidenceRearms =
        options.maxEvidenceRearms ?? DEFAULT_MAX_EVIDENCE_REARMS;
      // Guards are keyed to the recovery budget's lifetime, not to `episode`:
      // the unknown-runtime branch bumps `episode` on every failed read, so an
      // episode-keyed guard would re-log on each slow read of the same budget.
      if (!value.gaveUpLogged) {
        value.gaveUpLogged = true;
        log('[terminal-gate] terminal evidence unavailable', {
          taskID: run.taskID,
          generation: run.generation,
          state: board.get(run.taskID)?.state,
          attempt: value.retries,
          verdict: 'gave-up',
          reason: diagnostic,
          rearm: { armed, rearms: value.rearms, maxEvidenceRearms },
        });
      }
      // The final give-up is a distinct event, so it gets its own guard rather
      // than an `else` branch. Only a spent budget (or a host that can never
      // read evidence again) is final: `timer-pending` means recovery is still
      // scheduled, and reporting it as exhausted would be a lie — and would
      // consume the guard that the real final give-up needs.
      const final =
        refusal === 'budget-exhausted' ||
        refusal === 'no-evidence-source' ||
        refusal === 'no-polling-capability' ||
        refusal === 'not-running';
      if (final && !value.rearmExhaustedLogged) {
        value.rearmExhaustedLogged = true;
        log('[terminal-gate] terminal evidence rearm exhausted', {
          taskID: run.taskID,
          generation: run.generation,
          state: board.get(run.taskID)?.state,
          attempt: value.retries,
          rearms: value.rearms,
          maxEvidenceRearms,
          verdict: 'gave-up',
          reason: refusal,
        });
        // A host that exposes `session.status` still owns the read: its
        // reconciler keeps polling, and the terminal publication releases the
        // slot once the task is actually terminal. Releasing
        // here would admit a queued child while this one is still working.
        if (refusal !== 'no-polling-capability')
          options.onGiveUp?.(run.taskID, run.generation);
      }
    }
    return deferred(run, diagnostic);
  }

  function commit(
    token: ObservationToken,
    state: 'completed' | 'error' | 'cancelled' | 'stopped',
    text: string,
    lease?: BackgroundJobLease,
    attribution: TerminalAttribution = 'event',
    hostOutcomeRead?: string,
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
        (state === 'cancelled' ||
          value.runtime?.kind === 'deleted' ||
          !options.isObservationPending?.(token.taskID, token.generation)) &&
        (value.runtime?.kind === 'quiescent' ||
          value.runtime?.kind === 'deleted' ||
          (token.promptMessageID !== undefined &&
            attribution === 'transcript') ||
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
    if (value.timer) clearTimer(value.timer);
    value.timer = undefined;
    value.candidate = undefined;
    // Log-only corroboration: when a window-attributed host outcome is in
    // hand for this episode, compare it with the state being published and
    // log bounded-evidence disagreements. Same contract as
    // hostOutcomeRejectionReason: never gates behavior — promoting this to
    // a decision signal requires a fresh multi-agent review. No config, no
    // state: a publication happens at most once per (taskID, generation),
    // so the log is naturally bounded. The comparand prefers the caller-
    // passed read (the episode's freshest window-attributed outcome, for
    // commits whose runtime observation predates it) over the stale runtime
    // copy. Known divergence source: host-side outcome staleness across
    // runs (idle_outcome has no clear point —
    // docs/opencode-v2-compatibility.md); stop-family normalization keeps
    // verified-cancel publications out of the log.
    const hostOutcome =
      hostOutcomeRead ??
      (typeof value.runtime?.terminalOutcome === 'string'
        ? value.runtime.terminalOutcome
        : undefined);
    if (
      hostOutcome !== undefined &&
      terminalStateFamily(state) !==
        terminalStateFamily(hostOutcomeImpliedState(hostOutcome))
    )
      log('[terminal-gate] outcome corroboration', {
        taskID: token.taskID,
        alias: record.alias,
        generation: token.generation,
        published: state,
        attribution,
        hostOutcome,
        hostImpliedState: hostOutcomeImpliedState(hostOutcome),
      });
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
    // Session activity after this input's answer belongs to another turn.
    // It must not reopen this completed input and publish its answer twice.
    if (token.promptMessageID && before.state !== 'running')
      return deferred(token);
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
      if (value.timer) clearTimer(value.timer);
      value.timer = undefined;
      return deferred(token);
    }
    if (predatesPublication) return { kind: 'stale' };
    if (runtime.origin === 'session.idle') {
      // Hold the idle so a stale busy runtime can be recognised as
      // contradicted (#1561). Only a *new* idle restarts the fast budget: a
      // host that replays the double-idle pair (both members share one
      // `activityAt`) would otherwise keep the budget forever, turning the
      // fast tier into a `graceMs`-cadence poll loop. `rearms` never resets
      // here — an idle-happy host must not buy an unbounded slow tier.
      const isNewIdle =
        runtime.observedAt === undefined ||
        runtime.observedAt !== value.idleCandidate?.observedAt;
      value.idleCandidate = runtime;
      value.pendingRuntime = false;
      if (isNewIdle) value.retries = 0;
      return deferred(token);
    }
    value.pendingRuntime =
      runtime.origin === 'session.status' ||
      runtime.origin === 'cancel-verifier';
    if (runtime.kind === 'busy' || runtime.kind === 'retry') {
      value.episode += 1;
      value.quiescentSince = undefined;
      value.retries = 0;
      // Genuine live activity starts a fresh slow-tier budget too, and with it
      // a fresh log budget — otherwise the first exhaustion of the new run
      // would stay silent, hiding the diagnosis for the new attempt.
      value.rearms = 0;
      value.gaveUpLogged = false;
      value.rearmExhaustedLogged = false;
      value.candidate = undefined;
      value.idleCandidate = undefined;
      if (value.timer) clearTimer(value.timer);
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
      if (value.timer) clearTimer(value.timer);
      value.timer = undefined;
      return deferred(
        token,
        runtime.diagnostic ??
          'Runtime observation unavailable; task termination is unconfirmed.',
      );
    }
    value.quiescentSince ??= now();
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
      // Outcome reads go through the cross-component registry: a plain
      // probe may occupy the raw read under a different identity. Defer
      // before the deadline race — the registry serializes and re-issues
      // under our identity once the occupant settles, so no attempt is
      // burned on a chained wait (greptile P1 4339476556).
      if (key.startsWith('outcome:') && options.input) {
        const wait = pendingForeignRead(options.input, {
          taskID: token.taskID,
          identity,
        });
        if (wait) return { kind: 'blocked', retryAfter: wait };
      }
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
      value: await raceEvidenceDeadline(entry.underlying, timeoutMs, {
        setTimeout: setTimer,
        clearTimeout: clearTimer,
      }),
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

  // Queued input can coexist with the old execution's idle/error events and
  // outcome. A completed answer after this exact input proves its completion
  // even on hosts without activity APIs; it does not claim session-wide idle.
  async function inspectQueuedAnswer(
    token: ObservationToken,
  ): Promise<GateResult> {
    const transcriptRead = await read(
      `transcript:${token.taskID}`,
      token,
      () =>
        options.readTerminalEvidence
          ? options.readTerminalEvidence(token.taskID, token.promptMessageID)
          : options.input
            ? fetchChildTranscript(
                getClient(options.input),
                token.taskID,
                options.input.directory,
                undefined,
                undefined,
                token.promptMessageID,
              )
            : Promise.resolve(undefined),
    );
    if (!current(token)) return { kind: 'stale' };
    if (transcriptRead.kind === 'blocked')
      return requestRuntimeContrastAfterRead(token, transcriptRead.retryAfter);
    const evidence = classifyTerminalEvidence(transcriptRead.value, {
      promptMessageID: token.promptMessageID,
    });
    if (evidence.verdict !== 'completed' && evidence.verdict !== 'error')
      return retry(
        token,
        'Queued continuation has no attributable terminal answer yet.',
      );
    return commit(
      token,
      evidence.verdict,
      evidence.text,
      undefined,
      'transcript',
    );
  }

  async function inspect(run: RunRef): Promise<GateResult> {
    let token = capture(run);
    if (!token) return { kind: 'stale' };
    const value = observation(run);
    if (!value) return { kind: 'stale' };
    const cancellation = value.candidate?.signal.kind === 'cancel';
    const fenced = () =>
      !cancellation &&
      options.isObservationPending?.(run.taskID, run.generation);
    if (token.promptMessageID && !cancellation) {
      return inspectQueuedAnswer(token);
    }
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
    ) {
      // A busy runtime normally means the child is still executing and a
      // rejected outcome read is expected — polling that is busy-spinning, so
      // a healthy busy keeps returning a bare defer with no timer.
      //
      // But when a later idle contradicts the busy (the host proved
      // termination after it), the defer is suspicious and must arm a read.
      // Fast tier only: a bare `retry()` schedules the `graceMs` timer WITHOUT
      // marking the record uncertain, so the common short-lag case resolves
      // in seconds with no user-visible state change. Past the budget this
      // flows into the give-up branch, which hands off to the slow tier.
      if (idleContradictsBusy(value.idleCandidate, runtime)) {
        value.retries += 1;
        return value.retries > (options.maxEvidenceRetries ?? 3)
          ? retry(run, EVIDENCE_UNAVAILABLE_DIAGNOSTIC)
          : retry(run);
      }
      return deferred(run);
    }
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
    if (fenced()) return retry(run);
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
        ? options.readTerminalEvidence(run.taskID, token.baselineMessageID)
        : options.input
          ? fetchChildTranscript(
              getClient(options.input),
              run.taskID,
              options.input.directory,
              undefined,
              undefined,
              token.baselineMessageID,
            )
          : Promise.resolve(undefined),
    );
    if (!current(token)) return { kind: 'stale' };
    if (transcriptRead.kind === 'blocked')
      return requestRuntimeContrastAfterRead(token, transcriptRead.retryAfter);
    const response = transcriptRead.value;
    if (fenced()) return retry(run);
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
        if (fenced()) return retry(run);
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
        terminalOutcome,
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
      return commit(
        token,
        signal.status.state,
        signal.status.result,
        undefined,
        'event',
        terminalOutcome,
      );
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
        undefined,
        'event',
        terminalOutcome,
      );
    }
    const stable =
      now() -
        Math.max(value.quiescentSince ?? now(), token.attemptStartedAt ?? 0) >=
      graceMs;
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
    const retained = board.get(run.taskID);
    // A restored round stands in for live status only until an event makes
    // later activity ambiguous (episode bump); then the live read decides.
    if (
      retained?.verifiedRetainedRound === true &&
      retained.generation === run.generation &&
      retained.state !== 'running' &&
      observation(run)?.episode === 0
    ) {
      return Promise.resolve({ kind: 'committed', record: retained });
    }
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
        if (value.timer) clearTimer(value.timer);
      observations.clear();
      inFlight.clear();
    },
  };
  authorizedByGate.set(gate, authorizations);
  board.bindTerminalGate(gate);
  return gate;
}
