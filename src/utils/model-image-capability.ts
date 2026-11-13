/**
 * Host-resolved image-input capability and catalog existence for a model
 * reference.
 *
 * Both host flavors are read through their own resolved-model registry —
 * the same merged view (models.dev catalog ⊕ user config capabilities)
 * the host itself uses to gate unsupported media at request time:
 *
 * - v2 hosts: the `ctx.model` registry threaded through `experimental_v2`;
 * - v1 hosts: `client.config.providers()` through the plugin client.
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
  /** v1 plugin client with the `config.providers` namespace. */
  readonly client?: {
    readonly config?: {
      readonly providers?: () => Promise<unknown>;
    };
  };
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

/** `capabilities.input` in either host shape: the v2 modalities array
 * (`['text', 'image']`) or the v1 boolean record (`.image === true`). */
function imageInputOf(capabilities: unknown): boolean | undefined {
  if (!capabilities || typeof capabilities !== 'object') return undefined;
  const input = (capabilities as { input?: unknown }).input;
  if (Array.isArray(input))
    return input.some(
      (modality) =>
        typeof modality === 'string' && modality.startsWith('image'),
    );
  if (input && typeof input === 'object')
    return (input as { image?: unknown }).image === true;
  return undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** v2 `model.list()` payload: `{ data: ModelInfo[] }`, each entry carrying
 * `providerID`, `modelID` and the merged `capabilities`. Host `Model.Info`
 * has both `id` (catalog selection key) and `modelID` (provider API id);
 * the catalog is keyed by `id`. Prefer `rec.id` when string and nonempty,
 * retain `rec.modelID` only for older returned shapes lacking selection id. */
function catalogFromModelList(payload: unknown): ImageCatalog {
  const catalog = new Map<string, Map<string, boolean | undefined>>();
  const data = recordOf(payload)?.data;
  if (!Array.isArray(data)) return catalog;
  for (const entry of data) {
    const rec = recordOf(entry);
    const providerID = rec?.providerID;
    const id = typeof rec?.id === 'string' && rec.id ? rec.id : rec?.modelID;
    if (typeof providerID !== 'string' || typeof id !== 'string') continue;
    let models = catalog.get(providerID);
    if (!models) {
      models = new Map<string, boolean | undefined>();
      catalog.set(providerID, models);
    }
    models.set(id, imageInputOf(rec?.capabilities));
  }
  return catalog;
}

/** v1 `config.providers()` payload: `{ data: { providers: [...] } }` with
 * per-provider `models` records (the hey-api `fields` wrapper included). */
function catalogFromV1Providers(payload: unknown): ImageCatalog {
  const catalog = new Map<string, Map<string, boolean | undefined>>();
  const body = recordOf(recordOf(payload)?.data) ?? recordOf(payload);
  const providers = body?.providers;
  if (!Array.isArray(providers)) return catalog;
  for (const provider of providers) {
    const rec = recordOf(provider);
    if (!rec || typeof rec.id !== 'string') continue;
    const models = new Map<string, boolean | undefined>();
    for (const [modelID, model] of Object.entries(recordOf(rec.models) ?? {})) {
      models.set(modelID, imageInputOf(recordOf(model)?.capabilities));
    }
    catalog.set(rec.id, models);
  }
  return catalog;
}

async function fetchCatalog(
  deps: ModelImageCapabilityDeps,
): Promise<ImageCatalog> {
  if (deps.modelDomain?.list)
    return catalogFromModelList(await deps.modelDomain.list());
  if (deps.client?.config?.providers)
    return catalogFromV1Providers(await deps.client.config.providers());
  return new Map();
}

export async function modelAcceptsImageInput(
  ref: ModelImageCapabilityRef,
  deps: ModelImageCapabilityDeps,
): Promise<boolean | undefined> {
  if (!deps.modelDomain?.list && !deps.client?.config?.providers)
    return undefined;
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
  if (!deps.modelDomain?.list && !deps.client?.config?.providers)
    return undefined;
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
