import { describe, expect, mock, test } from 'bun:test';
import {
  BackgroundJobBoard,
  createBackgroundJobLifecycle,
} from '../background-jobs';
import { createTaskSessionManagerHook } from '../hooks/task-session-manager';
import {
  clearChildInputWait,
  getChildInputWait,
  listChildInputWaits,
  noteChildInputWait,
  resetChildInputWaitForTests,
} from '../hooks/task-session-manager/child-input-wait';
import { resetUserWaitGateForTests } from '../hooks/task-session-manager/user-wait-gate';
import { buildPluginInput } from '../v2/client-shim';
import { mapV2EventToV1 } from '../v2/event-adapter';
import type { V2Context } from '../v2/types';
import { createTaskReplyTool } from './task-reply';
import { createTaskStatusTool } from './task-status';

const asJobs = (board: BackgroundJobBoard) =>
  createBackgroundJobLifecycle({ backgroundJobBoard: board });

mock.module('../utils/opencode-client', () => ({
  getClient: (input: { client: unknown }) => input.client as never,
}));

function registerBackgroundChild(board: BackgroundJobBoard) {
  board.registerLaunch({
    taskID: 'ses_child1',
    parentSessionID: 'parent-1',
    agent: 'fixer',
    description: 'implement',
    background: true,
    now: 0,
  });
}

const statusClient = () =>
  ({
    session: { status: mock(async () => ({ data: {} })) },
  }) as never;

function makeV2Ctx(permissionReply?: (args: never) => Promise<unknown>) {
  return {
    app: { name: 'opencode2', version: 'test' },
    options: {},
    agent: {
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
      list: async () => [],
    },
    tool: {
      transform: async () => ({ dispose() {} }),
      hook: async () => ({ dispose() {} }),
    },
    command: {
      transform: async () => ({ dispose() {} }),
      list: async () => [],
    },
    session: { hook: async () => ({ dispose() {} }) },
    event: { subscribe: (() => ({})) as never },
    ...(permissionReply ? { permission: { reply: permissionReply } } : {}),
    location: {
      directory: '/test',
      project: { id: 'proj_1', directory: '/test', canonical: '/test' },
    },
  } as unknown as V2Context;
}

function createInputWaitHook(board: BackgroundJobBoard) {
  return createTaskSessionManagerHook(
    {
      client: statusClient(),
      directory: '/test',
      worktree: '/test',
    } as never,
    {
      maxSessionsPerAgent: 2,
      maxRetainedSnapshots: 20,
      backgroundJobs: createBackgroundJobLifecycle({
        backgroundJobBoard: board,
      }),
      shouldManageSession: (sessionID: string) => sessionID === 'parent-1',
      idleReconcileDelayMs: 0,
      runtimeStatusReconcileDelayMs: 0,
    },
  );
}

async function routeMappedV2Event(
  hook: ReturnType<typeof createInputWaitHook>,
  event: Record<string, unknown>,
) {
  for (const mapped of mapV2EventToV1(event)) {
    await hook.event({ event: mapped } as never);
  }
}

