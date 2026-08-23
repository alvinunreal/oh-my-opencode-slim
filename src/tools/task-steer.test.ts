import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createRevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createCancelTaskTool } from './cancel-task';
import { createTaskSteerTool } from './task-steer';

let mockClient: Record<string, unknown>;

mock.module('../utils/opencode-client', () => ({
  getClient: () => mockClient,
}));

function createTool(overrides?: {
  abort?: () => Promise<unknown>;
  status?: () => Promise<unknown>;
  promptAsync?: () => Promise<unknown>;
}) {
  const board = new BackgroundJobBoard();
  const abort = mock(overrides?.abort ?? (async () => ({})));
  const status = mock(
    overrides?.status ?? (async () => ({ data: { ses_1: { type: 'idle' } } })),
  );
  const promptAsync = mock(overrides?.promptAsync ?? (async () => ({})));
  mockClient = { session: { abort, status, promptAsync } };
  const revivedRunTracker = createRevivedRunTracker({
    input: { directory: '/test/project' } as never,
    backgroundJobBoard: board,
  });
  const tools = createTaskSteerTool({
    input: { directory: '/test/project' } as never,
    backgroundJobBoard: board,
    shouldManageSession: () => true,
    verifyAbortMs: 10,
    abortRetryIntervalMs: 0,
    stableStoppedMs: 0,
    revivedRunTracker,
  });
  const cancelTools = createCancelTaskTool({
    input: { directory: '/test/project' } as never,
    backgroundJobBoard: board,
    shouldManageSession: () => true,
    verifyAbortMs: 10,
    abortRetryIntervalMs: 0,
    stableStoppedMs: 0,
  });
  return {
    board,
    abort,
    promptAsync,
    taskCancel: cancelTools.task_cancel,
    taskSteer: tools.task_steer,
  };
}

const context = { sessionID: 'parent-1', agent: 'orchestrator' } as never;

function registerRunning(board: BackgroundJobBoard, taskID = 'ses_1') {
  board.registerLaunch({
    taskID,
    parentSessionID: 'parent-1',
    agent: 'explorer',
  });
}

function acknowledgedCompleted(board: BackgroundJobBoard, taskID = 'ses_1') {
  registerRunning(board, taskID);
  board.updateStatus({ taskID, state: 'completed', resultSummary: 'done' });
  board.markReconciled(taskID);
}

afterEach(() => mock.restore());

describe('task_steer tool', () => {
  test('interrupts a running child and relaunches it in the same session with the steering instruction', async () => {
    const events: string[] = [];
    const { board, abort, promptAsync, taskSteer } = createTool({
      abort: async () => {
        events.push('abort');
        return {};
      },
      promptAsync: async () => {
        events.push('promptAsync');
        return {};
      },
    });
    registerRunning(board);

    const output = await taskSteer.execute(
      { task_id: 'ses_1', prompt: 'Skip the review, focus on tests' },
      context,
    );

    expect(events).toEqual(['abort', 'promptAsync']);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      query: { directory: '/test/project' },
      body: {
        agent: 'explorer',
        parts: [
          {
            type: 'text',
            text: 'The orchestrator has interrupted this task to redirect it. Steer the current work as follows:\n\nSkip the review, focus on tests',
          },
        ],
      },
    });
    // Session retained: same taskID, new generation, still tracked as running.
    expect(board.get('ses_1')).toMatchObject({
      generation: 2,
      state: 'running',
    });
    expect(String(output)).toContain('state: running');
    expect(String(output)).toContain('status: started');
  });

  test('is a no-op for a finished child and points at task_revive', async () => {
    const { board, abort, promptAsync, taskSteer } = createTool();
    acknowledgedCompleted(board);

    const output = await taskSteer.execute(
      { task_id: 'ses_1', prompt: 'irrelevant' },
      context,
    );

    expect(abort).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
    expect(String(output)).toContain('status: no-op');
    expect(String(output)).toContain('task_revive');
    // The record must indeed be untouched.
    expect(board.get('ses_1')).toMatchObject({ generation: 1 });
  });

  test('is a no-op for a cancelled child', async () => {
    const { board, promptAsync, taskCancel, taskSteer } = createTool();
    registerRunning(board);
    await taskCancel.execute({ task_id: 'ses_1', reason: 'obsolete' }, context);

    const callsBefore = promptAsync.mock.calls.length;
    const output = await taskSteer.execute(
      { task_id: 'ses_1', prompt: 'irrelevant' },
      context,
    );

    expect(promptAsync.mock.calls.length).toBe(callsBefore);
    expect(String(output)).toContain('state: cancelled');
    expect(String(output)).toContain('status: no-op');
  });

  test('surfaces abort failure without relaunching', async () => {
    const { board, abort, promptAsync, taskSteer } = createTool({
      abort: async () => {
        throw new Error('abort denied');
      },
    });
    registerRunning(board);

    await expect(
      taskSteer.execute({ task_id: 'ses_1', prompt: 'redirect' }, context),
    ).rejects.toThrow('abort denied');
    expect(abort).toHaveBeenCalledTimes(1);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('rejects unknown tasks, empty args, and non-orchestrator callers', async () => {
    const { taskSteer } = createTool();
    await expect(
      taskSteer.execute({ task_id: 'ses_missing', prompt: 'x' }, context),
    ).rejects.toThrow('Unknown or unowned');
    await expect(
      taskSteer.execute({ task_id: 'ses_1', prompt: '  ' }, context),
    ).rejects.toThrow('task_steer requires prompt');
    await expect(
      taskSteer.execute({ task_id: 'ses_1', prompt: 'x' }, {
        sessionID: 'parent-1',
        agent: 'explorer',
      } as never),
    ).rejects.toThrow('task_steer can only be used by orchestrator');
  });
});
