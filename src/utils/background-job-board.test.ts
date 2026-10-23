import { describe, expect, mock, spyOn, test } from 'bun:test';
import {
  type BackgroundJobEvictedSession,
  isPrunableEvictedSession,
  BackgroundJobBoard as ProductionBoard,
} from './background-job-board';
import { BackgroundJobBoard, boardFixture } from './background-job-fixture';
import * as loggerModule from './logger';

describe('BackgroundJobBoard', () => {
  test('T-B: silent adoption does not outrank known F2 sessions', () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1000);
    const board = new BackgroundJobBoard({ maxReusablePerAgent: 2 });
    const complete = (taskID: string, now: number) => {
      board.registerLaunch({
        taskID,
        parentSessionID: 'parent-1',
        agent: 'explorer',
        now,
      });
      board.updateStatus({ taskID, state: 'completed', now });
      board.markReconciled(taskID, now);
    };
    complete('ses_f2', 400);
    const f2 = structuredClone(board.get('ses_f2'));
    const outcome = mock();
    const identity = mock();
    board.addTerminalOutcomeListener(outcome);
    board.addLaunchIdentityListener(identity);
    const input = {
      taskID: 'ses_adopted',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'host child',
      terminalState: 'error' as const,
      resultSummary: 'host error',
      createdAt: 50,
      updatedAt: 100,
    };
    try {
      const adopted = board.adoptTerminal(input);
      expect(adopted).toMatchObject({
        alias: 'ses_adopted',
        state: 'reconciled',
        terminalState: 'error',
        lastUsedAt: 100,
        resultSummary: 'host error',
      });
      expect(
        board.adoptTerminal({ ...input, taskID: 'ses_f2' }),
      ).toBeUndefined();
      expect(board.get('ses_f2')).toEqual(f2);
      expect(identity).toHaveBeenCalledTimes(1);
      expect(outcome).not.toHaveBeenCalled();
      expect(board.hasTerminalUnreconciled('parent-1')).toBe(false);
      complete('ses_new', 1000);
      expect(board.get('ses_adopted')).toBeUndefined();
      expect(board.get('ses_f2')).toBeDefined();
      expect(board.get('ses_new')?.alias).toBe('exp-2');
    } finally {
      clock.mockRestore();
    }
  });

  test('registers background launches as running jobs with aliases', () => {
    const board = new BackgroundJobBoard();

    const job = board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config',
      now: 100,
    });

    expect(job).toMatchObject({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config',
      state: 'running',
      alias: 'exp-1',
      terminalUnreconciled: false,
    });
    expect(board.hasRunning('parent-1')).toBe(true);
    expect(board.hasRunningJobs()).toBe(true);
    expect(job).not.toHaveProperty('provisional');
    expect(board.resolve('parent-1', job.taskID)).toEqual(job);
  });

  test.each([false, true])(
    'promotes a resolvable hidden placeholder (preserveRun=%s)',
    (preserveRun) => {
      const board = new BackgroundJobBoard();
      const launch = {
        taskID: 'child-1',
        parentSessionID: 'parent-1',
        agent: 'unknown',
        description: 'unattributed unknown task',
        now: 100,
      };
      const provisional = board.registerLaunch({
        ...launch,
        provisional: true,
      });
      expect(board.get(launch.taskID)).toEqual(provisional);
      expect(board.resolve('parent-1', launch.taskID)).toEqual(provisional);
      expect(board.resolve('parent-1', provisional.alias)).toEqual(provisional);
      // A provisional placeholder is never delegated work.
      expect(board.hasRunning('parent-1')).toBe(false);
      expect(board.hasTerminalUnreconciled('parent-1')).toBe(false);

      const promoted = board.registerLaunch({ ...launch, preserveRun });
      expect(promoted.provisional).toBe(false);
      expect(promoted.generation).toBe(
        provisional.generation + (preserveRun ? 0 : 1),
      );
      expect(board.resolve('parent-1', launch.taskID)?.provisional).toBe(false);
      board.markStopped(launch.taskID, 'no outcome', 200);
      expect(board.get(launch.taskID)).toMatchObject({
        taskID: launch.taskID,
        state: 'stopped',
        terminalUnreconciled: true,
      });
    },
  );

  test.each(['stopped', 'completed'])(
    'keeps a %s placeholder hidden before and after acknowledgement',
    (state) => {
      const board = new BackgroundJobBoard();
      const job = board.registerLaunch({
        taskID: 'child-1',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        provisional: true,
        now: 100,
      });
      if (state === 'stopped') board.markStopped(job.taskID, 'no outcome', 200);
      else board.updateStatus({ taskID: job.taskID, state: 'completed' });
      expect(board.hasTerminalUnreconciled('parent-1')).toBe(false);
      board.markReconciled(job.taskID);
      expect(board.hasTerminalUnreconciled('parent-1')).toBe(false);
      expect(board.resolve('parent-1', job.alias)?.provisional).toBe(true);
    },
  );

  test.each(['stopped', 'completed'])(
    'attribution promotes a %s placeholder via preserveRun without resurrecting it',
    (state) => {
      const board = new BackgroundJobBoard();
      const job = board.registerLaunch({
        taskID: 'child-1',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        provisional: true,
        now: 100,
      });
      if (state === 'stopped') board.markStopped(job.taskID, 'no outcome', 200);
      else board.updateStatus({ taskID: job.taskID, state: 'completed' });

      const promoted = board.registerLaunch({
        taskID: 'child-1',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        preserveRun: true,
        now: 300,
      });
      expect(promoted.provisional).toBe(false);
      expect(promoted.state).toBe(state);
      expect(promoted.generation).toBe(job.generation);
      expect(board.resolve('parent-1', 'child-1')?.provisional).toBe(false);
    },
  );

  test('provisionals are not delegated work for wake and wait predicates', () => {
    const board = new BackgroundJobBoard();
    const job = board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      provisional: true,
      now: 100,
    });
    expect(board.hasRunning('parent-1')).toBe(false);
    expect(board.hasTerminalUnreconciled('parent-1')).toBe(false);
    board.markStopped(job.taskID, 'no outcome', 200);
    expect(board.hasTerminalUnreconciled('parent-1')).toBe(false);
    board.promoteProvisional(job.taskID);
    expect(board.hasTerminalUnreconciled('parent-1')).toBe(true);
  });

  test('hasRunningJobs is false once no job is running', () => {
    const board = new BackgroundJobBoard();
    expect(board.hasRunningJobs()).toBe(false);
    board.registerLaunch({
      taskID: 'ses_idle',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config',
    });
    board.updateStatus({
      taskID: 'ses_idle',
      state: 'completed',
      resultSummary: 'done',
    });
    expect(board.hasRunningJobs()).toBe(false);
  });
  test('markUsed lands strictly after completion even with equal timestamps', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config',
      now: 100,
    });
    board.updateStatus({
      taskID: 'ses_1',
      state: 'completed',
      resultSummary: 'done',
      now: 200,
    });

    // Retrieval in the same millisecond as the terminal transition must
    // still open the duplicate-spawn guard's escape hatch.
    board.markUsed('parent-1', 'ses_1', 200);

    const job = board.get('ses_1');
    expect(job?.completedAt).toBe(200);
    expect(job?.lastUsedAt).toBe(201);
  });

  const leaseKinds = [
    'message',
    'relaunch',
    'cancellation',
    'terminal-notification',
  ] as const;
  test.each(
    leaseKinds.flatMap((owner) =>
      leaseKinds.map((contender) => ({ owner, contender })),
    ),
  )(
    '$owner excludes $contender until its own token is released',
    ({ owner, contender }) => {
      const board = new BackgroundJobBoard();
      const run = board.registerLaunch({
        taskID: 'ses_lease',
        parentSessionID: 'parent-1',
        agent: 'fixer',
      });
      const acquire = {
        message: () =>
          board.acquireLease(run.taskID, run.generation, 'message'),
        relaunch: () =>
          board.acquireLease(run.taskID, run.generation, 'relaunch'),
        cancellation: () =>
          board.acquireLease(run.taskID, run.generation, 'cancellation'),
        'terminal-notification': () =>
          board.acquireLease(
            run.taskID,
            run.generation,
            'terminal-notification',
            { terminalRevision: board.get(run.taskID)?.terminalRevision },
          ),
      };
      const complete = () =>
        board.updateStatus({
          taskID: run.taskID,
          state: 'completed',
          resultSummary: 'done',
        });
      if (owner === 'terminal-notification') complete();
      const lease = acquire[owner]();
      if (!lease) throw new Error('missing owner lease');
      expect(lease.kind).toBe(owner);
      expect(board.validateLease(lease)).toBe(true);
      if (owner !== 'relaunch') {
        expect(() => board.registerLaunch({ ...run })).toThrow(
          `${owner} lease`,
        );
      }
      // Change eligibility without releasing ownership. Withdrawing a terminal
      // revision revokes send permission, but must not prevent token retirement.
      const current = board.get(run.taskID);
      if (!current) throw new Error('missing current record');
      board.markRunningFromLiveSession(
        run.taskID,
        current.updatedAt + 1,
        run.generation,
        current.terminalRevision,
      );
      if (contender === 'terminal-notification') complete();
      expect(board.validateLease(lease)).toBe(
        owner !== 'terminal-notification',
      );
      expect(acquire[contender]()).toBeUndefined();
      expect(board.releaseLease(lease)).toBe(true);
      expect(board.releaseLease(lease)).toBe(false);
      const next = acquire[contender]();
      if (!next) throw new Error('missing next lease');
      expect(next.token).not.toBe(lease.token);
      expect(board.releaseLease(lease)).toBe(false);
      expect(board.validateLease(next)).toBe(true);
      expect(acquire[contender]()).toBeUndefined();
      expect(board.releaseLease(next)).toBe(true);
    },
  );

  // P3c: the four acquire seams collapsed into one owner mutex, but the kind
  // label stays load-bearing for the model-visible refusal. Pin each kind's
  // conflict wording byte-identically so the collapse cannot silently
  // reword a refusal.
  test.each(leaseKinds)(
    'a live $kind lease refuses a launch with byte-identical wording',
    (kind) => {
      const board = new BackgroundJobBoard();
      const run = board.registerLaunch({
        taskID: 'ses_refuse',
        parentSessionID: 'parent-1',
        agent: 'fixer',
      });
      if (kind === 'terminal-notification') {
        board.updateStatus({
          taskID: 'ses_refuse',
          state: 'completed',
          resultSummary: 'done',
        });
      }
      const lease = board.acquireLease(
        run.taskID,
        run.generation,
        kind,
        kind === 'terminal-notification'
          ? {
              terminalRevision: board.get(run.taskID)?.terminalRevision,
            }
          : undefined,
      );
      if (!lease) throw new Error(`missing ${kind} lease`);
      expect(() =>
        board.registerLaunch({
          taskID: run.taskID,
          parentSessionID: 'parent-1',
          agent: 'fixer',
        }),
      ).toThrow(
        `Cannot register launch for ses_refuse: a ${kind} lease already owns this session`,
      );
    },
  );

  // P3c counter collapse: lease tokens no longer consume a numeric sequence
  // (the run ordinal is the board's single counter); each issued token is a
  // fresh unique id, so a replayed token can never authorize anything.
  // Generation magnitude IS load-bearing outside the board (event-router's
  // ambiguous-relaunch-deletion check reads `generation > 1`), so lease
  // issuances must never spend run ordinals.
  test('lease issuances never advance the run ordinal', () => {
    const board = new BackgroundJobBoard();
    const run = board.registerLaunch({
      taskID: 'sesOrdinal',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    expect(run.generation).toBe(1);

    // Spend leases of every kind, repeatedly, including terminal ones.
    const message = board.acquireLease('sesOrdinal', run.generation, 'message');
    if (!message) throw new Error('missing message lease');
    board.releaseLease(message);
    const cancellation = board.acquireLease(
      'sesOrdinal',
      run.generation,
      'cancellation',
    );
    if (!cancellation) throw new Error('missing cancellation lease');
    board.releaseLease(cancellation);
    const relaunchLease = board.acquireLease(
      'sesOrdinal',
      run.generation,
      'relaunch',
    );
    if (!relaunchLease) throw new Error('missing relaunch lease');
    board.releaseLease(relaunchLease);
    board.updateStatus({ taskID: 'sesOrdinal', state: 'completed' });
    const terminal = board.acquireLease(
      'sesOrdinal',
      run.generation,
      'terminal-notification',
    );
    if (!terminal) throw new Error('missing terminal-notification lease');
    board.releaseLease(terminal);

    // A launch after all that churn still takes the board's second ordinal:
    // generations stay contiguous per launch, never per lease issuance.
    const relaunched = board.registerLaunch({
      taskID: 'sesOrdinal',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 200,
    });
    expect(relaunched.generation).toBe(2);
  });
  test('a superseded run rejects stale writers and replayed lease tokens', () => {
    const board = new BackgroundJobBoard();
    const first = board.registerLaunch({
      taskID: 'ses_stale',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 100,
    });
    const seeded = board.acquireLease(
      'ses_stale',
      first.generation,
      'relaunch',
    );
    if (!seeded) throw new Error('missing seeded relaunch lease');
    board.releaseLease(seeded);
    const second = board.registerLaunch({
      taskID: 'ses_stale',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 200,
    });

    // Stale writers replaying the superseded run's generation are ignored.
    expect(
      board.updateStatus({
        taskID: 'ses_stale',
        state: 'error',
        expectedGeneration: first.generation,
      }),
    ).toMatchObject({ state: 'running', generation: second.generation });
    expect(
      board.markRunningFromLiveSession('ses_stale', 300, first.generation),
    ).toMatchObject({ state: 'running', generation: second.generation });

    // A replayed lease token is not authoritative once the run's lease has
    // been reissued: unique tokens, no shared counter value to collide on.
    const retired = board.acquireLease(
      'ses_stale',
      second.generation,
      'relaunch',
    );
    if (!retired) throw new Error('missing relaunch lease');
    board.releaseLease(retired);
    expect(board.validateLease(retired)).toBe(false);
    const reissued = board.acquireLease(
      'ses_stale',
      second.generation,
      'relaunch',
    );
    if (!reissued) throw new Error('missing reissued lease');
    expect(reissued.token).not.toBe(retired.token);
    expect(board.validateLease(retired)).toBe(false);
    expect(board.releaseLease(retired)).toBe(false);
    expect(() =>
      board.registerLaunch({
        taskID: 'ses_stale',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        relaunchLease: retired,
      }),
    ).toThrow(
      'Cannot register launch for ses_stale: the relaunch lease is missing, stale, or belongs to another generation',
    );
    board.releaseLease(reissued);
  });

  test('relaunch lease fences cancellation and validates token/generation', () => {
    const board = new BackgroundJobBoard();
    const first = board.registerLaunch({
      taskID: 'ses_lease',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    const relaunchLease = board.acquireLease(
      first.taskID,
      first.generation,
      'relaunch',
    );

    expect(relaunchLease).toBeDefined();
    if (!relaunchLease) throw new Error('relaunch lease was not acquired');
    expect(
      board.acquireLease(first.taskID, first.generation, 'cancellation'),
    ).toBeUndefined();
    expect(
      board.releaseLease({
        ...relaunchLease,
        token: 'wrong-token',
      }),
    ).toBe(false);
    expect(
      board.releaseLease({
        ...relaunchLease,
        generation: first.generation + 1,
      }),
    ).toBe(false);
    expect(board.validateLease(relaunchLease)).toBe(true);

    const second = board.registerLaunch({
      taskID: first.taskID,
      parentSessionID: 'parent-1',
      agent: 'fixer',
      relaunchLease,
    });
    expect(second.generation).not.toBe(first.generation);
    expect(board.releaseLease(relaunchLease)).toBe(true);
  });

  test('expected generation and cancellation token fence markCancelled', () => {
    const board = new BackgroundJobBoard();
    const first = board.registerLaunch({
      taskID: 'ses_lease',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    const cancellationLease = board.acquireLease(
      first.taskID,
      first.generation,
      'cancellation',
    );
    expect(cancellationLease).toBeDefined();
    if (!cancellationLease) {
      throw new Error('cancellation lease was not acquired');
    }

    expect(
      board.markCancelled(first.taskID, 'wrong generation', Date.now(), {
        force: true,
        expectedGeneration: first.generation + 1,
        cancellationLease,
      })?.state,
    ).toBe('running');
    expect(
      board.markCancelled(first.taskID, 'wrong token', Date.now(), {
        force: true,
        expectedGeneration: first.generation,
        cancellationLease: {
          ...cancellationLease,
          token: 'wrong-token',
        },
      })?.state,
    ).toBe('running');
    expect(
      board.markCancelled(first.taskID, 'cancelled', Date.now(), {
        force: true,
        expectedGeneration: first.generation,
        cancellationLease,
      })?.state,
    ).toBe('cancelled');
  });

  test('updates terminal task results as unreconciled', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
      now: 100,
    });

    const updated = board.updateStatus({
      taskID: 'ses_1',
      state: 'completed',
      resultSummary: 'looks good',
      now: 200,
    });

    expect(updated).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      completedAt: 200,
      resultSummary: 'looks good',
    });
    expect(board.hasTerminalUnreconciled('parent-1')).toBe(true);
  });

  test('expected generation fences a late native terminal status', () => {
    const board = new BackgroundJobBoard();
    const listener = mock(() => {});
    board.addTerminalOutcomeListener((record) => listener(record.taskID));
    const first = board.registerLaunch({
      taskID: 'ses_generation',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({
      taskID: 'ses_generation',
      state: 'completed',
      resultSummary: 'G1 result',
    });
    listener.mockClear();
    const second = board.registerLaunch({
      taskID: 'ses_generation',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    board.updateStatus({
      taskID: 'ses_generation',
      state: 'completed',
      expectedGeneration: first.generation,
      resultSummary: 'late G1 result',
    });

    expect(board.get('ses_generation')).toMatchObject({
      generation: second.generation,
      state: 'running',
      resultSummary: undefined,
    });
    expect(listener).not.toHaveBeenCalled();

    board.updateStatus({
      taskID: 'ses_generation',
      state: 'completed',
      expectedGeneration: second.generation,
      resultSummary: 'G2 result',
    });
    expect(board.get('ses_generation')).toMatchObject({
      generation: second.generation,
      state: 'completed',
      resultSummary: 'G2 result',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('keeps timeout status running with timedOut overlay', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement parser',
    });

    board.updateStatus({
      taskID: 'ses_1',
      state: 'running',
      timedOut: true,
    });

    expect(board.get('ses_1')).toMatchObject({
      state: 'running',
      timedOut: true,
      terminalUnreconciled: false,
    });
  });

  test('resets timeout convergence when a timed out job completes', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement parser',
    });

    board.updateStatus({
      taskID: 'ses_1',
      state: 'running',
      timedOut: true,
    });
    board.updateStatus({
      taskID: 'ses_1',
      state: 'running',
      timedOut: true,
    });

    const completed = board.updateStatus({
      taskID: 'ses_1',
      state: 'completed',
      timedOut: true,
    });

    // P3c: the write-only timeout/error counters (timeoutCount, totalErrors,
    // lastErrorAt) are gone. What remains pinned: repeated timed-out
    // running observations then a completed publication still land the row
    // terminal exactly once (terminalRevision 1) with the terminal evidence.
    expect(completed).toMatchObject({
      state: 'completed',
      timedOut: true,
      terminalRevision: 1,
    });
  });

  test('marks terminal jobs as reconciled and hides them from prompt', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });
    board.markReconciled('ses_1', 300);

    expect(board.get('ses_1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
      updatedAt: 300,
    });
    expect(board.resolveReusable('parent-1', 'ses_1', 'oracle')).toBeDefined();
  });

  test('lists acknowledged stopped sessions as retained recovery, not reusable', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_stopped',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'idle review',
      now: 100,
    });
    board.markStopped('ses_stopped', 'no native result', 110, undefined, 110);

    expect(board.get('ses_stopped')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
    });
    expect(
      board.resolveReusable('parent-1', 'ses_stopped', 'oracle'),
    ).toBeUndefined();

    board.markReconciled('ses_stopped');

    // An acknowledged stopped session is retained for recovery, never
    // reusable: the machine board keeps it out of the reusable pool.
    expect(board.get('ses_stopped')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: false,
    });
    expect(
      board.resolveReusable('parent-1', 'ses_stopped', 'oracle'),
    ).toBeUndefined();
  });

  test('trimRetained evicts acknowledged stopped sessions beyond the per-agent cap', () => {
    const board = new BackgroundJobBoard({ maxReusablePerAgent: 1 });
    board.registerLaunch({
      taskID: 'ses_old',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      now: 100,
    });
    board.markStopped('ses_old', 'no native result', 110, undefined, 110);
    board.markReconciled('ses_old', 120);

    board.registerLaunch({
      taskID: 'ses_new',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      now: 200,
    });
    board.markStopped('ses_new', 'no native result', 210, undefined, 210);
    board.markReconciled('ses_new', 220);

    expect(board.get('ses_old')).toBeUndefined();
    expect(board.get('ses_new')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: false,
    });
  });

  test('releaseLease re-applies retention caps shielded by an in-flight lease', () => {
    // P2 regression: an ACK landing while a revive holds the relaunch
    // lease shields retained-stopped entries from trimRetained. When the
    // revive fails and releases the lease, the per-agent cap must be
    // re-applied — evicting the oldest acknowledged stopped entry that
    // was shielded while the lease was live.
    const board = new BackgroundJobBoard({ maxReusablePerAgent: 1 });
    board.registerLaunch({
      taskID: 'ses_a',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      now: 100,
    });
    board.markStopped('ses_a', 'no native result', 110, undefined, 110);
    board.markReconciled('ses_a', 120);

    // ses_a holds a relaunch lease (revive in flight).
    const lease = board.acquireLease('ses_a', 1, 'relaunch');
    expect(lease).toBeDefined();

    board.registerLaunch({
      taskID: 'ses_b',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      now: 200,
    });
    board.markStopped('ses_b', 'no native result', 210, undefined, 210);
    // ACK of ses_b while ses_a is leased: the shielded ses_a survives the
    // per-agent cap of 1 because leased entries are excluded.
    board.markReconciled('ses_b', 220);
    expect(board.get('ses_a')).toBeDefined();
    expect(board.get('ses_b')).toBeDefined();

    // Releasing the lease re-applies the cap without the shield: the
    // oldest retained entry (ses_a) is evicted.
    if (lease) expect(board.releaseLease(lease)).toBe(true);
    expect(board.get('ses_a')).toBeUndefined();
    expect(board.get('ses_b')).toMatchObject({ state: 'stopped' });
  });

  test.each([
    ['reusable count', 0],
    ['context', 20],
  ])(
    'a relaunch-leased record survives the %s cap through its ack and relaunch',
    (_, lineCount) => {
      const board = new BackgroundJobBoard({
        maxReusablePerAgent: 1,
        maxContextLines: 10,
      });
      const completed = (taskID: string, completedAt: number) =>
        board.restoreRetainedSession({
          taskID,
          parentSessionID: 'parent-1',
          agent: 'oracle',
          description: taskID,
          state: 'completed',
          background: true,
          resultSummary: 'done',
          launchedAt: completedAt - 10,
          completedAt,
        });
      const a = completed('ses_a', 100);
      board.addContext('ses_a', [{ path: 'a.ts', lineCount, lastReadAt: 1 }]);
      const lease = a && board.acquireLease('ses_a', a.generation, 'relaunch');
      // While A's revive is admitted, B completes and is acknowledged later.
      completed('ses_b', 200);
      board.markReconciled('ses_b', 220);
      // The host accepted A: acknowledge its old round, then relaunch it.
      board.markReconciled('ses_a', 150, a?.generation);
      expect(
        board.registerLaunch({
          taskID: 'ses_a',
          parentSessionID: 'parent-1',
          agent: 'oracle',
          relaunchLease: lease,
          now: 150,
        }),
      ).toMatchObject({ taskID: 'ses_a', state: 'running' });
    },
  );

  test('reuses cancelled and errored jobs only after terminal acknowledgement', () => {
    const board = new BackgroundJobBoard();

    for (const [taskID, state] of [
      ['ses_cancelled', 'cancelled'],
      ['ses_error', 'error'],
    ] as const) {
      board.registerLaunch({
        taskID,
        parentSessionID: 'parent-1',
        agent: 'oracle',
        description: `${state} review`,
      });
      board.updateStatus({ taskID, state });

      expect(board.get(taskID)).toMatchObject({
        state,
        terminalUnreconciled: true,
      });
      expect(
        board.resolveReusable('parent-1', taskID, 'oracle'),
      ).toBeUndefined();

      board.markReconciled(taskID);

      expect(board.resolveReusable('parent-1', taskID, 'oracle')).toMatchObject(
        {
          taskID,
          state: 'reconciled',
          terminalState: state,
          terminalUnreconciled: false,
        },
      );
    }

    expect(board.listReusable('parent-1').map((job) => job.taskID)).toEqual(
      expect.arrayContaining(['ses_cancelled', 'ses_error']),
    );
  });

  test('does not reuse an acknowledged terminal job with uncertain status', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_uncertain',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    // The markStatusUncertain overlay alone (a read that cannot confirm the
    // state) is what blocks reuse; an acknowledged terminal with a confirmed
    // state stays reusable.
    board.markStatusUncertain('ses_uncertain', 'status unavailable');
    expect(board.get('ses_uncertain')?.statusUncertain).toBe(true);
    expect(board.resolveReusable('parent-1', 'ses_uncertain')).toBeUndefined();

    const committed = boardFixture.updateStatus(board, {
      taskID: 'ses_uncertain',
      state: 'error',
      resultSummary: 'status unavailable',
    });
    board.markReconciled('ses_uncertain');
    expect(committed).toMatchObject({ state: 'error', statusUncertain: false });
    expect(board.get('ses_uncertain')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
      statusUncertain: false,
    });
    expect(board.resolveReusable('parent-1', 'ses_uncertain')).toBeDefined();
  });

  test('stale generations cannot alter a newer relaunch after terminal acknowledgement', () => {
    const board = new BackgroundJobBoard();
    const first = board.registerLaunch({
      taskID: 'ses_generation_terminal',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    board.updateStatus({
      taskID: first.taskID,
      state: 'error',
      expectedGeneration: first.generation,
    });
    board.markReconciled(first.taskID);

    const relaunchLease = board.acquireLease(
      first.taskID,
      first.generation,
      'relaunch',
    );
    expect(relaunchLease).toBeDefined();
    if (!relaunchLease) throw new Error('relaunch lease was not acquired');
    const second = board.registerLaunch({
      taskID: first.taskID,
      parentSessionID: first.parentSessionID,
      agent: first.agent,
      relaunchLease,
    });

    const stale = board.updateStatus({
      taskID: first.taskID,
      state: 'cancelled',
      expectedGeneration: first.generation,
    });

    expect(stale).toMatchObject({
      generation: second.generation,
      state: 'running',
      terminalUnreconciled: false,
    });
    expect(board.get(first.taskID)?.generation).toBe(second.generation);
  });

  test('does not reconcile running jobs', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'still running',
    });

    expect(board.markReconciled('ses_1')).toBeUndefined();
    expect(board.get('ses_1')).toMatchObject({ state: 'running' });
  });

  test('resets terminal state when an existing task id is relaunched', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'first run',
      now: 100,
    });
    board.updateStatus({
      taskID: 'ses_1',
      state: 'completed',
      resultSummary: 'old result',
      now: 200,
    });

    const relaunched = board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'second run',
      now: 300,
    });

    expect(relaunched).toMatchObject({
      state: 'running',
      timedOut: false,
      terminalUnreconciled: false,
      completedAt: undefined,
      resultSummary: undefined,
      launchedAt: 100,
      lastLaunchedAt: 300,
      updatedAt: 300,
    });
  });

  test('updateStatus refuses terminal state without a gate commit', () => {
    const board = new ProductionBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map files',
    });

    board.updateStatus({
      taskID: 'ses_1',
      state: 'error',
      resultSummary: 'failed',
    });

    expect(board.get('ses_1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
    expect(board.get('ses_1')?.resultSummary).toBeUndefined();
  });

  test('an empty completed label cannot publish an error either', () => {
    const board = new ProductionBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map files',
    });

    board.updateStatus({
      taskID: 'ses_1',
      state: 'completed',
      resultSummary: '',
    });

    expect(board.get('ses_1')).toMatchObject({
      state: 'running',
    });
    expect(board.get('ses_1')?.resultSummary).toBeUndefined();
  });

  test('cancellation text cannot bypass the gate', () => {
    const board = new ProductionBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map files',
    });

    board.updateStatus({
      taskID: 'ses_1',
      state: 'cancelled',
      resultSummary: 'cancelled by user',
    });

    expect(board.get('ses_1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
    expect(board.get('ses_1')?.resultSummary).toBeUndefined();
  });

  test('resolves task IDs and aliases within parent scope', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.registerLaunch({
      taskID: 'ses_2',
      parentSessionID: 'parent-2',
      agent: 'explorer',
    });

    expect(board.resolve('parent-1', 'ses_1')?.taskID).toBe('ses_1');
    expect(board.resolve('parent-1', 'exp-1')?.taskID).toBe('ses_1');
    expect(board.resolve('parent-2', 'exp-1')?.taskID).toBe('ses_2');
    expect(board.resolve('parent-1', 'ses_2')).toBeUndefined();
  });

  test('marks running jobs as cancelled and unreconciled', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 100,
    });

    const cancelled = board.markCancelled('ses_1', 'obsolete lane', 200);

    expect(cancelled).toMatchObject({
      state: 'cancelled',
      timedOut: false,
      terminalUnreconciled: true,
      completedAt: 200,
      resultSummary: 'cancelled: obsolete lane',
    });
    expect(board.hasTerminalUnreconciled('parent-1')).toBe(true);
  });

  test('markCancelled does not mutate already terminal jobs', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    board.updateStatus({
      taskID: 'ses_1',
      state: 'completed',
      resultSummary: 'done',
    });

    board.markCancelled('ses_1', 'too late');

    expect(board.get('ses_1')).toMatchObject({
      state: 'completed',
      resultSummary: 'done',
    });
  });

  test('stale running status cannot reopen terminal jobs', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    board.markCancelled('ses_1', 'obsolete');

    board.updateStatus({
      taskID: 'ses_1',
      state: 'running',
      timedOut: true,
    });

    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      terminalUnreconciled: true,
      timedOut: false,
    });
  });

  test('preserveRun terminal promotion re-fires the suppressed recovery wake', () => {
    const board = new BackgroundJobBoard();
    const listener = mock(() => {});
    board.addTerminalOutcomeListener((record) => listener(record.taskID));
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'unattributed oracle task',
      provisional: true,
      now: 100,
    });
    board.markStopped('child-1', 'no outcome', 200);
    const stops = listener.mock.calls.length;
    expect(stops).toBeGreaterThan(0);

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'unattributed oracle task',
      preserveRun: true,
      now: 300,
    });

    expect(listener).toHaveBeenLastCalledWith('child-1');
    expect(listener.mock.calls.length).toBe(stops + 1);
  });

  test('promoteProvisional re-fires the wake for a terminal placeholder and stays silent for a running one', () => {
    const board = new BackgroundJobBoard();
    const listener = mock(() => {});
    board.addTerminalOutcomeListener((record) => listener(record.taskID));
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      provisional: true,
      now: 100,
    });
    board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      provisional: true,
      now: 100,
    });
    board.markStopped('child-1', 'no outcome', 200);
    const stops = listener.mock.calls.length;

    board.promoteProvisional('child-1', 'parent-1');
    expect(listener.mock.calls.length).toBe(stops + 1);
    expect(listener).toHaveBeenLastCalledWith('child-1');

    board.promoteProvisional('child-2', 'parent-1');
    expect(listener.mock.calls.length).toBe(stops + 1);
  });

  test('promoteProvisional paints the owning call metadata', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      provisional: true,
      now: 100,
    });

    const promoted = board.promoteProvisional('child-1', 'parent-1', {
      agent: 'explorer',
      description: 'owned call',
      objective: 'full objective text',
      background: true,
    });

    expect(promoted?.provisional).toBe(false);
    expect(promoted?.agent).toBe('explorer');
    expect(promoted?.description).toBe('owned call');
    expect(promoted?.objective).toBe('full objective text');
    expect(promoted?.background).toBe(true);
  });

  test('notifies terminal listener on updateStatus terminal transition', () => {
    const board = new BackgroundJobBoard();
    const listener = mock(() => {});
    board.addTerminalOutcomeListener((record) => listener(record.taskID));
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });

    board.updateStatus({ taskID: 'ses_1', state: 'completed' });

    expect(listener).toHaveBeenCalledWith('ses_1');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('notifies terminal listener on markCancelled mutation', () => {
    const board = new BackgroundJobBoard();
    const listener = mock(() => {});
    board.addTerminalOutcomeListener((record) => listener(record.taskID));
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });

    board.markCancelled('ses_1');

    expect(listener).toHaveBeenCalledWith('ses_1');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('notifies terminal listener on forced markCancelled from running', () => {
    const board = new BackgroundJobBoard();
    const listener = mock(() => {});
    board.addTerminalOutcomeListener((record) => listener(record.taskID));
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });

    board.markCancelled('ses_1', 'user requested', Date.now(), {
      force: true,
    });

    expect(listener).toHaveBeenCalledWith('ses_1');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('does not force-cancel a newer generation or notify terminal listeners', () => {
    const board = new BackgroundJobBoard();
    const listener = mock(() => {});
    board.addTerminalOutcomeListener((record) => listener(record.taskID));
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });
    listener.mockClear();
    const relaunched = board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });

    const result = board.markCancelled(
      'ses_1',
      'stale cancellation',
      Date.now(),
      { force: true, expectedGeneration: relaunched.generation - 1 },
    );

    expect(result).toMatchObject({
      generation: relaunched.generation,
      state: 'running',
      cancellationRequested: false,
    });
    expect(board.get('ses_1')).toMatchObject({
      generation: relaunched.generation,
      state: 'running',
      terminalUnreconciled: false,
    });
    expect(listener).not.toHaveBeenCalled();
  });

  test('does not notify terminal listener on forced markCancelled from terminal', () => {
    const board = new BackgroundJobBoard();
    const listener = mock(() => {});
    board.addTerminalOutcomeListener((record) => listener(record.taskID));
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });
    listener.mockClear();

    board.markCancelled('ses_1', 'user requested', Date.now(), {
      force: true,
    });

    expect(listener).not.toHaveBeenCalled();
  });

  test('does not notify terminal listener for running or stale updates', () => {
    const board = new BackgroundJobBoard();
    const listener = mock(() => {});
    board.addTerminalOutcomeListener((record) => listener(record.taskID));
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });

    board.updateStatus({ taskID: 'ses_1', state: 'running' });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });
    listener.mockClear();
    board.updateStatus({ taskID: 'ses_1', state: 'running' });
    board.markCancelled('ses_1');

    expect(listener).not.toHaveBeenCalled();
  });

  test('a throwing terminal publication handler is contained', () => {
    const board = new BackgroundJobBoard();
    board.addTerminalOutcomeListener(() => {
      throw new Error('publication handler failed');
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });

    expect(() =>
      board.updateStatus({ taskID: 'ses_1', state: 'completed' }),
    ).not.toThrow();
    expect(board.get('ses_1')).toMatchObject({ state: 'completed' });
  });

  test('cancelled jobs ignore late non-cancelled terminal statuses', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    board.markCancelled('ses_1', 'user requested');

    board.updateStatus({
      taskID: 'ses_1',
      state: 'error',
      resultSummary: 'request cancelled upstream',
    });
    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      resultSummary: 'cancelled: user requested',
    });

    board.updateStatus({
      taskID: 'ses_1',
      state: 'completed',
      resultSummary: 'late completion',
    });
    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      resultSummary: 'cancelled: user requested',
    });
  });

  test('confirmed live busy retracts a cancelled publication', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({
      taskID: 'ses_1',
      state: 'cancelled',
      resultSummary: 'upstream cancelled during compaction',
      now: 100,
    });

    const updated = board.markRunningFromLiveSession('ses_1', 200);

    expect(updated).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
      lastLiveBusyAt: 200,
      terminalRevision: 2,
    });
    expect(updated?.completedAt).toBeUndefined();
    expect(updated?.terminalState).toBeUndefined();
    expect(updated?.resultSummary).toBeUndefined();
  });

  test('live busy reopens cancellation while preserving its intent', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    board.markCancelled('ses_1', 'user requested', 100);

    const updated = board.markRunningFromLiveSession('ses_1', 200);

    expect(updated).toMatchObject({
      state: 'running',
      cancellationRequested: true,
      terminalUnreconciled: false,
    });
  });

  test('live busy retracts even reconciled cancellation publications', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'cancelled', now: 100 });
    board.markReconciled('ses_1', 150);

    const updated = board.markRunningFromLiveSession('ses_1', 200);

    expect(updated).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
      terminalState: undefined,
      lastLiveBusyAt: 200,
    });
  });

  test('live busy clears pending stop confirmation', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 100,
    });
    const updated = board.markRunningFromLiveSession('ses_1', 200);

    expect(updated).toMatchObject({
      state: 'running',
      lastLiveBusyAt: 200,
    });
  });

  test('old busy leaves an acknowledged stopped publication unchanged', () => {
    const board = new BackgroundJobBoard();
    const run = board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 100,
    });
    board.markStopped(run.taskID, 'no result', 150, run.generation, 150);
    board.markReconciled(run.taskID, 160);
    const acknowledged = board.get(run.taskID);
    expect(
      board.markRunningFromLiveSession(run.taskID, 150, run.generation),
    ).toEqual({ ...acknowledged, lastLiveBusyAt: 150 });
    expect(board.get(run.taskID)).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: false,
    });
  });

  test('new busy reopens an acknowledged stopped publication', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 100,
    });
    const generation = board.get('ses_1')?.generation;
    board.markStopped('ses_1', 'no result', 150, generation, 150);
    board.markReconciled('ses_1', 160);

    const updated = board.markRunningFromLiveSession('ses_1', 200, generation);

    expect(updated).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
      lastLiveBusyAt: 200,
    });
  });

  test('stale busy at the stop timestamp does not revive an unreconciled stopped job', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 100,
    });
    const generation = board.get('ses_1')?.generation;
    board.markStopped('ses_1', 'no result', 150, generation, 150);

    const stale = board.markRunningFromLiveSession('ses_1', 150, generation);
    expect(stale).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
      lastLiveBusyAt: 150,
    });

    const later = board.markRunningFromLiveSession('ses_1', 151, generation);
    expect(later).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
  });

  test('relaunch lease retains exclusion but cannot hide live activity', () => {
    // The lease excludes competing operations, not observed host activity.
    // Revive must notice the activity and refuse while the board shows running.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 100,
    });
    const generation = board.get('ses_1')?.generation;
    board.markStopped('ses_1', 'no result', 150, generation, 150);

    const lease = board.acquireLease('ses_1', generation ?? 1, 'relaunch');
    expect(lease).toBeDefined();

    const leased = board.markRunningFromLiveSession('ses_1', 200, generation);
    expect(leased).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
      lastLiveBusyAt: 200,
    });
    expect(
      board.acquireLease('ses_1', generation ?? 1, 'relaunch'),
    ).toBeUndefined();
    if (lease) expect(board.validateLease(lease)).toBe(true);

    if (lease) board.releaseLease(lease);

    const revived = board.markRunningFromLiveSession('ses_1', 201, generation);
    expect(revived).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
  });

  test('live busy retracts a completed publication', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed', now: 100 });

    const updated = board.markRunningFromLiveSession('ses_1', 200);

    expect(updated).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
      terminalState: undefined,
      lastLiveBusyAt: 200,
    });
    expect(updated?.completedAt).toBeUndefined();
  });

  test('live busy recovery clears timeout state on running jobs', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      now: 100,
    });
    board.updateStatus({
      taskID: 'ses_1',
      state: 'running',
      timedOut: true,
      statusUncertain: true,
      now: 150,
    });

    const updated = board.markRunningFromLiveSession('ses_1', 200);

    expect(updated).toMatchObject({
      state: 'running',
      timedOut: false,
      recoverableAfterLiveBusy: true,
      statusUncertain: false,
      lastLiveBusyAt: 200,
      updatedAt: 200,
      alias: 'exp-1',
    });
  });

  test('resolves timed-out running jobs only after live busy recovery', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({
      taskID: 'ses_1',
      state: 'running',
      timedOut: true,
    });

    expect(
      board.resolveReusable('parent-1', 'exp-1', 'explorer'),
    ).toBeUndefined();
    expect(
      board.resolveRecoverable('parent-1', 'exp-1', 'explorer'),
    ).toBeUndefined();

    board.markRunningFromLiveSession('ses_1', 200);

    expect(
      board.resolveRecoverable('parent-1', 'exp-1', 'explorer'),
    ).toMatchObject({
      taskID: 'ses_1',
      state: 'running',
      timedOut: false,
      recoverableAfterLiveBusy: true,
      lastLiveBusyAt: 200,
    });
    expect(
      board.resolveRecoverable('parent-1', 'exp-1', 'oracle'),
    ).toBeUndefined();
  });

  test('stale status updates cannot reopen already reconciled jobs', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });
    board.markReconciled('ses_1', 300);

    // Stale status updates should not reopen the reconciled job
    const staleCompleted = board.updateStatus({
      taskID: 'ses_1',
      state: 'completed',
      resultSummary: 'stale result',
    });
    expect(staleCompleted).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });

    const staleError = board.updateStatus({
      taskID: 'ses_1',
      state: 'error',
      resultSummary: 'stale error',
    });
    expect(staleError).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });

    const staleCancelled = board.updateStatus({
      taskID: 'ses_1',
      state: 'cancelled',
    });
    expect(staleCancelled).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });

    expect(board.resolveReusable('parent-1', 'ses_1', 'oracle')).toBeDefined();
  });

  test('registerLaunch can reset a reconciled job to running', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
      now: 100,
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });
    board.markReconciled('ses_1', 300);

    // Relaunch should reset the reconciled job to running
    const relaunched = board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan again',
      now: 400,
    });

    expect(relaunched).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
      completedAt: undefined,
      resultSummary: undefined,
      updatedAt: 400,
    });
  });

  describe('intent-revealing query methods', () => {
    test('isRunning: true for running jobs, false for terminal/reconciled/unknown', () => {
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'running-1',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        now: 100,
      });
      board.registerLaunch({
        taskID: 'terminal-1',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        now: 100,
      });
      board.updateStatus({
        taskID: 'terminal-1',
        state: 'completed',
        now: 200,
      });
      board.markReconciled('terminal-1', 300);

      expect(board.isRunning('running-1')).toBe(true);
      expect(board.isRunning('terminal-1')).toBe(false);
      expect(board.isRunning('unknown-1')).toBe(false);
    });

    test('isTerminalUnreconciled: true after updateStatus to terminal, false after markReconciled', () => {
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'job-1',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        now: 100,
      });

      expect(board.isTerminalUnreconciled('job-1')).toBe(false);
      board.updateStatus({ taskID: 'job-1', state: 'completed', now: 200 });
      expect(board.isTerminalUnreconciled('job-1')).toBe(true);
      board.markReconciled('job-1', 300);
      expect(board.isTerminalUnreconciled('job-1')).toBe(false);
      expect(board.isTerminalUnreconciled('unknown-1')).toBe(false);
    });

    test('getResultSummary: returns summary after updateStatus with result', () => {
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'job-1',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        now: 100,
      });
      board.updateStatus({
        taskID: 'job-1',
        state: 'completed',
        resultSummary: 'all good',
        now: 200,
      });

      expect(board.getResultSummary('job-1')).toBe('all good');
      expect(board.getResultSummary('unknown-1')).toBeUndefined();
    });

    test('getParentSessionID: returns parentSessionID after registerLaunch', () => {
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'job-1',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        now: 100,
      });

      expect(board.getParentSessionID('job-1')).toBe('parent-1');
      expect(board.getParentSessionID('unknown-1')).toBeUndefined();
    });

    test('getState: returns state after mutation, undefined for unknown taskID', () => {
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'job-1',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        now: 100,
      });

      expect(board.getState('job-1')).toBe('running');
      board.updateStatus({ taskID: 'job-1', state: 'completed', now: 200 });
      expect(board.getState('job-1')).toBe('completed');
      expect(board.getState('unknown-1')).toBeUndefined();
    });

    test('field<K>: returns specific field for valid taskID, undefined for unknown', () => {
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'job-1',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        now: 100,
      });

      expect(board.field('job-1', 'alias')).toBe('ora-1');
      expect(board.field('job-1', 'parentSessionID')).toBe('parent-1');
      expect(board.field('unknown-1', 'alias')).toBeUndefined();
    });
  });

  describe('sidebarHistoryByParentAgent', () => {
    function sidebarHistory(board: BackgroundJobBoard, parent: string) {
      return board.sidebarHistoryByParentAgent().get(parent) ?? new Map();
    }

    /** Seed one oracle job and walk it to reconciled with controlled clocks. */
    function seedReconciled(
      board: BackgroundJobBoard,
      taskID: string,
      opts: {
        parent?: string;
        agent?: string;
        launchAt?: number;
        completedAt?: number;
        reconciledAt?: number;
        state?: 'completed' | 'error' | 'cancelled';
      } = {},
    ) {
      const parent = opts.parent ?? 'parent-1';
      const agent = opts.agent ?? 'oracle';
      const launchAt = opts.launchAt ?? 100;
      board.registerLaunch({
        taskID,
        parentSessionID: parent,
        agent,
        description: `${taskID} job`,
        now: launchAt,
      });
      board.updateStatus({
        taskID,
        state: opts.state ?? 'completed',
        resultSummary: 'done',
        now: opts.completedAt ?? launchAt + 100,
      });
      board.markReconciled(taskID, opts.reconciledAt ?? launchAt + 200);
    }

    test('selects max lastUsedAt per agent across four reconciled sessions', () => {
      // Cap 4: every seeded session stays accessible, so the assertion
      // exercises selection, not LRU eviction (covered separately).
      const board = new BackgroundJobBoard({ maxReusablePerAgent: 4 });
      seedReconciled(board, 'ses_a', { launchAt: 100, reconciledAt: 300 });
      seedReconciled(board, 'ses_b', { launchAt: 400, reconciledAt: 600 });
      seedReconciled(board, 'ses_c', { launchAt: 700, reconciledAt: 900 });
      seedReconciled(board, 'ses_d', { launchAt: 1000, reconciledAt: 1200 });
      expect(sidebarHistory(board, 'parent-1').get('oracle')?.[0]?.taskID).toBe(
        'ses_d',
      );

      // ses_a becomes the most recently used despite being oldest-launched.
      board.markUsed('parent-1', 'ses_a', 5000);

      const latest = sidebarHistory(board, 'parent-1');
      expect(latest.get('oracle')?.[0]).toMatchObject({
        taskID: 'ses_a',
        terminalState: 'completed',
      });
      expect(latest.get('oracle')?.map((entry) => entry.taskID)).toEqual([
        'ses_a',
        'ses_d',
        'ses_c',
        'ses_b',
      ]);
    });

    test('excludes unattributed placeholders even after acknowledgement', () => {
      const board = new BackgroundJobBoard({ maxReusablePerAgent: 4 });
      board.registerLaunch({
        taskID: 'ses_placeholder',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        provisional: true,
        now: 100,
      });
      board.updateStatus({
        taskID: 'ses_placeholder',
        state: 'completed',
        now: 200,
      });
      board.markReconciled('ses_placeholder', 300);

      // Same exclusion as the prompt's reusable section: the sidebar dot
      // must not advertise a placeholder nobody attributed.
      expect(sidebarHistory(board, 'parent-1').has('oracle')).toBe(false);

      // An attributed sibling still selects normally.
      seedReconciled(board, 'ses_attributed', { launchAt: 400 });
      expect(sidebarHistory(board, 'parent-1').get('oracle')?.[0]?.taskID).toBe(
        'ses_attributed',
      );
    });

    test('includes a finished session before the parent acknowledges it', () => {
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'ses_done',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        now: 100,
      });
      board.updateStatus({
        taskID: 'ses_done',
        state: 'completed',
        now: 200,
      });

      expect(sidebarHistory(board, 'parent-1').get('oracle')?.[0]?.taskID).toBe(
        'ses_done',
      );
    });

    test('includes both stopped phases but excludes running, uncertain, and provisional jobs', () => {
      const board = new BackgroundJobBoard();
      seedReconciled(board, 'ses_ok');

      board.registerLaunch({
        taskID: 'ses_running',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        now: 100,
      });

      board.registerLaunch({
        taskID: 'ses_uncertain',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        now: 100,
      });
      board.markStatusUncertain('ses_uncertain', 'status unavailable', 150);
      board.markReconciled('ses_uncertain', 300);

      board.registerLaunch({
        taskID: 'ses_stopped',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        now: 100,
      });
      board.markStopped('ses_stopped', 'no native result', 110, undefined, 110);
      board.registerLaunch({
        taskID: 'ses_provisional',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        provisional: true,
        now: 100,
      });
      board.markStopped(
        'ses_provisional',
        'no native result',
        110,
        undefined,
        110,
      );

      expect(
        sidebarHistory(board, 'parent-1')
          .get('oracle')
          ?.map((entry) => [entry.taskID, entry.terminalState]),
      ).toEqual([
        ['ses_ok', 'completed'],
        ['ses_stopped', 'stopped'],
      ]);
      board.markReconciled('ses_stopped', 300);

      const latest = sidebarHistory(board, 'parent-1');
      expect(
        latest
          .get('oracle')
          ?.map((entry) => [entry.taskID, entry.terminalState]),
      ).toEqual([
        ['ses_stopped', 'stopped'],
        ['ses_ok', 'completed'],
      ]);
      expect(new Set(latest.keys())).toEqual(new Set(['oracle']));
    });

    test('covers every reconciled terminal state: completed, error, cancelled', () => {
      const board = new BackgroundJobBoard();
      seedReconciled(board, 'ses_done', {
        agent: 'explorer',
        state: 'completed',
      });
      seedReconciled(board, 'ses_err', { agent: 'fixer', state: 'error' });
      seedReconciled(board, 'ses_cancel', {
        agent: 'designer',
        state: 'cancelled',
      });

      const latest = sidebarHistory(board, 'parent-1');
      expect(latest.get('explorer')?.[0]?.terminalState).toBe('completed');
      expect(latest.get('fixer')?.[0]?.terminalState).toBe('error');
      expect(latest.get('designer')?.[0]?.terminalState).toBe('cancelled');
    });

    test('markUsed on an older session moves the selection (user override)', () => {
      const board = new BackgroundJobBoard();
      seedReconciled(board, 'ses_old', { launchAt: 100, reconciledAt: 300 });
      seedReconciled(board, 'ses_new', { launchAt: 400, reconciledAt: 600 });

      expect(sidebarHistory(board, 'parent-1').get('oracle')?.[0]?.taskID).toBe(
        'ses_new',
      );

      // Explicit reuse of the old session must win the dot.
      board.markUsed('parent-1', 'ses_old', 5000);
      expect(sidebarHistory(board, 'parent-1').get('oracle')?.[0]?.taskID).toBe(
        'ses_old',
      );
    });

    test('LRU trim beyond maxReusablePerAgent evicts the oldest and keeps the selection correct', () => {
      const board = new BackgroundJobBoard({ maxReusablePerAgent: 2 });
      seedReconciled(board, 'ses_1', { launchAt: 100, reconciledAt: 300 });
      seedReconciled(board, 'ses_2', { launchAt: 400, reconciledAt: 600 });
      seedReconciled(board, 'ses_3', { launchAt: 700, reconciledAt: 900 });

      // The oldest was evicted by the count cap; selection falls to the
      // newest survivor.
      expect(board.get('ses_1')).toBeUndefined();
      const latest = sidebarHistory(board, 'parent-1');
      expect(latest.get('oracle')?.[0]?.taskID).toBe('ses_3');
    });

    test('relaunch of the selected session (no preserveRun) falls back to the previous reconciled', () => {
      const board = new BackgroundJobBoard();
      seedReconciled(board, 'ses_first', { launchAt: 100, reconciledAt: 300 });
      seedReconciled(board, 'ses_second', { launchAt: 400, reconciledAt: 600 });
      expect(sidebarHistory(board, 'parent-1').get('oracle')?.[0]?.taskID).toBe(
        'ses_second',
      );

      const lease = board.acquireLease(
        'ses_second',
        board.get('ses_second')?.generation ?? -1,
        'relaunch',
      );
      expect(lease).toBeDefined();
      board.registerLaunch({
        taskID: 'ses_second',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        relaunchLease: lease,
        now: 1000,
      });

      // The relaunched job is running again — only the older reconciled
      // session remains a dot target.
      const latest = sidebarHistory(board, 'parent-1');
      expect(latest.get('oracle')?.[0]?.taskID).toBe('ses_first');
    });

    test('scopes by parentSessionID; drop and clearParent empty the projection', () => {
      const board = new BackgroundJobBoard();
      seedReconciled(board, 'ses_mine', { parent: 'parent-1' });
      seedReconciled(board, 'ses_other', { parent: 'parent-2' });

      expect(sidebarHistory(board, 'parent-1').get('oracle')?.[0]?.taskID).toBe(
        'ses_mine',
      );
      expect(sidebarHistory(board, 'parent-2').get('oracle')?.[0]?.taskID).toBe(
        'ses_other',
      );
      expect(sidebarHistory(board, 'parent-3').size).toBe(0);

      board.drop('ses_mine');
      expect(sidebarHistory(board, 'parent-1').size).toBe(0);

      board.clearParent('parent-2');
      expect(sidebarHistory(board, 'parent-2').size).toBe(0);
    });

    test('mutation listener fires on launch, trim, and drop', () => {
      const board = new BackgroundJobBoard({ maxReusablePerAgent: 1 });
      let calls = 0;
      board.addMutationListener(() => {
        calls += 1;
      });

      seedReconciled(board, 'ses_1', { launchAt: 100, reconciledAt: 300 });
      const afterFirst = calls;
      expect(afterFirst).toBeGreaterThan(0);

      // Second reconciled session trims the first (count cap 1).
      seedReconciled(board, 'ses_2', { launchAt: 400, reconciledAt: 600 });
      const afterTrim = calls;
      expect(afterTrim).toBeGreaterThan(afterFirst);

      board.drop('ses_2');
      expect(calls).toBeGreaterThan(afterTrim);

      board.removeMutationListener(() => {});
      expect(calls).toBeGreaterThan(0);
    });

    test('sidebarHistoryByParentAgent never mutates lastUsedAt (read-only)', () => {
      const board = new BackgroundJobBoard();
      seedReconciled(board, 'ses_1', { launchAt: 100, reconciledAt: 300 });
      const before = board.get('ses_1')?.lastUsedAt;

      sidebarHistory(board, 'parent-1');

      expect(board.get('ses_1')?.lastUsedAt).toBe(before);
    });
  });

  describe('intent-revealing query methods', () => {
    test('isRunning: true for running jobs, false for terminal/reconciled/unknown', () => {
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'running-1',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        now: 100,
      });
      board.registerLaunch({
        taskID: 'terminal-1',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        now: 100,
      });
      board.updateStatus({
        taskID: 'terminal-1',
        state: 'completed',
        now: 200,
      });
      board.markReconciled('terminal-1', 300);

      expect(board.isRunning('running-1')).toBe(true);
      expect(board.isRunning('terminal-1')).toBe(false);
      expect(board.isRunning('unknown-1')).toBe(false);
    });

    test('isTerminalUnreconciled: true after updateStatus to terminal, false after markReconciled', () => {
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'job-1',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        now: 100,
      });

      expect(board.isTerminalUnreconciled('job-1')).toBe(false);
      board.updateStatus({ taskID: 'job-1', state: 'completed', now: 200 });
      expect(board.isTerminalUnreconciled('job-1')).toBe(true);
      board.markReconciled('job-1', 300);
      expect(board.isTerminalUnreconciled('job-1')).toBe(false);
      expect(board.isTerminalUnreconciled('unknown-1')).toBe(false);
    });

    test('getResultSummary: returns summary after updateStatus with result', () => {
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'job-1',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        now: 100,
      });
      board.updateStatus({
        taskID: 'job-1',
        state: 'completed',
        resultSummary: 'all good',
        now: 200,
      });

      expect(board.getResultSummary('job-1')).toBe('all good');
      expect(board.getResultSummary('unknown-1')).toBeUndefined();
    });

    test('getParentSessionID: returns parentSessionID after registerLaunch', () => {
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'job-1',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        now: 100,
      });

      expect(board.getParentSessionID('job-1')).toBe('parent-1');
      expect(board.getParentSessionID('unknown-1')).toBeUndefined();
    });

    test('getState: returns state after mutation, undefined for unknown taskID', () => {
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'job-1',
        parentSessionID: 'parent-1',
        agent: 'fixer',
        now: 100,
      });

      expect(board.getState('job-1')).toBe('running');
      board.updateStatus({ taskID: 'job-1', state: 'completed', now: 200 });
      expect(board.getState('job-1')).toBe('completed');
      expect(board.getState('unknown-1')).toBeUndefined();
    });

    test('field<K>: returns specific field for valid taskID, undefined for unknown', () => {
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'job-1',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        now: 100,
      });

      expect(board.field('job-1', 'alias')).toBe('ora-1');
      expect(board.field('job-1', 'parentSessionID')).toBe('parent-1');
      expect(board.field('unknown-1', 'alias')).toBeUndefined();
    });
  });

  describe('sidebarHistoryByParentAgent', () => {
    function sidebarHistory(board: BackgroundJobBoard, parent: string) {
      return board.sidebarHistoryByParentAgent().get(parent) ?? new Map();
    }

    /** Seed one oracle job and walk it to reconciled with controlled clocks. */
    function seedReconciled(
      board: BackgroundJobBoard,
      taskID: string,
      opts: {
        parent?: string;
        agent?: string;
        launchAt?: number;
        completedAt?: number;
        reconciledAt?: number;
        state?: 'completed' | 'error' | 'cancelled';
      } = {},
    ) {
      const parent = opts.parent ?? 'parent-1';
      const agent = opts.agent ?? 'oracle';
      const launchAt = opts.launchAt ?? 100;
      board.registerLaunch({
        taskID,
        parentSessionID: parent,
        agent,
        description: `${taskID} job`,
        now: launchAt,
      });
      board.updateStatus({
        taskID,
        state: opts.state ?? 'completed',
        resultSummary: 'done',
        now: opts.completedAt ?? launchAt + 100,
      });
      board.markReconciled(taskID, opts.reconciledAt ?? launchAt + 200);
    }

    test('selects max lastUsedAt per agent across four reconciled sessions', () => {
      // Cap 4: every seeded session stays accessible, so the assertion
      // exercises selection, not LRU eviction (covered separately).
      const board = new BackgroundJobBoard({ maxReusablePerAgent: 4 });
      seedReconciled(board, 'ses_a', { launchAt: 100, reconciledAt: 300 });
      seedReconciled(board, 'ses_b', { launchAt: 400, reconciledAt: 600 });
      seedReconciled(board, 'ses_c', { launchAt: 700, reconciledAt: 900 });
      seedReconciled(board, 'ses_d', { launchAt: 1000, reconciledAt: 1200 });
      expect(sidebarHistory(board, 'parent-1').get('oracle')?.[0]?.taskID).toBe(
        'ses_d',
      );

      // ses_a becomes the most recently used despite being oldest-launched.
      board.markUsed('parent-1', 'ses_a', 5000);

      const latest = sidebarHistory(board, 'parent-1');
      expect(latest.get('oracle')?.[0]).toMatchObject({
        taskID: 'ses_a',
        terminalState: 'completed',
      });
      expect(latest.get('oracle')?.map((entry) => entry.taskID)).toEqual([
        'ses_a',
        'ses_d',
        'ses_c',
        'ses_b',
      ]);
    });

    test('excludes unattributed placeholders even after acknowledgement', () => {
      const board = new BackgroundJobBoard({ maxReusablePerAgent: 4 });
      board.registerLaunch({
        taskID: 'ses_placeholder',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        provisional: true,
        now: 100,
      });
      board.updateStatus({
        taskID: 'ses_placeholder',
        state: 'completed',
        now: 200,
      });
      board.markReconciled('ses_placeholder', 300);

      // Same exclusion as the prompt's reusable section: the sidebar dot
      // must not advertise a placeholder nobody attributed.
      expect(sidebarHistory(board, 'parent-1').has('oracle')).toBe(false);

      // An attributed sibling still selects normally.
      seedReconciled(board, 'ses_attributed', { launchAt: 400 });
      expect(sidebarHistory(board, 'parent-1').get('oracle')?.[0]?.taskID).toBe(
        'ses_attributed',
      );
    });

    test('includes a finished session before the parent acknowledges it', () => {
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'ses_done',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        now: 100,
      });
      board.updateStatus({
        taskID: 'ses_done',
        state: 'completed',
        now: 200,
      });

      expect(sidebarHistory(board, 'parent-1').get('oracle')?.[0]?.taskID).toBe(
        'ses_done',
      );
    });

    test('includes both stopped phases but excludes running, uncertain, and provisional jobs', () => {
      const board = new BackgroundJobBoard();
      seedReconciled(board, 'ses_ok');

      board.registerLaunch({
        taskID: 'ses_running',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        now: 100,
      });

      board.registerLaunch({
        taskID: 'ses_uncertain',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        now: 100,
      });
      board.claimWallClockDeadline({
        taskID: 'ses_uncertain',
        generation: board.get('ses_uncertain')?.generation ?? -1,
        now: 150,
      });
      board.finalizeWallClockTimeout({
        taskID: 'ses_uncertain',
        generation: board.get('ses_uncertain')?.generation ?? -1,
        statusUncertain: true,
        resultSummary: 'status unavailable',
        now: 200,
      });
      board.markReconciled('ses_uncertain', 300);

      board.registerLaunch({
        taskID: 'ses_stopped',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        now: 100,
      });
      board.markStopped('ses_stopped', 'no native result', 110, undefined, 110);
      board.registerLaunch({
        taskID: 'ses_provisional',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        provisional: true,
        now: 100,
      });
      board.markStopped(
        'ses_provisional',
        'no native result',
        110,
        undefined,
        110,
      );

      expect(
        sidebarHistory(board, 'parent-1')
          .get('oracle')
          ?.map((entry) => [entry.taskID, entry.terminalState]),
      ).toEqual([
        ['ses_ok', 'completed'],
        ['ses_stopped', 'stopped'],
      ]);
      board.markReconciled('ses_stopped', 300);

      const latest = sidebarHistory(board, 'parent-1');
      expect(
        latest
          .get('oracle')
          ?.map((entry) => [entry.taskID, entry.terminalState]),
      ).toEqual([
        ['ses_stopped', 'stopped'],
        ['ses_ok', 'completed'],
      ]);
      expect(new Set(latest.keys())).toEqual(new Set(['oracle']));
    });

    test('covers every reconciled terminal state: completed, error, cancelled', () => {
      const board = new BackgroundJobBoard();
      seedReconciled(board, 'ses_done', {
        agent: 'explorer',
        state: 'completed',
      });
      seedReconciled(board, 'ses_err', { agent: 'fixer', state: 'error' });
      seedReconciled(board, 'ses_cancel', {
        agent: 'designer',
        state: 'cancelled',
      });

      const latest = sidebarHistory(board, 'parent-1');
      expect(latest.get('explorer')?.[0]?.terminalState).toBe('completed');
      expect(latest.get('fixer')?.[0]?.terminalState).toBe('error');
      expect(latest.get('designer')?.[0]?.terminalState).toBe('cancelled');
    });

    test('markUsed on an older session moves the selection (user override)', () => {
      const board = new BackgroundJobBoard();
      seedReconciled(board, 'ses_old', { launchAt: 100, reconciledAt: 300 });
      seedReconciled(board, 'ses_new', { launchAt: 400, reconciledAt: 600 });

      expect(sidebarHistory(board, 'parent-1').get('oracle')?.[0]?.taskID).toBe(
        'ses_new',
      );

      // Explicit reuse of the old session must win the dot.
      board.markUsed('parent-1', 'ses_old', 5000);
      expect(sidebarHistory(board, 'parent-1').get('oracle')?.[0]?.taskID).toBe(
        'ses_old',
      );
    });

    test('LRU trim beyond maxReusablePerAgent evicts the oldest and keeps the selection correct', () => {
      const board = new BackgroundJobBoard({ maxReusablePerAgent: 2 });
      seedReconciled(board, 'ses_1', { launchAt: 100, reconciledAt: 300 });
      seedReconciled(board, 'ses_2', { launchAt: 400, reconciledAt: 600 });
      seedReconciled(board, 'ses_3', { launchAt: 700, reconciledAt: 900 });

      // The oldest was evicted by the count cap; selection falls to the
      // newest survivor.
      expect(board.get('ses_1')).toBeUndefined();
      const latest = sidebarHistory(board, 'parent-1');
      expect(latest.get('oracle')?.[0]?.taskID).toBe('ses_3');
    });

    test('relaunch of the selected session (no preserveRun) falls back to the previous reconciled', () => {
      const board = new BackgroundJobBoard();
      seedReconciled(board, 'ses_first', { launchAt: 100, reconciledAt: 300 });
      seedReconciled(board, 'ses_second', { launchAt: 400, reconciledAt: 600 });
      expect(sidebarHistory(board, 'parent-1').get('oracle')?.[0]?.taskID).toBe(
        'ses_second',
      );

      const lease = board.acquireRelaunchLease(
        'ses_second',
        board.get('ses_second')?.generation ?? -1,
      );
      expect(lease).toBeDefined();
      board.registerLaunch({
        taskID: 'ses_second',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        relaunchLease: lease,
        now: 1000,
      });

      // The relaunched job is running again — only the older reconciled
      // session remains a dot target.
      const latest = sidebarHistory(board, 'parent-1');
      expect(latest.get('oracle')?.[0]?.taskID).toBe('ses_first');
    });

    test('scopes by parentSessionID; drop and clearParent empty the projection', () => {
      const board = new BackgroundJobBoard();
      seedReconciled(board, 'ses_mine', { parent: 'parent-1' });
      seedReconciled(board, 'ses_other', { parent: 'parent-2' });

      expect(sidebarHistory(board, 'parent-1').get('oracle')?.[0]?.taskID).toBe(
        'ses_mine',
      );
      expect(sidebarHistory(board, 'parent-2').get('oracle')?.[0]?.taskID).toBe(
        'ses_other',
      );
      expect(sidebarHistory(board, 'parent-3').size).toBe(0);

      board.drop('ses_mine');
      expect(sidebarHistory(board, 'parent-1').size).toBe(0);

      board.clearParent('parent-2');
      expect(sidebarHistory(board, 'parent-2').size).toBe(0);
    });

    test('mutation listener fires on launch, trim, and drop', () => {
      const board = new BackgroundJobBoard({ maxReusablePerAgent: 1 });
      let calls = 0;
      board.addMutationListener(() => {
        calls += 1;
      });

      seedReconciled(board, 'ses_1', { launchAt: 100, reconciledAt: 300 });
      const afterFirst = calls;
      expect(afterFirst).toBeGreaterThan(0);

      // Second reconciled session trims the first (count cap 1).
      seedReconciled(board, 'ses_2', { launchAt: 400, reconciledAt: 600 });
      const afterTrim = calls;
      expect(afterTrim).toBeGreaterThan(afterFirst);

      board.drop('ses_2');
      expect(calls).toBeGreaterThan(afterTrim);

      board.removeMutationListener(() => {});
      expect(calls).toBeGreaterThan(0);
    });

    test('sidebarHistoryByParentAgent never mutates lastUsedAt (read-only)', () => {
      const board = new BackgroundJobBoard();
      seedReconciled(board, 'ses_1', { launchAt: 100, reconciledAt: 300 });
      const before = board.get('ses_1')?.lastUsedAt;

      sidebarHistory(board, 'parent-1');

      expect(board.get('ses_1')?.lastUsedAt).toBe(before);
    });
  });
});

