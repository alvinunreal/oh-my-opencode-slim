import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from './board';
import {
  type BackgroundJobStorageBackend,
  clearSuppression,
  configureBackgroundJobPersistence,
  getSuppressionTombstone,
  loadInitialBackgroundJobPersistence,
  MAX_PERSISTED_TOMBSTONES,
  recordSuppression,
} from './persistence';

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
    const ledger = freshBoard.ledger;
    expect(ledger.tombstones.has('ses_roundtrip')).toBe(true);
    expect(ledger.deletionEpochs.get('ses_roundtrip')).toBe(1);
    // Next recorded epoch stays monotonic past the restored one.
    freshBoard.recordSuppression('ses_next');
    expect(ledger.deletionEpochs.get('ses_next')).toBe(2);
  });

  test('tombstone terminal result survives a simulated restart', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    recordSuppression('ses_terminal', 1, {
      state: 'completed',
      resultSummary: 'the answer is 42',
    });
    await flushWrites();
    expect(getSuppressionTombstone('ses_terminal')?.terminalState).toBe(
      'completed',
    );
    // Full-field fixture: any field the load path drops breaks the
    // equality below, regardless of which fields the assertions name.
    const before = getSuppressionTombstone('ses_terminal');

    // Simulated restart: same backend, fresh module state. The load path
    // must carry the persisted terminal result through, or a post-restart
    // task_revive cannot recognize the completed work.
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    expect(getSuppressionTombstone('ses_terminal')).toEqual(before);
  });

  test('a malformed persisted terminal payload is dropped wholesale on load', async () => {
    const { backend, map } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    recordSuppression('ses_half', 3, {
      state: 'completed',
      resultSummary: 'will be corrupted',
    });
    await flushWrites();
    // Corrupt the persisted tombstone entry: a terminal state without a
    // result summary. The load sanitizer must drop the pair wholesale —
    // the consumer contract is all-or-nothing.
    for (const [entryKey, entryValue] of map) {
      if (entryKey.includes('ses_half') && typeof entryValue === 'object') {
        map.set(entryKey, {
          taskID: 'ses_half',
          epoch: 3,
          recordedAt: 1,
          terminalState: 'completed',
        });
      }
    }

    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const tombstone = getSuppressionTombstone('ses_half');
    expect(tombstone?.epoch).toBe(3);
    expect(tombstone?.terminalState).toBeUndefined();
    expect(tombstone?.resultSummary).toBeUndefined();
  });

  test('clear-on-relaunch write-through removes the persisted tombstone but keeps the epoch', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const board = new BackgroundJobBoard();
    board.recordSuppression('ses_relaunch');
    expect(board.ledger.tombstones.has('ses_relaunch')).toBe(true);
    await flushWrites();

    board.clearSuppression('ses_relaunch');
    await flushWrites();

    // Simulated restart: the relaunch must NOT be ghost-skipped, but its
    // deletion epoch survives for generation fencing.
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    const freshLedger = new BackgroundJobBoard().ledger;
    expect(freshLedger.tombstones.has('ses_relaunch')).toBe(false);
    expect(freshLedger.deletionEpochs.get('ses_relaunch')).toBe(1);
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

  test('storage-absent fallback: pure memory, zero behavior change', async () => {
    configureBackgroundJobPersistence(undefined);

    expect(() => {
      recordSuppression('ses_fallback', 1);
      clearSuppression('ses_fallback');
    }).not.toThrow();
    await flushWrites();

    // No backend → nothing is seeded into fresh boards or ledgers.
    const board = new BackgroundJobBoard();
    const record = board.registerLaunch({
      taskID: 'ses_fresh',
      parentSessionID: 'parent-fallback',
      agent: 'fixer',
      description: 'fresh',
    });
    expect(record.alias).toBe('fix-1');
    expect(board.ledger.tombstones.size).toBe(0);
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
