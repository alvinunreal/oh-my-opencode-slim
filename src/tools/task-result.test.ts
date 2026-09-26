import { afterEach, expect, jest, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../utils/background-job-board';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
} from '../utils/background-job-terminal-gate';
import { getRuntimeSessionStatusSnapshot } from '../utils/session-runtime-status';
import { createTaskResultTool } from './task-result';

mock.module('../utils/opencode-client', () => ({
  getClient: (input: { client: unknown }) => input.client,
}));
const gates: BackgroundJobTerminalGate[] = [];
afterEach(() => {
  for (const gate of gates.splice(0)) gate.dispose();
});
function harness(tracked = true, indexed = !tracked, v2 = false) {
  const board = new BackgroundJobBoard();
  const run = tracked
    ? board.registerLaunch({
        taskID: 'ses_child1',
        parentSessionID: 'parent-1',
        agent: 'explorer',
        now: 0,
      })
    : undefined;
  const get = mock(async () => ({
    data: {
      id: 'ses_child1',
      parentID: 'parent-1',
      agent: 'explorer',
      ...(v2
        ? {
            location: { directory: '/tmp' },
            outcome: 'succeeded',
            time: { created: 1, idle: 30 },
          }
        : { directory: '/tmp', time: { created: 1 } }),
    },
  }));
  const status = mock(async () => ({
    data: indexed ? { ses_child1: { type: 'idle' } } : {},
  }));
  const parentMessages = mock(async () => ({ data: [] as unknown[] }));
  const messages = mock(async (args: { path: { id: string } }) =>
    args.path.id === 'parent-1'
      ? parentMessages()
      : {
          data: [
            ...(indexed || !tracked
              ? [
                  {
                    info: {
                      id: 'msg_user',
                      role: 'user',
                      time: { created: 2 },
                    },
                    parts: [{ type: 'text', text: 'delegated prompt' }],
                  },
                ]
              : []),
            {
              info: {
                ...(v2 ? { id: 'msg_assistant' } : {}),
                role: 'assistant',
                finish: 'stop',
                time: { created: 3, completed: 10 },
              },
              parts: [{ type: 'text', text: 'final findings' }],
            },
            ...(v2
              ? [{ info: { role: 'system', time: { created: 30 } }, parts: [] }]
              : []),
          ],
        },
  );
  const identity = {
    parentSessionID: 'parent-1',
    taskID: 'ses_child1',
    alias: 'exp-1',
    agent: 'explorer',
    directory: '/tmp',
  };
  const lookup = mock((_parent: string, key: string) =>
    indexed && (key === identity.taskID || key === identity.alias)
      ? identity
      : undefined,
  );
  const input = {
    directory: '/tmp',
    client: { session: v2 ? { get, messages } : { get, status, messages } },
  } as never;
  const gate = createBackgroundJobTerminalGate({
    backgroundJobBoard: board,
    input,
    graceMs: 0,
  });
  gates.push(gate);
  const tool = createTaskResultTool({
    input,
    backgroundJobBoard: board,
    terminalGate: gate,
    identityIndex: { lookup },
  }).task_result;
  const execute = (task_id = tracked ? 'exp-1' : 'ses_child1') =>
    tool.execute({ task_id }, {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as never);
  async function settle(
    state: 'completed' | 'error' | 'cancelled' | 'stopped',
    acknowledged = false,
  ) {
    if (!run) throw new Error('tracked fixture required');
    if (state === 'error')
      messages.mockResolvedValue({
        data: [
          { info: { role: 'assistant', error: 'provider failed' }, parts: [] },
        ],
      } as never);
    if (state === 'stopped') messages.mockResolvedValue({ data: [] });
    if (state === 'cancelled') {
      const lease = board.acquireCancellationLease(run.taskID, run.generation);
      const token = gate.capture(run);
      if (!lease || !token) throw new Error('missing cancellation authority');
      gate.observe(token, {
        kind: 'quiescent',
        origin: 'cancel-verifier',
        readStartedAt: token.readStartedAt,
        stable: true,
      });
      await gate.reconcile(run, {
        kind: 'cancel',
        lease,
        reason: 'user requested',
      });
      board.releaseLease(lease);
    } else await gate.reconcile(run);
    expect(board.get(run.taskID)?.state).toBe(state);
    if (acknowledged) board.markReconciled(run.taskID);
  }
  return {
    board,
    get run() {
      if (!run) throw new Error('tracked fixture required');
      return run;
    },
    gate,
    get,
    status,
    messages,
    parentMessages,
    lookup,
    identity,
    execute,
    settle,
    input,
  };
}

function parentDelegation(v2: boolean, agent = 'explorer', background = true) {
  const output = v2
    ? '<subagent sessionID="ses_child1" state="running">Working</subagent>'
    : 'task_id: ses_child1\nstate: running';
  return {
    data: [
      {
        info: { role: 'assistant', sessionID: 'parent-1' },
        parts: [
          {
            type: 'tool',
            ...(v2 ? { name: 'subagent' } : { tool: 'task' }),
            state: {
              status: 'completed',
              input: v2
                ? { agent, background }
                : { subagent_type: agent, background },
              ...(v2
                ? { content: [{ type: 'text', text: output }] }
                : { output }),
            },
          },
        ],
      },
    ],
  };
}

function v2Host(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: 'ses_child1',
      parentID: 'parent-1',
      agent: 'explorer',
      location: { directory: '/tmp' },
      outcome: 'succeeded',
      time: { created: 1, updated: 30, idle: 30 },
      ...overrides,
    },
  };
}

