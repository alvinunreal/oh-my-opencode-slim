import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
  BackgroundJobBoard,
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
