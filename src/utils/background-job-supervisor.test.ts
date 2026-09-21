import { describe, expect, mock, test } from 'bun:test';
import { buildPluginInput } from '../v2/client-shim';
import { BackgroundJobBoard } from './background-job-board';
import { BackgroundJobCoordinator } from './background-job-coordinator';
import { boardFixture } from './background-job-fixture';
import { BackgroundJobSupervisor } from './background-job-supervisor';
import { createBackgroundJobTerminalGate } from './background-job-terminal-gate';

type TimerCallback = () => void;

function createTimerHarness() {
  let now = 0;
  let nextID = 0;
  const timers = new Map<number, { at: number; callback: TimerCallback }>();

  const setTimeout = (callback: TimerCallback, delay: number) => {
    const id = ++nextID;
    timers.set(id, { at: now + delay, callback });
    return id;
  };
  const clearTimeout = (id: number) => {
    timers.delete(id);
  };
  const advanceTo = async (target: number) => {
    now = target;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
    }
  };

  return {
    now: () => now,
    setTimeout,
    clearTimeout,
    advanceTo,
    pending: () => timers.size,
  };
}

function createSupervisor(
  overrides: {
    timeoutMs?: number;
    graceMs?: number;
    abort?: (taskID: string) => Promise<unknown>;
  } = {},
) {
  const board = new BackgroundJobBoard();
  const coordinator = new BackgroundJobCoordinator(board);
  const timers = createTimerHarness();
  const abort = mock(overrides.abort ?? (async () => undefined)) as unknown as (
    taskID: string,
  ) => Promise<unknown>;
  const supervisor = new BackgroundJobSupervisor({
    backgroundJobStore: coordinator,
    terminalGate: createBackgroundJobTerminalGate({
      backgroundJobBoard: coordinator,
      now: timers.now,
    }),
    wallClockTimeoutMs: overrides.timeoutMs ?? 100,
    abortGraceMs: overrides.graceMs ?? 20,
    abort,
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  coordinator.addTerminalOutcomeListener((record) =>
    supervisor.onTerminal(record),
  );

  return { board, coordinator, supervisor, timers, abort };
}

function launch(
  board: BackgroundJobBoard,
  background: boolean,
  now = 0,
  taskID = 'ses_1',
) {
  return board.registerLaunch({
    taskID,
    parentSessionID: 'parent',
    agent: 'explorer',
    description: 'test job',
    background,
    now,
  });
}

describe('BackgroundJobSupervisor', () => {
  test('supervises only explicit background launches', async () => {
    const { board, supervisor, timers, abort } = createSupervisor();
    const foreground = launch(board, false);
    const background = launch(board, true, 0, 'ses_2');

    supervisor.onLaunch(foreground);
    supervisor.onLaunch(background);
    await timers.advanceTo(100);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith('ses_2');
    expect(board.get('ses_1')?.deadlineExceededAt).toBeUndefined();
  });

  test('duplicate launch observations do not renew one run deadline', async () => {
    const { board, supervisor, timers, abort } = createSupervisor();
    const first = launch(board, true);
    supervisor.onLaunch(first);
    supervisor.onLaunch({ ...first, updatedAt: 80, lastLiveBusyAt: 80 });

    await timers.advanceTo(100);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith('ses_1');
  });

  test('terminal state wins before the deadline and clears timers', async () => {
    const { board, coordinator, supervisor, timers, abort } =
      createSupervisor();
    const job = launch(board, true);
    supervisor.onLaunch(job);
    const completed = boardFixture.updateStatus(coordinator, {
      taskID: job.taskID,
      state: 'completed',
      now: 99,
    });
    if (completed) supervisor.onTerminal(completed);
    await timers.advanceTo(100);

    expect(abort).not.toHaveBeenCalled();
    expect(board.get(job.taskID)?.state).toBe('completed');
    expect(timers.pending()).toBe(0);
  });

  test.each([
    ['resolve', async () => undefined],
    ['reject', async () => Promise.reject(new Error('abort failed'))],
    ['hang', () => new Promise<never>(() => {})],
  ])(
    'abort %s is requested once and grace remains independent',
    async (_, abortCall) => {
      const { board, supervisor, timers, abort } = createSupervisor({
        abort: abortCall,
      });
      const job = launch(board, true);
      supervisor.onLaunch(job);
      await timers.advanceTo(100);
      await timers.advanceTo(119);

      expect(abort).toHaveBeenCalledTimes(1);
      expect(board.get(job.taskID)?.state).toBe('running');
      await timers.advanceTo(120);

      expect(board.get(job.taskID)).toMatchObject({
        state: 'running',
        timedOut: true,
        statusUncertain: true,
        cancellationRequested: true,
      });
      expect(board.get(job.taskID)?.deadlineExceededAt).toBe(100);
    },
  );

  test('completion after the deadline claim cannot replace the timeout', async () => {
    const { board, coordinator, supervisor, timers, abort } =
      createSupervisor();
    const job = launch(board, true);
    supervisor.onLaunch(job);
    await timers.advanceTo(100);

    const late = coordinator.updateStatus({
      taskID: job.taskID,
      state: 'completed',
      resultSummary: 'late success',
      now: 101,
    });
    expect(late?.state).toBe('running');
    expect(late?.resultSummary).not.toBe('late success');
    expect(abort).toHaveBeenCalledTimes(1);
  });

  test('busy activity after the deadline neither recovers nor renews the run', async () => {
    const { board, coordinator, supervisor, timers, abort } =
      createSupervisor();
    const job = launch(board, true);
    supervisor.onLaunch(job);
    await timers.advanceTo(100);
    coordinator.markRunningFromLiveSession(job.taskID, 101);

    expect(board.get(job.taskID)).toMatchObject({
      state: 'running',
      lastLiveBusyAt: 101,
      deadlineExceededAt: 100,
    });
    expect(
      coordinator.resolveRecoverable('parent', job.taskID),
    ).toBeUndefined();
    await timers.advanceTo(120);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(board.get(job.taskID)?.state).toBe('running');
  });

  test('error and cancellation labels during grace are not terminal authority', async () => {
    for (const state of ['error', 'cancelled'] as const) {
      const { board, coordinator, supervisor, timers } = createSupervisor();
      const job = launch(board, true);
      supervisor.onLaunch(job);
      await timers.advanceTo(100);

      const settled = coordinator.updateStatus({
        taskID: job.taskID,
        state,
        resultSummary: 'child terminal',
        now: 101,
      });

      expect(settled).toMatchObject({
        state: 'running',
        timedOut: true,
        statusUncertain: false,
        deadlineExceededAt: 100,
      });
      expect(timers.pending()).toBe(1);
    }
  });

  test('child deletion during grace publishes a visible timed-out terminal', async () => {
    const { board, supervisor, timers, abort } = createSupervisor();
    const job = launch(board, true);
    supervisor.onLaunch(job);
    await timers.advanceTo(100);

    expect(supervisor.onSessionDeleted(job.taskID)).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(board.get(job.taskID)).toMatchObject({
      state: 'error',
      timedOut: true,
      terminalUnreconciled: true,
      statusUncertain: false,
    });
    expect(board.formatForPrompt('parent')).toContain(
      'error, unreconciled, timed out',
    );
    board.markReconciled(job.taskID, 130);
    expect(board.get(job.taskID)).toMatchObject({
      state: 'reconciled',
      terminalState: 'error',
      statusUncertain: false,
      deadlineExceededAt: 100,
    });
    expect(timers.pending()).toBe(0);
  });

  test('wall-clock timeout is not recoverable while external timeout remains recoverable', async () => {
    const { board, coordinator, supervisor, timers } = createSupervisor();
    const external = launch(board, false, 0, 'external');
    coordinator.updateStatus({
      taskID: external.taskID,
      state: 'running',
      timedOut: true,
    });
    coordinator.markRunningFromLiveSession(external.taskID, 1);
    expect(
      coordinator.resolveRecoverable('parent', external.taskID),
    ).toBeDefined();

    const wall = launch(board, true, 0, 'wall');
    supervisor.onLaunch(wall);
    await timers.advanceTo(100);
    coordinator.markRunningFromLiveSession(wall.taskID, 101);
    expect(
      coordinator.resolveRecoverable('parent', wall.taskID),
    ).toBeUndefined();
  });

  // ── v2-sim pin: shim abort mapping + deadline error semantics ──
  //
  // On a v2 host the plugin's abort seam is `ctx.client.session.abort`
  // (src/index.ts), which the REAL v2 client shim maps to the host's
  // `session.interrupt({sessionID, resume: false})`. When the deadline
  // fires, that interrupt must be invoked (exactly once), and the
  // terminal outcome must be the wall-clock `error` — the interrupted
  // execution event the host publishes afterwards maps to the stop
  // family (Task 5), but a stop-family report can never outrank the
  // deadline claim: 'stopped' is not an acceptable terminal state for a
  // wall-clock timeout.
  test('v2-sim: deadline aborts via the shim interrupt mapping and finalizes error, never stopped', async () => {
    const interrupt = mock(
      async (_input: { sessionID: string; resume?: boolean }) => undefined,
    );
    const shim = buildPluginInput({
      session: { interrupt },
    } as unknown as Parameters<typeof buildPluginInput>[0]);
    const sessionAbort = (
      shim.client as {
        session: { abort: (args: Record<string, unknown>) => Promise<unknown> };
      }
    ).session.abort;
    const { board, coordinator, supervisor, timers } = createSupervisor({
      // The exact production wiring (src/index.ts): the supervisor's
      // abort delegates to client.session.abort({path:{id}}), which the
      // shim translates to interrupt({sessionID, resume:false}).
      abort: (taskID) => sessionAbort({ path: { id: taskID } }),
    });
    const job = launch(board, true);
    supervisor.onLaunch(job);
    await timers.advanceTo(100);

    // The shim mapping fired the host interrupt exactly once.
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      resume: false,
    });
    expect(board.get(job.taskID)).toMatchObject({
      state: 'running',
      timedOut: true,
      deadlineExceededAt: 100,
    });

    // The v2 host then reports the interrupted execution; the evidence
    // chain maps it to the stop family — but the deadline claim is a
    // hard, non-recoverable terminal authority.
    const stopFamily = boardFixture.updateStatus(coordinator, {
      taskID: job.taskID,
      state: 'stopped',
      resultSummary: 'host reported the interrupted execution',
      now: 101,
    });
    expect(stopFamily).toMatchObject({
      state: 'error',
      terminalState: 'error',
      timedOut: true,
      terminalUnreconciled: true,
      deadlineExceededAt: 100,
    });
    expect(stopFamily?.state).not.toBe('stopped');

    // The interrupt stays exactly-once after the terminal settles.
    await timers.advanceTo(200);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(0);
  });

  test('drop, parent cleanup, dispose, and relaunch clear or replace timers', async () => {
    const { board, supervisor, timers, abort } = createSupervisor();
    const job = launch(board, true);
    supervisor.onLaunch(job);
    supervisor.drop(job.taskID);
    board.drop(job.taskID);
    await timers.advanceTo(100);
    expect(abort).not.toHaveBeenCalled();

    const parentJob = launch(board, true, 100, 'parent-job');
    supervisor.onLaunch(parentJob);
    supervisor.clearParent('parent');
    board.clearParent('parent');
    await timers.advanceTo(200);
    expect(abort).not.toHaveBeenCalled();

    const relaunched = launch(board, true, 200, 'relaunch');
    supervisor.onLaunch(relaunched);
    const secondRun = board.registerLaunch({
      taskID: relaunched.taskID,
      parentSessionID: 'parent',
      agent: 'explorer',
      background: true,
      now: 300,
    });
    supervisor.onLaunch(secondRun);
    await timers.advanceTo(399);
    expect(abort).not.toHaveBeenCalled();
    await timers.advanceTo(400);
    expect(abort).toHaveBeenCalledTimes(1);

    const disposedJob = launch(board, true, 400, 'disposed');
    supervisor.onLaunch(disposedJob);
    supervisor.dispose();
    supervisor.dispose();
    expect(supervisor.onSessionDeleted(disposedJob.taskID)).toBe(false);
    expect(board.get(disposedJob.taskID)?.state).toBe('running');
    await timers.advanceTo(500);
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
