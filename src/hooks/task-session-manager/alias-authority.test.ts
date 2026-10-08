import { afterEach, describe, expect, jest, mock, spyOn, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BackgroundJobBoard,
  createBackgroundJobLifecycle,
} from '../../background-jobs';
import { OhMyOpenCodeLite } from '../../index';
import { createCancelTaskTool } from '../../tools/cancel-task';
import { createTaskMessageTool } from '../../tools/task-message';
import { createTaskReplyTool } from '../../tools/task-reply';
import { createTaskResultTool } from '../../tools/task-result';
import { createTaskReviveTool } from '../../tools/task-revive';
import { createTaskStatusTool } from '../../tools/task-status';
import * as opencodeClient from '../../utils/opencode-client';
import { mapV2EventToV1 } from '../../v2/event-adapter';
import {
  aliasUnverifiedMessage,
  appendChildRefSuffix,
  createAliasAuthority,
  createSessionRecovery,
  noteExactSessionAlias,
  pluginDisposedMessage,
  readAuthoritativeChildRef,
} from './session-recovery';
import { handleToolExecuteBefore } from './tool-execute-hooks';

const PARENT = 'ses_parent';
const OTHER = 'ses_otherparent';
const HOST = 'ses_hostchild';
const CACHE = 'ses_cachechild';
const context = { sessionID: PARENT, agent: 'orchestrator' };

afterEach(() => {
  mock.restore();
  jest.useRealTimers();
});

function closed(sessionID: string, body = 'ok'): string {
  return `<task id="${sessionID}" state="completed">\n<task_result>\n${body}\n</task_result>\n</task>`;
}

function withRef(
  sessionID: string,
  alias: string,
  agent = 'fixer',
  parent = PARENT,
): string {
  return appendChildRefSuffix(closed(sessionID), {
    parentSessionID: parent,
    agent,
    alias,
    sessionID,
  });
}

function taskPart(input: {
  output: string;
  agent?: string;
  tool?: string;
  callID?: string;
  status?: string;
}) {
  return {
    info: {
      id: `msg_${input.callID ?? 'done'}`,
      role: 'assistant',
      time: { created: 10, completed: 20 },
    },
    parts: [
      {
        type: 'tool',
        tool: input.tool ?? 'task',
        callID: input.callID ?? 'call_done',
        state: {
          status: input.status ?? 'completed',
          input: {
            subagent_type: input.agent ?? 'fixer',
            description: 'check',
            prompt: 'ask',
          },
          output: input.output,
          time: { start: 11, end: 19 },
        },
      },
    ],
  };
}

function clientFor(
  pages: unknown[] | ((id: string) => unknown | Promise<unknown>),
  extras?: Record<string, unknown>,
) {
  const messages = mock(async (args: { path?: { id?: string } }) => {
    if (typeof pages === 'function') return pages(args.path?.id ?? '');
    return { data: pages };
  });
  const prompt = mock(async () => ({}));
  const promptAsync = mock(async () => ({}));
  const abort = mock(async () => ({}));
  const reply = mock(async () => ({}));
  const input = {
    directory: '/tmp/omo-alias-authority',
    client: {
      session: {
        messages,
        prompt,
        promptAsync,
        abort,
        status: async () => ({ data: {} }),
        get: async () => ({
          data: { id: HOST, parentID: PARENT, agent: 'fixer' },
        }),
        ...extras,
      },
      permission: { reply },
    },
  };
  spyOn(opencodeClient, 'getClient').mockImplementation(
    (value) => (value as { client: unknown }).client as never,
  );
  return { input, messages, prompt, promptAsync, abort, reply };
}

function deferredBoard() {
  return new BackgroundJobBoard({ deferNumberedAliases: true });
}