test('retrieves full confirmed text without prompting or resuming', async () => {
  const h = harness();
  await h.settle('completed');
  h.messages.mockClear();
  expect(await h.execute()).toBe('final findings');
  expect(h.messages).toHaveBeenCalledTimes(1);
  expect(h.board.get(h.run.taskID)?.lastUsedAt).toBeGreaterThan(0);
});
test('only the last assistant segment is retrieved; reasoning is private', async () => {
  const h = harness();
  h.messages.mockResolvedValue({
    data: [
      {
        info: { role: 'assistant', finish: 'stop', time: { completed: 2 } },
        parts: [{ type: 'text', text: 'earlier' }],
      },
      { info: { role: 'user' }, parts: [] },
      {
        info: { role: 'assistant', finish: 'stop', time: { completed: 10 } },
        parts: [
          { type: 'reasoning', text: 'private' },
          { type: 'text', text: 'final' },
        ],
      },
    ],
  } as never);
  expect(await h.execute()).toBe('final');
});
test.each(['completed', 'error', 'cancelled', 'stopped'] as const)(
  'live busy retracts REAL %s before rejection or acknowledgement',
  async (state) => {
    for (const acknowledged of [false, true]) {
      const h = harness();
      await h.settle(state, acknowledged);
      const previous = h.board.get(h.run.taskID);
      if (!previous) throw new Error('missing terminal fixture');
      h.messages.mockClear();
      h.status.mockResolvedValue({ data: { ses_child1: { type: 'busy' } } });
      expect(await h.execute()).toContain('state: running');
      expect(h.board.get(h.run.taskID)).toMatchObject({
        state: 'running',
        generation: previous.generation,
        terminalRevision: previous.terminalRevision + 1,
        terminalUnreconciled: false,
        resultSummary: undefined,
      });
      expect(h.messages).not.toHaveBeenCalled();
    }
  },
);
test('busy timeout reopens without clearing deadline or cancellation intent', async () => {
  const h = harness();
  h.board.claimWallClockDeadline({ ...h.run, now: 1 });
  const token = h.gate.capture(h.run);
  if (!token) throw new Error('missing observation');
  h.gate.observe(token, {
    kind: 'deleted',
    origin: 'test',
    readStartedAt: token.readStartedAt,
  });
  expect(h.board.get(h.run.taskID)?.state).toBe('error');
  h.status.mockResolvedValue({ data: { ses_child1: { type: 'busy' } } });
  expect(await h.execute()).toContain('state: running');
  expect(h.board.get(h.run.taskID)).toMatchObject({
    state: 'running',
    deadlineExceededAt: 1,
    cancellationRequested: true,
    timedOut: true,
  });
});
test.each(['busy', 'retry'])(
  'preserves live %s presentation without reading result',
  async (type) => {
    const h = harness();
    h.status.mockResolvedValue({ data: { ses_child1: { type } } });
    expect(await h.execute()).toContain(
      type === 'retry' ? 'state: retry' : 'state: running',
    );
    expect(h.messages).not.toHaveBeenCalled();
    expect(h.status).toHaveBeenCalledTimes(1);
  },
);
test('valid idle with pending transcript is pending, not a terminal result', async () => {
  const h = harness();
  h.status.mockResolvedValue({ data: { ses_child1: { type: 'idle' } } });
  h.messages.mockResolvedValue({
    data: [{ info: { role: 'assistant' }, parts: [] }],
  } as never);
  expect(await h.execute()).toContain('state: pending');
  expect(h.board.get(h.run.taskID)?.state).toBe('running');
});
test('unknown status remains running without reading transcript', async () => {
  const h = harness();
  h.status.mockRejectedValue(new Error('unavailable'));
  expect(await h.execute()).toContain('state: running (unconfirmed)');
  expect(h.messages).not.toHaveBeenCalled();
});
test.each(['error', 'cancelled', 'stopped'] as const)(
  'quiescent %s is rejected only after checking activity',
  async (state) => {
    const h = harness();
    await h.settle(state);
    h.status.mockClear();
    await expect(h.execute()).rejects.toThrow(
      state === 'error'
        ? 'ended in error'
        : state === 'cancelled'
          ? 'was cancelled'
          : 'no confirmed completed result',
    );
    expect(h.status).toHaveBeenCalledTimes(1);
    expect(h.board.get(h.run.taskID)?.lastUsedAt).toBeGreaterThan(0);
  },
);
test('acknowledged completed result remains retrievable if current evidence matches', async () => {
  const h = harness();
  await h.settle('completed', true);
  expect(await h.execute()).toBe('final findings');
});
test('empty pending placeholder never rescues N-1 from a retained completed publication', async () => {
  const h = harness();
  await h.settle('completed');
  h.messages.mockResolvedValue({
    data: [
      {
        info: { role: 'assistant', time: { completed: 10 } },
        parts: [{ type: 'text', text: 'final findings' }],
      },
      { info: { role: 'assistant' }, parts: [] },
    ],
  } as never);
  expect(await h.execute()).not.toContain('final findings');
});
test('generation change during evidence lookup never returns the old result', async () => {
  const h = harness();
  h.messages.mockImplementation(async () => {
    h.board.registerLaunch({ ...h.run, now: 100 });
    return {
      data: [
        {
          info: { role: 'assistant', finish: 'stop', time: { completed: 10 } },
          parts: [{ type: 'text', text: 'old result' }],
        },
      ],
    };
  });
  await expect(h.execute()).rejects.toThrow('changed generation');
});
test('generation change during ownership lookup cannot consume a new publication', async () => {
  const h = harness();
  await h.settle('completed');
  h.get.mockImplementation(async () => {
    const lease = h.board.acquireRelaunchLease(h.run.taskID, h.run.generation);
    if (!lease) throw new Error('missing relaunch lease');
    h.board.registerLaunch({ ...h.run, relaunchLease: lease, now: 100 });
    h.board.releaseLease(lease);
    return { data: { parentID: 'parent-1' } };
  });
  await expect(h.execute()).rejects.toThrow('changed generation');
  expect(h.board.get(h.run.taskID)?.lastUsedAt).toBe(100);
});
test('ownership mismatch cannot expose a child result', async () => {
  const h = harness(false);
  h.get.mockResolvedValue({ data: { parentID: 'other' } });
  await expect(h.execute()).rejects.toThrow('does not match');
  expect(h.messages).not.toHaveBeenCalled();
});
test.each(['busy', 'retry'])(
  'untracked live %s returns status without a transcript',
  async (type) => {
    const h = harness(false);
    h.status.mockResolvedValue({ data: { ses_child1: { type } } });
    expect(await h.execute()).toContain(
      'retry task_result after the task finishes',
    );
    expect(h.messages).not.toHaveBeenCalled();
  },
);
test('indexed quiescent session still requires a terminal assistant segment', async () => {
  const h = harness(false);
  h.messages.mockResolvedValue({
    data: [
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'partial' }],
      },
    ],
  } as never);
  expect(await h.execute()).toContain('state: running (unconfirmed)');
});
test('unknown alias and empty task id are rejected', async () => {
  const h = harness();
  await expect(h.execute('exp-99')).rejects.toThrow('Unknown task ID');
  await expect(h.execute(' ')).rejects.toThrow('requires task_id');
});

