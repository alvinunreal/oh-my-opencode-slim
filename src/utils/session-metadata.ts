type SessionMetadataEviction = (sessionID: string) => void;

export class SessionMetadataStore {
  readonly #agents = new Map<string, string>();
  readonly #models = new Map<string, string>();
  readonly #directories = new Map<string, string>();
  readonly #insertionOrder = new Map<string, undefined>();
  readonly #activeOrchestratorSessionIDs = new Set<string>();
  /** Sessions that dispatched background work. Distinct from the user's
   * current agent selection (#1079): a Plan/Build parent that called
   * `task` stays task-managed without being rewritten to orchestrator. */
  readonly #taskManagedSessionIDs = new Set<string>();
  readonly #maxEntries: number;
  readonly #onEvict?: SessionMetadataEviction;

  constructor(options: {
    maxEntries: number;
    onEvict?: SessionMetadataEviction;
  }) {
    this.#maxEntries = options.maxEntries;
    this.#onEvict = options.onEvict;
  }

  getAgent(sessionID: string): string | undefined {
    return this.#agents.get(sessionID);
  }

  getModel(sessionID: string): string | undefined {
    return this.#models.get(sessionID);
  }

  setModel(sessionID: string, model: string): void {
    this.#models.set(sessionID, model);
    this.#track(sessionID);
  }

  getDirectory(sessionID: string): string | undefined {
    return this.#directories.get(sessionID);
  }

  setAgent(sessionID: string, agent: string): void {
    this.#agents.set(sessionID, agent);

    if (agent === 'orchestrator') {
      this.#activeOrchestratorSessionIDs.add(sessionID);
    } else {
      this.#activeOrchestratorSessionIDs.delete(sessionID);
    }

    this.#track(sessionID);
  }

  setDirectory(sessionID: string, directory: string): void {
    this.#directories.set(sessionID, directory);
    this.#track(sessionID);
  }

  markOrchestratorActive(sessionID: string): void {
    if (this.#agents.get(sessionID) === 'orchestrator') {
      this.#activeOrchestratorSessionIDs.add(sessionID);
    }
  }

  markOrchestratorIdle(sessionID: string): void {
    this.#activeOrchestratorSessionIDs.delete(sessionID);
  }

  markTaskManaged(sessionID: string): void {
    this.#taskManagedSessionIDs.add(sessionID);
    this.#track(sessionID);
  }

  isTaskManaged(sessionID: string): boolean {
    return this.#taskManagedSessionIDs.has(sessionID);
  }

  delete(sessionID: string): void {
    this.#agents.delete(sessionID);
    this.#models.delete(sessionID);
    this.#directories.delete(sessionID);
    this.#insertionOrder.delete(sessionID);
    this.#activeOrchestratorSessionIDs.delete(sessionID);
    this.#taskManagedSessionIDs.delete(sessionID);
  }

  get size(): number {
    return this.#insertionOrder.size;
  }

  hasAgent(sessionID: string): boolean {
    return this.#agents.has(sessionID);
  }

  hasDirectory(sessionID: string): boolean {
    return this.#directories.has(sessionID);
  }

  #track(sessionID: string): void {
    if (!this.#insertionOrder.has(sessionID)) {
      this.#insertionOrder.set(sessionID, undefined);
    }

    while (this.#insertionOrder.size > this.#maxEntries) {
      // Eviction preference: unprotected entries first, then task-managed
      // ones (oldest first — membership is permanent, so without this
      // fallback a run of delegating parents would grow the store past
      // its configured bound), and only as a last resort in-flight
      // orchestrator sessions. The cap exists precisely to bound retention
      // when deletion events are missed, so it must always be enforceable.
      const candidates = [...this.#insertionOrder.keys()];
      const evictableSessionID =
        candidates.find(
          (candidate) =>
            !this.#activeOrchestratorSessionIDs.has(candidate) &&
            !this.#taskManagedSessionIDs.has(candidate),
        ) ??
        candidates.find(
          (candidate) =>
            !this.#activeOrchestratorSessionIDs.has(candidate) &&
            this.#taskManagedSessionIDs.has(candidate),
        ) ??
        candidates.find((candidate) =>
          this.#activeOrchestratorSessionIDs.has(candidate),
        );
      if (evictableSessionID === undefined) return;

      this.#insertionOrder.delete(evictableSessionID);
      this.#agents.delete(evictableSessionID);
      this.#models.delete(evictableSessionID);
      this.#directories.delete(evictableSessionID);
      this.#taskManagedSessionIDs.delete(evictableSessionID);
      this.#activeOrchestratorSessionIDs.delete(evictableSessionID);
      this.#onEvict?.(evictableSessionID);
    }
  }
}
