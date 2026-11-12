/**
 * Process-local gate for orchestrator-wake reservation, progress cap, and
 * in-flight ownership. Shared across independently created hook instances in
 * the same JS process via globalThis + Symbol.for.
 */

import { getGlobalStore } from '../../utils/global-store';
import type { ContinuationModelSelection } from '../task-session-manager/continuation-model-selection';

export type WakeProgressState = {
  unchangedWakeCount: number;
  lastFingerprint: string | undefined;
  stopped: boolean;
  /** Set when a wake was reserved; next busy preserves the cap. */
  expectingWakeBusy: boolean;
  observedModel: ContinuationModelSelection | undefined;
};

type InFlightState = { owner: symbol; wakeCommitted: boolean };

type WakeGateStore = {
  progress: Map<string, WakeProgressState>;
  inFlight: Map<string, InFlightState>;
  releaseWaiters: Map<string, Set<() => void>>;
  /** #1411: per session, delta-less wake bodies already delivered with
   * occurrence counts. */
  deliveredDeltalessWakeTexts: Map<string, Map<string, number>>;
  /** #1411: per session, count of duplicate delta-less wakes suppressed. */
  suppressedDuplicateWakes: Map<string, number>;
  /** Insertion-ordered session keys for bounded eviction. */
  order: string[];
};

const STORE_KEY = 'oh-my-opencode-slim.orchestrator-wake-gate';
const HOLDERS_KEY = 'oh-my-opencode-slim.orchestrator-wake-gate-holders';
export const MAX_TRACKED_SESSIONS = 256;
const MAX_HOLDER_SESSIONS = 512;

/** Hook instances (by token) that serve each tracked session. Separate key so
 * a store created by an older module generation never lacks it. */
function getHolders(): Map<string, Set<symbol>> {
  return getGlobalStore<Map<string, Set<symbol>>>(HOLDERS_KEY, () => new Map());
}

function getStore(): WakeGateStore {
  const store = getGlobalStore<WakeGateStore>(STORE_KEY, () => ({
    progress: new Map(),
    inFlight: new Map(),
    releaseWaiters: new Map(),
    deliveredDeltalessWakeTexts: new Map(),
    suppressedDuplicateWakes: new Map(),
    order: [],
  }));
  // In-process reload can leave a pre-#1411 store object on the global key;
  // backfill so the delta-less wake path cannot crash on missing maps.
  store.deliveredDeltalessWakeTexts ??= new Map();
  store.suppressedDuplicateWakes ??= new Map();
  return store;
}

function touchOrder(sessionID: string): void {
  const store = getStore();
  const idx = store.order.indexOf(sessionID);
  if (idx >= 0) store.order.splice(idx, 1);
  store.order.push(sessionID);
  while (store.order.length > MAX_TRACKED_SESSIONS) {
    // Never evict a live evaluation's row, nor the row being touched: the
    // caller holds that object and mutates it next.
    const victim = store.order.find(
      (id) => id !== sessionID && !store.inFlight.has(id),
    );
    if (victim === undefined) break;
    clearWakeSession(victim);
  }
}

function emptyProgress(): WakeProgressState {
  return {
    unchangedWakeCount: 0,
    lastFingerprint: undefined,
    stopped: false,
    expectingWakeBusy: false,
    observedModel: undefined,
  };
}

export function getWakeProgress(sessionID: string): WakeProgressState {
  const store = getStore();
  const existing = store.progress.get(sessionID);
  if (existing) {
    touchOrder(sessionID);
    return existing;
  }
  const created = emptyProgress();
  store.progress.set(sessionID, created);
  touchOrder(sessionID);
  return created;
}

/**
 * Atomically claim the single in-flight evaluation slot for a session.
 * Returns an owner token, or null if another evaluation owns the slot.
 */
export function tryBeginWakeEvaluation(sessionID: string): symbol | null {
  const store = getStore();
  if (store.inFlight.has(sessionID)) return null;
  const owner = Symbol(sessionID);
  store.inFlight.set(sessionID, { owner, wakeCommitted: false });
  touchOrder(sessionID);
  return owner;
}

/**
 * Release an in-flight evaluation only when still owned by `owner`.
 */
export function releaseWakeEvaluation(sessionID: string, owner: symbol): void {
  const store = getStore();
  const state = store.inFlight.get(sessionID);
  if (state?.owner === owner) {
    store.inFlight.delete(sessionID);
    const waiters = store.releaseWaiters.get(sessionID);
    store.releaseWaiters.delete(sessionID);
    if (!state.wakeCommitted) {
      for (const waiter of waiters ?? []) waiter();
    }
  }
}

