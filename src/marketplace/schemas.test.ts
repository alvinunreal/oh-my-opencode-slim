import { describe, expect, test } from 'bun:test';
import {
  MarketplaceAgentManifestSchema,
  MarketplacePackageManifestSchema,
  MarketplaceProfileManifestSchema,
} from './schemas';

const common = {
  schemaVersion: 1 as const,
  id: 'community/example',
  version: '1.0.0',
  displayName: 'Example',
  description: 'An example package',
  instructions: 'Follow these instructions.',
  author: { name: 'Example Community' },
  tags: ['example'],
  license: 'MIT',
  compatibility: {
    plugin: '>=2.2.0 <3.0.0 || >=3.0.0-beta.0 <4.0.0',
    roleContract: '^1.0.0',
  },
  routing: {
    description: 'Explore example code.',
    keywords: ['example'],
    delegation: { when: 'When exploration is needed.', preferredRoles: [] },
  },
  requirements: {
    skills: { required: [], optional: [] },
    mcps: { required: [], optional: [] },
  },
  capabilities: { tools: [], permissions: [] },
};

describe('marketplace manifest schemas', () => {
  test('accept only data-only agent and profile manifests', () => {
    expect(
      MarketplaceAgentManifestSchema.safeParse({
        ...common,
        kind: 'agent',
        baseRole: 'fixer',
        agentName: 'example',
        overrides: {},
      }).success,
    ).toBe(true);
    expect(
      MarketplaceProfileManifestSchema.safeParse({
        ...common,
        kind: 'profile',
        targetRole: 'oracle',
        instructionMode: 'append',
        overrides: {},
      }).success,
    ).toBe(true);
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        kind: 'agent',
        baseRole: 'orchestrator',
        agentName: 'example',
        overrides: {},
      }).success,
    ).toBe(false);
  });

  test('rejects executable or non-canonical manifest fields', () => {
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        kind: 'agent',
        baseRole: 'explorer',
        agentName: 'example',
        overrides: {},
        scripts: { install: 'rm -rf /' },
      }).success,
    ).toBe(false);
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        id: 'Community/Example',
        kind: 'agent',
        baseRole: 'explorer',
        agentName: 'example',
        overrides: {},
      }).success,
    ).toBe(false);
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        kind: 'agent',
        baseRole: 'explorer',
        agentName: 'example',
        overrides: {},
        version: '^1.0.0',
      }).success,
    ).toBe(false);
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        kind: 'agent',
        baseRole: 'explorer',
        agentName: 'example',
        overrides: { promptSuffix: 'not canonical' },
      }).success,
    ).toBe(false);
  });

  test('rejects duplicate capabilities', () => {
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        capabilities: { tools: ['read', 'read'], permissions: [] },
        kind: 'agent',
        baseRole: 'explorer',
        agentName: 'example',
        overrides: {},
      }).success,
    ).toBe(false);
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        capabilities: {
          tools: [],
          permissions: ['network.fetch', 'network.fetch'],
        },
        kind: 'agent',
        baseRole: 'explorer',
        agentName: 'example',
        overrides: {},
      }).success,
    ).toBe(false);
  });

  test('rejects overlapping required and optional requirements', () => {
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        requirements: {
          skills: { required: ['code-search'], optional: ['code-search'] },
          mcps: { required: [], optional: [] },
        },
        kind: 'agent',
        baseRole: 'explorer',
        agentName: 'example',
        overrides: {},
      }).success,
    ).toBe(false);
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...common,
        requirements: {
          skills: { required: [], optional: [] },
          mcps: { required: ['crawl4ai'], optional: ['crawl4ai'] },
        },
        kind: 'agent',
        baseRole: 'explorer',
        agentName: 'example',
        overrides: {},
      }).success,
    ).toBe(false);
  });
});
