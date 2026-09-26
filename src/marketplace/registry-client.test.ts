import { describe, expect, test } from 'bun:test';
import {
  createMarketplaceRegistryEntry,
  createMarketplaceRegistryEntryV3,
  createMarketplaceRegistryIndex,
  createMarketplaceRegistryIndexV3,
  type MarketplacePackageBundle,
} from '../marketplace-contract/index.js';
import {
  MarketplaceCompatibilityError,
  MarketplaceRegistryIntegrityError,
  MarketplaceRegistryNotFoundError,
  MarketplaceRegistryProtocolError,
  MarketplaceRegistryUnavailableError,
} from './errors.js';
import {
  DEFAULT_MARKETPLACE_REGISTRY_ARTIFACT_MAX_BYTES,
  MARKETPLACE_REGISTRY_INDEX_URL,
  MARKETPLACE_REGISTRY_V3_INDEX_URL,
  MarketplaceRegistryClient,
} from './registry-client.js';

function bundle(
  version = '1.0.0',
  id = 'community/registry-agent',
  schemaVersion: 2 | 3 = 2,
): MarketplacePackageBundle {
  const common = {
    id,
    version,
    displayName: 'Registry agent',
    description: 'A registry test package.',
    agentName: 'registryagent',
    prompt: 'Use the explorer role.',
    author: { name: 'Community' },
    tags: ['registry'],
    license: 'MIT',
    compatibility: { plugin: '>=3.0.0' },
    skills: [],
    mcps: [],
    tools: [],
    model: { source: 'explicit' as const, candidates: ['provider/model'] },
  };
  if (schemaVersion === 3) {
    return {
      manifest: {
        ...common,
        schemaVersion: 3,
        routing: {
          lane: 'Registry v3 lane.',
          stats: ['Fast resolution'],
          delegateWhen: ['The package matches.'],
          avoid: ['Malformed metadata.'],
        },
      },
    };
  }
  return {
    manifest: {
      ...common,
      schemaVersion: 2,
      routing: {
        description: 'Explore registry fixtures.',
        keywords: ['registry'],
        when: 'When testing registry installs.',
      },
    },
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

describe('MarketplaceRegistryClient', () => {
  test('downloads v2 and v3 bundles and includes source provenance', async () => {
    const v2Bundle = bundle();
    const v2Index = createMarketplaceRegistryIndex([
      createMarketplaceRegistryEntry(v2Bundle),
    ]);
    const v2Client = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async (input) =>
        String(input) === MARKETPLACE_REGISTRY_INDEX_URL
          ? response(v2Index)
          : response(v2Bundle),
    });
    const v2 = await v2Client.download(v2Bundle.manifest.id);
    expect(v2.bundle).toEqual(v2Bundle);
    expect(v2.indexUrl).toBe(MARKETPLACE_REGISTRY_INDEX_URL);
    expect(v2.packageUrl).toBe(
      'https://registry.ohmyopencodeslim.com/v2/artifacts/community/registry-agent/1.0.0.json',
    );
    expect(v2.registry).toBe('https://registry.ohmyopencodeslim.com/v2/');

    const v3Bundle = bundle('1.0.0', 'community/registry-v3-agent', 3);
    const v3Index = createMarketplaceRegistryIndexV3([
      createMarketplaceRegistryEntryV3(v3Bundle),
    ]);
    const v3Client = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async (input) =>
        String(input) === MARKETPLACE_REGISTRY_V3_INDEX_URL
          ? response(v3Index)
          : response(v3Bundle),
    });
    const v3 = await v3Client.downloadV3(v3Bundle.manifest.id);
    expect(v3.bundle.manifest.schemaVersion).toBe(3);
    expect(v3.indexUrl).toBe(MARKETPLACE_REGISTRY_V3_INDEX_URL);
    expect(v3.registry).toBe('https://registry.ohmyopencodeslim.com/v3/');
  });

  test('validates selectors, not-found results, compatibility, and digests', async () => {
    const packageBundle = bundle();
    const index = createMarketplaceRegistryIndex([
      createMarketplaceRegistryEntry(packageBundle),
    ]);
    const client = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async (input) =>
        String(input) === MARKETPLACE_REGISTRY_INDEX_URL
          ? response(index)
          : response(packageBundle),
    });
    await expect(
      client.download('community/registry-agent@^1.0.0'),
    ).rejects.toBeInstanceOf(MarketplaceRegistryProtocolError);
    await expect(client.download('community/missing')).rejects.toBeInstanceOf(
      MarketplaceRegistryNotFoundError,
    );

    const incompatible = new MarketplaceRegistryClient({
      pluginVersion: '2.0.0',
      fetch: async (input) =>
        String(input) === MARKETPLACE_REGISTRY_INDEX_URL
          ? response(index)
          : response(packageBundle),
    });
    await expect(
      incompatible.download(packageBundle.manifest.id),
    ).rejects.toBeInstanceOf(MarketplaceCompatibilityError);

    const forged = {
      ...packageBundle,
      manifest: { ...packageBundle.manifest, description: 'forged' },
    };
    const corrupt = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async (input) =>
        String(input) === MARKETPLACE_REGISTRY_INDEX_URL
          ? response(index)
          : response(forged),
    });
    await expect(
      corrupt.download(packageBundle.manifest.id),
    ).rejects.toBeInstanceOf(MarketplaceRegistryIntegrityError);
  });

  test('classifies invalid responses and enforces bounded bodies', async () => {
    const redirecting = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async () => response({}, 302),
    });
    await expect(redirecting.fetchIndex()).rejects.toBeInstanceOf(
      MarketplaceRegistryProtocolError,
    );

    const notFound = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async () => response({}, 404),
    });
    await expect(notFound.fetchIndex()).rejects.toBeInstanceOf(
      MarketplaceRegistryNotFoundError,
    );

    const unavailable = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async () => response({}, 503),
    });
    await expect(unavailable.fetchIndex()).rejects.toBeInstanceOf(
      MarketplaceRegistryUnavailableError,
    );

    const oversized = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      maxIndexBytes: 10,
      fetch: async () => response({ schemaVersion: 3, entries: [] }),
    });
    await expect(oversized.fetchIndex()).rejects.toBeInstanceOf(
      MarketplaceRegistryProtocolError,
    );
    expect(DEFAULT_MARKETPLACE_REGISTRY_ARTIFACT_MAX_BYTES).toBeGreaterThan(0);
  });

  test('cancels rejected response bodies without masking classified errors', async () => {
    async function expectCancelledResponse(
      responseStatus: number,
      headers: HeadersInit | undefined,
      expectedError: new (...args: never[]) => Error,
      maxIndexBytes?: number,
    ) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
          return Promise.reject(new Error('cancellation failed'));
        },
      });
      const client = new MarketplaceRegistryClient({
        pluginVersion: '3.1.0',
        maxIndexBytes,
        fetch: async () =>
          new Response(body, { status: responseStatus, headers }),
      });

      await expect(client.fetchIndex()).rejects.toBeInstanceOf(expectedError);
      expect(cancelled).toBe(true);
    }

    await expectCancelledResponse(
      503,
      undefined,
      MarketplaceRegistryUnavailableError,
    );
    await expectCancelledResponse(
      302,
      undefined,
      MarketplaceRegistryProtocolError,
    );
    await expectCancelledResponse(
      200,
      { 'content-length': '100' },
      MarketplaceRegistryProtocolError,
      10,
    );
  });

  test('aborts timed-out requests and propagates external cancellation', async () => {
    const timedOut = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      timeoutMs: 5,
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    });
    await expect(timedOut.fetchIndex()).rejects.toBeInstanceOf(
      MarketplaceRegistryUnavailableError,
    );

    const controller = new AbortController();
    const observedSignal = new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(), {
        once: true,
      });
    });
    const cancelled = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    });
    const request = cancelled.fetchIndex(controller.signal);
    controller.abort();
    await observedSignal;
    await expect(request).rejects.toBeInstanceOf(
      MarketplaceRegistryUnavailableError,
    );
  });
});
