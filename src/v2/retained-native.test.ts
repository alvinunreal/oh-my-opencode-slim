import { afterEach, describe, expect, jest, test } from 'bun:test';
import { createPendingCallTracker } from '../hooks/task-session-manager/pending-call-tracker';
import {
  aliasUnpairedMessage,
  aliasUnverifiedMessage,
  appendChildRefSuffix,
  createAliasAuthority,
  createSessionRecovery,
  readAuthoritativeChildRef,
} from '../hooks/task-session-manager/session-recovery';
import {
  handleToolExecuteAfter,
  handleToolExecuteBefore,
} from '../hooks/task-session-manager/tool-execute-hooks';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { BackgroundJobBoard as FixtureBoard } from '../utils/background-job-fixture';
import { parseTaskIdFromTaskOutput } from '../utils/task';
import { buildPluginInput } from './client-shim';
import { createToolExecuteBridges } from './setup';

const PARENT = 'ses_parent';
const CHILD = 'ses_child';

afterEach(() => {
  jest.useRealTimers();
});

function round(text = 'LAB-MARKER') {
  return [
    {
      id: 'msg_user',
      type: 'user',
      time: { created: 10 },
      text: 'ask',
    },
    {
      id: 'msg_assistant',
      type: 'assistant',
      agent: 'fixer',
      parentID: 'msg_user',
      time: { created: 11, completed: 12 },
      finish: 'stop',
      content: [{ type: 'text', text }],
    },
    {
      id: 'msg_idle',
      type: 'idle',
      time: 13,
      outcome: 'succeeded',
    },
  ];
}

function host(options?: {
  get?: () => unknown;
  prompt?: (input: unknown) => Promise<unknown>;
  context?: (args: { sessionID: string }) => unknown;
  messages?: () => unknown;
}) {
  const context = options?.context ?? (() => round());
  const get =
    options?.get ??
    (() => ({
      id: CHILD,
      parentID: PARENT,
      agent: 'fixer',
      outcome: 'succeeded',
      time: { created: 9, idle: 13 },
    }));
  return buildPluginInput({
    directory: '/tmp/omo-implementation-repair',
    session: {
      get: async () => get(),
      ...(options?.prompt ? { prompt: options.prompt } : {}),
      context: async (args: { sessionID: string }) => context(args),
      messages: options?.messages,
    },
  } as never);
}

function deps(
  board: BackgroundJobBoard,
  input: ReturnType<typeof host>,
  pendingCallTracker = createPendingCallTracker(),
) {
  return {
    shouldManageSession: () => true,
    backgroundJobBoard: board,
    pendingCallTracker,
    taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
    hostFlavor: 'v2',
    recoverRetainedSession: createSessionRecovery({
      input: input as never,
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      stableStoppedMs: 0,
    }),
  };
}

