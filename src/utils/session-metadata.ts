import { isBuiltInOrchestrator } from './agent-variant';

type SessionMetadataEviction = (sessionID: string) => void;

export class SessionMetadataStore {
  readonly #agents = new Map<string, string>();
  readonly #models = new Map<string, string>();
  readonly #directories = new Map<string, string>();
  readonly #insertionOrder = new Map<string, undefined>();
  /** Active orchestrator sessions are protected from eviction first. */
  readonly #activeOrchestratorSessionIDs = new Set<string>();
  readonly #isOrchestratorAgent: (agent: string) => boolean;
  readonly #maxEntries: number;
  readonly #onEvict?: SessionMetadataEviction;

  constructor(options: {
    maxEntries: number;
    onEvict?: SessionMetadataEviction;
    /** Recognizes the built-in orchestrator and its configured display name. */
    isOrchestratorAgent?: (agent: string) => boolean;
  }) {
    this.#maxEntries = options.maxEntries;
    this.#onEvict = options.onEvict;
    this.#isOrchestratorAgent =
      options.isOrchestratorAgent ?? isBuiltInOrchestrator;
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

    if (this.#isOrchestratorAgent(agent)) {
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
    const agent = this.#agents.get(sessionID);
    if (agent !== undefined && this.#isOrchestratorAgent(agent)) {
      this.#activeOrchestratorSessionIDs.add(sessionID);
    }
  }

  markOrchestratorIdle(sessionID: string): void {
    this.#activeOrchestratorSessionIDs.delete(sessionID);
  }

  delete(sessionID: string): void {
    this.#agents.delete(sessionID);
    this.#models.delete(sessionID);
    this.#directories.delete(sessionID);
    this.#insertionOrder.delete(sessionID);
    this.#activeOrchestratorSessionIDs.delete(sessionID);
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
      // Prefer the oldest inactive entry, then the oldest active
      // orchestrator. The cap must hold even when deletion events are missed.
      const candidates = [...this.#insertionOrder.keys()];
      const evictableSessionID =
        candidates.find(
          (candidate) => !this.#activeOrchestratorSessionIDs.has(candidate),
        ) ?? candidates[0];
      if (evictableSessionID === undefined) return;

      this.#insertionOrder.delete(evictableSessionID);
      this.#agents.delete(evictableSessionID);
      this.#models.delete(evictableSessionID);
      this.#directories.delete(evictableSessionID);
      this.#activeOrchestratorSessionIDs.delete(evictableSessionID);
      this.#onEvict?.(evictableSessionID);
    }
  }
}
