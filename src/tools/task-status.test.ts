import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createAliasAuthority } from '../hooks/task-session-manager/session-recovery';
import { BackgroundJobBoard } from '../utils/background-job-board';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
} from '../utils/background-job-terminal-gate';
import { buildPluginInput } from '../v2/client-shim';
import { createTaskStatusTool } from './task-status';

let client: Record<string, any>;
const statusGates: BackgroundJobTerminalGate[] = [];
afterEach(() => {
  for (const gate of statusGates.splice(0)) gate.dispose();
});

function makeTool(options: {
  board: BackgroundJobBoard;
  now?: () => number;
  statusTimeoutMs?: number;
  readTimeoutMs?: number;
  hostFlavor?: string;
  resolveCanonicalTaskRef?: (
    parentSessionID: string,
    requested: string,
  ) => Promise<
    { kind: 'exact'; taskID: string } | { kind: 'refused'; reason: string }
  >;
}) {
  return createTaskStatusTool({
    input: {
      directory: '/test',
      client,
      ...(options.hostFlavor ? { hostFlavor: options.hostFlavor } : {}),
    } as any,
    backgroundJobBoard: options.board,
    now: options.now,
    statusTimeoutMs: options.statusTimeoutMs,
    readTimeoutMs: options.readTimeoutMs,
    resolveCanonicalTaskRef: options.resolveCanonicalTaskRef,
  });
}

/**
 * Result-mode harness: mirrors the settled-terminal fixtures the deleted
 * task-result suite used — a tracked launch plus an explicit terminal gate
 * so `settle` publishes terminal state before the result read.
 */
function makeResultTool(
  tracked = true,
  hostFlavor?: string,
  options?: { readTimeoutMs?: number },
) {
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
  statusGates.push(gate);
  const { task_status } = createTaskStatusTool({
    input,
    backgroundJobBoard: board,
    terminalGate: gate,
    readTimeoutMs: options?.readTimeoutMs,
  });
  const execute = (task_id = tracked ? 'exp-1' : 'ses_child1') =>
    task_status.execute({ task_id, result: true }, {
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
    tool: task_status,
    execute,
    settle,
    input,
  };
}

describe('task_status', () => {
  test('reads a child status without prompting it', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
    });
    const status = mock(async () => ({
      data: { ses_child1: { type: 'busy' } },
    }));
    client = { session: { status } };
    const { task_status } = makeTool({ board });

    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: busy');
    expect(output).toContain(
      '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
    );
    expect(status).toHaveBeenCalledTimes(1);
  });

  test('includes guidance for active states (retry, running)', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
    });
    const status = mock(async () => ({
      data: { ses_child1: { type: 'retry' } },
    }));
    client = { session: { status } };
    const { task_status } = makeTool({ board });

    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: retry');
    expect(output).toContain(
      '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
    );
  });

  test('flags a busy child without recent activity as possibly stuck', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'busy' } },
        })),
      },
    };
    const { task_status } = makeTool({ board, now: () => 120_000 });
    await expect(
      task_status.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-1',
      } as any),
    ).resolves.toContain('possibly_stuck: true');
  });

  test('surfaces a failed status read as explicit uncertainty, not a confident board fallback', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    client = {
      session: {
        status: mock(async () => {
          throw new Error('host status read failed');
        }),
      },
    };
    const { task_status } = makeTool({ board, now: () => 120_000 });
    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: running (unconfirmed)');
    expect(output).toContain('status_uncertain: true');
    expect(output).toContain('last_status_error: host status read failed');
    expect(output).not.toContain('[guidance]: The task is still running.');
    // An uncertain board fallback must never drive an automatic nudge.
    expect(output).toContain('possibly_stuck: false');
  });

  test('treats a malformed live status entry as uncertain', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'weird-state' } },
        })),
      },
    };
    const { task_status } = makeTool({ board, now: () => 120_000 });
    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: running (unconfirmed)');
    expect(output).toContain('status_uncertain: true');
    expect(output).toContain(
      'last_status_error: malformed live status entry for session',
    );
    expect(output).not.toContain('[guidance]: The task is still running.');
    expect(output).toContain('possibly_stuck: false');
  });

  test('bounds a hanging status read with a timeout and reports uncertainty', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    client = {
      session: {
        // Responds far slower than the bounded read allows; the 20ms race
        // timer must reject first so the tool cannot hang on a stuck host.
        status: mock(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ data: { ses_child1: { type: 'busy' } } }),
                200,
              ),
            ),
        ),
      },
    };
    const { task_status } = makeTool({ board, statusTimeoutMs: 20 });
    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('status_uncertain: true');
    expect(output).toContain('last_status_error');
    expect(output).toContain('timed out');
    expect(output).not.toContain('[guidance]: The task is still running.');
    expect(output).toContain('possibly_stuck: false');
  });

  test('reports an absent session in a valid map as uncertain', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    client = { session: { status: mock(async () => ({ data: {} })) } };
    const { task_status } = makeTool({ board, now: () => 120_000 });
    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: running (unconfirmed)');
    expect(output).toContain('status_uncertain: true');
    expect(output).toContain(
      'last_status_error: no live status entry for session',
    );
    expect(output).not.toContain('[guidance]: The task is still running.');
    expect(output).toContain('possibly_stuck: false');
  });

  test('rejects a task id owned by a different parent', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
    });
    const { task_status } = makeTool({ board });
    await expect(
      task_status.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-2',
      } as any),
    ).rejects.toThrow('Unknown task ID or alias');
  });

  test('v2 exposes sessionID and accepts the task_id alias', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
    });
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'busy' } },
        })),
      },
    };
    const { task_status } = makeTool({ board, hostFlavor: 'v2' });

    expect(Object.keys(task_status.args)).toContain('sessionID');

    const viaNative = await task_status.execute({ sessionID: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(viaNative).toContain('state: busy');
    const viaAlias = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(viaAlias).toContain('state: busy');

    await expect(
      task_status.execute({ sessionID: ' ' }, { sessionID: 'parent-1' } as any),
    ).rejects.toThrow('requires sessionID');
  });
});

