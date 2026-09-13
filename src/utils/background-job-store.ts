import type {
  BackgroundJobLaunchInput,
  BackgroundJobLease,
  BackgroundJobPromptMetadata,
  BackgroundJobRecord,
  BackgroundJobStatusInput,
  ContextFile,
  WallClockTimeoutClaimInput,
  WallClockTimeoutFinalizeInput,
} from './background-job-board';
import {
  clearSuppression as clearSuppressionPersisted,
  persistedBackgroundJobState,
  recordSuppression as recordSuppressionPersisted,
} from './background-job-persistence';

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

/**
 * Process-local lifecycle memory shared by every hook using one job store.
 *
 * These sets/maps intentionally have no count cap. Evicting an old identity
 * would turn a replay of valid history into a false negative for the current
 * generation. The ledger is process-local by design; it is not persistence.
 */
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

const lifecycleLedgers = new WeakMap<object, BackgroundJobLifecycleLedger>();

/**
 * Coordinators wrap a board without exposing it in their public type. Use the
 * wrapped board as the identity when one is present so both store facades
 * share the same lifecycle ledger.
 */
function backingStore(store: BackgroundJobStore): object {
  let current: unknown = store;
  const seen = new Set<object>();

  while (current && typeof current === 'object') {
    const object = current as object;
    if (seen.has(object)) return object;
    seen.add(object);

    const nested = (current as { board?: unknown }).board;
    if (!nested || typeof nested !== 'object') return object;
    current = nested;
  }

  return store as object;
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

export function getBackgroundJobLifecycleLedger(
  store: BackgroundJobStore,
): BackgroundJobLifecycleLedger {
  const key = backingStore(store);
  const existing = lifecycleLedgers.get(key);
  if (existing) return existing;

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
  lifecycleLedgers.set(key, ledger);
  return ledger;
}

/** Record a task drop/eviction as a rehydrate and late-output tombstone.
 * Write-through: the persisted tombstone (and its deletion epoch) is
 * updated together with the in-memory ledger so the two can never
 * diverge across a restart. */
export function recordBackgroundJobSuppression(
  store: BackgroundJobStore,
  taskID: string,
): void {
  const ledger = getBackgroundJobLifecycleLedger(store);
  if (ledger.tombstones.has(taskID)) return;
  ledger.tombstones.add(taskID);
  const epoch = ++ledger.nextEpoch;
  ledger.deletionEpochs.set(taskID, epoch);
  recordSuppressionPersisted(taskID, epoch);
}

/** Clear only the active rehydrate tombstone for a proven new launch.
 * Write-through: clearing on relaunch is load-bearing — a task deleted
 * then legitimately relaunched must NOT be ghost-skipped after a
 * restart. The deletion epoch intentionally survives (generation
 * fencing), matching the in-memory ledger semantics. */
export function clearBackgroundJobSuppression(
  store: BackgroundJobStore,
  taskID: string,
): void {
  getBackgroundJobLifecycleLedger(store).tombstones.delete(taskID);
  clearSuppressionPersisted(taskID);
}

/**
 * Unified interface for background job operations.
 * Both BackgroundJobBoard and BackgroundJobCoordinator satisfy this.
 *
 * ponytail: single interface, both board and coordinator implement it.
 */
export interface BackgroundJobStore {
  // ── Mutation methods ──────────────────────────────────────────────
  registerLaunch(input: BackgroundJobLaunchInput): BackgroundJobRecord;
  acquireCancellationLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined;
  acquireRelaunchLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined;
  acquireMessageLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined;
  acquireTerminalNotificationLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined;
  validateLease(lease: BackgroundJobLease): boolean;
  releaseLease(lease: BackgroundJobLease): boolean;
  updateStatus(
    input: BackgroundJobStatusInput,
  ): BackgroundJobRecord | undefined;
  updateFromStatusOutput(output: string): BackgroundJobRecord | undefined;
  claimWallClockDeadline(
    input: WallClockTimeoutClaimInput,
  ): BackgroundJobRecord | undefined;
  finalizeWallClockTimeout(
    input: WallClockTimeoutFinalizeInput,
  ): BackgroundJobRecord | undefined;
  markRunningFromLiveSession(
    taskID: string,
    now?: number,
    expectedGeneration?: number,
  ): BackgroundJobRecord | undefined;
  markStopped(
    taskID: string,
    resultSummary: string,
    observedAt?: number,
    expectedGeneration?: number,
    now?: number,
  ): BackgroundJobRecord | undefined;
  noteStopConfirmation(
    taskID: string,
    startedAt: number,
    expectedGeneration?: number,
  ): BackgroundJobRecord | undefined;
  markStatusUncertain(
    taskID: string,
    lastStatusError: string,
    expectedGeneration?: number,
    now?: number,
  ): BackgroundJobRecord | undefined;
  /**
   * Acknowledge the terminal notification delivered to the parent session.
   * This is a prompt-lifecycle acknowledgement, not filesystem reconciliation.
   */
  markReconciled(taskID: string, now?: number): BackgroundJobRecord | undefined;
  markCancelled(
    taskID: string,
    reason?: string,
    now?: number,
    options?: {
      force?: boolean;
      expectedGeneration?: number;
      cancellationLease?: BackgroundJobLease;
    },
  ): BackgroundJobRecord | undefined;
  clearParent(parentSessionID: string): void;
  drop(taskID: string): void;
  addContext(taskID: string, files: ContextFile[]): void;
  markUsed(parentSessionID: string, key: string, now?: number): void;

  // ── Query methods ─────────────────────────────────────────────────
  get(taskID: string): BackgroundJobRecord | undefined;
  field<K extends keyof BackgroundJobRecord>(
    taskID: string,
    key: K,
  ): BackgroundJobRecord[K] | undefined;
  isRunning(taskID: string): boolean;
  isTerminalUnreconciled(taskID: string): boolean;
  getResultSummary(taskID: string): string | undefined;
  getLastLiveBusyAt(taskID: string): number | undefined;
  getParentSessionID(taskID: string): string | undefined;
  getState(taskID: string): BackgroundJobRecord['state'] | undefined;
  resolve(
    parentSessionID: string,
    taskIDOrAlias: string,
  ): BackgroundJobRecord | undefined;
  resolveReusable(
    parentSessionID: string,
    taskIDOrAlias: string,
    agent?: string,
  ): BackgroundJobRecord | undefined;
  resolveRecoverable(
    parentSessionID: string,
    taskIDOrAlias: string,
    agent?: string,
  ): BackgroundJobRecord | undefined;
  taskIDs(): Set<string>;
  list(parentSessionID?: string): BackgroundJobRecord[];
  /** Cheap global check for any running job: single pass, no copy or sort. */
  hasRunningJobs(): boolean;
  hasRunning(parentSessionID: string): boolean;
  hasTerminalUnreconciled(parentSessionID: string): boolean;
  hasConvergenceSignals(taskID: string, threshold?: number): boolean;
  formatForPrompt(parentSessionID: string, now?: number): string | undefined;
  formatForPromptWithMetadata(
    parentSessionID: string,
    now?: number,
  ): BackgroundJobPromptMetadata | undefined;

  // ── Lifecycle policy ─────────────────────────────────────────────
  /** Evaluate close policy. Returns true if session should close now.
   *  Mutates deferred state: adds to deferred set if running, removes if not. */
  deferIfRunning(sessionId: string): boolean;
  /** Retry closing a deferred session. Returns true if session should now close. */
  retryDeferredClose(sessionId: string): boolean;
  /** Clear deferred close state for a session being deleted. */
  clearDeferredClose(sessionId: string): void;
}
