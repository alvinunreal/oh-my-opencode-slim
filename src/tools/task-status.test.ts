import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createAliasAuthority } from '../hooks/task-session-manager/session-recovery';
import {
  createToolLoopGuardHook,
  LOOP_GUARD_WARNING,
} from '../hooks/tool-loop-guard/hook';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { boardFixture } from '../utils/background-job-fixture';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
} from '../utils/background-job-terminal-gate';
import { buildPluginInput } from '../v2/client-shim';
import { createCancelTaskTool } from './cancel-task';
import { TaskActivityTracker } from './task-activity';
import { createTaskMessageTool } from './task-message';
import { createTaskStatusTool } from './task-status';

let client: Record<string, any>;
const statusGates: BackgroundJobTerminalGate[] = [];
afterEach(() => {
  for (const gate of statusGates.splice(0)) gate.dispose();
});

function makeTool(options: {
  board: BackgroundJobBoard;
  activityTracker?: TaskActivityTracker;
  now?: () => number;
  statusTimeoutMs?: number;
  readTimeoutMs?: number;
  hostFlavor?: string;
  resolveCanonicalTaskRef?: (
    parentSessionID: string,
    requested: string,
  ) => Promise<
    { kind: 'exact'; taskID: string } | { kind: 'refused'; reason: string }
  >;
}) {
  const input = {
    directory: '/test',
    client,
    ...(options.hostFlavor ? { hostFlavor: options.hostFlavor } : {}),
  } as any;
  const terminalGate = createBackgroundJobTerminalGate({
    input,
    backgroundJobBoard: options.board,
  });
  statusGates.push(terminalGate);
  return createTaskStatusTool({
    input,
    backgroundJobBoard: options.board,
    terminalGate,
    now: options.now,
    activityTracker: options.activityTracker,
    statusTimeoutMs: options.statusTimeoutMs,
    readTimeoutMs: options.readTimeoutMs,
    resolveCanonicalTaskRef: options.resolveCanonicalTaskRef,
  });
}

/**
 * Result-mode harness: mirrors the settled-terminal fixtures the deleted
 * task-result suite used — a tracked launch plus an explicit terminal gate
 * so `settle` publishes terminal state before the result read.
 */
