import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from './background-job-board';
import { BackgroundJobCoordinator } from './background-job-coordinator';

function createMockBoard(isRunning = false) {
  return {
    isRunning: mock(() => isRunning),
    getState: mock(() => (isRunning ? 'running' : 'completed')),
    addTerminalStateListener: mock(() => {}),
    removeTerminalStateListener: mock(() => {}),
  } as any;
}

describe('BackgroundJobCoordinator', () => {
  test('deferIfRunning returns false when job is running', () => {
    const board = createMockBoard(true);
    const coordinator = new BackgroundJobCoordinator(board);
    expect(coordinator.deferIfRunning('ses_123')).toBe(false);
  });

  test('deferIfRunning returns true when job is not running', () => {
    const board = createMockBoard(false);
    const coordinator = new BackgroundJobCoordinator(board);
    expect(coordinator.deferIfRunning('ses_123')).toBe(true);
  });

  test('retryDeferredClose returns false when not in deferred set', () => {
    const board = createMockBoard(false);
    const coordinator = new BackgroundJobCoordinator(board);
    expect(coordinator.retryDeferredClose('ses_123')).toBe(false);
  });

  test('retryDeferredClose returns true after job completes', () => {
    const board = createMockBoard(true);
    const coordinator = new BackgroundJobCoordinator(board);

    // First call defers (job running)
    expect(coordinator.deferIfRunning('ses_123')).toBe(false);

    // Now simulate job completion
    board.isRunning.mockReturnValue(false);
    expect(coordinator.retryDeferredClose('ses_123')).toBe(true);
  });

  test('clearDeferredClose removes from deferred set', () => {
    const board = createMockBoard(true);
    const coordinator = new BackgroundJobCoordinator(board);

    coordinator.deferIfRunning('ses_123');
    coordinator.clearDeferredClose('ses_123');

    // Now retryDeferredClose should return false (not in set)
    board.isRunning.mockReturnValue(false);
    expect(coordinator.retryDeferredClose('ses_123')).toBe(false);
  });

  test('handleTerminalState notifies listeners when retryDeferredClose returns true', () => {
    const board = createMockBoard(true);
    const coordinator = new BackgroundJobCoordinator(board);
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
    const coordinator = new BackgroundJobCoordinator(board);
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
    const coordinator = new BackgroundJobCoordinator(board);
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
    const coordinator = new BackgroundJobCoordinator(board);
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
    const coordinator = new BackgroundJobCoordinator(board);
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
    const coordinator = new BackgroundJobCoordinator(board);
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
      coordinator.markCancelled(first.taskID, 'wrong generation', Date.now(), {
        force: true,
        expectedGeneration: first.generation + 1,
        cancellationLease: lease,
      })?.state,
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
    const coordinator = new BackgroundJobCoordinator(board);
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
    const coordinator = new BackgroundJobCoordinator(board);
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
    const coordinator = new BackgroundJobCoordinator(board);
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
    const coordinator = new BackgroundJobCoordinator(board);
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
});