describe('alias numbering', () => {
  test('an existing parent keeps the task id, including early register paths', () => {
    const board = deferredBoard();
    expect(board.isNumberedAliasReady(PARENT)).toBe(false);
    const early = board.registerLaunch({
      taskID: 'ses_early',
      parentSessionID: PARENT,
      agent: 'fixer',
    });
    const placeholder = board.registerLaunch({
      taskID: 'ses_placeholder',
      parentSessionID: PARENT,
      agent: 'oracle',
      provisional: true,
    });
    const adopted = board.registerLaunch({
      taskID: 'ses_adopted',
      parentSessionID: PARENT,
      agent: 'explorer',
    });
    expect(early.alias).toBe('ses_early');
    expect(placeholder.alias).toBe('ses_placeholder');
    expect(adopted.alias).toBe('ses_adopted');
    expect(
      board.registerLaunch({
        taskID: 'ses_other',
        parentSessionID: OTHER,
        agent: 'fixer',
      }).alias,
    ).toBe('ses_other');
  });

  type PluginHooks = Awaited<ReturnType<typeof OhMyOpenCodeLite>>;

  /** One background fixer launch through the production hooks; returns its
   * model-visible alias. */
  async function launchAlias(
    hooks: PluginHooks,
    parent: string,
    child: string,
  ) {
    const call = { tool: 'task', sessionID: parent, callID: `call_${child}` };
    await hooks['tool.execute.before']?.(call, {
      args: { subagent_type: 'fixer', description: child, background: true },
    });
    const output = { output: `task_id: ${child}\nstate: running` };
    await hooks['tool.execute.after']?.(call, output as never);
    return /"alias":"([^"]+)"/.exec(output.output)?.[1];
  }

  /** Launches background fixers through the production plugin hooks and
   * returns each launch's model-visible alias. `events` are built after the
   * plugin starts. */
  async function pluginAliases(
    launches: [parent: string, child: string][],
    options: {
      messages?: (args: { path?: { id?: string } }) => unknown;
      events?: () => unknown[];
      hostFlavor?: 'v2';
      after?: (hooks: PluginHooks) => unknown;
    } = {},
  ): Promise<(string | undefined)[]> {
    const projectDir = await mkdtemp(join(tmpdir(), 'omo-alias-numbering-'));
    // Another file's mock.module of opencode-client outlives mock.restore().
    spyOn(opencodeClient, 'getClient').mockImplementation(
      (value) => (value as { client: unknown }).client as never,
    );
    const hooks = await OhMyOpenCodeLite({
      client: {
        app: { log: async () => ({}) },
        session: {
          status: async () => ({ data: {} }),
          get: async () => ({ data: {} }),
          messages: options.messages ?? (async () => ({ data: [] })),
        },
      },
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
      hostFlavor: options.hostFlavor,
    } as never);
    try {
      for (const event of options.events?.() ?? []) {
        await hooks.event?.({ event } as never);
      }
      for (const sessionID of new Set(launches.map(([parent]) => parent))) {
        await hooks['chat.message']?.(
          { sessionID, agent: 'orchestrator' } as never,
          {} as never,
        );
      }
      const aliases: (string | undefined)[] = [];
      for (const [parent, child] of launches) {
        aliases.push(await launchAlias(hooks, parent, child));
      }
      await options.after?.(hooks);
      return aliases;
    } finally {
      await hooks.dispose?.();
    }
  }

  // G2 after a restart: history pairs fix-1 with a live child this board does
  // not know, so the existing parent's new child keeps its ID. The harness
  // session.get stub carries no parentID, so the untracked fallback cannot
  // verify ownership and keeps the unknown error.
  test('a new child of an existing parent gets no number', async () => {
    const live = 'ses_livesibling';
    const history = [taskPart({ output: withRef(live, 'fix-1') })];
    const aliases = await pluginAliases([[PARENT, 'ses_newchild']], {
      messages: async (args) => ({
        data: args.path?.id === PARENT ? history : [],
      }),
      after: (hooks) =>
        expect(
          hooks.tool?.task_status?.execute({ task_id: 'fix-1' }, {
            sessionID: PARENT,
            agent: 'orchestrator',
          } as never),
        ).rejects.toThrow(`Unknown task ID or alias: ${live}`),
    });
    expect(aliases).toEqual(['ses_newchild']);
  });

  test('a parent created while the plugin runs numbers from 1; an older creation does not', async () => {
    const created = (id: string, at: number) => ({
      type: 'session.created',
      properties: { info: { id, time: { created: at } } },
    });
    expect(
      await pluginAliases(
        [
          [PARENT, 'ses_freshchild'],
          [OTHER, 'ses_replayedchild'],
          [PARENT, 'ses_freshchild2'],
        ],
        { events: () => [created(PARENT, Date.now()), created(OTHER, 0)] },
      ),
    ).toEqual(['fix-1', 'ses_replayedchild', 'fix-2']);
  });

  // Export/import restores a deleted session under the same ID without a
  // session.created; its history holds numbers this board never issued.
  test('a deleted parent stops numbering, so its restored copy keeps task IDs', async () => {
    const imported = 'ses_importedchild';
    const history = [taskPart({ output: withRef(imported, 'fix-2') })];
    const ctx = { sessionID: PARENT, agent: 'orchestrator' } as never;
    let restored: string | undefined;
    const aliases = await pluginAliases([[PARENT, 'ses_firstchild']], {
      messages: async (args) => ({
        data: args.path?.id === PARENT ? history : [],
      }),
      events: () => [
        {
          type: 'session.created',
          properties: { info: { id: PARENT, time: { created: Date.now() } } },
        },
      ],
      after: async (hooks) => {
        const deleted = { info: { id: PARENT } };
        await hooks.event?.({
          event: { type: 'session.deleted', properties: deleted },
        } as never);
        await hooks['chat.message']?.(ctx, {} as never);
        restored = await launchAlias(hooks, PARENT, 'ses_restoredchild');
        // The harness session.get stub carries no parentID, so the
        // untracked fallback keeps the unknown error.
        await expect(
          hooks.tool?.task_status?.execute({ task_id: 'fix-2' }, ctx),
        ).rejects.toThrow(`Unknown task ID or alias: ${imported}`);
      },
    });
    expect([...aliases, restored]).toEqual(['fix-1', 'ses_restoredchild']);
  });

  // The v2 pump hands the hook every mapped event, the raw envelope first:
  // {id, created, type, durable, data: {sessionID}}, stamped by the host.
  test('v2 takes the creation time from the envelope; a replayed or undated parent keeps IDs', async () => {
    const created = (sessionID: string, at?: number) =>
      mapV2EventToV1({
        id: `evt_${sessionID}`,
        created: at,
        type: 'session.created',
        durable: true,
        data: { sessionID },
      });
    const undated = 'ses_undatedparent';
    expect(
      await pluginAliases(
        [
          [PARENT, 'ses_freshchild'],
          [OTHER, 'ses_replayedchild'],
          [undated, 'ses_undatedchild'],
        ],
        {
          hostFlavor: 'v2',
          events: () => [
            ...created(PARENT, Date.now()),
            ...created(OTHER, 0),
            ...created(undated),
          ],
        },
      ),
    ).toEqual(['fix-1', 'ses_replayedchild', 'ses_undatedchild']);
  });
});

