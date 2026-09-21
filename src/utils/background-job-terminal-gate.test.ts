import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createTaskSessionManagerHook } from '../hooks/task-session-manager';
import { createRevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import { createTaskResultTool } from '../tools/task-result';
import { buildPluginInput } from '../v2/client-shim';
import { BackgroundJobBoard } from './background-job-board';
import { BackgroundJobCoordinator } from './background-job-coordinator';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
  EVIDENCE_UNAVAILABLE_DIAGNOSTIC,
  type RuntimeObservation,
  runtimeObservationFromSnapshot,
} from './background-job-terminal-gate';
import { BackgroundTaskConcurrency } from './background-task-concurrency';
import { classifyTerminalEvidence } from './child-transcript';
import * as loggerModule from './logger';
import { COMPLETED_WITHOUT_TEXT_DIAGNOSTIC } from './task';

// Other test files mock the shared opencode-client module process-globally
// (Bun mock.module is never auto-restored). Re-pin it to a passthrough so
// this file always exercises the client each test provides via input.
mock.module('./opencode-client', () => ({
  getClient: (input: { client: unknown }) => input.client as never,
}));

const gates: BackgroundJobTerminalGate[] = [];
afterEach(() => {
  for (const gate of gates.splice(0)) gate.dispose();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const answer = (text = 'answer') => ({
  data: [
    { info: { id: 'baseline', role: 'user' }, parts: [] },
    {
      info: {
        id: 'answer',
        role: 'assistant',
        time: { completed: 100 },
        finish: 'stop',
      },
      parts: [{ type: 'text', text }],
    },
  ],
});
function harness(
  options: Partial<Parameters<typeof createBackgroundJobTerminalGate>[0]> = {},
) {
  const board = new BackgroundJobBoard();
  const run = board.registerLaunch({
    taskID: 'ses_child',
    parentSessionID: 'parent',
    agent: 'fixer',
    background: true,
    now: 0,
  });
  let now = 1;
  const gate = createBackgroundJobTerminalGate({
    backgroundJobBoard: board,
    baselineFor: () => 'baseline',
    readTerminalEvidence: async () => answer(),
    graceMs: 5,
    now: () => now,
    ...options,
  });
  gates.push(gate);
  const observe = (
    kind: 'busy' | 'quiescent' | 'unknown' | 'deleted',
    stable = false,
    observedAt?: number,
  ) => {
    const token = gate.capture(run);
    if (!token) throw new Error('missing observation');
    return gate.observe(token, {
      kind,
      readStartedAt: token.readStartedAt,
      origin: observedAt === undefined ? 'test' : 'session.status-event',
      stable,
      ...(observedAt !== undefined ? { observedAt } : {}),
    });
  };
  return {
    board,
    run,
    gate,
    observe,
    advance: (time: number) => {
      now = time;
    },
  };
}

describe('terminal evidence policy (migrated from stop confirmation)', () => {
  test.each([
    undefined,
    {},
    { data: [], error: 'unavailable' },
    { data: [null] },
    { data: [{ info: { role: 'assistant' }, parts: 1 }] },
    { data: [{ info: { role: 'assistant' } }, 1] },
  ])('unknown or malformed evidence never means absence: %j', (response) => {
    expect(classifyTerminalEvidence(response).verdict).toBe('retry');
  });
  test('valid empty post-baseline segment is absent', () => {
    expect(
      classifyTerminalEvidence(
        { data: answer().data.slice(0, 1) },
        { baselineMessageID: 'baseline' },
      ),
    ).toEqual({ verdict: 'absent' });
  });
  test.each(['user', 'assistant'])(
    'new pending %s after a completed answer blocks N-1 retrieval',
    (role) => {
      const response = answer();
      response.data.push({ info: { id: 'pending', role }, parts: [] } as never);
      expect(
        classifyTerminalEvidence(response, { baselineMessageID: 'baseline' })
          .verdict,
      ).toBe('retry');
    },
  );
  test('a pending tool anywhere in the segment blocks completion', () => {
    const response = answer();
    response.data[1].parts.push({
      type: 'tool',
      state: { status: 'running' },
    } as never);
    expect(
      classifyTerminalEvidence(response, { baselineMessageID: 'baseline' })
        .verdict,
    ).toBe('retry');
  });
  test('terminal errors take precedence over leftover finish flags', () => {
    const response = answer();
    Object.assign(response.data[1].info, {
      error: 'failed',
      finish: 'tool-calls',
    });
    expect(
      classifyTerminalEvidence(response, { baselineMessageID: 'baseline' }),
    ).toEqual({ verdict: 'error', text: 'failed' });
  });
  test('missing baseline cannot recover historical answers', () => {
    expect(
      classifyTerminalEvidence(answer(), { baselineMessageID: 'missing' })
        .verdict,
    ).toBe('retry');
  });
});

describe('terminal gate', () => {
  test.each([
    ['old', { idle: 99 }, false],
    ['equal', { idle: 100 }, false],
    ['within read', { idle: 150 }, true],
    ['read completion', { idle: 200 }, true],
    ['future', { idle: 201 }, false],
    ['missing', { idle: undefined }, false],
    ['string', { idle: '150' }, false],
    ['NaN', { idle: NaN }, false],
    ['infinite', { idle: Infinity }, false],
    ['negative', { idle: -1 }, false],
    ['unaccredited clock', { clock: undefined }, false],
    ['future generation', { start: 300 }, false],
    ['invalid generation', { start: NaN }, false],
    ['negative generation', { start: -1 }, false],
    ['invalid read completion', { readAt: NaN }, false],
    ['infinite read completion', { readAt: Infinity }, false],
    ['negative read completion', { readAt: -1 }, false],
    ['replacement attempt', { attempt: 160 }, false],
    ['equal attempt', { attempt: 150 }, false],
    ['invalid attempt', { attempt: -1 }, false],
    ['live activity', { activity: 160 }, false],
    ['invalid activity', { activity: NaN }, false],
    ['fresh after all boundaries', { attempt: 120, activity: 130 }, true],
    [
      'first generation missing timestamp',
      { generation: 1, idle: undefined },
      false,
    ],
    ['first generation fresh timestamp', { generation: 1 }, true],
    ['host error', { error: 'unavailable' }, false],
    ['invalid response', { response: null }, false],
    [
      'malformed envelope',
      { response: { data: false, outcome: 'failed', time: { idle: 150 } } },
      false,
    ],
    ['unrecognized outcome', { outcome: 'running' }, false],
  ] as const)(
    'host outcome attribution: %s',
    async (_name, overrides, accepted) => {
      const spec = {
        idle: 150 as unknown,
        start: 100,
        readAt: 200,
        generation: 2,
        clock: 'shared-unix-ms' as 'shared-unix-ms' | undefined,
        attempt: undefined as number | undefined,
        activity: undefined as number | undefined,
        outcome: 'failed',
        error: undefined as string | undefined,
        response: undefined as unknown,
        ...overrides,
      };
      let clock = 140;
      const onTerminal = mock(() => {});
      const h = harness({
        hostOutcomeClock: spec.clock,
        now: () => clock,
        attemptStartedAtFor: () => spec.attempt,
        maxEvidenceRetries: 0,
        onTerminal,
        baselineFor: () => undefined,
        readTerminalEvidence: async () => ({ data: [] }),
        input: {
          client: {
            session: {
              get: async () => {
                clock = spec.readAt;
                if (spec.response !== undefined) return spec.response;
                return {
                  data: { outcome: spec.outcome, time: { idle: spec.idle } },
                  error: spec.error,
                };
              },
            },
          },
        } as never,
      });
      const run =
        spec.generation === 1
          ? h.run
          : h.board.registerLaunch({
              taskID: h.run.taskID,
              parentSessionID: 'parent',
              agent: 'fixer',
              now: spec.start,
            });
      if (spec.activity !== undefined)
        h.board.markRunningFromLiveSession(run.taskID, spec.activity);
      const revision = h.board.get(run.taskID)?.terminalRevision;
      await h.gate.reconcile(run);
      expect(h.board.get(run.taskID)).toMatchObject(
        accepted
          ? {
              state: 'error',
              resultSummary: 'Host reported outcome: failed.',
              terminalRevision: (revision ?? 0) + 1,
            }
          : {
              state: 'running',
              statusUncertain: true,
              terminalRevision: revision,
            },
      );
      if (!accepted)
        expect(h.board.get(run.taskID)?.resultSummary).toBeUndefined();
      expect(onTerminal).toHaveBeenCalledTimes(accepted ? 1 : 0);
    },
  );

  test('unattributable host outcome clears old quiescence instead of aging into stopped', async () => {
    let idle = 150;
    let transcript: unknown;
    const h = harness({
      hostOutcomeClock: 'shared-unix-ms',
      baselineFor: () => undefined,
      input: {
        client: {
          session: {
            get: async () => ({
              data: { outcome: 'succeeded', time: { idle } },
            }),
            // Source-present host: the early-publish path for an
            // absent transcript source must stay out of this test —
            // its subject is the stale-quiescence aging guard, and a
            // source-absent host would (correctly) publish completed
            // on the first reconcile below.
            messages: async () => ({ data: [] }),
          },
        },
      } as never,
      readTerminalEvidence: async () => transcript,
    });
    h.advance(200);
    await h.gate.reconcile(h.run); // Valid quiescence, unavailable evidence.
    idle = 0; // Equality to the generation boundary is not fresh evidence.
    transcript = { data: [] };
    for (let i = 1; i <= 6; i++) {
      h.advance(200 + i * 10);
      await h.gate.reconcile(h.run);
    }
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'running',
      statusUncertain: true,
      terminalRevision: 0,
    });
  });
  test('a host-timestamped busy keeps the short run outcome attributable', async () => {
    const h = harness({
      hostOutcomeClock: 'shared-unix-ms',
      baselineFor: () => undefined,
      readTerminalEvidence: async () => undefined,
      input: {
        client: {
          session: {
            get: async () => ({
              data: { outcome: 'failed', time: { idle: 50 } },
            }),
          },
        },
      } as never,
    });
    // start host=10 < idle=50 < receipt 60. The adapter preserves the
    // envelope `created`, so the delayed queued busy carries the host time
    // and cannot fence the run's own outcome. failed publishes without
    // transcript text.
    h.advance(60);
    h.observe('busy', false, 10);
    h.advance(61);
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'error',
      resultSummary: 'Host reported outcome: failed.',
      statusUncertain: false,
    });
  });
  test('a real resume after a delayed busy still fences the stale outcome', async () => {
    const h = harness({
      hostOutcomeClock: 'shared-unix-ms',
      baselineFor: () => undefined,
      readTerminalEvidence: async () => undefined,
      input: {
        client: {
          session: {
            get: async () => ({
              data: { outcome: 'failed', time: { idle: 50 } },
            }),
          },
        },
      } as never,
    });
    // The same failed outcome with an independently resumed run observed at
    // host time 55: the outcome predates live activity and must not publish.
    h.advance(60);
    h.observe('busy', false, 10);
    h.advance(62);
    h.observe('busy', false, 55);
    h.advance(63);
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'running',
      terminalRevision: 0,
    });
  });
  test('an attributable succeeded publishes completed when the transcript source is absent', async () => {
    const h = harness({
      hostOutcomeClock: 'shared-unix-ms',
      baselineFor: () => undefined,
      readTerminalEvidence: async () => undefined,
      input: {
        client: {
          session: {
            // No session.messages: capability absence. The undefined
            // evidence read is a dead end, not a pending transcript,
            // so the window-attributed success publishes completed.
            get: async () => ({
              data: { outcome: 'succeeded', time: { idle: 50 } },
            }),
          },
        },
      } as never,
    });
    h.observe('quiescent');
    h.advance(61);
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'completed',
      terminalRevision: 1,
      resultSummary: 'Host reported outcome: succeeded.',
    });
  });
  test('an attributable interrupted publishes stopped, never error, when the transcript source is absent', async () => {
    const h = harness({
      hostOutcomeClock: 'shared-unix-ms',
      baselineFor: () => undefined,
      readTerminalEvidence: async () => undefined,
      input: {
        client: {
          session: {
            // No session.messages: capability absence, same as the
            // succeeded twin above.
            get: async () => ({
              data: { outcome: 'interrupted', time: { idle: 50 } },
            }),
          },
        },
      } as never,
    });
    h.observe('quiescent');
    h.advance(61);
    await h.gate.reconcile(h.run);
    // The host distinguished an interruption from a failure; the board
    // stop family (no plugin-verified cancel lease) must carry it.
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'stopped',
      terminalRevision: 1,
      resultSummary: 'Host reported outcome: interrupted.',
    });
  });
  test('board rejects freely fabricated terminal authorization', async () => {
    const h = harness();
    const validate = mock(() => true);
    h.board.commitTerminal(
      { taskID: h.run.taskID, state: 'completed', resultSummary: 'forged' },
      { taskID: h.run.taskID, generation: h.run.generation, validate } as never,
    );
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    expect(validate).not.toHaveBeenCalled();
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.resultSummary).toBe('answer');
  });
  test('terminal authorization belongs to the currently bound gate and is single-use', async () => {
    const h = harness();
    const commit = h.board.commitTerminal.bind(h.board);
    const intercepted = spyOn(h.board, 'commitTerminal').mockImplementation(
      () => h.board.get(h.run.taskID),
    );
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    const [input, token] = intercepted.mock.calls[0];
    intercepted.mockRestore();
    const replacement = createBackgroundJobTerminalGate({
      backgroundJobBoard: h.board,
    });
    gates.push(replacement);
    commit(input, token);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    h.board.bindTerminalGate(h.gate);
    commit(input, token);
    expect(h.board.get(h.run.taskID)?.state).toBe('completed');
    const terminal = h.board.get(h.run.taskID);
    if (!terminal) throw new Error('missing terminal publication');
    const busy = h.gate.capture(terminal);
    if (!busy) throw new Error('missing current observation');
    h.gate.observe(busy, {
      kind: 'busy',
      origin: 'session.status',
      readStartedAt: busy.readStartedAt,
    });
    commit(input, token);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
  });
  test('late busy event does not become fresh activity at reception', async () => {
    const h = harness();
    h.advance(20);
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    h.advance(100);
    const token = h.gate.capture(h.run);
    if (!token) throw new Error('missing current observation');
    expect(
      h.gate.observe(token, {
        kind: 'busy',
        origin: 'session.status-event',
        observedAt: 10,
        readStartedAt: token.readStartedAt,
      }).kind,
    ).toBe('deferred');
    expect(h.board.get(h.run.taskID)?.state).toBe('completed');
    expect(
      h.gate.observe(token, {
        kind: 'busy',
        origin: 'session.status-event',
        observedAt: 30,
        readStartedAt: token.readStartedAt,
      }).kind,
    ).toBe('stale');
    const freshToken = h.gate.capture(h.run);
    if (!freshToken) throw new Error('missing fresh observation');
    h.gate.observe(freshToken, {
      kind: 'busy',
      origin: 'session.status-event',
      observedAt: 30,
      readStartedAt: freshToken.readStartedAt,
    });
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'running',
      lastLiveBusyAt: 30,
    });
  });
  test('task_result leaves a differing native result unacknowledged rather than substituting text', async () => {
    let response: unknown;
    const h = harness({ readTerminalEvidence: async () => response });
    h.observe('quiescent');
    await h.gate.reconcile(h.run, {
      kind: 'output',
      origin: { kind: 'native', run: h.run, callID: 'native' },
      status: {
        taskID: h.run.taskID,
        state: 'completed',
        timedOut: false,
        result: 'native result',
      },
    });
    response = answer('different transcript result');
    const input = {
      directory: '/tmp',
      client: {
        session: { get: async () => ({ data: { parentID: 'parent' } }) },
      },
    } as never;
    const result = createTaskResultTool({
      input,
      backgroundJobBoard: h.board,
      terminalGate: h.gate,
    }).task_result;
    expect(
      await result.execute({ task_id: h.run.taskID }, {
        sessionID: 'parent',
      } as never),
    ).toContain('unconfirmed');
    expect(h.board.get(h.run.taskID)).toMatchObject({
      resultSummary: 'native result',
      terminalRevision: 1,
      terminalUnreconciled: true,
    });
  });
  test('a hung child read does not block confirmation of another child', async () => {
    let release!: (value: unknown) => void;
    const h = harness({
      graceMs: 1000,
      readTerminalEvidence: (taskID) =>
        taskID === 'ses_child'
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve(answer('other result')),
    });
    h.observe('quiescent');
    const pending = h.gate.reconcile(h.run);
    await tick();
    const other = h.board.registerLaunch({
      taskID: 'other',
      parentSessionID: 'parent',
      agent: 'fixer',
      now: 0,
    });
    const token = h.gate.capture(other);
    if (!token) throw new Error('missing other child observation');
    h.gate.observe(token, {
      kind: 'quiescent',
      origin: 'test',
      readStartedAt: token.readStartedAt,
    });
    await h.gate.reconcile(other);
    expect(h.board.get('other')).toMatchObject({
      state: 'completed',
      resultSummary: 'other result',
    });
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    release(undefined);
    await pending;
  });
  test.each(['transcript', 'outcome', 'v2-outcome'])(
    'handoff activated during %s await blocks publication',
    async (stage) => {
      let blocked = false;
      let release!: (value: unknown) => void;
      const held = () =>
        new Promise((resolve) => {
          release = resolve;
        });
      const h = harness({
        hostOutcomeClock: 'shared-unix-ms',
        input: {
          directory: '/tmp',
          client: { session: { get: held } },
        } as never,
        readRuntime:
          stage === 'v2-outcome'
            ? undefined
            : async (_run, readStartedAt) => ({
                kind: 'quiescent',
                origin: 'test',
                readStartedAt,
              }),
        readTerminalEvidence:
          stage === 'transcript' ? held : async () => ({ data: [] }),
        isObservationPending: () => blocked,
        graceMs: 1000,
      });
      const pending = h.gate.reconcile(h.run);
      await tick();
      expect(release).toBeFunction();
      blocked = true;
      release(
        stage === 'transcript'
          ? answer()
          : { data: { outcome: 'failed', time: { idle: 1 } } },
      );
      await pending;
      expect(h.board.get(h.run.taskID)?.state).toBe('running');
    },
  );
  test('late resolution after timeout and identity replacement cannot be reused', async () => {
    let release!: (value: unknown) => void;
    const read = mock(
      (): Promise<unknown> =>
        read.mock.calls.length === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve(answer('new identity')),
    );
    const h = harness({
      readTerminalEvidence: read,
      readTimeoutMs: 2,
      graceMs: 1000,
    });
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    const replacement = h.board.registerLaunch({
      taskID: h.run.taskID,
      parentSessionID: 'parent',
      agent: 'fixer',
      now: 10,
    });
    const token = h.gate.capture(replacement);
    if (!token) throw new Error('missing replacement observation');
    h.gate.observe(token, {
      kind: 'quiescent',
      origin: 'test',
      readStartedAt: token.readStartedAt,
    });
    await h.gate.reconcile(replacement);
    expect(read).toHaveBeenCalledTimes(1);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    release(answer('obsolete'));
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'completed',
      generation: replacement.generation,
      resultSummary: 'new identity',
    });
  });
  test('completed transcript without quiescence stays running', async () => {
    const h = harness();
    expect((await h.gate.reconcile(h.run)).kind).toBe('deferred');
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
  });
  test.each(
    (['completed', 'error', 'cancelled'] as const).flatMap((state) =>
      (['busy', 'retry'] as const).map((activity) => ({ state, activity })),
    ),
  )(
    'parsed terminal output remains a candidate under a live v1 map: %j',
    async ({ state, activity }) => {
      const get = mock(async () => ({
        data: { outcome: 'failed', time: { idle: 1 } },
      }));
      const h = harness({
        input: {
          client: {
            session: {
              status: async () => ({ data: { ses_child: { type: activity } } }),
              get,
            },
          },
        } as never,
        hostOutcomeClock: 'shared-unix-ms',
      });
      await h.gate.reconcile(h.run, {
        kind: 'output',
        status: {
          taskID: h.run.taskID,
          state,
          result: 'historical',
          timedOut: false,
        },
        origin: { kind: 'native', run: h.run, callID: 'call' },
      });
      expect(h.board.get(h.run.taskID)?.state).toBe('running');
      expect(get).not.toHaveBeenCalled();
    },
  );
  test('quiescence plus attributable transcript commits exactly once', async () => {
    const h = harness();
    const listener = mock(() => {});
    h.board.addTerminalStateListener(listener);
    h.observe('quiescent');
    expect((await h.gate.reconcile(h.run)).kind).toBe('committed');
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'completed',
      terminalRevision: 1,
      resultSummary: 'answer',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
  test('valid absence stops only after grace', async () => {
    const h = harness({
      readTerminalEvidence: async () => ({ data: [] }),
      baselineFor: () => undefined,
    });
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    h.advance(7);
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.state).toBe('stopped');
  });
  test('unknown never becomes stopped by exhausting retries', async () => {
    const h = harness({
      readTerminalEvidence: async () => undefined,
      maxEvidenceRetries: 1,
    });
    h.observe('quiescent');
    h.advance(20);
    for (let i = 0; i < 4; i++) await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'running',
      lastStatusError: EVIDENCE_UNAVAILABLE_DIAGNOSTIC,
    });
  });
  test.each(['status', 'no runtime API'])(
    'runtime unknown retries are bounded for %s',
    async (source) => {
      const readRuntime = mock(
        async (
          _run: unknown,
          readStartedAt: number,
        ): Promise<RuntimeObservation> => ({
          kind: 'unknown',
          origin: 'session.status',
          readStartedAt,
        }),
      );
      const inspect = mock(() => {});
      const h = harness({
        readRuntime: source === 'status' ? readRuntime : undefined,
        observationRevisionFor: () => {
          inspect();
          return 1;
        },
        graceMs: 5,
      });
      await h.gate.reconcile(h.run);
      for (
        let i = 0;
        i < 100 &&
        h.board.get(h.run.taskID)?.lastStatusError !==
          EVIDENCE_UNAVAILABLE_DIAGNOSTIC;
        i++
      )
        await tick();
      expect(h.board.get(h.run.taskID)).toMatchObject({
        state: 'running',
        statusUncertain: true,
        lastStatusError: EVIDENCE_UNAVAILABLE_DIAGNOSTIC,
      });
      expect(readRuntime).toHaveBeenCalledTimes(source === 'status' ? 4 : 0);
      const calls = inspect.mock.calls.length;
      await Bun.sleep(25);
      expect(inspect).toHaveBeenCalledTimes(calls);
    },
  );
  test('busy during an evidence await immediately invalidates it', async () => {
    let resolve!: (value: unknown) => void;
    const h = harness({
      readTerminalEvidence: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    h.observe('quiescent');
    const pending = h.gate.reconcile(h.run);
    await tick();
    h.observe('busy');
    resolve(answer());
    await pending;
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'running',
      resultSummary: undefined,
    });
  });
  test('textless completion needs independent host termination and stabilization, never a parsed label', async () => {
    let terminated = false;
    const h = harness({
      maxEvidenceRetries: 1,
      readTerminalEvidence: async () => answer(''),
      readRuntime: async (_run, readStartedAt) => ({
        kind: 'quiescent',
        origin: 'host',
        readStartedAt,
        terminalOutcome: terminated ? 'succeeded' : undefined,
      }),
    });
    for (let i = 0; i < 3; i++)
      await h.gate.reconcile(h.run, {
        kind: 'output',
        status: {
          taskID: h.run.taskID,
          state: 'completed',
          timedOut: false,
          result: '',
        },
        origin: { kind: 'native', run: h.run, callID: 'call' },
      });
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    terminated = true;
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    h.advance(10);
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.state).toBe('error');
  });
  test('consumer timeouts never accumulate underlying reads', async () => {
    const read = mock(() => new Promise(() => {}));
    const h = harness({
      readTerminalEvidence: read,
      readTimeoutMs: 2,
      graceMs: 1000,
    });
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    await h.gate.reconcile(h.run);
    expect(read).toHaveBeenCalledTimes(1);
    h.observe('busy');
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    expect(read).toHaveBeenCalledTimes(1);
  });
  test.each([
    'coalesced',
    'new-episode-requested',
    'episode',
    'generation',
    'dispose',
  ] as const)(
    'pending runtime contrast handles %s without duplicate or stale reads',
    async (change) => {
      let release!: () => void;
      const readSettled = new Promise<void>((resolve) => {
        release = resolve;
      });
      let open = true;
      const readRuntime = mock(
        async (
          _run: unknown,
          readStartedAt: number,
        ): Promise<RuntimeObservation> => ({
          kind: open ? 'unknown' : 'busy',
          origin: 'session.status',
          readStartedAt,
          retryAfter: open ? readSettled : undefined,
        }),
      );
      const h = harness({ readRuntime });
      await h.gate.reconcile(h.run);
      await h.gate.reconcile(h.run);
      if (change === 'episode' || change === 'new-episode-requested')
        h.observe('unknown');
      if (change === 'new-episode-requested') await h.gate.reconcile(h.run);
      if (change === 'generation')
        h.board.registerLaunch({
          ...h.run,
          parentSessionID: 'parent',
          agent: 'fixer',
        });
      if (change === 'dispose') h.gate.dispose();
      const readsBeforeRelease = readRuntime.mock.calls.length;
      open = false;
      release();
      await tick();
      const freshReads =
        change === 'coalesced' || change === 'new-episode-requested' ? 1 : 0;
      expect(readRuntime).toHaveBeenCalledTimes(
        readsBeforeRelease + freshReads,
      );
      expect(h.board.get(h.run.taskID)?.state).toBe('running');
    },
  );
  test.each(['baseline', 'revision', 'episode', 'generation', 'dispose'])(
    'late evidence cannot cross changed %s',
    async (change) => {
      let baseline = 'baseline';
      let revision = 1;
      let resolve!: (value: unknown) => void;
      const h = harness({
        baselineFor: () => baseline,
        observationRevisionFor: () => revision,
        readTerminalEvidence: () =>
          new Promise((done) => {
            resolve = done;
          }),
      });
      h.observe('quiescent');
      const pending = h.gate.reconcile(h.run);
      await tick();
      if (change === 'baseline') baseline = 'new';
      if (change === 'revision') revision++;
      if (change === 'episode') {
        h.observe('busy');
        h.observe('quiescent');
      }
      if (change === 'generation')
        h.board.registerLaunch({
          ...h.run,
          parentSessionID: 'parent',
          agent: 'fixer',
        });
      if (change === 'dispose') h.gate.dispose();
      resolve(answer());
      await pending;
      expect(h.board.get(h.run.taskID)?.state).toBe('running');
    },
  );
  test('handoff blocks publication without discarding ownership', async () => {
    let blocked = true;
    const h = harness({ isObservationPending: () => blocked });
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    blocked = false;
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.state).toBe('completed');
  });
  test('valid absence and malformed map entry have distinct observations', () => {
    expect(
      runtimeObservationFromSnapshot(
        { statuses: new Map(), malformedSessionIDs: new Set() },
        'child',
        1,
      ).kind,
    ).toBe('quiescent');
    expect(
      runtimeObservationFromSnapshot(
        { statuses: new Map(), malformedSessionIDs: new Set(['child']) },
        'child',
        1,
      ).kind,
    ).toBe('unknown');
  });
  test('deadline deletion commits synchronously before drop', () => {
    const h = harness();
    h.board.claimWallClockDeadline(h.run);
    const result = h.observe('deleted');
    expect(result.kind).toBe('committed');
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'error',
      timedOut: true,
    });
  });
});

