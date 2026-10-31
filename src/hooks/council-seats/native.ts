/**
 * Native seat resolver: resolves `Seats:` refs straight from the host's
 * session domain — no board, no ledger, no lifecycle. This is what makes
 * council work with native OpenCode v2 delegation and the managed
 * lifecycle OFF.
 *
 * Only exact `ses_` child IDs resolve; any other ref is missing. One
 * bounded deadline covers the whole call; there is no retry, no polling,
 * and no transcript persistence.
 *
 * The child transcript is the attribution source: the seat body is read
 * from the trailing round AFTER the child's latest input boundary, so a
 * seat that was dispatched or resumed later can only ever surface the
 * answer to that latest prompt — text from an earlier round is never
 * replayed. A child still working on that prompt is `running`.
 *
 * Synthesis-time cutoff: the resolver stamps `synthesisStartedAt`
 * synchronously, before its first await, and every transcript input
 * boundary is compared against that stamp. A seat prompt whose input
 * boundary lands at or after the stamp is `ambiguous` — its answer
 * belongs to a dispatch the synthesis never observed, so the seat fails
 * closed rather than attributing newer text to an older ref.
 *
 * Cross-parent verification is load-bearing: a child whose `parentID`
 * does not match the caller is missing, never resolved — another
 * parent's seat text must never leak into this synthesis.
 */
import type { PluginInput } from '@opencode-ai/plugin';

import {
  attributeHostRoundToTranscript,
  classifyTerminalEvidence,
  fetchChildTranscript,
  latestInputAtOf,
  terminalTextOf,
} from '../../utils/child-transcript';
import { SESSION_ID_PATTERN } from '../../utils/session';
import { raceEvidenceDeadline } from '../../utils/session-info-read';
import {
  composeHostRound,
  hostRoundStateOf,
} from '../../utils/session-runtime-status';
import { SEAT_REASONS } from './assemble';
import type { SeatResult, SeatResultResolver } from './types';

/** Whole-call budget (parent read + every per-seat read). */
const DEFAULT_NATIVE_SEAT_TIMEOUT_MS = 5_000;

