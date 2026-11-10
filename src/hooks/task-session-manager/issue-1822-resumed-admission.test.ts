import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { createBackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import { createTimerHarness } from '../../utils/test-timers';
import { mapV2EventToV1 } from '../../v2/event-adapter';
import { handleEvent } from './event-router';

// Issue #1822: a resumed v2 background child registers a new generation (G2).
// Its native started event is stamped before G2's run boundary, and the
// terminal idle carries no generation. The fence must not strand G2 running.

function setup() {
  let clock = 0;
  const board = new BackgroundJobBoard();
  const timers = createTimerHarness();
  const deps = {
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
      now: () => clock,
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
      now: () => clock,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
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
    backgroundJobSupervisor: {
      onSessionDeleted: mock(() => {}),
    },
  };
  const route = async (
    id: string,
    type: string,
    data: object,
    created: number,
  ) => {
    clock = created;
    for (const mapped of mapV2EventToV1({ id, created, type, data } as never)) {
      await handleEvent({ event: mapped } as never, deps as never);
    }
  };
  return { board, route, deps, timers };
}

describe('issue-1822: resumed child admission release', () => {
  test.each([
    ['started before G2 registration', ['before', 'register']],
    ['G2 registered before stamped started delivered', ['register', 'before']],
  ] as const)(
    'terminal idle reconciles the resumed child (%s)',
    async (_label, order) => {
      const { board, route, deps } = setup();

      // G1 is observed busy, leaving a generation fence behind.
      board.registerLaunch({
        taskID: 'ses_child',
        parentSessionID: 'parent-1',
        agent: 'explorer',
        background: true,
        now: 0,
      });
      await route(
        'g1-busy',
        'session.execution.started',
        { sessionID: 'ses_child' },
        50,
      );

      // Parent resumes the child: G2 is registered at t=210 with the same
      // proof the real resume path supplies (pending.resumedTaskId).
      const register = () =>
        board.registerLaunch({
          taskID: 'ses_child',
          parentSessionID: 'parent-1',
          agent: 'explorer',
          background: true,
          resumedRunProven: true,
          now: 210,
        });
      const started = () =>
        route(
          'g2-busy',
          'session.execution.started',
          { sessionID: 'ses_child' },
          201,
        );
      if (order[0] === 'before') {
        await started();
        register();
      } else {
        register();
        await started();
      }
      expect(board.get('ses_child')).toMatchObject({
        generation: 2,
        state: 'running',
      });

      // Host reports the run finished at t=400 (succeeded + idle, no generation).
      await route(
        'g2-done',
        'session.execution.succeeded',
        { sessionID: 'ses_child' },
        400,
      );

      // Terminal reconciliation must be reached for G2 so the gate can commit
      // it and release the admission slot.
      expect(
        deps.idleReconciler.scheduleChildIdleReconciliation,
      ).toHaveBeenCalledWith('ses_child', 400, 2);
    },
  );
});