describe('terminal-session GC eviction listener', () => {
  // Each of the two retention-trim count-cap sites (trimReusable/trimRetained)
  // must fire onEvictedSession exactly once with a pre-delete snapshot.
  // clearParent/drop never fire it.

  test('trimReusable count-cap eviction fires the listener once', () => {
    const evictions: unknown[] = [];
    const board = new BackgroundJobBoard({
      maxReusablePerAgent: 2,
      onEvictedSession: (evicted) => evictions.push(evicted),
    });
    for (const [taskID, launchAt, reconciledAt] of [
      ['ses_1', 100, 300],
      ['ses_2', 400, 600],
      ['ses_3', 700, 900],
    ] as const) {
      board.registerLaunch({
        taskID,
        parentSessionID: 'parent-1',
        agent: 'oracle',
        description: `${taskID} job`,
        now: launchAt,
      });
      board.updateStatus({
        taskID,
        state: 'completed',
        resultSummary: 'done',
        now: launchAt + 100,
      });
      board.markReconciled(taskID, reconciledAt);
    }

    expect(board.get('ses_1')).toBeUndefined();
    expect(evictions).toHaveLength(1);
    expect(evictions[0]).toMatchObject({
      taskID: 'ses_1',
      state: 'reconciled',
    });
  });

  test('trimRetained count-cap eviction fires the listener once', () => {
    const evictions: unknown[] = [];
    const board = new BackgroundJobBoard({
      maxReusablePerAgent: 1,
      onEvictedSession: (evicted) => evictions.push(evicted),
    });
    board.registerLaunch({
      taskID: 'ses_old',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'old stopped',
      now: 100,
    });
    board.markStopped('ses_old', 'no native result', 110, undefined, 110);
    board.markReconciled('ses_old', 120);
    board.registerLaunch({
      taskID: 'ses_new',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'new stopped',
      now: 200,
    });
    board.markStopped('ses_new', 'no native result', 210, undefined, 210);
    board.markReconciled('ses_new', 220);

    expect(board.get('ses_old')).toBeUndefined();
    expect(evictions).toHaveLength(1);
    expect(evictions[0]).toMatchObject({ taskID: 'ses_old', state: 'stopped' });
  });

  test('clearParent and drop never fire the listener, including a parent deletion with running children', () => {
    const evictions: unknown[] = [];
    const board = new BackgroundJobBoard({
      onEvictedSession: (evicted) => evictions.push(evicted),
    });
    board.registerLaunch({
      taskID: 'ses_running',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'still running',
      now: 100,
    });
    board.registerLaunch({
      taskID: 'ses_other',
      parentSessionID: 'parent-2',
      agent: 'fixer',
      description: 'other',
      now: 100,
    });

    // Parent session.deleted with running children: no GC, no listener.
    board.clearParent('parent-1');
    expect(board.get('ses_running')).toBeUndefined();

    board.drop('ses_other');
    expect(board.get('ses_other')).toBeUndefined();
    expect(evictions).toHaveLength(0);
  });

  test('a throwing listener never breaks the trim', () => {
    const board = new BackgroundJobBoard({
      maxReusablePerAgent: 2,
      onEvictedSession: () => {
        throw new Error('listener boom');
      },
    });
    for (const [taskID, launchAt, reconciledAt] of [
      ['ses_1', 100, 300],
      ['ses_2', 400, 600],
      ['ses_3', 700, 900],
    ] as const) {
      board.registerLaunch({
        taskID,
        parentSessionID: 'parent-1',
        agent: 'oracle',
        description: `${taskID} job`,
        now: launchAt,
      });
      board.updateStatus({
        taskID,
        state: 'completed',
        resultSummary: 'done',
        now: launchAt + 100,
      });
      board.markReconciled(taskID, reconciledAt);
    }
    expect(board.get('ses_1')).toBeUndefined();
    expect(board.get('ses_2')).toBeDefined();
  });
});

