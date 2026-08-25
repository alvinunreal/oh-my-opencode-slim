import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createTaskMessageTool } from './task-message';

let client: Record<string, any>;
mock.module('../utils/opencode-client', () => ({ getClient: () => client }));

function registerRunningChild(
  board: BackgroundJobBoard,
  taskID = 'ses_child1',
  parent = 'parent-1',
): void {
  board.registerLaunch({
    taskID,
    parentSessionID: parent,
    agent: 'fixer',
    description: 'implement',
    now: 0,
  });
}

function makePrompt(): ReturnType<typeof mock> {
  return mock(async () => ({}));
}

function makeSession(prompt: ReturnType<typeof mock>) {
  return {
    get: mock(async () => ({
      data: { model: { providerID: 'openai', id: 'gpt-5.6' } },
    })),
    prompt,
  };
}

function createTool(board: BackgroundJobBoard) {
  return createTaskMessageTool({
    input: { directory: '/test' } as any,
    backgroundJobBoard: board,
  }).task_message;
}

function createToolWithTimeout(board: BackgroundJobBoard, timeoutMs: number) {
  return createTaskMessageTool({
    input: { directory: '/test' } as any,
    backgroundJobBoard: board,
    messageTimeoutMs: timeoutMs,
  }).task_message;
}

