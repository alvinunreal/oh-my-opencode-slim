/**
 * Process-local gate for incomplete-todo continuation promptAsync attempts.
 *
 * Scoped via globalThis + Symbol.for so independently created hook instances
 * in the same JS process share one-attempt-per-session protection. Does not
 * claim cross-process or restart durability.
 */

type AttemptState =
  | { status: 'reserved'; owner: symbol }
  | { status: 'consumed' };

type ContinuationAttemptStore = {
  attempts: Map<string, AttemptState>;
  /**
   * Last external user message ID that rearmed each session. Process-global so
   * two hook instances observing the same chat.message open only one epoch.
   */
  lastRearmMessageID: Map<string, string>;
};

const STORE_KEY = Symbol.for('oh-my-opencode-slim.continuation-attempt-gate');

function getStore(): ContinuationAttemptStore {
  const globalWithStore = globalThis as typeof globalThis & {
    [STORE_KEY]?: ContinuationAttemptStore;
  };
  globalWithStore[STORE_KEY] ??= {
    attempts: new Map(),
    lastRearmMessageID: new Map(),
  };
  return globalWithStore[STORE_KEY];
}

/**
 * Atomically reserve a continuation attempt.
 * Returns an owner token on success, or null if already reserved/consumed.
 */
export function tryReserveContinuationAttempt(
  sessionID: string,
): symbol | null {
  const { attempts } = getStore();
  if (attempts.has(sessionID)) return null;
  const owner = Symbol(sessionID);
  attempts.set(sessionID, { status: 'reserved', owner });
  return owner;
}

/**
 * Commit a reserved attempt owned by `owner`. Returns true if this owner
 * committed; false if the reservation is missing or owned by someone else.
 */
export function commitContinuationAttempt(
  sessionID: string,
  owner: symbol,
): boolean {
  const { attempts } = getStore();
  const state = attempts.get(sessionID);
  if (state?.status !== 'reserved' || state.owner !== owner) {
    return false;
  }
  attempts.set(sessionID, { status: 'consumed' });
  return true;
}

/**
 * Release an uncommitted reservation only when still owned by `owner`.
 * Consumed attempts and foreign reservations are left intact.
 */
export function releaseContinuationAttempt(
  sessionID: string,
  owner: symbol,
): void {
  const { attempts } = getStore();
  const state = attempts.get(sessionID);
  if (state?.status === 'reserved' && state.owner === owner) {
    attempts.delete(sessionID);
  }
}

/**
 * Open a new continuation epoch for a real external user message.
 * Idempotent per (sessionID, messageID): a second observe of the same message
 * (e.g. another hook instance) is a no-op and does not rearm again.
 * Returns true when this call cleared attempt state.
 */
export function rearmContinuationForUserMessage(
  sessionID: string,
  messageID: string,
): boolean {
  const store = getStore();
  if (store.lastRearmMessageID.get(sessionID) === messageID) {
    return false;
  }
  store.lastRearmMessageID.set(sessionID, messageID);
  store.attempts.delete(sessionID);
  return true;
}

/**
 * Full session cleanup (genuine deletion). Clears attempt state and rearm
 * identity so a later session id reuse is not pinned to a prior message.
 */
export function clearContinuationAttempt(sessionID: string): void {
  const store = getStore();
  store.attempts.delete(sessionID);
  store.lastRearmMessageID.delete(sessionID);
}

export function hasConsumedContinuationAttempt(sessionID: string): boolean {
  return getStore().attempts.get(sessionID)?.status === 'consumed';
}

/** Test seam: wipe process-local gate state between cases. */
export function resetContinuationAttemptGateForTests(): void {
  const store = getStore();
  store.attempts.clear();
  store.lastRearmMessageID.clear();
}
