import { describe, expect, test } from 'bun:test';
import {
  type ModelImageCapabilityDeps,
  modelAcceptsImageInput,
  modelExistsInCatalog,
} from './model-image-capability';

const REF = { providerID: 'p', id: 'm' } as const;

describe('modelAcceptsImageInput', () => {
  test('reads the v2 model registry (modalities array shape)', async () => {
    const deps: ModelImageCapabilityDeps = {
      cache: {},
      modelDomain: {
        list: async () => ({
          data: [
            {
              providerID: 'p',
              modelID: 'vision',
              capabilities: { input: ['text', 'image'] },
            },
            {
              providerID: 'p',
              modelID: 'text-only',
              capabilities: { input: ['text'] },
            },
            { providerID: 'p', modelID: 'no-capabilities' },
          ],
        }),
      },
    };
    await expect(
      modelAcceptsImageInput({ providerID: 'p', id: 'vision' }, deps),
    ).resolves.toBe(true);
    await expect(
      modelAcceptsImageInput({ providerID: 'p', id: 'text-only' }, deps),
    ).resolves.toBe(false);
    await expect(
      modelAcceptsImageInput({ providerID: 'p', id: 'no-capabilities' }, deps),
    ).resolves.toBeUndefined();
    await expect(
      modelAcceptsImageInput({ providerID: 'q', id: 'vision' }, deps),
    ).resolves.toBeUndefined();
  });

  test('keys v2 catalog entries by selection id, falling back to modelID', async () => {
    // Host Model.Info carries `id` (catalog selection alias) separately from
    // `modelID` (provider API id); Model.Ref.id selects by `id`.
    const deps: ModelImageCapabilityDeps = {
      cache: {},
      modelDomain: {
        list: async () => ({
          data: [
            {
              providerID: 'p',
              id: 'vision-tiered',
              modelID: 'vision-backend',
              capabilities: { input: ['text', 'image'] },
            },
            {
              providerID: 'p',
              id: 'text-tiered',
              modelID: 'vision-backend',
              capabilities: { input: ['text'] },
            },
          ],
        }),
      },
    };
    // The alias is accepted via its selection id.
    await expect(
      modelAcceptsImageInput({ providerID: 'p', id: 'vision-tiered' }, deps),
    ).resolves.toBe(true);
    // Distinct catalog records sharing one backend id stay separately keyed:
    // the alias's image capability must not leak into the text record.
    await expect(
      modelAcceptsImageInput({ providerID: 'p', id: 'text-tiered' }, deps),
    ).resolves.toBe(false);
    // The shared backend id is not itself a catalog key.
    await expect(
      modelAcceptsImageInput({ providerID: 'p', id: 'vision-backend' }, deps),
    ).resolves.toBeUndefined();
    await expect(
      modelExistsInCatalog({ providerID: 'p', id: 'vision-tiered' }, deps),
    ).resolves.toBe(true);
    await expect(
      modelExistsInCatalog({ providerID: 'p', id: 'vision-backend' }, deps),
    ).resolves.toBe(false);
  });

  test('still keys v2 catalog entries by modelID when no selection id is present', async () => {
    // Older returned shapes carry only `modelID`.
    const deps: ModelImageCapabilityDeps = {
      cache: {},
      modelDomain: {
        list: async () => ({
          data: [
            {
              providerID: 'p',
              modelID: 'vision',
              capabilities: { input: ['text', 'image'] },
            },
          ],
        }),
      },
    };
    await expect(
      modelAcceptsImageInput({ providerID: 'p', id: 'vision' }, deps),
    ).resolves.toBe(true);
  });

  test('uses the host image-modality prefix rule for configured capabilities', async () => {
    const deps: ModelImageCapabilityDeps = {
      cache: {},
      modelDomain: {
        list: async () => ({
          data: [
            {
              providerID: 'p',
              id: 'configured-vision',
              capabilities: { input: ['text', 'image/png'] },
            },
          ],
        }),
      },
    };
    await expect(
      modelAcceptsImageInput(
        { providerID: 'p', id: 'configured-vision' },
        deps,
      ),
    ).resolves.toBe(true);
  });

  test('reads the v1 providers catalog (boolean record shape) and caches it', async () => {
    let calls = 0;
    const deps: ModelImageCapabilityDeps = {
      cache: {},
      client: {
        config: {
          providers: async () => {
            calls++;
            return {
              data: {
                providers: [
                  {
                    id: 'p',
                    models: {
                      vision: {
                        capabilities: { input: { text: true, image: true } },
                      },
                      'text-only': {
                        capabilities: { input: { text: true, image: false } },
                      },
                    },
                  },
                ],
              },
            };
          },
        },
      },
    };
    await expect(
      modelAcceptsImageInput({ providerID: 'p', id: 'vision' }, deps),
    ).resolves.toBe(true);
    await expect(
      modelAcceptsImageInput({ providerID: 'p', id: 'text-only' }, deps),
    ).resolves.toBe(false);
    await expect(
      modelAcceptsImageInput({ providerID: 'p', modelID: 'unknown' }, deps),
    ).resolves.toBeUndefined();
    // The catalog is fetched once per generation.
    expect(calls).toBe(1);
  });

  test('resolves undefined without any capability source', async () => {
    await expect(
      modelAcceptsImageInput(REF, { cache: {} }),
    ).resolves.toBeUndefined();
  });

  test('a failed fetch resolves undefined and stays cached', async () => {
    let calls = 0;
    const deps: ModelImageCapabilityDeps = {
      cache: {},
      modelDomain: {
        list: async () => {
          calls++;
          throw new Error('registry unavailable');
        },
      },
    };
    await expect(modelAcceptsImageInput(REF, deps)).resolves.toBeUndefined();
    await expect(modelAcceptsImageInput(REF, deps)).resolves.toBeUndefined();
    // No per-request retry: the failed fetch caches unknown for the generation.
    expect(calls).toBe(1);
  });
});