test('integration: historical replay + rehydration + busy host publishes nothing and retains capacity', async () => {
  const board = new BackgroundJobBoard();
  const coordinator = new BackgroundJobCoordinator(board);
  const capacity = new BackgroundTaskConcurrency({
    defaultConcurrency: 1,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  const release = mock((taskID: string) => capacity.releaseTask(taskID));
  coordinator.addTerminalOutcomeListener((record) => release(record.taskID));
  const input = {
    directory: '/tmp',
    client: {
      session: {
        status: async () => ({ data: { ses_child: { type: 'busy' } } }),
        get: async () => ({
          data: { parentID: 'parent', outcome: 'succeeded' },
        }),
        messages: async () => answer('historical answer'),
      },
    },
  } as never;
  const gate = createBackgroundJobTerminalGate({
    input,
    backgroundJobBoard: coordinator,
  });
  gates.push(gate);
  const hook = createTaskSessionManagerHook(input, {
    backgroundJobBoard: coordinator,
    terminalGate: gate,
    backgroundTaskConcurrency: capacity,
    shouldManageSession: () => true,
    maxSessionsPerAgent: 10,
    maxRetainedSnapshots: 10,
  });
  const messages = [
    {
      info: {
        id: 'm1',
        sessionID: 'parent',
        role: 'assistant',
        agent: 'orchestrator',
      },
      parts: [
        {
          id: 'p1',
          type: 'tool',
          tool: 'task',
          state: {
            status: 'completed',
            input: { background: true, subagent_type: 'fixer' },
            output: 'task_id: ses_child\nstate: running',
          },
        },
      ],
    },
    {
      info: {
        id: 'm2',
        sessionID: 'parent',
        role: 'user',
        agent: 'orchestrator',
      },
      parts: [
        {
          id: 'p2',
          type: 'text',
          synthetic: true,
          text: '<task id="ses_child" state="completed"><task_result>historical answer</task_result></task>',
        },
      ],
    },
  ];
  await hook['experimental.chat.messages.transform']({}, { messages });
  expect(board.get('ses_child')?.state).toBe('running');
  expect(release).not.toHaveBeenCalled();
  let admitted = false;
  const ticket = capacity.acquire({});
  void ticket.ready.then(
    () => {
      admitted = true;
    },
    () => {},
  );
  await tick();
  expect(admitted).toBe(false);
  ticket.release();
  capacity.dispose();
  await hook.event({ event: { type: 'server.instance.disposed' } });
});

test('integration: late acknowledgement and transport success for A cannot consume terminal B', async () => {
  const timers = new Map<number, { delay: number; callback: () => void }>();
  let nextID = 0;
  const setTimer = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay: number,
  ) => {
    const id = ++nextID;
    timers.set(id, { delay, callback });
    return id;
  }) as typeof setTimeout);
  const clearTimer = spyOn(globalThis, 'clearTimeout').mockImplementation(((
    id: number,
  ) => {
    timers.delete(id);
  }) as typeof clearTimeout);
  const tick = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };
  const fire = (delay: number) => {
    const entry = [...timers.entries()].find(
      ([, timer]) => timer.delay === delay,
    );
    expect(entry).toBeDefined();
    if (entry) {
      timers.delete(entry[0]);
      entry[1].callback();
    }
  };
  const board = new BackgroundJobBoard();
  const run = board.registerLaunch({
    taskID: 'ses_child',
    parentSessionID: 'parent',
    agent: 'fixer',
    background: true,
    now: 0,
  });
  let text = 'A';
  let resolveA!: (value: unknown) => void;
  let rejectB!: (error: unknown) => void;
  const transport = mock(
    (_input: { body: { parts: Array<{ text: string }> } }) =>
      transport.mock.calls.length === 1
        ? new Promise((resolve) => {
            resolveA = resolve;
          })
        : transport.mock.calls.length === 2
          ? new Promise((_, reject) => {
              rejectB = reject;
            })
          : Promise.resolve({}),
  );
  const input = {
    directory: '/tmp',
    client: {
      session: { promptAsync: transport, messages: async () => answer(text) },
    },
  } as never;
  let tracker: ReturnType<typeof createRevivedRunTracker>;
  const gate = createBackgroundJobTerminalGate({
    backgroundJobBoard: board,
    input,
    baselineFor: () => 'baseline',
    onTerminal: (record) => tracker.onTerminal(record),
  });
  gates.push(gate);
  tracker = createRevivedRunTracker({
    input,
    backgroundJobBoard: board,
    terminalGate: gate,
    maxNotificationRetries: 2,
    notificationRetryDelayMs: 1,
  });
  tracker.register({ ...run, baselineMessageID: 'baseline' });
  const hook = createTaskSessionManagerHook(input, {
    backgroundJobBoard: board,
    terminalGate: gate,
    shouldManageSession: () => true,
    maxSessionsPerAgent: 10,
    maxRetainedSnapshots: 10,
  });
  try {
    const observe = (kind: 'busy' | 'quiescent') => {
      const token = gate.capture(run);
      if (!token) throw new Error('missing observation');
      gate.observe(token, {
        kind,
        origin: 'test',
        readStartedAt: token.readStartedAt,
      });
    };
    observe('quiescent');
    await gate.reconcile(run);
    await tick();
    const a = board.get(run.taskID);
    if (!a) throw new Error('missing terminal A');
    const messages = [
      {
        info: {
          id: 'parent-before',
          sessionID: 'parent',
          role: 'user',
          agent: 'orchestrator',
        },
        parts: [{ type: 'text', text: 'inspect results' }],
      },
    ];
    await hook['experimental.chat.messages.transform']({}, { messages });
    await hook.injectBackgroundJobBoard({}, { messages });
    observe('busy');
    text = 'B';
    observe('quiescent');
    await gate.reconcile(run);
    await tick();
    const b = board.get(run.taskID);
    if (!b) throw new Error('missing terminal B');
    tracker.onTerminal(a); // A delayed adapter callback must not replace B's notification state.
    for (let i = 0; i < 4; i++) {
      fire(1); // Lease contention is not a failed send attempt for B.
      await tick();
    }
    expect(transport).toHaveBeenCalledTimes(1);
    expect(b.terminalRevision).toBeGreaterThan(a.terminalRevision);
    messages.push({
      info: {
        id: 'parent-after',
        sessionID: 'parent',
        role: 'assistant',
        agent: 'orchestrator',
      },
      parts: [{ type: 'text', text: 'received the previous board' }],
    });
    const acknowledge = spyOn(board, 'markReconciled');
    await hook['experimental.chat.messages.transform']({}, { messages });
    await hook.injectBackgroundJobBoard({}, { messages });
    // The adapter rejects A before invoking the board's acknowledgement method.
    expect(acknowledge).not.toHaveBeenCalled();
    expect(
      board.acquireRelaunchLease(run.taskID, run.generation),
    ).toBeUndefined();
    fire(10_000); // A never settled: its local wait alone must release ownership.
    await tick();
    const lease = board.acquireRelaunchLease(run.taskID, run.generation);
    expect(lease).toBeDefined();
    if (lease) board.releaseLease(lease);
    fire(1);
    await tick();
    expect(transport).toHaveBeenCalledTimes(2); // B progresses without A's settlement.
    resolveA({});
    await tick();
    expect(
      board.acquireRelaunchLease(run.taskID, run.generation),
    ).toBeUndefined();
    rejectB(new Error('B was not accepted'));
    await tick();
    fire(1); // A's success cannot accept B or cancel B's retry.
    await tick();
    expect(board.get(run.taskID)).toMatchObject({
      state: 'completed',
      resultSummary: 'B',
      terminalUnreconciled: true,
      terminalRevision: b.terminalRevision,
    });
    expect(transport.mock.calls.length).toBe(3);
    expect(transport.mock.calls[1][0].body.parts[0].text).toContain(
      '<task_result>\nB\n</task_result>',
    );
    messages.push({
      info: {
        id: 'consume-B',
        sessionID: 'parent',
        role: 'assistant',
        agent: 'orchestrator',
      },
      parts: [{ type: 'text', text: 'received B' }],
    });
    await hook['experimental.chat.messages.transform']({}, { messages });
    await hook.injectBackgroundJobBoard({}, { messages });
    expect(
      acknowledge.mock.calls.some(
        ([taskID, , generation, revision]) =>
          taskID === run.taskID &&
          generation === run.generation &&
          revision === b.terminalRevision,
      ),
    ).toBe(true);
    acknowledge.mockRestore();
  } finally {
    resolveA?.({});
    tracker.dispose();
    await hook.event({ event: { type: 'server.instance.disposed' } });
    setTimer.mockRestore();
    clearTimer.mockRestore();
  }
});

