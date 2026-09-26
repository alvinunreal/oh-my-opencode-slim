import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { parseTaskStatusOutput } from '../utils';
import { BackgroundJobBoard as ProductionBoard } from '../utils/background-job-board';
import { BackgroundJobBoard } from '../utils/background-job-fixture';
import { createCancelTaskTool } from './cancel-task';

let mockClient: Record<string, unknown>;

function createTool(overrides?: {
  abort?: () => Promise<unknown>;
  status?: (() => Promise<unknown>) | null;
  get?: () => Promise<unknown>;
  shouldManageSession?: (sessionID: string) => boolean;
  abortTimeoutMs?: number;
  verifyAbortMs?: number;
  abortRetryIntervalMs?: number;
  stableStoppedMs?: number;
}) {
  const board = new BackgroundJobBoard();
  const abort = mock(overrides?.abort ?? (async () => ({})));
  const status =
    overrides?.status === null
      ? undefined
      : mock(
          overrides?.status ??
            (async () => ({ data: { ses_1: { type: 'idle' } } })),
        );
  const getSession = mock(overrides?.get ?? (async () => ({})));
  const deleteSession = mock(async () => ({}));
  mockClient = {
    session: { abort, status, get: getSession, delete: deleteSession },
  };
  const tools = createCancelTaskTool({
    input: { directory: '/test/project', client: mockClient } as any,
    backgroundJobBoard: board,
    shouldManageSession: overrides?.shouldManageSession ?? (() => true),
    abortTimeoutMs: overrides?.abortTimeoutMs,
    verifyAbortMs: overrides?.verifyAbortMs ?? 10,
    abortRetryIntervalMs: overrides?.abortRetryIntervalMs ?? 0,
    stableStoppedMs: overrides?.stableStoppedMs ?? 0,
  });
  return {
    board,
    abort,
    status,
    getSession,
    deleteSession,
    taskCancel: tools.task_cancel,
  };
}

const context = { sessionID: 'parent-1', agent: 'orchestrator' } as any;

afterEach(() => mock.restore());

