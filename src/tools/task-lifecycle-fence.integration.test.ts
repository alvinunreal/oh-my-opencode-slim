import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BackgroundJobBoard,
  createBackgroundJobLifecycle,
  createBackgroundJobTerminalGate,
} from '../background-jobs';
import { OhMyOpenCodeLite as plugin } from '../index';
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

async function loadPlugin(
  session: Record<string, unknown>,
  hostFlavor?: string,
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
    JSON.stringify({ companion: { enabled: false } }),
  );
  const hooks = await plugin({
    client: { app: { log: async () => ({}) }, session },
    directory: projectDir,
    worktree: projectDir,
    serverUrl: new URL('http://127.0.0.1:4098'),
    ...(hostFlavor ? { hostFlavor } : {}),
  } as never);
  await hooks['chat.message']?.(
    { sessionID: PARENT, agent: 'orchestrator' } as never,
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
    backgroundJobs: createBackgroundJobLifecycle({
      backgroundJobBoard: board,
      gate,
    }),
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
    backgroundJobs: createBackgroundJobLifecycle({
      backgroundJobBoard: board,
      gate: createBackgroundJobTerminalGate({
        input: {
          directory: '/tmp/omo-lifecycle-fence',
          client: { session: {} },
        } as never,
        backgroundJobBoard: board,
      }),
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
    'v2',
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
