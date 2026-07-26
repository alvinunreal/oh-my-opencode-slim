import { describe, expect, test, mock } from 'bun:test';
import { BackgroundJobBoard } from '../../utils';
import { createTaskSessionManagerHook } from './index';

const PARENT = 'parent-1';
const CHILD = 'child-1';

function taskCompletedPart(
  callID: string,
  childSessionId: string,
  resultText = '',
) {
  const tag = 'task_result';
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
          status: 'completed',
          output: [
            `<task id="${childSessionId}" state="completed">`,
            `<${tag}>`,
            resultText,
            `</${tag}>`,
            '</task>',
          ].join('\n'),
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

async function transform(
  hook: ReturnType<typeof createTaskSessionManagerHook>,
  history: unknown[],
) {
  const request = { messages: structuredClone(history) };
  await hook['experimental.chat.messages.transform']({}, request as never);
  return request.messages;
}

function setupCompletedBoard(board: BackgroundJobBoard, description = 'test task') {
  board.registerLaunch({
    taskID: CHILD,
    parentSessionID: PARENT,
    agent: 'fixer',
    description,
  });
}

function mockClient(childMessages: Array<{ info?: { role: string }; parts?: Array<{ type: string; text?: string }> }>) {
  return {
    session: {
      messages: mock(async () => ({ data: childMessages })),
      status: mock(async () => ({ data: {} })),
    },
  };
}

describe('reconcileFalseCompleteFallback', () => {
  test('fills empty completed output with child session real assistant text', async () => {
    const board = new BackgroundJobBoard();
    setupCompletedBoard(board, 'audit DATA.md');
    // Child session has produced a real 9346-char report
    const childMessages = [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'audit' }] },
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: '# Audit Report\nAll claims verified.' }],
      },
    ];
    const hook = createTaskSessionManagerHook(
      { client: mockClient(childMessages), directory: '/tmp' } as never,
      {
        maxSessionsPerAgent: 2,
        maxRetainedSnapshots: 2,
        backgroundJobBoard: board,
        shouldManageSession: () => true,
      },
    );

    const history = [
      userMessage('u1', 'run audit'),
      taskCompletedPart('call-1', CHILD, ''), // empty result = false-complete
    ];

    const result = await transform(hook, history);
    const part = findTaskPart(result, 'call-1') as any;

    expect(part.state.status).toBe('completed');
    expect(part.state.output).toContain('state="completed"');
    expect(part.state.output).toContain('Background task completed: audit DATA.md');
    expect(part.state.output).toContain('# Audit Report');
    expect(part.state.output).toContain('All claims verified.');
  });

  test('does NOT rewrite when completed output already has real text', async () => {
    const board = new BackgroundJobBoard();
    setupCompletedBoard(board, 'test task');
    const childMessages = [
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'real output' }] },
    ];
    const hook = createTaskSessionManagerHook(
      { client: mockClient(childMessages), directory: '/tmp' } as never,
      {
        maxSessionsPerAgent: 2,
        maxRetainedSnapshots: 2,
        backgroundJobBoard: board,
        shouldManageSession: () => true,
      },
    );

    const realText = 'Already have real result here';
    const history = [
      userMessage('u1', 'run task'),
      taskCompletedPart('call-1', CHILD, realText),
    ];

    const result = await transform(hook, history);
    const part = findTaskPart(result, 'call-1') as any;

    // Real completion is preserved unchanged.
    expect(part.state.output).toContain(realText);
    expect(part.state.output).not.toContain('Background task completed:');
  });

  test('does NOT rewrite when child session has no assistant text yet (still running)', async () => {
    const board = new BackgroundJobBoard();
    setupCompletedBoard(board, 'test task');
    // Child session has no assistant text — fallback model still running
    const childMessages = [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'prompt' }] },
    ];
    const hook = createTaskSessionManagerHook(
      { client: mockClient(childMessages), directory: '/tmp' } as never,
      {
        maxSessionsPerAgent: 2,
        maxRetainedSnapshots: 2,
        backgroundJobBoard: board,
        shouldManageSession: () => true,
      },
    );

    const history = [
      userMessage('u1', 'run task'),
      taskCompletedPart('call-1', CHILD, ''),
    ];

    const result = await transform(hook, history);
    const part = findTaskPart(result, 'call-1') as any;

    // No real text available yet — part stays empty (next turn re-evaluates).
    expect(part.state.status).toBe('completed');
    const tagMatch = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/m.exec(
      part.state.output,
    );
    expect(tagMatch?.[1]?.trim()).toBe('');
  });

  test('is idempotent across consecutive transforms', async () => {
    const board = new BackgroundJobBoard();
    setupCompletedBoard(board, 'test task');
    const childMessages = [
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'real output' }] },
    ];
    const hook = createTaskSessionManagerHook(
      { client: mockClient(childMessages), directory: '/tmp' } as never,
      {
        maxSessionsPerAgent: 2,
        maxRetainedSnapshots: 2,
        backgroundJobBoard: board,
        shouldManageSession: () => true,
      },
    );

    const history = [
      userMessage('u1', 'run task'),
      taskCompletedPart('call-1', CHILD, ''),
    ];

    const first = await transform(hook, history);
    const firstOutput = findTaskPart(first, 'call-1').state.output;

    const second = await transform(hook, history);
    const secondOutput = findTaskPart(second, 'call-1').state.output;

    expect(secondOutput).toBe(firstOutput);
  });

  test('does not touch non-task tool parts', async () => {
    const board = new BackgroundJobBoard();
    setupCompletedBoard(board, 'test task');
    const childMessages = [
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'real' }] },
    ];
    const hook = createTaskSessionManagerHook(
      { client: mockClient(childMessages), directory: '/tmp' } as never,
      {
        maxSessionsPerAgent: 2,
        maxRetainedSnapshots: 2,
        backgroundJobBoard: board,
        shouldManageSession: () => true,
      },
    );

    const history = [
      userMessage('u1', 'run task'),
      {
        info: { role: 'assistant', agent: 'orchestrator', sessionID: PARENT, id: 'call-2' },
        parts: [
          { type: 'text', text: ' ' },
          {
            type: 'tool',
            tool: 'read',
            callID: 'call-2',
            state: {
              status: 'completed',
              output: '<task id="child-1" state="completed"><task_result></task_result></task>',
              metadata: { sessionId: CHILD },
            },
          },
        ],
      },
    ];

    const result = await transform(hook, history);
    const part = result[1].parts[1] as any;

    // read tool parts are not reconciled.
    expect(part.state.output).toContain('<task_result></task_result>');
  });
});
