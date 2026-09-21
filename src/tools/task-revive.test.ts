import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import { createOpencodeClient } from '@opencode-ai/sdk';
import {
  createRevivedRunTracker,
  type RevivedRunTracker,
} from '../hooks/task-session-manager/revived-run-tracker';
import { BackgroundJobBoard as ProductionBoard } from '../utils/background-job-board';
import { BackgroundJobBoard } from '../utils/background-job-fixture';
import { getBackgroundJobLifecycleLedger } from '../utils/background-job-store';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
} from '../utils/background-job-terminal-gate';
import * as logger from '../utils/logger';
import * as opencodeClient from '../utils/opencode-client';
import { OperationTimeoutError } from '../utils/session';
import { createCancelTaskTool } from './cancel-task';
import { createTaskReviveTool } from './task-revive';

const gates: BackgroundJobTerminalGate[] = [];

function createTool(overrides?: {
  abort?: () => Promise<unknown>;
  status?: () => Promise<unknown>;
  /** v2 hosts expose no session.status map at all (see client-shim.ts). */
  omitStatus?: boolean;
  /** v2 wait capability injected as experimental_v2.waitForSessionIdle. */
  waitIdle?: () => Promise<void>;
  promptAsync?: () => Promise<unknown>;
  messages?: () => Promise<unknown>;
  baselineTimeoutMs?: number;
  admissionTimeoutMs?: number;
  onLaunch?: () => void;
  revivedRunTracker?: Partial<RevivedRunTracker>;
}) {
  const board = new BackgroundJobBoard();
  const abort = mock(overrides?.abort ?? (async () => ({})));
  const status = mock(
    overrides?.status ?? (async () => ({ data: { ses_1: { type: 'idle' } } })),
  );
  const promptAsync = mock(overrides?.promptAsync ?? (async () => ({})));
  const waitIdle = overrides?.waitIdle ? mock(overrides.waitIdle) : undefined;
  const input = {
    directory: '/test/project',
    ...(waitIdle ? { experimental_v2: { waitForSessionIdle: waitIdle } } : {}),
    client: {
      session: {
        abort,
        status: overrides?.omitStatus ? undefined : status,
        promptAsync,
        messages: overrides?.messages,
      },
    },
  } as never;
  const terminalGate = createBackgroundJobTerminalGate({
    backgroundJobBoard: board,
    input,
  });
  gates.push(terminalGate);
  const revivedRunTracker = Object.assign(
    createRevivedRunTracker({
      input,
      backgroundJobBoard: board,
      terminalGate,
    }),
    overrides?.revivedRunTracker,
  );
  const onLaunch = mock(overrides?.onLaunch ?? (() => {}));
  const tools = createTaskReviveTool({
    input,
    backgroundJobBoard: board,
    shouldManageSession: () => true,
    verifyAbortMs: 10,
    abortRetryIntervalMs: 0,
    stableStoppedMs: 0,
    revivedRunTracker,
    backgroundJobSupervisor: { onLaunch } as never,
    baselineTimeoutMs: overrides?.baselineTimeoutMs,
    admissionTimeoutMs: overrides?.admissionTimeoutMs,
  });
  const cancelTools = createCancelTaskTool({
    input,
    backgroundJobBoard: board,
    terminalGate,
    shouldManageSession: () => true,
    verifyAbortMs: 10,
    abortRetryIntervalMs: 0,
    stableStoppedMs: 0,
  });
  return {
    board,
    abort,
    status,
    waitIdle,
    promptAsync,
    revivedRunTracker,
    onLaunch,
    taskCancel: cancelTools.task_cancel,
    taskRevive: tools.task_revive,
  };
}

const context = { sessionID: 'parent-1', agent: 'orchestrator' } as any;

beforeEach(() => {
  // Other suites can leave module mocks installed. Override only for this
  // test; mock.restore below restores the previous implementation afterward.
  spyOn(opencodeClient, 'getClient').mockImplementation(
    (input) => input.client,
  );
});

afterEach(() => {
  for (const gate of gates.splice(0)) gate.dispose();
  mock.restore();
});

function acknowledgedCompleted(board: BackgroundJobBoard, taskID = 'ses_1') {
  board.registerLaunch({
    taskID,
    parentSessionID: 'parent-1',
    agent: 'explorer',
  });
  board.updateStatus({ taskID, state: 'completed', resultSummary: 'done' });
  board.markReconciled(taskID);
}

function stoppedSession(
  board: BackgroundJobBoard,
  taskID = 'ses_1',
  acknowledge = false,
) {
  board.registerLaunch({
    taskID,
    parentSessionID: 'parent-1',
    agent: 'explorer',
    now: 100,
  });
  board.markStopped(taskID, 'no native result', 110, undefined, 110);
  if (acknowledge) board.markReconciled(taskID);
}