describe('task_status with a waiting child', () => {
  test('#1356 native data-keyed permission reply clears only its matching child wait', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    const hook = createInputWaitHook(board);
    try {
      for (const requestID of ['per_1356', 'per_other']) {
        await routeMappedV2Event(hook, {
          type: 'permission.asked',
          data: {
            id: requestID,
            sessionID: 'ses_child1',
            action: 'external_directory',
            resources: ['/approved/scratch/report.txt'],
          },
        });
      }
      expect(getChildInputWait('ses_child1', 'per_1356')).toBeDefined();
      expect(getChildInputWait('ses_child1', 'per_other')).toBeDefined();

      // Exact native V2 wire shape; the event pump dispatches raw plus every
      // synthesized event, just as routeMappedV2Event does here.
      await routeMappedV2Event(hook, {
        type: 'permission.replied',
        data: {
          sessionID: 'ses_child1',
          requestID: 'per_1356',
          reply: 'once',
        },
      });

      expect(getChildInputWait('ses_child1', 'per_other')).toBeDefined();
      expect(getChildInputWait('ses_child1', 'per_1356')).toBeUndefined();
    } finally {
      resetChildInputWaitForTests();
    }
  });

  test('#1375 permission reply with a properties envelope still clears its child wait', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    const hook = createInputWaitHook(board);
    try {
      for (const requestID of ['per_1375', 'per_other']) {
        await routeMappedV2Event(hook, {
          type: 'permission.asked',
          data: {
            id: requestID,
            sessionID: 'ses_child1',
            action: 'external_directory',
            resources: ['/approved/scratch/report.txt'],
          },
        });
      }
      expect(getChildInputWait('ses_child1', 'per_1375')).toBeDefined();
      expect(getChildInputWait('ses_child1', 'per_other')).toBeDefined();

      // Same resolution payload as #1356 but with a bare `properties`
      // envelope alongside `data` — previously suppressed synthesis, so
      // the wait stuck and the parent kept seeing `waiting_input`.
      await routeMappedV2Event(hook, {
        type: 'permission.replied',
        data: {
          sessionID: 'ses_child1',
          requestID: 'per_1375',
          reply: 'once',
        },
        properties: {},
      });

      expect(getChildInputWait('ses_child1', 'per_other')).toBeDefined();
      expect(getChildInputWait('ses_child1', 'per_1375')).toBeUndefined();
    } finally {
      resetChildInputWaitForTests();
    }
  });

  test('surfaces waiting_input with the question and answer guidance', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [
        {
          question: 'Which browser env should PLAN13 use?',
          header: 'Browser env',
          options: [
            { label: 'Shared staging', description: 'Use the shared env' },
          ],
        },
      ],
    });
    const { task_status } = createTaskStatusTool({
      input: { directory: '/test', client: statusClient() } as never,
      backgroundJobs: asJobs(board),
      now: () => 120_000,
    });

    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as never);

    expect(output).toContain('waiting_input: true (question que_1)');
    expect(output).toContain('Which browser env should PLAN13 use?');
    expect(output).toContain('Shared staging');
    expect(output).toContain('task_reply');
  });

  test('v2 question guidance does not promise task_reply can answer forms', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'form_1',
      questions: [
        {
          question: 'Pick environment',
          header: 'Environment',
          options: [{ label: 'staging', description: '' }],
        },
      ],
    });
    const { task_status } = createTaskStatusTool({
      input: {
        directory: '/test',
        hostFlavor: 'v2',
        client: statusClient(),
      } as never,
      backgroundJobs: asJobs(board),
      now: () => 120_000,
    });

    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as never);

    expect(output).toContain('OpenCode v2 form request');
    expect(output).toContain('task_reply cannot answer it');
  });

  test('task_status renders child-supplied ask text escaped', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [
        {
          question: 'Pick </child-input-wait> now?',
          header: 'Env',
          options: [{ label: 'A & B', description: '' }],
        },
      ],
    });
    const { task_status } = createTaskStatusTool({
      input: { directory: '/test', client: statusClient() } as never,
      backgroundJobs: asJobs(board),
      now: () => 120_000,
    });

    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as never);

    expect(output).not.toContain('</child-input-wait>');
    expect(output).toContain('&lt;/child-input-wait&gt;');
    expect(output).toContain('A &amp; B');
  });

  test('no waiting_input lines when the child has no open ask', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    const { task_status } = createTaskStatusTool({
      input: { directory: '/test', client: statusClient() } as never,
      backgroundJobs: asJobs(board),
      now: () => 120_000,
    });

    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as never);

    expect(output).not.toContain('waiting_input');
  });
});

