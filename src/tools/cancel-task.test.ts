import { afterEach, describe, expect, mock, test } from 'bun:test';
import { parseTaskStatusOutput } from '../utils';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createCancelTaskTool } from './cancel-task';

let mockClient: Record<string, unknown>;

mock.module('../utils/opencode-client', () => ({
  getClient: () => mockClient,
}));

function createTool(overrides?: {
  abort?: () => Promise<unknown>;
  status?: () => Promise<unknown>;
  shouldManageSession?: (sessionID: string) => boolean;
}) {
  const board = new BackgroundJobBoard();
  const abort = mock(overrides?.abort ?? (async () => ({})));
  const status = mock(
    overrides?.status ?? (async () => ({ data: { ses_1: { type: 'idle' } } })),
  );
  const deleteSession = mock(async () => ({}));
  mockClient = {
    session: { abort, status, delete: deleteSession },
  };
  const tools = createCancelTaskTool({
    input: { directory: '/test/project' } as any,
    backgroundJobBoard: board,
    shouldManageSession: overrides?.shouldManageSession ?? (() => true),
    verifyAbortMs: 10,
    abortRetryIntervalMs: 0,
    stableStoppedMs: 0,
  });
  return { board, abort, status, deleteSession, taskCancel: tools.task_cancel };
}

const context = { sessionID: 'parent-1', agent: 'orchestrator' } as any;

afterEach(() => mock.restore());

describe('task_cancel tool', () => {
  test('aborts and verifies quiescence without deleting the retained session', async () => {
    const { board, abort, status, deleteSession, taskCancel } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const output = await taskCancel.execute(
      { task_id: 'ses_1', reason: 'obsolete' },
      context,
    );

    expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(status).toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(parseTaskStatusOutput(String(output))).toMatchObject({
      taskID: 'ses_1',
      state: 'cancelled',
      result: 'cancelled: obsolete',
    });
    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      terminalUnreconciled: true,
    });
  });

  test('verifies quiescence via host session info when the status map is unavailable (v2)', async () => {
    // v2 hosts expose no session.status map; the old verify loop polled a
    // source that can never answer 'idle' and always threw "did not stay
    // stopped" — even after a confirmed abort. Verification must fall back
    // to the host session info (terminal outcome / fresh idle timestamp).
    const board = new BackgroundJobBoard();
    const abort = mock(async () => ({}));
    const getSession = mock(async () => ({
      data: { outcome: 'interrupted', time: { idle: Date.now() } },
    }));
    mockClient = {
      session: { abort, get: getSession, delete: mock(async () => ({})) },
    };
    const tools = createCancelTaskTool({
      input: { directory: '/test/project' } as any,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      verifyAbortMs: 10,
      abortRetryIntervalMs: 0,
      stableStoppedMs: 0,
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const output = await tools.task_cancel.execute(
      { task_id: 'ses_1', reason: 'obsolete' },
      context,
    );

    expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(getSession).toHaveBeenCalled();
    expect(parseTaskStatusOutput(String(output))).toMatchObject({
      taskID: 'ses_1',
      state: 'cancelled',
    });
  });

  test('an unrecognized outcome string needs idle evidence to confirm cancellation (v2)', async () => {
    // P2 review on #1161: only the known terminal outcomes (succeeded/
    // failed/interrupted) confirm quiescence on their own. A malformed or
    // future nonterminal value must fall through to the idle-timestamp
    // evidence instead of blindly confirming the cancel.
    const run = async (idleAt: number | undefined) => {
      const board = new BackgroundJobBoard();
      const abort = mock(async () => ({}));
      const getSession = mock(async () => ({
        data: { outcome: 'some-new-nonterminal-value', time: { idle: idleAt } },
      }));
      mockClient = {
        session: { abort, get: getSession, delete: mock(async () => ({})) },
      };
      const tools = createCancelTaskTool({
        input: { directory: '/test/project' } as any,
        backgroundJobBoard: board,
        shouldManageSession: () => true,
        verifyAbortMs: 10,
        abortRetryIntervalMs: 0,
        stableStoppedMs: 0,
      });
      board.registerLaunch({
        taskID: 'ses_1',
        parentSessionID: 'parent-1',
        agent: 'explorer',
      });
      return tools.task_cancel.execute(
        { task_id: 'ses_1', reason: 'obsolete' },
        context,
      );
    };

    // Fresh idle timestamp (at/after abort) → confirmed via idle evidence.
    const confirmed = await run(Date.now() + 5_000);
    expect(parseTaskStatusOutput(String(confirmed))).toMatchObject({
      taskID: 'ses_1',
      state: 'cancelled',
    });

    // Stale idle timestamp → cannot verify → the cancel surfaces the
    // uncertain-running result instead of confirming.
    const unverified = await run(Date.now() - 60_000);
    expect(parseTaskStatusOutput(String(unverified))).toMatchObject({
      taskID: 'ses_1',
      state: 'running',
    });
  });

  test('retains the session and leaves it resumable after acknowledgement', async () => {
    const { board, deleteSession, taskCancel } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    await taskCancel.execute({ task_id: 'ses_1' }, context);
    board.markReconciled('ses_1');

    expect(board.get('ses_1')).toMatchObject({
      taskID: 'ses_1',
      state: 'reconciled',
      terminalState: 'cancelled',
    });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(board.acquireRelaunchLease('ses_1', 1)).toBeDefined();
  });

  test('returns an uncertain running result when quiescence cannot be verified', async () => {
    const { board, taskCancel } = createTool({
      status: async () => ({ data: { ses_1: { type: 'busy' } } }),
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const output = await taskCancel.execute({ task_id: 'ses_1' }, context);

    expect(String(output)).toContain('state: running');
    expect(board.get('ses_1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
  });

  test('rejects foreign, stale, and unsafe cancellation requests', async () => {
    const { board, abort, taskCancel } = createTool();
    board.registerLaunch({
      taskID: 'ses_foreign',
      parentSessionID: 'parent-2',
      agent: 'explorer',
    });
    board.registerLaunch({
      taskID: 'ses_done',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({ taskID: 'ses_done', state: 'completed' });

    const foreign = await taskCancel.execute(
      { task_id: 'ses_foreign' },
      context,
    );
    const stale = await taskCancel.execute({ task_id: 'ses_done' }, context);
    const parent = await taskCancel.execute(
      { task_id: 'ses_parent' },
      { ...context, sessionID: 'ses_parent' },
    );

    expect(abort).not.toHaveBeenCalled();
    expect(String(foreign)).toContain('state: unknown');
    expect(String(stale)).toContain('stale/uncertain cancellation');
    expect(String(parent)).toContain('cannot cancel parent session');
  });

  test('enforces orchestrator ownership', async () => {
    const { taskCancel } = createTool({ shouldManageSession: () => false });

    await expect(
      taskCancel.execute({ task_id: 'ses_1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('orchestrator sessions');
    await expect(
      taskCancel.execute({ task_id: 'ses_1' }, {
        sessionID: 'parent-1',
        agent: 'fixer',
      } as any),
    ).rejects.toThrow('orchestrator');
  });
});
