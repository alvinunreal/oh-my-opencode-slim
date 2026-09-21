import { describe, expect, mock, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  getRuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from './session-runtime-status';

function pluginInputWithClient(client: PluginInput['client']): PluginInput {
  return { client, directory: '/proj' } as PluginInput;
}

describe('getRuntimeSessionStatusSnapshot capability probe', () => {
  test('client without session.status returns the honest unavailable error', async () => {
    const snapshot = await getRuntimeSessionStatusSnapshot(
      pluginInputWithClient({ session: {} } as PluginInput['client']),
    );

    expect(snapshot.error).toBe(
      'session-status capability unavailable on this host',
    );
    expect(snapshot.statuses.size).toBe(0);
    expect(snapshot.malformedSessionIDs.size).toBe(0);
    expect(snapshot.retryAfter).toBeUndefined();
    expect(runtimeSessionStatus(snapshot, 'ses_1')).toBeUndefined();
  });

  test('capability-absent client never attempts a session read', async () => {
    const getSession = mock(() => Promise.resolve({ data: {} }));
    const listSessions = mock(() => Promise.resolve({ data: [] }));
    // v2 shim shape: session methods exist, `status` is deliberately omitted.
    const client = {
      session: { get: getSession, list: listSessions },
    } as PluginInput['client'];

    const snapshot = await getRuntimeSessionStatusSnapshot(
      pluginInputWithClient(client),
    );

    expect(snapshot.error).toBe(
      'session-status capability unavailable on this host',
    );
    expect(getSession).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
  });

  test('capable client still performs the status read and maps statuses', async () => {
    const status = mock(() =>
      Promise.resolve({
        data: {
          ses_1: { type: 'busy' },
          ses_2: { type: 'idle' },
          ses_bad: { type: 'weird' },
        },
      }),
    );
    const client = {
      session: { status },
    } as PluginInput['client'];

    const snapshot = await getRuntimeSessionStatusSnapshot(
      pluginInputWithClient(client),
    );

    expect(snapshot.error).toBeUndefined();
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith({
      query: { directory: '/proj' },
    });
    expect(snapshot.statuses.get('ses_1')).toBe('busy');
    expect(snapshot.statuses.get('ses_2')).toBe('idle');
    expect(snapshot.malformedSessionIDs.has('ses_bad')).toBe(true);
  });
});
