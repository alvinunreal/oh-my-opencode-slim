import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { createRevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createCancelTaskTool } from './cancel-task';
import { createTaskReviveTool } from './task-revive';

let mockClient: Record<string, unknown>;

mock.module('../utils/opencode-client', () => ({
  getClient: () => mockClient,
}));

function createTool(overrides?: {
  abort?: () => Promise<unknown>;
  status?: () => Promise<unknown>;
  promptAsync?: () => Promise<unknown>;
  revivedRunTracker?: {
    captureBaseline: () => Promise<string | undefined>;
    register: (input: unknown) => void;
    isTracked: (taskID: string, generation: number) => boolean;
    probe: (taskID: string, generation: number) => Promise<boolean>;
    onTerminal: (record: unknown) => void;
    dispose: () => void;
  };
}) {
  const board = new BackgroundJobBoard();
  const abort = mock(overrides?.abort ?? (async () => ({})));
  const status = mock(
    overrides?.status ?? (async () => ({ data: { ses_1: { type: 'idle' } } })),
  );
  const promptAsync = mock(overrides?.promptAsync ?? (async () => ({})));
  mockClient = { session: { abort, status, promptAsync } };
  const revivedRunTracker =
    overrides?.revivedRunTracker ??
    createRevivedRunTracker({
      input: { directory: '/test/project' } as any,
      backgroundJobBoard: board,
    });
  const tools = createTaskReviveTool({
    input: { directory: '/test/project' } as any,
    backgroundJobBoard: board,
    shouldManageSession: () => true,
    verifyAbortMs: 10,
    abortRetryIntervalMs: 0,
    stableStoppedMs: 0,
    revivedRunTracker,
  });
  const cancelTools = createCancelTaskTool({
    input: { directory: '/test/project' } as any,
    backgroundJobBoard: board,
    shouldManageSession: () => true,
    verifyAbortMs: 10,
    abortRetryIntervalMs: 0,
    stableStoppedMs: 0,
  });
  return {
    board,
    abort,
    status,
    promptAsync,
    taskCancel: cancelTools.task_cancel,
    taskRevive: tools.task_revive,
  };
}

const context = { sessionID: 'parent-1', agent: 'orchestrator' } as any;

afterEach(() => mock.restore());

function acknowledgedCompleted(board: BackgroundJobBoard, taskID = 'ses_1') {
  board.registerLaunch({
    taskID,
    parentSessionID: 'parent-1',
    agent: 'explorer',
  });
  board.updateStatus({ taskID, state: 'completed', resultSummary: 'done' });
  board.markReconciled(taskID);
}

function stoppedSession(
  board: BackgroundJobBoard,
  taskID = 'ses_1',
  acknowledge = false,
) {
  board.registerLaunch({
    taskID,
    parentSessionID: 'parent-1',
    agent: 'explorer',
    now: 100,
  });
  board.markStopped(taskID, 'no native result', 110, undefined, 110);
  if (acknowledge) board.markReconciled(taskID);
}