test.each(['transcript', 'outcome'])(
  'v2 real shim resumes after %s retry cutoff on the next idle event and returns an idempotent result',
  async (source) => {
    let valid = false;
    const context = mock(async () => {
      if (!valid) throw new Error('context temporarily unavailable');
      return [
        { id: 'baseline', role: 'user', content: [] },
        {
          id: 'result',
          role: 'assistant',
          content: [{ type: 'text', text: 'v2 result' }],
        },
      ];
    });
    const get = mock(
      async (): Promise<{
        id: string;
        parentID: string;
        outcome?: 'succeeded';
        time?: { idle: number };
      }> => ({
        id: 'ses_v2child',
        parentID: 'parent',
        outcome: source === 'transcript' || valid ? 'succeeded' : undefined,
        time: { idle: Date.now() },
      }),
    );
    const input = buildPluginInput({
      location: { directory: '/tmp' },
      session: {
        get,
        context,
      },
    } as never) as never;
    const board = new BackgroundJobBoard();
    const run = board.registerLaunch({
      taskID: 'ses_v2child',
      parentSessionID: 'parent',
      agent: 'fixer',
      now: 0,
    });
    const gate = createBackgroundJobTerminalGate({
      input,
      backgroundJobBoard: board,
      baselineFor: () => 'baseline',
      maxEvidenceRetries: source === 'transcript' ? 1 : 3,
      hostOutcomeClock: 'shared-unix-ms',
      graceMs: 5,
    });
    gates.push(gate);
    const hook = createTaskSessionManagerHook(input, {
      terminalGate: gate,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      maxSessionsPerAgent: 10,
      maxRetainedSnapshots: 10,
    });
    const idle = () =>
      hook.event({
        event: { type: 'session.idle', properties: { sessionID: run.taskID } },
      });
    try {
      await idle();
      for (
        let i = 0;
        i < 50 &&
        board.get(run.taskID)?.lastStatusError !==
          EVIDENCE_UNAVAILABLE_DIAGNOSTIC;
        i++
      )
        await tick();
      expect(board.get(run.taskID)).toMatchObject({
        state: 'running',
        statusUncertain: true,
        lastStatusError: EVIDENCE_UNAVAILABLE_DIAGNOSTIC,
      });
      const calls = context.mock.calls.length;
      const runtimeCalls = get.mock.calls.length;
      if (source === 'outcome') {
        expect(runtimeCalls).toBe(4);
        expect(context).not.toHaveBeenCalled();
      }
      await Bun.sleep(25); // More than graceMs * 4: neither reader may keep polling.
      expect(context).toHaveBeenCalledTimes(calls);
      expect(get).toHaveBeenCalledTimes(runtimeCalls);
      if (source === 'outcome') {
        // The host signal must renew the budget even if its first lookup still
        // lacks outcome. The next automatic retry, not another signal, succeeds.
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        get.mockImplementationOnce(async () => {
          await pending;
          return { id: 'ses_v2child', parentID: 'parent' };
        });
        await idle();
        for (let i = 0; i < 50 && get.mock.calls.length === runtimeCalls; i++)
          await tick();
        expect(get).toHaveBeenCalledTimes(runtimeCalls + 1);
        valid = true;
        release();
      } else {
        valid = true;
        await idle();
      }
      for (let i = 0; i < 50 && board.get(run.taskID)?.state === 'running'; i++)
        await tick();
      expect(board.get(run.taskID)).toMatchObject({
        state: 'completed',
        resultSummary: 'v2 result',
      });
      const result = createTaskResultTool({
        input,
        backgroundJobBoard: board,
        terminalGate: gate,
      }).task_result;
      expect(
        await result.execute({ task_id: run.taskID }, {
          sessionID: 'parent',
        } as never),
      ).toBe('v2 result');
      expect(
        await result.execute({ task_id: run.taskID }, {
          sessionID: 'parent',
        } as never),
      ).toBe('v2 result');
      expect(context).toHaveBeenCalledWith({ sessionID: run.taskID });
    } finally {
      await hook.event({ event: { type: 'server.instance.disposed' } });
    }
  },
);

