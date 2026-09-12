import { describe, expect, test } from 'bun:test';
import { ROLE_DEFINITIONS } from '../agents/role-definitions';
import type { MarketplacePackageManifest } from '../marketplace/schemas';
import { renderDefaultMarketplaceAutoDelegationBlock } from './index';

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
    )}\n\n- Package: Contract agent\n- Contract routing description.\n- **Delegate when:** The contract task matches.`;

    expect(renderDefaultMarketplaceAutoDelegationBlock(manifest)).toBe(
      expected,
    );
  });
});
