import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OhMyOpenCodeLite as plugin } from '../index';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createBackgroundJobTerminalGate } from '../utils/background-job-terminal-gate';
import { createTaskResultTool } from './task-result';

const PARENT = 'ses_parent';
const CHILD = 'ses_child';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface LoadPluginOptions {
  hostFlavor?: string;
  config?: Record<string, unknown>;
  agent?: string;
}

async function loadPlugin(
  session: Record<string, unknown>,
  options: LoadPluginOptions = {},
) {
  const projectDir = await mkdtemp(join(tmpdir(), 'omo-lifecycle-fence-'));
  const previous = { ...process.env };
  process.env = {
    ...previous,
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
      ...(options.config ?? {}),
    }),
  );
  const hooks = await plugin({
    client: { app: { log: async () => ({}) }, session },
    directory: projectDir,
    worktree: projectDir,
    serverUrl: new URL('http://127.0.0.1:4098'),
    ...(options.hostFlavor ? { hostFlavor: options.hostFlavor } : {}),
  } as never);
  await hooks['chat.message']?.(
    { sessionID: PARENT, agent: options.agent ?? 'orchestrator' } as never,
    {} as never,
  );
  return {
    hooks,
    async cleanup() {
      process.env = previous;
      await rm(projectDir, { recursive: true, force: true });
    },
    dispose() {
      return hooks.event?.({
        event: {
          type: 'server.instance.disposed',
          properties: { directory: projectDir },
        },
      } as never);
    },
  };
}

test('dispose during the message model read sends no prompt', async () => {
  const seen = deferred<void>();
  const read = deferred<{ data: unknown[] }>();
  const prompts: unknown[] = [];
  const loaded = await loadPlugin({
    get: async (args: { path?: { id?: string } }) => {
      return { data: { id: args.path?.id, parentID: PARENT } };
    },
    messages: async (args: { path?: { id?: string } }) => {
      if (args.path?.id !== CHILD) {
        return { data: [] };
      }
      seen.resolve();
      return read.promise;
    },
    status: async () => ({ data: {} }),
    prompt: async (args: unknown) => {
      prompts.push(args);
      return {};
    },
    promptAsync: async (args: unknown) => {
      prompts.push(args);
      return {};
    },
  });
  try {
    await loaded.hooks['tool.execute.before']?.(
      { tool: 'task', sessionID: PARENT, callID: 'call_launch' },
      {
        args: {
          subagent_type: 'fixer',
          description: 'running child',
          prompt: 'work',
          background: true,
        },
      },
    );
    await loaded.hooks['tool.execute.after']?.(
      { tool: 'task', sessionID: PARENT, callID: 'call_launch' },
      {
        output: '<task id="ses_child" state="running">\nworking\n</task>',
      },
    );
    const pending = loaded.hooks.tool?.task_message?.execute(
      { task_id: CHILD, message: 'follow up' },
      { sessionID: PARENT, agent: 'orchestrator', callID: 'call_msg' } as never,
    );
    await seen.promise;
    await loaded.dispose();
    read.resolve({
      data: [
        {
          info: {
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-test',
          },
        },
      ],
    });
    await expect(pending).rejects.toThrow(/disposed/);
    expect(prompts).toHaveLength(0);
  } finally {
    await loaded.cleanup();
  }
});

test('dispose after reconcile does not consume a restored terminal result', async () => {
  const board = new BackgroundJobBoard();
  const restored = board.restoreRetainedSession({
    taskID: CHILD,
    parentSessionID: PARENT,
    agent: 'fixer',
    description: 'cached',
    state: 'completed',
    background: false,
    completedAt: 20,
    resultSummary: 'CACHED-TEXT',
  });
  expect(restored?.lastUsedAt).toBe(20);
  const gate = createBackgroundJobTerminalGate({
    input: {
      directory: '/tmp/omo-lifecycle-fence',
      client: { session: {} },
    } as never,
    backgroundJobBoard: board,
  });
  const seen = deferred<void>();
  const read = deferred<{ data: { parentID: string } }>();
  let disposed = false;
  const tool = createTaskResultTool({
    input: {
      directory: '/tmp/omo-lifecycle-fence',
      client: {
        session: {
          get: async () => {
            seen.resolve();
            return read.promise;
          },
          status: async () => ({ data: {} }),
        },
      },
    } as never,
    backgroundJobBoard: board,
    terminalGate: gate,
    isDisposed: () => disposed,
  });
  const pending = tool.task_result.execute({ task_id: CHILD }, {
    sessionID: PARENT,
    agent: 'orchestrator',
    callID: 'call_result',
  } as never);
  await seen.promise;
  disposed = true;
  gate.dispose();
  read.resolve({ data: { parentID: PARENT } });
  await expect(pending).resolves.toBe('CACHED-TEXT');
  expect(board.get(CHILD)?.lastUsedAt).toBe(20);
  const fresh = createTaskResultTool({
    input: {
      directory: '/tmp/omo-lifecycle-fence',
      client: {
        session: {
          get: async () => ({ data: { parentID: PARENT } }),
          status: async () => ({ data: {} }),
        },
      },
    } as never,
    backgroundJobBoard: board,
    terminalGate: createBackgroundJobTerminalGate({
      input: {
        directory: '/tmp/omo-lifecycle-fence',
        client: { session: {} },
      } as never,
      backgroundJobBoard: board,
    }),
  });
  await expect(
    fresh.task_result.execute({ task_id: CHILD }, {
      sessionID: PARENT,
      agent: 'orchestrator',
      callID: 'call_fresh',
    } as never),
  ).resolves.toBe('CACHED-TEXT');
  expect(board.get(CHILD)?.lastUsedAt).toBeGreaterThan(20);
});

