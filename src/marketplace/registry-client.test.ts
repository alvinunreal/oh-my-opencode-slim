import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MarketplacePackageBundle } from '../marketplace-contract';
import {
  canonicalizeMarketplaceValue,
  createMarketplaceRegistryEntry,
  createMarketplaceRegistryEntryV3,
  createMarketplaceRegistryIndex,
  createMarketplaceRegistryIndexV3,
  digestMarketplaceBundle,
  MarketplaceManifestSummarySchema,
  MarketplaceRegistryIndexSchema,
  parseMarketplaceRegistryIndex,
  parseMarketplaceRegistrySelector,
  projectMarketplaceManifestSummary,
  registryArtifactPath,
  resolveMarketplaceRegistryEntry,
} from '../marketplace-contract';
import {
  MarketplaceRegistryIntegrityError,
  MarketplaceRegistryNotFoundError,
  MarketplaceRegistryProtocolError,
  MarketplaceRegistryUnavailableError,
} from './errors';
import {
  DEFAULT_MARKETPLACE_REGISTRY_ARTIFACT_MAX_BYTES,
  MARKETPLACE_REGISTRY_INDEX_URL,
  MARKETPLACE_REGISTRY_V3_INDEX_URL,
  MarketplaceRegistryClient,
} from './registry-client';
import { MarketplaceService } from './service';

function bundle(
  version = '1.0.0',
  id = 'community/registry-agent',
  plugin = '>=3.0.0',
): MarketplacePackageBundle {
  return {
    manifest: {
      schemaVersion: 2,
      id,
      version,
      displayName: 'Registry agent',
      description: 'A registry test package.',
      agentName: 'registryagent',
      prompt: 'Use the explorer role.',
      author: { name: 'Community' },
      tags: ['registry'],
      license: 'MIT',
      compatibility: { plugin },
      routing: {
        description: 'Explore registry fixtures.',
        keywords: ['registry'],
        when: 'When testing registry installs.',
      },
      skills: [],
      mcps: [],
      tools: [],
      model: { source: 'explicit', candidates: ['provider/model'] },
    },
  };
}

function bundleV3(
  version = '1.0.0',
  id = 'community/registry-v3-agent',
): MarketplacePackageBundle {
  const current = bundle(version, id);
  return {
    manifest: {
      ...current.manifest,
      schemaVersion: 3,
      compatibility: { plugin: '>=3.0.0-beta.3 <4.0.0' },
      routing: {
        lane: 'V3 registry lane.',
        stats: ['Fast v3 resolution'],
        delegateWhen: ['The v3 package matches.'],
        avoid: ['Malformed package metadata.'],
      },
    },
  };
}

function indexFor(packageBundle = bundle()): Record<string, unknown> {
  const manifest = packageBundle.manifest;
  return {
    schemaVersion: 3,
    entries: [
      {
        id: manifest.id,
        version: manifest.version,
        artifactPath: registryArtifactPath(manifest.id, manifest.version),
        digest: {
          algorithm: 'sha256',
          domain: 'marketplace-agent-bundle-v2',
          value: digestMarketplaceBundle(packageBundle),
        },
        summary: projectMarketplaceManifestSummary(manifest),
      },
    ],
  };
}

