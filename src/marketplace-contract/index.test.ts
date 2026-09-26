import { describe, expect, test } from 'bun:test';
import { ROLE_ROUTING_BLOCKS } from '../agents/role-routing';
import type { MarketplacePackageManifest } from '../marketplace/schemas';
import {
  createMarketplaceRegistryEntry,
  createMarketplaceRegistryEntryV3,
  createMarketplaceRegistryIndex,
  createMarketplaceRegistryIndexV3,
  MARKETPLACE_REGISTRY_SCHEMA_VERSION,
  type MarketplaceRegistryEntry,
  type MarketplaceRegistryEntryV3,
  MarketplaceRegistryIndexSchema,
  MarketplaceRegistryIndexV3Schema,
  parseMarketplaceRegistryIndex,
  parseMarketplaceRegistryIndexV3,
  parseMarketplaceRegistrySelector,
  renderDefaultMarketplaceAutoDelegationBlock,
  resolveMarketplaceRegistryEntry,
  validateMarketplaceRegistryEntry,
  validateMarketplaceRegistryEntryV3,
} from './index';

const manifest: MarketplacePackageManifest = {
  schemaVersion: 2,
  id: 'community/contract-agent',
  version: '1.0.0',
  displayName: 'Contract agent',
  description: 'A contract test agent.',
  agentName: 'contract-agent',
  prompt: 'Package prompt.',
  routing: {
    description: 'Contract routing description.',
    when: 'The contract task matches.',
    keywords: ['contract'],
  },
  skills: [],
  mcps: [],
  tools: [],
  author: { name: 'Community' },
  tags: ['contract'],
  license: 'MIT',
  compatibility: { plugin: '>=3.0.0-beta.3 <4.0.0' },
  model: { source: 'explicit', candidates: ['provider/model'] },
  extends: { builtin: 'explorer', promptMode: 'append' },
};

