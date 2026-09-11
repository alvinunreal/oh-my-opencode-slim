import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
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
    // Capability gate: without client.session.status the reconciler skips
    // entirely (single disable notice) instead of marking every running
    // job uncertain every poll. Skipping is strictly safer than the old
    // snapshot.error path for stop-confirmation: no lookup ever runs, so
    // nothing can terminalize a still-running job.
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

    reconciler.schedule();
    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: false,
    });
    expect(board.get('child-1')?.lastStatusError).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    expect(contextFilesForPrompt).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
    reconciler.dispose();
  });

  test('v2 host: polling loop never arms, no uncertainty marks, and the disable notice logs exactly once', async () => {
    // Board behavior is asserted in-process (no logger involved): the
    // loop never arms and nothing is ever marked uncertain.
    const board = new BackgroundJobBoard();
    const reconciler = createRuntimeStatusReconciler({
      // v2 shape: the session domain exists but has NO status method.
      input: {
        directory: '/test/project',
        client: { session: {} },
      } as never,
      backgroundJobBoard: board,
      delayMs: 1,
      taskContextTracker: {
        pendingManagedTaskIds: new Set(),
        contextFilesForPrompt: () => [],
        prune: () => {},
      },
    });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'gate check',
      now: 0,
    });

    // Repeated scheduling attempts (the event hook fires schedule()
    // after every event) must arm nothing.
    for (let index = 0; index < 5; index += 1) {
      reconciler.schedule();
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: false,
    });
    reconciler.dispose();

    // Log-file assertions run in a subprocess: other test files
    // mock.module('../../utils/logger') globally in shared-process runs,
    // so the real logger (and its file sink) is only observable with a
    // pristine module registry.
    const logDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'omos-reconcile-log-'),
    );
    const workerSource = `
      const { createRuntimeStatusReconciler } = await import(
        process.env.RECONCILER_MODULE_URL
      );
      const { BackgroundJobBoard } = await import(
        process.env.BOARD_MODULE_URL
      );
      const { initLogger, flushLoggerForTesting } = await import(
        process.env.LOGGER_MODULE_URL
      );
      const { readFileSync } = await import('node:fs');
      initLogger('reconcile-v2-gate');
      const board = new BackgroundJobBoard();
      const reconciler = createRuntimeStatusReconciler({
        input: {
          directory: '/test/project',
          client: { session: {} },
        },
        backgroundJobBoard: board,
        delayMs: 1,
        taskContextTracker: {
          pendingManagedTaskIds: new Set(),
          contextFilesForPrompt: () => [],
          prune: () => {},
        },
      });
      board.registerLaunch({
        taskID: 'child-1',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        description: 'worker gate check',
        now: 0,
      });
      for (let index = 0; index < 5; index += 1) {
        reconciler.schedule();
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
      await reconciler.reconcile();
      reconciler.dispose();
      await flushLoggerForTesting();
      const contents = readFileSync(
        process.env.LOG_FILE_PATH,
        'utf8',
      );
      const lines = contents.split('\\n');
      console.log(
        JSON.stringify({
          disableNotices: lines.filter((line) =>
            line.includes('runtime status reconciliation disabled'),
          ).length,
          uncertainLines: lines.filter((line) =>
            line.includes('reconciliation uncertain'),
          ).length,
        }),
      );
    `;
    const proc = Bun.spawn([process.execPath, '-e', workerSource], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        OPENCODE_LOG_DIR: logDir,
        RECONCILER_MODULE_URL: pathToFileURL(
          path.join(import.meta.dir, 'runtime-status-reconciliation.ts'),
        ).href,
        BOARD_MODULE_URL: pathToFileURL(
          path.join(import.meta.dir, '../../utils/index.ts'),
        ).href,
        LOGGER_MODULE_URL: pathToFileURL(
          path.join(import.meta.dir, '../../utils/logger.ts'),
        ).href,
        LOG_FILE_PATH: path.join(
          logDir,
          'oh-my-opencode-slim.reconcile-v2-gate.log',
        ),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    await fs.rm(logDir, { recursive: true, force: true });
    if (exitCode !== 0) {
      console.error(stderr);
      expect(exitCode).toBe(0);
    }
    const counts = JSON.parse(stdout.trim()) as {
      disableNotices: number;
      uncertainLines: number;
    };
    expect(counts.disableNotices).toBe(1);
    expect(counts.uncertainLines).toBe(0);
  });

  test('v1 host (status fn present): schedule() arms the loop exactly as before', async () => {
    const board = new BackgroundJobBoard();
    const status = mock(async () => ({
      data: { 'child-1': { type: 'busy' } },
    }));
    const reconciler = createRuntimeStatusReconciler({
      input: {
        directory: '/test/project',
        client: { session: { status } },
      } as never,
      backgroundJobBoard: board,
      delayMs: 1,
      taskContextTracker: {
        pendingManagedTaskIds: new Set(['child-1']),
        contextFilesForPrompt: () => [],
        prune: () => {},
      },
    });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'v1 loop regression',
      now: 0,
    });

    reconciler.schedule();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(status).toHaveBeenCalled();
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: false,
    });
    reconciler.dispose();
  });
});
