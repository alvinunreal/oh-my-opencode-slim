import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { DEFAULT_MAX_RETAINED_SNAPSHOTS } from '../../config/constants';
import { SessionLifecycle } from '../../hooks/session-lifecycle';
import {
  BackgroundJobBoard,
  BackgroundJobSupervisor,
  createInternalAgentTextPart,
  SLIM_INTERNAL_INITIATOR_MARKER,
} from '../../utils';
import {
  createPhaseReminderHook,
  PHASE_REMINDER_METADATA_KEY,
} from '../phase-reminder';
import { createPostFileToolNudgeHook } from '../post-file-tool-nudge';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  createTaskSessionManagerHook,
} from './index';
import { resetUserWaitGateForTests } from './user-wait-gate';

// Route getClient back to _ctx.client so existing _ctx.client.session
// mocks continue to work through the new v2 lookup path.
mock.module('../../utils/opencode-client', () => ({
  getClient: (input: { client: unknown }) => input.client as never,
}));

/** Wait for the idle reconciliation delay (2s + margin) to flush. */
function flushIdleReconcileDelay() {
  return new Promise((resolve) => setTimeout(resolve, 2100));
}

async function flushContinuation(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Flush delayed child idle-reconcile timers when idleReconcileDelayMs is 0. */
async function flushChildIdleReconcile(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function createSupervisorClock() {
  let now = 0;
  let nextID = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const setTimeout = (callback: () => void, delay: number) => {
    const id = ++nextID;
    timers.set(id, { at: now + delay, callback });
    return id;
  };
  const clearTimeout = (id: number) => timers.delete(id);
  const advanceTo = async (target: number) => {
    now = target;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (!due) break;
      timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
    }
  };

  return { now: () => now, setTimeout, clearTimeout, advanceTo };
}

function taskLaunchOutput(taskID: string): string {
  return [
    `task_id: ${taskID}`,
    'state: running',
    '',
    '<task_result>',
    'Background task started.',
    '</task_result>',
  ].join('\n');
}

function historicalRunningTaskPart(
  taskID: string,
  input: Record<string, unknown> = {
    background: true,
    subagent_type: 'explorer',
    description: 'recover scheduler task',
    prompt: 'inspect scheduler state',
  },
) {
  return {
    type: 'tool',
    tool: 'task',
    state: {
      status: 'running',
      input,
      output: taskLaunchOutput(taskID),
    },
  };
}

type HookOptions = {
  shouldManageSession?: (sessionID: string) => boolean;
  registerSessionAsOrchestrator?: (sessionID: string) => void;
  readContextMinLines?: number;
  readContextMaxFiles?: number;
  strategy?: 'latest' | 'checkpoint-compatible';
  maxRetainedSnapshots?: number;
  backgroundJobBoard?: BackgroundJobBoard;
  managedTaskSessionIDs?: Set<string>;
  sessionStatus?: unknown;
  sessionClient?: Record<string, unknown>;
  idleReconcileDelayMs?: number;
  runtimeStatusReconcileDelayMs?: number;
  isFallbackInProgress?: (sessionID: string) => boolean;
  willAttemptFallback?: (sessionID: string) => boolean;
  coordinator?: SessionLifecycle;
  backgroundJobSupervisor?: BackgroundJobSupervisor;
};

function createHook(options?: HookOptions) {
  const hook = createTaskSessionManagerHook(
    {
      client: {
        session: {
          status: mock(async () => ({ data: options?.sessionStatus ?? {} })),
          ...options?.sessionClient,
        },
      },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 2,
      maxRetainedSnapshots:
        options?.maxRetainedSnapshots ?? DEFAULT_MAX_RETAINED_SNAPSHOTS,
      strategy: options?.strategy,
      readContextMinLines: options?.readContextMinLines,
      readContextMaxFiles: options?.readContextMaxFiles,
      backgroundJobBoard: options?.backgroundJobBoard,
      managedTaskSessionIDs: options?.managedTaskSessionIDs,
      backgroundJobSupervisor: options?.backgroundJobSupervisor,
      shouldManageSession: options?.shouldManageSession ?? (() => true),
      registerSessionAsOrchestrator: options?.registerSessionAsOrchestrator,
      isFallbackInProgress: options?.isFallbackInProgress,
      willAttemptFallback: options?.willAttemptFallback,
      coordinator: options?.coordinator,
      idleReconcileDelayMs: options?.idleReconcileDelayMs,
      runtimeStatusReconcileDelayMs: options?.runtimeStatusReconcileDelayMs,
    },
  );

  return { hook };
}

function createMessages(sessionID: string, text = 'user message') {
  return {
    messages: [
      {
        info: { role: 'user', agent: 'orchestrator', sessionID },
        parts: [{ type: 'text', text }],
      },
    ],
  };
}

function createAnchoredMessages(sessionID: string, texts = ['R1']) {
  return {
    messages: texts.map((text, index) => ({
      info: {
        id: `message-${index}`,
        role: index === texts.length - 1 ? 'user' : 'assistant',
        agent: index === texts.length - 1 ? 'orchestrator' : undefined,
        sessionID,
      },
      parts: [{ type: 'text', text }],
    })),
  };
}

function boardText(messages: { messages: unknown[] }): string | undefined {
  // The board is injected as a trailing tagged PART on the last message
  // (keeping the message count stable so the provider's tail cache
  // breakpoint lands on stable real content). It is always the last part.
  const last = messages.messages.at(-1) as
    | {
        parts?: {
          text?: string;
          metadata?: Record<string, unknown>;
        }[];
      }
    | undefined;
  const part = last?.parts?.at(-1);
  return part?.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] === true
    ? part.text
    : undefined;
}

function isBoardPartForTest(part: { metadata?: Record<string, unknown> }) {
  return part.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] === true;
}

function boardSnapshotIDs(messages: { messages: unknown[] }): string[] {
  return messages.messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      isBoardPartForTest(part) && typeof part.metadata?.snapshotID === 'string'
        ? [part.metadata.snapshotID]
        : [],
    ),
  );
}

async function transformMessages(
  hook: ReturnType<typeof createTaskSessionManagerHook>,
  messages: { messages: unknown[] },
) {
  await hook['experimental.chat.messages.transform']({}, messages as never);
  await hook.injectBackgroundJobBoard({}, messages as never);
}

function setupCompletedJob(
  board: BackgroundJobBoard,
  opts?: { taskID?: string; parentSessionID?: string },
) {
  const taskID = opts?.taskID ?? 'child-1';
  const parentSessionID = opts?.parentSessionID ?? 'parent-1';
  board.registerLaunch({
    taskID,
    parentSessionID,
    agent: 'oracle',
    description: 'review plan',
  });
  board.updateStatus({ taskID, state: 'completed', resultSummary: 'done' });
}