describe('marketplace contract routing export', () => {
  test('exports the same authoritative default extension block', () => {
    const expected = `${ROLE_ROUTING_BLOCKS.explorer.replaceAll(
      '@explorer',
      '@contract-agent',
    )}\n\n- Lane: Contract routing description.\n- **Delegate when:** The contract task matches.`;

    expect(renderDefaultMarketplaceAutoDelegationBlock(manifest)).toBe(
      expected,
    );
  });

  test('selects the explicit v3 registry contract without widening v2 parsing', () => {
    const v3Manifest = {
      ...manifest,
      schemaVersion: 3 as const,
      routing: {
        lane: 'Contract lane.',
        stats: ['Fast'],
        delegateWhen: ['The contract task matches.'],
        avoid: ['Unbounded work.'],
      },
    };
    const entry = createMarketplaceRegistryEntryV3({
      manifest: v3Manifest,
    });
    const index = createMarketplaceRegistryIndexV3([entry]);

    expect(parseMarketplaceRegistryIndexV3(index)).toEqual(index);
    expect(() => parseMarketplaceRegistryIndex(index)).toThrow();
  });

  test('normalizes selectors and resolves the highest compatible version', () => {
    expect(
      parseMarketplaceRegistrySelector('  COMMUNITY/contract-agent  '),
    ).toEqual({
      id: 'community/contract-agent',
    });
    expect(
      parseMarketplaceRegistrySelector('COMMUNITY/contract-agent@1.0.0'),
    ).toEqual({
      id: 'community/contract-agent',
      version: '1.0.0',
    });
    expect(() =>
      parseMarketplaceRegistrySelector('community/invalid@wat'),
    ).toThrow();

    const older = createMarketplaceRegistryEntry({
      manifest: { ...manifest, version: '1.0.0' },
    });
    const newer = createMarketplaceRegistryEntry({
      manifest: { ...manifest, version: '1.2.0' },
    });
    const index = createMarketplaceRegistryIndex([newer, older]);
    expect(index.entries.map((entry) => entry.version)).toEqual([
      '1.0.0',
      '1.2.0',
    ]);
    expect(
      resolveMarketplaceRegistryEntry(
        index,
        { id: 'community/contract-agent' },
        { pluginVersion: '3.1.0' },
      ).version,
    ).toBe('1.2.0');
    expect(
      resolveMarketplaceRegistryEntry(
        index,
        { id: 'community/contract-agent' },
        { pluginVersion: '3.1.0' },
        '1.0.0',
      ).version,
    ).toBe('1.2.0');
  });

  test('projects prompt-free summaries and validates artifact identity/digest', () => {
    const entry = createMarketplaceRegistryEntry({ manifest });
    expect(entry.summary).not.toHaveProperty('prompt');
    expect(entry.digest.value).toMatch(/^[0-9a-f]{64}$/);
    expect(createMarketplaceRegistryIndex([entry]).entries).toEqual([entry]);
  });

  test('rejects duplicate and unsorted registry entries', () => {
    const entry = createMarketplaceRegistryEntry({ manifest });
    expect(() => createMarketplaceRegistryIndex([entry, entry])).toThrow();
    const later = createMarketplaceRegistryEntry({
      manifest: { ...manifest, id: 'z/contract-agent' },
    });
    expect(() =>
      parseMarketplaceRegistryIndex({
        schemaVersion: MARKETPLACE_REGISTRY_SCHEMA_VERSION,
        entries: [later, entry],
      }),
    ).toThrow();
  });

  test('invalid semantic versions make both index schemas fail safely', () => {
    const v2Entry = createMarketplaceRegistryEntry({ manifest });
    const v3Entry = createMarketplaceRegistryEntryV3({
      manifest: {
        ...manifest,
        schemaVersion: 3,
        routing: {
          lane: 'Contract lane.',
          stats: ['Fast'],
          delegateWhen: ['The contract task matches.'],
          avoid: ['Unbounded work.'],
        },
      },
    });
    const invalidVersion = 'not-semver';

    expect(() =>
      MarketplaceRegistryIndexSchema.safeParse({
        schemaVersion: 3,
        entries: [
          {
            ...v2Entry,
            version: invalidVersion,
            artifactPath: `artifacts/community/contract-agent/${invalidVersion}.json`,
            summary: { ...v2Entry.summary, version: invalidVersion },
          },
        ],
      }),
    ).not.toThrow();
    expect(
      MarketplaceRegistryIndexSchema.safeParse({
        schemaVersion: 3,
        entries: [
          {
            ...v2Entry,
            version: invalidVersion,
            artifactPath: `artifacts/community/contract-agent/${invalidVersion}.json`,
            summary: { ...v2Entry.summary, version: invalidVersion },
          },
        ],
      }).success,
    ).toBe(false);

    expect(() =>
      MarketplaceRegistryIndexV3Schema.safeParse({
        schemaVersion: 3,
        entries: [
          {
            ...v3Entry,
            version: invalidVersion,
            artifactPath: `artifacts/community/contract-agent/${invalidVersion}.json`,
            summary: { ...v3Entry.summary, version: invalidVersion },
          },
        ],
      }),
    ).not.toThrow();
    expect(
      MarketplaceRegistryIndexV3Schema.safeParse({
        schemaVersion: 3,
        entries: [
          {
            ...v3Entry,
            version: invalidVersion,
            artifactPath: `artifacts/community/contract-agent/${invalidVersion}.json`,
            summary: { ...v3Entry.summary, version: invalidVersion },
          },
        ],
      }).success,
    ).toBe(false);
  });

  test('entry validators reject malformed digests and inconsistent identities', () => {
    const bundle = { manifest };
    const v2Entry = createMarketplaceRegistryEntry(bundle);
    const v3Bundle = {
      manifest: {
        ...manifest,
        schemaVersion: 3 as const,
        routing: {
          lane: 'Contract lane.',
          stats: ['Fast'],
          delegateWhen: ['The contract task matches.'],
          avoid: ['Unbounded work.'],
        },
      },
    };
    const v3Entry = createMarketplaceRegistryEntryV3(v3Bundle);

    expect(() =>
      validateMarketplaceRegistryEntry(
        {
          ...v2Entry,
          digest: { ...v2Entry.digest, domain: 'wrong' },
        } as unknown as MarketplaceRegistryEntry,
        bundle,
      ),
    ).toThrow();
    expect(() =>
      validateMarketplaceRegistryEntry(
        { ...v2Entry, id: 'community/other' },
        bundle,
      ),
    ).toThrow();
    expect(() =>
      validateMarketplaceRegistryEntryV3(
        {
          ...v3Entry,
          digest: { ...v3Entry.digest, algorithm: 'wrong' },
        } as unknown as MarketplaceRegistryEntryV3,
        v3Bundle,
      ),
    ).toThrow();
    expect(() =>
      validateMarketplaceRegistryEntryV3(
        { ...v3Entry, id: 'community/other' },
        v3Bundle,
      ),
    ).toThrow();
  });
});