describe('canonical alias reference', () => {
  test('an exact session id does not read parent history', async () => {
    const { input, messages } = clientFor([
      taskPart({ output: withRef(HOST, 'fix-1') }),
    ]);
    const authority = createAliasAuthority({
      input: input as never,
      board: deferredBoard(),
    });
    expect(await authority.resolveCanonical(PARENT, HOST)).toEqual({
      kind: 'exact',
      taskID: HOST,
    });
    expect(messages).not.toHaveBeenCalled();
  });

  test('two saved targets refuse without writing', async () => {
    const other = 'ses_secondhost';
    const { input } = clientFor([
      taskPart({ output: withRef(HOST, 'fix-1'), callID: 'call_a' }),
      taskPart({
        output: withRef(other, 'fix-1'),
        callID: 'call_b',
      }),
    ]);
    const board = deferredBoard();
    board.registerLaunch({
      taskID: CACHE,
      parentSessionID: PARENT,
      agent: 'fixer',
      description: 'SECRET-B',
    });
    const many = await createAliasAuthority({
      input: input as never,
      board,
    }).resolveCanonical(PARENT, 'fix-1');
    expect(many.kind).toBe('refused');
    if (many.kind === 'refused') {
      expect(many.reason).toContain(HOST);
      expect(many.reason).toContain(other);
      expect(many.reason).toContain('multiple saved targets');
      expect(many.reason).toContain('No action was sent');
    }
    expect(board.get(HOST)).toBeUndefined();
    expect(board.get(CACHE)?.description).toBe('SECRET-B');
  });

  test('a board alias resolves without reading host history', async () => {
    const { input, messages } = clientFor(() => {
      throw new Error('history is not read');
    });
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: CACHE,
      parentSessionID: PARENT,
      agent: 'fixer',
    });
    const authority = createAliasAuthority({ input: input as never, board });
    expect(await authority.resolveCanonical(PARENT, 'fix-1')).toEqual({
      kind: 'exact',
      taskID: CACHE,
    });
    expect(
      await createAliasAuthority({
        input: input as never,
        board,
        isDisposed: () => true,
      }).resolveCanonical(PARENT, 'fix-9'),
    ).toEqual({ kind: 'refused', reason: pluginDisposedMessage() });
    expect(messages).not.toHaveBeenCalled();
    expect(await authority.resolveCanonical(PARENT, 'fix-9')).toEqual({
      kind: 'refused',
      reason: aliasUnverifiedMessage('fix-9'),
    });
  });

  test('an overflowing v1 parent window neither resolves nor restores an alias', async () => {
    const { input, messages } = clientFor((id) => ({
      data:
        id === PARENT
          ? [
              ...Array(1_000).fill({}),
              taskPart({ output: withRef(HOST, 'fix-1') }),
            ]
          : [
              { info: { role: 'user' }, parts: [] },
              {
                info: {
                  role: 'assistant',
                  finish: 'stop',
                  time: { completed: 3 },
                },
                parts: [{ type: 'text', text: 'done' }],
              },
            ],
    }));
    const board = new BackgroundJobBoard();
    const canonical = await createAliasAuthority({
      input: input as never,
      board,
    }).resolveCanonical(PARENT, 'fix-1');
    expect(
      await createSessionRecovery({
        input: input as never,
        backgroundJobs: createBackgroundJobLifecycle({
          backgroundJobBoard: board,
        }),
        stableStoppedMs: 0,
      })({ parentSessionID: PARENT, requested: HOST }),
    ).toEqual({ kind: 'recovered', taskID: HOST });
    expect({ canonical, alias: board.get(HOST)?.alias }).toEqual({
      canonical: { kind: 'refused', reason: aliasUnverifiedMessage('fix-1') },
      alias: HOST,
    });
    expect(messages.mock.calls).toMatchObject([
      [{ query: { limit: 1_001 } }],
      [{ query: { limit: undefined } }],
      [{ query: { limit: 1_001 } }],
    ]);
  });

  test('a held pairing read refuses as unverified at its deadline', async () => {
    const { input } = clientFor(() => new Promise(() => {}));
    jest.useFakeTimers();
    const pending = createAliasAuthority({
      input: input as never,
      board: deferredBoard(),
    }).resolveCanonical(PARENT, 'fix-9');
    jest.advanceTimersByTime(1_500);
    expect(await pending).toEqual({
      kind: 'refused',
      reason: aliasUnverifiedMessage('fix-9'),
    });
  }, 1_000);

  test('a failed task part does not hide the unique marked pairing', async () => {
    const { input } = clientFor([
      taskPart({ output: withRef(HOST, 'fix-1'), callID: 'call_a' }),
      taskPart({ output: '', status: 'error', callID: 'call_failed' }),
    ]);
    expect(
      await createAliasAuthority({
        input: input as never,
        board: deferredBoard(),
      }).resolveCanonical(PARENT, 'fix-1'),
    ).toEqual({ kind: 'exact', taskID: HOST });
  });

  test('exact recovery does not republish an alias that also belongs to another session', async () => {
    const { input } = clientFor((id) => {
      if (id === PARENT) {
        return {
          data: [
            taskPart({ output: withRef(HOST, 'fix-1'), callID: 'call_a' }),
            taskPart({
              output: withRef(CACHE, 'fix-1'),
              callID: 'call_b',
            }),
          ],
        };
      }
      return {
        data: [
          {
            info: {
              id: 'msg_user',
              role: 'user',
              agent: 'fixer',
              time: { created: 1 },
            },
            parts: [{ type: 'text', text: 'ask' }],
          },
          {
            info: {
              id: 'msg_turn',
              role: 'assistant',
              finish: 'stop',
              time: { created: 2, completed: 3 },
            },
            parts: [{ type: 'text', text: 'done' }],
          },
        ],
      };
    });
    const board = new BackgroundJobBoard();
    const result = await createSessionRecovery({
      input: input as never,
      backgroundJobs: createBackgroundJobLifecycle({
        backgroundJobBoard: board,
      }),
      stableStoppedMs: 0,
      stopConfirmationBudgetMs: 0,
    })({ parentSessionID: PARENT, requested: HOST });
    expect(result).toEqual({ kind: 'recovered', taskID: HOST });
    expect(board.get(HOST)?.alias).toBe(HOST);
  });

  test('control and read tools refuse an ambiguous alias before any action', async () => {
    const { input, prompt, promptAsync, abort, reply } = clientFor([
      taskPart({ output: withRef(HOST, 'fix-1'), callID: 'call_a' }),
      taskPart({ output: withRef(CACHE, 'fix-1'), callID: 'call_b' }),
    ]);
    const board = deferredBoard();
    const cached = board.registerLaunch({
      taskID: CACHE,
      parentSessionID: PARENT,
      agent: 'fixer',
      description: 'SECRET-B',
    });
    board.updateStatus({
      taskID: CACHE,
      state: 'completed',
      resultSummary: 'SECRET-B',
    });
    const resolveCanonicalTaskRef = createAliasAuthority({
      input: input as never,
      board,
    }).resolveCanonical;
    const shared = {
      input: input as never,
      backgroundJobs: createBackgroundJobLifecycle({
        backgroundJobBoard: board,
      }),
      resolveCanonicalTaskRef,
      shouldManageSession: () => true,
    };
    const tools = {
      ...createCancelTaskTool(shared),
      ...createTaskMessageTool(shared),
      ...createTaskReplyTool(shared),
      ...createTaskResultTool(shared),
      ...createTaskReviveTool({
        ...shared,
        revivedRunTracker: { captureBaseline: async () => 'baseline' } as never,
      }),
      ...createTaskStatusTool(shared),
    };
    const cancel = await tools.task_cancel.execute(
      { task_id: 'fix-1' },
      context as never,
    );
    expect(String(cancel)).toContain('No action was sent');
    expect(String(cancel)).not.toContain('SECRET-B');
    await expect(
      tools.task_message.execute(
        { task_id: 'fix-1', message: 'hello' },
        context as never,
      ),
    ).rejects.toThrow(/No action was sent/);
    await expect(
      tools.task_reply.execute(
        { task_id: 'fix-1', request_id: 'req_1', reply: 'once' },
        context as never,
      ),
    ).rejects.toThrow(/No action was sent/);
    await expect(
      tools.task_result.execute({ task_id: 'fix-1' }, context as never),
    ).rejects.toThrow(/No action was sent/);
    await expect(
      tools.task_revive.execute(
        { task_id: 'fix-1', prompt: 'again' },
        context as never,
      ),
    ).rejects.toThrow(/No action was sent/);
    await expect(
      tools.task_status.execute({ task_id: 'fix-1' }, context as never),
    ).rejects.toThrow(/No action was sent/);
    expect(abort).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(board.get(CACHE)?.taskID).toBe(cached.taskID);
    expect(board.get(HOST)).toBeUndefined();
  });

  test('after verification a changed alias cannot select the cache row', async () => {
    const { input } = clientFor([taskPart({ output: withRef(HOST, 'fix-1') })]);
    const board = new BackgroundJobBoard();
    board.restoreRetainedSession({
      taskID: HOST,
      parentSessionID: PARENT,
      agent: 'fixer',
      description: 'HOST-A',
      state: 'completed',
      background: false,
      alias: 'fix-1',
      resultSummary: 'HOST-A',
    });
    const resolveCanonicalTaskRef = createAliasAuthority({
      input: input as never,
      board,
    }).resolveCanonical;
    const status = createTaskStatusTool({
      input: {
        ...input,
        client: {
          ...input.client,
          session: {
            ...input.client.session,
            status: async () => {
              board.registerLaunch({
                taskID: CACHE,
                parentSessionID: PARENT,
                agent: 'fixer',
                description: 'SECRET-B',
              });
              return { data: {} };
            },
          },
        },
      } as never,
      backgroundJobs: createBackgroundJobLifecycle({
        backgroundJobBoard: board,
      }),
      resolveCanonicalTaskRef,
    });
    const output = await status.task_status.execute(
      { task_id: 'fix-1' },
      context as never,
    );
    expect(String(output)).toContain(HOST);
    expect(String(output)).not.toContain('SECRET-B');
    expect(String(output)).not.toContain(CACHE);
  });
});

