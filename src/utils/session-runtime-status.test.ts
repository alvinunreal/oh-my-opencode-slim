import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  classifyLiveSession,
  composeHostRound,
  getRuntimeSessionStatusSnapshot,
  hostRoundStateOf,
  hostRoundVerdict,
  runtimeSessionStatus,
} from './session-runtime-status';
import { createTimerHarness } from './test-timers';

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

describe('classifyLiveSession', () => {
  test('preserves host identity alongside a historical outcome', async () => {
    const get = mock(async () => ({
      data: {
        id: 'ses_child',
        parentID: 'ses_parent',
        outcome: 'succeeded',
        time: { idle: 5 },
      },
    }));
    expect(
      await classifyLiveSession(
        pluginInputWithClient({ session: { get } } as never),
        'ses_child',
      ),
    ).toEqual({
      kind: 'outcome',
      outcome: 'succeeded',
      idleAt: 5,
      sessionID: 'ses_child',
      parentID: 'ses_parent',
    });
  });

  test('concurrent probes share one in-flight host-info read', async () => {
    let resolveRead: (value: unknown) => void = () => {};
    const pending = new Promise<unknown>((resolve) => {
      resolveRead = resolve;
    });
    const get = mock(() => pending);
    const input = pluginInputWithClient({ session: { get } } as never);
    const first = classifyLiveSession(input, 'ses_shared');
    const second = classifyLiveSession(input, 'ses_shared');
    await Promise.resolve();
    expect(get).toHaveBeenCalledTimes(1);
    resolveRead({ data: { outcome: 'succeeded', time: { idle: 4 } } });
    expect(await first).toEqual({
      kind: 'outcome',
      outcome: 'succeeded',
      idleAt: 4,
    });
    expect(await second).toEqual({
      kind: 'outcome',
      outcome: 'succeeded',
      idleAt: 4,
    });
  });

  test('a rejected host-info read classifies unknown instead of throwing', async () => {
    const get = mock(async () => {
      throw new Error('host read failed');
    });
    const result = await classifyLiveSession(
      pluginInputWithClient({ session: { get } } as never),
      'ses_1',
    );
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') {
      expect(result.reason).toContain('host read failed');
    }
  });

  test.each([
    [{ type: 'busy' }, 'running'],
    [{ type: 'retry' }, 'running'],
    [{ type: 'idle' }, 'idle'],
  ] as const)(
    'live map entry %j classifies as %s without a host-info read',
    async (entry, kind) => {
      const status = mock(async () => ({ data: { ses_1: entry } }));
      const get = mock(async () => ({
        data: { outcome: 'succeeded', time: { idle: 5 } },
      }));
      const result = await classifyLiveSession(
        pluginInputWithClient({ session: { status, get } } as never),
        'ses_1',
      );
      expect(result).toEqual({ kind });
      expect(get).not.toHaveBeenCalled();
    },
  );

  test('a valid map without the session is quiescent (idle), not an outcome', async () => {
    const status = mock(async () => ({ data: {} }));
    const result = await classifyLiveSession(
      pluginInputWithClient({ session: { status } } as never),
      'ses_missing',
    );
    expect(result).toEqual({ kind: 'idle' });
  });

  test('map read failure and malformed entries stay unknown', async () => {
    const failing = pluginInputWithClient({
      session: {
        status: mock(async () => {
          throw new Error('status unavailable');
        }),
      },
    } as never);
    expect(await classifyLiveSession(failing, 'ses_1')).toEqual({
      kind: 'unknown',
      reason: 'status unavailable',
    });
    const malformed = pluginInputWithClient({
      session: {
        status: mock(async () => ({ data: { ses_1: { type: 'weird' } } })),
      },
    } as never);
    expect(await classifyLiveSession(malformed, 'ses_1')).toEqual({
      kind: 'unknown',
      reason: 'malformed entry',
    });
  });

  test.each([
    ['succeeded', 5],
    ['failed', 3],
    ['interrupted', 0],
  ] as const)(
    'host info outcome %s surfaces with time.idle %j (v2, no map)',
    async (outcome, idleAt) => {
      const get = mock(async () => ({
        data: {
          outcome,
          ...(idleAt !== undefined ? { time: { idle: idleAt } } : {}),
        },
      }));
      const result = await classifyLiveSession(
        pluginInputWithClient({ session: { get } } as never),
        'ses_1',
      );
      expect(result).toEqual({
        kind: 'outcome',
        outcome,
        ...(idleAt !== undefined ? { idleAt } : {}),
      });
      expect(get).toHaveBeenCalledWith({
        path: { id: 'ses_1' },
        query: { directory: '/proj' },
      });
    },
  );

  test.each(['idleOutcome', 'idle_outcome', 'outcome'])(
    'accepts the host %s spelling for the terminal outcome',
    async (key) => {
      const get = mock(async () => ({
        data: { [key]: 'failed', time: { idle: 7 } },
      }));
      expect(
        await classifyLiveSession(
          pluginInputWithClient({ session: { get } } as never),
          'ses_1',
        ),
      ).toEqual({ kind: 'outcome', outcome: 'failed', idleAt: 7 });
    },
  );

  test('accepts a flat (non-`data`) session info response', async () => {
    const get = mock(async () => ({ outcome: 'succeeded', time: { idle: 2 } }));
    expect(
      await classifyLiveSession(
        pluginInputWithClient({ session: { get } } as never),
        'ses_1',
      ),
    ).toEqual({ kind: 'outcome', outcome: 'succeeded', idleAt: 2 });
  });

  test.each([
    [{ data: { time: { idle: 3 } } }, 'no host terminal outcome'],
    [
      { data: { outcome: 'cancelled', time: { idle: 3 } } },
      'unrecognized host outcome: cancelled',
    ],
    [{ error: 'boom' }, 'invalid session info response'],
  ])(
    'unusable host info %j classifies unknown (%s)',
    async (response, reason) => {
      const get = mock(async () => response);
      expect(
        await classifyLiveSession(
          pluginInputWithClient({ session: { get } } as never),
          'ses_1',
        ),
      ).toEqual({ kind: 'unknown', reason });
    },
  );

  test('a throwing host read classifies unknown instead of surfacing', async () => {
    const get = mock(async () => {
      throw new Error('session get failed');
    });
    expect(
      await classifyLiveSession(
        pluginInputWithClient({ session: { get } } as never),
        'ses_1',
      ),
    ).toEqual({ kind: 'unknown', reason: 'session get failed' });
  });

  test('hosts without session.get classify unknown', async () => {
    expect(
      await classifyLiveSession(
        pluginInputWithClient({ session: {} } as never),
        'ses_1',
      ),
    ).toEqual({
      kind: 'unknown',
      reason: 'session-status and session-get unavailable on this host',
    });
  });

  test('the bounded host read rejects through the injected timer seam', async () => {
    const timers = createTimerHarness();
    let reads = 0;
    const get = mock(() => {
      reads += 1;
      return new Promise(() => {});
    });
    const pending = classifyLiveSession(
      pluginInputWithClient({ session: { get } } as never),
      'ses_1',
      { timeoutMs: 20, timers },
    );
    // Start → arm → fire → settle. No real time is involved.
    await timers.tick();
    expect(timers.pending()).toBe(1);
    await timers.advance(20);
    expect(await pending).toEqual({
      kind: 'unknown',
      reason: 'Session status lookup timed out',
    });
    expect(reads).toBe(1);
    expect(timers.pending()).toBe(0);
  });

  test('an early settle clears the injected timeout timer', async () => {
    const timers = createTimerHarness();
    const get = mock(async () => ({
      data: { outcome: 'interrupted', time: { idle: 1 } },
    }));
    expect(
      await classifyLiveSession(
        pluginInputWithClient({ session: { get } } as never),
        'ses_1',
        { timeoutMs: 20, timers },
      ),
    ).toEqual({ kind: 'outcome', outcome: 'interrupted', idleAt: 1 });
    expect(timers.pending()).toBe(0);
  });
});
