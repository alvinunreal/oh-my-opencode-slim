import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildResolvedAgentRegistry,
  resolveDesiredMarketplaceLiveFromDisk,
} from '../agents';
import { ROLE_DEFINITIONS } from '../agents/role-definitions';
import type { PluginConfig } from '../config';
import { loadPluginConfig } from '../config/loader';
import { RuntimeConfig } from '../config/runtime';
import { resolveRuntimeAgentName } from '../utils/agent-variant';
import {
  disableMarketplacePackage,
  enableMarketplaceAgent,
} from './activation-config';
import type { MarketplacePackageBundle } from './schemas';
import { acquireMarketplaceLeaseForPaths, MarketplaceStore } from './store';

const previousConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
});

function agentBundle(
  overrides: Partial<MarketplacePackageBundle['manifest']> = {},
): MarketplacePackageBundle {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'community/docs-researcher',
      version: '1.0.0',
      displayName: 'Docs researcher',
      description: 'A derived explorer.',
      agentName: 'docsresearcher',
      prompt: 'Prefer documentation paths first.',
      author: { name: 'Community' },
      tags: ['docs'],
      license: 'MIT',
      compatibility: {
        plugin: '>=3.0.0-beta.3 <4.0.0',
      },
      routing: {
        description: 'Research docs and examples.',
        keywords: ['docs'],
        when: 'When docs research is needed.',
      },
      skills: [],
      mcps: [],
      tools: [],
      model: { source: 'explicit', candidates: ['provider/model'] },
      extends: { builtin: 'explorer', promptMode: 'append' },
      ...overrides,
    } as MarketplacePackageBundle['manifest'],
  };
}

function writeSkill(directory: string, name: string): void {
  mkdirSync(join(directory, name), { recursive: true });
  writeFileSync(
    join(directory, name, 'SKILL.md'),
    `---
name: ${name}
description: Test skill.
---

# ${name}
`,
  );
}

function registryFor(
  config: PluginConfig,
  store: MarketplaceStore,
  directory = 'marketplace-activation-test',
) {
  RuntimeConfig.reset(directory);
  const runtime = RuntimeConfig.init(directory, config);
  return buildResolvedAgentRegistry(runtime, {
    marketplaceStore: store,
    availableMcpNames: ['context7', 'gh_grep'],
  });
}

