import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils';
import { COMPLETED_WITHOUT_TEXT_DIAGNOSTIC } from '../../utils/task';
import { createIdleReconciler } from './idle-reconciliation';

async function flushChildIdleReconcile(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Poll the board until the predicate holds (bounded) — CI runners can be
 * slower than the fixed 5ms flush, and the stabilization loop needs extra
 * macrotask hops (delay(0) per probe). */
async function waitForBoardRecord(
  board: BackgroundJobBoard,
  predicate: (record: { state: string } | undefined) => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(board.get('child-1'))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createHarness(options?: {
  stopConfirmationGraceMs?: number;
  readSessionOutcome?: (
    sessionID: string,
  ) => Promise<{ outcome?: string; resultText?: string } | undefined>;
  outcomeStabilization?: { probes: number; intervalMs: number };
}) {
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
    readSessionOutcome: options?.readSessionOutcome,
    outcomeStabilization: options?.outcomeStabilization,
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

describe('host outcome confirmation (v2: no session.status map)', () => {
  test('quiescent job with host outcome succeeded and result text settles completed with the real text', async () => {
    const readSessionOutcome = mock(
      async () =>
        ({ outcome: 'succeeded', resultText: 'Real result summary.' }) as const,
    );
    const { board, reconciler, terminalListener } = createHarness({
      stopConfirmationGraceMs: 60_000,
      readSessionOutcome,
    });
    const generation = board.get('child-1')?.generation ?? 1;

    await observeIdle(reconciler, 10, generation);
    await waitForBoardRecord(board, (r) => r?.state === 'reconciled');

    expect(readSessionOutcome).toHaveBeenCalledWith('child-1');
    const record = board.get('child-1');
    expect(record).toMatchObject({
      state: 'reconciled',
      terminalState: 'completed',
      terminalUnreconciled: false,
      statusUncertain: false,
    });
    expect(record?.resultSummary).toBe('Real result summary.');
    expect(terminalListener).toHaveBeenCalledTimes(1);
  });

  test('succeeded but textless settles error with the diagnostic after stabilization probes (incident #1115 precedent)', async () => {
    const readSessionOutcome = mock(
      async () => ({ outcome: 'succeeded' }) as const,
    );
    const { board, reconciler } = createHarness({
      stopConfirmationGraceMs: 60_000,
      outcomeStabilization: { probes: 2, intervalMs: 0 },
      readSessionOutcome,
    });
    const generation = board.get('child-1')?.generation ?? 1;

    await observeIdle(reconciler, 10, generation);
    await waitForBoardRecord(board, (r) => r?.state === 'reconciled');

    expect(readSessionOutcome).toHaveBeenCalledTimes(3); // initial + 2 probes
    const record = board.get('child-1');
    expect(record).toMatchObject({
      state: 'reconciled',
      terminalState: 'error',
      terminalUnreconciled: false,
    });
    expect(record?.resultSummary).toBe(COMPLETED_WITHOUT_TEXT_DIAGNOSTIC);
  });

  test('succeeded with text arriving on a later stabilization probe settles completed', async () => {
    let calls = 0;
    const readSessionOutcome = mock(async () => {
      calls += 1;
      return calls >= 2
        ? { outcome: 'succeeded', resultText: 'Late but real text.' }
        : { outcome: 'succeeded' };
    });
    const { board, reconciler } = createHarness({
      stopConfirmationGraceMs: 60_000,
      outcomeStabilization: { probes: 3, intervalMs: 0 },
      readSessionOutcome,
    });
    const generation = board.get('child-1')?.generation ?? 1;

    await observeIdle(reconciler, 10, generation);
    await waitForBoardRecord(board, (r) => r?.state === 'reconciled');

    const record = board.get('child-1');
    expect(record).toMatchObject({
      state: 'reconciled',
      terminalState: 'completed',
    });
    expect(record?.resultSummary).toBe('Late but real text.');
  });

  test('quiescent job with host outcome failed settles error', async () => {
    const { board, reconciler } = createHarness({
      stopConfirmationGraceMs: 60_000,
      readSessionOutcome: async () => ({ outcome: 'failed' }),
    });
    const generation = board.get('child-1')?.generation ?? 1;

    await observeIdle(reconciler, 10, generation);
    await waitForBoardRecord(board, (r) => r?.state === 'reconciled');

    const record = board.get('child-1');
    expect(record).toMatchObject({
      state: 'reconciled',
      terminalState: 'error',
      terminalUnreconciled: false,
    });
    expect((record?.resultSummary ?? '').toLowerCase()).not.toContain(
      'undefined',
    );
    expect(record?.resultSummary).toBe('Host reported outcome: failed.');
  });

  test('late busy after idle wins over a stale host outcome probe', async () => {
    const { board, reconciler } = createHarness({
      stopConfirmationGraceMs: 60_000,
      readSessionOutcome: async () => ({
        outcome: 'succeeded',
        resultText: 'x',
      }),
    });
    const generation = board.get('child-1')?.generation ?? 1;

    board.markRunningFromLiveSession('child-1', 20); // busy AFTER idleObservedAt 10
    await observeIdle(reconciler, 10, generation);

    expect(board.get('child-1')).toMatchObject({ state: 'running' });
  });

  test('quiescent job without a host outcome self-confirms stopped after grace', async () => {
    const { board, reconciler, terminalListener } = createHarness({
      stopConfirmationGraceMs: 5,
      readSessionOutcome: async () => undefined,
    });
    const generation = board.get('child-1')?.generation ?? 1;

    await observeIdle(reconciler, 10, generation);
    expect(board.get('child-1')).toMatchObject({ state: 'running' });

    // No external re-observation: the reconciler must complete the stop
    // confirmation itself after the grace elapses (the v1 design relied on
    // the periodic runtime-status reconciler, which is unavailable on v2).
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(board.get('child-1')).toMatchObject({ state: 'stopped' });
    expect(terminalListener).toHaveBeenCalledTimes(1);
  });
});
