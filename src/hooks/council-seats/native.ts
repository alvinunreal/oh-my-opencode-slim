import type { PluginInput } from '@opencode-ai/plugin';
import {
  attributeHostRoundToTranscript,
  fetchChildTranscript,
  latestInputAtOf,
  terminalTextOf,
} from '../../utils/child-transcript';
import { isRecord } from '../../utils/guards';
import { SESSION_ID_PATTERN } from '../../utils/session';
import { raceEvidenceDeadline } from '../../utils/session-info-read';
import {
  composeHostRound,
  hostRoundStateOf,
} from '../../utils/session-runtime-status';
import type { TimerSeam } from '../../utils/timer-seam';

const DEFAULT_SEAT_TIMEOUT_MS = 5_000;

export interface SeatReadOptions {
  timeoutMs?: number;
  now?: () => number;
  timers?: TimerSeam;
}

export type SeatEvidence =
  | { text: string; label?: string }
  | { reason: string; label?: string };

function boundedRead<T>(
  read: () => Promise<T>,
  remaining: () => number,
  timers?: TimerSeam,
): Promise<T | undefined> {
  const left = remaining();
  if (left <= 0) return Promise.resolve(undefined);
  // Defer the host invocation so synchronous throws also yield no evidence.
  return raceEvidenceDeadline(Promise.resolve().then(read), left, timers);
}

/** One result per ref, in order. All reads share the synthesis deadline. */
export async function readNativeSeats(
  input: PluginInput,
  parentSessionID: string,
  refs: readonly string[],
  options: SeatReadOptions = {},
): Promise<SeatEvidence[]> {
  const { timers } = options;
  const now = options.now ?? Date.now;
  const synthesisStartedAt = now();
  const deadline =
    synthesisStartedAt + (options.timeoutMs ?? DEFAULT_SEAT_TIMEOUT_MS);
  const remaining = () => Math.max(0, deadline - now());
  const { client, directory } = input;
  const session = client?.session;
  const get = session?.get;

  return Promise.all(
    refs.map(async (childID): Promise<SeatEvidence> => {
      if (!SESSION_ID_PATTERN.test(childID))
        return { reason: 'unresolved ref' };
      if (typeof get !== 'function') return { reason: 'session unreadable' };
      const response = await boundedRead<unknown>(
        // SDK methods depend on their session receiver.
        () =>
          get.call(session, { path: { id: childID }, query: { directory } }),
        remaining,
        timers,
      );
      if (!isRecord(response) || response.error || !isRecord(response.data))
        return { reason: 'session unreadable' };
      const info = response.data;
      const parentID = typeof info.parentID === 'string' ? info.parentID : '';
      if (!parentID) return { reason: 'session has no parent' };
      // Verify the parent before reading any transcript or using its label.
      if (parentID !== parentSessionID)
        return { reason: 'session belongs to another parent' };
      const label =
        typeof info.agent === 'string'
          ? info.agent.trim() || undefined
          : undefined;

      const transcript = await boundedRead(
        () => fetchChildTranscript(client, childID, directory),
        remaining,
        timers,
      );
      if (transcript === undefined)
        return { reason: 'transcript unreadable', label };
      const childInputAt = latestInputAtOf(transcript);
      if (childInputAt === undefined)
        return { reason: 'seat prompt boundary unknown', label };
      // This synthesis cannot attribute a round opened at or after its start.
      if (childInputAt >= synthesisStartedAt)
        return {
          reason: 'seat prompt is newer than the synthesis call',
          label,
        };

      const state = attributeHostRoundToTranscript(
        hostRoundStateOf(info),
        transcript,
      );
      const round = composeHostRound(state, childInputAt);
      if (round.verdict === 'unreadable')
        return { reason: round.reason ?? 'host state unreadable', label };
      if (round.verdict === 'incomplete')
        return { reason: 'still running', label };
      if (round.verdict === 'error' || round.verdict === 'interrupted')
        return { reason: 'failed', label };
      const text = terminalTextOf(transcript);
      return text && text.trim() !== ''
        ? { text, label }
        : { reason: 'empty result', label };
    }),
  );
}