describe('v2 historical context', () => {
  test('keeps scalar idle time, agent, and user text', async () => {
    const input = host();
    const response = await input.client.session.messages({
      path: { id: CHILD },
      query: { directory: '/tmp' },
    });
    const idle = response.data.find(
      (message: { info?: { sourceType?: string } }) =>
        message.info?.sourceType === 'idle',
    );
    expect(idle.info.time.created).toBe(13);
    expect(idle.info.outcome).toBe('succeeded');
    const user = response.data.find(
      (message: { info?: { sourceType?: string } }) =>
        message.info?.sourceType === 'user',
    );
    expect(user.parts[0].text).toBe('ask');
    const assistant = response.data.find(
      (message: { info?: { sourceType?: string } }) =>
        message.info?.sourceType === 'assistant',
    );
    expect(assistant.info.agent).toBe('fixer');
  });

  // The incident shape: the host recorded the terminal outcome, but the
  // transcript carries no trailing idle marker (shutdown-interrupted write).
  // Host-state triage must import completed, not stopped.
  test('a host terminal outcome imports completed without a transcript idle marker', async () => {
    const board = new BackgroundJobBoard();
    const input = host({
      context: (args) =>
        args.sessionID === CHILD
          ? [
              {
                id: 'msg_user',
                type: 'user',
                time: { created: 10 },
                text: 'ask',
              },
              {
                id: 'msg_assistant',
                type: 'assistant',
                agent: 'fixer',
                parentID: 'msg_user',
                time: { created: 11, completed: 12 },
                finish: 'stop',
                content: [{ type: 'text', text: 'LAB-MARKER' }],
              },
            ]
          : round(),
    });
    const result = await createSessionRecovery({
      input: input as never,
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      stableStoppedMs: 0,
    })({ parentSessionID: PARENT, requested: CHILD });
    expect(result).toEqual({ kind: 'recovered', taskID: CHILD });
    expect(board.get(CHILD)).toMatchObject({
      state: 'completed',
      resultSummary: 'LAB-MARKER',
    });
  });

  test.each([false, true])(
    'textless success stays pending (assistant present: %j)',
    async (withAssistant) => {
      const board = new BackgroundJobBoard();
      const input = host({
        context: (args) =>
          args.sessionID === CHILD
            ? round('').slice(0, withAssistant ? 2 : 1)
            : round(),
      });
      const refused = await createSessionRecovery({
        input: input as never,
        backgroundJobBoard: board,
        hostFlavor: 'v2',
        stableStoppedMs: 0,
      })({ parentSessionID: PARENT, requested: CHILD });
      expect(refused.kind).toBe('refused');
      if (refused.kind === 'refused') {
        expect(refused.reason).toContain('answer text is not readable yet');
      }
      expect(board.get(CHILD)).toBeUndefined();
    },
  );

  test('a textless succeeded outcome still adopts identity for a queued revive', async () => {
    // The P1 companion: adoption returns verified identity without
    // importing an empty completed row; task_revive owns the continuation.
    const board = new BackgroundJobBoard();
    const input = host({
      context: (args) =>
        args.sessionID === CHILD
          ? [
              {
                id: 'msg_user',
                type: 'user',
                time: { created: 10 },
                text: 'ask',
              },
            ]
          : round(),
    });
    const adopted = await createSessionRecovery({
      input: input as never,
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      stableStoppedMs: 0,
    })({
      parentSessionID: PARENT,
      requested: CHILD,
      purpose: 'revive',
      allowQueuedContinuation: true,
    });
    expect(adopted).toMatchObject({ kind: 'adoptable', taskID: CHILD });
    expect(board.get(CHILD)).toBeUndefined();
  });

  test.each([
    ['failed', 'error', false],
    ['failed', 'error', true],
    ['interrupted', 'stopped', false],
    ['interrupted', 'stopped', true],
  ] as const)(
    'textless %s recovers %s (assistant present: %j)',
    async (outcome, state, withAssistant) => {
      const board = new BackgroundJobBoard();
      const input = host({
        get: () => ({
          id: CHILD,
          parentID: PARENT,
          agent: 'fixer',
          outcome,
          time: { created: 9, idle: 13 },
        }),
        context: (args) =>
          args.sessionID === CHILD
            ? round('').slice(0, withAssistant ? 2 : 1)
            : round(),
      });
      const result = await createSessionRecovery({
        input: input as never,
        backgroundJobBoard: board,
        hostFlavor: 'v2',
        stableStoppedMs: 0,
      })({ parentSessionID: PARENT, requested: CHILD });
      expect(result).toEqual({ kind: 'recovered', taskID: CHILD });
      expect(board.get(CHILD)?.state).toBe(state);
      if (outcome === 'failed') {
        expect(board.get(CHILD)?.resultSummary).toBe(
          'The historical round failed before an assistant result.',
        );
      }
    },
  );

  test.each(['succeeded', 'failed', 'interrupted'] as const)(
    'newer assistant activity blocks an older %s outcome',
    async (outcome) => {
      for (const time of [{ created: 14 }, { created: 11, completed: 14 }]) {
        const board = new BackgroundJobBoard();
        const input = host({
          get: () => ({
            id: CHILD,
            parentID: PARENT,
            agent: 'fixer',
            outcome,
            time: { created: 9, idle: 13 },
          }),
          context: () => [
            ...round(),
            {
              id: 'new-answer',
              type: 'assistant',
              agent: 'fixer',
              time,
              content: [{ type: 'text', text: 'PARTIAL' }],
            },
          ],
        });
        const recover = createSessionRecovery({
          input: input as never,
          backgroundJobBoard: board,
          hostFlavor: 'v2',
        });
        expect(
          (await recover({ parentSessionID: PARENT, requested: CHILD })).kind,
        ).toBe('refused');
        expect(board.get(CHILD)).toBeUndefined();
        // An explicit queued continuation may adopt identity, never import
        // the obsolete terminal or newer partial answer as a settled row.
        expect(
          await recover({
            parentSessionID: PARENT,
            requested: CHILD,
            purpose: 'revive',
            allowQueuedContinuation: true,
          }),
        ).toMatchObject({ kind: 'adoptable', taskID: CHILD });
        expect(board.get(CHILD)).toBeUndefined();
      }
    },
  );

  test('a newer synthetic blocks an older succeeded outcome', async () => {
    // Host-state triage: the succeeded outcome predates the newest input
    // (the synthetic), so no terminal covers that round. Recovery reports
    // pending instead of importing OLD or lying about a stopped round.
    const input = host({
      get: () => ({
        id: CHILD,
        parentID: PARENT,
        agent: 'fixer',
        outcome: 'succeeded',
        time: { created: 9, idle: 13 },
      }),
      context: (args) =>
        args.sessionID === CHILD
          ? [
              {
                id: 'msg_user',
                type: 'user',
                time: { created: 10 },
                text: 'ask',
              },
              {
                id: 'msg_assistant',
                type: 'assistant',
                agent: 'fixer',
                parentID: 'msg_user',
                time: { created: 11, completed: 12 },
                finish: 'stop',
                content: [{ type: 'text', text: 'OLD' }],
              },
              {
                id: 'msg_idle',
                type: 'idle',
                time: 13,
                outcome: 'succeeded',
              },
              {
                id: 'msg_synthetic',
                type: 'synthetic',
                time: { created: 14 },
                text: 'new boundary',
              },
            ]
          : round(),
    });
    const board = new BackgroundJobBoard();
    const result = await createSessionRecovery({
      input: input as never,
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      stableStoppedMs: 0,
    })({ parentSessionID: PARENT, requested: CHILD });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.reason).toContain('no terminal outcome');
    }
    expect(board.get(CHILD)).toBeUndefined();
  });
});

