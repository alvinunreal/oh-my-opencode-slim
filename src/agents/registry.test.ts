import { describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../config';
import { CouncilConfigSchema } from '../config/council-schema';
import { RuntimeConfig } from '../config/runtime';
import { COUNCIL_SYNTHESIS_REINFORCEMENT } from './council';
import {
  buildResolvedAgentRegistry,
  projectAgentPermission,
  type ResolvedAgentRegistry,
} from './index';
import {
  ROLE_DEFINITIONS,
  SUPPORTED_SPECIALIST_ROLES,
} from './role-definitions';
import { TASK_REJECTION_INSTRUCTION } from './task-rejection';

const DIRECTORY = 'resolved-agent-registry-test';

function registryFor(config: PluginConfig = {}): ResolvedAgentRegistry {
  RuntimeConfig.reset(DIRECTORY);
  const runtime = RuntimeConfig.init(DIRECTORY, config);
  return buildResolvedAgentRegistry(runtime);
}

describe('ResolvedAgentRegistry', () => {
  test('keeps SDK, model, skill, MCP, and routing surfaces consistent', () => {
    const registry = registryFor({
      agents: {
        explorer: {
          model: ['provider/primary', 'provider/fallback'],
          skills: ['simplify'],
          mcps: ['context7'],
        },
      },
    });

    expect(registry.agents.map((agent) => agent.name)).toContain('explorer');
    expect(registry.sdkConfigs.explorer.model).toBe('provider/primary');
    expect(registry.modelArrays.explorer).toEqual([
      { id: 'provider/primary' },
      { id: 'provider/fallback' },
    ]);
    expect(registry.modelChains.explorer).toEqual([
      'provider/primary',
      'provider/fallback',
    ]);
    expect(registry.mcpLists.explorer).toEqual(['context7']);
    expect(registry.skillPermissions.explorer.simplify).toBe('allow');
    expect(registry.runtimeNameByCanonicalId.explorer).toBe('explorer');
    expect(registry.canonicalIdByRuntimeName.explorer).toBe('explorer');
    expect(registry.routing.map((entry) => entry.agentName)).toEqual(
      [...registry.routing].map((entry) => entry.agentName).sort(),
    );
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.modelArrays.explorer)).toBe(true);
    expect(Object.isFrozen(registry.sdkConfigs.explorer)).toBe(true);
    expect(Object.isFrozen(registry.sdkConfigs.explorer.permission)).toBe(true);
  });

  test('does not expose special agents as supported role definitions', async () => {
    const { SUPPORTED_SPECIALIST_ROLES } = await import('./role-definitions');
    expect(SUPPORTED_SPECIALIST_ROLES).not.toContain('orchestrator');
    expect(SUPPORTED_SPECIALIST_ROLES).not.toContain('councillor');
  });

  test('preserves complete built-in role parity', () => {
    const registry = registryFor({ disabled_agents: [] });
    for (const roleName of SUPPORTED_SPECIALIST_ROLES) {
      const role = ROLE_DEFINITIONS[roleName];
      const agent = registry.agents.find((entry) => entry.name === roleName);
      expect(agent?.baseRole).toBe(roleName);
      expect(agent?.config.prompt).toContain(role.basePrompt);
      expect(agent?.description).toBe(role.description);
      expect(registry.mcpLists[roleName]).toEqual([...role.defaultMcps]);
      expect(registry.routing).toContainEqual(
        expect.objectContaining({ agentName: roleName }),
      );
      const permission = registry.sdkConfigs[roleName]?.permission as Record<
        string,
        unknown
      >;
      expect(permission.edit).toBe(
        role.permissionPolicy === 'read-write' ? 'allow' : 'deny',
      );
      for (const skill of role.defaultSkills) {
        expect(
          (registry.skillPermissions[roleName] as Record<string, unknown>)[
            skill
          ],
        ).toBe('allow');
      }
    }
  });

  test('discovers preset-only custom agents and preserves their model chains', () => {
    const registry = registryFor({
      preset: 'custom',
      presets: {
        custom: {
          agents: {
            auditOracle: {
              baseRole: 'oracle',
              model: ['provider/one', 'provider/two'],
            },
          },
        },
      },
    });

    expect(registry.agents.map((agent) => agent.name)).toContain('auditOracle');
    expect(registry.modelArrays.auditOracle).toEqual([
      { id: 'provider/one' },
      { id: 'provider/two' },
    ]);
    expect(registry.modelChains.auditOracle).toEqual([
      'provider/one',
      'provider/two',
    ]);
  });

  test('renders derived role routing against the runtime agent name', () => {
    const registry = registryFor({
      agents: {
        auditOracle: { baseRole: 'oracle', model: 'provider/oracle' },
      },
    });
    const route = registry.routing.find(
      (entry) => entry.agentName === 'auditOracle',
    );

    expect(route?.routingBlock).toContain('@auditOracle');
    expect(route?.routingBlock).not.toContain('@oracle');
    expect(
      registry.agents.find((agent) => agent.name === 'orchestrator')?.config
        .prompt,
    ).toContain('@auditOracle');
  });

  test('does not route an unconfigured or disabled council', () => {
    expect(registryFor().routing.map((entry) => entry.agentName)).not.toContain(
      'council',
    );
    expect(
      registryFor({ disabled_agents: ['council'] }).routing.map(
        (entry) => entry.agentName,
      ),
    ).not.toContain('council');
  });

  test('routes an enabled council exactly when it is registered', () => {
    const registry = registryFor({
      disabled_agents: [],
      council: CouncilConfigSchema.parse({
        presets: { default: { alpha: { model: 'provider/councillor' } } },
      }),
    });

    expect(registry.sdkConfigs.council).toBeDefined();
    expect(
      registry.routing.filter((entry) => entry.agentName === 'council'),
    ).toHaveLength(1);
  });

  test('renders council routing with its resolved display name', () => {
    const registry = registryFor({
      agents: { council: { displayName: 'consensus' } },
      council: CouncilConfigSchema.parse({
        presets: { default: { alpha: { model: 'provider/councillor' } } },
      }),
    });
    const route = registry.routing.find(
      (entry) => entry.agentName === 'consensus',
    );

    expect(route?.routingBlock).toContain('@consensus');
    expect(route?.routingBlock).not.toContain('@council');
  });

  test('folds custom and ACP routing guidance into one deterministic registry', () => {
    const rawCustomGuidance =
      'Use @janitor after @explorer completes the initial scan.';
    const customGuidance =
      'Use @janitor after @scout completes the initial scan.';
    const acpGuidance = 'Delegate provider research to @claude-research.';
    const registry = registryFor({
      agents: {
        explorer: { model: 'provider/explorer', displayName: 'scout' },
        janitor: {
          model: 'provider/janitor',
          orchestratorPrompt: rawCustomGuidance,
        },
      },
      acpAgents: {
        'claude-research': {
          command: 'claude-code-acp',
          args: [],
          env: {},
          timeoutMs: 0,
          permissionMode: 'ask',
          orchestratorPrompt: acpGuidance,
        },
      },
    });
    const orchestrator = registry.agents.find(
      (agent) => agent.name === 'orchestrator',
    );
    const prompt = orchestrator?.config.prompt ?? '';

    expect(
      registry.routing.filter((entry) =>
        entry.routingBlock.includes(customGuidance),
      ),
    ).toHaveLength(1);
    expect(
      registry.routing.filter((entry) =>
        entry.routingBlock.includes(acpGuidance),
      ),
    ).toHaveLength(1);
    expect(prompt.match(new RegExp(customGuidance, 'g'))).toHaveLength(1);
    expect(prompt.match(new RegExp(acpGuidance, 'g'))).toHaveLength(1);
    expect(registry.routing.map((entry) => entry.agentName)).toEqual(
      [...registry.routing].map((entry) => entry.agentName).sort(),
    );
    expect(registry.routing.map((entry) => entry.agentName)).toContain('scout');
    expect(registry.routing.map((entry) => entry.agentName)).not.toContain(
      'explorer',
    );
  });

  test('finalizes host fields and MCP permissions in owned registry projections', () => {
    RuntimeConfig.reset(DIRECTORY);
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: { explorer: { mcps: ['context7'] } },
    });
    runtime.captureHostConfig({
      agent: {
        explorer: {
          model: 'host/explorer',
          options: { nested: { value: 1 } },
          permission: {
            bash: { 'git status': 'allow' },
          },
        },
      },
      mcp: { context7: { type: 'remote' } },
    });
    const registry = buildResolvedAgentRegistry(runtime, {
      availableMcpNames: ['context7'],
    });
    const explorer = registry.sdkConfigs.explorer as Record<string, unknown>;
    const permission = explorer.permission as Record<string, unknown>;

    expect(explorer.model).toBe('host/explorer');
    expect(explorer.options).toEqual({ nested: { value: 1 } });
    expect(permission['context7_*']).toBe('allow');
    expect((permission.bash as Record<string, unknown>)['git status']).toBe(
      'allow',
    );
    expect(Object.isFrozen(explorer.options)).toBe(true);
  });

  test('uses RoleDefinition.defaultModel for every built-in specialist', () => {
    const registry = registryFor({ disabled_agents: [] });
    for (const roleName of SUPPORTED_SPECIALIST_ROLES) {
      expect(registry.sdkConfigs[roleName]?.model).toBe(
        ROLE_DEFINITIONS[roleName].defaultModel,
      );
    }
  });

  test('normalizes host shorthand and reapplies only the immutable gate', () => {
    const registry = registryFor({ disabled_agents: [] });
    const hostEntry: Record<string, unknown> = { permission: 'ask' };

    projectAgentPermission('explorer', hostEntry, registry);

    expect(hostEntry.permission).toMatchObject({
      '*': 'ask',
      task_cancel: 'deny',
      wait_for_user: 'deny',
      marketplace: 'deny',
    });
    expect((hostEntry.permission as Record<string, unknown>).edit).toBe('deny');
  });

  test('mirrors display aliases across model, skill, and MCP consumers', () => {
    const registry = registryFor({
      disabled_agents: [],
      agents: {
        explorer: {
          displayName: 'Scout',
          model: ['provider/one', 'provider/two'],
          skills: ['simplify'],
          mcps: ['context7'],
        },
      },
    });

    expect(registry.canonicalIdByRuntimeName.Scout).toBe('explorer');
    expect(registry.modelArrays.Scout).toEqual(registry.modelArrays.explorer);
    expect(registry.mcpLists.Scout).toEqual(['context7']);
    expect(registry.skillPermissions.Scout).toEqual(
      registry.skillPermissions.explorer,
    );
    expect(registry.routing).toContainEqual(
      expect.objectContaining({ agentName: 'Scout' }),
    );
    expect(registry.sdkConfigs.Scout).toMatchObject({
      displayName: 'Scout',
      model: 'provider/one',
      mcps: ['context7'],
    });
    expect(registry.sdkConfigs.Scout.hidden).toBeUndefined();
    expect(registry.sdkConfigs.explorer.hidden).toBe(true);
    expect(
      (registry.sdkConfigs.Scout.permission as Record<string, unknown>)
        .marketplace,
    ).toBe('deny');
    expect(
      (registry.sdkConfigs.explorer.permission as Record<string, unknown>)
        .marketplace,
    ).toBe('deny');
  });

  test('does not let host prompts replace mandatory agent suffixes', () => {
    RuntimeConfig.reset(DIRECTORY);
    const runtime = RuntimeConfig.init(DIRECTORY, {
      disabled_agents: [],
      council: CouncilConfigSchema.parse({
        default_preset: 'default',
        presets: {
          default: {
            alpha: { model: 'provider/councillor' },
          },
        },
      }),
    });
    runtime.captureHostConfig({
      agent: {
        explorer: { prompt: 'host explorer prompt' },
        council: { prompt: 'host council prompt' },
      },
    });

    const registry = buildResolvedAgentRegistry(runtime);
    const explorerPrompt = String(registry.sdkConfigs.explorer.prompt);
    const councilPrompt = String(registry.sdkConfigs.council.prompt);

    expect(explorerPrompt).not.toContain('host explorer prompt');
    expect(explorerPrompt).toContain(TASK_REJECTION_INSTRUCTION);
    expect(councilPrompt).not.toContain('host council prompt');
    expect(councilPrompt).toContain(TASK_REJECTION_INSTRUCTION);
    expect(councilPrompt).toContain(COUNCIL_SYNTHESIS_REINFORCEMENT);
  });
});
