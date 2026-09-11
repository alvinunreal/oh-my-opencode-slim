import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { MultiplexerConfig } from './config';
import pluginModuleDefault, {
  OhMyOpenCodeLite as plugin,
  sessionManagerMultiplexerConfig,
  shouldEnableMultiplexer,
} from './index';
import { readTuiSnapshot } from './tui-state';

function createPluginClient(
  noop: () => Promise<unknown>,
  abort?: (input: { path: { id: string } }) => Promise<unknown>,
) {
  const session = new Proxy(abort ? { abort } : {}, {
    get(target, property) {
      if (property in target) {
        return target[property as keyof typeof target];
      }
      return noop;
    },
  }) as Record<string, unknown>;
  return new Proxy(
    { app: { log: noop }, session },
    {
      get(target, property) {
        if (property in target) {
          return target[property as keyof typeof target];
        }
        return new Proxy({}, { get: () => noop });
      },
    },
  );
}

function createHostTimerHarness() {
  let now = 0;
  let nextID = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const setTimeout = (callback: () => void, delay = 0) => {
    const id = ++nextID;
    timers.set(id, { at: now + delay, callback });
    return id;
  };
  const clearTimeout = (id: number) => timers.delete(id);
  const advanceTo = async (target: number) => {
    now = target;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (!due) break;
      timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
    }
  };

  return { now: () => now, setTimeout, clearTimeout, advanceTo };
}

describe('plugin env disable', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('returns empty hooks without reading plugin context', async () => {
    process.env.OH_MY_OPENCODE_SLIM_DISABLE = '1';

    const ctx = new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(`disabled plugin read ctx.${String(property)}`);
        },
      },
    );

    const hooks = await plugin(ctx as Parameters<typeof plugin>[0]);

    expect(hooks).toEqual({});
    expect(hooks.config).toBeUndefined();
    expect(hooks.event).toBeUndefined();
    expect(hooks.tool).toBeUndefined();
  });
});

