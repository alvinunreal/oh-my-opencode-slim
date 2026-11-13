import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { BackgroundJobBoard as ProductionBoard } from '../utils/background-job-board';
import { BackgroundJobBoard } from '../utils/background-job-fixture';
import { diagnosticExcerptOf } from '../utils/child-transcript';
import { createTaskMessageTool } from './task-message';

let client: Record<string, any>;
afterEach(() => mock.restore());

function registerRunningChild(
  board: BackgroundJobBoard,
  taskID = 'ses_child1',
  parent = 'parent-1',
  runInputMessageID?: string,
): void {
  board.registerLaunch({
    taskID,
    parentSessionID: parent,
    agent: 'fixer',
    description: 'implement',
    ...(runInputMessageID !== undefined ? { runInputMessageID } : {}),
    now: 0,
  });
}

/** A real v1 id: `msg_` + ascending hex timestamp, assigned by the host. */
const HOST_MESSAGE_ID = 'msg_019a2b3c4d5eAbCdEfGhIjKlMn';

/** What the v1 host returns for a noReply prompt: the stored user message. */
function hostAccepted() {
  return { data: { info: { id: HOST_MESSAGE_ID, role: 'user' }, parts: [] } };
}

function makePrompt(): ReturnType<typeof mock> {
  return mock(async () => hostAccepted());
}

/** Deterministic drain: late settlement runs only microtasks, never timers. */
async function drainMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
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

