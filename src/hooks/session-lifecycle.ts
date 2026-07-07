export class SessionLifecycle {
  #cleanupCallbacks: Array<(sessionId: string) => void> = [];
  #pendingSessionIds = new Set<string>();
  #everPendingSessionIds = new Set<string>();
  #log: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(log: (msg: string, meta?: Record<string, unknown>) => void) {
    this.#log = log;
  }

  onSessionDeleted(callback: (sessionId: string) => void): void {
    this.#cleanupCallbacks.push(callback);
  }

  dispatchSessionDeleted(sessionId: string): void {
    for (const cb of this.#cleanupCallbacks) {
      try {
        cb(sessionId);
      } catch (error) {
        this.#log(
          `[session-lifecycle] cleanup callback failed for session ${sessionId}`,
          { error },
        );
      }
    }
  }

  markPending(sessionId: string): void {
    this.#pendingSessionIds.add(sessionId);
    this.#everPendingSessionIds.add(sessionId);
  }

  /** Atomic — only one caller gets true per markPending call. */
  consumePending(sessionId: string): boolean {
    const had = this.#pendingSessionIds.has(sessionId);
    this.#pendingSessionIds.delete(sessionId);
    return had;
  }

  hasPendingSession(sessionId: string): boolean {
    return (
      this.#everPendingSessionIds.has(sessionId) &&
      !this.#pendingSessionIds.has(sessionId)
    );
  }

  clearSession(sessionId: string): void {
    this.#pendingSessionIds.delete(sessionId);
    this.#everPendingSessionIds.delete(sessionId);
  }
}
