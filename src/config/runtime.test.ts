import { describe, expect, test } from 'bun:test';
import { RuntimeConfig } from './runtime';
import type { PluginConfig } from './schema';

const DIRECTORY = '/tmp/runtime-config-test';

function resetRegistry(): void {
  RuntimeConfig.reset(DIRECTORY);
}

describe('RuntimeConfig', () => {
  test('init seeds a frozen plugin snapshot and get returns it', () => {
    resetRegistry();
    const plugin: PluginConfig = {
      preset: 'fast',
      agents: { explorer: { model: 'plugin-model' } },
    };
    const runtime = RuntimeConfig.init(DIRECTORY, plugin);
    expect(RuntimeConfig.get(DIRECTORY)).toBe(runtime);
    expect(runtime.plugin).toEqual(plugin);
    expect(Object.isFrozen(runtime.plugin)).toBe(true);
    expect(runtime.isCacheSafe).toBe(true);
  });

  test('plugin snapshot is isolated from later mutations of the seed', () => {
    resetRegistry();
    const seed: PluginConfig = {
      agents: { explorer: { model: 'original' } },
    };
    const runtime = RuntimeConfig.init(DIRECTORY, seed);
    // Mutating the original seed object must not leak into the snapshot.
    seed.agents = { explorer: { model: 'mutated' } };
    expect(runtime.plugin?.agents?.explorer?.model).toBe('original');
    expect(runtime.agent('explorer')?.model).toBe('original');
  });

  test('seed precedence: host override > runtime override > plugin file', () => {
    resetRegistry();
    const plugin: PluginConfig = {
      preset: 'file',
      presets: {
        file: { explorer: { model: 'preset-model' } },
        runtime: { explorer: { model: 'runtime-model' } },
      },
      agents: { explorer: { model: 'plugin-file-model' } },
    };
    const runtime = RuntimeConfig.init(DIRECTORY, plugin);
    runtime.setRuntimePreset('runtime');
    runtime.captureHostConfig({
      agent: { explorer: { model: 'host-model' } },
    });

    // host wins over runtime override
    expect(runtime.agent('explorer')?.model).toBe('host-model');

    // without host, runtime override wins over plugin file
    runtime.captureHostConfig({});
    expect(runtime.agent('explorer')?.model).toBe('runtime-model');

    // without runtime override, plugin file wins over preset agents
    runtime.setRuntimePreset(null);
    expect(runtime.agent('explorer')?.model).toBe('plugin-file-model');
  });

  test('host snapshot is captured before mutation', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {});
    const hostConfig: Record<string, unknown> = {
      default_agent: 'build',
      agent: { explorer: { model: 'before' } },
      small_model: 'small/before',
    };
    runtime.captureHostConfig(hostConfig);

    // Simulate the config hook mutating the SAME object afterwards.
    (hostConfig as Record<string, unknown>).default_agent = 'orchestrator';
    (hostConfig.agent as Record<string, unknown>).explorer = {
      model: 'after',
    };

    expect(runtime.host()?.default_agent).toBe('build');
    expect(runtime.hostAgent('explorer')?.model).toBe('before');
    expect(runtime.smallModel()).toBe('small/before');
  });

  test('registry reset clears the instance state', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: { explorer: { model: 'm1' } },
    });
    runtime.everModelSwitched('explorer');
    runtime.setRuntimePreset('whatever');
    expect(runtime.hasModelSwitched('explorer')).toBe(true);

    RuntimeConfig.reset(DIRECTORY);
    const fresh = RuntimeConfig.get(DIRECTORY);
    expect(fresh).not.toBe(runtime);
    expect(fresh.plugin).toBeUndefined();
    expect(fresh.hasModelSwitched('explorer')).toBe(false);
    expect(fresh.getRuntimePreset()).toBeNull();
    // Seeding again replaces the snapshot.
    RuntimeConfig.init(DIRECTORY, {
      agents: { explorer: { model: 'm2' } },
    });
    expect(RuntimeConfig.get(DIRECTORY).agent('explorer')?.model).toBe('m2');
  });

  test('getter defaults with an empty plugin config', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {});
    expect(runtime.preset).toBeUndefined();
    expect(runtime.agents()).toEqual({});
    expect(runtime.agent('explorer')).toBeUndefined();
    expect(runtime.disabledAgents).toEqual(new Set(['observer']));
    expect(runtime.disabledTools).toEqual([]);
    expect(runtime.disabledMcps).toEqual([]);
    expect(runtime.disabledSkills).toEqual([]);
    expect(runtime.customAgentNames).toEqual([]);
    expect(runtime.modelArrays).toEqual({});
    expect(runtime.imageRouting).toBe('direct'); // observer disabled
    expect(runtime.multiplexer).toEqual({
      type: 'none',
      layout: 'main-vertical',
      main_pane_size: 60,
      zellij_pane_mode: 'agent-tab',
    });
    expect(runtime.backgroundJobs.maxSessionsPerAgent).toBe(2);
    expect(runtime.backgroundJobs.strategy).toBe('latest');
    expect(runtime.fallback).toEqual({ enabled: true, maxRetries: 3 });
    expect(runtime.webfetch.enabled).toBe(true);
    expect(runtime.acpAgents).toEqual({});
    expect(runtime.companion).toBeUndefined();
    expect(runtime.council).toBeUndefined();
    expect(runtime.autoUpdate).toBe(true);
    expect(runtime.stripOrchestratorModel).toBe(false);
    expect(runtime.setDefaultAgent).toBe(true);
    expect(runtime.compactSidebar).toBe(true);
    expect(runtime.runtimeChains).toEqual({});
    expect(runtime.primaryModel).toBeUndefined();
    expect(runtime.host()).toBeUndefined();
    expect(runtime.hostAgent('explorer')).toBeUndefined();
    expect(runtime.smallModel()).toBeUndefined();
    expect(runtime.hostMcp()).toBeUndefined();
    expect(runtime.getRuntimePreset()).toBeNull();
    expect(runtime.hasModelSwitched('explorer')).toBe(false);
  });

  test('explicit config values override defaults', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      autoUpdate: false,
      stripOrchestratorModel: true,
      setDefaultAgent: false,
      compactSidebar: false,
      image_routing: 'auto',
      disabled_agents: ['observer', 'orchestrator'],
      disabled_tools: ['webfetch'],
      disabled_mcps: ['context7'],
      disabled_skills: ['clonedeps'],
      fallback: { enabled: false, maxRetries: 5 },
      webfetch: { enabled: false },
      acpAgents: { myAcp: { command: 'echo' } },
      backgroundJobs: { maxSessionsPerAgent: 7 },
      multiplexer: { type: 'tmux', layout: 'main-vertical' },
    });
    expect(runtime.autoUpdate).toBe(false);
    expect(runtime.stripOrchestratorModel).toBe(true);
    expect(runtime.setDefaultAgent).toBe(false);
    expect(runtime.compactSidebar).toBe(false);
    expect(runtime.imageRouting).toBe('auto');
    // orchestrator is protected and cannot be disabled
    expect(runtime.disabledAgents).toEqual(new Set(['observer']));
    expect(runtime.disabledTools).toEqual(['webfetch']);
    expect(runtime.disabledMcps).toEqual(['context7']);
    expect(runtime.disabledSkills).toEqual(['clonedeps']);
    expect(runtime.fallback.enabled).toBe(false);
    expect(runtime.fallback.maxRetries).toBe(5);
    expect(runtime.webfetch.enabled).toBe(false);
    expect(runtime.acpAgents.myAcp.command).toBe('echo');
    expect(runtime.backgroundJobs.maxSessionsPerAgent).toBe(7);
    expect(runtime.multiplexer.type).toBe('tmux');
  });

  test('runtimeChains derives from array models, alias-aware', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: {
        explorer: { model: ['provider/a', 'provider/b'] },
        // legacy alias key resolves to explorer; later real entry wins
        oracle: { model: 'string-model' }, // no chain for string
        fixer: {
          model: [
            { id: 'provider/x', variant: 'variant' },
            { id: 'provider/y' },
          ],
        },
      },
    });
    expect(runtime.runtimeChains).toEqual({
      explorer: ['provider/a', 'provider/b'],
      fixer: ['provider/x', 'provider/y'],
    });
  });

  test('primaryModel resolves from active preset (orchestrator, then subagent)', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      preset: 'fast',
      presets: {
        fast: {
          explorer: { model: 'provider/explorer' },
          oracle: { model: 'provider/oracle' },
        },
      },
    });
    expect(runtime.primaryModel).toBe('provider/explorer');

    RuntimeConfig.reset(DIRECTORY);
    const withOrch = RuntimeConfig.init(DIRECTORY, {
      preset: 'orch',
      presets: {
        orch: { orchestrator: { model: 'provider/orch' } },
      },
    });
    expect(withOrch.primaryModel).toBe('provider/orch');
  });

  test('setRuntimePreset re-applies preset agents into agents() and preset()', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      preset: 'file',
      presets: {
        file: { explorer: { model: 'file-preset-model' } },
        runtime: { explorer: { model: 'runtime-preset-model' } },
      },
      agents: { explorer: { temperature: 0.2 } },
    });
    expect(runtime.preset).toBe('file');
    expect(runtime.agent('explorer')?.model).toBe('file-preset-model');

    runtime.setRuntimePreset('runtime');
    expect(runtime.getRuntimePreset()).toBe('runtime');
    expect(runtime.preset).toBe('runtime');
    expect(runtime.agent('explorer')?.model).toBe('runtime-preset-model');
    // temperature from root agents survives the merge
    expect(runtime.agent('explorer')?.temperature).toBe(0.2);

    // stale preset name clears the selection
    runtime.setRuntimePreset('nonexistent');
    expect(runtime.getRuntimePreset()).toBeNull();
    expect(runtime.preset).toBe('file');

    runtime.setRuntimePreset(null);
    expect(runtime.getRuntimePreset()).toBeNull();
  });

  test('everModelSwitched / hasModelSwitched round-trips', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {});
    expect(runtime.hasModelSwitched('explorer')).toBe(false);
    runtime.everModelSwitched('explorer');
    expect(runtime.hasModelSwitched('explorer')).toBe(true);
    expect(runtime.hasModelSwitched('oracle')).toBe(false);
  });

  test('host surface returns captured values', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {});
    runtime.captureHostConfig({
      default_agent: 'build',
      agent: { explorer: { model: 'host/x', temperature: 0.5 } },
      mcp: { context7: { type: 'remote' } },
      small_model: 'host/small',
      provider: { provider1: { models: ['a/b'] } },
    });
    expect(runtime.host()?.default_agent).toBe('build');
    expect(runtime.hostAgent('explorer')).toEqual({
      model: 'host/x',
      temperature: 0.5,
    });
    expect(runtime.hostMcp()).toEqual({ context7: { type: 'remote' } });
    expect(runtime.smallModel()).toBe('host/small');
  });

  test('agent() is alias-aware for legacy names', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: { explore: { model: 'alias-model' } },
    });
    expect(runtime.agent('explorer')?.model).toBe('alias-model');
  });

  test('customAgentNames lists unknown agents keys only', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: {
        explorer: { model: 'builtin' },
        myCustom: { model: 'custom/model' },
      },
    });
    expect(runtime.customAgentNames).toEqual(['myCustom']);
  });

  test('modelArrays preserves variants, alias-aware, excludes disabled', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      disabled_agents: ['fixer'],
      agents: {
        // legacy alias key resolves to explorer
        explore: {
          model: [{ id: 'provider/a', variant: 'high' }, 'provider/b'],
        },
        fixer: { model: ['provider/f1', 'provider/f2'] },
        custom: { model: ['provider/c1', { id: 'provider/c2', variant: 'v' }] },
      },
    });
    expect(runtime.modelArrays).toEqual({
      explorer: [{ id: 'provider/a', variant: 'high' }, { id: 'provider/b' }],
      custom: [{ id: 'provider/c1' }, { id: 'provider/c2', variant: 'v' }],
    });
    // disabled agent chain is excluded
    expect(runtime.modelArrays.fixer).toBeUndefined();
  });

  test('modelArrays includes multi-model councillor chains from council config', () => {
    resetRegistry();
    // Parsed council shape: the schema transform adds `models` (normalized
    // chain with the shared variant applied) plus `model` (primary).
    const runtime = RuntimeConfig.init(DIRECTORY, {
      council: {
        default_preset: 'default',
        presets: {
          default: {
            alpha: {
              model: 'provider/a1',
              variant: 'fast',
              prompt: undefined,
              models: [
                { id: 'provider/a1', variant: 'fast' },
                { id: 'provider/a2', variant: 'fast' },
              ],
            },
            beta: {
              model: 'provider/b1',
              variant: undefined,
              prompt: undefined,
              models: [{ id: 'provider/b1', variant: undefined }],
            },
          },
        },
      },
    });
    expect(runtime.modelArrays['councillor-alpha']).toEqual([
      { id: 'provider/a1', variant: 'fast' },
      { id: 'provider/a2', variant: 'fast' },
    ]);
    // single-model councillor has no chain
    expect(runtime.modelArrays['councillor-beta']).toBeUndefined();
    // chains derive from modelArrays (councillor chains included)
    expect(runtime.runtimeChains['councillor-alpha']).toEqual([
      'provider/a1',
      'provider/a2',
    ]);
  });

  test('modelArrays excludes disabled councillor seats', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      disabled_agents: ['councillor-alpha'],
      council: {
        default_preset: 'default',
        presets: {
          default: {
            alpha: {
              model: 'provider/a1',
              variant: undefined,
              prompt: undefined,
              models: [
                { id: 'provider/a1', variant: undefined },
                { id: 'provider/a2', variant: undefined },
              ],
            },
          },
        },
      },
    });
    expect(runtime.modelArrays['councillor-alpha']).toBeUndefined();
  });
});