describe('v2 native resume through the setup bridge', () => {
  test('an unacknowledged completed session reconciles its old round and continues without a result read', async () => {
    const board = new FixtureBoard();
    board.registerLaunch({
      taskID: CHILD,
      parentSessionID: PARENT,
      agent: 'fixer',
      now: 10,
    });
    board.updateStatus({
      taskID: CHILD,
      state: 'completed',
      resultSummary: 'OLD',
    });
    const before = board.get(CHILD);
    const input = {
      tool: 'subagent',
      sessionID: PARENT,
      id: 'call_2',
      input: {
        agent: 'fixer',
        sessionID: CHILD,
        prompt: 'next',
        description: 'next',
      },
    };
    const bridges = createToolExecuteBridges(
      (hookInput, output) =>
        handleToolExecuteBefore(hookInput, output, deps(board, host())),
      undefined,
    );
    await bridges.beforeBridge(input);
    expect(input.input.sessionID).toBe(CHILD);
    // The old round is acknowledged by the resume path itself (the retired
    // task_revive used to do it), so the terminal result is consumed exactly
    // once and the same generation keeps its identity.
    expect(board.get(CHILD)).toMatchObject({
      state: 'reconciled',
      terminalState: 'completed',
      resultSummary: 'OLD',
      terminalUnreconciled: false,
      generation: before?.generation,
      terminalRevision: before?.terminalRevision,
    });
  });

  test('an unknown completed child is imported, reconciled, and then resumed, and failures do not create a child', async () => {
    const board = new BackgroundJobBoard();
    const input = host();
    const event = {
      tool: 'subagent',
      sessionID: PARENT,
      id: 'call_3',
      input: {
        agent: 'fixer',
        sessionID: CHILD,
        prompt: 'next',
        description: 'next',
      },
    };
    const bridges = createToolExecuteBridges(
      (hookInput, output) =>
        handleToolExecuteBefore(hookInput, output, deps(board, input)),
      undefined,
    );
    await bridges.beforeBridge(event);
    expect(board.get(CHILD)).toMatchObject({
      state: 'reconciled',
      terminalState: 'completed',
      agent: 'fixer',
      resultSummary: 'LAB-MARKER',
      parentSessionID: PARENT,
    });
    expect(event.input.sessionID).toBe(CHILD);

    const missing = new BackgroundJobBoard();
    const missingEvent = {
      tool: 'subagent',
      sessionID: PARENT,
      id: 'call_4',
      input: {
        agent: 'fixer',
        sessionID: CHILD,
        prompt: 'next',
        description: 'next',
      },
    };
    const missingBridges = createToolExecuteBridges(
      (hookInput, output) =>
        handleToolExecuteBefore(
          hookInput,
          output,
          deps(
            missing,
            host({ get: () => ({ error: { message: 'NotFound' } }) }),
          ),
        ),
      undefined,
    );
    await expect(missingBridges.beforeBridge(missingEvent)).rejects.toThrow(
      /cannot resolve this sessionID/,
    );
    expect(missingEvent.input.sessionID).toBe(CHILD);
    expect(missing.list(PARENT)).toEqual([]);

    const wrong = new BackgroundJobBoard();
    const wrongParentEvent = {
      tool: 'subagent',
      sessionID: PARENT,
      id: 'call_5',
      input: {
        agent: 'fixer',
        sessionID: CHILD,
        prompt: 'next',
        description: 'next',
      },
    };
    await createToolExecuteBridges(
      (hookInput, output) =>
        handleToolExecuteBefore(
          hookInput,
          output,
          deps(
            wrong,
            host({
              get: () => ({
                id: CHILD,
                parentID: 'ses_other',
                agent: 'fixer',
              }),
            }),
          ),
        ),
      undefined,
    ).beforeBridge(wrongParentEvent);
    // Native v2 `subagent` owns the parent-ownership refusal. The bridge
    // leaves the call intact and registers no board row.
    expect(wrongParentEvent.input.sessionID).toBe(CHILD);
    expect(wrong.get(CHILD)).toBeUndefined();
  });

  test('a malformed ses id is left to native subagent, not alias history', async () => {
    const board = new BackgroundJobBoard();
    const tracker = createPendingCallTracker();
    const malformed = {
      tool: 'subagent',
      sessionID: PARENT,
      id: 'call_malformed',
      input: {
        agent: 'fixer',
        sessionID: 'ses',
        prompt: 'next',
        description: 'next',
      },
    };
    await createToolExecuteBridges(
      (hookInput, output) =>
        handleToolExecuteBefore(
          hookInput,
          output,
          deps(board, host(), tracker),
        ),
      undefined,
    ).beforeBridge(malformed);
    expect(malformed.input.sessionID).toBe('ses');
    // The pending is delegated without a lease or admission ticket: native
    // owns the session-id decision, and the existing no-lease guard prevents
    // the executor wrapper/after-hook from registering a phantom row.
    const pending = tracker.peekByCallId('call_malformed', PARENT);
    expect(pending?.resumedTaskId).toBe('ses');
    expect(pending?.relaunchLease).toBeUndefined();
    expect(pending?.concurrencyTicket).toBeUndefined();
    expect(board.list(PARENT)).toEqual([]);
    await handleToolExecuteAfter(
      { tool: 'task', sessionID: PARENT, callID: 'call_malformed' },
      { output: 'Subagent session not found: ses' },
      {
        ...deps(board, host(), tracker),
        terminalGate: {
          reconcile: async () => undefined,
        } as never,
      },
    );
    expect(tracker.peekByCallId('call_malformed', PARENT)).toBeUndefined();
  });

  test('a ses-prefixed custom agent alias still composes with the handler', async () => {
    const board = new BackgroundJobBoard();
    const tracker = createPendingCallTracker();
    board.registerLaunch({
      taskID: CHILD,
      parentSessionID: PARENT,
      agent: 'ses-agent',
    });
    const running = board.get(CHILD);
    if (!running) throw new Error('expected a registered alias');
    expect(running.alias).toBe('ses-1');
    const input = host();
    const authority = createAliasAuthority({
      input: input as never,
      board,
      hostFlavor: 'v2',
    });
    const event = {
      tool: 'subagent',
      sessionID: PARENT,
      id: 'call_custom_alias',
      input: {
        agent: 'ses-agent',
        sessionID: 'ses-1',
        prompt: 'next',
        description: 'next',
      },
    };
    await createToolExecuteBridges(
      (hookInput, output) =>
        handleToolExecuteBefore(hookInput, output, {
          ...deps(board, input, tracker),
          resolveCanonicalTaskRef: authority.resolveCanonical,
        }),
      undefined,
    ).beforeBridge(event);
    // The authority resolves the numbered alias to its real id; the handler
    // must not treat `ses-1` as a broken session id.
    expect(event.input.sessionID).toBe(CHILD);
    expect(
      tracker.peekByCallId('call_custom_alias', PARENT)?.resumedTaskId,
    ).toBe(CHILD);
  });

  test('an untracked incomplete session is adopted instead of refused', async () => {
    // A seat that was running when the plugin restarted has no board row.
    // Without adoption the seat is a permanent [no response] placeholder, so
    // the delegation path adopts the verified host session and resumes it.
    const board = new BackgroundJobBoard();
    const input = host({
      get: () => ({
        id: CHILD,
        parentID: PARENT,
        agent: 'fixer',
        time: { created: 9 },
      }),
    });
    const event = {
      tool: 'subagent',
      sessionID: PARENT,
      id: 'call_adopt',
      input: {
        agent: 'fixer',
        sessionID: CHILD,
        prompt: 'again',
        description: 'again',
      },
    };
    await createToolExecuteBridges(
      (hookInput, output) =>
        handleToolExecuteBefore(hookInput, output, deps(board, input)),
      undefined,
    ).beforeBridge(event);

    // The adopted row represents recovered host work until a continuation is
    // accepted, and it is tracked under the calling parent.
    const adopted = board.get(CHILD);
    expect(adopted).toMatchObject({
      parentSessionID: PARENT,
      agent: 'fixer',
      externalOrigin: true,
      recoveredWithoutPrompt: true,
    });
    expect(event.input.sessionID).toBe(CHILD);
    // One row only: adoption never spawns a second child.
    expect(board.list(PARENT)).toHaveLength(1);
  });
});

