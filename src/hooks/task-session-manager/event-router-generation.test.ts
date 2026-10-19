import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { boardFixture } from '../../utils/background-job-fixture';
import { createBackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import { handleEvent } from './event-router';

function createDeps(board: BackgroundJobBoard, now: () => number) {
  const backgroundJobSupervisor = {
    onSessionDeleted: mock((sessionID: string) => {
      board.drop(sessionID);
    }),
  };

  return {
    inputWaits: {
      trackInputWait: mock(() => {}),
      clearInputWaits: mock(() => {}),
      waitsByParent: new Map<string, Set<string | symbol>>(),
    },
    idleSessionTokens: {
      clearSession: mock(() => {}),
      invalidate: mock(() => {}),
      disposeLocalState: mock(() => {}),
      sessionTokens: new Map<string, symbol>(),
    },
    options: {
      shouldManageSession: () => true,
      now,
    },
    idleReconciler: {
      scheduleIdleReconciliation: mock(() => {}),
      scheduleChildIdleReconciliation: mock(() => {}),
      scheduleDeferredErrorBackstop: mock(() => {}),
      scheduleErrorTerminalize: mock(() => {}),
      clearIdleTimers: mock(() => {}),
      clearAllTimers: mock(() => []),
    },
    deferredInlineErrors: new Map<string, string>(),
    backgroundJobBoard: board,
    terminalGate: createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      now,
    }),
    pendingCallTracker: {
      peekByParentAndAgent: mock(() => undefined),
      clearSession: mock(() => {}),
    },
    taskContextTracker: {
      pendingManagedTaskIds: new Set<string>(),
      clearSession: mock(() => {}),
      prune: mock(() => {}),
    },
    terminalJobsInjectedByParent: new Map(),
    pendingInjectedTerminalJobsByParent: new Map(),
    backgroundJobSupervisor,
  };
}

async function route(
  deps: ReturnType<typeof createDeps>,
  type: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await handleEvent(
    {
      event: { type, properties },
    } as never,
    deps as never,
  );
}

describe('task session event generation fences', () => {
  test('quarantines an interleaved old idle/error/busy sequence after same-ID relaunch', async () => {
    let clock = 100;
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'generation one',
      now: clock,
    });
    const deps = createDeps(board, () => clock);

    await route(deps, 'session.status', {
      sessionID: 'child-1',
      status: { type: 'busy' },
    });

    clock = 200;
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'generation two',
      now: clock,
    });
    const generationTwo = board.get('child-1');
    expect(generationTwo).toMatchObject({ generation: 2, state: 'running' });

    // OpenCode v1 does not attach a run generation to these events. Once the
    // router first observes the new board generation, it quarantines the
    // lifecycle sequence until a fresh busy activity fence is observed.
    await route(deps, 'session.idle', { sessionID: 'child-1' });
    await route(deps, 'session.error', {
      sessionID: 'child-1',
      error: { name: 'UnknownError', message: 'late generation one error' },
    });
    await route(deps, 'session.status', {
      sessionID: 'child-1',
      status: { type: 'busy' },
    });

    expect(
      deps.idleReconciler.scheduleChildIdleReconciliation,
    ).not.toHaveBeenCalled();
    expect(deps.idleReconciler.scheduleErrorTerminalize).not.toHaveBeenCalled();
    expect(board.get('child-1')).toMatchObject({
      generation: 2,
      state: 'running',
      description: 'generation two',
      lastLiveBusyAt: 200,
    });

    // A later busy observation belongs to the now-established generation and
    // can update its activity timestamp normally.
    clock = 201;
    await route(deps, 'session.status', {
      sessionID: 'child-1',
      status: { type: 'busy' },
      activityAt: clock,
    });
    expect(board.get('child-1')).toMatchObject({ lastLiveBusyAt: 201 });
  });

  test('rejects explicitly stale generation/activity metadata for all lifecycle signals', async () => {
    let clock = 100;
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'generation one',
      now: clock,
    });
    const deps = createDeps(board, () => clock);
    await route(deps, 'session.status', {
      sessionID: 'child-1',
      status: { type: 'busy' },
      generation: 1,
      activityAt: 100,
    });

    clock = 200;
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'generation two',
      now: clock,
    });
    const before = board.get('child-1');

    await route(deps, 'session.idle', {
      sessionID: 'child-1',
      generation: 1,
      activityAt: 150,
    });
    await route(deps, 'session.error', {
      sessionID: 'child-1',
      generation: 1,
      activityAt: 160,
      error: { name: 'UnknownError', message: 'stale error' },
    });
    await route(deps, 'session.status', {
      sessionID: 'child-1',
      generation: 1,
      activityAt: 170,
      status: { type: 'busy' },
    });

    expect(
      deps.idleReconciler.scheduleChildIdleReconciliation,
    ).not.toHaveBeenCalled();
    expect(deps.idleReconciler.scheduleErrorTerminalize).not.toHaveBeenCalled();
    expect(board.get('child-1')).toEqual(before);
  });

  test('keeps G2 when an unproven session.deleted arrives after same-ID relaunch', async () => {
    let clock = 100;
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'generation one',
      now: clock,
    });
    const deps = createDeps(board, () => clock);

    // Establish that the router has observed G1 before the native session ID
    // is reused. The deletion below intentionally has no host provenance.
    await route(deps, 'session.status', {
      sessionID: 'child-1',
      status: { type: 'busy' },
    });

    clock = 200;
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'generation two',
      now: clock,
    });

    await route(deps, 'session.deleted', { sessionID: 'child-1' });

    expect(
      deps.backgroundJobSupervisor.onSessionDeleted,
    ).not.toHaveBeenCalled();
    expect(board.get('child-1')).toMatchObject({
      generation: 2,
      state: 'running',
      description: 'generation two',
    });
    expect(deps.idleSessionTokens.clearSession).not.toHaveBeenCalled();
    expect(deps.pendingCallTracker.clearSession).not.toHaveBeenCalled();
  });
});