describe('foreground native terminal fast path (r2 hardening)', () => {
  test.each([
    [
      'unattributed native return keeps the full runtime discipline',
      false,
      false,
    ],
    [
      'ambiguous untimestamped busy kills a held foreground candidate',
      true,
      true,
    ],
  ] as const)('%s', async (_name, callIDConfirmed, ambiguousBusy) => {
    const board = new BackgroundJobBoard();
    const run = board.registerLaunch({
      taskID: `ses_fg_${ambiguousBusy ? 'ambiguous' : 'unattributed'}`,
      parentSessionID: 'parent',
      agent: 'fixer',
      background: false,
      now: 0,
    });
    // First row runs without a pending handoff so it isolates the
    // attribution barrier; second row holds the candidate behind one.
    let observationPending = ambiguousBusy;
    const gate = createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      readTerminalEvidence: async () => answer(),
      isObservationPending: () => observationPending,
      graceMs: 5,
      now: () => 1,
    });
    gates.push(gate);
    const held = await gate.reconcile(run, {
      kind: 'output',
      origin: {
        kind: 'native',
        run,
        callID: 'call',
        ...(callIDConfirmed ? { callIDConfirmed: true } : {}),
      },
      status: {
        taskID: run.taskID,
        state: 'completed',
        timedOut: false,
        result: 'done',
      },
    });
    expect(held.kind).toBe('deferred');
    expect(board.get(run.taskID)?.state).toBe('running');
    if (!ambiguousBusy) return;
    const token = gate.capture(run);
    if (!token) throw new Error('missing observation token');
    gate.observe(token, {
      kind: 'busy',
      origin: 'session.status-event',
      readStartedAt: token.readStartedAt,
    });
    observationPending = false;
    const after = await gate.reconcile(run);
    expect(after.kind).toBe('deferred');
    expect(board.get(run.taskID)?.state).toBe('running');
  });

  test('confirmed foreground textless completion publishes error, not invented success', async () => {
    const board = new BackgroundJobBoard();
    const run = board.registerLaunch({
      taskID: 'ses_fg_textless',
      parentSessionID: 'parent',
      agent: 'fixer',
      background: false,
      now: 0,
    });
    const gate = createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      // No terminal transcript evidence: the native return is the only
      // evidence, so guardCompletedStatusText decides the publication.
      readTerminalEvidence: async () => ({ data: [] }),
      graceMs: 5,
      now: () => 1,
    });
    gates.push(gate);
    const result = await gate.reconcile(run, {
      kind: 'output',
      origin: { kind: 'native', run, callID: 'call', callIDConfirmed: true },
      status: { taskID: run.taskID, state: 'completed', timedOut: false },
    });
    expect(result.kind).toBe('committed');
    expect(board.get(run.taskID)).toMatchObject({
      state: 'error',
      resultSummary: COMPLETED_WITHOUT_TEXT_DIAGNOSTIC,
    });
  });
});