test.each([false, true])(
  'indexed orphan recovers final text by alias and exact ID on v2=%s',
  async (v2) => {
    const h = harness(false, true, v2);
    expect(await h.execute('exp-1')).toBe('final findings');
    expect(await h.execute('ses_child1')).toBe('final findings');
    expect(h.board.get('ses_child1')).toBeUndefined();
    expect(h.get).toHaveBeenCalledWith({
      path: { id: 'ses_child1' },
      query: { directory: '/tmp' },
    });
    expect(h.messages).toHaveBeenCalledTimes(v2 ? 4 : 2);
    expect(h.get).toHaveBeenCalledTimes(v2 ? 4 : 2);
    expect(h.status).toHaveBeenCalledTimes(v2 ? 0 : 4);
  },
);

test.each(['exp-1', 'ses_child1'])(
  'indexed orphan recovers final text with absent idle key by %s',
  async (taskID) => {
    const h = harness(false);
    h.status.mockResolvedValue({ data: {} });
    expect(await h.execute(taskID)).toBe('final findings');
    expect(h.status).toHaveBeenCalledTimes(2);
    expect(h.messages).toHaveBeenCalledTimes(1);
  },
);

test('indexed running entry can recover terminal result without board acknowledgement', async () => {
  const h = harness(true, true);
  const before = { ...h.run };
  expect(await h.execute()).toBe('final findings');
  expect(h.board.get(h.run.taskID)).toEqual(before);
});

