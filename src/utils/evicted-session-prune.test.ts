import { describe, expect, mock, test } from 'bun:test';
import type { BackgroundJobEvictedSession } from '../background-jobs';
import { pruneEvictedHostSession } from './evicted-session-prune';
import {
  pendingSessionPrune,
  registerPendingSessionPrune,
} from './pending-session-prunes';

const evicted = (
  overrides: Partial<BackgroundJobEvictedSession> = {},
): BackgroundJobEvictedSession => ({
  taskID: 'ses_child',
  parentSessionID: 'parent-1',
  agent: 'oracle',
  description: 'child',
  state: 'reconciled',
  background: true,
  provisional: false,
  pluginLaunched: true,
  externalOrigin: false,
  alias: 'ses_child',
  lastUsedAt: 1,
  ...overrides,
});

const idleStatus = () => mock(async () => ({ data: {} }));

const hostSession = (data: unknown) => ({
  get: mock(async () => ({ data })),
  status: idleStatus(),
  delete: mock(async () => ({ data: true })),
});

const run = (
  session: Parameters<typeof pruneEvictedHostSession>[0]['session'],
  entry = evicted(),
  readTimeoutMs = 1_000,
  options: {
    deleteTimeoutMs?: number;
    isTracked?: (taskID: string) => boolean;
  } = {},
) =>
  pruneEvictedHostSession({
    session,
    directory: '/project',
    evicted: entry,
    readTimeoutMs,
    deleteTimeoutMs: options.deleteTimeoutMs ?? 1_000,
    isTracked: options.isTracked ?? (() => false),
  });

