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
import * as hookFactories from './hooks';
import * as handoffFactories from './hooks/task-session-manager/fallback-observation-transfer';
import { OhMyOpenCodeLite as plugin } from './index';
import * as interviewFactories from './interview';
import { getTuiStatePath, readTuiSnapshot } from './tui-state';
import type { BackgroundJobRecord } from './utils/background-job-board';
import * as gateFactories from './utils/background-job-terminal-gate';
import { BackgroundTaskConcurrency } from './utils/background-task-concurrency';

type PluginHooks = Awaited<ReturnType<typeof plugin>>;

const noop = async () => ({ data: [] });

function createClient() {
  const session = new Proxy(
    {
      get: async ({ path: requestPath }: { path: { id: string } }) => ({
        data: { id: requestPath.id },
      }),
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
        disabled_hooks: ['auto-update-checker'],
        ...overrides,
      }),
    );
  };

  const createHooks = (hostFlavor?: 'v1' | 'v2') =>
    plugin({
      client: createClient(),
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
      ...(hostFlavor ? { hostFlavor } : {}),
    } as never);

  for (const flavor of ['v1', 'v2'] as const) {
    test(`${flavor}: disabling managed jobs preserves headers and real retry steering`, async () => {
      await configure({
        backgroundJobs: { enabled: false },
        fallback: { enabled: true, maxRetries: 0 },
        agents: {
          orchestrator: { model: ['openai/gpt-b', 'openai/gpt-c'] },
        },
      });
      const retrySpy = spyOn(
        hookFactories.ForegroundFallbackManager.prototype,
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
      } finally {
        await hooks?.dispose?.();
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
      } finally {
        await hooks?.dispose?.();
      }
    });
  }

  test('foreground-fallback disabled hook does not dispatch retry steering', async () => {
    await configure({
      backgroundJobs: { enabled: false },
      disabled_hooks: ['auto-update-checker', 'foreground-fallback'],
      fallback: { enabled: true, maxRetries: 0 },
      agents: {
        orchestrator: { model: ['openai/gpt-b', 'openai/gpt-c'] },
      },
    });
    const retrySpy = spyOn(
      hookFactories.ForegroundFallbackManager.prototype,
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
      backgroundJobs: { enabled: false },
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

  test('v1 interview disabled keeps request transforms inert', async () => {
    await configure({
      backgroundJobs: { enabled: false },
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

  test('v2 uses the bridge service without constructing a v1 interview owner', async () => {
    await configure({ backgroundJobs: { enabled: false } });
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
    await configure({ backgroundJobs: { enabled: false } });
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

  test('auto-update checker is cold-gated with lifecycle on and off', async () => {
    const checkerEvent = mock(() => undefined);
    const factorySpy = spyOn(
      hookFactories,
      'createAutoUpdateCheckerHook',
    ).mockImplementation(() => ({ event: checkerEvent }));
    try {
      for (const enabled of [true, false]) {
        await configure({
          backgroundJobs: { enabled },
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
        backgroundJobs: { enabled: false },
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
          enabled: true,
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
        expect(readTuiSnapshot(externalDir).agentModels.explorer).toBe(
          'openai/gpt-c',
        );
        expect(readTuiSnapshot(externalDir).agentVariants.explorer).toBe(
          'high',
        );
      } else {
        for (const state of [statePath, externalPath]) {
          expect(existsSync(state)).toBe(false);
          expect(existsSync(`${state}.lock`)).toBe(false);
        }
      }
    });
  }

  test('terminal live foreground recovery never restores background admission', async () => {
    await configure({
      backgroundJobs: { enabled: true, wallClockTimeoutMs: 0 },
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
