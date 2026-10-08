import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from './board';
import { createBackgroundJobLifecycle } from './lifecycle';

const retained = {
  taskID: 'ses_child',
  parentSessionID: 'ses_parent',
  agent: 'fixer',
  description: 'Run one foreground fixer',
  state: 'completed' as const,
  background: false,
  resultSummary: 'LAB-MARKER',
  launchedAt: 1790753027502,
  completedAt: 1790753027711,
};

describe('restoreRetainedSession', () => {
  test('imports a terminal row without launching, notifying, or allocating an alias', () => {
    const board = new BackgroundJobBoard();
    const terminal: string[] = [];
    board.addTerminalStateListener((taskID) => terminal.push(taskID));

    const restored = board.restoreRetainedSession(retained);

    expect(restored).toMatchObject({
      taskID: 'ses_child',
      alias: 'ses_child',
      state: 'completed',
      generation: 1,
      background: false,
      terminalUnreconciled: true,
      resultSummary: 'LAB-MARKER',
      launchedAt: 1790753027502,
      completedAt: 1790753027711,
    });
    expect(restored?.lastLiveBusyAt).toBeUndefined();
    expect(board.isRunning('ses_parent')).toBe(false);
    expect(terminal).toEqual([]);

    const next = board.registerLaunch({
      taskID: 'ses_other',
      parentSessionID: 'ses_parent',
      agent: 'fixer',
      now: 50,
    });
    expect(next.alias).toBe('fix-1');
  });

  test('a trusted alias advances the counter once and does not burn extra counters', () => {
    const board = new BackgroundJobBoard();
    const restored = board.restoreRetainedSession({
      ...retained,
      alias: 'fix-3',
    });
    expect(restored?.alias).toBe('fix-3');
    const next = board.registerLaunch({
      taskID: 'ses_other',
      parentSessionID: 'ses_parent',
      agent: 'fixer',
      now: 50,
    });
    expect(next.alias).toBe('fix-4');
  });

  test('a reentrant, existing, or leased row is not overwritten and spends no generation', () => {
    const board = new BackgroundJobBoard();
    board.addMutationListener(() => {
      board.restoreRetainedSession({ ...retained, resultSummary: 'LATE' });
    });
    const running = board.registerLaunch({
      taskID: 'ses_child',
      parentSessionID: 'ses_parent',
      agent: 'fixer',
      now: 10,
    });
    expect(board.get('ses_child')).toMatchObject({
      state: 'running',
      generation: running.generation,
    });
    expect(board.get('ses_child')?.resultSummary).toBeUndefined();
    expect(board.restoreRetainedSession(retained)).toBeUndefined();

    const lease = board.acquireRelaunchLease('ses_child', running.generation);
    expect(lease).toBeDefined();
    board.drop('ses_child');
    expect(board.restoreRetainedSession(retained)).toBeUndefined();
    expect(board.get('ses_child')).toBeUndefined();
    expect(board.validateLease(lease as NonNullable<typeof lease>)).toBe(true);
    const next = board.registerLaunch({
      taskID: 'ses_other',
      parentSessionID: 'ses_parent',
      agent: 'fixer',
      now: 20,
    });
    expect(next.generation).toBe(running.generation + 1);
  });

  test('coordinator projects identity and still does not emit a terminal wake', () => {
    const board = new BackgroundJobBoard();
    const coordinator = createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    });
    const identity: string[] = [];
    const terminal: string[] = [];
    coordinator.addLaunchIdentityListener((event) => {
      identity.push(`${event.kind}:${event.alias}`);
    });
    coordinator.addTerminalStateListener((taskID) => terminal.push(taskID));

    const restored = coordinator.restoreRetainedSession({
      ...retained,
      alias: 'fix-2',
    });

    expect(restored?.state).toBe('completed');
    expect(identity).toEqual(['registered:fix-2']);
    expect(terminal).toEqual([]);
  });
});