test('real parent context pairs an alias through the shim', async () => {
  // Desensitized OpenCode 2.0.19 session.context tool part
  // (bounds-20260930T062758 round1 parent context): name, state.content,
  // and created/ran/completed. Identifiers and body text are replaced.
  const messages: Array<Record<string, unknown>> = [
    {
      id: 'msg_parent_user',
      type: 'user',
      time: { created: 1000 },
      text: 'ask',
    },
    {
      id: 'msg_parent_turn',
      type: 'assistant',
      agent: 'orchestrator',
      time: { created: 1001, completed: 1100 },
      content: [
        {
          type: 'tool',
          name: 'subagent',
          id: 'call_child',
          time: { created: 1002, ran: 1003, completed: 1090 },
          state: {
            input: {
              agent: 'fixer',
              description: 'Run one check',
              prompt: 'ask',
              background: false,
            },
            content: [
              {
                type: 'text',
                text: '<subagent sessionID="ses_childshape" state="completed">\nMARKER\n</subagent>',
              },
            ],
          },
        },
      ],
    },
  ];
  let childID = '';
  let agent = '';
  let description = '';
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const tool = part as Record<string, unknown>;
      if (tool.name !== 'subagent') continue;
      const state = tool.state as Record<string, unknown>;
      const input = state.input as Record<string, unknown>;
      agent = String(input.agent);
      description = String(input.description);
      const blocks = state.content as Array<Record<string, unknown>>;
      const text = String(blocks[0]?.text ?? '');
      const outer = /sessionID="([^"]+)"/.exec(text)?.[1] ?? '';
      childID = outer;
      blocks[0] = {
        ...blocks[0],
        text: appendChildRefSuffix(text, {
          parentSessionID: PARENT,
          agent,
          alias: 'fix-4',
          sessionID: outer,
        }),
      };
    }
  }
  expect(childID).toMatch(/^ses_/);
  const directory = '/tmp/omo-implementation-repair';
  const input = buildPluginInput({
    directory,
    session: {
      get: async (args: { sessionID: string }) => {
        if (args.sessionID !== childID)
          return { error: { message: 'NotFound' } };
        return {
          id: childID,
          parentID: PARENT,
          agent,
          outcome: 'succeeded',
          time: { created: 9, idle: 13 },
        };
      },
      context: async (args: { sessionID: string }) =>
        args.sessionID === PARENT ? messages : round('FROM-CHILD'),
    },
  } as never);
  const board = new BackgroundJobBoard();
  const canonical = await createAliasAuthority({
    input: input as never,
    board,
  }).resolveCanonical(PARENT, 'fix-4');
  expect(canonical).toEqual({ kind: 'exact', taskID: childID });
  const result = await createSessionRecovery({
    input: input as never,
    backgroundJobBoard: board,
    hostFlavor: 'v2',
    stableStoppedMs: 0,
  })({ parentSessionID: PARENT, requested: childID, agent });
  expect(result).toEqual({ kind: 'recovered', taskID: childID });
  expect(board.get(childID)).toMatchObject({
    alias: 'fix-4',
    agent,
    state: 'completed',
    parentSessionID: PARENT,
  });
  expect(board.get(childID)?.description.length).toBeGreaterThan(0);
  expect(description.length).toBeGreaterThan(0);
});