test('dispose after retained recovery acquires no relaunch lease', async () => {
  const seen = deferred<void>();
  const read = deferred<{ data: Record<string, unknown> }>();
  const prompts: unknown[] = [];
  const loaded = await loadPlugin(
    {
      get: async (args: { path?: { id?: string } }) => {
        if (args.path?.id !== CHILD) {
          return { data: { id: args.path?.id, parentID: PARENT } };
        }
        seen.resolve();
        return read.promise;
      },
      messages: async () => ({
        data: [
          {
            info: {
              id: 'msg_user',
              role: 'user',
              agent: 'fixer',
              time: { created: 10 },
            },
            parts: [{ type: 'text', text: 'ask' }],
          },
          {
            info: {
              id: 'msg_turn',
              role: 'assistant',
              finish: 'stop',
              time: { created: 11, completed: 12 },
            },
            parts: [{ type: 'text', text: 'done' }],
          },
        ],
      }),
      status: async () => ({ data: {} }),
      prompt: async (args: unknown) => {
        prompts.push(args);
        return {};
      },
    },
    { hostFlavor: 'v2' },
  );
  try {
    const pending = loaded.hooks['tool.execute.before']?.(
      { tool: 'task', sessionID: PARENT, callID: 'call_resume' },
      {
        args: {
          subagent_type: 'fixer',
          description: 'resume old',
          prompt: 'again',
          task_id: CHILD,
          background: true,
        },
      },
    );
    await seen.promise;
    await loaded.dispose();
    read.resolve({
      data: {
        id: CHILD,
        parentID: PARENT,
        agent: 'fixer',
        time: { created: 10, completed: 12 },
      },
    });
    await expect(pending).rejects.toThrow(/disposed/);
    expect(prompts).toHaveLength(0);
    const again = loaded.hooks['tool.execute.before']?.(
      { tool: 'task', sessionID: PARENT, callID: 'call_resume_2' },
      {
        args: {
          subagent_type: 'fixer',
          description: 'resume old',
          prompt: 'again',
          task_id: CHILD,
          background: false,
        },
      },
    );
    await expect(again).rejects.toThrow(/disposed/);
    await expect(again).rejects.not.toThrow(/already owned/);
  } finally {
    await loaded.cleanup();
  }
});

test('task_cancel and task_revive succeed when orchestrator runs under a displayName (#1531)', async () => {
  const aborted: unknown[] = [];
  const prompted: unknown[] = [];
  const loaded = await loadPlugin(
    {
      get: async ({ path }: { path: { id: string } }) => ({
        data: {
          id: path.id,
          parentID: PARENT,
          agent: 'fixer',
          time: { created: 10, idle: Date.now() },
        },
      }),
      abort: async (args: unknown) => {
        aborted.push(args);
        return {};
      },
      status: async () => ({
        data: { [CHILD]: { type: 'idle' } },
      }),
      promptAsync: async (args: unknown) => {
        prompted.push(args);
        return {};
      },
    },
    {
      hostFlavor: 'v2',
      agent: 'mira',
      config: {
        presets: {
          local: {
            orchestrator: {
              displayName: 'mira',
            },
          },
        },
        preset: 'local',
      },
    },
  );
  try {
    // Verify that chat.message established managed admission by resolving 'mira' -> 'orchestrator'
    // before task delegation marks PARENT as task-managed.
    // If displayName resolution fails, assertManagedSession rejects with 'can only be used in managed sessions'.
    await expect(
      loaded.hooks.tool?.task_cancel.execute(
        { sessionID: 'ses_untracked', reason: 'pre-check' },
        { sessionID: PARENT, agent: 'mira' } as never,
      ),
    ).resolves.toBeDefined();

    await loaded.hooks['tool.execute.before']?.(
      { tool: 'task', sessionID: PARENT, callID: 'call_init' },
      {
        args: {
          subagent_type: 'fixer',
          description: 'child work',
          prompt: 'do work',
          background: true,
        },
      },
    );
    await loaded.hooks['tool.execute.after']?.(
      { tool: 'task', sessionID: PARENT, callID: 'call_init' },
      {
        output: `<task id="${CHILD}" state="running">\nworking\n</task>`,
      },
    );

    const cancelOutput = await loaded.hooks.tool?.task_cancel.execute(
      { sessionID: CHILD, reason: 'cancel test' },
      { sessionID: PARENT, agent: 'mira' } as never,
    );
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toEqual({ path: { id: CHILD } });
    expect(String(cancelOutput)).toContain('state: cancelled');

    const reviveOutput = await loaded.hooks.tool?.task_revive.execute(
      { sessionID: CHILD, prompt: 'revive prompt' },
      { sessionID: PARENT, agent: 'mira' } as never,
    );
    expect(String(reviveOutput)).toContain('status: started');
    expect(prompted).toHaveLength(1);
    expect(prompted[0]).toMatchObject({ path: { id: CHILD } });
  } finally {
    await loaded.dispose();
    await loaded.cleanup();
  }
});
