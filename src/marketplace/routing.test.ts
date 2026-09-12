import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildResolvedAgentRegistry } from '../agents';
import {
  ROLE_DEFINITIONS,
  SUPPORTED_SPECIALIST_ROLES,
} from '../agents/role-definitions';
import { RuntimeConfig } from '../config/runtime';
import { renderDefaultMarketplaceAutoDelegationBlock } from '../marketplace-contract';
import { renderMarketplaceAutoDelegationBlock } from './routing';
import type { MarketplacePackageManifest } from './schemas';
import { MarketplaceStore } from './store';

const baseManifest: MarketplacePackageManifest = {
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

function expectedSuffix(manifest: MarketplacePackageManifest): string {
  return [
    `- Package: ${manifest.displayName}`,
    `- ${manifest.routing.description}`,
    `- **Delegate when:** ${manifest.routing.when}`,
  ].join('\n');
}

describe('marketplace routing renderer', () => {
  test('renders every supported extension role exactly', () => {
    for (const roleName of SUPPORTED_SPECIALIST_ROLES) {
      const manifest = {
        ...baseManifest,
        extends: { builtin: roleName, promptMode: 'append' },
      } as MarketplacePackageManifest;
      const expected = `${ROLE_DEFINITIONS[roleName].routingBlock.replaceAll(
        `@${roleName}`,
        `@${manifest.agentName}`,
      )}\n\n${expectedSuffix(manifest)}`;

      expect(renderMarketplaceAutoDelegationBlock(manifest)).toBe(expected);
    }
  });

  test('does not vary routing for append versus replace prompt modes', () => {
    for (const promptMode of ['append', 'replace'] as const) {
      const manifest = {
        ...baseManifest,
        extends: { builtin: 'explorer', promptMode },
      } as MarketplacePackageManifest;
      const expected = `${ROLE_DEFINITIONS.explorer.routingBlock.replaceAll(
        '@explorer',
        `@${manifest.agentName}`,
      )}\n\n${expectedSuffix(manifest)}`;

      expect(renderMarketplaceAutoDelegationBlock(manifest)).toBe(expected);
    }
  });

  test('renders standalone packages with the generic routing block', () => {
    const expected = [
      '@routing-agent',
      '- Lane: A standalone routing agent.',
      '',
      expectedSuffix(baseManifest),
    ].join('\n');

    expect(renderMarketplaceAutoDelegationBlock(baseManifest)).toBe(expected);
  });

  test('renders a runtime display alias without changing the manifest default', () => {
    const derived = {
      ...baseManifest,
      extends: { builtin: 'fixer', promptMode: 'append' as const },
    };

    expect(renderMarketplaceAutoDelegationBlock(derived, 'build-agent')).toBe(
      `${ROLE_DEFINITIONS.fixer.routingBlock.replaceAll(
        '@fixer',
        '@build-agent',
      )}\n\n${expectedSuffix(derived)}`,
    );
    expect(renderMarketplaceAutoDelegationBlock(derived)).toContain(
      '@routing-agent',
    );
  });

  test('uses the shared default renderer in the resolved routing registry', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-routing-'));
    try {
      const manifest = {
        ...baseManifest,
        extends: { builtin: 'oracle', promptMode: 'replace' as const },
      };
      const store = new MarketplaceStore({ rootDir: root });
      store.install({ manifest });
      RuntimeConfig.reset(root);
      const runtime = RuntimeConfig.init(root, {
        preset: 'work',
        presets: {
          work: {
            agents: { 'routing-agent': { displayName: 'build-agent' } },
            marketplace: { agents: ['community/routing-agent'] },
          },
        },
      });
      const registry = buildResolvedAgentRegistry(runtime, {
        marketplaceStore: store,
        availableMcpNames: [],
      });
      const route = registry.routing.find(
        (entry) => entry.agentName === 'build-agent',
      );

      expect(route?.routingBlock).toBe(
        renderMarketplaceAutoDelegationBlock(manifest, 'build-agent'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps custom orchestrator guidance and runtime aliases authoritative', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-routing-custom-'));
    try {
      const manifest = {
        ...baseManifest,
        extends: { builtin: 'oracle', promptMode: 'append' as const },
      };
      const store = new MarketplaceStore({ rootDir: root });
      store.install({ manifest });
      RuntimeConfig.reset(root);
      const runtime = RuntimeConfig.init(root, {
        preset: 'work',
        presets: {
          work: {
            agents: {
              'routing-agent': {
                displayName: 'build-agent',
                orchestratorPrompt: 'Use @routing-agent for this task.',
              },
            },
            marketplace: { agents: ['community/routing-agent'] },
          },
        },
      });
      const registry = buildResolvedAgentRegistry(runtime, {
        marketplaceStore: store,
        availableMcpNames: [],
      });
      const route = registry.routing.find(
        (entry) => entry.agentName === 'build-agent',
      );
      const roleRouting = ROLE_DEFINITIONS.oracle.routingBlock.replaceAll(
        '@oracle',
        '@build-agent',
      );

      expect(route?.routingBlock).toBe(
        `${roleRouting}\n\nUse @build-agent for this task.`,
      );
      expect(route?.routingBlock).not.toContain('- Package:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps an owner description in standalone runtime routing only', () => {
    const root = mkdtempSync(
      join(tmpdir(), 'marketplace-routing-description-'),
    );
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install({ manifest: baseManifest });
      RuntimeConfig.reset(root);
      const runtime = RuntimeConfig.init(root, {
        preset: 'work',
        presets: {
          work: {
            agents: {
              'routing-agent': {
                description: 'Owner-selected standalone lane.',
              },
            },
            marketplace: { agents: ['community/routing-agent'] },
          },
        },
      });
      const registry = buildResolvedAgentRegistry(runtime, {
        marketplaceStore: store,
        availableMcpNames: [],
      });
      const runtimeBlock = [
        '@routing-agent',
        '- Lane: Owner-selected standalone lane.',
        '',
        expectedSuffix(baseManifest),
      ].join('\n');
      const publicBlock =
        renderDefaultMarketplaceAutoDelegationBlock(baseManifest);
      const route = registry.routing.find(
        (entry) => entry.agentName === 'routing-agent',
      );
      const orchestrator = registry.agents.find(
        (agent) => agent.name === 'orchestrator',
      );

      expect(route?.routingBlock).toBe(runtimeBlock);
      expect(orchestrator?.config.prompt).toContain(runtimeBlock);
      expect(publicBlock).toBe(
        [
          '@routing-agent',
          '- Lane: A standalone routing agent.',
          '',
          expectedSuffix(baseManifest),
        ].join('\n'),
      );
      expect(publicBlock).not.toContain('Owner-selected standalone lane.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
