import {
  clearContinuationAttempt,
  commitContinuationAttempt,
  hasConsumedContinuationAttempt,
  rearmContinuationForUserMessage,
  releaseContinuationAttempt,
  tryReserveContinuationAttempt,
} from './continuation-attempt-gate';

export function createContinuationTokenManager(options?: {
  onInvalidateContinuation?: (sessionID: string) => void;
}) {
  const continuationSessionTokens = new Map<string, symbol>();
  const activeContinuationEvaluations = new Map<string, Set<symbol>>();
  /** Uncommitted reservation owners created by this token-manager instance. */
  const localReservations = new Map<string, symbol>();

  function getContinuationSessionToken(sessionID: string): symbol {
    const existing = continuationSessionTokens.get(sessionID);
    if (existing) return existing;

    const token = Symbol(sessionID);
    continuationSessionTokens.set(sessionID, token);
    return token;
  }

  function isCurrentContinuation(
    sessionID: string,
    sessionToken: symbol,
    evaluationToken?: symbol,
  ): boolean {
    return (
      continuationSessionTokens.get(sessionID) === sessionToken &&
      (evaluationToken === undefined ||
        activeContinuationEvaluations.get(sessionID)?.has(evaluationToken) ===
          true)
    );
  }

  function releaseLocalReservation(sessionID: string): void {
    const owner = localReservations.get(sessionID);
    if (!owner) return;
    releaseContinuationAttempt(sessionID, owner);
    localReservations.delete(sessionID);
  }

  function tryReserveAttempt(sessionID: string): symbol | null {
    const owner = tryReserveContinuationAttempt(sessionID);
    if (owner) {
      localReservations.set(sessionID, owner);
    }
    return owner;
  }

  function commitAttempt(sessionID: string, owner: symbol): boolean {
    const committed = commitContinuationAttempt(sessionID, owner);
    if (committed && localReservations.get(sessionID) === owner) {
      localReservations.delete(sessionID);
    }
    return committed;
  }

  function releaseAttempt(sessionID: string, owner: symbol): void {
    releaseContinuationAttempt(sessionID, owner);
    if (localReservations.get(sessionID) === owner) {
      localReservations.delete(sessionID);
    }
  }

  function invalidateContinuation(sessionID: string): void {
    options?.onInvalidateContinuation?.(sessionID);
    continuationSessionTokens.delete(sessionID);
    activeContinuationEvaluations.delete(sessionID);
    // Release this instance's uncommitted reservation immediately so a hung
    // SDK read cannot pin the process-global gate. Owner-safe: foreign or
    // already-committed attempts are untouched. Stale evaluator finally
    // cleanup remains a harmless no-op.
    releaseLocalReservation(sessionID);
  }

  /**
   * Real external user message: process-global attempt clear is idempotent per
   * message ID (only the first observe opens a new epoch). Always invalidate
   * this instance's local timers/tokens/reservations so a pre-message idle
   * timer on a second hook cannot fire SDK reads after the shared observe.
   */
  function rearmForUserMessage(sessionID: string, messageID: string): void {
    rearmContinuationForUserMessage(sessionID, messageID);
    invalidateContinuation(sessionID);
  }

  /**
   * Full session reset: local tokens + process-global attempt (including
   * consumed) and rearm identity. Used for genuine session deletion only.
   */
  function clearContinuation(sessionID: string): void {
    invalidateContinuation(sessionID);
    clearContinuationAttempt(sessionID);
  }

  /**
   * Instance disposal: drop local bookkeeping and release only this instance's
   * uncommitted reservations. Process-global committed attempts stay so another
   * hook instance in the same process cannot rearm a spent epoch.
   */
  function disposeLocalState(): void {
    for (const sessionID of [...localReservations.keys()]) {
      releaseLocalReservation(sessionID);
    }
    for (const sessionID of [...continuationSessionTokens.keys()]) {
      options?.onInvalidateContinuation?.(sessionID);
    }
    continuationSessionTokens.clear();
    activeContinuationEvaluations.clear();
  }

  const consumed = {
    has(sessionID: string): boolean {
      return hasConsumedContinuationAttempt(sessionID);
    },
  };

  return {
    getContinuationSessionToken,
    isCurrentContinuation,
    invalidateContinuation,
    rearmForUserMessage,
    clearContinuation,
    disposeLocalState,
    tryReserveAttempt,
    commitAttempt,
    releaseAttempt,
    sessionTokens: continuationSessionTokens,
    evaluations: activeContinuationEvaluations,
    consumed,
  };
}