describe('task-session-manager hook', () => {
  beforeEach(() => {
    // Process-global gate only — never reset inside createHook/production paths.
    resetUserWaitGateForTests();
  });

  test('tracks background child sessions before task output registration', async () => {
    const managedTaskSessionIDs = new Set<string>();
    const { hook } = createHook({
      managedTaskSessionIDs,
      shouldManageSession: () => false,
    });

    await hook.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-1', parentID: 'parent-1' } },
      },
    });

    expect(managedTaskSessionIDs.has('child-1')).toBe(true);
  });

  test('ignores messages without OpenCode info or parts', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map scheduler hooks',
    });
    const { hook } = createHook({ backgroundJobBoard: board });
    const messages = {
      messages: [
        {},
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
        },
        { parts: [{ type: 'text', text: 'missing info' }] },
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'assistant response' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [{ type: 'text', text: 'valid user message' }],
        },
      ],
    };

    await transformMessages(hook, messages as never);

    // Board is appended as a trailing part on the last user message, not as a
    // new message, so the message count is unchanged.
    expect(messages.messages).toHaveLength(5);
    expect(boardText(messages)).toContain('### Background Job Board');
    expect(boardText(messages)).toContain(
      'exp-1 / child-1 / explorer / running',
    );
  });

  test('rehydrates historical background tasks and reconciles stopped children immediately', async () => {
    const board = new BackgroundJobBoard();
    const status = mock(async () => ({ data: {} }));
    const { hook } = createHook({
      backgroundJobBoard: board,
      sessionClient: { status },
      runtimeStatusReconcileDelayMs: 60_000,
    });
    const messages = {
      messages: [
        {
          info: {
            role: 'assistant',
            sessionID: 'parent-1',
          },
          parts: [historicalRunningTaskPart('historical-child')],
        },
        ...createMessages('parent-1', 'continue').messages,
      ],
    };

    await transformMessages(hook, messages as never);

    expect(board.get('historical-child')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
      background: true,
      agent: 'explorer',
      description: 'recover scheduler task',
      objective: 'recover scheduler task',
    });
    expect(boardText(messages)).toContain(
      'historical-child / explorer / stopped, unreconciled',
    );
  });

  test('rehydrates a completed tool call when its child output is still running', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      sessionStatus: {},
      runtimeStatusReconcileDelayMs: 60_000,
    });
    const taskPart = historicalRunningTaskPart('completed-call-child');
    taskPart.state.status = 'completed';
    const messages = {
      messages: [
        {
          info: { role: 'assistant', sessionID: 'parent-1' },
          parts: [taskPart],
        },
        ...createMessages('parent-1', 'continue').messages,
      ],
    };

    await transformMessages(hook, messages as never);

    expect(board.get('completed-call-child')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
    });
  });

  test('consumes historical terminal completion before restart reconciliation', async () => {
    const board = new BackgroundJobBoard();
    const status = mock(async () => ({ data: {} }));
    const { hook } = createHook({
      backgroundJobBoard: board,
      sessionClient: { status },
      runtimeStatusReconcileDelayMs: 60_000,
    });
    const messages = {
      messages: [
        {
          info: { role: 'assistant', sessionID: 'parent-1' },
          parts: [historicalRunningTaskPart('completed-child')],
        },
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                '<task id="completed-child" state="completed">',
                '<summary>Background task completed: recovered</summary>',
                '<task_result>',
                'historical result',
                '</task_result>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
        ...createMessages('parent-1', 'continue').messages,
      ],
    };

    await transformMessages(hook, messages as never);

    expect(board.get('completed-child')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'historical result',
    });
    expect(status).not.toHaveBeenCalled();
  });

  test('keeps a rehydrated child running when live status is busy', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      sessionStatus: { 'historical-child': { type: 'busy' } },
      runtimeStatusReconcileDelayMs: 60_000,
    });
    const messages = {
      messages: [
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [historicalRunningTaskPart('historical-child')],
        },
        ...createMessages('parent-1', 'continue').messages,
      ],
    };

    await transformMessages(hook, messages as never);
    expect(board.get('historical-child')).toMatchObject({
      state: 'running',
      statusUncertain: false,
    });
    expect(boardText(messages)).toContain(
      'historical-child / explorer / running',
    );
  });

  test('ignores foreground, terminal, and malformed historical task parts', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    const messages = {
      messages: [
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [
            historicalRunningTaskPart('foreground-child', {
              background: false,
              subagent_type: 'explorer',
            }),
            {
              ...historicalRunningTaskPart('terminal-child'),
              state: {
                ...historicalRunningTaskPart('terminal-child').state,
                status: 'completed',
                output: [
                  'task_id: terminal-child',
                  'state: completed',
                  '',
                  '<task_result>',
                  'done',
                  '</task_result>',
                ].join('\n'),
              },
            },
            historicalRunningTaskPart('missing-id', {
              background: true,
              subagent_type: 'explorer',
            }),
          ],
        },
        ...createMessages('parent-1', 'continue').messages,
      ],
    };
    (
      messages.messages[0].parts[2] as { state: { output: string } }
    ).state.output = 'state: running\nmalformed output';

    await transformMessages(hook, messages as never);

    expect(board.list()).toHaveLength(0);
  });

  test('rehydration is idempotent across repeated transforms', async () => {
    const board = new BackgroundJobBoard();
    const status = mock(async () => ({ data: {} }));
    const { hook } = createHook({
      backgroundJobBoard: board,
      sessionClient: { status },
      runtimeStatusReconcileDelayMs: 60_000,
    });
    const messages = {
      messages: [
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [historicalRunningTaskPart('historical-child')],
        },
        ...createMessages('parent-1', 'continue').messages,
      ],
    };

    await transformMessages(hook, messages as never);
    const first = board.get('historical-child');
    await transformMessages(hook, messages as never);
    const second = board.get('historical-child');

    expect(second).toMatchObject({
      alias: first?.alias,
      generation: first?.generation,
      state: 'stopped',
    });
    expect(status).toHaveBeenCalledTimes(1);
  });

  test('stores background task launches in job board prompt context', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          background: true,
          description: 'map scheduler hooks',
          prompt: 'inspect scheduler hooks',
        },
      },
    );

    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output: [
          'task_id: child-1',
          'state: running',
          '',
          '<task_result>',
          'Background task started.',
          '</task_result>',
        ].join('\n'),
      },
    );

    const messages = createMessages('parent-1', 'do something');
    await hook.injectBackgroundJobBoard({}, messages);

    // Board is appended as a trailing part on the last (only) user message.
    // The message count is unchanged; the real text part is preserved and the
    // board part follows it.
    const userMessage = messages.messages[0];
    expect(messages.messages).toHaveLength(1);
    expect(userMessage.parts).toHaveLength(2);
    expect(userMessage.parts[0].text).toBe('do something');
    const boardMessage = messages.messages.at(-1) as {
      info: { role?: string; sessionID?: string };
      parts: { text?: string; synthetic?: boolean }[];
    };
    expect(boardMessage.info.role).toBe('user');
    expect(boardMessage.info.sessionID).toBe('parent-1');
    const boardPart = boardMessage.parts.at(-1) as {
      text?: string;
      synthetic?: boolean;
    };
    expect(boardPart.text).toContain('### Background Job Board');
    expect(boardPart.synthetic).toBe(true);
    expect(boardPart).toMatchObject({
      metadata: { [BACKGROUND_JOB_BOARD_METADATA_KEY]: true },
    });
    expect(boardPart.text).toStartWith('<system-reminder>');
    expect(boardPart.text).toEndWith('</system-reminder>');
    expect(boardPart.text).toContain('exp-1 / child-1 / explorer / running');
    expect(boardPart.text).toContain('Objective: map scheduler hooks');
  });

  test('records background=true explicitly and leaves foreground launches unsupervised', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    for (const [callID, taskID, background] of [
      ['background-call', 'background-child', true],
      ['foreground-call', 'foreground-child', false],
    ] as const) {
      await hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID },
        {
          args: {
            subagent_type: 'explorer',
            background,
            description: taskID,
          },
        },
      );
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'parent-1', callID },
        {
          output: [
            `task_id: ${taskID}`,
            'state: running',
            '',
            '<task_result>',
            'started',
            '</task_result>',
          ].join('\n'),
        },
      );
    }

    expect(board.get('background-child')?.background).toBe(true);
    expect(board.get('foreground-child')?.background).toBe(false);
  });

  test('does not let user-visible sentinel text suppress board injection', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    const { hook } = createHook({ backgroundJobBoard: board });
    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: 'SENTINEL: background-job-board-v2',
            },
          ],
        },
      ],
    };

    await hook.injectBackgroundJobBoard({}, messages);

    expect(boardText(messages)).toContain(
      'exp-1 / child-1 / explorer / running',
    );
    // The real sentinel-bearing part is preserved; the board is appended after
    // it as a trailing part on the same (last) message.
    expect(messages.messages[0].parts).toHaveLength(2);
    expect(messages.messages[0].parts[0].text).toBe(
      'SENTINEL: background-job-board-v2',
    );
  });

  test('does not duplicate board part after JSON persistence', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    const { hook } = createHook({ backgroundJobBoard: board });
    const messages = createMessages('parent-1', 'continue');

    await hook.injectBackgroundJobBoard({}, messages);
    messages.messages = JSON.parse(JSON.stringify(messages.messages));
    await hook.injectBackgroundJobBoard({}, messages);

    const boardMessages = messages.messages.filter((message) =>
      message.parts.some((part) =>
        part.text?.includes('### Background Job Board'),
      ),
    );
    expect(boardMessages).toHaveLength(1);
    expect(messages.messages.at(-1)).toBe(boardMessages[0]);
  });

  test('strips the tail board and re-appends the latest state on the new tail', async () => {
    // Production never sees a board in storage (synthetic parts are not
    // persisted), so the tail board from the previous request is the only one
    // present and is stripped in place before re-injection.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    const { hook } = createHook({ backgroundJobBoard: board });
    const messages = createMessages('parent-1', 'first turn');

    // Simulate the realistic path: the board is transient, so a fresh request
    // rebuilds real messages only and the tail (now "second turn") carries the
    // previous board as its trailing part before re-injection.
    await hook.injectBackgroundJobBoard({}, messages);
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'finished mapping',
    });

    await hook.injectBackgroundJobBoard({}, messages);

    const boardParts = messages.messages.flatMap((message) =>
      message.parts.filter(
        (part) => part.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] === true,
      ),
    );
    // The stale tail board is stripped and exactly one fresh board remains.
    expect(boardParts).toHaveLength(1);
    expect(boardParts[0].text).toContain('completed, unreconciled');
    // Board is the last part of the last (real) message; the real text part is
    // preserved before it.
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0].parts).toHaveLength(2);
    expect(messages.messages[0].parts[0].text).toBe('first turn');
    expect(messages.messages.at(-1)?.parts.at(-1)).toBe(boardParts[0]);
  });

  test('leaves a genuinely mid-history stale board untouched (cache invariant)', async () => {
    // If a board is found mid-history (e.g. a legacy/persisted block), removing
    // it would rewrite already-sent bytes and bust the whole tail. It is left
    // in place; the fresh board is appended to the current tail.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    const { hook } = createHook({ backgroundJobBoard: board });
    const messages = createMessages('parent-1', 'first turn');

    await hook.injectBackgroundJobBoard({}, messages);
    // A NEW real message arrives after the previous board, pushing it
    // mid-history (this only happens if a board was persisted into storage).
    messages.messages.push({
      info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
      parts: [{ type: 'text', text: 'second turn' }],
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'finished mapping',
    });

    await hook.injectBackgroundJobBoard({}, messages);

    // The mid-history board (on message[0]) is preserved; a fresh board is
    // appended to the current tail (message[1]).
    expect(messages.messages[0].parts.at(-1)?.text).toContain('running');
    const tailBoard = messages.messages.at(-1)?.parts.at(-1);
    expect(tailBoard?.text).toContain('completed, unreconciled');
    expect(messages.messages.at(-1)?.parts[0].text).toBe('second turn');
  });

  test('latest mode ignores maxRetainedSnapshots and replaces the board', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      maxRetainedSnapshots: 1,
    });
    const messages = createMessages('parent-1', 'first turn');

    await hook.injectBackgroundJobBoard({}, messages);
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'finished mapping',
    });

    // Re-injecting on the same tail strips the previous tail board and
    // re-appends the updated state — no retained snapshots in latest mode.
    await hook.injectBackgroundJobBoard({}, messages);

    expect(boardSnapshotIDs(messages)).toHaveLength(0);
    const boardParts = messages.messages.flatMap((message) =>
      message.parts.filter(
        (part) => part.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] === true,
      ),
    );
    expect(boardParts).toHaveLength(1);
    expect(boardParts[0].text).toContain('completed, unreconciled');
    expect(messages.messages.at(-1)?.parts.at(-1)).toBe(boardParts[0]);
  });

  test('leaves a JSON-persisted mid-history board message untouched (cache invariant)', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    const { hook } = createHook({ backgroundJobBoard: board });
    const messages = createMessages('parent-1', 'earlier turn');

    await hook.injectBackgroundJobBoard({}, messages);
    const persistedBoard = JSON.parse(
      JSON.stringify(messages.messages.at(-1)?.parts.at(-1)),
    );
    // A board persisted mid-history (not at the tail): stripping it would
    // rewrite already-sent bytes, so it must be left in place.
    messages.messages = [
      {
        info: { role: 'assistant' },
        parts: [persistedBoard],
      },
      {
        info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
        parts: [{ type: 'text', text: 'current turn' }],
      },
    ];

    await hook.injectBackgroundJobBoard({}, messages);

    // Mid-history board message preserved; fresh board appended to the tail.
    expect(messages.messages).toHaveLength(2);
    expect(messages.messages[0].parts[0].metadata).toEqual({
      [BACKGROUND_JOB_BOARD_METADATA_KEY]: true,
    });
    expect(messages.messages[1].parts[0].text).toBe('current turn');
    expect(messages.messages[1].parts.at(-1)?.metadata).toEqual({
      [BACKGROUND_JOB_BOARD_METADATA_KEY]: true,
    });
  });

  test('preserves prior board snapshots in checkpoint-compatible mode', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      strategy: 'checkpoint-compatible',
    });
    const messages = createMessages('parent-1', 'first turn');

    await hook.injectBackgroundJobBoard({}, messages);
    messages.messages.push({
      info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
      parts: [{ type: 'text', text: 'second turn' }],
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'finished mapping',
    });

    await hook.injectBackgroundJobBoard({}, messages);

    const boardParts = messages.messages.flatMap((message) =>
      message.parts.filter(
        (part) => part.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] === true,
      ),
    );
    expect(boardParts).toHaveLength(2);
    expect(boardParts[0].text).toContain('running');
    expect(boardParts[1].text).toContain('completed, unreconciled');
    expect(messages.messages.at(-1)?.parts[0]).toBe(boardParts[1]);
  });

  test('does not append an unchanged board in checkpoint-compatible mode', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      strategy: 'checkpoint-compatible',
    });
    const messages = createMessages('parent-1');

    await hook.injectBackgroundJobBoard({}, messages);
    await hook.injectBackgroundJobBoard({}, messages);

    const boardParts = messages.messages.flatMap((message) =>
      message.parts.filter(
        (part) => part.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] === true,
      ),
    );
    expect(boardParts).toHaveLength(1);
    expect(messages.messages.at(-1)?.parts[0]).toBe(boardParts[0]);
  });

  test('clears checkpoint snapshots when a session is recreated', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      strategy: 'checkpoint-compatible',
    });

    await hook.injectBackgroundJobBoard(
      {},
      createMessages('parent-1', 'same anchor'),
    );
    await hook.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'parent-1' } },
      },
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'finished',
    });

    const resetRequest = createMessages('parent-1', 'same anchor');
    await hook.injectBackgroundJobBoard({}, resetRequest);

    expect(
      resetRequest.messages.filter((message) =>
        message.parts.some((part) => isBoardPartForTest(part)),
      ),
    ).toHaveLength(1);
    expect(boardText(resetRequest)).toContain('completed, unreconciled');
  });

  test('clears checkpoint snapshots when a session is deleted', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      strategy: 'checkpoint-compatible',
    });

    await hook.injectBackgroundJobBoard(
      {},
      createMessages('parent-1', 'same anchor'),
    );
    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'parent-1' },
      },
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'finished',
    });

    const resetRequest = createMessages('parent-1', 'same anchor');
    await hook.injectBackgroundJobBoard({}, resetRequest);

    expect(
      resetRequest.messages.filter((message) =>
        message.parts.some((part) => isBoardPartForTest(part)),
      ),
    ).toHaveLength(1);
    expect(boardText(resetRequest)).toContain('completed, unreconciled');
  });

  test('retains checkpoint snapshots across fresh storage-derived message arrays', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      strategy: 'checkpoint-compatible',
      idleReconcileDelayMs: 0,
    });
    const firstRequest = createMessages('parent-1', 'first turn');

    await transformMessages(hook, firstRequest);
    const storedMessages = JSON.parse(
      JSON.stringify(
        firstRequest.messages.filter(
          (message) =>
            !message.parts?.some(
              (part) =>
                part.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] === true,
            ),
        ),
      ),
    );

    const secondRequest = { messages: storedMessages };
    await transformMessages(hook, secondRequest);

    const boardParts = secondRequest.messages.flatMap((message) =>
      message.parts.filter(
        (part) => part.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] === true,
      ),
    );
    expect(boardParts).toHaveLength(1);
    expect(boardParts[0].text).toContain('completed, unreconciled');
    expect(boardParts[0].synthetic).toBe(true);

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    await flushContinuation();

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('replays snapshots immediately after their anchors in fresh arrays', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      strategy: 'checkpoint-compatible',
      idleReconcileDelayMs: 0,
    });
    const first = createAnchoredMessages('parent-1', ['R1']);

    await hook.injectBackgroundJobBoard({}, first);
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
    });

    const second = {
      messages: createAnchoredMessages('parent-1', ['R1', 'A1', 'U2']).messages,
    };
    await hook.injectBackgroundJobBoard({}, second);
    const order = second.messages.flatMap((message) =>
      message.parts.map((part) => part.text),
    );

    expect(order).toEqual([
      'R1',
      expect.stringContaining('running'),
      'A1',
      'U2',
      expect.stringContaining('completed, unreconciled'),
    ]);

    const third = { messages: JSON.parse(JSON.stringify(second.messages)) };
    await hook.injectBackgroundJobBoard({}, third);
    expect(
      third.messages.filter((message) =>
        message.parts.some((part) => isBoardPartForTest(part)),
      ),
    ).toHaveLength(2);

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    await flushContinuation();
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('reconciles terminal jobs after the first changed checkpoint snapshot', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      strategy: 'checkpoint-compatible',
      idleReconcileDelayMs: 0,
    });

    await hook.injectBackgroundJobBoard({}, createMessages('parent-1'));
    expect(board.get('child-1')?.terminalUnreconciled).toBe(true);

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    await flushContinuation();

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('resets checkpoint snapshots after compaction', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      strategy: 'checkpoint-compatible',
    });
    const first = createMessages('parent-1', 'before compaction');
    await hook.injectBackgroundJobBoard({}, first);

    const compacted = createMessages('parent-1', 'compacted history');
    await hook.injectBackgroundJobBoard({}, compacted);

    expect(
      compacted.messages.filter((message) =>
        message.parts.some((part) => isBoardPartForTest(part)),
      ),
    ).toHaveLength(1);
  });

  test('starts a new checkpoint cache epoch at the snapshot limit', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      strategy: 'checkpoint-compatible',
    });

    const history: string[] = ['root'];
    for (let turn = 0; turn < 20; turn += 1) {
      // Register a distinct job for each turn
      const taskID = `child-${turn}`;
      board.registerLaunch({
        taskID,
        parentSessionID: 'parent-1',
        agent: 'explorer',
        description: `map hooks turn ${turn}`,
      });
      // Complete the job immediately
      board.updateStatus({
        taskID,
        state: 'completed',
        resultSummary: `result-${turn}`,
      });
      history.push(`turn-${turn}`);
      const request = createAnchoredMessages('parent-1', history);
      await hook.injectBackgroundJobBoard({}, request);

      if (turn === 19) {
        expect(boardSnapshotIDs(request)).toHaveLength(20);
        expect(boardSnapshotIDs(request)[0]).toEndWith(':0');
        expect(boardSnapshotIDs(request)[19]).toEndWith(':19');
      }
    }

    history.push('epoch-2-turn-1');
    // Register and complete first job in epoch 2
    board.registerLaunch({
      taskID: 'child-20',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks epoch 2 turn 1',
    });
    board.updateStatus({
      taskID: 'child-20',
      state: 'completed',
      resultSummary: 'epoch-2-result-1',
    });
    const epochStart = createAnchoredMessages('parent-1', history);
    await hook.injectBackgroundJobBoard({}, epochStart);
    expect(boardSnapshotIDs(epochStart)).toHaveLength(1);
    expect(boardSnapshotIDs(epochStart)[0]).toEndWith(':20');

    history.push('epoch-2-turn-2');
    // Register and complete second job in epoch 2
    board.registerLaunch({
      taskID: 'child-21',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks epoch 2 turn 2',
    });
    board.updateStatus({
      taskID: 'child-21',
      state: 'completed',
      resultSummary: 'epoch-2-result-2',
    });
    const secondEpochRequest = createAnchoredMessages('parent-1', history);
    await hook.injectBackgroundJobBoard({}, secondEpochRequest);
    expect(boardSnapshotIDs(secondEpochRequest)).toHaveLength(2);
    expect(boardSnapshotIDs(secondEpochRequest)[0]).toEndWith(':20');
    expect(boardSnapshotIDs(secondEpochRequest)[1]).toEndWith(':21');
  });

  test('strips the tail board when no jobs produce a prompt, leaving mid-history', async () => {
    const { hook } = createHook({
      backgroundJobBoard: new BackgroundJobBoard(),
    });
    const staleBoard = () => ({
      type: 'text',
      synthetic: true,
      text: '<system-reminder>stale</system-reminder>',
      metadata: { [BACKGROUND_JOB_BOARD_METADATA_KEY]: true },
    });
    const messages = {
      messages: [
        { info: { role: 'assistant' }, parts: [staleBoard()] },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [{ type: 'text', text: 'current turn' }, staleBoard()],
        },
      ],
    };

    await hook.injectBackgroundJobBoard({}, messages);

    // With no jobs there is nothing to inject. The tail board part is stripped
    // from the last message; the mid-history board message is left untouched
    // (removing it would rewrite already-sent bytes).
    expect(messages.messages).toHaveLength(2);
    expect(messages.messages[0].parts[0].metadata).toEqual({
      [BACKGROUND_JOB_BOARD_METADATA_KEY]: true,
    });
    expect(messages.messages[1].parts).toEqual([
      { type: 'text', text: 'current turn' },
    ]);
  });

  test('appends one board after a phase reminder on repeated transforms', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    const { hook } = createHook({ backgroundJobBoard: board });
    const phaseReminder = createPhaseReminderHook({
      shouldInject: () => true,
    });
    const messages = createMessages('parent-1', 'current turn');

    await phaseReminder['experimental.chat.messages.transform']({}, messages);
    await hook.injectBackgroundJobBoard({}, messages);

    // Next request: opencode rebuilds the array from storage. Transient
    // board messages are gone, but parts pushed onto shared message
    // objects (phase reminder) may linger.
    const nextRequest = { messages: [messages.messages[0]] };
    await phaseReminder['experimental.chat.messages.transform'](
      {},
      nextRequest,
    );
    await hook.injectBackgroundJobBoard({}, nextRequest);

    // The board is a trailing PART on the last (only) message, so the message
    // count stays 1. The previous tail board part is stripped and re-appended,
    // leaving exactly one board — the last part of the message.
    const parts = nextRequest.messages[0].parts;
    expect(
      parts.filter(
        (part) => part.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] === true,
      ),
    ).toHaveLength(1);
    expect(nextRequest.messages).toHaveLength(1);
    expect(parts.at(-1)?.metadata).toEqual({
      [BACKGROUND_JOB_BOARD_METADATA_KEY]: true,
    });
    // The phase reminder is preserved (immediately before the board).
    expect(parts.at(-2)?.metadata).toEqual({
      [PHASE_REMINDER_METADATA_KEY]: true,
    });
  });

  test('does not let user-visible internal marker suppress board injection', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    const { hook } = createHook({ backgroundJobBoard: board });
    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: SLIM_INTERNAL_INITIATOR_MARKER,
            },
          ],
        },
      ],
    };

    await hook.injectBackgroundJobBoard({}, messages);

    expect(boardText(messages)).toContain(
      'exp-1 / child-1 / explorer / running',
    );
    // The original marker-bearing part is preserved; the board is appended
    // after it as a trailing part on the same message.
    expect(messages.messages[0].parts).toHaveLength(2);
    expect(messages.messages[0].parts[0].text).toBe(
      SLIM_INTERNAL_INITIATOR_MARKER,
    );
  });

  test('does not inject board context into persisted internal turns', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    const { hook } = createHook({ backgroundJobBoard: board });
    const internalPart = JSON.parse(
      JSON.stringify(createInternalAgentTextPart('internal notification')),
    ) as ReturnType<typeof createInternalAgentTextPart>;
    const messages = {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [internalPart],
        },
      ],
    };

    await transformMessages(hook, messages);

    expect(messages.messages[0].parts).toHaveLength(1);
    expect(
      messages.messages[0].parts.some((part) =>
        part.text.includes('### Background Job Board'),
      ),
    ).toBe(false);
  });

  test('updates background job board from task output', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'oracle',
          description: 'review scheduler plan',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: ['task_id: child-1', 'state: running'].join('\n'),
      },
    );

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      {
        args: { subagent_type: 'oracle', description: 'review scheduler plan' },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      {
        output: [
          'task_id: child-1',
          'state: completed',
          '',
          '<task_result>',
          'plan is sound',
          '</task_result>',
        ].join('\n'),
      },
    );

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'plan is sound',
    });

    const messages = createMessages('parent-1', 'continue');
    await transformMessages(hook, messages);

    expect(boardText(messages)).toContain(
      'ora-1 / child-1 / oracle / completed, unreconciled',
    );
    expect(boardText(messages)).toContain('Result: plan is sound');
  });

  test('keeps task timeout as a running timed-out job', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'fixer',
          description: 'implement scheduler wiring',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: ['task_id: child-1', 'state: running'].join('\n'),
      },
    );

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      {
        args: {
          subagent_type: 'fixer',
          description: 'implement scheduler wiring',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      {
        output: [
          'task_id: child-1',
          'state: running',
          '',
          '<task_result>',
          'Timed out after 120000ms while waiting for task completion.',
          '</task_result>',
        ].join('\n'),
      },
    );

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      timedOut: true,
      terminalUnreconciled: false,
    });

    const messages = createMessages('parent-1', 'continue');
    await transformMessages(hook, messages);

    expect(boardText(messages)).toContain(
      'fix-1 / child-1 / fixer / running, timed out',
    );
  });

  test('reuses timed-out running aliases after live busy recovery', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'explorer',
          description: 'map timed out session',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: [
          'task_id: child-1',
          'state: running',
          '',
          '<task_result>',
          'Timed out after 120000ms while waiting for task completion.',
          '</task_result>',
        ].join('\n'),
      },
    );

    expect(
      board.resolveRecoverable('parent-1', 'exp-1', 'explorer')?.taskID,
    ).toBeUndefined();

    await hook.event({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'child-1',
          status: { type: 'busy' },
        },
      },
    });

    expect(
      board.resolveRecoverable('parent-1', 'exp-1', 'explorer')?.taskID,
    ).toBe('child-1');

    const resume = {
      args: { subagent_type: 'explorer', task_id: 'exp-1' },
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-1' },
      resume,
    );

    expect(resume.args.task_id).toBe('child-1');
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      timedOut: false,
      recoverableAfterLiveBusy: true,
    });
  });

  test('does not bypass live busy recovery gate for known raw session ids', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'explorer',
          description: 'map timed out session',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: [
          'task_id: ses_timeout',
          'state: running',
          '',
          '<task_result>',
          'Timed out after 120000ms while waiting for task completion.',
          '</task_result>',
        ].join('\n'),
      },
    );

    const resumeBeforeLiveBusy = {
      args: { subagent_type: 'explorer', task_id: 'ses_timeout' },
    };
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'resume-1' },
        resumeBeforeLiveBusy,
      ),
    ).rejects.toThrow('still running');
    expect(resumeBeforeLiveBusy.args.task_id).toBe('ses_timeout');

    await hook.event({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_timeout',
          status: { type: 'busy' },
        },
      },
    });

    const resumeAfterLiveBusy = {
      args: { subagent_type: 'explorer', task_id: 'ses_timeout' },
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-2' },
      resumeAfterLiveBusy,
    );

    expect(resumeAfterLiveBusy.args.task_id).toBe('ses_timeout');
  });

  test('busy timeout recovery clears timeout overlay from prompt', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'explorer',
          description: 'recover timed out child',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: [
          'task_id: child-1',
          'state: running',
          '',
          '<task_result>',
          'Timed out after 120000ms while waiting for task completion.',
          '</task_result>',
        ].join('\n'),
      },
    );

    const beforeMessages = createMessages('parent-1', 'before busy');
    await transformMessages(hook, beforeMessages);
    expect(boardText(beforeMessages)).toContain('running, timed out');

    await hook.event({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'child-1',
          status: { type: 'busy' },
        },
      },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      timedOut: false,
      recoverableAfterLiveBusy: true,
      statusUncertain: false,
    });

    const afterMessages = createMessages('parent-1', 'after busy');
    await transformMessages(hook, afterMessages);
    expect(afterMessages.messages[0].parts[0].text).not.toContain(
      'running, timed out',
    );
  });

  test('updates background job board from injected completion messages', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'explorer',
          description: 'map hooks',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: ['task_id: child-1', 'state: running'].join('\n'),
      },
    );

    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              id: 'part-1',
              synthetic: true,
              text: [
                '<task id="child-1" state="completed">',
                '<summary>Background task completed: map hooks</summary>',
                '<task_result>',
                'found hook flow',
                '</task_result>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await transformMessages(hook, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'found hook flow',
    });
    expect(boardText(messages)).toContain(
      'exp-1 / child-1 / explorer / completed, unreconciled',
    );
  });

  test('injected completion through message transform (without injectBackgroundJobBoard) remains terminal-unreconciled before parent idle, then reconciles after', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'explorer',
          description: 'map hooks',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: ['task_id: child-1', 'state: running'].join('\n'),
      },
    );

    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              id: 'part-1',
              synthetic: true,
              text: [
                '<task id="child-1" state="completed">',
                '<summary>Background task completed: map hooks</summary>',
                '<task_result>',
                'found hook flow',
                '</task_result>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    // through transform only, without injectBackgroundJobBoard (avoids broad remember)
    await hook['experimental.chat.messages.transform']({}, messages as never);

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'found hook flow',
    });
    expect(board.get('child-1')?.terminalUnreconciled).toBe(true);

    // duplicate occurrence is idempotent (no reprocess, no double remember)
    await hook['experimental.chat.messages.transform']({}, messages as never);
    expect(board.get('child-1')?.terminalUnreconciled).toBe(true);

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    await flushIdleReconcileDelay();

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('another terminal-unreconciled sibling remains unreconciled when only first child completion was injected', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    // setup child-1
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: { subagent_type: 'explorer', description: 'first' },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { output: ['task_id: child-1', 'state: running'].join('\n') },
    );

    // setup sibling child-2 (terminal via updateStatus after board payload, no injected)
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      {
        args: { subagent_type: 'oracle', description: 'second' },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      { output: ['task_id: child-2', 'state: running'].join('\n') },
    );

    // Full production sequence: transformMessages ... Only child-1 synthetic.
    // child-2 still running so not in terminalUnreconciled IDs of this payload.
    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              id: 'part-1',
              synthetic: true,
              text: [
                '<task id="child-1" state="completed">',
                '<summary>Background task completed: first</summary>',
                '<task_result>done1</task_result>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };
    await transformMessages(hook, messages);

    expect(board.get('child-1')?.terminalUnreconciled).toBe(true);
    expect(board.get('child-2')?.terminalUnreconciled).toBe(false);

    // duplicate stays idempotent
    await transformMessages(hook, messages);
    expect(board.get('child-1')?.terminalUnreconciled).toBe(true);

    // now make child-2 terminal (after the board payload was emitted)
    board.updateStatus({
      taskID: 'child-2',
      state: 'completed',
      resultSummary: 'sibling done',
    });
    expect(board.get('child-2')?.terminalUnreconciled).toBe(true);

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    await flushIdleReconcileDelay();

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
    // sibling terminal but never appeared in board payload nor had synthetic injected
    expect(board.get('child-2')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('a later synthetic completion does not replace an older delivered terminal batch', async () => {
    const board = new BackgroundJobBoard({ maxReusablePerAgent: 3 });
    const { hook } = createHook({
      backgroundJobBoard: board,
      idleReconcileDelayMs: 0,
    });

    for (const taskID of ['child-1', 'child-2']) {
      board.registerLaunch({
        taskID,
        parentSessionID: 'parent-1',
        agent: 'oracle',
        description: taskID,
      });
      board.updateStatus({ taskID, state: 'completed' });
    }

    // The first board payload records both executions as delivered.
    await transformMessages(hook, createMessages('parent-1', 'first turn'));

    board.registerLaunch({
      taskID: 'child-3',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'child-3',
    });
    const laterCompletion = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              id: 'child-3-completion',
              synthetic: true,
              text: [
                '<task id="child-3" state="completed">',
                '<summary>Background task completed: child-3</summary>',
                '<task_result>done3</task_result>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    // Process the later synthetic completion without rendering a new board.
    await hook['experimental.chat.messages.transform'](
      {},
      laterCompletion as never,
    );
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    await flushChildIdleReconcile();

    for (const taskID of ['child-1', 'child-2', 'child-3']) {
      expect(board.get(taskID)).toMatchObject({
        state: 'reconciled',
        terminalUnreconciled: false,
      });
    }
  });

  test('shape reconciliation leaves a pending synthetic completion unreconciled until its payload is delivered', async () => {
    const board = new BackgroundJobBoard({ maxReusablePerAgent: 3 });
    const { hook } = createHook({
      backgroundJobBoard: board,
      idleReconcileDelayMs: 0,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'first',
    });
    board.updateStatus({ taskID: 'child-1', state: 'completed' });
    await transformMessages(hook, createMessages('parent-1', 'first turn'));

    board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'second',
    });
    const pendingCompletion = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              id: 'child-2-completion',
              synthetic: true,
              text: [
                '<task id="child-2" state="completed">',
                '<summary>Background task completed: child-2</summary>',
                '<task_result>done2</task_result>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };
    await hook['experimental.chat.messages.transform'](
      {},
      pendingCompletion as never,
    );
    expect(board.get('child-2')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });

    // Shape reconciliation runs before this current payload is rendered.
    await hook.injectBackgroundJobBoard({}, pendingCompletion as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
    expect(board.get('child-2')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
    expect(boardText(pendingCompletion)).toContain(
      'child-2 / oracle / completed, unreconciled',
    );

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    await flushChildIdleReconcile();
    expect(board.get('child-2')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('no-starvation latest pipeline: child-1 synthetic remembered; child-2 becomes terminal before idle; next full transform emits child-2 in board; idle reconciles both', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    // child-1 via tool + synthetic injected (narrow + metadata will remember it)
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'explorer', description: 'first' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { output: ['task_id: child-1', 'state: running'].join('\n') },
    );

    const msg1 = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              id: 'part-1',
              synthetic: true,
              text: [
                '<task id="child-1" state="completed">',
                '<summary>Background task completed: first</summary>',
                '<task_result>done1</task_result>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };
    await transformMessages(hook, msg1);
    expect(board.get('child-1')?.terminalUnreconciled).toBe(true);

    // before idle, child-2 becomes terminal (no synthetic for it)
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      { args: { subagent_type: 'oracle', description: 'second' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      { output: ['task_id: child-2', 'state: running'].join('\n') },
    );
    board.updateStatus({
      taskID: 'child-2',
      state: 'completed',
      resultSummary: 'done2',
    });
    expect(board.get('child-2')?.terminalUnreconciled).toBe(true);

    // next full transform: emits board payload that now includes child-2 terminal
    const msg2 = createMessages('parent-1', 'next turn');
    await transformMessages(hook, msg2);
    expect(boardText(msg2)).toContain('child-2');
    expect(boardText(msg2)).toContain('completed, unreconciled');

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    await flushIdleReconcileDelay();

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
    expect(board.get('child-2')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('metadata/renderer selection omits child-2 from both board text and IDs; child-2 absent from emitted text and remains unreconciled', async () => {
    const board = new BackgroundJobBoard();
    // renderer-selection stub/fake: omits child-2 row from BOTH text and IDs (test-only shaping)
    const orig = board.formatForPromptWithMetadata.bind(board);
    board.formatForPromptWithMetadata = (p: string) => {
      const m = orig(p);
      if (!m) return m;
      const shapedText = m.text
        ? m.text
            .split('\n')
            .filter((line: string) => !line.includes('child-2'))
            .join('\n')
        : m.text;
      return {
        text: shapedText,
        terminalUnreconciledTaskIDs: m.terminalUnreconciledTaskIDs.filter(
          (execution) => execution.taskID === 'child-1',
        ),
      };
    };
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'c1',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'd1',
    });
    board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'c2',
    });
    board.updateStatus({
      taskID: 'child-2',
      state: 'completed',
      resultSummary: 'd2',
    });

    const messages = createMessages('parent-1');
    await transformMessages(hook, messages);

    const emitted = boardText(messages);
    expect(emitted).not.toContain('child-2');

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    await flushIdleReconcileDelay();

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
    expect(board.get('child-2')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('checkpoint-compatible no-starvation via snapshot replay: child-1 synthetic; child-2 terminal no synthetic; second transform replays snapshot with child-2; board text has it; idle reconciles both', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      strategy: 'checkpoint-compatible',
      idleReconcileDelayMs: 0,
    });

    // first: synthetic child-1 only
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'explorer', description: 'first' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { output: ['task_id: child-1', 'state: running'].join('\n') },
    );

    const msg1 = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              id: 'part-1',
              synthetic: true,
              text: [
                '<task id="child-1" state="completed">',
                '<summary>Background task completed: first</summary>',
                '<task_result>done1</task_result>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };
    await transformMessages(hook, msg1);
    expect(board.get('child-1')?.terminalUnreconciled).toBe(true);

    // child-2 becomes terminal without synthetic
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      { args: { subagent_type: 'oracle', description: 'second' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      { output: ['task_id: child-2', 'state: running'].join('\n') },
    );
    board.updateStatus({
      taskID: 'child-2',
      state: 'completed',
      resultSummary: 'done2',
    });
    expect(board.get('child-2')?.terminalUnreconciled).toBe(true);

    // second full transform (checkpoint): emits/replays snapshot containing child-2 (no narrow for child-2)
    const msg2 = createMessages('parent-1', 'next');
    await transformMessages(hook, msg2);
    const replayedText = boardText(msg2);
    expect(replayedText).toContain('child-2');
    expect(replayedText).toContain('completed, unreconciled');

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    await flushContinuation();

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
    expect(board.get('child-2')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('checkpoint replay does not reconcile a relaunch with the same task ID', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      strategy: 'checkpoint-compatible',
      idleReconcileDelayMs: 0,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'first execution',
    });
    board.updateStatus({ taskID: 'child-1', state: 'completed' });

    const firstRequest = createAnchoredMessages('parent-1', ['turn 1']);
    await transformMessages(hook, firstRequest);
    expect(boardSnapshotIDs(firstRequest)).toHaveLength(1);
    expect(board.get('child-1')).toMatchObject({
      generation: 1,
      terminalUnreconciled: true,
    });

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    await flushChildIdleReconcile();
    expect(board.get('child-1')).toMatchObject({
      generation: 1,
      state: 'reconciled',
    });

    board.drop('child-1');
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'second execution',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'second result',
    });
    expect(board.get('child-1')).toMatchObject({
      generation: 2,
      terminalUnreconciled: true,
    });

    // Hide the current board payload so only the stale generation-1 snapshot
    // is delivered on this request.
    board.formatForPromptWithMetadata = () => undefined;
    const replayedRequest = createAnchoredMessages('parent-1', [
      'turn 1',
      'turn 2',
    ]);
    await transformMessages(hook, replayedRequest);
    expect(boardSnapshotIDs(replayedRequest)).toEqual([
      'oh-my-opencode-slim:background-job-board:parent-1:0',
    ]);

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    await flushChildIdleReconcile();

    expect(board.get('child-1')).toMatchObject({
      generation: 2,
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'second result',
    });
  });

  test('checkpoint creates a new execution-aware snapshot when visible board text is unchanged', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      strategy: 'checkpoint-compatible',
      idleReconcileDelayMs: 0,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'same execution text',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'same result',
    });

    const firstRequest = createAnchoredMessages('parent-1', ['turn 1']);
    await transformMessages(hook, firstRequest);
    const firstBoardText = boardText(firstRequest);
    expect(firstBoardText).toContain('Result: same result');
    expect(boardSnapshotIDs(firstRequest)).toEqual([
      'oh-my-opencode-slim:background-job-board:parent-1:0',
    ]);

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    await flushChildIdleReconcile();

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'same execution text',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'same result',
    });
    expect(board.formatForPrompt('parent-1')).toBe(firstBoardText);
    expect(board.get('child-1')).toMatchObject({
      generation: 2,
      terminalUnreconciled: true,
    });

    let reconciliationCount = 0;
    const markReconciled = board.markReconciled.bind(board);
    board.markReconciled = (taskID, now) => {
      reconciliationCount += 1;
      return markReconciled(taskID, now);
    };

    const secondRequest = {
      messages: [
        ...firstRequest.messages,
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ type: 'text', text: 'response 1' }],
        },
      ],
    };
    await transformMessages(hook, secondRequest);
    expect(boardSnapshotIDs(secondRequest)).toEqual([
      'oh-my-opencode-slim:background-job-board:parent-1:0',
      'oh-my-opencode-slim:background-job-board:parent-1:1',
    ]);

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    await flushChildIdleReconcile();

    expect(reconciliationCount).toBe(1);
    expect(board.get('child-1')).toMatchObject({
      generation: 2,
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('ignores non-synthetic user text that resembles task status', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const messages = createMessages(
      'parent-1',
      [
        'please note this text:',
        'task_id: child-1',
        'state: completed',
        '<task_result>',
        'spoofed',
        '</task_result>',
      ].join('\n'),
    );

    await transformMessages(hook, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
  });

  test('does not replay old injected completion after same task id relaunches', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              id: 'part-2',
              synthetic: true,
              text: [
                'Background task completed: map hooks',
                'task_id: child-1',
                'state: completed',
                '',
                '<task_result>',
                'old result',
                '</task_result>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await transformMessages(hook, messages);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'old result',
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks again',
    });

    await transformMessages(hook, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
      resultSummary: undefined,
    });
  });

  test('new synthetic message occurrence updates board after task relaunch with same state/result', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    // First synthetic completion - processed
    const firstMessages = {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
            id: 'msg-1',
          },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                'Background task completed: map hooks',
                'task_id: child-1',
                'state: completed',
                '',
                '<task_result>',
                'same result',
                '</task_result>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await transformMessages(hook, firstMessages);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'same result',
    });

    // Relaunch same task ID
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks again',
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });

    // New synthetic message occurrence with same state/result - should update to terminal
    const secondMessages = {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
            id: 'msg-2',
          },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                'Background task completed: map hooks',
                'task_id: child-1',
                'state: completed',
                '',
                '<task_result>',
                'same result',
                '</task_result>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await transformMessages(hook, secondMessages);

    // Should be terminal again because this is a new message occurrence
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'same result',
    });
  });

  test('dedupes anonymous synthetic completions by content hash even when message index changes', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const completionPart = {
      type: 'text',
      synthetic: true,
      text: [
        'Background task completed: map hooks',
        'task_id: child-1',
        'state: completed',
        '',
        '<task_result>',
        'same result',
        '</task_result>',
      ].join('\n'),
    };

    // First transform - message at index 0
    const firstMessages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [completionPart],
        },
      ],
    };

    await transformMessages(hook, firstMessages);

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'same result',
    });

    // Relaunch the task
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks again',
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });

    // Second transform - same completion content but at different message index (1 instead of 0)
    // With stable content hash, this should still be deduped (not processed again)
    const secondMessages = {
      messages: [
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ type: 'text', text: 'some other message' }],
        }, // New message at index 0
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [completionPart], // Same completion now at index 1
        },
      ],
    };

    await transformMessages(hook, secondMessages);

    // Should still be running because the same anonymous completion was deduped
    // (not re-processed just because message index changed)
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
  });

  test('ignores non-synthetic spoof that resembles task status', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    // Non-synthetic message should be ignored even with valid-looking content
    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: false,
              text: [
                'Background task completed: map hooks',
                'task_id: child-1',
                'state: completed',
                '',
                '<task_result>',
                'spoofed result',
                '</task_result>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await transformMessages(hook, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
  });

  test('ignores synthetic summary/state mismatch - completed summary with error state', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    // "completed" summary with "error" state should be ignored
    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                '<task id="child-1" state="error">',
                '<summary>Background task completed: map hooks</summary>',
                '<task_error>',
                'something went wrong',
                '</task_error>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await transformMessages(hook, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
  });

  test('ignores synthetic summary/state mismatch - failed summary with completed state', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    // "failed" summary with "completed" state should be ignored
    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                '<task id="child-1" state="completed">',
                '<summary>Background task failed: map hooks</summary>',
                '<task_result>',
                'success result',
                '</task_result>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await transformMessages(hook, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
  });

  test('ignores running state in auto-injected synthetic path', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    // "completed" summary with "running" state should be ignored
    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                '<task id="child-1" state="running">',
                '<summary>Background task completed: map hooks</summary>',
                '<task_result>',
                'still running',
                '</task_result>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await transformMessages(hook, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });
  });

  test('valid synthetic completed message updates board to terminal', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                '<task id="child-1" state="completed">',
                '<summary>Background task completed: map hooks</summary>',
                '<task_result>',
                'successfully mapped',
                '</task_result>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await transformMessages(hook, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'successfully mapped',
    });
  });

  test('valid synthetic failed message updates board to terminal error', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                '<task id="child-1" state="error">',
                '<summary>Background task failed: map hooks</summary>',
                '<task_error>',
                'mapping failed',
                '</task_error>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await transformMessages(hook, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      terminalUnreconciled: true,
      resultSummary: 'mapping failed',
    });
  });

  test('normalizes late injected failure for an explicitly cancelled task', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'cancelled review',
    });
    board.markCancelled('child-1', 'user requested');
    board.markReconciled('child-1');

    const messages = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: [
                '<task id="child-1" state="error">',
                '<summary>Background task failed: cancelled review</summary>',
                '<task_error>',
                'No user message found in stream. This should never happen.',
                '</task_error>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await transformMessages(hook, messages);

    expect(messages.messages[0].parts.at(-1)?.text).toContain(
      'state: cancelled',
    );
    expect(messages.messages[0].parts.at(-1)?.text).toContain(
      'cancelled: user requested',
    );
    expect(messages.messages[0].parts[0].text).not.toContain(
      'No user message found',
    );
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalState: 'cancelled',
      terminalUnreconciled: false,
    });
  });

  test('normalizes late task error output for an explicitly cancelled task', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'cancelled review',
    });
    board.markCancelled('child-1', 'user requested');
    board.markReconciled('child-1');

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      { args: { subagent_type: 'oracle', description: 'cancelled review' } },
    );

    const output = {
      output: [
        'task_id: child-1',
        'state: error',
        '',
        '<task_error>',
        'No user message found in stream. This should never happen.',
        '</task_error>',
      ].join('\n'),
      metadata: { state: 'error' },
    };

    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      output,
    );

    expect(output.output).toContain('state: cancelled');
    expect(output.output).toContain('cancelled: user requested');
    expect(output.output).not.toContain('No user message found');
    expect(output.metadata).toMatchObject({ state: 'cancelled' });
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalState: 'cancelled',
    });
  });

  test('marks terminal jobs reconciled after injected prompt reaches idle', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'approved',
    });

    const messages = createMessages('parent-1', 'continue');
    await transformMessages(hook, messages);
    expect(boardText(messages)).toContain(
      'ora-1 / child-1 / oracle / completed, unreconciled',
    );

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    // Wait for deferred idle reconciliation timeout
    await flushIdleReconcileDelay();

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });

    const nextMessages = createMessages('parent-1', 'continue again');
    await transformMessages(hook, nextMessages);
    expect(boardText(nextMessages)).toContain('Reusable Sessions');
  });

  test('does not reopen stale cancelled child job when child session becomes busy', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'read internals',
    });
    board.updateStatus({ taskID: 'child-1', state: 'cancelled' });
    board.markReconciled('child-1');

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-1', status: { type: 'busy' } },
      },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
      terminalState: 'cancelled',
    });
  });

  test('late injected completion during idle delay is not dropped by reconciliation', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    setupCompletedJob(board);

    const messages = createMessages('parent-1', 'continue');
    await transformMessages(hook, messages);

    // Fire idle event (starts 2s reconciliation timer)
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    // Before the timer fires, a late injected completion arrives with error
    board.updateStatus({
      taskID: 'child-1',
      state: 'error',
      resultSummary: 'actual error from child',
    });

    await flushIdleReconcileDelay();

    // Reconciled with the late error's result, not the idle-written fallback
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalState: 'error',
      resultSummary: 'actual error from child',
    });
  });

  test('does not reconcile terminal jobs before they are injected into a prompt', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({ taskID: 'child-1', state: 'completed' });

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('does not reconcile injected terminal jobs after session error', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({ taskID: 'child-1', state: 'completed' });

    const messages = createMessages('parent-1', 'continue');
    await transformMessages(hook, messages);

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'parent-1',
          error: { name: 'MessageAbortedError' },
        },
      },
    });
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('reconciles a surfaced terminal job on the next request while wait_for_user is latched', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'approved',
    });

    // Request 1: inject the board with the completed job
    const request1 = createMessages('parent-1', 'continue');
    await transformMessages(hook, request1);
    expect(boardText(request1)).toContain(
      'ora-1 / child-1 / oracle / completed, unreconciled',
    );
    expect(boardText(request1)).toContain('Result: approved');

    // Latch wait_for_user (simulating the tool call)
    hook.beginUserWait('parent-1');

    // Request 2: same history + one assistant message with a tool part
    // (simulating the wait_for_user tool call turn)
    const request2 = {
      messages: [
        ...request1.messages,
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [
            { type: 'text', text: 'calling wait_for_user' },
            {
              type: 'tool',
              tool: 'wait_for_user',
              id: 'wait-call-1',
              args: { prompt: 'waiting' },
            },
          ],
        },
      ],
    };
    await transformMessages(hook, request2);

    // The job should now be reconciled (not unreconciled)
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
    // The board should no longer show the Result line
    expect(boardText(request2)).toContain(
      'ora-1 / child-1 / oracle / completed, reconciled',
    );
    expect(boardText(request2)).not.toContain('Result: approved');
  });

  test('does not reconcile when the same request is transformed twice', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'approved',
    });

    const messages = createMessages('parent-1', 'continue');

    // Transform the same message array twice (simulating a provider
    // retry). The second transform strips the previously-injected trailing
    // board message automatically, then computes the same shape key.
    await transformMessages(hook, messages);
    const firstBoardText = boardText(messages);

    await transformMessages(hook, messages);
    const secondBoardText = boardText(messages);

    // Both should show unreconciled (same prompt shape = no reconciliation)
    expect(firstBoardText).toContain('completed, unreconciled');
    expect(secondBoardText).toContain('completed, unreconciled');
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('reconciles when compaction preserves message and part counts', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'approved',
    });

    const surfacedRequest = {
      messages: [
        {
          info: {
            id: 'user-1',
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ type: 'text', text: 'original user turn' }],
        },
        {
          info: {
            id: 'assistant-1',
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ type: 'text', text: 'older assistant content' }],
        },
      ],
    };
    const surfacedMessageCount = surfacedRequest.messages.length;
    const surfacedPartCount = surfacedRequest.messages.flatMap(
      (message) => message.parts,
    ).length;

    await transformMessages(hook, surfacedRequest);
    expect(boardText(surfacedRequest)).toContain('completed, unreconciled');
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });

    const compactedWithNewTurn = {
      messages: [
        {
          info: {
            id: 'user-1',
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ type: 'text', text: 'original user turn' }],
        },
        {
          info: {
            id: 'assistant-2',
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [
            { type: 'text', text: 'new assistant turn after compaction' },
          ],
        },
      ],
    };

    expect(compactedWithNewTurn.messages).toHaveLength(surfacedMessageCount);
    expect(
      compactedWithNewTurn.messages.flatMap((message) => message.parts),
    ).toHaveLength(surfacedPartCount);

    await transformMessages(hook, compactedWithNewTurn);

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
    expect(boardText(compactedWithNewTurn)).toContain('completed, reconciled');
    expect(boardText(compactedWithNewTurn)).not.toContain('Result: approved');
  });

  test('stops re-announcing a completion across a run of requests', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'approved',
    });

    // Build 5 explicit requests: the first carries only the user message,
    // each subsequent one adds exactly one more assistant part. This makes
    // it obvious which request is the "model has now reacted" boundary.
    const userMessage = {
      info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
      parts: [{ type: 'text', text: 'turn 1' }],
    };
    function buildRequest(assistantMessageCount: number) {
      return {
        messages: [
          userMessage,
          ...Array.from({ length: assistantMessageCount }, (_, i) => ({
            info: {
              role: 'assistant',
              agent: 'orchestrator',
              sessionID: 'parent-1',
            },
            parts: [{ type: 'text', text: `response ${i + 1}` }],
          })),
        ],
      };
    }

    const resultLines: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      const request = buildRequest(i);
      await transformMessages(hook, request);
      const board_text = boardText(request);
      resultLines.push(board_text?.includes('Result: approved') ?? false);
    }

    // The Result line should appear in exactly one board — the first one,
    // where the shape key was first stored. Every later request carries a
    // strictly larger shape, so the completion is reconciled.
    const resultCount = resultLines.filter((x) => x).length;
    expect(resultCount).toBe(1);
    expect(resultLines[0]).toBe(true);
    expect(resultLines[1]).toBe(false);
    expect(resultLines[2]).toBe(false);
    expect(resultLines[3]).toBe(false);
    expect(resultLines[4]).toBe(false);
  });

  test('reconciles a surfaced terminal job on the next request in checkpoint-compatible mode', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      strategy: 'checkpoint-compatible',
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'approved',
    });

    // Request 1: inject the board with the completed job
    const request1 = createAnchoredMessages('parent-1', ['turn 1']);
    await transformMessages(hook, request1);
    const snapshots1 = boardSnapshotIDs(request1);
    expect(snapshots1.length).toBeGreaterThan(0);
    expect(boardText(request1)).toContain('completed, unreconciled');

    // Request 2: same history + one assistant message
    const request2 = {
      messages: [
        ...request1.messages,
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ type: 'text', text: 'response 1' }],
        },
      ],
    };
    await transformMessages(hook, request2);

    // The job should now be reconciled
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
    // A new snapshot should be created reflecting the reconciled state
    const snapshots2 = boardSnapshotIDs(request2);
    expect(snapshots2.length).toBeGreaterThan(snapshots1.length);
    expect(boardText(request2)).toContain('completed, reconciled');
  });

  test('reconciles all terminal jobs surfaced on the same prompt shape', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    // Two completions that arrive in the same request window
    board.registerLaunch({
      taskID: 'child-A',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan A',
    });
    board.registerLaunch({
      taskID: 'child-B',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan B',
    });
    board.updateStatus({
      taskID: 'child-A',
      state: 'completed',
      resultSummary: 'approved A',
    });
    board.updateStatus({
      taskID: 'child-B',
      state: 'completed',
      resultSummary: 'approved B',
    });

    // Request 1: both jobs are surfaced and stored under the same prompt
    // shape key. The union branch of rememberInjectedTerminalJobs keeps
    // them together even if a second completion lands mid-request.
    const request1 = createMessages('parent-1', 'continue');
    await transformMessages(hook, request1);
    expect(boardText(request1)).toContain('Result: approved A');
    expect(boardText(request1)).toContain('Result: approved B');

    // Request 2: same shape (no new part) — both jobs stay unreconciled
    const request2 = createMessages('parent-1', 'continue');
    await transformMessages(hook, request2);
    expect(boardText(request2)).toContain('completed, unreconciled');
    expect(board.get('child-A')).toMatchObject({ terminalUnreconciled: true });
    expect(board.get('child-B')).toMatchObject({ terminalUnreconciled: true });

    // Request 3: model added an assistant part — both jobs reconcile
    // together because they share a stored prompt shape key.
    const request3 = {
      messages: [
        ...request1.messages,
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ type: 'text', text: 'acknowledged' }],
        },
      ],
    };
    await transformMessages(hook, request3);

    expect(board.get('child-A')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
    expect(board.get('child-B')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('idle backstop is a no-op after shape-reconciliation already fired', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      idleReconcileDelayMs: 0,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'approved',
    });

    // Request 1: surface the completion
    const request1 = createMessages('parent-1', 'continue');
    await transformMessages(hook, request1);
    expect(board.get('child-1')).toMatchObject({ terminalUnreconciled: true });

    // Request 2: model added a part, shape-reconciliation fires
    const request2 = {
      messages: [
        ...request1.messages,
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ type: 'text', text: 'thanks' }],
        },
      ],
    };
    await transformMessages(hook, request2);
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });

    // Session goes idle — the backstop fires but must not disturb the
    // already-reconciled job (and must not error on a missing entry).
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushChildIdleReconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('preserves injected terminal jobs for recoverable HTTP 400 errors', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({ taskID: 'child-1', state: 'completed' });

    const messages = createMessages('parent-1', 'continue');
    await transformMessages(hook, messages);

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'parent-1',
          error: {
            data: { statusCode: 400, responseBody: 'rate limit exceeded' },
          } as unknown as { name?: string },
        },
      },
    });
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('non-retryable session.error marks running job as error on board', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({ taskID: 'child-1', state: 'running' });

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: {
            name: 'UnknownError',
            message: 'LLM proxy connection refused',
          },
        },
      },
    });

    const job = board.get('child-1');
    expect(job?.state).toBe('error');
    expect(job?.resultSummary).toBe('LLM proxy connection refused');
  });

  test('persistent 401 session.error on managed session records board error when fallback cannot recover', async () => {
    // 401/410 are persistent (not recovered once the fallback chain is
    // exhausted) and must surface as an error, not a false completion.
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      // No chain / chain exhausted / fallback disabled → error is final.
      willAttemptFallback: () => false,
    });

    board.registerLaunch({
      taskID: 'parent-1',
      parentSessionID: 'root-1',
      agent: 'orchestrator',
      description: 'background session',
    });
    board.updateStatus({ taskID: 'parent-1', state: 'running' });

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'parent-1',
          error: { statusCode: 401, message: 'Unauthorized' },
        },
      },
    });

    const job = board.get('parent-1');
    expect(job?.state).toBe('error');
    expect(job?.resultSummary).toBe('Unauthorized');
  });

  test('terminalizes deferred 401 as error when the session idles unrecovered', async () => {
    // A 401/410 with a fallback model available is reprompted by
    // ForegroundFallbackManager; terminalizing at session.error time
    // would leave a recovered job permanently failed. But if the session
    // ends (idle) without recovery — e.g. execFallback failed silently —
    // the deferred error must terminalize as 'error', not the false
    // 'completed' the child-idle path would record.
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      willAttemptFallback: () => true,
      idleReconcileDelayMs: 0,
    });

    board.registerLaunch({
      taskID: 'parent-1',
      parentSessionID: 'root-1',
      agent: 'orchestrator',
      description: 'background session',
    });
    board.updateStatus({ taskID: 'parent-1', state: 'running' });

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'parent-1',
          error: { statusCode: 401, message: 'Unauthorized' },
        },
      },
    });

    // Deferred: job still running while the fallback may recover.
    expect(board.get('parent-1')?.state).toBe('running');

    // The fallback never recovered the session; it went idle instead.
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushChildIdleReconcile();

    expect(board.get('parent-1')).toMatchObject({
      state: 'error',
      resultSummary:
        'Session error after failed model fallback (auth/model unavailable)',
    });
  });

  test('clears deferred 401 when live busy shows the session recovered', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      willAttemptFallback: () => true,
      idleReconcileDelayMs: 0,
    });

    board.registerLaunch({
      taskID: 'parent-1',
      parentSessionID: 'root-1',
      agent: 'orchestrator',
      description: 'background session',
    });
    board.updateStatus({ taskID: 'parent-1', state: 'running' });

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'parent-1',
          error: { statusCode: 401, message: 'Unauthorized' },
        },
      },
    });
    expect(board.get('parent-1')?.state).toBe('running');

    // Fallback re-prompt landed: live busy cancels the deferred error.
    await hook.event({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'parent-1',
          status: { type: 'busy' },
        },
      },
    });

    // Idle after recovery completes the job normally — not as an error.
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushChildIdleReconcile();

    expect(board.get('parent-1')?.state).not.toBe('error');
  });

  test('session.idle does not overwrite error state with completed', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'error',
      resultSummary: 'connection refused',
    });

    const messages = createMessages('parent-1', 'continue');
    await hook['experimental.chat.messages.transform']({}, messages);

    await hook.event({
      event: {
        type: 'session.idle',
        properties: {
          info: { id: 'child-1', parentID: 'parent-1' },
        },
      },
    });

    const job = board.get('child-1');
    expect(job?.state).toBe('error');
    expect(job?.resultSummary).toBe('connection refused');
  });

  test('child session.error (non-orchestrator) records failure on board', async () => {
    const board = new BackgroundJobBoard();
    // Child subagent sessions are not orchestrators, so shouldManageSession
    // returns false for them. The error must still land on the board,
    // otherwise idle reconciliation marks the job completed (false success).
    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'designer',
      description: 'design ui',
    });
    board.updateStatus({ taskID: 'child-1', state: 'running' });

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: {
            name: 'AI_APICallError',
            message: 'Internal server error',
          },
        },
      },
    });

    const job = board.get('child-1');
    expect(job?.state).toBe('error');
    expect(job?.resultSummary).toBe('Internal server error');
  });

  test('child session.error during fallback is not recorded on board', async () => {
    const board = new BackgroundJobBoard();
    // isFallbackInProgress is currently always-false for real children
    // (they have no fallback chain), so this guard path is unreachable in
    // production today. The test pins the defensive behavior for the day
    // children gain a fallback chain.
    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      isFallbackInProgress: () => true,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'designer',
      description: 'design ui',
    });
    board.updateStatus({ taskID: 'child-1', state: 'running' });

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: {
            name: 'AI_APICallError',
            message: 'Internal server error',
          },
        },
      },
    });

    const job = board.get('child-1');
    expect(job?.state).toBe('running');
  });

  test('completed reconciled job appears reusable and resumes via task', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config schema',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'schema mapped',
    });

    const messages = createMessages('parent-1', 'continue');
    await transformMessages(hook, messages);
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    // Wait for deferred idle reconciliation timeout
    await flushIdleReconcileDelay();

    const nextMessages = createMessages('parent-1', 'reuse');
    await transformMessages(hook, nextMessages);
    expect(boardText(nextMessages)).toContain('#### Reusable Sessions');
    expect(boardText(nextMessages)).toContain(
      'exp-1 / child-1 / explorer / completed, reconciled',
    );
    expect(nextMessages.messages[0].parts[0].text).not.toContain(
      ['<resumable', '_sessions>'].join(''),
    );
    expect(nextMessages.messages[0].parts[0].text).not.toContain(
      ['### Resumable', 'Sessions'].join(' '),
    );

    const resume = {
      args: {
        subagent_type: 'explorer',
        description: 'continue config schema',
        task_id: 'exp-1',
      },
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-1' },
      resume,
    );
    expect(resume.args.task_id).toBe('child-1');
  });

  test('only reconciled completed jobs resolve as reusable task sessions', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    board.registerLaunch({
      taskID: 'done-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({ taskID: 'done-1', state: 'completed' });
    board.registerLaunch({
      taskID: 'err-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'bad review',
    });
    board.updateStatus({ taskID: 'err-1', state: 'error' });
    board.markReconciled('err-1');

    const unreconciled = {
      args: { subagent_type: 'oracle', task_id: 'ora-1' },
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      unreconciled,
    );
    expect(unreconciled.args.task_id).toBeUndefined();

    board.markReconciled('done-1');

    const failed = { args: { subagent_type: 'oracle', task_id: 'ora-2' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      failed,
    );
    expect(failed.args.task_id).toBeUndefined();

    const completed = { args: { subagent_type: 'oracle', task_id: 'ora-1' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-3' },
      completed,
    );
    expect(completed.args.task_id).toBe('done-1');

    const messages = createMessages('parent-1', 'continue');
    await transformMessages(hook, messages);
    expect(boardText(messages)).toContain(
      'ora-1 / done-1 / oracle / completed, reconciled',
    );
    expect(messages.messages[0].parts[0].text).not.toContain('err-1');
  });

  test('running aliases fail closed instead of spawning a new task', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const resume = { args: { subagent_type: 'explorer', task_id: 'exp-1' } };
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
        resume,
      ),
    ).rejects.toThrow('still running');
    expect(resume.args.task_id).toBe('exp-1');
  });

  test('task alias is dropped when subagent_type is missing', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const resume = { args: { task_id: 'exp-1' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
      resume,
    );

    expect(resume.args.task_id).toBeUndefined();
  });

  test('task alias is dropped when subagent_type is invalid', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const resume = {
      args: { subagent_type: 123, task_id: 'exp-1' },
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
      resume,
    );

    expect(resume.args.task_id).toBeUndefined();
  });

  test('custom subagent raw session task_id is preserved', async () => {
    const { hook } = createHook();
    const resume = {
      args: { subagent_type: 'repro-helper', task_id: 'ses_custom123' },
    };

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
      resume,
    );

    expect(resume.args.task_id).toBe('ses_custom123');
  });

  test('custom subagent aliases resolve for the same custom agent', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'repro-helper',
      description: 'ask secret letter',
    });
    board.updateStatus({ taskID: 'child-1', state: 'completed' });
    board.markReconciled('child-1');

    const resume = {
      args: { subagent_type: 'repro-helper', task_id: 'rep-1' },
    };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
      resume,
    );

    expect(resume.args.task_id).toBe('child-1');
  });

  test('wrong parent or wrong agent alias does not resolve', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({ taskID: 'child-1', state: 'completed' });
    board.markReconciled('child-1');

    const wrongAgent = { args: { subagent_type: 'oracle', task_id: 'exp-1' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'agent' },
      wrongAgent,
    );
    expect(wrongAgent.args.task_id).toBeUndefined();
  });

  test('resuming reusable job relaunches running and removes reusable entry', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({ taskID: 'child-1', state: 'completed' });
    board.markReconciled('child-1');

    const resume = { args: { subagent_type: 'explorer', task_id: 'exp-1' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
      resume,
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
      { output: ['task_id: child-1', 'state: running'].join('\n') },
    );

    const messages = createMessages('parent-1', 'continue');
    await transformMessages(hook, messages);
    expect(boardText(messages)).toContain(
      'exp-1 / child-1 / explorer / running',
    );
    expect(boardText(messages)).toContain('#### Reusable Sessions\n- none');
  });

  test('bare task id output without state does not create reusable job', async () => {
    const { hook } = createHook();
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'explorer', description: 'legacy output' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { output: 'task_id: child-1 (for resuming to continue this task)' },
    );

    const messages = createMessages('parent-1', 'continue');
    await transformMessages(hook, messages);
    expect(messages.messages[0].parts[0].text).toBe('continue');
  });

  test('completed foreground XML task output becomes reusable after reconciliation', async () => {
    const { hook } = createHook();
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'fixer', description: 'reuse probe' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: [
          '<task id="ses_child" state="completed">',
          '<task_result>',
          'done',
          '</task_result>',
          '</task>',
        ].join('\n'),
      },
    );

    const unreconciled = createMessages('parent-1', 'continue');
    await transformMessages(hook, unreconciled);
    expect(boardText(unreconciled)).toContain(
      'fix-1 / ses_child / fixer / completed, unreconciled',
    );

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    // Wait for deferred idle reconciliation timeout
    await flushIdleReconcileDelay();

    const reusable = createMessages('parent-1', 'reuse');
    await transformMessages(hook, reusable);
    expect(boardText(reusable)).toContain(
      'fix-1 / ses_child / fixer / completed, reconciled',
    );

    const resume = { args: { subagent_type: 'fixer', task_id: 'fix-1' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-1' },
      resume,
    );
    expect(resume.args.task_id).toBe('ses_child');
  });

  test('late child busy event does not reopen completed foreground XML task', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'fixer', description: 'reuse probe' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: [
          '<task id="ses_child" state="completed">',
          '<task_result>',
          'done',
          '</task_result>',
          '</task>',
        ].join('\n'),
      },
    );

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_child', status: { type: 'busy' } },
      },
    });

    expect(board.get('ses_child')).toMatchObject({
      state: 'completed',
      terminalState: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('preserves explicit raw session ids when reusable board misses', async () => {
    const { hook } = createHook();
    const resume = {
      args: { subagent_type: 'fixer', task_id: 'ses_existing' },
    };

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-1' },
      resume,
    );

    expect(resume.args.task_id).toBe('ses_existing');
  });

  test('still drops unknown reusable aliases', async () => {
    const { hook } = createHook();
    const resume = { args: { subagent_type: 'fixer', task_id: 'fix-99' } };

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-1' },
      resume,
    );

    expect(resume.args.task_id).toBeUndefined();
  });

  test('reads before and after launch attach with unique-line counts and caps', async () => {
    const { hook } = createHook({
      readContextMinLines: 5,
      readContextMaxFiles: 1,
    });
    await hook.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-1', parentID: 'parent-1' } },
      },
    });
    for (const [file, start, count] of [
      ['small.ts', 1, 4],
      ['large.ts', 1, 12],
      ['large.ts', 7, 6],
      ['medium.ts', 1, 5],
    ] as const) {
      await hook['tool.execute.after'](
        { tool: 'read', sessionID: 'child-1', callID: `read-${file}-${start}` },
        {
          output: [
            `<path>/tmp/src/${file}</path>`,
            '<content>',
            ...Array.from(
              { length: count },
              (_, index) => `${start + index}: line`,
            ),
            '</content>',
          ].join('\n'),
        },
      );
    }
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'explorer', description: 'context caps' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { output: ['task_id: child-1', 'state: running'].join('\n') },
    );
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'status-1' },
      { args: { subagent_type: 'explorer', description: 'context caps' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'status-1' },
      { output: ['task_id: child-1', 'state: completed'].join('\n') },
    );
    const messages = createMessages('parent-1', 'continue');
    await transformMessages(hook, messages);
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    // Wait for deferred idle reconciliation timeout
    await flushIdleReconcileDelay();

    const next = createMessages('parent-1', 'reuse');
    await transformMessages(hook, next);
    const prompt = boardText(next);
    expect(prompt).not.toContain('small.ts');
    expect(prompt).toContain('src/large.ts (12 lines)');
    expect(prompt).not.toContain('src/large.ts (18 lines)');
    expect(prompt).toContain('(+1 more)');
  });

  test('reusable cap evicts only old reusable jobs, not active jobs', async () => {
    const board = new BackgroundJobBoard({ maxReusablePerAgent: 2 });
    for (const index of [1, 2, 3]) {
      board.registerLaunch({
        taskID: `done-${index}`,
        parentSessionID: 'parent-1',
        agent: 'explorer',
        description: `done ${index}`,
        now: index,
      });
      board.updateStatus({
        taskID: `done-${index}`,
        state: 'completed',
        now: index,
      });
      board.markReconciled(`done-${index}`, index);
    }
    board.registerLaunch({
      taskID: 'running-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'active',
      now: 4,
    });

    expect(board.get('done-1')).toBeUndefined();
    expect(board.get('done-2')).toBeDefined();
    expect(board.get('done-3')).toBeDefined();
    expect(board.get('running-1')).toBeDefined();
  });

  test('does not expose a system transform for resumable sessions', async () => {
    const { hook } = createHook();
    expect('experimental.chat.system.transform' in hook).toBe(false);
  });

  test('ignores sessions that are not orchestrator-managed', async () => {
    const { hook } = createHook({ shouldManageSession: () => false });

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'manual-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'manual-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const messages = createMessages('manual-1', 'do something');
    await transformMessages(hook, messages);

    // Message should remain unchanged
    expect(messages.messages[0].parts[0].text).toBe('do something');
  });

  test('cleans up background jobs when parent or child is deleted', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const { hook } = createHook({ coordinator });

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'oracle',
          description: 'architecture review',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    coordinator.dispatchSessionDeleted('child-1');

    const messages = createMessages('parent-1', 'do something');
    await transformMessages(hook, messages);
    // Message should remain unchanged since session was deleted
    expect(messages.messages[0].parts[0].text).toBe('do something');
  });

  test('cleans pending calls when parent session is deleted', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const { hook } = createHook({ coordinator });

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'oracle',
          description: 'architecture review',
        },
      },
    );

    coordinator.dispatchSessionDeleted('parent-1');

    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const messages = createMessages('parent-1', 'do something');
    await transformMessages(hook, messages);

    // Message should remain unchanged since session was deleted
    expect(messages.messages[0].parts[0].text).toBe('do something');
  });

  test('marks a running child as stopped when idle has no terminal task result', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'fix bug',
    });
    expect(board.get('child-1')).toMatchObject({ state: 'running' });

    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'parent-1',
      idleReconcileDelayMs: 0,
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });
    await flushChildIdleReconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
      resultSummary:
        'Background session stopped before a terminal task result was received.',
    });
  });

  test('ignores an idle observation after the child has relaunched', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'first run',
      now: 0,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      idleReconcileDelayMs: 20,
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'second run',
      now: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      generation: 2,
      description: 'second run',
    });
  });

  test('starts runtime reconciliation after task launch', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 0,
    });
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'fixer',
          background: true,
          description: 'runtime-check',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { output: taskLaunchOutput('child-1') },
    );
    await flushChildIdleReconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
    });
  });

  test('ignores session.idle for already reconciled job', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'fix bug',
    });
    board.updateStatus({ taskID: 'child-1', state: 'completed' });
    board.markReconciled('child-1');

    const { hook } = createHook({ backgroundJobBoard: board });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalState: 'completed',
    });
  });

  test('does not reconcile from idle when fallback is in progress', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'fix bug',
    });
    expect(board.get('child-1')).toMatchObject({ state: 'running' });

    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'parent-1',
      isFallbackInProgress: (id) => id === 'child-1',
      idleReconcileDelayMs: 0,
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });
    await flushChildIdleReconcile();

    // Job should still be running — not reconciled
    expect(board.get('child-1')).toMatchObject({ state: 'running' });
  });

  test('does NOT drop job from board on session.deleted when fallback in progress', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'architecture review',
    });
    expect(board.get('child-1')).toMatchObject({ state: 'running' });

    createHook({
      backgroundJobBoard: board,
      coordinator,
      isFallbackInProgress: (id) => id === 'child-1',
    });

    // Dispatch session.deleted while fallback is in progress
    coordinator.dispatchSessionDeleted('child-1');

    // Job must survive — the orchestrator needs to track it through the
    // abort/re-prompt cycle
    expect(board.get('child-1')).toBeDefined();
    expect(board.get('child-1')).toMatchObject({ state: 'running' });
  });

  test('drops job from board on session.deleted when no fallback in progress', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'architecture review',
    });
    expect(board.get('child-2')).toMatchObject({ state: 'running' });

    createHook({
      backgroundJobBoard: board,
      coordinator,
      // isFallbackInProgress not set — no guard
    });

    // Dispatch session.deleted normally
    coordinator.dispatchSessionDeleted('child-2');

    // Job should be dropped
    expect(board.get('child-2')).toBeUndefined();
  });

  test('marks stopped from idle when fallback guard passes', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'fix bug',
    });
    expect(board.get('child-1')).toMatchObject({ state: 'running' });

    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'parent-1',
      // isFallbackInProgress returns false for child-1
      isFallbackInProgress: () => false,
      idleReconcileDelayMs: 0,
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });
    await flushChildIdleReconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
    });
  });

  test('busy-after-idle from fallback re-prompt leaves job running', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'fix bug',
    });
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      timedOut: false,
    });

    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      isFallbackInProgress: (id) => id === 'child-1',
      idleReconcileDelayMs: 0,
    });

    // First idle (abort from fallback) — guarded, no reconciliation
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });
    await flushChildIdleReconcile();
    expect(board.get('child-1')).toMatchObject({ state: 'running' });

    // Busy signal (fallback re-prompt) — updates lastLiveBusyAt
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-1', status: { type: 'busy' } },
      },
    });
    expect(board.get('child-1')).toMatchObject({ state: 'running' });

    // Second idle stops the child without an explicit task result.
    const hook2 = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      isFallbackInProgress: () => false,
      idleReconcileDelayMs: 0,
    });
    await hook2.hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });
    await flushChildIdleReconcile();
    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
    });
  });

  test('busy after idle cancels pending child idle-reconcile (FG race)', async () => {
    // OpenCode can emit idle for a rate-limited child BEFORE FG sets
    // isFallbackInProgress. Immediate reconcile would mark completed while
    // FG re-prompts and the child keeps working. Delay + busy cancel keeps
    // the job running (the observed council-b false-complete race).
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-b',
      parentSessionID: 'parent-1',
      agent: 'councillor-reviewer-b',
      description: 'audit distributed',
    });

    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      isFallbackInProgress: () => false,
      idleReconcileDelayMs: 30,
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-b' } },
    });
    expect(board.get('child-b')).toMatchObject({ state: 'running' });

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-b', status: { type: 'busy' } },
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(board.get('child-b')).toMatchObject({ state: 'running' });
  });

  test('session.deleted cancels pending child idle-reconcile (FG teardown race)', async () => {
    // FG aborts the child session mid-idle-delay; onSessionDeleted must
    // cancel the pending timer so it cannot fire after FG finishes and
    // re-check isFallbackInProgress=false, falsely reconciling the board
    // entry while the re-prompted session keeps working.
    const coordinator = new SessionLifecycle(() => {});
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-b',
      parentSessionID: 'parent-1',
      agent: 'councillor-reviewer-b',
      description: 'audit distributed',
    });

    let fgInProgress = false;
    const { hook } = createHook({
      backgroundJobBoard: board,
      coordinator,
      shouldManageSession: () => false,
      isFallbackInProgress: () => fgInProgress,
      idleReconcileDelayMs: 30,
    });

    // idle fires before FG sets isFallbackInProgress — schedules timer T.
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-b' } },
    });
    // FG claims the session and aborts it; OpenCode emits session.deleted
    // while the timer is still pending. onSessionDeleted must cancel T.
    fgInProgress = true;
    coordinator.dispatchSessionDeleted('child-b');
    // FG finishes; isFallbackInProgress goes false before T would fire.
    fgInProgress = false;

    await new Promise((r) => setTimeout(r, 60));
    // Board entry survives (isFallbackInProgress was true at delete time)
    // but is NOT reconciled — the timer was cancelled on session.deleted.
    const job = board.get('child-b');
    expect(job).toBeDefined();
    expect(job?.state).toBe('running');
  });

  test('session.created early-registers board job so after-hook cancellation cannot orphan the child', async () => {
    // Reproduces #765: parent tool may be cancelled before tool.execute.after,
    // so the job never lands on the board. Early registration from
    // session.created keeps runningJobForSession true and lets idle reconcile.
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      idleReconcileDelayMs: 0,
    });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'oracle',
          description: 'loss design review',
        },
      },
    );

    // Child session is created while the parent tool is still in flight.
    await hook.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-1', parentID: 'parent-1' } },
      },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      agent: 'oracle',
      parentSessionID: 'parent-1',
      description: 'loss design review',
    });

    // Simulate parent tool never firing tool.execute.after (cancelled).
    // Child goes idle without task output — board must stop waiting.
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });
    await flushChildIdleReconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
    });
  });

  test('session.created early registration attributes each parallel child to its own pending call', async () => {
    // Regression: when a parent launches several task tools in parallel with
    // different subagent types (e.g. council reviewers a/b/c), the old
    // peekByParent() returned the FIRST pending call for every child, so
    // all children were registered with the first subagent's agentType.
    // info.agent on the child session disambiguates which pending call
    // started it.
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });

    // Parent fires three task tools in parallel: oracle / explorer / fixer.
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-a' },
      { args: { subagent_type: 'oracle', description: 'audit loss' } },
    );
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-b' },
      { args: { subagent_type: 'explorer', description: 'audit data' } },
    );
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-c' },
      { args: { subagent_type: 'fixer', description: 'audit fix' } },
    );

    // Each child session is created while the parent tool calls are still
    // in flight (before any tool.execute.after). info.agent identifies the
    // subagent that owns each child.
    await hook.event({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'child-a', parentID: 'parent-1', agent: 'oracle' },
        },
      },
    });
    await hook.event({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'child-b', parentID: 'parent-1', agent: 'explorer' },
        },
      },
    });
    await hook.event({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'child-c', parentID: 'parent-1', agent: 'fixer' },
        },
      },
    });

    expect(board.get('child-a')).toMatchObject({
      agent: 'oracle',
      description: 'audit loss',
    });
    expect(board.get('child-b')).toMatchObject({
      agent: 'explorer',
      description: 'audit data',
    });
    expect(board.get('child-c')).toMatchObject({
      agent: 'fixer',
      description: 'audit fix',
    });
  });

  test.each([
    ['foreground-created-first', ['foreground-child', 'background-child']],
    ['background-created-first', ['background-child', 'foreground-child']],
  ])(
    'ambiguous early created events never supervise the foreground child (%s)',
    async (_, createdOrder) => {
      const board = new BackgroundJobBoard();
      const clock = createSupervisorClock();
      const abort = mock(async () => undefined);
      const supervisor = new BackgroundJobSupervisor({
        backgroundJobStore: board,
        wallClockTimeoutMs: 100,
        abortGraceMs: 10,
        abort,
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      });
      const { hook } = createHook({
        backgroundJobBoard: board,
        backgroundJobSupervisor: supervisor,
      });

      await hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'background-call' },
        {
          args: {
            subagent_type: 'explorer',
            background: true,
            description: 'background child',
          },
        },
      );
      await hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'foreground-call' },
        {
          args: {
            subagent_type: 'explorer',
            background: false,
            description: 'foreground child',
          },
        },
      );

      for (const taskID of createdOrder) {
        await hook.event({
          event: {
            type: 'session.created',
            properties: { info: { id: taskID, parentID: 'parent-1' } },
          },
        });
      }

      expect(board.get('background-child')?.background).toBe(false);
      expect(board.get('foreground-child')?.background).toBe(false);
      expect(abort).not.toHaveBeenCalled();

      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'parent-1', callID: 'foreground-call' },
        { output: taskLaunchOutput('foreground-child') },
      );
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'parent-1', callID: 'background-call' },
        { output: taskLaunchOutput('background-child') },
      );

      expect(board.get('foreground-child')?.background).toBe(false);
      expect(board.get('background-child')?.background).toBe(true);
      const backgroundJob = board.get('background-child');
      expect(backgroundJob).toBeDefined();
      const deadline = (backgroundJob?.runStartedAt ?? 0) + 100;
      await clock.advanceTo(deadline);

      expect(abort).toHaveBeenCalledTimes(1);
      expect(abort).toHaveBeenCalledWith('background-child');
    },
  );

  test('missing after-hook callID fails closed while an exact background call remains', async () => {
    const board = new BackgroundJobBoard();
    const clock = createSupervisorClock();
    const abort = mock(async () => undefined);
    const supervisor = new BackgroundJobSupervisor({
      backgroundJobStore: board,
      wallClockTimeoutMs: 100,
      abortGraceMs: 10,
      abort,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      backgroundJobSupervisor: supervisor,
    });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'foreground-call' },
      {
        args: {
          subagent_type: 'explorer',
          background: false,
          description: 'foreground child',
        },
      },
    );
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'background-call' },
      {
        args: {
          subagent_type: 'explorer',
          background: true,
          description: 'background child',
        },
      },
    );
    for (const taskID of ['background-child', 'foreground-child']) {
      await hook.event({
        event: {
          type: 'session.created',
          properties: { info: { id: taskID, parentID: 'parent-1' } },
        },
      });
    }

    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1' },
      { output: taskLaunchOutput('foreground-child') },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'background-call' },
      { output: taskLaunchOutput('background-child') },
    );

    expect(board.get('foreground-child')?.background).toBe(false);
    expect(board.get('background-child')?.background).toBe(true);
    const deadline = (board.get('background-child')?.runStartedAt ?? 0) + 100;
    await clock.advanceTo(deadline);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith('background-child');
  });

  test('fallback delete/recreate/busy preserves an unclaimed absolute deadline', async () => {
    const board = new BackgroundJobBoard();
    const coordinator = new SessionLifecycle(() => {});
    const clock = createSupervisorClock();
    const abort = mock(async () => undefined);
    const supervisor = new BackgroundJobSupervisor({
      backgroundJobStore: board,
      wallClockTimeoutMs: 100,
      abortGraceMs: 10,
      abort,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const job = board.registerLaunch({
      taskID: 'fallback-child',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      background: true,
      now: 0,
    });
    supervisor.onLaunch(job);
    let fallback = true;
    const { hook } = createHook({
      backgroundJobBoard: board,
      backgroundJobSupervisor: supervisor,
      coordinator,
      shouldManageSession: () => false,
      isFallbackInProgress: () => fallback,
    });

    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'fallback-child' },
      },
    });
    coordinator.dispatchSessionDeleted('fallback-child');
    await hook.event({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'fallback-child', parentID: 'parent-1' },
        },
      },
    });
    await hook.event({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'fallback-child',
          status: { type: 'busy' },
        },
      },
    });
    fallback = false;
    await clock.advanceTo(100);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith('fallback-child');
    expect(board.get('fallback-child')?.deadlineExceededAt).toBe(100);
  });

  test('fallback deletion during grace confirms rather than clears a hard timeout', async () => {
    const board = new BackgroundJobBoard();
    const coordinator = new SessionLifecycle(() => {});
    const clock = createSupervisorClock();
    const abort = mock(async () => undefined);
    const supervisor = new BackgroundJobSupervisor({
      backgroundJobStore: board,
      wallClockTimeoutMs: 100,
      abortGraceMs: 20,
      abort,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const job = board.registerLaunch({
      taskID: 'fallback-grace-child',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      background: true,
      now: 0,
    });
    supervisor.onLaunch(job);
    let fallback = false;
    const { hook } = createHook({
      backgroundJobBoard: board,
      backgroundJobSupervisor: supervisor,
      coordinator,
      shouldManageSession: () => false,
      isFallbackInProgress: () => fallback,
    });

    await clock.advanceTo(100);
    fallback = true;
    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'fallback-grace-child' },
      },
    });
    coordinator.dispatchSessionDeleted('fallback-grace-child');

    expect(abort).toHaveBeenCalledTimes(1);
    expect(board.get('fallback-grace-child')).toMatchObject({
      state: 'error',
      timedOut: true,
      deadlineExceededAt: 100,
    });
  });

  test('cancelled job is not reconciled from idle', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'fix bug',
    });
    board.markCancelled('child-1', 'explicit cancel');
    expect(board.get('child-1')).toMatchObject({ state: 'cancelled' });

    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      idleReconcileDelayMs: 0,
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });
    await flushChildIdleReconcile();

    // Should remain cancelled — idle does not override terminal state
    const job = board.get('child-1');
    expect(job?.state).toBe('cancelled');
  });

  test('idle via session.status path marks the job stopped', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'fix bug',
    });
    expect(board.get('child-1')).toMatchObject({ state: 'running' });

    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'parent-1',
      idleReconcileDelayMs: 0,
    });

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-1', status: { type: 'idle' } },
      },
    });
    await flushChildIdleReconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
    });
  });

  test('parent deletion clears jobs and pending calls', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board, coordinator });
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { subagent_type: 'oracle', description: 'architecture review' } },
    );
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'architecture review',
    });

    coordinator.dispatchSessionDeleted('parent-1');
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { output: ['task_id: child-2', 'state: running'].join('\n') },
    );

    expect(board.list('parent-1')).toHaveLength(0);
  });

  test('recovers stale orchestrator mapping in tool.execute.before', async () => {
    const agentMap = new Map<string, string>();
    agentMap.set('orchestrator-1', 'explorer'); // stale non-orchestrator value

    const board = new BackgroundJobBoard();

    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: (id) => agentMap.get(id) === 'orchestrator',
      registerSessionAsOrchestrator: (id) => {
        agentMap.set(id, 'orchestrator');
      },
    });

    // Before recovery: stale mapping blocks pending call creation
    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'orchestrator-1',
        callID: 'call-recovery',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'test recovery',
        },
      },
    );

    // After recovery: agentMap now has 'orchestrator' for this session
    expect(agentMap.get('orchestrator-1')).toBe('orchestrator');

    // executeTool.after finds the pending call and registers the board entry
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'orchestrator-1',
        callID: 'call-recovery',
      },
      {
        output: [
          'task_id: child-recovery-1',
          'state: running',
          '',
          '<task_result>',
          'Background task started.',
          '</task_result>',
        ].join('\n'),
      },
    );

    const jobs = board.list('orchestrator-1');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      taskID: 'child-recovery-1',
      parentSessionID: 'orchestrator-1',
      state: 'running',
    });
  });

  test('recovers stale orchestrator mapping in messages.transform', async () => {
    const agentMap = new Map<string, string>();
    agentMap.set('orchestrator-1', 'explorer'); // stale non-orchestrator value

    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-transform-1',
      parentSessionID: 'orchestrator-1',
      agent: 'explorer',
      description: 'transform recovery test',
    });

    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: (id) => agentMap.get(id) === 'orchestrator',
      registerSessionAsOrchestrator: (id) => {
        agentMap.set(id, 'orchestrator');
      },
    });

    // Before recovery: stale mapping blocks transform processing
    const messages = {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'orchestrator-1',
          },
          parts: [{ type: 'text', text: 'continue working' }],
        },
      ],
    };

    await transformMessages(hook, messages as never);

    // After recovery: agentMap corrected, board reminders injected
    expect(agentMap.get('orchestrator-1')).toBe('orchestrator');
    expect(boardText(messages)).toContain('### Background Job Board');
    expect(boardText(messages)).toContain('child-transform-1');
  });

  test('repairs session mapping before composed reminder transforms', async () => {
    const agentMap = new Map<string, string>();
    const coordinator = new SessionLifecycle(() => {});
    const shouldInject = (sessionID: string) =>
      agentMap.get(sessionID) === 'orchestrator';
    const { hook: taskSessionManager } = createHook({
      shouldManageSession: shouldInject,
      registerSessionAsOrchestrator: (sessionID) => {
        agentMap.set(sessionID, 'orchestrator');
      },
    });
    const postFileNudge = createPostFileToolNudgeHook({
      coordinator,
      shouldInject,
    });
    const phaseReminder = createPhaseReminderHook({ shouldInject });
    const messages = createMessages('orchestrator-1');

    await postFileNudge['tool.execute.after'](
      { tool: 'Read', sessionID: 'orchestrator-1' },
      {},
    );
    await taskSessionManager['experimental.chat.messages.transform'](
      {},
      messages,
    );
    await postFileNudge['experimental.chat.messages.transform']({}, messages);
    await phaseReminder['experimental.chat.messages.transform']({}, messages);

    expect(agentMap.get('orchestrator-1')).toBe('orchestrator');
    expect(
      messages.messages[0].parts.filter(
        (part) => part.metadata?.[PHASE_REMINDER_METADATA_KEY] === true,
      ),
    ).toHaveLength(1);
  });

  test('idle reconciliation still runs without orchestrator wake SDK calls', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
    });
    const promptAsync = mock(async () => ({}));
    const todo = mock(async () => ({ data: [{ status: 'pending' }] }));
    const { hook } = createHook({
      backgroundJobBoard: board,
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo,
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.injectBackgroundJobBoard({}, createMessages('parent-1'));
    expect(board.get('child-1')?.terminalUnreconciled).toBe(true);

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    await flushContinuation();

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
    expect(todo).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('hasInputWait is true after wait_for_user and clears on distinct external message', async () => {
    const { hook } = createHook();
    hook.beginUserWait('parent-1');
    expect(hook.hasInputWait('parent-1')).toBe(true);

    hook.observeChatMessage(
      { sessionID: 'parent-1', messageID: 'msg-user-resumes' },
      {
        message: {
          id: 'msg-user-resumes',
          role: 'user',
          sessionID: 'parent-1',
        },
        parts: [{ type: 'text', text: 'The manual step is complete.' }],
      },
    );
    expect(hook.hasInputWait('parent-1')).toBe(false);
  });

  test('synthetic and internal messages do not clear wait_for_user', async () => {
    const { hook } = createHook();
    hook.beginUserWait('parent-1');
    hook.observeChatMessage(
      { sessionID: 'parent-1', messageID: 'msg-internal' },
      {
        message: {
          id: 'msg-internal',
          role: 'user',
          sessionID: 'parent-1',
        },
        parts: [
          { type: 'text', synthetic: true, text: 'synthetic continuation' },
          createInternalAgentTextPart('internal continuation'),
        ],
      },
    );
    expect(hook.hasInputWait('parent-1')).toBe(true);
  });

  test('question/permission asks arm hasInputWait until resolved', async () => {
    const { hook } = createHook();
    await hook.event({
      event: {
        type: 'question.asked',
        properties: { sessionID: 'parent-1', id: 'q-1' },
      },
    });
    expect(hook.hasInputWait('parent-1')).toBe(true);
    await hook.event({
      event: {
        type: 'question.replied',
        properties: { sessionID: 'parent-1', requestID: 'q-1' },
      },
    });
    expect(hook.hasInputWait('parent-1')).toBe(false);
  });

  test('user waits survive hook disposal and clear on genuine deletion', async () => {
    const owner = createHook().hook;
    owner.beginUserWait('parent-1');
    expect(owner.hasInputWait('parent-1')).toBe(true);

    await owner.event({
      event: { type: 'server.instance.disposed' },
    });
    // Process-local wait survives disposal of one hook instance.
    const next = createHook().hook;
    expect(next.hasInputWait('parent-1')).toBe(true);

    await next.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'parent-1' },
      },
    });
    expect(next.hasInputWait('parent-1')).toBe(false);
  });
});
