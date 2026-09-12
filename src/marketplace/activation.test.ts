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
import { RuntimeConfig } from '../config/runtime';
import { resolveRuntimeAgentName } from '../utils/agent-variant';
import {
  disableMarketplacePackage,
  enableMarketplaceAgent,
} from './activation-config';
import type { MarketplacePackageBundle } from './schemas';
import { MarketplaceStore } from './store';

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
              agents: {},
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
      expect(derived?.config.prompt).toContain(
        ROLE_DEFINITIONS.explorer.basePrompt,
      );
      expect(derived?.config.prompt).toContain(
        'Prefer documentation paths first.',
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
              agents: {},
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
              agents: {},
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
              agents: {},
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
                agents: {},
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
              agents: {},
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
              agents: {},
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

  test('reports manually persisted retired activation without creating an agent', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-'));
    try {
      const store = new MarketplaceStore({ rootDir: root });
      const registry = registryFor(
        {
          preset: 'work',
          presets: {
            work: {
              agents: {},
              marketplace: {
                agents: ['alvin/deepwork-implementer'],
              },
            },
          },
        },
        store,
        'marketplace-retired-test',
      );
      expect(
        registry.agents.some((agent) => agent.name === 'implementer'),
      ).toBe(false);
      expect(registry.diagnostics).toEqual([
        {
          packageId: 'alvin/deepwork-implementer',
          code: 'retired',
          message:
            'alvin/deepwork-implementer is retired and will not be activated',
        },
      ]);
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
                agents: {},
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
              agents: {},
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
              agents: {},
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
              agents: {},
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
              agents: {},
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
              agents: {},
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
            agents: {},
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
              agents: {},
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
              agents: {},
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
              agents: {},
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
              agents: {},
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
              agents: {},
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
              agents: {},
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
              agents: {},
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
              agents: {},
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
              agents: {},
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
              agents: {},
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
            agents: {},
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
          presets: { work: { agents: {} } },
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
            agents: {},
            marketplace: {
              agents: ['community/docs-researcher'],
            },
          },
        },
      });
      disableMarketplacePackage(project, 'community/docs-researcher');
      expect(
        JSON.parse(readFileSync(userConfig, 'utf8')).presets.work.marketplace
          .agents,
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
              agents: {},
              marketplace: { agents: ['community/docs-researcher'] },
            },
          },
        }),
      );
      writeFileSync(
        projectConfig,
        JSON.stringify({
          preset: 'work',
          presets: { work: { agents: {} } },
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
          work: { marketplace: { agents: string[] } };
        };
      };
      expect(merged.presets.work.marketplace.agents).toEqual([
        'community/docs-researcher',
        'community/other',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('competing activation writers keep both package enables', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    const barrierDir = join(root, 'barriers');
    const storeRoot = join(root, 'store');
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      mkdirSync(barrierDir, { recursive: true });
      writeFileSync(join(barrierDir, 'config-rmw-read.wait'), 'wait');
      const userConfig = join(
        configHome,
        'opencode',
        'oh-my-opencode-slim.json',
      );
      writeFileSync(
        userConfig,
        JSON.stringify({
          preset: 'work',
          presets: { work: { agents: {} } },
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
            `import { enableMarketplaceAgent } from './src/marketplace/activation-config.ts';
import { MarketplaceStore } from './src/marketplace/store.ts';
const { directory, packageId, storeRoot } = JSON.parse(process.argv[1]);
enableMarketplaceAgent(directory, packageId, new MarketplaceStore({ rootDir: storeRoot }));`,
            JSON.stringify({
              directory: project,
              packageId,
              storeRoot,
            }),
          ],
          {
            stdout: 'pipe',
            stderr: 'pipe',
            env: {
              ...process.env,
              XDG_CONFIG_HOME: configHome,
              CONFIG_MUTATION_BARRIER_DIR: barrierDir,
            },
          },
        );
      const first = spawnEnable('community/docs-researcher');
      const started = Date.now();
      const reached = join(barrierDir, 'config-rmw-read.reached');
      while (!existsSync(reached)) {
        if (Date.now() - started > 8_000) {
          throw new Error('Timed out waiting for first writer barrier');
        }
        await Bun.sleep(10);
      }
      const second = spawnEnable('community/other');
      await Bun.sleep(80);
      writeFileSync(join(barrierDir, 'config-rmw-read.go'), 'go');
      const [firstCode, secondCode] = await Promise.all([
        first.exited,
        second.exited,
      ]);
      expect(firstCode).toBe(0);
      expect(secondCode).toBe(0);
      expect(
        JSON.parse(readFileSync(userConfig, 'utf8')).presets.work.marketplace
          .agents,
      ).toEqual(['community/docs-researcher', 'community/other']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
