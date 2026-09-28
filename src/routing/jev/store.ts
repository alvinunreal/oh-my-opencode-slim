import type { JevRouteResult, ModelEntry, JevSpecialist } from './types';

export type JevRouteRecord = {
  result: JevRouteResult;
  /** Epoch ms when recorded. */
  at: number;
};

const TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 200;

/**
 * Per-session cache of the latest Jev routing decision.
 * Used by the dispatch hook to force the selected model onto task/subagent
 * calls even when the host's delegation tool has no model parameter in the
 * LLM-facing schema (v1), or when the LLM forgets to pass it.
 */
export class JevRouteStore {
  private readonly map = new Map<string, JevRouteRecord>();

  record(sessionID: string, result: JevRouteResult): void {
    if (!sessionID) return;
    if (this.map.size >= MAX_SESSIONS) {
      // Drop oldest
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(sessionID, { result, at: Date.now() });
  }

  get(sessionID: string): JevRouteResult | undefined {
    const rec = this.map.get(sessionID);
    if (!rec) return undefined;
    if (Date.now() - rec.at > TTL_MS) {
      this.map.delete(sessionID);
      return undefined;
    }
    return rec.result;
  }

  /** Latest result only when it names this specialist (task-type match). */
  getForSpecialist(
    sessionID: string,
    specialist: JevSpecialist | string,
    options?: { requireOk?: boolean },
  ): JevRouteResult | undefined {
    const result = this.get(sessionID);
    if (!result?.specialist) return undefined;
    if (result.specialist !== specialist) return undefined;
    if (result.status === 'error') return undefined;
    if (options?.requireOk && result.status !== 'ok') return undefined;
    return result;
  }

  clear(sessionID?: string): void {
    if (sessionID) this.map.delete(sessionID);
    else this.map.clear();
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
