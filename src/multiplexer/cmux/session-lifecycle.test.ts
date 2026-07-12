import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Multiplexer } from '../types';
import { CmuxClosePolicy } from './close-policy';
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

  test('coordinator completion still requires lifetime and three stable idle polls', async () => {
    const mux = multiplexer();
    let now = 0;
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        now: () => now,
        isServerRunning: async () => true,
        fetchStatuses: async () => ({ s: { type: 'idle' } }),
      },
    );
    await lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 's', parentID: 'p' } },
    });
    await lifecycle.closeSessionFromCoordinator('s');
    await lifecycle.pollOnce();
    expect(mux.closePane).not.toHaveBeenCalled();
    now = 10_000;
    await lifecycle.pollOnce();
    await lifecycle.pollOnce();
    expect(mux.closePane).not.toHaveBeenCalled();
    await lifecycle.pollOnce();
    expect(mux.closePane).toHaveBeenCalledTimes(1);
    await lifecycle.cleanup();
  });

  test('dispose gate closes a late successful spawn and never marks it active', async () => {
    const mux = multiplexer();
    const spawn = deferred<{ success: true; paneId: string }>();
    mux.spawnPane.mockImplementationOnce(() => spawn.promise);
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      () => 'http://server',
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
    new CmuxSessionLifecycle(
      'new',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        closeRetryMaxAttempts: 1,
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mux.closePane).toHaveBeenCalledTimes(1);
    expect(store.get('orphan')).toMatchObject({
      owner: 'new',
      lifecycle: 'orphaned',
      paneId: 'orphan-pane',
    });
  });

  test('terminal tracked orphan gets a fresh close budget when claimed', async () => {
    const policy = new CmuxClosePolicy(1, 1);
    let intent = policy.request('cleanup', 0, 0);
    intent = policy.failed(intent, 1);
    intent = policy.failed(policy.resume(intent, 30_001), 30_002);
    intent = policy.failed(policy.resume(intent, 90_002), 90_003);
    store.claimCreated({
      session: 'spent',
      owner: 'old',
      parent: 'p',
      title: 'agent',
      directory: '/repo',
      paneId: 'pane',
      spawnState: 'attached',
      lifecycle: 'orphaned',
      lastActivityAt: 0,
      activityVersion: 0,
      idleConsecutive: 0,
      closeIntent: intent,
    });
    const mux = multiplexer();
    mux.closePane.mockResolvedValue(false);
    new CmuxSessionLifecycle(
      'new',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        closeRetryMaxAttempts: 1,
      },
    );
    await Promise.resolve();
    expect(mux.closePane).toHaveBeenCalledTimes(1);
    expect(store.get('spent')?.owner).toBe('new');
    expect(store.get('spent')?.closeIntent?.nextAttemptAt).not.toBe(Infinity);
  });

  test('busy activity cancels idle close during the first cooldown', async () => {
    let now = 0;
    const mux = multiplexer();
    mux.closePane.mockResolvedValue(false);
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        now: () => now,
        delay: () => new Promise(() => {}),
        closeRetryMaxAttempts: 1,
        isServerRunning: async () => true,
        fetchStatuses: async () => ({ active: { type: 'idle' } }),
      },
    );
    await lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'active', parentID: 'p' } },
    });
    now = 10_000;
    await lifecycle.pollOnce();
    await lifecycle.pollOnce();
    await lifecycle.pollOnce();
    expect(store.get('active')).toMatchObject({
      lifecycle: 'active',
      closeIntent: { phase: 'cooldown', cooldowns: 1 },
    });
    await lifecycle.onSessionStatus({
      type: 'session.status',
      properties: { sessionID: 'active', status: { type: 'busy' } },
    });
    expect(store.get('active')).toMatchObject({ lifecycle: 'active' });
    expect(store.get('active')?.closeIntent).toBeUndefined();
    expect(store.get('active')?.closeTimer).toBeUndefined();
  });

  for (const result of [true, false]) {
    test(`old owner close ${result ? 'success' : 'failure'} cannot mutate a claimed orphan`, async () => {
      store.claimCreated({
        session: 'race',
        owner: 'old',
        parent: 'p',
        title: 'agent',
        directory: '/repo',
        paneId: 'pane',
        spawnState: 'attached',
        lifecycle: 'orphaned',
        lastActivityAt: 0,
        activityVersion: 0,
        idleConsecutive: 0,
      });
      const oldMux = multiplexer();
      const close = deferred<boolean>();
      oldMux.closePane.mockImplementationOnce(() => close.promise);
      new CmuxSessionLifecycle('old', oldMux, () => 'http://server', '/repo');
      await Promise.resolve();
      const newMux = multiplexer();
      newMux.closePane.mockResolvedValue(false);
      new CmuxSessionLifecycle(
        'new',
        newMux,
        () => 'http://server',
        '/repo',
        undefined,
        {
          closeRetryMaxAttempts: 1,
        },
      );
      await Promise.resolve();
      const currentIntent = store.get('race')?.closeIntent;
      close.resolve(result);
      await Promise.resolve();
      await Promise.resolve();
      expect(store.get('race')).toMatchObject({ owner: 'new', paneId: 'pane' });
      expect(store.get('race')?.closeIntent).toBe(currentIntent);
    });
  }

  for (const result of [true, false]) {
    test(`cleanup close ${result ? 'success' : 'failure'} cannot mutate a newly claimed record`, async () => {
      store.claimCreated({
        session: 'cleanup-race',
        owner: 'old',
        parent: 'p',
        title: 'agent',
        directory: '/repo',
        paneId: 'pane',
        spawnState: 'attached',
        lifecycle: 'active',
        lastActivityAt: 0,
        activityVersion: 0,
        idleConsecutive: 0,
      });
      const oldMux = multiplexer();
      const close = deferred<boolean>();
      oldMux.closePane.mockImplementationOnce(() => close.promise);
      const old = new CmuxSessionLifecycle(
        'old',
        oldMux,
        () => 'http://server',
        '/repo',
        undefined,
        { delay: async () => {} },
      );
      const cleaning = old.cleanup();
      await Promise.resolve();
      store.markOrphaned('cleanup-race');
      const newMux = multiplexer();
      newMux.closePane.mockResolvedValue(false);
      new CmuxSessionLifecycle(
        'new',
        newMux,
        () => 'http://server',
        '/repo',
        undefined,
        { closeRetryMaxAttempts: 1 },
      );
      await Promise.resolve();
      const currentIntent = store.get('cleanup-race')?.closeIntent;
      close.resolve(result);
      await cleaning;
      expect(store.get('cleanup-race')).toMatchObject({
        owner: 'new',
        paneId: 'pane',
      });
      expect(store.get('cleanup-race')?.closeIntent).toBe(currentIntent);
    });
  }

  test('late spawn does not overwrite a record claimed by a new owner', async () => {
    const oldMux = multiplexer();
    const spawn = deferred<{ success: true; paneId: string }>();
    oldMux.spawnPane.mockImplementationOnce(() => spawn.promise);
    oldMux.closePane.mockResolvedValue(false);
    const old = new CmuxSessionLifecycle(
      'old',
      oldMux,
      () => 'http://server',
      '/repo',
      undefined,
      { delay: async () => {}, isServerRunning: async () => true },
    );
    const creating = old.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'late-race', parentID: 'p' } },
    });
    await Promise.resolve();
    await old.cleanup();
    store.markOrphaned('late-race');
    const existing = store.get('late-race');
    if (existing) existing.paneId = 'new-pane';
    const newMux = multiplexer();
    newMux.closePane.mockResolvedValue(false);
    new CmuxSessionLifecycle(
      'new',
      newMux,
      () => 'http://server',
      '/repo',
      undefined,
      { closeRetryMaxAttempts: 1 },
    );
    await Promise.resolve();
    const currentIntent = store.get('late-race')?.closeIntent;
    spawn.resolve({ success: true, paneId: 'old-late-pane' });
    await creating;
    expect(store.get('late-race')).toMatchObject({
      owner: 'new',
      paneId: 'new-pane',
    });
    expect(store.get('late-race')?.closeIntent).toBe(currentIntent);
    expect(
      store.ownedBy('old').some((record) => record.paneId === 'old-late-pane'),
    ).toBe(true);
  });
});

