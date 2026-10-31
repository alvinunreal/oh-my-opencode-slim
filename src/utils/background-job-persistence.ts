/**
 * Persistence for background-job lifecycle state (tombstones and
 * deletion epochs) over the optional v2 host storage domain
 * (`ctx.storage`).
 *
 * Design invariants:
 * - **Write-through.** `recordBackgroundJobSuppression` /
 *   `clearBackgroundJobSuppression` (background-job-board.ts) call this
 *   module on every mutation so the persisted state tracks the in-process
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

import { log } from './logger';

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
const CHILD_PREFIX = `${KEY_ROOT}child/`;

/** Persisted tombstone entries self-cap at this many most-recent items. */
export const MAX_PERSISTED_TOMBSTONES = 500;
/** Persisted owned-child identities self-cap at this many newest launches. */
export const MAX_PERSISTED_CHILDREN = 500;

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

/**
 * Minimal plugin-owned child identity persisted across restarts. Carries
 * exactly what startup recovery needs to re-adopt a background child when
 * the host exposes no session listing: ownership, display fields, launch
 * time, and whether the terminal outcome was already delivered.
 */
export interface PersistedBackgroundChild {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description: string;
  objective?: string;
  /** Per-run launch fence. On relaunch this advances to the current
   * execution's start; the board keeps the historical first launch in its
   * own record. Delivery acknowledgements must match this value. */
  launchedAt: number;
  background: true;
  /** Set after a terminal outcome was published to the parent. */
  deliveredAt?: number;
}

export interface PersistedBackgroundJobState {
  /** taskID → persisted tombstone entry (currently suppressed runs). */
  tombstones: Map<string, PersistedTombstoneEntry>;
  /** taskID → persisted plugin-owned background child identity. */
  children: Map<string, PersistedBackgroundChild>;
  /** taskID → deletion epoch (survives clear-on-relaunch). */
  deletionEpochs: Map<string, number>;
  /** Highest deletion epoch seen; keeps future epochs monotonic. */
  nextEpoch: number;
}

function emptyState(): PersistedBackgroundJobState {
  return {
    tombstones: new Map(),
    children: new Map(),
    deletionEpochs: new Map(),
    nextEpoch: 0,
  };
}

let backend: BackgroundJobStorageBackend | undefined;
/** State loaded from a real backend; the only seed source. */
let loaded = emptyState();
/** Live tombstone bookkeeping for cap enforcement (loaded ∪ recorded). */
const liveTombstones = new Map<string, PersistedTombstoneEntry>();
/** Live owned-child identities for cap enforcement (loaded ∪ recorded). */
const liveChildren = new Map<string, PersistedBackgroundChild>();
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
  liveChildren.clear();
  writeQueues.clear();
}

function tombstoneKey(taskID: string): string {
  return `${TOMBSTONE_PREFIX}${taskID}`;
}

function epochKey(taskID: string): string {
  return `${EPOCH_PREFIX}${taskID}`;
}

function parsePersistedChild(
  value: unknown,
): PersistedBackgroundChild | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Partial<PersistedBackgroundChild>;
  if (
    typeof record.taskID !== 'string' ||
    !record.taskID ||
    typeof record.parentSessionID !== 'string' ||
    !record.parentSessionID ||
    typeof record.agent !== 'string' ||
    !record.agent ||
    record.background !== true ||
    typeof record.launchedAt !== 'number' ||
    !Number.isFinite(record.launchedAt)
  ) {
    return undefined;
  }
  return {
    taskID: record.taskID,
    parentSessionID: record.parentSessionID,
    agent: record.agent,
    description:
      typeof record.description === 'string' ? record.description : '',
    ...(typeof record.objective === 'string'
      ? { objective: record.objective }
      : {}),
    launchedAt: record.launchedAt,
    background: true,
    ...(typeof record.deliveredAt === 'number' &&
    Number.isFinite(record.deliveredAt)
      ? { deliveredAt: record.deliveredAt }
      : {}),
  };
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
      } else if (entry.key.startsWith(CHILD_PREFIX)) {
        const child = parsePersistedChild(entry.value);
        if (child) state.children.set(child.taskID, child);
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
  for (const child of state.children.values()) {
    liveChildren.set(child.taskID, child);
  }
  loaded = state;
  enforceChildCap();
  // Keep the seed snapshot identical to the live capped set: a backend
  // written by an older build may exceed the cap, and consumers must never
  // observe entries the cap just evicted.
  state.children = new Map(liveChildren);
  return state;
}

/** Seed snapshot for fresh boards/ledgers (backend-loaded state only). */
export function persistedBackgroundJobState(): PersistedBackgroundJobState {
  return loaded;
}

/**
 * Record a suppression tombstone (write-through from
 * `recordBackgroundJobSuppression`). The epoch comes from the ledger so
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
  removeChild(taskID);

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

/** Seed snapshot of owned child identities (backend-loaded state only). */
export function persistedBackgroundChildren(): ReadonlyMap<
  string,
  PersistedBackgroundChild