function createTool(board: BackgroundJobBoard) {
  return createTaskMessageTool({
    input: { directory: '/test', client } as any,
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

/** Execute the default tool's task_message for ses_child1 as parent-1. */
function send(board: BackgroundJobBoard, message: string, timeoutMs?: number) {
  const tool =
    timeoutMs === undefined
      ? createTool(board)
      : createToolWithTimeout(board, timeoutMs);
  return tool.execute({ task_id: 'ses_child1', message }, {
    sessionID: 'parent-1',
  } as any);
}

describe('task_message', () => {
  test('T13: pins the restore target, or the current child model when unavailable', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    const session = makeSession(prompt);
    client = { session };
    let restore = true;
    const task = createTaskMessageTool({
      input: { directory: '/test', client } as any,
      backgroundJobBoard: board,
      restoreTarget: () =>
        restore ? { model: 'primary/a', variant: 'high' } : undefined,
    }).task_message;
    await task.execute({ task_id: 'ses_child1', message: 'first' }, {
      sessionID: 'parent-1',
    } as any);
    expect(prompt.mock.calls[0]?.[0].body).toMatchObject({
      model: { providerID: 'primary', modelID: 'a' },
      variant: 'high',
    });
    restore = false;
    await task.execute({ task_id: 'ses_child1', message: 'second' }, {
      sessionID: 'parent-1',
    } as any);
    expect(prompt.mock.calls[1]?.[0].body).toMatchObject({
      model: { providerID: 'openai', modelID: 'gpt-6' },
      variant: 'default',
    });
  });
  test('the schema-level message cap admits 2000 chars and rejects 2001', async () => {
    // The cap lives in the host-enforced zod schema; retuning it touches this.
    const tool = createTool(new BackgroundJobBoard());
    expect(tool.args.message.safeParse('a'.repeat(2000)).success).toBe(true);
    expect(tool.args.message.safeParse('a'.repeat(2001)).success).toBe(false);
  });

  test('queues messages for a parent-owned running child', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = { session: makeSession(prompt) };

    await expect(send(board, 'Please continue.')).resolves.toContain('queued');

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
    // The host-assigned id becomes the generation's excerpt boundary.
    expect(board.get('ses_child1')?.amendmentInputMessageID).toBe(
      HOST_MESSAGE_ID,
    );
  });

  test('never chooses the v1 admission id; records the host-assigned one', async () => {
    // v1 orders turns by id string (`msg_` + hex timestamp); a plugin-chosen
    // id would sort after every host id and keep the child loop running.
    const board = new BackgroundJobBoard();
    registerRunningChild(board, 'ses_child1', 'parent-1', 'msg_open');
    const hostID = 'msg_019a2b3c4d5fZyXwVuTsRqPoNm';
    const prompt = mock(async () => ({
      data: { info: { id: hostID, role: 'user' }, parts: [] },
    }));
    client = { session: makeSession(prompt) };

    await expect(send(board, 'Amend.')).resolves.toContain('queued');

    const body = prompt.mock.calls[0]?.[0].body as Record<string, unknown>;
    expect(body).not.toHaveProperty('messageID');
    expect(board.get('ses_child1')?.amendmentInputMessageID).toBe(hostID);
  });

  test('records no amendment boundary when the host returns no message id', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = mock(async () => ({}));
    client = { session: makeSession(prompt) };

    await expect(send(board, 'Amend.')).resolves.toContain(
      'no amendment boundary was recorded',
    );
    expect(prompt.mock.calls[0]?.[0].body).not.toHaveProperty('messageID');
    expect(board.get('ses_child1')?.amendmentInputMessageID).toBeUndefined();
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

    await send(board, 'Continue with the fix.');

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

    await send(board, 'Continue with the fix.');

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

    await send(board, 'Continue with the fix.');

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

    await expect(send(board, 'Continue with the fix.')).rejects.toThrow(
      'no authoritative model identity',
    );
    expect(prompt).not.toHaveBeenCalled();

    const job = board.get('ses_child1');
    expect(job?.state).toBe('running');
    if (!job) throw new Error('missing running job');
    expect(
      board.acquireLease(job.taskID, job.generation, 'cancellation')?.kind,
    ).toBe('cancellation');
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

    await expect(send(board, 'Continue with the fix.', 5)).rejects.toThrow(
      'model lookup timed out',
    );
    expect(lookupSignal?.aborted).toBe(true);
    expect(prompt).not.toHaveBeenCalled();

    const job = board.get('ses_child1');
    expect(job?.state).toBe('running');
    if (!job) throw new Error('missing running job');
    const lease = board.acquireLease(
      job.taskID,
      job.generation,
      'cancellation',
    );
    expect(lease?.kind).toBe('cancellation');
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

    await expect(send(board, 'Do not send.')).rejects.toThrow('task_revive');
    expect(prompt).not.toHaveBeenCalled();

    const job = board.get('ses_child1');
    expect(job?.state).toBe('completed');
    if (!job) throw new Error('missing completed job');
    const terminalLease = board.acquireLease(
      job.taskID,
      job.generation,
      'terminal-notification',
    );
    expect(terminalLease?.kind).toBe('terminal-notification');
    if (terminalLease) board.releaseLease(terminalLease);
  });

  test('serializes message transport against cancellation and relaunch', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    let releasePrompt!: () => void;
    const prompt = mock(
      () =>
        new Promise<unknown>((resolve) => {
          releasePrompt = () => resolve(hostAccepted());
        }),
    );
    client = { session: makeSession(prompt) };

    const pending = send(board, 'Hold the lane.');
    await drainMicrotasks();

    const job = board.get('ses_child1');
    expect(job?.state).toBe('running');
    if (!job) throw new Error('missing running job');
    expect(
      board.acquireLease(job.taskID, job.generation, 'cancellation'),
    ).toBeUndefined();
    expect(
      board.acquireLease(job.taskID, job.generation, 'relaunch'),
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
      board.acquireLease(job.taskID, job.generation, 'cancellation')?.kind,
    ).toBe('cancellation');
  });

  test('rejects API failures and releases the message lease without stamping', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = mock(async () => ({ error: { message: 'HTTP 409' } }));
    client = { session: makeSession(prompt) };

    await expect(send(board, 'Please continue.')).rejects.toThrow('HTTP 409');

    const job = board.get('ses_child1');
    expect(job?.state).toBe('running');
    // A rejected response proves no accepted deposit: nothing is stamped.
    expect(job?.amendmentInputMessageID).toBeUndefined();
    if (!job) throw new Error('missing running job');
    expect(
      board.acquireLease(job.taskID, job.generation, 'cancellation')?.kind,
    ).toBe('cancellation');
  });

  test('a thrown transport rejects without stamping or repeating the prompt', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const failure = new Error('connection reset before admission');
    const prompt = mock(async () => {
      throw failure;
    });
    client = { session: makeSession(prompt) };

    await expect(send(board, 'Please continue.')).rejects.toThrow(
      'connection reset before admission',
    );

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(board.get('ses_child1')?.state).toBe('running');
    expect(board.get('ses_child1')?.amendmentInputMessageID).toBeUndefined();
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
          : Promise.resolve(hostAccepted()),
      );
      client = { session: makeSession(prompt) };
      const acquire = spyOn(ProductionBoard.prototype, 'acquireLease');
      const release = spyOn(ProductionBoard.prototype, 'releaseLease');
      const context = { sessionID: 'parent-1' } as any;
      const tool = createTool(board);

      await expect(
        createToolWithTimeout(board, 5).execute(
          { task_id: 'ses_child1', message: 'Please continue.' },
          context,
        ),
      ).rejects.toThrow('timed out');
      const lease = acquire.mock.results
        .map((result) => result?.value)
        .find((value) => value?.kind === 'message');
      if (!lease) throw new Error('missing message lease');
      const retirements = () =>
        release.mock.calls.filter(
          ([candidate]) => candidate.token === lease.token,
        );
      expect(board.validateLease(lease)).toBe(true);
      expect(retirements()).toHaveLength(0);
      expect(
        board.acquireLease(lease.taskID, lease.generation, 'cancellation'),
      ).toBeUndefined();
      expect(
        board.acquireLease(lease.taskID, lease.generation, 'relaunch'),
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
          board.acquireLease(
            lease.taskID,
            lease.generation,
            'terminal-notification',
          ),
        ).toBeUndefined();
      }
      const beforeSettlement = { ...board.get(lease.taskID) };
      if (settlement === 'reject')
        transport.reject(new Error('late transport failure'));
      else transport.resolve(hostAccepted());
      await drainMicrotasks();
      expect(retirements()).toHaveLength(1);
      expect(board.validateLease(lease)).toBe(false);
      if (settlement === 'reject') {
        // A late failure proves no acceptance: nothing is stamped.
        expect(board.get(lease.taskID)).toEqual(beforeSettlement);
      } else {
        // A late SUCCESS is still this run's admitted deposit: the boundary
        // must survive the timeout so diagnostics can attribute the tail.
        expect(board.get(lease.taskID)).toEqual({
          ...beforeSettlement,
          amendmentInputMessageID: HOST_MESSAGE_ID,
        });
      }

      const afterSettlement = { ...board.get(lease.taskID) };

      const replacement = completed
        ? board.acquireLease(
            lease.taskID,
            lease.generation,
            'terminal-notification',
          )
        : board.acquireLease(lease.taskID, lease.generation, 'message');
      expect(replacement?.kind).toBe(
        completed ? 'terminal-notification' : 'message',
      );
      if (!replacement) throw new Error('settled write retained exclusion');
      // The settled write's lease is stale: releasing is a rejected no-op that
      // must not retire the replacement token.
      expect(board.releaseLease(lease)).toBe(false);
      expect(board.validateLease(replacement)).toBe(true);
      expect(board.get(lease.taskID)).toEqual(afterSettlement);
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

    await expect(send(board, 'Please continue.')).rejects.toThrow(
      'no longer tracked',
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  test('a same-run terminal published before the response still stamps captured + 1', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board, 'ses_child1', 'parent-1', 'msg_open');
    const run = board.get('ses_child1');
    if (!run) throw new Error('missing child');

    // The host writes the message and only then returns; the run's single
    // terminal outcome publishes BEFORE the response is delivered.
    const prompt = mock(async () => {
      const ended = board.updateStatus({
        taskID: 'ses_child1',
        state: 'error',
        resultSummary: 'provider timeout',
        now: 200,
      });
      if (ended?.state !== 'error') throw new Error('expected terminal');
      return hostAccepted();
    });
    client = { session: makeSession(prompt) };

    await expect(send(board, 'Continue.')).resolves.toContain('queued');

    const stamped = board.get('ses_child1');
    const messageID = HOST_MESSAGE_ID;
    expect(stamped).toMatchObject({
      state: 'error',
      terminalRevision: run.terminalRevision + 1,
      amendmentInputMessageID: messageID,
      resultSummary: 'provider timeout',
    });
  });

  test.each(['terminal + 1', 'reopened + 2'])(
    'a deposit accepted only after the deadline keeps its boundary (%s)',
    async (outcome) => {
      const board = new BackgroundJobBoard();
      registerRunningChild(board, 'ses_child1', 'parent-1', 'msg_open');
      const run = board.get('ses_child1');
      if (!run) throw new Error('missing child');
      const transport = Promise.withResolvers<unknown>();
      const prompt = mock(() => transport.promise);
      client = { session: makeSession(prompt) };

      // The transport is still pending when the tool's deadline expires.
      await expect(
        createToolWithTimeout(board, 5).execute(
          { task_id: 'ses_child1', message: 'Continue.' },
          { sessionID: 'parent-1' } as any,
        ),
      ).rejects.toThrow('timed out');

      const ended = board.updateStatus({
        taskID: 'ses_child1',
        state: 'error',
        resultSummary: 'provider timeout',
        now: 200,
      });
      if (outcome === 'reopened + 2') {
        const reopened = board.markRunningFromLiveSession(
          'ses_child1',
          (ended?.completedAt ?? 0) + 1000,
        );
        if (reopened?.state !== 'running') throw new Error('expected reopen');
      }

      // The host accepted the deposit; only now does the response resolve.
      transport.resolve(hostAccepted());
      await drainMicrotasks();

      const stamped = board.get('ses_child1');
      const messageID = HOST_MESSAGE_ID;
      if (outcome === 'reopened + 2') {
        // The reopened run is not the captured one: no stale boundary.
        expect(stamped?.amendmentInputMessageID).toBeUndefined();
        expect(stamped?.terminalRevision).toBe(run.terminalRevision + 2);
        return;
      }
      expect(stamped).toMatchObject({
        state: 'error',
        terminalRevision: run.terminalRevision + 1,
        amendmentInputMessageID: messageID,
        runInputMessageID: 'msg_open',
      });
      // The single cross-module read-through proof: the late boundary keeps
      // the late-accepted run readable.
      const transcript = {
        data: [
          {
            info: { id: 'msg_open', role: 'user', time: { created: 10 } },
            parts: [],
          },
          {
            info: { id: messageID, role: 'user', time: { created: 150 } },
            parts: [],
          },
          {
            info: {
              role: 'assistant',
              time: { created: 160, completed: 170 },
            },
            parts: [{ type: 'text', text: 'late deposit failed tail' }],
          },
        ],
      };
      const excerpt = diagnosticExcerptOf(transcript, {
        inputMessageID: stamped?.runInputMessageID,
        amendmentMessageID: stamped?.amendmentInputMessageID,
        runStartedAt: stamped?.runStartedAt,
        completedAt: stamped?.completedAt,
      });
      if (!('text' in excerpt)) throw new Error(excerpt.unavailable);
      expect(excerpt.text).toContain('late deposit failed tail');
      // Without the recorded amendment the same transcript refuses.
      expect(
        diagnosticExcerptOf(transcript, {
          inputMessageID: stamped?.runInputMessageID,
          runStartedAt: stamped?.runStartedAt,
          completedAt: stamped?.completedAt,
        }),
      ).toHaveProperty('unavailable');
    },
  );

  test('a same-run stop published before the response still stamps captured + 1', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const run = board.get('ses_child1');
    if (!run) throw new Error('missing child');

    const prompt = mock(async () => {
      // Stop-family publication: no terminal task result, same run.
      board.updateStatus({
        taskID: 'ses_child1',
        state: 'stopped',
        resultSummary: 'no terminal result',
        now: 200,
      });
      return hostAccepted();
    });
    client = { session: makeSession(prompt) };

    await expect(send(board, 'Continue.')).resolves.toContain('queued');

    const messageID = HOST_MESSAGE_ID;
    expect(board.get('ses_child1')).toMatchObject({
      state: 'stopped',
      terminalRevision: run.terminalRevision + 1,
      amendmentInputMessageID: messageID,
    });
  });

  test('a cancellation queued behind an accepted deposit keeps the recorded amendment', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const run = board.get('ses_child1');
    if (!run) throw new Error('missing child');
    const prompt = makePrompt();
    client = { session: makeSession(prompt) };

    await send(board, 'Continue.');
    const messageID = HOST_MESSAGE_ID;
    expect(board.get('ses_child1')?.amendmentInputMessageID).toBe(messageID);

    // A cancellation lands after the accepted deposit: the recorded same-run
    // ID must survive that transition.
    const cancellationLease = board.acquireLease(
      'ses_child1',
      run.generation,
      'cancellation',
    );
    if (!cancellationLease) throw new Error('missing cancellation lease');
    const cancelled = board.markCancelled('ses_child1', 'user requested', 200, {
      cancellationLease,
    });
    board.releaseLease(cancellationLease);
    expect(cancelled).toMatchObject({
      state: 'cancelled',
      terminalRevision: run.terminalRevision + 1,
      amendmentInputMessageID: messageID,
    });
  });

  test('a reopen between dispatch and the response refuses the stale stamp', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const run = board.get('ses_child1');
    if (!run) throw new Error('missing child');

    const prompt = mock(async () => {
      // Deterministic: the run publishes, then is observed live again in the
      // SAME generation while the deposit is in flight.
      const ended = board.updateStatus({
        taskID: 'ses_child1',
        state: 'error',
        resultSummary: 'first failure',
        now: 200,
      });
      if (ended?.state !== 'error') throw new Error('expected terminal');
      const reopened = board.markRunningFromLiveSession('ses_child1', 300);
      if (reopened?.state !== 'running') throw new Error('expected reopen');
      return hostAccepted();
    });
    client = { session: makeSession(prompt) };

    // A running-only recheck would accept the reopened row; only the board's
    // revision fence can refuse.
    await expect(send(board, 'Continue.')).resolves.toContain(
      'no amendment boundary',
    );

    const reopened = board.get('ses_child1');
    expect(reopened?.state).toBe('running');
    expect(reopened?.terminalRevision).toBe(run.terminalRevision + 2);
    expect(reopened?.amendmentInputMessageID).toBeUndefined();

    // The reopened run's own terminal publication refuses the old fence too.
    const secondEnd = board.updateStatus({
      taskID: 'ses_child1',
      state: 'error',
      resultSummary: 'second failure',
      now: 400,
    });
    expect(secondEnd?.terminalRevision).toBe(run.terminalRevision + 3);
    expect(secondEnd?.amendmentInputMessageID).toBeUndefined();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  test('a deposit whose row disappeared before the response refuses the stamp', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = mock(async () => {
      board.drop('ses_child1');
      return hostAccepted();
    });
    client = { session: makeSession(prompt) };

    await expect(send(board, 'Continue.')).resolves.toContain(
      'no amendment boundary',
    );
    expect(board.get('ses_child1')).toBeUndefined();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  test('a disposed plugin does not stamp an already-accepted deposit', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    let disposed = false;
    const prompt = mock(async () => {
      disposed = true;
      return hostAccepted();
    });
    client = { session: makeSession(prompt) };
    const tool = createTaskMessageTool({
      input: { directory: '/test', client } as any,
      backgroundJobBoard: board,
      isDisposed: () => disposed,
    }).task_message;

    await expect(
      tool.execute({ task_id: 'ses_child1', message: 'Continue.' }, {
        sessionID: 'parent-1',
      } as any),
    ).resolves.toContain('no amendment boundary');
    expect(board.get('ses_child1')?.amendmentInputMessageID).toBeUndefined();
  });

  test('a reopen during the model lookup dispatches into the live run and stamps it', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const run = board.get('ses_child1');
    if (!run) throw new Error('missing child');
    const messages = mock(async () => {
      // The deposit's run ends and is observed live again DURING the model
      // lookup, before dispatch. The send-time validation then sees the
      // reopened run, so the deposit belongs to it and must be stamped with
      // ITS revision — never the pre-lookup capture.
      const ended = board.updateStatus({
        taskID: 'ses_child1',
        state: 'error',
        resultSummary: 'first failure',
        now: 200,
      });
      if (ended?.state !== 'error') throw new Error('expected terminal');
      const reopened = board.markRunningFromLiveSession('ses_child1', 300);
      if (reopened?.state !== 'running') throw new Error('expected reopen');
      return {
        data: [
          {
            info: {
              role: 'user',
              model: { providerID: 'openai', id: 'gpt-6' },
            },
          },
        ],
      };
    });
    const prompt = makePrompt();
    client = { session: { messages, prompt } };

    await expect(send(board, 'Continue.')).resolves.toContain('queued');

    const dispatched = board.get('ses_child1');
    expect(dispatched?.state).toBe('running');
    expect(dispatched?.terminalRevision).toBe(run.terminalRevision + 2);
    expect(dispatched?.amendmentInputMessageID).toBe(HOST_MESSAGE_ID);
  });

  test('rejects terminal and cancelling tasks', async () => {
    const terminalBoard = new BackgroundJobBoard();
    registerRunningChild(terminalBoard);
    terminalBoard.updateStatus({ taskID: 'ses_child1', state: 'completed' });
    const terminalPrompt = makePrompt();
    client = { session: { prompt: terminalPrompt } };

    await expect(send(terminalBoard, 'Too late')).rejects.toThrow(
      'task_revive',
    );
    await expect(send(terminalBoard, 'Too late')).rejects.toThrow(
      'task_revive and task_id: "ses_child1"',
    );
    let message = '';
    try {
      await send(terminalBoard, 'Too late');
    } catch (error) {
      message = (error as Error).message;
    }
    // Terminal-resume guidance names task_revive with the task_id param.
    expect(message).toContain(
      'Continue that same session with task_revive and task_id: "ses_child1".',
    );
    expect(message).not.toContain('task_result');
    expect(message).not.toContain('task(');
    expect(message).not.toContain('sessionID');
    expect(terminalPrompt).not.toHaveBeenCalled();

    const cancellingBoard = new BackgroundJobBoard();
    registerRunningChild(cancellingBoard);
    cancellingBoard.markCancelled('ses_child1', 'stop requested');
    const cancellingPrompt = makePrompt();
    client = { session: { prompt: cancellingPrompt } };

    await expect(send(cancellingBoard, 'Do not send')).rejects.toThrow(
      'cancellation was requested',
    );
    expect(cancellingPrompt).not.toHaveBeenCalled();
  });

  test('v1 exposes the task_id schema and emits no delivery', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = { session: makeSession(prompt) };
    const v1 = createTool(board);

    expect(Object.keys(v1.args)).not.toContain('delivery');
    expect(Object.keys(v1.args).sort()).toEqual(['message', 'task_id']);

    await v1.execute({ task_id: 'ses_child1', message: 'Status update' }, {
      sessionID: 'parent-1',
    } as any);
    const body = prompt.mock.calls[0]?.[0].body;
    expect(body).not.toHaveProperty('delivery');
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
    // No launch registered: the board lost the child while the host session
    // still exists.
    const error = (await send(board, 'go').catch((e: Error) => e)) as Error;
    expect(error.message).toContain('Unknown task ID or alias: ses_child1');
    expect(error.message).toContain('not tracked');
    // v1 routing names the host-flavor resume param and the target ID.
    expect(error.message).toContain('task_revive and task_id: "ses_child1"');
    expect(error.message).toContain('do not launch a duplicate');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('a board-missed alias keeps the bare unknown error', async () => {
    const board = new BackgroundJobBoard();
    const prompt = makePrompt();
    client = { session: { prompt } };
    // An alias is board-scoped: without a record the error stays bare.
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
    // A foreign parent's record is visible through canonical resolution; the
    // settled-session advice must not fire, so the error stays bare.
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

  test('a refused alias still enumerates recent handles', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = { session: { prompt } };
    const task_message = createTaskMessageTool({
      input: { directory: '/test', client } as any,
      backgroundJobBoard: board,
      resolveCanonicalTaskRef: async () => ({
        kind: 'refused',
        reason: 'Unknown task ID or alias: fix-9',
      }),
    }).task_message;
    const error = (await task_message
      .execute({ task_id: 'fix-9', message: 'go' }, {
        sessionID: 'parent-1',
      } as any)
      .catch((e: Error) => e)) as Error;
    expect(error.message).toContain('Unknown task ID or alias: fix-9');
    expect(error.message).toContain('recent:');
    expect(prompt).not.toHaveBeenCalled();
  });
  test('a disposal landing after the helper check still stops the send', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    const prompt = makePrompt();
    client = { session: { prompt } };
    // The helper check passes (call 1); execute's post-await re-check
    // (call 2) must refuse to send.
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

    await expect(send(board, 'Do not send')).rejects.toThrow('message lease');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('uses explicit queue wording without legacy delivery terms', async () => {
    const board = new BackgroundJobBoard();
    registerRunningChild(board);
    client = { session: makeSession(makePrompt()) };

    const result = await send(board, 'Status update');

    expect(result).toContain('queued');
    expect(result).not.toContain('delivered');
    expect(result).not.toContain('admitted');
    expect(result).not.toContain('nudge');
  });
});
