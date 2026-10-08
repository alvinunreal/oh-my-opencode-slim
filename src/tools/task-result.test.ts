import { afterEach, expect, mock, test } from 'bun:test';
import {
  BackgroundJobBoard,
  type BackgroundJobTerminalGate,
  createBackgroundJobLifecycle,
  createBackgroundJobTerminalGate,
} from '../background-jobs';
import { buildPluginInput } from '../v2/client-shim';
import { createTaskResultTool } from './task-result';

const gates: BackgroundJobTerminalGate[] = [];
afterEach(() => {
  for (const gate of gates.splice(0)) gate.dispose();
});
function harness(tracked = true, hostFlavor?: string) {
  const board = new BackgroundJobBoard();
  const run = tracked
    ? board.registerLaunch({
        taskID: 'ses_child1',
        parentSessionID: 'parent-1',
        agent: 'explorer',
        now: 0,
      })
    : undefined;
  const get = mock(async () => ({ data: { parentID: 'parent-1' } }));
  const status = mock(async () => ({ data: {} }));
  const messages = mock(async () => ({
    data: [
      {
        info: { role: 'assistant', finish: 'stop', time: { completed: 10 } },
        parts: [{ type: 'text', text: 'final findings' }],
      },
    ],
  }));
  const input = {
    directory: '/tmp',
    client: { session: { get, status, messages } },
    ...(hostFlavor ? { hostFlavor } : {}),
  } as never;
  const gate = createBackgroundJobTerminalGate({
    backgroundJobBoard: board,
    input,
    graceMs: 0,
  });
  gates.push(gate);
  const tool = createTaskResultTool({
    input,
    backgroundJobs: createBackgroundJobLifecycle({
      backgroundJobBoard: board,
      gate,
    }),
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
    tool,
    execute,
    settle,
    input,
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
  await expect(h.execute()).rejects.toThrow('does not belong');
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
test('untracked quiescent session still requires a terminal assistant segment', async () => {
  const h = harness(false);
  h.messages.mockResolvedValue({
    data: [
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'partial' }],
      },
    ],
  } as never);
  await expect(h.execute()).rejects.toThrow('no terminal evidence');
});
test('an untracked v1 compaction round does not replace the final result', async () => {
  const h = harness(false);
  const { data } = await h.messages();
  h.messages.mockResolvedValue({
    data: [
      ...data,
      { info: { role: 'user' }, parts: [{ type: 'compaction', auto: false }] },
      {
        info: { role: 'assistant', summary: true, finish: 'stop' },
        parts: [{ type: 'text', text: 'COMPACTION-SUMMARY' }],
      },
    ],
  } as never);
  expect(await h.execute()).toContain('final findings');
});
test.each([
  ['finished', 'succeeded', 'final findings'],
  ['still running', undefined, 'running (unconfirmed)'],
])(
  'untracked v2 %s child is classified from its context',
  async (_, outcome, expected) => {
    // The v2 shim has no session.status; the context's idle marker ends a round.
    const context = mock(async () => [
      { id: 'u1', type: 'user', text: 'ask', time: { created: 1 } },
      {
        id: 'a1',
        type: 'assistant',
        text: 'final findings',
        time: { created: 2 },
      },
      ...(outcome
        ? [{ id: 'i1', type: 'idle', outcome, time: { created: 3 } }]
        : []),
    ]);
    const input = buildPluginInput({
      session: { get: async () => ({ parentID: 'parent-1' }), context },
    } as never) as never;
    const output = await createTaskResultTool({
      input,
      backgroundJobs: createBackgroundJobLifecycle({
        backgroundJobBoard: new BackgroundJobBoard(),
      }),
    }).task_result.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as never);
    expect(String(output)).toContain(expected);
    expect(context).toHaveBeenCalledTimes(1);
  },
);
test('unknown alias and empty task id are rejected', async () => {
  const h = harness();
  await expect(h.execute('exp-99')).rejects.toThrow('Unknown task ID');
  await expect(h.execute(' ')).rejects.toThrow('requires task_id');
});

test('v2 exposes sessionID, accepts the task_id alias, and emits a sessionID label', async () => {
  const h = harness(true, 'v2');
  expect(Object.keys(h.tool.args)).toContain('sessionID');
  expect(Object.keys(h.tool.args)).toContain('task_id');

  await h.settle('completed');
  const context = {
    sessionID: 'parent-1',
    agent: 'orchestrator',
  } as never;
  expect(await h.tool.execute({ sessionID: 'exp-1' }, context)).toBe(
    'final findings',
  );
  expect(await h.tool.execute({ task_id: 'exp-1' }, context)).toBe(
    'final findings',
  );
});

test('v2 emits sessionID: in pending output and rejects an empty identifier', async () => {
  const h = harness(true, 'v2');
  h.status.mockResolvedValue({ data: { ses_child1: { type: 'busy' } } });
  const context = {
    sessionID: 'parent-1',
    agent: 'orchestrator',
  } as never;

  const output = await h.tool.execute({ sessionID: 'exp-1' }, context);
  expect(String(output)).toContain('sessionID: ses_child1');
  await expect(h.tool.execute({ sessionID: ' ' }, context)).rejects.toThrow(
    'requires sessionID',
  );
});

test('v1 keeps the task_id schema and label', async () => {
  const h = harness();
  expect(Object.keys(h.tool.args)).toEqual(['task_id']);
  h.status.mockResolvedValue({ data: { ses_child1: { type: 'busy' } } });
  const output = await h.tool.execute({ task_id: 'exp-1' }, {
    sessionID: 'parent-1',
    agent: 'orchestrator',
  } as never);
  expect(String(output)).toContain('task_id: ses_child1');
});