test('tracked completed result never consults an unavailable identity index', async () => {
  const h = harness();
  await h.settle('completed');
  h.lookup.mockImplementation(() => {
    throw new Error('index unavailable');
  });
  expect(await h.execute()).toBe('final findings');
});

test('indexed running result fails closed if board relaunches during retrieval', async () => {
  const h = harness(true, true);
  h.messages.mockImplementation(async () => {
    h.board.registerLaunch({ ...h.run, now: 100 });
    return {
      data: [
        { info: { role: 'user', time: { created: 2 } }, parts: [] },
        {
          info: { role: 'assistant', finish: 'stop', time: { completed: 10 } },
          parts: [{ type: 'text', text: 'old result' }],
        },
      ],
    };
  });
  await expect(h.execute()).rejects.toThrow('changed generation');
});

test('indexed v1 idle recheck refuses a concurrent new run', async () => {
  const h = harness(false);
  h.status
    .mockResolvedValueOnce({ data: {} })
    .mockResolvedValueOnce({ data: { ses_child1: { type: 'busy' } } });
  expect(await h.execute()).not.toContain('final findings');
});

test.each(['busy', 'retry'])(
  'indexed v1 absent key recheck blocks a new %s state',
  async (type) => {
    const h = harness(false);
    h.status
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { ses_child1: { type } } });
    expect(await h.execute()).toContain('state: running (unconfirmed)');
    expect(h.messages).toHaveBeenCalledTimes(1);
  },
);

