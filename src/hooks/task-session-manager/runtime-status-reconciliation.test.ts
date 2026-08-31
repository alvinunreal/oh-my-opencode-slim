import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils';
import { buildPluginInput } from '../../v2/client-shim';
import { createRuntimeStatusReconciler } from './runtime-status-reconciliation';

function createReconciler(
  status: () => Promise<unknown>,
  statusTimeoutMs?: number,
  stopConfirmationGraceMs?: number,
) {
  const board = new BackgroundJobBoard();
  const contextFilesForPrompt = mock(() => []);
  const prune = mock(() => {});
  const reconciler = createRuntimeStatusReconciler({
    input: {
      directory: '/test/project',
      client: { session: { status } },
    } as never,
    backgroundJobBoard: board,
    statusTimeoutMs,
    stopConfirmationGraceMs,
    taskContextTracker: {
      pendingManagedTaskIds: new Set(['child-1']),
      contextFilesForPrompt,
      prune,
    },
  });
  board.registerLaunch({
    taskID: 'child-1',
    parentSessionID: 'parent-1',
    agent: 'fixer',
    description: 'fix reconciliation',
    now: 0,
  });
  return { board, reconciler, contextFilesForPrompt, prune };
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolve) throw new Error('Deferred promise resolver is unavailable');
      resolve(value);
    },
  };
}