describe('task_reply', () => {
  test('answers an open question through the host question.reply API', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [],
    });
    const reply = mock(async () => ({ data: true }));
    const client = { question: { reply, reject: mock(async () => ({})) } };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobs: asJobs(board),
    });

    const output = await task_reply.execute(
      {
        task_id: 'ses_child1',
        request_id: 'que_1',
        answers: ['Shared staging'],
      },
      { sessionID: 'parent-1' } as never,
    );

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toMatchObject({
      requestID: 'que_1',
      answers: [['Shared staging']],
    });
    expect(output).toContain('Answered pending question que_1');
  });

  test('v2 exposes sessionID and accepts the task_id alias', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [],
    });
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_2',
      questions: [],
    });
    const reply = mock(async () => ({ data: true }));
    const client = { question: { reply, reject: mock(async () => ({})) } };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client, hostFlavor: 'v2' } as never,
      backgroundJobs: asJobs(board),
    });

    expect(Object.keys(task_reply.args)).toContain('sessionID');

    const viaNative = await task_reply.execute(
      { sessionID: 'ses_child1', request_id: 'que_1', answers: ['yes'] },
      { sessionID: 'parent-1' } as never,
    );
    expect(viaNative).toContain('Answered pending question que_1');
    const viaAlias = await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'que_2', answers: ['yes'] },
      { sessionID: 'parent-1' } as never,
    );
    expect(viaAlias).toContain('Answered pending question que_2');
  });

  test('omitted answers rejects the open question', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [],
    });
    const reject = mock(async () => ({ data: true }));
    const client = { question: { reply: mock(async () => ({})), reject } };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobs: asJobs(board),
    });

    const output = await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'que_1' },
      { sessionID: 'parent-1' } as never,
    );

    expect(reject).toHaveBeenCalledTimes(1);
    expect(output).toContain('Rejected pending question que_1');
  });

  test('rejects an unknown request id with the open list', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [],
    });
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client: {} } as never,
      backgroundJobs: asJobs(board),
    });

    await expect(
      task_reply.execute({ task_id: 'ses_child1', request_id: 'que_zzz' }, {
        sessionID: 'parent-1',
      } as never),
    ).rejects.toThrow('no open request que_zzz');
  });

  test('#1435 a request resolved elsewhere converges benignly when no asks remain', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'permission',
      requestID: 'per_gone',
      permission: 'bash',
      patterns: ['*'],
    });
    // An external replier (host policy, TUI, Safety Net) resolved the ask
    // after the parent was woken; the sidecar cleared it via the event path.
    clearChildInputWait('ses_child1', 'per_gone');
    const reply = mock(async () => ({ data: true }));
    const client = { permission: { reply } };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobs: asJobs(board),
    });

    const output = await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'per_gone', reply: 'always' },
      { sessionID: 'parent-1' } as never,
    );

    expect(reply).not.toHaveBeenCalled();
    expect(output).toContain('No open request per_gone');
    expect(output).toContain('Nothing was replied');
  });

  test('#1435 a request id open on another task steers the parent there', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    board.registerLaunch({
      taskID: 'ses_child2',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      background: true,
      now: 0,
    });
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'permission',
      requestID: 'per_shared',
      permission: 'bash',
      patterns: ['*'],
    });
    noteChildInputWait({
      taskID: 'ses_child2',
      parentSessionID: 'parent-1',
      kind: 'permission',
      requestID: 'per_on_b',
      permission: 'bash',
      patterns: ['*'],
    });
    const client = {
      permission: { reply: mock(async () => ({ data: true })) },
    };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobs: asJobs(board),
    });

    const caught = await task_reply
      .execute(
        { task_id: 'ses_child1', request_id: 'per_on_b', reply: 'once' },
        { sessionID: 'parent-1' } as never,
      )
      .catch((error) => error);

    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toContain('per_on_b');
    expect(caught.message).toContain('ses_child2');
  });

  test('#1435 a request id held by another parent does not disclose it', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    board.registerLaunch({
      taskID: 'ses_foreign',
      parentSessionID: 'parent-2',
      agent: 'fixer',
      description: 'implement',
      background: true,
      now: 0,
    });
    noteChildInputWait({
      taskID: 'ses_foreign',
      parentSessionID: 'parent-2',
      kind: 'permission',
      requestID: 'per_foreign',
      permission: 'bash',
      patterns: ['*'],
    });
    const client = {
      permission: { reply: mock(async () => ({ data: true })) },
    };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobs: asJobs(board),
    });

    const output = await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'per_foreign', reply: 'once' },
      { sessionID: 'parent-1' } as never,
    );

    expect(output).toContain('Nothing was replied');
    expect(output).not.toContain('ses_foreign');
  });

  test('rejects a task id owned by a different parent', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client: {} } as never,
      backgroundJobs: asJobs(board),
    });

    await expect(
      task_reply.execute({ task_id: 'ses_child1', request_id: 'que_1' }, {
        sessionID: 'parent-2',
      } as never),
    ).rejects.toThrow('Unknown task ID or alias');
  });

  test('answers an open permission request through permission.reply', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'permission',
      requestID: 'per_1',
      permission: 'bash',
      patterns: ['docker *'],
    });
    const reply = mock(async () => ({ data: true }));
    const client = { permission: { reply } };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobs: asJobs(board),
    });

    const output = await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'per_1', reply: 'once' },
      { sessionID: 'parent-1' } as never,
    );

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toMatchObject({
      sessionID: 'ses_child1',
      requestID: 'per_1',
      reply: 'once',
    });
    expect(output).toContain('Replied once to pending permission per_1');
  });

  test('a successful reply clears the wait', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [],
    });
    const client = {
      question: {
        reply: mock(async () => ({ data: true })),
        reject: mock(async () => ({})),
      },
    };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobs: asJobs(board),
    });

    await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'que_1', answers: ['yes'] },
      { sessionID: 'parent-1' } as never,
    );

    expect(getChildInputWait('ses_child1', 'que_1')).toBeUndefined();
    expect(listChildInputWaits('ses_child1')).toHaveLength(0);
  });

  test('an HTTP-error question result fails and keeps the wait for retry', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [],
    });
    const client = {
      question: {
        reply: mock(async () => ({
          data: undefined,
          error: { message: 'unknown question' },
          response: { ok: false, status: 404 },
        })),
        reject: mock(async () => ({})),
      },
    };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobs: asJobs(board),
    });

    await expect(
      task_reply.execute(
        { task_id: 'ses_child1', request_id: 'que_1', answers: ['yes'] },
        { sessionID: 'parent-1' } as never,
      ),
    ).rejects.toThrow('Task reply transport failed');

    expect(getChildInputWait('ses_child1', 'que_1')).not.toBeUndefined();
  });

  test('a timed-out permission reply keeps the wait for retry', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'permission',
      requestID: 'per_1',
      permission: 'bash',
      patterns: ['docker *'],
    });
    const client = {
      permission: { reply: mock(() => new Promise(() => {})) },
    };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobs: asJobs(board),
      replyTimeoutMs: 5,
    });

    await expect(
      task_reply.execute(
        { task_id: 'ses_child1', request_id: 'per_1', reply: 'once' },
        { sessionID: 'parent-1' } as never,
      ),
    ).rejects.toThrow('timed out');

    expect(getChildInputWait('ses_child1', 'per_1')).not.toBeUndefined();
  });

  test('#1356 a host not-found permission reply clears only that stale wait', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    for (const requestID of ['per_gone', 'per_open']) {
      noteChildInputWait({
        taskID: 'ses_child1',
        parentSessionID: 'parent-1',
        kind: 'permission',
        requestID,
        permission: 'external_directory',
        patterns: ['/approved/*'],
      });
    }
    const client = {
      permission: {
        reply: mock(async () => {
          throw new Error('Permission request not found: per_gone');
        }),
      },
    };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobs: asJobs(board),
    });

    const output = await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'per_gone', reply: 'once' },
      { sessionID: 'parent-1' } as never,
    );

    expect(output).toContain('no longer pending');
    expect(output).toContain('Nothing was replied');
    expect(getChildInputWait('ses_child1', 'per_gone')).toBeUndefined();
    expect(getChildInputWait('ses_child1', 'per_open')).toBeDefined();
  });

  test('a timed-out question reject keeps the wait for retry', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [],
    });
    const client = {
      question: {
        reply: mock(async () => ({})),
        reject: mock(() => new Promise(() => {})),
      },
    };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobs: asJobs(board),
      replyTimeoutMs: 5,
    });

    await expect(
      task_reply.execute({ task_id: 'ses_child1', request_id: 'que_1' }, {
        sessionID: 'parent-1',
      } as never),
    ).rejects.toThrow('timed out');

    expect(getChildInputWait('ses_child1', 'que_1')).not.toBeUndefined();
  });
});

