import { describe, expect, test } from 'bun:test';
import {
  MarketplaceCompatibilityError,
  MarketplaceService,
  satisfiesPluginCompatibility,
} from './index';
import type { MarketplacePackageBundle } from './schemas';

const bundle: MarketplacePackageBundle = {
  manifest: {
    schemaVersion: 2,
    id: 'community/compatible',
    version: '1.0.0',
    displayName: 'Compatible agent',
    description: 'A compatible agent.',
    agentName: 'compatible',
    prompt: 'Append these instructions.',
    author: { name: 'Community' },
    tags: ['test'],
    license: 'MIT',
    compatibility: { plugin: '>=3.0.0-beta.3 <4.0.0' },
    routing: {
      description: 'Use for compatibility tests.',
      keywords: ['test'],
      when: 'When testing.',
    },
    skills: ['one'],
    mcps: [],
    tools: ['read'],
    model: { source: 'explicit', candidates: ['provider/model'] },
  },
};

describe('marketplace compatibility', () => {
  test('supports bounded exact and comparator plugin ranges', () => {
    expect(satisfiesPluginCompatibility('2.2.18', '>=2.2.0 <3.0.0')).toBe(true);
    expect(satisfiesPluginCompatibility('3.0.0', '>=2.2.0 <3.0.0')).toBe(false);
    expect(satisfiesPluginCompatibility('2.2.18', '^2.0.0')).toBe(true);
  });

  test('rejects incompatible agents before persistence', () => {
    const service = new MarketplaceService({
      rootDir: '/tmp/marketplace-compatibility-test',
      pluginVersion: '1.0.0',
    });
    expect(() => service.install(bundle)).toThrow(
      MarketplaceCompatibilityError,
    );
  });
});