/** Scheduler seam, matching `raceEvidenceDeadline`'s timer contract. */
export interface NativeSeatTimers {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface NativeSeatResolverOptions {
  /** Total budget for one resolver call. Default 5 s. */
  timeoutMs?: number;
  /** Clock for the whole-call deadline (tests inject the timer harness). */
  now?: () => number;
  /** Scheduler seam for bounded reads (tests inject the timer harness). */
  timers?: NativeSeatTimers;
}

type SessionGet = (args: {
  path: { id: string };
  query?: { directory?: string };
}) => Promise<unknown>;

/** A read that yields undefined on budget exhaustion, transport failure,
 *  or host error payload — absence of evidence, never a throw. */
function boundedRead<T>(
  read: () => Promise<T>,
  remaining: () => number,
  timers?: NativeSeatTimers,
): Promise<T | undefined> {
  const left = remaining();
  if (left <= 0) return Promise.resolve(undefined);
  // Defer the invocation into the promise chain: a host method that throws
  // synchronously degrades to absence of evidence instead of rejecting
  // the whole resolver call.
  return raceEvidenceDeadline(Promise.resolve().then(read), left, timers);
}

function missing(reason: string): SeatResult {
  return { kind: 'missing', reason };
}

function ambiguous(reason: string, label?: string): SeatResult {
  return { kind: 'ambiguous', reason, ...(label ? { label } : {}) };
}

/** Host session info, or undefined when unreadable/unavailable. */
async function readHostInfo(
  session: unknown,
  get: SessionGet | undefined,
  sessionID: string,
  directory: string | undefined,
  remaining: () => number,
  timers?: NativeSeatTimers,
): Promise<Record<string, unknown> | undefined> {
  if (!get) return undefined;
  const response = await boundedRead(
    // SDK-generated session methods read `this._client`: invoke on the
    // session receiver the method was read from.
    () => get.call(session, { path: { id: sessionID }, query: { directory } }),
    remaining,
    timers,
  );
  if (!response || (response as { error?: unknown }).error) return undefined;
  const data = (response as { data?: unknown }).data;
  return typeof data === 'object' && data !== null
    ? (data as Record<string, unknown>)
    : undefined;
}

export function createNativeSeatResolver(
  input: PluginInput,
  options: NativeSeatResolverOptions = {},
): SeatResultResolver {
  const budget = options.timeoutMs ?? DEFAULT_NATIVE_SEAT_TIMEOUT_MS;
  const clock = options.now ?? Date.now;
  const v2 =
    (input as PluginInput & { hostFlavor?: string }).hostFlavor === 'v2';
  const directory = input.directory;

  return async (parentSessionID, seats) => {
    const synthesisStartedAt = clock();
    const deadline = synthesisStartedAt + budget;
    const remaining = () => Math.max(0, deadline - clock());
    const client = input.client;

    const session = client?.session;
    const get = session?.get as SessionGet | undefined;

    return Promise.all(
      seats.map(async (seat) => {
        const childID = seat.childID;
        if (typeof childID !== 'string' || !SESSION_ID_PATTERN.test(childID)) {
          return missing('unresolved ref');
        }
        const info = await readHostInfo(
          session,
          get,
          childID,
          directory,
          remaining,
          options.timers,
        );
        if (info === undefined) {
          return ambiguous('session unreadable');
        }
        const parentID = typeof info.parentID === 'string' ? info.parentID : '';
        if (!parentID) return ambiguous('session has no parent');
        // Never leak another parent's seat content.
        if (parentID !== parentSessionID) {
          return missing('session belongs to another parent');
        }
        const agent =
          typeof info.agent === 'string' ? info.agent.trim() : undefined;
        const label = agent || undefined;
        // When the seat carries a display label distinct from the child ID,
        // the host's agent must agree with it.
        if (agent && seat.seat !== childID && agent !== seat.seat) {
          return ambiguous('agent does not match the seat label', label);
        }

        const transcript = await boundedRead(
          () => fetchChildTranscript(client, childID, directory),
          remaining,
          options.timers,
        );
        if (transcript === undefined) {
          return ambiguous('transcript unreadable', label);
        }
        const childInputAt = latestInputAtOf(transcript);
        if (childInputAt === undefined) {
          return ambiguous('seat prompt boundary unknown', label);
        }
        // Synthesis-time cutoff: a seat prompt at/after this stamp is work
        // the synthesis call never observed — fail closed rather than
        // attributing a newer answer to the older seat ref.
        if (childInputAt >= synthesisStartedAt) {
          return ambiguous(
            'seat prompt is newer than the synthesis call',
            label,
          );
        }

        if (v2) {
          const state = attributeHostRoundToTranscript(
            hostRoundStateOf(info),
            transcript,
          );
          const round = composeHostRound(state, childInputAt);
          if (round.verdict === 'unreadable') {
            return ambiguous(round.reason ?? 'host state unreadable', label);
          }
          if (round.verdict === 'incomplete') {
            return {
              kind: 'running',
              reason: SEAT_REASONS.running,
              ...(label ? { label } : {}),
            };
          }
          if (round.verdict === 'error' || round.verdict === 'interrupted') {
            return {
              kind: 'error',
              reason: SEAT_REASONS.error,
              ...(label ? { label } : {}),
            };
          }
          const text = terminalTextOf(transcript);
          return text && text.trim() !== ''
            ? { kind: 'completed', text, ...(label ? { label } : {}) }
            : {
                kind: 'empty',
                reason: SEAT_REASONS.empty,
                ...(label ? { label } : {}),
              };
        }

        const verdict = classifyTerminalEvidence(transcript);
        switch (verdict.verdict) {
          case 'completed': {
            const text = verdict.text?.trim() ?? '';
            return text !== ''
              ? { kind: 'completed', text, ...(label ? { label } : {}) }
              : {
                  kind: 'empty',
                  reason: SEAT_REASONS.empty,
                  ...(label ? { label } : {}),
                };
          }
          case 'error':
            return {
              kind: 'error',
              reason: SEAT_REASONS.error,
              ...(label ? { label } : {}),
            };
          case 'retry':
            // `textless` is a finished turn without an answer; every other
            // retry reason is a still-open round.
            return verdict.reason === 'textless'
              ? {
                  kind: 'empty',
                  reason: SEAT_REASONS.empty,
                  ...(label ? { label } : {}),
                }
              : {
                  kind: 'running',
                  reason: SEAT_REASONS.running,
                  ...(label ? { label } : {}),
                };
          case 'absent':
            return {
              kind: 'running',
              reason: SEAT_REASONS.running,
              ...(label ? { label } : {}),
            };
        }
      }),
    );
  };
}
