import { describe, expect, mock, spyOn, test } from 'bun:test';
import {
  type BackgroundJobEvictedSession,
  clearBackgroundJobSuppression,
  getBackgroundJobLifecycleLedger,
  isPrunableEvictedSession,
  BackgroundJobBoard as ProductionBoard,
  type RestoreRetainedSessionInput,
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

    // Same-millisecond retrieval must still open the duplicate-spawn hatch.
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
      // Change eligibility without releasing ownership; token retirement stays.
      const current = board.get(run.taskID);
      if (!current) throw new Error('missing current record');
      board.markRunningFromLiveSession(
        run.taskID,
        (current.completedAt ?? current.runStartedAt) + 1,
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

  // Pin each kind's conflict wording byte-identically: the kind label stays
  // load-bearing even after the acquire seams collapse into one mutex.
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

  // Lease tokens must never spend run ordinals: the generation is load-bearing
  // outside the board, and each replayed token stays unauthorized.
  test('run input anchors remain generation-local across duplicate observations and reopen', () => {
    const board = new BackgroundJobBoard();
    const input = {
      taskID: 'ses_anchor',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    };
    const first = board.registerLaunch({
      ...input,
      runInputMessageID: 'msg_first',
    });
    expect(first.runInputMessageID).toBe('msg_first');
    const kept = board.registerLaunch({ ...input, preserveRun: true });
    expect(kept.runInputMessageID).toBe('msg_first');
    const replaced = board.registerLaunch(input);
    expect(replaced.generation).toBeGreaterThan(first.generation);
    expect(replaced.runInputMessageID).toBeUndefined();
    const latest = board.registerLaunch({
      ...input,
      runInputMessageID: 'msg_latest',
      now: 100,
    });
    board.updateStatus({
      taskID: input.taskID,
      state: 'completed',
      resultSummary: 'done',
      now: 200,
    });
    board.markRunningFromLiveSession(latest.taskID, 201);
    expect(board.get(input.taskID)?.runInputMessageID).toBeUndefined();
  });

  test('preserveRun running observation backfills an absent anchor and never overwrites a known one', () => {
    const board = new BackgroundJobBoard();
    const input = {
      taskID: 'ses_backfill',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    };
    board.registerLaunch(input);
    const backfilled = board.registerLaunch({
      ...input,
      preserveRun: true,
      runInputMessageID: 'msg_opened',
    });
    expect(backfilled.runInputMessageID).toBe('msg_opened');
    expect(board.get(input.taskID)?.runInputMessageID).toBe('msg_opened');

    // A known anchor is never overwritten by a later duplicate observation.
    const kept = board.registerLaunch({
      ...input,
      preserveRun: true,
      runInputMessageID: 'msg_other',
    });
    expect(kept.runInputMessageID).toBe('msg_opened');
  });

  test('preserveRun over an ordinary terminal record backfills only under a same-generation lease', () => {
    const board = new BackgroundJobBoard();
    const input = {
      taskID: 'ses_terminal',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    };
    board.registerLaunch(input);
    board.updateStatus({
      taskID: input.taskID,
      state: 'completed',
      resultSummary: 'done',
    });
    const generation = board.get(input.taskID)?.generation ?? 0;

    // No lease: the generation is unproven — the record stays untouched.
    const untouched = board.registerLaunch({
      ...input,
      preserveRun: true,
      runInputMessageID: 'msg_unproven',
    });
    expect(untouched.runInputMessageID).toBeUndefined();
    expect(untouched.generation).toBe(generation);
    expect(untouched.state).toBe('completed');

    // A validated relaunch lease proves the same generation: backfill.
    const lease = board.acquireLease(input.taskID, generation, 'relaunch');
    if (!lease) throw new Error('missing relaunch lease');
    const anchored = board.registerLaunch({
      ...input,
      preserveRun: true,
      runInputMessageID: 'msg_proven',
      relaunchLease: lease,
    });
    expect(anchored.runInputMessageID).toBe('msg_proven');
    board.releaseLease(lease);

    // A known anchor is still never overwritten, even with a lease.
    const lease2 = board.acquireLease(
      input.taskID,
      anchored.generation,
      'relaunch',
    );
    if (!lease2) throw new Error('missing second relaunch lease');
    const kept = board.registerLaunch({
      ...input,
      preserveRun: true,
      runInputMessageID: 'msg_late',
      relaunchLease: lease2,
    });
    expect(kept.runInputMessageID).toBe('msg_proven');
    board.releaseLease(lease2);
  });

  test('promoteProvisional backfills a caller anchor only when the record has none', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_promote_fresh',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      provisional: true,
    });
    const promoted = board.promoteProvisional('ses_promote_fresh', 'parent-1', {
      agent: 'fixer',
      description: 'attributed',
      runInputMessageID: 'msg_owner',
    });
    expect(promoted?.runInputMessageID).toBe('msg_owner');

    board.registerLaunch({
      taskID: 'ses_promote_kept',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      provisional: true,
      runInputMessageID: 'msg_existing',
    });
    const kept = board.promoteProvisional('ses_promote_kept', 'parent-1', {
      runInputMessageID: 'msg_owner',
    });
    expect(kept?.runInputMessageID).toBe('msg_existing');

    // No metadata: legacy shape preserved — the key stays absent, not
    // explicitly undefined.
    board.registerLaunch({
      taskID: 'ses_promote_plain',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      provisional: true,
    });
    const plain = board.promoteProvisional(
      'ses_promote_plain',
      'parent-1',
      undefined,
    );
    expect(plain?.runInputMessageID).toBeUndefined();
    expect('runInputMessageID' in (plain ?? {})).toBe(false);
  });

  test('a message lease requires a live run like a cancellation lease', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_msg',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    board.updateStatus({
      taskID: 'ses_msg',
      state: 'completed',
      resultSummary: 'done',
    });
    expect(board.acquireLease('ses_msg', 1, 'message')).toBeUndefined();
  });

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

    // Repeated timed-out running observations then a completed publication land
    // the row terminal exactly once (terminalRevision 1).
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
    // reusable inside the reusable pool.
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
    // An ACK during a live relaunch lease shields retained-stopped entries; the
    // release must re-apply the per-agent cap and evict the oldest shielded.
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

    expect(board.list('parent-1').map((job) => job.taskID)).toEqual(
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
    // The uncertain overlay alone blocks reuse; a confirmed terminal stays
    // reusable.
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
    // The lease excludes competitors, not observed host activity.
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
      // Cap 4 keeps every seeded session: this exercises selection, not eviction.
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

      // The sidebar dot must not advertise a placeholder nobody attributed.
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
      board.markStatusUncertain('ses_uncertain', 'status unavailable');
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

      // The oldest was evicted; selection falls to the newest survivor.
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

      // The relaunched job runs again; only the older reconciled remains.
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
  // Both retention-trim count-cap sites must fire once with a pre-delete
  // snapshot; clearParent/drop never fire it.

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
        // Promotion clears provisional; later background:true never re-grants it.
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
        // task_revive-style relaunch with background:true never gains provenance.
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

// ── Merged subscription seams: the board owns the terminal-outcome fan-out and
// the launch-identity projection the dissolved coordinator used to wrap. ──

/** One run launched at a controlled clock, for the amendment fence tests. */
function launchedRun(board: BackgroundJobBoard, taskID: string, now = 100) {
  return board.registerLaunch({
    taskID,
    parentSessionID: 'parent-1',
    agent: 'fixer',
    now,
  });
}

/** noteRunAmendment against the run's own row at its captured revision/generation unless overridden. */
function stamp(
  board: BackgroundJobBoard,
  run: { taskID: string; generation: number; terminalRevision: number },
  messageID: string,
  revision = run.terminalRevision,
  generation = run.generation,
) {
  return board.noteRunAmendment(run.taskID, generation, messageID, revision);
}

describe('noteRunAmendment run-identity fence', () => {
  test('stamps its captured run while it is still running, idempotently and for repeated messages', () => {
    const board = new BackgroundJobBoard();
    const run = launchedRun(board, 'ses_deposit');
    const before = board.get('ses_deposit');
    if (!before) throw new Error('missing running record');

    expect(stamp(board, run, 'msg_queue')).toBe(true);
    // The fence touches nothing but the amendment id.
    expect(board.get('ses_deposit')).toEqual({
      ...before,
      amendmentInputMessageID: 'msg_queue',
    });
    // Idempotent for the same id.
    expect(stamp(board, run, 'msg_queue')).toBe(true);
    expect(board.get('ses_deposit')?.amendmentInputMessageID).toBe('msg_queue');
    // A different id at the captured revision replaces the boundary.
    expect(stamp(board, run, 'msg_queue_followup')).toBe(true);
    expect(board.get('ses_deposit')?.amendmentInputMessageID).toBe(
      'msg_queue_followup',
    );
    expect(board.get('ses_deposit')?.state).toBe('running');
  });

  test('a new generation never inherits the previous run amendment', () => {
    const board = new BackgroundJobBoard();
    const run = launchedRun(board, 'ses_stale_amendment');
    expect(stamp(board, run, 'msg_old_amend')).toBe(true);
    boardFixture.updateStatus(board, {
      taskID: run.taskID,
      state: 'error',
      resultSummary: 'previous generation failed',
      now: 200,
    });

    const next = board.registerLaunch({
      taskID: run.taskID,
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 300,
      runInputMessageID: 'msg_new_open',
    });

    expect(next.generation).toBeGreaterThan(run.generation);
    expect(next.runInputMessageID).toBe('msg_new_open');
    // The old boundary belongs to the generation that is gone: a cancelled
    // continuation whose input never lands must not inherit it.
    expect(next.amendmentInputMessageID).toBeUndefined();
  });

  test.each([
    'completed',
    'error',
    'cancelled',
    'stopped',
    'reconciled',
  ] as const)(
    'stamps the same run terminal %s at captured + 1 and preserves every other field',
    (terminal) => {
      const board = new BackgroundJobBoard();
      const run = launchedRun(board, `ses_term_${terminal}`);
      // Captured on the running run, then one same-run terminal transition.
      boardFixture.updateStatus(board, {
        taskID: run.taskID,
        state: terminal === 'reconciled' ? 'completed' : terminal,
        resultSummary: `${terminal} summary`,
        now: 200,
      });
      if (terminal === 'reconciled') board.markReconciled(run.taskID, 300);
      const before = board.get(run.taskID);
      if (!before) throw new Error('missing terminal record');
      expect(before.terminalRevision).toBe(run.terminalRevision + 1);

      expect(stamp(board, run, 'msg_steer')).toBe(true);

      const stamped = board.get(run.taskID);
      // Only the amendment id moved; the terminal publication is untouched.
      expect(stamped).toEqual({
        ...before,
        amendmentInputMessageID: 'msg_steer',
      });
      expect(stamped?.state).toBe(
        terminal === 'reconciled' ? 'reconciled' : terminal,
      );
    },
  );

  test('refuses a terminal row at the captured revision (stopped outside the ladder)', () => {
    // Only a running row accepts the captured revision; anything else refuses.
    const board = new BackgroundJobBoard();
    const run = launchedRun(board, 'ses_captured_terminal');
    const ended = boardFixture.updateStatus(board, {
      taskID: run.taskID,
      state: 'error',
      resultSummary: 'failed',
      now: 200,
    });
    if (ended?.state !== 'error') throw new Error('expected terminal row');

    expect(stamp(board, run, 'msg_late', ended.terminalRevision)).toBe(false);
    expect(
      board.get('ses_captured_terminal')?.amendmentInputMessageID,
    ).toBeUndefined();
  });

  type SteerRun = ReturnType<typeof launchedRun>;
  // Every refusal keeps both rows unstamped; the runs stay generation-distinct.
  const refusalRows: Array<
    [
      string,
      {
        taskID?: string;
        generationDelta?: number;
        messageID?: string;
        revision?: number;
        revisionDelta?: number;
      },
    ]
  > = [
    ['one revision behind', { revisionDelta: -1 }],
    ['two revisions ahead', { revisionDelta: 2 }],
    ['a wrong generation', { generationDelta: 1 }],
    ['a foreign row', { taskID: 'ses_other_run' }],
    ['a missing row', { taskID: 'ses_missing', revision: 0 }],
    ['an empty message id', { messageID: '', revision: 0 }],
    ['an empty task id', { taskID: '', revision: 0 }],
  ];
  test.each(refusalRows)('refuses a deposit naming %s', (_name, patch) => {
    const board = new BackgroundJobBoard();
    const run = launchedRun(board, 'ses_ref');
    const other = launchedRun(board, 'ses_other_run');
    expect(
      board.noteRunAmendment(
        patch.taskID ?? 'ses_ref',
        run.generation + (patch.generationDelta ?? 0),
        patch.messageID ?? 'msg_steer',
        patch.revision ?? run.terminalRevision + (patch.revisionDelta ?? 0),
      ),
    ).toBe(false);
    expect(board.get('ses_ref')?.amendmentInputMessageID).toBeUndefined();
    expect(board.get('ses_other_run')?.amendmentInputMessageID).toBeUndefined();
    expect(other.generation).toBeGreaterThan(run.generation);
  });

  const reopenRows = [
    {
      name: 'a running row at captured + 1',
      stampFirst: false,
      publishAgain: false,
      revision: (run: SteerRun) => run.terminalRevision + 1,
      messageID: 'msg_steer_plus_one',
    },
    {
      name: 'a reopened row at the captured revision',
      stampFirst: true,
      publishAgain: false,
      revision: (run: SteerRun) => run.terminalRevision,
      messageID: 'msg_steer_again',
    },
    {
      name: 'a re-terminalized row at the captured revision',
      stampFirst: true,
      publishAgain: true,
      revision: (run: SteerRun) => run.terminalRevision,
      messageID: 'msg_steer_again',
    },
  ];
  test.each(reopenRows)(
    'a same-generation reopen refuses $name',
    ({ stampFirst, publishAgain, revision, messageID }) => {
      const board = new BackgroundJobBoard();
      const run = launchedRun(board, 'ses_steer_reopen', 100);
      const firstEnd = boardFixture.updateStatus(board, {
        taskID: run.taskID,
        state: 'error',
        resultSummary: 'first failure',
        now: 200,
      });
      expect(firstEnd?.terminalRevision).toBe(run.terminalRevision + 1);
      if (stampFirst) {
        expect(stamp(board, run, 'msg_steer')).toBe(true);
        expect(board.get(run.taskID)?.amendmentInputMessageID).toBe(
          'msg_steer',
        );
      }

      const reopened = board.markRunningFromLiveSession(run.taskID, 300);
      expect(reopened?.state).toBe('running');
      expect(reopened?.terminalRevision).toBe(run.terminalRevision + 2);
      expect(reopened?.amendmentInputMessageID).toBeUndefined();
      if (publishAgain) {
        const secondEnd = boardFixture.updateStatus(board, {
          taskID: run.taskID,
          state: 'error',
          resultSummary: 'second failure',
          now: 400,
        });
        expect(secondEnd?.terminalRevision).toBe(run.terminalRevision + 3);
        expect(board.get(run.taskID)?.resultSummary).toBe('second failure');
      }

      expect(stamp(board, run, messageID, revision(run))).toBe(false);
      expect(board.get(run.taskID)?.amendmentInputMessageID).toBeUndefined();
    },
  );

  test('an equal-timestamp busy observation does not reopen the terminal run', () => {
    // Equal-timestamp busy cannot revive the row, so the amendment survives.
    const board = new BackgroundJobBoard();
    const run = launchedRun(board, 'ses_steer_reopen_same_time', 100);
    boardFixture.updateStatus(board, {
      taskID: run.taskID,
      state: 'completed',
      resultSummary: 'done',
      now: 200,
    });
    const terminalized = board.get(run.taskID);
    if (!terminalized) throw new Error('missing terminal record');
    expect(terminalized.completedAt).toBe(200);

    const reopened = board.markRunningFromLiveSession(
      run.taskID,
      200,
      run.generation,
    );
    expect(reopened?.state).toBe('completed');
    expect(stamp(board, run, 'msg_steer_late')).toBe(true);
    expect(
      board.get('ses_steer_reopen_same_time')?.amendmentInputMessageID,
    ).toBe('msg_steer_late');
  });
});

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

describe('BackgroundJobBoard direct queries and projection reuse', () => {
  test('resolve hits full task IDs through the map, scoped per parent', () => {
    const board = new BackgroundJobBoard();
    const first = board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      now: 100,
    });
    const second = board.registerLaunch({
      taskID: 'ses_2',
      parentSessionID: 'parent-2',
      agent: 'explorer',
      now: 500,
    });

    expect(board.resolve('parent-1', 'ses_1')).toBe(first);
    expect(board.resolve('parent-2', 'ses_2')).toBe(second);
    // Whitespace is trimmed; foreign parents and unknown ids miss.
    expect(board.resolve('parent-1', '  ses_1  ')).toBe(first);
    expect(board.resolve('parent-1', 'ses_2')).toBeUndefined();
    expect(board.resolve('parent-1', 'ses_missing')).toBeUndefined();
  });

  test('resolve alias fallback stays scoped per parent and is order-independent', () => {
    const board = new BackgroundJobBoard();
    const first = board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      now: 100,
    });
    const second = board.registerLaunch({
      taskID: 'ses_2',
      parentSessionID: 'parent-2',
      agent: 'explorer',
      now: 500,
    });

    expect(board.resolve('parent-1', first.alias)).toBe(first);
    expect(board.resolve('parent-2', second.alias)).toBe(second);
    // Numbered aliases are namespaced per parent: the same alias string
    // resolves to each parent's own record, never across parents.
    expect(first.alias).toBe(second.alias);
    expect(board.resolve('parent-1', second.alias)).toBe(first);
    // The map hit wins even when the record launched after its siblings.
    expect(board.resolve('parent-2', 'ses_2')).toBe(second);
  });

  test('hasRunning and hasTerminalUnreconciled answer per parent without sorting', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_run',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      now: 100,
    });
    board.registerLaunch({
      taskID: 'ses_stopped',
      parentSessionID: 'parent-2',
      agent: 'oracle',
      now: 100,
    });
    board.markStopped('ses_stopped', 'no native result', 110, undefined, 110);

    expect(board.hasRunning('parent-1')).toBe(true);
    expect(board.hasRunning('parent-2')).toBe(false);
    expect(board.hasTerminalUnreconciled('parent-1')).toBe(false);
    expect(board.hasTerminalUnreconciled('parent-2')).toBe(true);
  });

  test('restoreRetainedSession alias availability is scoped per parent', () => {
    const board = new BackgroundJobBoard();
    const restore = (taskID: string, parentSessionID: string) =>
      board.restoreRetainedSession({
        taskID,
        parentSessionID,
        agent: 'oracle',
        description: taskID,
        state: 'completed',
        background: true,
        resultSummary: 'done',
        alias: 'ora-7',
        launchedAt: 100,
        completedAt: 110,
      });

    expect(restore('ses_a', 'parent-1')?.alias).toBe('ora-7');
    // Taken within the same parent: the row keeps its task ID.
    expect(restore('ses_b', 'parent-1')?.alias).toBe('ses_b');
    // A sibling parent holding the alias does not block another parent.
    expect(restore('ses_c', 'parent-2')?.alias).toBe('ora-7');
  });

  test('sidebar history selections omit absent timestamps (no undefined keys)', () => {
    const board = new BackgroundJobBoard();
    // A restored stopped row carries only launch evidence; completedAt
    // stays absent.
    board.restoreRetainedSession({
      taskID: 'ses_stopped',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'recovered stop',
      state: 'stopped',
      background: true,
      launchedAt: 100,
    });

    const selection = board
      .sidebarHistoryByParentAgent()
      .get('parent-1')
      ?.get('oracle')?.[0];
    expect(selection).toMatchObject({
      taskID: 'ses_stopped',
      terminalState: 'stopped',
      lastUsedAt: 100,
    });
    expect(selection && 'completedAt' in selection).toBe(false);
  });

  test('sidebarHistoryByParentAgent reuses an explicit sorted snapshot', () => {
    const board = new BackgroundJobBoard();
    const seed = (taskID: string, parentSessionID: string, now: number) => {
      board.registerLaunch({
        taskID,
        parentSessionID,
        agent: 'oracle',
        now,
      });
      board.updateStatus({
        taskID,
        state: 'completed',
        resultSummary: 'done',
        now: now + 100,
      });
      board.markReconciled(taskID, now + 200);
    };
    seed('ses_1', 'parent-1', 100);
    seed('ses_2', 'parent-2', 400);

    const records = board.list();
    expect(board.sidebarHistoryByParentAgent(records)).toEqual(
      board.sidebarHistoryByParentAgent(),
    );
    // A parent-scoped slice of the same snapshot groups only its records.
    const scoped = board.sidebarHistoryByParentAgent(
      records.filter((job) => job.parentSessionID === 'parent-1'),
    );
    expect([...scoped.keys()]).toEqual(['parent-1']);
  });

  test('aliases stay unique per parent across launch, restore, and adoption', () => {
    const board = new BackgroundJobBoard();
    const owners = new Map<string, string>();
    const claim = (parentSessionID: string, alias: string, taskID: string) => {
      const key = `${parentSessionID}\u0000${alias}`;
      expect(owners.has(key)).toBe(false);
      owners.set(key, taskID);
    };

    const first = board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    const second = board.registerLaunch({
      taskID: 'ses_2',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    claim('parent-1', first.alias, 'ses_1');
    claim('parent-1', second.alias, 'ses_2');

    // A restored trusted alias claims it; a second restore with the same
    // historical alias falls back to its own task ID.
    const restore = (taskID: string, alias: string, launchedAt: number) =>
      board.restoreRetainedSession({
        taskID,
        parentSessionID: 'parent-1',
        agent: 'oracle',
        description: taskID,
        state: 'completed',
        background: true,
        resultSummary: 'done',
        alias,
        launchedAt,
        completedAt: launchedAt + 10,
      });
    const trusted = restore('ses_3', 'ora-9', 100);
    claim('parent-1', trusted?.alias ?? '', 'ses_3');
    const fallback = restore('ses_4', 'ora-9', 200);
    expect(fallback?.alias).toBe('ses_4');
    claim('parent-1', fallback.alias, 'ses_4');

    // An adopted row aliases to its own task ID.
    const adopted = board.registerLaunch({
      taskID: 'ses_5',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      adopted: true,
    });
    expect(adopted.alias).toBe('ses_5');
    claim('parent-1', adopted.alias, 'ses_5');

    // The same alias string may live under another parent: resolution is
    // parent-scoped, never global.
    const cross = board.registerLaunch({
      taskID: 'ses_6',
      parentSessionID: 'parent-2',
      agent: 'oracle',
    });
    expect(cross.alias).toBe(first.alias);
    claim('parent-2', cross.alias, 'ses_6');

    // Every record resolves through both identity paths.
    for (const [key, taskID] of owners) {
      const [parentSessionID, alias] = key.split('\u0000');
      expect(board.resolve(parentSessionID, alias)?.taskID).toBe(taskID);
      expect(board.resolve(parentSessionID, taskID)?.taskID).toBe(taskID);
    }
  });
});

