/**
 * Host-resolved image-input capability and catalog existence for a model
 * reference.
 *
 * The `ctx.model` registry threaded through `experimental_v2` is the same
 * resolved view the host uses to gate unsupported media at request time.
 *
 * omos keeps no capability table of its own. The catalog is cached in a
 * caller-owned slot — each plugin generation passes a fresh holder, so
 * rebuilds clear it by construction, and the plugin config hook drops the
 * cached promise on config changes. `undefined` means unknown, and callers
 * keep their conservative default.
 */

import { withTimeout } from './session';

/** In-process registry lookups are fast; anything slower is unknown. */
const CATALOG_LOOKUP_TIMEOUT_MS = 2_000;

/** v2 `Model.Ref`-shaped: `id` is the model id. */
export interface ModelImageCapabilityRef {
  readonly providerID: string;
  readonly id: string;
}

export interface ModelImageCapabilityCache {
  /** Resolved catalog, or `null` after a failed fetch (unknown — callers
   *  keep their default). `modelExistsInCatalog` drops the memo on failure
   *  instead, so stale-pin checks retry on the next capture. */
  promise?: Promise<ImageCatalog | null>;
}

export interface ModelImageCapabilityDeps {
  /** v2 host model registry threaded through `experimental_v2`. */
  readonly modelDomain?: {
    readonly list?: (input?: unknown) => Promise<unknown>;
  };
  /** Caller-owned cache slot; each plugin generation passes a fresh one. */
  readonly cache: ModelImageCapabilityCache;
}

type ImageCatalog = ReadonlyMap<
  string,
  ReadonlyMap<string, boolean | undefined>
>;

/** `capabilities.input` is a modalities array such as `['text', 'image']`. */
function imageInputOf(capabilities: unknown): boolean | undefined {
  if (!capabilities || typeof capabilities !== 'object') return undefined;
  const input = (capabilities as { input?: unknown }).input;
  if (Array.isArray(input)) return input.includes('image');
  return undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** v2 `model.list()` payload: `{ data: ModelInfo[] }`, each entry carrying
 * `providerID`, `modelID` and the merged `capabilities`. */
function catalogFromModelList(payload: unknown): ImageCatalog {
  const catalog = new Map<string, Map<string, boolean | undefined>>();
  const data = recordOf(payload)?.data;
  if (!Array.isArray(data)) return catalog;
  for (const entry of data) {
    const rec = recordOf(entry);
    const providerID = rec?.providerID;
    const modelID = rec?.modelID;
    if (typeof providerID !== 'string' || typeof modelID !== 'string') continue;
    let models = catalog.get(providerID);
    if (!models) {
      models = new Map<string, boolean | undefined>();
      catalog.set(providerID, models);
    }
    models.set(modelID, imageInputOf(rec?.capabilities));
  }
  return catalog;
}

async function fetchCatalog(
  deps: ModelImageCapabilityDeps,
): Promise<ImageCatalog> {
  if (deps.modelDomain?.list)
    return catalogFromModelList(await deps.modelDomain.list());
  return new Map();
}

export async function modelAcceptsImageInput(
  ref: ModelImageCapabilityRef,
  deps: ModelImageCapabilityDeps,
): Promise<boolean | undefined> {
  if (!deps.modelDomain?.list) return undefined;
  try {
    deps.cache.promise ??= fetchCatalog(deps);
    return (await deps.cache.promise)?.get(ref.providerID)?.get(ref.id);
  } catch {
    // A failed fetch is cached as unknown for the rest of the generation
    // (no per-request retry); the config hook drops the promise so config
    // changes retry.
    deps.cache.promise = Promise.resolve(null);
    return undefined;
  }
}

/**
 * Whether a model reference still resolves in the host catalog: `true`
 * present, `false` only when a successfully loaded catalog positively
 * shows it is gone (provider listed without the model), `undefined`
 * unknown (no catalog source, empty/unparseable payload, provider absent,
 * failed fetch, timeout) — callers keep their default. A missing provider
 * is not proof: v2 `model.list` omits disabled/unauthenticated providers,
 * so a temporarily unavailable provider must not retire a pin. Unknown
 * outcomes drop the cache memo so the next call retries (issue #1689).
 */
export async function modelExistsInCatalog(
  ref: ModelImageCapabilityRef,
  deps: ModelImageCapabilityDeps,
): Promise<boolean | undefined> {
  if (!deps.modelDomain?.list) return undefined;
  try {
    deps.cache.promise ??= fetchCatalog(deps);
    const catalog = await withTimeout(
      deps.cache.promise,
      CATALOG_LOOKUP_TIMEOUT_MS,
      'model catalog lookup timed out',
    );
    // Empty or unparseable is unknown, not proof the model is gone.
    if (!catalog || catalog.size === 0) {
      deps.cache.promise = undefined;
      return undefined;
    }
    const models = catalog.get(ref.providerID);
    if (!models) return undefined;
    return models.has(ref.id);
  } catch {
    // Failed or timed out: unknown; drop the memo so the next call retries.
    deps.cache.promise = undefined;
    return undefined;
  }
}
