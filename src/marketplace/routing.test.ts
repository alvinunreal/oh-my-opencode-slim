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
import type {
  MarketplacePackageManifest,
  MarketplacePackageManifestV3,
} from './schemas';
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

const v3Manifest: MarketplacePackageManifestV3 = {
  schemaVersion: 3,
  id: 'community/routing-v3-agent',
  version: '1.0.0',
  displayName: 'Routing v3 agent',
  description: 'A v3 standalone routing agent.',
  agentName: 'routing-v3-agent',
  prompt: 'Package prompt.',
  routing: {
    lane: 'Deterministic package lane.',
    stats: ['Fast implementation', 'Low context overhead'],
    delegateWhen: ['The task has a bounded implementation scope.'],
    avoid: ['Architecture decisions', 'Visual design work'],
    additionalInstructions: ['Return a concise implementation summary.'],
  },
  skills: ['simplify'],
  mcps: ['context7'],
  tools: ['read', 'apply_patch'],
  author: { name: 'Community' },
  tags: ['routing'],
  license: 'MIT',
  compatibility: { plugin: '>=3.0.0-beta.3 <4.0.0' },
  model: { source: 'explicit', candidates: ['provider/model'] },
};

function expectedSuffix(manifest: MarketplacePackageManifest): string {
  return [
    `- Lane: ${manifest.routing.description}`,
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

  test('renders v3 standalone routing deterministically in source order', () => {
    expect(renderMarketplaceAutoDelegationBlock(v3Manifest)).toBe(
      [
        '@routing-v3-agent',
        '- Lane: Deterministic package lane.',
        '- Role: A v3 standalone routing agent.',
        '- Capabilities: Tools: read, apply_patch; Skills: simplify; MCPs: context7',
        '- Stats: Fast implementation • Low context overhead',
        '- **Delegate when:** The task has a bounded implementation scope.',
        '- **Avoid:** Architecture decisions • Visual design work',
        '- **Additional instructions:** Return a concise implementation summary.',
      ].join('\n'),
    );
  });

  test('renders v3 extensions after the current base-role block', () => {
    const manifest: MarketplacePackageManifestV3 = {
      ...v3Manifest,
      extends: { builtin: 'fixer', promptMode: 'append' },
    };
    expect(renderMarketplaceAutoDelegationBlock(manifest, 'build-agent')).toBe(
      [
        ROLE_DEFINITIONS.fixer.routingBlock.replaceAll(
          '@fixer',
          '@build-agent',
        ),
        '',
        '- Lane: Deterministic package lane.',
        '- Stats: Fast implementation • Low context overhead',
        '- **Delegate when:** The task has a bounded implementation scope.',
        '- **Avoid:** Architecture decisions • Visual design work',
        '- **Additional instructions:** Return a concise implementation summary.',
      ].join('\n'),
    );
  });

  test('keeps v3 routing metadata in the orchestrator prompt only', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-routing-v3-'));
    try {
      const manifest = {
        ...v3Manifest,
        skills: [],
        mcps: [],
        tools: [],
      } satisfies MarketplacePackageManifestV3;
      const store = new MarketplaceStore({ rootDir: root });
      store.install({ manifest });
      RuntimeConfig.reset(root);
      const runtime = RuntimeConfig.init(root, {
        preset: 'work',
        presets: {
          work: {
            agents: {},
            marketplace: { agents: [manifest.id] },
          },
        },
      });
      const registry = buildResolvedAgentRegistry(runtime, {
        marketplaceStore: store,
        availableMcpNames: [],
      });
      const activatedAgent = registry.agents.find(
        (agent) => agent.name === manifest.agentName,
      );
      const route = registry.routing.find(
        (entry) => entry.agentName === manifest.agentName,
      );
      const orchestrator = registry.agents.find(
        (agent) => agent.name === 'orchestrator',
      );

      expect(activatedAgent?.config.prompt).toBe(manifest.prompt);
      for (const metadata of [
        '- Package:',
        '- Package lane:',
        '**Delegate when:**',
        '**Avoid:**',
      ]) {
        expect(activatedAgent?.config.prompt).not.toContain(metadata);
      }
      for (const metadata of ['- Stats:', '**Delegate when:**', '**Avoid:**']) {
        expect(route?.routingBlock).toContain(metadata);
        expect(orchestrator?.config.prompt).toContain(metadata);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      const activatedAgent = registry.agents.find(
        (agent) => agent.name === 'routing-agent',
      );
      const orchestrator = registry.agents.find(
        (agent) => agent.name === 'orchestrator',
      );

      expect(route?.routingBlock).toBe(
        renderMarketplaceAutoDelegationBlock(manifest, 'build-agent'),
      );
      expect(activatedAgent?.config.prompt).toBe(manifest.prompt);
      expect(activatedAgent?.config.prompt).not.toContain('- Package:');
      expect(activatedAgent?.config.prompt).not.toContain('- Package lane:');
      expect(activatedAgent?.config.prompt).not.toContain('- Stats:');
      expect(activatedAgent?.config.prompt).not.toContain('**Delegate when:**');
      expect(orchestrator?.config.prompt).toContain(route?.routingBlock ?? '');
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
