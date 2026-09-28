import type { JevRouteResult, ModelEntry } from './types';

export type JevRouteRecord = {
  result: JevRouteResult;
  /** Epoch ms when recorded. */
  at: number;
};

const TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 200;

export type JevRouteStoreOptions = {
  now?: () => number;
};

/**
 * Per-session cache of Jev routing decisions, keyed per task.
 *
 * Each `jev_route` call records its own task key, so the orchestrator can
 * route two independent lanes in parallel without the second decision
 * clobbering the first. The dispatch hook consumes a matching keyed entry
 * once, so a later failure (which clears the cache) cannot reuse a stale
 * decision from earlier work.
 */
export class JevRouteStore {
  private readonly map = new Map<string, JevRouteRecord>();
  private readonly now: () => number;

  constructor(options?: JevRouteStoreOptions) {
    this.now = options?.now ?? Date.now;
  }

  private key(sessionID: string, taskKey: string): string {
    return `${sessionID}::${taskKey}`;
  }

  record(sessionID: string, taskKey: string, result: JevRouteResult): void {
    if (!sessionID || !taskKey) return;
    if (this.map.size >= MAX_SESSIONS) {
      // Drop oldest
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(this.key(sessionID, taskKey), {
      result,
      at: this.now(),
    });
  }

  getForTask(sessionID: string, taskKey: string): JevRouteResult | undefined {
    const rec = this.map.get(this.key(sessionID, taskKey));
    if (!rec) return undefined;
    if (this.now() - rec.at > TTL_MS) {
      this.map.delete(this.key(sessionID, taskKey));
      return undefined;
    }
    return rec.result;
  }

  /** Backwards-compatible single-key lookup for non-parallel callers. */
  get(sessionID: string): JevRouteResult | undefined {
    return this.getForTask(sessionID, sessionID);
  }

  private normalize(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
  }

  private overlapScore(a: string, b: string): number {
    const wordsA = new Set(
      this.normalize(a).split(/\s+/).filter((w) => w.length > 2),
    );
    const wordsB = new Set(
      this.normalize(b).split(/\s+/).filter((w) => w.length > 2),
    );
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    let overlap = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) overlap += 1;
    }
    return overlap / Math.min(wordsA.size, wordsB.size);
  }

  /**
   * Find the specialist's latest decision for work related to this prompt.
   *
   * jev_route records one entry per task; the dispatch carries the raw lane
   * prompt, which rarely equals the Jev state verbatim. Match by task-type
   * (specialist) first, then by lexical overlap between the Jev input
   * (taskKey) and the lane prompt. No related task ⇒ no injection.
   */
  findForPrompt(
    sessionID: string,
    specialist: string,
    prompt: string,
    options?: { requireOk?: boolean; minOverlap?: number },
  ): { key: string; result: JevRouteResult } | undefined {
    const prefix = `${sessionID}::`;
    const minOverlap = options?.minOverlap ?? 0.2;
    let best:
      | { key: string; result: JevRouteResult; score: number }
      | undefined;
    for (const [key, rec] of this.map) {
      if (!key.startsWith(prefix)) continue;
      const result = rec.result;
      if (!result.specialist || result.specialist !== specialist) continue;
      if (result.status === 'error') continue;
      if (options?.requireOk && result.status !== 'ok') continue;
      const taskKey = key.slice(prefix.length);
      const score = this.overlapScore(taskKey, prompt);
      if (score < minOverlap) continue;
      if (this.now() - rec.at > TTL_MS) {
        this.map.delete(key);
        continue;
      }
      if (!best || score > best.score) best = { key, result, score };
    }
    return best ? { key: best.key, result: best.result } : undefined;
  }

  /** Latest task result only when it names this specialist (task-type match). */
  getForSpecialist(
    sessionID: string,
    specialist: string,
    options?: { requireOk?: boolean; taskKey?: string },
  ): JevRouteResult | undefined {
    if (options?.taskKey) {
      const result = this.getForTask(sessionID, options.taskKey);
      if (!result?.specialist) return undefined;
      if (result.specialist !== specialist) return undefined;
      if (result.status === 'error') return undefined;
      if (options?.requireOk && result.status !== 'ok') return undefined;
      return result;
    }
    return this.findForPrompt(sessionID, specialist, '', options)?.result;
  }

  /** Remove a single task entry after successful injection (consume-once). */
  consume(sessionID: string, taskKey: string): void {
    this.map.delete(this.key(sessionID, taskKey));
  }

  /** Direct removal for a matched store key (see findForPrompt). */
  consumeKey(key: string): void {
    this.map.delete(key);
  }

  clear(sessionID?: string): void {
    if (!sessionID) {
      this.map.clear();
      return;
    }
    for (const key of this.map.keys()) {
      if (key.startsWith(`${sessionID}::`)) this.map.delete(key);
    }
  }
}

/**
 * Build the host model argument value for a delegation call.
 * Returns the bare `provider/model` id; variant is carried separately.
 */
export function toDelegationModelArg(
  model: ModelEntry | undefined,
): string | undefined {
  return model?.id || undefined;
}
