import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { stateFilePath } from './companion/manager';
import type { MultiplexerConfig } from './config';
import * as wakeHooks from './hooks';
import {
  getWakeProgress,
  resetOrchestratorWakeGateForTests,
} from './hooks/orchestrator-wake/wake-gate';
import pluginModuleDefault, {
  OhMyOpenCodeLite as plugin,
  sessionManagerMultiplexerConfig,
  shouldEnableMultiplexer,
} from './index';
import { readTuiSnapshot, snapshotSectionsEqual } from './tui-state';
import { BackgroundJobCoordinator } from './utils/background-job-coordinator';
import { BackgroundJobBoard } from './utils/background-job-fixture';
import { createInternalAgentTextPart } from './utils/internal-initiator';

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

describe('plugin reload generation cleanup', () => {
  let originalEnv: typeof process.env;
  let projectDir: string;

  const createHooks = (pluginConfig: Record<string, unknown> = {}) =>
    plugin({
      client: createPluginClient(async () => ({})),
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
      ...pluginConfig,
    } as never);

  beforeEach(async () => {
    originalEnv = { ...process.env };
    projectDir = await mkdtemp('/tmp/oh-my-opencode-slim-gens-');
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
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(projectDir, { recursive: true, force: true });
  });

  test('v1 dispose clears the process-global wake gate progress', async () => {
    resetOrchestratorWakeGateForTests();
    try {
      const hooks = await createHooks();

      // Simulate a generation-one session that already hit the two-wake
      // no-progress cap. The wake gate is process-global (globalThis +
      // Symbol.for), so without explicit disposal cleanup a reloaded
      // generation would inherit the cap and never wake this session.
      const progress = getWakeProgress('wake-generation-session');
      progress.unchangedWakeCount = 2;
      progress.stopped = true;
      progress.expectingWakeBusy = true;

      await hooks.dispose?.();

      expect(getWakeProgress('wake-generation-session')).toEqual({
        unchangedWakeCount: 0,
        lastFingerprint: undefined,
        stopped: false,
        expectingWakeBusy: false,
        observedModel: undefined,
      });
    } finally {
      resetOrchestratorWakeGateForTests();
    }
  });

  test.each(['provisional', 'promoted', 'preserveRun', 'attributed'])(
    'stopped recovery listener respects explicit provenance: %s',
    async (kind) => {
      const wake = mock(() => {});
      const createScheduler = wakeHooks.createOrchestratorWakeScheduler;
      const scheduler = spyOn(
        wakeHooks,
        'createOrchestratorWakeScheduler',
      ).mockImplementation((...args) => ({
        ...createScheduler(...args),
        triggerStoppedJobRecovery: wake,
      }));
      const subscriptions = spyOn(
        BackgroundJobCoordinator.prototype,
        'addTerminalOutcomeListener',
      );
      let hooks: Awaited<ReturnType<typeof plugin>> | undefined;
      try {
        hooks = await createHooks();
        const board = new BackgroundJobBoard();
        const launch = {
          taskID: 'child-1',
          parentSessionID: 'parent-1',
          agent: 'unknown',
          description: 'unattributed unknown task',
          now: 100,
        };
        const initial = board.registerLaunch({
          ...launch,
          ...(kind === 'attributed' ? {} : { provisional: true as const }),
        });
        if (kind === 'attributed')
          expect(initial).not.toHaveProperty('provisional');
        if (kind === 'promoted' || kind === 'preserveRun')
          board.registerLaunch({
            ...launch,
            preserveRun: kind === 'preserveRun',
          });
        const stopped = board.markStopped(launch.taskID, 'no outcome', 200);
        if (!stopped) throw new Error('missing stopped record');
        expect(stopped).toMatchObject({
          state: 'stopped',
          terminalUnreconciled: true,
        });
        // Invoke the real subscriptions installed by the plugin composition.
        for (const [listener] of subscriptions.mock.calls) listener(stopped);
        expect(wake).toHaveBeenCalledTimes(kind === 'provisional' ? 0 : 1);
        if (kind !== 'provisional') {
          expect(wake.mock.calls[0]?.[0]).toBe('parent-1');
          expect(board.formatForPrompt('parent-1')).toContain(launch.taskID);
        }
      } finally {
        await hooks?.dispose?.();
        scheduler.mockRestore();
        subscriptions.mockRestore();
      }
    },
  );

  test('v1 dispose releases this generation companion manager', async () => {
    // Enabled with a custom (missing) binaryPath: registration and state
    // writes run, but neither the updater nor spawnIfAvailable touches
    // the network or spawns a child.
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: {
          enabled: true,
          binaryPath: `${projectDir}/missing-companion-bin`,
        },
      }),
    );
    const hooks = await createHooks();
    const readSessionIds = (): string[] => {
      const state = JSON.parse(readFileSync(stateFilePath(), 'utf8')) as {
        sessions: Array<{ session_id: string }>;
      };
      return state.sessions.map((s) => s.session_id);
    };

    // onLoad registered this generation's manager in the state file.
    expect(readSessionIds()).toContain(`proc_${process.pid}`);

    await hooks.dispose?.();

    // dispose must call companionManager.onExit(): the session entry is
    // withdrawn even if the next generation fails before its own onLoad.
    expect(readSessionIds()).not.toContain(`proc_${process.pid}`);
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

  const busy = (sessionID: string) =>
    hooks?.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID, status: { type: 'busy' } },
      },
    } as never);

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
    await busy('fixer-a');
    await busy('fixer-b');

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
    await busy('oracle-a');

    await hooks?.dispose?.();

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({});
  });

  test('second plugin init in the same PID does not wipe the first instance activity', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'oracle-live', agent: 'oracle' } as never,
      {} as never,
    );
    await busy('oracle-live');
    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
      'oracle-live': 'oracle',
    });

    const second = await createActivityPlugin();
    try {
      expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
        'oracle-live': 'oracle',
      });
    } finally {
      await second.dispose?.();
    }
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
      await busy('oracle-a');
      await otherHooks.event?.({
        event: {
          type: 'session.status',
          properties: { sessionID: 'explorer-b', status: { type: 'busy' } },
        },
      } as never);

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

  test('hydrates the full ancestry chain with the SDK receiver intact', async () => {
    const calls: string[] = [];
    const receivers: unknown[] = [];
    const sessionApi = {
      async get(this: unknown, input: { path: { id: string } }) {
        calls.push(input.path.id);
        receivers.push(this);
        const parents: Record<string, string | undefined> = {
          grandchild: 'child',
          child: 'root',
          root: undefined,
        };
        return { data: { parentID: parents[input.path.id] } };
      },
    };
    const chainHooks = await plugin({
      client: { session: sessionApi },
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    try {
      await chainHooks?.event?.({
        event: {
          type: 'session.status',
          properties: { sessionID: 'grandchild', status: { type: 'busy' } },
        },
      } as never);
      await chainHooks?.['chat.message']?.(
        { sessionID: 'grandchild', agent: 'fixer' } as never,
        {} as never,
      );
      // Fire-and-forget hydration; give the microtask queue a beat.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const snapshot = readTuiSnapshot(projectDir);
      expect(snapshot.sessionParents).toEqual({
        grandchild: 'child',
        child: 'root',
      });
      expect(calls).toEqual(['grandchild', 'child', 'root']);
      // The SDK method must run with its receiver (#595 class of bug).
      for (const receiver of receivers) {
        expect(receiver).toBe(sessionApi);
      }
    } finally {
      await chainHooks?.dispose?.();
    }
  });

  test('does not cache an errored host lookup as a confirmed root', async () => {
    let attempts = 0;
    const sessionApi = {
      async get(input: { path: { id: string } }) {
        attempts += 1;
        if (attempts === 1) {
          // HTTP error resolved instead of thrown (SDK default).
          return { error: { status: 503 }, data: undefined };
        }
        if (input.path.id === 'real-root') {
          return { data: { parentID: undefined } }; // Confirmed root.
        }
        return { data: { parentID: 'real-root' } };
      },
    };
    const retryHooks = await plugin({
      client: { session: sessionApi },
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    try {
      await retryHooks?.event?.({
        event: {
          type: 'session.status',
          properties: { sessionID: 'orphan-a', status: { type: 'busy' } },
        },
      } as never);
      await retryHooks?.['chat.message']?.(
        { sessionID: 'orphan-a', agent: 'fixer' } as never,
        {} as never,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(readTuiSnapshot(projectDir).sessionParents).toEqual({});

      // A later activation must retry: the failed slot was released.
      await retryHooks?.event?.({
        event: {
          type: 'session.status',
          properties: { sessionID: 'orphan-a', status: { type: 'busy' } },
        },
      } as never);
      await retryHooks?.['chat.message']?.(
        { sessionID: 'orphan-a', agent: 'fixer' } as never,
        {} as never,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      // 1st: 503 (released). 2nd: retry yields the parent. 3rd: confirms
      // real-root has no further parent (walk to a confirmed root).
      expect(attempts).toBe(3);
      expect(readTuiSnapshot(projectDir).sessionParents['orphan-a']).toBe(
        'real-root',
      );
    } finally {
      await retryHooks?.dispose?.();
    }
  });

  test('does not cache a malformed parentID as a confirmed root', async () => {
    let attempts = 0;
    const sessionApi = {
      async get(_input: { path: { id: string } }) {
        attempts += 1;
        if (attempts === 1) {
          // Malformed non-string parent: contract violation, not a root.
          return { data: { parentID: 123 } };
        }
        return { data: { parentID: 'fixed-root' } };
      },
    };
    const malformedHooks = await plugin({
      client: { session: sessionApi },
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    try {
      await malformedHooks?.event?.({
        event: {
          type: 'session.status',
          properties: { sessionID: 'broken-a', status: { type: 'busy' } },
        },
      } as never);
      await malformedHooks?.['chat.message']?.(
        { sessionID: 'broken-a', agent: 'fixer' } as never,
        {} as never,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(readTuiSnapshot(projectDir).sessionParents).toEqual({});

      // A later activation must retry: the malformed slot was released.
      await malformedHooks?.event?.({
        event: {
          type: 'session.status',
          properties: { sessionID: 'broken-a', status: { type: 'busy' } },
        },
      } as never);
      await malformedHooks?.['chat.message']?.(
        { sessionID: 'broken-a', agent: 'fixer' } as never,
        {} as never,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(readTuiSnapshot(projectDir).sessionParents['broken-a']).toBe(
        'fixed-root',
      );
    } finally {
      await malformedHooks?.dispose?.();
    }
  });
  test('chat.message does not light a spinner without session.status busy', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'orch', agent: 'orchestrator' } as never,
      {} as never,
    );
    await hooks?.['chat.message']?.(
      { sessionID: 'lib-child', agent: 'librarian' } as never,
      {} as never,
    );

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({});

    await busy('lib-child');

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
      'lib-child': 'librarian',
    });
  });

  test('idle stays idle after a later chat.message on the same session', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'orch', agent: 'orchestrator' } as never,
      {} as never,
    );
    await busy('orch');
    await hooks?.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'orch', status: { type: 'idle' } },
      },
    } as never);

    await hooks?.['chat.message']?.(
      { sessionID: 'orch', agent: 'orchestrator' } as never,
      {} as never,
    );

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({});
  });

  test('busy before the agent is known still lights the spinner on chat.message', async () => {
    await busy('late-agent');
    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({});

    await hooks?.['chat.message']?.(
      { sessionID: 'late-agent', agent: 'fixer' } as never,
      {} as never,
    );

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
      'late-agent': 'fixer',
    });
  });

  test('agent change while busy moves the spinner to the new agent row', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'root', agent: 'orchestrator' } as never,
      {} as never,
    );
    await busy('root');
    await hooks?.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'root', status: { type: 'idle' } },
      },
    } as never);
    await busy('root');

    await hooks?.['chat.message']?.(
      { sessionID: 'root', agent: 'fixer' } as never,
      {} as never,
    );

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
      root: 'fixer',
    });
  });

  test('message.part.delta does not write TUI activity or session model', async () => {
    await hooks?.['chat.message']?.(
      {
        sessionID: 'stream-1',
        agent: 'orchestrator',
        model: { providerID: 'openai', modelID: 'gpt-4o' },
      } as never,
      {} as never,
    );
    const before = readTuiSnapshot(projectDir);

    await hooks?.event?.({
      event: {
        type: 'message.part.delta',
        properties: {
          sessionID: 'stream-1',
          messageID: 'msg-1',
          partID: 'part-1',
          field: 'text',
          delta: 'a'.repeat(200),
        },
      },
    } as never);

    const after = readTuiSnapshot(projectDir);
    expect(after.activeSessions).toEqual(before.activeSessions);
    expect(after.agentModels).toEqual(before.agentModels);
    expect(snapshotSectionsEqual(after, before)).toBe(true);
  });

  test('chat.message model is published to sessionDetails when the session is already busy', async () => {
    await busy('ora-child');
    await hooks?.['chat.message']?.(
      {
        sessionID: 'ora-child',
        agent: 'oracle',
        model: { providerID: 'openai', modelID: 'gpt-5.6' },
      } as never,
      {} as never,
    );

    expect(readTuiSnapshot(projectDir).sessionDetails['ora-child']).toEqual({
      model: 'openai/gpt-5.6',
      status: 'busy',
    });
  });

  test('model observed before busy is recovered on activation (v2 order)', async () => {
    await hooks?.['chat.message']?.(
      {
        sessionID: 'ora-early',
        agent: 'oracle',
        model: { providerID: 'openai', modelID: 'gpt-5.6' },
      } as never,
      {} as never,
    );
    expect(readTuiSnapshot(projectDir).sessionDetails).toEqual({});

    await busy('ora-early');
    expect(readTuiSnapshot(projectDir).sessionDetails['ora-early']).toEqual({
      model: 'openai/gpt-5.6',
      status: 'busy',
    });
  });

  test('two same-agent sessions keep distinct models in sessionDetails', async () => {
    await hooks?.['chat.message']?.(
      {
        sessionID: 'ora-a',
        agent: 'oracle',
        model: { providerID: 'openai', modelID: 'gpt-5.6' },
      } as never,
      {} as never,
    );
    await hooks?.['chat.message']?.(
      {
        sessionID: 'ora-b',
        agent: 'oracle',
        model: { providerID: 'anthropic', modelID: 'claude-opus' },
      } as never,
      {} as never,
    );
    await busy('ora-a');
    await busy('ora-b');

    const details = readTuiSnapshot(projectDir).sessionDetails;
    expect(details['ora-a']?.model).toBe('openai/gpt-5.6');
    expect(details['ora-b']?.model).toBe('anthropic/claude-opus');
  });

  test('chat.message model after idle does not resurrect sessionDetails', async () => {
    await hooks?.['chat.message']?.(
      {
        sessionID: 'ora-idle',
        agent: 'oracle',
        model: { providerID: 'openai', modelID: 'gpt-5.6' },
      } as never,
      {} as never,
    );
    await busy('ora-idle');
    await hooks?.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ora-idle', status: { type: 'idle' } },
      },
    } as never);

    await hooks?.['chat.message']?.(
      {
        sessionID: 'ora-idle',
        agent: 'oracle',
        model: { providerID: 'openai', modelID: 'gpt-5.6' },
      } as never,
      {} as never,
    );

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({});
    expect(readTuiSnapshot(projectDir).sessionDetails).toEqual({});
  });

  const launchChild = async (
    parentID: string,
    childID: string,
    callID: string,
  ) => {
    await hooks?.['tool.execute.before']?.(
      { tool: 'task', sessionID: parentID, callID } as never,
      {
        args: {
          background: true,
          subagent_type: 'oracle',
          description: 'sidebar child',
        },
      } as never,
    );
    await hooks?.['tool.execute.after']?.(
      { tool: 'task', sessionID: parentID, callID } as never,
      {
        output: [
          `task_id: ${childID}`,
          'state: running',
          '',
          '<task_result>',
          'Background task started.',
          '</task_result>',
        ].join('\n'),
      } as never,
    );
  };

  test('launch then busy persists the board alias into sessionDetails', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'parent-1', agent: 'orchestrator' } as never,
      {} as never,
    );
    await launchChild('parent-1', 'child-launch-first', 'call-launch-first');
    await hooks?.['chat.message']?.(
      { sessionID: 'child-launch-first', agent: 'oracle' } as never,
      {} as never,
    );
    await busy('child-launch-first');

    const snapshot = readTuiSnapshot(projectDir);
    expect(snapshot.sessionParents['child-launch-first']).toBe('parent-1');
    expect(snapshot.sessionDetails['child-launch-first']?.alias).toMatch(
      /^ora-\d+$/,
    );
    expect(snapshot.activeSessions['child-launch-first']).toBe('oracle');
  });

  test('busy then launch backfills the alias without resurrecting idle sessions', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'parent-2', agent: 'orchestrator' } as never,
      {} as never,
    );
    await hooks?.['chat.message']?.(
      { sessionID: 'child-busy-first', agent: 'oracle' } as never,
      {} as never,
    );
    await busy('child-busy-first');
    expect(
      readTuiSnapshot(projectDir).sessionDetails['child-busy-first']?.alias,
    ).toBeUndefined();

    await launchChild('parent-2', 'child-busy-first', 'call-busy-first');

    const snapshot = readTuiSnapshot(projectDir);
    expect(snapshot.sessionParents['child-busy-first']).toBe('parent-2');
    expect(snapshot.sessionDetails['child-busy-first']?.alias).toMatch(
      /^ora-\d+$/,
    );
  });

  test('terminal subagent output clears active session in TUI snapshot', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'parent-3', agent: 'orchestrator' } as never,
      {} as never,
    );
    await hooks?.['tool.execute.before']?.(
      { tool: 'task', sessionID: 'parent-3', callID: 'call-fg-1' } as never,
      {
        args: {
          background: false,
          subagent_type: 'oracle',
          description: 'foreground child',
        },
      } as never,
    );
    await hooks?.['chat.message']?.(
      { sessionID: 'child-fg-1', agent: 'oracle' } as never,
      {} as never,
    );
    await busy('child-fg-1');

    expect(readTuiSnapshot(projectDir).activeSessions['child-fg-1']).toBe(
      'oracle',
    );

    await hooks?.['tool.execute.after']?.(
      { tool: 'task', sessionID: 'parent-3', callID: 'call-fg-1' } as never,
      {
        output: [
          'task_id: child-fg-1',
          'state: completed',
          '',
          '<task_result>',
          'Analysis finished.',
          '</task_result>',
        ].join('\n'),
      } as never,
    );

    // #1215: a callID-confirmed foreground native terminal return is itself
    // terminal evidence, so the active session clears immediately.
    const snapshot = readTuiSnapshot(projectDir);
    expect(snapshot.activeSessions['child-fg-1']).toBeUndefined();
    expect(snapshot.sessionDetails['child-fg-1']).toBeUndefined();
  });

  test('unattributed terminal output defers until idle evidence clears it', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'parent-4', agent: 'orchestrator' } as never,
      {} as never,
    );
    // The pending call is registered under a different callID than the
    // returning output, so attribution is text-parsed, never
    // callID-confirmed: the #1215 fast path must not fire. The child's
    // session.created early-registers the pending for this task ID, so
    // the mismatched return still resolves identity — unconfirmed.
    await hooks?.['tool.execute.before']?.(
      { tool: 'task', sessionID: 'parent-4', callID: 'call-fg-2a' } as never,
      {
        args: {
          background: false,
          subagent_type: 'oracle',
          description: 'foreground child',
        },
      } as never,
    );
    await hooks?.event?.({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'child-fg-2', parentID: 'parent-4', agent: 'oracle' },
        },
      },
    } as never);
    await hooks?.['chat.message']?.(
      { sessionID: 'child-fg-2', agent: 'oracle' } as never,
      {} as never,
    );
    await busy('child-fg-2');

    expect(readTuiSnapshot(projectDir).activeSessions['child-fg-2']).toBe(
      'oracle',
    );

    await hooks?.['tool.execute.after']?.(
      { tool: 'task', sessionID: 'parent-4', callID: 'call-fg-2b' } as never,
      {
        output: [
          'task_id: child-fg-2',
          'state: completed',
          '',
          '<task_result>',
          'Analysis finished.',
          '</task_result>',
        ].join('\n'),
      } as never,
    );

    // Unconfirmed attribution keeps the full runtime discipline: the
    // terminal text alone must not clear the active session yet.
    expect(readTuiSnapshot(projectDir).activeSessions['child-fg-2']).toBe(
      'oracle',
    );

    // Idle runtime evidence is what publishes the terminal state.
    await hooks?.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-fg-2', status: { type: 'idle' } },
      },
    } as never);
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const snapshot = readTuiSnapshot(projectDir);
    expect(snapshot.activeSessions['child-fg-2']).toBeUndefined();
    expect(snapshot.sessionDetails['child-fg-2']).toBeUndefined();
  });

  test('string status idle clears active sessions', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'fixer-str', agent: 'fixer' } as never,
      {} as never,
    );
    await busy('fixer-str');
    expect(readTuiSnapshot(projectDir).activeSessions['fixer-str']).toBe(
      'fixer',
    );

    await hooks?.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'fixer-str', status: 'idle' },
      },
    } as never);

    expect(
      readTuiSnapshot(projectDir).activeSessions['fixer-str'],
    ).toBeUndefined();
  });

  test('session.error clears active sessions', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'oracle-err', agent: 'oracle' } as never,
      {} as never,
    );
    await busy('oracle-err');
    expect(readTuiSnapshot(projectDir).activeSessions['oracle-err']).toBe(
      'oracle',
    );

    await hooks?.event?.({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'oracle-err',
          error: { message: 'Task failed' },
        },
      },
    } as never);

    expect(
      readTuiSnapshot(projectDir).activeSessions['oracle-err'],
    ).toBeUndefined();
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

  /** Admit two session-inheriting fixer tasks; the second must stay
   * queued behind the parent's single provider slot. */
  async function expectSecondTaskQueued(sessionID: string): Promise<void> {
    const before = hooks?.['tool.execute.before'];
    expect(before).toBeFunction();
    const first = before?.(
      { tool: 'task', sessionID, callID: 'call-1' } as never,
      {
        args: {
          background: true,
          subagent_type: 'fixer',
          description: 'first task',
        },
      } as never,
    );
    const second = before?.(
      { tool: 'task', sessionID, callID: 'call-2' } as never,
      {
        args: {
          background: true,
          subagent_type: 'fixer',
          description: 'second task',
        },
      } as never,
    );
    // Slot release happens via board terminal outcomes, out of scope here.
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
  }

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

    await expectSecondTaskQueued('orchestrator-1');
  });

  test('internal initiator chat.message does not overwrite the tracked session model', async () => {
    await hooks?.['chat.message']?.(
      {
        sessionID: 'plan-1',
        agent: 'plan',
        model: { providerID: 'openai', modelID: 'gpt-4o' },
      } as never,
      {} as never,
    );
    await hooks?.['chat.message']?.(
      {
        sessionID: 'plan-1',
        agent: 'orchestrator',
        model: { providerID: 'anthropic', modelID: 'claude' },
        parts: [createInternalAgentTextPart('child completed')],
      } as never,
      {} as never,
    );

    await expectSecondTaskQueued('plan-1');
  });

  test('message.updated of an internal admission does not overwrite the tracked model', async () => {
    const { __resetInternalAdmissionsForTesting } = await import(
      './v2/internal-admissions'
    );
    __resetInternalAdmissionsForTesting();

    await hooks?.['chat.message']?.(
      {
        sessionID: 'plan-1',
        agent: 'plan',
        model: { providerID: 'openai', modelID: 'gpt-4o' },
      } as never,
      {} as never,
    );
    await hooks?.['chat.message']?.(
      {
        sessionID: 'plan-1',
        agent: 'orchestrator',
        model: { providerID: 'anthropic', modelID: 'claude' },
        messageID: 'msg_internal',
        parts: [createInternalAgentTextPart('child completed')],
      } as never,
      {} as never,
    );
    await hooks?.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_internal',
            sessionID: 'plan-1',
            agent: 'orchestrator',
            providerID: 'anthropic',
            modelID: 'claude',
          },
        },
      },
    } as never);

    await expectSecondTaskQueued('plan-1');
    __resetInternalAdmissionsForTesting();
  });

  test('message.updated of an assistant reply to an internal admission does not overwrite the tracked model', async () => {
    const { __resetInternalAdmissionsForTesting } = await import(
      './v2/internal-admissions'
    );
    __resetInternalAdmissionsForTesting();

    await hooks?.['chat.message']?.(
      {
        sessionID: 'plan-1',
        agent: 'plan',
        model: { providerID: 'openai', modelID: 'gpt-4o' },
      } as never,
      {} as never,
    );
    await hooks?.['chat.message']?.(
      {
        sessionID: 'plan-1',
        agent: 'orchestrator',
        model: { providerID: 'anthropic', modelID: 'claude' },
        messageID: 'msg_internal',
        parts: [createInternalAgentTextPart('child completed')],
      } as never,
      {} as never,
    );
    await hooks?.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_assistant',
            parentID: 'msg_internal',
            sessionID: 'plan-1',
            agent: 'orchestrator',
            providerID: 'anthropic',
            modelID: 'claude',
          },
        },
      },
    } as never);

    await expectSecondTaskQueued('plan-1');
    __resetInternalAdmissionsForTesting();
  });

  test('v2 agent-discovery without parts does not overwrite tracked selection', async () => {
    const { recordInternalAdmission, __resetInternalAdmissionsForTesting } =
      await import('./v2/internal-admissions');
    __resetInternalAdmissionsForTesting();
    recordInternalAdmission('plan-1', 'msg_discovery');

    await hooks?.['chat.message']?.(
      {
        sessionID: 'plan-1',
        agent: 'plan',
        model: { providerID: 'openai', modelID: 'gpt-4o' },
      } as never,
      {} as never,
    );
    await hooks?.['chat.message']?.(
      {
        sessionID: 'plan-1',
        agent: 'orchestrator',
        model: { providerID: 'anthropic', modelID: 'claude' },
        messageID: 'msg_discovery',
      } as never,
      {} as never,
    );

    await expectSecondTaskQueued('plan-1');
    __resetInternalAdmissionsForTesting();
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
    client.session.status = async () => ({ data: {} });
    client.session.messages = async () => ({
      data: [
        {
          info: {
            role: 'assistant',
            time: { completed: Date.now() },
            finish: 'stop',
          },
          parts: [{ type: 'text', text: 'done' }],
        },
      ],
    });
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
          orchestrator: { model: 'preset/orchestrator' },
          fixer: { inheritModelFrom: 'session' },
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

  test('config() keeps compaction exception after host council prompt override', async () => {
    const hooks = await loadConfiguredPlugin({
      council: {
        presets: { default: { alpha: { model: 'test/councillor' } } },
      },
      agents: {
        council: { displayName: 'ArchitectureCouncil' },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        council: { prompt: 'Always include ## Council Response.' },
        ArchitectureCouncil: {
          prompt: 'Always include ## Council Summary.',
        },
      },
    };

    try {
      await hooks.config?.(hostConfig);
      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      for (const key of ['council', 'ArchitectureCouncil'] as const) {
        expect(agents[key]?.prompt).toContain(
          'if the host asks you to produce a session checkpoint or compaction summary in a specific template',
        );
      }
      expect(agents.council?.prompt).toContain(
        'Always include ## Council Response.',
      );
      expect(agents.ArchitectureCouncil?.prompt).toContain(
        'Always include ## Council Summary.',
      );
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

describe('system.transform orchestrator injection', () => {
  let originalEnv: typeof process.env;
  const configDirs: string[] = [];

  beforeEach(() => {
    originalEnv = { ...process.env };
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

  async function loadPluginWithOrchestratorSession(
    config: Record<string, unknown> = {},
  ) {
    const configDir = await mkdtemp('/tmp/oh-my-system-transform-');
    configDirs.push(configDir);
    await Bun.write(
      `${configDir}/oh-my-opencode-slim.json`,
      JSON.stringify(config),
    );
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: `${configDir}/data`,
      XDG_CACHE_HOME: `${configDir}/cache`,
      OPENCODE_LOG_DIR: `${configDir}/logs`,
    };
    const client = createPluginClient(async () => ({}));
    const hooks = await plugin({
      client,
      directory: configDir,
      worktree: configDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
    // Session tracked as orchestrator (how chat.message records it).
    await hooks['chat.message']?.(
      {
        sessionID: 'ses-orc',
        agent: 'orchestrator',
        model: { providerID: 'test', modelID: 'm' },
      } as never,
      {} as never,
    );
    return hooks;
  }

  const ENV_BLOCK = [
    'You are powered by the model named test/m.',
    '<env>',
    '  Working directory: /tmp',
    '</env>',
  ].join('\n');

  test('does not duplicate a custom orchestrator prompt already present', async () => {
    // Configure a REAL custom replacement without default-prompt markers:
    // the effective prompt is this string, and the dedup must key on it.
    const customPrompt = 'Mi prompt custom sin marcadores.';
    const hooks = await loadPluginWithOrchestratorSession({
      agents: { orchestrator: { prompt: customPrompt } },
    });
    try {
      const system = [`${ENV_BLOCK}\n\n${customPrompt}`];
      await hooks['experimental.chat.system.transform']?.(
        { sessionID: 'ses-orc' } as never,
        { system } as never,
      );
      // Exactly one copy of the effective prompt (split = parts + 1) and
      // no default-prompt content appended after it.
      expect(system[0]?.split(customPrompt).length).toBe(2);
      expect(system[0]).toBe(`${ENV_BLOCK}\n\n${customPrompt}`);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('skips auxiliary requests (title/compaction) in an orchestrator session', async () => {
    const hooks = await loadPluginWithOrchestratorSession();
    try {
      // Title/compaction requests carry their own short system and no
      // environment block.
      const system = [
        'You are a title generator. You output ONLY a thread title.',
      ];
      await hooks['experimental.chat.system.transform']?.(
        { sessionID: 'ses-orc' } as never,
        { system } as never,
      );
      expect(system[0]).not.toContain('<Role>');
      expect(system[0]).toBe(
        'You are a title generator. You output ONLY a thread title.',
      );
    } finally {
      await hooks.dispose?.();
    }
  });

  test('injects on a main chat request in an orchestrator session', async () => {
    const hooks = await loadPluginWithOrchestratorSession();
    try {
      const system = [ENV_BLOCK];
      await hooks['experimental.chat.system.transform']?.(
        { sessionID: 'ses-orc' } as never,
        { system } as never,
      );
      expect(system[0]).toContain('<Role>');
    } finally {
      await hooks.dispose?.();
    }
  });

  test('collapses the v2.0.5 identity part spliced at system[1] after the orchestrator prompt', async () => {
    // OpenCode v2.0.5 core splices a "# Your Model" identity part at
    // system[1] (packages/core/src/plugin/identity.ts). The transform
    // must keep appending the orchestrator prompt to system[0] and
    // collapse deterministically regardless.
    const hooks = await loadPluginWithOrchestratorSession();
    try {
      const system = [
        'You are an agent powered by OpenCode.\n<env>Working directory: /tmp</env>',
        '# Your Model\n- Name: GLM\n- Provider ID: zhipuai\n- Model ID: glm-5.3',
      ];
      await hooks['experimental.chat.system.transform']?.(
        { sessionID: 'ses-orc', agent: 'orchestrator' } as never,
        { system } as never,
      );
      expect(system).toHaveLength(1);
      expect(system[0]).toContain('# Your Model');
      const identityAt = (system[0] as string).indexOf('# Your Model');
      const orchestratorAt = (system[0] as string).indexOf('<Role>');
      expect(orchestratorAt).toBeGreaterThan(-1);
      expect(identityAt).toBeGreaterThan(orchestratorAt);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('request-scoped agent overrides session tracking', async () => {
    const hooks = await loadPluginWithOrchestratorSession();
    try {
      // v2 bridge forwards the request agent: an auxiliary request says
      // its real agent even though the session is tracked as orchestrator.
      const system = [ENV_BLOCK];
      await hooks['experimental.chat.system.transform']?.(
        { sessionID: 'ses-orc', agent: 'title' } as never,
        { system } as never,
      );
      expect(system[0]).not.toContain('<Role>');
    } finally {
      await hooks.dispose?.();
    }
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