test('host outcome triage: interrupted stops, failed errors, and a newer assistant exceeds the host idle', async () => {
  // Host-state triage imports the interrupted round without an assistant.
  // An assistant created after the terminal idle is newer activity the host
  // terminal does not cover, so it must stay pending rather than complete.
  const interruptedInput = host({
    get: () => ({
      id: CHILD,
      parentID: PARENT,
      agent: 'fixer',
      outcome: 'interrupted',
      time: { created: 9, idle: 11 },
    }),
    context: (args) =>
      args.sessionID === CHILD ? round().slice(0, 1) : round(),
  });
  const interruptedBoard = new BackgroundJobBoard();
  await createSessionRecovery({
    input: interruptedInput as never,
    backgroundJobBoard: interruptedBoard,
    hostFlavor: 'v2',
    stableStoppedMs: 0,
  })({ parentSessionID: PARENT, requested: CHILD });
  expect(interruptedBoard.get(CHILD)).toMatchObject({
    state: 'stopped',
  });

  const failedInput = host({
    get: () => ({
      id: CHILD,
      parentID: PARENT,
      agent: 'fixer',
      outcome: 'failed',
      time: { created: 9, idle: 11 },
    }),
    context: (args) =>
      args.sessionID === CHILD ? round().slice(0, 1) : round(),
  });
  const failedBoard = new BackgroundJobBoard();
  await createSessionRecovery({
    input: failedInput as never,
    backgroundJobBoard: failedBoard,
    hostFlavor: 'v2',
    stableStoppedMs: 0,
  })({ parentSessionID: PARENT, requested: CHILD });
  expect(failedBoard.get(CHILD)).toMatchObject({ state: 'error' });

  const newerAssistantInput = host({
    get: () => ({
      id: CHILD,
      parentID: PARENT,
      agent: 'fixer',
      outcome: 'succeeded',
      time: { created: 9, idle: 13 },
    }),
    context: (args) =>
      args.sessionID === CHILD
        ? [
            {
              id: 'msg_user',
              type: 'user',
              time: { created: 10 },
              text: 'ask',
            },
            {
              id: 'msg_a',
              type: 'assistant',
              agent: 'fixer',
              parentID: 'msg_user',
              time: { created: 11, completed: 12 },
              finish: 'stop',
              content: [{ type: 'text', text: 'ANSWER-A' }],
            },
            { id: 'msg_idle_a', type: 'idle', time: 13, outcome: 'succeeded' },
            {
              id: 'msg_b',
              type: 'assistant',
              agent: 'fixer',
              parentID: 'msg_user',
              time: { created: 14 },
              content: [{ type: 'text', text: 'ANSWER-B' }],
            },
          ]
        : round(),
  });
  const newerBoard = new BackgroundJobBoard();
  const newerResult = await createSessionRecovery({
    input: newerAssistantInput as never,
    backgroundJobBoard: newerBoard,
    hostFlavor: 'v2',
    stableStoppedMs: 0,
  })({ parentSessionID: PARENT, requested: CHILD });
  // The host succeeded at idle 13, but the newest assistant was created at
  // 14. That reply is not covered by the terminal boundary.
  expect(newerResult.kind).toBe('refused');
  if (newerResult.kind === 'refused') {
    expect(newerResult.reason).toContain('no terminal outcome');
  }
  expect(newerBoard.get(CHILD)).toBeUndefined();
});

test('malformed transcript entries fail closed during v2 recovery', async () => {
  const board = new BackgroundJobBoard();
  const input = host({
    get: () => ({
      id: CHILD,
      parentID: PARENT,
      agent: 'fixer',
      outcome: 'succeeded',
      time: { created: 9, idle: 13 },
    }),
  });
  (input.client.session as { messages: unknown }).messages = async () => ({
    data: [{ info: null }],
  });
  const result = await createSessionRecovery({
    input: input as never,
    backgroundJobBoard: board,
    hostFlavor: 'v2',
    stableStoppedMs: 0,
  })({ parentSessionID: PARENT, requested: CHILD });
  expect(result.kind).toBe('refused');
  if (result.kind === 'refused') {
    expect(result.reason).toContain('malformed transcript entries');
  }
  expect(board.get(CHILD)).toBeUndefined();
});

test('a host terminal outcome without a transcript input boundary is pending, not completed', async () => {
  const board = new BackgroundJobBoard();
  const input = host({
    get: () => ({
      id: CHILD,
      parentID: PARENT,
      agent: 'fixer',
      outcome: 'succeeded',
      time: { created: 9, idle: 13 },
    }),
    context: (args) =>
      args.sessionID === CHILD
        ? [
            {
              id: 'msg_assistant',
              type: 'assistant',
              agent: 'fixer',
              time: { created: 11, completed: 12 },
              finish: 'stop',
              content: [{ type: 'text', text: 'ORPHAN' }],
            },
          ]
        : round(),
  });
  const result = await createSessionRecovery({
    input: input as never,
    backgroundJobBoard: board,
    hostFlavor: 'v2',
    stableStoppedMs: 0,
  })({ parentSessionID: PARENT, requested: CHILD });
  expect(result.kind).toBe('refused');
  if (result.kind === 'refused') {
    expect(result.reason).toContain('no terminal outcome');
  }
  expect(board.get(CHILD)).toBeUndefined();
});

test('host state that cannot be verified fails closed', async () => {
  const board = new BackgroundJobBoard();
  const input = host({
    get: () => ({
      id: CHILD,
      parentID: PARENT,
      agent: 'fixer',
      outcome: 'succeeded',
      time: { created: 9 },
    }),
  });
  const result = await createSessionRecovery({
    input: input as never,
    backgroundJobBoard: board,
    hostFlavor: 'v2',
    stableStoppedMs: 0,
  })({ parentSessionID: PARENT, requested: CHILD });
  expect(result.kind).toBe('refused');
  if (result.kind === 'refused') {
    expect(result.reason).toContain('host state could not be verified');
  }
  expect(board.get(CHILD)).toBeUndefined();
});

