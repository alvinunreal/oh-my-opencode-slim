import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from './background-job-fixture';
import {
  aliasHighWaterMark,
  type BackgroundJobStorageBackend,
  bumpAliasHighWaterMark,
  clearSuppression,
  configureBackgroundJobPersistence,
  loadInitialBackgroundJobPersistence,
  MAX_PERSISTED_TOMBSTONES,
  recordSuppression,
} from './background-job-persistence';
import {
  clearBackgroundJobSuppression,
  getBackgroundJobLifecycleLedger,
  recordBackgroundJobSuppression,
} from './index';

/** In-memory v2-storage backend double with cursor pagination. */
function createMemoryBackend() {
  const map = new Map<string, unknown>();
  const backend: BackgroundJobStorageBackend = {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    remove: async (key) => {
      map.delete(key);
    },
    scan: async (options) => {
      const keys = [...map.keys()]
        .filter(
          (key) =>
            key.startsWith(options.prefix) &&
            (options.after === undefined || key > options.after),
        )
        .sort();
      const limit = options.limit ?? 1000;
      const page = keys.slice(0, limit);
      const next = keys.length > limit ? page[page.length - 1] : undefined;
      return {
        entries: page.map((key) => ({ key, value: map.get(key) })),
        next,
      };
    },
  };
  return { backend, map };
}

