import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  composeHostRound,
  getRuntimeSessionStatusSnapshot,
  hostRoundStateOf,
  hostRoundVerdict,
} from './session-runtime-status';

function pluginInputWithClient(client: PluginInput['client']): PluginInput {
  return { client, directory: '/proj' } as PluginInput;
}

afterEach(() => jest.useRealTimers());

describe('host round state', () => {
  test('terminal evidence needs outcome and idle together', () => {
    expect(
      hostRoundStateOf({ outcome: 'succeeded', time: { idle: 12 } }),
    ).toEqual({ kind: 'terminal', outcome: 'succeeded', idleAt: 12 });
    expect(hostRoundStateOf({ time: { created: 9 } })).toEqual({
      kind: 'pending',
    });
    expect(hostRoundStateOf(undefined)).toEqual({ kind: 'pending' });
  });

  test('partial or malformed projections fail closed', () => {
    for (const info of [
      { outcome: 'succeeded' },
      { time: { idle: 12 } },
      { outcome: 'completed', time: { idle: 12 } },
      { outcome: 'succeeded', time: { idle: Number.NaN } },
      { outcome: 'succeeded', time: { idle: -1 } },
      { outcome: 'succeeded', time: { idle: 1.5 } },
      { outcome: 'succeeded', time: { idle: Number.MAX_SAFE_INTEGER + 1 } },
    ]) {
      expect(hostRoundStateOf(info).kind).toBe('unknown');
    }
  });
});

describe('host round composition', () => {
  test.each([
    ['succeeded', 'completed'],
    ['failed', 'error'],
    ['interrupted', 'interrupted'],
  ] as const)(
    'maps %s terminal evidence after latest input',
    (outcome, verdict) => {
      const state = { kind: 'terminal', outcome, idleAt: 12 } as const;
      expect(hostRoundVerdict(state, 10)).toBe('terminal');
      expect(composeHostRound(state, 10)).toMatchObject({
        verdict,
        startedAt: 10,
        completedAt: 12,
      });
      if (outcome === 'failed') {
        expect(composeHostRound(state, 10).text).toBe(
          'The historical round failed before an assistant result.',
        );
      }
    },
  );

  test('old or unanchored terminal is pending for the latest input', () => {
    const state = {
      kind: 'terminal',
      outcome: 'succeeded',
      idleAt: 10,
    } as const;
    expect(hostRoundVerdict(state, 10)).toBe('pending');
    expect(composeHostRound(state, 10)).toEqual({
      verdict: 'incomplete',
      startedAt: 10,
    });
    expect(hostRoundVerdict({ ...state, idleAt: 12 }, undefined)).toBe(
      'pending',
    );
    expect(composeHostRound({ ...state, idleAt: 12 }, undefined)).toEqual({
      verdict: 'incomplete',
      startedAt: undefined,
    });
  });

  test('unfinished and unknown remain distinguishable', () => {
    expect(hostRoundVerdict({ kind: 'pending' }, 10)).toBe('pending');
    expect(composeHostRound({ kind: 'pending' }, 10)).toEqual({
      verdict: 'incomplete',
      startedAt: 10,
    });
    const unknown = { kind: 'unknown', reason: 'offline' } as const;
    expect(hostRoundVerdict(unknown, 10)).toBe('unknown');
    expect(composeHostRound(unknown, 10)).toEqual({
      verdict: 'unreadable',
      reason: 'offline',
    });
  });
});

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
      signal: expect.any(AbortSignal),
    });
    expect(snapshot.statuses.get('ses_1')).toBe('busy');
    expect(snapshot.statuses.get('ses_2')).toBe('idle');
    expect(snapshot.malformedSessionIDs.has('ses_bad')).toBe(true);
  });

  test('aborts a timed-out status read before the next lookup', async () => {
    jest.useFakeTimers();
    const status = mock((_options: { signal?: AbortSignal }) =>
      Promise.resolve({ data: {} }),
    ).mockImplementationOnce(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const input = pluginInputWithClient({ session: { status } } as never);
    const pending = getRuntimeSessionStatusSnapshot(input, { timeoutMs: 20 });
    const collision = await getRuntimeSessionStatusSnapshot(input);
    expect(collision.error).toBe('Previous session-status read is still open');
    expect(collision.retryAfter).toBeInstanceOf(Promise);
    expect(status).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(20);
    expect((await pending).error).toBe('Session status lookup timed out');
    const next = await getRuntimeSessionStatusSnapshot(input);
    expect({ calls: status.mock.calls.length, error: next.error }).toEqual({
      calls: 2,
      error: undefined,
    });
    expect(status.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });

  test('aborts the read when the timeout is invalid', async () => {
    const status = mock(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const input = pluginInputWithClient({ session: { status } } as never);
    for (const _ of [0, 1]) {
      const snapshot = await getRuntimeSessionStatusSnapshot(input, {
        timeoutMs: 0,
      });
      expect(snapshot.error).toBe('Session status lookup timed out');
    }
    expect(status).toHaveBeenCalledTimes(2);
    expect(status.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });
});
