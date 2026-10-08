/**
 * Process-local lifecycle memory for the background-jobs package: one
 * ledger per board instance, owned as a readonly board field.
 *
 * These sets/maps intentionally have no count cap. Evicting an old identity
 * would turn a replay of valid history into a false negative for the current
 * generation. The ledger is process-local by design; it is not persistence.
 */

import {
  clearSuppression as clearSuppressionPersisted,
  persistedBackgroundJobState,
  recordSuppression as recordSuppressionPersisted,
} from './persistence';

export type BackgroundJobSyntheticTerminalOccurrencePhase =
  | 'observed'
  | 'processed'
  | 'ambiguous';

export interface BackgroundJobSyntheticTerminalOccurrence {
  taskID: string;
  occurrenceID: string;
  generationAtObservation?: number;
  lifecycleEpochAtObservation: number;
  phase: BackgroundJobSyntheticTerminalOccurrencePhase;
}

export interface BackgroundJobInjectedCompletionFence {
  taskID: string;
  generation: number;
  lifecycleEpoch: number;
}

export interface BackgroundJobLifecycleLedger {
  tombstones: Set<string>;
  deletionEpochs: Map<string, number>;
  injectedCompletionFences: Map<string, BackgroundJobInjectedCompletionFence>;
  syntheticTerminalOccurrences: Map<
    string,
    BackgroundJobSyntheticTerminalOccurrence
  >;
  syntheticTerminalOccurrenceOrder: string[];
  processedInjectedCompletions: Set<string>;
  processedInjectedCompletionOrder: string[];
  nextEpoch: number;
}

export function createLifecycleLedger(): BackgroundJobLifecycleLedger {
  const ledger: BackgroundJobLifecycleLedger = {
    tombstones: new Set<string>(),
    deletionEpochs: new Map<string, number>(),
    injectedCompletionFences: new Map(),
    syntheticTerminalOccurrences: new Map(),
    syntheticTerminalOccurrenceOrder: [],
    processedInjectedCompletions: new Set<string>(),
    processedInjectedCompletionOrder: [],
    nextEpoch: 0,
  };
  seedFromPersistence(ledger);
  return ledger;
}

/**
 * Seed a freshly created ledger from backend-loaded persistence state.
 * No-op without a configured storage backend (v1 / hosts without the
 * domain) — fresh ledgers then stay exactly as process-local as before.
 */
function seedFromPersistence(ledger: BackgroundJobLifecycleLedger): void {
  const snapshot = persistedBackgroundJobState();
  if (snapshot.tombstones.size === 0 && snapshot.deletionEpochs.size === 0) {
    return;
  }
  for (const [taskID, record] of snapshot.tombstones) {
    ledger.tombstones.add(taskID);
    ledger.deletionEpochs.set(taskID, record.epoch);
  }
  for (const [taskID, epoch] of snapshot.deletionEpochs) {
    if (!ledger.deletionEpochs.has(taskID)) {
      ledger.deletionEpochs.set(taskID, epoch);
    }
  }
  if (snapshot.nextEpoch > ledger.nextEpoch) {
    ledger.nextEpoch = snapshot.nextEpoch;
  }
}

/** Record a task drop/eviction as a rehydrate and late-output tombstone.
 * Write-through: the persisted tombstone (and its deletion epoch) is
 * updated together with the in-memory ledger so the two can never
 * diverge across a restart. Cleared only by clearSuppression via
 * registerLaunch — an explicit (re)launch/adoption is proof of life;
 * the deletion epoch intentionally survives for generation fencing. */
export function recordSuppression(
  ledger: BackgroundJobLifecycleLedger,
  taskID: string,
  terminal?: {
    state: 'completed' | 'error' | 'cancelled';
    resultSummary: string;
  },
): void {
  if (ledger.tombstones.has(taskID)) return;
  ledger.tombstones.add(taskID);
  const epoch = ++ledger.nextEpoch;
  ledger.deletionEpochs.set(taskID, epoch);
  recordSuppressionPersisted(taskID, epoch, terminal);
}

/** Clear only the active rehydrate tombstone for a proven new launch.
 * Write-through: clearing on relaunch is load-bearing — a task deleted
 * then legitimately relaunched must NOT be ghost-skipped after a
 * restart. The deletion epoch intentionally survives (generation
 * fencing), matching the in-memory ledger semantics. */
export function clearSuppression(
  ledger: BackgroundJobLifecycleLedger,
  taskID: string,
): void {
  ledger.tombstones.delete(taskID);
  clearSuppressionPersisted(taskID);
}
