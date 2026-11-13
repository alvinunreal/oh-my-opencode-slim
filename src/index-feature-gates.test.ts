import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CompanionManager,
  companionSessionIdForDirectory,
  stateFilePath,
} from './companion/manager';
import * as autoUpdateFactories from './hooks/auto-update-checker';
import * as foregroundFallbackFactories from './hooks/foreground-fallback';
import * as handoffFactories from './hooks/task-session-manager/fallback-observation-transfer';
import { OhMyOpenCodeLite as plugin } from './index';
import * as interviewFactories from './interview';
import * as interviewSubmitStateFactories from './tools/interview-submit-state';
import * as nativeTaskControlFactories from './tools/native-task-control';
import { getTuiStatePath, readTuiSnapshot } from './tui-state';
import type { BackgroundJobRecord } from './utils/background-job-board';
import * as gateFactories from './utils/background-job-terminal-gate';
import { BackgroundTaskConcurrency } from './utils/background-task-concurrency';
import * as jsdom from './utils/jsdom';

type PluginHooks = Awaited<ReturnType<typeof plugin>>;

const noop = async () => ({ data: [] });

function createClient(onSessionGet?: (sessionID: string) => void) {
  const session = new Proxy(
    {
      get: async ({ path: requestPath }: { path: { id: string } }) => {
        onSessionGet?.(requestPath.id);
        return { data: { id: requestPath.id } };
      },
      messages: noop,
      status: async () => ({ data: {} }),
    },
    { get: (target, key) => Reflect.get(target, key) ?? noop },
  );
  return new Proxy(
    { session, app: { log: noop } },
    {
      get: (target, key) =>
        Reflect.get(target, key) ?? new Proxy({}, { get: () => noop }),
    },
  );
}

