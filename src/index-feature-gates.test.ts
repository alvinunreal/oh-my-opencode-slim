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
import { withTuiAttachment } from './companion/attachment-test-helper';
import {
  CompanionManager,
  companionSessionIdForDirectory,
  stateFilePath,
} from './companion/manager';
import * as foregroundFallbackFactories from './hooks/foreground-fallback';
import { OhMyOpenCodeLite as plugin } from './index';
import * as interviewFactories from './interview';
import * as interviewSubmitStateFactories from './tools/interview-submit-state';
import * as nativeTaskControlFactories from './tools/native-task-control';
import * as taskReportFactories from './tools/task-report';
import { getTuiStatePath } from './tui-state';
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

  for (const flavor of ['v2'] as const) {
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
      } finally {
        await hooks?.dispose?.();
        retrySpy.mockRestore();
      }
    });
  }

  test('v2 native disabled task_reply and task_report skip their own factories', async () => {
    await configure({
      backgroundJobs: { mode: 'native' },
      disabled_tools: ['task_reply', 'task_report', 'webfetch'],
      marketplace: { enabled: false },
      disabled_hooks: ['auto-update-checker', 'foreground-fallback'],
      disabled_commands: ['deepwork', 'reflect'],
    });
    const nativeControl = spyOn(
      nativeTaskControlFactories,
      'createNativeTaskControlTools',
    );
    const report = spyOn(taskReportFactories, 'createTaskReportTool');
    let hooks: PluginHooks | undefined;
    try {
      hooks = await createHooks('v2');
      // The shared native factory remains necessary for status/cancel; the
      // disabled permission reply is filtered from its returned tools.
      expect(nativeControl).toHaveBeenCalledTimes(1);
      expect(report).not.toHaveBeenCalled();
      expect(hooks.tool?.task_cancel).toBeDefined();
      expect(hooks.tool?.task_status).toBeDefined();
      expect(hooks.tool?.task_reply).toBeUndefined();
      expect(hooks.tool?.task_report).toBeUndefined();
    } finally {
      await hooks?.dispose?.();
      nativeControl.mockRestore();
      report.mockRestore();
    }
  });

  test('v2 native injects no background default and ignores sameProviderPolicy', async () => {
    await configure({
      backgroundJobs: {
        mode: 'native',
        sameProviderPolicy: { 'lm-nexus': 'foreground' },
      },
    });
    let hooks: PluginHooks | undefined;
    try {
      hooks = await createHooks('v2');
      await hooks['chat.message']?.(
        {
          sessionID: 'ses_policy',
          agent: 'orchestrator',
          model: { providerID: 'lm-nexus', modelID: 'parent-model' },
        } as never,
        {} as never,
      );
      const call = {
        tool: 'task',
        sessionID: 'ses_policy',
        callID: 'call_policy',
      };
      // Omitted background stays omitted: the host owns the default.
      const omitted: Record<string, unknown> = {
        subagent_type: 'oracle',
        description: 'policy',
        prompt: 'work',
      };
      await hooks['tool.execute.before']?.(
        call as never,
        { args: omitted } as never,
      );
      expect('background' in omitted).toBe(false);

      // Explicit values pass through untouched in both lanes.
      const explicitTrue: Record<string, unknown> = {
        subagent_type: 'oracle',
        description: 'policy',
        prompt: 'work',
        background: true,
      };
      await hooks['tool.execute.before']?.(
        { ...call, callID: 'call_true' } as never,
        { args: explicitTrue } as never,
      );
      expect(explicitTrue.background).toBe(true);

      const explicitFalse: Record<string, unknown> = {
        subagent_type: 'oracle',
        description: 'policy',
        prompt: 'work',
        background: false,
      };
      await hooks['tool.execute.before']?.(
        { ...call, callID: 'call_false' } as never,
        { args: explicitFalse } as never,
      );
      expect(explicitFalse.background).toBe(false);
    } finally {
      await hooks?.dispose?.();
    }
  });

  for (const flavor of ['v2'] as const) {
    test(`${flavor}: native mode registers the host-supported task tools`, async () => {
      await configure({ backgroundJobs: { mode: 'native' } });
      let hooks: PluginHooks | undefined;
      try {
        hooks = await createHooks(flavor);
        expect(hooks.tool?.task_status).toBeDefined();
        expect(hooks.tool?.task_cancel).toBeDefined();
        if (flavor === 'v2') {
          expect(hooks.tool?.task_reply).toBeDefined();
          expect(hooks.tool?.task_report).toBeDefined();
        } else {
          expect(hooks.tool?.task_reply).toBeUndefined();
          expect(hooks.tool?.task_report).toBeUndefined();
        }
        for (const name of ['task_revive', 'task_message', 'wait_for_user']) {
          expect(hooks.tool?.[name]).toBeUndefined();
        }
      } finally {
        await hooks?.dispose?.();
      }
    });

    test(`${flavor}: native mode returns no tool whose registered native controls are disabled`, async () => {
      await configure({
        backgroundJobs: { mode: 'native' },
        disabled_tools: [
          'task_cancel',
          'task_status',
          ...(flavor === 'v2' ? ['task_reply', 'task_report'] : []),
        ],
        webfetch: { enabled: false },
        marketplace: { enabled: false },
        disabled_hooks: ['auto-update-checker', 'foreground-fallback'],
        disabled_commands: ['deepwork', 'reflect'],
      });
      const nativeControlSpy = spyOn(
        nativeTaskControlFactories,
        'createNativeTaskControlTools',
      );
      const reportSpy = spyOn(taskReportFactories, 'createTaskReportTool');
      let hooks: PluginHooks | undefined;
      try {
        hooks = await createHooks(flavor);
        expect(nativeControlSpy).not.toHaveBeenCalled();
        expect(reportSpy).not.toHaveBeenCalled();
        for (const name of [
          'task_cancel',
          'task_status',
          'task_reply',
          'task_report',
        ]) {
          expect(hooks.tool?.[name]).toBeUndefined();
        }
      } finally {
        await hooks?.dispose?.();
        nativeControlSpy.mockRestore();
        reportSpy.mockRestore();
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
          'task_report',
          'task_revive',
          'task_message',
          'wait_for_user',
        ]) {
          expect(hooks.tool?.[name]).toBeUndefined();
        }
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
    await withTuiAttachment(projectDir, async () => {
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
  });

  for (const flavor of ['v2'] as const) {
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

  for (const _sidebar of [false, true]) {
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
});
