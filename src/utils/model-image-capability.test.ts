import { describe, expect, test } from 'bun:test';
import {
  type ModelImageCapabilityDeps,
  modelAcceptsImageInput,
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
    // No per-request retry: the empty catalog is cached for the generation.
    expect(calls).toBe(1);
  });
});
