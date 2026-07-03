import { describe, expect, mock, test } from 'bun:test';
import { parseTaskStatusOutput } from '../utils';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createCancelTaskTool } from './cancel-task';

function createTool(overrides?: {
  abort?: () => Promise<unknown>;
  delete?: () => Promise<unknown>;
  get?: () => Promise<unknown>;
  status?: () => Promise<unknown>;
  includeDelete?: boolean;
  shouldManageSession?: (sessionID: string) => boolean;
  abortTimeoutMs?: number;
  verifyAbortMs?: number;
  abortRetryIntervalMs?: number;
  stableStoppedMs?: number;
  deleteVerifyMs?: number;
  deleteStableStoppedMs?: number;
}) {
  const board = new BackgroundJobBoard();
  const abort = mock(overrides?.abort ?? (async () => ({})));
  const deleteSession = mock(overrides?.delete ?? (async () => ({})));
  const get = mock(
    overrides?.get ?? (async () => ({ data: { parentID: 'parent-1' } })),
  );
  const status = mock(overrides?.status ?? (async () => ({ data: {} })));
  const session: Record<string, unknown> = { abort, get, status };
  if (overrides?.includeDelete !== false) session.delete = deleteSession;
  const tools = createCancelTaskTool({
    client: { session } as any,
    backgroundJobBoard: board,
    shouldManageSession: overrides?.shouldManageSession ?? (() => true),
    abortTimeoutMs: overrides?.abortTimeoutMs,
    verifyAbortMs: overrides?.verifyAbortMs ?? 1,
    abortRetryIntervalMs: overrides?.abortRetryIntervalMs ?? 0,
    stableStoppedMs: overrides?.stableStoppedMs ?? 0,
    deleteVerifyMs: overrides?.deleteVerifyMs ?? 1,
    deleteStableStoppedMs: overrides?.deleteStableStoppedMs ?? 0,
  });

  return {
    board,
    abort,
    deleteSession,
    get,
    status,
    cancelTask: tools.cancel_task,
  };
}

const context = { sessionID: 'parent-1', agent: 'orchestrator' } as any;

