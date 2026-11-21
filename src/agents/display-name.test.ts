import { describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../config';
import { CouncilConfigSchema } from '../config/council-schema';
import { RuntimeConfig } from '../config/runtime';
import { createAgents, getAgentConfigs } from './index';

const TEST_DIRECTORY = 'runtime-test-agents-display-name';
function runtimeFor(config: PluginConfig | undefined = {}) {
  RuntimeConfig.reset(TEST_DIRECTORY);
  RuntimeConfig.init(TEST_DIRECTORY, config ?? {});
  return RuntimeConfig.get(TEST_DIRECTORY);
}

describe('displayName', () => {
  test('stores displayName on agent when configured', () => {
    const config: PluginConfig = {
      agents: {
        explorer: { displayName: 'researcher' },
      },
    };

    const agents = createAgents(runtimeFor(config));
    const explorer = agents.find((a) => a.name === 'explorer');
    expect(explorer?.displayName).toBe('researcher');

    const sdkConfigs = getAgentConfigs(runtimeFor(config));
    expect((sdkConfigs.explorer as { displayName?: string }).displayName).toBe(
      'researcher',
    );
  });

  test.each(['researcher', '@researcher', '  researcher  '])(
    'normalizes %p in native agent IDs and user-authored prompt mentions',
    (displayName) => {
      const configs = getAgentConfigs(
        runtimeFor({
          agents: {
            explorer: { displayName },
            orchestrator: { prompt: 'Brief @explorer.' },
          },
        }),
        { hostFlavor: 'v2' },
      );
      expect(configs.researcher.mode).toBe('subagent');
      expect(configs.explorer.hidden).toBe(true);
      expect(configs.orchestrator.prompt).toBe('Brief @researcher.');
    },
  );

  test('throws when duplicate displayName is assigned', () => {
    const config: PluginConfig = {
      agents: {
        explorer: { displayName: 'helper' },
        designer: { displayName: 'helper' },
      },
    };

    expect(() => createAgents(runtimeFor(config))).toThrow(
      "Duplicate displayName 'helper' assigned to multiple agents",
    );
  });

  test('throws when normalized duplicate displayName is assigned', () => {
    const config: PluginConfig = {
      agents: {
        explorer: { displayName: 'advisor' },
        designer: { displayName: ' @advisor ' },
      },
    };

    expect(() => createAgents(runtimeFor(config))).toThrow(
      "Duplicate displayName 'advisor' assigned to multiple agents",
    );
  });

  test('throws when displayName conflicts with internal agent name', () => {
    const config: PluginConfig = {
      agents: {
        explorer: { displayName: 'oracle' },
      },
    };

    expect(() => createAgents(runtimeFor(config))).toThrow(
      "displayName 'oracle' conflicts with an agent name",
    );
  });

  test('throws when normalized displayName conflicts with internal agent name', () => {
    const config: PluginConfig = {
      agents: {
        explorer: { displayName: ' @oracle ' },
      },
    };

    expect(() => createAgents(runtimeFor(config))).toThrow(
      "displayName 'oracle' conflicts with an agent name",
    );
  });

  test('throws when orchestrator displayName conflicts with internal agent name', () => {
    const config: PluginConfig = {
      agents: {
        orchestrator: { displayName: 'oracle' },
      },
    };

    expect(() => createAgents(runtimeFor(config))).toThrow(
      /displayName.*conflicts with an agent name/,
    );
  });

  test('throws when displayName is not a safe agent alias', () => {
    const config: PluginConfig = {
      agents: {
        explorer: { displayName: 'senior reviewer' },
      },
    };

    expect(() => createAgents(runtimeFor(config))).toThrow(
      "displayName 'senior reviewer' must match /^[a-z][a-z0-9_-]*$/i",
    );
  });

  test('resolves legacy alias for explorer displayName override', () => {
    const config: PluginConfig = {
      agents: {
        explore: { displayName: 'researcher' },
      },
    };

    const agents = createAgents(runtimeFor(config));
    const explorer = agents.find((a) => a.name === 'explorer');

    expect(explorer?.displayName).toBe('researcher');
  });

  test('uses displayName as host-facing registry key with hidden internal alias', () => {
    const config: PluginConfig = {
      agents: {
        oracle: { displayName: 'advisor' },
      },
    };

    const sdkConfigs = getAgentConfigs(runtimeFor(config)) as Record<
      string,
      { hidden?: boolean; mode?: string }
    >;

    expect(sdkConfigs.advisor).toBeDefined();
    expect(sdkConfigs.advisor.mode).toBe('subagent');
    expect(sdkConfigs.advisor.hidden).toBeUndefined();

    expect(sdkConfigs.oracle).toBeDefined();
    expect(sdkConfigs.oracle.mode).toBe('subagent');
    expect(sdkConfigs.oracle.hidden).toBe(true);
  });

  test('uses orchestrator displayName as host-facing key with hidden internal alias', () => {
    const config: PluginConfig = {
      agents: {
        orchestrator: { displayName: 'engineer' },
      },
    };

    const sdkConfigs = getAgentConfigs(runtimeFor(config)) as Record<
      string,
      { hidden?: boolean; mode?: string }
    >;

    expect(sdkConfigs.engineer).toBeDefined();
    expect(sdkConfigs.engineer.mode).toBe('primary');
    expect(sdkConfigs.engineer.hidden).toBeUndefined();

    expect(sdkConfigs.orchestrator).toBeDefined();
    expect(sdkConfigs.orchestrator.mode).toBe('primary');
    expect(sdkConfigs.orchestrator.hidden).toBe(true);
  });

  test('keeps internal-only council agents hidden even with displayName configured', () => {
    const config: PluginConfig = {
      disabled_agents: [],
      council: CouncilConfigSchema.parse({
        presets: { default: { alpha: { model: 'test/councillor' } } },
      }),
      agents: {
        councillor: { displayName: 'reviewer' },
      },
    };

    const sdkConfigs = getAgentConfigs(runtimeFor(config));

    expect(sdkConfigs.reviewer).toBeUndefined();
    expect(sdkConfigs.councillor?.hidden).toBe(true);
  });

  test('keeps dynamic councillor-<seat> agents hidden from @ autocomplete', () => {
    const config: PluginConfig = {
      disabled_agents: [],
      council: CouncilConfigSchema.parse({
        presets: { default: { alpha: { model: 'test/councillor' } } },
      }),
    };

    const sdkConfigs = getAgentConfigs(runtimeFor(config));

    expect(sdkConfigs['councillor-alpha']?.hidden).toBe(true);
    expect(sdkConfigs['councillor-alpha']?.mode).toBe('subagent');
  });
});
