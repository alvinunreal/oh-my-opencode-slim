import { describe, expect, test } from 'bun:test';
import { SPECIALIST_DESCRIPTIONS } from '../agents/role-descriptions';
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
  test('uses the native built-in role description with the package name', () => {
    for (const builtin of SUPPORTED_SPECIALIST_ROLES) {
      const extended = {
        ...manifest,
        extends: { builtin, promptMode: 'append' },
      } as MarketplacePackageManifest;
      expect(renderMarketplaceAutoDelegationBlock(extended)).toBe(
        `@routing-agent — ${SPECIALIST_DESCRIPTIONS[builtin]}\n\n- Lane: Package routing description.\n- **Delegate when:** The task matches this package.`,
      );
    }
  });

  test('renders standalone v2 package routing', () => {
    expect(renderMarketplaceAutoDelegationBlock(manifest)).toBe(
      '@routing-agent\n- Lane: A standalone routing agent.\n\n- Lane: Package routing description.\n- **Delegate when:** The task matches this package.',
    );
  });

  test('resolves a raw legacy librarian extension to the explorer role block', () => {
    // Stored manifests are byte-faithful: raw manifests can still carry
    // `librarian`, which has no specialist description entry. Render and
    // produce exactly the bytes the resolved manifest would produce.
    const v3Base = {
      ...manifest,
      schemaVersion: 3 as const,
      routing: {
        lane: 'Focused routing.',
        stats: ['Fast'],
        delegateWhen: ['The task is bounded.'],
        avoid: ['Architecture decisions'],
      },
      tools: ['read'],
    };
    for (const schemaVersion of [2, 3] as const) {
      const base = schemaVersion === 2 ? manifest : v3Base;
      const legacy = {
        ...base,
        extends: { builtin: 'librarian', promptMode: 'append' },
      } as MarketplacePackageManifest;
      const resolved = {
        ...base,
        extends: { builtin: 'explorer', promptMode: 'append' },
      } as MarketplacePackageManifest;
      expect(renderMarketplaceAutoDelegationBlock(legacy)).toBe(
        renderMarketplaceAutoDelegationBlock(resolved),
      );
    }
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

  test('includes v3 extension capabilities after the shared role description', () => {
    const v3Extension: MarketplacePackageManifestV3 = {
      ...manifest,
      schemaVersion: 3,
      routing: {
        lane: 'Focused routing.',
        stats: ['Fast', 'Bounded'],
        delegateWhen: ['The task is bounded.'],
        avoid: ['Architecture decisions'],
      },
      tools: ['read', 'grep'],
      skills: ['skill-a'],
      mcps: ['server-a'],
      extends: { builtin: 'explorer', promptMode: 'append' },
    };
    const roleBlock = `@routing-agent — ${SPECIALIST_DESCRIPTIONS.explorer}`;

    expect(renderMarketplaceAutoDelegationBlock(v3Extension)).toBe(
      `${roleBlock}\n\n- Lane: Focused routing.\n- Capabilities: Tools: read, grep; Skills: skill-a; MCPs: server-a\n- Stats: Fast • Bounded\n- **Delegate when:** The task is bounded.\n- **Avoid:** Architecture decisions`,
    );
  });

  test('omits the v3 extension capability line when all capability lists are empty', () => {
    const v3Extension: MarketplacePackageManifestV3 = {
      ...manifest,
      schemaVersion: 3,
      routing: {
        lane: 'Focused routing.',
        stats: ['Fast'],
        delegateWhen: ['The task is bounded.'],
        avoid: ['Architecture decisions'],
      },
      extends: { builtin: 'explorer', promptMode: 'append' },
    };
    const roleBlock = `@routing-agent — ${SPECIALIST_DESCRIPTIONS.explorer}`;

    expect(renderMarketplaceAutoDelegationBlock(v3Extension)).toBe(
      `${roleBlock}\n\n- Lane: Focused routing.\n- Stats: Fast\n- **Delegate when:** The task is bounded.\n- **Avoid:** Architecture decisions`,
    );
  });
});