describe('terminal-session GC provenance', () => {
  type Kind =
    | 'plugin-background'
    | 'foreground'
    | 'promoted-placeholder'
    | 'restored'
    | 'revive-adopted'
    | 'adopted-terminal'
    | 'resume-observed';

  /** Create `ses_target` by kind, then evict it with a newer launch. */
  const evictTarget = (kind: Kind): BackgroundJobEvictedSession => {
    const evictions: BackgroundJobEvictedSession[] = [];
    const board = new BackgroundJobBoard({
      maxReusablePerAgent: 1,
      onEvictedSession: (evicted) => evictions.push(evicted),
    });
    const base = {
      taskID: 'ses_target',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'target',
    };
    const complete = (taskID: string, now: number) => {
      board.updateStatus({ taskID, state: 'completed', now });
      board.markReconciled(taskID, now + 1);
    };
    switch (kind) {
      case 'plugin-background':
        board.registerLaunch({
          ...base,
          background: true,
          pluginLaunched: true,
          now: 100,
        });
        complete('ses_target', 110);
        break;
      case 'foreground':
        board.registerLaunch({
          ...base,
          background: false,
          pluginLaunched: true,
          now: 100,
        });
        complete('ses_target', 110);
        break;
      case 'promoted-placeholder':
        board.registerLaunch({
          ...base,
          background: false,
          provisional: true,
          now: 100,
        });
        // Promotion clears provisional; a later attributed background
        // observation must still not grant plugin provenance.
        board.promoteProvisional('ses_target', 'parent-1', {
          background: true,
        });
        board.registerLaunch({
          ...base,
          background: true,
          pluginLaunched: true,
          preserveRun: true,
          now: 105,
        });
        expect(board.get('ses_target')?.provisional).toBe(false);
        expect(board.get('ses_target')?.pluginLaunched).toBeUndefined();
        complete('ses_target', 110);
        break;
      case 'restored':
        board.restoreRetainedSession({
          ...base,
          state: 'completed',
          background: true,
          resultSummary: 'done',
          launchedAt: 100,
          completedAt: 110,
        });
        board.markReconciled('ses_target', 111);
        break;
      case 'revive-adopted':
        board.registerLaunch({
          ...base,
          background: true,
          adopted: true,
          pluginLaunched: true,
          now: 100,
        });
        complete('ses_target', 110);
        break;
      case 'adopted-terminal':
        board.adoptTerminal({
          ...base,
          createdAt: 100,
          updatedAt: 110,
          terminalState: 'completed',
          resultSummary: 'done',
        });
        break;
      case 'resume-observed':
        // A record of unknown provenance relaunched with background:true
        // (task_revive style) never gains plugin provenance.
        board.registerLaunch({ ...base, background: false, now: 100 });
        complete('ses_target', 110);
        board.registerLaunch({ ...base, background: true, now: 120 });
        complete('ses_target', 130);
        break;
    }
    board.registerLaunch({
      taskID: 'ses_newer',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'newer',
      background: true,
      pluginLaunched: true,
      now: 500,
    });
    complete('ses_newer', 510);
    const target = evictions.find((entry) => entry.taskID === 'ses_target');
    expect(target).toBeDefined();
    return target as BackgroundJobEvictedSession;
  };

  test('a background launch by this plugin is prunable', () => {
    const evicted = evictTarget('plugin-background');
    expect(evicted).toMatchObject({
      background: true,
      provisional: false,
      pluginLaunched: true,
      externalOrigin: false,
    });
    expect(isPrunableEvictedSession(evicted)).toBe(true);
  });

  for (const kind of [
    'foreground',
    'promoted-placeholder',
    'restored',
    'revive-adopted',
    'adopted-terminal',
    'resume-observed',
  ] as const) {
    test(`a ${kind} record is never prunable`, () => {
      expect(isPrunableEvictedSession(evictTarget(kind))).toBe(false);
    });
  }

  test('each provenance fact alone blocks pruning', () => {
    const eligible: BackgroundJobEvictedSession = {
      taskID: 'ses_x',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'x',
      state: 'reconciled',
      background: true,
      provisional: false,
      pluginLaunched: true,
      externalOrigin: false,
      alias: 'ses_x',
      lastUsedAt: 1,
    };
    expect(isPrunableEvictedSession(eligible)).toBe(true);
    expect(isPrunableEvictedSession({ ...eligible, background: false })).toBe(
      false,
    );
    expect(isPrunableEvictedSession({ ...eligible, provisional: true })).toBe(
      false,
    );
    expect(
      isPrunableEvictedSession({ ...eligible, pluginLaunched: false }),
    ).toBe(false);
    expect(
      isPrunableEvictedSession({ ...eligible, externalOrigin: true }),
    ).toBe(false);
  });
});

