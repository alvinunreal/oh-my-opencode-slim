import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import { createRevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import { createV1InterviewSessionRuntime } from '../interview/runtime';
import { createTaskMessageTool } from '../tools/task-message';
import { createTaskReviveTool } from '../tools/task-revive';
import { createTaskStatusTool } from '../tools/task-status';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { boardFixture } from '../utils/background-job-fixture';
import { createBackgroundJobTerminalGate } from '../utils/background-job-terminal-gate';
import * as opencodeClient from '../utils/opencode-client';
import { buildPluginInput, type ExperimentalV2 } from './client-shim';
import type { V2Context } from './types';

const dispose: Array<() => void> = [];
const context = { sessionID: 'parent', agent: 'orchestrator' } as never;
const reviveArgs = { task_id: 'ses_child', prompt: 'Continue' };
const messageArgs = { task_id: 'ses_child', message: 'Update' };

beforeEach(() => {
  // Other tool suites mock this module globally. Keep this suite on its real shim.
  spyOn(opencodeClient, 'getClient').mockImplementation(
    (input) => input.client,
  );
});
afterEach(() => {
  for (const cleanup of dispose.splice(0)) cleanup();
  mock.restore();
});

function harness(
  options: {
    running?: boolean;
    retainedState?: 'completed' | 'cancelled';
    session?: Partial<V2Context['session']>;
    waitForIdleTimeoutMs?: number;
    messageTimeoutMs?: number;
    isDisposed?: () => boolean;
  } = {},
) {
  const host = {
    get: mock(async () => ({
      outcome: 'interrupted',
      agent: 'explorer',
      model: { id: 'persisted-model', providerID: 'provider', variant: 'high' },
    })),
    context: mock(async () => []),
    prompt: mock(async (_args: Record<string, unknown>) => ({})),
    wait: mock(async () => {}),
    interrupt: mock(async () => ({})),
    switchAgent: mock(async () => {}),
    switchModel: mock(async () => {}),
    synthetic: mock(async () => ({})),
    ...options.session,
  };
  const input = buildPluginInput({
    session: host,
  } as unknown as V2Context) as unknown as PluginInput & {
    experimental_v2?: ExperimentalV2;
  };
  const board = new BackgroundJobBoard();
  board.registerLaunch({
    taskID: 'ses_child',
    parentSessionID: 'parent',
    agent: 'explorer',
    now: 100,
  });
  if (!options.running)
    boardFixture.updateStatus(board, {
      taskID: 'ses_child',
      state: options.retainedState ?? 'completed',
      now: 110,
    });
  let tracker: ReturnType<typeof createRevivedRunTracker>;
  const onTerminal = mock((record) => tracker.onTerminal(record));
  const gate = createBackgroundJobTerminalGate({
    backgroundJobBoard: board,
    input,
    hostOutcomeClock: 'shared-unix-ms',
    baselineFor: (id, generation) => tracker?.baselineFor(id, generation),
    observationRevisionFor: (id, generation) =>
      tracker?.revisionFor(id, generation),
    attemptStartedAtFor: (id, generation) =>
      tracker?.attemptStartedAtFor(id, generation),
    isObservationPending: (id, generation) =>
      tracker?.isObservationPending(id, generation) ?? false,
    graceMs: 5,
  });
  tracker = createRevivedRunTracker({
    input,
    backgroundJobBoard: board,
    terminalGate: gate,
  });
  // The retained-state setup above already published before this point;
  // from here on the board's outcome fan-out is the publication channel,
  // exactly as production wires the tracker (index.ts).
  board.addTerminalOutcomeListener(onTerminal);
  const baseline = spyOn(tracker, 'captureBaseline');
  const register = spyOn(tracker, 'register');
  dispose.push(() => {
    tracker.dispose();
    gate.dispose();
  });
  const onLaunch = mock(() => {});
  const revive = createTaskReviveTool({
    input,
    backgroundJobBoard: board,
    terminalGate: gate,
    shouldManageSession: () => true,
    revivedRunTracker: tracker,
    backgroundJobSupervisor: { onLaunch } as never,
    stableStoppedMs: 0,
    abortRetryIntervalMs: 0,
    waitForIdleTimeoutMs: options.waitForIdleTimeoutMs,
  }).task_revive;
  const message = createTaskMessageTool({
    input,
    backgroundJobBoard: board,
    messageTimeoutMs: options.messageTimeoutMs,
    isDisposed: options.isDisposed,
  }).task_message;
  return {
    input,
    host,
    board,
    message,
    revive,
    baseline,
    register,
    onLaunch,
    tracker,
    gate,
    onTerminal,
  };
}

describe('task controls through the real v2 client shim', () => {
  test.each(
    (['v1', 'v2'] as const).flatMap((flavor) =>
      [
        'new input',
        'new input without assistant',
        'new synthetic',
        'new assistant',
        'same run',
        'same tick',
        'host maintenance',
        'missing terminal time',
      ].map((scenario) => ({ flavor, scenario })),
    ),
  )(
    'diagnostics refuse activity beyond the recorded terminal on %j',
    async ({ flavor, scenario }) => {
      const native: Array<Record<string, unknown>> = [
        { id: 'input', type: 'user', time: 100, content: [] },
        {
          id: 'answer',
          type: 'assistant',
          time: scenario === 'same tick' ? 200 : 199,
          content: [{ type: 'text', text: 'CURRENT PARTIAL' }],
        },
      ];
      if (scenario.startsWith('new input') || scenario === 'new synthetic')
        native.push({
          id: 'new-input',
          type: scenario === 'new synthetic' ? 'synthetic' : 'user',
          time: 300,
          content: [],
        });
      if (
        scenario.startsWith('new ') &&
        scenario !== 'new input without assistant'
      )
        native.push({
          id: 'new-answer',
          type: 'assistant',
          time: 310,
          content: [{ type: 'text', text: 'NEW RUN PARTIAL' }],
        });
      if (scenario === 'host maintenance')
        native.push(
          {
            id: 'compact',
            type: 'compaction',
            status: 'completed',
            time: 300,
            content: [],
          },
          { id: 'idle', type: 'idle', time: 310, content: [] },
        );
      const input =
        flavor === 'v2'
          ? buildPluginInput({
              session: { context: async () => native },
            } as unknown as V2Context)
          : ({
              directory: '/test',
              client: {
                session: {
                  messages: async () => ({
                    data: native.map((message) => ({
                      info: {
                        id: message.id,
                        role:
                          message.type === 'idle'
                            ? 'system'
                            : ['compaction', 'synthetic'].includes(
                                  String(message.type),
                                )
                              ? 'user'
                              : message.type,
                        ...(message.type === 'synthetic'
                          ? { sourceType: 'synthetic' }
                          : {}),
                        time: { created: message.time },
                      },
                      parts:
                        message.type === 'compaction'
                          ? [{ type: 'compaction' }]
                          : message.content,
                    })),
                  }),
                },
              },
            } as unknown as PluginInput);
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'ses_child',
        parentSessionID: 'parent',
        agent: 'explorer',
        now: 100,
      });
      boardFixture.updateStatus(board, {
        taskID: 'ses_child',
        state: 'error',
        now: 200,
      });
      const job = board.get('ses_child');
      if (!job) throw new Error('expected tracked record');
      if (scenario === 'missing terminal time') job.completedAt = undefined;
      const before = structuredClone(job);
      const gate = createBackgroundJobTerminalGate({
        input,
        backgroundJobBoard: board,
      });
      dispose.push(() => gate.dispose());
      const writes = [
        spyOn(gate, 'capture'),
        spyOn(gate, 'observe'),
        spyOn(gate, 'reconcile'),
        spyOn(board, 'markUsed'),
      ];
      const output = await createTaskStatusTool({
        input,
        backgroundJobBoard: board,
        terminalGate: gate,
      }).task_status.execute(
        {
          ...(flavor === 'v2'
            ? { sessionID: 'ses_child' }
            : { task_id: 'ses_child' }),
          diagnostic: true,
        },
        context,
      );
      expect(output).toContain('generation: 1');
      expect(output).not.toContain('NEW RUN PARTIAL');
      if (scenario.startsWith('new '))
        expect(output).toContain(
          'evidence: unavailable (activity after the recorded terminal outcome)',
        );
      else if (scenario === 'missing terminal time')
        expect(output).toContain(
          'evidence: unavailable (recorded terminal time is unavailable)',
        );
      else {
        expect(output).toContain('CURRENT PARTIAL');
        expect(output).toContain('evidence: transcript');
      }
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(board.get('ses_child')).toEqual(before);
    },
  );

  test.each(
    (['v1', 'v2'] as const).flatMap((flavor) =>
      [
        'textless failure',
        'input before registration',
        'missing time',
        'only old evidence',
      ].map((scenario) => ({ flavor, scenario })),
    ),
  )(
    'tracked diagnostics bind the board run on %j',
    async ({ flavor, scenario }) => {
      const native = [
        { id: 'old-input', type: 'user', time: 10, content: [] },
        {
          id: 'old-answer',
          type: 'assistant',
          time: 20,
          content: [{ type: 'text', text: 'STALE SUCCESS' }],
        },
        ...(scenario === 'input before registration'
          ? // Native after-hook registration can follow the input.
            [{ id: 'new-input', type: 'user', time: 99, content: [] }]
          : []),
        ...(scenario === 'only old evidence'
          ? []
          : [
              {
                id: 'step',
                type: 'assistant',
                time: scenario === 'missing time' ? undefined : 110,
                content: [
                  { type: 'tool', state: { status: 'completed' } },
                  ...(scenario === 'input before registration'
                    ? [{ type: 'text', text: 'CURRENT PARTIAL' }]
                    : []),
                ],
              },
              {
                id: 'error',
                type: 'assistant',
                time: 120,
                error: 'current failure',
                content: [],
              },
            ]),
      ];
      const input =
        flavor === 'v2'
          ? buildPluginInput({
              session: { context: async () => native },
            } as unknown as V2Context)
          : ({
              directory: '/test',
              client: {
                session: {
                  messages: async () => ({
                    data: native.map((message) => ({
                      info: {
                        id: message.id,
                        role: message.type,
                        time: { created: message.time },
                        error: 'error' in message ? message.error : undefined,
                      },
                      parts: message.content,
                    })),
                  }),
                },
              },
            } as unknown as PluginInput);
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'ses_child',
        parentSessionID: 'parent',
        agent: 'explorer',
        now: 1,
      });
      boardFixture.updateStatus(board, {
        taskID: 'ses_child',
        state: 'error',
        now: 30,
      });
      const previous = board.get('ses_child');
      if (!previous) throw new Error('expected previous run');
      const lease = board.acquireLease(
        'ses_child',
        previous.generation,
        'relaunch',
      );
      if (!lease) throw new Error('expected relaunch lease');
      board.registerLaunch({
        taskID: 'ses_child',
        parentSessionID: 'parent',
        agent: 'explorer',
        now: 100,
        relaunchLease: lease,
      });
      board.releaseLease(lease);
      boardFixture.updateStatus(board, {
        taskID: 'ses_child',
        state: 'error',
        now: 130,
      });
      const before = structuredClone(board.get('ses_child'));
      expect(before?.generation).toBe(2);
      const gate = createBackgroundJobTerminalGate({
        input,
        backgroundJobBoard: board,
      });
      dispose.push(() => gate.dispose());
      const output = await createTaskStatusTool({
        input,
        backgroundJobBoard: board,
        terminalGate: gate,
      }).task_status.execute(
        {
          ...(flavor === 'v2'
            ? { sessionID: 'ses_child' }
            : { task_id: 'ses_child' }),
          diagnostic: true,
        },
        context,
      );
      expect(output).toContain(`generation: ${before?.generation}`);
      expect(output).not.toContain('STALE SUCCESS');
      if (scenario === 'missing time' || scenario === 'only old evidence') {
        expect(output).toContain('excerpt: none (evidence unavailable)');
        expect(output).toContain('tracked run');
      } else {
        expect(output).toContain('assistant_error: current failure');
        expect(output).toContain('earlier messages omitted');
        if (scenario === 'textless failure')
          expect(output).toContain('2 earlier messages omitted');
        if (scenario === 'input before registration')
          expect(output).toContain('CURRENT PARTIAL');
      }
      expect(board.get('ses_child')).toEqual(before);
    },
  );

  test.each(
    (['v1', 'v2'] as const).flatMap((flavor) =>
      [true, false].map((partial) => ({ flavor, partial })),
    ),
  )(
    'read-only diagnostics fence runs on %j failed and interrupted children',
    async ({ flavor, partial }) => {
      for (const outcome of ['failed', 'interrupted']) {
        const host = {
          get: mock(async () => ({
            id: 'ses_child',
            parentID: 'parent',
            outcome,
            time: { idle: 20 },
          })),
          context: mock(async () => [
            {
              id: 'old-input',
              type: 'user',
              time: 1,
              content: [],
            },
            {
              id: 'old-answer',
              type: 'assistant',
              time: 2,
              content: [{ type: 'text', text: 'STALE SUCCESS' }],
            },
            {
              id: 'user',
              type: 'user',
              time: 10,
              content: [{ type: 'text', text: 'private input' }],
            },
            {
              id: 'answer',
              type: 'assistant',
              time: 11,
              content: partial ? [{ type: 'text', text: 'partial work' }] : [],
            },
          ]),
          prompt: mock(async () => ({})),
          interrupt: mock(async () => ({})),
          synthetic: mock(async () => ({})),
          wait: mock(async () => {}),
        };
        const input =
          flavor === 'v2'
            ? buildPluginInput({ session: host } as unknown as V2Context)
            : ({
                directory: '/test',
                client: {
                  session: {
                    prompt: host.prompt,
                    abort: host.interrupt,
                    synthetic: host.synthetic,
                    wait: host.wait,
                    get: mock(async () => ({ data: await host.get() })),
                    status: mock(async () => ({ data: {} })),
                    messages: mock(async () => ({
                      data: [
                        { info: { role: 'user' }, parts: [] },
                        {
                          info: { role: 'assistant' },
                          parts: [{ type: 'text', text: 'STALE SUCCESS' }],
                        },
                        {
                          info: { role: 'user', time: { created: 10 } },
                          parts: [],
                        },
                        {
                          info: {
                            role: 'assistant',
                            error: 'child failed',
                            time: { created: 11 },
                          },
                          parts: partial
                            ? [{ type: 'text', text: 'partial work' }]
                            : [],
                        },
                      ],
                    })),
                  },
                },
              } as unknown as PluginInput);
        const board = new BackgroundJobBoard();
        board.registerLaunch({
          taskID: 'ses_child',
          parentSessionID: 'parent',
          agent: 'explorer',
          now: 10,
        });
        boardFixture.updateStatus(board, {
          taskID: 'ses_child',
          state: 'error',
          now: 20,
        });
        const gate = createBackgroundJobTerminalGate({
          input,
          backgroundJobBoard: board,
        });
        dispose.push(() => gate.dispose());
        const capture = spyOn(gate, 'capture');
        const observe = spyOn(gate, 'observe');
        const reconcile = spyOn(gate, 'reconcile');
        const output = await createTaskStatusTool({
          input,
          backgroundJobBoard: board,
          terminalGate: gate,
        }).task_status.execute(
          {
            ...(flavor === 'v2'
              ? { sessionID: 'ses_child' }
              : { task_id: 'ses_child' }),
            diagnostic: true,
          },
          context,
        );
        expect(output).toContain('generation: 1');
        expect(output).toContain('state: error');
        expect(output).toContain('partial_output: true');
        if (partial) expect(output).toContain('partial work');
        expect(output).not.toContain('STALE SUCCESS');
        expect(output).toContain('2 earlier messages omitted');
        expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(
          6144,
        );
        for (const fn of [
          host.prompt,
          host.get,
          host.interrupt,
          host.synthetic,
          host.wait,
          capture,
          observe,
          reconcile,
        ])
          expect(fn).not.toHaveBeenCalled();
      }
    },
  );
  test.each([
    'disposed',
    'lease released',
    'agent changed',
    'current',
  ] as const)(
    'revalidates task authorization after the deferred agent lookup: %s',
    async (change) => {
      const entered = Promise.withResolvers<void>();
      const lookup = Promise.withResolvers<{ agent: string }>();
      let disposed = false;
      const get = mock(() => {
        entered.resolve();
        return lookup.promise;
      });
      const h = harness({
        running: true,
        session: { get },
        isDisposed: () => disposed,
      });
      const acquire = spyOn(h.board, 'acquireLease');
      const pending = h.message.execute(messageArgs, context);
      const settled = pending.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await entered.promise;
      expect(h.host.prompt).not.toHaveBeenCalled();
      const lease = acquire.mock.results
        .map((result) => result?.value)
        .find((value) => value?.kind === 'message');
      if (!lease) throw new Error('Expected a held message lease');

      if (change === 'disposed') disposed = true;
      if (change === 'lease released') h.board.releaseLease(lease);
      if (change === 'agent changed') {
        const job = h.board.get('ses_child');
        if (!job) throw new Error('Expected a tracked task');
        job.agent = 'fixer';
      }
      const failure = {
        disposed: /disposed/,
        'lease released': /message lease is no longer valid/,
        'agent changed': /agent changed while preparing/,
      };
      lookup.resolve({ agent: 'explorer' });
      const result = await settled;
      if (change === 'current') {
        expect(result.error).toBeUndefined();
        expect(String(result.value)).toContain('queued');
        expect(h.host.prompt).toHaveBeenCalledTimes(1);
        expect(h.host.prompt).toHaveBeenCalledWith({
          sessionID: 'ses_child',
          text: 'Update',
          delivery: 'queue',
          resume: false,
        });
      } else {
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toMatch(failure[change]);
        expect(h.host.prompt).not.toHaveBeenCalled();
      }
      expect(get).toHaveBeenCalledTimes(1);
      expect(h.host.switchAgent).not.toHaveBeenCalled();
      expect(h.host.switchModel).not.toHaveBeenCalled();
      expect(h.host.interrupt).not.toHaveBeenCalled();
      const nextLease = h.board.acquireLease('ses_child', 1, 'message');
      expect(nextLease).toBeDefined();
      if (nextLease) h.board.releaseLease(nextLease);
    },
  );

  test.each([
    { agent: 'other-agent' },
    {},
    { error: 'lookup failed' },
    undefined,
  ])(
    'refuses an unverified owning agent before writing: %j',
    async (record) => {
      const h = harness({
        session: { get: mock(async () => record) as never },
      });
      await expect(
        h.input.client.session.prompt({
          path: { id: 'ses_child' },
          body: {
            agent: 'explorer',
            noReply: true,
            parts: [{ type: 'text', text: 'Update' }],
          },
        }),
      ).rejects.toThrow('agent must match');
      expect(h.host.prompt).not.toHaveBeenCalled();
      expect(h.host.switchAgent).not.toHaveBeenCalled();
      expect(h.host.switchModel).not.toHaveBeenCalled();
    },
  );

  test('does not write if owning-agent lookup rejects or is unavailable', async () => {
    for (const get of [
      undefined,
      mock(async () => {
        throw new Error('lookup failed');
      }),
    ]) {
      const h = harness({ session: { get } });
      await expect(
        h.input.client.session.prompt({
          path: { id: 'ses_child' },
          body: { agent: 'explorer', noReply: true, parts: [] },
        }),
      ).rejects.toThrow();
      expect(h.host.prompt).not.toHaveBeenCalled();
      expect(h.host.switchAgent).not.toHaveBeenCalled();
    }
  });

  test.each(
    ['v2', 'v1-idle', 'v1-absent'].flatMap((route) =>
      [
        ['interrupted', 'failed'],
        ['failed', 'interrupted'],
        ['interrupted', 'succeeded'],
        ['succeeded', 'succeeded'],
      ].map(([oldOutcome, freshOutcome]) => ({
        route,
        oldOutcome,
        freshOutcome,
      })),
    ),
  )(
    'attributes host outcomes to G2 rather than G1: %j',
    async ({ route, oldOutcome, freshOutcome }) => {
      let clock = 200;
      spyOn(Date, 'now').mockImplementation(() => clock);
      let outcome = oldOutcome;
      let idle = 110;
      const baseline = { id: 'baseline', role: 'assistant', content: [] };
      let transcript: Array<Record<string, unknown>> = [baseline];
      const h = harness({
        retainedState: 'cancelled',
        session: {
          get: async () => ({ outcome, time: { idle } }),
          context: async () => transcript,
          prompt: async () => {
            transcript = [
              baseline,
              {
                id: 'pending',
                role: 'assistant',
                content: [{ type: 'text', text: 'streaming partial' }],
              },
            ];
            return {};
          },
        },
      });
      // Supply the real v1 map contract; the production v2 shim still omits it.
      if (route !== 'v2')
        h.input.client.session.status = mock(async () => ({
          data: route === 'v1-idle' ? { ses_child: { type: 'idle' } } : {},
        })) as never;
      const output = String(await h.revive.execute(reviveArgs, context));
      expect(output).toContain('status: started');
      expect(output).toContain('status_uncertain: true');
      expect(output).toContain('not attributable');
      expect(output).not.toContain('revive failed');
      const revision = h.board.get('ses_child')?.terminalRevision;
      transcript = [];
      for (let i = 0; i < 5; i++) {
        clock += 1_000;
        await h.tracker.probe('ses_child', 2);
      }
      expect(h.board.get('ses_child')).toMatchObject({
        generation: 2,
        state: 'running',
        statusUncertain: true,
        terminalRevision: revision,
        resultSummary: undefined,
      });
      expect(h.onTerminal).not.toHaveBeenCalled();
      expect(h.host.synthetic).not.toHaveBeenCalled();
      if (route === 'v2') {
        const oldRevision = h.tracker.revisionFor('ses_child', 2);
        h.tracker.register({
          taskID: 'ses_child',
          generation: 2,
          parentSessionID: 'parent',
          baselineMessageID: 'baseline',
          description: 'replacement attempt',
        });
        expect(h.tracker.revisionFor('ses_child', 2)).not.toBe(oldRevision);
        expect(h.tracker.attemptStartedAtFor('ses_child', 2)).toBe(clock);
        idle = clock - 1; // Valid for G2, but belongs to its replaced attempt.
        await h.tracker.probe('ses_child', 2);
        expect(h.onTerminal).not.toHaveBeenCalled();
        expect(h.board.get('ses_child')?.state).toBe('running');
      }
      clock += 2;
      outcome = freshOutcome;
      idle = clock - 1;
      transcript = [
        baseline,
        {
          id: 'answer',
          role: 'assistant',
          content: [{ type: 'text', text: 'G2 result' }],
        },
      ];
      await h.tracker.probe('ses_child', 2);
      await h.tracker.probe('ses_child', 2);
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
      expect(h.board.get('ses_child')).toMatchObject({
        state:
          freshOutcome === 'succeeded'
            ? 'completed'
            : freshOutcome === 'failed'
              ? 'error'
              : 'stopped',
        terminalRevision: (revision ?? 0) + 1,
        resultSummary:
          freshOutcome === 'succeeded'
            ? 'G2 result'
            : `Host reported outcome: ${freshOutcome}.`,
      });
    },
  );

  test('completion between admission and ACK uses the admission boundary', async () => {
    let clock = 200;
    spyOn(Date, 'now').mockImplementation(() => clock);
    const baseline = { id: 'baseline', role: 'assistant', content: [] };
    let transcript: Array<Record<string, unknown>> = [baseline];
    const h = harness({
      session: {
        get: async () => ({ outcome: 'succeeded', time: { idle: 220 } }),
        context: async () => transcript,
        prompt: async () => {
          transcript = [
            baseline,
            {
              id: 'answer',
              role: 'assistant',
              content: [{ type: 'text', text: 'fast G2' }],
            },
          ];
          clock = 250; // ACK follows the completion, not the other way round.
          return {};
        },
      },
    });
    const output = String(await h.revive.execute(reviveArgs, context));
    expect(output).toContain('status: completed');
    expect(h.board.get('ses_child')).toMatchObject({
      runStartedAt: 200,
      lastLiveBusyAt: 200,
      resultSummary: 'fast G2',
    });
    expect(h.tracker.attemptStartedAtFor('ses_child', 2)).toBe(200);
    expect(h.onTerminal).toHaveBeenCalledTimes(1);
  });
  test.each(['v1', 'v2'])(
    'message selection policy preserves the %s contract',
    async (flavor) => {
      const h = harness({ running: true });
      const prompt = mock(async () => ({}));
      const messages = mock(async () => ({
        data: [
          {
            info: {
              role: 'assistant',
              providerID: 'provider',
              modelID: 'model',
              variant: 'high',
            },
          },
        ],
      }));
      const input =
        flavor === 'v2'
          ? h.input
          : ({
              client: { session: { messages, prompt } },
              directory: '/test',
            } as unknown as PluginInput);
      const shimPrompt = spyOn(h.input.client.session, 'prompt');
      const tool = createTaskMessageTool({
        input,
        backgroundJobBoard: h.board,
      }).task_message;
      expect(String(await tool.execute(messageArgs, context))).toContain(
        'queued',
      );
      if (flavor === 'v1') {
        expect(messages).toHaveBeenCalledTimes(1);
        expect(prompt).toHaveBeenCalledWith(
          expect.objectContaining({
            body: {
              agent: 'explorer',
              model: { providerID: 'provider', modelID: 'model' },
              variant: 'high',
              noReply: true,
              parts: [{ type: 'text', text: 'Update' }],
            },
          }),
        );
      } else {
        expect(h.host.get).toHaveBeenCalledWith({ sessionID: 'ses_child' });
        expect(h.host.context).not.toHaveBeenCalled();
        expect(shimPrompt.mock.calls[0]?.[0].body).toEqual({
          agent: 'explorer',
          noReply: true,
          parts: [{ type: 'text', text: 'Update' }],
        });
        expect(h.host.prompt).toHaveBeenCalledWith({
          sessionID: 'ses_child',
          text: 'Update',
          delivery: 'queue',
          resume: false,
        });
      }
      expect(h.host.switchAgent).not.toHaveBeenCalled();
      expect(h.host.switchModel).not.toHaveBeenCalled();
      expect(h.host.synthetic).not.toHaveBeenCalled();
    },
  );

  test.each(['shim with files', 'interview notify'])(
    'preserves noReply intent from %s',
    async (caller) => {
      const h = harness();
      if (caller === 'interview notify') {
        await createV1InterviewSessionRuntime(h.input).notify(
          'ses_child',
          'Update',
        );
      } else
        await h.input.client.session.prompt({
          path: { id: 'ses_child' },
          body: {
            noReply: true,
            parts: [
              { type: 'text', text: 'Update' },
              {
                type: 'file',
                url: 'file:///test/a.txt',
                filename: 'a.txt',
                mime: 'text/plain',
              },
            ],
          },
        });
      expect(h.host.prompt).toHaveBeenCalledTimes(1);
      expect(h.host.prompt).toHaveBeenCalledWith({
        sessionID: 'ses_child',
        text: 'Update',
        delivery: 'queue',
        resume: false,
        ...(caller === 'shim with files'
          ? { files: [{ uri: 'file:///test/a.txt', name: 'a.txt' }] }
          : {}),
      });
      expect(h.host.synthetic).not.toHaveBeenCalled();
      expect(h.host.switchAgent).not.toHaveBeenCalled();
      expect(h.host.switchModel).not.toHaveBeenCalled();
    },
  );

  test.each(['agent', 'model', 'variant'])(
    'refuses unrepresentable prompt selection override %s before writing',
    async (key) => {
      const h = harness();
      await expect(
        h.input.client.session.prompt({
          path: { id: 'ses_child' },
          body: {
            noReply: true,
            [key]: 'override',
            parts: [{ type: 'text', text: 'Update' }],
          },
        }),
      ).rejects.toThrow('selection overrides');
      expect(h.host.prompt).not.toHaveBeenCalled();
      expect(h.host.switchAgent).not.toHaveBeenCalled();
      expect(h.host.switchModel).not.toHaveBeenCalled();
    },
  );

  test.each(['reject', 'error response'] as const)(
    'does not report queued or retry when the host returns %j',
    async (failure) => {
      const prompt = mock(async () => {
        if (failure === 'reject') throw new Error('host refused');
        return { error: 'host refused' };
      });
      const h = harness({ running: true, session: { prompt } });
      await expect(h.message.execute(messageArgs, context)).rejects.toThrow(
        'host refused',
      );
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenCalledWith({
        sessionID: 'ses_child',
        text: 'Update',
        delivery: 'queue',
        resume: false,
      });
    },
  );

  test.each(['resolve', 'reject'] as const)(
    'quarantines an admitted write until late %j without a second send',
    async (settlement) => {
      const send = Promise.withResolvers<unknown>();
      const prompt = mock(() => send.promise);
      const h = harness({
        running: true,
        session: { prompt },
        messageTimeoutMs: 5,
      });
      const release = spyOn(h.board, 'releaseLease');
      await expect(h.message.execute(messageArgs, context)).rejects.toThrow(
        'transport timed out',
      );
      expect(release).not.toHaveBeenCalled();
      expect(
        h.board.acquireLease('ses_child', 1, 'cancellation'),
      ).toBeUndefined();
      expect(h.board.acquireLease('ses_child', 1, 'relaunch')).toBeUndefined();
      if (settlement === 'resolve') send.resolve({});
      else send.reject(new Error('late rejection'));
      await Bun.sleep(0);
      expect(release).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenCalledWith({
        sessionID: 'ses_child',
        text: 'Update',
        delivery: 'queue',
        resume: false,
      });
      const lease = h.board.acquireLease('ses_child', 1, 'message');
      expect(lease).toBeDefined();
      if (lease) h.board.releaseLease(lease);
    },
  );

  test.each([false, true])(
    'revive waits for real host idle before admission (initially running: %s)',
    async (running) => {
      const idle = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const wait = mock(() => {
        entered.resolve();
        return idle.promise;
      });
      const h = harness({ running, session: { wait } });
      expect(h.input.client.session.status).toBeUndefined();
      expect(typeof h.input.experimental_v2?.waitForSessionIdle).toBe(
        'function',
      );
      const pending = h.revive.execute(reviveArgs, context);
      await entered.promise;
      expect(wait.mock.calls).toEqual([[{ sessionID: 'ses_child' }]]);
      expect(h.host.interrupt).toHaveBeenCalledTimes(running ? 1 : 0);
      // A running cancel must settle the same idle wait before baseline.
      // A retained session captures baseline and then waits before prompt.
      expect(h.baseline).toHaveBeenCalledTimes(running ? 0 : 1);
      expect(h.host.prompt).not.toHaveBeenCalled();
      idle.resolve();
      const output = String(await pending);
      expect(h.baseline).toHaveBeenCalledTimes(1);
      expect(output).toContain('status: started');
      expect(output).not.toContain('generation:');
      expect(h.host.prompt).toHaveBeenCalledWith({
        sessionID: 'ses_child',
        text: 'Continue',
        delivery: 'queue',
      });
      expect(h.register).toHaveBeenCalledTimes(1);
      expect(h.onLaunch).toHaveBeenCalledTimes(1);
      const lease = h.board.acquireLease('ses_child', 2, 'relaunch');
      expect(lease).toBeDefined();
      if (lease) h.board.releaseLease(lease);
    },
  );

  test.each([
    'pending',
    'late resolve',
    'late reject',
    'reject',
    'invalid',
    'non-promise',
    'blocked',
  ])(
    'does not authorize revive from an idle wait that is %s',
    async (outcome) => {
      const idle = Promise.withResolvers<void>();
      const wait = mock(() => {
        if (outcome === 'reject')
          return Promise.reject(new Error('idle wait rejected'));
        if (outcome === 'invalid')
          return Promise.resolve({ error: 'not idle' });
        if (outcome === 'non-promise') return undefined;
        if (outcome === 'blocked') {
          const until = Date.now() + 25;
          while (Date.now() < until) {
            /* Timer cannot run while the host blocks. */
          }
          return Promise.resolve();
        }
        return idle.promise;
      });
      const h = harness({
        session: { wait: wait as never },
        waitForIdleTimeoutMs: 5,
      });
      await expect(h.revive.execute(reviveArgs, context)).rejects.toThrow(
        /idle wait/i,
      );
      const lease = h.board.acquireLease('ses_child', 1, 'relaunch');
      expect(lease).toBeDefined();
      if (!lease) throw new Error('preparation lease was retained');
      if (outcome === 'late resolve') idle.resolve();
      if (outcome === 'late reject')
        idle.reject(new Error('late wait rejection'));
      await Bun.sleep(0);
      expect(h.host.prompt).not.toHaveBeenCalled();
      expect(h.host.interrupt).not.toHaveBeenCalled();
      expect(h.host.get).not.toHaveBeenCalled(); // Historical outcome is not authorization.
      expect(h.register).not.toHaveBeenCalled();
      expect(h.board.get('ses_child')).toMatchObject({
        generation: 1,
        state: 'completed',
      });
      expect(h.board.validateLease(lease)).toBe(true);
      h.board.releaseLease(lease);
    },
  );

  test.each(['drop', 'generation', 'revoke', 'running', 'activity'])(
    'revalidates ownership and activity after the idle wait: %s',
    async (change) => {
      const idle = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const h = harness({
        session: {
          wait: () => {
            entered.resolve();
            return idle.promise;
          },
        },
      });
      const acquire = spyOn(h.board, 'acquireLease');
      const pending = h.revive.execute(reviveArgs, context);
      await entered.promise;
      const lease = acquire.mock.results
        .map((result) => result?.value)
        .find((value) => value?.kind === 'relaunch');
      if (!lease) throw new Error('missing relaunch lease');
      let replacement: typeof lease | undefined;
      if (change === 'drop') h.board.drop('ses_child');
      if (change === 'generation' || change === 'revoke') {
        h.board.releaseLease(lease);
        if (change === 'generation')
          h.board.registerLaunch({
            taskID: 'ses_child',
            parentSessionID: 'parent',
            agent: 'explorer',
          });
        replacement = h.board.acquireLease(
          'ses_child',
          h.board.get('ses_child')?.generation ?? -1,
          'relaunch',
        );
      }
      if (change === 'running' || change === 'activity') {
        h.board.markRunningFromLiveSession('ses_child', 200);
        if (change === 'activity')
          boardFixture.updateStatus(h.board, {
            taskID: 'ses_child',
            state: 'completed',
            now: 210,
          });
      }
      idle.resolve();
      await expect(pending).rejects.toThrow(
        /no longer tracked|generation changed|became active again/,
      );
      expect(h.host.prompt).not.toHaveBeenCalled();
      expect(h.register).not.toHaveBeenCalled();
      expect(h.board.validateLease(lease)).toBe(false);
      if (replacement) {
        expect(h.board.validateLease(replacement)).toBe(true);
        h.board.releaseLease(replacement);
      }
      if (change === 'drop')
        h.board.registerLaunch({
          taskID: 'ses_child',
          parentSessionID: 'parent',
          agent: 'explorer',
        });
      const available = h.board.acquireLease(
        'ses_child',
        h.board.get('ses_child')?.generation ?? -1,
        'relaunch',
      );
      expect(available).toBeDefined();
      if (available) h.board.releaseLease(available);
    },
  );

  test.each([
    [false, undefined],
    [true, undefined],
    [true, false],
  ] as const)(
    'rejects a missing idle-verification capability before effects (running=%s, wait=%s)',
    async (running, wait) => {
      const h = harness({ running, session: { wait: wait as never } });
      expect(h.input.client.session.status).toBeUndefined();
      expect(h.input.experimental_v2?.waitForSessionIdle).toBeUndefined();
      await expect(h.revive.execute(reviveArgs, context)).rejects.toThrow(
        /idle-verification capability unavailable/,
      );
      expect(h.host.interrupt).not.toHaveBeenCalled();
      expect(h.host.get).not.toHaveBeenCalled();
      expect(h.baseline).not.toHaveBeenCalled();
      expect(h.host.context).not.toHaveBeenCalled();
      expect(h.host.prompt).not.toHaveBeenCalled();
      expect(h.register).not.toHaveBeenCalled();
    },
  );

  test('v2 messaging is queue-only: no steer parameter reaches the host', async () => {
    const h = harness({ running: true });
    const shimPrompt = spyOn(h.input.client.session, 'prompt');
    expect(Object.keys(h.message.args)).not.toContain('delivery');
    const output = String(
      await h.message.execute(
        { task_id: 'ses_child', message: 'Update' },
        context,
      ),
    );
    expect(h.host.prompt).toHaveBeenCalledWith({
      sessionID: 'ses_child',
      text: 'Update',
      delivery: 'queue',
      resume: false,
    });
    expect(h.host.interrupt).not.toHaveBeenCalled();
    expect(h.host.switchAgent).not.toHaveBeenCalled();
    expect(h.host.switchModel).not.toHaveBeenCalled();
    expect(h.host.synthetic).not.toHaveBeenCalled();
    expect(h.host.wait).not.toHaveBeenCalled();
    expect(h.host.get).toHaveBeenCalledWith({ sessionID: 'ses_child' });
    expect(h.host.context).not.toHaveBeenCalled();
    expect(output).not.toMatch(/read|applied|acknowledged/i);
    expect(shimPrompt.mock.calls[0]?.[0].body.agent).toBe('explorer');
    expect(shimPrompt.mock.calls[0]?.[0].body).not.toHaveProperty('delivery');
    expect(output).toMatch(/queued/i);
  });

  test('queue mirror omits the removed delivery argument', async () => {
    const h = harness({ running: true });
    await h.message.execute(
      { task_id: 'ses_child', message: 'Update' },
      context,
    );
    expect(h.host.prompt).toHaveBeenCalledWith({
      sessionID: 'ses_child',
      text: 'Update',
      delivery: 'queue',
      resume: false,
    });
  });
});
