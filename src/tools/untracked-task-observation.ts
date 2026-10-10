import { type PluginInput } from '@opencode-ai/plugin';
import {
  classifyTerminalEvidence,
  classifyV2HistoricalRound,
  fetchChildTranscript,
} from '../utils/child-transcript';
import { isRecord } from '../utils/guards';
import { getClient } from '../utils/opencode-client';
import { SESSION_ID_PATTERN, withTimeout } from '../utils/session';
import { getRuntimeSessionStatusSnapshot } from '../utils/session-runtime-status';

/** Each untracked host read (ownership, transcript) refuses after 5 s. */
const DEFAULT_READ_TIMEOUT_MS = 5_000;

/** v1 live probe + transcript classification for an untracked task.
 *  `live.status` is `v2` on hosts with no status map; `round` is absent
 *  when a live verdict short-circuits the read or it failed (`roundError`
 *  carries the raw error for callers that rethrow). */
export interface UntrackedEvidence {
  live: {
    status: 'busy' | 'retry' | 'unknown' | 'absent' | 'v2';
    reason?: string;
  };
  round?:
    | Awaited<ReturnType<typeof classifyTerminalEvidence>>
    | Awaited<ReturnType<typeof classifyV2HistoricalRound>>;
  roundError?: unknown;
}

async function boundedRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  return withTimeout(read(controller.signal), timeoutMs, message).catch(
    (error) => {
      controller.abort();
      throw error;
    },
  );
}

/** Read-only ownership check for a session the board does not track;
 *  error texts stay per-tool (callers map the kinds). */
export async function verifyUntrackedOwnership(
  options: { input: PluginInput; readTimeoutMs?: number },
  identity: string,
  parentSessionID: string,
) {
  if (!SESSION_ID_PATTERN.test(identity)) return { kind: 'not-a-session' };
  const client = getClient(options.input);
  if (typeof client.session?.get !== 'function') {
    return { kind: 'no-session-get' };
  }
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  let data: Record<string, unknown> | undefined;
  try {
    const response = await boundedRead(
      (signal) =>
        client.session.get({
          path: { id: identity },
          query: { directory: options.input.directory },
          signal,
        }),
      readTimeoutMs,
      'session ownership read timed out',
    );
    data = isRecord(response.data) ? response.data : undefined;
  } catch {
    // Unreadable session, host error payload, or no parent: verifies nothing.
    return { kind: 'unreadable' };
  }
  if (!data || typeof data.parentID !== 'string' || !data.parentID) {
    return { kind: 'unreadable' };
  }
  if (data.parentID !== parentSessionID) return { kind: 'foreign-parent' };

  const agent =
    typeof data.agent === 'string' ? data.agent.trim() || undefined : undefined;
  const created = isRecord(data.time) ? data.time.created : undefined;
  return {
    kind: 'verified',
    agent,
    createdAt:
      typeof created === 'number' && Number.isFinite(created)
        ? created
        : undefined,
  };
}

/** A live verdict short-circuits the transcript (unreadable liveness cannot
 *  rule out a newer run, so history proves nothing); v2 skips the probe. */
export async function readUntrackedEvidence(
  options: {
    input: PluginInput;
    readTimeoutMs?: number;
    statusTimeoutMs?: number;
  },
  identity: string,
): Promise<UntrackedEvidence> {
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const client = getClient(options.input);
  const v2 = (options.input as { hostFlavor?: string }).hostFlavor === 'v2';
  if (v2) return readTranscript(client, options, identity, readTimeoutMs, true);
  const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
    timeoutMs: options.statusTimeoutMs,
  });
  if (snapshot.error || snapshot.malformedSessionIDs.has(identity)) {
    return {
      live: {
        status: 'unknown',
        reason: snapshot.error ?? 'malformed session-status entry',
      },
    };
  }
  const status = snapshot.statuses.get(identity);
  if (status === 'busy' || status === 'retry') {
    return { live: { status } };
  }
  return readTranscript(client, options, identity, readTimeoutMs, false);
}

async function readTranscript(
  client: ReturnType<typeof getClient>,
  options: { input: PluginInput },
  identity: string,
  readTimeoutMs: number,
  v2: boolean,
): Promise<UntrackedEvidence> {
  const live: UntrackedEvidence['live'] = { status: v2 ? 'v2' : 'absent' };
  try {
    const transcript = await boundedRead(
      (signal) =>
        fetchChildTranscript(
          client,
          identity,
          options.input.directory,
          undefined,
          signal,
        ),
      readTimeoutMs,
      'child transcript read timed out',
    );
    return {
      live,
      round: v2
        ? classifyV2HistoricalRound(transcript)
        : classifyTerminalEvidence(transcript),
    };
  } catch (error) {
    return { live, roundError: error };
  }
}
