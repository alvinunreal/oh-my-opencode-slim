import { describe, expect, test } from 'bun:test';
import { CouncilConfigSchema } from '../config';
import { RuntimeConfig } from '../config/runtime';
import {
  adaptPermissions,
  snapshotNativeAgentForRegistry,
} from '../v2/adapters';
import { createAgents } from './index';
import { buildResolvedAgentRegistry } from './registry';

const DIR = 'runtime-test-final-agent-registry';

function runtimeFor(config: Parameters<typeof RuntimeConfig.init>[1]) {
  RuntimeConfig.reset(DIR);
  return RuntimeConfig.init(DIR, config);
}

function build(
  runtime: RuntimeConfig,
  hostSnapshot: Record<string, unknown>,
  options: Record<string, unknown> = {},
) {
  const definitions = createAgents(runtime);
  return buildResolvedAgentRegistry(runtime, {
    hostSnapshot,
    definitions,
    ...options,
  } as Parameters<typeof buildResolvedAgentRegistry>[1]);
}

describe('finalized existing-agent registry', () => {
  test('owns host inputs and exposes isolated projections', () => {
    const runtime = runtimeFor({
      agents: { explorer: { model: 'plugin/model' } },
    });
    const host = {
      agent: {
        explorer: { model: 'host/model', options: { nested: { value: 1 } } },
      },
    };
    const registry = build(runtime, host);
    host.agent.explorer.options.nested.value = 2;
    const projection = registry.getSdkAgentProjection() as Record<
      string,
      { options?: { nested?: { value?: number } } }
    >;
    if (projection.explorer.options?.nested) {
      projection.explorer.options.nested.value = 3;
    }
    expect(registry.finalAgentConfig.explorer).toMatchObject({
      model: 'host/model',
    });
    const unchanged = registry.getSdkAgentProjection().explorer?.options as {
      nested: { value: number };
    };
    expect(unchanged.nested.value).toBe(1);
    expect(registry.getSdkAgentProjection().explorer?.model).toBe('host/model');
  });

  test('preserves host-selected scalar model and plugin-array candidate chain', () => {
    const runtime = runtimeFor({
      agents: {
        explorer: {
          model: ['provider/first', { id: 'provider/next', variant: 'next-v' }],
        },
      },
    });
    const selected: string[] = [];
    const registry = build(
      runtime,
      {
        agent: { explorer: { model: 'host/selected', variant: 'host-v' } },
      },
      { onHostModelSelected: (name: string) => selected.push(name) },
    );
    expect(registry.modelCandidates.explorer).toEqual([
      { id: 'provider/first' },
      { id: 'provider/next', variant: 'next-v' },
    ]);
    expect(registry.effectiveStartupModels.explorer).toEqual({
      model: 'host/selected',
      variant: 'host-v',
    });
    expect(selected).toEqual(['explorer']);
  });

  test('model-less native snapshot leaves configured scalar model intact', () => {
    const runtime = runtimeFor({
      agents: { explorer: { model: 'provider/scalar' } },
    });
    const native = snapshotNativeAgentForRegistry({ id: 'explorer' });
    const registry = build(runtime, {
      agent: { explorer: native.config },
    });

    expect(registry.finalAgentConfig.explorer).toMatchObject({
      model: 'provider/scalar',
    });
    expect(registry.getSdkAgentProjection().explorer?.model).toBe(
      'provider/scalar',
    );
  });

  test('resolves layered runtime presets after host merge and then applies inheritance', () => {
    const runtime = runtimeFor({
      presets: {
        parent: { agents: { explorer: { model: 'preset/parent' } } },
        child: {
          extends: 'parent',
          agents: { explorer: { model: 'preset/child', variant: 'child-v' } },
        },
      },
      agents: { explorer: { model: 'plugin/model' } },
    });
    runtime.setRuntimePreset('child');
    const registry = build(runtime, {
      agent: { explorer: { model: 'host/model', prompt: 'host prompt' } },
    });
    expect(registry.finalAgentConfig.explorer).toMatchObject({
      model: 'preset/child',
      variant: 'child-v',
      prompt: 'host prompt',
    });
  });

  test('file presets are construction inputs, not post-host overrides', () => {
    const runtime = runtimeFor({
      preset: 'file',
      presets: {
        file: { agents: { explorer: { model: 'file/model' } } },
      },
      agents: { explorer: { model: 'root/model' } },
    });
    const registry = build(runtime, {
      agent: { explorer: { model: 'host/model' } },
    });
    expect(registry.finalAgentConfig.explorer).toMatchObject({
      model: 'host/model',
    });
    expect(build(runtime, {}).finalAgentConfig.explorer).toMatchObject({
      model: 'root/model',
    });
  });

  test('clears stale variants for session inheritance and pins orchestrator inheritance', () => {
    const runtime = runtimeFor({
      agents: {
        explorer: {
          model: ['fallback/model', { id: 'fallback/next' }],
          inheritModelFrom: 'session',
        },
        oracle: { inheritModelFrom: 'orchestrator' },
        orchestrator: { model: 'owner/orchestrator' },
      },
    });
    const registry = build(runtime, {
      agent: {
        explorer: { model: 'host/model', variant: 'stale' },
        oracle: { model: 'host/oracle' },
      },
    });
    expect(registry.finalAgentConfig.explorer).not.toHaveProperty('model');
    expect(registry.finalAgentConfig.explorer).not.toHaveProperty('variant');
    expect(registry.finalAgentConfig.oracle).toMatchObject({
      model: 'owner/orchestrator',
    });
    expect(registry.modelCandidates.explorer).toEqual([
      { id: 'fallback/model' },
      { id: 'fallback/next' },
    ]);
  });

  test('orchestrator inheritance follows the finalized visible model while canonical stays independently callable', () => {
    const runtime = runtimeFor({
      presets: {
        runtime: {
          agents: { orchestrator: { model: 'preset/canonical' } },
        },
      },
      agents: {
        orchestrator: { displayName: 'lead', model: 'plugin/canonical' },
        explorer: { inheritModelFrom: 'orchestrator' },
      },
    });
    runtime.setRuntimePreset('runtime');
    const registry = build(runtime, {
      agent: {
        orchestrator: { model: 'host/canonical' },
        lead: { model: 'host/visible' },
      },
    });

    expect(registry.finalAgentConfig.orchestrator).toMatchObject({
      model: 'preset/canonical',
      hidden: true,
    });
    expect(registry.finalAgentConfig.lead).toMatchObject({
      model: 'host/visible',
    });
    expect(registry.finalAgentConfig.explorer).toMatchObject({
      model: 'host/visible',
    });
    expect(registry.effectiveStartupModels.orchestrator?.model).toBe(
      'preset/canonical',
    );
    expect(registry.effectiveStartupModels.lead?.model).toBe('host/visible');
  });

  test('keeps council host prompt exception and legacy/display aliases in parity', () => {
    const runtime = runtimeFor({
      council: CouncilConfigSchema.parse({
        presets: { default: { alpha: { model: 'provider/council' } } },
      }),
      agents: {
        explorer: {
          model: ['provider/one', 'provider/two'],
          displayName: 'scout',
        },
      },
    });
    const registry = build(runtime, {
      agent: {
        scout: { model: 'host/scout', prompt: 'host scout prompt' },
        council: { prompt: 'host council prompt' },
      },
    });
    expect(registry.identities.explorer).toBe('scout');
    expect(registry.finalAgentConfig.scout).toMatchObject({
      model: 'host/scout',
    });
    expect(registry.modelCandidates.scout).toEqual(
      registry.modelCandidates.explorer,
    );
    expect(registry.finalAgentConfig.council?.prompt).toContain('compaction');
    expect(registry.getSdkAgentProjection().council?.prompt).toContain(
      'compaction',
    );
  });

  test('merges host and plugin MCPs before permissions are compiled', () => {
    const runtime = runtimeFor({
      agents: { explorer: { mcps: ['plugin-mcp'] } },
    });
    const registry = build(
      runtime,
      {
        mcp: { 'host-mcp': { type: 'remote' } },
        agent: { explorer: { permission: { host_tool: 'allow' } } },
      },
      { pluginMcps: { 'plugin-mcp': { type: 'local' } } },
    );
    const config = registry.finalAgentConfig.explorer as {
      permission: Record<string, unknown>;
    };
    expect(Object.keys(registry.mcpConfig).sort()).toEqual([
      'host-mcp',
      'plugin-mcp',
    ]);
    expect(config.permission).toMatchObject({
      'host-mcp_*': 'deny',
      'plugin-mcp_*': 'allow',
      host_tool: 'allow',
    });
  });

  test('projects finalized v1 skill permission rules for native discovery', () => {
    const runtime = runtimeFor({
      agents: { explorer: { skills: ['review-tools'] } },
    });
    const registry = build(runtime, {
      agent: {
        explorer: {
          permission: {
            skill: {
              '*': 'deny',
              'review-tools': 'ask',
              'named-allow': 'allow',
            },
          },
        },
      },
    });
    const projection = registry.getSdkAgentProjection();
    const explorerPermission = projection.explorer?.permission as {
      skill: Record<string, string>;
    };

    expect(explorerPermission.skill).toMatchObject({
      '*': 'deny',
      'review-tools': 'ask',
      'named-allow': 'allow',
    });
    expect(
      registry.nativePolicies.explorer.decide('skill', 'hidden-skill'),
    ).toBe('deny');
    expect(
      registry.nativePolicies.explorer.decide('skill', 'review-tools'),
    ).toBe('ask');
    expect(
      registry.nativePolicies.explorer.decide('skill', 'named-allow'),
    ).toBe('allow');

    const generatedProjection = build(runtime, {}).getSdkAgentProjection();
    const orchestratorPermission = generatedProjection.orchestrator?.permission;
    const generatedExplorerPermission =
      generatedProjection.explorer?.permission;
    expect(orchestratorPermission).toBeDefined();
    expect(generatedExplorerPermission).toBeDefined();
    const orchestratorSkills = (
      orchestratorPermission as {
        skill: Record<string, string>;
      }
    ).skill;
    const explorerSkills = (
      generatedExplorerPermission as {
        skill: Record<string, string>;
      }
    ).skill;
    expect(orchestratorSkills['*']).toBe('allow');
    expect(explorerSkills['*']).toBe('deny');
  });

  test('compiles ordered v2 skill IDs independently of display names', () => {
    const runtime = runtimeFor({});
    const skillID = 'review-tools';
    const skillDisplayName = 'Code Review';
    const hostRules = [
      { action: 'skill', resource: '*', effect: 'deny' as const },
      { action: 'skill', resource: skillID, effect: 'allow' as const },
      { action: 'skill', resource: skillID, effect: 'ask' as const },
    ];
    const registry = build(
      runtime,
      {},
      {
        hostFlavor: 'v2',
        nativePermissionsByAgent: { explorer: hostRules },
      },
    );
    const policy = registry.nativePolicies.explorer;
    const projectedAgents = registry.getSdkAgentProjection();
    const projectedPermission = projectedAgents.explorer?.permission;
    const skillRules = policy.rules.filter((rule) => rule.action === 'skill');

    expect(projectedAgents.explorer).toBeDefined();
    expect(projectedPermission).toBeDefined();
    const projectedRules = adaptPermissions(projectedPermission);
    expect(policy.rules.slice(0, projectedRules.length)).toEqual(
      projectedRules,
    );
    expect(skillRules.slice(-3)).toEqual(hostRules);
    expect(policy.decide('skill', skillID)).toBe('ask');
    expect(policy.decide('skill', skillDisplayName)).toBe('deny');
    expect(registry.nativePolicies.explore).toBe(policy);
    expect(registry.nativePolicies.explore.rules).toBe(policy.rules);
  });

  test('keeps canonical and visible host overrides independent', () => {
    const runtime = runtimeFor({
      agents: {
        explorer: { displayName: 'Scout', model: 'plugin/model' },
      },
    });
    const canonicalRules = [
      { action: 'skill', resource: 'review-tools', effect: 'allow' as const },
      { action: 'skill', resource: 'review-tools', effect: 'ask' as const },
    ];
    const visibleRules = [
      { action: 'skill', resource: '*', effect: 'allow' as const },
      { action: 'skill', resource: 'review-tools', effect: 'deny' as const },
    ];
    const registry = build(
      runtime,
      {
        agent: {
          explorer: {
            model: 'canonical/model',
            variant: 'canonical-v',
            permission: { read: 'allow', canonical_tool: 'allow' },
          },
          Scout: {
            model: 'visible/model',
            variant: 'visible-v',
            permission: { read: 'deny', visible_tool: 'allow' },
          },
        },
      },
      {
        hostFlavor: 'v2',
        nativePermissionsByAgent: {
          explorer: canonicalRules,
          Scout: visibleRules,
        },
      },
    );
    const sdk = registry.getSdkAgentProjection() as Record<
      string,
      Record<string, unknown>
    >;
    const canonicalPermission = sdk.explorer?.permission as Record<
      string,
      unknown
    >;
    const visiblePermission = sdk.Scout?.permission as Record<string, unknown>;

    expect(sdk.explorer).toMatchObject({
      model: 'canonical/model',
      variant: 'canonical-v',
    });
    expect(sdk.Scout).toMatchObject({
      model: 'visible/model',
      variant: 'visible-v',
    });
    expect(canonicalPermission).toMatchObject({
      read: 'allow',
      canonical_tool: 'allow',
    });
    expect(visiblePermission).toMatchObject({
      read: 'deny',
      canonical_tool: 'allow',
      visible_tool: 'allow',
    });
    expect(registry.effectiveStartupModels.explorer).toEqual({
      model: 'canonical/model',
      variant: 'canonical-v',
    });
    expect(registry.effectiveStartupModels.Scout).toEqual({
      model: 'visible/model',
      variant: 'visible-v',
    });
    expect(registry.nativePolicies.explorer.rules.slice(-2)).toEqual(
      canonicalRules,
    );
    expect(registry.nativePolicies.Scout.rules.slice(-2)).toEqual(visibleRules);
    expect(
      registry.nativePolicies.explorer.decide('skill', 'review-tools'),
    ).toBe('ask');
    expect(registry.nativePolicies.Scout.decide('skill', 'review-tools')).toBe(
      'deny',
    );
  });

  test('visible native rules backfill the canonical policy when no canonical rules exist', () => {
    const runtime = runtimeFor({
      agents: { explorer: { displayName: 'Scout' } },
    });
    const visibleRules = [
      { action: 'skill', resource: '*', effect: 'allow' as const },
      { action: 'skill', resource: 'review-tools', effect: 'deny' as const },
    ];
    const registry = build(
      runtime,
      {},
      {
        hostFlavor: 'v2',
        nativePermissionsByAgent: { Scout: visibleRules },
      },
    );

    expect(registry.nativePolicies.explorer.rules.slice(-2)).toEqual(
      visibleRules,
    );
    expect(
      registry.nativePolicies.explorer.decide('skill', 'review-tools'),
    ).toBe('deny');
    expect(registry.nativePolicies.Scout.rules.slice(-2)).toEqual(visibleRules);
  });

  test('canonical native rules remain unchanged when no visible rules exist', () => {
    const runtime = runtimeFor({
      agents: { explorer: { displayName: 'Scout' } },
    });
    const canonicalRules = [
      { action: 'skill', resource: '*', effect: 'deny' as const },
      { action: 'skill', resource: 'review-tools', effect: 'allow' as const },
    ];
    const registry = build(
      runtime,
      {},
      {
        hostFlavor: 'v2',
        nativePermissionsByAgent: { explorer: canonicalRules },
      },
    );

    expect(registry.nativePolicies.explorer.rules.slice(-2)).toEqual(
      canonicalRules,
    );
    expect(
      registry.nativePolicies.explorer.decide('skill', 'review-tools'),
    ).toBe('allow');
    expect(registry.nativePolicies.Scout.rules.slice(-2)).toEqual(
      canonicalRules,
    );
  });

  test('keeps the SDK orchestrator stripped while TUI retains its effective model', () => {
    const runtime = runtimeFor({
      stripOrchestratorModel: true,
      agents: {
        orchestrator: { model: 'provider/orchestrator', displayName: 'lead' },
      },
    });
    const registry = build(runtime, {});
    const projection = registry.getSdkAgentProjection();
    expect(projection.orchestrator).not.toHaveProperty('model');
    expect(projection.lead).not.toHaveProperty('model');
    expect(registry.tuiAgentModels.orchestrator).toBe('provider/orchestrator');
  });

  test('preserves host visibility overrides across canonical and visible projections', () => {
    const runtime = runtimeFor({
      stripOrchestratorModel: true,
      agents: {
        explorer: { displayName: 'Scout' },
        oracle: { displayName: 'OracleVisible' },
        orchestrator: {
          model: 'provider/orchestrator',
          displayName: 'Lead',
        },
      },
    });
    const registry = build(runtime, {
      agent: { explorer: { hidden: false } },
    });
    const sdkAgents = registry.getSdkAgentProjection() as Record<
      string,
      Record<string, unknown>
    >;
    const managedAgents = registry.managedAgentConfig as Record<
      string,
      Record<string, unknown>
    >;

    expect(sdkAgents.explorer).toEqual(managedAgents.explorer);
    expect(sdkAgents.Scout).toEqual(managedAgents.Scout);
    expect(sdkAgents.explorer.hidden).toBe(false);
    expect(sdkAgents.Scout).not.toHaveProperty('hidden');

    expect(sdkAgents.oracle).toEqual(managedAgents.oracle);
    expect(sdkAgents.OracleVisible).toEqual(managedAgents.OracleVisible);
    expect(sdkAgents.oracle.hidden).toBe(true);
    expect(sdkAgents.OracleVisible).not.toHaveProperty('hidden');

    expect(sdkAgents.orchestrator).toEqual(managedAgents.orchestrator);
    expect(sdkAgents.Lead).toEqual(managedAgents.Lead);
    expect(sdkAgents.orchestrator).not.toHaveProperty('model');
    expect(sdkAgents.Lead).not.toHaveProperty('model');
  });

  test('explicit scalar model wins over session inheritance and TUI follows it', () => {
    const runtime = runtimeFor({
      agents: {
        explorer: { model: 'provider/scalar', inheritModelFrom: 'session' },
      },
    });
    const registry = build(runtime, {});
    expect(registry.finalAgentConfig.explorer).toMatchObject({
      model: 'provider/scalar',
    });
    expect(registry.tuiAgentModels.explorer).toBe('provider/scalar');
  });

  test('session inheritance clears canonical and visible host models and variants', () => {
    const runtime = runtimeFor({
      agents: {
        explorer: { displayName: 'Scout', inheritModelFrom: 'session' },
        fixer: {
          displayName: 'FixerVisible',
          model: ['fallback/first', 'fallback/second'],
          inheritModelFrom: 'session',
        },
      },
    });
    const registry = build(runtime, {
      agent: {
        explorer: { model: 'host/canonical', variant: 'canonical-v' },
        Scout: { model: 'host/visible', variant: 'visible-v' },
        fixer: { model: 'host/fixer', variant: 'fixer-v' },
        FixerVisible: {
          model: 'host/fixer-visible',
          variant: 'visible-fixer-v',
        },
      },
    });
    const projection = registry.getSdkAgentProjection() as Record<
      string,
      Record<string, unknown>
    >;

    for (const name of ['explorer', 'Scout', 'fixer', 'FixerVisible']) {
      expect(registry.finalAgentConfig[name]).not.toHaveProperty('model');
      expect(registry.finalAgentConfig[name]).not.toHaveProperty('variant');
      expect(projection[name]).not.toHaveProperty('model');
      expect(projection[name]).not.toHaveProperty('variant');
    }
  });

  test('stripped orchestrator keeps tracked TUI model and variant for visible alias', () => {
    const runtime = runtimeFor({
      stripOrchestratorModel: true,
      agents: {
        orchestrator: {
          model: 'provider/orchestrator',
          variant: 'high',
          displayName: 'Lead',
        },
      },
    });
    const registry = build(runtime, {});
    const projection = registry.getSdkAgentProjection() as Record<
      string,
      Record<string, unknown>
    >;

    expect(projection.orchestrator).not.toHaveProperty('model');
    expect(projection.Lead).not.toHaveProperty('model');
    expect(registry.tuiAgentModels.Lead).toBe('provider/orchestrator');
    expect(registry.tuiAgentVariants.Lead).toBe('high');
  });

  test('stripped orchestrator keeps a visible alias effective model for the TUI', () => {
    const runtime = runtimeFor({
      stripOrchestratorModel: true,
      agents: {
        orchestrator: { model: 'provider/orchestrator', displayName: 'Lead' },
      },
    });
    const registry = build(runtime, {
      agent: { Lead: { model: 'provider/visible', variant: 'visible-v' } },
    });
    const projection = registry.getSdkAgentProjection() as Record<
      string,
      Record<string, unknown>
    >;

    expect(projection.orchestrator).not.toHaveProperty('model');
    expect(projection.Lead?.model).toBe('provider/visible');
    expect(registry.tuiAgentModels.Lead).toBe('provider/visible');
    expect(registry.tuiAgentVariants.Lead).toBe('visible-v');
  });

  test('does not publish a partial registry after construction failure', () => {
    const runtime = runtimeFor({
      agents: { 'bad name': { model: 'provider/model' } },
    });
    expect(() => build(runtime, {})).toThrow(
      "Unsafe custom agent name 'bad name'",
    );
  });
});