describe('pruneEvictedHostSession', () => {
  test('deletes a verified background child this plugin launched', async () => {
    const session = hostSession({ id: 'ses_child', parentID: 'parent-1' });
    expect(await run(session)).toBe('deleted');
    expect(session.get.mock.calls[0]?.[0]).toMatchObject({
      path: { id: 'ses_child' },
      query: { directory: '/project' },
    });
    expect(session.delete).toHaveBeenCalledTimes(1);
    expect(session.delete.mock.calls[0]?.[0]).toMatchObject({
      path: { id: 'ses_child' },
      query: { directory: '/project' },
    });
  });

  for (const [name, overrides] of [
    ['foreground', { background: false }],
    ['provisional', { provisional: true }],
    ['restored or adopted', { externalOrigin: true, pluginLaunched: false }],
    ['not plugin launched', { pluginLaunched: false }],
  ] as const) {
    test(`never reads or deletes a ${name} record`, async () => {
      const session = hostSession({ id: 'ses_child', parentID: 'parent-1' });
      expect(await run(session, evicted(overrides))).toBe('ineligible');
      expect(session.get).not.toHaveBeenCalled();
      expect(session.delete).not.toHaveBeenCalled();
    });
  }

  test('skips when the host parentID does not match the record parent', async () => {
    const session = hostSession({ id: 'ses_child', parentID: 'parent-2' });
    expect(await run(session)).toBe('parent-mismatch');
    expect(session.delete).not.toHaveBeenCalled();
  });

  test('skips when the host session has no parentID', async () => {
    const session = hostSession({ id: 'ses_child' });
    expect(await run(session)).toBe('read-failed');
    expect(session.delete).not.toHaveBeenCalled();
  });

  test('skips when the host returns a different session id', async () => {
    const session = hostSession({ id: 'ses_other', parentID: 'parent-1' });
    expect(await run(session)).toBe('read-failed');
    expect(session.delete).not.toHaveBeenCalled();
  });

  test('skips when the read rejects, reports an error, or is missing', async () => {
    const rejecting = {
      get: mock(async () => {
        throw new Error('boom');
      }),
      status: idleStatus(),
      delete: mock(async () => ({})),
    };
    expect(await run(rejecting)).toBe('read-failed');
    expect(rejecting.delete).not.toHaveBeenCalled();

    const erroring = {
      get: mock(async () => ({ error: { name: 'NotFound' } })),
      status: idleStatus(),
      delete: mock(async () => ({})),
    };
    expect(await run(erroring)).toBe('read-failed');
    expect(erroring.delete).not.toHaveBeenCalled();

    const getless = { status: idleStatus(), delete: mock(async () => ({})) };
    expect(await run(getless)).toBe('read-failed');
    expect(getless.delete).not.toHaveBeenCalled();
  });

  test('skips when the read times out and aborts it', async () => {
    let signal: AbortSignal | undefined;
    const session = {
      get: mock(
        (request: { signal?: AbortSignal }) =>
          new Promise<unknown>(() => {
            signal = request.signal;
          }),
      ),
      status: idleStatus(),
      delete: mock(async () => ({})),
    };
    expect(await run(session, evicted(), 5)).toBe('read-failed');
    expect(signal?.aborted).toBe(true);
    expect(session.delete).not.toHaveBeenCalled();
  });

  test('a rejected delete resolves to delete-failed', async () => {
    const session = {
      get: mock(async () => ({
        data: { id: 'ses_child', parentID: 'parent-1' },
      })),
      status: idleStatus(),
      delete: mock(async () => {
        throw new Error('gone');
      }),
    };
    expect(await run(session)).toBe('delete-failed');
  });

  test('a busy, retrying, or unreadable status skips the delete', async () => {
    for (const status of [
      async () => ({ data: { ses_child: { type: 'busy' } } }),
      async () => ({ data: { ses_child: { type: 'retry' } } }),
      async () => ({ data: { ses_child: { type: 'weird' } } }),
      async () => ({ error: { name: 'Unavailable' } }),
      async () => {
        throw new Error('status down');
      },
    ]) {
      const session = {
        ...hostSession({ id: 'ses_child', parentID: 'parent-1' }),
        status: mock(status),
      };
      expect(await run(session)).toBe('not-idle');
      expect(session.delete).not.toHaveBeenCalled();
    }
    const statusless = hostSession({ id: 'ses_child', parentID: 'parent-1' });
    const { status: _omit, ...withoutStatus } = statusless;
    expect(await run(withoutStatus)).toBe('not-idle');
    expect(statusless.delete).not.toHaveBeenCalled();
  });

  test('an explicitly idle session is deleted', async () => {
    const session = {
      ...hostSession({ id: 'ses_child', parentID: 'parent-1' }),
      status: mock(async () => ({ data: { ses_child: { type: 'idle' } } })),
    };
    expect(await run(session)).toBe('deleted');
  });

  test('a session the board tracks again is never deleted', async () => {
    const before = hostSession({ id: 'ses_child', parentID: 'parent-1' });
    expect(await run(before, evicted(), 1_000, { isTracked: () => true })).toBe(
      'tracked',
    );
    expect(before.get).not.toHaveBeenCalled();
    expect(before.delete).not.toHaveBeenCalled();

    // Re-registered while the host reads were in flight.
    let tracked = false;
    const during = {
      ...hostSession({ id: 'ses_child', parentID: 'parent-1' }),
      status: mock(async () => {
        tracked = true;
        return { data: {} };
      }),
    };
    expect(
      await run(during, evicted(), 1_000, { isTracked: () => tracked }),
    ).toBe('tracked');
    expect(during.delete).not.toHaveBeenCalled();
  });

  test('an error-returning or falsy delete reports delete-failed', async () => {
    for (const result of [
      { error: { name: 'NotFound', message: 'missing' } },
      { data: false },
      undefined,
    ]) {
      const session = {
        ...hostSession({ id: 'ses_child', parentID: 'parent-1' }),
        delete: mock(async () => result),
      };
      expect(await run(session)).toBe('delete-failed');
    }
  });

  test('a hung delete times out, aborts, and settles the prune fence', async () => {
    let signal: AbortSignal | undefined;
    const session = {
      ...hostSession({ id: 'ses_child', parentID: 'parent-1' }),
      delete: mock(
        (request: { signal?: AbortSignal }) =>
          new Promise<unknown>(() => {
            signal = request.signal;
          }),
      ),
    };
    registerPendingSessionPrune(
      'ses_child_hung',
      run(session, evicted(), 1_000, { deleteTimeoutMs: 5 }),
    );
    const fence = pendingSessionPrune('ses_child_hung');
    expect(fence).toBeDefined();
    await fence;
    expect(signal?.aborted).toBe(true);
    // Let the registry's self-removal microtask run.
    await Promise.resolve();
    expect(pendingSessionPrune('ses_child_hung')).toBeUndefined();
    expect(await run(session, evicted(), 1_000, { deleteTimeoutMs: 5 })).toBe(
      'delete-failed',
    );
  });
});