test('an unfinished (shutdown-interrupted) session is refused as pending and the delegation path adopts it', async () => {
  // Shutdown preserves the execution claim on purpose and the host may resume
  // the round after a restart, so plain recovery must not import it as
  // terminal. The delegation path (purpose revive + queued continuation)
  // adopts the verified identity instead, so a seat that was running at
  // restart is not a permanent unresolved placeholder.
  const board = new BackgroundJobBoard();
  const input = host({
    get: () => ({
      id: CHILD,
      parentID: PARENT,
      agent: 'fixer',
      time: { created: 9 },
    }),
  });
  const refused = await createSessionRecovery({
    input: input as never,
    backgroundJobBoard: board,
    hostFlavor: 'v2',
    stableStoppedMs: 0,
  })({ parentSessionID: PARENT, requested: CHILD });
  expect(refused.kind).toBe('refused');
  if (refused.kind === 'refused') {
    expect(refused.reason).toContain('no terminal outcome');
    expect(refused.reason).toContain('subagent(sessionID: "ses_child"');
    expect(refused.reason).not.toContain('task_revive');
  }
  expect(board.get(CHILD)).toBeUndefined();

  const event = {
    tool: 'subagent',
    sessionID: PARENT,
    id: 'call_pending',
    input: {
      agent: 'fixer',
      sessionID: CHILD,
      prompt: 'again',
      description: 'again',
    },
  };
  await createToolExecuteBridges(
    (hookInput, output) =>
      handleToolExecuteBefore(hookInput, output, deps(board, input)),
    undefined,
  ).beforeBridge(event);
  // Adopted, not refused: one tracked row, no silent re-dispatch.
  expect(board.list(PARENT)).toHaveLength(1);
  expect(board.get(CHILD)).toMatchObject({
    parentSessionID: PARENT,
    agent: 'fixer',
    recoveredWithoutPrompt: true,
  });
  expect(event.input.sessionID).toBe(CHILD);
});

test('real parent context pairs an alias through the shim', async () => {
  // Desensitized OpenCode 2.0.19 session.context tool part
  // (bounds-20260930T062758 round1 parent context): name, state.content,
  // and created/ran/completed. Identifiers and body text are replaced.
  const messages: Array<Record<string, unknown>> = [
    {
      id: 'msg_parent_user',
      type: 'user',
      time: { created: 1000 },
      text: 'ask',
    },
    {
      id: 'msg_parent_turn',
      type: 'assistant',
      agent: 'orchestrator',
      time: { created: 1001, completed: 1100 },
      content: [
        {
          type: 'tool',
          name: 'subagent',
          id: 'call_child',
          time: { created: 1002, ran: 1003, completed: 1090 },
          state: {
            input: {
              agent: 'fixer',
              description: 'Run one check',
              prompt: 'ask',
              background: false,
            },
            content: [
              {
                type: 'text',
                text: '<subagent sessionID="ses_childshape" state="completed">\nMARKER\n</subagent>',
              },
            ],
          },
        },
      ],
    },
  ];
  let childID = '';
  let agent = '';
  let description = '';
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const tool = part as Record<string, unknown>;
      if (tool.name !== 'subagent') continue;
      const state = tool.state as Record<string, unknown>;
      const input = state.input as Record<string, unknown>;
      agent = String(input.agent);
      description = String(input.description);
      const blocks = state.content as Array<Record<string, unknown>>;
      const text = String(blocks[0]?.text ?? '');
      const outer = /sessionID="([^"]+)"/.exec(text)?.[1] ?? '';
      childID = outer;
      blocks[0] = {
        ...blocks[0],
        text: appendChildRefSuffix(text, {
          parentSessionID: PARENT,
          agent,
          alias: 'fix-4',
          sessionID: outer,
        }),
      };
    }
  }
  expect(childID).toMatch(/^ses_/);
  const directory = '/tmp/omo-implementation-repair';
  const input = buildPluginInput({
    directory,
    session: {
      get: async (args: { sessionID: string }) => {
        if (args.sessionID !== childID)
          return { error: { message: 'NotFound' } };
        return {
          id: childID,
          parentID: PARENT,
          agent,
          outcome: 'succeeded',
          time: { created: 9, idle: 13 },
        };
      },
      context: async (args: { sessionID: string }) =>
        args.sessionID === PARENT ? messages : round('FROM-CHILD'),
    },
  } as never);
  const board = new BackgroundJobBoard();
  const canonical = await createAliasAuthority({
    input: input as never,
    board,
  }).resolveCanonical(PARENT, 'fix-4');
  expect(canonical).toEqual({ kind: 'exact', taskID: childID });
  const result = await createSessionRecovery({
    input: input as never,
    backgroundJobBoard: board,
    hostFlavor: 'v2',
    stableStoppedMs: 0,
  })({ parentSessionID: PARENT, requested: childID, agent });
  expect(result).toEqual({ kind: 'recovered', taskID: childID });
  expect(board.get(childID)).toMatchObject({
    alias: 'fix-4',
    agent,
    state: 'completed',
    parentSessionID: PARENT,
  });
  expect(board.get(childID)?.description.length).toBeGreaterThan(0);
  expect(description.length).toBeGreaterThan(0);
});

