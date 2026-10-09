/**
 * Host-resolved image-input capability for a model reference.
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

/** v2 `Model.Ref`-shaped: `id` is the model id. */
export interface ModelImageCapabilityRef {
  readonly providerID: string;
  readonly id: string;
}

export interface ModelImageCapabilityCache {
  promise?: Promise<ImageCatalog>;
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
  if (Array.isArray(input)) return input.includes('image');
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
    return (await deps.cache.promise).get(ref.providerID)?.get(ref.id);
  } catch {
    // A failed fetch is cached as an empty catalog for the rest of the
    // generation (reads as unknown for every model, no per-request
    // retry); the config hook drops the promise so config changes retry.
    deps.cache.promise = Promise.resolve(new Map());
    return undefined;
  }
}