test('indexed v1 absent key cannot return an earlier turn after new admission', async () => {
  const h = harness(false);
  h.status.mockResolvedValue({ data: {} });
  h.messages.mockResolvedValue({
    data: [
      { info: { role: 'user', time: { created: 2 } }, parts: [] },
      {
        info: { role: 'assistant', finish: 'stop', time: { completed: 10 } },
        parts: [{ type: 'text', text: 'old answer' }],
      },
      { info: { role: 'user', time: { created: 20 } }, parts: [] },
    ],
  } as never);
  expect(await h.execute()).toContain('state: running (unconfirmed)');
  expect(h.status).toHaveBeenCalledTimes(1);
});

test('unindexed orphan exact ID cannot read a foreign session', async () => {
  const h = harness(false, false);
  await expect(h.execute('ses_child1')).rejects.toThrow('Unknown task ID');
  expect(h.get).not.toHaveBeenCalled();
  expect(h.messages).toHaveBeenCalledTimes(1);
  expect(h.messages.mock.calls[0]?.[0]).toMatchObject({
    path: { id: 'parent-1' },
  });
});

test.each([false, true])(
  'pre-index exact ID requires native parent delegation on v2=%s',
  async (v2) => {
    const h = harness(false, false, v2);
    h.parentMessages.mockResolvedValue(parentDelegation(v2));
    if (v2) h.get.mockResolvedValue(v2Host() as never);
    else h.status.mockResolvedValue({ data: { ses_child1: { type: 'idle' } } });
    expect(await h.execute('ses_child1')).toBe('final findings');
    expect(h.get).toHaveBeenCalledTimes(v2 ? 2 : 1);
    expect(h.messages).toHaveBeenCalledTimes(v2 ? 3 : 2);
    expect(h.board.get('ses_child1')).toBeUndefined();
  },
);

test('unindexed alias does not search the parent or the child', async () => {
  const h = harness(false, false, true);
  h.parentMessages.mockResolvedValue(parentDelegation(true));
  await expect(h.execute('exp-1')).rejects.toThrow('Unknown task ID');
  expect(h.messages).not.toHaveBeenCalled();
  expect(h.get).not.toHaveBeenCalled();
});

test('unindexed ID rejects prompt text, foreign agent, and foreground delegation', async () => {
  const h = harness(false, false, true);
  h.parentMessages.mockResolvedValue({
    data: [
      {
        info: { role: 'user' },
        parts: [{ type: 'text', text: 'task_id: ses_child1\nstate: running' }],
      },
    ],
  });
  await expect(h.execute()).rejects.toThrow('Unknown task ID');
  h.parentMessages.mockResolvedValue(parentDelegation(true, 'other'));
  await expect(h.execute()).rejects.toThrow('stored identity');
  h.parentMessages.mockResolvedValue(parentDelegation(true, 'explorer', false));
  await expect(h.execute()).rejects.toThrow('Unknown task ID');
});

test('unindexed ID rejects a foreign host parent before reading child', async () => {
  const h = harness(false, false, true);
  h.parentMessages.mockResolvedValue(parentDelegation(true));
  h.get.mockResolvedValue(v2Host({ parentID: 'foreign' }) as never);
  await expect(h.execute()).rejects.toThrow('stored identity');
  expect(h.messages).toHaveBeenCalledTimes(1);
});

test('indexed v2 cannot infer idle from succeeded outcome and updated time', async () => {
  const h = harness(false, true, true);
  h.get.mockResolvedValue(
    v2Host({ time: { created: 1, updated: 30 } }) as never,
  );
  expect(await h.execute('exp-1')).toContain('state: running (unconfirmed)');
  expect(h.get).toHaveBeenCalledTimes(1);
  expect(h.messages).toHaveBeenCalledTimes(1);
});