describe('cancel_task tool', () => {
  test('cancels a tracked running task by task ID', async () => {
    const { board, abort, cancelTask } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const output = await cancelTask.execute(
      { task_id: 'ses_1', reason: 'obsolete' },
      context,
    );

    expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(String(output)).toContain('state: cancelled');
    expect(String(output)).toContain('cancelled: obsolete');
    expect(parseTaskStatusOutput(String(output))).toMatchObject({
      taskID: 'ses_1',
      state: 'cancelled',
      result: 'cancelled: obsolete',
    });
    expect(board.get('ses_1')).toMatchObject({ state: 'cancelled' });
  });

  test('cancels a tracked running task by parent-scoped alias', async () => {
    const { board, abort, cancelTask } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });

    await cancelTask.execute({ task_id: 'ora-1' }, context);

    expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
  });

  test('does not abort raw session IDs tracked by a different parent', async () => {
    const { board, abort, cancelTask } = createTool();
    board.registerLaunch({
      taskID: 'ses_2',
      parentSessionID: 'parent-2',
      agent: 'fixer',
    });

    const output = await cancelTask.execute({ task_id: 'ses_2' }, context);

    expect(abort).not.toHaveBeenCalled();
    expect(String(output)).toContain('state: unknown');
  });

  test('does not abort unknown aliases', async () => {
    const { abort, cancelTask } = createTool();

    const output = await cancelTask.execute({ task_id: 'fix-99' }, context);

    expect(abort).not.toHaveBeenCalled();
    expect(String(output)).toContain('state: unknown');
  });

  test('aborts tracked jobs regardless of current board state', async () => {
    const { board, abort, cancelTask } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });

    const output = await cancelTask.execute({ task_id: 'ses_1' }, context);

    expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(String(output)).toContain('state: cancelled');
    expect(board.get('ses_1')).toMatchObject({ state: 'cancelled' });
  });

  test('aborts owned raw session IDs when job board lost the task', async () => {
    const { abort, cancelTask } = createTool();

    const output = await cancelTask.execute(
      { task_id: 'ses_lost', reason: 'stop ghost worker' },
      context,
    );

    expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_lost' } });
    expect(String(output)).toContain('state: cancelled');
    expect(String(output)).toContain('cancelled: stop ghost worker');
  });

  test('does not abort raw session ID without metadata ownership', async () => {
    const { abort, cancelTask } = createTool({
      get: async () => ({ data: { parentID: 'other-parent' } }),
    });

    const output = await cancelTask.execute({ task_id: 'ses_lost' }, context);

    expect(abort).not.toHaveBeenCalled();
    expect(String(output)).toContain('state: unknown');
  });

  test('does not abort the parent session ID', async () => {
    const { abort, cancelTask } = createTool();

    const output = await cancelTask.execute(
      { task_id: 'ses_parent' },
      { ...context, sessionID: 'ses_parent' },
    );

    expect(abort).not.toHaveBeenCalled();
    expect(String(output)).toContain('state: unknown');
  });

  test('still aborts stale cancelled jobs', async () => {
    const { board, abort, cancelTask } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'cancelled' });

    const output = await cancelTask.execute(
      { task_id: 'ses_1', reason: 'stop ghost worker' },
      context,
    );

    expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(String(output)).toContain('state: cancelled');
  });

  test('still aborts reconciled stale cancellations', async () => {
    const { board, abort, cancelTask } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'cancelled' });
    board.markReconciled('ses_1');

    const output = await cancelTask.execute(
      { task_id: 'ses_1', reason: 'stop ghost worker' },
      context,
    );

    expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(String(output)).toContain('state: cancelled');
  });

  test('does not terminalize board when abort fails without delete', async () => {
    const { board, abort, cancelTask } = createTool({
      includeDelete: false,
      abort: async () => {
        throw new Error('abort failed');
      },
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });

    const output = await cancelTask.execute({ task_id: 'ses_1' }, context);

    expect(abort).toHaveBeenCalled();
    expect(String(output)).toContain('state: running');
    expect(board.get('ses_1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
      statusUncertain: true,
    });
  });

  test('deletes session when abort fails but delete succeeds', async () => {
    const { board, abort, deleteSession, cancelTask } = createTool({
      abort: async () => {
        throw new Error('abort failed');
      },
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });

    const output = await cancelTask.execute({ task_id: 'ses_1' }, context);

    expect(abort).toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(String(output)).toContain('state: cancelled');
    expect(board.get('ses_1')).toMatchObject({ state: 'cancelled' });
  });

  test('treats delete not-found as success when status is missing', async () => {
    const { board, deleteSession, cancelTask } = createTool({
      delete: async () => {
        throw new Error('not found');
      },
      status: async () => ({ data: {} }),
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });

    const output = await cancelTask.execute({ task_id: 'ses_1' }, context);

    expect(deleteSession).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(String(output)).toContain('state: cancelled');
    expect(board.get('ses_1')).toMatchObject({ state: 'cancelled' });
  });

  test('keeps running/status uncertain when delete fails and status stays busy', async () => {
    const { board, deleteSession, cancelTask } = createTool({
      delete: async () => {
        throw new Error('delete failed');
      },
      status: async () => ({ data: { ses_1: { type: 'busy' } } }),
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });

    const output = await cancelTask.execute({ task_id: 'ses_1' }, context);

    expect(deleteSession).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(String(output)).toContain('state: running');
    expect(board.get('ses_1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      terminalUnreconciled: false,
    });
  });

  test('keeps running/status uncertain when abort times out without delete', async () => {
    const { board, cancelTask } = createTool({
      includeDelete: false,
      abort: () => new Promise(() => {}),
      abortTimeoutMs: 1,
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });

    const output = await cancelTask.execute({ task_id: 'ses_1' }, context);

    expect(String(output)).toContain('state: running');
    expect(parseTaskStatusOutput(String(output))).toMatchObject({
      taskID: 'ses_1',
      state: 'running',
    });
    expect(board.get('ses_1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
      statusUncertain: true,
    });
  });

  test('deletes session when abort returns but session stays busy', async () => {
    let deleted = false;
    const { board, abort, deleteSession, cancelTask } = createTool({
      delete: async () => {
        deleted = true;
        return {};
      },
      status: async () =>
        deleted ? { data: {} } : { data: { ses_1: { type: 'busy' } } },
      verifyAbortMs: 1,
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });

    const output = await cancelTask.execute({ task_id: 'ses_1' }, context);

    expect(abort).toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(String(output)).toContain('state: cancelled');
    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      terminalUnreconciled: true,
      cancellationRequested: true,
    });
  });

  test('deletes and marks cancelled when session idles then becomes busy', async () => {
    let deleted = false;
    const statuses = [{ data: {} }, { data: { ses_1: { type: 'busy' } } }];
    const { board, abort, deleteSession, cancelTask } = createTool({
      delete: async () => {
        deleted = true;
        return {};
      },
      status: async () =>
        deleted ? { data: {} } : (statuses.shift() ?? { data: {} }),
      verifyAbortMs: 10,
      abortRetryIntervalMs: 0,
      stableStoppedMs: 2,
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });

    const output = await cancelTask.execute({ task_id: 'ses_1' }, context);

    expect(abort).toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(String(output)).toContain('state: cancelled');
    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      cancellationRequested: true,
      terminalUnreconciled: true,
    });
  });

  test('deletes session when board observes busy after abort despite idle status map', async () => {
    let deleted = false;
    const { board, deleteSession, cancelTask } = createTool({
      delete: async () => {
        deleted = true;
        return {};
      },
      status: async () => (deleted ? { data: {} } : { data: {} }),
      verifyAbortMs: 20,
      abortRetryIntervalMs: 1,
      stableStoppedMs: 10,
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      now: Date.now() - 1000,
    });

    queueMicrotask(() => board.markRunningFromLiveSession('ses_1'));

    const output = await cancelTask.execute({ task_id: 'ses_1' }, context);

    expect(deleteSession).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(String(output)).toContain('state: cancelled');
    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      cancellationRequested: true,
    });
  });

  test('marks cancelled when session disappears from status map', async () => {
    const { board, abort, cancelTask } = createTool({
      status: async () => ({ data: {} }),
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });

    const output = await cancelTask.execute({ task_id: 'ses_1' }, context);

    expect(abort).toHaveBeenCalled();
    expect(String(output)).toContain('state: cancelled');
    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      cancellationRequested: true,
    });
  });

  test('cancelSessionByID returns state: error when abort throws non-SessionStillRunningError, even if board shows running', async () => {
    const { board, abort, cancelTask } = createTool({
      includeDelete: false,
      abort: async () => {
        throw new Error('network timeout');
      },
    });
    // Register a running job so that isRunning(taskID) would be true
    // if the function incorrectly checks it.
    board.registerLaunch({
      taskID: 'ses_running',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    // Override resolve to return undefined, forcing the cancelSessionByID
    // raw session path instead of the tracked task path.
    board.resolve = mock(() => undefined);

    const output = await cancelTask.execute(
      { task_id: 'ses_running', reason: 'regression guard' },
      context,
    );

    expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_running' } });
    // cancelSessionByID must return state: error for non-SessionStillRunningError,
    // NOT state: running (which would happen if || isRunning() were present).
    expect(String(output)).toContain('state: error');
    expect(String(output)).not.toContain('state: running');
  });

  test('denies non-orchestrator agents', async () => {
    const { cancelTask } = createTool();

    await expect(
      cancelTask.execute({ task_id: 'ses_1' }, {
        sessionID: 'parent-1',
        agent: 'fixer',
      } as any),
    ).rejects.toThrow('orchestrator');
  });

  test('denies unmanaged sessions', async () => {
    const { cancelTask } = createTool({ shouldManageSession: () => false });

    await expect(
      cancelTask.execute({ task_id: 'ses_1' }, context),
    ).rejects.toThrow('orchestrator sessions');
  });
});
