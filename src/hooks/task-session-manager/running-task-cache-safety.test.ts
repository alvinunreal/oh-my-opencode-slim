/**
 * Regression coverage for running background-task tool-result byte stability.
 *
 * While a background `task` lane runs, the runtime may stream live child
 * progress into the parent's task tool part (`state.output`). A still-running
 * task result sits mid-history, so any per-request change to it invalidates
 * the provider prompt cache from that byte onward, re-writing the entire tail
 * every request (a write-never-read loop).
 *
 * The transform hook must:
 *  (a) keep a running task part byte-identical across consecutive requests
 *      while the child progresses,
 *  (b) materialize the terminal result exactly once and keep it byte-stable
 *      afterwards, and
 *  (c) never produce duplicate completed results.
 */
import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../background-jobs';
import { DEFAULT_MAX_RETAINED_SNAPSHOTS } from '../../config/constants';
import { createTaskSessionManagerHook } from './index';

const SESSION = 'ses_orchestrator_1114';
const CHILD = 'ses_child_0771';

function createHook(board: BackgroundJobBoard) {
  return createTaskSessionManagerHook(
    {
      client: { session: { status: mock(async () => ({ data: {} })) } },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 4,
      maxRetainedSnapshots: DEFAULT_MAX_RETAINED_SNAPSHOTS,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    },
  );
}

/** A task tool call on an assistant message, mirroring the SDK part shape. */
function taskToolMessage(callID: string, output: string) {
  return {
    info: {
      role: 'assistant',
      agent: 'orchestrator',
      sessionID: SESSION,
      id: callID,
    },
    parts: [
      { type: 'text', text: ' ' },
      {
        type: 'tool',
        tool: 'task',
        callID,
        state: { status: 'running', input: { background: true }, output },
      },
    ],
  };
}

function userMessage(id: string, text: string) {
  return {
    info: { role: 'user', agent: 'orchestrator', sessionID: SESSION, id },
    parts: [{ type: 'text', text }],
  };
}

/** Grab the task tool part's rendered output from a transformed history. */
function taskOutput(messages: unknown[], callID: string): string | undefined {
  for (const message of messages as any[]) {
    for (const part of message?.parts ?? []) {
      if (
        part?.type === 'tool' &&
        part?.tool === 'task' &&
        part?.callID === callID
      ) {
        return part.state?.output as string | undefined;
      }
    }
  }
  return undefined;
}

async function transform(
  hook: ReturnType<typeof createTaskSessionManagerHook>,
  history: unknown[],
): Promise<unknown[]> {
  // prompt.ts rebuilds msgs from storage every request, so each transform
  // starts from a fresh clone of the real history.
  const request = { messages: structuredClone(history) };
  await hook['experimental.chat.messages.transform']({}, request as never);
  return request.messages;
}

// Core's running placeholder that grows with live child progress. In this
// runtime it is static, but the transform must be robust to a runtime that
// streams progress into it.
function runningOutput(snapshot: string): string {
  return [
    `<task id="${CHILD}" state="running">`,
    '<summary>Background task started</summary>',
    '<task_result>',
    snapshot,
    '</task_result>',
    '</task>',
  ].join('\n');
}