describe('plugin tool registration', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    process.env.OPENCODE_CONFIG_DIR =
      '/private/tmp/oh-my-opencode-slim-hitl-empty-config';
    process.env.XDG_CONFIG_HOME =
      '/private/tmp/oh-my-opencode-slim-hitl-empty-xdg';
    process.env.XDG_DATA_HOME =
      '/private/tmp/oh-my-opencode-slim-hitl-empty-data';
    process.env.XDG_CACHE_HOME =
      '/private/tmp/oh-my-opencode-slim-hitl-empty-cache';
    process.env.OPENCODE_LOG_DIR =
      '/private/tmp/oh-my-opencode-slim-hitl-empty-logs';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('registers wait_for_user and recovers a stale orchestrator session mapping', async () => {
    const noop = async () => ({});
    const session = new Proxy({}, { get: () => noop }) as Record<
      string,
      unknown
    >;
    const client = new Proxy(
      { app: { log: noop }, session },
      {
        get(target, property) {
          if (property in target) {
            return target[property as keyof typeof target];
          }
          return new Proxy({}, { get: () => noop });
        },
      },
    );

    const hooks = await plugin({
      client,
      directory: '/private/tmp/oh-my-opencode-slim-hitl-project',
      worktree: '/private/tmp/oh-my-opencode-slim-hitl-project',
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    expect(hooks.tool?.task_status).toBeDefined();
    expect(hooks.tool?.task_result).toBeDefined();
    expect(hooks.tool?.task_message).toBeDefined();
    expect(hooks.tool?.task_cancel).toBeDefined();
    expect(hooks.tool?.task_revive).toBeDefined();
    expect(hooks.tool?.wait_for_user).toBeDefined();
    expect(hooks.tool?.marketplace).toBeDefined();
    await expect(
      hooks.tool?.wait_for_user?.execute(
        { reason: 'Complete the external approval.' },
        { sessionID: 'parent-after-reload', agent: 'orchestrator' } as never,
      ),
    ).resolves.toContain('state: waiting_for_user');
  });

  test('does not retain loop-guard state when search-path validation rejects', async () => {
    const projectDir = await mkdtemp('/tmp/oh-my-opencode-slim-search-hook-');
    const client = createPluginClient(async () => ({}));
    let hooks: Awaited<ReturnType<typeof plugin>> | undefined;

    try {
      hooks = await plugin({
        client,
        directory: projectDir,
        worktree: projectDir,
        serverUrl: new URL('http://127.0.0.1:4096'),
      } as never);

      const rejectedPath = path.join(projectDir, 'created-after-rejection');
      await expect(
        hooks['tool.execute.before']?.(
          { tool: 'glob', sessionID: 'search-loop', callID: 'rejected' },
          { args: { path: rejectedPath } },
        ),
      ).rejects.toThrow(/Search path does not exist/);

      // A host should not emit `after` after a rejected `before`, but this
      // simulates that stray completion to ensure it cannot poison tracking.
      await mkdir(rejectedPath);
      await hooks['tool.execute.after']?.(
        { tool: 'glob', sessionID: 'search-loop', callID: 'rejected' },
        { output: 'same', metadata: {} },
      );

      for (let i = 0; i < 4; i++) {
        const callID = `valid-${i}`;
        await hooks['tool.execute.before']?.(
          { tool: 'glob', sessionID: 'search-loop', callID },
          { args: { path: rejectedPath } },
        );
        await hooks['tool.execute.after']?.(
          { tool: 'glob', sessionID: 'search-loop', callID },
          { output: 'same', metadata: {} },
        );
      }

      await expect(
        hooks['tool.execute.before']?.(
          { tool: 'glob', sessionID: 'search-loop', callID: 'valid-4' },
          { args: { path: rejectedPath } },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await hooks?.dispose?.();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test('exposes an idempotent top-level dispose finalizer', async () => {
    const noop = async () => ({});
    const session = new Proxy({}, { get: () => noop }) as Record<
      string,
      unknown
    >;
    const client = new Proxy(
      { app: { log: noop }, session },
      {
        get(target, property) {
          if (property in target) {
            return target[property as keyof typeof target];
          }
          return new Proxy({}, { get: () => noop });
        },
      },
    );

    const hooks = await plugin({
      client,
      directory: '/private/tmp/oh-my-opencode-slim-dispose-project',
      worktree: '/private/tmp/oh-my-opencode-slim-dispose-project',
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    expect(hooks.dispose).toBeFunction();
    await hooks.dispose?.();
    await hooks.dispose?.();
  });

  test('disposes generation one timers and fresh generation two supervises launches', async () => {
    const originalEnv = { ...process.env };
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalNow = Date.now;
    const clock = createHostTimerHarness();
    const abortCalls: string[] = [];
    const noop = async () => ({});
    const client = createPluginClient(noop, async ({ path }) => {
      abortCalls.push(path.id);
      return {};
    });
    const configDir = await mkdtemp('/tmp/oh-my-opencode-slim-phase-2r-');
    await Bun.write(
      `${configDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        backgroundJobs: {
          wallClockTimeoutMs: 60_000,
          abortGraceMs: 1_000,
        },
      }),
    );
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    globalThis.setTimeout = clock.setTimeout as typeof globalThis.setTimeout;
    globalThis.clearTimeout =
      clock.clearTimeout as typeof globalThis.clearTimeout;
    Date.now = clock.now;

    const launch = async (
      hooks: Awaited<ReturnType<typeof plugin>>,
      callID: string,
      taskID: string,
    ) => {
      await hooks['tool.execute.before']?.(
        { tool: 'task', sessionID: 'parent-1', callID },
        {
          args: {
            subagent_type: 'explorer',
            background: true,
            description: taskID,
          },
        },
      );
      await hooks['tool.execute.after']?.(
        { tool: 'task', sessionID: 'parent-1', callID },
        {
          output: [
            `task_id: ${taskID}`,
            'state: running',
            '',
            '<task_result>',
            'started',
            '</task_result>',
          ].join('\n'),
        },
      );
    };

    let generationOne: Awaited<ReturnType<typeof plugin>> | undefined;
    let generationTwo: Awaited<ReturnType<typeof plugin>> | undefined;
    try {
      generationOne = await plugin({
        client,
        directory: configDir,
        worktree: configDir,
        serverUrl: new URL('http://127.0.0.1:4096'),
      } as never);
      expect(generationOne.dispose).toBeFunction();
      await launch(generationOne, 'call-1', 'child-generation-1');

      await clock.advanceTo(59_999);
      expect(abortCalls).toEqual([]);
      await generationOne.dispose?.();
      await generationOne.dispose?.();
      await clock.advanceTo(60_000);
      expect(abortCalls).toEqual([]);

      generationTwo = await plugin({
        client,
        directory: configDir,
        worktree: configDir,
        serverUrl: new URL('http://127.0.0.1:4096'),
      } as never);
      expect(generationTwo.dispose).toBeFunction();
      await launch(generationTwo, 'call-2', 'child-generation-2');
      await clock.advanceTo(119_999);
      expect(abortCalls).toEqual([]);
      await clock.advanceTo(120_000);
      expect(abortCalls).toEqual(['child-generation-2']);
    } finally {
      await generationTwo?.dispose?.();
      await generationOne?.dispose?.();
      process.env = originalEnv;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      Date.now = originalNow;
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('plugin TUI agent activity', () => {
  let originalEnv: typeof process.env;
  let projectDir: string;
  let hooks: Awaited<ReturnType<typeof plugin>> | undefined;
  const createActivityPlugin = () =>
    plugin({
      client: createPluginClient(async () => ({})),
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

  beforeEach(async () => {
    originalEnv = { ...process.env };
    projectDir = await mkdtemp('/tmp/oh-my-opencode-slim-tui-activity-');
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: projectDir,
      XDG_DATA_HOME: `${projectDir}/data`,
      XDG_CACHE_HOME: `${projectDir}/cache`,
      OPENCODE_LOG_DIR: `${projectDir}/logs`,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({ companion: { enabled: false } }),
    );

    hooks = await createActivityPlugin();
  });

  afterEach(async () => {
    await hooks?.dispose?.();
    process.env = originalEnv;
    await rm(projectDir, { recursive: true, force: true });
  });

  test('keeps an agent active until all of its sessions stop', async () => {
    const chatMessage = hooks?.['chat.message'];
    expect(chatMessage).toBeFunction();

    await chatMessage?.(
      { sessionID: 'fixer-a', agent: 'fixer' } as never,
      {} as never,
    );
    await chatMessage?.(
      { sessionID: 'fixer-b', agent: 'fixer' } as never,
      {} as never,
    );

    await hooks?.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'fixer-a', status: { type: 'idle' } },
      },
    } as never);

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
      'fixer-b': 'fixer',
    });

    await hooks?.event?.({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 'fixer-b' } },
      },
    } as never);

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({});
  });

  test('clears active sessions when plugin disposes', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'oracle-a', agent: 'oracle' } as never,
      {} as never,
    );

    await hooks?.dispose?.();

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({});
  });

  test('server disposal preserves activity owned by another plugin instance', async () => {
    const otherHooks = await createActivityPlugin();

    try {
      await hooks?.['chat.message']?.(
        { sessionID: 'oracle-a', agent: 'oracle' } as never,
        {} as never,
      );
      await otherHooks['chat.message']?.(
        { sessionID: 'explorer-b', agent: 'explorer' } as never,
        {} as never,
      );

      await hooks?.event?.({
        event: { type: 'server.instance.disposed' },
      } as never);

      expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
        'explorer-b': 'explorer',
      });
    } finally {
      await otherHooks.dispose?.();
    }
  });
});

describe('background task admission model resolution', () => {
  let originalEnv: typeof process.env;
  let projectDir: string;
  let hooks: Awaited<ReturnType<typeof plugin>> | undefined;

  const createPlugin = () =>
    plugin({
      client: createPluginClient(async () => ({})),
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4098'),
    } as never);

  beforeEach(async () => {
    originalEnv = { ...process.env };
    projectDir = await mkdtemp('/tmp/oh-my-opencode-slim-concurrency-');
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: projectDir,
      XDG_DATA_HOME: `${projectDir}/data`,
      XDG_CACHE_HOME: `${projectDir}/cache`,
      OPENCODE_LOG_DIR: `${projectDir}/logs`,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: false },
        backgroundJobs: {
          concurrency: {
            defaultConcurrency: 0,
            providerConcurrency: { openai: 1 },
          },
        },
        agents: { fixer: { inheritModelFrom: 'session' } },
      }),
    );
    hooks = await createPlugin();
  });

  afterEach(async () => {
    await hooks?.dispose?.();
    process.env = originalEnv;
    await rm(projectDir, { recursive: true, force: true });
  });

  test('chat.message records the session model so session-inheriting tasks queue behind the parent provider cap', async () => {
    // chat.message fires before message.updated and carries the message's
    // model. Without recording it, a session-inheriting fixer task would be
    // admitted with no model (default tier, no provider cap).
    await hooks?.['chat.message']?.(
      {
        sessionID: 'orchestrator-1',
        agent: 'orchestrator',
        model: { providerID: 'openai', modelID: 'gpt-4o' },
      } as never,
      {} as never,
    );

    const before = hooks?.['tool.execute.before'];
    expect(before).toBeFunction();

    const first = before?.(
      { tool: 'task', sessionID: 'orchestrator-1', callID: 'call-1' } as never,
      {
        args: {
          background: true,
          subagent_type: 'fixer',
          description: 'first task',
        },
      } as never,
    );
    const second = before?.(
      { tool: 'task', sessionID: 'orchestrator-1', callID: 'call-2' } as never,
      {
        args: {
          background: true,
          subagent_type: 'fixer',
          description: 'second task',
        },
      } as never,
    );

    // The first fixer task holds the single openai slot (resolved from the
    // parent's model recorded by chat.message); the second must stay queued.
    // (Slot release happens via board terminal outcomes, out of scope here.)
    await first;
    const outcome = await Promise.race([
      second?.then(
        () => 'admitted',
        (e) => `rejected:${String(e)}`,
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('still-queued'), 100),
      ),
    ]);
    expect(outcome).toBe('still-queued');
  });
});

describe('plugin config model inheritance', () => {
  let originalEnv: typeof process.env;
  const configDirs: string[] = [];

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  });

  afterEach(async () => {
    process.env = originalEnv;
    while (configDirs.length > 0) {
      const configDir = configDirs.pop();
      if (configDir) {
        await rm(configDir, { recursive: true, force: true });
      }
    }
  });

  async function loadConfiguredPlugin(config: Record<string, unknown>) {
    const configDir = await mkdtemp('/tmp/oh-my-opencode-inheritance-');
    configDirs.push(configDir);
    await Bun.write(
      `${configDir}/oh-my-opencode-slim.json`,
      JSON.stringify(config),
    );
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_DATA_HOME: `${configDir}/data`,
      XDG_CACHE_HOME: `${configDir}/cache`,
      OPENCODE_LOG_DIR: `${configDir}/logs`,
    };

    const client = createPluginClient(async () => ({}));
    return plugin({
      client,
      directory: configDir,
      worktree: configDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
  }

  async function assertAdmissionUsesFinalModel(
    subagentType: string,
    config: Record<string, unknown>,
    hostAgent: Record<string, unknown>,
  ): Promise<void> {
    const hooks = await loadConfiguredPlugin(config);
    try {
      await hooks.config?.({ agent: hostAgent });
      await hooks['chat.message']?.(
        {
          sessionID: 'orchestrator-1',
          agent: 'orchestrator',
          model: { providerID: 'openai', modelID: 'parent' },
        } as never,
        {} as never,
      );
      const first = hooks['tool.execute.before']?.(
        {
          tool: 'task',
          sessionID: 'orchestrator-1',
          callID: 'call-1',
        } as never,
        {
          args: {
            background: true,
            subagent_type: subagentType,
            description: 'first admission',
          },
        } as never,
      );
      const second = hooks['tool.execute.before']?.(
        {
          tool: 'task',
          sessionID: 'orchestrator-1',
          callID: 'call-2',
        } as never,
        {
          args: {
            background: true,
            subagent_type: subagentType,
            description: 'second admission',
          },
        } as never,
      );

      await first;
      const queued = await Promise.race([
        second?.then(
          () => 'admitted',
          () => 'rejected',
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('still-queued'), 30),
        ),
      ]);
      expect(queued).toBe('still-queued');

      await hooks['tool.execute.after']?.(
        {
          tool: 'task',
          sessionID: 'orchestrator-1',
          callID: 'call-1',
        } as never,
        {
          output: 'task_id: child-1\nstate: completed\nresult: done',
        } as never,
      );
      await second;
    } finally {
      await hooks.dispose?.();
    }
  }

  test('session inheritance removes a stale host model in the final config', async () => {
    const hooks = await loadConfiguredPlugin({
      agents: {
        librarian: { model: 'local/librarian' },
        fixer: { inheritModelFrom: 'session' },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        orchestrator: { model: 'host/orchestrator' },
        fixer: { model: 'host/stale-fixer', temperature: 0.2 },
      },
    };

    try {
      await hooks.config?.(hostConfig);

      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(agents.fixer?.model).toBeUndefined();
      expect(agents.fixer?.temperature).toBe(0.2);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('orchestrator inheritance uses the host orchestrator model in the final config', async () => {
    const hooks = await loadConfiguredPlugin({
      agents: {
        librarian: { inheritModelFrom: 'orchestrator' },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        orchestrator: { model: 'host/orchestrator' },
        librarian: { model: 'host/stale-librarian' },
      },
    };

    try {
      await hooks.config?.(hostConfig);

      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(agents.librarian?.model).toBe('host/orchestrator');
    } finally {
      await hooks.dispose?.();
    }
  });

  test('preset inheritance clears a stale host model in the final config', async () => {
    const hooks = await loadConfiguredPlugin({
      preset: 'split',
      presets: {
        split: {
          agents: {
            orchestrator: { model: 'preset/orchestrator' },
            fixer: { inheritModelFrom: 'session' },
          },
        },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        orchestrator: { model: 'host/orchestrator' },
        fixer: { model: 'host/stale-fixer', temperature: 0.4 },
      },
    };

    try {
      await hooks.config?.(hostConfig);

      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(agents.fixer?.model).toBeUndefined();
      expect(agents.fixer?.temperature).toBe(0.4);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('config() writes the visible orchestrator display name as default_agent', async () => {
    const hooks = await loadConfiguredPlugin({
      council: {
        presets: { default: { alpha: { model: 'test/councillor' } } },
      },
      agents: {
        orchestrator: { displayName: 'EngineeringLead' },
        council: { displayName: 'ArchitectureCouncil' },
      },
    });
    const hostConfig: Record<string, unknown> = {};

    try {
      await hooks.config?.(hostConfig);

      // The orchestrator's visible entry is keyed by its display name;
      // canonical 'orchestrator' is only a hidden alias, so default_agent
      // must target the display-name entry.
      expect(hostConfig.default_agent).toBe('EngineeringLead');
      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(agents.EngineeringLead?.hidden).toBeUndefined();
      expect(agents.orchestrator?.hidden).toBe(true);
      expect(agents.ArchitectureCouncil?.hidden).toBeUndefined();
      expect(agents.council?.hidden).toBe(true);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('admission uses a direct host override from final agent config', async () => {
    await assertAdmissionUsesFinalModel(
      'fixer',
      {
        backgroundJobs: {
          concurrency: {
            defaultConcurrency: 0,
            providerConcurrency: { host: 1 },
          },
        },
        agents: { fixer: { model: 'plugin/fixer' } },
      },
      { fixer: { model: 'host/fixer' } },
    );
  });

  test('admission uses a display-name host override before alias resolution', async () => {
    await assertAdmissionUsesFinalModel(
      'researcher',
      {
        backgroundJobs: {
          concurrency: {
            defaultConcurrency: 0,
            providerConcurrency: { host: 1 },
          },
        },
        agents: {
          explorer: { model: 'plugin/explorer', displayName: 'researcher' },
        },
      },
      { researcher: { model: 'host/researcher' } },
    );
  });

  test('admission resolves a legacy agent alias to the final canonical entry', async () => {
    await assertAdmissionUsesFinalModel(
      'explore',
      {
        backgroundJobs: {
          concurrency: {
            defaultConcurrency: 0,
            providerConcurrency: { host: 1 },
          },
        },
        agents: { explorer: { model: 'plugin/explorer' } },
      },
      { explorer: { model: 'host/explorer' } },
    );
  });

  test('ACP admission falls back to the parent only when its final config is model-less', async () => {
    await assertAdmissionUsesFinalModel(
      'external',
      {
        backgroundJobs: {
          concurrency: {
            defaultConcurrency: 0,
            providerConcurrency: { openai: 1 },
          },
        },
        acpAgents: { external: { command: 'bridge-acp' } },
      },
      { orchestrator: { model: 'openai/parent' } },
    );
  });
});

describe('multiplexer host gating', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('multiplexer is host-gated off on v2', () => {
    // Minimal base input satisfying every v1 condition: a configured
    // multiplexer type plus a live inside-session env marker (TMUX).
    process.env.TMUX = '/tmp/tmux-1000/default,1,0';
    const baseInput = {
      multiplexerConfig: {
        type: 'tmux',
        layout: 'main-vertical',
        main_pane_size: 60,
        zellij_pane_mode: 'agent-tab',
      } satisfies MultiplexerConfig,
    };

    expect(shouldEnableMultiplexer(baseInput)).toBe(true); // v1 unchanged
    expect(shouldEnableMultiplexer({ hostFlavor: 'v2', ...baseInput })).toBe(
      false,
    );
  });

  test('multiplexer session manager config is forced off on v2 hosts', () => {
    const multiplexerConfig = {
      type: 'tmux',
      layout: 'main-vertical',
      main_pane_size: 60,
      zellij_pane_mode: 'agent-tab',
    } satisfies MultiplexerConfig;

    // v2: type forced to 'none' so the manager's env-based self-gate
    // (which would fire inside tmux) cannot re-enable pane management.
    expect(sessionManagerMultiplexerConfig('v2', multiplexerConfig).type).toBe(
      'none',
    );
    // v1: the exact same config object is passed through untouched.
    expect(sessionManagerMultiplexerConfig(undefined, multiplexerConfig)).toBe(
      multiplexerConfig,
    );
  });
});

describe('v1 host plugin module contract', () => {
  // OpenCode v1.18.23+ validates a plugin module's default export before
  // loading it:
  //   - `server`, when present, must be a function
  //   - `tui`, when present, must be a function
  //   - a module must not declare both `server` and `tui`
  // A boolean `tui: true` marker on the server entry violates the second
  // and third rules, so the whole plugin fails to load with
  // "Plugin ... has invalid tui export" (observed on v1.18.25). The TUI
  // entry ships separately via the `./tui` package export.
  test('server entry keeps a callable server export and no tui key', () => {
    expect(typeof pluginModuleDefault).toBe('object');
    expect(pluginModuleDefault).not.toBeNull();

    const module = pluginModuleDefault as Record<string, unknown>;

    // v1 loader: `server` present must be a function.
    expect(typeof module.server).toBe('function');
    // v1 loader: `tui` must be absent (or a function in a tui-only module);
    // a server module declaring `tui` is rejected outright.
    expect('tui' in module).toBe(false);
  });
});