describe('task_revive tool', () => {
  test('uses promptAsync, starts a new board generation, and retains the session', async () => {
    const { board, promptAsync, taskRevive } = createTool();
    acknowledgedCompleted(board);

    const output = await taskRevive.execute(
      { task_id: 'ses_1', prompt: 'Continue the investigation' },
      context,
    );

    expect(promptAsync).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      query: { directory: '/test/project' },
      body: {
        agent: 'explorer',
        parts: [{ type: 'text', text: 'Continue the investigation' }],
      },
      delivery: 'queue',
    });
    const call = promptAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.body).not.toHaveProperty('noReply', true);
    expect(String(output)).toContain('state: running');
    expect(String(output)).toContain('status: started');
    expect(board.get('ses_1')).toMatchObject({
      generation: 2,
      state: 'running',
    });
    const lease = board.acquireRelaunchLease('ses_1', 2);
    expect(lease).toBeDefined();
    if (lease) board.releaseLease(lease);
  });

  test('reports a fast terminal completion observed by the immediate probe', async () => {
    let board: BackgroundJobBoard;
    const tracker = {
      captureBaseline: async () => undefined,
      register: () => {},
      isTracked: () => false,
      probe: async (_taskID: string, generation: number) => {
        board.updateStatus({
          taskID: 'ses_1',
          expectedGeneration: generation,
          state: 'completed',
          resultSummary: 'fast completion',
        });
        return true;
      },
      onTerminal: () => {},
      dispose: () => {},
    };
    const tools = createTool({ revivedRunTracker: tracker });
    board = tools.board;
    acknowledgedCompleted(board);

    const output = await tools.taskRevive.execute(
      { task_id: 'ses_1', prompt: 'finish quickly' },
      context,
    );

    expect(String(output)).toContain('state: completed');
    expect(String(output)).toContain('status: completed');
    expect(String(output)).toContain('fast completion');
    expect(String(output)).not.toContain('state: running');
    expect(tools.board.get('ses_1')).toMatchObject({
      generation: 2,
      state: 'completed',
    });
  });

  test('cancels a running generation and launches its replacement in order', async () => {
    const events: string[] = [];
    const { board, abort, promptAsync, taskRevive } = createTool({
      abort: async () => {
        events.push('abort');
        return {};
      },
      status: async () => ({ data: { ses_1: { type: 'idle' } } }),
      promptAsync: async () => {
        events.push('promptAsync');
        return {};
      },
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    await taskRevive.execute(
      { task_id: 'ses_1', prompt: 'Resume with a new objective' },
      context,
    );

    expect(abort).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['abort', 'promptAsync']);
    expect(board.get('ses_1')).toMatchObject({
      generation: 2,
      state: 'running',
    });
  });

  test('revives a directly cancelled retained session before acknowledgement', async () => {
    const { board, promptAsync, taskCancel, taskRevive } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    await taskCancel.execute({ task_id: 'ses_1', reason: 'obsolete' }, context);
    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      terminalUnreconciled: true,
      statusUncertain: false,
    });

    const output = await taskRevive.execute(
      { task_id: 'ses_1', prompt: 'try again' },
      context,
    );

    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(String(output)).toContain('state: running');
    expect(board.get('ses_1')).toMatchObject({
      generation: 2,
      state: 'running',
    });
  });

  test('revives a stopped session before and after acknowledgement', async () => {
    for (const acknowledge of [false, true]) {
      const { board, promptAsync, taskRevive } = createTool();
      stoppedSession(board, 'ses_1', acknowledge);
      expect(board.get('ses_1')).toMatchObject({
        state: 'stopped',
        terminalUnreconciled: !acknowledge,
      });

      const output = await taskRevive.execute(
        { task_id: 'ses_1', prompt: 'continue from the retained session' },
        context,
      );

      expect(promptAsync).toHaveBeenCalledTimes(1);
      expect(String(output)).toContain('state: running');
      expect(board.get('ses_1')).toMatchObject({
        generation: 2,
        state: 'running',
      });
    }
  });

  test('refuses to relaunch when a late busy revives the generation during baseline capture', async () => {
    // P1 regression: captureBaseline awaits network I/O. If a live busy
    // observation arrives while the baseline is in flight, the revive
    // must NOT send promptAsync over the still-active generation, must
    // not bump the board generation, and must release the relaunch
    // lease. With the lease held, the busy observation keeps the record
    // stopped and only advances lastLiveBusyAt; the revive refuses on
    // that fresh-activity signal.
    let resolveBaseline: (id: string | undefined) => void = () => {};
    const baselineGate = new Promise<string | undefined>((resolve) => {
      resolveBaseline = resolve;
    });
    const deferredTracker = {
      captureBaseline: () => baselineGate,
      register: () => {},
      isTracked: () => false,
      probe: () => Promise.resolve(true),
      onTerminal: () => {},
      dispose: () => {},
    };
    const { board, promptAsync, taskRevive } = createTool({
      revivedRunTracker: deferredTracker as any,
    });
    stoppedSession(board);

    const pending = taskRevive.execute(
      { task_id: 'ses_1', prompt: 'continue' },
      context,
    );
    // Late busy observation lands while captureBaseline is in flight.
    board.markRunningFromLiveSession('ses_1', 115);
    resolveBaseline(undefined);

    await expect(pending).rejects.toThrow(/became active again/);
    expect(promptAsync).toHaveBeenCalledTimes(0);
    expect(board.get('ses_1')).toMatchObject({
      state: 'stopped',
      generation: 1,
      lastLiveBusyAt: 115,
    });
    // The relaunch lease was released: a new acquire on the same
    // generation succeeds.
    const reLease = board.acquireRelaunchLease('ses_1', 1);
    expect(reLease).toBeDefined();
    if (reLease) board.releaseLease(reLease);
  });

  test('refuses to relaunch when the host reports the session busy even if the board is stopped', async () => {
    // P1 regression (host fence): the board record stays stopped under
    // the relaunch lease, but the session may have resumed
    // independently at the host. On v2 hosts promptAsync degrades to
    // steering an in-flight run instead of rejecting it, so a live
    // busy/retry entry must refuse before the prompt is sent.
    const { board, promptAsync, status, taskRevive } = createTool({
      status: async () => ({ data: { ses_1: { type: 'busy' } } }),
    });
    stoppedSession(board);

    await expect(
      taskRevive.execute({ task_id: 'ses_1', prompt: 'continue' }, context),
    ).rejects.toThrow(/executing at the host/);

    expect(promptAsync).toHaveBeenCalledTimes(0);
    expect(status).toHaveBeenCalled();
    expect(board.get('ses_1')).toMatchObject({
      state: 'stopped',
      generation: 1,
    });
    const reLease = board.acquireRelaunchLease('ses_1', 1);
    expect(reLease).toBeDefined();
    if (reLease) board.releaseLease(reLease);
  });

  test('rejects an uncertain retained terminal job', async () => {
    const { board, promptAsync, taskRevive } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({
      taskID: 'ses_1',
      state: 'error',
      statusUncertain: true,
    });

    await expect(
      taskRevive.execute({ task_id: 'ses_1', prompt: 'try again' }, context),
    ).rejects.toThrow('verified retained terminal session');
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('rejects foreign, parent, and stale task requests', async () => {
    const { board, promptAsync, taskRevive } = createTool();
    acknowledgedCompleted(board, 'ses_foreign');
    const foreignRecord = board.get('ses_foreign');
    if (!foreignRecord) throw new Error('missing foreign record');
    board.updateStatus({ taskID: 'ses_foreign', state: 'completed' });
    board.markReconciled('ses_foreign');
    board.registerLaunch({
      taskID: 'ses_stale',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({ taskID: 'ses_stale', state: 'completed' });
    board.markReconciled('ses_stale');

    await expect(
      taskRevive.execute({ task_id: 'ses_foreign', prompt: 'x' }, {
        sessionID: 'parent-2',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('Unknown or unowned');
    await expect(
      taskRevive.execute({ task_id: 'parent-1', prompt: 'x' }, context),
    ).rejects.toThrow('Unknown or unowned');

    const originalResolve = board.resolve.bind(board);
    let mutated = false;
    board.resolve = mock((parent, requested) => {
      const result = originalResolve(parent, requested);
      if (result && requested === 'ses_stale' && !mutated) {
        mutated = true;
        const lease = board.acquireRelaunchLease(
          'ses_stale',
          result.generation,
        );
        if (!lease) throw new Error('missing stale relaunch lease');
        board.registerLaunch({
          taskID: 'ses_stale',
          parentSessionID: 'parent-1',
          agent: 'explorer',
          relaunchLease: lease,
        });
      }
      return result;
    });
    await expect(
      taskRevive.execute({ task_id: 'ses_stale', prompt: 'x' }, context),
    ).rejects.toThrow('run generation changed');
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('releases the relaunch lease when promptAsync fails', async () => {
    const { board, promptAsync, taskRevive } = createTool({
      promptAsync: async () => {
        throw new Error('host unavailable');
      },
    });
    acknowledgedCompleted(board);

    await expect(
      taskRevive.execute({ task_id: 'ses_1', prompt: 'retry' }, context),
    ).rejects.toThrow('host unavailable');
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const lease = board.acquireRelaunchLease('ses_1', 1);
    expect(lease).toBeDefined();
    if (lease) board.releaseLease(lease);
    expect(board.get('ses_1')).toMatchObject({
      generation: 1,
      state: 'reconciled',
      statusUncertain: false,
    });
  });

  test('v1 SDK serializes only the body: the delivery hint never reaches the wire', async () => {
    // v1 compatibility evidence for the queue-delivery fence: the hint
    // travels as a client-side argument, and the real @opencode-ai/sdk
    // request pipeline must serialize ONLY `body` into the HTTP request.
    // A captured fetch observes the wire shape directly.
    const captured = new Map<string, unknown>();
    const client = createOpencodeClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: async (request: Request) => {
        captured.set('url', request.url);
        captured.set('body', await request.text());
        return new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    await client.session.promptAsync({
      path: { id: 'ses_1' },
      query: { directory: '/test/project' },
      body: { agent: 'explorer', parts: [{ type: 'text', text: 'go' }] },
      // Extra top-level argument, exactly as task-revive sends it.
      delivery: 'queue',
    } as Parameters<typeof client.session.promptAsync>[0] &
      Record<string, unknown>);

    expect(captured.get('url')).toContain('/session/ses_1/prompt_async');
    const wireBody = JSON.parse(String(captured.get('body')));
    expect(wireBody).toEqual({
      agent: 'explorer',
      parts: [{ type: 'text', text: 'go' }],
    });
  });
});
