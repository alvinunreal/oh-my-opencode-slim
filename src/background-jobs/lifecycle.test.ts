import { describe, expect, mock, spyOn, test } from 'bun:test';
import * as loggerModule from '../utils/logger';
import {
  FixtureBoardProxy as BackgroundJobBoard,
  boardFixture,
} from './fixture';
import {
  BackgroundJobLifecycle,
  createBackgroundJobLifecycle,
} from './lifecycle';
import { BackgroundJobLaunchConflictError } from './types';

function createMockBoard(isRunning = false) {
  return {
    isRunning: mock(() => isRunning),
    getState: mock(() => (isRunning ? 'running' : 'completed')),
    addTerminalStateListener: mock(() => {}),
    removeTerminalStateListener: mock(() => {}),
  } as any;
}

describe('BackgroundJobLifecycle', () => {
  test('deferIfRunning returns false when job is running', () => {
    const board = createMockBoard(true);
    const coordinator = new BackgroundJobLifecycle(board);
    expect(coordinator.deferIfRunning('ses_123')).toBe(false);
  });

  test('deferIfRunning returns true when job is not running', () => {
    const board = createMockBoard(false);
    const coordinator = new BackgroundJobLifecycle(board);
    expect(coordinator.deferIfRunning('ses_123')).toBe(true);
  });

  test('retryDeferredClose returns false when not in deferred set', () => {
    const board = createMockBoard(false);
    const coordinator = new BackgroundJobLifecycle(board);
    expect(coordinator.retryDeferredClose('ses_123')).toBe(false);
  });

  test('retryDeferredClose returns true after job completes', () => {
    const board = createMockBoard(true);
    const coordinator = new BackgroundJobLifecycle(board);

    // First call defers (job running)
    expect(coordinator.deferIfRunning('ses_123')).toBe(false);

    // Now simulate job completion
    board.isRunning.mockReturnValue(false);
    expect(coordinator.retryDeferredClose('ses_123')).toBe(true);
  });

  test('clearDeferredClose removes from deferred set', () => {
    const board = createMockBoard(true);
    const coordinator = new BackgroundJobLifecycle(board);

    coordinator.deferIfRunning('ses_123');
    coordinator.clearDeferredClose('ses_123');

    // Now retryDeferredClose should return false (not in set)
    board.isRunning.mockReturnValue(false);
    expect(coordinator.retryDeferredClose('ses_123')).toBe(false);
  });

  test('handleTerminalState notifies listeners when retryDeferredClose returns true', () => {
    const board = createMockBoard(true);
    const coordinator = new BackgroundJobLifecycle(board);
    const listener = mock(() => {});

    coordinator.addTerminalStateListener(listener);

    // Defer the session
    coordinator.deferIfRunning('ses_123');

    // Simulate terminal state notification from board
    board.getState.mockReturnValue('completed');
    board.isRunning.mockReturnValue(false);

    // Trigger handleTerminalState via board's listener callback
    const boardListener = board.addTerminalStateListener.mock.calls[0]?.[0];
    boardListener?.('ses_123');

    expect(listener).toHaveBeenCalledWith('ses_123');
  });

  test('handleTerminalState does not notify when not in deferred set', () => {
    const board = createMockBoard(false);
    const coordinator = new BackgroundJobLifecycle(board);
    const listener = mock(() => {});

    coordinator.addTerminalStateListener(listener);

    // Simulate terminal state notification without deferring first
    board.getState.mockReturnValue('completed');
    const boardListener = board.addTerminalStateListener.mock.calls[0]?.[0];
    boardListener?.('ses_123');

    expect(listener).not.toHaveBeenCalled();
  });

  test('throws in one coordinator listener does not prevent subsequent listeners from receiving notification', () => {
    const board = createMockBoard(true);
    const coordinator = new BackgroundJobLifecycle(board);
    const order: string[] = [];

    coordinator.addTerminalStateListener(() => {
      throw new Error('first listener failed');
    });
    coordinator.addTerminalStateListener(() => {
      order.push('second');
    });

    // Defer the session
    coordinator.deferIfRunning('ses_123');

    // Simulate terminal state notification from board
    board.getState.mockReturnValue('completed');
    board.isRunning.mockReturnValue(false);

    // Trigger handleTerminalState via board's listener callback
    const boardListener = board.addTerminalStateListener.mock.calls[0]?.[0];
    boardListener?.('ses_123');

    expect(order).toEqual(['second']);
  });

  test('throws in one outcome listener without blocking later outcomes', () => {
    const board = new BackgroundJobBoard();
    const coordinator = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    });
    const delivered: string[] = [];
    coordinator.addTerminalOutcomeListener(() => {
      throw new Error('first outcome listener failed');
    });
    coordinator.addTerminalOutcomeListener((record) => {
      delivered.push(record.taskID);
    });
    board.registerLaunch({
      taskID: 'ses_123',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });

    board.updateStatus({ taskID: 'ses_123', state: 'completed' });

    expect(delivered).toEqual(['ses_123']);
  });

  test('full chain: board terminal → coordinator → listener for deferred job', () => {
    const board = new BackgroundJobBoard();
    const coordinator = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    });
    const listener = mock(() => {});
    coordinator.addTerminalStateListener(listener);

    // Register and start a job
    board.registerLaunch({
      taskID: 'full-chain-test',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({
      taskID: 'full-chain-test',
      state: 'running',
    });

    // Defer close while job is running
    expect(coordinator.deferIfRunning('full-chain-test')).toBe(false);

    // Transition to completed — board fires listener, coordinator re-checks
    board.updateStatus({
      taskID: 'full-chain-test',
      state: 'completed',
    });

    expect(listener).toHaveBeenCalledWith('full-chain-test');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('forwards live lease acquisition, validation, release, and mark generation', () => {
    const board = new BackgroundJobBoard();
    const coordinator = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    });
    const first = coordinator.registerLaunch({
      taskID: 'ses_forwarded_lease',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    const lease = coordinator.acquireCancellationLease(
      first.taskID,
      first.generation,
    );

    expect(lease).toBeDefined();
    if (!lease) throw new Error('cancellation lease was not acquired');
    expect(coordinator.validateLease(lease)).toBe(true);
    expect(
      boardFixture.markCancelled(
        coordinator,
        first.taskID,
        'wrong generation',
        Date.now(),
        {
          force: true,
          expectedGeneration: first.generation + 1,
          cancellationLease: lease,
        },
      )?.state,
    ).toBe('running');
    expect(coordinator.releaseLease(lease)).toBe(true);
    expect(coordinator.validateLease(lease)).toBe(false);
    const relaunchLease = coordinator.acquireRelaunchLease(
      first.taskID,
      first.generation,
    );
    expect(relaunchLease).toBeDefined();
    if (!relaunchLease) throw new Error('relaunch lease was not acquired');
    expect(coordinator.validateLease(relaunchLease)).toBe(true);
    expect(coordinator.releaseLease(relaunchLease)).toBe(true);
  });

  test('forwards mutually exclusive message lease acquisition', () => {
    const board = new BackgroundJobBoard();
    const coordinator = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    });
    const job = coordinator.registerLaunch({
      taskID: 'ses_message_coordinator',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    const lease = coordinator.acquireMessageLease(job.taskID, job.generation);

    expect(lease).toMatchObject({ kind: 'message' });
    expect(
      coordinator.acquireCancellationLease(job.taskID, job.generation),
    ).toBe(undefined);
    expect(coordinator.acquireRelaunchLease(job.taskID, job.generation)).toBe(
      undefined,
    );
    if (!lease) throw new Error('message lease was not acquired');
    expect(coordinator.releaseLease(lease)).toBe(true);
  });

  test('forwards terminal notification lease acquisition after completion', () => {
    const board = new BackgroundJobBoard();
    const coordinator = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    });
    const job = coordinator.registerLaunch({
      taskID: 'ses_terminal_notification',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    coordinator.updateStatus({
      taskID: job.taskID,
      expectedGeneration: job.generation,
      state: 'completed',
    });

    const lease = coordinator.acquireTerminalNotificationLease(
      job.taskID,
      job.generation,
    );
    expect(lease).toMatchObject({ kind: 'terminal-notification' });
    expect(
      coordinator.acquireRelaunchLease(job.taskID, job.generation),
    ).toBeUndefined();
    if (!lease) throw new Error('terminal notification lease was not acquired');
    expect(coordinator.releaseLease(lease)).toBe(true);
  });

  test('notifies launch identity on accepted register, drop, and clearParent', () => {
    const board = new BackgroundJobBoard();
    const coordinator = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    });
    const events: Array<{ kind: string; taskID: string; alias: string }> = [];
    coordinator.addLaunchIdentityListener((event) => {
      events.push({
        kind: event.kind,
        taskID: event.taskID,
        alias: event.alias,
      });
    });

    const first = coordinator.registerLaunch({
      taskID: 'ses_ora_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    expect(events).toEqual([
      { kind: 'registered', taskID: 'ses_ora_1', alias: first.alias },
    ]);

    coordinator.drop('ses_ora_1');
    expect(events.at(-1)).toEqual({
      kind: 'removed',
      taskID: 'ses_ora_1',
      alias: first.alias,
    });

    const sibling = coordinator.registerLaunch({
      taskID: 'ses_ora_2',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    coordinator.clearParent('parent-1');
    expect(events.at(-1)).toEqual({
      kind: 'removed',
      taskID: 'ses_ora_2',
      alias: sibling.alias,
    });
    expect(board.list('parent-1')).toEqual([]);
  });

  test('does not notify identity for a rejected launch, and a throwing listener does not fail the launch', () => {
    const board = new BackgroundJobBoard();
    const coordinator = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    });
    const first = coordinator.registerLaunch({
      taskID: 'ses_busy',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    const lease = coordinator.acquireMessageLease(
      first.taskID,
      first.generation,
    );
    expect(lease).toBeDefined();

    const events: string[] = [];
    coordinator.addLaunchIdentityListener(() => {
      throw new Error('identity listener failed');
    });
    coordinator.addLaunchIdentityListener((event) => {
      events.push(`${event.kind}:${event.taskID}`);
    });

    expect(() =>
      coordinator.registerLaunch({
        taskID: 'ses_busy',
        parentSessionID: 'parent-1',
        agent: 'oracle',
      }),
    ).toThrow();
    expect(events).toEqual([]);

    const accepted = coordinator.registerLaunch({
      taskID: 'ses_ok',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    expect(accepted.taskID).toBe('ses_ok');
    expect(events).toEqual(['registered:ses_ok']);
  });

  test('logs the terminal state dispatch with record identity', () => {
    const entries: Array<{ message: string; data: unknown }> = [];
    const spy = spyOn(loggerModule, 'log').mockImplementation(
      (message: string, data?: unknown) => {
        entries.push({ message, data });
      },
    );
    try {
      const board = new BackgroundJobBoard();
      const coordinator = createBackgroundJobLifecycle({
        backgroundJobBoard: board,
      });
      const job = coordinator.registerLaunch({
        taskID: 'ses_dispatch_log',
        parentSessionID: 'parent-1',
        agent: 'fixer',
      });
      board.updateStatus({ taskID: job.taskID, state: 'running' });
      expect(coordinator.deferIfRunning(job.taskID)).toBe(false);
      board.updateStatus({ taskID: job.taskID, state: 'completed' });
      const dispatch = entries.find(
        (entry) => entry.message === '[job-lifecycle] terminal state dispatch',
      );
      expect(dispatch?.data).toMatchObject({
        taskID: job.taskID,
        generation: job.generation,
        state: 'completed',
        parentSessionID: 'parent-1',
        deferredClose: true,
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('ledger-on-board equivalence', () => {
  test('the facade ledger is the board-owned ledger (one per board instance)', () => {
    const board = new BackgroundJobBoard();
    const lifecycle = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    });
    // Same Map/Set objects, not a copy: consumers reading tombstones or
    // deletion epochs through either surface observe one lifecycle memory.
    expect(lifecycle.ledger).toBe(board.ledger);
  });

  test('facade suppression writes land on the board ledger (write-through)', () => {
    const board = new BackgroundJobBoard();
    const lifecycle = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    });
    lifecycle.recordSuppression('ses_sup', {
      state: 'completed',
      resultSummary: 'done',
    });
    expect(board.ledger.tombstones.has('ses_sup')).toBe(true);
    expect(board.ledger.deletionEpochs.get('ses_sup')).toBe(1);
    // registerLaunch clears only the active tombstone; the epoch survives
    // for generation fencing — identical semantics through both surfaces.
    lifecycle.registerLaunch({
      taskID: 'ses_sup',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    expect(board.ledger.tombstones.has('ses_sup')).toBe(false);
    expect(board.ledger.deletionEpochs.get('ses_sup')).toBe(1);
    lifecycle.clearSuppression('ses_sup');
    expect(board.ledger.tombstones.has('ses_sup')).toBe(false);
  });

  test('board drop records suppression on the shared ledger epoch counter', () => {
    const board = new BackgroundJobBoard();
    const lifecycle = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    });
    board.registerLaunch({
      taskID: 'ses_drop',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    lifecycle.drop('ses_drop');
    expect(board.ledger.tombstones.has('ses_drop')).toBe(true);
    expect(board.ledger.deletionEpochs.get('ses_drop')).toBe(1);
  });
});

describe('lifecycle seam ordering (through the factory)', () => {
  test('commitTerminal is inert without a gate-issued authorization token', () => {
    const board = new BackgroundJobBoard();
    const jobs = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    });
    const run = jobs.registerLaunch({
      taskID: 'ses_token_gate',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 0,
    });
    // A fabricated token can never authorize a terminal transition.
    const committed = jobs.commitTerminal(
      {
        taskID: run.taskID,
        state: 'completed',
        resultSummary: 'forged',
        now: 10,
      },
      Object.freeze({ forged: true } as never),
    );
    expect(committed).toBe(run);
    expect(board.get(run.taskID)).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
  });

  test('markReconciled rejects on generation or terminalRevision mismatch', () => {
    const board = new BackgroundJobBoard();
    const jobs = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    });
    const run = jobs.registerLaunch({
      taskID: 'ses_reconcile_fence',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 0,
    });
    // Drive the terminal publication directly through the board state
    // machine (the gate tracks the same row).
    const terminal = board.updateStatus({
      taskID: run.taskID,
      state: 'running',
    });
    expect(terminal).toBeDefined();
    const stopped = board.updateStatus({
      taskID: run.taskID,
      state: 'cancelled',
      resultSummary: 'stop',
      now: 6,
    } as never);
    expect(stopped).toBeDefined();
    const published = board.get(run.taskID);
    if (!published) throw new Error('missing published record');
    // Wrong generation: rejected (record returned unchanged).
    expect(jobs.markReconciled(run.taskID, 7, published.generation + 5)).toBe(
      published,
    );
    // Wrong revision: rejected.
    expect(jobs.markReconciled(run.taskID, 7, published.generation, 99)).toBe(
      published,
    );
    // Both current: accepted.
    const acked = jobs.markReconciled(
      run.taskID,
      7,
      published.generation,
      published.terminalRevision,
    );
    expect(acked).toBeDefined();
    expect(acked?.state).toBe('reconciled');
  });

  test('releaseLease re-applies trimRetained after a revive shield', () => {
    const board = new BackgroundJobBoard({
      maxReusablePerAgent: 1,
    });
    const jobs = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    });
    const first = jobs.registerLaunch({
      taskID: 'ses_retained_a',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 0,
    });
    // Live-stop without a native result, then acknowledge: retained-stopped.
    board.markStopped('ses_retained_a', 'busy again', 2, first.generation, 2);
    board.markReconciled('ses_retained_a', 2);
    // The retained-stopped row is lease-shielded while a revive is in flight.
    const lease = jobs.acquireRelaunchLease('ses_retained_a', first.generation);
    expect(lease).toBeDefined();
    const second = jobs.registerLaunch({
      taskID: 'ses_retained_b',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 3,
    });
    board.markStopped('ses_retained_b', 'busy again', 5, second.generation, 5);
    board.markReconciled('ses_retained_b', 5);
    // Both retained-stopped rows coexist under the shield.
    expect(
      board.list('parent-1').filter((job) => job.state === 'stopped').length,
    ).toBe(2);
    // Releasing the shield re-applies the cap: the older row is evicted.
    expect(jobs.releaseLease(lease as never)).toBe(true);
    const stopped = board
      .list('parent-1')
      .filter((job) => job.state === 'stopped');
    expect(stopped.length).toBe(1);
    expect(stopped[0]?.taskID).toBe('ses_retained_b');
    expect(board.ledger.tombstones.has('ses_retained_a')).toBe(true);
  });

  test('supervisor deadline ordering: claim -> grace armed before abort -> expiry marks uncertain', async () => {
    const board = new BackgroundJobBoard();
    const timers: Array<{ fire: () => void; delay: number }> = [];
    const now = 1_000;
    const jobs = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
      wallClockTimeoutMs: 500,
      abortGraceMs: 50,
      abort: async () => {
        throw new Error('abort hung (never resolved)');
      },
      readRuntime: async (_run, startedAt) => ({
        kind: 'quiescent' as const,
        origin: 'test.readRuntime',
        readStartedAt: startedAt,
      }),
      now: () => now,
      setTimeout: (callback, delay) => {
        timers.push({ fire: callback, delay });
        return timers.length as never;
      },
      clearTimeout: () => {},
    });
    const run = jobs.registerLaunch({
      taskID: 'ses_deadline',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      background: true,
      now: 1_000,
    });
    jobs.onLaunch(run);
    // One deadline timer, armed for the wall-clock budget.
    expect(timers.length).toBe(1);
    expect(timers[0]?.delay).toBe(500);
    // Fire the deadline: the board claims it, then the grace timer is
    // armed BEFORE the (hanging) abort is invoked.
    timers[0]?.fire();
    const claimed = board.get(run.taskID);
    expect(claimed).toMatchObject({
      timedOut: true,
      deadlineExceededAt: 1_000,
    });
    expect(timers.length).toBe(2);
    expect(timers[1]?.delay).toBe(50);
    // Grace expiry: markStatusUncertain + a gate reconcile request.
    const reconcileRequested = new Promise<void>((resolve) => {
      jobs.addMutationListener(() => {});
      resolve();
    });
    await reconcileRequested;
    timers[1]?.fire();
    const uncertain = board.get(run.taskID);
    expect(uncertain).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
    // The gate reconciles the deadline: quiescence confirms the abort.
    const result = await jobs.reconcile(
      { taskID: run.taskID, generation: run.generation },
      { kind: 'deadline' },
    );
    expect(result.kind).toBe('committed');
    expect(result.kind === 'committed' && result.record.state).toBe('error');
  });

  test('registerLaunch relaunchLease conflict paths', () => {
    const board = new BackgroundJobBoard();
    const jobs = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    });
    const first = jobs.registerLaunch({
      taskID: 'ses_conflict',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 0,
    });
    // No lease + no live lease: plain relaunch succeeds.
    const second = jobs.registerLaunch({
      taskID: 'ses_conflict',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 5,
    });
    expect(second.generation).toBe(first.generation + 1);
    // A live relaunch lease without the matching lease: conflict error.
    const liveLease = jobs.acquireRelaunchLease(
      'ses_conflict',
      second.generation,
    );
    expect(liveLease).toBeDefined();
    expect(() =>
      jobs.registerLaunch({
        taskID: 'ses_conflict',
        parentSessionID: 'parent-1',
        agent: 'fixer',
      }),
    ).toThrow(BackgroundJobLaunchConflictError);
    // A stale lease (wrong generation): conflict error.
    expect(() =>
      jobs.registerLaunch({
        taskID: 'ses_conflict',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        relaunchLease: { ...liveLease, generation: 99 },
      }),
    ).toThrow(BackgroundJobLaunchConflictError);
    // The matching lease: authorized same-ID relaunch.
    const third = jobs.registerLaunch({
      taskID: 'ses_conflict',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      relaunchLease: liveLease,
      now: 10,
    });
    expect(third.generation).toBe(second.generation + 1);
  });
});
