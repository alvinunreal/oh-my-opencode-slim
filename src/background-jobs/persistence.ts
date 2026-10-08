/**
 * Persistence for background-job lifecycle state (tombstones and
 * deletion epochs) over the optional v2 host storage domain
 * (`ctx.storage`).
 *
 * Design invariants:
 * - **Write-through.** `recordSuppression` / `clearSuppression`
 *   (ledger.ts) call this module on every mutation so the persisted state tracks the in-process
 *   ledger. Writes are queued fire-and-forget: a crash between the
 *   in-memory mutation and the queue flush loses that persisted entry —
 *   an accepted degradation to process-local behavior. A task deleted and
 *   then legitimately
 *   relaunched must NOT be ghost-skipped after a restart — clearing the
 *   tombstone on relaunch is load-bearing (the deletion EPOCH survives a
 *   clear so generation fencing keeps working).
 * - **Seeding is backend-only.** Fresh boards/ledgers seed from what a
 *   real backend returned via `loadInitialBackgroundJobPersistence`.
 *   Without a backend (v1 hosts, hosts without the domain) the module is
 *   a pure in-memory no-op sink: zero behavior change, and no
 *   cross-board contamination inside one process.
 * - **Bounded growth.** Persisted tombstones (and their epoch entries)
 *   are capped at `MAX_PERSISTED_TOMBSTONES` most-recent by recorded
 *   time. Evicting an ancient tombstone can at worst resurrect an
 *   equally ancient deleted run — the same trade a fresh process makes
 *   today.
 * - **Serialized writes.** Every storage mutation for one key is chained
 *   through an in-process queue, so concurrent callers never race a
 *   read-modify-write on the same key. Queued writes are also fenced
 *   across reconfigurations: a write enqueued before a configure() call
 *   refuses to execute afterwards, so it can never land on — and reorder
 *   against new-epoch writes on — the replacement backend. Writes are
 *   fire-and-forget with logged (never thrown) failures — persistence
 *   loss degrades to today's process-local behavior.
 *
 * Aliases are not persisted: a production board numbers only parents
 * created while it runs, and an old alias resolves only through its
 * marker in the parent's history (see docs/background-orchestration.md).
 */

import { log } from '../utils/logger';

/** Subset of the v2 `StorageDomain` this module consumes (see
 * `V2Context['storage']` in src/v2/types.ts). */
export interface BackgroundJobStorageBackend {
  get(key: string): Promise<unknown> | unknown;
  set(key: string, value: unknown): Promise<unknown> | unknown;
  remove(key: string): Promise<unknown> | unknown;
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: Array<{ key: string; value: unknown }>;
    next?: string;
  }>;
}

const KEY_ROOT = 'omo/bgj/';
const TOMBSTONE_PREFIX = `${KEY_ROOT}tombstone/`;
const EPOCH_PREFIX = `${KEY_ROOT}epoch/`;

/** Persisted tombstone entries self-cap at this many most-recent items. */
export const MAX_PERSISTED_TOMBSTONES = 500;

/** Defensive bound on scan pagination (a corrupted cursor loop). */
const MAX_SCAN_PAGES = 10_000;

export interface PersistedTombstoneEntry {
  taskID: string;
  epoch: number;
  recordedAt: number;
  /** Terminal state recorded when an evicted task had already ended with a
   * result, so a post-restart task_revive can surface the recorded result
   * instead of re-prompting the child. */
  terminalState?: 'completed' | 'error' | 'cancelled';
  resultSummary?: string;
}

export interface PersistedBackgroundJobState {
  /** taskID → persisted tombstone entry (currently suppressed runs). */
  tombstones: Map<string, PersistedTombstoneEntry>;
  /** taskID → deletion epoch (survives clear-on-relaunch). */
  deletionEpochs: Map<string, number>;
  /** Highest deletion epoch seen; keeps future epochs monotonic. */
  nextEpoch: number;
}

function emptyState(): PersistedBackgroundJobState {
  return {
    tombstones: new Map(),
    deletionEpochs: new Map(),
    nextEpoch: 0,
  };
}