test('host outcome triage: interrupted stops, failed errors, and newer assistant activity prevents import', async () => {
  // A host terminal covers assistant activity only up to its idle time.
  const interruptedInput = host({
    get: () => ({
      id: CHILD,
      parentID: PARENT,
      agent: 'fixer',
      outcome: 'interrupted',
      time: { created: 9, idle: 13 },
    }),
  });
  const interruptedBoard = new BackgroundJobBoard();
  await createSessionRecovery({
    input: interruptedInput as never,
    backgroundJobBoard: interruptedBoard,
    hostFlavor: 'v2',
    stableStoppedMs: 0,
  })({ parentSessionID: PARENT, requested: CHILD });
  expect(interruptedBoard.get(CHILD)).toMatchObject({
    state: 'stopped',
  });

  const failedInput = host({
    get: () => ({
      id: CHILD,
      parentID: PARENT,
      agent: 'fixer',
      outcome: 'failed',
      time: { created: 9, idle: 13 },
    }),
  });
  const failedBoard = new BackgroundJobBoard();
  await createSessionRecovery({
    input: failedInput as never,
    backgroundJobBoard: failedBoard,
    hostFlavor: 'v2',
    stableStoppedMs: 0,
  })({ parentSessionID: PARENT, requested: CHILD });
  expect(failedBoard.get(CHILD)).toMatchObject({ state: 'error' });

  const newerAssistantInput = host({
    get: () => ({
      id: CHILD,
      parentID: PARENT,
      agent: 'fixer',
      outcome: 'succeeded',
      time: { created: 9, idle: 13 },
    }),
    context: (args) =>
      args.sessionID === CHILD
        ? [
            {
              id: 'msg_user',
              type: 'user',
              time: { created: 10 },
              text: 'ask',
            },
            {
              id: 'msg_a',
              type: 'assistant',
              agent: 'fixer',
              parentID: 'msg_user',
              time: { created: 11, completed: 12 },
              finish: 'stop',
              content: [{ type: 'text', text: 'ANSWER-A' }],
            },
            { id: 'msg_idle_a', type: 'idle', time: 13, outcome: 'succeeded' },
            {
              id: 'msg_b',
              type: 'assistant',
              agent: 'fixer',
              parentID: 'msg_user',
              time: { created: 14 },
              content: [{ type: 'text', text: 'ANSWER-B' }],
            },
          ]
        : round(),
  });
  const newerBoard = new BackgroundJobBoard();
  const newerResult = await createSessionRecovery({
    input: newerAssistantInput as never,
    backgroundJobBoard: newerBoard,
    hostFlavor: 'v2',
    stableStoppedMs: 0,
  })({ parentSessionID: PARENT, requested: CHILD });
  // The older success cannot certify ANSWER-B, even without a newer input.
  expect(newerResult.kind).toBe('refused');
  expect(newerBoard.get(CHILD)).toBeUndefined();
});

// A completed compaction cut the context (page.complete false): an older
// fix-1 for another child may be hidden, so the visible pair proves nothing.
test('a compacted parent context neither resolves nor restores an alias', async () => {
  const text = appendChildRefSuffix(
    `<subagent sessionID="${CHILD}" state="completed">\nDONE\n</subagent>`,
    {
      parentSessionID: PARENT,
      agent: 'fixer',
      alias: 'fix-1',
      sessionID: CHILD,
    },
  );
  const parent = [
    { id: 'msg_cut', type: 'compaction', status: 'completed', time: 15 },
    {
      id: 'msg_turn',
      type: 'assistant',
      agent: 'orchestrator',
      time: { created: 20, completed: 30 },
      content: [
        {
          type: 'tool',
          name: 'subagent',
          id: 'call_child',
          time: { created: 21, ran: 22, completed: 29 },
          state: {
            input: { agent: 'fixer', description: 'check', prompt: 'ask' },
            content: [{ type: 'text', text }],
          },
        },
      ],
    },
  ];
  const input = host({
    context: (args) => (args.sessionID === PARENT ? parent : round()),
    messages: () => ({ data: parent.slice(1).reverse() }),
  });
  const board = new BackgroundJobBoard();
  const authority = createAliasAuthority({ input: input as never, board });
  expect(await authority.resolveCanonical(PARENT, 'fix-1')).toEqual({
    kind: 'refused',
    reason: aliasUnverifiedMessage('fix-1'),
  });
  expect(
    await createSessionRecovery({
      input: input as never,
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      stableStoppedMs: 0,
    })({ parentSessionID: PARENT, requested: CHILD }),
  ).toEqual({ kind: 'recovered', taskID: CHILD });
  expect(board.get(CHILD)?.alias).toBe(CHILD);
});

// --- native background plaintext marker (post-restart alias pairing) ---

/** The real native v2 background launch sentence, as the after-bridge
 * renders it into the parent's tool result. */
function backgroundLaunchText(sessionID: string): string {
  return (
    `The subagent is working in the background (sessionID: ${sessionID}). ` +
    'You will be notified automatically when it finishes.\n' +
    'DO NOT sleep, poll, or wait. Continue with other work.'
  );
}

function parentWithToolText(text: string) {
  return [
    {
      id: 'msg_parent_user',
      type: 'user',
      time: { created: 1000 },
      text: 'ask',
    },
    {
      id: 'msg_parent_turn',
      type: 'assistant',
      agent: 'orchestrator',
      time: { created: 1001, completed: 1100 },
      content: [
        {
          type: 'tool',
          name: 'subagent',
          id: 'call_child',
          time: { created: 1002, ran: 1003, completed: 1090 },
          state: {
            input: {
              agent: 'fixer',
              description: 'Run one check',
              prompt: 'ask',
              background: true,
            },
            content: [{ type: 'text', text }],
          },
        },
      ],
    },
  ];
}