describe('recorded host alias interleave', () => {
  const v1Parent = 'ses_f056711d1ffeK1iBZwobzsRi56';
  const v1A = 'ses_f05670f71ffecrzbssUnH69xZD';
  const v1B = 'ses_f0566b48affe94I8ZSvRgVaTLX';
  const secretA = 'LAB-MARKER:secA-d326f8b2518c';
  const secretB = 'LAB-MARKER:secB-b9939557bd4b';

  function v1Task(input: {
    callID: string;
    sessionID: string;
    marker: string;
  }) {
    const output = `<task id="${input.sessionID}" state="completed">\n<task_result>\n${input.marker}\n</task_result>\n</task>\n<!-- slim-child-ref:v1 ${JSON.stringify(
      {
        parentSessionID: v1Parent,
        agent: 'fixer',
        alias: 'fix-1',
        sessionID: input.sessionID,
      },
    )} -->`;
    return {
      info: {
        role: 'assistant',
        time: { created: 1790910721646, completed: 1790910722315 },
      },
      parts: [
        { type: 'step-start' },
        {
          type: 'tool',
          callID: input.callID,
          tool: 'task',
          state: {
            status: 'completed',
            input: {
              subagent_type: 'fixer',
              description: 'Run one foreground fixer',
              prompt: input.marker,
              background: false,
            },
            output,
            time: { start: 1790910722184, end: 1790910722306 },
          },
        },
        { type: 'step-finish' },
      ],
    };
  }

  test('v1 restart history with two fix-1 tails does not report B', async () => {
    const { input } = clientFor([
      v1Task({ callID: 'call_2', sessionID: v1A, marker: secretA }),
      v1Task({ callID: 'call_3', sessionID: v1B, marker: secretB }),
    ]);
    const board = deferredBoard();
    board.registerLaunch({
      taskID: v1B,
      parentSessionID: v1Parent,
      agent: 'fixer',
      description: secretB,
    });
    const authority = createAliasAuthority({
      input: input as never,
      board,
    });
    const failed = createTaskStatusTool({
      input: input as never,
      backgroundJobs: createBackgroundJobLifecycle({
        backgroundJobBoard: board,
      }),
      resolveCanonicalTaskRef: authority.resolveCanonical,
    }).task_status.execute({ task_id: 'fix-1' }, {
      sessionID: v1Parent,
      agent: 'orchestrator',
    } as never);
    await expect(failed).rejects.toThrow(/multiple saved targets/);
    await expect(failed).rejects.toThrow(v1A);
    await expect(failed).rejects.toThrow(v1B);
    await expect(failed).rejects.not.toThrow(/Task fix-1/);
    expect(board.get(v1B)?.description).toBe(secretB);
    expect(board.get(v1A)).toBeUndefined();
  });
});

