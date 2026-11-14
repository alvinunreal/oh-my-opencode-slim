import { describe, expect, spyOn, test } from 'bun:test';
import { DEFAULT_CHILD_INPUT_WAKE_KINDS } from './constants';
import * as effectiveOverrides from './effective-agent-overrides';
import { RuntimeConfig } from './runtime';
import type { PluginConfig } from './schema';

const DIRECTORY = '/tmp/runtime-config-test';

function resetRegistry(): void {
  RuntimeConfig.reset(DIRECTORY);
}

describe('RuntimeConfig', () => {
  test('reuses agent resolution until a preset switch or reseed', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: {
        explorer: {
          model: ['provider/first', 'provider/next'],
          inheritModelFrom: 'session',
        },
        oracle: { skills_add: ['project-skill'] },
      },
      presets: {
        fast: { explorer: { model: ['provider/fast', 'provider/backup'] } },
      },
    });
    const resolve = spyOn(effectiveOverrides, 'resolveEffectiveAgentOverrides');
    try {
      expect(runtime.agent('explorer')?.model).toEqual([
        'provider/first',
        'provider/next',
      ]);
      expect(runtime.combinedModelInheritanceSource('explorer')).toBe(
        'session',
      );
      expect(runtime.modelArrays.explorer[0].id).toBe('provider/first');
      expect(resolve).toHaveBeenCalledTimes(1);

      const snapshot = runtime.agents();
      snapshot.explorer.model = 'provider/changed-by-caller';
      expect(runtime.agent('explorer')?.model).toEqual([
        'provider/first',
        'provider/next',
      ]);
      expect(
        runtime.agents({ oracle: ['marketplace-skill'] }).oracle.skills,
      ).toContain('marketplace-skill');
      expect(runtime.agents().oracle.skills).not.toContain('marketplace-skill');
      runtime.setRuntimePreset('fast');
      expect(runtime.agent('explorer')?.model).toEqual([
        'provider/fast',
        'provider/backup',
      ]);
      RuntimeConfig.init(DIRECTORY, {
        agents: { explorer: { model: 'provider/reseeded' } },
      });
      expect(runtime.agent('explorer')?.model).toBe('provider/reseeded');
    } finally {
      resolve.mockRestore();
    }
  });
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

  test('inheritance prevents host models from leaking into agent views', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: {
        explorer: { inheritModelFrom: 'session' },
        oracle: { inheritModelFrom: 'orchestrator' },
      },
    });
    runtime.captureHostConfig({
      agent: {
        explorer: { model: 'host/explorer', temperature: 0.3 },
        oracle: {
          model: 'host/oracle',
          options: { reasoningEffort: 'high' },
        },
      },
    });

    expect(runtime.agent('explorer')).toEqual({
      inheritModelFrom: 'session',
      temperature: 0.3,
    });
    expect(runtime.agent('oracle')).toEqual({
      inheritModelFrom: 'orchestrator',
      options: { reasoningEffort: 'high' },
    });
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

  test('host agent entries under pre-rename names feed the merged agent', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {});
    runtime.captureHostConfig({
      agent: { librarian: { model: 'host/legacy-librarian' } },
    });
    expect(runtime.agent('explorer')?.model).toBe('host/legacy-librarian');
    // Host-native namespaces never map onto plugin agents.
    runtime.captureHostConfig({
      agent: {
        librarian: { model: 'host/legacy-librarian' },
        explore: { model: 'host/native' },
      },
    });
    expect(runtime.agent('explorer')?.model).toBe('host/legacy-librarian');
  });

  test('canonical host agent entries win over pre-rename ones', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {});
    runtime.captureHostConfig({
      agent: {
        explorer: { model: 'host/canonical' },
        librarian: { model: 'host/legacy' },
      },
    });
    expect(runtime.agent('explorer')?.model).toBe('host/canonical');
  });

  test('disabled_agents canonicalizes legacy alias names', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      disabled_agents: ['librarian'],
    });
    expect(runtime.disabledAgents).toEqual(new Set(['explorer']));
  });

  test('disabled agent derivation is reused and invalidated on reseed', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      disabled_agents: ['librarian', 'orchestrator'],
    });
    const disabled = runtime.disabledAgents;
    expect(disabled).toEqual(new Set(['explorer']));
    expect(runtime.disabledAgents).toBe(disabled);
    RuntimeConfig.init(DIRECTORY, { disabled_agents: ['observer'] });
    expect(runtime.disabledAgents).toEqual(new Set(['observer']));
    expect(runtime.disabledAgents).not.toBe(disabled);
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

  test('core feature and display getter defaults with an empty config', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {});
    expect(runtime.preset).toBeUndefined();
    expect(runtime.updateCheckerEnabled).toBe(true);
    expect(runtime.stripOrchestratorModel).toBe(false);
    expect(runtime.routingBlock).toBe(true);
    expect(runtime.setDefaultAgent).toBe(true);
    expect(runtime.compactSidebar).toBe(true);
    expect(runtime.sidebarEnabled).toBe(true);
    expect(runtime.backgroundJobsEnabled).toBe(true);
    expect(runtime.backgroundJobsMode).toBe('managed');
    expect(runtime.interviewEnabled).toBe(true);
    expect(runtime.liveConfigRefresh).toBe(true);
    expect(runtime.imageRouting).toBe('direct');
    expect(runtime.companion).toBeUndefined();
    expect(runtime.council).toBeUndefined();
    expect(runtime.featureGates).toEqual({
      backgroundJobsMode: 'managed',
      managedJobs: true,
      presetRouting: true,
      tui: true,
      sidebar: true,
      interview: true,
      marketplace: true,
      webfetch: true,
      liveConfigRefresh: true,
      updateChecker: true,
    });
  });

  test('featureGates is frozen, cached per generation, and defaults while unseeded', () => {
    resetRegistry();
    const unseeded = RuntimeConfig.get(DIRECTORY).featureGates;
    expect(unseeded.backgroundJobsMode).toBe('managed');
    expect(RuntimeConfig.get(DIRECTORY).featureGates).toBe(unseeded);

    const runtime = RuntimeConfig.init(DIRECTORY, {});
    const gates = runtime.featureGates;
    expect(Object.isFrozen(gates)).toBe(true);
    expect(runtime.featureGates).toBe(gates);
    expect(runtime.sidebarEnabled).toBe(gates.sidebar);

    RuntimeConfig.init(DIRECTORY, { tui: false });
    expect(runtime.featureGates).not.toBe(gates);
    expect(runtime.featureGates.tui).toBe(false);
    // The TUI master switch also turns off server-side sidebar recording.
    expect(runtime.sidebarEnabled).toBe(false);
  });

  test('feature gates default on and read explicit off values', () => {
    resetRegistry();
    const off = RuntimeConfig.init(DIRECTORY, {
      backgroundJobs: { mode: 'off' },
      interview: { enabled: false },
      sidebar: false,
    });
    expect(off.backgroundJobsEnabled).toBe(false);
    expect(off.backgroundJobsMode).toBe('off');
    expect(off.interviewEnabled).toBe(false);
    expect(off.sidebarEnabled).toBe(false);
    // Sibling backgroundJobs keys stay readable (parsed; inert at runtime).
    expect(off.backgroundJobs.mode).toBe('off');

    RuntimeConfig.reset(DIRECTORY);
    const partial = RuntimeConfig.init(DIRECTORY, {
      backgroundJobs: { mode: 'off', maxSessionsPerAgent: 4 },
      interview: { maxQuestions: 5 },
    });
    expect(partial.backgroundJobsEnabled).toBe(false);
    expect(partial.backgroundJobs.maxSessionsPerAgent).toBe(4);
    expect(partial.interviewEnabled).toBe(true);
    expect(partial.sidebarEnabled).toBe(true);
    expect(partial.liveConfigRefresh).toBe(true);

    RuntimeConfig.reset(DIRECTORY);
    const refreshOff = RuntimeConfig.init(DIRECTORY, {
      liveConfigRefresh: false,
    });
    expect(refreshOff.liveConfigRefresh).toBe(false);
    // The switch is the config-file watcher only: /preset writes keep their
    // own refresh path (host-side), so the derived boolean stays a pure
    // projection of the config layer and carries no preset state.
    expect(RuntimeConfig.get(DIRECTORY).liveConfigRefresh).toBe(false);
  });

  test('backgroundJobs.mode resolves the lifecycle', () => {
    resetRegistry();
    const native = RuntimeConfig.init(DIRECTORY, {
      backgroundJobs: { mode: 'native' },
    });
    expect(native.backgroundJobsMode).toBe('native');
    // Only the managed mode constructs the board-shaped lifecycle.
    expect(native.backgroundJobsEnabled).toBe(false);

    RuntimeConfig.reset(DIRECTORY);
    const off = RuntimeConfig.init(DIRECTORY, {
      backgroundJobs: { mode: 'off' },
    });
    expect(off.backgroundJobsMode).toBe('off');
    expect(off.backgroundJobsEnabled).toBe(false);

    RuntimeConfig.reset(DIRECTORY);
    const managed = RuntimeConfig.init(DIRECTORY, {
      backgroundJobs: { mode: 'managed' },
    });
    expect(managed.backgroundJobsMode).toBe('managed');
    expect(managed.backgroundJobsEnabled).toBe(true);
  });

  test('host flavor controls cached feature gates for reseeded and detached runtimes', () => {
    resetRegistry();
    const v1 = RuntimeConfig.init(DIRECTORY, {}, 'v1');
    v1.captureHostConfig({ default_agent: 'v1-agent' });
    v1.everModelSwitched('explorer');
    const v1Gates = v1.featureGates;
    expect(v1Gates.backgroundJobsMode).toBe('managed');
    expect(v1Gates.managedJobs).toBe(true);

    // Switching host flavor from v1 to v2 creates a clean instance to prevent
    // stale v1 singleton state (switched models, host snapshot) from polluting v2.
    const v2 = RuntimeConfig.init(DIRECTORY, {}, 'v2');
    expect(v2).not.toBe(v1);
    expect(v2.host()).toBeUndefined();
    expect(v2.hasModelSwitched('explorer')).toBe(false);
    expect(v2.featureGates).not.toBe(v1Gates);
    expect(v2.featureGates).toMatchObject({
      backgroundJobsMode: 'native',
      managedJobs: false,
      presetRouting: true,
    });
    expect(v2.backgroundJobs.mode).toBe('native');
    expect(v2.backgroundJobs.maxSessionsPerAgent).toBe(2);
    expect(v1Gates.backgroundJobsMode).toBe('managed');
    expect(RuntimeConfig.get(DIRECTORY)).toBe(v2);
    expect(RuntimeConfig.get(DIRECTORY).featureGates).toBe(v2.featureGates);

    const detached = RuntimeConfig.createDetached(
      DIRECTORY,
      { backgroundJobs: { mode: 'off' } },
      'v2',
    );
    expect(detached.featureGates).toMatchObject({
      backgroundJobsMode: 'off',
      managedJobs: false,
      presetRouting: false,
    });
    expect(v2.featureGates.backgroundJobsMode).toBe('native');
  });

  test('rejects v2 managed runtime seeds before replacing the prior snapshot', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, { tui: false }, 'v2');
    const gates = runtime.featureGates;
    expect(() =>
      RuntimeConfig.init(
        DIRECTORY,
        { backgroundJobs: { mode: 'managed' } },
        'v2',
      ),
    ).toThrow(/Unsupported backgroundJobs\.mode "managed"/);
    expect(runtime.featureGates).toBe(gates);
    expect(runtime.plugin).toEqual({ tui: false });
    expect(() =>
      RuntimeConfig.createDetached(
        DIRECTORY,
        { backgroundJobs: { mode: 'managed' } },
        'v2',
      ),
    ).toThrow(/Unsupported backgroundJobs\.mode "managed"/);
  });

  test('updateCheckerEnabled is off for autoUpdate false or the disabled hook', () => {
    resetRegistry();
    const autoUpdateOff = RuntimeConfig.init(DIRECTORY, { autoUpdate: false });
    expect(autoUpdateOff.updateCheckerEnabled).toBe(false);

    RuntimeConfig.reset(DIRECTORY);
    const hookOff = RuntimeConfig.init(DIRECTORY, {
      disabled_hooks: ['auto-update-checker'],
    });
    expect(hookOff.updateCheckerEnabled).toBe(false);

    RuntimeConfig.reset(DIRECTORY);
    const unrelatedHook = RuntimeConfig.init(DIRECTORY, {
      disabled_hooks: ['cache-monitor'],
    });
    expect(unrelatedHook.updateCheckerEnabled).toBe(true);
  });

  test('webfetch is gated by its config switch and disabled_tools entry', () => {
    resetRegistry();
    const toolDisabled = RuntimeConfig.init(DIRECTORY, {
      disabled_tools: ['webfetch'],
    });
    expect(toolDisabled.featureGates.webfetch).toBe(false);

    RuntimeConfig.reset(DIRECTORY);
    const switchOff = RuntimeConfig.init(DIRECTORY, {
      webfetch: { enabled: false },
    });
    expect(switchOff.featureGates.webfetch).toBe(false);

    RuntimeConfig.reset(DIRECTORY);
    const unrelated = RuntimeConfig.init(DIRECTORY, {
      disabled_tools: ['task_cancel'],
    });
    expect(unrelated.featureGates.webfetch).toBe(true);
  });

  test('marketplaceEnabled defaults on and reads an explicit root kill switch', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {});
    expect(runtime.marketplaceEnabled).toBe(true);

    const off = RuntimeConfig.init(DIRECTORY, {
      marketplace: { enabled: false },
    });
    expect(off.marketplaceEnabled).toBe(false);

    // The kill switch is distinct from per-preset activation: an empty
    // activation list (no agents selected) is not the kill switch.
    RuntimeConfig.reset(DIRECTORY);
    const emptyActivation = RuntimeConfig.init(DIRECTORY, {
      preset: 'fast',
      presets: { fast: { marketplace: { agents: [] } } },
    });
    expect(emptyActivation.marketplaceEnabled).toBe(true);

    // Even with package IDs selected, the root switch wins when false.
    const offWithSelection = RuntimeConfig.init(DIRECTORY, {
      marketplace: { enabled: false },
      preset: 'fast',
      presets: { fast: { marketplace: { agents: ['author/pkg'] } } },
    });
    expect(offWithSelection.marketplaceEnabled).toBe(false);
  });

  test('disabledHooks and disabledCommands return a stable set per generation', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      disabled_hooks: ['foreground-fallback', 'phase-reminder'],
      disabled_commands: ['interview'],
    });

    const first = runtime.disabledHooks;
    const second = runtime.disabledHooks;
    expect(second).toBe(first);
    expect(first).toEqual(new Set(['foreground-fallback', 'phase-reminder']));

    const commands = runtime.disabledCommands;
    expect(runtime.disabledCommands).toBe(commands);
    expect(commands).toEqual(new Set(['interview']));

    // Re-seeding starts a new generation: the memoized sets are rebuilt.
    RuntimeConfig.init(DIRECTORY, {
      disabled_hooks: ['cache-monitor'],
    });
    expect(runtime.disabledHooks).not.toBe(first);
    expect(runtime.disabledHooks).toEqual(new Set(['cache-monitor']));
    // No disabled_commands in the new seed → empty set, still stable.
    const cleared = runtime.disabledCommands;
    expect(runtime.disabledCommands).toBe(cleared);
    expect(cleared).toEqual(new Set());
  });

  describe('acpAgents runtime projection', () => {
    test('projects configured wrappers with a stable per-generation ref', () => {
      resetRegistry();
      const runtime = RuntimeConfig.init(DIRECTORY, {
        acpAgents: {
          bridge: { command: 'bridge-acp' },
          research: { command: 'research-acp', timeoutMs: 5_000 },
        },
      });
      const first = runtime.acpAgents;
      expect(Object.keys(first)).toEqual(['bridge', 'research']);
      expect(first.research).toMatchObject({
        command: 'research-acp',
        timeoutMs: 5_000,
      });
      expect(Object.isFrozen(first)).toBe(true);
      expect(runtime.acpAgents).toBe(first);

      const detached = RuntimeConfig.createDetached(
        DIRECTORY,
        runtime.plugin ?? {},
      );
      expect(detached.acpAgents).not.toBe(first);
      expect(detached.acpAgents).toEqual(first);
    });

    test('re-seeding starts a new generation', () => {
      resetRegistry();
      const runtime = RuntimeConfig.init(DIRECTORY, {
        acpAgents: { bridge: { command: 'bridge-acp' } },
      });
      const first = runtime.acpAgents;
      RuntimeConfig.init(DIRECTORY, {
        acpAgents: { bridge: { command: 'bridge-acp' } },
      });
      expect(runtime.acpAgents).not.toBe(first);
      expect(runtime.acpAgents).toEqual(first);
      // Raw configured record survives the projection.
      expect(runtime.plugin?.acpAgents).toEqual({
        bridge: { command: 'bridge-acp' },
      });
    });

    test('disabled_tools with acp_run returns one frozen empty object', () => {
      resetRegistry();
      const runtime = RuntimeConfig.init(DIRECTORY, {
        disabled_tools: ['acp_run', 'task_cancel'],
        acpAgents: { bridge: { command: 'bridge-acp' } },
      });
      const projected = runtime.acpAgents;
      expect(projected).toEqual({});
      expect(Object.isFrozen(projected)).toBe(true);
      expect(runtime.acpAgents).toBe(projected);
      // Unrelated tool lists leave the projection untouched.
      RuntimeConfig.reset(DIRECTORY);
      const unrelated = RuntimeConfig.init(DIRECTORY, {
        disabled_tools: ['task_cancel'],
        acpAgents: { bridge: { command: 'bridge-acp' } },
      });
      expect(Object.keys(unrelated.acpAgents)).toEqual(['bridge']);
    });

    test('disabled agents are dropped from the projection', () => {
      resetRegistry();
      const runtime = RuntimeConfig.init(DIRECTORY, {
        disabled_agents: ['observer', 'second'],
        acpAgents: {
          observer: { command: 'observer-acp' },
          second: { command: 'second-acp' },
        },
      });
      expect(runtime.acpAgents).toEqual({});
      expect(runtime.plugin?.acpAgents?.second).toMatchObject({
        command: 'second-acp',
      });
    });

    test('names are trimmed like the agent factory', () => {
      resetRegistry();
      const runtime = RuntimeConfig.init(DIRECTORY, {
        disabled_agents: ['bridge'],
        acpAgents: {
          ' bridge ': { command: 'bridge-acp' },
          other: { command: 'other-acp' },
        },
      });
      expect(Object.keys(runtime.acpAgents)).toEqual(['other']);
    });

    test('an unseeded runtime exposes an empty projection', () => {
      resetRegistry();
      expect(RuntimeConfig.get(DIRECTORY).acpAgents).toEqual({});
    });
  });

  test('disabled collection defaults with an empty config', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {});
    expect(runtime.disabledAgents).toEqual(new Set(['observer']));
    expect(runtime.disabledTools).toEqual([]);
    expect(runtime.disabledMcps).toEqual([]);
    expect(runtime.disabledSkills).toEqual([]);
    expect(runtime.disabledHooks).toEqual(new Set());
    expect(runtime.disabledCommands).toEqual(new Set());
  });

  test('subsystem defaults with an empty config', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {});
    expect(runtime.multiplexer).toEqual({
      type: 'none',
      layout: 'main-vertical',
      main_pane_size: 60,
      equalize_panes: true,
    });
    expect(runtime.backgroundJobs.maxSessionsPerAgent).toBe(2);
    // The job board is never rendered on any host, so there is no
    // boardInjection switch to read.
    expect(
      'boardInjection' in (runtime.backgroundJobs as Record<string, unknown>),
    ).toBe(false);
    expect(runtime.backgroundJobs.pruneEvictedSessions).toBe(false);
    expect(runtime.backgroundJobs.concurrency).toEqual({
      defaultConcurrency: 0,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    expect(runtime.fallback).toEqual({
      enabled: true,
      maxRetries: 3,
      initialRetryDelayMs: 0,
      retryDelayMs: 500,
      continuationPolicy: 'retry-primary',
    });
    expect(runtime.featureGates.webfetch).toBe(true);
    expect(runtime.acpAgents).toEqual({});
  });

  test('model and host defaults with an empty config', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {});
    expect(runtime.agents()).toEqual({});
    expect(runtime.agent('explorer')).toBeUndefined();
    expect(runtime.customAgentNames).toEqual([]);
    expect(runtime.modelArrays).toEqual({});
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
      routingBlock: false,
      setDefaultAgent: false,
      compactSidebar: false,
      sidebar: false,
      image_routing: 'auto',
      disabled_agents: ['observer', 'orchestrator'],
      disabled_tools: ['webfetch'],
      disabled_mcps: ['context7'],
      disabled_skills: ['clonedeps'],
      disabled_hooks: ['foreground-fallback'],
      disabled_commands: ['interview', 'deepwork'],
      fallback: { enabled: false, maxRetries: 5 },
      webfetch: { enabled: false },
      acpAgents: { myAcp: { command: 'echo' } },
      backgroundJobs: { maxSessionsPerAgent: 7 },
      multiplexer: { type: 'tmux', layout: 'main-vertical' },
    });
    expect(runtime.updateCheckerEnabled).toBe(false);
    expect(runtime.stripOrchestratorModel).toBe(true);
    expect(runtime.routingBlock).toBe(false);
    expect(runtime.setDefaultAgent).toBe(false);
    expect(runtime.compactSidebar).toBe(false);
    expect(runtime.sidebarEnabled).toBe(false);
    expect(runtime.imageRouting).toBe('auto');
    // orchestrator is protected and cannot be disabled
    expect(runtime.disabledAgents).toEqual(new Set(['observer']));
    expect(runtime.disabledTools).toEqual(['webfetch']);
    expect(runtime.disabledMcps).toEqual(['context7']);
    expect(runtime.disabledSkills).toEqual(['clonedeps']);
    expect(runtime.disabledHooks).toEqual(new Set(['foreground-fallback']));
    expect(runtime.disabledCommands).toEqual(
      new Set(['interview', 'deepwork']),
    );
    expect(runtime.fallback.enabled).toBe(false);
    expect(runtime.fallback.maxRetries).toBe(5);
    expect(runtime.featureGates.webfetch).toBe(false);
    expect(runtime.acpAgents.myAcp.command).toBe('echo');
    expect(runtime.backgroundJobs.maxSessionsPerAgent).toBe(7);
    expect(runtime.multiplexer.type).toBe('tmux');
  });

  test('backgroundJobs folds childInputWake off into all-false kinds', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      backgroundJobs: {
        childInputWake: false,
        childInputWakeKinds: { question: true },
      },
    });
    expect(runtime.backgroundJobs.childInputWake).toBe(false);
    expect(runtime.backgroundJobs.childInputWakeKinds).toEqual({
      permission: false,
      question: false,
    });
  });

  test('backgroundJobs passes childInputWakeKinds through when enabled', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      backgroundJobs: {
        childInputWake: true,
        childInputWakeKinds: { permission: true, question: false },
      },
    });
    expect(runtime.backgroundJobs.childInputWakeKinds).toEqual({
      permission: true,
      question: false,
    });
  });

  test('backgroundJobs ships the default child-input wake kinds', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {});
    expect(runtime.backgroundJobs.childInputWakeKinds).toEqual(
      DEFAULT_CHILD_INPUT_WAKE_KINDS,
    );
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

  test("agent() returns the merged view of a legacy 'librarian' record", () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: { librarian: { model: 'x/legacy-model', temperature: 0.4 } },
    });
    expect(runtime.agent('explorer')).toEqual({
      model: 'x/legacy-model',
      temperature: 0.4,
    });
    expect(runtime.customAgentNames).toEqual([]);
  });

  test("agent() keeps canonical fields over merged 'librarian' fields", () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: {
        explorer: { model: 'x/canonical' },
        librarian: { model: 'x/legacy-model', temperature: 0.4 },
      },
    });
    expect(runtime.agent('explorer')).toEqual({
      model: 'x/canonical',
      temperature: 0.4,
    });
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

  test('modelArrays and runtimeChains retain nested spaced IDs and variants', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      preset: 'spaced',
      presets: {
        spaced: {
          explorer: {
            model: [
              {
                id: 'opencode-omniroute-live/of/MiniMax M3',
                variant: 'fast',
              },
              { id: 'of/Kimi K2.6', variant: 'balanced' },
              'opencode-omniroute-live/of/Qwen3.8 27b',
            ],
          },
        },
      },
    });

    expect(runtime.modelArrays.explorer).toEqual([
      {
        id: 'opencode-omniroute-live/of/MiniMax M3',
        variant: 'fast',
      },
      { id: 'of/Kimi K2.6', variant: 'balanced' },
      { id: 'opencode-omniroute-live/of/Qwen3.8 27b' },
    ]);
    expect(runtime.runtimeChains.explorer).toEqual([
      'opencode-omniroute-live/of/MiniMax M3',
      'of/Kimi K2.6',
      'opencode-omniroute-live/of/Qwen3.8 27b',
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

describe('RuntimeConfig combinedModelInheritanceSource', () => {
  test('resolves the source for combined array + inherit policies', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: {
        fixer: {
          model: ['chain/primary', 'chain/backup'],
          inheritModelFrom: 'session',
        },
        oracle: {
          model: [{ id: 'chain/primary' }],
          inheritModelFrom: 'orchestrator',
        },
      },
    } as PluginConfig);

    expect(runtime.combinedModelInheritanceSource('fixer')).toBe('session');
    expect(runtime.combinedModelInheritanceSource('oracle')).toBe(
      'orchestrator',
    );
  });

  test('resolves agent aliases to their canonical override', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: {
        explore: {
          model: ['chain/primary'],
          inheritModelFrom: 'session',
        },
      },
    } as PluginConfig);

    expect(runtime.combinedModelInheritanceSource('explorer')).toBe('session');
  });

  test('returns undefined for agents without a combined policy', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: {
        // Empty array: no usable chain.
        fixer: { model: [], inheritModelFrom: 'session' },
        // Array without an inheritance directive: fully static.
        oracle: { model: ['chain/primary'] },
        // Scalar model plus inheritance: explicit model wins.
        explorer: { model: 'explorer-model', inheritModelFrom: 'session' },
        // Inheritance without a chain: plain inherit, not combined.
        observer: { inheritModelFrom: 'session' },
      },
    } as PluginConfig);

    expect(runtime.combinedModelInheritanceSource('fixer')).toBeUndefined();
    expect(runtime.combinedModelInheritanceSource('oracle')).toBeUndefined();
    expect(runtime.combinedModelInheritanceSource('explorer')).toBeUndefined();
    expect(runtime.combinedModelInheritanceSource('observer')).toBeUndefined();
    expect(
      runtime.combinedModelInheritanceSource('unconfigured-agent'),
    ).toBeUndefined();
  });
});