// ── Contract pins from the issue #1717 mutation sweep ──────────────
// Each test names the behavioral contract it pins and targets a
// surviving-mutant cluster in the board's decision logic.
describe('BackgroundJobBoard contract pins (#1717)', () => {
  test('contract: a replayed suppression keeps the first deletion epoch', () => {
    // recordBackgroundJobSuppression must stamp the epoch exactly once:
    // replayed drops are no-ops so valid history cannot re-epoch.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_sup',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    board.drop('ses_sup');
    const ledger = getBackgroundJobLifecycleLedger(board);
    expect(ledger.tombstones.has('ses_sup')).toBe(true);
    expect(ledger.deletionEpochs.get('ses_sup')).toBe(1);
    const nextEpochAfterFirst = ledger.nextEpoch;
    board.drop('ses_sup');
    expect(ledger.tombstones.has('ses_sup')).toBe(true);
    expect(ledger.deletionEpochs.get('ses_sup')).toBe(1);
    expect(ledger.nextEpoch).toBe(nextEpochAfterFirst);
  });

  test('contract: a relaunch or explicit clear empties the tombstone', () => {
    // A proven new launch is proof of life: the rehydrate tombstone
    // must clear so the relaunched task is not ghost-skipped.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_r1',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    board.drop('ses_r1');
    const ledger = getBackgroundJobLifecycleLedger(board);
    expect(ledger.tombstones.has('ses_r1')).toBe(true);
    board.registerLaunch({
      taskID: 'ses_r1',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 200,
    });
    expect(ledger.tombstones.has('ses_r1')).toBe(false);

    board.registerLaunch({
      taskID: 'ses_r2',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    board.drop('ses_r2');
    expect(ledger.tombstones.has('ses_r2')).toBe(true);
    clearBackgroundJobSuppression(board, 'ses_r2');
    expect(ledger.tombstones.has('ses_r2')).toBe(false);
  });

  test('contract: a stale running status cannot reopen terminal rows', () => {
    // The applyStatus guard keeps stopped, cancelled, and reconciled
    // publications final against any late running status write.
    const board = new BackgroundJobBoard();
    const stopRun = board.registerLaunch({
      taskID: 'ses_s',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    board.markStopped('ses_s', 'host stop', 200, stopRun.generation, 200);
    expect(board.getState('ses_s')).toBe('stopped');
    const cancelRun = board.registerLaunch({
      taskID: 'ses_c',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    board.markCancelled('ses_c', 'user cancelled', 200);
    expect(board.getState('ses_c')).toBe('cancelled');
    const doneRun = board.registerLaunch({
      taskID: 'ses_k',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    board.updateStatus({
      taskID: 'ses_k',
      state: 'completed',
      now: 200,
    });
    board.markReconciled('ses_k', 250);
    expect(board.getState('ses_k')).toBe('reconciled');

    for (const run of [stopRun, cancelRun, doneRun]) {
      const before = structuredClone(board.get(run.taskID));
      const outcome = board.updateStatus({
        taskID: run.taskID,
        state: 'running',
        now: 300,
      });
      expect(outcome).toEqual(before);
      expect(board.get(run.taskID)).toEqual(before);
    }
    expect(board.hasRunning('p1')).toBe(false);
  });

  test('contract: status writes for unknown tasks stay no-ops', () => {
    // Neither a running nor a terminal write may materialize a record
    // (or throw) for a task the board does not track.
    const board = new BackgroundJobBoard();
    expect(
      board.updateStatus({ taskID: 'ghost', state: 'running' }),
    ).toBeUndefined();
    expect(
      boardFixture.updateStatus(board, {
        taskID: 'ghost',
        state: 'completed',
        resultSummary: 'done',
        now: 100,
      }),
    ).toBeUndefined();
    expect(board.get('ghost')).toBeUndefined();
  });

  test('contract: busy observations respect the publication fence', () => {
    // A busy observation that did not see the row's own terminal
    // publication is stale evidence: it stamps the clock only. One that
    // saw this publication is genuinely live again and reopens the run.
    const board = new BackgroundJobBoard();
    const runA = board.registerLaunch({
      taskID: 'ses_a',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    board.updateStatus({
      taskID: 'ses_a',
      state: 'completed',
      resultSummary: 'done',
      now: 200,
    });
    const published = board.get('ses_a');
    if (!published) throw new Error('missing terminal record');
    const stale = board.markRunningFromLiveSession(
      'ses_a',
      150,
      runA.generation,
      99,
    );
    expect(stale).toEqual({ ...published, lastLiveBusyAt: 150 });
    // The stamp lands on the board, not just the return value.
    expect(board.get('ses_a')).toEqual(stale);
    expect(board.getState('ses_a')).toBe('completed');

    const runB = board.registerLaunch({
      taskID: 'ses_b',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    board.updateStatus({
      taskID: 'ses_b',
      state: 'completed',
      resultSummary: 'done',
      now: 200,
    });
    const reopened = board.markRunningFromLiveSession(
      'ses_b',
      150,
      runB.generation,
      1,
    );
    expect(reopened).toMatchObject({
      state: 'running',
      terminalRevision: 2,
      activityRevision: 1,
      lastLiveBusyAt: 150,
    });
    expect(reopened?.completedAt).toBeUndefined();
    expect(reopened?.launchedAt).toBe(150);
    expect(reopened?.runStartedAt).toBe(150);
  });

  test('contract: a running heartbeat keeps the run fence in place', () => {
    // Repeated busy observations of an in-flight run move only the
    // activity clock: run identity and publication revision are fixed
    // until a terminal transition, and stale generations touch nothing.
    const board = new BackgroundJobBoard();
    const run = board.registerLaunch({
      taskID: 'ses_h',
      parentSessionID: 'p1',
      agent: 'explorer',
      runInputMessageID: 'msg_open',
      now: 100,
    });
    const beat = board.markRunningFromLiveSession(
      'ses_h',
      150,
      run.generation,
      0,
    );
    expect(beat).toMatchObject({
      state: 'running',
      launchedAt: 100,
      runStartedAt: 100,
      activityRevision: 1,
      terminalRevision: 0,
      lastLiveBusyAt: 150,
      recoverableAfterLiveBusy: false,
    });
    // A heartbeat keeps the run's input anchor: nothing reopens here.
    expect(beat?.runInputMessageID).toBe('msg_open');

    const beforeFence = structuredClone(board.get('ses_h'));
    expect(
      board.markRunningFromLiveSession('ses_h', 300, run.generation + 1, 0),
    ).toEqual(beforeFence);
    expect(board.get('ses_h')).toEqual(beforeFence);
  });

  test('contract: restore admission rejects blanks and unknown states', () => {
    // Blank identities are not evidence of a session, and an
    // unlisted state is not a terminal cache row.
    const board = new BackgroundJobBoard();
    const base = {
      parentSessionID: 'p1',
      agent: 'explorer',
      description: 'recovered run',
      state: 'completed' as const,
      background: true,
    };
    expect(
      board.restoreRetainedSession({ ...base, taskID: ' ' }),
    ).toBeUndefined();
    expect(
      board.restoreRetainedSession({
        ...base,
        taskID: 'ses_x',
        parentSessionID: ' ',
      }),
    ).toBeUndefined();
    expect(
      board.restoreRetainedSession({
        ...base,
        taskID: 'ses_x',
        agent: ' ',
      }),
    ).toBeUndefined();
    expect(
      board.restoreRetainedSession({
        ...base,
        taskID: 'ses_x',
        state: 'running' as unknown as RestoreRetainedSessionInput['state'],
      }),
    ).toBeUndefined();
    expect(board.taskIDs().size).toBe(0);
  });

  test('contract: a duplicate restore refuses and keeps the first row', () => {
    // restoreRetainedSession admits absent, unleased rows exactly
    // once; a retry must not overwrite or extend the cache row.
    const board = new BackgroundJobBoard();
    const base = {
      parentSessionID: 'p1',
      agent: 'explorer',
      description: 'recovered run',
      objective: 'plan-o',
      state: 'completed' as const,
      background: true,
      launchedAt: 100,
      completedAt: 110,
      resultSummary: 'done',
    };
    const first = board.restoreRetainedSession({
      ...base,
      taskID: 'ses_d',
    });
    expect(first).toMatchObject({
      state: 'completed',
      terminalState: 'completed',
      terminalRevision: 1,
      terminalUnreconciled: true,
      cancellationRequested: false,
      timedOut: false,
      background: true,
      objective: 'plan-o',
      completedAt: 110,
      resultSummary: 'done',
    });
    expect(
      board.restoreRetainedSession({ ...base, taskID: 'ses_d' }),
    ).toBeUndefined();
    expect(board.get('ses_d')).toEqual(first);

    const fallback = board.restoreRetainedSession({
      ...base,
      taskID: 'ses_fb',
      description: ' ',
    });
    expect(fallback?.description).toBe('recovered explorer session');
  });

  test('contract: restored rows carry the lifecycle of their state', () => {
    // Completed/error rows record their terminal revision and state;
    // stopped rows keep the publication ladder at zero with no
    // terminalState key; only cancelled rows carry cancellation intent.
    const board = new BackgroundJobBoard();
    const base = {
      parentSessionID: 'p1',
      agent: 'explorer',
      description: 'recovered run',
      background: true,
      launchedAt: 100,
      completedAt: 110,
      resultSummary: 'done',
    };
    const stopped = board.restoreRetainedSession({
      ...base,
      taskID: 'ses_stop',
      state: 'stopped',
      completedAt: undefined,
    });
    expect(stopped).toMatchObject({
      state: 'stopped',
      terminalRevision: 0,
      terminalUnreconciled: true,
      timedOut: false,
    });
    expect(Object.hasOwn(stopped ?? {}, 'terminalState')).toBe(false);

    const cancelled = board.restoreRetainedSession({
      ...base,
      taskID: 'ses_cancel',
      state: 'cancelled',
    });
    expect(cancelled).toMatchObject({
      state: 'cancelled',
      terminalState: 'cancelled',
      terminalRevision: 1,
      cancellationRequested: true,
    });

    const errored = board.restoreRetainedSession({
      ...base,
      taskID: 'ses_err',
      state: 'error',
    });
    expect(errored).toMatchObject({
      state: 'error',
      terminalState: 'error',
      terminalRevision: 1,
      cancellationRequested: false,
    });
  });

  test('contract: a trusted historical alias advances the counter', () => {
    // A restored trusted alias claims its number, so the next numbered
    // alias of the same parent/agent must skip past it.
    const board = new BackgroundJobBoard();
    const restored = board.restoreRetainedSession({
      taskID: 'ses_h2',
      parentSessionID: 'p1',
      agent: 'oracle',
      description: 'old run',
      state: 'completed',
      background: true,
      alias: 'ora-9',
      launchedAt: 100,
      completedAt: 110,
    });
    expect(restored?.alias).toBe('ora-9');
    const next = board.registerLaunch({
      taskID: 'ses_n',
      parentSessionID: 'p1',
      agent: 'oracle',
      now: 200,
    });
    expect(next.alias).toBe('ora-10');
    // A lower historical alias never rewinds the counter.
    board.restoreRetainedSession({
      taskID: 'ses_h3',
      parentSessionID: 'p1',
      agent: 'oracle',
      description: 'older run',
      state: 'completed',
      background: true,
      alias: 'ora-3',
      launchedAt: 50,
      completedAt: 60,
    });
    const afterLower = board.registerLaunch({
      taskID: 'ses_n2',
      parentSessionID: 'p1',
      agent: 'oracle',
      now: 300,
    });
    expect(afterLower.alias).toBe('ora-11');

    // ora-1 is the smallest claimable historical number.
    const board2 = new BackgroundJobBoard();
    board2.restoreRetainedSession({
      taskID: 'ses_o',
      parentSessionID: 'p1',
      agent: 'oracle',
      description: 'old run',
      state: 'completed',
      background: true,
      alias: 'ora-1',
      launchedAt: 100,
      completedAt: 110,
    });
    const next2 = board2.registerLaunch({
      taskID: 'ses_o2',
      parentSessionID: 'p1',
      agent: 'oracle',
      now: 200,
    });
    expect(next2.alias).toBe('ora-2');

    // An unsafe historical number never advances the counter.
    const board3 = new BackgroundJobBoard();
    board3.restoreRetainedSession({
      taskID: 'ses_u',
      parentSessionID: 'p1',
      agent: 'oracle',
      description: 'old run',
      state: 'completed',
      background: true,
      alias: 'ora-99999999999999999999',
      launchedAt: 100,
      completedAt: 110,
    });
    const next3 = board3.registerLaunch({
      taskID: 'ses_u2',
      parentSessionID: 'p1',
      agent: 'oracle',
      now: 200,
    });
    expect(next3.alias).toBe('ora-1');
  });

  test('contract: trimRetained eviction stays within the agent', () => {
    // The per-agent count cap may evict only the triggering agent's
    // retained rows; other agents' rows are out of scope.
    const board = new BackgroundJobBoard({ maxReusablePerAgent: 1 });
    const exp = board.registerLaunch({
      taskID: 'ses_exp',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    board.markStopped('ses_exp', 'stop', 150, exp.generation, 150);
    board.markReconciled('ses_exp', 160);
    const fix = board.registerLaunch({
      taskID: 'ses_fix',
      parentSessionID: 'p1',
      agent: 'fixer',
      now: 200,
    });
    board.markStopped('ses_fix', 'stop', 250, fix.generation, 250);
    board.markReconciled('ses_fix', 260);
    expect(board.get('ses_exp')).toBeDefined();
    expect(board.get('ses_fix')).toBeDefined();

    const fix2 = board.registerLaunch({
      taskID: 'ses_fix2',
      parentSessionID: 'p1',
      agent: 'fixer',
      now: 300,
    });
    board.markStopped('ses_fix2', 'stop', 350, fix2.generation, 350);
    board.markReconciled('ses_fix2', 360);
    expect(board.get('ses_exp')).toBeDefined();
    expect(board.get('ses_fix2')).toBeDefined();
    expect(board.get('ses_fix')).toBeUndefined();
  });

  test('contract: releasing a lease for a dropped job trims nothing', () => {
    // A release whose job is already gone is a plain lease drop: it
    // must neither throw nor reach the retention trim.
    const board = new BackgroundJobBoard({ maxReusablePerAgent: 1 });
    const keep = board.registerLaunch({
      taskID: 'ses_keep',
      parentSessionID: 'p1',
      agent: 'fixer',
      now: 100,
    });
    board.markStopped('ses_keep', 'stop', 150, keep.generation, 150);
    board.markReconciled('ses_keep', 160);
    const leased = board.registerLaunch({
      taskID: 'ses_leased',
      parentSessionID: 'p1',
      agent: 'fixer',
      now: 200,
    });
    const lease = board.acquireLease(
      'ses_leased',
      leased.generation,
      'message',
    );
    expect(lease).toBeDefined();
    board.drop('ses_leased');
    if (!lease) throw new Error('missing lease');
    expect(() => board.releaseLease(lease)).not.toThrow();
    expect(board.isTracked('ses_leased')).toBe(false);
    expect(board.get('ses_keep')).toBeDefined();
  });

  test('contract: preserveRun paints metadata and provenance when proven', () => {
    // Caller metadata overwrites on observation; native provenance is
    // painted only for this plugin's own tracked background launches —
    // never for foreground rows, adopted inputs, or external origins.
    const board = new BackgroundJobBoard();
    const first = board.registerLaunch({
      taskID: 'ses_p1',
      parentSessionID: 'p1',
      agent: 'explorer',
      description: 'old',
      objective: 'plan-a',
      now: 100,
    });
    const observed = board.registerLaunch({
      taskID: 'ses_p1',
      parentSessionID: 'p1',
      agent: 'fixer',
      description: 'fresh',
      background: true,
      preserveRun: true,
      pluginLaunched: true,
      now: 200,
    });
    expect(observed).toMatchObject({
      agent: 'fixer',
      description: 'fresh',
      objective: 'plan-a',
      background: true,
      pluginLaunched: true,
    });
    expect(observed.generation).toBe(first.generation);

    board.registerLaunch({
      taskID: 'ses_p2',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    const foreground = board.registerLaunch({
      taskID: 'ses_p2',
      parentSessionID: 'p1',
      agent: 'explorer',
      preserveRun: true,
      pluginLaunched: true,
      now: 200,
    });
    expect(foreground.pluginLaunched).toBeUndefined();
    expect(foreground.background).toBe(false);

    board.registerLaunch({
      taskID: 'ses_p3',
      parentSessionID: 'p1',
      agent: 'explorer',
      background: true,
      now: 100,
    });
    const adopted = board.registerLaunch({
      taskID: 'ses_p3',
      parentSessionID: 'p1',
      agent: 'explorer',
      background: true,
      preserveRun: true,
      pluginLaunched: true,
      adopted: true,
      now: 200,
    });
    expect(adopted.pluginLaunched).toBeUndefined();

    board.registerLaunch({
      taskID: 'ses_p4',
      parentSessionID: 'p1',
      agent: 'explorer',
      background: true,
      provisional: true,
      now: 100,
    });
    const provisional = board.registerLaunch({
      taskID: 'ses_p4',
      parentSessionID: 'p1',
      agent: 'explorer',
      background: true,
      preserveRun: true,
      pluginLaunched: true,
      now: 200,
    });
    expect(provisional.pluginLaunched).toBeUndefined();
    expect(provisional.provisional).toBe(false);
  });

  test('contract: a relaunch resets run state, keeps metadata fallbacks', () => {
    // A relaunch is a new generation of the same task: dirty run state,
    // terminal evidence, and input anchors die with the old run, empty
    // metadata falls back to the existing record, and the task-local run
    // ordinal advances. Each case seeds non-default state first so the
    // resets are discriminating.
    const board = new BackgroundJobBoard();
    // (a) live run state: heartbeat, timeout overlay, uncertainty.
    const first = board.registerLaunch({
      taskID: 'ses_rl',
      parentSessionID: 'p1',
      agent: 'explorer',
      description: 'old',
      objective: 'plan-a',
      background: true,
      runInputMessageID: 'msg-1',
      now: 100,
    });
    board.markRunningFromLiveSession('ses_rl', 150, first.generation, 0);
    board.updateStatus({
      taskID: 'ses_rl',
      state: 'running',
      timedOut: true,
      now: 200,
    });
    board.markStatusUncertain('ses_rl', 'status error');
    expect(board.get('ses_rl')).toMatchObject({
      activityRevision: 1,
      timedOut: true,
      statusUncertain: true,
    });
    const relaunched = board.registerLaunch({
      taskID: 'ses_rl',
      parentSessionID: 'p1',
      agent: '',
      description: '',
      now: 300,
    });
    expect(relaunched).toMatchObject({
      agent: 'explorer',
      description: 'old',
      objective: 'plan-a',
      background: true,
      state: 'running',
      taskGeneration: 2,
      terminalRevision: 0,
      activityRevision: 0,
      timedOut: false,
      statusUncertain: false,
    });
    expect(relaunched.generation).not.toBe(first.generation);
    // A new generation never inherits the previous run's input anchor.
    expect(relaunched.runInputMessageID).toBeUndefined();
    expect(relaunched.lastLaunchedAt).toBe(300);
    expect(relaunched.runStartedAt).toBe(300);

    // (b) a live-busy recovery flag dies with the run.
    const second = board.registerLaunch({
      taskID: 'ses_rl2',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    board.updateStatus({
      taskID: 'ses_rl2',
      state: 'running',
      timedOut: true,
      now: 150,
    });
    board.markRunningFromLiveSession('ses_rl2', 200, second.generation);
    expect(board.get('ses_rl2')?.recoverableAfterLiveBusy).toBe(true);
    expect(
      board.registerLaunch({
        taskID: 'ses_rl2',
        parentSessionID: 'p1',
        agent: 'explorer',
        now: 300,
      }),
    ).toMatchObject({ recoverableAfterLiveBusy: false });

    // (c) terminal evidence dies with the run.
    board.registerLaunch({
      taskID: 'ses_rl3',
      parentSessionID: 'p1',
      agent: 'explorer',
      background: true,
      now: 100,
    });
    board.markCancelled('ses_rl3', 'user cancelled', 200);
    expect(board.get('ses_rl3')).toMatchObject({
      cancellationRequested: true,
      terminalUnreconciled: true,
    });
    const relaunched3 = board.registerLaunch({
      taskID: 'ses_rl3',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 300,
    });
    expect(relaunched3).toMatchObject({
      cancellationRequested: false,
      terminalUnreconciled: false,
      state: 'running',
      taskGeneration: 2,
      terminalRevision: 0,
      activityRevision: 0,
    });
    expect(relaunched3.completedAt).toBeUndefined();
    expect(relaunched3.resultSummary).toBeUndefined();
    expect(relaunched3.terminalState).toBeUndefined();
  });

  test('contract: launch registration never steals a live lease', () => {
    // A live message lease owns the session, and a relaunch lease
    // naming another generation cannot authorize a registration.
    const board = new BackgroundJobBoard();
    const run = board.registerLaunch({
      taskID: 'ses_l',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    const lease = board.acquireLease('ses_l', run.generation, 'message');
    expect(lease).toBeDefined();
    expect(() =>
      board.registerLaunch({
        taskID: 'ses_l',
        parentSessionID: 'p1',
        agent: 'explorer',
        now: 200,
      }),
    ).toThrow(/already owns this session/);
    expect(() =>
      board.registerLaunch({
        taskID: 'ses_ghost',
        parentSessionID: 'p1',
        agent: 'explorer',
        relaunchLease: {
          taskID: 'ses_ghost',
          generation: 7,
          token: 'stale-token',
          kind: 'relaunch',
        },
        now: 100,
      }),
    ).toThrow(/relaunch lease is missing, stale/);
  });
});

describe('BackgroundJobBoard GAP-HIGH contract pins (#1723) — terminal writes, amendments, resolve', () => {
  // A row whose recoverability was earned by live busy: the timeout
  // observation clears the flag, then markRunningFromLiveSession
  // restores it because the row had timedOut.
  const seedRecoverable = (board: ProductionBoard, taskID: string) => {
    board.registerLaunch({
      taskID,
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    board.updateStatus({ taskID, state: 'running', timedOut: true, now: 200 });
    board.markRunningFromLiveSession(taskID, 300);
  };

  // Terminal-write pins go through the fixture's synchronous commit seam
  // (commitTerminalRecord / markCancelled force), not the terminal-commit
  // token gate.
  test('contract: a terminal write resets timedOut to the input default', () => {
    // applyStatus always publishes `input.timedOut ?? false`, so a completed
    // write clears an earlier timeout; a true literal would leave timedOut
    // set and flip the assertion.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_reset',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    board.updateStatus({
      taskID: 'ses_reset',
      state: 'running',
      timedOut: true,
      now: 200,
    });
    expect(board.get('ses_reset')?.timedOut).toBe(true);
    board.updateStatus({ taskID: 'ses_reset', state: 'completed', now: 300 });
    expect(board.get('ses_reset')?.timedOut).toBe(false);
  });

  test('contract: a plain running update keeps live-busy recoverability', () => {
    // A non-timed-out running publish keeps existing.recoverableAfterLiveBusy;
    // forcing the reset arm would make the recoverable lookup go absent.
    const board = new BackgroundJobBoard();
    seedRecoverable(board, 'ses_busy');
    expect(board.resolveRecoverable('p1', 'ses_busy')?.taskID).toBe('ses_busy');
    board.updateStatus({ taskID: 'ses_busy', state: 'running', now: 400 });
    expect(board.get('ses_busy')?.recoverableAfterLiveBusy).toBe(true);
    expect(board.resolveRecoverable('p1', 'ses_busy')?.taskID).toBe('ses_busy');
  });

  test('contract: a timed-out running update drops recoverability', () => {
    // The inner `input.timedOut === true` arm resets the flag; only a
    // non-timed-out publish takes the preserve arm.
    const board = new BackgroundJobBoard();
    seedRecoverable(board, 'ses_timed_out');
    board.updateStatus({
      taskID: 'ses_timed_out',
      state: 'running',
      timedOut: true,
      now: 400,
    });
    expect(board.get('ses_timed_out')?.recoverableAfterLiveBusy).toBe(false);
  });

  test('contract: a terminal update drops recoverability', () => {
    // The outer `input.state !== 'running' ? false` arm clears the flag on any
    // terminal publish; the true arm would preserve the stale value.
    const board = new BackgroundJobBoard();
    seedRecoverable(board, 'ses_rec_done');
    board.updateStatus({
      taskID: 'ses_rec_done',
      state: 'completed',
      now: 400,
    });
    expect(board.get('ses_rec_done')?.recoverableAfterLiveBusy).toBe(false);
  });

  test('contract: a repeated amendment id is a no-op', () => {
    // noteRunAmendment returns early when the row already carries the message
    // id, so the record object is not re-set and the identity assertion
    // holds.
    const board = new BackgroundJobBoard();
    const run = board.registerLaunch({
      taskID: 'ses_amend',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    const messageID = 'msg_1';
    expect(
      board.noteRunAmendment('ses_amend', run.generation, messageID, 0),
    ).toBe(true);
    const before = board.get('ses_amend');
    expect(
      board.noteRunAmendment('ses_amend', run.generation, messageID, 0),
    ).toBe(true);
    expect(board.get('ses_amend')).toBe(before);
  });

  test('contract: resolve prefers the earliest launch when an alias shadows a task ID', () => {
    // An alias match and a task ID match compete in one scan and the smallest
    // launchedAt wins; taking the last iterated match instead would keep the
    // later-launched restored row.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_first',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    board.restoreRetainedSession({
      taskID: 'ses_second',
      parentSessionID: 'p1',
      agent: 'explorer',
      description: 'restored row',
      state: 'completed',
      background: true,
      alias: 'ses_first',
      launchedAt: 200,
      completedAt: 200,
    });
    expect(board.get('ses_second')?.alias).toBe('ses_first');
    expect(board.resolve('p1', 'ses_first')?.taskID).toBe('ses_first');
  });

  test('contract: resolveReusable refuses another agent', () => {
    // The agent filter is the last refusal: a reusable row is not handed to
    // a different agent; dropping the filter would return it anyway.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_reuse',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    board.updateStatus({ taskID: 'ses_reuse', state: 'completed', now: 200 });
    board.markReconciled('ses_reuse', 300);
    expect(board.resolveReusable('p1', 'ses_reuse', 'oracle')).toBeUndefined();
    expect(board.resolveReusable('p1', 'ses_reuse', 'explorer')?.taskID).toBe(
      'ses_reuse',
    );
  });

  test('contract: resolveRecoverable ignores an unknown id', () => {
    // The missing-row guard returns undefined; dereferencing the absent
    // record would throw.
    const board = new BackgroundJobBoard();
    expect(board.resolveRecoverable('p1', 'ghost')).toBeUndefined();
  });

  test('contract: markUsed ignores an unknown id', () => {
    // The missing-row guard returns without writing; dereferencing the
    // absent record would throw.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_used',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    expect(() => board.markUsed('p1', 'ghost', 500)).not.toThrow();
    expect(board.get('ses_used')?.lastUsedAt).toBe(100);
  });

  test('contract: markUsed on a running row stamps the explicit clock', () => {
    // Without completedAt the use stamps `now` directly; the completedAt + 1
    // branch would write NaN.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_run',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 100,
    });
    board.markUsed('p1', 'ses_run', 500);
    expect(board.get('ses_run')?.lastUsedAt).toBe(500);
  });
});

describe('BackgroundJobBoard GAP-HIGH contract pins (#1723) — stop, reconcile, cancel guards', () => {
  const running = (board: BackgroundJobBoard, taskID = 'ses_run', now = 100) =>
    board.registerLaunch({
      taskID,
      parentSessionID: 'p1',
      agent: 'explorer',
      now,
    });

  // Relaunch the row to a second generation, then publish its completion:
  // the stale-generation and matching-generation cases start from this state.
  const relaunchedCompleted = (
    board: BackgroundJobBoard,
    taskID = 'ses_run',
  ) => {
    const first = running(board, taskID, 100);
    board.registerLaunch({
      taskID,
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 150,
    });
    boardFixture.updateStatus(board, { taskID, state: 'completed', now: 200 });
    const current = board.get(taskID);
    if (!current) throw new Error('missing relaunched row');
    return {
      firstGeneration: first.generation,
      generation: current.generation,
    };
  };

  test('contract: a stopped publication clears timedOut and recoverableAfterLiveBusy', () => {
    // The stop publication retires both flags; writing `true` would leave a
    // timed-out, still-recoverable stopped row.
    const board = new BackgroundJobBoard();
    running(board);
    board.updateStatus({
      taskID: 'ses_run',
      state: 'running',
      timedOut: true,
      now: 150,
    });
    expect(board.get('ses_run')?.timedOut).toBe(true);
    boardFixture.markStopped(
      board,
      'ses_run',
      'host stopped',
      200,
      undefined,
      300,
    );
    const stopped = board.get('ses_run');
    expect(stopped?.state).toBe('stopped');
    expect(stopped?.timedOut).toBe(false);
    expect(stopped?.recoverableAfterLiveBusy).toBe(false);
  });

  test('contract: markStatusUncertain refuses a reconciled reusable row', () => {
    // Only a running row may become uncertain; a reconciled row must stay
    // resolvable as reusable.
    const board = new BackgroundJobBoard();
    running(board);
    boardFixture.updateStatus(board, {
      taskID: 'ses_run',
      state: 'completed',
      now: 200,
    });
    board.markReconciled('ses_run', 250);
    expect(board.resolveReusable('p1', 'ses_run')?.taskID).toBe('ses_run');
    const returned = board.markStatusUncertain('ses_run', 'host went quiet');
    expect(returned?.statusUncertain).toBe(false);
    expect(board.get('ses_run')?.statusUncertain).toBe(false);
    expect(board.resolveReusable('p1', 'ses_run')?.taskID).toBe('ses_run');
  });

  test('contract: markStatusUncertain ignores an unknown id', () => {
    // The optional chain keeps the ghost lookup total; a bare dereference
    // would throw on undefined.
    const board = new BackgroundJobBoard();
    expect(() => board.markStatusUncertain('ghost', 'err')).not.toThrow();
    expect(board.markStatusUncertain('ghost', 'err')).toBeUndefined();
  });

  test('contract: markStatusUncertain refuses a stale generation', () => {
    // The generation fence keeps a stale host observation off the live run; a
    // gen1 write must not mark the gen2 row uncertain.
    const board = new BackgroundJobBoard();
    const first = running(board);
    board.registerLaunch({
      taskID: 'ses_run',
      parentSessionID: 'p1',
      agent: 'explorer',
      now: 150,
    });
    const current = board.get('ses_run');
    expect(current?.generation).not.toBe(first.generation);
    const returned = board.markStatusUncertain(
      'ses_run',
      'stale host error',
      first.generation,
    );
    expect(returned?.statusUncertain).toBe(false);
    expect(board.get('ses_run')?.statusUncertain).toBe(false);
  });

  test('contract: markStatusUncertain accepts the current generation', () => {
    // A pin that matches must let the write through; only stale pins refuse.
    const board = new BackgroundJobBoard();
    running(board);
    const generation = board.get('ses_run')?.generation;
    const returned = board.markStatusUncertain(
      'ses_run',
      'host went quiet',
      generation,
    );
    expect(returned?.statusUncertain).toBe(true);
    expect(board.get('ses_run')?.statusUncertain).toBe(true);
  });

  test('contract: markReconciled ignores an unknown id', () => {
    // The missing-row guard is the only total exit.
    const board = new BackgroundJobBoard();
    expect(() => board.markReconciled('ghost', 500)).not.toThrow();
    expect(board.markReconciled('ghost', 500)).toBeUndefined();
  });

  test('contract: markReconciled refuses a wrong revision pin', () => {
    // A pinned terminal revision that no longer matches must refuse.
    const board = new BackgroundJobBoard();
    running(board);
    boardFixture.updateStatus(board, {
      taskID: 'ses_run',
      state: 'completed',
      now: 200,
    });
    const revision = board.get('ses_run')?.terminalRevision ?? -1;
    const returned = board.markReconciled(
      'ses_run',
      300,
      undefined,
      revision + 1,
    );
    expect(returned?.state).toBe('completed');
    expect(board.get('ses_run')?.state).toBe('completed');
  });

  test('contract: markReconciled refuses a stale generation without a revision pin', () => {
    // A stale generation alone must refuse even with no revision pinned.
    const board = new BackgroundJobBoard();
    const { firstGeneration } = relaunchedCompleted(board);
    const returned = board.markReconciled('ses_run', 300, firstGeneration);
    expect(returned?.state).toBe('completed');
    expect(board.get('ses_run')?.state).toBe('completed');
  });

  test('contract: markReconciled accepts the matching generation', () => {
    // The comparison must accept the live generation, not just refuse stale
    // pins.
    const board = new BackgroundJobBoard();
    const { generation } = relaunchedCompleted(board);
    const returned = board.markReconciled('ses_run', 300, generation);
    expect(returned?.state).toBe('reconciled');
    expect(board.get('ses_run')?.state).toBe('reconciled');
  });

  test('contract: markReconciled accepts a matching terminalRevision', () => {
    // A matching revision pin must let the reconcile through; only drifted
    // pins refuse.
    const board = new BackgroundJobBoard();
    running(board);
    boardFixture.updateStatus(board, {
      taskID: 'ses_run',
      state: 'completed',
      now: 200,
    });
    const revision = board.get('ses_run')?.terminalRevision ?? -1;
    const returned = board.markReconciled('ses_run', 300, undefined, revision);
    expect(returned?.state).toBe('reconciled');
    expect(board.get('ses_run')?.state).toBe('reconciled');
  });

  test('contract: cancellation refuses a presented non-cancellation lease', () => {
    // A presented lease is always validated, so a forged message-scope lease
    // over a row with no live lease must refuse.
    const board = new BackgroundJobBoard();
    running(board);
    const result = board.markCancelled('ses_run', 'stop', 300, {
      cancellationLease: {
        taskID: 'ses_run',
        generation: board.get('ses_run')?.generation ?? -1,
        token: 'forged',
        kind: 'message',
      },
    });
    expect(result?.state).toBe('running');
    expect(board.get('ses_run')?.state).toBe('running');
  });

  test('contract: a stale cancellation lease cannot authorize a cancel', () => {
    // The token check must refuse a cancellation lease that is not live.
    const board = new BackgroundJobBoard();
    running(board);
    const retired = {
      taskID: 'ses_run',
      generation: board.get('ses_run')?.generation ?? -1,
      token: 'retired',
      kind: 'cancellation' as const,
    };
    expect(board.validateLease(retired)).toBe(false);
    const result = board.markCancelled('ses_run', 'stop', 300, {
      cancellationLease: retired,
    });
    expect(result?.state).toBe('running');
    expect(board.get('ses_run')?.state).toBe('running');
  });

  test('contract: a valid message lease on another session cannot authorize a cancel', () => {
    // validateLease accepts a live lease by token/generation/kind, so the kind
    // check is the only thing refusing a message-scope authorization.
    const board = new BackgroundJobBoard();
    running(board, 'ses_target', 100);
    running(board, 'ses_owner', 120);
    const ownerGeneration = board.get('ses_owner')?.generation ?? -1;
    const messageLease = board.acquireLease(
      'ses_owner',
      ownerGeneration,
      'message',
    );
    if (!messageLease) throw new Error('missing message lease');
    expect(board.validateLease(messageLease)).toBe(true);
    const result = board.markCancelled('ses_target', 'stop', 300, {
      cancellationLease: messageLease,
    });
    expect(result?.state).toBe('running');
    expect(board.get('ses_target')?.state).toBe('running');
  });

  test('contract: a live message lease on the row refuses a cancel with no lease', () => {
    // The active-lease fence is not optional; skipping it would cancel a row
    // whose message-scope operation owns it.
    const board = new BackgroundJobBoard();
    const run = running(board);
    const lease = board.acquireLease('ses_run', run.generation, 'message');
    if (!lease) throw new Error('missing message lease');
    const result = board.markCancelled('ses_run', 'stop', 300);
    expect(result?.state).toBe('running');
    expect(board.get('ses_run')?.state).toBe('running');
    expect(board.validateLease(lease)).toBe(true);
  });

  test('contract: a live cancellation lease must be presented by token', () => {
    // Owning a live cancellation lease is not authority to cancel without
    // presenting it.
    const board = new BackgroundJobBoard();
    const run = running(board);
    const lease = board.acquireLease('ses_run', run.generation, 'cancellation');
    if (!lease) throw new Error('missing cancellation lease');
    const result = board.markCancelled('ses_run', 'stop', 300);
    expect(result?.state).toBe('running');
    expect(board.get('ses_run')?.state).toBe('running');
    expect(board.validateLease(lease)).toBe(true);
  });

  test('contract: a successful cancel clears recoverableAfterLiveBusy and statusUncertain', () => {
    // The cancel publication retires both flags; leaving them set would keep
    // the cancelled row recoverable and status-uncertain.
    const board = new BackgroundJobBoard();
    running(board);
    board.updateStatus({
      taskID: 'ses_run',
      state: 'running',
      timedOut: true,
      now: 150,
    });
    board.markRunningFromLiveSession('ses_run', 200);
    expect(board.get('ses_run')?.recoverableAfterLiveBusy).toBe(true);
    board.markStatusUncertain('ses_run', 'host unreachable');
    expect(board.get('ses_run')?.statusUncertain).toBe(true);
    const cancelled = board.markCancelled('ses_run', 'host stopped', 300);
    expect(cancelled?.state).toBe('cancelled');
    expect(board.get('ses_run')?.recoverableAfterLiveBusy).toBe(false);
    expect(board.get('ses_run')?.statusUncertain).toBe(false);
  });
});

describe('BackgroundJobBoard GAP-HIGH contract pins (#1723) — lease lifecycle', () => {
  const running = (board: BackgroundJobBoard, taskID = 'ses_run', now = 100) =>
    board.registerLaunch({
      taskID,
      parentSessionID: 'p1',
      agent: 'explorer',
      now,
    });

  const completed = (board: BackgroundJobBoard, taskID = 'ses_run') => {
    running(board, taskID, 100);
    boardFixture.updateStatus(board, { taskID, state: 'completed', now: 200 });
    const row = board.get(taskID);
    if (!row) throw new Error('missing completed row');
    return row;
  };

  test('contract: acquireLease refuses a task the board has never seen', () => {
    // An unknown task must never receive a lease; a ghost row would be left in
    // the live-lease index.
    const board = new BackgroundJobBoard();
    expect(board.acquireLease('ghost', 1, 'relaunch')).toBeUndefined();
    expect(board.isTracked('ghost')).toBe(false);
  });

  test('contract: acquireLease refuses a mismatched generation on an existing row', () => {
    // The generation fence applies to existing rows; a stale-generation lease
    // would block the correct-generation acquire that follows.
    const board = new BackgroundJobBoard();
    const run = running(board);
    expect(
      board.acquireLease('ses_run', run.generation + 1, 'relaunch'),
    ).toBeUndefined();
    const lease = board.acquireLease('ses_run', run.generation, 'relaunch');
    if (!lease) throw new Error('missing relaunch lease');
    expect(lease.generation).toBe(run.generation);
    expect(board.validateLease(lease)).toBe(true);
  });

  test('contract: acquireLease refuses cancellation on a completed row', () => {
    // The cancellation/message branch requires a live run; a lease issued for a
    // completed row would block the relaunch acquire below.
    const board = new BackgroundJobBoard();
    const row = completed(board);
    expect(
      board.acquireLease('ses_run', row.generation, 'cancellation'),
    ).toBeUndefined();
    expect(
      board.acquireLease('ses_run', row.generation, 'relaunch')?.taskID,
    ).toBe('ses_run');
  });

  test('contract: acquireLease refuses terminal-notification while the run is live', () => {
    // A terminal-publication lease requires terminal evidence; without it a
    // running row would get leased.
    const board = new BackgroundJobBoard();
    const run = running(board);
    expect(
      board.acquireLease('ses_run', run.generation, 'terminal-notification'),
    ).toBeUndefined();
    expect(
      board.acquireLease('ses_run', run.generation, 'relaunch')?.taskID,
    ).toBe('ses_run');
  });

  test('contract: acquireLease refuses terminal-notification pinned to the wrong terminalRevision', () => {
    // A revision-pinned lease must match the row's current terminalRevision; a
    // mismatched pin would lease a stale publication.
    const board = new BackgroundJobBoard();
    const row = completed(board);
    expect(row.terminalRevision).toBe(1);
    expect(
      board.acquireLease('ses_run', row.generation, 'terminal-notification', {
        terminalRevision: row.terminalRevision - 1,
      }),
    ).toBeUndefined();
    const lease = board.acquireLease(
      'ses_run',
      row.generation,
      'terminal-notification',
      { terminalRevision: row.terminalRevision },
    );
    if (!lease) throw new Error('missing terminal-notification lease');
    expect(lease.terminalRevision).toBe(row.terminalRevision);
  });

  test('contract: a cancellation lease carries no terminalRevision property', () => {
    // Only terminal-notification leases carry the pin; the cancellation lease
    // shape must not attach terminalRevision.
    const board = new BackgroundJobBoard();
    const run = running(board);
    const lease = board.acquireLease('ses_run', run.generation, 'cancellation');
    if (!lease) throw new Error('missing cancellation lease');
    expect('terminalRevision' in lease).toBe(false);
  });

  test('contract: validateLease rejects a lease whose generation drifted', () => {
    // The generation comparison is load bearing.
    const board = new BackgroundJobBoard();
    const run = running(board);
    const lease = board.acquireLease('ses_run', run.generation, 'relaunch');
    if (!lease) throw new Error('missing relaunch lease');
    expect(board.validateLease(lease)).toBe(true);
    expect(
      board.validateLease({ ...lease, generation: run.generation + 1 }),
    ).toBe(false);
  });

  test('contract: validateLease rejects a lease whose kind drifted', () => {
    // The kind comparison is load bearing.
    const board = new BackgroundJobBoard();
    const run = running(board);
    const lease = board.acquireLease('ses_run', run.generation, 'relaunch');
    if (!lease) throw new Error('missing relaunch lease');
    expect(board.validateLease(lease)).toBe(true);
    expect(board.validateLease({ ...lease, kind: 'message' })).toBe(false);
  });

  test('contract: validateLease returns false after the leased row is dropped', () => {
    // Validating a pin lease whose row was dropped must be false, not a throw.
    const board = new BackgroundJobBoard();
    const row = completed(board);
    const lease = board.acquireLease(
      'ses_run',
      row.generation,
      'terminal-notification',
    );
    if (!lease) throw new Error('missing terminal-notification lease');
    board.drop('ses_run');
    expect(board.get('ses_run')).toBeUndefined();
    expect(() => board.validateLease(lease)).not.toThrow();
    expect(board.validateLease(lease)).toBe(false);
  });

  test('contract: releaseLease refuses a lease presented under another kind', () => {
    // The kind fence protects the live slot; a retyped lease would free the
    // slot and let the second acquire succeed.
    const board = new BackgroundJobBoard();
    const run = running(board);
    const lease = board.acquireLease('ses_run', run.generation, 'cancellation');
    if (!lease) throw new Error('missing cancellation lease');
    expect(board.releaseLease({ ...lease, kind: 'message' })).toBe(false);
    expect(board.validateLease(lease)).toBe(true);
    expect(
      board.acquireLease('ses_run', run.generation, 'cancellation'),
    ).toBeUndefined();
  });

  test('contract: releaseLease refuses a terminal-notification lease with a drifted terminalRevision', () => {
    // The terminalRevision fence is load bearing; a drifted pin would free the
    // live slot.
    const board = new BackgroundJobBoard();
    const row = completed(board);
    const lease = board.acquireLease(
      'ses_run',
      row.generation,
      'terminal-notification',
    );
    if (!lease) throw new Error('missing terminal-notification lease');
    expect(lease.terminalRevision).toBe(row.terminalRevision);
    expect(
      board.releaseLease({
        ...lease,
        terminalRevision: row.terminalRevision - 1,
      }),
    ).toBe(false);
    expect(board.validateLease(lease)).toBe(true);
  });
});

describe('BackgroundJobBoard GAP-HIGH contract pins (#1723) — recoverable terminal rows', () => {
  test('contract: resolveRecoverable refuses a terminal row that kept live-busy recoverability', () => {
    // The state half of the guard is load bearing even when the recoverability
    // flag is set: correctStartupRecoveredTerminal retires a run without
    // clearing recoverableAfterLiveBusy (it spreads ...existing), so a terminal
    // row can carry the flag.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ext',
      parentSessionID: 'p1',
      agent: 'explorer',
      adopted: true,
      now: 100,
    });
    board.updateStatus({
      taskID: 'ses_ext',
      state: 'running',
      timedOut: true,
      now: 200,
    });
    board.markRunningFromLiveSession('ses_ext', 300);
    expect(board.get('ses_ext')?.recoverableAfterLiveBusy).toBe(true);
    const corrected = board.correctStartupRecoveredTerminal({
      taskID: 'ses_ext',
      generation: board.get('ses_ext')?.generation ?? -1,
      state: 'completed',
      now: 400,
    });
    expect(corrected?.state).toBe('completed');
    expect(board.get('ses_ext')?.recoverableAfterLiveBusy).toBe(true);
    expect(board.resolveRecoverable('p1', 'ses_ext')).toBeUndefined();
  });
});
