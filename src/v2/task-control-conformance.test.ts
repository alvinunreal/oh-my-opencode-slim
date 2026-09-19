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
  } = {},
) {
  const host = {
    get: mock(async () => ({
      outcome: 'interrupted',
      agent: 'persisted-agent',
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
  const generateText = mock(async (text: string) => ({ text }));
  const input = buildPluginInput({ session: host } as unknown as V2Context, {
    generateText,
  }) as unknown as PluginInput & { experimental_v2?: ExperimentalV2 };
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
    onTerminal,
    graceMs: 5,
  });
  tracker = createRevivedRunTracker({
    input,
    backgroundJobBoard: board,
    terminalGate: gate,
  });
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
    generateText,
    tracker,
    gate,
    onTerminal,
  };
}

describe('task controls through the real v2 client shim', () => {
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
      const get = mock(async () => ({
        data: {
          model: { providerID: 'provider', id: 'model', variant: 'high' },
        },
      }));
      const input =
        flavor === 'v2'
          ? h.input
          : ({
              client: { session: { get, prompt } },
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
        expect(get).toHaveBeenCalledTimes(1);
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
        expect(h.host.get).not.toHaveBeenCalled();
        expect(h.host.context).not.toHaveBeenCalled();
        expect(shimPrompt.mock.calls[0]?.[0].body).toEqual({
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

  test.each(['reject', 'error response'])(
    'does not report queued or retry when the host returns %s',
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

  test.each(['resolve', 'reject'])(
    'quarantines an admitted write until late %s without a second send',
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
      expect(h.board.acquireCancellationLease('ses_child', 1)).toBeUndefined();
      expect(h.board.acquireRelaunchLease('ses_child', 1)).toBeUndefined();
      if (settlement === 'resolve') send.resolve({});
      else send.reject(new Error('late rejection'));
      await Bun.sleep(0);
      expect(release).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenCalledTimes(1);
      const lease = h.board.acquireMessageLease('ses_child', 1);
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
      expect(await h.input.experimental_v2?.generateText?.('ping')).toEqual({
        text: 'ping',
      });
      const pending = h.revive.execute(reviveArgs, context);
      await entered.promise;
      expect(wait.mock.calls).toEqual([[{ sessionID: 'ses_child' }]]);
      expect(h.host.interrupt).toHaveBeenCalledTimes(running ? 1 : 0);
      expect(h.baseline).toHaveBeenCalledTimes(1);
      expect(h.host.prompt).not.toHaveBeenCalled();
      idle.resolve();
      const output = String(await pending);
      expect(output).toContain('generation: 2');
      expect(output).toContain('status: started');
      expect(h.host.prompt).toHaveBeenCalledWith({
        sessionID: 'ses_child',
        text: 'Continue',
        delivery: 'queue',
      });
      expect(h.register).toHaveBeenCalledTimes(1);
      expect(h.onLaunch).toHaveBeenCalledTimes(1);
      const lease = h.board.acquireRelaunchLease('ses_child', 2);
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
      const lease = h.board.acquireRelaunchLease('ses_child', 1);
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
      const acquire = spyOn(h.board, 'acquireRelaunchLease');
      const pending = h.revive.execute(reviveArgs, context);
      await entered.promise;
      const lease = acquire.mock.results[0]?.value;
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
        replacement = h.board.acquireRelaunchLease(
          'ses_child',
          h.board.get('ses_child')?.generation ?? -1,
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
      const available = h.board.acquireRelaunchLease(
        'ses_child',
        h.board.get('ses_child')?.generation ?? -1,
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
      expect(await h.input.experimental_v2?.generateText?.('ping')).toEqual({
        text: 'ping',
      });
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
});
