import type { PluginInput } from '@opencode-ai/plugin';
import { isRecord } from './guards';
import { getClient } from './opencode-client';

export type RuntimeSessionStatus = 'busy' | 'retry' | 'idle';
export const DEFAULT_RUNTIME_SESSION_STATUS_TIMEOUT_MS = 5_000;
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
    const request = client.session.status({
      query: { directory: input.directory },
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
    );
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

export function runtimeSessionStatus(
  snapshot: RuntimeSessionStatusSnapshot,
  sessionID: string,
): RuntimeSessionStatus | undefined {
  if (snapshot.error) return undefined;
  if (snapshot.malformedSessionIDs.has(sessionID)) return undefined;
  return snapshot.statuses.get(sessionID);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Session status lookup timed out');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Session status lookup timed out'));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