// ── Merged subscription seams (formerly the coordinator's) ──────────
// The board owns the terminal-outcome fan-out and the launch-identity
// projection that the dissolved coordinator used to wrap.
describe('BackgroundJobBoard subscription seams', () => {
  test('notifies launch identity on accepted register, drop, and clearParent', () => {
    const board = new BackgroundJobBoard();
    const events: Array<{ kind: string; taskID: string; alias: string }> = [];
    board.addLaunchIdentityListener((event) => {
      events.push({
        kind: event.kind,
        taskID: event.taskID,
        alias: event.alias,
      });
    });

    const first = board.registerLaunch({
      taskID: 'ses_ora_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    expect(events).toEqual([
      { kind: 'registered', taskID: 'ses_ora_1', alias: first.alias },
    ]);

    board.drop('ses_ora_1');
    expect(events.at(-1)).toEqual({
      kind: 'removed',
      taskID: 'ses_ora_1',
      alias: first.alias,
    });

    const sibling = board.registerLaunch({
      taskID: 'ses_ora_2',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    board.clearParent('parent-1');
    expect(events.at(-1)).toEqual({
      kind: 'removed',
      taskID: 'ses_ora_2',
      alias: sibling.alias,
    });
    expect(board.list('parent-1')).toEqual([]);
  });

  test('does not notify identity for a rejected launch, and a throwing listener does not fail the launch', () => {
    const board = new BackgroundJobBoard();
    const first = board.registerLaunch({
      taskID: 'ses_busy',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    const lease = board.acquireLease(first.taskID, first.generation, 'message');
    expect(lease).toBeDefined();

    const events: string[] = [];
    board.addLaunchIdentityListener(() => {
      throw new Error('identity listener failed');
    });
    board.addLaunchIdentityListener((event) => {
      events.push(`${event.kind}:${event.taskID}`);
    });

    expect(() =>
      board.registerLaunch({
        taskID: 'ses_busy',
        parentSessionID: 'parent-1',
        agent: 'oracle',
      }),
    ).toThrow();
    expect(events).toEqual([]);

    const accepted = board.registerLaunch({
      taskID: 'ses_ok',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    expect(accepted.taskID).toBe('ses_ok');
    expect(events).toEqual(['registered:ses_ok']);
  });

  test('a throwing outcome listener does not prevent subsequent outcomes', () => {
    const board = new BackgroundJobBoard();
    const delivered: string[] = [];
    board.addTerminalOutcomeListener(() => {
      throw new Error('first outcome listener failed');
    });
    board.addTerminalOutcomeListener((record) => {
      delivered.push(record.taskID);
    });
    board.registerLaunch({
      taskID: 'ses_123',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });

    board.updateStatus({ taskID: 'ses_123', state: 'completed' });

    expect(delivered).toEqual(['ses_123']);
  });

  test('logs the terminal state dispatch with record identity', () => {
    const entries: Array<{ message: string; data: unknown }> = [];
    const spy = spyOn(loggerModule, 'log').mockImplementation(
      (message: string, data?: unknown) => {
        entries.push({ message, data });
      },
    );
    try {
      const board = new BackgroundJobBoard();
      board.addTerminalOutcomeListener(() => {});
      const job = board.registerLaunch({
        taskID: 'ses_dispatch_log',
        parentSessionID: 'parent-1',
        agent: 'fixer',
      });
      board.updateStatus({ taskID: job.taskID, state: 'running' });
      board.updateStatus({ taskID: job.taskID, state: 'completed' });
      const dispatch = entries.find(
        (entry) =>
          entry.message === '[job-coordinator] terminal state dispatch',
      );
      expect(dispatch?.data).toMatchObject({
        taskID: job.taskID,
        generation: job.generation,
        state: 'completed',
        parentSessionID: 'parent-1',
      });
      expect(dispatch?.data).not.toHaveProperty('deferredClose');
    } finally {
      spy.mockRestore();
    }
  });

  test('stays silent on publication when no outcome listener is installed', () => {
    const entries: string[] = [];
    const spy = spyOn(loggerModule, 'log').mockImplementation(
      (message: string) => {
        entries.push(message);
      },
    );
    try {
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'ses_quiet',
        parentSessionID: 'parent-1',
        agent: 'fixer',
      });
      board.updateStatus({ taskID: 'ses_quiet', state: 'completed' });
      expect(
        entries.filter((message) =>
          message.includes('terminal state dispatch'),
        ),
      ).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