describe('task_message', () => {
  test('queues messages for a parent-owned running child', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = { session: makeSession(prompt) };

    await expect(
      createTool(board).execute(
        { task_id: 'ses_child1', message: 'Please continue.' },
        { sessionID: 'parent-1' } as any,
      ),
    ).resolves.toContain('queued');

    expect(prompt).toHaveBeenCalledWith({
      path: { id: 'ses_child1' },
      body: {
        agent: 'fixer',
        model: { providerID: 'openai', modelID: 'gpt-5.6' },
        variant: 'default',
        noReply: true,
        parts: [{ type: 'text', text: 'Please continue.' }],
      },
      throwOnError: true,
    });
  });

  test('uses only the noReply transport and permits repeated updates', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = { session: makeSession(prompt) };
    const task_message = createTool(board);

    await task_message.execute({ task_id: 'ses_child1', message: 'First' }, {
      sessionID: 'parent-1',
    } as any);
    await task_message.execute({ task_id: 'ses_child1', message: 'Second' }, {
      sessionID: 'parent-1',
    } as any);

    expect(prompt).toHaveBeenCalledTimes(2);
    expect((client.session as any).promptAsync).toBeUndefined();
    expect(prompt.mock.calls[0]?.[0].body.noReply).toBe(true);
    expect(prompt.mock.calls[1]?.[0].body.noReply).toBe(true);
  });

  test('transports the authoritative current model and variant', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const transportOrder: string[] = [];
    const prompt = mock(async () => {
      transportOrder.push('prompt');
      return {};
    });
    const get = mock(async () => {
      transportOrder.push('get');
      return {
        data: {
          model: {
            providerID: 'openai',
            id: 'gpt-5.6',
            variant: 'high',
          },
        },
      };
    });
    client = { session: { get, prompt } };

    await createTool(board).execute(
      { task_id: 'ses_child1', message: 'Continue with the fix.' },
      { sessionID: 'parent-1' } as any,
    );

    expect(get).toHaveBeenCalledWith({
      path: { id: 'ses_child1' },
      query: { directory: '/test' },
      signal: expect.any(AbortSignal),
    });
    expect(transportOrder).toEqual(['get', 'prompt']);
    expect(prompt).toHaveBeenCalledWith({
      path: { id: 'ses_child1' },
      body: {
        agent: 'fixer',
        model: { providerID: 'openai', modelID: 'gpt-5.6' },
        variant: 'high',
        noReply: true,
        parts: [{ type: 'text', text: 'Continue with the fix.' }],
      },
      throwOnError: true,
    });
  });

  test('transports a separate current session variant', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    const get = mock(async () => ({
      data: {
        model: { providerID: 'openai', id: 'gpt-5.6' },
        variant: 'medium',
      },
    }));
    client = { session: { get, prompt } };

    await createTool(board).execute(
      { task_id: 'ses_child1', message: 'Continue with the fix.' },
      { sessionID: 'parent-1' } as any,
    );

    expect(prompt.mock.calls[0]?.[0].body).toEqual({
      agent: 'fixer',
      model: { providerID: 'openai', modelID: 'gpt-5.6' },
      variant: 'medium',
      noReply: true,
      parts: [{ type: 'text', text: 'Continue with the fix.' }],
    });
  });

  test('transports a valid current model without a variant', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = {
      session: {
        get: mock(async () => ({
          data: { model: { providerID: 'openai', id: 'gpt-5.6' } },
        })),
        prompt,
      },
    };

    await createTool(board).execute(
      { task_id: 'ses_child1', message: 'Continue with the fix.' },
      { sessionID: 'parent-1' } as any,
    );

    expect(prompt.mock.calls[0]?.[0].body).toEqual({
      agent: 'fixer',
      model: { providerID: 'openai', modelID: 'gpt-5.6' },
      variant: 'default',
      noReply: true,
      parts: [{ type: 'text', text: 'Continue with the fix.' }],
    });
  });

  test('falls back to the latest user message when get is malformed', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = {
      session: {
        get: mock(async () => ({ data: { model: { providerID: 'openai' } } })),
        messages: mock(async () => ({
          data: [
            {
              info: {
                role: 'user',
                model: {
                  providerID: 'anthropic',
                  modelID: 'claude-sonnet',
                  variant: 'high',
                },
              },
            },
            { info: { role: 'assistant' } },
          ],
        })),
        prompt,
      },
    };

    await createTool(board).execute(
      { task_id: 'ses_child1', message: 'Continue with the fix.' },
      { sessionID: 'parent-1' } as any,
    );

    expect(prompt.mock.calls[0]?.[0].body).toEqual({
      agent: 'fixer',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
      variant: 'high',
      noReply: true,
      parts: [{ type: 'text', text: 'Continue with the fix.' }],
    });
  });

  test('falls back to the latest user message when get throws', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    const messages = mock(async () => ({
      data: [
        {
          info: {
            role: 'user',
            model: { providerID: 'anthropic', id: 'claude-sonnet' },
            variant: 'high',
          },
        },
      ],
    }));
    client = {
      session: {
        get: mock(async () => {
          throw new Error('session unavailable');
        }),
        messages,
        prompt,
      },
    };

    await createTool(board).execute(
      { task_id: 'ses_child1', message: 'Continue with the fix.' },
      { sessionID: 'parent-1' } as any,
    );

    expect(messages).toHaveBeenCalledWith({
      path: { id: 'ses_child1' },
      query: { directory: '/test', limit: 20 },
      signal: expect.any(AbortSignal),
    });
    expect(prompt.mock.calls[0]?.[0].body).toEqual({
      agent: 'fixer',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
      variant: 'high',
      noReply: true,
      parts: [{ type: 'text', text: 'Continue with the fix.' }],
    });
  });

  test('falls back to the latest user message when get is unavailable', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = {
      session: {
        messages: mock(async () => ({
          data: [
            {
              info: {
                role: 'user',
                model: { providerID: 'google', id: 'gemini-pro' },
              },
            },
          ],
        })),
        prompt,
      },
    };

    await createTool(board).execute(
      { task_id: 'ses_child1', message: 'Continue with the fix.' },
      { sessionID: 'parent-1' } as any,
    );

    expect(prompt.mock.calls[0]?.[0].body).toEqual({
      agent: 'fixer',
      model: { providerID: 'google', modelID: 'gemini-pro' },
      variant: 'default',
      noReply: true,
      parts: [{ type: 'text', text: 'Continue with the fix.' }],
    });
  });

  test('rejects without prompting when both identity sources are unavailable', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = {
      session: {
        get: mock(async () => ({
          data: { model: { id: 'missing-provider' } },
        })),
        messages: mock(async () => ({ data: [] })),
        prompt,
      },
    };

    await expect(
      createTool(board).execute(
        { task_id: 'ses_child1', message: 'Continue with the fix.' },
        { sessionID: 'parent-1' } as any,
      ),
    ).rejects.toThrow('no authoritative model identity');
    expect(prompt).not.toHaveBeenCalled();

    const job = board.get('ses_child1');
    expect(job).toBeDefined();
    if (!job) throw new Error('missing running job');
    expect(
      board.acquireCancellationLease(job.taskID, job.generation),
    ).toBeDefined();
  });

  test('bounds a hanging identity lookup and releases the lease', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    let lookupSignal: AbortSignal | undefined;
    const get = mock((input: { signal?: AbortSignal }) => {
      lookupSignal = input.signal;
      return new Promise<unknown>(() => {});
    });
    client = { session: { get, prompt } };

    await expect(
      createToolWithTimeout(board, 5).execute(
        { task_id: 'ses_child1', message: 'Continue with the fix.' },
        { sessionID: 'parent-1' } as any,
      ),
    ).rejects.toThrow('model lookup timed out');
    expect(lookupSignal).toBeDefined();
    expect(lookupSignal?.aborted).toBe(true);
    expect(prompt).not.toHaveBeenCalled();

    const job = board.get('ses_child1');
    expect(job).toBeDefined();
    if (!job) throw new Error('missing running job');
    expect(
      board.acquireCancellationLease(job.taskID, job.generation),
    ).toBeDefined();
  });

  test('rechecks the job after lookup before prompting', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    const get = mock(async () => {
      board.updateStatus({ taskID: 'ses_child1', state: 'completed' });
      return {
        data: {
          model: { providerID: 'openai', id: 'gpt-5.6' },
          variant: 'high',
        },
      };
    });
    client = { session: { get, prompt } };

    await expect(
      createTool(board).execute(
        { task_id: 'ses_child1', message: 'Do not send.' },
        { sessionID: 'parent-1' } as any,
      ),
    ).rejects.toThrow('not running');
    expect(prompt).not.toHaveBeenCalled();

    const job = board.get('ses_child1');
    expect(job).toBeDefined();
    if (!job) throw new Error('missing completed job');
    const terminalLease = board.acquireTerminalNotificationLease(
      job.taskID,
      job.generation,
    );
    expect(terminalLease).toBeDefined();
    if (terminalLease) board.releaseLease(terminalLease);
  });

  test('serializes message transport against cancellation and relaunch', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    let releasePrompt!: () => void;
    const prompt = mock(
      () =>
        new Promise<unknown>((resolve) => {
          releasePrompt = () => resolve({});
        }),
    );
    client = { session: makeSession(prompt) };

    const pending = createTool(board).execute(
      { task_id: 'ses_child1', message: 'Hold the lane.' },
      { sessionID: 'parent-1' } as any,
    );
    await Bun.sleep(0);

    const job = board.get('ses_child1');
    expect(job).toBeDefined();
    if (!job) throw new Error('missing running job');
    expect(
      board.acquireCancellationLease(job.taskID, job.generation),
    ).toBeUndefined();
    expect(
      board.acquireRelaunchLease(job.taskID, job.generation),
    ).toBeUndefined();
    expect(() =>
      board.registerLaunch({
        taskID: job.taskID,
        parentSessionID: job.parentSessionID,
        agent: job.agent,
      }),
    ).toThrow('message lease');

    releasePrompt();
    await expect(pending).resolves.toContain('queued');
    expect(
      board.acquireCancellationLease(job.taskID, job.generation),
    ).toBeDefined();
  });

  test('rejects API failures and releases the message lease', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = mock(async () => ({ error: { message: 'HTTP 409' } }));
    client = { session: makeSession(prompt) };

    await expect(
      createTool(board).execute(
        { task_id: 'ses_child1', message: 'Please continue.' },
        { sessionID: 'parent-1' } as any,
      ),
    ).rejects.toThrow('HTTP 409');

    const job = board.get('ses_child1');
    expect(job).toBeDefined();
    if (!job) throw new Error('missing running job');
    expect(
      board.acquireCancellationLease(job.taskID, job.generation),
    ).toBeDefined();
  });

  test('quarantines a timed-out pending transport until it settles', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    let settlePrompt!: () => void;
    const prompt = mock(
      () =>
        new Promise<unknown>((resolve) => {
          settlePrompt = () => resolve({});
        }),
    );
    client = { session: makeSession(prompt) };

    await expect(
      createToolWithTimeout(board, 5).execute(
        { task_id: 'ses_child1', message: 'Please continue.' },
        { sessionID: 'parent-1' } as any,
      ),
    ).rejects.toThrow('timed out');

    const job = board.get('ses_child1');
    expect(job).toBeDefined();
    if (!job) throw new Error('missing running job');
    expect(
      board.acquireCancellationLease(job.taskID, job.generation),
    ).toBeUndefined();

    settlePrompt();
    await Bun.sleep(0);
    expect(
      board.acquireCancellationLease(job.taskID, job.generation),
    ).toBeDefined();
  });

  test('rejects a task that is no longer tracked', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    const session = {
      get: async () => ({
        data: { model: { providerID: 'openai', id: 'gpt-5.6' } },
      }),
      get prompt() {
        board.drop('ses_child1');
        return prompt;
      },
    };
    client = { session };

    await expect(
      createTool(board).execute(
        { task_id: 'ses_child1', message: 'Please continue.' },
        { sessionID: 'parent-1' } as any,
      ),
    ).rejects.toThrow('no longer tracked');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('rejects terminal and cancelling tasks', async () => {
    const terminalBoard = new BackgroundJobBoard();
    registerRunningChild(terminalBoard);
    terminalBoard.updateStatus({ taskID: 'ses_child1', state: 'completed' });
    const terminalPrompt = makePrompt();
    client = { session: { prompt: terminalPrompt } };

    await expect(
      createTool(terminalBoard).execute(
        { task_id: 'ses_child1', message: 'Too late' },
        { sessionID: 'parent-1' } as any,
      ),
    ).rejects.toThrow('not running');
    expect(terminalPrompt).not.toHaveBeenCalled();

    const cancellingBoard = new BackgroundJobBoard();
    registerRunningChild(cancellingBoard);
    cancellingBoard.markCancelled('ses_child1', 'stop requested');
    const cancellingPrompt = makePrompt();
    client = { session: { prompt: cancellingPrompt } };

    await expect(
      createTool(cancellingBoard).execute(
        { task_id: 'ses_child1', message: 'Do not send' },
        { sessionID: 'parent-1' } as any,
      ),
    ).rejects.toThrow('cancellation was requested');
    expect(cancellingPrompt).not.toHaveBeenCalled();
  });

  test('rejects a child owned by another parent', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = { session: { prompt } };

    await expect(
      createTool(board).execute(
        { task_id: 'ses_child1', message: 'Do not send' },
        { sessionID: 'parent-2' } as any,
      ),
    ).rejects.toThrow('Unknown task ID or alias');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('rejects a relaunch attempt at the transport boundary', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    const session = {
      get prompt() {
        board.registerLaunch({
          taskID: 'ses_child1',
          parentSessionID: 'parent-1',
          agent: 'fixer',
          now: 1,
        });
        return prompt;
      },
    };
    client = { session };

    await expect(
      createTool(board).execute(
        { task_id: 'ses_child1', message: 'Do not send' },
        { sessionID: 'parent-1' } as any,
      ),
    ).rejects.toThrow('message lease');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('uses explicit queue wording without legacy delivery terms', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    client = { session: makeSession(makePrompt()) };

    const result = await createTool(board).execute(
      { task_id: 'ses_child1', message: 'Status update' },
      { sessionID: 'parent-1' } as any,
    );

    expect(result).toContain('queued');
    expect(result).not.toContain('delivered');
    expect(result).not.toContain('admitted');
    expect(result).not.toContain('nudge');
  });
});