describe('marketplace runtime activation', () => {
  test('activates a derived agent from the effective preset', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(agentBundle());
      const registry = registryFor(
        {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        },
        store,
      );
      const derived = registry.agents.find(
        (agent) => agent.name === 'docsresearcher',
      );
      expect(derived?.baseRole).toBe('explorer');
      expect(derived?.config.prompt).toBe(
        `${ROLE_DEFINITIONS.explorer.basePrompt}\n\nPrefer documentation paths first.`,
      );
      expect(derived?.config.prompt).toContain(
        'READ-ONLY: inspect and report; do not modify files.',
      );
      expect(registry.mcpLists.docsresearcher).toEqual([]);
      expect(
        registry.routing.some((entry) => entry.agentName === 'docsresearcher'),
      ).toBe(true);
      expect(registry.provenance.docsresearcher).toBe(
        'marketplace-agent:community/docs-researcher@1.0.0',
      );
      expect(registry.diagnostics).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('user overrides win over package configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          model: { source: 'explicit', candidates: ['package/model'] },
          description: 'Package desc',
        }),
      );
      const registry = registryFor(
        {
          preset: 'work',
          presets: {
            work: {
              agents: {
                docsresearcher: {
                  model: 'user/model',
                  description: 'User desc',
                },
              },
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        },
        store,
      );
      const derived = registry.agents.find(
        (agent) => agent.name === 'docsresearcher',
      );
      expect(derived?.config.model).toBe('user/model');
      expect(derived?.description).toBe('User desc');
      expect(derived?.config.prompt).toContain(
        'Prefer documentation paths first.',
      );
      expect(registry.provenance.docsresearcher).toBe(
        'marketplace-agent:community/docs-researcher@1.0.0',
      );
      expect(registry.packageIdByRuntimeName.docsresearcher).toBe(
        'community/docs-researcher',
      );
      expect(registry.runtimeNameByPackageId['community/docs-researcher']).toBe(
        'docsresearcher',
      );
      expect(
        registry.routing.find((entry) => entry.agentName === 'docsresearcher')
          ?.routingBlock,
      ).toContain('Research docs and examples.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects colliding runtime names', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(agentBundle({ agentName: 'explorer' }));
      const registry = registryFor(
        {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        },
        store,
      );
      expect(
        registry.agents.some((agent) => agent.name === 'docsresearcher'),
      ).toBe(false);
      expect(registry.diagnostics[0]?.code).toBe('collision');
      expect(registry.marketplaceLive).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('disables packages with missing required dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          skills: ['not-a-real-skill'],
          mcps: [],
        }),
      );
      const registry = registryFor(
        {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        },
        store,
      );
      expect(
        registry.agents.some((agent) => agent.name === 'docsresearcher'),
      ).toBe(false);
      expect(registry.diagnostics[0]?.code).toBe('missing-required-dependency');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps optional missing dependencies from disabling a package', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          skills: [],
          mcps: [],
        }),
      );
      const registry = registryFor(
        {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        },
        store,
      );
      expect(
        registry.agents.some((agent) => agent.name === 'docsresearcher'),
      ).toBe(true);
      expect(
        registry.skillPermissions.docsresearcher?.['not-a-real-skill'],
      ).not.toBe('allow');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('classifies unreadable selected packages as operational', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      const installed = store.install(agentBundle());
      chmodSync(join(installed.path, 'package.json'), 0);
      try {
        const registry = registryFor(
          {
            preset: 'work',
            presets: {
              work: {
                marketplace: { agents: ['community/docs-researcher'] },
              },
            },
          },
          store,
        );
        expect(
          registry.diagnostics.some((entry) => entry.code === 'operational'),
        ).toBe(true);
        expect(registry.marketplaceLive).toEqual([]);
      } finally {
        chmodSync(join(installed.path, 'package.json'), 0o644);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('records missing and corrupt packages without creating agents', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      const missing = registryFor(
        {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/missing'] },
            },
          },
        },
        store,
      );
      expect(missing.diagnostics[0]?.code).toBe('missing');
      expect(
        missing.routing.some((entry) => entry.agentName === 'missing'),
      ).toBe(false);

      writeFileSync(store.paths.lockfilePath, '{bad json');
      const corrupt = registryFor(
        {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        },
        store,
        'marketplace-corrupt-test',
      );
      expect(corrupt.diagnostics[0]?.code).toBe('corrupt');
      expect(
        corrupt.agents.some((agent) => agent.name === 'docsresearcher'),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not contact the network while resolving activation', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('network should not be used');
    }) as typeof fetch;
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(agentBundle());
      expect(() =>
        registryFor(
          {
            preset: 'work',
            presets: {
              work: {
                marketplace: { agents: ['community/docs-researcher'] },
              },
            },
          },
          store,
        ),
      ).not.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('puts required package MCPs and routing in the final registry', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          skills: [],
          mcps: ['context7'],
        }),
      );
      RuntimeConfig.reset('marketplace-mcp-projection');
      const registry = buildResolvedAgentRegistry(
        RuntimeConfig.init('marketplace-mcp-projection', {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
        {
          marketplaceStore: store,
          preflightMcpNames: ['context7', 'gh_grep'],
          availableMcpNames: ['context7', 'gh_grep'],
        },
      );
      expect(registry.mcpLists.docsresearcher).toContain('context7');
      expect(
        (
          registry.sdkConfigs.docsresearcher.permission as Record<
            string,
            string
          >
        )['context7_*'],
      ).toBe('allow');
      expect(
        registry.routing.find((entry) => entry.agentName === 'docsresearcher')
          ?.routingBlock,
      ).toContain('When docs research is needed.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('disables only packages whose required MCP action namespace overlaps another available server', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(agentBundle({ mcps: ['context7'] }));
      store.install(
        agentBundle({
          id: 'community/private-researcher',
          agentName: 'privateresearcher',
          mcps: ['context7_private'],
        }),
      );
      store.install(
        agentBundle({
          id: 'community/other-researcher',
          agentName: 'otherresearcher',
          mcps: ['gh_grep'],
        }),
      );
      RuntimeConfig.reset('marketplace-mcp-namespace-collision');
      const registry = buildResolvedAgentRegistry(
        RuntimeConfig.init('marketplace-mcp-namespace-collision', {
          preset: 'work',
          presets: {
            work: {
              marketplace: {
                agents: [
                  'community/docs-researcher',
                  'community/private-researcher',
                  'community/other-researcher',
                ],
              },
            },
          },
        }),
        {
          marketplaceStore: store,
          preflightMcpNames: ['context7', 'context7_private', 'gh_grep'],
          availableMcpNames: ['context7', 'context7_private', 'gh_grep'],
        },
      );
      expect(registry.diagnostics).toEqual([
        {
          packageId: 'community/docs-researcher',
          code: 'ambiguous-mcp-namespace',
          message:
            'community/docs-researcher is disabled: ambiguous MCP action namespace between context7 and context7_private',
        },
        {
          packageId: 'community/private-researcher',
          code: 'ambiguous-mcp-namespace',
          message:
            'community/private-researcher is disabled: ambiguous MCP action namespace between context7_private and context7',
        },
      ]);
      expect(
        registry.agents.some((agent) => agent.name === 'docsresearcher'),
      ).toBe(false);
      expect(
        registry.agents.some((agent) => agent.name === 'privateresearcher'),
      ).toBe(false);
      expect(registry.mcpLists.docsresearcher).toBeUndefined();
      expect(
        registry.runtimeNameByPackageId['community/docs-researcher'],
      ).toBeUndefined();
      expect(registry.marketplaceLive).toEqual([
        expect.objectContaining({
          packageId: 'community/other-researcher',
          runtimeName: 'otherresearcher',
        }),
      ]);
      expect(registry.mcpLists.otherresearcher).toEqual(['gh_grep']);
      expect(
        registry.runtimeNameByPackageId['community/other-researcher'],
      ).toBe('otherresearcher');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not confuse unrelated available MCP server names', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(agentBundle({ mcps: ['context7'] }));
      RuntimeConfig.reset('marketplace-mcp-namespace-unrelated');
      const registry = buildResolvedAgentRegistry(
        RuntimeConfig.init('marketplace-mcp-namespace-unrelated', {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
        {
          marketplaceStore: store,
          preflightMcpNames: ['context7', 'context7private'],
          availableMcpNames: ['context7', 'context7private'],
        },
      );
      expect(registry.diagnostics).toEqual([]);
      expect(registry.mcpLists.docsresearcher).toEqual(['context7']);
      expect(registry.marketplaceLive).toEqual([
        expect.objectContaining({ packageId: 'community/docs-researcher' }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ['docs.v1', 'docs_v1'],
    ['docs_v1', 'docs.v1'],
    ['docs@v1', 'docs#v1'],
    ['docs.v1', 'docs_v1_private'],
    ['docs_v1_private', 'docs.v1'],
  ])(
    'rejects required MCP %s overlapping normalized namespace of %s',
    (required, other) => {
      const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
      try {
        const store = new MarketplaceStore({ rootDir: root });
        store.install(agentBundle({ mcps: [required] }));
        store.install(
          agentBundle({
            id: 'community/other-researcher',
            agentName: 'otherresearcher',
            mcps: ['gh_grep'],
          }),
        );
        const directory = `marketplace-mcp-normalized-${required}-${other}`;
        RuntimeConfig.reset(directory);
        const registry = buildResolvedAgentRegistry(
          RuntimeConfig.init(directory, {
            preset: 'work',
            presets: {
              work: {
                marketplace: {
                  agents: [
                    'community/docs-researcher',
                    'community/other-researcher',
                  ],
                },
              },
            },
          }),
          {
            marketplaceStore: store,
            preflightMcpNames: [required, other, 'gh_grep'],
            availableMcpNames: [required, 'gh_grep'],
          },
        );
        expect(registry.diagnostics).toEqual([
          {
            packageId: 'community/docs-researcher',
            code: 'ambiguous-mcp-namespace',
            message: `community/docs-researcher is disabled: ambiguous MCP action namespace between ${required} and ${other}`,
          },
        ]);
        expect(
          registry.runtimeNameByPackageId['community/docs-researcher'],
        ).toBeUndefined();
        expect(registry.marketplaceLive).toEqual([
          expect.objectContaining({
            packageId: 'community/other-researcher',
            runtimeName: 'otherresearcher',
          }),
        ]);
        expect(registry.mcpLists.otherresearcher).toEqual(['gh_grep']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('rejects a builtin MCP namespace overlapping a configured but unadmitted server', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    const project = join(root, 'project');
    try {
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(
        join(project, '.opencode', 'opencode.json'),
        JSON.stringify({
          mcp: {
            context7_private: {
              type: 'remote',
              url: 'http://127.0.0.1/mcp',
            },
          },
        }),
      );
      const store = new MarketplaceStore({ rootDir: join(root, 'store') });
      store.install(agentBundle({ mcps: ['context7'] }));
      RuntimeConfig.reset(project);
      const registry = buildResolvedAgentRegistry(
        RuntimeConfig.init(project, {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
        {
          marketplaceStore: store,
          projectDirectory: project,
          availableMcpNames: ['context7'],
        },
      );
      expect(registry.diagnostics).toEqual([
        {
          packageId: 'community/docs-researcher',
          code: 'ambiguous-mcp-namespace',
          message:
            'community/docs-researcher is disabled: ambiguous MCP action namespace between context7 and context7_private',
        },
      ]);
      expect(registry.marketplaceLive).toEqual([]);
      expect(
        registry.runtimeNameByPackageId['community/docs-researcher'],
      ).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not treat plugin-injected MCPs as preflight capabilities', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          skills: [],
          mcps: ['injected-plugin-mcp'],
        }),
      );
      RuntimeConfig.reset('marketplace-injected-mcp');
      const registry = buildResolvedAgentRegistry(
        RuntimeConfig.init('marketplace-injected-mcp', {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
        {
          marketplaceStore: store,
          availableMcpNames: ['injected-plugin-mcp'],
        },
      );
      expect(registry.diagnostics[0]?.code).toBe('missing-required-dependency');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preflights on-disk enabled skill directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    const skillRoot = join(root, 'skills');
    const bareRoot = join(root, 'bare');
    const nestedRoot = join(skillRoot, 'nested');
    const linkedRoot = join(root, 'linked-skills');
    try {
      mkdirSync(join(bareRoot, 'on-disk-skill'), { recursive: true });
      writeFileSync(
        join(bareRoot, 'on-disk-skill', 'README.md'),
        '# not a skill',
      );
      writeSkill(nestedRoot, 'on-disk-skill');
      mkdirSync(linkedRoot, { recursive: true });
      symlinkSync(
        join(nestedRoot, 'on-disk-skill'),
        join(linkedRoot, 'on-disk-skill'),
      );
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          skills: ['on-disk-skill'],
          mcps: [],
        }),
      );
      RuntimeConfig.reset('marketplace-disk-skill');
      const missing = buildResolvedAgentRegistry(
        RuntimeConfig.init('marketplace-disk-skill', {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
        { marketplaceStore: store, extraSkillDirectories: [bareRoot] },
      );
      expect(missing.diagnostics[0]?.code).toBe('missing-required-dependency');

      RuntimeConfig.reset('marketplace-disk-skill-ok');
      const present = buildResolvedAgentRegistry(
        RuntimeConfig.init('marketplace-disk-skill-ok', {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
        {
          marketplaceStore: store,
          extraSkillDirectories: [skillRoot],
        },
      );
      expect(
        present.agents.some((agent) => agent.name === 'docsresearcher'),
      ).toBe(true);

      RuntimeConfig.reset('marketplace-disk-skill-link');
      const linked = buildResolvedAgentRegistry(
        RuntimeConfig.init('marketplace-disk-skill-link', {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
        {
          marketplaceStore: store,
          extraSkillDirectories: [linkedRoot],
        },
      );
      expect(
        linked.agents.some((agent) => agent.name === 'docsresearcher'),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not treat host-snapshot MCPs as preflight capabilities', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          skills: [],
          mcps: ['injected-host-mcp'],
        }),
      );
      RuntimeConfig.reset('marketplace-host-mcp');
      const runtime = RuntimeConfig.init('marketplace-host-mcp', {
        preset: 'work',
        presets: {
          work: {
            marketplace: { agents: ['community/docs-researcher'] },
          },
        },
      });
      runtime.captureHostConfig({
        mcp: {
          'injected-host-mcp': {
            type: 'remote',
            url: 'http://127.0.0.1/mcp',
          },
        },
      });
      const registry = buildResolvedAgentRegistry(runtime, {
        marketplaceStore: store,
        projectDirectory: root,
      });
      expect(registry.diagnostics[0]?.code).toBe('missing-required-dependency');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not treat disabled on-disk OpenCode MCPs as available', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(
        join(project, '.opencode', 'opencode.json'),
        JSON.stringify({
          mcp: {
            'project-mcp': {
              type: 'remote',
              url: 'http://127.0.0.1/mcp',
              enabled: false,
            },
          },
        }),
      );
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          skills: [],
          mcps: ['project-mcp'],
        }),
      );
      RuntimeConfig.reset(project);
      const registry = buildResolvedAgentRegistry(
        RuntimeConfig.init(project, {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
        { marketplaceStore: store, projectDirectory: project },
      );
      expect(registry.diagnostics[0]?.code).toBe('missing-required-dependency');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('treats enabled on-disk OpenCode MCPs as available', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(
        join(project, '.opencode', 'opencode.json'),
        JSON.stringify({
          mcp: {
            'project-mcp': {
              type: 'remote',
              url: 'http://127.0.0.1/mcp',
            },
          },
        }),
      );
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          skills: [],
          mcps: ['project-mcp'],
        }),
      );
      RuntimeConfig.reset(project);
      const registry = buildResolvedAgentRegistry(
        RuntimeConfig.init(project, {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
        {
          marketplaceStore: store,
          projectDirectory: project,
          availableMcpNames: ['project-mcp'],
        },
      );
      expect(
        registry.agents.some((agent) => agent.name === 'docsresearcher'),
      ).toBe(true);
      expect(registry.mcpLists.docsresearcher).toContain('project-mcp');
      expect(
        (
          registry.sdkConfigs.docsresearcher.permission as Record<
            string,
            string
          >
        )['project-mcp_*'],
      ).toBe('allow');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('filters disabled on-disk skills and MCPs', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    const skillRoot = join(root, 'skills');
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeSkill(skillRoot, 'on-disk-skill');
      writeFileSync(
        join(project, '.opencode', 'opencode.json'),
        JSON.stringify({
          mcp: {
            'project-mcp': {
              type: 'remote',
              url: 'http://127.0.0.1/mcp',
            },
          },
        }),
      );
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          skills: ['on-disk-skill'],
          mcps: ['project-mcp'],
        }),
      );
      RuntimeConfig.reset(project);
      const registry = buildResolvedAgentRegistry(
        RuntimeConfig.init(project, {
          preset: 'work',
          disabled_skills: ['on-disk-skill'],
          disabled_mcps: ['project-mcp'],
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
        {
          marketplaceStore: store,
          projectDirectory: project,
          extraSkillDirectories: [skillRoot],
        },
      );
      expect(registry.diagnostics[0]?.code).toBe('missing-required-dependency');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores invalid empty MCP definitions and reads config.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(
        join(configHome, 'opencode', 'config.json'),
        JSON.stringify({
          mcp: {
            'config-json-mcp': {
              type: 'remote',
              url: 'http://127.0.0.1/mcp',
            },
          },
        }),
      );
      writeFileSync(
        join(project, '.opencode', 'opencode.json'),
        JSON.stringify({
          mcp: {
            'empty-mcp': {},
          },
        }),
      );
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          skills: [],
          mcps: ['empty-mcp'],
        }),
      );
      RuntimeConfig.reset(project);
      const missing = buildResolvedAgentRegistry(
        RuntimeConfig.init(project, {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
        { marketplaceStore: store, projectDirectory: project },
      );
      expect(missing.diagnostics[0]?.code).toBe('missing-required-dependency');

      store.install(
        agentBundle({
          id: 'community/config-json',
          agentName: 'configjson',
          skills: [],
          mcps: ['config-json-mcp'],
        }),
      );
      RuntimeConfig.reset(`${project}-ok`);
      const present = buildResolvedAgentRegistry(
        RuntimeConfig.init(`${project}-ok`, {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/config-json'] },
            },
          },
        }),
        { marketplaceStore: store, projectDirectory: project },
      );
      expect(present.agents.some((agent) => agent.name === 'configjson')).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('discovers hidden external skill directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    const previousHome = process.env.OPENCODE_TEST_HOME;
    try {
      process.env.OPENCODE_TEST_HOME = root;
      writeSkill(join(root, '.claude', 'skills', '.hidden'), 'hidden-skill');
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          skills: ['hidden-skill'],
          mcps: [],
        }),
      );
      RuntimeConfig.reset(root);
      const registry = buildResolvedAgentRegistry(
        RuntimeConfig.init(root, {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
        { marketplaceStore: store, projectDirectory: root },
      );
      expect(
        registry.agents.some((agent) => agent.name === 'docsresearcher'),
      ).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODE_TEST_HOME;
      else process.env.OPENCODE_TEST_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('filters explicit preflight skill and MCP names by disabled sets', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          skills: ['on-disk-skill'],
          mcps: ['project-mcp'],
        }),
      );
      RuntimeConfig.reset('marketplace-explicit-disabled');
      const registry = buildResolvedAgentRegistry(
        RuntimeConfig.init('marketplace-explicit-disabled', {
          preset: 'work',
          disabled_skills: ['on-disk-skill'],
          disabled_mcps: ['project-mcp'],
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
        {
          marketplaceStore: store,
          preflightSkillNames: ['on-disk-skill'],
          preflightMcpNames: ['project-mcp'],
        },
      );
      expect(registry.diagnostics[0]?.code).toBe('missing-required-dependency');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reserves custom names except the marketplace owner override key', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(agentBundle());
      const colliding = registryFor(
        {
          preset: 'work',
          agents: {
            docsresearcher: { displayName: 'janitor' },
            janitor: { model: 'custom/model' },
          },
          presets: {
            work: {
              agents: { janitor: { model: 'custom/model' } },
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        },
        store,
      );
      expect(colliding.diagnostics[0]?.code).toBe('collision');

      store.install(
        agentBundle({ id: 'community/janitor', agentName: 'janitor' }),
      );
      const ownKey = registryFor(
        {
          preset: 'work',
          agents: { janitor: { model: 'custom/model' } },
          presets: {
            work: {
              agents: { janitor: { model: 'custom/model' } },
              marketplace: { agents: ['community/janitor'] },
            },
          },
        },
        store,
        'marketplace-own-override',
      );
      const derived = ownKey.agents.find((agent) => agent.name === 'janitor');
      expect(derived?.config.model).toBe('custom/model');
      expect(ownKey.provenance.janitor).toBe(
        'marketplace-agent:community/janitor@1.0.0',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('treats a self-alias as a no-op', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          agentName: 'docsresearcher',
        }),
      );
      const registry = registryFor(
        {
          preset: 'work',
          presets: {
            work: {
              agents: { docsresearcher: { displayName: 'docsresearcher' } },
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        },
        store,
      );
      expect(
        registry.agents.some((agent) => agent.name === 'docsresearcher'),
      ).toBe(true);
      expect(registry.runtimeNameByPackageId['community/docs-researcher']).toBe(
        'docsresearcher',
      );
      expect(registry.canonicalIdByRuntimeName.docsresearcher).toBe(
        'docsresearcher',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('discovers skills from .claude and OPENCODE_CONFIG MCPs', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    const configHome = join(root, 'config');
    const previousHome = process.env.OPENCODE_TEST_HOME;
    const previousConfig = process.env.OPENCODE_CONFIG;
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      process.env.OPENCODE_TEST_HOME = root;
      writeSkill(join(root, '.claude', 'skills'), 'on-disk-skill');
      const customConfig = join(root, 'custom-opencode.json');
      writeFileSync(
        customConfig,
        JSON.stringify({
          mcp: {
            'config-mcp': {
              type: 'remote',
              url: 'http://127.0.0.1/mcp',
            },
          },
        }),
      );
      process.env.OPENCODE_CONFIG = customConfig;
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          skills: ['on-disk-skill'],
          mcps: ['config-mcp'],
        }),
      );
      RuntimeConfig.reset(root);
      const registry = buildResolvedAgentRegistry(
        RuntimeConfig.init(root, {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
        {
          marketplaceStore: store,
          projectDirectory: root,
          availableMcpNames: ['config-mcp'],
        },
      );
      expect(
        registry.agents.some((agent) => agent.name === 'docsresearcher'),
      ).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODE_TEST_HOME;
      else process.env.OPENCODE_TEST_HOME = previousHome;
      if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = previousConfig;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('disables unsafe display aliases without throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(agentBundle());
      const registry = registryFor(
        {
          preset: 'work',
          presets: {
            work: {
              agents: { docsresearcher: { displayName: 'Docs Researcher' } },
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        },
        store,
      );
      expect(
        registry.agents.some((agent) => agent.name === 'docsresearcher'),
      ).toBe(false);
      expect(registry.diagnostics[0]?.code).toBe('invalid-alias');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('isolates inactive package corruption from selected loads', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(agentBundle());
      store.install(
        agentBundle({
          id: 'community/other',
          agentName: 'otheragent',
        }),
      );
      writeFileSync(
        join(root, 'packages', 'community', 'other', '1.0.0', 'package.json'),
        '{"not":"a package"}',
      );
      const registry = registryFor(
        {
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        },
        store,
      );
      expect(
        registry.agents.some((agent) => agent.name === 'docsresearcher'),
      ).toBe(true);
      expect(registry.diagnostics).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves marketplace aliases from the final registry maps', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(
        agentBundle({
          model: { source: 'explicit', candidates: ['package/model'] },
        }),
      );
      const registry = registryFor(
        {
          preset: 'work',
          presets: {
            work: {
              agents: { docsresearcher: { displayName: 'docsalias' } },
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        },
        store,
      );
      expect(resolveRuntimeAgentName(registry, '@docsalias')).toBe(
        'docsresearcher',
      );
      expect(resolveRuntimeAgentName(registry, 'explore')).toBe('explorer');
      expect(registry.canonicalIdByRuntimeName.docsalias).toBe(
        'docsresearcher',
      );
      expect(registry.runtimeNameByPackageId['community/docs-researcher']).toBe(
        'docsalias',
      );
      expect(registry.marketplaceLive).toEqual([
        expect.objectContaining({
          packageId: 'community/docs-researcher',
          runtimeName: 'docsalias',
        }),
      ]);
      expect(
        (registry.sdkConfigs.docsalias.permission as Record<string, unknown>)[
          '*'
        ],
      ).toBe('deny');
      expect(
        (
          registry.sdkConfigs.docsresearcher.permission as Record<
            string,
            unknown
          >
        )['*'],
      ).toBe('deny');
      expect(registry.sdkConfigs.docsalias.model).toBe('package/model');
      expect(registry.sdkConfigs.docsresearcher.model).toBe('package/model');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('live identity uses final registry runtime name after user display override', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(agentBundle());
      const registry = registryFor(
        {
          preset: 'work',
          agents: { docsresearcher: { displayName: 'fieldscout' } },
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        },
        store,
      );
      expect(registry.runtimeNameByPackageId['community/docs-researcher']).toBe(
        'fieldscout',
      );
      expect(registry.marketplaceLive).toEqual([
        expect.objectContaining({
          packageId: 'community/docs-researcher',
          runtimeName: 'fieldscout',
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('desired live from disk does not mutate the session RuntimeConfig', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    mkdirSync(join(configHome, 'opencode'), { recursive: true });
    mkdirSync(join(project, '.opencode'), { recursive: true });
    process.env.XDG_CONFIG_HOME = configHome;
    writeFileSync(
      join(configHome, 'opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'work',
        presets: {
          work: {
            marketplace: { agents: ['community/docs-researcher'] },
          },
        },
      }),
    );
    const sessionDir = `${project}\0session`;
    try {
      const store = new MarketplaceStore({ rootDir: join(root, 'store') });
      store.install(agentBundle());
      writeFileSync(
        join(project, '.opencode', 'oh-my-opencode-slim.json'),
        JSON.stringify({
          agents: { docsresearcher: { displayName: 'docsalias' } },
        }),
      );
      RuntimeConfig.reset(sessionDir);
      const session = RuntimeConfig.init(sessionDir, {
        preset: 'session-preset',
      });
      session.captureHostConfig({ default_agent: 'build' });
      const desired = resolveDesiredMarketplaceLiveFromDisk(project, store);
      expect(desired.packages).toEqual([
        expect.objectContaining({
          packageId: 'community/docs-researcher',
          runtimeName: 'docsalias',
        }),
      ]);
      expect(RuntimeConfig.get(sessionDir).host()?.default_agent).toBe('build');
      expect(RuntimeConfig.get(sessionDir).plugin?.preset).toBe(
        'session-preset',
      );
    } finally {
      RuntimeConfig.reset(sessionDir);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('marketplace activation persistence', () => {
  test('enables and disables an installed agent on the active preset', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      const userConfig = join(
        configHome,
        'opencode',
        'oh-my-opencode-slim.json',
      );
      writeFileSync(
        userConfig,
        JSON.stringify({
          preset: 'work',
          presets: { work: {} },
        }),
      );
      const store = new MarketplaceStore({ rootDir: join(root, 'store') });
      store.install(agentBundle());
      enableMarketplaceAgent(project, 'community/docs-researcher', store);
      expect(existsSync(`${userConfig}.bak`)).toBe(true);
      expect(JSON.parse(readFileSync(userConfig, 'utf8'))).toEqual({
        preset: 'work',
        presets: {
          work: {
            marketplace: {
              agents_add: ['community/docs-researcher'],
            },
          },
        },
      });
      disableMarketplacePackage(project, 'community/docs-researcher');
      expect(
        JSON.parse(readFileSync(userConfig, 'utf8')).presets.work.marketplace
          .agents_add,
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('project enable keeps inherited user marketplace agents', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      const userConfig = join(
        configHome,
        'opencode',
        'oh-my-opencode-slim.json',
      );
      const projectConfig = join(
        project,
        '.opencode',
        'oh-my-opencode-slim.json',
      );
      writeFileSync(
        userConfig,
        JSON.stringify({
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
      );
      writeFileSync(
        projectConfig,
        JSON.stringify({
          preset: 'work',
          presets: { work: {} },
        }),
      );
      const store = new MarketplaceStore({ rootDir: join(root, 'store') });
      store.install(agentBundle());
      store.install(
        agentBundle({
          id: 'community/other',
          agentName: 'otheragent',
        }),
      );
      enableMarketplaceAgent(project, 'community/other', store);
      const merged = JSON.parse(readFileSync(projectConfig, 'utf8')) as {
        presets: {
          work: { marketplace: { agents_add: string[] } };
        };
      };
      expect(merged.presets.work.marketplace).toEqual({
        agents_add: ['community/other'],
      });
      expect(
        loadPluginConfig(project, { silent: true }).presets?.work,
      ).toMatchObject({
        marketplace: {
          agents: ['community/docs-researcher', 'community/other'],
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('child toggles preserve future parent additions and flat preset fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    const userConfig = join(configHome, 'opencode', 'oh-my-opencode-slim.json');
    const projectConfig = join(
      project,
      '.opencode',
      'oh-my-opencode-slim.json',
    );
    const a = 'community/docs-researcher';
    const b = 'community/other';
    const c = 'community/third';
    const d = 'community/fourth';
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      const writeParent = (agents: string[]) =>
        writeFileSync(
          userConfig,
          JSON.stringify({
            presets: {
              base: { marketplace: { agents } },
            },
          }),
        );
      const child = () =>
        JSON.parse(readFileSync(projectConfig, 'utf8')).presets.work;
      const active = () =>
        loadPluginConfig(project, { silent: true }).presets?.work?.marketplace
          ?.agents;
      writeParent([a, b]);
      writeFileSync(
        projectConfig,
        JSON.stringify({
          preset: 'work',
          presets: {
            work: { extends: 'base', oracle: { model: 'openai/gpt-5' } },
          },
        }),
      );
      const store = new MarketplaceStore({ rootDir: join(root, 'store') });
      store.install(agentBundle());
      store.install(agentBundle({ id: d, agentName: 'fourth' }));

      disableMarketplacePackage(project, a);
      expect(child().marketplace).toEqual({ agents_remove: [a] });
      writeParent([a, b, c]);
      expect(active()).toEqual([b, c]);
      enableMarketplaceAgent(project, d, store);
      expect(child().marketplace).toEqual({
        agents_add: [d],
        agents_remove: [a],
      });
      expect(active()).toEqual([b, c, d]);
      enableMarketplaceAgent(project, a, store);
      expect(child().marketplace).toEqual({
        agents_add: [d],
        agents_remove: [],
      });
      writeParent([a, c]);
      expect(active()).toEqual([a, c, d]);
      expect(child().oracle).toEqual({ model: 'openai/gpt-5' });
      disableMarketplacePackage(project, d);
      expect(child().marketplace).toEqual({
        agents_add: [],
        agents_remove: [],
      });
      expect(active()).toEqual([a, c]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('same-named user and project presets keep lower activation live', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    const userConfig = join(configHome, 'opencode', 'oh-my-opencode-slim.json');
    const projectConfig = join(
      project,
      '.opencode',
      'oh-my-opencode-slim.json',
    );
    const a = 'community/docs-researcher';
    const b = 'community/other';
    const c = 'community/third';
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      const writeUser = (agents: string[]) =>
        writeFileSync(
          userConfig,
          JSON.stringify({
            preset: 'work',
            presets: {
              work: {
                marketplace: { agents },
              },
            },
          }),
        );
      writeUser([a, b]);
      writeFileSync(
        projectConfig,
        JSON.stringify({
          presets: {
            work: { oracle: { model: 'openai/gpt-5' } },
          },
        }),
      );
      disableMarketplacePackage(project, a);
      writeUser([a, b, c]);
      expect(
        loadPluginConfig(project, { silent: true }).presets?.work?.marketplace
          ?.agents,
      ).toEqual([b, c]);
      const stored = JSON.parse(readFileSync(projectConfig, 'utf8'));
      expect(stored.presets.work.marketplace).toEqual({ agents_remove: [a] });
      const disabledContents = readFileSync(projectConfig, 'utf8');
      disableMarketplacePackage(project, a);
      expect(readFileSync(projectConfig, 'utf8')).toBe(disabledContents);
      const store = new MarketplaceStore({ rootDir: join(root, 'store') });
      store.install(agentBundle());
      enableMarketplaceAgent(project, a, store);
      expect(
        loadPluginConfig(project, { silent: true }).presets?.work?.marketplace
          ?.agents,
      ).toEqual([a, b, c]);
      expect(
        JSON.parse(readFileSync(projectConfig, 'utf8')).presets.work
          .marketplace,
      ).toEqual({ agents_remove: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('project enable cancels only the matching user-layer removal', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    const userConfig = join(configHome, 'opencode', 'oh-my-opencode-slim.json');
    const projectConfig = join(
      project,
      '.opencode',
      'oh-my-opencode-slim.json',
    );
    const a = 'community/docs-researcher';
    const b = 'community/other';
    const c = 'community/third';
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      const writeParent = (agents: string[]) =>
        writeFileSync(
          userConfig,
          JSON.stringify({
            preset: 'work',
            presets: {
              base: { marketplace: { agents } },
              work: { extends: 'base', marketplace: { agents_remove: [a, b] } },
            },
          }),
        );
      writeParent([a, b]);
      writeFileSync(
        projectConfig,
        JSON.stringify({
          presets: {
            work: { oracle: { model: 'openai/gpt-5' } },
          },
        }),
      );
      const local = () =>
        JSON.parse(readFileSync(projectConfig, 'utf8')).presets.work
          .marketplace;
      const active = () =>
        loadPluginConfig(project, { silent: true }).presets?.work?.marketplace
          ?.agents;
      const store = new MarketplaceStore({ rootDir: join(root, 'store') });
      store.install(agentBundle());

      enableMarketplaceAgent(project, a, store);
      expect(local()).toEqual({ agents_add: [a] });
      expect(active()).toEqual([a]);
      const enabledContents = readFileSync(projectConfig, 'utf8');
      enableMarketplaceAgent(project, a, store);
      expect(readFileSync(projectConfig, 'utf8')).toBe(enabledContents);

      writeParent([a, b, c]);
      expect(active()).toEqual([a, c]);
      expect(local()).toEqual({ agents_add: [a] });
      disableMarketplacePackage(project, a);
      expect(local()).toEqual({ agents_add: [] });
      expect(active()).toEqual([c]);
      const disabledContents = readFileSync(projectConfig, 'utf8');
      disableMarketplacePackage(project, a);
      expect(readFileSync(projectConfig, 'utf8')).toBe(disabledContents);
      enableMarketplaceAgent(project, a, store);
      expect(local()).toEqual({ agents_add: [a] });
      expect(active()).toEqual([a, c]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('normalizes existing package IDs before enabling or disabling', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      const configPath = join(
        configHome,
        'opencode',
        'oh-my-opencode-slim.json',
      );
      writeFileSync(
        configPath,
        JSON.stringify({
          preset: 'work',
          presets: {
            work: {
              marketplace: {
                agents: [' COMMUNITY/DOCS-RESEARCHER '],
              },
            },
          },
        }),
      );
      const store = new MarketplaceStore({ rootDir: join(root, 'store') });
      store.install(agentBundle());

      const originalContents = readFileSync(configPath, 'utf8');
      enableMarketplaceAgent(project, 'community/docs-researcher', store);
      expect(readFileSync(configPath, 'utf8')).toBe(originalContents);
      disableMarketplacePackage(project, ' COMMUNITY/DOCS-RESEARCHER ');
      expect(
        JSON.parse(readFileSync(configPath, 'utf8')).presets.work.marketplace
          .agents,
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves interpolated inheritance across user and project config', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    const previousBasePreset = process.env.MARKETPLACE_BASE_PRESET;
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      process.env.MARKETPLACE_BASE_PRESET = 'base';
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      const userConfig = join(
        configHome,
        'opencode',
        'oh-my-opencode-slim.json',
      );
      const projectConfig = join(
        project,
        '.opencode',
        'oh-my-opencode-slim.json',
      );
      writeFileSync(
        userConfig,
        JSON.stringify({
          presets: {
            base: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
      );
      writeFileSync(
        projectConfig,
        JSON.stringify({
          preset: 'work',
          presets: {
            work: { extends: '{env:MARKETPLACE_BASE_PRESET}' },
          },
        }),
      );
      const store = new MarketplaceStore({ rootDir: join(root, 'store') });
      store.install(agentBundle({ id: 'community/other', agentName: 'other' }));

      enableMarketplaceAgent(project, 'community/other', store);
      expect(
        JSON.parse(readFileSync(projectConfig, 'utf8')).presets.work.marketplace
          .agents_add,
      ).toEqual(['community/other']);
    } finally {
      if (previousBasePreset === undefined)
        delete process.env.MARKETPLACE_BASE_PRESET;
      else process.env.MARKETPLACE_BASE_PRESET = previousBasePreset;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retains an explicitly empty child activation after a no-op disable', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      const configPath = join(
        configHome,
        'opencode',
        'oh-my-opencode-slim.json',
      );
      writeFileSync(
        configPath,
        JSON.stringify({
          presets: {
            base: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
      );
      const projectConfig = join(
        project,
        '.opencode',
        'oh-my-opencode-slim.json',
      );
      writeFileSync(
        projectConfig,
        JSON.stringify({
          preset: 'work',
          presets: {
            work: {
              extends: 'base',
              marketplace: { agents: [] },
            },
          },
        }),
      );

      disableMarketplacePackage(project, 'community/not-enabled');
      const initialProjectContents = readFileSync(projectConfig, 'utf8');
      expect(
        JSON.parse(initialProjectContents).presets.work.marketplace,
      ).toEqual({ agents: [] });

      writeFileSync(
        configPath,
        JSON.stringify({
          presets: {
            base: {
              marketplace: {
                agents: ['community/docs-researcher', 'community/other'],
              },
            },
          },
        }),
      );
      disableMarketplacePackage(project, 'community/not-enabled');
      expect(readFileSync(projectConfig, 'utf8')).toBe(initialProjectContents);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('enabling an already active package leaves the config untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      const configPath = join(
        configHome,
        'opencode',
        'oh-my-opencode-slim.json',
      );
      const contents = `{
  "preset": "work",
   "presets": { "work": { "oracle": { "model": "openai/gpt-5" } } }
}\n`;
      writeFileSync(configPath, contents);
      const store = new MarketplaceStore({ rootDir: join(root, 'store') });
      store.install(agentBundle());

      enableMarketplaceAgent(project, 'community/docs-researcher', store);
      const enabledContents = readFileSync(configPath, 'utf8');
      enableMarketplaceAgent(project, 'community/docs-researcher', store);
      expect(readFileSync(configPath, 'utf8')).toBe(enabledContents);
      expect(JSON.parse(enabledContents).presets.work.oracle).toEqual({
        model: 'openai/gpt-5',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('persists the effective user/project activation after a real change', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      const userConfig = join(
        configHome,
        'opencode',
        'oh-my-opencode-slim.json',
      );
      const projectConfig = join(
        project,
        '.opencode',
        'oh-my-opencode-slim.json',
      );
      writeFileSync(
        userConfig,
        JSON.stringify({
          preset: 'work',
          presets: {
            work: {
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
      );
      writeFileSync(
        projectConfig,
        JSON.stringify({
          presets: {
            work: {
              marketplace: { agents: ['community/other'] },
              oracle: { model: 'openai/gpt-5' },
            },
          },
        }),
      );
      const store = new MarketplaceStore({ rootDir: join(root, 'store') });
      store.install(agentBundle());

      enableMarketplaceAgent(project, 'community/docs-researcher', store);
      const projectPreset = JSON.parse(readFileSync(projectConfig, 'utf8'))
        .presets.work;
      expect(projectPreset.marketplace.agents).toEqual([
        'community/other',
        'community/docs-researcher',
      ]);
      expect(projectPreset.oracle).toEqual({ model: 'openai/gpt-5' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not persist the selected inherited or environment preset name', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    const previousPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      process.env.OH_MY_OPENCODE_SLIM_PRESET = 'work';
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      const userConfig = join(
        configHome,
        'opencode',
        'oh-my-opencode-slim.json',
      );
      const projectConfig = join(
        project,
        '.opencode',
        'oh-my-opencode-slim.json',
      );
      writeFileSync(userConfig, JSON.stringify({ presets: { work: {} } }));
      writeFileSync(projectConfig, JSON.stringify({ presets: {} }));
      const store = new MarketplaceStore({ rootDir: join(root, 'store') });
      store.install(agentBundle());

      enableMarketplaceAgent(project, 'community/docs-researcher', store);
      expect(
        JSON.parse(readFileSync(projectConfig, 'utf8')),
      ).not.toHaveProperty('preset');
    } finally {
      if (previousPreset === undefined)
        delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
      else process.env.OH_MY_OPENCODE_SLIM_PRESET = previousPreset;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('competing activation writers keep both package enables', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    const storeRoot = join(root, 'store');
    const userConfig = join(configHome, 'opencode', 'oh-my-opencode-slim.json');
    const mutationLockRoot = join(
      configHome,
      'opencode',
      '.oh-my-opencode-slim.json.write-lock',
    );
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(
        userConfig,
        JSON.stringify({
          preset: 'work',
          presets: { work: {} },
        }),
      );
      const store = new MarketplaceStore({ rootDir: storeRoot });
      store.install(agentBundle());
      store.install(
        agentBundle({
          id: 'community/other',
          agentName: 'otheragent',
        }),
      );
      const spawnEnable = (packageId: string) =>
        Bun.spawn(
          [
            'bun',
            '-e',
            `import { writeFileSync } from 'node:fs';
import { enableMarketplaceAgent } from './src/marketplace/activation-config.ts';
import { MarketplaceStore } from './src/marketplace/store.ts';
const { directory, packageId, storeRoot, readyPath } = JSON.parse(process.argv[1]);
writeFileSync(readyPath, 'ready');
enableMarketplaceAgent(directory, packageId, new MarketplaceStore({ rootDir: storeRoot }));`,
            JSON.stringify({
              directory: project,
              packageId,
              storeRoot,
              readyPath: join(root, `${packageId.split('/')[1]}.ready`),
            }),
          ],
          {
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env, XDG_CONFIG_HOME: configHome },
          },
        );
      const configLease = acquireMarketplaceLeaseForPaths({
        rootDir: mutationLockRoot,
        packagesDir: join(mutationLockRoot, 'packages'),
        lockfilePath: join(mutationLockRoot, 'lock.json'),
        lockDir: join(mutationLockRoot, 'lock'),
        stagingDir: join(mutationLockRoot, '.staging'),
      });
      const workers = [
        spawnEnable('community/docs-researcher'),
        spawnEnable('community/other'),
      ];
      const readyPaths = [
        join(root, 'docs-researcher.ready'),
        join(root, 'other.ready'),
      ];
      try {
        const started = Date.now();
        while (!readyPaths.every(existsSync)) {
          if (Date.now() - started > 10_000) {
            throw new Error(
              'Timed out waiting for activation writers to start',
            );
          }
          await Bun.sleep(10);
        }
      } finally {
        configLease.release();
      }
      const exitCodes = await Promise.all(
        workers.map((worker) => worker.exited),
      );
      const errors = await Promise.all(
        workers.map((worker) => new Response(worker.stderr).text()),
      );
      if (exitCodes.some((code) => code !== 0)) {
        throw new Error(errors.join('\n'));
      }
      expect(exitCodes).toEqual([0, 0]);
      const enabledPackages = JSON.parse(readFileSync(userConfig, 'utf8'))
        .presets.work.marketplace.agents_add as string[];
      expect(enabledPackages).toHaveLength(2);
      expect(enabledPackages).toEqual(
        expect.arrayContaining([
          'community/docs-researcher',
          'community/other',
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
