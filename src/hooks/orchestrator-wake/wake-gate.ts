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
  /** Insertion-ordered session keys for bounded eviction. */
  order: string[];
};

const STORE_KEY = 'oh-my-opencode-slim.orchestrator-wake-gate';
const MAX_TRACKED_SESSIONS = 256;

function getStore(): WakeGateStore {
  return getGlobalStore<WakeGateStore>(STORE_KEY, () => ({
    progress: new Map(),
    inFlight: new Map(),
    releaseWaiters: new Map(),
    order: [],
  }));
}

function touchOrder(sessionID: string): void {
  const store = getStore();
  const idx = store.order.indexOf(sessionID);
  if (idx >= 0) store.order.splice(idx, 1);
  store.order.push(sessionID);
  while (store.order.length > MAX_TRACKED_SESSIONS) {
    const oldest = store.order.shift();
    if (!oldest) break;
    clearWakeSession(oldest);
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

/** Full session cleanup (deletion or disposal). */
export function clearWakeSession(sessionID: string): void {
  const store = getStore();
  store.progress.delete(sessionID);
  store.inFlight.delete(sessionID);
  store.releaseWaiters.delete(sessionID);
  const idx = store.order.indexOf(sessionID);
  if (idx >= 0) store.order.splice(idx, 1);
}

/** Server/instance disposal: drop all process-local wake state. */
export function clearAllWakeSessions(): void {
  const store = getStore();
  store.progress.clear();
  store.inFlight.clear();
  store.releaseWaiters.clear();
  store.order.length = 0;
}

/** Test seam. */
export function resetOrchestratorWakeGateForTests(): void {
  clearAllWakeSessions();
}