let backend: BackgroundJobStorageBackend | undefined;
/** State loaded from a real backend; the only seed source. */
let loaded = emptyState();
/** Live tombstone bookkeeping for cap enforcement (loaded ∪ recorded). */
const liveTombstones = new Map<string, PersistedTombstoneEntry>();
/** Per-key serialized write queues (no concurrent RMW on one key). */
const writeQueues = new Map<string, Promise<void>>();
/**
 * Reconfiguration fence: incremented on every configure() call. Queued
 * writes capture the epoch at enqueue time and refuse to execute after a
 * reconfiguration — an already-scheduled promise chain would otherwise
 * read the module-global backend at execution time and land a stale
 * write on the NEW backend, reordering against new-epoch writes for the
 * same key (e.g. resurrecting a tombstone a newer clear removed).
 */
let configEpoch = 0;

function enqueueWrite(key: string, op: () => Promise<void>): void {
  const epochAtEnqueue = configEpoch;
  const prior = writeQueues.get(key) ?? Promise.resolve();
  const next = prior
    .then(() => {
      if (epochAtEnqueue !== configEpoch) {
        // Refuse to run: the new epoch's writes own the state now.
        log(
          '[background-job-persistence] discarded stale persistence write across reconfiguration',
          { key },
        );
        return;
      }
      return op();
    })
    .catch((err) => {
      log('[background-job-persistence] write failed', {
        key,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  writeQueues.set(key, next);
  void next.then(() => {
    if (writeQueues.get(key) === next) writeQueues.delete(key);
  });
}

/**
 * Configure the persistence sink. `undefined` (or an absent call — the v1
 * default) selects the pure memory fallback: writes become no-ops and
 * nothing is ever seeded. Re-configuring resets all module state; callers
 * simulating a restart re-configure and then `await
 * loadInitialBackgroundJobPersistence()`.
 */
export function configureBackgroundJobPersistence(
  storage: BackgroundJobStorageBackend | undefined,
): void {
  // Fence off every write queued by the previous epoch before swapping
  // the backend: queued ops compare their captured epoch against the new
  // one and refuse to execute (see enqueueWrite).
  configEpoch += 1;
  backend = storage;
  loaded = emptyState();
  liveTombstones.clear();
  writeQueues.clear();
}

function tombstoneKey(taskID: string): string {
  return `${TOMBSTONE_PREFIX}${taskID}`;
}

function epochKey(taskID: string): string {
  return `${EPOCH_PREFIX}${taskID}`;
}

/**
 * Scan the storage backend (following the paginated `next` cursor) into
 * the module's seed state. No backend → returns empty state and seeds
 * nothing. The returned snapshot is the same object later boards/ledgers
 * seed from.
 */
export async function loadInitialBackgroundJobPersistence(): Promise<PersistedBackgroundJobState> {
  if (!backend) {
    loaded = emptyState();
    return loaded;
  }

  const state = emptyState();
  let after: string | undefined;
  let pages = 0;
  do {
    const page = await backend.scan({ prefix: KEY_ROOT, after, limit: 200 });
    for (const entry of page.entries) {
      if (entry.key.startsWith(TOMBSTONE_PREFIX)) {
        const value = entry.value as Partial<PersistedTombstoneEntry>;
        if (
          typeof value?.taskID === 'string' &&
          typeof value?.epoch === 'number' &&
          Number.isFinite(value.epoch)
        ) {
          // Passthrough + validation: the load must mirror the write shape,
          // so new persisted fields survive by construction; validation
          // only rejects bad values — it never selects fields (a whitelist
          // silently drops fields added to the write path).
          const record: PersistedTombstoneEntry = {
            ...value,
            taskID: value.taskID,
            epoch: value.epoch,
            recordedAt:
              typeof value.recordedAt === 'number' &&
              Number.isFinite(value.recordedAt)
                ? value.recordedAt
                : 0,
          };
          if (
            !(
              (record.terminalState === 'completed' ||
                record.terminalState === 'error' ||
                record.terminalState === 'cancelled') &&
              typeof record.resultSummary === 'string' &&
              record.resultSummary
            )
          ) {
            delete record.terminalState;
            delete record.resultSummary;
          }
          state.tombstones.set(record.taskID, record);
          state.deletionEpochs.set(record.taskID, record.epoch);
        }
      } else if (entry.key.startsWith(EPOCH_PREFIX)) {
        const taskID = entry.key.slice(EPOCH_PREFIX.length);
        if (typeof entry.value === 'number' && Number.isFinite(entry.value)) {
          state.deletionEpochs.set(taskID, entry.value);
        }
      }
    }
    after = page.next;
    pages += 1;
  } while (after !== undefined && pages < MAX_SCAN_PAGES);

  state.nextEpoch = Math.max(0, ...state.deletionEpochs.values(), 0);
  for (const record of state.tombstones.values()) {
    liveTombstones.set(record.taskID, record);
  }
  loaded = state;
  return state;
}

/** Seed snapshot for fresh boards/ledgers (backend-loaded state only). */
export function persistedBackgroundJobState(): PersistedBackgroundJobState {
  return loaded;
}

/**
 * Record a suppression tombstone (write-through from
 * `recordSuppression`). The epoch comes from the ledger so
 * in-memory and persisted epochs stay identical.
 */
export function recordSuppression(
  taskID: string,
  epoch?: number,
  terminal?: {
    state: 'completed' | 'error' | 'cancelled';
    resultSummary: string;
  },
): void {
  const effectiveEpoch = epoch ?? nextFreeEpoch();
  const record: PersistedTombstoneEntry = {
    taskID,
    epoch: effectiveEpoch,
    recordedAt: Date.now(),
    ...(terminal
      ? { terminalState: terminal.state, resultSummary: terminal.resultSummary }
      : {}),
  };
  liveTombstones.set(taskID, record);
  enforceTombstoneCap();

  if (!backend) return;
  enqueueWrite(tombstoneKey(taskID), async () => {
    await backend?.set(tombstoneKey(taskID), { ...record });
  });
  enqueueWrite(epochKey(taskID), async () => {
    await backend?.set(epochKey(taskID), effectiveEpoch);
  });
}

/** Epoch suggestion when no ledger epoch was supplied. */
function nextFreeEpoch(): number {
  let max = loaded.nextEpoch;
  for (const record of liveTombstones.values()) {
    if (record.epoch > max) max = record.epoch;
  }
  return max + 1;
}

/**
 * Clear the suppression tombstone (write-through from
 * `clearBackgroundJobSuppression`). The deletion EPOCH is deliberately
 * kept — a relaunch must not be ghost-skipped after a restart, but its
 * generation fencing must survive.
 */
export function clearSuppression(taskID: string): void {
  liveTombstones.delete(taskID);
  if (!backend) return;
  enqueueWrite(tombstoneKey(taskID), async () => {
    await backend?.remove(tombstoneKey(taskID));
  });
}

/** Read a persisted suppression tombstone (hydrated at load, maintained by
 * record/clear). Terminal-result entries let a post-restart task_revive
 * surface the recorded result instead of re-prompting the child. */
export function getSuppressionTombstone(
  taskID: string,
): PersistedTombstoneEntry | undefined {
  return liveTombstones.get(taskID);
}

function enforceTombstoneCap(): void {
  if (liveTombstones.size <= MAX_PERSISTED_TOMBSTONES) return;
  const ordered = [...liveTombstones.values()].sort(
    (left, right) => left.recordedAt - right.recordedAt,
  );
  const evict = ordered.slice(
    0,
    liveTombstones.size - MAX_PERSISTED_TOMBSTONES,
  );
  for (const record of evict) {
    liveTombstones.delete(record.taskID);
  }
  if (!backend) return;
  for (const record of evict) {
    enqueueWrite(tombstoneKey(record.taskID), async () => {
      await backend?.remove(tombstoneKey(record.taskID));
    });
    enqueueWrite(epochKey(record.taskID), async () => {
      await backend?.remove(epochKey(record.taskID));
    });
  }
}
