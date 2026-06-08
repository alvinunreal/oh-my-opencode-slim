import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils';
import { createTaskSessionManagerHook } from './index';

function createHook(options?: {
  shouldManageSession?: (sessionID: string) => boolean;
  readContextMinLines?: number;
  readContextMaxFiles?: number;
  backgroundJobBoard?: BackgroundJobBoard;
  sessionStatus?: unknown;
}) {
  const hook = createTaskSessionManagerHook(
    {
      client: {
        session: {
          status: mock(async () => ({ data: options?.sessionStatus ?? {} })),
        },
      },
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

  test('classifies transient task_status errors for known running jobs', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });

    const output = {
      output: [
        'task_id: child-1',
        'state: error',
        '',
        '<task_error>',
        'Task is not running in this process and has no final output.',
        '</task_error>',
      ].join('\n'),
      metadata: { state: 'error' },
    };

    await hook['tool.execute.after'](
      { tool: 'task_status', sessionID: 'parent-1', callID: 'call-2' },
      output,
    );

    expect(output.output).toContain('state: error');
    expect(output.metadata).toMatchObject({ state: 'error' });
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      terminalUnreconciled: false,
    });
  });

  test('does not terminalize transient task_status errors when live session is busy', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      sessionStatus: { 'child-1': { type: 'busy' } },
    });

    const output = {
      output: [
        'task_id: child-1',
        'state: error',
        '',
        '<task_error>',
        'Task is not running in this process and has no final output.',
        '</task_error>',
      ].join('\n'),
      metadata: { state: 'error' },
    };

    await hook['tool.execute.after'](
      { tool: 'task_status', sessionID: 'parent-1', callID: 'call-2' },
      output,
    );

    expect(output.output).toContain('state: error');
    expect(output.metadata).toMatchObject({ state: 'error' });
    expect(board.get('child-1')).toBeUndefined();
  });

  test('treats transient task_status errors as ambiguous for stale terminal records with live busy evidence', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      sessionStatus: { 'child-1': { type: 'busy' } },
    });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({ taskID: 'child-1', state: 'completed' });

    const output = {
      output: [
        'task_id: child-1',
        'state: error',
        '',
        '<task_error>',
        'Task is not running in this process and has no final output.',
        '</task_error>',
      ].join('\n'),
      metadata: { state: 'error' },
    };

    await hook['tool.execute.after'](
      { tool: 'task_status', sessionID: 'parent-1', callID: 'call-2' },
      output,
    );

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
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

  test('dedupes anonymous synthetic completions by content hash even when message index changes', async () => {
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

    // First transform - message at index 0
    const firstMessages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [completionPart],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, firstMessages);

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'same result',
    });

    // Relaunch the task
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

    // Second transform - same completion content but at different message index (1 instead of 0)
    // With stable content hash, this should still be deduped (not processed again)
    const secondMessages = {
      messages: [
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ type: 'text', text: 'some other message' }],
        }, // New message at index 0
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [completionPart], // Same completion now at index 1
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, secondMessages);

    // Should still be running because the same anonymous completion was deduped
    // (not re-processed just because message index changed)
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
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

  test('normalizes late injected failure for an explicitly cancelled task', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'cancelled review',
    });
    board.markCancelled('child-1', 'user requested');
    board.markReconciled('child-1');

    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                'Background task failed: cancelled review',
                'task_id: child-1',
                'state: error',
                '',
                '<task_error>',
                'No user message found in stream. This should never happen.',
                '</task_error>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, messages);

    expect(messages.messages[0].parts[0].text).toContain('state: cancelled');
    expect(messages.messages[0].parts[0].text).toContain(
      'cancelled: user requested',
    );
    expect(messages.messages[0].parts[0].text).not.toContain(
      'No user message found',
    );
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalState: 'cancelled',
      terminalUnreconciled: false,
    });
  });

  test('normalizes late task_status error output for an explicitly cancelled task', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'cancelled review',
    });
    board.markCancelled('child-1', 'user requested');
    board.markReconciled('child-1');

    const output = {
      output: [
        'task_id: child-1',
        'state: error',
        '',
        '<task_error>',
        'No user message found in stream. This should never happen.',
        '</task_error>',
      ].join('\n'),
      metadata: { state: 'error' },
    };

    await hook['tool.execute.after'](
      { tool: 'task_status', sessionID: 'parent-1', callID: 'call-2' },
      output,
    );

    expect(output.output).toContain('state: cancelled');
    expect(output.output).toContain('cancelled: user requested');
    expect(output.output).not.toContain('No user message found');
    expect(output.metadata).toMatchObject({ state: 'cancelled' });
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalState: 'cancelled',
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
    expect(nextMessages.messages[0].parts[0].text).toContain(
      'Reusable Sessions',
    );
  });

  test('does not reopen stale cancelled child job when child session becomes busy', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'read internals',
    });
    board.updateStatus({ taskID: 'child-1', state: 'cancelled' });
    board.markReconciled('child-1');

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-1', status: { type: 'busy' } },
      },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
      terminalState: 'cancelled',
    });
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

  test('completed reconciled job appears reusable and resumes via task', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config schema',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'schema mapped',
    });

    const messages = createMessages('parent-1', 'continue');
    await hook['experimental.chat.messages.transform']({}, messages);
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    const nextMessages = createMessages('parent-1', 'reuse');
    await hook['experimental.chat.messages.transform']({}, nextMessages);
    expect(nextMessages.messages[0].parts[0].text).toContain(
      '#### Reusable Sessions',
    );
    expect(nextMessages.messages[0].parts[0].text).toContain(
      'exp-1 / child-1 / explorer / completed, reconciled',
    );
    expect(nextMessages.messages[0].parts[0].text).not.toContain(
      ['<resumable', '_sessions>'].join(''),
    );
    expect(nextMessages.messages[0].parts[0].text).not.toContain(
      ['### Resumable', 'Sessions'].join(' '),
    );

    const resume = {
      args: {
        subagent_type: 'explorer',
        description: 'continue config schema',
        task_id: 'exp-1',
      },
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-1' },
      resume,
    );
    expect(resume.args.task_id).toBe('child-1');
  });

  test('only reconciled completed jobs resolve as reusable task sessions', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'done-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({ taskID: 'done-1', state: 'completed' });
    board.registerLaunch({
      taskID: 'err-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'bad review',
    });
    board.updateStatus({ taskID: 'err-1', state: 'error' });
    board.markReconciled('err-1');

    const unreconciled = {
      args: { subagent_type: 'oracle', task_id: 'ora-1' },
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      unreconciled,
    );
    expect(unreconciled.args.task_id).toBeUndefined();

    board.markReconciled('done-1');

    const failed = { args: { subagent_type: 'oracle', task_id: 'ora-2' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      failed,
    );
    expect(failed.args.task_id).toBeUndefined();

    const completed = { args: { subagent_type: 'oracle', task_id: 'ora-1' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-3' },
      completed,
    );
    expect(completed.args.task_id).toBe('done-1');

    const messages = createMessages('parent-1', 'continue');
    await hook['experimental.chat.messages.transform']({}, messages);
    expect(messages.messages[0].parts[0].text).toContain(
      'ora-1 / done-1 / oracle / completed, reconciled',
    );
    expect(messages.messages[0].parts[0].text).not.toContain('err-1');
  });

  test('running alias is polled through task_status but not resumed by task', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const resume = { args: { subagent_type: 'explorer', task_id: 'exp-1' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
      resume,
    );
    expect(resume.args.task_id).toBeUndefined();

    const poll = { args: { task_id: 'exp-1' } };
    await hook['tool.execute.before'](
      { tool: 'task_status', sessionID: 'parent-1', callID: 'poll' },
      poll,
    );
    expect(poll.args.task_id).toBe('child-1');
  });

  test('task alias is dropped when subagent_type is missing', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const resume = { args: { task_id: 'exp-1' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
      resume,
    );

    expect(resume.args.task_id).toBeUndefined();
  });

  test('task alias is dropped when subagent_type is invalid', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const resume = {
      args: { subagent_type: 'not-an-agent', task_id: 'exp-1' },
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
      resume,
    );

    expect(resume.args.task_id).toBeUndefined();
  });

  test('wrong parent or wrong agent alias does not resolve', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({ taskID: 'child-1', state: 'completed' });
    board.markReconciled('child-1');

    const wrongAgent = { args: { subagent_type: 'oracle', task_id: 'exp-1' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'agent' },
      wrongAgent,
    );
    expect(wrongAgent.args.task_id).toBeUndefined();

    const wrongParent = { args: { task_id: 'exp-1' } };
    await hook['tool.execute.before'](
      { tool: 'task_status', sessionID: 'parent-2', callID: 'parent' },
      wrongParent,
    );
    expect(wrongParent.args.task_id).toBe('exp-1');
  });

  test('unknown raw task_status id remains unchanged', async () => {
    const { hook } = createHook();
    const poll = { args: { task_id: 'raw-unknown' } };
    await hook['tool.execute.before'](
      { tool: 'task_status', sessionID: 'parent-1', callID: 'poll' },
      poll,
    );
    expect(poll.args.task_id).toBe('raw-unknown');
  });

  test('resuming reusable job relaunches running and removes reusable entry', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({ taskID: 'child-1', state: 'completed' });
    board.markReconciled('child-1');

    const resume = { args: { subagent_type: 'explorer', task_id: 'exp-1' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
      resume,
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
      { output: ['task_id: child-1', 'state: running'].join('\n') },
    );

    const messages = createMessages('parent-1', 'continue');
    await hook['experimental.chat.messages.transform']({}, messages);
    expect(messages.messages[0].parts[0].text).toContain(
      'exp-1 / child-1 / explorer / running',
    );
    expect(messages.messages[0].parts[0].text).toContain(
      '#### Reusable Sessions\n- none',
    );
  });

  test('bare task id output without state does not create reusable job', async () => {
    const { hook } = createHook();
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'explorer', description: 'legacy output' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { output: 'task_id: child-1 (for resuming to continue this task)' },
    );

    const messages = createMessages('parent-1', 'continue');
    await hook['experimental.chat.messages.transform']({}, messages);
    expect(messages.messages[0].parts[0].text).toBe('continue');
  });

  test('completed foreground XML task output becomes reusable after reconciliation', async () => {
    const { hook } = createHook();
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'fixer', description: 'reuse probe' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: [
          '<task id="ses_child" state="completed">',
          '<task_result>',
          'done',
          '</task_result>',
          '</task>',
        ].join('\n'),
      },
    );

    const unreconciled = createMessages('parent-1', 'continue');
    await hook['experimental.chat.messages.transform']({}, unreconciled);
    expect(unreconciled.messages[0].parts[0].text).toContain(
      'fix-1 / ses_child / fixer / completed, unreconciled',
    );

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    const reusable = createMessages('parent-1', 'reuse');
    await hook['experimental.chat.messages.transform']({}, reusable);
    expect(reusable.messages[0].parts[0].text).toContain(
      'fix-1 / ses_child / fixer / completed, reconciled',
    );

    const resume = { args: { subagent_type: 'fixer', task_id: 'fix-1' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-1' },
      resume,
    );
    expect(resume.args.task_id).toBe('ses_child');
  });

  test('late child busy event does not reopen completed foreground XML task', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'fixer', description: 'reuse probe' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: [
          '<task id="ses_child" state="completed">',
          '<task_result>',
          'done',
          '</task_result>',
          '</task>',
        ].join('\n'),
      },
    );

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_child', status: { type: 'busy' } },
      },
    });

    expect(board.get('ses_child')).toMatchObject({
      state: 'completed',
      terminalState: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('preserves explicit raw session ids when reusable board misses', async () => {
    const { hook } = createHook();
    const resume = {
      args: { subagent_type: 'fixer', task_id: 'ses_existing' },
    };

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-1' },
      resume,
    );

    expect(resume.args.task_id).toBe('ses_existing');
  });

  test('still drops unknown reusable aliases', async () => {
    const { hook } = createHook();
    const resume = { args: { subagent_type: 'fixer', task_id: 'fix-99' } };

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-1' },
      resume,
    );

    expect(resume.args.task_id).toBeUndefined();
  });

  test('reads before and after launch attach with unique-line counts and caps', async () => {
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
    for (const [file, start, count] of [
      ['small.ts', 1, 4],
      ['large.ts', 1, 12],
      ['large.ts', 7, 6],
      ['medium.ts', 1, 5],
    ] as const) {
      await hook['tool.execute.after'](
        { tool: 'read', sessionID: 'child-1', callID: `read-${file}-${start}` },
        {
          output: [
            `<path>/tmp/src/${file}</path>`,
            '<content>',
            ...Array.from(
              { length: count },
              (_, index) => `${start + index}: line`,
            ),
            '</content>',
          ].join('\n'),
        },
      );
    }
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'explorer', description: 'context caps' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { output: ['task_id: child-1', 'state: running'].join('\n') },
    );
    await hook['tool.execute.after'](
      { tool: 'task_status', sessionID: 'parent-1', callID: 'status-1' },
      { output: ['task_id: child-1', 'state: completed'].join('\n') },
    );
    const messages = createMessages('parent-1', 'continue');
    await hook['experimental.chat.messages.transform']({}, messages);
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    const next = createMessages('parent-1', 'reuse');
    await hook['experimental.chat.messages.transform']({}, next);
    const prompt = next.messages[0].parts[0].text;
    expect(prompt).not.toContain('small.ts');
    expect(prompt).toContain('src/large.ts (12 lines)');
    expect(prompt).not.toContain('src/large.ts (18 lines)');
    expect(prompt).toContain('(+1 more)');
  });

  test('reusable cap evicts only old reusable jobs, not active jobs', async () => {
    const board = new BackgroundJobBoard({ maxReusablePerAgent: 2 });
    for (const index of [1, 2, 3]) {
      board.registerLaunch({
        taskID: `done-${index}`,
        parentSessionID: 'parent-1',
        agent: 'explorer',
        description: `done ${index}`,
        now: index,
      });
      board.updateStatus({
        taskID: `done-${index}`,
        state: 'completed',
        now: index,
      });
      board.markReconciled(`done-${index}`, index);
    }
    board.registerLaunch({
      taskID: 'running-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'active',
      now: 4,
    });

    expect(board.get('done-1')).toBeUndefined();
    expect(board.get('done-2')).toBeDefined();
    expect(board.get('done-3')).toBeDefined();
    expect(board.get('running-1')).toBeDefined();
  });

  test('does not expose a system transform for resumable sessions', async () => {
    const { hook } = createHook();
    expect('experimental.chat.system.transform' in hook).toBe(false);
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

  test('cleans up background jobs when parent or child is deleted', async () => {
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

  test('parent deletion clears jobs and pending calls', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'oracle', description: 'architecture review' } },
    );
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'architecture review',
    });

    await hook.event({
      event: { type: 'session.deleted', properties: { sessionID: 'parent-1' } },
    });
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { output: ['task_id: child-2', 'state: running'].join('\n') },
    );

    expect(board.list('parent-1')).toHaveLength(0);
  });
});