describe('CmuxSessionLifecycle stuck detection', () => {
  const store = new CmuxSessionStore();
  beforeEach(() => store.resetForTests());

  function busyStatuses(
    ...sessions: string[]
  ): () => Promise<Record<string, { type: string }>> {
    const map: Record<string, { type: string }> = {};
    for (const s of sessions) map[s] = { type: 'busy' };
    return async () => map;
  }

  test('stuck triggers when busy with no activityVersion change for > threshold', async () => {
    let now = 0;
    const mux = multiplexer();
    const abort = mock(() => Promise.resolve());
    const markCancelled = mock(() => {});
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      () => 'http://server',
      '/repo',
      {
        deferIfRunning: () => true,
        clearDeferredClose: () => {},
        markCancelled,
      },
      {
        now: () => now,
        stuckThresholdMs: 100,
        stuckGraceMs: 10,
        client: { session: { abort } },
        isServerRunning: async () => true,
        fetchStatuses: busyStatuses('stuck-1'),
        delay: async () => {},
      },
    );
    await lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'stuck-1', parentID: 'p' } },
    });

    // First poll: snapshot stuckCheckVersion (no activity - version stays 0)
    now = 1_000;
    await lifecycle.pollOnce();
    expect(abort).not.toHaveBeenCalled();

    // Second poll past threshold + grace: version still 0, stuck detected
    now = 2_000;
    await lifecycle.pollOnce();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(mux.closePane).toHaveBeenCalledTimes(1);
    await lifecycle.cleanup();
  });

  test('stuck does NOT trigger during grace period', async () => {
    let now = 0;
    const mux = multiplexer();
    const abort = mock(() => Promise.resolve());
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        now: () => now,
        stuckThresholdMs: 100,
        stuckGraceMs: 500_000, // very long grace
        client: { session: { abort } },
        isServerRunning: async () => true,
        fetchStatuses: busyStatuses('grace'),
        delay: async () => {},
      },
    );
    await lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'grace', parentID: 'p' } },
    });

    now = 1_000;
    await lifecycle.pollOnce(); // snapshot
    now = 10_000;
    await lifecycle.pollOnce(); // past threshold, but not grace
    expect(abort).not.toHaveBeenCalled();
    await lifecycle.cleanup();
  });

  test('stuck resets when activity fires between polls', async () => {
    let now = 0;
    const mux = multiplexer();
    const abort = mock(() => Promise.resolve());
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        now: () => now,
        stuckThresholdMs: 300,
        stuckGraceMs: 10,
        client: { session: { abort } },
        isServerRunning: async () => true,
        fetchStatuses: busyStatuses('reset-me'),
        delay: async () => {},
      },
    );
    await lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'reset-me', parentID: 'p' } },
    });

    // Initial poll snapshots version
    now = 10;
    await lifecycle.pollOnce();

    // Activity fires (content event) - resets stuck state (clears
    // stuckCheckVersion + updates lastActivityAt)
    now = 20;
    await lifecycle.onSessionStatus({
      type: 'message.updated',
      properties: { sessionID: 'reset-me' },
    });

    // First poll after activity: snapshots the new version. Threshold has
    // barely elapsed (noActivityMs = 10 < 300), so no stuck.
    now = 30;
    await lifecycle.pollOnce();
    expect(abort).not.toHaveBeenCalled();

    // Second poll after activity: version still same, threshold still not
    // reached (noActivityMs = 40 - 20 = 20 < 300). No stuck.
    now = 40;
    await lifecycle.pollOnce();
    expect(abort).not.toHaveBeenCalled();

    // Enough time passes: now threshold exceeded
    now = 500;
    await lifecycle.pollOnce();
    expect(abort).toHaveBeenCalledTimes(1);
    await lifecycle.cleanup();
  });

  test('stuck does NOT trigger for idle sessions', async () => {
    let now = 0;
    const mux = multiplexer();
    const abort = mock(() => Promise.resolve());
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        now: () => now,
        stuckThresholdMs: 100,
        stuckGraceMs: 10,
        client: { session: { abort } },
        isServerRunning: async () => true,
        fetchStatuses: async () => ({ nope: { type: 'idle' } }),
        delay: async () => {},
      },
    );
    await lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'nope', parentID: 'p' } },
    });

    now = 50_000;
    await lifecycle.pollOnce();
    expect(abort).not.toHaveBeenCalled();
    await lifecycle.cleanup();
  });

  test('abort + close are invoked on a stuck session', async () => {
    let now = 0;
    const mux = multiplexer();
    const abort = mock(() => Promise.resolve());
    const markCancelled = mock(() => {});
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      () => 'http://server',
      '/repo',
      {
        deferIfRunning: () => true,
        clearDeferredClose: () => {},
        markCancelled,
      },
      {
        now: () => now,
        stuckThresholdMs: 50,
        stuckGraceMs: 10,
        client: { session: { abort } },
        isServerRunning: async () => true,
        fetchStatuses: busyStatuses('abort-me'),
        delay: async () => {},
      },
    );
    await lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'abort-me', parentID: 'p' } },
    });

    now = 500;
    await lifecycle.pollOnce(); // snapshot
    now = 10_000;
    await lifecycle.pollOnce(); // stuck triggers
    expect(abort).toHaveBeenCalledTimes(1);
    expect(mux.closePane).toHaveBeenCalledTimes(1);
    expect(markCancelled).toHaveBeenCalledWith('abort-me', 'stuck');
    expect(store.get('abort-me')?.stuckDetectedAt).toBe(10_000);
    await lifecycle.cleanup();
  });
});
