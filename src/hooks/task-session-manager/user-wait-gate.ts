import { getGlobalStore } from '../../utils/global-store';

/**
 * Process-local gate for explicit wait_for_user HITL latches.
 *
 * Scoped via globalThis + Symbol.for so independently created hook instances
 * in the same JS process share wait state. Does not claim cross-process or
 * restart durability.
 */

type WaitState = { status: 'waiting-for-user' };

type RearmIdentity = string | symbol;

type UserWaitStore = {
  waits: Map<string, WaitState>;
  /**
   * Last external user-message identity that cleared each session wait.
   * string = chat.message ID; symbol = same-process object identity fallback.
   */
  lastRearmIdentity: Map<string, RearmIdentity>;
  /** Stable symbols for ID-less output.message object identity (same process). */
  messageObjectIdentity: WeakMap<object, symbol>;
};

const STORE_KEY = 'oh-my-opencode-slim.user-wait-gate';

function getStore(): UserWaitStore {
  return getGlobalStore<UserWaitStore>(STORE_KEY, () => ({
    waits: new Map(),
    lastRearmIdentity: new Map(),
    messageObjectIdentity: new WeakMap(),
  }));
}

/**
 * Block automatic orchestrator wakes for a text-only HITL boundary until a
 * distinct real external user message opens the next epoch.
 */
export function beginUserWait(sessionID: string): void {
  getStore().waits.set(sessionID, { status: 'waiting-for-user' });
}

export function hasUserWait(sessionID: string): boolean {
  return getStore().waits.get(sessionID)?.status === 'waiting-for-user';
}

function resolveRearmIdentity(identity: string | object): RearmIdentity {
  if (typeof identity === 'string') return identity;
  const store = getStore();
  const existing = store.messageObjectIdentity.get(identity);
  if (existing) return existing;
  const token = Symbol('user-wait-rearm-message');
  store.messageObjectIdentity.set(identity, token);
  return token;
}

/**
 * Clear wait_for_user for a real external user message.
 * Idempotent per (sessionID, identity). Returns true when this call cleared
 * wait state.
 */
export function clearUserWaitForMessage(
  sessionID: string,
  identity: string | object,
): boolean {
  const store = getStore();
  const resolved = resolveRearmIdentity(identity);
  if (store.lastRearmIdentity.get(sessionID) === resolved) {
    return false;
  }
  store.lastRearmIdentity.set(sessionID, resolved);
  store.waits.delete(sessionID);
  return true;
}

/**
 * Full session cleanup (genuine deletion). Clears wait state and rearm
 * identity so a later session id reuse is not pinned to a prior message.
 */
export function clearUserWait(sessionID: string): void {
  const store = getStore();
  store.waits.delete(sessionID);
  store.lastRearmIdentity.delete(sessionID);
}

/** Test seam: wipe process-local gate state between cases. */
export function resetUserWaitGateForTests(): void {
  const store = getStore();
  store.waits.clear();
  store.lastRearmIdentity.clear();
}