describe('task_reply on a v1-shaped host client', () => {
  function registerOpenQuestion() {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [],
    });
    return board;
  }

  test('answers a question through the v1 _client.post transport', async () => {
    const board = registerOpenQuestion();
    const post = mock(async () => ({ data: true, error: undefined }));
    const client = { _client: { post } };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobs: asJobs(board),
    });

    const output = await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'que_1', answers: ['Shared'] },
      { sessionID: 'parent-1' } as never,
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      url: '/question/{requestID}/reply',
      path: { requestID: 'que_1' },
      body: { answers: [['Shared']] },
    });
    expect(output).toContain('Answered pending question que_1');
    expect(getChildInputWait('ses_child1', 'que_1')).toBeUndefined();
  });

  test('rejects a question through the v1 _client.post transport', async () => {
    const board = registerOpenQuestion();
    const post = mock(async () => ({ data: true, error: undefined }));
    const client = { _client: { post } };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobs: asJobs(board),
    });

    const output = await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'que_1' },
      { sessionID: 'parent-1' } as never,
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      url: '/question/{requestID}/reject',
      path: { requestID: 'que_1' },
    });
    expect(output).toContain('Rejected pending question que_1');
  });

  test('answers a permission through the typed v1 permissions method', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'permission',
      requestID: 'per_1',
      permission: 'bash',
      patterns: ['docker *'],
    });
    const postPermission = mock(async () => ({
      data: true,
      error: undefined,
    }));
    const client = { postSessionIdPermissionsPermissionId: postPermission };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobs: asJobs(board),
    });

    const output = await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'per_1', reply: 'always' },
      { sessionID: 'parent-1' } as never,
    );

    expect(postPermission).toHaveBeenCalledTimes(1);
    expect(postPermission.mock.calls[0]?.[0]).toMatchObject({
      path: { id: 'ses_child1', permissionID: 'per_1' },
      body: { response: 'always' },
    });
    expect(output).toContain('Replied always to pending permission per_1');
  });

  test('an HTTP-error v1 result fails and keeps the wait', async () => {
    const board = registerOpenQuestion();
    const post = mock(async () => ({
      data: undefined,
      error: { message: 'unknown question' },
      response: { ok: false, status: 404 },
    }));
    const client = { _client: { post } };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobs: asJobs(board),
    });

    await expect(
      task_reply.execute(
        { task_id: 'ses_child1', request_id: 'que_1', answers: ['Shared'] },
        { sessionID: 'parent-1' } as never,
      ),
    ).rejects.toThrow('Task reply transport failed');

    expect(getChildInputWait('ses_child1', 'que_1')).not.toBeUndefined();
  });

  test('a client with neither domain nor v1 transport throws the no-host-API error', async () => {
    const board = registerOpenQuestion();
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client: {} } as never,
      backgroundJobs: asJobs(board),
    });

    await expect(
      task_reply.execute(
        { task_id: 'ses_child1', request_id: 'que_1', answers: ['Shared'] },
        { sessionID: 'parent-1' } as never,
      ),
    ).rejects.toThrow('no question.reply API');
  });

  test('v2 unsupported question reply capability reports honestly and keeps the wait', async () => {
    const board = registerOpenQuestion();
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client: { permission: {} } } as never,
      backgroundJobs: asJobs(board),
    });

    await expect(
      task_reply.execute(
        { task_id: 'ses_child1', request_id: 'que_1', answers: ['Shared'] },
        { sessionID: 'parent-1' } as never,
      ),
    ).rejects.toThrow('no question.reply API');
    expect(getChildInputWait('ses_child1', 'que_1')).not.toBeUndefined();
  });
});

