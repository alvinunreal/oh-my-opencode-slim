/**
 * Pure helpers for councillor model fallback chains.
 *
 * Kept free of any schema/validation library import so that runtime consumers
 * (e.g. `CouncilManager`) can resolve a councillor's ordered model chain
 * without pulling in zod or the config schema module.
 */

/** A single model in a councillor fallback chain, with optional variant. */
export type CouncillorModelEntry = { id: string; variant?: string };

/**
 * Flatten a councillor model config into an ordered list of model entries.
 *
 * Accepts either a single "provider/model" string or an ordered fallback
 * chain (array of strings and/or `{ id, variant }` entries). Entries that
 * don't carry their own variant fall back to the shared `fallbackVariant`.
 */
export function normalizeCouncillorModels(
  model: string | Array<string | CouncillorModelEntry>,
  fallbackVariant?: string,
): CouncillorModelEntry[] {
  const raw = Array.isArray(model) ? model : [model];
  return raw.map((entry) =>
    typeof entry === 'string'
      ? { id: entry, variant: fallbackVariant }
      : { id: entry.id, variant: entry.variant ?? fallbackVariant },
  );
}