/** Flush serialized fire-and-forget persistence writes. */
function flushWrites() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/** Manually-resolved promise for holding queued writes in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('background-job persistence', () => {
  beforeEach(() => {
    configureBackgroundJobPersistence(undefined);
  });

  afterEach(() => {
    configureBackgroundJobPersistence(undefined);
  });

  test('tombstone round-trips across a simulated restart and seeds a fresh ledger', async () => {
    const { backend, map } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    recordSuppression('ses_roundtrip', 1);
    await flushWrites();
    expect([...map.keys()].some((key) => key.includes('ses_roundtrip'))).toBe(
      true,
    );

    // Simulated restart: same backend, fresh module + fresh board/ledger.
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const freshBoard = new BackgroundJobBoard();
    const ledger = getBackgroundJobLifecycleLedger(freshBoard);
    expect(ledger.tombstones.has('ses_roundtrip')).toBe(true);
    expect(ledger.deletionEpochs.get('ses_roundtrip')).toBe(1);
    // Next recorded epoch stays monotonic past the restored one.
    recordBackgroundJobSuppression(freshBoard, 'ses_next');
    expect(ledger.deletionEpochs.get('ses_next')).toBe(2);
  });

  test('count trim survives restart and permits only verified matching re-adoption', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    const board = new BackgroundJobBoard({ maxReusablePerAgent: 1 });
    const launch = (taskID: string, now: number) => {
      const job = board.registerLaunch({
        taskID,
        parentSessionID: 'parent',
        agent: 'fixer',
        description: 'verified job',
        background: true,
        now,
      });
      board.updateStatus({ taskID, state: 'completed', now: now + 1 });
      board.markReconciled(taskID, now + 2);
      return job;
    };
    const first = launch('trimmed', 100);
    launch('retained', 200);
    expect(board.get(first.taskID)).toBeUndefined();
    await flushWrites();

    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    const restarted = new BackgroundJobBoard({ maxReusablePerAgent: 1 });
    const ledger = getBackgroundJobLifecycleLedger(restarted);
    const identity = {
      taskID: first.taskID,
      parentSessionID: 'parent',
      agent: 'fixer',
      alias: first.alias,
      description: 'verified job',
      background: true,
    } as const;
    const evidence = {
      kind: 'terminal',
      state: 'completed',
      resultSummary: 'verified result',
      completedAt: 101,
      acknowledged: true,
    } as const;
    expect(ledger.trimmedIdentities.get(first.taskID)?.alias).toBe(first.alias);
    for (const mismatch of [
      { alias: 'fix-999' },
      { parentSessionID: 'other' },
    ]) {
      expect(() =>
        restarted.adoptExistingSession({ ...identity, ...mismatch }, evidence),
      ).toThrow('suppressed');
    }
    const adopted = restarted.adoptExistingSession(identity, evidence);
    expect(adopted).toMatchObject({
      state: 'reconciled',
      terminalState: 'completed',
      resultSummary: 'verified result',
      completedAt: 101,
      terminalRevision: 1,
    });
    expect(ledger.tombstones.has(first.taskID)).toBe(true);
    const epoch = ledger.deletionEpochs.get(first.taskID);
    expect(restarted.adoptExistingSession(identity, evidence)).toBe(adopted);
    expect(ledger.deletionEpochs.get(first.taskID)).toBe(epoch);
    restarted.drop(first.taskID);
    expect(ledger.deletionEpochs.get(first.taskID)).toBeGreaterThan(epoch ?? 0);
    await flushWrites();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    const afterDeletion = new BackgroundJobBoard();
    expect(() =>
      afterDeletion.adoptExistingSession(identity, evidence),
    ).toThrow('suppressed');
  });

  test('context trim retains its reuse cap after restart; live adoption adds no terminal evidence', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    const options = { maxContextLines: 5, readContextMinLines: 1 };
    const board = new BackgroundJobBoard(options);
    const job = board.registerLaunch({
      taskID: 'context-trimmed',
      parentSessionID: 'parent',
      agent: 'fixer',
      background: true,
      now: 100,
    });
    board.addContext(job.taskID, [
      { path: 'big.ts', lineCount: 10, lastReadAt: 100 },
    ]);
    board.updateStatus({ taskID: job.taskID, state: 'completed', now: 110 });
    board.markReconciled(job.taskID, 120);
    expect(board.get(job.taskID)).toBeUndefined();
    await flushWrites();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    const restarted = new BackgroundJobBoard(options);
    const identity = {
      taskID: job.taskID,
      parentSessionID: 'parent',
      agent: 'fixer',
      alias: job.alias,
      background: true,
    } as const;
    const adopted = restarted.adoptExistingSession(identity, {
      kind: 'terminal',
      state: 'completed',
      resultSummary: 'host result',
      completedAt: 110,
      acknowledged: true,
    });
    expect(adopted.contextFiles).toEqual([
      { path: 'big.ts', lineCount: 10, lastReadAt: 100 },
    ]);
    expect(restarted.resolveReusable('parent', job.alias)).toBeUndefined();

    const sameTrim = new BackgroundJobBoard(options);
    const live = sameTrim.adoptExistingSession(identity, {
      kind: 'live',
      observedBusyAt: 200,
    });
    expect(live).toMatchObject({
      state: 'running',
      terminalState: undefined,
      resultSummary: undefined,
      completedAt: undefined,
      terminalRevision: 0,
    });

    restarted.drop(job.taskID);
    await flushWrites();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    expect(() =>
      new BackgroundJobBoard().adoptExistingSession(identity, {
        kind: 'live',
        observedBusyAt: 200,
      }),
    ).toThrow('suppressed');
  });

  test('deleted parent overrides a persisted trim even when no job is loaded', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    const board = new BackgroundJobBoard({ maxReusablePerAgent: 0 });
    const job = board.registerLaunch({
      taskID: 'trimmed-parent',
      parentSessionID: 'parent',
      agent: 'fixer',
      background: true,
      now: 100,
    });
    board.updateStatus({ taskID: job.taskID, state: 'completed', now: 110 });
    board.markReconciled(job.taskID, 120);
    await flushWrites();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    const restarted = new BackgroundJobBoard();
    const oldEpoch = getBackgroundJobLifecycleLedger(
      restarted,
    ).deletionEpochs.get(job.taskID);
    restarted.clearParent('parent');
    expect(
      getBackgroundJobLifecycleLedger(restarted).deletionEpochs.get(job.taskID),
    ).toBeGreaterThan(oldEpoch ?? 0);
    await flushWrites();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    expect(() =>
      new BackgroundJobBoard().adoptExistingSession(
        {
          taskID: job.taskID,
          parentSessionID: 'parent',
          agent: 'fixer',
          alias: job.alias,
          background: true,
        },
        { kind: 'live', observedBusyAt: 200 },
      ),
    ).toThrow('suppressed');
  });

  test('legacy untyped and malformed trim tombstones fail closed', async () => {
    const { backend, map } = createMemoryBackend();
    const identity = {
      taskID: 'legacy',
      parentSessionID: 'parent',
      agent: 'fixer',
      alias: 'fix-1',
      background: true,
    } as const;
    map.set('omo/bgj/tombstone/legacy', {
      taskID: 'legacy',
      epoch: 7,
      recordedAt: 100,
    });
    map.set('omo/bgj/tombstone/malformed', {
      taskID: 'malformed',
      epoch: 8,
      recordedAt: 101,
      reason: 'trim',
      trimmedIdentity: { ...identity, contextFiles: 'invalid' },
    });
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    const board = new BackgroundJobBoard();
    for (const taskID of ['legacy', 'malformed']) {
      expect(() =>
        board.adoptExistingSession(
          { ...identity, taskID },
          {
            kind: 'live',
            observedBusyAt: 200,
          },
        ),
      ).toThrow('suppressed');
    }
    expect(getBackgroundJobLifecycleLedger(board).nextEpoch).toBe(8);
  });

  test('a newer deletion epoch fences a stale trim tombstone', async () => {
    const { backend, map } = createMemoryBackend();
    map.set('omo/bgj/tombstone/stale-trim', {
      taskID: 'stale-trim',
      epoch: 3,
      recordedAt: 100,
      reason: 'trim',
      trimmedIdentity: {
        parentSessionID: 'parent',
        agent: 'fixer',
        alias: 'fix-1',
        background: true,
        description: 'task',
        contextFiles: [],
      },
    });
    map.set('omo/bgj/epoch/stale-trim', 4);
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    const board = new BackgroundJobBoard();
    const ledger = getBackgroundJobLifecycleLedger(board);
    expect(ledger.deletionEpochs.get('stale-trim')).toBe(4);
    expect(ledger.trimmedIdentities.has('stale-trim')).toBe(false);
    expect(() =>
      board.adoptExistingSession(
        {
          taskID: 'stale-trim',
          parentSessionID: 'parent',
          agent: 'fixer',
          alias: 'fix-1',
          background: true,
        },
        { kind: 'live', observedBusyAt: 200 },
      ),
    ).toThrow('suppressed');
  });

  test('clear-on-relaunch write-through removes the persisted tombstone but keeps the epoch', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const board = new BackgroundJobBoard();
    recordBackgroundJobSuppression(board, 'ses_relaunch');
    expect(
      getBackgroundJobLifecycleLedger(board).tombstones.has('ses_relaunch'),
    ).toBe(true);
    await flushWrites();

    clearBackgroundJobSuppression(board, 'ses_relaunch');
    await flushWrites();

    // Simulated restart: the relaunch must NOT be ghost-skipped, but its
    // deletion epoch survives for generation fencing.
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    const freshLedger = getBackgroundJobLifecycleLedger(
      new BackgroundJobBoard(),
    );
    expect(freshLedger.tombstones.has('ses_relaunch')).toBe(false);
    expect(freshLedger.deletionEpochs.get('ses_relaunch')).toBe(1);
  });

  test('alias counters never reuse a historical alias across a simulated restart', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const firstBoard = new BackgroundJobBoard();
    const a = firstBoard.registerLaunch({
      taskID: 'ses_a',
      parentSessionID: 'parent-alias',
      agent: 'fixer',
      description: 'first',
    });
    const b = firstBoard.registerLaunch({
      taskID: 'ses_b',
      parentSessionID: 'parent-alias',
      agent: 'fixer',
      description: 'second',
    });
    expect(a.alias).toBe('fix-1');
    expect(b.alias).toBe('fix-2');
    await flushWrites();

    // Simulated restart: fresh board seeds from the persisted high-water
    // mark; the alias MAPPING is not restored (old ids resolve not-found),
    // but no NEW alias collides with a historical one.
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    expect(aliasHighWaterMark('parent-alias', 'fix')).toBe(2);

    const restarted = new BackgroundJobBoard();
    const c = restarted.registerLaunch({
      taskID: 'ses_c',
      parentSessionID: 'parent-alias',
      agent: 'fixer',
      description: 'third',
    });
    expect(c.alias).toBe('fix-3');
  });

  test('two concurrently-live boards sharing a prefix never reuse an alias', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const boardA = new BackgroundJobBoard();
    expect(
      boardA.registerLaunch({
        taskID: 'ses_live_a1',
        parentSessionID: 'parent-live',
        agent: 'fixer',
        description: 'a1',
      }).alias,
    ).toBe('fix-1');
    expect(
      boardA.registerLaunch({
        taskID: 'ses_live_a2',
        parentSessionID: 'parent-live',
        agent: 'fixer',
        description: 'a2',
      }).alias,
    ).toBe('fix-2');
    await flushWrites();

    // A second LIVE board in the same process must seed from the live
    // high-water max (writtenAliasMax), not only the backend snapshot
    // frozen at configure time — otherwise it would hand out fix-1 again.
    const boardB = new BackgroundJobBoard();
    expect(
      boardB.registerLaunch({
        taskID: 'ses_live_b1',
        parentSessionID: 'parent-live',
        agent: 'fixer',
        description: 'b1',
      }).alias,
    ).toBe('fix-3');
  });

  test('writes queued before a reconfiguration never land on the new backend', async () => {
    const gate = deferred<void>();
    const { backend: backendA, map: mapA } = createMemoryBackend();
    const gatedA: BackgroundJobStorageBackend = {
      ...backendA,
      set: (key, value) => gate.promise.then(() => backendA.set(key, value)),
      remove: (key) => gate.promise.then(() => backendA.remove(key)),
    };
    configureBackgroundJobPersistence(gatedA);
    await loadInitialBackgroundJobPersistence();

    // Tombstone + epoch writes queue behind the gate (old epoch).
    recordSuppression('ses_stale_cross', 1);

    const { backend: backendB, map: mapB } = createMemoryBackend();
    configureBackgroundJobPersistence(backendB);
    await loadInitialBackgroundJobPersistence();

    gate.resolve();
    await flushWrites();

    // The stale queued op is discarded, not executed: it touches neither
    // the old backend (refuse-to-run) nor — critically — the new one.
    expect(
      [...mapA.keys()].some((key) => key.includes('ses_stale_cross')),
    ).toBe(false);
    expect(
      [...mapB.keys()].some((key) => key.includes('ses_stale_cross')),
    ).toBe(false);

    // New-epoch writes on the new backend work normally.
    recordSuppression('ses_fresh_cross', 2);
    await flushWrites();
    expect(
      [...mapB.keys()].some((key) => key.includes('ses_fresh_cross')),
    ).toBe(true);
  });

  test('alias high-water marks never regress on concurrent bumps', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    bumpAliasHighWaterMark('parent-race', 'fix', 5);
    bumpAliasHighWaterMark('parent-race', 'fix', 3); // stale writer
    await flushWrites();

    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    expect(aliasHighWaterMark('parent-race', 'fix')).toBe(5);
  });

  test('storage-absent fallback: pure memory, zero behavior change', async () => {
    configureBackgroundJobPersistence(undefined);

    expect(() => {
      recordSuppression('ses_fallback', 1);
      clearSuppression('ses_fallback');
      bumpAliasHighWaterMark('parent-fallback', 'fix', 7);
    }).not.toThrow();
    await flushWrites();

    // No backend → nothing is seeded into fresh boards or ledgers and
    // alias numbering restarts from 1 exactly as before persistence.
    expect(aliasHighWaterMark('parent-fallback', 'fix')).toBe(0);
    const board = new BackgroundJobBoard();
    const record = board.registerLaunch({
      taskID: 'ses_fresh',
      parentSessionID: 'parent-fallback',
      agent: 'fixer',
      description: 'fresh',
    });
    expect(record.alias).toBe('fix-1');
    expect(getBackgroundJobLifecycleLedger(board).tombstones.size).toBe(0);
  });

  test('tombstone entries self-cap at the recorded-time bound', async () => {
    const { backend, map } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    for (let i = 0; i <= MAX_PERSISTED_TOMBSTONES + 2; i += 1) {
      recordSuppression(`ses_cap_${String(i).padStart(4, '0')}`, i + 1);
    }
    await flushWrites();

    const tombstoneKeys = [...map.keys()].filter((key) =>
      key.includes('tombstone'),
    );
    expect(tombstoneKeys.length).toBeLessThanOrEqual(MAX_PERSISTED_TOMBSTONES);
    // The oldest entries were evicted; the newest survives.
    expect(tombstoneKeys.some((key) => key.includes('ses_cap_0000'))).toBe(
      false,
    );
    expect(
      tombstoneKeys.some((key) =>
        key.includes(
          `ses_cap_${String(MAX_PERSISTED_TOMBSTONES + 2).padStart(4, '0')}`,
        ),
      ),
    ).toBe(true);
  });

  test('loadInitial follows the paginated scan cursor', async () => {
    const { backend, map } = createMemoryBackend();
    // Page size 3 forces cursor pagination across the seeded entries.
    const paged: BackgroundJobStorageBackend = {
      get: backend.get,
      set: backend.set,
      remove: backend.remove,
      scan: async (options) => {
        const keys = [...map.keys()]
          .filter(
            (key) =>
              key.startsWith(options.prefix) &&
              (options.after === undefined || key > options.after),
          )
          .sort();
        const limit = 3;
        const page = keys.slice(0, limit);
        const next = keys.length > limit ? page[page.length - 1] : undefined;
        return {
          entries: page.map((key) => ({ key, value: map.get(key) })),
          next,
        };
      },
    };
    configureBackgroundJobPersistence(paged);
    await loadInitialBackgroundJobPersistence();

    for (let i = 0; i < 7; i += 1) {
      recordSuppression(`ses_page_${i}`, i + 1);
    }
    await flushWrites();

    configureBackgroundJobPersistence(paged);
    const snapshot = await loadInitialBackgroundJobPersistence();
    expect(snapshot.tombstones.size).toBe(7);
    expect(snapshot.nextEpoch).toBe(7);
  });
});
