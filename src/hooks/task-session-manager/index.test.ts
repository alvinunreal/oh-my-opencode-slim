import { describe, expect, mock, test } from 'bun:test';
import { DEFAULT_MAX_RETAINED_SNAPSHOTS } from '../../config/constants';
import { SessionLifecycle } from '../../hooks/session-lifecycle';
import {
  BackgroundJobBoard,
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

function createHook(options?: {
  shouldManageSession?: (sessionID: string) => boolean;
  registerSessionAsOrchestrator?: (sessionID: string) => void;
  readContextMinLines?: number;
  readContextMaxFiles?: number;
  strategy?: 'latest' | 'checkpoint-compatible';
  maxRetainedSnapshots?: number;
  backgroundJobBoard?: BackgroundJobBoard;
  sessionStatus?: unknown;
  sessionClient?: Record<string, unknown>;
  idleReconcileDelayMs?: number;
  isFallbackInProgress?: (sessionID: string) => boolean;
  coordinator?: SessionLifecycle;
}) {
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
      shouldManageSession: options?.shouldManageSession ?? (() => true),
      registerSessionAsOrchestrator: options?.registerSessionAsOrchestrator,
      isFallbackInProgress: options?.isFallbackInProgress,
      coordinator: options?.coordinator,
      idleReconcileDelayMs: options?.idleReconcileDelayMs,
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
  const last = messages.messages.at(-1) as
    | {
        parts?: {
          text?: string;
          metadata?: Record<string, unknown>;
        }[];
      }
    | undefined;
  const part = last?.parts?.[0];
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

    expect(messages.messages).toHaveLength(6);
    expect(boardText(messages)).toContain('### Background Job Board');
    expect(boardText(messages)).toContain(
      'exp-1 / child-1 / explorer / running',
    );
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

    const userMessage = messages.messages[0];
    expect(userMessage.parts).toHaveLength(1);
    expect(userMessage.parts[0].text).toBe('do something');
    const boardMessage = messages.messages.at(-1) as {
      info: { role?: string; sessionID?: string };
      parts: { text?: string; synthetic?: boolean }[];
    };
    expect(messages.messages).toHaveLength(2);
    expect(boardMessage.info.role).toBe('user');
    expect(boardMessage.info.sessionID).toBe('parent-1');
    const boardPart = boardMessage.parts[0] as {
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
    expect(messages.messages[0].parts).toHaveLength(1);
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

  test('strips stale board parts from history before injecting the latest state', async () => {
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
    expect(boardParts).toHaveLength(1);
    expect(boardParts[0].text).toContain('completed, unreconciled');
    expect(messages.messages[0].parts).toHaveLength(1);
    expect(messages.messages.at(-1)?.parts[0]).toBe(boardParts[0]);
    expect(messages.messages.at(-2)?.parts[0].text).toBe('second turn');
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

    expect(boardSnapshotIDs(messages)).toHaveLength(0);
    const boardParts = messages.messages.flatMap((message) =>
      message.parts.filter(
        (part) => part.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] === true,
      ),
    );
    expect(boardParts).toHaveLength(1);
    expect(boardParts[0].text).toContain('completed, unreconciled');
    expect(messages.messages.at(-1)?.parts[0]).toBe(boardParts[0]);
  });

  test('strips JSON-persisted board parts from earlier messages', async () => {
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
      JSON.stringify(messages.messages.at(-1)?.parts[0]),
    );
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

    expect(messages.messages).toHaveLength(2);
    expect(messages.messages[0].parts[0].text).toBe('current turn');
    expect(messages.messages[1].parts[0].metadata).toEqual({
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

    const history: string[] = ['root'];
    for (let turn = 0; turn < 20; turn += 1) {
      board.updateStatus({
        taskID: 'child-1',
        state: turn % 2 === 0 ? 'completed' : 'error',
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
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'epoch-2-result-1',
    });
    const epochStart = createAnchoredMessages('parent-1', history);
    await hook.injectBackgroundJobBoard({}, epochStart);
    expect(boardSnapshotIDs(epochStart)).toHaveLength(1);
    expect(boardSnapshotIDs(epochStart)[0]).toEndWith(':20');

    history.push('epoch-2-turn-2');
    board.updateStatus({
      taskID: 'child-1',
      state: 'error',
      resultSummary: 'epoch-2-result-2',
    });
    const secondEpochRequest = createAnchoredMessages('parent-1', history);
    await hook.injectBackgroundJobBoard({}, secondEpochRequest);
    expect(boardSnapshotIDs(secondEpochRequest)).toHaveLength(2);
    expect(boardSnapshotIDs(secondEpochRequest)[0]).toEndWith(':20');
    expect(boardSnapshotIDs(secondEpochRequest)[1]).toEndWith(':21');
  });

  test('strips existing board parts when no jobs produce a prompt', async () => {
    const { hook } = createHook({
      backgroundJobBoard: new BackgroundJobBoard(),
    });
    const staleBoard = {
      type: 'text',
      synthetic: true,
      text: '<system-reminder>stale</system-reminder>',
      metadata: { [BACKGROUND_JOB_BOARD_METADATA_KEY]: true },
    };
    const messages = {
      messages: [
        { info: { role: 'assistant' }, parts: [staleBoard] },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [{ type: 'text', text: 'current turn' }, staleBoard],
        },
      ],
    };

    await hook.injectBackgroundJobBoard({}, messages);

    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0].parts).toEqual([
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

    const parts = nextRequest.messages[0].parts;
    expect(
      parts.filter(
        (part) => part.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] === true,
      ),
    ).toHaveLength(0);
    expect(parts.at(-1)?.metadata).toEqual({
      [PHASE_REMINDER_METADATA_KEY]: true,
    });
    expect(nextRequest.messages).toHaveLength(2);
    expect(nextRequest.messages.at(-1)?.parts[0].metadata).toEqual({
      [BACKGROUND_JOB_BOARD_METADATA_KEY]: true,
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
    expect(messages.messages[0].parts).toHaveLength(1);
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
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-1' },
      resumeBeforeLiveBusy,
    );

    expect(resumeBeforeLiveBusy.args.task_id).toBeUndefined();

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

  test('running alias is not resumed by task', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const resume = { args: { subagent_type: 'explorer', task_id: 'exp-1' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
      resume,
    );
    expect(resume.args.task_id).toBeUndefined();
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

  test('reconciles running child session job from session.idle event', async () => {
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
      state: 'reconciled',
      terminalState: 'completed',
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

  test('reconciles from idle when fallback guard passes', async () => {
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
      state: 'reconciled',
      terminalState: 'completed',
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

    // Second idle (real completion) — fallback no longer in progress
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
      state: 'reconciled',
      terminalState: 'completed',
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
    // Child goes idle after finishing — board must still reconcile.
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });
    await flushChildIdleReconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalState: 'completed',
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

  test('idle via session.status idle path triggers reconciliation', async () => {
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
      state: 'reconciled',
      terminalState: 'completed',
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

  test('nudges once for incomplete todos when parent and children are inactive', async () => {
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'in_progress' }] })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          parts: [expect.objectContaining({ synthetic: true })],
        }),
      }),
    );
  });

  test('does not evaluate or nudge while a question or permission waits', async () => {
    const todo = mock(async () => ({ data: [{ status: 'pending' }] }));
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo,
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: {
        type: 'question.asked',
        properties: { sessionID: 'parent-1', id: 'question-1' },
      },
    });
    await hook.event({
      event: {
        type: 'permission.asked',
        properties: { sessionID: 'parent-1', id: 'permission-1' },
      },
    });
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(todo).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('cancels a scheduled continuation when an input wait arrives before its timer fires', async () => {
    const todo = mock(async () => ({ data: [{ status: 'pending' }] }));
    const children = mock(async () => ({ data: [] }));
    const status = mock(async () => ({ data: {} }));
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: { todo, children, status, promptAsync },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await hook.event({
      event: {
        type: 'permission.asked',
        properties: { sessionID: 'parent-1', id: 'permission-1' },
      },
    });
    await flushContinuation();

    expect(todo).not.toHaveBeenCalled();
    expect(children).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('fails closed when an id-less ask races a scheduled continuation', async () => {
    const todo = mock(async () => ({ data: [{ status: 'pending' }] }));
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo,
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await hook.event({
      event: {
        type: 'question.asked',
        properties: { sessionID: 'parent-1' },
      },
    });
    await flushContinuation();

    expect(todo).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();

    await hook.event({
      event: {
        type: 'question.replied',
        properties: { sessionID: 'parent-1', requestID: 'question-1' },
      },
    });
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(todo).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('clears only the resolved input wait and resumes on a later idle', async () => {
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: {
        type: 'question.asked',
        properties: { sessionID: 'parent-1', id: 'question-1' },
      },
    });
    await hook.event({
      event: {
        type: 'permission.asked',
        properties: { sessionID: 'parent-1', id: 'permission-1' },
      },
    });
    await hook.event({
      event: {
        type: 'question.asked',
        properties: { sessionID: 'parent-1', id: 'question-2' },
      },
    });
    await hook.event({
      event: {
        type: 'question.replied',
        properties: { sessionID: 'parent-1', requestID: 'unknown-question' },
      },
    });
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).not.toHaveBeenCalled();

    await hook.event({
      event: {
        type: 'question.replied',
        properties: { sessionID: 'parent-1', requestID: 'question-1' },
      },
    });
    await hook.event({
      event: {
        type: 'permission.replied',
        properties: { sessionID: 'parent-1', requestID: 'permission-1' },
      },
    });
    await flushContinuation();
    expect(promptAsync).not.toHaveBeenCalled();

    await hook.event({
      event: {
        type: 'question.rejected',
        properties: { sessionID: 'parent-1', requestID: 'question-2' },
      },
    });
    await flushContinuation();
    expect(promptAsync).not.toHaveBeenCalled();

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('resumes on a later idle after a question rejection', async () => {
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: {
        type: 'question.asked',
        properties: { sessionID: 'parent-1', id: 'question-1' },
      },
    });
    await hook.event({
      event: {
        type: 'question.rejected',
        properties: { sessionID: 'parent-1', requestID: 'question-1' },
      },
    });
    await flushContinuation();

    expect(promptAsync).not.toHaveBeenCalled();

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('invalidates an in-flight continuation when an input wait arrives', async () => {
    let resolveTodo!: (value: { data: { status: string }[] }) => void;
    const todo = mock(
      () =>
        new Promise<{ data: { status: string }[] }>((resolve) => {
          resolveTodo = resolve;
        }),
    );
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo,
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();
    expect(todo).toHaveBeenCalledTimes(1);

    await hook.event({
      event: {
        type: 'question.asked',
        properties: { sessionID: 'parent-1', id: 'question-1' },
      },
    });
    resolveTodo({ data: [{ status: 'pending' }] });
    await flushContinuation();

    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('internal and synthetic messages do not clear an input wait', async () => {
    const todo = mock(async () => ({ data: [{ status: 'pending' }] }));
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo,
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: {
        type: 'question.asked',
        properties: { sessionID: 'parent-1', id: 'question-1' },
      },
    });
    hook.observeChatMessage(
      {},
      {
        message: { role: 'user', sessionID: 'parent-1' },
        parts: [
          { type: 'text', synthetic: true, text: 'synthetic response' },
          createInternalAgentTextPart('internal response'),
        ],
      },
    );
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(todo).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('retains input waits across a session error', async () => {
    const todo = mock(async () => ({ data: [{ status: 'pending' }] }));
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo,
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: {
        type: 'question.asked',
        properties: { sessionID: 'parent-1', id: 'question-1' },
      },
    });
    await hook.event({
      event: { type: 'session.error', properties: { sessionID: 'parent-1' } },
    });
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(todo).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('clears stale input waits on session and server cleanup', async () => {
    for (const lifecycleEvent of [
      { type: 'session.deleted', properties: { sessionID: 'parent-1' } },
      { type: 'server.instance.disposed' },
    ]) {
      const promptAsync = mock(async () => ({}));
      const { hook } = createHook({
        idleReconcileDelayMs: 0,
        sessionClient: {
          todo: mock(async () => ({ data: [{ status: 'pending' }] })),
          children: mock(async () => ({ data: [] })),
          status: mock(async () => ({ data: {} })),
          promptAsync,
        },
      });

      await hook.event({
        event: {
          type: 'question.asked',
          properties: { sessionID: 'parent-1', id: 'question-1' },
        },
      });
      await hook.event({ event: lifecycleEvent });
      await hook.event({
        event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
      });
      await flushContinuation();

      expect(promptAsync).toHaveBeenCalledTimes(1);
    }
  });

  test('coalesces paired idle events and suppresses active children', async () => {
    const promptAsync = mock(async () => ({}));
    const children = mock(async () => ({ data: [{ id: 'child-1' }] }));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
        children,
        status: mock(async () => ({ data: { 'child-1': { type: 'busy' } } })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });
    await flushContinuation();

    expect(children).toHaveBeenCalledTimes(1);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('runtime-shaped external messages rearm a consumed nudge', async () => {
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();
    hook.observeChatMessage(
      {},
      {
        message: { role: 'user', sessionID: 'parent-1' },
        parts: [{ type: 'text', text: 'continue' }],
      },
    );
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test('file-only external messages rearm a consumed nudge', async () => {
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();
    hook.observeChatMessage(
      {},
      {
        message: { role: 'user', sessionID: 'parent-1' },
        parts: [{ type: 'file', filename: 'command-output.txt' }],
      },
    );
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test('synthetic completion messages do not rearm a consumed nudge', async () => {
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();
    hook.observeChatMessage(
      {},
      {
        message: { role: 'user', sessionID: 'parent-1' },
        parts: [
          {
            type: 'text',
            synthetic: true,
            text: 'Background task completed: child-1',
          },
        ],
      },
    );
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('nudge busy-to-idle cycle does not send a second unchanged nudge', async () => {
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'busy' } },
      },
    });
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('retry status invalidates a pending continuation evaluation', async () => {
    let resolveTodo!: (value: { data: { status: string }[] }) => void;
    const todo = mock(
      () =>
        new Promise<{ data: { status: string }[] }>((resolve) => {
          resolveTodo = resolve;
        }),
    );
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo,
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();
    expect(todo).toHaveBeenCalledTimes(1);

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'retry' } },
      },
    });
    resolveTodo({ data: [{ status: 'pending' }] });
    await flushContinuation();

    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('terminal-unreconciled jobs suppress continuation nudges', async () => {
    const board = new BackgroundJobBoard();
    setupCompletedJob(board);
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      backgroundJobBoard: board,
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook['experimental.chat.messages.transform'](
      {},
      createMessages('parent-1'),
    );
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('missing SDK response data fails closed without nudging', async () => {
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: undefined })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('does not nudge when todos are completed or cancelled only', async () => {
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({
          data: [{ status: 'completed' }, { status: 'cancelled' }],
        })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('does not nudge while the parent is active', async () => {
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: { 'parent-1': { type: 'busy' } } })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('does not nudge while a child is retrying', async () => {
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
        children: mock(async () => ({ data: [{ id: 'child-1' }] })),
        status: mock(async () => ({
          data: { 'child-1': { type: 'retrying' } },
        })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('does not rearm a consumed nudge for its actual internal part', async () => {
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();
    hook.observeChatMessage(
      {},
      {
        message: { role: 'user', sessionID: 'parent-1' },
        parts: [createInternalAgentTextPart('Continue coordinating')],
      },
    );
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('keeps a rejected prompt consumed', async () => {
    const promptAsync = mock(async () => {
      throw new Error('prompt failed');
    });
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('keeps a failed prompt response consumed', async () => {
    const promptAsync = mock(async () => ({ error: 'prompt failed' }));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('fails closed for missing or throwing SDK endpoints', async () => {
    const missingPrompt = mock(async () => ({}));
    const { hook: missingHook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: { promptAsync: missingPrompt },
    });
    const throwingPrompt = mock(async () => ({}));
    const { hook: throwingHook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => {
          throw new Error('todo unavailable');
        }),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync: throwingPrompt,
      },
    });

    for (const hook of [missingHook, throwingHook]) {
      await hook.event({
        event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
      });
    }
    await flushContinuation();

    expect(missingPrompt).not.toHaveBeenCalled();
    expect(throwingPrompt).not.toHaveBeenCalled();
  });

  test('does not nudge when fallback is already in progress', async () => {
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      isFallbackInProgress: () => true,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();

    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('does not nudge when fallback starts during evaluation', async () => {
    let fallbackInProgress = false;
    let releaseTodos: (() => void) | undefined;
    const todos = new Promise<{ data: Array<{ status: string }> }>(
      (resolve) => {
        releaseTodos = () => resolve({ data: [{ status: 'pending' }] });
      },
    );
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      isFallbackInProgress: () => fallbackInProgress,
      sessionClient: {
        todo: mock(async () => todos),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();
    fallbackInProgress = true;
    releaseTodos?.();
    await flushContinuation();

    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('final gate blocks a terminal result that arrives during SDK queries', async () => {
    const board = new BackgroundJobBoard();
    let childrenCalls = 0;
    let releaseLatestChildren: (() => void) | undefined;
    const latestChildren = new Promise<{ data: Array<unknown> }>((resolve) => {
      releaseLatestChildren = () => resolve({ data: [] });
    });
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      backgroundJobBoard: board,
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
        children: mock(async () => {
          childrenCalls++;
          return childrenCalls === 1 ? { data: [] } : latestChildren;
        }),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();
    setupCompletedJob(board);
    releaseLatestChildren?.();
    await flushContinuation();

    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('instance disposal invalidates an evaluation whose timer already fired', async () => {
    let releaseTodos: (() => void) | undefined;
    const todos = new Promise<{ data: Array<{ status: string }> }>(
      (resolve) => {
        releaseTodos = () => resolve({ data: [{ status: 'pending' }] });
      },
    );
    const promptAsync = mock(async () => ({}));
    const { hook } = createHook({
      idleReconcileDelayMs: 0,
      sessionClient: {
        todo: mock(async () => todos),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
        promptAsync,
      },
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await flushContinuation();
    await hook.event({ event: { type: 'server.instance.disposed' } });
    releaseTodos?.();
    await flushContinuation();

    expect(promptAsync).not.toHaveBeenCalled();
  });
});
