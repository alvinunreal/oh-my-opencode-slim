import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../background-jobs';
import type {
  BackgroundJobSupervisor,
  BackgroundTaskConcurrency,
} from '../../utils';

// Route getClient back to _ctx.client so the mock ctx client is what the
// rehydrate probe sees (same pattern as index.test.ts).
mock.module('../../utils/opencode-client', () => ({
  getClient: (input: { client: unknown }) => input.client as never,
}));

import { createBackgroundJobLifecycle } from '../../background-jobs';
import { createTaskSessionManagerHook } from './index';

function taskLaunchOutput(taskID: string): string {
  return [
    `task_id: ${taskID}`,
    'state: running',
    '',
    '<task_result>',
    'Background task started.',
    '</task_result>',
  ].join('\n');
}

function historicalRunningPart(taskID: string) {
  return {
    type: 'tool',
    tool: 'task',
    state: {
      status: 'running',
      input: {
        background: true,
        subagent_type: 'explorer',
        description: 'probe task',
        prompt: 'inspect state',
      },
      output: taskLaunchOutput(taskID),
    },
  };
}

function rehydrateMessages(taskID: string) {
  return {
    messages: [
      {
        info: {
          role: 'assistant',
          agent: 'orchestrator',
          sessionID: 'parent-1',
        },
        parts: [historicalRunningPart(taskID)],
      },
      {
        info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
        parts: [{ type: 'text', text: 'continue' }],
      },
    ],
  };
}