describe('task_status untracked read-only fallback', () => {
  const KID = 'ses_lostchild';

  /** v1 transcript evidence shape for one finished child round. */
  function childTranscript(state: 'completed' | 'incomplete') {
    const messages: any[] = [
      {
        info: { id: 'msg_user', role: 'user', time: { created: 10 } },
        parts: [{ type: 'text', text: 'ask' }],
      },
    ];
    if (state === 'completed') {
      messages.push({
        info: {
          id: 'msg_turn',
          role: 'assistant',
          finish: 'stop',
          time: { created: 11, completed: 12 },
        },
        parts: [{ type: 'text', text: 'LAB-MARKER: done' }],
      });
    } else {
      messages.push({
        info: { id: 'msg_turn', role: 'assistant', time: { created: 11 } },
        parts: [{ type: 'text', text: 'partial' }],
      });
    }
    return { data: messages };
  }

  function hostClient(options?: {
    parent?: string;
    transcript?: 'completed' | 'incomplete';
    liveStatus?: Record<string, { type: string }>;
    omitGet?: boolean;
  }) {
    return {
      session: {
        ...(options?.omitGet
          ? {}
          : {
              get: mock(async () => ({
                data: {
                  id: KID,
                  parentID: options?.parent ?? 'parent-1',
                  agent: 'fixer',
                  time: { created: 100, updated: 200 },
                },
              })),
            }),
        status: mock(async () => ({ data: options?.liveStatus ?? {} })),
        messages: mock(async () =>
          childTranscript(options?.transcript ?? 'completed'),
        ),
      },
    };
  }

  test('an untracked owned exact id reports verified completion (v1)', async () => {
    client = hostClient({ transcript: 'completed' });
    const { task_status } = makeTool({ board: new BackgroundJobBoard() });
    const output = await task_status.execute({ task_id: KID }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('not tracked by the local background job board');
    expect(output).toContain('state: completed (verified from history)');
    expect(output).toContain('agent: fixer');
    expect(output).toContain('result: true');
    // Read-only: nothing was registered on the board.
    expect(client.session.get).toHaveBeenCalledTimes(1);
  });

  test('an untracked owned exact id reports uncertain incomplete state (v2)', async () => {
    client = hostClient({ transcript: 'incomplete' });
    const { task_status } = makeTool({
      board: new BackgroundJobBoard(),
      hostFlavor: 'v2',
    });
    const output = await task_status.execute({ task_id: KID }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: running-or-incomplete (uncertain');
    expect(output).not.toContain('The task is still running.');
  });

  test('a v1 live busy map reports live running without board adoption', async () => {
    client = hostClient({
      transcript: 'incomplete',
      liveStatus: { [KID]: { type: 'busy' } },
    });
    const board = new BackgroundJobBoard();
    const { task_status } = makeTool({ board });
    const output = await task_status.execute({ task_id: KID }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: busy (live)');
    expect(output).toContain('[guidance]: The task is still running.');
    expect(board.get(KID)).toBeUndefined();
  });

  test('a session owned by another parent refuses', async () => {
    client = hostClient({ parent: 'parent-2' });
    const { task_status } = makeTool({ board: new BackgroundJobBoard() });
    await expect(
      task_status.execute({ task_id: KID }, { sessionID: 'parent-1' } as any),
    ).rejects.toThrow('does not belong to this session');
  });

  test('a non-exact alias that resolves nowhere still refuses', async () => {
    client = hostClient();
    const { task_status } = makeTool({ board: new BackgroundJobBoard() });
    await expect(
      task_status.execute({ task_id: 'fix-9' }, {
        sessionID: 'parent-1',
      } as any),
    ).rejects.toThrow('Unknown task ID or alias: fix-9');
  });

  test('an alias resolved by resolveCanonical but not on the board uses the fallback', async () => {
    client = hostClient({ transcript: 'completed' });
    // The parent history pairs fix-1 with KID through a marker on a
    // native background plaintext launch sentence.
    const backgroundText =
      `The subagent is working in the background (sessionID: ${KID}). ` +
      'You will be notified automatically when it finishes.';
    const marker = `<!-- slim-child-ref:v1 ${JSON.stringify({
      parentSessionID: 'parent-1',
      agent: 'fixer',
      alias: 'fix-1',
      sessionID: KID,
    })} -->`;
    const marked = `${backgroundText}\n${marker}`;
    const parentHistory = {
      data: [
        {
          info: { id: 'msg_u', role: 'user', time: { created: 10 } },
          parts: [{ type: 'text', text: 'ask' }],
        },
        {
          info: {
            id: 'msg_a',
            role: 'assistant',
            time: { created: 20, completed: 30 },
          },
          parts: [
            {
              type: 'tool',
              tool: 'task',
              state: {
                status: 'completed',
                input: {
                  subagent_type: 'fixer',
                  description: 'd',
                  prompt: 'p',
                  background: true,
                },
                output: marked,
                time: { start: 21, end: 29 },
              },
            },
          ],
        },
      ],
    };
    client.session.messages = mock(async (args: { path?: { id?: string } }) =>
      args.path?.id === 'parent-1'
        ? parentHistory
        : childTranscript('completed'),
    );
    const board = new BackgroundJobBoard();
    const authority = createAliasAuthority({
      input: { directory: '/test', client } as never,
      board,
    });
    expect(await authority.resolveCanonical('parent-1', 'fix-1')).toEqual({
      kind: 'exact',
      taskID: KID,
    });
    const { task_status } = makeTool({
      board,
      resolveCanonicalTaskRef: authority.resolveCanonical,
    });
    const output = await task_status.execute({ task_id: 'fix-1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain(KID);
    expect(output).toContain('not tracked by the local background job board');
    expect(output).toContain('state: completed (verified from history)');
    expect(board.get(KID)).toBeUndefined();
  });

  test('a failed v1 live status read reports unknown, not history completion', async () => {
    client = hostClient({ transcript: 'completed' });
    client.session.status = mock(async () => {
      throw new Error('status unavailable');
    });
    const { task_status } = makeTool({ board: new BackgroundJobBoard() });
    const output = await task_status.execute({ task_id: KID }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: unknown (uncertain; live status');
    expect(output).not.toContain('completed (verified from history)');
    expect(client.session.messages).not.toHaveBeenCalled();
  });

  test('held untracked host reads are aborted at their deadline', async () => {
    const signals: AbortSignal[] = [];
    const held = (args: { signal?: AbortSignal }) => {
      if (args.signal) signals.push(args.signal);
      return new Promise(() => {});
    };
    client = hostClient({ transcript: 'completed' });
    client.session.messages = mock(held);
    const { task_status } = makeTool({
      board: new BackgroundJobBoard(),
      readTimeoutMs: 20,
    });
    const output = await task_status.execute({ task_id: KID }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('(uncertain; transcript could not be read)');
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);

    signals.length = 0;
    client.session.get = mock(held);
    await expect(
      task_status.execute({ task_id: KID }, { sessionID: 'parent-1' } as any),
    ).rejects.toThrow(`Unknown task ID or alias: ${KID}`);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  test('the host session creation time is labeled as creation, not activity', async () => {
    client = hostClient({ transcript: 'completed' });
    const { task_status } = makeTool({ board: new BackgroundJobBoard() });
    const output = await task_status.execute({ task_id: KID }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain(`created_at: ${new Date(100).toISOString()}`);
    expect(output).not.toContain('last_activity_at');
  });

  test('without session.get the untracked path keeps the unknown error', async () => {
    client = hostClient({ omitGet: true });
    const { task_status } = makeTool({ board: new BackgroundJobBoard() });
    await expect(
      task_status.execute({ task_id: KID }, { sessionID: 'parent-1' } as any),
    ).rejects.toThrow(`Unknown task ID or alias: ${KID}`);
  });
});

describe('task_status result mode', () => {
  test('retrieves full confirmed text without prompting or resuming', async () => {
    const h = makeResultTool();
    await h.settle('completed');
    h.messages.mockClear();
    expect(await h.execute()).toBe('final findings');
    expect(h.messages).toHaveBeenCalledTimes(1);
    expect(h.board.get(h.run.taskID)?.lastUsedAt).toBeGreaterThan(0);
  });
  test('only the last assistant segment is retrieved', async () => {
    const h = makeResultTool();
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
        const h = makeResultTool();
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
  test.each(['busy', 'retry'])(
    'preserves live %s presentation without reading result',
    async (type) => {
      const h = makeResultTool();
      h.status.mockResolvedValue({ data: { ses_child1: { type } } });
      expect(await h.execute()).toContain(
        type === 'retry' ? 'state: retry' : 'state: running',
      );
      expect(h.messages).not.toHaveBeenCalled();
      expect(h.status).toHaveBeenCalledTimes(1);
    },
  );
  test('valid idle with pending transcript is pending, not a terminal result', async () => {
    const h = makeResultTool();
    h.status.mockResolvedValue({ data: { ses_child1: { type: 'idle' } } });
    h.messages.mockResolvedValue({
      data: [{ info: { role: 'assistant' }, parts: [] }],
    } as never);
    expect(await h.execute()).toContain('state: pending');
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
  });
  test('unknown status remains running without reading transcript', async () => {
    const h = makeResultTool();
    h.status.mockRejectedValue(new Error('unavailable'));
    expect(await h.execute()).toContain('state: running (unconfirmed)');
    expect(h.messages).not.toHaveBeenCalled();
  });
  test.each(['error', 'cancelled', 'stopped'] as const)(
    'quiescent %s is rejected only after checking activity',
    async (state) => {
      const h = makeResultTool();
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
  test('acknowledged completed result stays retrievable on matching evidence', async () => {
    const h = makeResultTool();
    await h.settle('completed', true);
    expect(await h.execute()).toBe('final findings');
  });
  test('generation change during evidence lookup never returns the old result', async () => {
    const h = makeResultTool();
    h.messages.mockImplementation(async () => {
      h.board.registerLaunch({ ...h.run, now: 100 });
      return {
        data: [
          {
            info: {
              role: 'assistant',
              finish: 'stop',
              time: { completed: 10 },
            },
            parts: [{ type: 'text', text: 'old result' }],
          },
        ],
      };
    });
    await expect(h.execute()).rejects.toThrow('changed generation');
  });
  test('ownership mismatch cannot expose a child result', async () => {
    const h = makeResultTool(false);
    h.get.mockResolvedValue({ data: { parentID: 'other' } });
    await expect(h.execute()).rejects.toThrow('does not belong');
    expect(h.messages).not.toHaveBeenCalled();
  });
  test.each(['busy', 'retry'])(
    'untracked live %s returns status without a transcript',
    async (type) => {
      const h = makeResultTool(false);
      h.status.mockResolvedValue({ data: { ses_child1: { type } } });
      expect(await h.execute()).toContain(
        'retry task_status with { result: true } after the task finishes',
      );
      expect(h.messages).not.toHaveBeenCalled();
    },
  );
  test('untracked quiescent session still requires a terminal assistant segment', async () => {
    const h = makeResultTool(false);
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
  test('held untracked transcript reads are aborted at their deadline', async () => {
    const signals: AbortSignal[] = [];
    const held = (args: { signal?: AbortSignal }) => {
      if (args.signal) signals.push(args.signal);
      return new Promise(() => {});
    };
    const h = makeResultTool(false, undefined, { readTimeoutMs: 20 });
    h.messages.mockImplementation(held as never);
    await expect(h.execute()).rejects.toThrow(
      'child transcript read timed out',
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });
  test.each([
    ['finished', 'succeeded', 'final findings'],
    ['still running', undefined, 'running (unconfirmed)'],
  ])(
    'untracked v2 %s child is classified from its context',
    async (_, outcome, expected) => {
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
        session: {
          get: async () => ({
            parentID: 'parent-1',
            ...(outcome ? { outcome, time: { idle: 3 } } : {}),
          }),
          context,
        },
      } as never) as never;
      const output = await createTaskStatusTool({
        input,
        backgroundJobBoard: new BackgroundJobBoard(),
      }).task_status.execute({ task_id: 'ses_child1', result: true }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as never);
      expect(String(output)).toContain(expected);
      expect(context).toHaveBeenCalledTimes(1);
    },
  );
  test('unknown alias and empty task id are rejected', async () => {
    const h = makeResultTool();
    await expect(h.execute('exp-99')).rejects.toThrow('Unknown task ID');
    await expect(
      h.tool.execute({ task_id: ' ', result: true }, {
        sessionID: 'parent-1',
      } as any),
    ).rejects.toThrow('requires task_id');
  });
  test('v2 accepts the sessionID and task_id spellings in result mode', async () => {
    const h = makeResultTool(true, 'v2');
    expect(Object.keys(h.tool.args)).toContain('sessionID');
    expect(Object.keys(h.tool.args)).toContain('task_id');
    expect(Object.keys(h.tool.args)).toContain('result');
    await h.settle('completed');
    const context = {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as never;
    expect(
      await h.tool.execute({ sessionID: 'exp-1', result: true }, context),
    ).toBe('final findings');
    expect(
      await h.tool.execute({ task_id: 'exp-1', result: true }, context),
    ).toBe('final findings');
  });
  test('v2 emits sessionID: in pending result output and rejects an empty identifier', async () => {
    const h = makeResultTool(true, 'v2');
    h.status.mockResolvedValue({ data: { ses_child1: { type: 'busy' } } });
    const context = {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as never;
    const output = await h.tool.execute(
      { sessionID: 'exp-1', result: true },
      context,
    );
    expect(String(output)).toContain('sessionID: ses_child1');
    await expect(
      h.tool.execute({ sessionID: ' ', result: true }, context),
    ).rejects.toThrow('requires sessionID');
  });
  test('status mode is unchanged when result is absent or false', async () => {
    const h = makeResultTool();
    h.status.mockResolvedValue({ data: { ses_child1: { type: 'busy' } } });
    for (const extra of [{}, { result: false }]) {
      const output = await h.tool.execute({ task_id: 'exp-1', ...extra }, {
        sessionID: 'parent-1',
      } as any);
      expect(String(output)).toContain('Task exp-1 (ses_child1)');
      expect(String(output)).toContain('state: busy');
    }
  });
});
