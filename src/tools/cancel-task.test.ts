import { describe, expect, mock, test } from 'bun:test';
import { parseTaskStatusOutput } from '../utils';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createCancelTaskTool } from './cancel-task';

function createTool(overrides?: {
  abort?: () => Promise<unknown>;
  shouldManageSession?: (sessionID: string) => boolean;
  abortTimeoutMs?: number;
}) {
  const board = new BackgroundJobBoard();
  const abort = mock(overrides?.abort ?? (async () => ({})));
  const tools = createCancelTaskTool({
    client: { session: { abort } } as any,
    backgroundJobBoard: board,
    shouldManageSession: overrides?.shouldManageSession ?? (() => true),
    abortTimeoutMs: overrides?.abortTimeoutMs,
  });

  return { board, abort, cancelTask: tools.cancel_task };
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

  test('does not abort unknown or wrong-parent tasks', async () => {
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

  test('does not abort already terminal jobs', async () => {
    const { board, abort, cancelTask } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });

    const output = await cancelTask.execute({ task_id: 'ses_1' }, context);

    expect(abort).not.toHaveBeenCalled();
    expect(String(output)).toContain('state: completed');
    expect(board.get('ses_1')).toMatchObject({ state: 'completed' });
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
    expect(String(output)).toContain('state: reconciled');
  });

  test('does not mark cancelled when abort fails', async () => {
    const { board, abort, cancelTask } = createTool({
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

    expect(abort).toHaveBeenCalledTimes(1);
    expect(String(output)).toContain('state: cancel_error');
    expect(board.get('ses_1')).toMatchObject({ state: 'running' });
  });

  test('marks timeout as terminal error to avoid ghost running jobs', async () => {
    const { board, cancelTask } = createTool({
      abort: () => new Promise(() => {}),
      abortTimeoutMs: 1,
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });

    const output = await cancelTask.execute({ task_id: 'ses_1' }, context);

    expect(String(output)).toContain('state: error');
    expect(parseTaskStatusOutput(String(output))).toMatchObject({
      taskID: 'ses_1',
      state: 'error',
    });
    expect(board.get('ses_1')).toMatchObject({
      state: 'error',
      terminalUnreconciled: true,
    });
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