describe('background reconcile failure containment', () => {
  test('a failing scheduled reconcile is logged and contained, never an unhandled rejection', async () => {
    // Regression (CI-only flake): a scheduled retry reconcile still in
    // flight when another test file swaps the process-global getClient
    // mock used to reject inside the fire-and-forget `void reconcile(run)`
    // timer callback; the escaping rejection crashed whichever test was
    // running by then. Background reconciliation is fail-soft: failures
    // are logged and swallowed.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // Throw on every getClient resolution only while armed — i.e. from
      // the moment the first (awaited) reconcile has scheduled the retry
      // timer until we re-arm recovery. Exactly the CI scenario: the
      // scheduled reconcile resolves its client after another test file
      // swapped the process-global getClient mock.
      let armed = false;
      let armedThrows = 0;
      let clientReads = 0;
      const input = {
        directory: '/tmp',
        get client() {
          clientReads += 1;
          if (armed) {
            armedThrows += 1;
            throw new Error('client vanished mid-flight');
          }
          return {
            session: { status: async () => ({}) },
          };
        },
      } as never;
      const h = harness({ graceMs: 1, input });

      // Awaited reconcile: the status read yields an invalid-response
      // snapshot → unknown runtime → a retry is scheduled (timer) and the
      // result is deferred, not a rejection.
      const first = await h.gate.reconcile(h.run);
      expect(first.kind).toBe('deferred');
      expect(clientReads).toBeGreaterThanOrEqual(2);

      armed = true;
      // Flush the scheduled timer plus pending microtask/macrotask turns
      // so the fire-and-forget reconcile has fully settled.
      for (let i = 0; i < 8; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      // The scheduled reconcile really did hit the throwing client...
      expect(armedThrows).toBeGreaterThanOrEqual(1);

      // ...but the failure never escaped as an unhandled rejection.
      expect(unhandled).toEqual([]);

      // The gate still operates afterwards (client recovered).
      armed = false;
      const next = await h.gate.reconcile(h.run);
      expect(['deferred', 'stale']).toContain(next.kind);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('terminal gate observability (INFO logs)', () => {
  function captureLogs() {
    const entries: Array<{ message: string; data: unknown }> = [];
    const spy = spyOn(loggerModule, 'log').mockImplementation(
      (message: string, data?: unknown) => {
        entries.push({ message, data });
      },
    );
    return {
      entries,
      of: (message: string) =>
        entries.filter((entry) => entry.message === message),
      restore: () => spy.mockRestore(),
    };
  }

  test('host-outcome attribution attempt logs attempt number and attribution window', async () => {
    const capture = captureLogs();
    try {
      let clock = 140;
      const h = harness({
        hostOutcomeClock: 'shared-unix-ms',
        now: () => clock,
        maxEvidenceRetries: 0,
        baselineFor: () => undefined,
        readTerminalEvidence: async () => ({ data: [] }),
        input: {
          client: {
            session: {
              get: async () => {
                clock = 200;
                return { data: { outcome: 'failed', time: { idle: 150 } } };
              },
            },
          },
        } as never,
      });
      const run = h.board.registerLaunch({
        taskID: h.run.taskID,
        parentSessionID: 'parent',
        agent: 'fixer',
        now: 100,
      });
      await h.gate.reconcile(run);
      expect(
        capture.of('[terminal-gate] host-outcome read initiated'),
      ).toHaveLength(1);
      const attempts = capture.of('[terminal-gate] host-outcome attribution');
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.data).toMatchObject({
        taskID: run.taskID,
        generation: run.generation,
        state: 'running',
        attribution: 'host-outcome',
        attempt: 0,
        outcome: 'failed',
        windowLower: 100,
        windowUpper: 200,
        verdict: 'accepted',
      });
      const published = capture.of('[terminal-gate] terminal published');
      expect(published).toHaveLength(1);
      expect(published[0]?.data).toMatchObject({
        taskID: run.taskID,
        generation: run.generation,
        state: 'error',
        attribution: 'host-outcome',
        parentSessionID: 'parent',
      });
    } finally {
      capture.restore();
    }
  });

  test('rejected host-outcome attribution logs the rejection reason', async () => {
    const capture = captureLogs();
    try {
      const h = harness({
        hostOutcomeClock: 'shared-unix-ms',
        baselineFor: () => undefined,
        readTerminalEvidence: async () => ({ data: [] }),
        input: {
          client: {
            session: {
              get: async () => ({
                data: { outcome: 'running', time: { idle: 150 } },
              }),
            },
          },
        } as never,
      });
      h.advance(200);
      await h.gate.reconcile(h.run);
      const attempts = capture.of('[terminal-gate] host-outcome attribution');
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.data).toMatchObject({
        taskID: h.run.taskID,
        attribution: 'host-outcome',
        attempt: 0,
        verdict: 'rejected',
        reason: 'unrecognized-outcome:running',
      });
    } finally {
      capture.restore();
    }
  });

  test('transcript publication logs transcript attribution', async () => {
    const capture = captureLogs();
    try {
      const h = harness();
      h.observe('quiescent');
      await h.gate.reconcile(h.run);
      const published = capture.of('[terminal-gate] terminal published');
      expect(published).toHaveLength(1);
      expect(published[0]?.data).toMatchObject({
        taskID: h.run.taskID,
        generation: h.run.generation,
        state: 'completed',
        attribution: 'transcript',
        parentSessionID: 'parent',
      });
    } finally {
      capture.restore();
    }
  });

  test('evidence-unavailable give-up logs the exhausted attempt count', async () => {
    const capture = captureLogs();
    try {
      const h = harness({
        maxEvidenceRetries: 0,
        readTerminalEvidence: async () => undefined,
      });
      await h.gate.reconcile(h.run);
      const giveUps = capture.of(
        '[terminal-gate] terminal evidence unavailable',
      );
      expect(giveUps).toHaveLength(1);
      expect(giveUps[0]?.data).toMatchObject({
        taskID: h.run.taskID,
        generation: h.run.generation,
        state: 'running',
        attempt: 1,
        verdict: 'gave-up',
      });
    } finally {
      capture.restore();
    }
  });
});
