import { describe, expect, mock, test } from 'bun:test';
import {
  type BackgroundJobAdoptionEvidence,
  BackgroundJobBoard,
} from '../utils/background-job-board';
import type { TaskControlRecovery } from './task-control-recovery';
import { createTaskControlRecovery } from './task-control-recovery';
import { createTaskMessageTool } from './task-message';
import { createTaskReviveTool } from './task-revive';
import { createTaskStatusTool } from './task-status';

let client: Record<string, any>;
mock.module('../utils/opencode-client', () => ({ getClient: () => client }));

function makeTool(options: {
  board: BackgroundJobBoard;
  now?: () => number;
  statusTimeoutMs?: number;
  identityIndex?: any;
  recovery?: TaskControlRecovery;
}) {
  return createTaskStatusTool({
    input: { directory: '/test' } as any,
    backgroundJobBoard: options.board,
    now: options.now,
    statusTimeoutMs: options.statusTimeoutMs,
    identityIndex: options.identityIndex,
    recovery: options.recovery,
  });
}

const adoptedIdentity = {
  parentSessionID: 'parent-1',
  taskID: 'host-child',
  agent: 'explorer',
  alias: 'exp-8',
  description: 'host task',
  background: true,
} as const;

const acknowledgedCompleted = {
  kind: 'terminal',
  state: 'completed',
  resultSummary: 'host result',
  completedAt: 250,
  acknowledged: true,
} as const;

async function readAdoptedStatus(
  evidence: BackgroundJobAdoptionEvidence,
  status: () => unknown,
  options?: { now?: number; statusTimeoutMs?: number },
) {
  const board = new BackgroundJobBoard();
  const job = board.adoptExistingSession(adoptedIdentity, evidence);
  client = { session: { status: mock(status) } };
  const { task_status } = makeTool({
    board,
    now: () => options?.now ?? 120_000,
    statusTimeoutMs: options?.statusTimeoutMs,
  });
  const output = await task_status.execute({ task_id: job.taskID }, {
    sessionID: 'parent-1',
  } as any);
  return { output, job };
}

const recoveredIdentity = {
  parentSessionID: 'parent-1',
  taskID: 'ses_orphan',
  agent: 'fixer',
  alias: 'fix-1',
  directory: '/test',
};

const recoveredParent = {
  data: [
    {
      info: { id: 'call', role: 'assistant', sessionID: 'parent-1' },
      parts: [
        {
          type: 'tool',
          name: 'task',
          state: {
            input: { subagent_type: 'fixer', background: true },
            output: 'task_id: ses_orphan\nstate: running',
          },
        },
      ],
    },
  ],
};