describe('plugin feature gates through exported hooks', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let projectDir: string;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    projectDir = await mkdtemp(
      path.join(os.tmpdir(), 'oh-my-opencode-slim-feature-gates-'),
    );
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: projectDir,
      XDG_CONFIG_HOME: projectDir,
      XDG_DATA_HOME: path.join(projectDir, 'data'),
      XDG_CACHE_HOME: path.join(projectDir, 'cache'),
      OPENCODE_LOG_DIR: path.join(projectDir, 'logs'),
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(projectDir, { recursive: true, force: true });
  });

  const configure = async (overrides: Record<string, unknown>) => {
    await Bun.write(
      path.join(projectDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        companion: { enabled: false },
        webfetch: { enabled: false },
        disabled_hooks: ['auto-update-checker'],
        ...overrides,
      }),
    );
  };

  const createHooks = (hostFlavor?: 'v1' | 'v2', client = createClient()) =>
    plugin({
      client,
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
      ...(hostFlavor ? { hostFlavor } : {}),
    } as never);

  for (const [label, options, enabled] of [
    ['enabled', { webfetch: { enabled: true } }, true],
    ['feature disabled', { webfetch: { enabled: false } }, false],
    [
      'tool disabled',
      { webfetch: { enabled: true }, disabled_tools: ['webfetch'] },
      false,
    ],
    [
      'both disabled',
      { webfetch: { enabled: false }, disabled_tools: ['webfetch'] },
      false,
    ],
  ] as const) {
    test(`webfetch ${label}: registration and JSDOM probe agree`, async () => {
      await configure({ backgroundJobs: { mode: 'off' }, ...options });
      const probe = spyOn(jsdom, 'probeJSDOM').mockResolvedValue(null);
      let hooks: PluginHooks | undefined;
      try {
        hooks = await createHooks();
        expect(Boolean(hooks.tool?.webfetch)).toBe(enabled);
        expect(probe).toHaveBeenCalledTimes(enabled ? 1 : 0);
      } finally {
        await hooks?.dispose?.();
        probe.mockRestore();
      }
    });
  }

  for (const flavor of ['v1', 'v2'] as const) {
    test(`${flavor}: disabling managed jobs preserves headers and real retry steering`, async () => {
      await configure({
        backgroundJobs: { mode: 'off' },
        fallback: { enabled: true, maxRetries: 0 },
        agents: {
          orchestrator: { model: ['openai/gpt-b', 'openai/gpt-c'] },
        },
      });
      const retrySpy = spyOn(
        foregroundFallbackFactories.ForegroundFallbackManager.prototype,
        'handleV2Retry',
      );
      const handoffSpy = spyOn(
        handoffFactories,
        'createBackgroundFallbackHandoff',
      );
      let hooks: PluginHooks | undefined;
      try {
        hooks = await createHooks(flavor);
        for (const name of [
          'task_status',
          'task_reply',
          'task_cancel',
          'task_revive',
          'wait_for_user',
        ]) {
          expect(hooks.tool?.[name]).toBeUndefined();
        }
        expect(hooks['v2.backgroundGeneration']).toBeUndefined();
        expect(hooks['chat.headers']).toBeFunction();
        expect(handoffSpy).not.toHaveBeenCalled();

        const switchModel = mock(async () => ({}));
        const retry = {
          sessionID: `ses_${flavor}_retry`,
          agent: 'orchestrator',
          model: { providerID: 'openai', id: 'gpt-b' },
          error: { message: 'Rate limit exceeded' },
          decision: { retry: true, delay: 2_000 },
        };
        await hooks['v2.session.retry']?.(retry as never, switchModel as never);
        expect(retrySpy).toHaveBeenCalledTimes(1);
        expect(switchModel).toHaveBeenCalledWith(retry.sessionID, {
          providerID: 'openai',
          id: 'gpt-c',
        });
        expect(retry.decision).toEqual({ retry: true, delay: 500 });
        expect(handoffSpy).not.toHaveBeenCalled();
      } finally {
        await hooks?.dispose?.();
        handoffSpy.mockRestore();
        retrySpy.mockRestore();
      }
    });
  }

  for (const flavor of ['v1', 'v2'] as const) {
    test(`${flavor}: native mode registers exactly the two host-read controls`, async () => {
      await configure({ backgroundJobs: { mode: 'native' } });
      let hooks: PluginHooks | undefined;
      try {
        hooks = await createHooks(flavor);
        expect(hooks.tool?.task_status).toBeDefined();
        expect(hooks.tool?.task_cancel).toBeDefined();
        for (const name of [
          'task_reply',
          'task_revive',
          'task_message',
          'wait_for_user',
        ]) {
          expect(hooks.tool?.[name]).toBeUndefined();
        }
        expect(hooks['v2.backgroundGeneration']).toBeUndefined();
      } finally {
        await hooks?.dispose?.();
      }
    });

    test(`${flavor}: native mode returns nothing when both host-read controls are disabled`, async () => {
      // Startup-only case: keep unrelated optional subsystems cold so the
      // assertion is about the native-control gate, not init cost.
      await configure({
        backgroundJobs: { mode: 'native' },
        disabled_tools: ['task_cancel', 'task_status'],
        webfetch: { enabled: false },
        marketplace: { enabled: false },
        disabled_hooks: ['auto-update-checker', 'foreground-fallback'],
        disabled_commands: ['deepwork', 'reflect'],
      });
      const nativeControlSpy = spyOn(
        nativeTaskControlFactories,
        'createNativeTaskControlTools',
      );
      let hooks: PluginHooks | undefined;
      try {
        hooks = await createHooks(flavor);
        expect(nativeControlSpy).not.toHaveBeenCalled();
        expect(hooks.tool?.task_cancel).toBeUndefined();
        expect(hooks.tool?.task_status).toBeUndefined();
      } finally {
        await hooks?.dispose?.();
        nativeControlSpy.mockRestore();
      }
    });

    test(`${flavor}: mode off registers no task control tool`, async () => {
      await configure({ backgroundJobs: { mode: 'off' } });
      let hooks: PluginHooks | undefined;
      try {
        hooks = await createHooks(flavor);
        for (const name of [
          'task_status',
          'task_cancel',
          'task_reply',
          'task_revive',
          'task_message',
          'wait_for_user',
        ]) {
          expect(hooks.tool?.[name]).toBeUndefined();
        }
        expect(hooks['v2.backgroundGeneration']).toBeUndefined();
      } finally {
        await hooks?.dispose?.();
      }
    });
  }

  test('foreground-fallback disabled hook does not dispatch retry steering', async () => {
    await configure({
      backgroundJobs: { mode: 'off' },
      disabled_hooks: ['auto-update-checker', 'foreground-fallback'],
      fallback: { enabled: true, maxRetries: 0 },
      agents: {
        orchestrator: { model: ['openai/gpt-b', 'openai/gpt-c'] },
      },
    });
    const retrySpy = spyOn(
      foregroundFallbackFactories.ForegroundFallbackManager.prototype,
      'handleV2Retry',
    );
    let hooks: PluginHooks | undefined;
    try {
      hooks = await createHooks('v2');
      const switchModel = mock(async () => ({}));
      const retry = {
        sessionID: 'ses_disabled_retry',
        agent: 'orchestrator',
        model: { providerID: 'openai', id: 'gpt-b' },
        error: { message: 'Rate limit exceeded' },
        decision: { retry: true, delay: 2_000 },
      };
      // The host still dispatches the retry hook, but the disabled hook
      // means no manager is constructed: the interface outcome must be a
      // no-op switch and an untouched host decision.
      await hooks['v2.session.retry']?.(retry as never, switchModel as never);
      expect(retrySpy).toHaveBeenCalledTimes(0);
      expect(switchModel).not.toHaveBeenCalled();
      expect(retry.decision).toEqual({ retry: true, delay: 2_000 });
    } finally {
      await hooks?.dispose?.();
      retrySpy.mockRestore();
    }
  });

  test('v2 fallback disabled at startup can still be enabled live', async () => {
    await configure({
      backgroundJobs: { mode: 'off' },
      fallback: { enabled: false, maxRetries: 0 },
      agents: {
        orchestrator: { model: ['openai/gpt-b', 'openai/gpt-c'] },
      },
    });
    let hooks: PluginHooks | undefined;
    try {
      hooks = await createHooks('v2');
      const sessionID = 'ses_live_enabled_retry';
      // A live config refresh pins the refreshed bundle with fallback on.
      hooks['v2.pinSessionChains']?.(
        sessionID,
        { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
        true,
      );
      const switchModel = mock(async () => ({}));
      const retry = {
        sessionID,
        agent: 'orchestrator',
        model: { providerID: 'openai', id: 'gpt-b' },
        error: { message: 'Rate limit exceeded' },
        decision: { retry: true, delay: 2_000 },
      };
      await hooks['v2.session.retry']?.(retry as never, switchModel as never);
      expect(switchModel).toHaveBeenCalledWith(sessionID, {
        providerID: 'openai',
        id: 'gpt-c',
      });
    } finally {
      await hooks?.dispose?.();
    }
  });

  test('v2 fallback remains retry-capable with watcher off for explicit preset bindings', async () => {
    await configure({
      backgroundJobs: { mode: 'off' },
      fallback: { enabled: false, maxRetries: 0 },
      liveConfigRefresh: false,
      agents: {
        orchestrator: { model: ['openai/gpt-b', 'openai/gpt-c'] },
      },
    });
    let hooks: PluginHooks | undefined;
    try {
      hooks = await createHooks('v2');
      // An explicit /preset (or a persisted child binding) can turn fallback on
      // without the file watcher; the retry hook must stay registered.
      hooks['v2.pinSessionChains']?.(
        'ses_explicit_fallback',
        { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
        true,
      );
      const switchModel = mock(async () => ({}));
      const retry = {
        sessionID: 'ses_explicit_fallback',
        agent: 'orchestrator',
        model: { providerID: 'openai', id: 'gpt-b' },
        error: { message: 'Rate limit exceeded' },
        decision: { retry: true, delay: 2_000 },
      };
      await hooks['v2.session.retry']?.(retry as never, switchModel as never);
      expect(switchModel).toHaveBeenCalledWith('ses_explicit_fallback', {
        providerID: 'openai',
        id: 'gpt-c',
      });
    } finally {
      await hooks?.dispose?.();
    }
  });

  test('v1 interview disabled keeps request transforms inert', async () => {
    await configure({
      backgroundJobs: { mode: 'off' },
      interview: { enabled: false },
      disabled_hooks: [
        'auto-update-checker',
        'phase-reminder',
        'council-inject',
        'deepwork-goal',
      ],
    });
    let hooks: PluginHooks | undefined;
    try {
      hooks = await createHooks('v1');
      const messages = [
        {
          info: { id: 'msg_1', role: 'user', sessionID: 'ses_interview_off' },
          parts: [{ type: 'text', text: 'hello' }],
        },
      ];
      await expect(
        hooks['experimental.chat.messages.transform']?.(
          {} as never,
          { messages } as never,
        ),
      ).resolves.toBeUndefined();

      const completed = { text: 'hello' };
      await hooks['experimental.text.complete']?.(
        { sessionID: 'ses_interview_off', messageID: 'msg_1' } as never,
        completed as never,
      );
      expect(completed.text).toBe('hello');
    } finally {
      await hooks?.dispose?.();
    }
  });

  test('disabled interview_submit_state skips its tool registration', async () => {
    // Feature stays enabled (interview on, command available); only the tool
    // is switched off, so this exercises the tool-level guard. Unrelated
    // subsystems stay cold for a startup-only assertion. The factory spy
    // pins the outcome to construction, not just registration.
    const submitStateSpy = spyOn(
      interviewSubmitStateFactories,
      'createInterviewSubmitStateTool',
    );
    await configure({
      backgroundJobs: { mode: 'off' },
      interview: { enabled: true },
      disabled_tools: ['interview_submit_state'],
      webfetch: { enabled: false },
      marketplace: { enabled: false },
      disabled_hooks: ['auto-update-checker', 'foreground-fallback'],
      disabled_commands: ['deepwork', 'reflect'],
    });
    let hooks: PluginHooks | undefined;
    try {
      hooks = await createHooks('v2');
      expect(submitStateSpy).not.toHaveBeenCalled();
      expect(hooks.tool?.interview_submit_state).toBeUndefined();
    } finally {
      await hooks?.dispose?.();
      submitStateSpy.mockRestore();
    }
  });

  test('v2 uses the bridge service without constructing a v1 interview owner', async () => {
    await configure({ backgroundJobs: { mode: 'off' } });
    const managerSpy = spyOn(interviewFactories, 'createInterviewManager');
    const submitState = mock(async () => ({ ok: true, message: 'accepted' }));
    const service = {
      getActiveInterviewId: () => 'interview_1',
      submitState,
    };
    let hooks: PluginHooks | undefined;
    try {
      hooks = await createHooks('v2');
      expect(managerSpy).not.toHaveBeenCalled();
      expect(hooks.tool?.interview_submit_state).toBeDefined();
      hooks['v2.setInterviewService']?.(service as never);
      const result = await hooks.tool?.interview_submit_state.execute(
        { state: { summary: 'Specification', questions: [] } } as never,
        { sessionID: 'ses_interview', messageID: 'msg_1' } as never,
      );
      expect(result).toBe('accepted');
      expect(submitState).toHaveBeenCalledTimes(1);
    } finally {
      await hooks?.dispose?.();
      managerSpy.mockRestore();
    }
  });

  test('v1 still constructs exactly one enabled interview owner', async () => {
    await configure({ backgroundJobs: { mode: 'off' } });
    const managerSpy = spyOn(interviewFactories, 'createInterviewManager');
    let hooks: PluginHooks | undefined;
    try {
      hooks = await createHooks('v1');
      expect(managerSpy).toHaveBeenCalledTimes(1);
    } finally {
      await hooks?.dispose?.();
      managerSpy.mockRestore();
    }
  });

  test('companion cold gate: disabled companion is not constructed', async () => {
    await configure({});
    const onLoadSpy = spyOn(CompanionManager.prototype, 'onLoad');
    let hooks: PluginHooks | undefined;
    try {
      hooks = await createHooks('v2');
      // companion.enabled defaults to false in this suite's config: no
      // manager is constructed, so no onLoad (and its state-file cleanup
      // I/O) ever runs and no state file is created.
      expect(onLoadSpy).not.toHaveBeenCalled();
      expect(existsSync(stateFilePath())).toBe(false);
    } finally {
      await hooks?.dispose?.();
      onLoadSpy.mockRestore();
    }
  });

  test('companion cold gate: disabled companion still prunes its stale session', async () => {
    await configure({});
    const ownID = companionSessionIdForDirectory(projectDir);
    const file = stateFilePath();
    await Bun.write(
      file,
      JSON.stringify({
        version: 1,
        sessions: [
          { session_id: ownID, pid: process.pid },
          { session_id: 'other-session', pid: process.pid },
        ],
      }),
    );
    let hooks: PluginHooks | undefined;
    try {
      hooks = await createHooks('v2');
      const state = JSON.parse(readFileSync(file, 'utf8')) as {
        sessions: Array<{ session_id: string }>;
      };
      expect(state.sessions.map((s) => s.session_id)).toEqual([
        'other-session',
      ]);
    } finally {
      await hooks?.dispose?.();
    }
  });

  test('companion cold gate: enabled companion loads and cleans up', async () => {
    await configure({
      companion: {
        enabled: true,
        // Missing binary: registration and state writes run, but the
        // updater and spawn path touch neither network nor a child.
        binaryPath: `${projectDir}/missing-companion-bin`,
      },
    });
    const onLoadSpy = spyOn(CompanionManager.prototype, 'onLoad');
    let hooks: PluginHooks | undefined;
    try {
      hooks = await createHooks('v2');
      expect(onLoadSpy).toHaveBeenCalledTimes(1);
      expect(existsSync(stateFilePath())).toBe(true);
    } finally {
      await hooks?.dispose?.();
      onLoadSpy.mockRestore();
    }
  });

  test('auto-update checker is cold-gated by the disabled hook in every lifecycle mode', async () => {
    const checkerEvent = mock(() => undefined);
    const factorySpy = spyOn(
      autoUpdateFactories,
      'createAutoUpdateCheckerHook',
    ).mockImplementation(() => ({ event: checkerEvent }));
    try {
      for (const mode of ['managed', 'native', 'off'] as const) {
        await configure({
          backgroundJobs: { mode },
          disabled_hooks: ['auto-update-checker'],
        });
        const hooks = await createHooks();
        try {
          await hooks.event?.({
            event: {
              type: 'session.created',
              properties: { info: { id: 'ses_p' } },
            },
          } as never);
          expect(factorySpy).not.toHaveBeenCalled();
          expect(checkerEvent).not.toHaveBeenCalled();
        } finally {
          await hooks.dispose?.();
        }
      }

      await configure({
        backgroundJobs: { mode: 'managed' },
        disabled_hooks: [],
      });
      const hooks = await createHooks();
      try {
        expect(factorySpy).toHaveBeenCalledTimes(1);
        await hooks.event?.({
          event: {
            type: 'session.created',
            properties: { info: { id: 'ses_control' } },
          },
        } as never);
        expect(checkerEvent).toHaveBeenCalledTimes(1);
      } finally {
        await hooks.dispose?.();
      }
    } finally {
      factorySpy.mockRestore();
    }
  });

  test('autoUpdate false alone keeps the server hook unconstructed', async () => {
    const checkerEvent = mock(() => undefined);
    const factorySpy = spyOn(
      autoUpdateFactories,
      'createAutoUpdateCheckerHook',
    ).mockImplementation(() => ({ event: checkerEvent }));
    let hooks: PluginHooks | undefined;
    try {
      await configure({
        backgroundJobs: { mode: 'managed' },
        disabled_hooks: [],
        autoUpdate: false,
      });
      hooks = await createHooks();
      try {
        await hooks.event?.({
          event: {
            type: 'session.created',
            properties: { info: { id: 'ses_autoupdate_off' } },
          },
        } as never);
        // `autoUpdate: false` is the whole switch here: the disabled_hooks
        // mask is empty, yet the hook factory must never be constructed.
        expect(factorySpy).not.toHaveBeenCalled();
        expect(checkerEvent).not.toHaveBeenCalled();
      } finally {
        await hooks.dispose?.();
        hooks = undefined;
      }

      await configure({
        backgroundJobs: { mode: 'managed' },
        disabled_hooks: [],
        autoUpdate: true,
      });
      hooks = await createHooks();
      try {
        expect(factorySpy).toHaveBeenCalledTimes(1);
        await hooks.event?.({
          event: {
            type: 'session.created',
            properties: { info: { id: 'ses_autoupdate_on' } },
          },
        } as never);
        expect(checkerEvent).toHaveBeenCalledTimes(1);
      } finally {
        await hooks.dispose?.();
        hooks = undefined;
      }
    } finally {
      factorySpy.mockRestore();
    }
  });

  for (const flavor of ['v1', 'v2'] as const) {
    test(`${flavor}: no post-tool consumers means no v1 after hook`, async () => {
      await configure({
        backgroundJobs: { mode: 'off' },
        disabled_hooks: [
          'auto-update-checker',
          'json-error-recovery',
          'tool-loop-guard',
        ],
      });
      const hooks = await createHooks(flavor);
      try {
        expect(hooks['tool.execute.after']).toBeUndefined();
      } finally {
        await hooks.dispose?.();
      }
    });
  }

  for (const mode of ['managed', 'native', 'off'] as const) {
    test(`v2 ${mode}: native updates replace the unused server checker`, async () => {
      await configure({ backgroundJobs: { mode }, disabled_hooks: [] });
      const factory = spyOn(autoUpdateFactories, 'createAutoUpdateCheckerHook');
      let hooks: PluginHooks | undefined;
      try {
        hooks = await createHooks('v2');
        await hooks.event?.({
          event: {
            type: 'session.created',
            properties: { info: { id: 'ses_native_update' } },
          },
        } as never);
        expect(factory).not.toHaveBeenCalled();
      } finally {
        await hooks?.dispose?.();
        factory.mockRestore();
      }
    });
  }

  async function exerciseSidebar(hooks: PluginHooks, externalDir: string) {
    const call = { tool: 'task', sessionID: 'ses_p', callID: 'call_1' };
    await hooks['tool.execute.before']?.(
      call as never,
      {
        args: {
          subagent_type: 'explorer',
          background: true,
          description: 'sidebar launch',
        },
      } as never,
    );
    await hooks['tool.execute.after']?.(
      call as never,
      {
        output: 'task_id: ses_child\nstate: running',
      } as never,
    );
    await hooks.event?.({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'ses_child', parentID: 'ses_p', directory: externalDir },
        },
      },
    } as never);
    await hooks.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_child',
            sessionID: 'ses_child',
            agent: 'explorer',
            providerID: 'openai',
            modelID: 'gpt-b',
          },
        },
      },
    } as never);
    await hooks['chat.message']?.(
      {
        sessionID: 'ses_child',
        agent: 'explorer',
        model: { providerID: 'openai', modelID: 'gpt-c', variant: 'high' },
      } as never,
      {} as never,
    );
  }

  for (const sidebar of [false, true]) {
    test(`sidebar ${sidebar} controls all state writes with managed jobs on`, async () => {
      const externalDir = await mkdtemp(path.join(projectDir, 'external-'));
      await configure({
        sidebar,
        backgroundJobs: {
          mode: 'managed',
          wallClockTimeoutMs: 0,
          orchestratorWake: { enabled: false },
        },
      });
      const hooks = await createHooks();
      try {
        await exerciseSidebar(hooks, externalDir);
      } finally {
        await hooks.dispose?.();
      }
      const statePath = getTuiStatePath(projectDir);
      const externalPath = getTuiStatePath(externalDir);
      if (sidebar) {
        expect(existsSync(statePath)).toBe(true);
        expect(existsSync(externalPath)).toBe(true);
        expect(
          readTuiSnapshot(externalDir).sessionModels?.ses_child?.explorer,
        ).toEqual({ model: 'openai/gpt-c', variant: 'high' });
      } else {
        for (const state of [statePath, externalPath]) {
          expect(existsSync(state)).toBe(false);
          expect(existsSync(`${state}.lock`)).toBe(false);
        }
      }
    });
  }

  test('tui false overrides sidebar true: no server state writes or parent hydration', async () => {
    const externalDir = await mkdtemp(path.join(projectDir, 'external-'));
    await configure({
      tui: false,
      sidebar: true,
      // Keep the managed lifecycle out of this observation: its terminal gate
      // legitimately reads the child through the same client API. With the
      // lifecycle off, any session.get here can only come from TUI hydration.
      backgroundJobs: { mode: 'off' },
    });
    const sessionReads: string[] = [];
    let hooks: PluginHooks | undefined;
    try {
      hooks = await createHooks(
        undefined,
        createClient((sessionID) => sessionReads.push(sessionID)),
      );
      await exerciseSidebar(hooks, externalDir);

      // Parent hydration only runs from an active TUI agent. The child has
      // an agent from exerciseSidebar, so a busy status would hydrate the
      // parent link if the sidebar gate were open.
      sessionReads.length = 0;
      await hooks.event?.({
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'ses_child',
            status: { type: 'busy' },
          },
        },
      } as never);
      await Promise.resolve();
      expect(sessionReads).toEqual([]);

      // Startup/config refresh and explicit profile refresh write paths.
      await hooks.config?.({});
      await expect(
        hooks['v2.refreshProfiles']?.({ allowInvalidFallback: true }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await hooks?.dispose?.();
    }

    for (const directory of [projectDir, externalDir]) {
      const statePath = getTuiStatePath(directory);
      expect(existsSync(statePath)).toBe(false);
      expect(existsSync(`${statePath}.lock`)).toBe(false);
    }
  });

  test('terminal live foreground recovery never restores background admission', async () => {
    await configure({
      backgroundJobs: { mode: 'managed', wallClockTimeoutMs: 0 },
    });
    let onRunning: ((record: BackgroundJobRecord) => void) | undefined;
    const originalGate = gateFactories.createBackgroundJobTerminalGate;
    const gateSpy = spyOn(
      gateFactories,
      'createBackgroundJobTerminalGate',
    ).mockImplementation((options) => {
      onRunning = options.onRunning;
      return originalGate(options);
    });
    const restoreSpy = spyOn(
      BackgroundTaskConcurrency.prototype,
      'restoreTask',
    );
    let hooks: PluginHooks | undefined;
    try {
      hooks = await createHooks('v2');
      expect(onRunning).toBeFunction();
      const common = {
        parentSessionID: 'ses_p',
        agent: 'explorer',
        generation: 1,
        state: 'running',
      };
      onRunning?.({
        ...common,
        taskID: 'ses_fg',
        background: false,
      } as BackgroundJobRecord);
      expect(restoreSpy).not.toHaveBeenCalled();
      onRunning?.({
        ...common,
        taskID: 'ses_bg',
        background: true,
      } as BackgroundJobRecord);
      expect(restoreSpy).toHaveBeenCalledTimes(1);
      expect(restoreSpy).toHaveBeenCalledWith('ses_bg', undefined);
    } finally {
      await hooks?.dispose?.();
      restoreSpy.mockRestore();
      gateSpy.mockRestore();
    }
  });
});
