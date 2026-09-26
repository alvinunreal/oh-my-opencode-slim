import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
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
    retainedBoardSnapshots: new Map(),
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