describe('running task tool-result cache safety', () => {
  test('(a) running task part is byte-identical across consecutive requests while the child progresses', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);

    // Two consecutive requests where the runtime streamed different live
    // progress snapshots into the same running task part.
    const history1 = [
      userMessage('u1', 'Coordinate the work'),
      taskToolMessage(
        'call-1',
        runningOutput('The task is working in the background... (711 bytes)'),
      ),
    ];
    const history2 = [
      userMessage('u1', 'Coordinate the work'),
      taskToolMessage(
        'call-1',
        runningOutput(
          'Progress snapshot: found 4 files, still working... (4132 bytes)',
        ),
      ),
    ];

    const out1 = await transform(hook, history1);
    const out2 = await transform(hook, history2);

    const o1 = taskOutput(out1, 'call-1');
    const o2 = taskOutput(out2, 'call-1');

    expect(o1).toBeDefined();
    expect(o2).toBeDefined();
    // Byte-identical despite different live snapshots — cache prefix preserved.
    expect(o2).toBe(o1 as string);
    // Deterministic placeholder keyed on the task ID, still parseable as running.
    expect(o1).toContain(`<task id="${CHILD}" state="running">`);
    expect(o1).not.toContain('4132 bytes');
    expect(o1).not.toContain('711 bytes');
  });

  test('(b) terminal result materializes once and then stays byte-stable', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);

    const completedOutput = [
      `<task id="${CHILD}" state="completed">`,
      '<summary>Background task completed: research grok models</summary>',
      '<task_result>',
      'Full research findings: repo uses xai/grok-imagine-image, latest is quality mode.',
      '</task_result>',
      '</task>',
    ].join('\n');

    // The completed tool part carries a real terminal result.
    const completedMessage = {
      info: {
        role: 'assistant',
        agent: 'orchestrator',
        sessionID: SESSION,
        id: 'call-1',
      },
      parts: [
        {
          type: 'tool',
          tool: 'task',
          callID: 'call-1',
          state: {
            status: 'completed',
            input: { background: true },
            output: completedOutput,
          },
        },
      ],
    };
    const history = [
      userMessage('u1', 'Coordinate the work'),
      completedMessage,
    ];

    const out1 = await transform(hook, history);
    const out2 = await transform(hook, history);

    const o1 = taskOutput(out1, 'call-1');
    const o2 = taskOutput(out2, 'call-1');

    // The terminal result must reach the orchestrator intact and unchanged.
    expect(o1).toBe(completedOutput);
    expect(o2).toBe(completedOutput);
    expect(o1).toContain('Full research findings');
  });

  test('(c) running → terminal transition mutates the part exactly once, no duplicate completed results', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);

    const completedOutput = [
      `<task id="${CHILD}" state="completed">`,
      '<summary>Background task completed: research grok models</summary>',
      '<task_result>',
      'Final result body.',
      '</task_result>',
      '</task>',
    ].join('\n');

    // Turn 1 & 2: running (byte-stable). Turn 3: completed.
    const runningHistory = [
      userMessage('u1', 'Coordinate the work'),
      taskToolMessage('call-1', runningOutput('snapshot A')),
    ];
    const runningHistory2 = [
      userMessage('u1', 'Coordinate the work'),
      taskToolMessage('call-1', runningOutput('snapshot B — bigger')),
    ];
    const terminalHistory = [
      userMessage('u1', 'Coordinate the work'),
      {
        info: {
          role: 'assistant',
          agent: 'orchestrator',
          sessionID: SESSION,
          id: 'call-1',
        },
        parts: [
          {
            type: 'tool',
            tool: 'task',
            callID: 'call-1',
            state: {
              status: 'completed',
              input: { background: true },
              output: completedOutput,
            },
          },
        ],
      },
    ];

    const r1 = taskOutput(await transform(hook, runningHistory), 'call-1');
    const r2 = taskOutput(await transform(hook, runningHistory2), 'call-1');
    const outTerminal = await transform(hook, terminalHistory);
    const t3 = taskOutput(outTerminal, 'call-1');
    const t4 = taskOutput(await transform(hook, terminalHistory), 'call-1');

    // Running requests are byte-identical; the single mutation is running→terminal.
    expect(r2).toBe(r1 as string);
    expect(r1).not.toBe(t3);
    // Terminal stays stable afterwards (no further mutation).
    expect(t4).toBe(t3 as string);
    expect(t3).toBe(completedOutput);

    // No duplicate completed results anywhere in the payload.
    const completedCount = (outTerminal as any[])
      .flatMap((m) => m?.parts ?? [])
      .filter(
        (p: any) =>
          p?.type === 'tool' &&
          p?.tool === 'task' &&
          typeof p?.state?.output === 'string' &&
          p.state.output.includes('state="completed"'),
      ).length;
    expect(completedCount).toBe(1);
  });

  test('foreground (non-background) running task parts are also stabilized deterministically', async () => {
    // Defensive: a running task part with no background flag still normalizes
    // to the deterministic placeholder (only terminal results are preserved).
    const board = new BackgroundJobBoard();
    const hook = createHook(board);

    const message = {
      info: {
        role: 'assistant',
        agent: 'orchestrator',
        sessionID: SESSION,
        id: 'call-1',
      },
      parts: [
        {
          type: 'tool',
          tool: 'task',
          callID: 'call-1',
          state: {
            status: 'running',
            input: {},
            output: runningOutput('live snapshot'),
          },
        },
      ],
    };

    const out = await transform(hook, [userMessage('u1', 'go'), message]);
    const o = taskOutput(out, 'call-1');
    expect(o).toContain(`<task id="${CHILD}" state="running">`);
    expect(o).not.toContain('live snapshot');
  });
});