describe('task_cancel tool', () => {
  test('aborts and verifies quiescence without deleting the retained session', async () => {
    const { board, abort, status, deleteSession, taskCancel } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const output = await taskCancel.execute(
      { task_id: 'ses_1', reason: 'obsolete' },
      context,
    );

    expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(status).toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(parseTaskStatusOutput(String(output))).toMatchObject({
      taskID: 'ses_1',
      state: 'cancelled',
      result: 'cancelled: obsolete',
    });
    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      terminalUnreconciled: true,
    });
  });

  test('verifies quiescence via host session info when the status map is unavailable (v2)', async () => {
    // v2 hosts expose no session.status map; the old verify loop polled a
    // source that can never answer 'idle' and always threw "did not stay
    // stopped" — even after a confirmed abort. Verification must fall back
    // to the host session info (terminal outcome / fresh idle timestamp).
    const board = new BackgroundJobBoard();
    const abort = mock(async () => ({}));
    const getSession = mock(async () => ({
      data: { outcome: 'interrupted', time: { idle: Date.now() } },
    }));
    mockClient = {
      session: { abort, get: getSession, delete: mock(async () => ({})) },
    };
    const tools = createCancelTaskTool({
      input: { directory: '/test/project', client: mockClient } as any,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      verifyAbortMs: 10,
      abortRetryIntervalMs: 0,
      stableStoppedMs: 0,
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const output = await tools.task_cancel.execute(
      { task_id: 'ses_1', reason: 'obsolete' },
      context,
    );

    expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(getSession).toHaveBeenCalled();
    expect(parseTaskStatusOutput(String(output))).toMatchObject({
      taskID: 'ses_1',
      state: 'cancelled',
    });
  });

  test.each(['pending', 'resolve', 'reject', 'blocked response'])(
    'bounds a host-info read after abort without consuming late evidence: %s',
    async (settlement) => {
      const read = Promise.withResolvers<unknown>();
      const evidenceRead = mock(() => 'interrupted');
      const dataRead = mock(() => ({
        get outcome() {
          return evidenceRead();
        },
      }));
      const response = {
        get data() {
          return dataRead();
        },
      };
      const { board, abort, getSession, taskCancel } = createTool({
        status: null,
        get: () => {
          if (settlement === 'blocked response') {
            const until = Date.now() + 25;
            while (Date.now() < until) {
              // Occupy the real event loop: the deadline timer cannot run.
            }
            read.resolve(response);
          }
          return read.promise;
        },
        verifyAbortMs: 5,
        // A timed-out read must not spend another polling interval.
        abortRetryIntervalMs: 100,
      });
      board.registerLaunch({
        taskID: 'ses_1',
        parentSessionID: 'parent-1',
        agent: 'explorer',
      });
      const commit = spyOn(ProductionBoard.prototype, 'commitTerminal');
      const acquire = spyOn(
        ProductionBoard.prototype,
        'acquireCancellationLease',
      );
      const pending = taskCancel.execute({ task_id: 'ses_1' }, context);
      const output = await Promise.race([
        pending,
        Bun.sleep(25).then(() => undefined),
      ]);
      // External assertions: production must not catch these failures.
      expect(output).toBeDefined();
      expect(String(output)).toContain('state: running');
      expect(String(output)).toContain('host-info');
      expect(String(output)).toContain('timed out');
      expect(abort).toHaveBeenCalledTimes(1);
      expect(getSession).toHaveBeenCalledTimes(1);
      expect(board.get('ses_1')).toMatchObject({
        generation: 1,
        state: 'running',
        statusUncertain: true,
        terminalUnreconciled: false,
      });
      expect(commit).not.toHaveBeenCalled();
      const oldLease = acquire.mock.results[0]?.value;
      if (!oldLease) throw new Error('missing cancellation lease');
      expect(board.validateLease(oldLease)).toBe(false);
      const replacement = board.acquireCancellationLease('ses_1', 1);
      expect(replacement).toBeDefined();
      if (!replacement) throw new Error('read timeout retained exclusion');
      const uncertain = board.get('ses_1');
      if (settlement === 'resolve') read.resolve(response);
      if (settlement === 'reject') read.reject(new Error('late read failure'));
      await Bun.sleep(0);
      expect(dataRead).not.toHaveBeenCalled();
      expect(evidenceRead).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(board.get('ses_1')).toEqual(uncertain);
      expect(board.validateLease(replacement)).toBe(true);
      board.releaseLease(replacement);
      const relaunch = board.acquireRelaunchLease('ses_1', 1);
      expect(relaunch).toBeDefined();
      if (relaunch) board.releaseLease(relaunch);
    },
  );

  test.each(['inconclusive', 'error'])(
    'caps host-info polling to the remaining verification budget: %s',
    async (result) => {
      const verifyAbortMs = 5;
      const { board, taskCancel } = createTool({
        status: null,
        get: async () => {
          if (result === 'error') throw new Error('lookup failed');
          return { data: {} };
        },
        verifyAbortMs,
        abortRetryIntervalMs: 100,
      });
      board.registerLaunch({
        taskID: 'ses_1',
        parentSessionID: 'parent-1',
        agent: 'explorer',
      });
      const commit = spyOn(ProductionBoard.prototype, 'commitTerminal');
      const started = performance.now();
      const output = await taskCancel.execute({ task_id: 'ses_1' }, context);
      expect(performance.now() - started).toBeLessThanOrEqual(
        verifyAbortMs + 25,
      );
      expect(String(output)).toContain('state: running');
      expect(board.get('ses_1')).toMatchObject({ statusUncertain: true });
      expect(commit).not.toHaveBeenCalled();
      const available = board.acquireRelaunchLease('ses_1', 1);
      expect(available).toBeDefined();
      if (available) board.releaseLease(available);
    },
  );

  test.each(['revoked', 'dropped', 'completed', 'generation changed'])(
    'revalidates a deferred abort after ownership is %s',
    async (change) => {
      const { board, abort, status, taskCancel } = createTool({
        abort: () => new Promise(() => {}),
        abortTimeoutMs: 5,
      });
      board.registerLaunch({
        taskID: 'ses_1',
        parentSessionID: 'parent-1',
        agent: 'explorer',
      });
      const commit = spyOn(ProductionBoard.prototype, 'commitTerminal');
      const acquire = spyOn(
        ProductionBoard.prototype,
        'acquireCancellationLease',
      );
      const pending = taskCancel.execute({ task_id: 'ses_1' }, context);
      const lease = acquire.mock.results[0]?.value;
      if (!lease) throw new Error('missing cancellation lease');
      // No await: mutate after the chain is created but before its callback.
      let replacement: typeof lease | undefined;
      if (change === 'dropped') board.drop('ses_1');
      else if (change === 'completed') {
        board.updateStatus({ taskID: 'ses_1', state: 'completed' });
      } else {
        board.releaseLease(lease);
        if (change === 'generation changed')
          board.registerLaunch({
            taskID: 'ses_1',
            parentSessionID: 'parent-1',
            agent: 'explorer',
          });
        replacement = board.acquireCancellationLease(
          'ses_1',
          board.get('ses_1')?.generation ?? -1,
        );
        expect(replacement).toBeDefined();
      }
      const output = await pending;
      expect(String(output)).toMatch(
        /lease is no longer valid|stale\/uncertain cancellation/,
      );
      expect(abort).not.toHaveBeenCalled();
      expect(status).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(board.validateLease(lease)).toBe(false);
      if (change === 'completed') {
        expect(board.get('ses_1')).toMatchObject({
          generation: 1,
          state: 'completed',
        });
        const notification = board.acquireTerminalNotificationLease('ses_1', 1);
        expect(notification).toBeDefined();
        if (notification) board.releaseLease(notification);
      }
      if (change === 'generation changed') {
        expect(board.get('ses_1')).toMatchObject({
          generation: 2,
          statusUncertain: false,
        });
      }
      if (replacement) {
        expect(board.validateLease(replacement)).toBe(true);
        board.releaseLease(replacement);
      }
      if (change === 'dropped')
        board.registerLaunch({
          taskID: 'ses_1',
          parentSessionID: 'parent-1',
          agent: 'explorer',
        });
      const available = board.acquireRelaunchLease(
        'ses_1',
        board.get('ses_1')?.generation ?? -1,
      );
      expect(available).toBeDefined();
      if (available) board.releaseLease(available);
    },
  );

  test.each(['pending', 'resolve', 'reject'])(
    'quarantines a pending abort; late %s never resumes verification',
    async (settlement) => {
      const transport = Promise.withResolvers<unknown>();
      const { board, abort, status, getSession, taskCancel } = createTool({
        abort: () => transport.promise,
        abortTimeoutMs: 5,
      });
      board.registerLaunch({
        taskID: 'ses_1',
        parentSessionID: 'parent-1',
        agent: 'explorer',
      });
      const commit = spyOn(ProductionBoard.prototype, 'commitTerminal');
      const acquire = spyOn(
        ProductionBoard.prototype,
        'acquireCancellationLease',
      );
      const output = await taskCancel.execute({ task_id: 'ses_1' }, context);
      expect(String(output)).toContain('Session abort timed out after 5ms');
      expect(String(output)).toContain('state: running');
      expect(abort).toHaveBeenCalledTimes(1);
      expect(status).not.toHaveBeenCalled();
      expect(getSession).not.toHaveBeenCalled();
      expect(board.get('ses_1')).toMatchObject({
        generation: 1,
        state: 'running',
        statusUncertain: true,
        terminalUnreconciled: false,
      });
      const lease = acquire.mock.results[0]?.value;
      if (!lease) throw new Error('missing cancellation lease');
      expect(board.validateLease(lease)).toBe(true);
      expect(board.acquireCancellationLease('ses_1', 1)).toBeUndefined();
      expect(board.acquireMessageLease('ses_1', 1)).toBeUndefined();
      expect(board.acquireRelaunchLease('ses_1', 1)).toBeUndefined();
      expect(commit).not.toHaveBeenCalled();
      if (settlement === 'pending') {
        board.updateStatus({ taskID: 'ses_1', state: 'completed' });
        expect(board.get('ses_1')?.state).toBe('completed');
        expect(board.validateLease(lease)).toBe(true);
        expect(
          board.acquireTerminalNotificationLease('ses_1', 1),
        ).toBeUndefined();
        expect(board.acquireRelaunchLease('ses_1', 1)).toBeUndefined();
        return;
      }
      const uncertain = board.get('ses_1');
      if (settlement === 'resolve') transport.resolve({});
      else transport.reject(new Error('late abort failure'));
      await Bun.sleep(0);
      expect(status).not.toHaveBeenCalled();
      expect(getSession).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(board.get('ses_1')).toEqual(uncertain);
      expect(board.validateLease(lease)).toBe(false);
      const available = board.acquireCancellationLease('ses_1', 1);
      expect(available).toBeDefined();
      if (available) board.releaseLease(available);
      const relaunch = board.acquireRelaunchLease('ses_1', 1);
      expect(relaunch).toBeDefined();
      if (relaunch) board.releaseLease(relaunch);
    },
  );

  test('an unrecognized outcome string needs idle evidence to confirm cancellation (v2)', async () => {
    // P2 review on #1161: only the known terminal outcomes (succeeded/
    // failed/interrupted) confirm quiescence on their own. A malformed or
    // future nonterminal value must fall through to the idle-timestamp
    // evidence instead of blindly confirming the cancel.
    const run = async (idleAt: number | undefined) => {
      const board = new BackgroundJobBoard();
      const abort = mock(async () => ({}));
      const getSession = mock(async () => ({
        data: { outcome: 'some-new-nonterminal-value', time: { idle: idleAt } },
      }));
      mockClient = {
        session: { abort, get: getSession, delete: mock(async () => ({})) },
      };
      const tools = createCancelTaskTool({
        input: { directory: '/test/project', client: mockClient } as any,
        backgroundJobBoard: board,
        shouldManageSession: () => true,
        verifyAbortMs: 10,
        abortRetryIntervalMs: 0,
        stableStoppedMs: 0,
      });
      board.registerLaunch({
        taskID: 'ses_1',
        parentSessionID: 'parent-1',
        agent: 'explorer',
      });
      return tools.task_cancel.execute(
        { task_id: 'ses_1', reason: 'obsolete' },
        context,
      );
    };

    // Fresh idle timestamp (at/after abort) → confirmed via idle evidence.
    const confirmed = await run(Date.now() + 5_000);
    expect(parseTaskStatusOutput(String(confirmed))).toMatchObject({
      taskID: 'ses_1',
      state: 'cancelled',
    });

    // Stale idle timestamp → cannot verify → the cancel surfaces the
    // uncertain-running result instead of confirming.
    const unverified = await run(Date.now() - 60_000);
    expect(parseTaskStatusOutput(String(unverified))).toMatchObject({
      taskID: 'ses_1',
      state: 'running',
    });
  });

  test('a valid status map without an entry confirms quiescence after abort (activity-map contract)', async () => {
    // False-stop incident follow-up: the host's status map REMOVES a
    // session's entry when it goes idle, so "map received correctly, no
    // entry for this session" is quiescence evidence — the old verify
    // loop threw "did not stay stopped: unknown" on it.
    const { board, taskCancel } = createTool({
      status: async () => ({ data: {} }), // valid map, no ses_1 entry
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const output = await taskCancel.execute(
      { task_id: 'ses_1', reason: 'obsolete' },
      context,
    );

    expect(parseTaskStatusOutput(String(output))).toMatchObject({
      taskID: 'ses_1',
      state: 'cancelled',
    });
  });

  test('busy between absences restarts the quiescence stability window', async () => {
    // Deterministic reset proof: alternating
    // absence/busy lookups never let the stability window mature —
    // without the reset, the stale quiet timestamp from the FIRST
    // absence would confirm once verifyAbortMs elapses. With the reset,
    // every busy observation restarts the window and the cancel ends
    // uncertain-running instead of falsely cancelled.
    let lookups = 0;
    const { board, taskCancel } = createTool({
      verifyAbortMs: 150,
      abortRetryIntervalMs: 0,
      stableStoppedMs: 60,
      status: async () => {
        lookups += 1;
        return lookups % 2 === 0
          ? { data: { ses_1: { type: 'busy' } } }
          : { data: {} };
      },
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const output = await taskCancel.execute(
      { task_id: 'ses_1', reason: 'obsolete' },
      context,
    );

    expect(String(output)).toContain('state: running');
    expect(board.get('ses_1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
  });

  test('retains the session and leaves it resumable after acknowledgement', async () => {
    const { board, deleteSession, taskCancel } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    await taskCancel.execute({ task_id: 'ses_1' }, context);
    board.markReconciled('ses_1');

    expect(board.get('ses_1')).toMatchObject({
      taskID: 'ses_1',
      state: 'reconciled',
      terminalState: 'cancelled',
    });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(board.acquireRelaunchLease('ses_1', 1)).toBeDefined();
  });

  test('returns an uncertain running result when quiescence cannot be verified', async () => {
    const { board, taskCancel } = createTool({
      status: async () => ({ data: { ses_1: { type: 'busy' } } }),
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const output = await taskCancel.execute({ task_id: 'ses_1' }, context);

    expect(String(output)).toContain('state: running');
    expect(board.get('ses_1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
  });

  test('rejects foreign, stale, and unsafe cancellation requests', async () => {
    const { board, abort, taskCancel } = createTool();
    board.registerLaunch({
      taskID: 'ses_foreign',
      parentSessionID: 'parent-2',
      agent: 'explorer',
    });
    board.registerLaunch({
      taskID: 'ses_done',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({ taskID: 'ses_done', state: 'completed' });

    const foreign = await taskCancel.execute(
      { task_id: 'ses_foreign' },
      context,
    );
    const stale = await taskCancel.execute({ task_id: 'ses_done' }, context);
    const parent = await taskCancel.execute(
      { task_id: 'ses_parent' },
      { ...context, sessionID: 'ses_parent' },
    );

    expect(abort).not.toHaveBeenCalled();
    expect(String(foreign)).toContain('state: unknown');
    expect(String(stale)).toContain('stale/uncertain cancellation');
    expect(String(parent)).toContain('cannot cancel parent session');
  });

  test('enforces orchestrator ownership', async () => {
    const { taskCancel } = createTool({ shouldManageSession: () => false });

    await expect(
      taskCancel.execute({ task_id: 'ses_1' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('orchestrator sessions');
    await expect(
      taskCancel.execute({ task_id: 'ses_1' }, {
        sessionID: 'parent-1',
        agent: 'fixer',
      } as any),
    ).rejects.toThrow('orchestrator');
  });
});
