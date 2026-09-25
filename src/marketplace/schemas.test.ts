import { describe, expect, test } from 'bun:test';
import {
  MarketplaceAgentManifestSchema,
  MarketplacePackageManifestSchema,
  MarketplacePackageManifestV3Schema,
  MarketplaceVersionSchema,
} from './schemas';

const common = {
  schemaVersion: 2 as const,
  id: 'community/example',
  version: '1.0.0',
  displayName: 'Example',
  description: 'An example package',
  agentName: 'example',
  prompt: 'Follow these instructions.',
  author: { name: 'Example Community' },
  tags: ['example'],
  license: 'MIT',
  compatibility: { plugin: '>=3.0.0-beta.3 <4.0.0' },
  routing: {
    description: 'Explore example code.',
    when: 'When exploration is needed.',
    keywords: ['example'],
  },
  skills: [],
  mcps: [],
  tools: [],
  model: { source: 'explicit' as const, candidates: ['provider/model'] },
};

const commonV3 = {
  ...common,
  schemaVersion: 3 as const,
  routing: {
    lane: 'Bounded implementation work.',
    stats: ['Fast execution', 'Low context overhead'],
    delegateWhen: ['The task has a clear implementation boundary.'],
    avoid: ['Architecture decisions'],
    additionalInstructions: ['Report changed files and validation.'],
  },
};

describe('agents-only marketplace manifest schemas', () => {
  test('rejects non-canonical semantic-version aliases', () => {
    expect(MarketplaceVersionSchema.safeParse('v1.0.0').success).toBe(false);
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        version: 'v1.0.0',
      }).success,
    ).toBe(false);
  });

  test('accepts standalone and single-builtin extension agents', () => {
    expect(MarketplaceAgentManifestSchema.safeParse(common).success).toBe(true);
    expect(
      MarketplaceAgentManifestSchema.safeParse({
        ...common,
        extends: { builtin: 'explorer', promptMode: 'append' },
        model: { source: 'builtin' },
      }).success,
    ).toBe(true);
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        extends: {
          builtin: 'explorer',
          promptMode: 'append',
          extra: true,
        },
      }).success,
    ).toBe(false);
  });

  test('accepts v3 routing and keeps the manifest union version-aware', () => {
    expect(MarketplacePackageManifestV3Schema.safeParse(commonV3).success).toBe(
      true,
    );
    expect(MarketplaceAgentManifestSchema.safeParse(commonV3).success).toBe(
      true,
    );
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        schemaVersion: 3,
        routing: commonV3.routing,
      }).success,
    ).toBe(true);
  });

  test('rejects invalid v3 routing values and publisher-authored policy fields', () => {
    const invalidCases = [
      { routing: { ...commonV3.routing, lane: 'line\nwrapped' } },
      { routing: { ...commonV3.routing, lane: 'x'.repeat(161) } },
      {
        routing: { ...commonV3.routing, stats: ['duplicate', 'duplicate'] },
      },
      { routing: { ...commonV3.routing, stats: [] } },
      { routing: { ...commonV3.routing, delegateWhen: [] } },
      { routing: { ...commonV3.routing, avoid: [] } },
      {
        routing: {
          ...commonV3.routing,
          additionalInstructions: Array.from({ length: 9 }, () => 'x'),
        },
      },
      {
        extends: { builtin: 'explorer', promptMode: 'replace' },
      },
      { permission: { read: 'allow' } },
      { capabilities: ['read'] },
    ];

    for (const invalid of invalidCases) {
      expect(
        MarketplacePackageManifestV3Schema.safeParse({
          ...commonV3,
          ...invalid,
        }).success,
      ).toBe(false);
    }
  });

  test('rejects extension-only builtin model policy for standalone agents', () => {
    expect(
      MarketplaceAgentManifestSchema.safeParse({
        ...common,
        model: { source: 'builtin' },
      }).success,
    ).toBe(false);
  });

  test('rejects executable, duplicate, and unknown manifest fields', () => {
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        scripts: { install: 'rm -rf /' },
      }).success,
    ).toBe(false);
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        id: 'Community/Example',
      }).success,
    ).toBe(false);
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        tools: ['read', 'read'],
      }).success,
    ).toBe(false);
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        unknownField: true,
      }).success,
    ).toBe(false);
  });
});
