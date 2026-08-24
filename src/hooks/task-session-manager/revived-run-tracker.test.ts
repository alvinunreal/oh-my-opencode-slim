import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { createRevivedRunTracker } from './revived-run-tracker';

function createHarness(
  messages: () => unknown,
  prompt = mock(async () => ({})),
  assertBound = false,
  shouldManageSession?: (sessionID: string) => boolean,
) {
  const board = new BackgroundJobBoard();
  board.registerLaunch({
    taskID: 'ses_child',
    parentSessionID: 'parent',
    agent: 'explorer',
    background: true,
  });
  board.updateStatus({
    taskID: 'ses_child',
    state: 'completed',
    resultSummary: 'old result',
  });
  board.markReconciled('ses_child');
  const lease = board.acquireRelaunchLease('ses_child', 1);
  if (!lease) throw new Error('missing relaunch lease');
  const run = board.registerLaunch({
    taskID: 'ses_child',
    parentSessionID: 'parent',
    agent: 'explorer',
    description: 'inspect the change',
    background: true,
    relaunchLease: lease,
  });
  board.releaseLease(lease);
  let session: {
    messages: ReturnType<typeof mock>;
    promptAsync: ReturnType<typeof mock>;
  };
  session = {
    messages: mock(function (this: unknown) {
      if (assertBound) expect(this).toBe(session);
      return messages();
    }),
    promptAsync: mock(function (this: unknown, ..._args: unknown[]) {
      if (assertBound) expect(this).toBe(session);
      return prompt();
    }),
  };
  const input = {
    directory: '/test',
    client: {
      session,
    },
  } as never;
  const settled = mock(() => {});
  const pruned = mock(() => {});
  const tracker = createRevivedRunTracker({
    input,
    backgroundJobBoard: board,
    notificationRetryDelayMs: 0,
    onSettled: settled,
    pruneContext: pruned,
    shouldManageSession,
  });
  return {
    board,
    run,
    tracker,
    prompt: session.promptAsync,
    settled,
    pruned,
  };
}

