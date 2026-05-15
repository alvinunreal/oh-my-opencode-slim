import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils';
import { createTaskSessionManagerHook } from './index';

function createHook(options?: {
  shouldManageSession?: (sessionID: string) => boolean;
  readContextMinLines?: number;
  readContextMaxFiles?: number;
  backgroundJobBoard?: BackgroundJobBoard;
}) {
  const hook = createTaskSessionManagerHook(
    {
      client: { session: { status: mock(async () => ({ data: {} })) } },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 2,
      readContextMinLines: options?.readContextMinLines,
      readContextMaxFiles: options?.readContextMaxFiles,
      backgroundJobBoard: options?.backgroundJobBoard,
      shouldManageSession: options?.shouldManageSession ?? (() => true),
    },
  );

  return { hook };
}

function createMessages(sessionID: string, text = 'user message') {
  return {
    messages: [
      {
        info: { role: 'user', agent: 'orchestrator', sessionID },
        parts: [{ type: 'text', text }],
      },
    ],
  };
}

describe('task-session-manager hook', () => {
  test('stores background task launches in job board prompt context', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'map scheduler hooks',
          prompt: 'inspect scheduler hooks',
        },
      },
    );

    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output: [
          'task_id: child-1 (for polling this task with task_status)',
          'state: running',
          '',
          '<task_result>',
          'Background task started.',
          '</task_result>',
        ].join('\n'),
      },
    );

    const messages = createMessages('parent-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);

    const userMessage = messages.messages[0];
    expect(userMessage.parts[0].text).toContain('### Background Job Board');
    expect(userMessage.parts[0].text).toContain(
      'exp-1 / child-1 / explorer / running',
    );
    expect(userMessage.parts[0].text).toContain(
      'Objective: map scheduler hooks',
    );
  });

  test('updates background job board from task_status output', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'oracle',
          description: 'review scheduler plan',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: [
          'task_id: child-1 (for polling this task with task_status)',
          'state: running',
        ].join('\n'),
      },
    );

    await hook['tool.execute.after'](
      { tool: 'task_status', sessionID: 'parent-1', callID: 'call-2' },
      {
        output: [
          'task_id: child-1',
          'state: completed',
          '',
          '<task_result>',
          'plan is sound',
          '</task_result>',
        ].join('\n'),
      },
    );

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'plan is sound',
    });

    const messages = createMessages('parent-1', 'continue');
    await hook['experimental.chat.messages.transform']({}, messages);

    expect(messages.messages[0].parts[0].text).toContain(
      'ora-1 / child-1 / oracle / completed, unreconciled',
    );
    expect(messages.messages[0].parts[0].text).toContain(
      'Result: plan is sound',
    );
  });

  test('keeps task_status timeout as a running timed-out job', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'fixer',
          description: 'implement scheduler wiring',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: [
          'task_id: child-1 (for polling this task with task_status)',
          'state: running',
        ].join('\n'),
      },
    );

    await hook['tool.execute.after'](
      { tool: 'task_status', sessionID: 'parent-1', callID: 'call-2' },
      {
        output: [
          'task_id: child-1',
          'state: running',
          '',
          '<task_result>',
          'Timed out after 120000ms while waiting for task completion.',
          '</task_result>',
        ].join('\n'),
      },
    );

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      timedOut: true,
      terminalUnreconciled: false,
    });

    const messages = createMessages('parent-1', 'continue');
    await hook['experimental.chat.messages.transform']({}, messages);

    expect(messages.messages[0].parts[0].text).toContain(
      'fix-1 / child-1 / fixer / running, timed out',
    );
  });

  test('updates background job board from injected completion messages', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'explorer',
          description: 'map hooks',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: [
          'task_id: child-1 (for polling this task with task_status)',
          'state: running',
        ].join('\n'),
      },
    );

    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              id: 'part-1',
              synthetic: true,
              text: [
                'Background task completed: map hooks',
                'task_id: child-1',
                'state: completed',
                '',
                '<task_result>',
                'found hook flow',
                '</task_result>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'found hook flow',
    });
    expect(messages.messages[0].parts[0].text).toContain(
      'exp-1 / child-1 / explorer / completed, unreconciled',
    );
  });

  test('ignores non-synthetic user text that resembles task status', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const messages = createMessages(
      'parent-1',
      [
        'please note this text:',
        'task_id: child-1',
        'state: completed',
        '<task_result>',
        'spoofed',
        '</task_result>',
      ].join('\n'),
    );

    await hook['experimental.chat.messages.transform']({}, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
  });

  test('does not replay old injected completion after same task id relaunches', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              id: 'part-2',
              synthetic: true,
              text: [
                'Background task completed: map hooks',
                'task_id: child-1',
                'state: completed',
                '',
                '<task_result>',
                'old result',
                '</task_result>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, messages);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'old result',
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks again',
    });

    await hook['experimental.chat.messages.transform']({}, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
      resultSummary: undefined,
    });
  });

  test('new synthetic message occurrence updates board after task relaunch with same state/result', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    // First synthetic completion - processed
    const firstMessages = {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
            id: 'msg-1',
          },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                'Background task completed: map hooks',
                'task_id: child-1',
                'state: completed',
                '',
                '<task_result>',
                'same result',
                '</task_result>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, firstMessages);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'same result',
    });

    // Relaunch same task ID
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks again',
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });

    // New synthetic message occurrence with same state/result - should update to terminal
    const secondMessages = {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
            id: 'msg-2',
          },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                'Background task completed: map hooks',
                'task_id: child-1',
                'state: completed',
                '',
                '<task_result>',
                'same result',
                '</task_result>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, secondMessages);

    // Should be terminal again because this is a new message occurrence
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'same result',
    });
  });

  test('dedupes anonymous synthetic completions by session message and part index', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const completionPart = {
      type: 'text',
      synthetic: true,
      text: [
        'Background task completed: map hooks',
        'task_id: child-1',
        'state: completed',
        '',
        '<task_result>',
        'same result',
        '</task_result>',
      ].join('\n'),
    };
    const firstMessage = {
      info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
      parts: [completionPart],
    };

    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [firstMessage] },
    );

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks again',
    });

    const secondMessage = {
      info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
      parts: [completionPart],
    };

    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [firstMessage, secondMessage] },
    );

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'same result',
    });
  });

  test('ignores non-synthetic spoof that resembles task status', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    // Non-synthetic message should be ignored even with valid-looking content
    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: false,
              text: [
                'Background task completed: map hooks',
                'task_id: child-1',
                'state: completed',
                '',
                '<task_result>',
                'spoofed result',
                '</task_result>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
  });

  test('ignores synthetic prefix/state mismatch - completed prefix with error state', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    // "completed" prefix with "error" state should be ignored
    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                'Background task completed: map hooks',
                'task_id: child-1',
                'state: error',
                '',
                '<task_error>',
                'something went wrong',
                '</task_error>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
  });

  test('ignores synthetic prefix/state mismatch - failed prefix with completed state', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    // "failed" prefix with "completed" state should be ignored
    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                'Background task failed: map hooks',
                'task_id: child-1',
                'state: completed',
                '',
                '<task_result>',
                'success result',
                '</task_result>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
  });

  test('ignores running state in auto-injected synthetic path', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    // "completed" prefix with "running" state should be ignored
    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                'Background task completed: map hooks',
                'task_id: child-1',
                'state: running',
                '',
                '<task_result>',
                'still running',
                '</task_result>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
  });

  test('valid synthetic completed message updates board to terminal', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                'Background task completed: map hooks',
                'task_id: child-1',
                'state: completed',
                '',
                '<task_result>',
                'successfully mapped',
                '</task_result>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'successfully mapped',
    });
  });

  test('valid synthetic failed message updates board to terminal error', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                'Background task failed: map hooks',
                'task_id: child-1',
                'state: error',
                '',
                '<task_error>',
                'mapping failed',
                '</task_error>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      terminalUnreconciled: true,
      resultSummary: 'mapping failed',
    });
  });

  test('marks terminal jobs reconciled after injected prompt reaches idle', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'approved',
    });

    const messages = createMessages('parent-1', 'continue');
    await hook['experimental.chat.messages.transform']({}, messages);
    expect(messages.messages[0].parts[0].text).toContain(
      'ora-1 / child-1 / oracle / completed, unreconciled',
    );

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });

    const nextMessages = createMessages('parent-1', 'continue again');
    await hook['experimental.chat.messages.transform']({}, nextMessages);
    expect(nextMessages.messages[0].parts[0].text).toBe('continue again');
  });

  test('does not reconcile terminal jobs before they are injected into a prompt', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({ taskID: 'child-1', state: 'completed' });

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('does not reconcile injected terminal jobs after session error', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({ taskID: 'child-1', state: 'completed' });

    const messages = createMessages('parent-1', 'continue');
    await hook['experimental.chat.messages.transform']({}, messages);

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'parent-1',
          error: { name: 'MessageAbortedError' },
        },
      },
    });
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('does not expose running background jobs as resumable sessions', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'background config schema',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output: [
          'task_id: child-1 (for polling this task with task_status)',
          'state: running',
        ].join('\n'),
      },
    );

    const next = {
      args: {
        subagent_type: 'explorer',
        description: 'continue background work',
        task_id: 'exp-1',
      },
    };
    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      next,
    );

    expect(next.args.task_id).toBeUndefined();
  });

  test('drops remembered alias when resumed session is relaunched in background', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const resumed = {
      args: {
        subagent_type: 'explorer',
        description: 'continue config schema',
        task_id: 'exp-1',
      },
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      resumed,
    );
    expect(resumed.args.task_id).toBe('child-1');

    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      {
        output: [
          'task_id: child-1 (for polling this task with task_status)',
          'state: running',
        ].join('\n'),
      },
    );

    const next = {
      args: {
        subagent_type: 'explorer',
        description: 'try stale alias',
        task_id: 'exp-1',
      },
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-3' },
      next,
    );

    expect(next.args.task_id).toBeUndefined();

    const messages = createMessages('parent-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);
    expect(messages.messages[0].parts[0].text).toContain(
      'exp-1 / child-1 / explorer / running',
    );
    expect(messages.messages[0].parts[0].text).not.toContain(
      'explorer: exp-1 config schema',
    );
  });

  test('stores task sessions and injects resumable-session block into user message', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
          prompt: 'inspect config schema',
        },
      },
    );

    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const messages = createMessages('parent-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);

    const userMessage = messages.messages[0];
    expect(userMessage.parts[0].text).toContain('<resumable_sessions>');
    expect(userMessage.parts[0].text).toContain('### Resumable Sessions');
    expect(userMessage.parts[0].text).toContain(
      'explorer: exp-1 config schema',
    );
    expect(userMessage.parts[0].text).toContain('</resumable_sessions>');
  });

  test('does not expose a system transform for resumable sessions', async () => {
    const { hook } = createHook();
    expect('experimental.chat.system.transform' in hook).toBe(false);
  });

  test('resolves remembered aliases to real task ids before execution', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
          prompt: 'inspect config schema',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const next = {
      args: {
        subagent_type: 'explorer',
        description: 'continue schema work',
        task_id: 'exp-1',
      },
    };
    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      next,
    );

    expect(next.args.task_id).toBe('child-1');
  });

  test('tracks files read by child sessions in resumable message context', async () => {
    const { hook } = createHook();

    await hook.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-1', parentID: 'parent-1' } },
      },
    });

    await hook['tool.execute.after'](
      {
        tool: 'read',
        sessionID: 'child-1',
        callID: 'read-1',
      },
      {
        output: [
          '<path>/tmp/src/index.ts</path>',
          '<type>file</type>',
          '<content>',
          ...Array.from({ length: 12 }, (_, index) => `${index + 1}: line`),
          '</content>',
        ].join('\n'),
        metadata: {
          loaded: ['/tmp/AGENTS.md'],
        },
      },
    );

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'session files',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const messages = createMessages('parent-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);

    const userMessage = messages.messages[0];
    expect(userMessage.parts[0].text).toContain('exp-1 session files');
    expect(userMessage.parts[0].text).toContain(
      'Context read by exp-1: src/index.ts (12 lines)',
    );
  });

  test('accumulates multiple reads and hides tiny read context', async () => {
    const { hook } = createHook();

    await hook.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-1', parentID: 'parent-1' } },
      },
    });

    await hook['tool.execute.after'](
      { tool: 'read', sessionID: 'child-1', callID: 'read-1' },
      {
        output: [
          '<path>/tmp/src/small.ts</path>',
          '<content>',
          ...Array.from({ length: 4 }, (_, index) => `${index + 1}: line`),
          '</content>',
        ].join('\n'),
      },
    );
    await hook['tool.execute.after'](
      { tool: 'read', sessionID: 'child-1', callID: 'read-2' },
      {
        output: [
          '<path>/tmp/src/large.ts</path>',
          '<content>',
          ...Array.from({ length: 7 }, (_, index) => `${index + 1}: line`),
          '</content>',
        ].join('\n'),
      },
    );
    await hook['tool.execute.after'](
      { tool: 'read', sessionID: 'child-1', callID: 'read-3' },
      {
        output: [
          '<path>/tmp/src/large.ts</path>',
          '<content>',
          ...Array.from({ length: 5 }, (_, index) => `${index + 8}: line`),
          '</content>',
        ].join('\n'),
      },
    );

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'explorer', description: 'line counts' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const messages = createMessages('parent-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);

    const prompt = messages.messages[0].parts[0].text;
    expect(prompt).not.toContain('small.ts');
    expect(prompt).toContain('src/large.ts (12 lines)');
  });

  test('counts overlapping repeated reads once per unique line', async () => {
    const { hook } = createHook();

    await hook.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-1', parentID: 'parent-1' } },
      },
    });
    for (const call of ['read-1', 'read-2']) {
      await hook['tool.execute.after'](
        { tool: 'read', sessionID: 'child-1', callID: call },
        {
          output: [
            '<path>/tmp/src/repeat.ts</path>',
            '<content>',
            ...Array.from({ length: 12 }, (_, index) => `${index + 1}: line`),
            '</content>',
          ].join('\n'),
        },
      );
    }

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'explorer', description: 'repeat reads' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const messages = createMessages('parent-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);

    const prompt = messages.messages[0].parts[0].text;
    expect(prompt).toContain('src/repeat.ts (12 lines)');
    expect(prompt).not.toContain('src/repeat.ts (24 lines)');
  });

  test('uses configured read context thresholds', async () => {
    const { hook } = createHook({
      readContextMinLines: 5,
      readContextMaxFiles: 1,
    });

    await hook.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-1', parentID: 'parent-1' } },
      },
    });
    for (const [file, lines] of [
      ['small.ts', 4],
      ['medium.ts', 5],
      ['large.ts', 12],
    ] as const) {
      await hook['tool.execute.after'](
        { tool: 'read', sessionID: 'child-1', callID: `read-${file}` },
        {
          output: [
            `<path>/tmp/src/${file}</path>`,
            '<content>',
            ...Array.from({ length: lines }, (_, line) => `${line + 1}: line`),
            '</content>',
          ].join('\n'),
        },
      );
    }

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'explorer', description: 'configured caps' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const messages = createMessages('parent-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);

    const prompt = messages.messages[0].parts[0].text;
    expect(prompt).not.toContain('small.ts');
    expect(prompt).toContain('Context read by exp-1:');
    expect(prompt).toContain('(+1 more)');
  });

  test('ignores reads from unmanaged child sessions', async () => {
    const { hook } = createHook({
      shouldManageSession: (sessionID) => sessionID === 'parent-1',
    });

    await hook.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-1', parentID: 'other-parent' } },
      },
    });
    await hook['tool.execute.after'](
      { tool: 'read', sessionID: 'child-1', callID: 'read-1' },
      {
        output: [
          '<path>/tmp/src/index.ts</path>',
          '<content>',
          ...Array.from({ length: 12 }, (_, index) => `${index + 1}: line`),
          '</content>',
        ].join('\n'),
      },
    );

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'explorer', description: 'unmanaged read' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const messages = createMessages('parent-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);

    const prompt = messages.messages[0].parts[0].text;
    expect(prompt).toContain('exp-1 unmanaged read');
    expect(prompt).not.toContain('Context read by exp-1');
  });

  test('prunes read context when remembered sessions are evicted', async () => {
    const { hook } = createHook();

    for (const index of [1, 2, 3]) {
      await hook.event({
        event: {
          type: 'session.created',
          properties: {
            info: { id: `child-${index}`, parentID: 'parent-1' },
          },
        },
      });
      await hook['tool.execute.after'](
        { tool: 'read', sessionID: `child-${index}`, callID: `read-${index}` },
        {
          output: [
            `<path>/tmp/src/file-${index}.ts</path>`,
            '<content>',
            ...Array.from({ length: 12 }, (_, line) => `${line + 1}: line`),
            '</content>',
          ].join('\n'),
        },
      );
      await hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: `call-${index}` },
        { args: { subagent_type: 'explorer', description: `thread ${index}` } },
      );
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'parent-1', callID: `call-${index}` },
        {
          output: `task_id: child-${index} (for resuming to continue this task if needed)`,
        },
      );
    }

    const messages = createMessages('parent-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);

    const prompt = messages.messages[0].parts[0].text;
    expect(prompt).not.toContain('exp-1 thread 1');
    expect(prompt).not.toContain('file-1.ts');
    expect(prompt).toContain('exp-2 thread 2');
    expect(prompt).toContain('file-2.ts (12 lines)');
    expect(prompt).toContain('exp-3 thread 3');
    expect(prompt).toContain('file-3.ts (12 lines)');
  });

  test('drops stale remembered sessions and falls back to fresh', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const next = {
      args: {
        subagent_type: 'explorer',
        description: 'continue schema work',
        task_id: 'exp-1',
      },
    };
    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      next,
    );

    expect(next.args.task_id).toBe('child-1');

    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      {
        output: '[ERROR] Session not found',
      },
    );

    const messages = createMessages('parent-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);
    expect(messages.messages[0].parts[0].text).not.toContain('exp-1');
  });

  test('drops resumed predecessor when success returns a new task id', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'continue schema work',
          task_id: 'exp-1',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      {
        output:
          'task_id: child-2 (for resuming to continue this task if needed)',
      },
    );

    const messages = createMessages('parent-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);

    const prompt = messages.messages[0].parts[0].text;
    expect(prompt).toContain('continue schema work');
    expect(prompt).not.toContain('config schema');
  });

  test('does not drop remembered session on non-runtime session text', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'continue schema work',
          task_id: 'exp-1',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      {
        output: 'Found no session cookies in fixtures, continuing analysis.',
      },
    );

    const messages = createMessages('parent-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);

    expect(messages.messages[0].parts[0].text).toContain('exp-1 config schema');
  });

  test('ignores sessions that are not orchestrator-managed', async () => {
    const { hook } = createHook({ shouldManageSession: () => false });

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'manual-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'manual-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const messages = createMessages('manual-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);

    // Message should remain unchanged
    expect(messages.messages[0].parts[0].text).toBe('do something');
  });

  test('cleans up remembered sessions when parent or child is deleted', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'oracle',
          description: 'architecture review',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'child-1' },
      },
    });

    const messages = createMessages('parent-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);
    // Message should remain unchanged since session was deleted
    expect(messages.messages[0].parts[0].text).toBe('do something');
  });

  test('cleans pending calls when parent session is deleted', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'oracle',
          description: 'architecture review',
        },
      },
    );

    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'parent-1' },
      },
    });

    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const messages = createMessages('parent-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);

    // Message should remain unchanged since session was deleted
    expect(messages.messages[0].parts[0].text).toBe('do something');
  });

  test('deduplicates pending call order when a resume call is recorded twice', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'continue schema work',
          task_id: 'exp-1',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      {
        output: '[ERROR] Session not found',
      },
    );

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-3',
      },
      {
        args: {
          subagent_type: 'oracle',
          description: 'architecture review',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-3',
      },
      {
        output:
          'task_id: child-3 (for resuming to continue this task if needed)',
      },
    );

    const messages = createMessages('parent-1', 'do something');
    await hook['experimental.chat.messages.transform']({}, messages);

    expect(messages.messages[0].parts[0].text).toContain(
      'oracle: ora-1 architecture review',
    );
  });
});