describe('task_status', () => {
  test('adopts an exact orphan alias and reports recovered live state', async () => {
    const board = new BackgroundJobBoard();
    client = {
      session: {
        messages: mock(async ({ path }: { path: { id: string } }) =>
          path.id === 'parent-1' ? recoveredParent : { data: [] },
        ),
        get: mock(async () => ({
          data: {
            id: 'ses_orphan',
            parentID: 'parent-1',
            directory: '/test',
          },
        })),
        status: mock(async () => ({
          data: { ses_orphan: { type: 'busy' } },
        })),
      },
    };
    const { task_status } = makeTool({
      board,
      identityIndex: { lookup: () => recoveredIdentity },
    });

    const output = await task_status.execute({ task_id: 'fix-1' }, {
      sessionID: 'parent-1',
    } as any);

    expect(output).toContain('state: busy');
    expect(output).toContain('recovered: true');
    expect(board.resolve('parent-1', 'fix-1')).toMatchObject({
      taskID: 'ses_orphan',
    });
  });

  test('reads an exact orphan session ID read-only without an identity index', async () => {
    const board = new BackgroundJobBoard();
    client = {
      session: {
        messages: mock(async ({ path }: { path: { id: string } }) =>
          path.id === 'parent-1' ? recoveredParent : { data: [] },
        ),
        get: mock(async () => ({
          data: {
            id: 'ses_orphan',
            parentID: 'parent-1',
            directory: '/test',
          },
        })),
        status: mock(async () => ({
          data: { ses_orphan: { type: 'busy' } },
        })),
      },
    };
    const { task_status } = makeTool({ board });

    const output = await task_status.execute({ task_id: 'ses_orphan' }, {
      sessionID: 'parent-1',
    } as any);

    expect(output).toContain('Task ses_orphan (ses_orphan)');
    expect(output).toContain('state: busy');
    expect(output).toContain('recovered: true');
    expect(output).toContain('read_only: true');
    expect(output).toContain('control_operations: blocked');
    expect(board.resolve('parent-1', 'ses_orphan')).toBeUndefined();
  });

  test('keeps exact orphan controls blocked after a read-only status lookup', async () => {
    const board = new BackgroundJobBoard();
    client = {
      session: {
        messages: mock(async ({ path }: { path: { id: string } }) =>
          path.id === 'parent-1' ? recoveredParent : { data: [] },
        ),
        get: mock(async () => ({
          data: {
            id: 'ses_orphan',
            parentID: 'parent-1',
            directory: '/test',
          },
        })),
        status: mock(async () => ({
          data: { ses_orphan: { type: 'busy' } },
        })),
      },
    };
    const input = { directory: '/test' } as any;
    const recovery = createTaskControlRecovery({
      input,
      backgroundJobBoard: board,
    });
    const { task_status } = makeTool({ board, recovery });
    const { task_message } = createTaskMessageTool({
      input,
      backgroundJobBoard: board,
      recovery,
    });
    const { task_revive } = createTaskReviveTool({
      input,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      revivedRunTracker: {} as any,
      recovery,
    });

    await expect(
      task_status.execute({ task_id: 'ses_orphan' }, {
        sessionID: 'parent-1',
      } as any),
    ).resolves.toContain('read_only: true');
    expect(board.resolve('parent-1', 'ses_orphan')).toBeUndefined();
    await expect(
      task_message.execute({ task_id: 'ses_orphan', message: 'hello' }, {
        sessionID: 'parent-1',
      } as any),
    ).rejects.toThrow('orphan recovery is not safe');
    await expect(
      task_revive.execute({ task_id: 'ses_orphan', prompt: 'continue' }, {
        sessionID: 'parent-1',
      } as any),
    ).rejects.toThrow('orphan recovery is not safe');
  });

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

  test('confirms a terminal board state when a valid status map omits the session', async () => {
    const cases: Array<{
      evidence: BackgroundJobAdoptionEvidence;
      state: string;
    }> = [
      { evidence: acknowledgedCompleted, state: 'reconciled' },
      {
        evidence: { ...acknowledgedCompleted, acknowledged: false },
        state: 'completed',
      },
      {
        evidence: {
          ...acknowledgedCompleted,
          state: 'error',
          acknowledged: false,
        },
        state: 'error',
      },
      {
        evidence: {
          ...acknowledgedCompleted,
          state: 'cancelled',
          acknowledged: false,
        },
        state: 'cancelled',
      },
      {
        evidence: {
          kind: 'stopped',
          resultSummary: 'host observed stop without result',
          completedAt: 250,
        },
        state: 'stopped',
      },
    ];

    for (const { evidence, state } of cases) {
      const { output, job } = await readAdoptedStatus(evidence, async () => ({
        data: {},
      }));
      expect(job.state).toBe(state);
      expect(output).toContain(`state: ${state}\n`);
      expect(output).not.toContain('status_uncertain');
      expect(output).not.toContain('no live status entry');
      expect(output).not.toContain('state: idle');
      expect(output).toContain('possibly_stuck: false');
    }
  });

  test('keeps a reconciled record unconfirmed when the status read throws', async () => {
    const { output } = await readAdoptedStatus(
      acknowledgedCompleted,
      async () => {
        throw new Error('host status read failed');
      },
    );
    expect(output).toContain('state: reconciled (unconfirmed)');
    expect(output).toContain('status_uncertain: true');
    expect(output).toContain('last_status_error: host status read failed');
    expect(output).toContain('possibly_stuck: false');
  });

  test('keeps a reconciled record unconfirmed when the live entry is malformed', async () => {
    const { output } = await readAdoptedStatus(
      acknowledgedCompleted,
      async () => ({
        data: { 'host-child': { type: 'weird-state' } },
      }),
    );
    expect(output).toContain('state: reconciled (unconfirmed)');
    expect(output).toContain('status_uncertain: true');
    expect(output).toContain(
      'last_status_error: malformed live status entry for session',
    );
    expect(output).not.toContain('state: idle');
    expect(output).toContain('possibly_stuck: false');
  });

  test('keeps a reconciled record unconfirmed when the status read times out', async () => {
    const { output } = await readAdoptedStatus(
      acknowledgedCompleted,
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ data: { 'host-child': { type: 'idle' } } }),
            200,
          ),
        ),
      { statusTimeoutMs: 20 },
    );
    expect(output).toContain('state: reconciled (unconfirmed)');
    expect(output).toContain('status_uncertain: true');
    expect(output).toContain('last_status_error');
    expect(output).toContain('timed out');
    expect(output).not.toContain('state: idle');
    expect(output).toContain('possibly_stuck: false');
  });

  test('prefers live busy, retry, and idle over a terminal board record', async () => {
    for (const live of ['busy', 'retry', 'idle'] as const) {
      const { output } = await readAdoptedStatus(
        acknowledgedCompleted,
        async () => ({
          data: { 'host-child': { type: live } },
        }),
      );
      expect(output).toContain(`state: ${live}\n`);
      expect(output).not.toContain('state: reconciled');
      expect(output).not.toContain('status_uncertain');
      expect(output).not.toContain('no live status entry');
    }
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
});