describe('revived run tracker', () => {
  test('publishes a newer completed assistant turn and notifies the parent', async () => {
    let probe = false;
    const harness = createHarness(
      () =>
        probe
          ? {
              data: [
                { info: { id: 'baseline', role: 'user' }, parts: [] },
                {
                  info: {
                    id: 'assistant-1',
                    role: 'assistant',
                    time: { completed: 2 },
                  },
                  parts: [{ type: 'text', text: 'new result' }],
                },
              ],
            }
          : { data: [{ info: { id: 'baseline', role: 'user' }, parts: [] }] },
      undefined,
      true,
    );
    const baseline = await harness.tracker.captureBaseline('ses_child');
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: baseline,
      description: 'inspect the change',
    });
    probe = true;
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);

    expect(harness.board.get('ses_child')).toMatchObject({
      state: 'completed',
      resultSummary: 'new result',
    });
    expect(harness.prompt).toHaveBeenCalledTimes(1);
    expect(harness.prompt.mock.calls[0]?.[0]).toMatchObject({
      path: { id: 'parent' },
      body: {
        agent: 'orchestrator',
        parts: [{ type: 'text', synthetic: true }],
      },
    });
  });

  test('keeps a non-terminal idle turn running and rejects historical output', async () => {
    const harness = createHarness(() => ({
      data: [
        { info: { id: 'baseline', role: 'user' }, parts: [] },
        {
          info: {
            id: 'assistant-old',
            role: 'assistant',
            time: { completed: 1 },
          },
          parts: [{ type: 'text', text: 'old result' }],
        },
        {
          info: { id: 'assistant-new', role: 'assistant' },
          parts: [{ type: 'text', text: 'partial' }],
        },
      ],
    }));
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);

    expect(harness.board.get('ses_child')).toMatchObject({ state: 'running' });
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  test('publishes an explicitly empty completed turn but rejects tool-call finishes', async () => {
    let toolCallFinish = true;
    const harness = createHarness(() => ({
      data: [
        { info: { id: 'baseline', role: 'user' }, parts: [] },
        {
          info: {
            id: 'assistant-new',
            role: 'assistant',
            time: { completed: 2 },
            finish: toolCallFinish ? 'tool-calls' : 'stop',
          },
          parts: [],
        },
      ],
    }));
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });
    expect(
      await harness.tracker.probe(harness.run.taskID, harness.run.generation),
    ).toBe(false);
    expect(harness.board.get('ses_child')?.state).toBe('running');

    toolCallFinish = false;
    expect(
      await harness.tracker.probe(harness.run.taskID, harness.run.generation),
    ).toBe(true);
    expect(harness.board.get('ses_child')).toMatchObject({
      state: 'completed',
      resultSummary: '',
    });
  });

  test('publishes immediate child errors and ignores stale generations', async () => {
    const harness = createHarness(() => ({
      data: [
        { info: { id: 'baseline', role: 'user' }, parts: [] },
        {
          info: {
            id: 'assistant-error',
            role: 'assistant',
            time: { completed: 3 },
            error: { message: 'provider failed' },
          },
          parts: [],
        },
      ],
    }));
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });
    const staleLease = harness.board.acquireRelaunchLease(
      harness.run.taskID,
      harness.run.generation,
    );
    if (!staleLease) throw new Error('missing stale lease');
    const newer = harness.board.registerLaunch({
      taskID: harness.run.taskID,
      parentSessionID: 'parent',
      agent: 'explorer',
      background: true,
      relaunchLease: staleLease,
    });
    harness.board.releaseLease(staleLease);
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);
    expect(harness.board.get('ses_child')).toMatchObject({
      generation: newer.generation,
      state: 'running',
    });
  });

  test('retries parent notification without changing the terminal board state', async () => {
    let attempts = 0;
    const prompt = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('parent unavailable');
      return {};
    });
    const harness = createHarness(
      () => ({
        data: [
          { info: { id: 'baseline', role: 'user' }, parts: [] },
          {
            info: {
              id: 'assistant-1',
              role: 'assistant',
              time: { completed: 2 },
            },
            parts: [{ type: 'text', text: 'done' }],
          },
        ],
      }),
      prompt,
    );
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.board.markReconciled(harness.run.taskID);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.board.get('ses_child')?.state).toBe('reconciled');
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  test('holds the terminal notification lease while parent transport is active', async () => {
    const harness = createHarness(() => ({ data: [] }));
    let relaunchLease: unknown;
    harness.prompt.mockImplementation(async () => {
      relaunchLease = harness.board.acquireRelaunchLease(
        harness.run.taskID,
        harness.run.generation,
      );
      return {};
    });
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      description: 'inspect the change',
    });
    const terminal = harness.board.updateStatus({
      taskID: harness.run.taskID,
      expectedGeneration: harness.run.generation,
      state: 'completed',
      resultSummary: 'done',
    });
    if (!terminal) throw new Error('missing terminal record');
    harness.tracker.onTerminal(terminal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(relaunchLease).toBeUndefined();
    expect(harness.board.get(harness.run.taskID)).toMatchObject({
      generation: harness.run.generation,
      state: 'completed',
    });
  });

  test('forwards coordinator terminal outcomes to one parent notification', async () => {
    const harness = createHarness(() => ({ data: [] }));
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      description: 'inspect the change',
    });
    const terminal = harness.board.updateStatus({
      taskID: harness.run.taskID,
      expectedGeneration: harness.run.generation,
      state: 'error',
      resultSummary: 'timeout',
    });
    if (!terminal) throw new Error('missing terminal record');
    harness.tracker.onTerminal(terminal);
    harness.tracker.onTerminal(terminal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.prompt).toHaveBeenCalledTimes(1);
  });

  test('skips parent notification when shouldManageSession returns false', async () => {
    const harness = createHarness(
      () => ({ data: [] }),
      undefined,
      false,
      () => false,
    );
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      description: 'inspect the change',
    });
    const terminal = harness.board.updateStatus({
      taskID: harness.run.taskID,
      expectedGeneration: harness.run.generation,
      state: 'completed',
      resultSummary: 'done',
    });
    if (!terminal) throw new Error('missing terminal record');
    harness.tracker.onTerminal(terminal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.prompt).toHaveBeenCalledTimes(0);
  });

  test('discards a retry when the task generation is relaunched', async () => {
    const prompt = mock(async () => {
      throw new Error('parent unavailable');
    });
    const harness = createHarness(() => ({ data: [] }), prompt);
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      description: 'inspect the change',
    });
    const terminal = harness.board.updateStatus({
      taskID: harness.run.taskID,
      expectedGeneration: harness.run.generation,
      state: 'completed',
      resultSummary: 'done',
    });
    if (!terminal) throw new Error('missing terminal record');
    harness.tracker.onTerminal(terminal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const lease = harness.board.acquireRelaunchLease(
      harness.run.taskID,
      harness.run.generation,
    );
    if (!lease) throw new Error('missing relaunch lease');
    const newer = harness.board.registerLaunch({
      taskID: harness.run.taskID,
      parentSessionID: 'parent',
      agent: 'explorer',
      background: true,
      relaunchLease: lease,
    });
    harness.board.releaseLease(lease);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(
      harness.tracker.isTracked(harness.run.taskID, newer.generation),
    ).toBe(false);
  });

  test('clears cancelled runs and pending context without notifying the parent', () => {
    const harness = createHarness(() => ({ data: [] }));
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      description: 'inspect the change',
    });
    const cancelled = harness.board.updateStatus({
      taskID: harness.run.taskID,
      expectedGeneration: harness.run.generation,
      state: 'cancelled',
      resultSummary: 'cancelled by user',
    });
    if (!cancelled) throw new Error('missing cancelled record');
    harness.tracker.onTerminal(cancelled);

    expect(
      harness.tracker.isTracked(harness.run.taskID, harness.run.generation),
    ).toBe(false);
    expect(harness.settled).toHaveBeenCalledTimes(1);
    expect(harness.pruned).toHaveBeenCalledTimes(1);
    expect(harness.prompt).not.toHaveBeenCalled();

    const lease = harness.board.acquireRelaunchLease(
      harness.run.taskID,
      harness.run.generation,
    );
    if (!lease) throw new Error('missing revive lease');
    const next = harness.board.registerLaunch({
      taskID: harness.run.taskID,
      parentSessionID: 'parent',
      agent: 'explorer',
      background: true,
      relaunchLease: lease,
    });
    harness.board.releaseLease(lease);
    harness.tracker.register({
      taskID: next.taskID,
      generation: next.generation,
      parentSessionID: 'parent',
      description: 'second revive',
    });
    harness.tracker.onTerminal(cancelled);
    expect(harness.tracker.isTracked(next.taskID, next.generation)).toBe(true);
  });
});