/**
 * Retry an evaluation that lost the shared in-flight reservation. Registering
 * and checking the reservation happen against the same store, so an owner
 * release cannot be missed between them.
 */
export function retryAfterWakeEvaluation(
  sessionID: string,
  retry: () => void,
): () => void {
  const store = getStore();
  if (!store.inFlight.has(sessionID)) {
    queueMicrotask(retry);
    return () => {};
  }
  const waiters = store.releaseWaiters.get(sessionID) ?? new Set<() => void>();
  waiters.add(retry);
  store.releaseWaiters.set(sessionID, waiters);
  return () => {
    const current = store.releaseWaiters.get(sessionID);
    current?.delete(retry);
    if (current?.size === 0) store.releaseWaiters.delete(sessionID);
  };
}

/**
 * Record a wake reservation before promptAsync. Owner-safe: only the current
 * in-flight owner may commit. Updates fingerprint accounting and marks that
 * the next busy should preserve (not rearm) the no-progress cap.
 */
export function commitWakeReservation(
  sessionID: string,
  owner: symbol,
  fingerprint: string,
): boolean {
  const store = getStore();
  const flight = store.inFlight.get(sessionID);
  if (flight?.owner !== owner) return false;
  flight.wakeCommitted = true;

  const progress = getWakeProgress(sessionID);
  if (progress.lastFingerprint !== fingerprint) {
    progress.unchangedWakeCount = 0;
    progress.lastFingerprint = fingerprint;
  }
  progress.unchangedWakeCount += 1;
  progress.expectingWakeBusy = true;
  if (progress.unchangedWakeCount >= 2) {
    progress.stopped = true;
  }
  return true;
}

/**
 * #1411: record a delta-less wake body about to be delivered. First
 * occurrence stores count 1 and returns `repeat: false`; every identical
 * body afterwards increments the count, bumps the per-session suppressed
 * counter, and returns `repeat: true` with the new occurrence number.
 * `reservation` is the map the count was written into: a rollback only
 * applies while that exact map is still the session's, so an eviction that
 * replaced it makes a stale rollback a no-op.
 */
export function reserveWakeBodyOccurrence(
  sessionID: string,
  wakeText: string,
): {
  repeat: boolean;
  occurrence: number;
  reservation: Map<string, number>;
} {
  const store = getStore();
  let counts = store.deliveredDeltalessWakeTexts.get(sessionID);
  if (!counts) {
    counts = new Map();
    store.deliveredDeltalessWakeTexts.set(sessionID, counts);
  }
  touchOrder(sessionID);
  const previous = counts.get(wakeText) ?? 0;
  const occurrence = previous + 1;
  counts.set(wakeText, occurrence);
  if (previous > 0) {
    store.suppressedDuplicateWakes.set(
      sessionID,
      (store.suppressedDuplicateWakes.get(sessionID) ?? 0) + 1,
    );
  }
  return { repeat: previous > 0, occurrence, reservation: counts };
}

/** #1411 observability: suppressed duplicate wake count for a session. */
export function getSuppressedDuplicateWakes(sessionID: string): number {
  return getStore().suppressedDuplicateWakes.get(sessionID) ?? 0;
}

/**
 * #1411: undo the occurrence a failed send reserved, so the retry delivers
 * the full text instead of a phantom repeat. Removes the sole occurrence
 * outright; an occurrence that was a counted repeat also undoes its
 * suppression count (floored at 0). `reservation` and `occurrence` must be
 * what the caller's `reserveWakeBodyOccurrence` returned: if the session's
 * occurrence map has since been replaced (LRU eviction, hook disposal,
 * session deletion) or the count moved on to a newer reservation, this is a
 * no-op so a stale send cannot undo someone else's reservation.
 */
export function rollbackWakeBodyOccurrence(
  sessionID: string,
  wakeText: string,
  occurrence: number,
  reservation: Map<string, number>,
): void {
  const store = getStore();
  const counts = store.deliveredDeltalessWakeTexts.get(sessionID);
  if (counts !== reservation || reservation.get(wakeText) !== occurrence) {
    return;
  }
  if (occurrence === 1) {
    reservation.delete(wakeText);
    return;
  }
  reservation.set(wakeText, occurrence - 1);
  store.suppressedDuplicateWakes.set(
    sessionID,
    Math.max(0, (store.suppressedDuplicateWakes.get(sessionID) ?? 0) - 1),
  );
}

/** A failed send did not make progress. Only its current in-flight owner may
 * undo the cap accounting; keep wakeCommitted so release cannot start a
 * waiter storm (the session timer controls the next attempt). */
