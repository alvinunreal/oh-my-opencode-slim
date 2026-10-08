/** Host-capability ladder for the terminal gate: the named adapters that
 * read termination evidence from the OpenCode host, one rung per source.
 * - Runtime status: `session.status` (bounded snapshot → RuntimeObservation)
 * - Host outcome: `session.get` (shared in-flight read + window attribution)
 * - Transcript evidence: `session.messages` via fetchChildTranscript
 * The readRuntime/readTerminalEvidence injection seams stay in the gate's
 * options; these adapters are exactly the host fallbacks behind them. */
import type { PluginInput } from '@opencode-ai/plugin';
import { fetchChildTranscript, responseError } from '../utils/child-transcript';
import { isRecord } from '../utils/guards';
import { getClient } from '../utils/opencode-client';
import {
  getRuntimeSessionStatusSnapshot,
  type RuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../utils/session-runtime-status';
import type { ObservationToken, RuntimeObservation } from './terminal-gate';

// ── Runtime status rung (session.status) ────────────────────────────

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

/** Named session.status fallback behind the gate's readRuntime seam. */
export async function hostRuntimeStatus(
  input: PluginInput,
  taskID: string,
  readStartedAt: number,
): Promise<RuntimeObservation> {
  return runtimeObservationFromSnapshot(
    await getRuntimeSessionStatusSnapshot(input),
    taskID,
    readStartedAt,
  );
}

/** Capability probes: the gate never infers capabilities from host
 * flavor, only from the presence of the SDK endpoint function. */
export function hasRuntimeStatus(input: PluginInput): boolean {
  return typeof getClient(input)?.session?.status === 'function';
}

export function hasSessionInfo(input: PluginInput): boolean {
  return typeof getClient(input)?.session?.get === 'function';
}

// ── Host outcome rung (session.get) ─────────────────────────────────

export function observationIdentity(token: ObservationToken): string {
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

export function validHostTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hostTerminalOutcome(info: Record<string, unknown>): unknown {
  return info.idleOutcome ?? info.idle_outcome ?? info.outcome;
}

export function attributableHostOutcome(
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
export function hostOutcomeRejectionReason(
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

// ── Transcript evidence rung (session.messages) ─────────────────────

/** Named transcript fallback behind the gate's readTerminalEvidence
 * seam. Capability absence, not a pending read: resolves undefined
 * ONLY when the host exposes no session.messages endpoint. */
export function readTranscriptEvidence(
  readers: {
    readTerminalEvidence?: (taskID: string) => Promise<unknown>;
    input?: PluginInput;
  },
  taskID: string,
): Promise<unknown> {
  return readers.readTerminalEvidence
    ? readers.readTerminalEvidence(taskID)
    : readers.input
      ? fetchChildTranscript(
          getClient(readers.input),
          taskID,
          readers.input.directory,
        )
      : Promise.resolve(undefined);
}

export function transcriptSourceAbsent(
  input: PluginInput | undefined,
): boolean {
  return (
    input !== undefined &&
    typeof getClient(input)?.session?.messages !== 'function'
  );
}
