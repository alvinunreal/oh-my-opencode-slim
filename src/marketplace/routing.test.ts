import { describe, expect, test } from 'bun:test';
import { ROLE_ROUTING_BLOCKS } from '../agents/role-routing';
import { SUPPORTED_SPECIALIST_ROLES } from '../config/agent-roles';
import { renderMarketplaceAutoDelegationBlock } from './routing';
import type {
  MarketplacePackageManifest,
  MarketplacePackageManifestV3,
} from './schemas';

const manifest: MarketplacePackageManifest = {
  schemaVersion: 2,
  id: 'community/routing-agent',
  version: '1.0.0',
  displayName: 'Routing agent',
  description: 'A standalone routing agent.',
  agentName: 'routing-agent',
  prompt: 'Package prompt.',
  routing: {
    description: 'Package routing description.',
    when: 'The task matches this package.',
    keywords: ['routing'],
  },
  skills: [],
  mcps: [],
  tools: [],
  author: { name: 'Community' },
  tags: ['routing'],
  license: 'MIT',
  compatibility: { plugin: '>=3.0.0-beta.3 <4.0.0' },
  model: { source: 'explicit', candidates: ['provider/model'] },
};

describe('marketplace routing renderer', () => {
  test('preserves built-in routing bytes and substitutes the agent name', () => {
    for (const builtin of SUPPORTED_SPECIALIST_ROLES) {
      const extended = {
        ...manifest,
        extends: { builtin, promptMode: 'append' },
      } as MarketplacePackageManifest;
      expect(renderMarketplaceAutoDelegationBlock(extended)).toBe(
        `${ROLE_ROUTING_BLOCKS[builtin].replaceAll(`@${builtin}`, '@routing-agent')}\n\n- Lane: Package routing description.\n- **Delegate when:** The task matches this package.`,
      );
    }
  });

  test('renders standalone v2 package routing', () => {
    expect(renderMarketplaceAutoDelegationBlock(manifest)).toBe(
      '@routing-agent\n- Lane: A standalone routing agent.\n\n- Lane: Package routing description.\n- **Delegate when:** The task matches this package.',
    );
  });

  test('renders the v3 routing and capability fields', () => {
    const v3: MarketplacePackageManifestV3 = {
      ...manifest,
      schemaVersion: 3,
      routing: {
        lane: 'Focused routing.',
        stats: ['Fast'],
        delegateWhen: ['The task is bounded.'],
        avoid: ['Architecture decisions'],
      },
      tools: ['read'],
    };
    expect(renderMarketplaceAutoDelegationBlock(v3)).toBe(
      '@routing-agent\n- Lane: Focused routing.\n- Role: A standalone routing agent.\n- Capabilities: Tools: read\n- Stats: Fast\n- **Delegate when:** The task is bounded.\n- **Avoid:** Architecture decisions',
    );
  });
});