export function rollbackWakeReservation(
  sessionID: string,
  owner: symbol,
): void {
  const store = getStore();
  const flight = store.inFlight.get(sessionID);
  if (flight?.owner !== owner || !flight.wakeCommitted) return;
  const progress = store.progress.get(sessionID);
  if (!progress) return;
  progress.unchangedWakeCount = Math.max(0, progress.unchangedWakeCount - 1);
  progress.stopped = false;
}

/** Host fingerprint changed: reset the two-wake no-progress cap. */
export function noteHostProgress(sessionID: string, fingerprint: string): void {
  const progress = getWakeProgress(sessionID);
  if (progress.lastFingerprint === fingerprint) return;
  progress.lastFingerprint = fingerprint;
  progress.unchangedWakeCount = 0;
  progress.stopped = false;
}

/**
 * Whether busy belongs to a scheduler wake. The marker persists through
 * duplicate status delivery from independently-created hook instances.
 */
export function isExpectingWakeBusy(sessionID: string): boolean {
  const progress = getWakeProgress(sessionID);
  return progress.expectingWakeBusy;
}

/** Clear the scheduler busy marker once the corresponding idle arrives. */
export function clearExpectingWakeBusy(sessionID: string): void {
  const progress = getWakeProgress(sessionID);
  progress.expectingWakeBusy = false;
}

/** External user activity or genuine lifecycle cleanup rearms the cap. */
export function rearmWakeProgress(sessionID: string): void {
  const progress = getWakeProgress(sessionID);
  progress.unchangedWakeCount = 0;
  progress.lastFingerprint = undefined;
  progress.stopped = false;
  progress.expectingWakeBusy = false;
}

export function setObservedWakeModel(
  sessionID: string,
  model: ContinuationModelSelection | undefined,
): void {
  getWakeProgress(sessionID).observedModel = model;
}

export function getObservedWakeModel(
  sessionID: string,
): ContinuationModelSelection | undefined {
  return getStore().progress.get(sessionID)?.observedModel;
}

/** Record that the hook identified by `holder` serves this session. */
export function claimWakeSession(sessionID: string, holder: symbol): void {
  const holders = getHolders();
  const set = holders.get(sessionID) ?? new Set<symbol>();
  set.add(holder);
  // LRU touch, bounded on its own so claims never evict progress entries. An
  // evicted claim only means disposal leaves that session to the gate's own
  // eviction or the last-instance clear.
  holders.delete(sessionID);
  holders.set(sessionID, set);
  while (holders.size > MAX_HOLDER_SESSIONS) {
    const oldest = holders.keys().next().value;
    if (oldest === undefined) break;
    holders.delete(oldest);
  }
}

/**
 * One hook instance's disposal while others stay live: drop the wake state of
 * the sessions only that hook served, so a reloaded generation for its
 * location starts with fresh no-progress caps, while sessions another live
 * hook still serves keep theirs. The disposing hook releases its own
 * in-flight reservations first, so a reservation still present belongs to a
 * live hook and is left in place together with its release waiters.
 */
export function releaseWakeSessionHolder(holder: symbol): void {
  const store = getStore();
  for (const [sessionID, set] of [...getHolders()]) {
    if (!set.delete(holder) || set.size > 0) continue;
    if (store.inFlight.has(sessionID)) {
      store.progress.delete(sessionID);
      store.deliveredDeltalessWakeTexts.delete(sessionID);
      store.suppressedDuplicateWakes.delete(sessionID);
      getHolders().delete(sessionID);
    } else {
      clearWakeSession(sessionID);
    }
  }
}

/** Full session cleanup (deletion or disposal). */
export function clearWakeSession(sessionID: string): void {
  const store = getStore();
  getHolders().delete(sessionID);
  store.progress.delete(sessionID);
  store.inFlight.delete(sessionID);
  store.releaseWaiters.delete(sessionID);
  store.deliveredDeltalessWakeTexts.delete(sessionID);
  store.suppressedDuplicateWakes.delete(sessionID);
  const idx = store.order.indexOf(sessionID);
  if (idx >= 0) store.order.splice(idx, 1);
}

/** Server/instance disposal: drop all process-local wake state. */
export function clearAllWakeSessions(): void {
  const store = getStore();
  store.progress.clear();
  store.inFlight.clear();
  store.releaseWaiters.clear();
  store.deliveredDeltalessWakeTexts.clear();
  store.suppressedDuplicateWakes.clear();
  store.order.length = 0;
  getHolders().clear();
}

/** Test seam. */
export function resetOrchestratorWakeGateForTests(): void {
  clearAllWakeSessions();
}