describe('runtime status reconciliation', () => {
  test('keeps a runtime-busy job running', async () => {
    const { board, reconciler } = createReconciler(async () => ({
      data: { 'child-1': { type: 'busy' } },
    }));

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: false,
    });
  });

  test('keeps an absent runtime session provisional instead of stopping it', async () => {
    const { board, reconciler, contextFilesForPrompt, prune } =
      createReconciler(async () => ({ data: {} }));

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError:
        'Runtime status response did not contain a live session state; task termination is unconfirmed.',
    });
    expect(board.resolveReusable('parent-1', 'fix-1', 'fixer')).toBeUndefined();
    expect(contextFilesForPrompt).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  test('does not let idle runtime observation win over a late completion', async () => {
    const { board, reconciler } = createReconciler(async () => ({
      data: { 'child-1': { type: 'idle' } },
    }));
    const listener = mock(() => {});
    board.addTerminalStateListener(listener);

    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });

    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'late result',
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      resultSummary: 'late result',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('clears provisional uncertainty when a missing session becomes busy', async () => {
    let liveStatus: unknown = { data: {} };
    const { board, reconciler } = createReconciler(async () => liveStatus);

    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });

    liveStatus = { data: { 'child-1': { type: 'busy' } } };
    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: false,
    });
  });

  test('repeated absence never starts the stop clock or stops the job', async () => {
    const { board, reconciler, contextFilesForPrompt, prune } =
      createReconciler(async () => ({ data: {} }));
    const listener = mock(() => {});
    board.addTerminalStateListener(listener);

    for (let i = 0; i < 5; i += 1) {
      await reconciler.reconcile();
    }

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError:
        'Runtime status response did not contain a live session state; task termination is unconfirmed.',
    });
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    expect(contextFilesForPrompt).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  test('keeps the board running but explicitly uncertain when lookup fails', async () => {
    const { board, reconciler } = createReconciler(async () => {
      throw new Error('server restarting');
    });

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError: 'Runtime status lookup failed: server restarting',
    });
  });

  test('marks malformed runtime status entries uncertain rather than stopped', async () => {
    const { board, reconciler } = createReconciler(async () => ({
      data: { 'child-1': { type: 'suspended' } },
    }));

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError:
        'Runtime status response did not contain a recognized session state.',
    });
  });

  test.each([
    { type: 'idle' },
    { type: 'suspended' },
    { status: { type: 'busy' } },
  ])('marks unsupported status wrapper %j uncertain', async (data) => {
    const { board, reconciler } = createReconciler(async () => ({ data }));

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
  });

  test('turns a hung status lookup into uncertainty instead of stalling', async () => {
    const { board, reconciler } = createReconciler(
      () => new Promise(() => {}),
      1,
    );

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError:
        'Runtime status lookup failed: Session status lookup timed out',
    });
  });

  test('does not stop a job that received busy while status lookup was in flight', async () => {
    const response = deferred<unknown>();
    const { board, reconciler } = createReconciler(() => response.promise);

    const reconciliation = reconciler.reconcile();
    await Promise.resolve();
    board.markRunningFromLiveSession('child-1');
    response.resolve({ data: {} });
    await reconciliation;

    expect(board.get('child-1')).toMatchObject({ state: 'running' });
  });

  test('serializes overlapping reconciliation and observes jobs added in-flight', async () => {
    const firstResponse = deferred<unknown>();
    let lookupCount = 0;
    const status = mock(() => {
      lookupCount += 1;
      if (lookupCount === 1) return firstResponse.promise;
      return Promise.resolve({
        data: {
          'child-1': { type: 'busy' },
          'child-2': { type: 'idle' },
        },
      });
    });
    const { board, reconciler } = createReconciler(status);

    const firstReconciliation = reconciler.reconcile();
    await Promise.resolve();
    board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'second reconciliation job',
      now: 0,
    });
    const secondReconciliation = reconciler.reconcile();

    expect(status).toHaveBeenCalledTimes(1);
    firstResponse.resolve({ data: { 'child-1': { type: 'busy' } } });
    await Promise.all([firstReconciliation, secondReconciliation]);

    expect(status).toHaveBeenCalledTimes(2);
    expect(board.get('child-2')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
    reconciler.dispose();
  });

  test('does not apply an old status response to a relaunched generation', async () => {
    const response = deferred<unknown>();
    const { board, reconciler } = createReconciler(() => response.promise);

    const reconciliation = reconciler.reconcile();
    await Promise.resolve();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'relaunched fix',
      now: 1,
    });
    response.resolve({ data: {} });
    await reconciliation;

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      description: 'relaunched fix',
      generation: 2,
    });
  });

  test('idle then busy inside grace remains running with no terminal listener', async () => {
    let liveStatus: unknown = { data: { 'child-1': { type: 'idle' } } };
    const { board, reconciler } = createReconciler(
      async () => liveStatus,
      undefined,
      60_000,
    );
    const listener = mock(() => {});
    board.addTerminalStateListener(listener);

    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
    expect(listener).not.toHaveBeenCalled();

    liveStatus = { data: { 'child-1': { type: 'busy' } } };
    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: false,
      stopConfirmationStartedAt: undefined,
    });
    expect(listener).not.toHaveBeenCalled();
  });

  test('repeated idle beyond confirmation grace becomes stopped exactly once', async () => {
    const { board, reconciler, contextFilesForPrompt, prune } =
      createReconciler(
        async () => ({ data: { 'child-1': { type: 'idle' } } }),
        undefined,
        0,
      );
    const listener = mock(() => {});
    board.addTerminalStateListener(listener);

    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({ state: 'running' });
    expect(listener).not.toHaveBeenCalled();

    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(contextFilesForPrompt).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledTimes(1);

    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({ state: 'stopped' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('a busy observation resets pending stop confirmation', async () => {
    let liveStatus: unknown = { data: { 'child-1': { type: 'idle' } } };
    const { board, reconciler } = createReconciler(
      async () => liveStatus,
      undefined,
      0,
    );
    const listener = mock(() => {});
    board.addTerminalStateListener(listener);

    await reconciler.reconcile();
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeDefined();

    liveStatus = { data: { 'child-1': { type: 'busy' } } };
    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      stopConfirmationStartedAt: undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 2));
    liveStatus = { data: { 'child-1': { type: 'idle' } } };
    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({ state: 'running' });
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeDefined();
    expect(listener).not.toHaveBeenCalled();
  });

  test('status lookup failure does not confirm a stop or wake the parent', async () => {
    let liveStatus: () => Promise<unknown> = async () => ({
      data: { 'child-1': { type: 'idle' } },
    });
    const { board, reconciler } = createReconciler(
      () => liveStatus(),
      undefined,
      0,
    );
    const listener = mock(() => {});
    board.addTerminalStateListener(listener);

    await reconciler.reconcile();
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeDefined();

    liveStatus = async () => {
      throw new Error('server restarting');
    };
    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError: 'Runtime status lookup failed: server restarting',
    });
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeDefined();
    expect(listener).not.toHaveBeenCalled();
  });

  test('does not let stale busy revive a confirmed stopped job after terminal wake', () => {
    const { board } = createReconciler(async () => ({ data: {} }));
    const generation = board.get('child-1')?.generation;
    board.markStopped('child-1', 'no result', 150, generation, 150);
    board.markReconciled('child-1', 160);

    board.markRunningFromLiveSession('child-1', 200, generation);

    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: false,
      lastLiveBusyAt: 200,
    });
  });

  test('later live busy can still revive an unreconciled stopped job', () => {
    const { board } = createReconciler(async () => ({ data: {} }));
    const generation = board.get('child-1')?.generation;
    board.markStopped('child-1', 'no result', 150, generation, 150);

    board.markRunningFromLiveSession('child-1', 200, generation);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
      resultSummary: undefined,
    });
  });

  test('keeps a timed-out job recoverable through repeated busy observations', () => {
    const { board } = createReconciler(async () => ({ data: {} }));
    board.updateStatus({
      taskID: 'child-1',
      state: 'running',
      timedOut: true,
    });

    board.markRunningFromLiveSession('child-1', 1);
    board.markRunningFromLiveSession('child-1', 2);

    expect(
      board.resolveRecoverable('parent-1', 'fix-1', 'fixer'),
    ).toBeDefined();
  });

  test('does not mutate after disposal while a lookup is in flight', async () => {
    const response = deferred<unknown>();
    const { board, reconciler } = createReconciler(() => response.promise);

    const reconciliation = reconciler.reconcile();
    await Promise.resolve();
    reconciler.dispose();
    response.resolve({ data: {} });
    await reconciliation;

    expect(board.get('child-1')).toMatchObject({ state: 'running' });
  });

  test('v2 shim client (no session.status) never confirms a stop', async () => {
    // The v2 client shim deliberately omits session.status: an empty-but-
    // valid status map from a fake stub would let stop-confirmation mark a
    // still-running job `stopped` after the grace. Omission must surface
    // as snapshot.error → markStatusUncertain, even far beyond the grace.
    const board = new BackgroundJobBoard();
    const contextFilesForPrompt = mock(() => []);
    const prune = mock(() => {});
    const reconciler = createRuntimeStatusReconciler({
      input: {
        directory: '/test/project',
        client: buildPluginInput({} as never).client,
      } as never,
      backgroundJobBoard: board,
      stopConfirmationGraceMs: 0,
      taskContextTracker: {
        pendingManagedTaskIds: new Set(['child-1']),
        contextFilesForPrompt,
        prune,
      },
    });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'shim status omission',
      now: 0,
    });
    const listener = mock(() => {});
    board.addTerminalStateListener(listener);

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
    expect(board.get('child-1')?.lastStatusError).toContain(
      'Runtime status lookup failed',
    );
    expect(listener).not.toHaveBeenCalled();
    expect(contextFilesForPrompt).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
    reconciler.dispose();
  });
});