function controlledAdmissionDeadline() {
  const ready = Promise.withResolvers<() => void>();
  const timers = new Map<number, () => void>();
  let nextID = 0;
  spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    ms: number,
  ) => {
    const id = ++nextID;
    const fire = () => {
      timers.delete(id);
      callback();
    };
    timers.set(id, fire);
    if (ms === 1_000) ready.resolve(fire);
    return id;
  }) as typeof setTimeout);
  spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => {
    timers.delete(id);
  }) as typeof clearTimeout);
  return {
    ready: ready.promise,
    fireRemaining: () => {
      for (const fire of timers.values()) fire();
    },
  };
}

describe('task_revive tool', () => {
  test.each([
    ['early', 'idle'],
    ['early', 'rejected'],
    ['early', 'error response'],
    ['late', 'rejected'],
    ['late', 'error response'],
    ...[
      'idle',
      'absent',
      'pending',
      'abort rejected',
      'abort error',
      'abort throw',
      'status rejected',
      'status error',
      'malformed',
      'busy',
      'retry',
      'status timeout',
      'replaced during abort',
      'replaced during read',
    ].map((outcome) => ['late', outcome]),
  ])('deleted admission %s: %s', async (timing, outcome) => {
    const deadline = controlledAdmissionDeadline();
    const send = Promise.withResolvers<unknown>();
    const stop = Promise.withResolvers<unknown>();
    const read = Promise.withResolvers<unknown>();
    const reading = Promise.withResolvers<void>();
    const admissionLogged = Promise.withResolvers<void>();
    const compensated = Promise.withResolvers<void>();
    const log = spyOn(logger, 'log').mockImplementation((message) => {
      if (message === '[task-revive] admission failed')
        admissionLogged.resolve();
      if (message.startsWith('[task-revive] compensation '))
        compensated.resolve();
    });
    const fixture = createTool({
      admissionTimeoutMs: 1_000,
      promptAsync: () => send.promise,
      abort: () => {
        if (outcome === 'abort throw') throw new Error('abort failed');
        return stop.promise;
      },
    });
    const { board, taskRevive, abort, status, promptAsync, onLaunch } = fixture;
    acknowledgedCompleted(board);
    const acquire = spyOn(ProductionBoard.prototype, 'acquireRelaunchLease');
    const release = spyOn(ProductionBoard.prototype, 'releaseLease');
    const launch = spyOn(ProductionBoard.prototype, 'registerLaunch');
    const register = spyOn(fixture.revivedRunTracker, 'register');
    const probe = spyOn(fixture.revivedRunTracker, 'probe');
    const terminal = mock(() => {});
    board.addTerminalStateListener(terminal);
    const result = taskRevive
      .execute({ task_id: 'ses_1', prompt: 'continue' }, context)
      .then(String, (error: Error) => error);
    const fireDeadline = await deadline.ready;
    const lease = acquire.mock.results[0]?.value;
    if (!lease) throw new Error('missing relaunch lease');
    if (timing === 'late') {
      fireDeadline();
      expect(await result).toContain('status: admission_unknown');
    }
    board.drop('ses_1');
    const tombstones = getBackgroundJobLifecycleLedger(board).tombstones;
    expect(tombstones.has('ses_1')).toBe(true);
    status.mockImplementation(() => {
      reading.resolve();
      return read.promise;
    });
    const rejected = ['rejected', 'error response'].includes(outcome);
    if (outcome === 'rejected') send.reject(new Error('host refused'));
    else send.resolve(rejected ? { error: 'host refused' } : {});
    await admissionLogged.promise;
    if (timing === 'early') {
      expect(String(await result)).toContain(
        rejected
          ? 'host refused'
          : 'admission accepted but invalidated by loss of the record; compensation initiated',
      );
    }
    expect(abort).toHaveBeenCalledTimes(rejected ? 0 : 1);
    expect(launch).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(onLaunch).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1); // no pre-settlement idle proof
    if (!rejected) {
      expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
      expect(board.validateLease(lease)).toBe(true);
      expect(release).not.toHaveBeenCalled();
      expect(() => acknowledgedCompleted(board)).toThrow(/lease/);
      deadline.fireRemaining(); // no local deadline can retire a pending abort
      expect(board.validateLease(lease)).toBe(true);
      if (outcome === 'replaced during abort') board.releaseLease(lease);
      if (outcome === 'abort rejected' || outcome === 'pending')
        stop.reject(new Error('abort failed'));
      else
        stop.resolve(
          outcome === 'abort error' ? { error: 'abort failed' } : {},
        );
      if (!outcome.startsWith('abort ') && outcome !== 'pending') {
        if (outcome !== 'replaced during abort') await reading.promise;
        if (outcome === 'replaced during read') board.releaseLease(lease);
        if (outcome.startsWith('replaced')) {
          acknowledgedCompleted(board);
          const successor = board.get('ses_1');
          if (!successor) throw new Error('missing successor');
          const replacement = board.acquireRelaunchLease(
            'ses_1',
            successor.generation,
          );
          if (!replacement) throw new Error('missing replacement');
          read.resolve({ data: {} });
          // Read settlement must not retire a replacement's token.
          await compensated.promise;
          expect(board.validateLease(replacement)).toBe(true);
          expect(board.get('ses_1')).toEqual(successor);
          return;
        }
        if (outcome === 'status rejected')
          read.reject(new Error('read failed'));
        else if (outcome === 'status timeout') deadline.fireRemaining();
        else
          read.resolve(
            outcome === 'status error'
              ? { error: 'read failed' }
              : {
                  data:
                    outcome === 'absent'
                      ? {}
                      : {
                          ses_1: {
                            type: outcome === 'malformed' ? 'unknown' : outcome,
                          },
                        },
                },
          );
      }
      await compensated.promise;
    }
    const released = rejected || outcome === 'idle' || outcome === 'absent';
    expect(board.validateLease(lease)).toBe(!released);
    expect(release).toHaveBeenCalledTimes(released ? 1 : 0);
    if (released) expect(release).toHaveBeenCalledWith(lease);
    else
      expect(log).toHaveBeenCalledWith(
        '[task-revive] compensation unconfirmed',
        expect.objectContaining({ taskID: 'ses_1' }),
      );
    expect(board.get('ses_1')).toBeUndefined();
    expect(tombstones.has('ses_1')).toBe(true);
    expect(terminal).not.toHaveBeenCalled();
    if (outcome === 'status timeout') {
      read.reject(new Error('late read failure')); // timeout loser is observed
      await read.promise.catch(() => {});
      expect(board.validateLease(lease)).toBe(true);
    }
  });

  test.each(['success', 'rejection', 'error envelope'])(
    'notification timeout permits a real revive; old %s leaves the new generation and lease intact',
    async (outcome) => {
      const timers = new Map<number, { delay: number; callback: () => void }>();
      let nextID = 0;
      spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: () => void,
        delay: number,
      ) => {
        const id = ++nextID;
        timers.set(id, { delay, callback });
        return id;
      }) as typeof setTimeout);
      spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => {
        timers.delete(id);
      }) as typeof clearTimeout);
      const flush = async () => {
        for (let i = 0; i < 50; i++) await Promise.resolve();
      };
      let resolve!: (value: unknown) => void;
      let reject!: (error: unknown) => void;
      const pending = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const { board, promptAsync, taskRevive, revivedRunTracker } = createTool({
        messages: async () => ({
          data: [
            {
              info: {
                id: 'old-result',
                role: 'assistant',
                finish: 'stop',
                time: { completed: 1 },
              },
              parts: [{ type: 'text', text: 'done' }],
            },
          ],
        }),
      });
      promptAsync.mockImplementationOnce(() => pending);
      const run = board.registerLaunch({
        taskID: 'ses_1',
        parentSessionID: 'parent-1',
        agent: 'explorer',
        background: true,
      });
      revivedRunTracker.register(run);
      const terminal = board.updateStatus({
        taskID: run.taskID,
        state: 'completed',
        resultSummary: 'done',
      });
      if (!terminal) throw new Error('missing terminal record');
      revivedRunTracker.onTerminal(terminal);
      await flush();
      const args = {
        task_id: run.taskID,
        prompt: 'Continue the investigation',
      };
      await expect(taskRevive.execute(args, context)).rejects.toThrow(
        'relaunch lease unavailable',
      );
      expect(promptAsync).toHaveBeenCalledTimes(1);
      const timeout = [...timers.values()].find(
        (timer) => timer.delay === 10_000,
      );
      expect(timeout).toBeDefined();
      timeout?.callback();
      await flush();
      try {
        const output = await taskRevive.execute(args, context);
        expect(String(output)).toContain('status: started');
        expect(promptAsync).toHaveBeenCalledTimes(2);
        expect(promptAsync.mock.calls[1]?.[0]).toMatchObject({
          path: { id: run.taskID },
          delivery: 'queue',
        });
        const current = board.get(run.taskID);
        if (!current) throw new Error('missing revived record');
        expect(current).toMatchObject({
          generation: run.generation + 1,
          state: 'running',
        });
        const lease = board.acquireMessageLease(
          current.taskID,
          current.generation,
        );
        if (!lease) throw new Error('missing new-generation lease');
        if (outcome === 'success') resolve({});
        else if (outcome === 'rejection')
          reject(new Error('old transport failed'));
        else resolve({ error: 'old transport failed' });
        await flush();
        expect(board.get(run.taskID)).toEqual(current);
        expect(board.validateLease(lease)).toBe(true);
        expect(
          board.acquireRelaunchLease(current.taskID, current.generation),
        ).toBeUndefined();
        expect(board.releaseLease(lease)).toBe(true);
        expect(
          [...timers.values()].some((timer) => timer.delay === 1_000),
        ).toBe(false);
        expect(promptAsync).toHaveBeenCalledTimes(2);
      } finally {
        revivedRunTracker.dispose();
      }
    },
  );

  test('uses promptAsync, starts a new board generation, and retains the session', async () => {
    const { board, promptAsync, taskRevive } = createTool();
    acknowledgedCompleted(board);

    const output = await taskRevive.execute(
      { task_id: 'ses_1', prompt: 'Continue the investigation' },
      context,
    );

    expect(promptAsync).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      query: { directory: '/test/project' },
      body: {
        agent: 'explorer',
        parts: [{ type: 'text', text: 'Continue the investigation' }],
      },
      delivery: 'queue',
    });
    const call = promptAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.body).not.toHaveProperty('noReply', true);
    expect(String(output)).toContain('state: running');
    expect(String(output)).toContain('status: started');
    expect(board.get('ses_1')).toMatchObject({
      generation: 2,
      state: 'running',
    });
    const lease = board.acquireRelaunchLease('ses_1', 2);
    expect(lease).toBeDefined();
    if (lease) board.releaseLease(lease);
  });

  test('reports a fast terminal completion observed by the immediate probe', async () => {
    let board: BackgroundJobBoard;
    const tracker = {
      captureBaseline: async () => undefined,
      register: () => {},
      probe: async (_taskID: string, generation: number) => {
        board.updateStatus({
          taskID: 'ses_1',
          expectedGeneration: generation,
          state: 'completed',
          resultSummary: 'fast completion',
        });
        return true;
      },
    };
    const tools = createTool({ revivedRunTracker: tracker });
    board = tools.board;
    acknowledgedCompleted(board);

    const output = await tools.taskRevive.execute(
      { task_id: 'ses_1', prompt: 'finish quickly' },
      context,
    );

    expect(String(output)).toContain('state: completed');
    expect(String(output)).toContain('status: completed');
    expect(String(output)).toContain('fast completion');
    expect(String(output)).not.toContain('state: running');
    expect(tools.board.get('ses_1')).toMatchObject({
      generation: 2,
      state: 'completed',
    });
  });

  test('cancels a running generation and launches its replacement in order', async () => {
    const events: string[] = [];
    const { board, abort, promptAsync, taskRevive } = createTool({
      abort: async () => {
        events.push('abort');
        return {};
      },
      status: async () => ({ data: { ses_1: { type: 'idle' } } }),
      promptAsync: async () => {
        events.push('promptAsync');
        return {};
      },
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    await taskRevive.execute(
      { task_id: 'ses_1', prompt: 'Resume with a new objective' },
      context,
    );

    expect(abort).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['abort', 'promptAsync']);
    expect(board.get('ses_1')).toMatchObject({
      generation: 2,
      state: 'running',
    });
  });

  test('revives a directly cancelled retained session before acknowledgement', async () => {
    const { board, promptAsync, taskCancel, taskRevive } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    await taskCancel.execute({ task_id: 'ses_1', reason: 'obsolete' }, context);
    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      terminalUnreconciled: true,
      statusUncertain: false,
    });

    const output = await taskRevive.execute(
      { task_id: 'ses_1', prompt: 'try again' },
      context,
    );

    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(String(output)).toContain('state: running');
    expect(board.get('ses_1')).toMatchObject({
      generation: 2,
      state: 'running',
    });
  });

  test('revives a stopped session before and after acknowledgement', async () => {
    for (const acknowledge of [false, true]) {
      const { board, promptAsync, taskRevive } = createTool();
      stoppedSession(board, 'ses_1', acknowledge);
      expect(board.get('ses_1')).toMatchObject({
        state: 'stopped',
        terminalUnreconciled: !acknowledge,
      });

      const output = await taskRevive.execute(
        { task_id: 'ses_1', prompt: 'continue from the retained session' },
        context,
      );

      expect(promptAsync).toHaveBeenCalledTimes(1);
      expect(String(output)).toContain('state: running');
      expect(board.get('ses_1')).toMatchObject({
        generation: 2,
        state: 'running',
      });
    }
  });

  test('revives a stopped session on a v2 host with no live session-status map', async () => {
    // Regression: v2 hosts omit session.status entirely (client-shim.ts).
    // Revive must not depend on the v1 status map: with no map, the tool
    // verifies quiescence through the experimental_v2.waitForSessionIdle
    // capability instead. That supersedes the skip-verification approach
    // merged in #1221; a host with neither capability refuses clearly
    // before any abort or prompt (see task-control-conformance tests).
    const { board, status, waitIdle, promptAsync, taskRevive } = createTool({
      omitStatus: true,
      waitIdle: async () => {},
    });
    stoppedSession(board);

    const output = await taskRevive.execute(
      { task_id: 'ses_1', prompt: 'continue from the retained session' },
      context,
    );

    expect(status).not.toHaveBeenCalled();
    expect(waitIdle).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(String(output)).toContain('state: running');
    expect(board.get('ses_1')).toMatchObject({
      generation: 2,
      state: 'running',
    });
  });

  test.each(['resolve', 'reject'] as const)(
    'baseline deadline releases the lease; late %s cannot send or retire a replacement',
    async (settlement) => {
      const baseline = Promise.withResolvers<string | undefined>();
      const { board, promptAsync, taskRevive } = createTool({
        baselineTimeoutMs: 5,
        revivedRunTracker: { captureBaseline: () => baseline.promise },
      });
      stoppedSession(board);
      await expect(
        taskRevive.execute({ task_id: 'ses_1', prompt: 'continue' }, context),
      ).rejects.toThrow(/baseline.*deadline/i);
      const replacement = board.acquireRelaunchLease('ses_1', 1);
      expect(replacement).toBeDefined();
      if (!replacement) throw new Error('missing replacement lease');
      if (settlement === 'resolve') baseline.resolve('late-baseline');
      else baseline.reject(new Error('late read failure'));
      await baseline.promise.catch(() => {});
      expect(promptAsync).not.toHaveBeenCalled();
      expect(board.get('ses_1')?.generation).toBe(1);
      expect(board.validateLease(replacement)).toBe(true);
      board.releaseLease(replacement);
    },
  );

  test.each([
    ['baseline', 'running', /became active again/],
    ['status', 'running', /became active again/],
    ['status', 'drop', /no longer tracked/],
    ['status', 'generation', /generation changed/],
    ['status', 'lease', /became active again/],
  ] as const)(
    'refuses a %s read invalidated by %s',
    async (phase, change, error) => {
      const entered = Promise.withResolvers<void>();
      const read = Promise.withResolvers<void>();
      const { board, promptAsync, taskRevive } = createTool({
        status: async () => {
          if (phase === 'status') {
            entered.resolve();
            await read.promise;
          }
          return { data: { ses_1: { type: 'idle' } } };
        },
        revivedRunTracker: {
          captureBaseline: async () => {
            if (phase === 'baseline') {
              entered.resolve();
              await read.promise;
            }
            return undefined;
          },
        },
      });
      stoppedSession(board);
      const acquire = spyOn(ProductionBoard.prototype, 'acquireRelaunchLease');
      const pending = taskRevive.execute(
        { task_id: 'ses_1', prompt: 'continue' },
        context,
      );
      await entered.promise;
      const lease = acquire.mock.results[0]?.value;
      if (!lease) throw new Error('missing relaunch lease');
      let replacement: typeof lease | undefined;
      if (change === 'drop') board.drop('ses_1');
      if (change === 'generation' || change === 'lease') {
        board.releaseLease(lease);
        if (change === 'generation') acknowledgedCompleted(board);
        else replacement = board.acquireRelaunchLease('ses_1', 1);
      }
      if (change === 'running') board.markRunningFromLiveSession('ses_1', 115);
      read.resolve();
      await expect(pending).rejects.toThrow(error);
      expect(promptAsync).not.toHaveBeenCalled();
      expect(board.validateLease(lease)).toBe(false);
      if (change === 'running') {
        expect(board.get('ses_1')).toMatchObject({
          state: 'running',
          generation: 1,
          lastLiveBusyAt: 115,
        });
      }
      if (replacement) {
        expect(board.validateLease(replacement)).toBe(true);
        board.releaseLease(replacement);
      }
      if (change === 'drop') acknowledgedCompleted(board);
      const reLease = board.acquireRelaunchLease(
        'ses_1',
        board.get('ses_1')?.generation ?? -1,
      );
      expect(reLease).toBeDefined();
      if (reLease) board.releaseLease(reLease);
    },
  );

  test('refuses to relaunch when the host reports the session busy even if the board is stopped', async () => {
    // The host can resume independently before the board observes it;
    // its busy/retry entry must refuse before the prompt is sent.
    const { board, promptAsync, status, taskRevive } = createTool({
      status: async () => ({ data: { ses_1: { type: 'busy' } } }),
    });
    stoppedSession(board);

    await expect(
      taskRevive.execute({ task_id: 'ses_1', prompt: 'continue' }, context),
    ).rejects.toThrow(/executing at the host/);

    expect(promptAsync).toHaveBeenCalledTimes(0);
    expect(status).toHaveBeenCalled();
    expect(board.get('ses_1')).toMatchObject({
      state: 'stopped',
      generation: 1,
    });
    const reLease = board.acquireRelaunchLease('ses_1', 1);
    expect(reLease).toBeDefined();
    if (reLease) board.releaseLease(reLease);
  });

  test('rejects an uncertain retained terminal job', async () => {
    const { board, promptAsync, taskRevive } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({
      taskID: 'ses_1',
      state: 'error',
      statusUncertain: true,
    });

    await expect(
      taskRevive.execute({ task_id: 'ses_1', prompt: 'try again' }, context),
    ).rejects.toThrow('verified retained terminal session');
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('rejects foreign, parent, and stale task requests', async () => {
    const { board, promptAsync, taskRevive } = createTool();
    acknowledgedCompleted(board, 'ses_foreign');
    const foreignRecord = board.get('ses_foreign');
    if (!foreignRecord) throw new Error('missing foreign record');
    board.updateStatus({ taskID: 'ses_foreign', state: 'completed' });
    board.markReconciled('ses_foreign');
    board.registerLaunch({
      taskID: 'ses_stale',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({ taskID: 'ses_stale', state: 'completed' });
    board.markReconciled('ses_stale');

    await expect(
      taskRevive.execute({ task_id: 'ses_foreign', prompt: 'x' }, {
        sessionID: 'parent-2',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('Unknown or unowned');
    await expect(
      taskRevive.execute({ task_id: 'parent-1', prompt: 'x' }, context),
    ).rejects.toThrow('Unknown or unowned');

    const originalResolve = board.resolve.bind(board);
    let mutated = false;
    board.resolve = mock((parent, requested) => {
      const result = originalResolve(parent, requested);
      if (result && requested === 'ses_stale' && !mutated) {
        mutated = true;
        const lease = board.acquireRelaunchLease(
          'ses_stale',
          result.generation,
        );
        if (!lease) throw new Error('missing stale relaunch lease');
        board.registerLaunch({
          taskID: 'ses_stale',
          parentSessionID: 'parent-1',
          agent: 'explorer',
          relaunchLease: lease,
        });
      }
      return result;
    });
    await expect(
      taskRevive.execute({ task_id: 'ses_stale', prompt: 'x' }, context),
    ).rejects.toThrow('run generation changed');
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test.each(['reject', 'error response', 'throw', 'transport timeout'])(
    'releases the relaunch lease when promptAsync fails via %s',
    async (failure) => {
      const error =
        failure === 'transport timeout'
          ? new OperationTimeoutError('Revive admission deadline exceeded')
          : new Error('host unavailable');
      const { board, promptAsync, taskRevive } = createTool({
        promptAsync: () => {
          if (failure === 'throw') throw error;
          return failure === 'error response'
            ? Promise.resolve({ error: error.message })
            : Promise.reject(error);
        },
      });
      acknowledgedCompleted(board);

      await expect(
        taskRevive.execute({ task_id: 'ses_1', prompt: 'retry' }, context),
      ).rejects.toThrow(`revive failed: ${error.message}`);
      expect(promptAsync).toHaveBeenCalledTimes(1);
      const lease = board.acquireRelaunchLease('ses_1', 1);
      expect(lease).toBeDefined();
      if (lease) board.releaseLease(lease);
      expect(board.get('ses_1')).toMatchObject({
        generation: 1,
        state: 'reconciled',
        statusUncertain: false,
      });
    },
  );

  test.each(['deadline first', 'acceptance first'])(
    'keeps the local deadline outcome when admission settles in the same tick: %s',
    async (order) => {
      const send = Promise.withResolvers<unknown>();
      const deadlineReady = Promise.withResolvers<() => void>();
      const admissionTimeoutMs = 1_000;
      const realSetTimeout = globalThis.setTimeout;
      spyOn(globalThis, 'setTimeout').mockImplementation(
        (callback, ms, ...args) => {
          const timer = realSetTimeout(callback, ms, ...args);
          if (ms === admissionTimeoutMs)
            deadlineReady.resolve(() => {
              clearTimeout(timer);
              callback(...args);
            });
          return timer;
        },
      );
      const log = spyOn(logger, 'log').mockImplementation(() => {});
      const observed = Promise.withResolvers<void>();
      const { board, taskRevive, revivedRunTracker, onLaunch } = createTool({
        admissionTimeoutMs,
        promptAsync: () => send.promise,
        revivedRunTracker: {
          probe: async () => {
            observed.resolve();
            return false;
          },
        },
      });
      acknowledgedCompleted(board);
      const launch = spyOn(ProductionBoard.prototype, 'registerLaunch');
      const register = spyOn(revivedRunTracker, 'register');
      const pending = taskRevive.execute(
        { task_id: 'ses_1', prompt: 'go' },
        context,
      );
      const admissionDeadline = await deadlineReady.promise;
      // No await between these actions: settlement races the timer's microtasks.
      if (order === 'deadline first') {
        admissionDeadline();
        send.resolve({});
      } else {
        send.resolve({});
        admissionDeadline();
      }
      const output = String(await pending);
      await observed.promise;
      expect(output).toContain('status: admission_unknown');
      expect(output).toContain('do not retry task_revive');
      expect(output).toContain('Use task_status');
      expect(output).not.toContain('revive failed');
      expect(launch).toHaveBeenCalledTimes(1);
      expect(register).toHaveBeenCalledTimes(1);
      expect(onLaunch).toHaveBeenCalledTimes(1);
      expect(board.get('ses_1')).toMatchObject({
        generation: 2,
        state: 'running',
      });
      const lease = board.acquireRelaunchLease('ses_1', 2);
      expect(lease).toBeDefined();
      if (lease) board.releaseLease(lease);
      expect(log).not.toHaveBeenCalled();
    },
  );

  test.each([
    'pending',
    'accepted',
    'rejected',
    'error response',
    'tracker error',
    'supervisor error',
    'revoked',
    'dropped revoked',
    'superseded',
  ])('owns unknown admission until late settlement: %s', async (outcome) => {
    const deadline = controlledAdmissionDeadline();
    const send = Promise.withResolvers<unknown>();
    const settled = Promise.withResolvers<void>();
    const log = spyOn(logger, 'log').mockImplementation(() =>
      settled.resolve(),
    );
    const { board, taskRevive, revivedRunTracker, onLaunch, abort } =
      createTool({
        admissionTimeoutMs: 1_000,
        promptAsync: () => send.promise,
        onLaunch: () => {
          if (outcome === 'supervisor error')
            throw new Error('supervisor failed');
        },
        revivedRunTracker: {
          captureBaseline: async () => 'baseline',
          register: () => {
            if (outcome === 'tracker error') throw new Error('tracker failed');
          },
          probe: async () => {
            settled.resolve();
            return false;
          },
        },
      });
    acknowledgedCompleted(board);
    const acquire = spyOn(ProductionBoard.prototype, 'acquireRelaunchLease');
    const launch = spyOn(ProductionBoard.prototype, 'registerLaunch');
    const register = spyOn(revivedRunTracker, 'register');
    const probe = spyOn(revivedRunTracker, 'probe');
    const pending = taskRevive.execute(
      { task_id: 'ses_1', prompt: 'continue' },
      context,
    );
    (await deadline.ready)();
    const output = await pending;
    expect(String(output)).toContain('status: admission_unknown');
    expect(String(output)).not.toContain('<task_result>');
    expect(launch).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(onLaunch).not.toHaveBeenCalled();
    const lease = acquire.mock.results[0]?.value;
    if (!lease) throw new Error('missing relaunch lease');
    expect(board.validateLease(lease)).toBe(true);
    expect(board.acquireRelaunchLease('ses_1', 1)).toBeUndefined();
    if (outcome === 'pending') return;

    let replacement: typeof lease | undefined;
    if (outcome === 'dropped revoked') board.drop('ses_1');
    if (
      outcome === 'revoked' ||
      outcome === 'dropped revoked' ||
      outcome === 'superseded'
    ) {
      board.releaseLease(lease);
      if (outcome === 'superseded') acknowledgedCompleted(board);
      replacement = board.acquireRelaunchLease(
        'ses_1',
        board.get('ses_1')?.generation ?? -1,
      );
    }
    const generation = board.get('ses_1')?.generation;
    launch.mockClear();
    if (outcome === 'rejected') send.reject(new Error('host unavailable'));
    else
      send.resolve(
        outcome === 'error response' ? { error: 'host refused' } : {},
      );
    // Repeated and conflicting settlements must never register twice.
    send.resolve({});
    send.reject(new Error('duplicate settlement'));
    await settled.promise;
    expect(abort).not.toHaveBeenCalled();
    const admitted = ['accepted', 'tracker error', 'supervisor error'].includes(
      outcome,
    );
    expect(launch).toHaveBeenCalledTimes(
      ['rejected', 'error response'].includes(outcome) ? 0 : 1,
    );
    expect(register).toHaveBeenCalledTimes(admitted ? 1 : 0);
    expect(onLaunch).toHaveBeenCalledTimes(
      admitted && outcome !== 'tracker error' ? 1 : 0,
    );
    expect(probe).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 0);
    expect(board.get('ses_1')?.generation).toBe(admitted ? 2 : generation);
    if (outcome === 'accepted') {
      expect(launch.mock.invocationCallOrder[0]).toBeLessThan(
        Number(register.mock.invocationCallOrder[0]),
      );
      expect(register.mock.invocationCallOrder[0]).toBeLessThan(
        Number(onLaunch.mock.invocationCallOrder[0]),
      );
      expect(register).toHaveBeenCalledWith(
        expect.objectContaining({
          taskID: 'ses_1',
          generation: 2,
          baselineMessageID: 'baseline',
        }),
      );
      expect(log).not.toHaveBeenCalled();
    } else
      expect(log).toHaveBeenCalledWith(
        '[task-revive] admission failed',
        expect.anything(),
      );
    expect(board.validateLease(lease)).toBe(false);
    if (replacement) {
      expect(board.validateLease(replacement)).toBe(true);
      board.releaseLease(replacement);
    }
    if (outcome === 'dropped revoked') {
      expect(board.get('ses_1')).toBeUndefined();
      expect(
        getBackgroundJobLifecycleLedger(board).tombstones.has('ses_1'),
      ).toBe(true);
      return;
    }
    const available = board.acquireRelaunchLease(
      'ses_1',
      board.get('ses_1')?.generation ?? -1,
    );
    expect(available).toBeDefined();
    if (available) board.releaseLease(available);
  });

  test.each(['immediate', 'late', 'superseded'])(
    '%s observation does not hold relaunch exclusion',
    async (timing) => {
      const send = Promise.withResolvers<unknown>();
      const probing = Promise.withResolvers<void>();
      const observation = Promise.withResolvers<boolean>();
      const observed = Promise.withResolvers<void>();
      const log = spyOn(logger, 'log').mockImplementation(() =>
        observed.resolve(),
      );
      const { board, taskRevive, promptAsync, abort } = createTool({
        admissionTimeoutMs: 5,
        promptAsync: () =>
          timing === 'late' ? send.promise : Promise.resolve({}),
        revivedRunTracker: {
          captureBaseline: async () => undefined,
          register: () => {},
          probe: (_taskID, generation) => {
            if (generation === 3) return Promise.resolve(false);
            probing.resolve();
            return observation.promise;
          },
        },
      });
      acknowledgedCompleted(board);
      const pending = taskRevive.execute(
        { task_id: 'ses_1', prompt: 'go' },
        context,
      );
      if (timing === 'late') {
        expect(String(await pending)).toContain('status: admission_unknown');
        send.resolve({});
      }
      await probing.promise;
      const lease = board.acquireRelaunchLease('ses_1', 2);
      expect(lease).toBeDefined();
      if (lease) board.releaseLease(lease);
      if (timing === 'superseded') {
        const replacement = String(
          await taskRevive.execute(
            { task_id: 'ses_1', prompt: 'replace G2' },
            context,
          ),
        );
        observation.resolve(false);
        await expect(pending).rejects.toThrow('revive became stale');
        expect(replacement).toContain('generation: 3');
        expect(replacement).toContain('status: started');
        expect(board.get('ses_1')).toMatchObject({
          generation: 3,
          state: 'running',
        });
        expect(promptAsync).toHaveBeenCalledTimes(2);
        expect(abort).toHaveBeenCalledTimes(1);
        // Terminal-gate observability INFO logs (publication, attribution,
        // evidence verdicts) are expected on this path; nothing else — in
        // particular no error-path log — may fire.
        const logged = (log.mock.calls as Array<[string]>)
          .map(([message]) => message)
          .filter((message) => !message.startsWith('[terminal-gate]'));
        expect(logged).toEqual([]);
        return;
      }
      observation.reject(new Error('probe failed'));
      if (timing === 'immediate')
        expect(String(await pending)).toContain('status: started');
      await observed.promise;
      expect(board.get('ses_1')).toMatchObject({
        generation: 2,
        state: 'running',
        statusUncertain: false,
      });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        '[task-revive] observation failed',
        expect.anything(),
      );
    },
  );

  test('v1 SDK serializes only the body: the delivery hint never reaches the wire', async () => {
    // v1 compatibility evidence for the queue-delivery fence: the hint
    // travels as a client-side argument, and the real @opencode-ai/sdk
    // request pipeline must serialize ONLY `body` into the HTTP request.
    // A captured fetch observes the wire shape directly.
    const captured = new Map<string, unknown>();
    const client = createOpencodeClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: async (request: Request) => {
        captured.set('url', request.url);
        captured.set('body', await request.text());
        return new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    await client.session.promptAsync({
      path: { id: 'ses_1' },
      query: { directory: '/test/project' },
      body: { agent: 'explorer', parts: [{ type: 'text', text: 'go' }] },
      // Extra top-level argument, exactly as task-revive sends it.
      delivery: 'queue',
    } as Parameters<typeof client.session.promptAsync>[0] &
      Record<string, unknown>);

    expect(captured.get('url')).toContain('/session/ses_1/prompt_async');
    const wireBody = JSON.parse(String(captured.get('body')));
    expect(wireBody).toEqual({
      agent: 'explorer',
      parts: [{ type: 'text', text: 'go' }],
    });
  });
});