describe('task session event fence activity proofs (#1586)', () => {
  const SESSION = 'child-1';
  const PARENT = 'parent-1';

  function startRound(
    board: BackgroundJobBoard,
    description: string,
    now: number,
  ): void {
    board.registerLaunch({
      taskID: SESSION,
      parentSessionID: PARENT,
      agent: 'fixer',
      description,
      now,
    });
  }

  function completeRound(
    board: BackgroundJobBoard,
    description: string,
    now: number,
  ): void {
    boardFixture.updateStatus(board, {
      taskID: SESSION,
      state: 'completed',
      resultSummary: description,
      now,
    });
  }

  /** G1 observed by the router, completed; then a same-ID continuation round
   * registered and completed with no intervening child events. */
  async function seedFencedContinuation(
    board: BackgroundJobBoard,
    deps: ReturnType<typeof createDeps>,
    clock: { value: number },
  ) {
    startRound(board, 'generation one', clock.value);
    await route(deps, 'session.status', {
      sessionID: SESSION,
      status: { type: 'busy' },
    });
    clock.value = 150;
    completeRound(board, 'generation one', clock.value);
    clock.value = 200;
    startRound(board, 'generation two', clock.value);
    clock.value = 250;
    completeRound(board, 'generation two', clock.value);
    return board.get(SESSION);
  }

  test('reopens a terminal continued run when a host-stamped busy proves activity after the terminal transition', async () => {
    const clock = { value: 100 };
    const board = new BackgroundJobBoard();
    const deps = createDeps(board, () => clock.value);
    const terminal = await seedFencedContinuation(board, deps, clock);
    expect(terminal).toMatchObject({
      generation: 2,
      state: 'completed',
      completedAt: 250,
      terminalRevision: 1,
      runStartedAt: 200,
      lastLiveBusyAt: 200,
    });

    // The revival busy carries the host envelope timestamp, proving it
    // belongs to the current run: not fence-only, and the board reopens
    // (terminalRevision bump) so the following idle can publish rev>1.
    clock.value = 300;
    await route(deps, 'session.status', {
      sessionID: SESSION,
      status: { type: 'busy' },
      activityAt: clock.value,
    });
    expect(board.get(SESSION)).toMatchObject({
      state: 'running',
      terminalRevision: 2,
    });

    clock.value = 301;
    await route(deps, 'session.idle', { sessionID: SESSION });
    expect(
      deps.idleReconciler.scheduleChildIdleReconciliation,
    ).toHaveBeenCalledTimes(1);
  });

  test('an in-window stamped busy stays fence-only but clears the fence; a later revival still reopens', async () => {
    const clock = { value: 100 };
    const board = new BackgroundJobBoard();
    const deps = createDeps(board, () => clock.value);
    const terminal = await seedFencedContinuation(board, deps, clock);
    expect(terminal).toMatchObject({
      state: 'completed',
      completedAt: 250,
      terminalRevision: 1,
    });

    // A stamp between runStartedAt and completedAt does not prove activity
    // after the terminal transition. The busy is swallowed by the fence
    // (no reopen) but still clears awaitingActivity, so a later
    // timestampless idle is not dropped as stale. A naive lift-on-any-stamp
    // would instead run the swallowed-session side effects below; the reopen
    // itself would still be refused by the terminal gate's predatesPublication
    // backstop (observedAt <= completedAt).
    const invalidations = deps.idleSessionTokens.invalidate.mock.calls.length;
    clock.value = 249;
    await route(deps, 'session.status', {
      sessionID: SESSION,
      status: { type: 'busy' },
      activityAt: clock.value,
    });
    expect(deps.idleSessionTokens.invalidate).toHaveBeenCalledTimes(
      invalidations,
    );
    expect(board.get(SESSION)).toEqual(terminal);

    clock.value = 260;
    await route(deps, 'session.idle', { sessionID: SESSION });
    expect(
      deps.idleReconciler.scheduleIdleReconciliation,
    ).toHaveBeenCalledTimes(1);
    expect(
      deps.idleReconciler.scheduleChildIdleReconciliation,
    ).not.toHaveBeenCalled();

    // The cleared fence must not strand the genuine revival: a busy stamped
    // after completedAt reopens the run and the following idle reconciles it.
    clock.value = 400;
    await route(deps, 'session.status', {
      sessionID: SESSION,
      status: { type: 'busy' },
      activityAt: clock.value,
    });
    expect(board.get(SESSION)).toMatchObject({
      state: 'running',
      terminalRevision: 2,
    });
    clock.value = 401;
    await route(deps, 'session.idle', { sessionID: SESSION });
    expect(
      deps.idleReconciler.scheduleChildIdleReconciliation,
    ).toHaveBeenCalledTimes(1);
  });

  test('a timestampless busy stays fence-only: the Date.now() fallback is not proof', async () => {
    const clock = { value: 100 };
    const board = new BackgroundJobBoard();
    const deps = createDeps(board, () => clock.value);
    const terminal = await seedFencedContinuation(board, deps, clock);

    // The local clock is already past completedAt, but no host stamp was
    // supplied. The busy must stay fence-only: it never reaches the busy
    // handler body (no session-token invalidation) and the board is
    // untouched, so a local receipt time cannot stand in for host proof.
    const invalidations = deps.idleSessionTokens.invalidate.mock.calls.length;
    clock.value = 300;
    await route(deps, 'session.status', {
      sessionID: SESSION,
      status: { type: 'busy' },
    });
    expect(deps.idleSessionTokens.invalidate).toHaveBeenCalledTimes(
      invalidations,
    );
    expect(board.get(SESSION)).toEqual(terminal);
  });

  test('a fresh busy reopens a terminal run even with no prior fence entry', async () => {
    const clock = { value: 100 };
    const board = new BackgroundJobBoard();
    startRound(board, 'generation one', clock.value);
    const deps = createDeps(board, () => clock.value);
    clock.value = 150;
    completeRound(board, 'generation one', clock.value);
    expect(board.get(SESSION)).toMatchObject({
      state: 'completed',
      completedAt: 150,
      terminalRevision: 1,
    });

    // First round with no fence: the revival busy proceeds and reopens.
    clock.value = 300;
    await route(deps, 'session.status', {
      sessionID: SESSION,
      status: { type: 'busy' },
      activityAt: clock.value,
    });
    expect(board.get(SESSION)).toMatchObject({
      state: 'running',
      terminalRevision: 2,
    });
    clock.value = 301;
    await route(deps, 'session.idle', { sessionID: SESSION });
    expect(
      deps.idleReconciler.scheduleChildIdleReconciliation,
    ).toHaveBeenCalledTimes(1);
  });

  test('the native v1 info.time.updated spelling counts as a supplied stamp', async () => {
    const clock = { value: 100 };
    const board = new BackgroundJobBoard();
    const deps = createDeps(board, () => clock.value);
    await seedFencedContinuation(board, deps, clock);

    clock.value = 300;
    await route(deps, 'session.status', {
      info: { id: SESSION, time: { updated: clock.value } },
      status: { type: 'busy' },
    });
    expect(board.get(SESSION)).toMatchObject({
      state: 'running',
      terminalRevision: 2,
    });
  });

  test('a timestampless idle while the fence is armed is still dropped', async () => {
    const clock = { value: 100 };
    const board = new BackgroundJobBoard();
    const deps = createDeps(board, () => clock.value);
    startRound(board, 'generation one', clock.value);
    await route(deps, 'session.status', {
      sessionID: SESSION,
      status: { type: 'busy' },
    });
    clock.value = 150;
    completeRound(board, 'generation one', clock.value);
    clock.value = 200;
    startRound(board, 'generation two', clock.value);

    // The generation change arms the fence; the first idle has no stamp and
    // no generation, so it is dropped unchanged (stale).
    clock.value = 210;
    await route(deps, 'session.idle', { sessionID: SESSION });
    expect(
      deps.idleReconciler.scheduleIdleReconciliation,
    ).not.toHaveBeenCalled();
    expect(
      deps.idleReconciler.scheduleChildIdleReconciliation,
    ).not.toHaveBeenCalled();
    expect(board.get(SESSION)).toMatchObject({
      generation: 2,
      state: 'running',
    });
  });
});
