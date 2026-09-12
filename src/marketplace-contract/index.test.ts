import { describe, expect, test } from 'bun:test';
import { ROLE_DEFINITIONS } from '../agents/role-definitions';
import type { MarketplacePackageManifest } from '../marketplace/schemas';
import {
  createMarketplaceRegistryEntryV3,
  createMarketplaceRegistryIndexV3,
  parseMarketplaceRegistryIndex,
  parseMarketplaceRegistryIndexV3,
  renderDefaultMarketplaceAutoDelegationBlock,
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
    const expected = `${ROLE_DEFINITIONS.explorer.routingBlock.replaceAll(
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
});