test('old succeeded outcome with a completed second run and updated but no idle stays pending', async () => {
  const h = harness(false, true, true);
  h.get.mockResolvedValue(
    v2Host({ time: { created: 1, updated: 60 } }) as never,
  );
  h.messages.mockResolvedValue({
    data: [
      {
        info: { id: 'first-user', role: 'user', time: { created: 2 } },
        parts: [],
      },
      {
        info: {
          id: 'first-answer',
          role: 'assistant',
          finish: 'stop',
          time: { completed: 10 },
        },
        parts: [{ type: 'text', text: 'old answer' }],
      },
      {
        info: { id: 'second-user', role: 'user', time: { created: 35 } },
        parts: [],
      },
      {
        info: {
          id: 'second-answer',
          role: 'assistant',
          finish: 'stop',
          time: { completed: 50 },
        },
        parts: [{ type: 'text', text: 'second answer' }],
      },
      { info: { role: 'system', time: { created: 60 } }, parts: [] },
    ],
  } as never);
  expect(await h.execute()).toContain('state: running (unconfirmed)');
  expect(h.get).toHaveBeenCalledTimes(1);
  expect(h.messages).toHaveBeenCalledTimes(1);
  h.get.mockResolvedValue(
    v2Host({ time: { created: 1, updated: 60, idle: 60 } }) as never,
  );
  expect(await h.execute()).toBe('second answer');
});

test.each([
  { id: 'foreign' },
  { parentID: 'foreign' },
  { agent: 'foreign' },
  { location: { directory: '/foreign' } },
])('indexed v2 second host read rejects identity change %j', async (change) => {
  const h = harness(false, true, true);
  h.get
    .mockResolvedValueOnce(v2Host() as never)
    .mockResolvedValueOnce(v2Host(change) as never);
  await expect(h.execute()).rejects.toThrow('stored identity');
});

test('indexed v2 second host read refuses changed outcome or updated time', async () => {
  const h = harness(false, true, true);
  for (const change of [
    { outcome: 'failed' },
    { time: { created: 1, updated: 31 } },
  ]) {
    h.get
      .mockResolvedValueOnce(v2Host() as never)
      .mockResolvedValueOnce(v2Host(change) as never);
    expect(await h.execute()).toContain('state: running (unconfirmed)');
  }
  h.get
    .mockResolvedValueOnce(v2Host() as never)
    .mockResolvedValueOnce({ error: { name: 'NotFoundError' } } as never);
  await expect(h.execute()).rejects.toThrow('could not be verified');
});

test('indexed v2 second transcript read refuses a new admission', async () => {
  const h = harness(false, true, true);
  h.get.mockResolvedValue(v2Host() as never);
  const first = await h.messages({ path: { id: 'ses_child1' } });
  h.messages.mockClear();
  h.messages.mockResolvedValueOnce(first as never).mockResolvedValueOnce({
    data: [
      ...first.data,
      {
        info: { id: 'second-user', role: 'user', time: { created: 40 } },
        parts: [],
      },
    ],
  } as never);
  expect(await h.execute()).toContain('state: running (unconfirmed)');
  expect(h.messages).toHaveBeenCalledTimes(2);
});

test('indexed v2 second transcript read refuses changed assistant ID', async () => {
  const h = harness(false, true, true);
  h.get.mockResolvedValue(v2Host() as never);
  const first = await h.messages({ path: { id: 'ses_child1' } });
  h.messages.mockClear();
  h.messages.mockResolvedValueOnce(first as never).mockResolvedValueOnce({
    data: first.data.map((message) =>
      message.info.role === 'assistant'
        ? { ...message, info: { ...message.info, id: 'new-assistant' } }
        : message,
    ),
  } as never);
  expect(await h.execute()).toContain('state: running (unconfirmed)');
});

