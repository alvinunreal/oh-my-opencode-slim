import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { buildPluginInput } from '../v2/client-shim';
import { createTaskResultTool } from './task-result';
import { createTaskStatusTool } from './task-status';

let mockClient: Record<string, any>;

mock.module('../utils/opencode-client', () => ({
  getClient: () => mockClient,
}));

function createTool() {
  const board = new BackgroundJobBoard();
  const get = mock(async () => ({ data: { parentID: 'parent-1' } }));
  const messages = mock(async () => ({
    data: [
      {
        info: { role: 'assistant' },
        parts: [
          { type: 'reasoning', text: 'private work' },
          { type: 'text', text: 'complete findings' },
        ],
      },
    ],
  }));
  const status = mock(async () => ({ data: {} }));
  mockClient = { session: { get, messages, status } };

  const input = { directory: '/test/project' } as any;
  const tools = createTaskResultTool({
    input,
    backgroundJobBoard: board,
  });
  const statusTools = createTaskStatusTool({
    input,
    backgroundJobBoard: board,
  });
  return {
    board,
    get,
    messages,
    statusTool: statusTools.task_status,
    tool: tools.task_result,
  };
}

describe('task_result', () => {
  test('returns completed task text without prompting the child', async () => {
    const { board, tool, messages } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });
    board.updateStatus({ taskID: 'ses_child1', state: 'completed' });

    const output = await tool.execute({ task_id: 'exp-1' }, {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as any);

    expect(output).toBe('complete findings');
    expect(messages).toHaveBeenCalledTimes(1);
    expect(mockClient.session.prompt).toBeUndefined();
    expect(mockClient.session.promptAsync).toBeUndefined();
  });

  test('returns only the final assistant response', async () => {
    const { board, tool } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });
    board.updateStatus({ taskID: 'ses_child1', state: 'completed' });
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'earlier progress' }],
        },
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'final findings' }],
        },
      ],
    });

    await expect(
      tool.execute({ task_id: 'exp-1' }, {
        sessionID: 'parent-1',
        agent: 'fixer',
      } as any),
    ).resolves.toBe('final findings');
  });

  test('returns a non-error status for a still-running tracked task', async () => {
    const { board, tool, statusTool, messages } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });

    const output = await tool.execute({ task_id: 'exp-1' }, {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as any);

    expect(output).toBe(
      [
        'task_id: ses_child1',
        'state: running',
        'message: Task is still running. Wait for its terminal result.',
        'next: use task_status to inspect the task',
      ].join('\n'),
    );
    await expect(
      statusTool.execute({ task_id: 'exp-1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).resolves.toContain('state: running');
    expect(messages).not.toHaveBeenCalled();
  });

  test('preserves a live retry state for a tracked running task', async () => {
    const { board, tool, messages } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });
    mockClient.session.status.mockResolvedValue({
      data: { ses_child1: { type: 'retry' } },
    });

    const output = await tool.execute({ task_id: 'exp-1' }, {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as any);

    expect(output).toContain('state: retry');
    expect(output).toContain('next: use task_status to inspect the task');
    expect(messages).not.toHaveBeenCalled();
  });

  test('self-heals a stopped board record when the live child is busy', async () => {
    const { board, tool, messages } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });
    const generation = board.get('ses_child1')?.generation;
    board.markStopped(
      'ses_child1',
      'provisional idle observation',
      1,
      generation,
    );
    mockClient.session.status.mockResolvedValue({
      data: { ses_child1: { type: 'busy' } },
    });

    const output = await tool.execute({ task_id: 'exp-1' }, {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as any);

    expect(output).toContain('state: running');
    expect(output).toContain('task_status');
    expect(board.get('ses_child1')).toMatchObject({
      state: 'running',
      statusUncertain: false,
    });
    expect(messages).not.toHaveBeenCalled();
  });

  test('rejects a tracked task that ended in error', async () => {
    const { board, tool, messages } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });
    board.updateStatus({
      taskID: 'ses_child1',
      state: 'error',
      resultSummary: 'provider exploded',
    });

    await expect(
      tool.execute({ task_id: 'exp-1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('ended in error: provider exploded');
    expect(messages).not.toHaveBeenCalled();
  });

  test('marks a terminal job used even when retrieval finds no text result', async () => {
    const { board, tool } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
      now: 100,
    });
    board.updateStatus({
      taskID: 'ses_child1',
      state: 'error',
      resultSummary: undefined,
      now: 200,
    });
    mockClient.session.messages.mockResolvedValue({ data: [] });

    await expect(
      tool.execute({ task_id: 'exp-1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('ended in error');

    // Retrieval attempt must still count as consumption so the
    // duplicate-spawn guard's escape hatch opens for failed terminals.
    const job = board.get('ses_child1');
    expect(job?.completedAt).toBe(200);
    expect(job?.lastUsedAt).toBeGreaterThan(job?.completedAt ?? 0);
  });

  test('rejects a tracked task that was cancelled', async () => {
    const { board, tool, messages } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });
    board.markCancelled('ses_child1', 'orchestrator aborted');

    await expect(
      tool.execute({ task_id: 'exp-1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('was cancelled: orchestrator aborted');
    expect(messages).not.toHaveBeenCalled();
  });

  test('returns a reconciled task whose terminal outcome was completed', async () => {
    const { board, tool } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });
    board.updateStatus({ taskID: 'ses_child1', state: 'completed' });
    board.markReconciled('ses_child1');

    const output = await tool.execute({ task_id: 'exp-1' }, {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as any);

    expect(output).toBe('complete findings');
  });

  test('does not return G2 partial output after G1 completion races a relaunch', async () => {
    const { board, tool, messages } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });
    const first = board.updateStatus({
      taskID: 'ses_child1',
      state: 'completed',
      resultSummary: 'G1 complete',
    });
    if (!first) throw new Error('G1 was not registered');

    mockClient.session.status.mockImplementation(async () => {
      board.registerLaunch({
        taskID: 'ses_child1',
        parentSessionID: 'parent-1',
        agent: 'explorer',
        description: 'G2 relaunch',
      });
      return { data: { ses_child1: { type: 'busy' } } };
    });
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'G2 partial output' }],
        },
      ],
    });

    await expect(
      tool.execute({ task_id: 'exp-1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('changed generation');
    expect(board.get('ses_child1')).toMatchObject({
      generation: first.generation + 1,
      state: 'running',
    });
    expect(messages).not.toHaveBeenCalled();
  });

  test('does not return a result when G2 relaunches during result extraction', async () => {
    const { board, tool } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });
    board.updateStatus({
      taskID: 'ses_child1',
      state: 'completed',
      resultSummary: 'G1 complete',
    });

    mockClient.session.messages.mockImplementation(async () => {
      board.registerLaunch({
        taskID: 'ses_child1',
        parentSessionID: 'parent-1',
        agent: 'explorer',
        description: 'G2 relaunch',
      });
      return {
        data: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'G2 partial output' }],
          },
        ],
      };
    });

    await expect(
      tool.execute({ task_id: 'exp-1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('changed generation');
    expect(board.get('ses_child1')?.state).toBe('running');
  });

  test('rejects a reconciled task whose terminal outcome was error', async () => {
    const { board, tool, messages } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });
    board.updateStatus({
      taskID: 'ses_child1',
      state: 'error',
      resultSummary: 'model unavailable',
    });
    board.markReconciled('ses_child1');

    await expect(
      tool.execute({ task_id: 'exp-1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('ended in error: model unavailable');
    expect(messages).not.toHaveBeenCalled();
  });

  test('returns a status for an untracked child whose live session is busy', async () => {
    const { tool, messages } = createTool();
    mockClient.session.status.mockImplementation(async () => ({
      data: { ses_child1: { type: 'busy' } },
    }));

    const output = await tool.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as any);

    expect(output).toBe(
      [
        'task_id: ses_child1',
        'state: running',
        'message: Task is still running. Wait for its terminal result.',
        'next: retry task_result after the task finishes',
      ].join('\n'),
    );
    expect(messages).not.toHaveBeenCalled();

    mockClient.session.status.mockResolvedValue({ data: {} });
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: { role: 'assistant', time: { completed: 100 } },
          parts: [{ type: 'text', text: 'final findings' }],
        },
      ],
    });
    await expect(
      tool.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).resolves.toBe('final findings');
  });

  test('returns a status for an untracked child whose live session is retrying', async () => {
    const { tool, messages } = createTool();
    mockClient.session.status.mockImplementation(async () => ({
      data: { ses_child1: { type: 'retry' } },
    }));

    const output = await tool.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as any);

    expect(output).toContain('state: retry');
    expect(output).toContain('next: retry task_result after the task finishes');
    expect(output).not.toContain('task_status');
    expect(messages).not.toHaveBeenCalled();
  });

  test('rejects an untracked idle session with no terminal evidence', async () => {
    const { tool, messages } = createTool();
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'partial findings' }],
        },
      ],
    });

    await expect(
      tool.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('no terminal evidence');
    expect(messages).toHaveBeenCalledTimes(1);
  });

  test('rejects an untracked session idle mid-exchange', async () => {
    const { tool } = createTool();
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: { role: 'assistant', time: { completed: 100 } },
          parts: [{ type: 'text', text: 'earlier answer' }],
        },
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: 'continue' }],
        },
      ],
    });

    await expect(
      tool.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('no terminal evidence');
  });

  test('rejects an untracked session whose last assistant message errored', async () => {
    const { tool } = createTool();
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: {
            role: 'assistant',
            time: { completed: 100 },
            error: { name: 'MessageAbortedError', data: {} },
          },
          parts: [{ type: 'text', text: 'partial findings' }],
        },
      ],
    });

    await expect(
      tool.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('no terminal evidence');
  });

  test('returns an untracked session result when terminal evidence exists', async () => {
    const { tool, messages } = createTool();
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: { role: 'assistant', time: { completed: 100 } },
          parts: [
            { type: 'reasoning', text: 'private work' },
            { type: 'text', text: 'final findings' },
          ],
        },
      ],
    });

    const output = await tool.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as any);

    expect(output).toBe('final findings');
    expect(messages).toHaveBeenCalledTimes(1);
  });

  test('returns a tracked result through the v2 client shim', async () => {
    const { board, tool } = createTool();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'trace bug',
    });
    board.updateStatus({
      taskID: 'ses_child1',
      state: 'completed',
      resultSummary: 'complete findings',
    });
    mockClient = (buildPluginInput('/test/project') as { client: never })
      .client;

    const output = await tool.execute({ task_id: 'exp-1' }, {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as any);

    expect(output).toBe('complete findings');
  });

  test('rejects a task owned by another parent session', async () => {
    const { tool, get, messages } = createTool();
    get.mockImplementation(async () => ({
      data: { parentID: 'other-parent' },
    }));

    await expect(
      tool.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('does not belong to this session');
    expect(messages).not.toHaveBeenCalled();
  });
});
