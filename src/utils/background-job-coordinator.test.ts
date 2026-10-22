import { describe, expect, mock, spyOn, test } from 'bun:test';
import { BackgroundJobCoordinator } from './background-job-coordinator';
import { BackgroundJobBoard, boardFixture } from './background-job-fixture';
import * as loggerModule from './logger';

function createMockBoard(isRunning = false) {
  return {
    isRunning: mock(() => isRunning),
    getState: mock(() => (isRunning ? 'running' : 'completed')),
    setTerminalPublicationHandler: mock(() => {}),
  } as any;
}

describe('BackgroundJobCoordinator', () => {
  test('installs its terminal publication handler on the board', () => {
    const board = createMockBoard(false);
    new BackgroundJobCoordinator(board);
    expect(board.setTerminalPublicationHandler).toHaveBeenCalledTimes(1);
    expect(typeof board.setTerminalPublicationHandler.mock.calls[0]?.[0]).toBe(
      'function',
    );
  });

  test('handleTerminalState dispatches terminal outcomes with the record', () => {
    const board = createMockBoard(true);
    const coordinator = new BackgroundJobCoordinator(board);
    const listener = mock(() => {});

    coordinator.addTerminalOutcomeListener(listener);

    // Simulate terminal state notification from board
    board.getState.mockReturnValue('completed');
    board.isRunning.mockReturnValue(false);
    board.get = mock(() => ({
      taskID: 'ses_123',
      parentSessionID: 'parent-1',
      generation: 1,
    }));

    const publish = board.setTerminalPublicationHandler.mock.calls[0]?.[0];
    publish?.('ses_123');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ taskID: 'ses_123' }),
    );
  });

  test('handleTerminalState drops a cleaned-up task without dispatching', () => {
    const board = createMockBoard(true);
    const coordinator = new BackgroundJobCoordinator(board);
    const listener = mock(() => {});

    coordinator.addTerminalOutcomeListener(listener);

    board.getState.mockReturnValue(undefined);
    const publish = board.setTerminalPublicationHandler.mock.calls[0]?.[0];
    publish?.('ses_gone');

    expect(listener).not.toHaveBeenCalled();
  });

  test('throws in one outcome listener does not prevent subsequent outcomes', () => {
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

  test('full chain: board terminal → coordinator → outcome listener', () => {
    const board = new BackgroundJobBoard();
    const coordinator = new BackgroundJobCoordinator(board);
    const listener = mock(() => {});
    coordinator.addTerminalOutcomeListener(listener);

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

    // Transition to completed — board publishes, coordinator dispatches
    board.updateStatus({
      taskID: 'full-chain-test',
      state: 'completed',
    });

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

  test('logs the terminal state dispatch with record identity', () => {
    const entries: Array<{ message: string; data: unknown }> = [];
    const spy = spyOn(loggerModule, 'log').mockImplementation(
      (message: string, data?: unknown) => {
        entries.push({ message, data });
      },
    );
    try {
      const board = new BackgroundJobBoard();
      const coordinator = new BackgroundJobCoordinator(board);
      const job = coordinator.registerLaunch({
        taskID: 'ses_dispatch_log',
        parentSessionID: 'parent-1',
        agent: 'fixer',
      });
      board.updateStatus({ taskID: job.taskID, state: 'running' });
      board.updateStatus({ taskID: job.taskID, state: 'completed' });
      const dispatch = entries.find(
        (entry) =>
          entry.message === '[job-coordinator] terminal state dispatch',
      );
      expect(dispatch?.data).toMatchObject({
        taskID: job.taskID,
        generation: job.generation,
        state: 'completed',
        parentSessionID: 'parent-1',
      });
      expect(dispatch?.data).not.toHaveProperty('deferredClose');
    } finally {
      spy.mockRestore();
    }
  });
});