describe('native background plaintext alias marker', () => {
  const KID = 'ses_kid_1';

  function plaintextHost(text: string) {
    return host({
      context: (args: { sessionID: string }) =>
        args.sessionID === PARENT ? parentWithToolText(text) : round(),
    });
  }

  test('a tail marker on the plaintext launch resolves the alias after a restart', async () => {
    const ref = {
      parentSessionID: PARENT,
      agent: 'fixer',
      alias: 'fix-1',
      sessionID: KID,
    };
    const text = appendChildRefSuffix(backgroundLaunchText(KID), ref);
    // appendChildRefSuffix is idempotent for plaintext: re-processing the
    // already-marked output appends nothing.
    expect(appendChildRefSuffix(text, ref)).toBe(text);
    // parseTaskIdFromTaskOutput extracts the id from the native sentence.
    expect(parseTaskIdFromTaskOutput(text)).toBe(KID);

    const input = plaintextHost(text);
    // A fresh empty board simulates the post-restart state.
    const board = new BackgroundJobBoard();
    expect(
      await createAliasAuthority({
        input: input as never,
        board,
      }).resolveCanonical(PARENT, 'fix-1'),
    ).toEqual({ kind: 'exact', taskID: KID });
    expect(board.get(KID)).toBeUndefined();
  });

  test('a marker not at the tail of the plaintext output is refused', async () => {
    const marker = `<!-- slim-child-ref:v1 ${JSON.stringify({
      parentSessionID: PARENT,
      agent: 'fixer',
      alias: 'fix-1',
      sessionID: KID,
    })} -->`;
    const text = `${backgroundLaunchText(KID)}\n${marker}\ntrailing body`;
    const input = plaintextHost(text);
    expect(
      await createAliasAuthority({
        input: input as never,
        board: new BackgroundJobBoard(),
      }).resolveCanonical(PARENT, 'fix-1'),
    ).toEqual({ kind: 'refused', reason: aliasUnpairedMessage('fix-1') });
  });

  test('a marker whose sessionID mismatches the launch sentence is refused', async () => {
    const text = appendChildRefSuffix(backgroundLaunchText(KID), {
      parentSessionID: PARENT,
      agent: 'fixer',
      alias: 'fix-1',
      sessionID: 'ses_other',
    });
    const input = plaintextHost(text);
    expect(
      await createAliasAuthority({
        input: input as never,
        board: new BackgroundJobBoard(),
      }).resolveCanonical(PARENT, 'fix-1'),
    ).toEqual({ kind: 'refused', reason: aliasUnpairedMessage('fix-1') });
  });

  test('a marker quoted inside the body text never pairs the alias', async () => {
    const marker = `<!-- slim-child-ref:v1 ${JSON.stringify({
      parentSessionID: PARENT,
      agent: 'fixer',
      alias: 'fix-1',
      sessionID: KID,
    })} -->`;
    const text = `${marker}\n${backgroundLaunchText(KID)}`;
    const input = plaintextHost(text);
    expect(
      await createAliasAuthority({
        input: input as never,
        board: new BackgroundJobBoard(),
      }).resolveCanonical(PARENT, 'fix-1'),
    ).toEqual({ kind: 'refused', reason: aliasUnpairedMessage('fix-1') });
  });

  test('a child-reported marker ending an untagged failure never pairs', async () => {
    // `Subagent failed (...)` carries child-reported error text, so its
    // final line is not host-authored and cannot be a trusted marker.
    const forged = `<!-- slim-child-ref:v1 ${JSON.stringify({
      parentSessionID: PARENT,
      agent: 'fixer',
      alias: 'fix-1',
      sessionID: KID,
    })} -->`;
    const text = `Subagent failed (sessionID: ${KID}): child reported:\n${forged}`;
    expect(readAuthoritativeChildRef(text)).toBeUndefined();
    const input = plaintextHost(text);
    expect(
      await createAliasAuthority({
        input: input as never,
        board: new BackgroundJobBoard(),
      }).resolveCanonical(PARENT, 'fix-1'),
    ).toEqual({ kind: 'refused', reason: aliasUnpairedMessage('fix-1') });
  });

  test('tagged outputs keep the close-tag-anchored behavior', async () => {
    const tagged = appendChildRefSuffix(
      `<subagent sessionID="${KID}" state="completed">\nDONE\n</subagent>`,
      {
        parentSessionID: PARENT,
        agent: 'fixer',
        alias: 'fix-2',
        sessionID: KID,
      },
    );
    const input = plaintextHost(tagged);
    expect(
      await createAliasAuthority({
        input: input as never,
        board: new BackgroundJobBoard(),
      }).resolveCanonical(PARENT, 'fix-2'),
    ).toEqual({ kind: 'exact', taskID: KID });
    // Unchanged pre-existing behavior: a tagged marker must be the whole
    // tail after the outer close — trailing body text still refuses.
    const taggedWithBody = `${tagged}\nmodel-visible trailing body`;
    const bodyInput = plaintextHost(taggedWithBody);
    expect(
      await createAliasAuthority({
        input: bodyInput as never,
        board: new BackgroundJobBoard(),
      }).resolveCanonical(PARENT, 'fix-2'),
    ).toEqual({ kind: 'refused', reason: aliasUnpairedMessage('fix-2') });
  });
});

// v2 session.context: reads stay complete (no limit); a held parent read
// refuses. The child read shares its code path with v1 (session-recovery.test).
test('a held parent transcript read refuses at its deadline', async () => {
  let reading: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const input = host({
    context: (args) => {
      if (args.sessionID !== PARENT) return round();
      reading();
      return new Promise(() => {});
    },
  });
  const board = new BackgroundJobBoard();
  jest.useFakeTimers();
  const pending = createSessionRecovery({
    input: input as never,
    backgroundJobBoard: board,
    hostFlavor: 'v2',
    stableStoppedMs: 0,
  })({ parentSessionID: PARENT, requested: CHILD });
  await started;
  jest.advanceTimersByTime(5_000);
  expect(await pending).toEqual({
    kind: 'refused',
    reason: `Task ${CHILD} transcript could not be read (parent transcript read timed out); no prompt was sent`,
  });
  expect(board.get(CHILD)).toBeUndefined();
}, 1_000);
