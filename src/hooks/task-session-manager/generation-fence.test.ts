import { describe, expect, mock, test } from 'bun:test';
import {
  FixtureBoard as BackgroundJobBoard,
  createBackgroundJobLifecycle,
} from '../../background-jobs';
import { createTaskSessionManagerHook } from './index';

const PARENT_SESSION_ID = 'parent-generation-fence';

function createHook(board: BackgroundJobBoard) {
  return createTaskSessionManagerHook(
    {
      client: {
        session: { status: mock(async () => ({ data: {} })) },
      },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 2,
      maxRetainedSnapshots: 4,
      backgroundJobs: createBackgroundJobLifecycle({
        backgroundJobBoard: board,
      }),
      shouldManageSession: () => true,
      runtimeStatusReconcileDelayMs: 60_000,
    },
  );
}

function completionPart(taskID: string, occurrenceID: string, result: string) {
  return {
    type: 'text',
    id: occurrenceID,
    synthetic: true,
    text: [
      `<task id="${taskID}" state="completed">`,
      '<summary>Background task completed: delayed result</summary>',
      '<task_result>',
      result,
      '</task_result>',
      '</task>',
    ].join('\n'),
  };
}

function completionMessage(part: ReturnType<typeof completionPart>) {
  return {
    info: {
      role: 'user',
      agent: 'orchestrator',
      sessionID: PARENT_SESSION_ID,
    },
    parts: [part],
  };
}

function ambiguousCompletionPart(
  taskID: string,
  messageID: string,
  result: string,
) {
  return {
    type: 'text',
    synthetic: true,
    messageID,
    text: [
      `<task id="${taskID}" state="completed">`,
      '<summary>Background task completed: delayed result</summary>',
      '<task_result>',
      result,
      '</task_result>',
      '</task>',
    ].join('\n'),
  };
}

describe('task generation fences', () => {
  test('does not apply a terminal part observed before any generation to G2', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const oldCompletion = completionPart(
      'same-task-id',
      'generation-one-completion',
      'G1 result',
    );

    // Runtime observation wins the race before task registration, so no
    // generation can safely be associated with this occurrence.
    await hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: oldCompletion },
      },
    });

    board.registerLaunch({
      taskID: 'same-task-id',
      parentSessionID: PARENT_SESSION_ID,
      agent: 'explorer',
      description: 'G1',
    });
    board.updateStatus({
      taskID: 'same-task-id',
      state: 'completed',
      resultSummary: 'G1 result',
    });
    const generationTwo = board.registerLaunch({
      taskID: 'same-task-id',
      parentSessionID: PARENT_SESSION_ID,
      agent: 'explorer',
      description: 'G2',
    });

    await hook['experimental.chat.messages.transform']({}, {
      messages: [completionMessage(oldCompletion)],
    } as never);

    expect(board.get('same-task-id')).toMatchObject({
      generation: generationTwo.generation,
      state: 'running',
      statusUncertain: true,
      resultSummary: undefined,
    });
  });

  test('does not apply delayed native G1 output after G2 relaunch', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: PARENT_SESSION_ID,
        callID: 'generation-one-call',
      },
      {
        args: {
          subagent_type: 'explorer',
          background: true,
          description: 'G1',
        },
      },
    );
    await hook.event({
      event: {
        type: 'session.created',
        properties: {
          info: {
            id: 'same-task-id',
            parentID: PARENT_SESSION_ID,
            agent: 'explorer',
          },
        },
      },
    });

    const generationOne = board.get('same-task-id');
    if (!generationOne) throw new Error('G1 was not registered');
    board.updateStatus({
      taskID: 'same-task-id',
      state: 'completed',
      resultSummary: 'G1 result',
    });
    const generationTwo = board.registerLaunch({
      taskID: 'same-task-id',
      parentSessionID: PARENT_SESSION_ID,
      agent: 'explorer',
      description: 'G2',
    });

    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: PARENT_SESSION_ID,
        callID: 'generation-one-call',
      },
      {
        output: [
          'task_id: same-task-id',
          'state: completed',
          '',
          '<task_result>',
          'late G1 result',
          '</task_result>',
        ].join('\n'),
      },
    );

    expect(board.get('same-task-id')).toMatchObject({
      generation: generationTwo.generation,
      state: 'running',
      resultSummary: undefined,
    });
    expect(generationTwo.generation).toBe(generationOne.generation + 1);
  });

  test('keeps an interleaved old completion fail-closed with multiple ambiguous origins', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const terminalListener = mock(() => {});
    board.addTerminalStateListener(terminalListener);

    board.registerLaunch({
      taskID: 'same-task-id',
      parentSessionID: PARENT_SESSION_ID,
      agent: 'explorer',
      description: 'G1',
    });
    const oldCompletion = ambiguousCompletionPart(
      'same-task-id',
      'generation-one-part-a',
      'G1 result A',
    );
    await hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: oldCompletion },
      },
    });

    const generationTwo = board.registerLaunch({
      taskID: 'same-task-id',
      parentSessionID: PARENT_SESSION_ID,
      agent: 'explorer',
      description: 'G2',
    });
    const delayedOldCompletion = ambiguousCompletionPart(
      'same-task-id',
      'generation-one-part-b',
      'G1 result B',
    );
    await hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: delayedOldCompletion },
      },
    });

    await hook['experimental.chat.messages.transform']({}, {
      messages: [completionMessage(oldCompletion)],
    } as never);

    expect(board.get('same-task-id')).toMatchObject({
      generation: generationTwo.generation,
      state: 'running',
      statusUncertain: true,
      resultSummary: undefined,
      terminalUnreconciled: false,
    });
    expect(terminalListener).not.toHaveBeenCalled();
  });
});
