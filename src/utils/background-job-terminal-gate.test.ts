import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createTaskSessionManagerHook } from '../hooks/task-session-manager';
import { createRevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import { createTaskStatusTool } from '../tools/task-status';
import { buildPluginInput } from '../v2/client-shim';
import {
  BackgroundJobBoard,
  type BackgroundJobTerminalInput,
} from './background-job-board';
import {
  type BackgroundJobTerminalGate,
  consumeTerminalCommitToken,
  createBackgroundJobTerminalGate,
  EVIDENCE_UNAVAILABLE_DIAGNOSTIC,
  idleContradictsBusy,
  type RuntimeObservation,
  runtimeObservationFromSnapshot,
  type TerminalCommitToken,
} from './background-job-terminal-gate';
import { BackgroundTaskConcurrency } from './background-task-concurrency';
import { classifyTerminalEvidence } from './child-transcript';
import * as loggerModule from './logger';
import { readHostSessionInfo } from './session-info-read';
import { COMPLETED_WITHOUT_TEXT_DIAGNOSTIC } from './task';
import { createTimerHarness, tick } from './test-timers';

// Other test files mock the shared opencode-client module process-globally
// (Bun mock.module is never auto-restored). Re-pin it to a passthrough so
// this file always exercises the client each test provides via input.
mock.module('./opencode-client', () => ({
  getClient: (input: { client: unknown }) => input.client as never,
}));

const gates: BackgroundJobTerminalGate[] = [];
/** Shared log capture: several suites assert on gate log lines. */
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
afterEach(() => {
  for (const gate of gates.splice(0)) gate.dispose();
});
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
  const timers = createTimerHarness();
  const gate = createBackgroundJobTerminalGate({
    backgroundJobBoard: board,
    baselineFor: () => 'baseline',
    readTerminalEvidence: async () => answer(),
    graceMs: 5,
    now: () => now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
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
    timers,
    advance: (time: number) => {
      now = time;
    },
    /**
     * Advance BOTH clocks together. The timer harness owns scheduling, while
     * the gate's observation clock is the separate `now` seam above. The
     * attribution window's `readCompletedAt` reads the *observation* clock, so
     * advancing only one strands the other: a late outcome can never then be
     * attributed. Every timer-driven test must use this helper.
     */
    advanceBoth: async (ms: number) => {
      // Both clocks advance by the same DELTA but keep their own origins:
      // the harness clock starts at 0 while this fixture's observation clock
      // starts at 1 and may be moved absolutely with `advance()`. Syncing one
      // to the other's absolute value would rewind the attribution window.
      now += ms;
      await timers.advance(ms);
    },
    observationNow: () => now,
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
      const publications: string[] = [];
      const h = harness({
        hostOutcomeClock: spec.clock,
        now: () => clock,
        attemptStartedAtFor: () => spec.attempt,
        maxEvidenceRetries: 0,
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
      // The board's outcome fan-out is the single publication channel: the
      // gate no longer carries its own terminal callback.
      h.board.addTerminalOutcomeListener((record) => {
        publications.push(`${record.taskID}:${record.terminalRevision}`);
      });
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
      expect(publications).toHaveLength(accepted ? 1 : 0);
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
  test('a foreign probe holding the raw read defers the outcome check without burning retries', async () => {
    let resolveProbe: (value: unknown) => void = () => {};
    let calls = 0;
    const get = mock(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          resolveProbe = resolve;
        });
      }
      return Promise.resolve({
        data: { outcome: 'succeeded', time: { idle: 50 } },
      });
    });
    const probeInput = { client: { session: { get } } };
    const h = harness({
      hostOutcomeClock: 'shared-unix-ms',
      baselineFor: () => undefined,
      readTerminalEvidence: async () => undefined,
      input: probeInput as never,
    });
    h.observe('quiescent');
    h.advance(61);
    // A plain task_status probe occupies the shared slot with its own
    // identity before the gate's outcome read.
    const probe = readHostSessionInfo(probeInput as never, {
      taskID: 'ses_child',
      identity: 'standalone:ses_child',
    });
    await h.gate.reconcile(h.run);
    // Blocked before the deadline race: no gate read, no retry burn, and
    // a repeated blocked reconcile coalesces into one follow-up.
    expect(calls).toBe(1);
    expect(h.board.get(h.run.taskID)).toMatchObject({ state: 'running' });
    await h.gate.reconcile(h.run);
    expect(calls).toBe(1);
    resolveProbe({ data: { outcome: 'succeeded', time: { idle: 50 } } });
    await probe;
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'completed',
      terminalRevision: 1,
      resultSummary: 'Host reported outcome: succeeded.',
    });
    // Exactly one gate read followed the probe.
    expect(calls).toBe(2);
  });
  test('a slow foreign occupant never exhausts the outcome retry budget', async () => {
    let resolveProbe: (value: unknown) => void = () => {};
    let calls = 0;
    const get = mock(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          resolveProbe = resolve;
        });
      }
      return Promise.resolve({
        data: { outcome: 'succeeded', time: { idle: 50 } },
      });
    });
    const probeInput = { client: { session: { get } } };
    const h = harness({
      hostOutcomeClock: 'shared-unix-ms',
      baselineFor: () => undefined,
      readTerminalEvidence: async () => undefined,
      input: probeInput as never,
    });
    h.observe('quiescent');
    h.advance(61);
    const probe = readHostSessionInfo(probeInput as never, {
      taskID: 'ses_child',
      identity: 'standalone:ses_child',
    });
    await h.gate.reconcile(h.run);
    // Advance the wall clock and fire every scheduled timer while the
    // foreign occupant stays unsettled: deferral must be delay-neutral,
    // not a slow retry exhaustion (the bot's exact scenario).
    h.advance(200_000);
    await h.timers.advance(200_000);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(
      String(h.board.get(h.run.taskID)?.resultSummary ?? ''),
    ).not.toContain(EVIDENCE_UNAVAILABLE_DIAGNOSTIC);
    resolveProbe({ data: { outcome: 'succeeded', time: { idle: 50 } } });
    await probe;
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'completed',
      terminalRevision: 1,
    });
  });
  test('accepts OpenCode V2 idleOutcome for a successful child', async () => {
    const h = harness({
      hostOutcomeClock: 'shared-unix-ms',
      baselineFor: () => undefined,
      readTerminalEvidence: async () => undefined,
      input: {
        client: {
          session: {
            get: async () => ({
              data: { idleOutcome: 'succeeded', time: { idle: 50 } },
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
  test('accepts OpenCode V2 idle_outcome for a successful child', async () => {
    const h = harness({
      hostOutcomeClock: 'shared-unix-ms',
      baselineFor: () => undefined,
      readTerminalEvidence: async () => undefined,
      input: {
        client: {
          session: {
            get: async () => ({
              data: { idle_outcome: 'succeeded', time: { idle: 50 } },
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
      {
        taskID: h.run.taskID,
        generation: h.run.generation,
        validate,
      } as never,
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
  test('task_status result mode leaves a differing native result unacknowledged rather than substituting text', async () => {
    let response: unknown;
    const h = harness({ readTerminalEvidence: async () => response });
    h.observe('quiescent');
    await h.gate.reconcile(h.run, {
      kind: 'output',
      origin: {
        kind: 'native',
        run: h.run,
        callID: 'native',
        callIDConfirmed: true,
      },
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
    const result = createTaskStatusTool({
      input,
      backgroundJobBoard: h.board,
      terminalGate: h.gate,
    }).task_status;
    expect(
      await result.execute({ task_id: h.run.taskID, result: true }, {
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
    const read = mock((): Promise<unknown> => {
      if (read.mock.calls.length !== 1)
        return Promise.resolve(answer('new identity'));
      const held = Promise.withResolvers<unknown>();
      release = held.resolve;
      return held.promise;
    });
    const h = harness({
      readTerminalEvidence: read,
      readTimeoutMs: 2,
      graceMs: 1000,
    });
    h.observe('quiescent');
    const firstRead = h.gate.reconcile(h.run);
    await h.timers.tick(); // arm the evidence deadline
    await h.timers.advance(2); // readTimeoutMs
    await firstRead;
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
    const replacementRead = h.gate.reconcile(replacement);
    await h.timers.tick();
    await h.timers.advance(2);
    await replacementRead;
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
    h.board.addTerminalOutcomeListener(listener);
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
        // This test's intent is "exhaustion ends all scheduling", so the
        // slow tier must not arm. The `status` variant has `readRuntime` and
        // no `input`, so it genuinely qualifies for an arm (guards #1/#2 both
        // pass); budget 0 is what expresses the intent. The no-API variant
        // needs no override — the evidence-source guard already refuses it.
        ...(source === 'status' ? { maxEvidenceRearms: 0 } : {}),
      });
      await h.gate.reconcile(h.run);
      for (
        let i = 0;
        i < 100 &&
        h.board.get(h.run.taskID)?.lastStatusError !==
          EVIDENCE_UNAVAILABLE_DIAGNOSTIC;
        i++
      )
        await h.timers.advance(5);
      expect(h.board.get(h.run.taskID)).toMatchObject({
        state: 'running',
        statusUncertain: true,
        lastStatusError: EVIDENCE_UNAVAILABLE_DIAGNOSTIC,
      });
      expect(readRuntime).toHaveBeenCalledTimes(source === 'status' ? 4 : 0);
      const calls = inspect.mock.calls.length;
      // Neither variant may leave a poll scheduled. The `status` variant has
      // `readRuntime` but no `input`, so the re-arm's evidence-source guard
      // refuses it too — proof that exhaustion ends all scheduling here.
      expect(h.timers.pending()).toBe(0);
      await h.timers.advance(25); // > graceMs * 4: no poll may remain scheduled
      expect(inspect).toHaveBeenCalledTimes(calls);
      expect(h.timers.pending()).toBe(0);
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
  test('a startup-recovered v1 child interrupted by restart stops after stable idle', async () => {
    const h = harness({
      input: {
        client: { session: { status: async () => ({ data: {} }) } },
      } as never,
      readTerminalEvidence: async () => ({
        data: [
          { info: { id: 'baseline', role: 'user' }, parts: [] },
          {
            info: { id: 'answer', role: 'assistant', time: { created: 1 } },
            parts: [],
          },
        ],
      }),
    });
    const record = h.board.get(h.run.taskID);
    if (!record) throw new Error('missing run');
    record.recoveredAtStartup = true;
    const publications: string[] = [];
    h.board.addTerminalOutcomeListener((job) => publications.push(job.state));
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    h.advance(10);
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
    });
    expect(publications).toEqual(['stopped']);

    const resumed = h.board.registerLaunch({
      taskID: 'ses_resumed',
      parentSessionID: 'parent',
      agent: 'fixer',
      background: true,
      now: 10,
    });
    resumed.recoveredAtStartup = true;
    const token = h.gate.capture(resumed);
    if (!token) throw new Error('missing observation');
    h.gate.observe(token, {
      kind: 'busy',
      origin: 'session.status',
      readStartedAt: token.readStartedAt,
    });
    await h.gate.reconcile(resumed);
    h.advance(20);
    await h.gate.reconcile(resumed);
    expect(h.board.get(resumed.taskID)?.state).toBe('running');
  });

  test('a stable idle v1 textless completion becomes an error after the evidence budget', async () => {
    const h = harness({
      input: {
        client: { session: { status: async () => ({ data: {} }) } },
      } as never,
      maxEvidenceRetries: 1,
      readTerminalEvidence: async () => answer(''),
    });
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    h.advance(10);
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'error',
      resultSummary: COMPLETED_WITHOUT_TEXT_DIAGNOSTIC,
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
    const first = h.gate.reconcile(h.run);
    await h.timers.tick(); // arm the evidence deadline
    await h.timers.advance(2); // readTimeoutMs
    await first;
    const second = h.gate.reconcile(h.run);
    await h.timers.tick();
    await h.timers.advance(2);
    await second;
    expect(read).toHaveBeenCalledTimes(1);
    h.observe('busy');
    h.observe('quiescent');
    const third = h.gate.reconcile(h.run);
    await h.timers.tick();
    await h.timers.advance(2);
    await third;
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
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'running',
      statusUncertain: false,
    });
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
  test('a deleted child session publishes nothing on its own', () => {
    const h = harness();
    const result = h.observe('deleted');
    expect(result.kind).toBe('deferred');
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
  });
});

test('integration: historical replay + rehydration + busy host publishes nothing and retains capacity', async () => {
  const board = new BackgroundJobBoard();
  const capacity = new BackgroundTaskConcurrency({
    defaultConcurrency: 1,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  const release = mock((taskID: string) => capacity.releaseTask(taskID));
  board.addTerminalOutcomeListener((record) => release(record.taskID));
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
    backgroundJobBoard: board,
  });
  gates.push(gate);
  const hook = createTaskSessionManagerHook(input, {
    backgroundJobBoard: board,
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
  });
  gates.push(gate);
  tracker = createRevivedRunTracker({
    input,
    backgroundJobBoard: board,
    terminalGate: gate,
    maxNotificationRetries: 2,
    notificationRetryDelayMs: 1,
  });
  // Production wires the tracker through the board's outcome fan-out
  // (index.ts), not through a private gate callback.
  board.addTerminalOutcomeListener((record) => {
    tracker.onTerminal(record);
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
      board.acquireLease(run.taskID, run.generation, 'relaunch'),
    ).toBeUndefined();
    fire(10_000); // A never settled: its local wait alone must release ownership.
    await tick();
    const lease = board.acquireLease(run.taskID, run.generation, 'relaunch');
    expect(lease).toBeDefined();
    if (lease) board.releaseLease(lease);
    fire(1);
    await tick();
    expect(transport).toHaveBeenCalledTimes(2); // B progresses without A's settlement.
    resolveA({});
    await tick();
    expect(
      board.acquireLease(run.taskID, run.generation, 'relaunch'),
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
    // The revived-run tracker delivered B's terminal notification to the
    // parent. Retirement rides the OBSERVED delivery (issue #1647): the
    // notification part in the parent history is the acknowledgement.
    messages.push({
      info: {
        id: 'consume-B',
        sessionID: 'parent',
        role: 'user',
        agent: 'orchestrator',
        time: { created: Date.now() + 1_000 },
      },
      parts: [
        {
          type: 'text',
          text: transport.mock.calls[1]?.[0]?.body.parts[0]?.text ?? '',
          synthetic: true,
          metadata: { 'oh-my-opencode-slim.internalInitiator': true },
        },
      ],
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
    // EXCEPTION (ts-no-test-timers): v2-shim integration (see the note at
    // the settle below) — the zero-delay hops must span real time so the
    // gate's real grace timers fire mid-loop while the shim chain settles.
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
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
      // EXCEPTION (ts-no-test-timers): v2-shim integration — the shim's
      // runtime-observation chain interleaves with real event-loop turns
      // outside the timer seam, so deterministic driving reordered its
      // retry chain. Backlog: seam the shim's status lookup to convert.
      await Bun.sleep(25); // More than graceMs * 4: neither reader may keep polling.
      expect(context).toHaveBeenCalledTimes(calls);
      expect(get).toHaveBeenCalledTimes(runtimeCalls);
      if (source === 'outcome') {
        // The host signal must renew the budget even if its first lookup still
        // lacks outcome. The next automatic retry, not another signal, succeeds.
        const held = Promise.withResolvers<void>();
        get.mockImplementationOnce(async () => {
          await held.promise;
          return { id: 'ses_v2child', parentID: 'parent' };
        });
        await idle();
        for (let i = 0; i < 50 && get.mock.calls.length === runtimeCalls; i++)
          await tick();
        expect(get).toHaveBeenCalledTimes(runtimeCalls + 1);
        valid = true;
        held.resolve();
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
      const result = createTaskStatusTool({
        input,
        backgroundJobBoard: board,
        terminalGate: gate,
      }).task_status;
      expect(
        await result.execute({ task_id: run.taskID, result: true }, {
          sessionID: 'parent',
        } as never),
      ).toBe('v2 result');
      expect(
        await result.execute({ task_id: run.taskID, result: true }, {
          sessionID: 'parent',
        } as never),
      ).toBe('v2 result');
      expect(context).toHaveBeenCalledWith({ sessionID: run.taskID });
    } finally {
      await hook.event({ event: { type: 'server.instance.disposed' } });
    }
  },
);

test.each([
  'completed',
  'queued-answer',
  'missing-baseline',
  'budget-exceeded',
  'pending-tool',
  'new-prompt',
])(
  'v2 revived child completion survives compaction without bypassing %s evidence',
  async (scenario) => {
    const queued = scenario === 'queued-answer';
    const completed = scenario === 'completed' || queued;
    const baseline = {
      id: 'baseline',
      type: queued ? 'user' : 'idle',
      time: { created: 1 },
    };
    const compacted = [
      { id: 'compact', type: 'compaction', status: 'completed' },
      {
        id: 'result',
        type: 'assistant',
        time: { created: 3, completed: 4 },
        finish: 'stop',
        content: [{ type: 'text', text: 'compacted child result' }],
      },
      { id: 'idle', type: 'idle', time: { created: 5 } },
    ];
    let reads = 0;
    const messages = mock(async ({ cursor }: { cursor?: string }) => {
      reads++;
      if (scenario === 'budget-exceeded') {
        return {
          data: [{ id: `old_${reads}`, type: 'user' }],
          cursor: { next: `cursor_${reads}` },
        };
      }
      return cursor
        ? {
            data:
              scenario === 'missing-baseline'
                ? []
                : [
                    ...(scenario === 'pending-tool'
                      ? [
                          {
                            id: 'pending',
                            type: 'assistant',
                            finish: 'tool-calls',
                            content: [
                              { type: 'tool', state: { status: 'running' } },
                            ],
                          },
                        ]
                      : []),
                    baseline,
                  ],
          }
        : {
            data: [
              ...(scenario === 'new-prompt'
                ? [{ id: 'new-prompt', type: 'user', text: 'continue' }]
                : []),
              ...compacted.slice().reverse(),
            ],
            cursor: { next: 'older' },
          };
    });
    const input = buildPluginInput({
      location: { directory: '/proj' },
      session: {
        context: async () => compacted,
        messages,
        get: async () => ({ outcome: 'succeeded', time: { idle: 5 } }),
      },
    } as never) as never;
    const board = new BackgroundJobBoard();
    const run = board.registerLaunch({
      taskID: 'ses_compacted',
      parentSessionID: 'parent',
      agent: 'oracle',
      background: true,
      now: 2,
    });
    const gate = createBackgroundJobTerminalGate({
      input,
      backgroundJobBoard: board,
      baselineFor: () => (queued ? undefined : 'baseline'),
      promptMessageIDFor: () => (queued ? 'baseline' : undefined),
      hostOutcomeClock: 'shared-unix-ms',
      now: () => 10,
    });
    gates.push(gate);
    await gate.reconcile(run);
    expect(board.get(run.taskID)?.state).toBe(
      completed ? 'completed' : 'running',
    );
    if (completed) {
      expect(board.get(run.taskID)?.resultSummary).toBe(
        'compacted child result',
      );
    }
    expect(messages).toHaveBeenCalledTimes(
      scenario === 'budget-exceeded' ? 10 : 2,
    );
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
      // Fire the scheduled retry and drain its fire-and-forget reconcile.
      await h.timers.advance(2);
      await h.timers.tick();
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
        // No `input` and no `readRuntime`: the arm's evidence-source guard
        // refuses, so the give-up log reports that no slow tier took over
        // (T8's refusal path) and nothing is left scheduled.
        rearm: { armed: false },
      });
      expect(h.timers.pending()).toBe(0);
    } finally {
      capture.restore();
    }
  });

  test('a final give-up frees the admission slot the task holds', async () => {
    // The wedge this pins: an unconfirmable task keeps its slot, so a later
    // launch waits on `await ticket.ready` forever. Releasing at give-up is
    // what lets the queue move again.
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const first = scheduler.acquire({ model: 'openai/fast' });
    await first.ready;
    first.bind('ses_child');
    const queued = scheduler.acquire({ model: 'openai/fast' });
    let granted = false;
    void queued.ready.then(() => {
      granted = true;
    });
    await Promise.resolve();
    expect(granted).toBe(false);

    const h = harness({
      maxEvidenceRetries: 0,
      readTerminalEvidence: async () => undefined,
      onGiveUp: (taskID) => scheduler.releaseTask(taskID),
    });
    await h.gate.reconcile(h.run);
    await Promise.resolve();
    expect(granted).toBe(true);
  });

  test('final give-up releases whatever the task holds, exactly once', async () => {
    const giveUps: Array<{ taskID: string; generation: number }> = [];
    const h = harness({
      maxEvidenceRetries: 0,
      readTerminalEvidence: async () => undefined,
      onGiveUp: (taskID, generation) => giveUps.push({ taskID, generation }),
    });
    await h.gate.reconcile(h.run);
    expect(giveUps).toEqual([
      { taskID: h.run.taskID, generation: h.run.generation },
    ]);
    // The record stays `running` on the board, so it is reconciled again; the
    // release must not repeat (a second release would free another task's slot).
    await h.gate.reconcile(h.run);
    expect(giveUps).toHaveLength(1);
  });
});

describe('outcome corroboration (log-only mirror)', () => {
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

  test('divergent host outcome is logged and never changes publication', async () => {
    const capture = captureLogs();
    try {
      const run = async (terminalOutcome: string) => {
        const h = harness({
          baselineFor: () => undefined,
          readTerminalEvidence: async () => ({ data: [] }),
        });
        const token = h.gate.capture(h.run);
        if (!token) throw new Error('missing observation');
        h.gate.observe(token, {
          kind: 'quiescent',
          origin: 'host-outcome',
          readStartedAt: token.readStartedAt,
          stable: true,
          terminalOutcome,
        });
        h.advance(20);
        const lease = h.board.acquireLease(
          h.run.taskID,
          h.run.generation,
          'cancellation',
        );
        if (!lease) throw new Error('missing cancellation lease');
        const before = capture.entries.length;
        const result = await h.gate.reconcile(h.run, {
          kind: 'cancel',
          lease,
          reason: 'user requested',
        });
        expect(result.kind).toBe('committed');
        return {
          record: h.board.get(h.run.taskID),
          corroboration: capture.entries
            .slice(before)
            .filter(
              (entry) =>
                entry.message === '[terminal-gate] outcome corroboration',
            ),
        };
      };
      const divergent = await run('failed');
      expect(divergent.record).toMatchObject({
        state: 'cancelled',
        resultSummary: 'cancelled: user requested',
        terminalRevision: 1,
      });
      expect(divergent.corroboration).toHaveLength(1);
      expect(divergent.corroboration[0]?.data).toMatchObject({
        taskID: 'ses_child',
        generation: 1,
        published: 'cancelled',
        attribution: 'event',
        hostOutcome: 'failed',
        hostImpliedState: 'error',
      });
      // Log-only contract: the publication with the divergent outcome in
      // hand is identical to the same cancellation without it.
      const control = await run('cancelled');
      expect(divergent.record).toEqual(control.record);
      expect(control.corroboration).toHaveLength(0);
    } finally {
      capture.restore();
    }
  });

  test('a fresh outcome read threads into the commit compare', async () => {
    const capture = captureLogs();
    try {
      const h = harness({
        hostOutcomeClock: 'shared-unix-ms',
        baselineFor: () => undefined,
        readTerminalEvidence: async () => undefined,
        input: {
          client: {
            session: {
              get: async () => ({
                data: { outcome: 'succeeded', time: { idle: 50 } },
              }),
            },
          },
        } as never,
      });
      h.observe('quiescent');
      h.advance(61);
      const result = await h.gate.reconcile(h.run, {
        kind: 'output',
        origin: {
          kind: 'native',
          run: h.run,
          callID: 'native',
          callIDConfirmed: true,
        },
        status: {
          taskID: h.run.taskID,
          state: 'error',
          timedOut: false,
          result: 'native failure',
        },
      });
      expect(result.kind).toBe('committed');
      expect(h.board.get(h.run.taskID)?.state).toBe('error');
      const entries = capture.of('[terminal-gate] outcome corroboration');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.data).toMatchObject({
        published: 'error',
        attribution: 'event',
        hostOutcome: 'succeeded',
        hostImpliedState: 'completed',
      });
    } finally {
      capture.restore();
    }
  });

  test('agreeing host outcome publishes silently', async () => {
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
                data: { outcome: 'failed', time: { idle: 50 } },
              }),
            },
          },
        } as never,
      });
      h.observe('quiescent');
      h.advance(61);
      await h.gate.reconcile(h.run);
      expect(h.board.get(h.run.taskID)?.state).toBe('error');
      expect(capture.of('[terminal-gate] outcome corroboration')).toHaveLength(
        0,
      );
    } finally {
      capture.restore();
    }
  });

  test('a host without session.get never produces a corroboration entry', async () => {
    const capture = captureLogs();
    try {
      const h = harness();
      h.observe('quiescent');
      await h.gate.reconcile(h.run);
      expect(h.board.get(h.run.taskID)?.state).toBe('completed');
      expect(capture.of('[terminal-gate] outcome corroboration')).toHaveLength(
        0,
      );
    } finally {
      capture.restore();
    }
  });
});

describe('evidence re-arm (#1561)', () => {
  test('idleContradictsBusy: only a provably later idle contradicts a busy', () => {
    const busy = (
      observedAt?: number,
      readStartedAt = 10,
    ): RuntimeObservation => ({
      kind: 'busy',
      origin: 'session.status-event',
      readStartedAt,
      ...(observedAt === undefined ? {} : { observedAt }),
    });
    const idle = (
      observedAt?: number,
      readStartedAt = 20,
    ): RuntimeObservation => ({
      kind: 'quiescent',
      origin: 'session.idle',
      readStartedAt,
      ...(observedAt === undefined ? {} : { observedAt }),
    });

    // Later idle ⇒ contradicted.
    expect(idleContradictsBusy(idle(200), busy(100))).toBe(true);
    // Same millisecond: delivery order decides, later delivery ⇒ contradicted.
    expect(idleContradictsBusy(idle(100, 30), busy(100, 10))).toBe(true);
    expect(idleContradictsBusy(idle(100, 10), busy(100, 10))).toBe(true);
    // Earlier idle ⇒ not contradicted.
    expect(idleContradictsBusy(idle(50), busy(100))).toBe(false);
    // Same millisecond, delivered BEFORE the busy ⇒ not contradicted.
    expect(idleContradictsBusy(idle(100, 5), busy(100, 10))).toBe(false);
    // Uncomparable (either side missing `observedAt`) ⇒ not contradicted.
    expect(idleContradictsBusy(idle(undefined), busy(100))).toBe(false);
    expect(idleContradictsBusy(idle(200), busy(undefined))).toBe(false);
    expect(idleContradictsBusy(undefined, busy(100))).toBe(false);
    // Invalid timestamps are not comparables either.
    expect(idleContradictsBusy(idle(Number.NaN), busy(100))).toBe(false);
  });
});

/**
 * Shim-shaped harness for the #1561 re-arm tests: a client exposing ONLY
 * `session.get` (no `session.status`, so the local polling reconciler is not
 * in play) whose committed outcome stays hidden for the first N reads.
 */
function shimHarness(
  config: {
    hideOutcomeForReads: number;
    gateOptions?: Record<string, unknown>;
  } = { hideOutcomeForReads: 4 },
) {
  let reads = 0;
  let committed = false;
  // The attribution window compares host `idleAt` against the gate's
  // OBSERVATION clock (`now()`), not wall clock, so the idle stamp must live
  // on that clock too. Tests stamp it once the outcome commits.
  let idleAt = 0;
  const get = mock(async () => {
    reads += 1;
    return {
      data:
        committed && reads > config.hideOutcomeForReads
          ? {
              parentID: 'parent',
              outcome: 'succeeded',
              time: { idle: idleAt },
            }
          : { parentID: 'parent' },
    };
  });
  const h = harness({
    ...(config.gateOptions ?? {}),
    baselineFor: () => undefined,
    hostOutcomeClock: 'shared-unix-ms',
    // No transcript on this host: undefined is classified as "transcript
    // source unavailable", NOT as evidence. Without this the inherited
    // default answer would publish through the transcript path and the test
    // would never exercise the host-outcome attribution it claims to pin.
    readTerminalEvidence: async () => undefined,
    // Shim shape: ONLY `session.get`. No transcript source, so a
    // window-attributed `succeeded` publishes `completed` from the host
    // outcome alone — exactly the path the probe exercises.
    input: { client: { session: { get } } } as never,
  });
  return {
    ...h,
    get,
    reads: () => reads,
    commit: (idleObservationTime?: number) => {
      committed = true;
      idleAt = idleObservationTime ?? h.observationNow();
    },
  };
}

describe('evidence re-arm behavior (#1561)', () => {
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

  test('T2: a healthy busy is never re-armed (no busy-spinning)', async () => {
    const h = shimHarness({ hideOutcomeForReads: 1_000 });
    // Busy with no idle contradiction afterwards: a genuinely executing child.
    h.observe('busy', false, 100);
    h.advance(100);
    await h.gate.reconcile(h.run);
    const readsAfterDefer = h.reads();
    expect(h.timers.pending()).toBe(0);
    await h.advanceBoth(500);
    // No new reads and nothing scheduled: the gate is not a poller.
    expect(h.reads()).toBe(readsAfterDefer);
    expect(h.timers.pending()).toBe(0);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    // ...and crucially the record is NOT marked uncertain by mere suspicion.
    expect(h.board.get(h.run.taskID)?.statusUncertain ?? false).toBe(false);
  });

  test('T5(i): a fresh busy clears an armed re-arm and resets both budgets', async () => {
    // The slow tier must exist for "an armed re-arm" to be cleared, so this
    // fixture runs a real millisecond cadence: asserting an empty timer set
    // without ever arming one would pass vacuously.
    const h = shimHarness({
      hideOutcomeForReads: 1_000,
      gateOptions: { evidenceRearmMs: 5, maxEvidenceRearms: 4 },
    });
    h.observe('busy', false, 100);
    h.advance(100);
    const token = h.gate.capture(h.run);
    if (!token) throw new Error('missing observation');
    h.gate.observe(token, {
      kind: 'quiescent',
      origin: 'session.idle',
      readStartedAt: token.readStartedAt,
      observedAt: 200,
    });
    h.advance(200);
    // Start reading, then drain the fast tier into the slow one.
    await h.gate.reconcile(h.run);
    for (let i = 0; i < 12; i++) await h.advanceBoth(5);
    // A slow timer is genuinely pending now — the premise of the test.
    expect(h.timers.pending()).toBe(1);
    // A genuine busy: live activity resolves the suspicion honestly and
    // clears the armed re-arm along with both budgets.
    h.observe('busy', false, 5_000);
    expect(h.timers.pending()).toBe(0);
    const readsAfterBusy = h.reads();
    await h.advanceBoth(1_000);
    expect(h.reads()).toBe(readsAfterBusy);
    expect(h.timers.pending()).toBe(0);
    // A *later* new idle contradiction re-engages a fresh fast budget, hence a
    // fresh round of reads (that is what "resets both budgets" buys).
    const token2 = h.gate.capture(h.run);
    if (!token2) throw new Error('missing observation');
    h.gate.observe(token2, {
      kind: 'quiescent',
      origin: 'session.idle',
      readStartedAt: token2.readStartedAt,
      observedAt: 6_000,
    });
    await h.gate.reconcile(h.run);
    expect(h.reads()).toBeGreaterThan(readsAfterBusy);
  });

  test('T1: a late-attributable outcome terminalizes the stranded board', async () => {
    const capture = captureLogs();
    try {
      const h = shimHarness({
        hideOutcomeForReads: 12,
        gateOptions: { evidenceRearmMs: 1, maxEvidenceRearms: 16 },
      });
      h.observe('busy', false, 100);
      h.advance(100);
      const token = h.gate.capture(h.run);
      if (!token) throw new Error('missing observation');
      h.gate.observe(token, {
        kind: 'quiescent',
        origin: 'session.idle',
        readStartedAt: token.readStartedAt,
        observedAt: 200,
      });
      h.advance(250);
      // Commit the host outcome with the idle on the observation clock, inside
      // the attribution window: lowerBound (last live busy) 100 < 250 <= read.
      h.commit(250);
      // The first reconcile is what starts the read loop; the re-arm continues
      // it. Nothing else drives the gate in this unit fixture.
      await h.gate.reconcile(h.run);
      // Nothing may publish while the outcome is still hidden: the whole point
      // is that attribution, not suspicion, authorizes the publication.
      expect(capture.of('[terminal-gate] terminal published')).toHaveLength(0);
      // Drive the fast tier, then the slow tier, until the outcome surfaces.
      for (
        let i = 0;
        i < 120 && h.board.get(h.run.taskID)?.state === 'running';
        i++
      )
        await h.advanceBoth(50);
      const record = h.board.get(h.run.taskID);
      expect(record).toMatchObject({
        state: 'completed',
        resultSummary: 'Host reported outcome: succeeded.',
        statusUncertain: false,
      });
      // Exactly one publication, and it carries the host-outcome attribution:
      // a publication through any other path (or a second one) would fail.
      const published = capture.of('[terminal-gate] terminal published');
      expect(published).toHaveLength(1);
      expect(published[0]?.data).toMatchObject({
        taskID: h.run.taskID,
        state: 'completed',
        attribution: 'host-outcome',
      });
      expect(h.timers.pending()).toBe(0);
    } finally {
      capture.restore();
    }
  });

  test('T3: exhaustion stays indeterminate and logs each line once', async () => {
    const capture = captureLogs();
    try {
      const giveUps: string[] = [];
      const h = shimHarness({
        hideOutcomeForReads: 1_000,
        gateOptions: {
          evidenceRearmMs: 5,
          maxEvidenceRearms: 3,
          onGiveUp: (taskID: string) => giveUps.push(taskID),
        },
      });
      h.observe('busy', false, 100);
      h.advance(100);
      // Suspicion needs an idle contradiction to engage the fast tier, and a
      // first reconcile to start reading.
      const token = h.gate.capture(h.run);
      if (!token) throw new Error('missing observation');
      h.gate.observe(token, {
        kind: 'quiescent',
        origin: 'session.idle',
        readStartedAt: token.readStartedAt,
        observedAt: 200,
      });
      h.advance(200);
      await h.gate.reconcile(h.run);
      for (let i = 0; i < 60; i++) await h.advanceBoth(40);
      const record = h.board.get(h.run.taskID);
      expect(record?.state).toBe('running');
      expect(record?.statusUncertain).toBe(true);
      expect(record?.lastStatusError).toBe(EVIDENCE_UNAVAILABLE_DIAGNOSTIC);
      // First exhaustion logs once, and reports that the slow tier took over.
      const gaveUps = capture.of(
        '[terminal-gate] terminal evidence unavailable',
      );
      expect(gaveUps).toHaveLength(1);
      expect(gaveUps[0]?.data).toMatchObject({
        verdict: 'gave-up',
        rearm: { armed: true, maxEvidenceRearms: 3 },
      });
      // Final give-up on the arm budget logs once, after that handoff.
      const exhausted = capture.of(
        '[terminal-gate] terminal evidence rearm exhausted',
      );
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0]?.data).toMatchObject({
        verdict: 'gave-up',
        rearms: 3,
        maxEvidenceRearms: 3,
      });
      // Arm budget gone: this is the point of no return, so it releases once.
      expect(giveUps).toEqual([h.run.taskID]);
      expect(h.timers.pending()).toBe(0);
    } finally {
      capture.restore();
    }
  });

  test('T9: arming is refused where a polling reconciler owns recovery', async () => {
    // Same exhaustion shape, but the host DOES expose `session.status`: the
    // 5 s `runtime-status-reconciliation` sweeper already retries such
    // records, so the gate must not become a second scheduler for one fact.
    // The client must actually carry `session.status`, or this test would
    // pass without ever reaching the guard it claims to pin.
    const statusRead = mock(async () => ({
      data: { child: { type: 'idle' } },
    }));
    const giveUps: string[] = [];
    const h = harness({
      baselineFor: () => undefined,
      readTerminalEvidence: async () => undefined,
      graceMs: 5,
      evidenceRearmMs: 5,
      input: {
        client: { session: { status: statusRead } },
      } as never,
      onGiveUp: (taskID: string) => giveUps.push(taskID),
    });
    h.observe('busy', false, 100);
    h.advance(100);
    const token = h.gate.capture(h.run);
    if (!token) throw new Error('missing observation');
    h.gate.observe(token, {
      kind: 'quiescent',
      origin: 'session.idle',
      readStartedAt: token.readStartedAt,
      observedAt: 200,
    });
    h.advance(250);
    // Drive to fast-budget exhaustion; the host's polling capability must stop
    // the slow tier from arming.
    await h.gate.reconcile(h.run);
    for (let i = 0; i < 10; i++) await h.advanceBoth(5);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    expect(h.timers.pending()).toBe(0);
    // The host's sweeper still owns the read, so its publication — not this
    // give-up — is what releases the slot: releasing here would admit a
    // queued child while this one may still be working.
    expect(giveUps).toEqual([]);
  });
});

describe('re-arm budget accounting (#1561)', () => {
  test('T7: a re-arm fire performs one read and never restarts the fast tier', async () => {
    let reads = 0;
    const get = mock(async () => {
      reads += 1;
      return { data: { parentID: 'parent' } };
    });
    const h = harness({
      baselineFor: () => undefined,
      hostOutcomeClock: 'shared-unix-ms',
      evidenceRearmMs: 2,
      maxEvidenceRearms: 4,
      input: { client: { session: { get } } } as never,
    });
    h.observe('busy', false, 100);
    h.advance(100);
    const token = h.gate.capture(h.run);
    if (!token) throw new Error('missing observation');
    h.gate.observe(token, {
      kind: 'quiescent',
      origin: 'session.idle',
      readStartedAt: token.readStartedAt,
      observedAt: 200,
    });
    h.advance(250);
    await h.gate.reconcile(h.run);
    // Burn the fast tier, then sample each subsequent arm: every fire adds
    // exactly one read and exactly one pending timer (never a graceMs burst).
    const before = reads;
    for (let i = 0; i < 60; i++) {
      await h.advanceBoth(2);
      if (h.timers.pending() === 0) break;
    }
    // Exact accounting, which is the real invariant: the remaining fast-tier
    // reads (maxEvidenceRetries = 3, minus the one this reconcile already
    // performed) plus exactly `maxEvidenceRearms` slow-tier reads. A re-arm
    // that wrongly re-engaged the fast tier would overshoot this.
    expect(reads - before).toBe(3 + 4);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    expect(h.timers.pending()).toBe(0);
  });
});

describe('replayed idle and rehydrate backstop (#1561)', () => {
  test('T5(ii): replaying the same idle never resets the fast budget', async () => {
    const get = mock(async () => ({ data: { parentID: 'parent' } }));
    const h = harness({
      baselineFor: () => undefined,
      hostOutcomeClock: 'shared-unix-ms',
      readTerminalEvidence: async () => undefined,
      maxEvidenceRetries: 1,
      graceMs: 5,
      input: { client: { session: { get } } } as never,
    });
    h.observe('busy', false, 100);
    h.advance(100);
    // One contradicting idle engages the fast tier.
    const token = h.gate.capture(h.run);
    if (!token) throw new Error('missing observation');
    h.gate.observe(token, {
      kind: 'quiescent',
      origin: 'session.idle',
      readStartedAt: token.readStartedAt,
      observedAt: 200,
    });
    h.advance(200);
    await h.gate.reconcile(h.run);
    // Replay the SAME idle repeatedly (equal observedAt, as the double-idle
    // pair does). With maxEvidenceRetries = 1 the budget must stay exhausted:
    // a reset would keep re-arming fast timers forever.
    for (let i = 0; i < 20; i++) {
      const t = h.gate.capture(h.run);
      if (!t) break;
      h.gate.observe(t, {
        kind: 'quiescent',
        origin: 'session.idle',
        readStartedAt: t.readStartedAt,
        observedAt: 200,
      });
      await h.advanceBoth(5);
    }
    // The diagnostic landed: the budget was exhausted despite the replays.
    expect(h.board.get(h.run.taskID)?.lastStatusError).toBe(
      EVIDENCE_UNAVAILABLE_DIAGNOSTIC,
    );
  });

  test('T8: a later reconcile still publishes after the re-arm budget is dead', async () => {
    let committed = false;
    let idleAt = 0;
    const get = mock(async () => ({
      data: committed
        ? { parentID: 'parent', outcome: 'succeeded', time: { idle: idleAt } }
        : { parentID: 'parent' },
    }));
    const h = harness({
      baselineFor: () => undefined,
      hostOutcomeClock: 'shared-unix-ms',
      evidenceRearmMs: 2,
      maxEvidenceRearms: 1,
      input: { client: { session: { get } } } as never,
    });
    h.observe('busy', false, 100);
    h.advance(100);
    const token = h.gate.capture(h.run);
    if (!token) throw new Error('missing observation');
    h.gate.observe(token, {
      kind: 'quiescent',
      origin: 'session.idle',
      readStartedAt: token.readStartedAt,
      observedAt: 200,
    });
    h.advance(250);
    await h.gate.reconcile(h.run);
    // Burn both tiers: the record stays visibly indeterminate.
    for (let i = 0; i < 40; i++) await h.advanceBoth(10);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    expect(h.board.get(h.run.taskID)?.statusUncertain).toBe(true);
    expect(h.timers.pending()).toBe(0);
    // The documented backstop: a later activity rehydrate still reconciles
    // and publishes. Re-arm exhaustion must not have closed that door.
    committed = true;
    idleAt = h.observationNow();
    await h.gate.reconcile(h.run);
    const record = h.board.get(h.run.taskID);
    expect(record?.state).toBe('completed');
    expect(record?.terminalRevision).toBeGreaterThan(0);
    expect(h.timers.pending()).toBe(0);
  });
});

describe('concurrent re-arm idempotency (#1561)', () => {
  test('T4: concurrent reads around a re-arm publish exactly once', async () => {
    // The race must be REAL: hold a host read open, start an event-driven
    // reconcile on top of it, then let the pending slow timer fire while that
    // read is still unsettled. Only then do the per-identity `inFlight` dedup
    // and `commit()`'s single-use authorization earn their keep.
    let reads = 0;
    let committed = false;
    let idleAt = 0;
    let release: (() => void) | undefined;
    const get = mock(async () => {
      reads += 1;
      const payload = {
        data: committed
          ? { parentID: 'parent', outcome: 'succeeded', time: { idle: idleAt } }
          : { parentID: 'parent' },
      };
      // Once the outcome is committed, the first read hangs until released, so
      // a second reconcile is guaranteed to overlap it.
      if (committed && release === undefined) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return payload;
    });
    const h = harness({
      baselineFor: () => undefined,
      hostOutcomeClock: 'shared-unix-ms',
      evidenceRearmMs: 2,
      maxEvidenceRearms: 8,
      input: { client: { session: { get } } } as never,
    });
    const publications: string[] = [];
    h.board.addTerminalOutcomeListener((record) => {
      publications.push(`${record.taskID}:${record.terminalRevision}`);
    });
    h.observe('busy', false, 100);
    h.advance(100);
    const token = h.gate.capture(h.run);
    if (!token) throw new Error('missing observation');
    h.gate.observe(token, {
      kind: 'quiescent',
      origin: 'session.idle',
      readStartedAt: token.readStartedAt,
      observedAt: 200,
    });
    h.advance(250);
    await h.gate.reconcile(h.run);
    // Drain the fast tier so a SLOW timer is genuinely pending.
    for (let i = 0; i < 12; i++) await h.advanceBoth(5);
    expect(h.timers.pending()).toBe(1);
    // Commit, then start an event-driven reconcile whose read hangs open.
    committed = true;
    idleAt = h.observationNow();
    const eventReconcile = h.gate.reconcile(h.run);
    await tick();
    expect(release).toBeDefined();
    // Fire the pending slow timer while that read is still unsettled: its
    // reconcile must JOIN the open read instead of issuing a second one.
    const readsBefore = reads;
    await h.advanceBoth(5);
    expect(reads).toBe(readsBefore);
    // Release, then let every overlapping attempt settle.
    release?.();
    await eventReconcile;
    await h.gate.reconcile(h.run);
    const record = h.board.get(h.run.taskID);
    expect(record?.state).toBe('completed');
    // Exactly one publication, and therefore exactly one revision bump.
    expect(publications).toHaveLength(1);
    expect(record?.terminalRevision).toBe(1);
    expect(h.timers.pending()).toBe(0);
  });
});

describe('give-up log contract under repeated reads (#1561)', () => {
  test('a pending re-arm is not reported as final exhaustion', async () => {
    const capture = captureLogs();
    try {
      // Slow tier armed and waiting. An extra reconcile (a `task_status` call
      // is exactly this) must not log the final line: recovery is still
      // scheduled, and burning the once-per-budget guard there would hide the
      // genuine final give-up later.
      const h = shimHarness({
        hideOutcomeForReads: 1_000,
        gateOptions: { evidenceRearmMs: 60_000, maxEvidenceRearms: 4 },
      });
      h.observe('busy', false, 100);
      h.advance(100);
      const token = h.gate.capture(h.run);
      if (!token) throw new Error('missing observation');
      h.gate.observe(token, {
        kind: 'quiescent',
        origin: 'session.idle',
        readStartedAt: token.readStartedAt,
        observedAt: 200,
      });
      h.advance(250);
      await h.gate.reconcile(h.run);
      // Drain the fast tier; the slow arm is now pending for 60 s.
      for (let i = 0; i < 12; i++) await h.advanceBoth(5);
      expect(h.timers.pending()).toBe(1);
      // Extra reads while it waits.
      for (let i = 0; i < 3; i++) await h.gate.reconcile(h.run);
      expect(
        capture.of('[terminal-gate] terminal evidence rearm exhausted'),
      ).toHaveLength(0);
      // And the first-exhaustion line is still once-per-budget, not per read.
      expect(
        capture.of('[terminal-gate] terminal evidence unavailable'),
      ).toHaveLength(1);
    } finally {
      capture.restore();
    }
  });

  test('repeated unknown reads do not re-log give-up within one budget', async () => {
    const capture = captureLogs();
    try {
      // On a host with only `session.get` and no retained busy observation,
      // every hidden outcome observes `unknown`, which bumps `episode`. An
      // episode-keyed guard would therefore re-log on every slow read; the
      // guard must track the recovery budget instead.
      let reads = 0;
      const get = mock(async () => {
        reads += 1;
        return { data: { parentID: 'parent' } };
      });
      const h = harness({
        baselineFor: () => undefined,
        hostOutcomeClock: 'shared-unix-ms',
        evidenceRearmMs: 5,
        maxEvidenceRearms: 6,
        input: { client: { session: { get } } } as never,
      });
      await h.gate.reconcile(h.run);
      for (let i = 0; i < 80; i++) await h.advanceBoth(500);
      expect(h.timers.pending()).toBe(0);
      expect(reads).toBeGreaterThan(4);
      expect(
        capture.of('[terminal-gate] terminal evidence unavailable'),
      ).toHaveLength(1);
      expect(
        capture.of('[terminal-gate] terminal evidence rearm exhausted'),
      ).toHaveLength(1);
    } finally {
      capture.restore();
    }
  });
});

describe('terminal attribution race guards and publication fences', () => {
  test('unconfirmed native output with evidence timeout remains unconfirmed, while confirmed native publishes', async () => {
    const h = harness({
      readTerminalEvidence: async () => undefined,
      maxEvidenceRetries: 1,
    });
    h.observe('quiescent');
    // 1. Unconfirmed native call (callIDConfirmed: false)
    const unconfirmed = await h.gate.reconcile(h.run, {
      kind: 'output',
      origin: {
        kind: 'native',
        run: h.run,
        callID: 'unconfirmed-call',
        callIDConfirmed: false,
      },
      status: {
        taskID: h.run.taskID,
        state: 'completed',
        timedOut: false,
        result: 'unconfirmed native text',
      },
    });
    expect(unconfirmed.kind).toBe('deferred');
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    expect(h.board.get(h.run.taskID)?.resultSummary).not.toBe(
      'unconfirmed native text',
    );

    // 2. Confirmed native call (callIDConfirmed: true)
    const confirmed = await h.gate.reconcile(h.run, {
      kind: 'output',
      origin: {
        kind: 'native',
        run: h.run,
        callID: 'confirmed-call',
        callIDConfirmed: true,
      },
      status: {
        taskID: h.run.taskID,
        state: 'completed',
        timedOut: false,
        result: 'confirmed native text',
      },
    });
    expect(confirmed.kind).toBe('committed');
    expect(h.board.get(h.run.taskID)?.state).toBe('completed');
    expect(h.board.get(h.run.taskID)?.resultSummary).toBe(
      'confirmed native text',
    );
  });

  test('attributable host outcome positive publishes completed with host outcome summary', async () => {
    let clock = 150;
    const h = harness({
      hostOutcomeClock: 'shared-unix-ms',
      now: () => clock,
      readTerminalEvidence: async () => undefined,
      input: {
        client: {
          session: {
            get: async () => {
              clock = 200;
              return { data: { outcome: 'succeeded', time: { idle: 160 } } };
            },
          },
        },
      } as never,
    });
    h.observe('quiescent');
    const result = await h.gate.reconcile(h.run);
    expect(result.kind).toBe('committed');
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'completed',
      resultSummary: 'Host reported outcome: succeeded.',
    });
  });

  test('competing reads and duplicate output idle notify listener exactly once with revision 1', async () => {
    const h = harness();
    const listener = mock(() => {});
    h.board.addTerminalOutcomeListener(listener);
    h.observe('quiescent');

    const [first, second] = await Promise.all([
      h.gate.reconcile(h.run),
      h.gate.reconcile(h.run),
    ]);
    expect(first.kind).toBe('committed');
    expect(second.kind).toBe('committed');

    // Duplicate idle after commit
    h.observe('quiescent');
    await h.gate.reconcile(h.run);

    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'completed',
      terminalRevision: 1,
      resultSummary: 'answer',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('consumeTerminalCommitToken: wrong gate, record, input, or consumed replay is invalid', async () => {
    const h = harness();
    let capturedToken: TerminalCommitToken | undefined;
    let capturedInput: BackgroundJobTerminalInput | undefined;
    const commitTerminalSpy = spyOn(
      h.board,
      'commitTerminal',
    ).mockImplementation((input, token) => {
      capturedInput = input;
      capturedToken = token;
      return h.board.get(h.run.taskID);
    });
    try {
      h.observe('quiescent');
      await h.gate.reconcile(h.run);
      expect(capturedToken).toBeDefined();
      expect(capturedInput).toBeDefined();
    } finally {
      commitTerminalSpy.mockRestore();
    }

    const record = h.board.get(h.run.taskID);
    if (!record || !capturedToken || !capturedInput) {
      throw new Error('missing test preconditions');
    }

    // 1. Wrong gate (token remains unconsumed on h.gate)
    const otherGate = createBackgroundJobTerminalGate({
      backgroundJobBoard: h.board,
    });
    gates.push(otherGate);
    expect(
      consumeTerminalCommitToken(
        otherGate,
        capturedToken,
        record,
        capturedInput,
      ),
    ).toBe(false);

    // 2. Valid consumption succeeds and consumes token
    expect(
      consumeTerminalCommitToken(h.gate, capturedToken, record, capturedInput),
    ).toBe(true);

    // 3. Replay of consumed token is invalid (single-use)
    expect(
      consumeTerminalCommitToken(h.gate, capturedToken, record, capturedInput),
    ).toBe(false);

    // 4. A fresh authorization with wrong record or wrong input fails
    let token2: TerminalCommitToken | undefined;
    let input2: BackgroundJobTerminalInput | undefined;
    const commitSpy2 = spyOn(h.board, 'commitTerminal').mockImplementation(
      (input, token) => {
        input2 = input;
        token2 = token;
        return h.board.get(h.run.taskID);
      },
    );
    try {
      h.observe('quiescent');
      await h.gate.reconcile(h.run);
    } finally {
      commitSpy2.mockRestore();
    }
    if (!token2 || !input2) throw new Error('missing second token');
    const otherRecord = { ...record, taskID: 'other_task' };
    expect(
      consumeTerminalCommitToken(h.gate, token2, otherRecord, input2),
    ).toBe(false);
    // Already consumed on wrong-record attempt, replay is also invalid
    expect(consumeTerminalCommitToken(h.gate, token2, record, input2)).toBe(
      false,
    );
  });

  test('disposal and unconfirmed late evidence are no-ops', async () => {
    const held = Promise.withResolvers<unknown>();
    const h = harness({
      readTerminalEvidence: () => held.promise,
    });
    h.observe('quiescent');
    const pending = h.gate.reconcile(h.run);
    await tick();

    // Dispose while evidence read is pending
    h.gate.dispose();

    // Late evidence resolves after disposal
    held.resolve(answer('late text'));
    await pending;

    // Record remains running; late evidence did not publish
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    expect(h.board.get(h.run.taskID)?.resultSummary).toBeUndefined();

    // Further operations on disposed gate are stale / no-op
    expect(h.gate.capture(h.run)).toBeUndefined();
    const token = {
      taskID: h.run.taskID,
      generation: h.run.generation,
      activityRevision: 0,
      episode: 0,
      readStartedAt: 1,
    };
    expect(
      h.gate.observe(token, {
        kind: 'quiescent',
        origin: 'test',
        readStartedAt: 1,
      }),
    ).toEqual({ kind: 'stale' });
    expect(await h.gate.reconcile(h.run)).toEqual({ kind: 'stale' });
  });

  test('busy or relaunch during held read prevents old publication', async () => {
    const held = Promise.withResolvers<unknown>();
    const h = harness({
      readTerminalEvidence: () => held.promise,
    });
    const token = h.gate.capture(h.run);
    if (!token) throw new Error('missing token');
    h.gate.observe(token, {
      kind: 'quiescent',
      origin: 'test',
      readStartedAt: token.readStartedAt,
    });

    const pending = h.gate.reconcile(h.run);
    await tick();

    // Transition to busy while read is held
    h.gate.observe(token, {
      kind: 'busy',
      origin: 'session.status',
      readStartedAt: token.readStartedAt + 1,
    });
    expect(h.board.get(h.run.taskID)?.state).toBe('running');

    // Held read resolves with old evidence
    held.resolve(answer('stale held answer'));
    const res = await pending;

    expect(['deferred', 'stale']).toContain(res.kind);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    expect(h.board.get(h.run.taskID)?.resultSummary).toBeUndefined();
  });

  test('relaunch during held read prevents old publication', async () => {
    const held = Promise.withResolvers<unknown>();
    const h = harness({
      readTerminalEvidence: () => held.promise,
    });
    const token = h.gate.capture(h.run);
    if (!token) throw new Error('missing token');
    h.gate.observe(token, {
      kind: 'quiescent',
      origin: 'test',
      readStartedAt: token.readStartedAt,
    });

    const pending = h.gate.reconcile(h.run);
    await tick();

    // Relaunch the task while read is held (generation advances)
    const lease = h.board.acquireLease(
      h.run.taskID,
      h.run.generation,
      'relaunch',
    );
    if (!lease) throw new Error('missing relaunch lease');
    const relaunched = h.board.registerLaunch({
      taskID: h.run.taskID,
      parentSessionID: 'parent',
      agent: 'fixer',
      relaunchLease: lease,
      now: 10,
    });
    h.board.releaseLease(lease);
    expect(relaunched.generation).toBe(2);

    // Held read from generation 1 resolves
    held.resolve(answer('generation 1 stale answer'));
    const res = await pending;

    expect(['deferred', 'stale']).toContain(res.kind);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    expect(h.board.get(h.run.taskID)?.resultSummary).toBeUndefined();
  });

  test('legitimate fresh relaunch publishes once and does not seal record forever', async () => {
    const h = harness();
    h.observe('quiescent');
    const first = await h.gate.reconcile(h.run);
    expect(first.kind).toBe('committed');
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'completed',
      terminalRevision: 1,
      generation: 1,
    });

    // Acquire relaunch lease and register launch for generation 2
    const lease = h.board.acquireLease(
      h.run.taskID,
      h.run.generation,
      'relaunch',
    );
    if (!lease) throw new Error('missing relaunch lease');
    const relaunched = h.board.registerLaunch({
      taskID: h.run.taskID,
      parentSessionID: 'parent',
      agent: 'fixer',
      relaunchLease: lease,
      now: 10,
    });
    h.board.releaseLease(lease);

    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    expect(relaunched.generation).toBe(2);

    // Fresh run completes with new observation
    const token = h.gate.capture(relaunched);
    if (!token) throw new Error('missing fresh token');
    h.gate.observe(token, {
      kind: 'quiescent',
      origin: 'test',
      readStartedAt: 11,
    });

    const second = await h.gate.reconcile(relaunched);
    expect(second.kind).toBe('committed');
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'completed',
      generation: 2,
      terminalRevision: 1,
    });
  });

  test('deadline expired raw read remains owned so no duplicate read is started, then fresh can proceed', async () => {
    let underlyingReads = 0;
    const held = Promise.withResolvers<unknown>();
    const read = mock((): Promise<unknown> => {
      underlyingReads += 1;
      if (underlyingReads === 1) return held.promise;
      return Promise.resolve(answer('fresh answer'));
    });
    const h = harness({
      readTerminalEvidence: read,
      readTimeoutMs: 2,
      graceMs: 1000,
    });
    h.observe('quiescent');

    // First reconcile starts the raw read
    const first = h.gate.reconcile(h.run);
    await h.timers.tick();
    await h.timers.advance(2); // Deadline expires
    await first;
    expect(underlyingReads).toBe(1);

    // Second reconcile while underlying is still in-flight: reuses in-flight read, does not start a new underlying read
    const second = h.gate.reconcile(h.run);
    await h.timers.tick();
    await h.timers.advance(2);
    await second;
    expect(underlyingReads).toBe(1);

    // Underlying read finally settles
    held.resolve(answer('initial settled'));
    await tick();

    // Now that the slot is settled, a fresh reconcile can launch a new read and proceed
    const third = await h.gate.reconcile(h.run);
    expect(underlyingReads).toBe(2);
    expect(third.kind).toBe('committed');
    expect(h.board.get(h.run.taskID)?.state).toBe('completed');
  });
});
