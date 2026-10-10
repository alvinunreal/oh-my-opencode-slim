import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { BackgroundJobBoard as ProductionBoard } from '../utils/background-job-board';
import { BackgroundJobBoard } from '../utils/background-job-fixture';
import { createTaskMessageTool } from './task-message';

let client: Record<string, any>;
afterEach(() => mock.restore());

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
    messages: mock(async () => ({
      data: [
        {
          info: {
            role: 'user',
            model: { providerID: 'openai', modelID: 'gpt-6' },
          },
        },
      ],
    })),
    prompt,
  };
}

function createTool(board: BackgroundJobBoard, hostFlavor?: string) {
  return createTaskMessageTool({
    input: {
      directory: '/test',
      client,
      ...(hostFlavor ? { hostFlavor } : {}),
    } as any,
    backgroundJobBoard: board,
  }).task_message;
}

function createToolWithTimeout(board: BackgroundJobBoard, timeoutMs: number) {
  return createTaskMessageTool({
    input: { directory: '/test', client } as any,
    backgroundJobBoard: board,
    messageTimeoutMs: timeoutMs,
  }).task_message;
}

describe('task_message', () => {
  test('the schema-level message cap admits 2000 chars and rejects 2001', async () => {
    // The bound lives in the zod schema the host enforces before execute()
    // runs (the plugin cannot reword that rejection), so the pin targets
    // the schema itself. Literal values: retuning the cap must explicitly
    // touch this test.
    const tool = createTool(new BackgroundJobBoard());
    expect(tool.args.message.safeParse('a'.repeat(2000)).success).toBe(true);
    expect(tool.args.message.safeParse('a'.repeat(2001)).success).toBe(false);
  });

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
        model: { providerID: 'openai', modelID: 'gpt-6' },
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

  test('pins the executing step instead of stale session selection', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    const get = mock(async () => ({
      data: { model: { providerID: 'openai', id: 'gpt-6' } },
    }));
    const messages = mock(async () => ({
      data: [
        { info: { role: 'assistant', providerID: 'openai', modelID: 'gpt-6' } },
        {
          info: {
            role: 'assistant',
            providerID: 'anthropic',
            modelID: 'claude-sonnet',
            variant: 'max',
          },
        },
      ],
    }));
    client = { session: { get, messages, prompt } };

    await createTool(board).execute(
      { task_id: 'ses_child1', message: 'Continue with the fix.' },
      { sessionID: 'parent-1' } as any,
    );

    expect(prompt.mock.calls[0]?.[0].body).toMatchObject({
      model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
      variant: 'max',
    });
    expect(get).not.toHaveBeenCalled();
    expect(messages).toHaveBeenCalledWith({
      path: { id: 'ses_child1' },
      query: { directory: '/test', limit: 20 },
      signal: expect.any(AbortSignal),
    });
  });

  test('transports a separate user message variant', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    const messages = mock(async () => ({
      data: [
        {
          info: {
            role: 'user',
            model: { providerID: 'openai', id: 'gpt-6' },
            variant: 'medium',
          },
        },
      ],
    }));
    client = { session: { messages, prompt } };

    await createTool(board).execute(
      { task_id: 'ses_child1', message: 'Continue with the fix.' },
      { sessionID: 'parent-1' } as any,
    );

    expect(prompt.mock.calls[0]?.[0].body).toEqual({
      agent: 'fixer',
      model: { providerID: 'openai', modelID: 'gpt-6' },
      variant: 'medium',
      noReply: true,
      parts: [{ type: 'text', text: 'Continue with the fix.' }],
    });
  });

  test('skips compaction summaries and malformed steps when pinning the model', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    const messages = mock(async () => ({
      data: [
        {
          info: {
            role: 'assistant',
            providerID: 'anthropic',
            modelID: 'claude-sonnet',
            variant: 'high',
          },
        },
        { info: { role: 'assistant' } },
        {
          info: {
            role: 'assistant',
            summary: true,
            providerID: 'other',
            modelID: 'compact',
          },
        },
      ],
    }));
    client = {
      session: {
        messages,
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

  test('rejects without prompting when the transcript has no model identity', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = {
      session: {
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
    const messages = mock((input: { signal?: AbortSignal }) => {
      lookupSignal = input.signal;
      return new Promise<unknown>(() => {});
    });
    client = { session: { messages, prompt } };

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
    const lease = board.acquireCancellationLease(job.taskID, job.generation);
    expect(lease).toBeDefined();
    if (lease) board.releaseLease(lease);
  });

  test('rechecks the job after lookup before prompting', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    const messages = mock(async () => {
      board.updateStatus({ taskID: 'ses_child1', state: 'completed' });
      return {
        data: [
          {
            info: {
              role: 'user',
              model: { providerID: 'openai', id: 'gpt-6' },
              variant: 'high',
            },
          },
        ],
      };
    });
    client = { session: { messages, prompt } };

    await expect(
      createTool(board).execute(
        { task_id: 'ses_child1', message: 'Do not send.' },
        { sessionID: 'parent-1' } as any,
      ),
    ).rejects.toThrow('task_revive');
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

  test.each(['resolve', 'reject', 'complete then resolve'])(
    'quarantines only the pending write taskID and retires once on late %s',
    async (settlement) => {
      const board = new BackgroundJobBoard();
      registerRunningChild(board);
      registerRunningChild(board, 'ses_child2');
      const transport = Promise.withResolvers<unknown>();
      const prompt = mock((input: { path: { id: string } }) =>
        input.path.id === 'ses_child1'
          ? transport.promise
          : Promise.resolve({}),
      );
      client = { session: makeSession(prompt) };
      const acquire = spyOn(ProductionBoard.prototype, 'acquireMessageLease');
      const release = spyOn(ProductionBoard.prototype, 'releaseLease');
      const context = { sessionID: 'parent-1' } as any;
      const tool = createTool(board);

      await expect(
        createToolWithTimeout(board, 5).execute(
          { task_id: 'ses_child1', message: 'Please continue.' },
          context,
        ),
      ).rejects.toThrow('timed out');
      const lease = acquire.mock.results[0]?.value;
      if (!lease) throw new Error('missing message lease');
      const retirements = () =>
        release.mock.calls.filter(
          ([candidate]) => candidate.token === lease.token,
        );
      expect(board.validateLease(lease)).toBe(true);
      expect(retirements()).toHaveLength(0);
      expect(
        board.acquireCancellationLease(lease.taskID, lease.generation),
      ).toBeUndefined();
      expect(
        board.acquireRelaunchLease(lease.taskID, lease.generation),
      ).toBeUndefined();
      await expect(
        tool.execute(
          { task_id: 'ses_child1', message: 'Still excluded.' },
          context,
        ),
      ).rejects.toThrow('message/control lease unavailable');
      expect(prompt).toHaveBeenCalledTimes(1);

      // A different child on the same board/parent remains writable.
      await expect(
        tool.execute(
          { task_id: 'ses_child2', message: 'Independent update.' },
          context,
        ),
      ).resolves.toContain('queued');
      expect(prompt).toHaveBeenCalledTimes(2);
      expect(prompt.mock.calls[1]?.[0].path.id).toBe('ses_child2');
      expect(board.validateLease(lease)).toBe(true);
      expect(retirements()).toHaveLength(0);

      const completed = settlement === 'complete then resolve';
      if (completed) {
        // Completion can still arrive; only the lease-protected notification waits.
        board.updateStatus({
          taskID: lease.taskID,
          state: 'completed',
          resultSummary: 'done',
        });
        expect(board.getResultSummary(lease.taskID)).toBe('done');
        expect(
          board.acquireTerminalNotificationLease(
            lease.taskID,
            lease.generation,
          ),
        ).toBeUndefined();
      }
      const beforeSettlement = { ...board.get(lease.taskID) };
      if (settlement === 'reject')
        transport.reject(new Error('late transport failure'));
      else transport.resolve({});
      await Bun.sleep(0);
      expect(retirements()).toHaveLength(1);
      expect(board.validateLease(lease)).toBe(false);
      expect(board.get(lease.taskID)).toEqual(beforeSettlement);

      const replacement = completed
        ? board.acquireTerminalNotificationLease(lease.taskID, lease.generation)
        : board.acquireMessageLease(lease.taskID, lease.generation);
      expect(replacement).toBeDefined();
      if (!replacement) throw new Error('settled write retained exclusion');
      // The settled write's lease is stale: releasing it is a rejected no-op
      // and must not retire the replacement token. This call intentionally
      // passes through the release spy, so retirements() above counts it.
      expect(board.releaseLease(lease)).toBe(false);
      expect(board.validateLease(replacement)).toBe(true);
      expect(board.get(lease.taskID)).toEqual(beforeSettlement);
      board.releaseLease(replacement);
    },
  );

  test('rejects a task that is no longer tracked', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    const session = {
      ...makeSession(prompt),
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
    ).rejects.toThrow('task_revive');
    await expect(
      createTool(terminalBoard).execute(
        { task_id: 'ses_child1', message: 'Too late' },
        { sessionID: 'parent-1' } as any,
      ),
    ).rejects.toThrow('task_revive and task_id: "ses_child1"');
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

  test('terminal-resume guidance names the host delegation tool', async () => {
    const v1Board = new BackgroundJobBoard();
    registerRunningChild(v1Board);
    v1Board.updateStatus({ taskID: 'ses_child1', state: 'completed' });
    client = { session: { prompt: makePrompt() } };
    await expect(
      createTool(v1Board).execute(
        { task_id: 'ses_child1', message: 'Too late' },
        { sessionID: 'parent-1' } as any,
      ),
    ).rejects.toThrow('task_revive and task_id: "ses_child1"');

    const v2Board = new BackgroundJobBoard();
    registerRunningChild(v2Board);
    v2Board.updateStatus({ taskID: 'ses_child1', state: 'completed' });
    client = { session: { prompt: makePrompt() } };
    let message = '';
    try {
      await createTool(v2Board, 'v2').execute(
        { task_id: 'ses_child1', message: 'Too late' },
        { sessionID: 'parent-1' } as any,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('task_revive and sessionID: "ses_child1"');
    expect(message).not.toContain('task_result');
    expect(message).not.toContain('task(');
    expect(message).not.toContain('task_id');
  });

  test('v2 exposes sessionID and accepts the task_id alias', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = { session: makeSession(prompt) };
    const task_message = createTool(board, 'v2');

    expect(Object.keys(task_message.args)).toContain('sessionID');

    await expect(
      task_message.execute(
        { sessionID: 'ses_child1', message: 'Native update' },
        { sessionID: 'parent-1' } as any,
      ),
    ).resolves.toContain('queued');
    await expect(
      task_message.execute({ task_id: 'ses_child1', message: 'Alias update' }, {
        sessionID: 'parent-1',
      } as any),
    ).resolves.toContain('queued');
    expect(prompt).toHaveBeenCalledTimes(2);
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

  test('a board-missed settled child gets recovery guidance, not bare unknown', async () => {
    const board = new BackgroundJobBoard();
    const prompt = makePrompt();
    client = { session: { prompt } };
    // No launch registered: the board lost the child (restart or retention
    // trim) while the host session still exists and is owned.
    const error = (await createTool(board)
      .execute({ task_id: 'ses_child1', message: 'go' }, {
        sessionID: 'parent-1',
      } as any)
      .catch((e: Error) => e)) as Error;
    expect(error.message).toContain('Unknown task ID or alias: ses_child1');
    expect(error.message).toContain('not tracked');
    // v1 routing names the host-flavor resume param and the target ID.
    expect(error.message).toContain('task_revive and task_id: "ses_child1"');
    expect(error.message).toContain('do not launch a duplicate');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('a board-missed settled child on v2 routes with the sessionID param', async () => {
    const board = new BackgroundJobBoard();
    const prompt = makePrompt();
    client = { session: { prompt } };
    const error = (await createTool(board, 'v2')
      .execute({ task_id: 'ses_child1', message: 'go' }, {
        sessionID: 'parent-1',
      } as any)
      .catch((e: Error) => e)) as Error;
    expect(error.message).toContain('task_revive and sessionID: "ses_child1"');
  });

  test('a board-missed alias keeps the bare unknown error', async () => {
    const board = new BackgroundJobBoard();
    const prompt = makePrompt();
    client = { session: { prompt } };
    // An alias is board-scoped: without a board record it has no host
    // existence, so the error stays bare — no settled-session guidance.
    const error = (await createTool(board)
      .execute({ task_id: 'exp-9', message: 'go' }, {
        sessionID: 'parent-1',
      } as any)
      .catch((e: Error) => e)) as Error;
    expect(error.message).toBe('Unknown task ID or alias: exp-9');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('a session tracked by another parent keeps the bare unknown error', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = { session: { prompt } };
    // Canonical resolution maps the ref to the session ID and board.get is
    // not parent-scoped, so a foreign parent's record is visible here. The
    // settled-session advice must not fire: task_revive would reject the
    // same ownership mismatch, so the error stays bare.
    const task_message = createTaskMessageTool({
      input: { directory: '/test', client } as any,
      backgroundJobBoard: board,
      resolveCanonicalTaskRef: async () => ({
        kind: 'exact',
        taskID: 'ses_child1',
      }),
    }).task_message;
    const error = (await task_message
      .execute({ task_id: 'ses_child1', message: 'go' }, {
        sessionID: 'parent-2',
      } as any)
      .catch((e: Error) => e)) as Error;
    expect(error.message).toBe('Unknown task ID or alias: ses_child1');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('a disposal landing after the helper check still stops the send', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = { session: { prompt } };
    // The helper's disposed check passes (call 1); the plugin is torn down
    // while the resolution await is in flight; execute's post-await
    // re-check (call 2) must refuse to send.
    let disposedCalls = 0;
    const task_message = createTaskMessageTool({
      input: { directory: '/test', client } as any,
      backgroundJobBoard: board,
      isDisposed: () => ++disposedCalls > 1,
    }).task_message;
    await expect(
      task_message.execute({ task_id: 'ses_child1', message: 'go' }, {
        sessionID: 'parent-1',
      } as any),
    ).rejects.toThrow('The plugin instance was disposed');
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

  test('v2 schema exposes delivery and rejects invalid values', () => {
    const board = new BackgroundJobBoard();
    const v2 = createTool(board, 'v2');
    expect(Object.keys(v2.args)).toContain('delivery');
    expect(v2.args.delivery.safeParse('queue').success).toBe(true);
    expect(v2.args.delivery.safeParse('steer').success).toBe(true);
    expect(v2.args.delivery.safeParse('push').success).toBe(false);
    expect(v2.args.delivery.safeParse(undefined).success).toBe(true);
  });

  test('v1 schema has no delivery key and emits no delivery', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = { session: makeSession(prompt) };
    const v1 = createTool(board);

    expect(Object.keys(v1.args)).not.toContain('delivery');

    await v1.execute({ task_id: 'ses_child1', message: 'Status update' }, {
      sessionID: 'parent-1',
    } as any);
    const body = prompt.mock.calls[0]?.[0].body;
    expect(body).not.toHaveProperty('delivery');
  });

  test('omitted delivery matches explicit queue on v2', async () => {
    const runOnce = async (extra: Record<string, unknown>) => {
      const board = new BackgroundJobBoard();
      registerRunningChild(board);
      const prompt = makePrompt();
      client = { session: makeSession(prompt) };
      const result = await createTool(board, 'v2').execute(
        { sessionID: 'ses_child1', message: 'Update', ...extra },
        { sessionID: 'parent-1' } as any,
      );
      return { result, body: prompt.mock.calls[0]?.[0].body };
    };

    const omitted = await runOnce({});
    const queued = await runOnce({ delivery: 'queue' });
    expect(omitted.body).toEqual(queued.body);
    expect(omitted.body).not.toHaveProperty('delivery');
    expect(omitted.body.noReply).toBe(true);
    expect(omitted.result).toBe(queued.result);
    expect(omitted.result).toContain('queued');
  });

  test('explicit steer on v2 adds delivery and reports acceptance', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = { session: makeSession(prompt) };

    const result = await createTool(board, 'v2').execute(
      { sessionID: 'ses_child1', message: 'Update', delivery: 'steer' },
      { sessionID: 'parent-1' } as any,
    );

    const body = prompt.mock.calls[0]?.[0].body;
    expect(body.noReply).toBe(true);
    expect(body.delivery).toBe('steer');
    expect(result).toMatch(/steer/i);
    expect(result).toContain('not confirmed');
    expect(result).not.toMatch(/read|confirm.*child|applied|acknowledged/i);
  });

  test('steer refuses a terminal task without leaving a message lease', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    board.updateStatus({ taskID: 'ses_child1', state: 'completed' });
    const prompt = makePrompt();
    client = { session: makeSession(prompt) };

    await expect(
      createTool(board, 'v2').execute(
        { sessionID: 'ses_child1', message: 'Too late', delivery: 'steer' },
        { sessionID: 'parent-1' } as any,
      ),
    ).rejects.toThrow('task_revive');
    expect(prompt).not.toHaveBeenCalled();

    const job = board.get('ses_child1');
    if (!job) throw new Error('missing completed job');
    expect(
      board.acquireMessageLease(job.taskID, job.generation),
    ).toBeUndefined();
    const terminalLease = board.acquireTerminalNotificationLease(
      job.taskID,
      job.generation,
    );
    expect(terminalLease).toBeDefined();
    if (terminalLease) board.releaseLease(terminalLease);
  });
});