/** Flush the fire-and-forget probe's promise chain. */
function flushProbe() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/** Manually-resolved promise for holding a probe's get in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createHook(options: {
  board: BackgroundJobBoard;
  getSession?: (input: Record<string, unknown>) => Promise<unknown>;
  getMessages?: (input: Record<string, unknown>) => Promise<unknown>;
  supervisor?: BackgroundJobSupervisor;
  concurrency?: BackgroundTaskConcurrency;
}) {
  const input = {
    client: {
      session: {
        status: mock(async () => ({ data: {} })),
        ...(options.getSession ? { get: options.getSession } : {}),
        ...(options.getMessages ? { messages: options.getMessages } : {}),
      },
    },
    directory: '/tmp',
    worktree: '/tmp',
  } as never;
  return createTaskSessionManagerHook(input, {
    maxSessionsPerAgent: 2,
    maxRetainedSnapshots: 4,
    backgroundJobs: createBackgroundJobLifecycle({
      backgroundJobBoard: options.board,
      input,
      hostOutcomeClock: 'shared-unix-ms', // The fixture shares Date.now with the gate.
      ...(options.supervisor ? { supervisor: options.supervisor } : {}),
    }),
    hostOutcomeClock: 'shared-unix-ms', // The fixture shares Date.now with the gate.
    backgroundTaskConcurrency: options.concurrency,
    shouldManageSession: () => true,
    runtimeStatusReconcileDelayMs: 60_000,
  });
}

async function runTransform(
  hook: ReturnType<typeof createTaskSessionManagerHook>,
  taskID: string,
) {
  await hook['experimental.chat.messages.transform'](
    {},
    rehydrateMessages(taskID) as never,
  );
}

describe('rehydrate session.get existence probe', () => {
  test('NotFound (_tag) tombstones the run and fires every cleanup action', async () => {
    const board = new BackgroundJobBoard();
    const onSessionDeleted = mock(() => true);
    const releaseTask = mock(() => {});
    const supervisor = {
      onSessionDeleted,
    } as unknown as BackgroundJobSupervisor;
    const concurrency = {
      releaseTask,
      restoreTask: mock(() => {}),
    } as unknown as BackgroundTaskConcurrency;
    const notFound = Object.assign(new Error('session not found'), {
      _tag: 'Session.NotFoundError',
    });
    const hook = createHook({
      board,
      supervisor,
      concurrency,
      getSession: mock(() => Promise.reject(notFound)),
    });

    await runTransform(hook, 'child-gone');
    // The probe is fire-and-forget; flush its promise chain.
    await flushProbe();

    expect(board.get('child-gone')).toBeUndefined();
    expect(onSessionDeleted).toHaveBeenCalledWith('child-gone');
    expect(releaseTask).toHaveBeenCalledWith('child-gone');
    expect(board.ledger.tombstones.has('child-gone')).toBe(true);

    // The tombstone prevents the next transform from resurrecting the run.
    await runTransform(hook, 'child-gone');
    await flushProbe();
    expect(board.get('child-gone')).toBeUndefined();
    expect(board.list()).toHaveLength(0);
  });

  test('a NotFound resolving after a same-ID relaunch leaves the live record alone', async () => {
    const board = new BackgroundJobBoard();
    const releaseTask = mock(() => {});
    const onSessionDeleted = mock(() => true);
    const notFound = Object.assign(new Error('gone'), {
      _tag: 'Session.NotFoundError',
    });
    const gate = deferred<void>();
    const hook = createHook({
      board,
      supervisor: {
        onSessionDeleted,
      } as unknown as BackgroundJobSupervisor,
      concurrency: {
        releaseTask,
        restoreTask: mock(() => {}),
      } as unknown as BackgroundTaskConcurrency,
      // Hold the probe's get in flight until the relaunch below lands.
      getSession: mock(() => gate.promise.then(() => Promise.reject(notFound))),
    });

    // Rehydrate registers generation 1 and the probe starts against it.
    const transform = runTransform(hook, 'child-stale-probe');
    await flushProbe();
    const relaunched = board.registerLaunch({
      taskID: 'child-stale-probe',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'legitimate relaunch while probe in flight',
    });
    expect(relaunched.generation).toBe(2);

    // The stale NotFound resolves only now — it must NOT tombstone or
    // drop the live relaunched record.
    gate.resolve();
    await transform;
    await flushProbe();

    expect(board.get('child-stale-probe')).toMatchObject({
      generation: relaunched.generation,
      state: 'running',
    });
    expect(board.ledger.tombstones.has('child-stale-probe')).toBe(false);
    expect(onSessionDeleted).not.toHaveBeenCalled();
    expect(releaseTask).not.toHaveBeenCalled();
  });

  test('a terminal outcome resolving after a same-ID relaunch does not settle the new run', async () => {
    const board = new BackgroundJobBoard();
    const gate = deferred<void>();
    const hook = createHook({
      board,
      // Hold the probe's get in flight until the relaunch below lands.
      getSession: mock(() =>
        gate.promise.then(async () => ({ outcome: 'failed' })),
      ),
    });

    // Rehydrate registers generation 1 and the probe starts against it.
    const transform = runTransform(hook, 'child-stale-settle');
    await flushProbe();
    const relaunched = board.registerLaunch({
      taskID: 'child-stale-settle',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'legitimate relaunch while probe in flight',
    });
    expect(relaunched.generation).toBe(2);

    // The stale probe's terminal outcome resolves only now — it must NOT
    // terminalize the relaunched generation (updateStatus rejects via
    // the probe-start generation; no markReconciled).
    gate.resolve();
    await transform;
    await flushProbe();

    expect(board.get('child-stale-settle')).toMatchObject({
      generation: relaunched.generation,
      state: 'running',
      terminalState: undefined,
      resultSummary: undefined,
    });
  });

  test('transient probe rejection fails open (job stays registered)', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook({
      board,
      getSession: mock(() => Promise.reject(new Error('ECONNRESET'))),
    });

    await runTransform(hook, 'child-flaky');
    await flushProbe();

    expect(board.get('child-flaky')).toMatchObject({ state: 'running' });
    expect(board.ledger.tombstones.has('child-flaky')).toBe(false);
  });

  test('existing session with a succeeded outcome settles via final text', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook({
      board,
      getSession: mock(async () => ({
        data: {
          id: 'child-done',
          outcome: 'succeeded',
          time: { idle: Date.now() },
        },
      })),
      getMessages: mock(async () => ({
        data: [
          {
            info: { id: 'm1', role: 'assistant' },
            parts: [{ type: 'text', text: 'final answer' }],
          },
        ],
      })),
    });

    await runTransform(hook, 'child-done');
    await flushProbe();

    expect(board.get('child-done')).toMatchObject({
      // Confirmation is not acknowledgement: this result still needs delivery.
      state: 'completed',
      terminalState: 'completed',
      resultSummary: 'final answer',
    });
  });

  test('existing session with a failed outcome settles as error', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook({
      board,
      getSession: mock(async () => ({
        outcome: 'failed',
        time: { idle: Date.now() },
      })),
    });

    await runTransform(hook, 'child-failed');
    await flushProbe();

    expect(board.get('child-failed')).toMatchObject({
      state: 'error',
      terminalState: 'error',
      resultSummary: 'Host reported outcome: failed.',
    });
  });

  test('a still-running host session is left alone', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook({
      board,
      getSession: mock(async () => ({ outcome: undefined })),
    });

    await runTransform(hook, 'child-live');
    await flushProbe();

    expect(board.get('child-live')).toMatchObject({ state: 'running' });
  });

  test('hosts without session.get skip the probe silently', async () => {
    const board = new BackgroundJobBoard();
    const releaseTask = mock(() => {});
    const hook = createHook({
      board,
      concurrency: {
        releaseTask,
        restoreTask: mock(() => {}),
      } as unknown as BackgroundTaskConcurrency,
    });

    await runTransform(hook, 'child-inert');
    await flushProbe();

    expect(board.get('child-inert')).toMatchObject({ state: 'running' });
    expect(releaseTask).not.toHaveBeenCalled();
  });

  test('the probe never surfaces an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      const board = new BackgroundJobBoard();
      const notFound = Object.assign(new Error('gone'), {
        _tag: 'Session.NotFoundError',
      });
      const notFoundHook = createHook({
        board,
        getSession: mock(() => Promise.reject(notFound)),
      });
      await runTransform(notFoundHook, 'child-unhandled-gone');
      const transientHook = createHook({
        board,
        getSession: mock(() =>
          Promise.reject(new Error('boom before get resolves')),
        ),
      });
      await runTransform(transientHook, 'child-unhandled-flaky');
      await flushProbe();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
