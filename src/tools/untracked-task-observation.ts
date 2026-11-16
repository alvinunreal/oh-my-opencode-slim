import type { PluginInput } from '@opencode-ai/plugin';
import {
  attributeHostRoundToTranscript,
  type CurrentRoundClassification,
  classifyMigratedV1Round,
  fetchChildTranscript,
  latestInputAtOf,
  terminalErrorOf,
  terminalTextOf,
} from '../utils/child-transcript';
import { isRecord } from '../utils/guards';
import { getClient } from '../utils/opencode-client';
import { SESSION_ID_PATTERN, withTimeout } from '../utils/session';
import {
  composeHostRound,
  hostRoundStateOf,
  hostRunningSince,
  isHostTimestamp,
} from '../utils/session-runtime-status';

/** Each untracked host read (ownership, transcript) refuses after 5 s. */
const DEFAULT_READ_TIMEOUT_MS = 5_000;

/** Host execution or transcript evidence for an untracked task. */
export interface UntrackedEvidence {
  running?: { since: number };
  round?: CurrentRoundClassification;
  roundError?: unknown;
  error?: string;
  source?: 'history';
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
  // Mirror recovery: a payload for a different session proves nothing.
  if (data.id !== undefined && data.id !== identity) {
    return { kind: 'unreadable' };
  }
  if (data.parentID !== parentSessionID) return { kind: 'foreign-parent' };

  const agent =
    typeof data.agent === 'string' ? data.agent.trim() || undefined : undefined;
  const created = isRecord(data.time) ? data.time.created : undefined;
  return {
    kind: 'verified',
    agent,
    hostInfo: data,
    createdAt:
      typeof created === 'number' && Number.isFinite(created)
        ? created
        : undefined,
  };
}

/** An open host execution short-circuits the transcript. */
export async function readUntrackedEvidence(
  options: {
    input: PluginInput;
    readTimeoutMs?: number;
  },
  identity: string,
  hostInfo?: Record<string, unknown>,
): Promise<UntrackedEvidence> {
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const since = hostRunningSince(hostInfo);
  if (since !== undefined) return { running: { since } };
  const client = getClient(options.input);
  return readTranscript(client, options, identity, readTimeoutMs, hostInfo);
}

async function readTranscript(
  client: ReturnType<typeof getClient>,
  options: { input: PluginInput },
  identity: string,
  readTimeoutMs: number,
  hostInfo?: Record<string, unknown>,
): Promise<UntrackedEvidence> {
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
    const state = attributeHostRoundToTranscript(
      hostRoundStateOf(hostInfo),
      transcript,
    );
    const hostTime = isRecord(hostInfo?.time) ? hostInfo.time : undefined;
    if (
      state.kind === 'pending' &&
      hostTime?.busy === undefined &&
      hostTime?.idle === undefined
    ) {
      const migrated = classifyMigratedV1Round(transcript);
      if (migrated) return { round: migrated, source: 'history' };
    }
    const latestInputAt = latestInputAtOf(transcript);
    const busy = hostTime?.busy;
    const busyAt = isHostTimestamp(busy) ? busy : undefined;
    const round = composeHostRound(state, latestInputAt, busyAt);
    if (state.kind === 'terminal') {
      const text = terminalTextOf(transcript);
      if (text) round.text = text;
      else if (state.outcome === 'succeeded')
        return {
          round: { verdict: 'incomplete', startedAt: latestInputAt },
        };
    }
    return {
      round,
      ...(state.kind === 'terminal' && state.outcome === 'failed'
        ? { error: terminalErrorOf(transcript) }
        : {}),
    };
  } catch (error) {
    return { roundError: error };
  }
}