describe('modelExistsInCatalog', () => {
  const catalogDeps = (): ModelImageCapabilityDeps => ({
    cache: {},
    modelDomain: {
      list: async () => ({
        data: [
          { providerID: 'p', modelID: 'live' },
          { providerID: 'p', modelID: 'also-live' },
        ],
      }),
    },
  });

  test('reports present models and models retired from a listed provider', async () => {
    const deps = catalogDeps();
    await expect(
      modelExistsInCatalog({ providerID: 'p', id: 'live' }, deps),
    ).resolves.toBe(true);
    await expect(
      modelExistsInCatalog({ providerID: 'p', id: 'gone' }, deps),
    ).resolves.toBe(false);
  });

  test('treats an absent provider as unknown, not retired', async () => {
    // v2 model.list omits disabled/unauthenticated providers, so a missing
    // provider does not prove its models are gone.
    const deps = catalogDeps();
    await expect(
      modelExistsInCatalog({ providerID: 'missing', id: 'live' }, deps),
    ).resolves.toBe(undefined);
    // The catalog stays memoized: absence is a definite read, not a failure.
    expect(deps.cache.promise).toBeDefined();
  });

  test('resolves undefined without any catalog source', async () => {
    await expect(modelExistsInCatalog(REF, { cache: {} })).resolves.toBe(
      undefined,
    );
  });

  test('treats empty or unparseable catalogs as unknown', async () => {
    for (const payload of [{ data: [] }, {}, { data: 'not-an-array' }]) {
      const deps: ModelImageCapabilityDeps = {
        cache: {},
        modelDomain: { list: async () => payload },
      };
      await expect(modelExistsInCatalog(REF, deps)).resolves.toBeUndefined();
    }
  });

  test('a failed fetch resolves undefined and retries on the next call', async () => {
    let calls = 0;
    const deps: ModelImageCapabilityDeps = {
      cache: {},
      modelDomain: {
        list: async () => {
          calls++;
          throw new Error('registry unavailable');
        },
      },
    };
    await expect(modelExistsInCatalog(REF, deps)).resolves.toBeUndefined();
    await expect(modelExistsInCatalog(REF, deps)).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