test('indexed alias must match parent and stored agent/directory', async () => {
  const h = harness(false);
  h.lookup.mockImplementation((parent, key) =>
    parent === 'parent-1' && key === 'exp-1'
      ? { ...h.identity, agent: 'other' }
      : undefined,
  );
  h.get.mockResolvedValue({
    data: {
      id: 'ses_child1',
      parentID: 'parent-1',
      agent: 'explorer',
      directory: '/tmp',
    },
  } as never);
  await expect(h.execute('exp-1')).rejects.toThrow('stored identity');
  expect(h.messages).not.toHaveBeenCalled();
  await expect(h.execute('ses_child1')).rejects.toThrow('Unknown task ID');
  h.lookup.mockImplementation((_parent, _key) => ({
    ...h.identity,
    parentSessionID: 'other',
  }));
  await expect(h.execute('exp-1')).rejects.toThrow('stored identity');
  h.lookup.mockImplementation((_parent, _key) => ({
    ...h.identity,
    directory: '/elsewhere',
  }));
  await expect(h.execute('exp-1')).rejects.toThrow('stored identity');
});

test.each([
  { id: 'wrong', parentID: 'parent-1', agent: 'explorer', directory: '/tmp' },
  {
    id: 'ses_child1',
    parentID: 'foreign',
    agent: 'explorer',
    directory: '/tmp',
  },
  { id: 'ses_child1', parentID: 'parent-1', agent: 'other', directory: '/tmp' },
  {
    id: 'ses_child1',
    parentID: 'parent-1',
    agent: 'explorer',
    directory: '/other',
  },
])('indexed orphan refuses mismatched host identity %j', async (data) => {
  const h = harness(false);
  h.get.mockResolvedValue({ data } as never);
  await expect(h.execute()).rejects.toThrow('stored identity');
  expect(h.messages).not.toHaveBeenCalled();
});

test('indexed orphan refuses session.get error envelopes and missing sessions', async () => {
  const h = harness(false);
  h.get.mockResolvedValue({
    error: { name: 'NotFoundError' },
  } as never);
  await expect(h.execute()).rejects.toThrow('could not be verified');
  h.get.mockRejectedValue(new Error('NotFound'));
  await expect(h.execute()).rejects.toThrow('NotFound');
  expect(h.messages).not.toHaveBeenCalled();
});

test.each(['busy', 'retry'])(
  'indexed %s is never returned as final',
  async (type) => {
    const h = harness(false);
    h.status.mockResolvedValue({ data: { ses_child1: { type } } });
    expect(await h.execute()).toContain(
      type === 'busy' ? 'state: running' : 'state: retry',
    );
    expect(h.messages).not.toHaveBeenCalled();
  },
);

test.each([
  ['error envelope', { error: { name: 'Unavailable' } }],
  ['invalid map', { data: { type: 'idle' } }],
  ['malformed child entry', { data: { ses_child1: { type: 'unknown' } } }],
  ['missing data', {}],
] as const)(
  'indexed v1 %s fails closed before and after transcript',
  async (_case, response) => {
    for (const stage of ['before', 'after'] as const) {
      const h = harness(false);
      if (stage === 'before') h.status.mockResolvedValueOnce(response as never);
      else
        h.status
          .mockResolvedValueOnce({ data: {} })
          .mockResolvedValueOnce(response as never);
      expect(await h.execute()).toContain('state: running (unconfirmed)');
      expect(h.messages).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1);
    }
  },
);

test.each(['before', 'after'] as const)(
  'indexed v1 status transport error %s transcript fails closed',
  async (stage) => {
    const h = harness(false);
    if (stage === 'after') h.status.mockResolvedValueOnce({ data: {} });
    h.status.mockRejectedValueOnce(new Error('status unavailable'));
    expect(await h.execute()).toContain('state: running (unconfirmed)');
    expect(h.messages).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1);
  },
);

