import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MarketplacePackageBundle } from '../marketplace-contract';
import {
  canonicalizeMarketplaceValue,
  createMarketplaceRegistryEntry,
  createMarketplaceRegistryIndex,
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
  MarketplaceRetiredError,
} from './errors';
import {
  DEFAULT_MARKETPLACE_REGISTRY_ARTIFACT_MAX_BYTES,
  MARKETPLACE_REGISTRY_INDEX_URL,
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
      schemaVersion: 1,
      id,
      version,
      kind: 'agent',
      displayName: 'Registry agent',
      description: 'A registry test package.',
      instructions: 'Use the explorer role.',
      author: { name: 'Community' },
      tags: ['registry'],
      license: 'MIT',
      compatibility: { plugin, roleContract: '^1.0.0' },
      routing: {
        description: 'Explore registry fixtures.',
        keywords: ['registry'],
        delegation: {
          when: 'When testing registry installs.',
          preferredRoles: [],
        },
      },
      requirements: {
        skills: { required: [], optional: [] },
        mcps: { required: [], optional: [] },
      },
      capabilities: { tools: [], permissions: [] },
      baseRole: 'explorer',
      agentName: 'registryagent',
      overrides: {},
    },
  };
}

function indexFor(packageBundle = bundle()): Record<string, unknown> {
  const manifest = packageBundle.manifest;
  return {
    schemaVersion: 1,
    entries: [
      {
        id: manifest.id,
        version: manifest.version,
        artifactPath: registryArtifactPath(manifest.id, manifest.version),
        digest: {
          algorithm: 'sha256',
          domain: 'marketplace-bundle-v1',
          value: digestMarketplaceBundle(packageBundle),
        },
        summary: projectMarketplaceManifestSummary(manifest),
      },
    ],
  };
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
      schemaVersion: 1,
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
      schemaVersion: 1,
      entries: [
        ...(indexFor(bundle('1.0.0')).entries as unknown[]),
        ...(indexFor(bundle('2.0.0')).entries as unknown[]),
      ],
    });
    expect(
      resolveMarketplaceRegistryEntry(
        index,
        { id: 'community/registry-agent' },
        { pluginVersion: '3.1.0', roleContractVersion: '1.0.0' },
      ).version,
    ).toBe('2.0.0');
    expect(() =>
      parseMarketplaceRegistrySelector('community/registry-agent@^1.0.0'),
    ).toThrow();
    expect(() =>
      parseMarketplaceRegistrySelector('community/registry-agent@v1.0.0'),
    ).toThrow();
  });

  test('validates v2 retirement tombstones and rejects retired selectors', () => {
    const first = indexFor(bundle('1.0.0', 'community/alpha'));
    const second = indexFor(bundle('1.0.0', 'community/beta'));
    const entries = [
      ...(first.entries as unknown[]),
      ...(second.entries as unknown[]),
    ];
    expect(
      parseMarketplaceRegistryIndex({
        schemaVersion: 2,
        entries,
        retirements: [{ id: 'community/alpha' }],
      }).schemaVersion,
    ).toBe(2);
    expect(() =>
      parseMarketplaceRegistryIndex({
        schemaVersion: 2,
        entries,
        retirements: [{ id: 'community/missing' }],
      }),
    ).toThrow('no registry entry');
    expect(() =>
      parseMarketplaceRegistryIndex({
        schemaVersion: 2,
        entries,
        retirements: [{ id: 'community/alpha' }, { id: 'community/alpha' }],
      }),
    ).toThrow('Duplicate');
    expect(() =>
      parseMarketplaceRegistryIndex({
        schemaVersion: 2,
        entries,
        retirements: [{ id: 'community/beta' }, { id: 'community/alpha' }],
      }),
    ).toThrow('sorted');

    const index = parseMarketplaceRegistryIndex({
      schemaVersion: 2,
      entries,
      retirements: [{ id: 'community/alpha' }],
    });
    for (const selector of [
      { id: 'community/alpha' },
      { id: 'community/alpha', version: '1.0.0' },
    ]) {
      expect(() =>
        resolveMarketplaceRegistryEntry(index, selector, {
          pluginVersion: '3.1.0',
          roleContractVersion: '1.0.0',
        }),
      ).toThrow(MarketplaceRetiredError);
    }
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
        registryClient: client,
      });
      const installed = await service.installRemote('community/registry-agent');
      expect(installed.manifest.version).toBe('1.0.0');
      expect(
        service.store.getLockfile().packages['community/registry-agent'].source,
      ).toEqual({
        kind: 'registry',
        registry: 'https://registry.ohmyopencodeslim.com/v1/',
        indexUrl: MARKETPLACE_REGISTRY_INDEX_URL,
        packageUrl:
          'https://registry.ohmyopencodeslim.com/v1/artifacts/community/registry-agent/1.0.0.json',
      });
      expect(calls).toEqual([
        MARKETPLACE_REGISTRY_INDEX_URL,
        'https://registry.ohmyopencodeslim.com/v1/artifacts/community/registry-agent/1.0.0.json',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects policy-retired remote selectors before any fetch', async () => {
    let fetches = 0;
    const client = new MarketplaceRegistryClient({
      pluginVersion: '3.1.0',
      fetch: async () => {
        fetches += 1;
        return response({});
      },
    });
    await expect(
      client.download('alvin/deepwork-recon@1.0.0'),
    ).rejects.toBeInstanceOf(MarketplaceRetiredError);
    expect(fetches).toBe(0);

    const root = mkdtempSync(join(tmpdir(), 'marketplace-retired-remote-'));
    try {
      let downloads = 0;
      const service = new MarketplaceService({
        rootDir: root,
        registryClient: {
          download: async () => {
            downloads += 1;
            throw new Error('registry client should not be called');
          },
        },
      });
      await expect(
        service.installRemote('alvin/deepwork-implementer'),
      ).rejects.toBeInstanceOf(MarketplaceRetiredError);
      await expect(
        service.updateRemote('alvin/deepwork-reviewer'),
      ).rejects.toBeInstanceOf(MarketplaceRetiredError);
      expect(downloads).toBe(0);
      expect(existsSync(service.store.paths.lockfilePath)).toBe(false);
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
      fetch: async () => response({ schemaVersion: 1, entries: [] }),
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
        controller.enqueue(new TextEncoder().encode('{"schemaVersion":1'));
        controller.error(new Error('connection interrupted'));
      },
    });
    const failures = [
      async () => response({ schemaVersion: 1, entries: [] }),
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
