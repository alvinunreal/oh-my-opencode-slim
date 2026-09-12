import { describe, expect, test } from 'bun:test';
import {
  MarketplaceAgentManifestSchema,
  MarketplacePackageManifestSchema,
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
