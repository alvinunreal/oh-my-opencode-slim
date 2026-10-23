import { describe, expect, mock, test } from 'bun:test';
import { buildPluginInput } from '../v2/client-shim';
import { BackgroundJobBoard } from './background-job-board';
import { boardFixture } from './background-job-fixture';
import { BackgroundJobSupervisor } from './background-job-supervisor';
import { createBackgroundJobTerminalGate } from './background-job-terminal-gate';
import { createTimerHarness } from './test-timers';

function createSupervisor(
  overrides: {
    timeoutMs?: number;
    abort?: (taskID: string) => Promise<unknown>;
  } = {},
) {
  const board = new BackgroundJobBoard();
  const timers = createTimerHarness();
  const abort = mock(overrides.abort ?? (async () => undefined)) as unknown as (
    taskID: string,
  ) => Promise<unknown>;
  const supervisor = new BackgroundJobSupervisor({
    backgroundJobBoard: board,
    wallClockTimeoutMs: overrides.timeoutMs ?? 100,
    abort,
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  board.addTerminalOutcomeListener((record) => supervisor.onTerminal(record));

  return { board, supervisor, timers, abort };
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
    // The watchdog stops the child; the HOST reports the terminal, so the
    // board row is untouched by the expiry itself.
    expect(board.get('ses_1')?.state).toBe('running');
    expect(board.get('ses_1')?.timedOut).toBe(false);
    expect(board.get('ses_2')?.state).toBe('running');
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

  test('a reopened live run arms a fresh deadline from its new fence', async () => {
    const { board, supervisor, timers, abort } = createSupervisor();
    const job = launch(board, true);
    supervisor.onLaunch(job);
    const completed = boardFixture.updateStatus(board, {
      taskID: job.taskID,
      state: 'completed',
      now: 50,
    });
    if (completed) supervisor.onTerminal(completed);

    const reopened = board.markRunningFromLiveSession(job.taskID, 60);
    expect(reopened).toMatchObject({ state: 'running', runStartedAt: 60 });
    if (reopened) supervisor.onLaunch(reopened);

    // The original deadline was 100. The reopened execution started at 60,
    // so its one-shot deadline is 160.
    await timers.advanceTo(159);
    expect(abort).not.toHaveBeenCalled();
    await timers.advanceTo(160);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  test('terminal state wins before the deadline and clears timers', async () => {
    const { board, supervisor, timers, abort } = createSupervisor();
    const job = launch(board, true);
    supervisor.onLaunch(job);
    const completed = boardFixture.updateStatus(board, {
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
    'abort %s never fabricates a board terminal or a second abort',
    async (_, abortCall) => {
      const { board, supervisor, timers, abort } = createSupervisor({
        abort: abortCall,
      });
      const job = launch(board, true);
      supervisor.onLaunch(job);
      await timers.advanceTo(100);
      await timers.advanceTo(200);

      expect(abort).toHaveBeenCalledTimes(1);
      // The watchdog only asks the host to stop the child. The board row
      // stays exactly as it was: no timeout claim, no fabricated terminal.
      expect(board.get(job.taskID)).toMatchObject({
        state: 'running',
        timedOut: false,
        statusUncertain: false,
        cancellationRequested: false,
        terminalUnreconciled: false,
      });
      expect(timers.pending()).toBe(0);
    },
  );

  test('expiry acquires the task_cancel cancellation lease and releases it when the abort settles', async () => {
    const { board, supervisor, timers } = createSupervisor({
      // A hanging host abort: the lease must stay held for its duration.
      abort: () => new Promise<never>(() => {}),
    });
    const job = launch(board, true);
    supervisor.onLaunch(job);
    await timers.advanceTo(100);
    await timers.tick();

    expect(board.acquireLease(job.taskID, job.generation, 'cancellation')).toBe(
      undefined,
    );
    expect(
      board.acquireLease(job.taskID, job.generation, 'relaunch'),
    ).toBeUndefined();

    // A teardown while the abort is in flight releases the lease, so the
    // run cannot outlive its watchdog ownership.
    supervisor.drop(job.taskID);
    const reclaimed = board.acquireLease(
      job.taskID,
      job.generation,
      'cancellation',
    );
    expect(reclaimed).toEqual(
      expect.objectContaining({ kind: 'cancellation' }),
    );
    if (reclaimed) board.releaseLease(reclaimed);
  });

  test('the lease is released once a settling abort completes', async () => {
    const settle = Promise.withResolvers<void>();
    const { board, supervisor, timers } = createSupervisor({
      abort: async () => {
        await settle.promise;
      },
    });
    const job = launch(board, true);
    supervisor.onLaunch(job);
    await timers.advanceTo(100);
    await timers.tick();
    expect(board.acquireLease(job.taskID, job.generation, 'cancellation')).toBe(
      undefined,
    );

    settle.resolve();
    await timers.tick();
    expect(
      board.acquireLease(job.taskID, job.generation, 'cancellation'),
    ).toEqual(expect.objectContaining({ kind: 'cancellation' }));
  });

  test('a lease already held by another operation stands the watchdog down', async () => {
    const { board, supervisor, timers, abort } = createSupervisor();
    const job = launch(board, true);
    supervisor.onLaunch(job);
    // A user task_cancel (or relaunch/message operation) already owns the child.
    const lease = board.acquireLease(
      job.taskID,
      job.generation,
      'cancellation',
    );
    expect(lease).toBeDefined();

    await timers.advanceTo(100);
    expect(abort).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
    if (lease) {
      expect(board.validateLease(lease)).toBe(true);
      board.releaseLease(lease);
    }
  });

  test('the later real aborted terminal publishes exactly once through the host evidence path', async () => {
    const { board, supervisor, timers, abort } = createSupervisor();
    const gate = createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      graceMs: 5,
      maxEvidenceRetries: 0,
      readTerminalEvidence: async () => ({ data: [] }),
    });
    const publications: string[] = [];
    board.addTerminalOutcomeListener((record) =>
      publications.push(`${record.state}:${record.terminalRevision}`),
    );
    const job = launch(board, true);
    supervisor.onLaunch(job);
    await timers.advanceTo(100);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(board.get(job.taskID)).toMatchObject({ state: 'running' });

    // The host reports the outcome of the abort it performed: an interrupted
    // run lands in the stop family through the gate's evidence path.
    const token = gate.capture({
      taskID: job.taskID,
      generation: job.generation,
    });
    expect(token).toBeDefined();
    if (token) {
      const observed = gate.observe(token, {
        kind: 'quiescent',
        origin: 'host-outcome',
        readStartedAt: token.readStartedAt,
        terminalOutcome: 'interrupted',
      });
      expect(observed.kind).toBe('deferred');
    }
    await timers.advanceTo(110);

    const result = await gate.reconcile({
      taskID: job.taskID,
      generation: job.generation,
    });
    expect(result.kind).toBe('committed');
    expect(board.get(job.taskID)).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
      resultSummary: 'Host reported outcome: interrupted.',
    });
    expect(publications).toEqual(['stopped:1']);

    // Nothing re-opens a published terminal, and no second abort happens.
    const again = await gate.reconcile({
      taskID: job.taskID,
      generation: job.generation,
    });
    expect(again.kind).toBe('committed');
    expect(publications).toEqual(['stopped:1']);
    await timers.advanceTo(400);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(0);
    gate.dispose();
  });

  test('busy activity after the abort keeps the row running until real evidence lands', async () => {
    const { board, supervisor, timers, abort } = createSupervisor();
    const job = launch(board, true);
    supervisor.onLaunch(job);
    await timers.advanceTo(100);
    board.markRunningFromLiveSession(job.taskID, 101);

    expect(board.get(job.taskID)).toMatchObject({
      state: 'running',
      lastLiveBusyAt: 101,
    });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(board.get(job.taskID)?.state).toBe('running');
    expect(board.get(job.taskID)?.resultSummary).toBeUndefined();
  });

  test('wallClockTimeoutMs = 0 disables the watchdog entirely', async () => {
    const { board, supervisor, timers, abort } = createSupervisor({
      timeoutMs: 0,
    });
    const job = launch(board, true);
    supervisor.onLaunch(job);

    expect(timers.pending()).toBe(0);
    await timers.advanceTo(1_000_000);
    expect(abort).not.toHaveBeenCalled();
    expect(board.get(job.taskID)).toMatchObject({ state: 'running' });
    supervisor.onTerminal({ ...job, state: 'completed', terminalRevision: 1 });
    supervisor.onSessionDeleted(job.taskID);
    expect(timers.pending()).toBe(0);
  });

  test('cancel-vs-watchdog race publishes one terminal and leaks no lease', async () => {
    // The watchdog's abort and a user task_cancel race: whichever acquires the
    // cancellation lease owns the child; the other stands down. Exactly one
    // terminal is published and no lease survives the run.
    const settle = Promise.withResolvers<void>();
    const { board, supervisor, timers, abort } = createSupervisor({
      abort: async () => {
        await settle.promise;
      },
    });
    const job = launch(board, true);
    supervisor.onLaunch(job);
    await timers.advanceTo(100);
    await timers.tick();

    // The watchdog holds the lease for the abort's duration, so the racing
    // user task_cancel is refused instead of sending a second abort.
    expect(board.acquireLease(job.taskID, job.generation, 'cancellation')).toBe(
      undefined,
    );

    // The watchdog's abort settles, the user's cancel takes over, and its
    // terminal publishes exactly once.
    settle.resolve();
    await timers.tick();
    const userLease = board.acquireLease(
      job.taskID,
      job.generation,
      'cancellation',
    );
    expect(userLease).toEqual(
      expect.objectContaining({ kind: 'cancellation' }),
    );
    if (!userLease) throw new Error('lease not restored after abort settled');

    const cancelled = boardFixture.markCancelled(
      board,
      job.taskID,
      'user cancel',
      110,
      { cancellationLease: userLease },
    );
    expect(cancelled).toMatchObject({ state: 'cancelled' });
    if (cancelled) supervisor.onTerminal(cancelled);
    expect(board.validateLease(userLease)).toBe(true);
    board.releaseLease(userLease);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(board.get(job.taskID)).toMatchObject({ state: 'cancelled' });
    expect(timers.pending()).toBe(0);
  });

  // ── v2-sim pin: shim abort mapping ──
  //
  // On a v2 host the plugin's abort seam is `ctx.client.session.abort`
  // (src/index.ts), which the REAL v2 client shim maps to the host's
  // `session.interrupt({sessionID, resume: false})`. When the deadline
  // fires, that interrupt must be invoked exactly once; the host then
  // reports the interrupted execution through the normal evidence path,
  // which is the only place a terminal is published.
  test('v2-sim: deadline aborts via the shim interrupt mapping exactly once', async () => {
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
    const { board, supervisor, timers } = createSupervisor({
      // The exact production wiring (src/index.ts): the supervisor's
      // abort delegates to client.session.abort({path:{id}}), which the
      // shim translates to interrupt({sessionID, resume:false}).
      abort: (taskID) => sessionAbort({ path: { id: taskID } }),
    });
    const job = launch(board, true);
    supervisor.onLaunch(job);
    await timers.advanceTo(100);

    // The shim mapping fired the host interrupt exactly once, and the
    // watchdog wrote no terminal state of its own.
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      resume: false,
    });
    expect(board.get(job.taskID)).toMatchObject({ state: 'running' });

    // The v2 host then reports the interrupted execution; the evidence
    // chain maps it to the stop family — the only terminal this run gets.
    const stopFamily = boardFixture.updateStatus(board, {
      taskID: job.taskID,
      state: 'stopped',
      resultSummary: 'host reported the interrupted execution',
      now: 101,
    });
    expect(stopFamily).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
    });

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
    supervisor.onSessionDeleted(disposedJob.taskID);
    expect(board.get(disposedJob.taskID)?.state).toBe('running');
    await timers.advanceTo(500);
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