describe('task_reply v2 event transport integration', () => {
  test('raw permission.asked maps through the hook sidecar and replies via pinned v2 permission.reply', async () => {
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    const hook = createInputWaitHook(board);
    try {
      const reply = mock(async () => ({ data: true }));
      const input = buildPluginInput(makeV2Ctx(reply as never));
      const { task_reply } = createTaskReplyTool({
        input: input as never,
        backgroundJobs: asJobs(board),
      });

      await routeMappedV2Event(hook, {
        type: 'permission.asked',
        data: {
          id: 'per_1',
          sessionID: 'ses_child1',
          action: 'tool.execute',
          resources: ['bash:*'],
        },
      });

      expect(getChildInputWait('ses_child1', 'per_1')).toMatchObject({
        kind: 'permission',
        permission: 'tool.execute',
        patterns: ['bash:*'],
      });

      await task_reply.execute(
        { task_id: 'ses_child1', request_id: 'per_1', reply: 'always' },
        { sessionID: 'parent-1' } as never,
      );

      expect(reply).toHaveBeenCalledTimes(1);
      expect(reply.mock.calls[0]?.[0]).toEqual({
        sessionID: 'ses_child1',
        requestID: 'per_1',
        decision: 'always',
      });
      expect(getChildInputWait('ses_child1', 'per_1')).toBeUndefined();
    } finally {
      await hook.event({
        event: { type: 'server.instance.disposed' },
      } as never);
    }
  });

  test('v2 form.created maps to a question wait but unsupported task_reply keeps the wait', async () => {
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    const hook = createInputWaitHook(board);
    try {
      const input = buildPluginInput(makeV2Ctx());
      const { task_reply } = createTaskReplyTool({
        input: input as never,
        backgroundJobs: asJobs(board),
      });

      await routeMappedV2Event(hook, {
        type: 'form.created',
        data: {
          form: {
            id: 'form_1',
            sessionID: 'ses_child1',
            fields: [
              {
                key: 'environment',
                title: 'Pick environment',
                type: 'select',
                options: [{ label: 'staging', description: 'Use staging' }],
              },
            ],
          },
        },
      });

      expect(getChildInputWait('ses_child1', 'form_1')).toMatchObject({
        kind: 'question',
        requestID: 'form_1',
      });
      await expect(
        task_reply.execute(
          { task_id: 'ses_child1', request_id: 'form_1', answers: ['staging'] },
          { sessionID: 'parent-1' } as never,
        ),
      ).rejects.toThrow('no question.reply API');
      expect(getChildInputWait('ses_child1', 'form_1')).not.toBeUndefined();
    } finally {
      await hook.event({
        event: { type: 'server.instance.disposed' },
      } as never);
    }
  });
});