function indexForV3(packageBundle = bundleV3()): Record<string, unknown> {
  return createMarketplaceRegistryIndexV3([
    createMarketplaceRegistryEntryV3(packageBundle),
  ]);
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('marketplace registry contract', () => {
  test('enforces deterministic sorted unique entries and projections', () => {
    const first = indexFor(bundle('1.0.0'));
    const second = indexFor(bundle('2.0.0'));
    const validIndex = {
      schemaVersion: 3,
      entries: [
        ...(first.entries as unknown[]),
        ...(second.entries as unknown[]),
      ],
    };
    expect(MarketplaceRegistryIndexSchema.safeParse(validIndex).success).toBe(
      true,
    );
    expect(
      MarketplaceManifestSummarySchema.safeParse(
        (first.entries as any)[0].summary,
      ).success,
    ).toBe(true);
    expect(() =>
      parseMarketplaceRegistryIndex({
        ...validIndex,
        entries: [...(validIndex.entries as unknown[]).reverse()],
      }),
    ).toThrow('sorted');
    expect(() =>
      parseMarketplaceRegistryIndex({
        ...first,
        entries: [
          {
            ...(first.entries as any)[0],
            artifactPath: 'https://evil.example/artifact.json',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseMarketplaceRegistryIndex({
        ...first,
        entries: [
          ...(first.entries as unknown[]),
          ...(first.entries as unknown[]),
        ],
      }),
    ).toThrow('Duplicate');
  });

  test('parses exact selectors and resolves the highest compatible version', () => {
    expect(
      parseMarketplaceRegistrySelector('Community/Registry-Agent@2.0.0'),
    ).toEqual({
      id: 'community/registry-agent',
      version: '2.0.0',
    });
    const index = parseMarketplaceRegistryIndex({
      schemaVersion: 3,
      entries: [
        ...(indexFor(bundle('1.0.0')).entries as unknown[]),
        ...(indexFor(bundle('2.0.0')).entries as unknown[]),
      ],
    });
    expect(
      resolveMarketplaceRegistryEntry(
        index,
        { id: 'community/registry-agent' },
        { pluginVersion: '3.1.0' },
      ).version,
    ).toBe('2.0.0');
    expect(() =>
      parseMarketplaceRegistrySelector('community/registry-agent@^1.0.0'),
    ).toThrow();
    expect(() =>
      parseMarketplaceRegistrySelector('community/registry-agent@v1.0.0'),
    ).toThrow();
  });

  test('accepts empty or absent retirement lists and resolves legacy IDs', () => {
    const legacy = indexFor(bundle('1.0.0', 'legacy/package'));
    const withoutRetirements = parseMarketplaceRegistryIndex(legacy);
    const withEmptyRetirements = parseMarketplaceRegistryIndex({
      ...legacy,
      retirements: [],
    });

    expect(withoutRetirements.retirements).toBeUndefined();
    expect(withEmptyRetirements.retirements).toEqual([]);
    expect(
      resolveMarketplaceRegistryEntry(
        withoutRetirements,
        { id: 'legacy/package' },
        { pluginVersion: '3.1.0' },
      ).id,
    ).toBe('legacy/package');
  });

  test('uses locale-independent code-unit ordering for JSON and catalog entries', () => {
    expect(canonicalizeMarketplaceValue({ a_: 1, 'a-': 2 })).toBe(
      '{"a-":2,"a_":1}',
    );
    const left = createMarketplaceRegistryEntry(bundle('1.0.0', 'a_a/pkg'));
    const right = createMarketplaceRegistryEntry(bundle('1.0.0', 'a-a/pkg'));
    const index = createMarketplaceRegistryIndex([left, right]);
    expect(index.entries.map((entry) => entry.id)).toEqual([
      'a-a/pkg',
      'a_a/pkg',
    ]);
  });
});

describe('MarketplaceRegistryClient', () => {
  test('downloads v3 artifacts with the v3 contract and base URL', async () => {
    const packageBundle = bundleV3();
    const calls: string[] = [];
    const client = new MarketplaceRegistryClient({
      pluginVersion: '3.0.0-beta.6',
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        return url === MARKETPLACE_REGISTRY_V3_INDEX_URL
          ? response(indexForV3(packageBundle))
          : response(packageBundle);
      },
    });

    const downloaded = await client.downloadV3('community/registry-v3-agent');
    expect(downloaded.bundle.manifest.schemaVersion).toBe(3);
    expect(downloaded.registry).toBe(
      'https://registry.ohmyopencodeslim.com/v3/',
    );
    expect(calls).toEqual([
      MARKETPLACE_REGISTRY_V3_INDEX_URL,
      'https://registry.ohmyopencodeslim.com/v3/artifacts/community/registry-v3-agent/1.0.0.json',
    ]);
  });

  test('the v2 client rejects v3 indexes instead of parsing them as v2', async () => {
    const packageBundle = bundleV3();
    const client = new MarketplaceRegistryClient({
      pluginVersion: '3.0.0-beta.6',
      fetch: async () => response(indexForV3(packageBundle)),
    });

    await expect(client.fetchIndex()).rejects.toBeInstanceOf(
      MarketplaceRegistryProtocolError,
    );
  });

  test('MarketplaceService tries v3 first and installs the v3 result', async () => {
    const packageBundle = bundleV3();
    const calls: string[] = [];
    const root = mkdtempSync(join(tmpdir(), 'marketplace-v3-first-'));
    try {
      const service = new MarketplaceService({
        rootDir: root,
        pluginVersion: '3.0.0-beta.6',
        registryClient: new MarketplaceRegistryClient({
          pluginVersion: '3.0.0-beta.6',
          fetch: async (input) => {
            const url = String(input);
            calls.push(url);
            return url === MARKETPLACE_REGISTRY_V3_INDEX_URL
              ? response(indexForV3(packageBundle))
              : response(packageBundle);
          },
        }),
      });

      const installed = await service.installRemote(
        'community/registry-v3-agent',
      );
      expect(installed.manifest.schemaVersion).toBe(3);
      expect(installed.manifest.version).toBe('1.0.0');
      expect(
        service.store.getLockfile().packages['community/registry-v3-agent']
          .source,
      ).toMatchObject({
        kind: 'registry',
        registry: 'https://registry.ohmyopencodeslim.com/v3/',
      });
      expect(calls[0]).toBe(MARKETPLACE_REGISTRY_V3_INDEX_URL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('updates an installed v3 package through v3 without substituting v2', async () => {
    const initial = bundleV3('1.0.0');
    const updated = bundleV3('2.0.0');
    const v2Replacement = bundle('2.0.0', initial.manifest.id);
    const calls: string[] = [];
    let v3IndexReads = 0;
    const root = mkdtempSync(join(tmpdir(), 'marketplace-v3-update-'));
    try {
      const service = new MarketplaceService({
        rootDir: root,
        pluginVersion: '3.0.0-beta.6',
        registryClient: new MarketplaceRegistryClient({
          pluginVersion: '3.0.0-beta.6',
          fetch: async (input) => {
            const url = String(input);
            calls.push(url);
            if (url === MARKETPLACE_REGISTRY_V3_INDEX_URL) {
              v3IndexReads += 1;
              return response(
                createMarketplaceRegistryIndexV3(
                  v3IndexReads === 1
                    ? [createMarketplaceRegistryEntryV3(initial)]
                    : [
                        createMarketplaceRegistryEntryV3(initial),
                        createMarketplaceRegistryEntryV3(updated),
                      ],
                ),
              );
            }
            if (url === MARKETPLACE_REGISTRY_INDEX_URL) {
              return response(indexFor(v2Replacement));
            }
            if (
              url.endsWith(
                '/v3/artifacts/community/registry-v3-agent/1.0.0.json',
              )
            ) {
              return response(initial);
            }
            if (
              url.endsWith(
                '/v3/artifacts/community/registry-v3-agent/2.0.0.json',
              )
            ) {
              return response(updated);
            }
            if (
              url.endsWith(
                '/v2/artifacts/community/registry-v3-agent/2.0.0.json',
              )
            ) {
              return response(v2Replacement);
            }
            throw new Error(`Unexpected registry request: ${url}`);
          },
        }),
      });

      const installed = await service.installRemote(
        'community/registry-v3-agent',
      );
      const result = await service.updateRemote('community/registry-v3-agent');

      expect(installed.manifest.schemaVersion).toBe(3);
      expect(result.manifest.schemaVersion).toBe(3);
      expect(result.manifest.version).toBe('2.0.0');
      expect(result.source).toEqual({
        kind: 'registry',
        registry: 'https://registry.ohmyopencodeslim.com/v3/',
        indexUrl: MARKETPLACE_REGISTRY_V3_INDEX_URL,
        packageUrl:
          'https://registry.ohmyopencodeslim.com/v3/artifacts/community/registry-v3-agent/2.0.0.json',
      });
      expect(calls).toEqual([
        MARKETPLACE_REGISTRY_V3_INDEX_URL,
        'https://registry.ohmyopencodeslim.com/v3/artifacts/community/registry-v3-agent/1.0.0.json',
        MARKETPLACE_REGISTRY_V3_INDEX_URL,
        'https://registry.ohmyopencodeslim.com/v3/artifacts/community/registry-v3-agent/2.0.0.json',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('falls back to v2 only when v3 is unavailable or lacks the package', async () => {
    const v2Bundle = bundle();
    const calls: string[] = [];
    const root = mkdtempSync(join(tmpdir(), 'marketplace-v3-fallback-'));
    try {
      const service = new MarketplaceService({
        rootDir: root,
        pluginVersion: '3.1.0',
        registryClient: new MarketplaceRegistryClient({
          pluginVersion: '3.1.0',
          fetch: async (input) => {
            const url = String(input);
            calls.push(url);
            if (url === MARKETPLACE_REGISTRY_V3_INDEX_URL) {
              return response(createMarketplaceRegistryIndexV3([]));
            }
            if (url === MARKETPLACE_REGISTRY_INDEX_URL) {
              return response(indexFor(v2Bundle));
            }
            return response(v2Bundle);
          },
        }),
      });

      const installed = await service.installRemote('community/registry-agent');
      expect(installed.manifest.schemaVersion).toBe(2);
      expect(calls).toEqual([
        MARKETPLACE_REGISTRY_V3_INDEX_URL,
        MARKETPLACE_REGISTRY_INDEX_URL,
        'https://registry.ohmyopencodeslim.com/v2/artifacts/community/registry-agent/1.0.0.json',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('falls back when the v3 endpoint is unavailable', async () => {
    const packageBundle = bundle();
    const calls: string[] = [];
    const root = mkdtempSync(join(tmpdir(), 'marketplace-v3-unavailable-'));
    try {
      const service = new MarketplaceService({
        rootDir: root,
        pluginVersion: '3.1.0',
        registryClient: new MarketplaceRegistryClient({
          pluginVersion: '3.1.0',
          fetch: async (input) => {
            const url = String(input);
            calls.push(url);
            if (url === MARKETPLACE_REGISTRY_V3_INDEX_URL) {
              return response({}, 503);
            }
            if (url === MARKETPLACE_REGISTRY_INDEX_URL) {
              return response(indexFor(packageBundle));
            }
            return response(packageBundle);
          },
        }),
      });

      expect(
        (await service.installRemote('community/registry-agent')).manifest
          .schemaVersion,
      ).toBe(2);
      expect(calls[0]).toBe(MARKETPLACE_REGISTRY_V3_INDEX_URL);
      expect(calls[1]).toBe(MARKETPLACE_REGISTRY_INDEX_URL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not fall back after malformed or integrity-invalid v3 data', async () => {
    const packageBundle = bundleV3();
    const malformedCalls: string[] = [];
    const malformed = new MarketplaceRegistryClient({
      pluginVersion: '3.0.0-beta.6',
      fetch: async (input) => {
        malformedCalls.push(String(input));
        return response({ schemaVersion: 3, entries: [{}] });
      },
    });
    await expect(
      malformed.downloadV3('community/registry-v3-agent'),
    ).rejects.toBeInstanceOf(MarketplaceRegistryProtocolError);
    expect(malformedCalls).toEqual([MARKETPLACE_REGISTRY_V3_INDEX_URL]);

    const integrityCalls: string[] = [];
    const integrity = new MarketplaceRegistryClient({
      pluginVersion: '3.0.0-beta.6',
      fetch: async (input) => {
        const url = String(input);
        integrityCalls.push(url);
        return url === MARKETPLACE_REGISTRY_V3_INDEX_URL
          ? response(indexForV3(packageBundle))
          : response({
              ...packageBundle,
              manifest: { ...packageBundle.manifest, description: 'forged' },
            });
      },
    });
    await expect(
      integrity.downloadV3('community/registry-v3-agent'),
    ).rejects.toBeInstanceOf(MarketplaceRegistryIntegrityError);
    expect(integrityCalls).toHaveLength(2);
    expect(integrityCalls[0]).toBe(MARKETPLACE_REGISTRY_V3_INDEX_URL);
  });

  test('validates the index and artifact before store mutation and records provenance', async () => {
    const packageBundle = bundle();
    const calls: string[] = [];
    const client = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async (input) => {
        calls.push(String(input));
        return calls.length === 1
          ? response(indexFor(packageBundle))
          : response(packageBundle);
      },
    });
    const root = mkdtempSync(join(tmpdir(), 'marketplace-registry-'));
    try {
      const service = new MarketplaceService({
        rootDir: root,
        pluginVersion: '3.1.0',
        registryClient: { download: client.download.bind(client) },
      });
      const installed = await service.installRemote('community/registry-agent');
      expect(installed.manifest.version).toBe('1.0.0');
      expect(
        service.store.getLockfile().packages['community/registry-agent'].source,
      ).toEqual({
        kind: 'registry',
        registry: 'https://registry.ohmyopencodeslim.com/v2/',
        indexUrl: MARKETPLACE_REGISTRY_INDEX_URL,
        packageUrl:
          'https://registry.ohmyopencodeslim.com/v2/artifacts/community/registry-agent/1.0.0.json',
      });
      expect(calls).toEqual([
        MARKETPLACE_REGISTRY_INDEX_URL,
        'https://registry.ohmyopencodeslim.com/v2/artifacts/community/registry-agent/1.0.0.json',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects digest, summary, redirect, and bounded responses', async () => {
    const packageBundle = bundle();
    const badIndex = indexFor(packageBundle);
    (badIndex.entries as any)[0].digest.value = '0'.repeat(64);
    const client = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async (input) =>
        String(input) === MARKETPLACE_REGISTRY_INDEX_URL
          ? response(badIndex)
          : response(packageBundle),
    });
    await expect(
      client.download('community/registry-agent'),
    ).rejects.toBeInstanceOf(MarketplaceRegistryIntegrityError);

    const mismatchedSummary = indexFor(packageBundle);
    (mismatchedSummary.entries as any)[0].summary.displayName = 'Forged';
    const summaryClient = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async (input) =>
        String(input) === MARKETPLACE_REGISTRY_INDEX_URL
          ? response(mismatchedSummary)
          : response(packageBundle),
    });
    await expect(
      summaryClient.download('community/registry-agent'),
    ).rejects.toBeInstanceOf(MarketplaceRegistryIntegrityError);

    const redirecting = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async () => response({}, 302),
    });
    await expect(redirecting.fetchIndex()).rejects.toBeInstanceOf(
      MarketplaceRegistryProtocolError,
    );

    const unavailable = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async () => response({}, 503),
    });
    await expect(unavailable.fetchIndex()).rejects.toBeInstanceOf(
      MarketplaceRegistryUnavailableError,
    );
    const notFound = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async () => response({}, 404),
    });
    await expect(notFound.fetchIndex()).rejects.toBeInstanceOf(
      MarketplaceRegistryNotFoundError,
    );

    const oversized = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      maxIndexBytes: 10,
      fetch: async () => response({ schemaVersion: 3, entries: [] }),
    });
    await expect(oversized.fetchIndex()).rejects.toBeInstanceOf(
      MarketplaceRegistryProtocolError,
    );
    const timedOut = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      timeoutMs: 1,
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
    expect(DEFAULT_MARKETPLACE_REGISTRY_ARTIFACT_MAX_BYTES).toBeGreaterThan(0);
  });

  test('local reads do not call the registry and updates are monotonic', async () => {
    let calls = 0;
    const packageBundle = bundle();
    const client = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async () => {
        calls += 1;
        return response(indexFor(packageBundle));
      },
    });
    const root = mkdtempSync(join(tmpdir(), 'marketplace-offline-'));
    try {
      const service = new MarketplaceService({
        rootDir: root,
        registryClient: client,
      });
      service.importFile(join(root, 'missing.json'));
    } catch {
      // The missing local source is intentionally a local failure.
    }
    try {
      expect(calls).toBe(0);
      const service = new MarketplaceService({
        rootDir: root,
        registryClient: client,
      });
      expect(service.list()).toEqual([]);
      expect(calls).toBe(0);
      await expect(
        service.updateRemote('community/registry-agent'),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves the installed state after every remote validation failure', async () => {
    const interruptedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"schemaVersion":3'));
        controller.error(new Error('connection interrupted'));
      },
    });
    const failures = [
      async () => response({ schemaVersion: 3, entries: [] }),
      async (input: RequestInfo | URL) => {
        const index = indexFor(bundle());
        (index.entries as any)[0].digest.value = '0'.repeat(64);
        return String(input) === MARKETPLACE_REGISTRY_INDEX_URL
          ? response(index)
          : response(bundle());
      },
      async (input: RequestInfo | URL) => {
        const index = indexFor(bundle());
        (index.entries as any)[0].summary.displayName = 'Forged';
        return String(input) === MARKETPLACE_REGISTRY_INDEX_URL
          ? response(index)
          : response(bundle());
      },
      async (input: RequestInfo | URL) => {
        const incompatible = bundle(
          '1.0.0',
          'community/registry-agent',
          '>=99.0.0',
        );
        return String(input) === MARKETPLACE_REGISTRY_INDEX_URL
          ? response(indexFor(incompatible))
          : response(incompatible);
      },
      async (input: RequestInfo | URL) =>
        String(input) === MARKETPLACE_REGISTRY_INDEX_URL
          ? response(indexFor(bundle()))
          : new Response(interruptedBody, { status: 200 }),
    ];

    for (const failure of failures) {
      const root = mkdtempSync(join(tmpdir(), 'marketplace-preserve-'));
      try {
        const service = new MarketplaceService({
          rootDir: root,
          pluginVersion: '3.1.0',
          registryClient: new MarketplaceRegistryClient({
            pluginVersion: '3.1.0',
            fetch: failure,
          }),
        });
        const installed = service.install(bundle());
        const beforeLock = readFileSync(service.store.paths.lockfilePath);
        const beforePackage = readFileSync(
          join(installed.path, 'package.json'),
        );
        await expect(
          service.installRemote('community/registry-agent'),
        ).rejects.toThrow();
        expect(readFileSync(service.store.paths.lockfilePath)).toEqual(
          beforeLock,
        );
        expect(readFileSync(join(installed.path, 'package.json'))).toEqual(
          beforePackage,
        );
        expect(service.show('community/registry-agent').manifest.version).toBe(
          '1.0.0',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
