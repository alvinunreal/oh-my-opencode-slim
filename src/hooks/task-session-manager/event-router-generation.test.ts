import { describe, expect, mock, spyOn, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { createBackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import { mapV2EventToV1 } from '../../v2/event-adapter';
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
  test('proven resumes reject unattributed old errors but reconcile idle', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 100,
    });
    const deps = createDeps(board, () => 300);
    await route(deps, 'session.status', {
      sessionID: 'child-1',
      status: { type: 'busy' },
      activityAt: 100,
    });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 200,
      resumedRunProven: true,
    });
    const reconcile = spyOn(deps.terminalGate, 'reconcile').mockResolvedValue({
      kind: 'stale',
    });
    try {
      await route(deps, 'session.error', {
        sessionID: 'child-1',
        error: { message: 'late old error' },
      });
      expect(reconcile).not.toHaveBeenCalled();
      expect(board.get('child-1')?.state).toBe('running');
      await route(deps, 'session.idle', { sessionID: 'child-1' });
      expect(
        deps.idleReconciler.scheduleChildIdleReconciliation,
      ).toHaveBeenCalledTimes(1);
      await route(deps, 'session.error', {
        sessionID: 'child-1',
        activityAt: 300,
        error: { message: 'current failure' },
      });
      expect(reconcile).toHaveBeenCalledTimes(1);
    } finally {
      reconcile.mockRestore();
      deps.terminalGate.dispose();
    }
  });

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

  test.each([
    ['succeeded', ['session.status', 'session.idle']],
    ['failed', ['session.error', 'session.status', 'session.idle']],
    ['interrupted', ['session.status', 'session.idle']],
  ] as const)(
    'delayed terminal execution.%s from the previous run cannot terminalize or reconcile the current run',
    async (subtype, expectedTypes) => {
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
        activityAt: clock,
      });

      // Same-ID relaunch (G2). The first unproven busy only establishes
      // the activity fence; the second one records the current run's
      // activity boundary.
      clock = 200;
      board.registerLaunch({
        taskID: 'child-1',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        description: 'generation two',
        now: clock,
      });
      for (const activityAt of [300, 310]) {
        for (const mapped of mapV2EventToV1({
          id: `evt_busy_${activityAt}`,
          created: activityAt,
          type: 'session.execution.started',
          data: { sessionID: 'child-1' },
        })) {
          await handleEvent({ event: mapped } as never, deps as never);
        }
      }
      expect(board.get('child-1')).toMatchObject({
        generation: 2,
        state: 'running',
        lastLiveBusyAt: 310,
      });
      const before = board.get('child-1');

      // The previous run's terminal envelope arrives late. Its host
      // timestamp predates the current run's activity; a companion event
      // without `activityAt` would instead fall back to the local receipt
      // time and act on G2.
      clock = 999;
      const delayed = mapV2EventToV1({
        id: 'evt_delayed_terminal',
        created: 250,
        type: `session.execution.${subtype}`,
        data: { sessionID: 'child-1' },
      });
      expect(delayed.map((event) => event.type)).toEqual([
        `session.execution.${subtype}`,
        ...expectedTypes,
      ]);
      for (const mapped of delayed) {
        await handleEvent({ event: mapped } as never, deps as never);
      }

      expect(
        deps.idleReconciler.scheduleIdleReconciliation,
      ).not.toHaveBeenCalled();
      expect(
        deps.idleReconciler.scheduleChildIdleReconciliation,
      ).not.toHaveBeenCalled();
      expect(
        deps.idleReconciler.scheduleDeferredErrorBackstop,
      ).not.toHaveBeenCalled();
      expect(board.get('child-1')).toEqual(before);
      expect(board.get('child-1')).toMatchObject({
        generation: 2,
        state: 'running',
        lastLiveBusyAt: 310,
        terminalRevision: 0,
      });
    },
  );

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
