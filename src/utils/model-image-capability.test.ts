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
              id: 'vision',
              modelID: 'vision-api',
              providerID: 'p',
              capabilities: { input: ['text', 'image'] },
            },
            {
              id: 'text-only',
              modelID: 'text-only-api',
              providerID: 'p',
              capabilities: { input: ['text'] },
            },
            { id: 'no-capabilities', providerID: 'p' },
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

  test('reads the model registry and caches it', async () => {
    let calls = 0;
    const deps: ModelImageCapabilityDeps = {
      cache: {},
      modelDomain: {
        list: async () => {
          calls++;
          return {
            data: [
              {
                id: 'vision',
                modelID: 'vision-api',
                providerID: 'p',
                capabilities: { input: ['text', 'image'] },
              },
              {
                id: 'text-only',
                modelID: 'text-only-api',
                providerID: 'p',
                capabilities: { input: ['text'] },
              },
            ],
          };
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
      modelAcceptsImageInput({ providerID: 'p', id: 'unknown' }, deps),
    ).resolves.toBeUndefined();
    // The catalog is fetched once per generation.
    expect(calls).toBe(1);
  });

  test('resolves undefined without any capability source', async () => {
    await expect(
      modelAcceptsImageInput(REF, { cache: {} }),
    ).resolves.toBeUndefined();
  });

  test('keys the catalog by the stable Model.Info id, not provider modelID', async () => {
    const deps: ModelImageCapabilityDeps = {
      cache: {},
      modelDomain: {
        list: async () => ({
          data: [
            {
              id: 'vision',
              modelID: 'gpt-6-api',
              providerID: 'p',
              capabilities: { input: ['text', 'image'] },
            },
          ],
        }),
      },
    };
    await expect(
      modelAcceptsImageInput({ providerID: 'p', id: 'vision' }, deps),
    ).resolves.toBe(true);
    await expect(
      modelAcceptsImageInput({ providerID: 'p', id: 'gpt-6-api' }, deps),
    ).resolves.toBeUndefined();
  });

  test('keeps aliases distinct when they share one provider modelID', async () => {
    // `gpt-6-fast` aliases `gpt-6` and shares its API id; keying by modelID
    // would collapse the two entries and answer for the wrong model.
    const deps: ModelImageCapabilityDeps = {
      cache: {},
      modelDomain: {
        list: async () => ({
          data: [
            {
              id: 'gpt-6',
              modelID: 'gpt-6-api',
              providerID: 'p',
              capabilities: { input: ['text', 'image'] },
            },
            {
              id: 'gpt-6-fast',
              modelID: 'gpt-6-api',
              providerID: 'p',
              capabilities: { input: ['text'] },
            },
          ],
        }),
      },
    };
    await expect(
      modelAcceptsImageInput({ providerID: 'p', id: 'gpt-6' }, deps),
    ).resolves.toBe(true);
    await expect(
      modelAcceptsImageInput({ providerID: 'p', id: 'gpt-6-fast' }, deps),
    ).resolves.toBe(false);
  });

  test('accepts image-prefixed input modalities like the host check', async () => {
    const deps: ModelImageCapabilityDeps = {
      cache: {},
      modelDomain: {
        list: async () => ({
          data: [
            {
              id: 'png-only',
              providerID: 'p',
              capabilities: { input: ['text', 'image/png'] },
            },
            {
              id: 'audio-only',
              providerID: 'p',
              capabilities: { input: ['text', 'audio'] },
            },
          ],
        }),
      },
    };
    await expect(
      modelAcceptsImageInput({ providerID: 'p', id: 'png-only' }, deps),
    ).resolves.toBe(true);
    await expect(
      modelAcceptsImageInput({ providerID: 'p', id: 'audio-only' }, deps),
    ).resolves.toBe(false);
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
          { id: 'live', modelID: 'live-api', providerID: 'p' },
          { id: 'also-live', modelID: 'also-live-api', providerID: 'p' },
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

  test('resolves pins by the stable Model.Info id, not provider modelID', async () => {
    const deps = catalogDeps();
    await expect(
      modelExistsInCatalog({ providerID: 'p', id: 'live' }, deps),
    ).resolves.toBe(true);
    // A provider-facing API id is not a selectable model id; only `id` pins.
    await expect(
      modelExistsInCatalog({ providerID: 'p', id: 'live-api' }, deps),
    ).resolves.toBe(false);
  });

  test('pin existence tracks each alias even when modelIDs collide', async () => {
    const deps: ModelImageCapabilityDeps = {
      cache: {},
      modelDomain: {
        list: async () => ({
          data: [
            { id: 'gpt-6', modelID: 'gpt-6-api', providerID: 'p' },
            { id: 'gpt-6-fast', modelID: 'gpt-6-api', providerID: 'p' },
          ],
        }),
      },
    };
    await expect(
      modelExistsInCatalog({ providerID: 'p', id: 'gpt-6' }, deps),
    ).resolves.toBe(true);
    await expect(
      modelExistsInCatalog({ providerID: 'p', id: 'gpt-6-fast' }, deps),
    ).resolves.toBe(true);
    await expect(
      modelExistsInCatalog({ providerID: 'p', id: 'gpt-6-api' }, deps),
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