describe('oracle audit fences', () => {
  test('root dispose before a launch does not create pending work or abort', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'omo-alias-dispose-'));
    const abort = mock(async () => ({}));
    const prompt = mock(async () => ({}));
    const client = {
      app: { log: async () => ({}) },
      session: {
        abort,
        prompt,
        status: async () => ({ data: {} }),
        get: async () => ({ data: {} }),
      },
    };
    const hooks = await OhMyOpenCodeLite({
      client,
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
    await hooks.event?.({
      event: {
        type: 'server.instance.disposed',
        properties: { directory: projectDir },
      },
    } as never);
    await expect(
      hooks['tool.execute.before']?.(
        {
          tool: 'task',
          sessionID: 'ses_parentdispose01',
          callID: 'call_held',
        },
        {
          args: {
            subagent_type: 'fixer',
            description: 'held launch',
            prompt: 'do not send',
            background: true,
          },
        },
      ),
    ).rejects.toThrow(/disposed/);
    expect(abort).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    await hooks['tool.execute.after']?.(
      {
        tool: 'task',
        sessionID: 'ses_parentdispose01',
        callID: 'call_held',
      },
      { output: withRef(HOST, 'fix-4'), metadata: {} },
    );
    await expect(
      hooks.tool?.task_status?.execute({ task_id: HOST }, {
        sessionID: 'ses_parentdispose01',
        agent: 'orchestrator',
      } as never),
    ).rejects.toThrow(/disposed|Unknown task/);
  });
});