function makeResultTool(
  tracked = true,
  hostFlavor?: string,
  options?: { readTimeoutMs?: number },
) {
  const board = new BackgroundJobBoard();
  const run = tracked
    ? board.registerLaunch({
        taskID: 'ses_child1',
        parentSessionID: 'parent-1',
        agent: 'explorer',
        now: 0,
      })
    : undefined;
  const get = mock(async () => ({ data: { parentID: 'parent-1' } }));
  const status = mock(async () => ({ data: {} }));
  const messages = mock(async () => ({
    data: [
      {
        info: { role: 'assistant', finish: 'stop', time: { completed: 10 } },
        parts: [{ type: 'text', text: 'final findings' }],
      },
    ],
  }));
  const input = {
    directory: '/tmp',
    client: { session: { get, status, messages } },
    ...(hostFlavor ? { hostFlavor } : {}),
  } as never;
  const gate = createBackgroundJobTerminalGate({
    backgroundJobBoard: board,
    input,
    graceMs: 0,
    now: () => 20,
  });
  statusGates.push(gate);
  const { task_status } = createTaskStatusTool({
    input,
    backgroundJobBoard: board,
    terminalGate: gate,
    readTimeoutMs: options?.readTimeoutMs,
  });
  const execute = (task_id = tracked ? 'exp-1' : 'ses_child1') =>
    task_status.execute({ task_id, result: true }, {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as never);
  async function settle(
    state: 'completed' | 'error' | 'cancelled' | 'stopped',
    acknowledged = false,
  ) {
    if (!run) throw new Error('tracked fixture required');
    if (state === 'error')
      messages.mockResolvedValue({
        data: [
          { info: { role: 'assistant', error: 'provider failed' }, parts: [] },
        ],
      } as never);
    if (state === 'stopped') messages.mockResolvedValue({ data: [] });
    if (state === 'cancelled') {
      const lease = board.acquireCancellationLease(run.taskID, run.generation);
      const token = gate.capture(run);
      if (!lease || !token) throw new Error('missing cancellation authority');
      gate.observe(token, {
        kind: 'quiescent',
        origin: 'cancel-verifier',
        readStartedAt: token.readStartedAt,
        stable: true,
      });
      await gate.reconcile(run, {
        kind: 'cancel',
        lease,
        reason: 'user requested',
      });
      board.releaseLease(lease);
    } else await gate.reconcile(run);
    expect(board.get(run.taskID)?.state).toBe(state);
    if (acknowledged) board.markReconciled(run.taskID);
  }
  return {
    board,
    get run() {
      if (!run) throw new Error('tracked fixture required');
      return run;
    },
    gate,
    get,
    status,
    messages,
    tool: task_status,
    execute,
    settle,
    input,
  };
}

describe('task_status', () => {
  test.each(
    (['v1', 'v2'] as const).flatMap((flavor) =>
      (['error', 'cancelled', 'stopped'] as const).map((state) => ({
        flavor,
        state,
      })),
    ),
  )(
    'tracked terminal reasons never borrow partial findings: %j',
    async ({ flavor, state }) => {
      const h = makeResultTool(true, flavor);
      await h.settle(state);
      const job = h.board.get('ses_child1');
      if (!job) throw new Error('expected tracked record');
      job.resultSummary = 'PARTIAL FINDINGS';
      job.lastStatusError = undefined;
      const answer = {
        info: {
          role: 'assistant',
          time: { created: 2 },
          error: 'assistant failed' as string | undefined,
        },
        parts: [{ type: 'text', text: 'PARTIAL FINDINGS' }],
      };
      h.messages.mockResolvedValue({
        data: [
          { info: { role: 'user', time: { created: 1 } }, parts: [] },
          answer,
        ],
      } as never);
      const read = () =>
        h.tool.execute({ task_id: 'ses_child1', diagnostic: true }, {
          sessionID: 'parent-1',
        } as never);
      const output = await read();
      expect(output).toContain('terminal_reason: assistant failed\n');
      expect(output.slice(0, output.indexOf('excerpt_begin'))).not.toContain(
        'PARTIAL FINDINGS',
      );
      expect(output.slice(output.indexOf('excerpt_begin'))).toContain(
        'PARTIAL FINDINGS',
      );
      expect(output).toEndWith(
        'next: treat this as non-final evidence; await or re-delegate, do not mark the task accepted',
      );
      answer.info.error = undefined;
      expect(await read()).toContain(`terminal_reason: ${state}\n`);
      job.lastStatusError = 'host error';
      expect(await read()).toContain('terminal_reason: host error\n');
      job.lastStatusError = undefined;
      job.resultSummary = 'Host reported outcome: failed.';
      answer.info.error = 'assistant failed';
      expect(await read()).toContain(
        'terminal_reason: Host reported outcome: failed.\n',
      );
    },
  );

  test('tool description stays status-focused and diagnostic parameter is concise', () => {
    const h = makeResultTool();
    expect(h.tool.description).not.toContain('diagnostic: true');
    expect(h.tool.description).toContain(
      'For an untracked session (e.g. after a restart), reports a read-only observed state.',
    );
    const description = h.tool.args.diagnostic.description ?? '';
    expect(description).toContain('tracked');
    expect(
      new TextEncoder().encode(description).byteLength,
    ).toBeLessThanOrEqual(135);
  });

  test.each([
    'unknown',
    'untracked status',
    'foreign untracked',
    'canonical refusal',
    'resolver error',
    'foreign tracked',
    'running',
    'completed',
    'unavailable',
    'race',
  ])(
    'bounds diagnostic errors and refusals with oversized references: %s',
    async (kind) => {
      const huge = `ses_${'a'.repeat(20_000)}`;
      const detail = '💥'.repeat(20_000);
      const board = new BackgroundJobBoard();
      const tracked = [
        'foreign tracked',
        'running',
        'completed',
        'unavailable',
        'race',
      ].includes(kind);
      if (tracked) {
        board.registerLaunch({
          taskID: huge,
          parentSessionID: kind === 'foreign tracked' ? 'foreign' : 'parent-1',
          agent: detail,
          now: 0,
        });
        if (['completed', 'unavailable', 'race'].includes(kind))
          boardFixture.updateStatus(board, {
            taskID: huge,
            state: kind === 'completed' ? 'completed' : 'error',
            now: 10,
          });
      }
      client = {
        session: {
          get: mock(async () => ({
            data:
              kind === 'foreign untracked'
                ? { parentID: 'foreign' }
                : kind === 'untracked status'
                  ? { parentID: 'parent-1' }
                  : {},
          })),
          messages: mock(async () => {
            if (kind === 'race')
              board.registerLaunch({
                taskID: huge,
                parentSessionID: 'parent-1',
                agent: detail,
                now: 20,
              });
            throw new Error(detail);
          }),
        },
      };
      const tool = makeTool({
        board,
        resolveCanonicalTaskRef: async () => {
          if (kind === 'resolver error') throw new Error(detail);
          return kind === 'canonical refusal'
            ? { kind: 'refused', reason: detail }
            : { kind: 'exact', taskID: huge };
        },
      }).task_status;
      let rendered: string;
      try {
        rendered = await tool.execute({ task_id: huge, diagnostic: true }, {
          sessionID: 'parent-1',
        } as never);
        expect([
          'running',
          'completed',
          'unavailable',
          'untracked status',
        ]).toContain(kind);
      } catch (error) {
        rendered = String(error);
        expect([
          'unknown',
          'foreign untracked',
          'canonical refusal',
          'resolver error',
          'foreign tracked',
          'race',
        ]).toContain(kind);
      }
      expect(new TextEncoder().encode(rendered).byteLength).toBeLessThanOrEqual(
        6144,
      );
      expect(rendered).toContain('[... truncated ...]');
    },
  );

  test.each(['v1', 'v2'])(
    'untracked diagnostic returns ordinary status with no excerpt read on %s',
    async (flavor) => {
      const h = makeResultTool(false, flavor);
      const input = { info: { role: 'user', time: { created: 1 } }, parts: [] };
      const answer = {
        info: {
          role: 'assistant',
          time: { created: 2 },
          error: 'child failed',
        },
        parts: [{ type: 'text', text: 'partial evidence' }],
      };
      h.get.mockResolvedValue({
        data: { parentID: 'parent-1', outcome: 'failed', time: { idle: 3 } },
      } as never);
      h.messages.mockResolvedValue({
        data: [input, answer],
      } as never);
      const args = { task_id: 'ses_child1' };
      const context = { sessionID: 'parent-1' } as never;
      const status = await h.tool.execute(args, context);
      h.get.mockClear();
      h.messages.mockClear();
      const markUsed = spyOn(h.board, 'markUsed');
      const output = await h.tool.execute(
        { ...args, diagnostic: true },
        context,
      );
      expect(output).toBe(
        `${status}\nmessage: Diagnostics require a tracked task record.`,
      );
      expect(output).toContain(
        `state: error (verified from ${flavor === 'v2' ? 'host state' : 'history'})`,
      );
      expect(output).not.toContain('partial evidence');
      expect(output).not.toContain('excerpt_begin');
      expect(h.get).toHaveBeenCalledTimes(1);
      expect(h.messages).toHaveBeenCalledTimes(1);
      expect(h.messages.mock.calls[0]?.[0]).toMatchObject({
        query: { limit: undefined },
      });
      expect(markUsed).not.toHaveBeenCalled();
      expect(h.board.get('ses_child1')).toBeUndefined();
      markUsed.mockRestore();
    },
  );

  test('ordinary untracked status and result preserve unlimited fetch defaults', async () => {
    const h = makeResultTool(false);
    const context = { sessionID: 'parent-1' } as never;
    await h.tool.execute({ task_id: 'ses_child1' }, context);
    await h.tool.execute({ task_id: 'ses_child1', result: true }, context);
    expect(h.messages).toHaveBeenCalledTimes(2);
    for (const [args] of h.messages.mock.calls)
      expect(args).toMatchObject({ query: { limit: undefined } });
  });
  test.each(['observed-activity', 'host-busy', 'launch-time', 'unknown'])(
    'activity provenance preserves timestamp: %s',
    async (source) => {
      const board = new BackgroundJobBoard();
      const tracker = new TaskActivityTracker();
      if (source !== 'unknown')
        board.registerLaunch({
          taskID: 'ses_child1',
          parentSessionID: 'parent-1',
          agent: 'explorer',
          now: 100,
        });
      if (source === 'host-busy')
        board.markRunningFromLiveSession('ses_child1', 150);
      if (source === 'observed-activity') tracker.touch('ses_child1', 175);
      client = {
        session: {
          get: mock(async () => ({ data: { parentID: 'parent-1' } })),
          status: mock(async () => ({
            data: { ses_child1: { type: 'busy' } },
          })),
        },
      };
      const tool = makeTool({
        board,
        activityTracker: tracker,
        now: () => 200,
      }).task_status;
      const output = await tool.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-1',
      } as never);
      expect(output.match(/^last_activity_source: (.+)$/m)?.[1]).toBe(source);
      if (source !== 'unknown')
        expect(output).toContain(
          `last_activity_at: ${new Date(source === 'observed-activity' ? 175 : source === 'host-busy' ? 150 : 100).toISOString()}`,
        );
      else expect(output).not.toContain('last_activity_at:');
    },
  );

  test.each(['error', 'cancelled', 'stopped'] as const)(
    'diagnostic serves %s without gate, board, or host writes',
    async (state) => {
      const h = makeResultTool();
      await h.settle(state);
      h.messages.mockResolvedValue({
        data: [
          { info: { role: 'user' }, parts: [] },
          {
            info: { role: 'assistant', time: { created: 10 } },
            parts: [{ type: 'text', text: 'partial findings' }],
          },
        ],
      } as never);
      const captures = spyOn(h.gate, 'capture');
      const observes = spyOn(h.gate, 'observe');
      const reconciles = spyOn(h.gate, 'reconcile');
      const markUsed = spyOn(h.board, 'markUsed');
      const terminal = mock(() => {});
      h.board.setTerminalPublicationHandler(terminal);
      const before = structuredClone(h.board.get('ses_child1'));
      h.get.mockClear();
      h.status.mockClear();
      h.messages.mockClear();
      const output = await h.tool.execute(
        { task_id: 'exp-1', diagnostic: true },
        { sessionID: 'parent-1' } as never,
      );
      for (const expected of [
        `state: ${state}`,
        'generation: 1',
        'terminal_reason:',
        'partial_output: true',
        'excerpt_begin',
        'partial findings',
      ])
        expect(output).toContain(expected);
      expect(h.board.get('ses_child1')).toEqual(before);
      for (const spy of [
        captures,
        observes,
        reconciles,
        markUsed,
        terminal,
        h.get,
        h.status,
      ])
        expect(spy).not.toHaveBeenCalled();
      expect(h.messages).toHaveBeenCalledTimes(1);
      expect(h.messages.mock.calls[0]?.[0]).toMatchObject({
        query: { limit: 100 },
      });
      captures.mockRestore();
      observes.mockRestore();
      reconciles.mockRestore();
      markUsed.mockRestore();
      h.board.setTerminalPublicationHandler(undefined);
      if (state === 'error') {
        const used = spyOn(h.board, 'markUsed');
        await expect(h.execute()).rejects.toThrow('ended in error');
        expect(used).toHaveBeenCalledTimes(1);
        used.mockRestore();
      }
    },
  );

  test.each(['running', 'completed'] as const)(
    'diagnostic refuses %s without reading transcript',
    async (state) => {
      const h = makeResultTool();
      if (state === 'completed') await h.settle(state);
      h.messages.mockClear();
      const before = structuredClone(h.board.get('ses_child1'));
      const output = await h.tool.execute(
        { task_id: 'exp-1', diagnostic: true },
        { sessionID: 'parent-1' } as never,
      );
      expect(output).toContain(`state: ${state}`);
      expect(output).toContain(
        state === 'completed' ? 'result: true' : 'finished-but-unsuccessful',
      );
      expect(h.messages).not.toHaveBeenCalled();
      expect(h.board.get('ses_child1')).toEqual(before);
    },
  );

  test('diagnostic mutual exclusion precedes all host I/O', async () => {
    const h = makeResultTool();
    await expect(
      h.tool.execute({ task_id: 'exp-1', diagnostic: true, result: true }, {
        sessionID: 'parent-1',
      } as never),
    ).rejects.toThrow('accepts either result or diagnostic, not both');
    for (const fn of [h.get, h.status, h.messages])
      expect(fn).not.toHaveBeenCalled();
  });

  test.each(['generation', 'publication', 'reopen', 'deleted'] as const)(
    'diagnostic rejects a %s race during transcript read',
    async (change) => {
      const h = makeResultTool();
      await h.settle('error');
      h.messages.mockImplementation(async () => {
        const job = h.board.get('ses_child1');
        if (!job) throw new Error('expected tracked child');
        if (change === 'generation') job.generation++;
        if (change === 'publication') job.terminalRevision++;
        if (change === 'reopen')
          h.board.markRunningFromLiveSession(
            job.taskID,
            100,
            job.generation,
            job.terminalRevision,
          );
        if (change === 'deleted')
          spyOn(h.board, 'get').mockReturnValue(undefined);
        return { data: [] };
      });
      await expect(
        h.tool.execute({ task_id: 'exp-1', diagnostic: true }, {
          sessionID: 'parent-1',
        } as never),
      ).rejects.toThrow(
        'changed generation while its diagnostic was being read',
      );
      if (change === 'deleted') (h.board.get as any).mockRestore();
    },
  );

  test.each([true, false])(
    'diagnostic rejects foreign ownership (tracked=%s)',
    async (tracked) => {
      const h = makeResultTool(tracked);
      if (tracked) {
        const job = h.board.get('ses_child1');
        if (!job) throw new Error('expected tracked child');
        job.parentSessionID = 'foreign';
      } else h.get.mockResolvedValue({ data: { parentID: 'foreign' } });
      await expect(
        h.tool.execute({ task_id: 'ses_child1', diagnostic: true }, {
          sessionID: 'parent-1',
        } as never),
      ).rejects.toThrow('does not belong to this session');
      expect(h.messages).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, { data: 'not-array' }, { data: [] }])(
    'diagnostic unavailable or empty evidence stays truthful: %j',
    async (transcript) => {
      const h = makeResultTool();
      await h.settle('error');
      h.messages.mockResolvedValue(transcript as never);
      const output = await h.tool.execute(
        { task_id: 'exp-1', diagnostic: true },
        { sessionID: 'parent-1' } as never,
      );
      expect(output).toContain('state: error');
      expect(output).toContain('evidence: unavailable');
    },
  );

  test('whole rendered single-message diagnostic reports only character truncation within 6144 bytes', async () => {
    const h = makeResultTool();
    await h.settle('error');
    h.messages.mockResolvedValue({
      data: [
        { info: { role: 'user', time: { created: 0 } }, parts: [] },
        {
          info: { role: 'assistant', time: { created: 1 } },
          parts: [{ type: 'text', text: '界'.repeat(2000) }],
        },
      ],
    } as never);
    const output = await h.tool.execute(
      { task_id: 'exp-1', diagnostic: true },
      { sessionID: 'parent-1' } as never,
    );
    expect(output).toContain('excerpt_begin\n');
    expect(output).toContain('truncated: chars\n');
    expect(output).not.toContain('earlier messages omitted');
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(
      6144,
    );
  });

  test('whole rendered diagnostic including huge reason and multibyte transcript fits 6144 bytes', async () => {
    const h = makeResultTool();
    await h.settle('error');
    const job = h.board.get('ses_child1');
    if (!job) throw new Error('expected tracked child');
    job.lastStatusError = '💥'.repeat(100_000);
    h.messages.mockResolvedValue({
      data: Array.from({ length: 100 }, (_, index) => ({
        info: {
          role: index === 61 ? 'user' : 'assistant',
          time: { created: index / 10 },
        },
        parts: [{ type: 'text', text: '💥'.repeat(100_000) }],
      })),
    } as never);
    const read = () =>
      h.tool.execute({ task_id: 'exp-1', diagnostic: true }, {
        sessionID: 'parent-1',
      } as never);
    const output = await read();
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(
      6144,
    );
    expect(output).toContain('[... truncated ...]');
    expect(output).toContain('truncated: messages,chars');
    expect(await read()).toBe(output);
  });

  test.each(['child transcript read timed out', 'session deleted'])(
    'diagnostic reports unavailable evidence on read failure: %s',
    async (message) => {
      const h = makeResultTool();
      await h.settle('error');
      h.messages.mockRejectedValue(new Error(message));
      const output = await h.tool.execute(
        { task_id: 'exp-1', diagnostic: true },
        { sessionID: 'parent-1' } as never,
      );
      expect(output).toContain(`evidence: unavailable (${message})`);
      expect(output).toContain('terminal_reason: error');
      expect(output).not.toContain('excerpt_begin');
      expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(
        6144,
      );
    },
  );

  test.each(['busy', 'unknown'])(
    'untracked diagnostic keeps the ordinary live-status short circuit: %s',
    async (kind) => {
      const h = makeResultTool(false);
      if (kind === 'busy')
        h.status.mockResolvedValue({
          data: { ses_child1: { type: 'busy' } },
        } as never);
      if (kind === 'unknown')
        h.status.mockRejectedValue(new Error('status unreadable'));
      const output = await h.tool.execute(
        { task_id: 'ses_child1', diagnostic: true },
        { sessionID: 'parent-1' } as never,
      );
      expect(output).not.toContain('partial_output: true');
      expect(output).toContain(
        kind === 'busy' ? 'state: busy (live)' : 'state: unknown (uncertain;',
      );
      expect(output).toContain('Diagnostics require a tracked task record.');
      expect(h.messages).not.toHaveBeenCalled();
      expect(h.board.get('ses_child1')).toBeUndefined();
    },
  );

  test('diagnostic unavailable host endpoint retains terminal header', async () => {
    const h = makeResultTool();
    await h.settle('error');
    (h.input as any).client.session.messages = undefined;
    const output = await h.tool.execute(
      { task_id: 'exp-1', diagnostic: true },
      { sessionID: 'parent-1' } as never,
    );
    expect(output).toContain('state: error');
    expect(output).toContain(
      'evidence: unavailable (transcript source not exposed by host)',
    );
  });
  test('reads a child status without prompting it', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
    });
    const status = mock(async () => ({
      data: { ses_child1: { type: 'busy' } },
    }));
    client = { session: { status } };
    const { task_status } = makeTool({ board });

    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: busy');
    expect(output).toContain(
      '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
    );
    expect(status).toHaveBeenCalledTimes(1);
  });

  test('includes guidance for active states (retry, running)', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
    });
    const status = mock(async () => ({
      data: { ses_child1: { type: 'retry' } },
    }));
    client = { session: { status } };
    const { task_status } = makeTool({ board });

    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: retry');
    expect(output).toContain(
      '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
    );
  });

  test('flags a busy child without recent activity as possibly stuck', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'busy' } },
        })),
      },
    };
    const { task_status } = makeTool({ board, now: () => 120_000 });
    await expect(
      task_status.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-1',
      } as any),
    ).resolves.toContain('possibly_stuck: true');
  });

  test('surfaces a failed status read as explicit uncertainty, not a confident board fallback', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    client = {
      session: {
        status: mock(async () => {
          throw new Error('host status read failed');
        }),
      },
    };
    const { task_status } = makeTool({ board, now: () => 120_000 });
    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: running (unconfirmed)');
    expect(output).toContain('status_uncertain: true');
    expect(output).toContain('last_status_error: host status read failed');
    expect(output).not.toContain('[guidance]: The task is still running.');
    // An uncertain board fallback must never drive an automatic nudge.
    expect(output).toContain('possibly_stuck: false');
  });

  test('treats a malformed live status entry as uncertain', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'weird-state' } },
        })),
      },
    };
    const { task_status } = makeTool({ board, now: () => 120_000 });
    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: running (unconfirmed)');
    expect(output).toContain('status_uncertain: true');
    expect(output).toContain(
      'last_status_error: malformed live status entry for session',
    );
    expect(output).not.toContain('[guidance]: The task is still running.');
    expect(output).toContain('possibly_stuck: false');
  });

  test('bounds a hanging status read with a timeout and reports uncertainty', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    client = {
      session: {
        // Responds far slower than the bounded read allows; the 20ms race
        // timer must reject first so the tool cannot hang on a stuck host.
        status: mock(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ data: { ses_child1: { type: 'busy' } } }),
                200,
              ),
            ),
        ),
      },
    };
    const { task_status } = makeTool({ board, statusTimeoutMs: 20 });
    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('status_uncertain: true');
    expect(output).toContain('last_status_error');
    expect(output).toContain('timed out');
    expect(output).not.toContain('[guidance]: The task is still running.');
    expect(output).toContain('possibly_stuck: false');
  });

  test('reports an absent session in a valid map as uncertain', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      now: 0,
    });
    client = { session: { status: mock(async () => ({ data: {} })) } };
    const { task_status } = makeTool({ board, now: () => 120_000 });
    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: running (unconfirmed)');
    expect(output).toContain('status_uncertain: true');
    expect(output).toContain(
      'last_status_error: no live status entry for session',
    );
    expect(output).not.toContain('[guidance]: The task is still running.');
    expect(output).toContain('possibly_stuck: false');
  });

  test('rejects a task id owned by a different parent', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
    });
    const { task_status } = makeTool({ board });
    await expect(
      task_status.execute({ task_id: 'ses_child1' }, {
        sessionID: 'parent-2',
      } as any),
    ).rejects.toThrow('Unknown task ID or alias');
  });

  test('v2 exposes sessionID and accepts the task_id alias', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
    });
    client = {
      session: {
        status: mock(async () => ({
          data: { ses_child1: { type: 'busy' } },
        })),
      },
    };
    const { task_status } = makeTool({ board, hostFlavor: 'v2' });

    expect(Object.keys(task_status.args)).toContain('sessionID');

    const viaNative = await task_status.execute({ sessionID: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(viaNative).toContain('state: busy');
    const viaAlias = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(viaAlias).toContain('state: busy');

    await expect(
      task_status.execute({ sessionID: ' ' }, { sessionID: 'parent-1' } as any),
    ).rejects.toThrow('requires sessionID');
  });
});

