import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils';
import { createTaskSessionManagerHook } from './index';

const PARENT = 'parent-1';
const CHILD = 'child-1';

function createHook(board: BackgroundJobBoard) {
  return createTaskSessionManagerHook(
    { client: { session: {} } } as never,
    {
      maxSessionsPerAgent: 2,
      maxRetainedSnapshots: 2,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    },
  );
}

/**
 * An assistant message with a task tool part, mirroring the shape opencode
 * writes when a foreground task tool call fails. For the false-cancel bug,
 * opencode writes status:"error" + error:"Tool execution failed: Task cancelled"
 * (prompt.ts:414-428), with state.metadata.sessionId pointing at the child
 * session (task.ts:188-195 via ctx.metadata).
 */
function taskErrorPart(
  callID: string,
  childSessionId: string,
  errorMsg = 'Tool execution failed: Task cancelled',
) {
  return {
    info: {
      role: 'assistant',
      agent: 'orchestrator',
      sessionID: PARENT,
      id: callID,
    },
    parts: [
      { type: 'text', text: ' ' },
      {
        type: 'tool',
        tool: 'task',
        callID,
        state: {
          status: 'error',
          error: errorMsg,
          metadata: { sessionId: childSessionId },
        },
      },
    ],
  };
}

function userMessage(id: string, text: string) {
  return {
    info: { role: 'user', agent: 'orchestrator', sessionID: PARENT, id },
    parts: [{ type: 'text', text }],
  };
}

function findTaskPart(messages: unknown[], callID: string) {
  for (const message of messages as { parts?: any[] }[]) {
    for (const part of message?.parts ?? []) {
      if (part?.type === 'tool' && part?.tool === 'task' && part?.callID === callID) {
        return part;
      }
    }
  }
  return undefined;
}

async function transform(hook: ReturnType<typeof createTaskSessionManagerHook>, history: unknown[]) {
  const request = { messages: structuredClone(history) };
  await hook['experimental.chat.messages.transform']({}, request as never);
  return request.messages;
}

function setupCompletedBoard(board: BackgroundJobBoard) {
  board.registerLaunch({
    taskID: CHILD,
    parentSessionID: PARENT,
    agent: 'fixer',
    description: 'test fix',
  });
  board.updateStatus({
    taskID: CHILD,
    state: 'completed',
    resultSummary: 'patched src/foo.ts',
  });
}

describe('reconcileFallbackFalseCancel', () => {
  test('rewrites false-cancelled error part to completed when board has completed truth', async () => {
    const board = new BackgroundJobBoard();
    setupCompletedBoard(board);
    const hook = createHook(board);

    const history = [
      userMessage('u1', 'fix the bug'),
      taskErrorPart('call-1', CHILD),
    ];

    const result = await transform(hook, history);
    const part = findTaskPart(result, 'call-1') as any;

    expect(part.state.status).toBe('completed');
    expect(part.state.error).toBeUndefined();
    expect(part.state.output).toContain('state="completed"');
    expect(part.state.output).toContain('Background task completed: test fix');
    expect(part.state.output).toContain('patched src/foo.ts');
  });

  test('rewrites false-cancelled error part to error when board has error truth', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: CHILD,
      parentSessionID: PARENT,
      agent: 'fixer',
      description: 'test fix',
    });
    board.updateStatus({
      taskID: CHILD,
      state: 'error',
      resultSummary: 'syntax error in foo.ts',
    });
    const hook = createHook(board);

    const history = [
      userMessage('u1', 'fix the bug'),
      taskErrorPart('call-1', CHILD),
    ];

    const result = await transform(hook, history);
    const part = findTaskPart(result, 'call-1') as any;

    expect(part.state.status).toBe('error');
    expect(part.state.error).toBeUndefined();
    expect(part.state.output).toContain('state="error"');
    expect(part.state.output).toContain('Background task failed: test fix');
    expect(part.state.output).toContain('syntax error in foo.ts');
  });

  test('does NOT rewrite when board is cancelled (preserves true user cancel)', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: CHILD,
      parentSessionID: PARENT,
      agent: 'fixer',
      description: 'test fix',
    });
    board.markCancelled(CHILD, 'user requested');
    board.markReconciled(CHILD);
    const hook = createHook(board);

    const history = [
      userMessage('u1', 'fix the bug'),
      taskErrorPart('call-1', CHILD),
    ];

    const result = await transform(hook, history);
    const part = findTaskPart(result, 'call-1') as any;

    // True cancel: board terminalState is cancelled, not completed/error.
    // Part stays as the original error.
    expect(part.state.status).toBe('error');
    expect(part.state.error).toContain('cancelled');
  });

  test('does NOT rewrite when board is still running (no truth yet)', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: CHILD,
      parentSessionID: PARENT,
      agent: 'fixer',
      description: 'test fix',
    });
    // board stays running — model 2 hasn't completed yet
    const hook = createHook(board);

    const history = [
      userMessage('u1', 'fix the bug'),
      taskErrorPart('call-1', CHILD),
    ];

    const result = await transform(hook, history);
    const part = findTaskPart(result, 'call-1') as any;

    expect(part.state.status).toBe('error');
    expect(part.state.error).toContain('cancelled');
  });

  test('does NOT rewrite error parts whose message is not a task cancellation', async () => {
    const board = new BackgroundJobBoard();
    setupCompletedBoard(board);
    const hook = createHook(board);

    // A genuine tool error (not a cancellation) must be left intact.
    const history = [
      userMessage('u1', 'fix the bug'),
      taskErrorPart('call-1', CHILD, 'Tool execution failed: timeout'),
    ];

    const result = await transform(hook, history);
    const part = findTaskPart(result, 'call-1') as any;

    expect(part.state.status).toBe('error');
    expect(part.state.error).toBe('Tool execution failed: timeout');
  });

  test('is idempotent across consecutive transforms', async () => {
    const board = new BackgroundJobBoard();
    setupCompletedBoard(board);
    const hook = createHook(board);

    const history = [
      userMessage('u1', 'fix the bug'),
      taskErrorPart('call-1', CHILD),
    ];

    const first = await transform(hook, history);
    const firstOutput = findTaskPart(first, 'call-1').state.output;

    const second = await transform(hook, history);
    const secondOutput = findTaskPart(second, 'call-1').state.output;

    expect(secondOutput).toBe(firstOutput);
  });

  test('does not touch non-task tool parts', async () => {
    const board = new BackgroundJobBoard();
    setupCompletedBoard(board);
    const hook = createHook(board);

    const history = [
      userMessage('u1', 'fix the bug'),
      {
        info: { role: 'assistant', agent: 'orchestrator', sessionID: PARENT, id: 'call-2' },
        parts: [
          { type: 'text', text: ' ' },
          {
            type: 'tool',
            tool: 'read',
            callID: 'call-2',
            state: {
              status: 'error',
              error: 'Tool execution failed: Task cancelled',
              metadata: { sessionId: CHILD },
            },
          },
        ],
      },
    ];

    const result = await transform(hook, history);
    const part = result[1].parts[1] as any;

    // read tool parts are not reconciled by the task-session-manager.
    expect(part.state.status).toBe('error');
    expect(part.state.error).toContain('cancelled');
  });
});
