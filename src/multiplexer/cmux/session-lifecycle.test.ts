import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Multiplexer } from '../types';
import { CmuxSessionLifecycle } from './session-lifecycle';
import { CmuxSessionStore } from './session-state';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function multiplexer() {
  return {
    type: 'cmux',
    isAvailable: async () => true,
    isInsideSession: () => true,
    spawnPane: mock(async () => ({ success: true, paneId: 'pane' })),
    closePane: mock(async () => true),
    applyLayout: async () => {},
  } satisfies Multiplexer;
}

describe('CmuxSessionLifecycle races', () => {
  const store = new CmuxSessionStore();
  beforeEach(() => store.resetForTests());

  test('in-flight activity automatically respawns after idle close succeeds', async () => {
    const mux = multiplexer();
    const close = deferred<boolean>();
    mux.closePane.mockImplementationOnce(() => close.promise);
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      'http://server',
      '/repo',
      undefined,
      { isServerRunning: async () => true },
    );
    await lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 's', parentID: 'p' } },
    });
    const closing = lifecycle.closeSessionFromCoordinator('s');
    await lifecycle.onSessionStatus({
      type: 'session.status',
      properties: { sessionID: 's', status: { type: 'busy' } },
    });
    close.resolve(true);
    await closing;
    expect(mux.spawnPane).toHaveBeenCalledTimes(2);
    expect(store.get('s')).toMatchObject({
      paneId: 'pane',
      spawnState: 'attached',
      lifecycle: 'active',
      owner: 'owner',
    });
  });

  test('dispose gate closes a late successful spawn and never marks it active', async () => {
    const mux = multiplexer();
    const spawn = deferred<{ success: true; paneId: string }>();
    mux.spawnPane.mockImplementationOnce(() => spawn.promise);
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      'http://server',
      '/repo',
      undefined,
      {
        delay: async () => {},
        shutdownTimeoutMs: 1,
        isServerRunning: async () => true,
      },
    );
    const creating = lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'late', parentID: 'p' } },
    });
    await Promise.resolve();
    await lifecycle.cleanup();
    spawn.resolve({ success: true, paneId: 'late-pane' });
    await creating;
    expect(mux.closePane).toHaveBeenCalledWith('late-pane');
    expect(store.get('late')).toBeUndefined();
    await lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'blocked', parentID: 'p' } },
    });
    expect(mux.spawnPane).toHaveBeenCalledTimes(1);
  });

  test('new same-directory lifecycle takes over orphan with bounded attempts', async () => {
    store.claimCreated({
      session: 'orphan',
      owner: 'old',
      parent: 'p',
      title: 'agent',
      directory: '/repo',
      paneId: 'orphan-pane',
      spawnState: 'attached',
      lifecycle: 'orphaned',
      lastActivityAt: 0,
      activityVersion: 0,
      idleConsecutive: 0,
    });
    const mux = multiplexer();
    mux.closePane.mockResolvedValue(false);
    new CmuxSessionLifecycle('new', mux, 'http://server', '/repo', undefined, {
      closeRetryMaxAttempts: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mux.closePane).toHaveBeenCalledTimes(1);
    expect(store.get('orphan')).toMatchObject({
      owner: 'new',
      lifecycle: 'orphaned',
      paneId: 'orphan-pane',
    });
  });
});
