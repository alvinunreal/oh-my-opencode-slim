import { afterEach, describe, expect, jest, test } from 'bun:test';
import {
  FixtureBoard as BackgroundJobBoard,
  createBackgroundJobLifecycle,
  type FixtureBoardInstance,
} from '../background-jobs';
import { createPendingCallTracker } from '../hooks/task-session-manager/pending-call-tracker';
import {
  aliasUnpairedMessage,
  aliasUnverifiedMessage,
  appendChildRefSuffix,
  createAliasAuthority,
  createSessionRecovery,
  readAuthoritativeChildRef,
} from '../hooks/task-session-manager/session-recovery';
import { handleToolExecuteBefore } from '../hooks/task-session-manager/tool-execute-hooks';
import { classifyV2HistoricalRound } from '../utils/child-transcript';
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
      time: { created: 9 },
    }));
  return buildPluginInput({
    directory: '/tmp/omo-implementation-repair',
    session: {
      get: async () => get(),
      context: async (args: { sessionID: string }) => context(args),
      messages: options?.messages,
    },
  } as never);
}

function deps(board: FixtureBoardInstance, input: ReturnType<typeof host>) {
  return {
    shouldManageSession: () => true,
    backgroundJobs: createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    }),
    pendingCallTracker: createPendingCallTracker(),
    taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
    hostFlavor: 'v2',
    recoverRetainedSession: createSessionRecovery({
      input: input as never,
      backgroundJobs: createBackgroundJobLifecycle({
        backgroundJobBoard: board,
      }),
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

  test('a newer synthetic blocks an older succeeded outcome', () => {
    const round = classifyV2HistoricalRound({
      data: [
        {
          info: {
            id: 'msg_user',
            role: 'user',
            sourceType: 'user',
            time: { created: 10 },
          },
          parts: [{ type: 'text', text: 'ask' }],
        },
        {
          info: {
            id: 'msg_assistant',
            role: 'assistant',
            sourceType: 'assistant',
            parentID: 'msg_user',
            time: { created: 11, completed: 12 },
          },
          parts: [{ type: 'text', text: 'OLD' }],
        },
        {
          info: {
            id: 'msg_idle',
            role: 'system',
            sourceType: 'idle',
            outcome: 'succeeded',
            time: { created: 13 },
          },
          parts: [],
        },
        {
          info: {
            id: 'msg_synthetic',
            role: 'synthetic',
            sourceType: 'synthetic',
            time: { created: 14 },
          },
          parts: [{ type: 'text', text: 'new boundary' }],
        },
      ],
    });
    expect(round.verdict).toBe('incomplete');
    expect(JSON.stringify(round)).not.toContain('OLD');
  });
});

describe('v2 native resume through the setup bridge', () => {
  test('an unacknowledged completed session continues without task_result or an early ack', async () => {
    const board = new BackgroundJobBoard();
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
    expect(board.get(CHILD)).toMatchObject({
      state: 'completed',
      resultSummary: 'OLD',
      terminalUnreconciled: true,
      generation: before?.generation,
      terminalRevision: before?.terminalRevision,
    });
  });

  test('an unknown completed child is imported and then resumed, and failures do not create a child', async () => {
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
      state: 'completed',
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
    await expect(
      createToolExecuteBridges(
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
      ).beforeBridge({
        tool: 'subagent',
        sessionID: PARENT,
        id: 'call_5',
        input: {
          agent: 'fixer',
          sessionID: CHILD,
          prompt: 'next',
          description: 'next',
        },
      }),
    ).rejects.toThrow(/different parent/);
    expect(wrong.get(CHILD)).toBeUndefined();
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
          time: { created: 9 },
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
    backgroundJobs: createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    }),
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

test('interrupted and failed idles do not require an assistant, and a later assistant is not closed by an older idle', () => {
  const interrupted = classifyV2HistoricalRound({
    data: [
      {
        info: {
          id: 'msg_user',
          role: 'user',
          sourceType: 'user',
          time: { created: 10 },
        },
        parts: [{ type: 'text', text: 'ask' }],
      },
      {
        info: {
          id: 'msg_idle',
          role: 'system',
          sourceType: 'idle',
          outcome: 'interrupted',
          time: { created: 11 },
        },
        parts: [],
      },
    ],
  });
  expect(interrupted.verdict).toBe('interrupted');

  const failed = classifyV2HistoricalRound({
    data: [
      {
        info: {
          id: 'msg_user',
          role: 'user',
          sourceType: 'user',
          time: { created: 10 },
        },
        parts: [{ type: 'text', text: 'ask' }],
      },
      {
        info: {
          id: 'msg_idle',
          role: 'system',
          sourceType: 'idle',
          outcome: 'failed',
          time: { created: 11 },
        },
        parts: [],
      },
    ],
  });
  expect(failed.verdict).toBe('error');
  expect(failed.text).not.toContain('ask');

  const succeededWithoutAssistant = classifyV2HistoricalRound({
    data: [
      {
        info: {
          id: 'msg_user',
          role: 'user',
          sourceType: 'user',
          time: { created: 10 },
        },
        parts: [{ type: 'text', text: 'ask' }],
      },
      {
        info: {
          id: 'msg_idle',
          role: 'system',
          sourceType: 'idle',
          outcome: 'succeeded',
          time: { created: 11 },
        },
        parts: [],
      },
    ],
  });
  expect(succeededWithoutAssistant.verdict).toBe('incomplete');

  const mismatch = classifyV2HistoricalRound({
    data: [
      {
        info: {
          id: 'msg_user',
          role: 'user',
          sourceType: 'user',
          time: { created: 10 },
        },
        parts: [{ type: 'text', text: 'ask' }],
      },
      {
        info: {
          id: 'msg_a',
          role: 'assistant',
          sourceType: 'assistant',
          parentID: 'msg_user',
          time: { created: 11, completed: 12 },
        },
        parts: [{ type: 'text', text: 'ANSWER-A' }],
      },
      {
        info: {
          id: 'msg_idle_a',
          role: 'system',
          sourceType: 'idle',
          outcome: 'succeeded',
          time: { created: 13 },
        },
        parts: [],
      },
      {
        info: {
          id: 'msg_b',
          role: 'assistant',
          sourceType: 'assistant',
          parentID: 'msg_user',
          time: { created: 14 },
        },
        parts: [{ type: 'text', text: 'ANSWER-B' }],
      },
    ],
  });
  expect(mismatch.verdict).toBe('incomplete');
  expect(JSON.stringify(mismatch)).not.toContain('ANSWER-B');
  expect(JSON.stringify(mismatch)).not.toContain('ANSWER-A');
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
      backgroundJobs: createBackgroundJobLifecycle({
        backgroundJobBoard: board,
      }),
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
    backgroundJobs: createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    }),
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