test.each(['before', 'after'] as const)(
  'indexed v1 timed out status %s transcript fails closed',
  async (stage) => {
    jest.useFakeTimers();
    let release: (() => void) | undefined;
    try {
      const h = harness(false);
      if (stage === 'after') h.status.mockResolvedValueOnce({ data: {} });
      h.status.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ data: {} } as never);
          }),
      );
      const result = h.execute();
      for (
        let i = 0;
        i < 20 && h.status.mock.calls.length < (stage === 'before' ? 1 : 2);
        i++
      )
        await Promise.resolve();
      expect(h.status).toHaveBeenCalledTimes(stage === 'before' ? 1 : 2);
      jest.advanceTimersByTime(5_000);
      expect(await result).toContain('state: running (unconfirmed)');
      expect(h.messages).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1);
    } finally {
      release?.();
      jest.useRealTimers();
    }
  },
);

test.each(['before', 'after'] as const)(
  'indexed v1 open status read %s transcript fails closed',
  async (stage) => {
    const h = harness(false);
    let release: (() => void) | undefined;
    if (stage === 'after') h.status.mockResolvedValueOnce({ data: {} });
    h.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: {} } as never);
        }),
    );
    try {
      if (stage === 'before') void getRuntimeSessionStatusSnapshot(h.input);
      else {
        const transcript = await h.messages({ path: { id: 'ses_child1' } });
        h.messages.mockClear();
        h.messages.mockImplementationOnce(async () => {
          void getRuntimeSessionStatusSnapshot(h.input);
          return transcript;
        });
      }
      expect(await h.execute()).toContain('state: running (unconfirmed)');
      expect(h.messages).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1);
    } finally {
      release?.();
    }
  },
);

test('indexed v2 requires succeeded outcome and bounded idle after final assistant', async () => {
  const h = harness(false, true, true);
  for (const data of [
    { outcome: 'failed', time: { created: 1, idle: 30 } },
    { outcome: 'succeeded', time: { created: 1, idle: 5 } },
    { outcome: 'succeeded', time: { created: 1, idle: 10 } },
    { outcome: 'succeeded', time: { created: 1 } },
    { outcome: 'succeeded', time: { created: 20, idle: 30 } },
  ]) {
    h.get.mockResolvedValue({
      data: {
        id: 'ses_child1',
        parentID: 'parent-1',
        agent: 'explorer',
        directory: '/tmp',
        ...data,
      },
    } as never);
    expect(await h.execute()).toContain('state: running (unconfirmed)');
  }
});

test('indexed orphan never returns earlier answer across a second admission', async () => {
  const h = harness(false, true, true);
  h.messages.mockResolvedValue({
    data: [
      { info: { role: 'user', time: { created: 2 } }, parts: [] },
      {
        info: { role: 'assistant', finish: 'stop', time: { completed: 10 } },
        parts: [{ type: 'text', text: 'old answer' }],
      },
      { info: { role: 'user', time: { created: 15 } }, parts: [] },
      { info: { role: 'assistant' }, parts: [] },
    ],
  } as never);
  expect(await h.execute()).not.toContain('old answer');
  h.messages.mockResolvedValue({
    data: [
      { info: { role: 'user', time: { created: 2 } }, parts: [] },
      {
        info: { role: 'assistant', finish: 'stop', time: { completed: 10 } },
        parts: [{ type: 'text', text: 'old answer' }],
      },
      { info: { role: 'user', time: { created: 35 } }, parts: [] },
      {
        info: { role: 'assistant', finish: 'stop', time: { completed: 40 } },
        parts: [{ type: 'text', text: 'new answer' }],
      },
    ],
  } as never);
  expect(await h.execute()).not.toContain('new answer');
});

test('indexed orphan requires assistant stop and completion timestamp', async () => {
  const h = harness(false, true, true);
  for (const info of [
    { role: 'assistant', finish: 'tool-calls', time: { completed: 10 } },
    { role: 'assistant', finish: 'stop' },
    { role: 'assistant', finish: 'stop', time: { completed: 1 } },
  ]) {
    h.messages.mockResolvedValue({
      data: [
        { info: { role: 'user', time: { created: 2 } }, parts: [] },
        { info, parts: [{ type: 'text', text: 'partial' }] },
      ],
    } as never);
    expect(await h.execute()).not.toContain('partial');
  }
});
