import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils';
import { createIdleReconciler } from './idle-reconciliation';

async function flushChildIdleReconcile(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function createHarness(options?: { stopConfirmationGraceMs?: number }) {
  const board = new BackgroundJobBoard();
  const terminalListener = mock(() => {});
  board.addTerminalStateListener(terminalListener);
  const contextFilesForPrompt = mock(() => []);
  const prune = mock(() => {});
  const reconciler = createIdleReconciler({
    backgroundJobBoard: board,
    reconcileInjectedTerminalJobs: mock(() => {}),
    idleReconcileDelayMs: 0,
    stopConfirmationGraceMs: options?.stopConfirmationGraceMs ?? 0,
    hasInputWait: () => false,
    getIdleSessionToken: () => Symbol('idle'),
    isCurrentIdleSessionToken: () => true,
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
    description: 'fix idle race',
    now: 0,
  });
  return { board, reconciler, terminalListener, contextFilesForPrompt, prune };
}

async function observeIdle(
  reconciler: ReturnType<typeof createIdleReconciler>,
  idleObservedAt: number,
  generation: number,
): Promise<void> {
  reconciler.scheduleChildIdleReconciliation(
    'child-1',
    idleObservedAt,
    generation,
  );
  await flushChildIdleReconcile();
}

describe('idle reconciliation stop confirmation', () => {
  test('idle then busy inside grace remains running with no terminal listener', async () => {
    const { board, reconciler, terminalListener } = createHarness({
      stopConfirmationGraceMs: 60_000,
    });
    const generation = board.get('child-1')?.generation ?? 1;

    await observeIdle(reconciler, 10, generation);
    expect(board.get('child-1')).toMatchObject({ state: 'running' });
    expect(terminalListener).not.toHaveBeenCalled();

    board.markRunningFromLiveSession('child-1', 15);
    await observeIdle(reconciler, 16, generation);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      stopConfirmationStartedAt: 17,
    });
    expect(terminalListener).not.toHaveBeenCalled();
  });

  test('repeated idle beyond confirmation grace becomes stopped exactly once', async () => {
    const {
      board,
      reconciler,
      terminalListener,
      contextFilesForPrompt,
      prune,
    } = createHarness();
    const generation = board.get('child-1')?.generation ?? 1;

    await observeIdle(reconciler, 10, generation);
    expect(board.get('child-1')).toMatchObject({ state: 'running' });
    expect(terminalListener).not.toHaveBeenCalled();

    await observeIdle(reconciler, 20, generation);
    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
    });
    expect(terminalListener).toHaveBeenCalledTimes(1);
    expect(contextFilesForPrompt).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledTimes(1);

    await observeIdle(reconciler, 30, generation);
    expect(board.get('child-1')).toMatchObject({ state: 'stopped' });
    expect(terminalListener).toHaveBeenCalledTimes(1);
  });

  test('a busy observation resets pending stop confirmation', async () => {
    const { board, reconciler, terminalListener } = createHarness();
    const generation = board.get('child-1')?.generation ?? 1;

    await observeIdle(reconciler, 10, generation);
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBe(11);

    board.markRunningFromLiveSession('child-1', 15);
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      stopConfirmationStartedAt: undefined,
    });

    await observeIdle(reconciler, 20, generation);
    expect(board.get('child-1')).toMatchObject({ state: 'running' });
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBe(21);
    expect(terminalListener).not.toHaveBeenCalled();
  });
});
