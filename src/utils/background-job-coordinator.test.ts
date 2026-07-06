import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobCoordinator } from './background-job-coordinator';

function createMockBoard(isRunning = false) {
  return {
    isRunning: mock(() => isRunning),
    getState: mock(() => (isRunning ? 'running' : 'completed')),
    addTerminalStateListener: mock(() => {}),
    removeTerminalStateListener: mock(() => {}),
    // ... other methods as needed
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
});