describe('native create degrade', () => {
  test('an existing parent still creates and tells the model to use the exact session id', async () => {
    const board = deferredBoard();
    const args = {
      subagent_type: 'fixer',
      description: 'new work',
      prompt: 'do it',
      background: false,
    };
    await handleToolExecuteBefore(
      { tool: 'task', sessionID: PARENT, callID: 'call_new' },
      { args },
      {
        shouldManageSession: () => true,
        backgroundJobs: createBackgroundJobLifecycle({
          backgroundJobBoard: board,
        }),
        pendingCallTracker: {
          add() {},
          take: () => undefined,
          pendingCallId: () => 'call_new',
        },
        taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
      },
    );
    const created = board.registerLaunch({
      taskID: 'ses_created',
      parentSessionID: PARENT,
      agent: 'fixer',
      description: 'new work',
    });
    expect(created.alias).toBe('ses_created');
    const noted = noteExactSessionAlias(closed('ses_created'), 'ses_created');
    const marked = appendChildRefSuffix(noted, {
      parentSessionID: PARENT,
      agent: 'fixer',
      alias: created.alias,
      sessionID: 'ses_created',
    });
    expect(marked).toContain('Refer by the exact session id ses_created.');
    expect(marked).not.toContain('Call task_result');
    expect(readAuthoritativeChildRef(marked)?.alias).toBe('ses_created');
  });

  // İ lowercases to two code units; offsets must stay on the original text.
  test('a case-changing character keeps the note and suffix aligned', () => {
    const ref = {
      parentSessionID: PARENT,
      agent: 'fixer',
      alias: 'fix-1',
      sessionID: HOST,
    };
    const raw = `<task id="${HOST}" state="completed"><task_result>İstanbul, İzmir</task_result></task>`;
    const noted = noteExactSessionAlias(raw, HOST);
    expect(noted).toContain(`Refer by the exact session id ${HOST}.\n</task>`);
    expect(readAuthoritativeChildRef(appendChildRefSuffix(noted, ref))).toEqual(
      ref,
    );
  });
});
