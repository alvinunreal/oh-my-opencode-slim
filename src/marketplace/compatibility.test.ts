import { describe, expect, test } from 'bun:test';
import {
  MarketplaceCompatibilityError,
  MarketplaceService,
  satisfiesPluginCompatibility,
} from './index';
import type { MarketplacePackageBundle } from './schemas';

const bundle: MarketplacePackageBundle = {
  manifest: {
    schemaVersion: 1,
    id: 'community/compatible',
    version: '1.0.0',
    kind: 'profile',
    displayName: 'Compatible profile',
    description: 'A compatible profile.',
    instructions: 'Append these instructions.',
    author: { name: 'Community' },
    tags: ['test'],
    license: 'MIT',
    compatibility: {
      plugin: '>=2.2.0 <3.0.0 || >=3.0.0-beta.0 <4.0.0',
      roleContract: '^1.0.0',
    },
    routing: {
      description: 'Use for compatibility tests.',
      keywords: ['test'],
      delegation: { when: 'When testing.', preferredRoles: [] },
    },
    requirements: {
      skills: { required: ['one'], optional: ['two'] },
      mcps: { required: [], optional: ['three'] },
    },
    capabilities: { tools: ['read'], permissions: ['filesystem.read'] },
    targetRole: 'oracle',
    instructionMode: 'append',
    overrides: {},
  },
};

describe('marketplace compatibility', () => {
  test('supports bounded exact and comparator plugin ranges', () => {
    expect(satisfiesPluginCompatibility('2.2.18', '>=2.2.0 <3.0.0')).toBe(true);
    expect(satisfiesPluginCompatibility('3.0.0', '>=2.2.0 <3.0.0')).toBe(false);
    expect(satisfiesPluginCompatibility('2.2.18', '^2.0.0')).toBe(true);
  });

  test('rejects incompatible packages before persistence', () => {
    const service = new MarketplaceService({
      rootDir: '/tmp/marketplace-compatibility-test',
      pluginVersion: '1.0.0',
    });
    expect(() => service.install(bundle)).toThrow(
      MarketplaceCompatibilityError,
    );
  });
});