describe('task_status untracked read-only fallback', () => {
  const KID = 'ses_lostchild';

  /** v1 transcript evidence shape for one finished child round. */
  function childTranscript(state: 'completed' | 'incomplete' | 'textless') {
    const messages: any[] = [
      {
        info: { id: 'msg_user', role: 'user', time: { created: 10 } },
        parts: [{ type: 'text', text: 'ask' }],
      },
    ];
    if (state === 'completed') {
      messages.push({
        info: {
          id: 'msg_turn',
          role: 'assistant',
          finish: 'stop',
          time: { created: 11, completed: 12 },
        },
        parts: [{ type: 'text', text: 'LAB-MARKER: done' }],
      });
    } else if (state === 'incomplete') {
      messages.push({
        info: { id: 'msg_turn', role: 'assistant', time: { created: 11 } },
        parts: [{ type: 'text', text: 'partial' }],
      });
    }
    return { data: messages };
  }

  function hostClient(options?: {
    parent?: string;
    transcript?: 'completed' | 'incomplete' | 'textless';
    liveStatus?: Record<string, { type: string }>;
    omitGet?: boolean;
    outcome?: string;
    idle?: number;
  }) {
    return {
      session: {
        ...(options?.omitGet
          ? {}
          : {
              get: mock(async () => ({
                data: {
                  id: KID,
                  parentID: options?.parent ?? 'parent-1',
                  agent: 'fixer',
                  ...(options?.outcome
                    ? {
                        outcome: options.outcome,
                        time: { created: 100, idle: options.idle ?? 200 },
                      }
                    : { time: { created: 100, updated: 200 } }),
                },
              })),
            }),
        status: mock(async () => ({ data: options?.liveStatus ?? {} })),
        messages: mock(async () =>
          childTranscript(options?.transcript ?? 'completed'),
        ),
      },
    };
  }

  test('an untracked owned exact id reports verified completion (v1)', async () => {
    client = hostClient({ transcript: 'completed' });
    const { task_status } = makeTool({ board: new BackgroundJobBoard() });
    const output = await task_status.execute({ task_id: KID }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('not tracked by the local background job board');
    expect(output).toContain('state: completed (verified from history)');
    expect(output).toContain('agent: fixer');
    expect(output).toContain('result: true');
    // Read-only: nothing was registered on the board.
    expect(client.session.get).toHaveBeenCalledTimes(1);
  });

  test('an untracked owned exact id reports uncertain incomplete state (v2)', async () => {
    client = hostClient({ transcript: 'incomplete' });
    const { task_status } = makeTool({
      board: new BackgroundJobBoard(),
      hostFlavor: 'v2',
    });
    const output = await task_status.execute({ task_id: KID }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: running-or-incomplete (uncertain');
    expect(output).not.toContain('The task is still running.');
  });

  test('v2 status classifies from the ownership read without an extra get', async () => {
    client = hostClient({
      transcript: 'incomplete',
      outcome: 'succeeded',
      idle: 20,
    });
    const { task_status } = makeTool({
      board: new BackgroundJobBoard(),
      hostFlavor: 'v2',
    });
    const output = await task_status.execute({ task_id: KID }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: completed (verified from host state)');
    expect(client.session.get).toHaveBeenCalledTimes(1);
  });

  test('v2 keeps a newer assistant after the host idle pending', async () => {
    client = hostClient({
      transcript: 'incomplete',
      outcome: 'succeeded',
      idle: 12,
    });
    client.session.messages = mock(async () => ({
      data: [
        {
          info: { id: 'msg_user', role: 'user', time: { created: 10 } },
          parts: [],
        },
        {
          info: {
            id: 'msg_newer',
            role: 'assistant',
            time: { created: 13 },
          },
          parts: [{ type: 'text', text: 'NEWER' }],
        },
      ],
    }));
    const { task_status } = makeTool({
      board: new BackgroundJobBoard(),
      hostFlavor: 'v2',
    });
    const output = await task_status.execute({ task_id: KID }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: running-or-incomplete (uncertain');
    expect(output).toContain(
      'no terminal host outcome covers the latest input',
    );
    expect(output).not.toContain('NEWER');
    expect(client.session.get).toHaveBeenCalledTimes(1);
  });

  test('a returned id for another session refuses untracked ownership', async () => {
    client = hostClient();
    client.session.get = mock(async () => ({
      data: {
        id: 'ses_other',
        parentID: 'parent-1',
        agent: 'fixer',
        time: { created: 100 },
      },
    }));
    const { task_status } = makeTool({ board: new BackgroundJobBoard() });
    await expect(
      task_status.execute({ task_id: KID }, { sessionID: 'parent-1' } as any),
    ).rejects.toThrow('Unknown task ID or alias');
  });

  test('a v1 live busy map reports live running without board adoption', async () => {
    client = hostClient({
      transcript: 'incomplete',
      liveStatus: { [KID]: { type: 'busy' } },
    });
    const board = new BackgroundJobBoard();
    const { task_status } = makeTool({ board });
    const output = await task_status.execute({ task_id: KID }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: busy (live)');
    expect(output).toContain('[guidance]: The task is still running.');
    expect(board.get(KID)).toBeUndefined();
  });

  test('a session owned by another parent refuses', async () => {
    client = hostClient({ parent: 'parent-2' });
    const { task_status } = makeTool({ board: new BackgroundJobBoard() });
    await expect(
      task_status.execute({ task_id: KID }, { sessionID: 'parent-1' } as any),
    ).rejects.toThrow('does not belong to this session');
  });

  test('a non-exact alias that resolves nowhere still refuses', async () => {
    client = hostClient();
    const { task_status } = makeTool({ board: new BackgroundJobBoard() });
    await expect(
      task_status.execute({ task_id: 'fix-9' }, {
        sessionID: 'parent-1',
      } as any),
    ).rejects.toThrow('Unknown task ID or alias: fix-9');
  });

  test('an alias resolved by resolveCanonical but not on the board uses the fallback', async () => {
    client = hostClient({ transcript: 'completed' });
    // The parent history pairs fix-1 with KID through a marker on a
    // native background plaintext launch sentence.
    const backgroundText =
      `The subagent is working in the background (sessionID: ${KID}). ` +
      'You will be notified automatically when it finishes.';
    const marker = `<!-- slim-child-ref:v1 ${JSON.stringify({
      parentSessionID: 'parent-1',
      agent: 'fixer',
      alias: 'fix-1',
      sessionID: KID,
    })} -->`;
    const marked = `${backgroundText}\n${marker}`;
    const parentHistory = {
      data: [
        {
          info: { id: 'msg_u', role: 'user', time: { created: 10 } },
          parts: [{ type: 'text', text: 'ask' }],
        },
        {
          info: {
            id: 'msg_a',
            role: 'assistant',
            time: { created: 20, completed: 30 },
          },
          parts: [
            {
              type: 'tool',
              tool: 'task',
              state: {
                status: 'completed',
                input: {
                  subagent_type: 'fixer',
                  description: 'd',
                  prompt: 'p',
                  background: true,
                },
                output: marked,
                time: { start: 21, end: 29 },
              },
            },
          ],
        },
      ],
    };
    client.session.messages = mock(async (args: { path?: { id?: string } }) =>
      args.path?.id === 'parent-1'
        ? parentHistory
        : childTranscript('completed'),
    );
    const board = new BackgroundJobBoard();
    const authority = createAliasAuthority({
      input: { directory: '/test', client } as never,
      board,
    });
    expect(await authority.resolveCanonical('parent-1', 'fix-1')).toEqual({
      kind: 'exact',
      taskID: KID,
    });
    const { task_status } = makeTool({
      board,
      resolveCanonicalTaskRef: authority.resolveCanonical,
    });
    const output = await task_status.execute({ task_id: 'fix-1' }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain(KID);
    expect(output).toContain('not tracked by the local background job board');
    expect(output).toContain('state: completed (verified from history)');
    expect(board.get(KID)).toBeUndefined();
  });

  test('a v2 host outcome without readable answer text reports pending, not verified completion', async () => {
    // Incident 1115 companion: the status fallback must not render a
    // textless succeeded host outcome as plain verified completion.
    client = hostClient({ transcript: 'textless', outcome: 'succeeded' });
    delete (client.session as Record<string, unknown>).status;
    const { task_status } = makeTool({
      board: new BackgroundJobBoard(),
      hostFlavor: 'v2',
    });
    const output = await task_status.execute({ task_id: KID }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain(
      'uncertain; no terminal host outcome covers the latest input',
    );
    const result = await task_status.execute({ task_id: KID, result: true }, {
      sessionID: 'parent-1',
    } as any);
    expect(result).toContain('state: running (unconfirmed)');
  });

  test('a failed v1 live status read reports unknown, not history completion', async () => {
    client = hostClient({ transcript: 'completed' });
    client.session.status = mock(async () => {
      throw new Error('status unavailable');
    });
    const { task_status } = makeTool({ board: new BackgroundJobBoard() });
    const output = await task_status.execute({ task_id: KID }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('state: unknown (uncertain; live status');
    expect(output).not.toContain('completed (verified from history)');
    expect(client.session.messages).not.toHaveBeenCalled();
  });

  test('held untracked host reads are aborted at their deadline', async () => {
    const signals: AbortSignal[] = [];
    const held = (args: { signal?: AbortSignal }) => {
      if (args.signal) signals.push(args.signal);
      return new Promise(() => {});
    };
    client = hostClient({ transcript: 'completed' });
    client.session.messages = mock(held);
    const { task_status } = makeTool({
      board: new BackgroundJobBoard(),
      readTimeoutMs: 20,
    });
    const output = await task_status.execute({ task_id: KID }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain('(uncertain; transcript could not be read)');
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);

    signals.length = 0;
    client.session.get = mock(held);
    await expect(
      task_status.execute({ task_id: KID }, { sessionID: 'parent-1' } as any),
    ).rejects.toThrow(`Unknown task ID or alias: ${KID}`);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  test('the host session creation time is labeled as creation, not activity', async () => {
    client = hostClient({ transcript: 'completed' });
    const { task_status } = makeTool({ board: new BackgroundJobBoard() });
    const output = await task_status.execute({ task_id: KID }, {
      sessionID: 'parent-1',
    } as any);
    expect(output).toContain(`created_at: ${new Date(100).toISOString()}`);
    expect(output).not.toContain('last_activity_at');
  });

  test('without session.get the untracked path keeps the unknown error', async () => {
    client = hostClient({ omitGet: true });
    const { task_status } = makeTool({ board: new BackgroundJobBoard() });
    await expect(
      task_status.execute({ task_id: KID }, { sessionID: 'parent-1' } as any),
    ).rejects.toThrow(`Unknown task ID or alias: ${KID}`);
  });
});

describe('task_status result mode', () => {
  test('retrieves full confirmed text without prompting or resuming', async () => {
    const h = makeResultTool();
    await h.settle('completed');
    h.messages.mockClear();
    expect(await h.execute()).toBe('final findings');
    expect(h.messages).toHaveBeenCalledTimes(1);
    expect(h.board.get(h.run.taskID)?.lastUsedAt).toBeGreaterThan(0);
  });
  test('only the last assistant segment is retrieved', async () => {
    const h = makeResultTool();
    h.messages.mockResolvedValue({
      data: [
        {
          info: { role: 'assistant', finish: 'stop', time: { completed: 2 } },
          parts: [{ type: 'text', text: 'earlier' }],
        },
        { info: { role: 'user' }, parts: [] },
        {
          info: { role: 'assistant', finish: 'stop', time: { completed: 10 } },
          parts: [
            { type: 'reasoning', text: 'private' },
            { type: 'text', text: 'final' },
          ],
        },
      ],
    } as never);
    expect(await h.execute()).toBe('final');
  });
  test.each(['completed', 'error', 'cancelled', 'stopped'] as const)(
    'live busy retracts REAL %s before rejection or acknowledgement',
    async (state) => {
      for (const acknowledged of [false, true]) {
        const h = makeResultTool();
        await h.settle(state, acknowledged);
        const previous = h.board.get(h.run.taskID);
        if (!previous) throw new Error('missing terminal fixture');
        h.messages.mockClear();
        h.status.mockResolvedValue({ data: { ses_child1: { type: 'busy' } } });
        expect(await h.execute()).toContain('state: running');
        expect(h.board.get(h.run.taskID)).toMatchObject({
          state: 'running',
          generation: previous.generation,
          terminalRevision: previous.terminalRevision + 1,
          terminalUnreconciled: false,
          resultSummary: undefined,
        });
        expect(h.messages).not.toHaveBeenCalled();
      }
    },
  );
  test.each(['busy', 'retry'])(
    'preserves live %s presentation without reading result',
    async (type) => {
      const h = makeResultTool();
      h.status.mockResolvedValue({ data: { ses_child1: { type } } });
      expect(await h.execute()).toContain(
        type === 'retry' ? 'state: retry' : 'state: running',
      );
      expect(h.messages).not.toHaveBeenCalled();
      expect(h.status).toHaveBeenCalledTimes(1);
    },
  );
  test('valid idle with pending transcript is pending, not a terminal result', async () => {
    const h = makeResultTool();
    h.status.mockResolvedValue({ data: { ses_child1: { type: 'idle' } } });
    h.messages.mockResolvedValue({
      data: [{ info: { role: 'assistant' }, parts: [] }],
    } as never);
    expect(await h.execute()).toContain('state: pending');
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
  });
  test('unknown status remains running without reading transcript', async () => {
    const h = makeResultTool();
    h.status.mockRejectedValue(new Error('unavailable'));
    expect(await h.execute()).toContain('state: running (unconfirmed)');
    expect(h.messages).not.toHaveBeenCalled();
  });
  test.each(['error', 'cancelled'] as const)(
    'quiescent %s is rejected only after checking activity and marks the result consumed',
    async (state) => {
      const h = makeResultTool();
      await h.settle(state);
      h.status.mockClear();
      await expect(h.execute()).rejects.toThrow(
        state === 'error' ? 'ended in error' : 'was cancelled',
      );
      expect(h.status).toHaveBeenCalledTimes(1);
      // error/cancelled throw text IS the delivered result → mark used.
      expect(h.board.get(h.run.taskID)?.lastUsedAt).toBeGreaterThan(0);
    },
  );
  test('quiescent stopped is refused without marking the result consumed', async () => {
    const h = makeResultTool();
    await h.settle('stopped');
    h.status.mockClear();
    const before = h.board.get(h.run.taskID)?.lastUsedAt;
    await expect(h.execute()).rejects.toThrow('no confirmed completed result');
    expect(h.status).toHaveBeenCalledTimes(1);
    // stopped has no delivered result: markUsed would silently open the
    // duplicate-dispatch escape hatch, so it must not run.
    expect(h.board.get(h.run.taskID)?.lastUsedAt).toBe(before);
  });
  test('acknowledged completed result stays retrievable on matching evidence', async () => {
    const h = makeResultTool();
    await h.settle('completed', true);
    expect(await h.execute()).toBe('final findings');
  });
  test('generation change during evidence lookup never returns the old result', async () => {
    const h = makeResultTool();
    h.messages.mockImplementation(async () => {
      h.board.registerLaunch({ ...h.run, now: 100 });
      return {
        data: [
          {
            info: {
              role: 'assistant',
              finish: 'stop',
              time: { completed: 10 },
            },
            parts: [{ type: 'text', text: 'old result' }],
          },
        ],
      };
    });
    await expect(h.execute()).rejects.toThrow('changed generation');
  });
  test('ownership mismatch cannot expose a child result', async () => {
    const h = makeResultTool(false);
    h.get.mockResolvedValue({ data: { parentID: 'other' } });
    await expect(h.execute()).rejects.toThrow('does not belong');
    expect(h.messages).not.toHaveBeenCalled();
  });
  test.each(['busy', 'retry'])(
    'untracked live %s returns status without a transcript',
    async (type) => {
      const h = makeResultTool(false);
      h.status.mockResolvedValue({ data: { ses_child1: { type } } });
      expect(await h.execute()).toContain(
        'retry task_status with { result: true } after the task finishes',
      );
      expect(h.messages).not.toHaveBeenCalled();
    },
  );
  test('untracked quiescent session still requires a terminal assistant segment', async () => {
    const h = makeResultTool(false);
    h.messages.mockResolvedValue({
      data: [
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'partial' }],
        },
      ],
    } as never);
    await expect(h.execute()).rejects.toThrow('no terminal evidence');
  });
  test('held untracked transcript reads are aborted at their deadline', async () => {
    const signals: AbortSignal[] = [];
    const held = (args: { signal?: AbortSignal }) => {
      if (args.signal) signals.push(args.signal);
      return new Promise(() => {});
    };
    const h = makeResultTool(false, undefined, { readTimeoutMs: 20 });
    h.messages.mockImplementation(held as never);
    await expect(h.execute()).rejects.toThrow(
      'child transcript read timed out',
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });
  test.each([
    ['finished', 'succeeded', 'final findings'],
    ['still running', undefined, 'running (unconfirmed)'],
  ])(
    'untracked v2 %s child is classified from its context',
    async (_, outcome, expected) => {
      const context = mock(async () => [
        { id: 'u1', type: 'user', text: 'ask', time: { created: 1 } },
        {
          id: 'a1',
          type: 'assistant',
          text: 'final findings',
          time: { created: 2 },
        },
        ...(outcome
          ? [{ id: 'i1', type: 'idle', outcome, time: { created: 3 } }]
          : []),
      ]);
      const input = buildPluginInput({
        session: {
          get: async () => ({
            parentID: 'parent-1',
            ...(outcome ? { outcome, time: { idle: 3 } } : {}),
          }),
          context,
        },
      } as never) as never;
      const board = new BackgroundJobBoard();
      const terminalGate = createBackgroundJobTerminalGate({
        input,
        backgroundJobBoard: board,
      });
      statusGates.push(terminalGate);
      const output = await createTaskStatusTool({
        input,
        backgroundJobBoard: board,
        terminalGate,
      }).task_status.execute({ task_id: 'ses_child1', result: true }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as never);
      expect(String(output)).toContain(expected);
      expect(context).toHaveBeenCalledTimes(1);
    },
  );
  test.each([{ created: 14 }, { created: 11, completed: 14 }, {}])(
    'untracked v2 never serves an answer outside its host terminal (%j)',
    async (time) => {
      const board = new BackgroundJobBoard();
      const input = buildPluginInput({
        session: {
          get: async () => ({
            parentID: 'parent-1',
            outcome: 'succeeded',
            time: { idle: 13 },
          }),
          context: async () => [
            { id: 'u1', type: 'user', text: 'ask', time: { created: 10 } },
            {
              id: 'a1',
              type: 'assistant',
              text: 'PARTIAL',
              time,
            },
          ],
        },
      } as never) as never;
      const terminalGate = createBackgroundJobTerminalGate({
        input,
        backgroundJobBoard: board,
      });
      statusGates.push(terminalGate);
      const tool = createTaskStatusTool({
        input,
        backgroundJobBoard: board,
        terminalGate,
      });
      const context = { sessionID: 'parent-1' } as never;
      const status = await tool.task_status.execute(
        { task_id: 'ses_child1' },
        context,
      );
      expect(String(status)).not.toContain('state: completed');
      expect(String(status)).not.toContain('PARTIAL');
      const result = tool.task_status.execute(
        { task_id: 'ses_child1', result: true },
        context,
      );
      if (Object.keys(time).length === 0) {
        await expect(result).rejects.toThrow('no terminal evidence');
      } else {
        const output = await result;
        expect(String(output)).toContain('running (unconfirmed)');
        expect(String(output)).not.toContain('PARTIAL');
      }
      expect(board.list('parent-1')).toHaveLength(0);
    },
  );

  test('unknown alias and empty task id are rejected', async () => {
    const h = makeResultTool();
    await expect(h.execute('exp-99')).rejects.toThrow('Unknown task ID');
    await expect(
      h.tool.execute({ task_id: ' ', result: true }, {
        sessionID: 'parent-1',
      } as any),
    ).rejects.toThrow('requires task_id');
  });
  test('v2 accepts the sessionID and task_id spellings in result mode', async () => {
    const h = makeResultTool(true, 'v2');
    expect(Object.keys(h.tool.args)).toContain('sessionID');
    expect(Object.keys(h.tool.args)).toContain('task_id');
    expect(Object.keys(h.tool.args)).toContain('result');
    await h.settle('completed');
    const context = {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as never;
    expect(
      await h.tool.execute({ sessionID: 'exp-1', result: true }, context),
    ).toBe('final findings');
    expect(
      await h.tool.execute({ task_id: 'exp-1', result: true }, context),
    ).toBe('final findings');
  });
  test('v2 emits sessionID: in pending result output and rejects an empty identifier', async () => {
    const h = makeResultTool(true, 'v2');
    h.status.mockResolvedValue({ data: { ses_child1: { type: 'busy' } } });
    const context = {
      sessionID: 'parent-1',
      agent: 'orchestrator',
    } as never;
    const output = await h.tool.execute(
      { sessionID: 'exp-1', result: true },
      context,
    );
    expect(String(output)).toContain('sessionID: ses_child1');
    await expect(
      h.tool.execute({ sessionID: ' ', result: true }, context),
    ).rejects.toThrow('requires sessionID');
  });
  test('status mode is unchanged when result is absent or false', async () => {
    const h = makeResultTool();
    h.status.mockResolvedValue({ data: { ses_child1: { type: 'busy' } } });
    for (const extra of [{}, { result: false }]) {
      const output = await h.tool.execute({ task_id: 'exp-1', ...extra }, {
        sessionID: 'parent-1',
      } as any);
      expect(String(output)).toContain('Task exp-1 (ses_child1)');
      expect(String(output)).toContain('state: busy');
    }
  });
});

/**
 * v2 hosts expose no live session-status map, so a tracked task stays
 * `running (unconfirmed)` on the board. The probe closes that gap: one
 * bounded host-info read for an attributable terminal outcome, fed through
 * the terminal gate's ordinary observe/reconcile API (the gate owns the
 * publication — this path NEVER calls board.commitTerminal).
 */
describe('task_status v2 terminal-outcome probe', () => {
  function makeProbeTool(
    options: {
      outcome?: string;
      idle?: number;
      resultFirstRead?: boolean;
      getFails?: boolean;
    } = {},
  ) {
    const board = new BackgroundJobBoard();
    const run = board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'probe',
      now: 1,
    });
    let getCalls = 0;
    const get = mock(async () => {
      if (options.getFails) throw new Error('host read failed');
      const idle =
        options.resultFirstRead && getCalls++ === 0 ? 0 : (options.idle ?? 5);
      return {
        data: {
          id: 'ses_child1',
          parentID: 'parent-1',
          ...(options.outcome !== undefined
            ? { outcome: options.outcome }
            : {}),
          time: { idle },
        },
      };
    });
    // v2 shape: session.get present, session.status deliberately absent.
    const input = {
      directory: '/test',
      client: { session: { get } },
      hostFlavor: 'v2',
    } as never;
    // The gate's own session-info read must share the host clock, as it does
    // in the plugin composition root. On result:true, the first gate read is
    // deliberately stale, so the classifier's fresh read is load-bearing.
    const gate = createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      input,
      hostOutcomeClock: 'shared-unix-ms',
    });
    statusGates.push(gate);
    const tool = createTaskStatusTool({
      input,
      backgroundJobBoard: board,
      terminalGate: gate,
      now: () => 1_000,
    });
    return { board, run, gate, get, tool };
  }

  const context = { sessionID: 'parent-1' } as never;

  test('a failing host-info read degrades to the unconfirmed reply instead of throwing', async () => {
    const h = makeProbeTool({ getFails: true });
    const output = await h.tool.task_status.execute(
      { task_id: 'exp-1' },
      context,
    );
    expect(String(output)).toContain('state: running (unconfirmed)');
    expect(String(output)).toContain('status_uncertain: true');
    const refusal = await h.tool.task_status.execute(
      { task_id: 'exp-1', result: true },
      context,
    );
    expect(String(refusal)).toContain('state: running (unconfirmed)');
  });

  test('a refused alias enumerates recent handles in both modes', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'probe',
      now: 1,
    });
    const { task_status } = makeTool({
      board,
      resolveCanonicalTaskRef: async () => ({
        kind: 'refused',
        reason: 'Unknown task ID or alias: fix-9',
      }),
    });
    for (const args of [
      { task_id: 'fix-9' },
      { task_id: 'fix-9', result: true },
    ]) {
      const error = (await task_status
        .execute(args, { sessionID: 'parent-1' } as never)
        .catch((e: Error) => e)) as Error;
      expect(error.message).toContain('Unknown task ID or alias: fix-9');
      expect(error.message).toContain('recent:');
    }
  });

  test('plain query publishes the terminal state from an attributable outcome', async () => {
    const h = makeProbeTool({ outcome: 'succeeded', idle: 5 });
    const output = await h.tool.task_status.execute(
      { task_id: 'exp-1' },
      context,
    );
    expect(String(output)).toContain('Task exp-1 (ses_child1)');
    expect(String(output)).toContain('state: completed');
    expect(String(output)).not.toContain('unconfirmed');
    expect(String(output)).not.toContain('status_uncertain');
    expect(h.board.get('ses_child1')).toMatchObject({
      state: 'completed',
      resultSummary: 'Host reported outcome: succeeded.',
    });
    // The classifier read and gate attribution read are separate by design.
    expect(h.get).toHaveBeenCalledTimes(2);
  });

  test('result:true retrieves the published result instead of refusing', async () => {
    const h = makeProbeTool({
      outcome: 'succeeded',
      idle: 5,
      resultFirstRead: true,
    });
    const output = await h.tool.task_status.execute(
      { task_id: 'exp-1', result: true },
      context,
    );
    expect(output).toBe('Host reported outcome: succeeded.');
    expect(h.board.get('ses_child1')?.state).toBe('completed');
    // Initial gate probe (stale idle), the classifier's read (reused by the
    // result ownership check), and the gate attribution read.
    expect(h.get).toHaveBeenCalledTimes(3);
  });

  test('interrupted publishes stopped and never becomes completed', async () => {
    const h = makeProbeTool({ outcome: 'interrupted', idle: 5 });
    const output = await h.tool.task_status.execute(
      { task_id: 'exp-1' },
      context,
    );
    expect(String(output)).toContain('state: stopped');
    expect(String(output)).not.toContain('state: completed');
    expect(h.board.get('ses_child1')).toMatchObject({
      state: 'stopped',
      resultSummary: 'Host reported outcome: interrupted.',
    });
    // The result read refuses: an interruption is not a completion.
    await expect(
      h.tool.task_status.execute({ task_id: 'exp-1', result: true }, context),
    ).rejects.toThrow('has no confirmed completed result');
  });

  test('failed publishes the error family', async () => {
    const h = makeProbeTool({ outcome: 'failed', idle: 5 });
    const output = await h.tool.task_status.execute(
      { task_id: 'exp-1' },
      context,
    );
    expect(String(output)).toContain('state: error');
    expect(h.board.get('ses_child1')).toMatchObject({
      state: 'error',
      resultSummary: 'Host reported outcome: failed.',
    });
  });

  test.each([
    [{ outcome: undefined, idle: undefined }, 'no host terminal outcome'],
    [{ outcome: 'cancelled', idle: 5 }, 'unrecognized host outcome'],
  ])(
    'an unattributable host read renders the unchanged uncertainty (%j)',
    async (hostInfo) => {
      const h = makeProbeTool(hostInfo as { outcome?: string; idle?: number });
      const output = await h.tool.task_status.execute(
        { task_id: 'exp-1' },
        context,
      );
      expect(String(output)).toContain('Task exp-1 (ses_child1)');
      expect(String(output)).toContain('state: running (unconfirmed)');
      expect(String(output)).toContain('status_uncertain: true');
      expect(String(output)).toContain(
        'next: state unconfirmed; await the completion notice, do not poll task_status.',
      );
      expect(String(output)).not.toContain(
        '[guidance]: The task is still running.',
      );
      expect(h.board.get('ses_child1')?.state).toBe('running');
    },
  );

  test('an unattributable host read keeps the result-mode refusal with push-not-poll guidance', async () => {
    const h = makeProbeTool();
    const output = await h.tool.task_status.execute(
      { task_id: 'exp-1', result: true },
      context,
    );
    expect(String(output)).toContain('state: running (unconfirmed)');
    expect(String(output)).toContain(
      'next: a completion notice will arrive; continue other work and do not poll task_status.',
    );
    expect(h.board.get('ses_child1')?.state).toBe('running');
  });

  test('a host read failure stays uncertain rather than throwing', async () => {
    const h = makeProbeTool();
    h.get.mockImplementation(async () => {
      throw new Error('session get failed');
    });
    const output = await h.tool.task_status.execute(
      { task_id: 'exp-1' },
      context,
    );
    expect(String(output)).toContain('state: running (unconfirmed)');
    expect(h.board.get('ses_child1')?.state).toBe('running');
  });
});

/**
 * Unknown-handle errors enumerate the parent's live handles so an alias typo
 * is recoverable from the error itself. The enumerated line must stay
 * parse-safe: alias + agent + state only, `recent: `-prefixed.
 */
describe('task_status unknown-handle enumeration', () => {
  const BANNED_PREFIXES = ['state:', 'Task ', 'task_id:', 'sessionID:'];

  function seededBoard(): BackgroundJobBoard {
    const board = new BackgroundJobBoard();
    const seeds: Array<{
      taskID: string;
      agent: string;
      state: 'running' | 'completed' | 'cancelled';
    }> = [
      { taskID: 'ses_a1', agent: 'fixer', state: 'completed' },
      { taskID: 'ses_a2', agent: 'fixer', state: 'running' },
      { taskID: 'ses_a3', agent: 'explorer', state: 'running' },
      { taskID: 'ses_a4', agent: 'explorer', state: 'cancelled' },
      { taskID: 'ses_a5', agent: 'oracle', state: 'completed' },
      { taskID: 'ses_a6', agent: 'fixer', state: 'running' },
    ];
    seeds.forEach((seed, index) => {
      board.registerLaunch({
        taskID: seed.taskID,
        parentSessionID: 'parent-1',
        agent: seed.agent,
        description: seed.taskID,
        now: index + 1,
      });
      if (seed.state !== 'running') {
        boardFixture.updateStatus(board, {
          taskID: seed.taskID,
          state: seed.state,
          resultSummary: seed.state,
          now: index + 1,
        });
      }
    });
    return board;
  }

  /** Last 5 by launchedAt: ses_a1 is evicted from the enumeration window. */
  const EXPECTED_RECENT =
    'recent: fix-2 fixer running; exp-1 explorer running; exp-2 explorer cancelled; ora-1 oracle completed; fix-3 fixer running';

  function assertParseSafe(recentLine: string | undefined): void {
    expect(recentLine).toBeDefined();
    for (const banned of BANNED_PREFIXES) {
      expect(recentLine?.startsWith(banned)).toBe(false);
    }
  }

  test('task_status enumerates the parent-scoped handles on an unknown ref', async () => {
    client = { session: {} };
    const board = seededBoard();
    const { task_status } = makeTool({ board });
    const error = await task_status
      .execute({ task_id: 'fix-9' }, { sessionID: 'parent-1' } as never)
      .catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Unknown task ID or alias: fix-9');
    expect(message).toContain(EXPECTED_RECENT);
    expect(message).not.toContain('ses_a');
    assertParseSafe(
      message.split('\n').find((line) => line.startsWith('recent: ')),
    );
  });

  test('the tool description documents the handle enumeration for a placeholder id', () => {
    const { task_status } = makeTool({ board: new BackgroundJobBoard() });
    const description = task_status.description ?? '';
    expect(description).toContain('unknown or placeholder task_id');
    expect(description).toContain('recent task handles');
    expect(description).toContain('recently finished sessions');
  });

  test('task_status keeps the bare unknown error with an empty board', async () => {
    client = { session: {} };
    const { task_status } = makeTool({ board: new BackgroundJobBoard() });
    const error = await task_status
      .execute({ task_id: 'fix-9' }, { sessionID: 'parent-1' } as never)
      .catch((thrown: Error) => thrown);
    expect((error as Error).message).toBe('Unknown task ID or alias: fix-9');
  });

  test('task_message enumerates the handles through the shared unknown-ref error', async () => {
    const board = seededBoard();
    const { task_message } = createTaskMessageTool({
      input: { directory: '/test', client: { session: {} } } as never,
      backgroundJobBoard: board,
    });
    const error = await task_message
      .execute({ task_id: 'fix-9', message: 'hello' }, {
        sessionID: 'parent-1',
      } as never)
      .catch((thrown: Error) => thrown);
    const message = (error as Error).message;
    expect(message).toContain('Unknown task ID or alias: fix-9');
    expect(message).toContain(EXPECTED_RECENT);
    expect(message).not.toContain('ses_a');
    assertParseSafe(
      message.split('\n').find((line) => line.startsWith('recent: ')),
    );
  });

  test('task_cancel enumerates the handles inside its unknown output', async () => {
    const board = seededBoard();
    const { task_cancel } = createCancelTaskTool({
      input: { directory: '/test', client: { session: {} } } as never,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    });
    const output = String(
      await task_cancel.execute({ task_id: 'fix-9' }, {
        sessionID: 'parent-1',
      } as never),
    );
    expect(output).toContain('task_id: fix-9');
    expect(output).toContain('state: unknown');
    expect(output).toContain(EXPECTED_RECENT);
    expect(output).not.toContain('ses_a');
    assertParseSafe(
      output.split('\n').find((line) => line.startsWith('recent: ')),
    );
  });

  test('the enumerated recent line never corrupts loop-guard taskID/state extraction', async () => {
    const board = seededBoard();
    const { task_cancel } = createCancelTaskTool({
      input: { directory: '/test', client: { session: {} } } as never,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    });
    const unknownOutput = String(
      await task_cancel.execute({ task_id: 'fix-9' }, {
        sessionID: 'parent-1',
      } as never),
    );
    const recentLine = unknownOutput
      .split('\n')
      .find((line) => line.startsWith('recent: '));
    assertParseSafe(recentLine);

    const hook = createToolLoopGuardHook();
    const feed = async (callID: string, output: string) => {
      await hook['tool.execute.before'](
        { tool: 'task_status', sessionID: 's1', callID },
        { args: { task_id: 'fix-9' } },
      );
      const result = { output, metadata: {} };
      await hook['tool.execute.after'](
        { tool: 'task_status', sessionID: 's1', callID },
        result,
      );
      return result;
    };
    // Identical header + state, different enumeration payloads: the stream
    // must still advance (the recent line is not part of the extraction).
    for (let i = 1; i <= 2; i++) {
      const result = await feed(
        `c${i}`,
        unknownOutput.replace(/recent: .*/, `recent: fix-${i} fixer completed`),
      );
      expect(String(result.output)).not.toContain(LOOP_GUARD_WARNING);
    }
    const third = await feed(
      'c3',
      unknownOutput.replace(/recent: .*/, 'recent: fix-3 fixer running'),
    );
    expect(String(third.output)).toContain(LOOP_GUARD_WARNING);

    // A real state change still resets the stream.
    const changed = await feed(
      'c4',
      unknownOutput.replace('state: unknown', 'state: running'),
    );
    expect(String(changed.output)).not.toContain(LOOP_GUARD_WARNING);
  });
});
