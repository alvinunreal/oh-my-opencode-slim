import { describe, expect, mock, test } from 'bun:test';
import {
  BackgroundJobBoard,
  createBackgroundJobLifecycle,
} from '../background-jobs';
import { createAliasAuthority } from '../hooks/task-session-manager/session-recovery';
import { createTaskStatusTool } from './task-status';

const asJobs = (board: BackgroundJobBoard) =>
  createBackgroundJobLifecycle({ backgroundJobBoard: board });

let client: Record<string, any>;

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
    backgroundJobs: asJobs(options.board),
    now: options.now,
    statusTimeoutMs: options.statusTimeoutMs,
    readTimeoutMs: options.readTimeoutMs,
    resolveCanonicalTaskRef: options.resolveCanonicalTaskRef,
  });
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
    expect(output).toContain('task_result');
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