> {
  // Without a storage backend there is nothing durable to restore. Keep
  // in-process launches out of startup scans so tests and plugin instances
  // cannot inherit another board's live children.
  return backend ? liveChildren : new Map();
}

/**
 * Persist one plugin-owned background child identity (write-through from
 * `BackgroundJobBoard.registerLaunch`). A new launch clears any previous
 * delivery marker so the eventual terminal outcome is published once.
 * `launchedAt` must be the current execution's start (a relaunch advances
 * it); a historical first launch would let an old acknowledgement fence a
 * newer run.
 */
export function recordPersistedBackgroundChild(
  input: PersistedBackgroundChild,
  options: { preserveDelivered?: boolean } = {},
): void {
  if (!backend) return;
  const child: PersistedBackgroundChild = {
    taskID: input.taskID,
    parentSessionID: input.parentSessionID,
    agent: input.agent,
    description: input.description,
    ...(input.objective !== undefined ? { objective: input.objective } : {}),
    launchedAt: input.launchedAt,
    background: true,
  };
  const previous = liveChildren.get(child.taskID);
  if (options.preserveDelivered && previous?.deliveredAt !== undefined) {
    child.deliveredAt = previous.deliveredAt;
  }
  if (
    !child.taskID ||
    !child.parentSessionID ||
    !child.agent ||
    !Number.isFinite(child.launchedAt)
  ) {
    return;
  }
  liveChildren.set(child.taskID, child);
  enforceChildCap();
  // The incoming identity can itself be the oldest entry, so the cap may
  // have just evicted it. Writing it unconditionally would resurrect the
  // evicted run in the backend, leaving memory and backend over/divergent.
  if (!liveChildren.has(child.taskID)) return;
  enqueueWrite(childKey(child.taskID), async () => {
    await backend?.set(childKey(child.taskID), { ...child });
  });
}

/** Snapshot the live persisted identity for a launch the host may refuse. */
export function getPersistedBackgroundChild(
  taskID: string,
): PersistedBackgroundChild | undefined {
  const child = liveChildren.get(taskID);
  return child ? { ...child } : undefined;
}

/**
 * Restore a snapshot taken before a refused relaunch. `undefined` removes the
 * rejected launch's identity instead. A deletion tombstone wins: a refused
 * relaunch must not resurrect a run deleted while the admission was in flight.
 */
export function restorePersistedBackgroundChild(
  taskID: string,
  snapshot: PersistedBackgroundChild | undefined,
): void {
  if (!backend) return;
  if (liveTombstones.has(taskID)) return;
  if (snapshot === undefined) {
    removeChild(taskID);
    return;
  }
  const child = parsePersistedChild(snapshot);
  if (!child || child.taskID !== taskID) return;
  liveChildren.set(taskID, child);
  enforceChildCap();
  // The cap can evict the restored identity too; its queued delete owns the
  // key then, so never write the snapshot back over it.
  if (!liveChildren.has(taskID)) return;
  enqueueWrite(childKey(taskID), async () => {
    await backend?.set(childKey(taskID), { ...child });
  });
}

/**
 * Mark a persisted child's terminal outcome as delivered. When
 * `expectedLaunchedAt` is supplied, the marker is applied only to that
 * exact run: an acceptance that resolves after the same child relaunched
 * cannot acknowledge the newer generation.
 */
export function markPersistedBackgroundChildDelivered(
  taskID: string,
  now = Date.now(),
  expectedLaunchedAt?: number,
): boolean {
  const child = liveChildren.get(taskID);
  if (!child) return false;
  if (
    expectedLaunchedAt !== undefined &&
    child.launchedAt !== expectedLaunchedAt
  ) {
    return false;
  }
  const delivered: PersistedBackgroundChild = { ...child, deliveredAt: now };
  liveChildren.set(taskID, delivered);
  if (!backend) return true;
  enqueueWrite(childKey(taskID), async () => {
    await backend?.set(childKey(taskID), { ...delivered });
  });
  return true;
}

function removeChild(taskID: string): void {
  if (!liveChildren.delete(taskID)) return;
  if (!backend) return;
  enqueueWrite(childKey(taskID), async () => {
    await backend?.remove(childKey(taskID));
  });
}

function childKey(taskID: string): string {
  return `${CHILD_PREFIX}${taskID}`;
}

function enforceChildCap(): void {
  if (liveChildren.size <= MAX_PERSISTED_CHILDREN) return;
  const ordered = [...liveChildren.values()].sort(
    (left, right) => left.launchedAt - right.launchedAt,
  );
  const evict = ordered.slice(0, liveChildren.size - MAX_PERSISTED_CHILDREN);
  for (const child of evict) {
    liveChildren.delete(child.taskID);
  }
  if (!backend) return;
  for (const child of evict) {
    enqueueWrite(childKey(child.taskID), async () => {
      await backend?.remove(childKey(child.taskID));
    });
  }
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
