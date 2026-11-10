import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { createBackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import { createTimerHarness } from '../../utils/test-timers';
import { mapV2EventToV1 } from '../../v2/event-adapter';
import { handleEvent } from './event-router';
import { createPendingCallTracker } from './pending-call-tracker';
import { registerDelegatedLaunchFromStructured } from './tool-execute-hooks';

// Issue #1822: a resumed v2 background child registers a new generation (G2).
// Its native started event is stamped before G2's run boundary, and the
// terminal idle carries no generation. The fence must not strand G2 running.
//
// The resume drives the real structured-registration entry (the same one the
// v2 executor wrapper calls) so the proof is exercised as production produces
// it, not hand-seeded onto the board. Both clocks are logical: the event
// timestamps ride in the event properties so the router reads them directly,
// and the launch stamps come from the injected `now` seam. Without that, the
// board would stamp real wall time and the stale-busy ordering would silently
// stop being stale.

const TASK = 'ses_child';
const PARENT = 'parent-1';

function setup() {
  let clock = 0;
  const board = new BackgroundJobBoard();
  const timers = createTimerHarness();
  const tracker = createPendingCallTracker({
    releaseLease: (lease) => board.releaseLease(lease),
  });

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
    pendingCallTracker: tracker,
    taskContextTracker: {
      pendingManagedTaskIds: new Set<string>(),
      clearSession: mock(() => {}),
      prune: mock(() => {}),
      addContext: () => {},
      contextFilesForPrompt: () => [],
    },
    backgroundJobSupervisor: {
      onSessionDeleted: mock(() => {}),
      onLaunch: mock(() => {}),
    },
  };

  const launchDeps = {
    directory: '/tmp',
    backgroundJobBoard: board,
    terminalGate: deps.terminalGate,
    taskContextTracker: deps.taskContextTracker,
    firstAdmission: (sessionID: string) => tracker.firstAdmission(sessionID),
    now: () => clock,
  };

  /**
   * Deliver one host event with an explicit host timestamp. The timestamp
   * rides in the properties so `eventActivityAt` reads it directly and the
   * router never falls back to the wall clock.
   */
  const route = async (id: string, type: string, at: number) => {
    clock = at;
    for (const mapped of mapV2EventToV1({
      id,
      created: at,
      type,
      data: { sessionID: TASK },
    } as never)) {
      const event = mapped as { properties?: Record<string, unknown> };
      event.properties = { ...event.properties, timestamp: at };
      await handleEvent({ event } as never, deps as never);
    }
  };

  const setClock = (v: number) => {
    clock = v;
  };

  return { board, tracker, deps, launchDeps, route, setClock };
}

describe('issue-1822: resumed child admission release', () => {
  test.each([
    ['started delivered before G2 registration', true],
    ['G2 registered before the stamped started is delivered', false],
  ] as const)(
    'terminal idle reconciles the resumed child (%s)',
    async (_label, startedFirst) => {
      const { board, tracker, deps, launchDeps, route, setClock } = setup();

      // G1 runs and is observed busy, leaving a prior generation fence.
      board.registerLaunch({
        taskID: TASK,
        parentSessionID: PARENT,
        agent: 'explorer',
        background: true,
        now: 0,
      });
      await route('g1-busy', 'session.execution.started', 50);

      // The parent resumes: a relaunch lease over G1, exactly as the
      // before-hook creates it, then the structured entry registers G2.
      const previous = board.get(TASK);
      if (!previous) throw new Error('missing G1 record');
      const lease = board.acquireLease(TASK, previous.generation, 'relaunch');
      if (!lease) throw new Error('missing relaunch lease');
      const pending = {
        callId: 'call_1',
        parentSessionId: PARENT,
        agentType: 'explorer',
        label: 'resumed',
        fullObjective: 'resumed objective',
        background: true,
        lifecycleEpoch: 0,
        resumedTaskId: TASK,
        relaunchLease: lease,
      };
      tracker.add(pending);

      const register = async () => {
        setClock(210);
        await registerDelegatedLaunchFromStructured(
          {
            callID: 'call_1',
            childTaskID: TASK,
            state: 'running',
            background: true,
            exactCallConfirmed: true,
            pending,
            handledByWrapper: true,
          },
          launchDeps as never,
        );
      };
      // The incident's busy evidence: stamped at t=201, before G2's t=210
      // run boundary.
      const started = () => route('g2-busy', 'session.execution.started', 201);
      if (startedFirst) {
        await started();
        await register();
      } else {
        await register();
        await started();
      }

      // Pin the ordering this fixture claims: the busy event really is
      // stamped before the new generation's run boundary. Without this the
      // case would pass for the wrong reason (a busy observation after the
      // boundary clears the fence by itself).
      const resumedRecord = board.get(TASK);
      expect(resumedRecord).toMatchObject({
        generation: 2,
        state: 'running',
        resumedRunProven: true,
        runStartedAt: 210,
      });
      expect(201).toBeLessThan(resumedRecord?.runStartedAt ?? 0);

      // Host reports the run finished (succeeded + idle, no generation).
      await route('g2-done', 'session.execution.succeeded', 400);

      // The generationless terminal idle must reach child reconciliation for
      // G2 so the gate can commit it and release the admission slot. Without
      // the launch proof this observation is rejected as fenced-stale.
      expect(
        deps.idleReconciler.scheduleChildIdleReconciliation,
      ).toHaveBeenCalledWith(TASK, 400, 2);
    },
  );
});
