import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { COMPLETED_WITHOUT_TEXT_DIAGNOSTIC } from '../../utils/task';
import { updateBackgroundJobFromOutput } from './status-utils';

function harness() {
  const board = new BackgroundJobBoard();
  board.registerLaunch({
    taskID: 'child-1',
    parentSessionID: 'parent-1',
    agent: 'explorer',
    description: 'trace bug',
  });
  const taskContextTracker = {
    pendingManagedTaskIds: new Set<string>(),
    contextFilesForPrompt: () => [],
    prune: mock(() => {}),
  };
  return { board, taskContextTracker };
}

describe('updateBackgroundJobFromOutput', () => {
  test('does not enter completed from an empty completed status', () => {
    const { board, taskContextTracker } = harness();
    const updated = updateBackgroundJobFromOutput(
      [
        'task_id: child-1',
        'state: completed',
        '',
        '<task_result>',
        '</task_result>',
      ].join('\n'),
      board,
      taskContextTracker,
    );

    expect(updated).toMatchObject({
      state: 'error',
      resultSummary: COMPLETED_WITHOUT_TEXT_DIAGNOSTIC,
    });
    expect(board.get('child-1')?.state).not.toBe('completed');
  });

  test('records completed when the status carries result text', () => {
    const { board, taskContextTracker } = harness();
    const updated = updateBackgroundJobFromOutput(
      [
        'task_id: child-1',
        'state: completed',
        '',
        '<task_result>',
        'final findings',
        '</task_result>',
      ].join('\n'),
      board,
      taskContextTracker,
    );

    expect(updated).toMatchObject({
      state: 'completed',
      resultSummary: 'final findings',
    });
  });
});
