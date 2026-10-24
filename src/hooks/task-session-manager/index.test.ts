import {
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { SessionLifecycle } from '../../hooks/session-lifecycle';
import { createTaskReviveTool } from '../../tools/task-revive';
import {
  BackgroundJobSupervisor,
  BackgroundTaskConcurrency,
  createInternalAgentTextPart,
  getBackgroundJobLifecycleLedger,
  BackgroundJobBoard as ProductionBoard,
} from '../../utils';
import { BackgroundJobBoard } from '../../utils/background-job-fixture';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
} from '../../utils/background-job-terminal-gate';
import * as logger from '../../utils/logger';
import { DEFAULT_RUNTIME_SESSION_STATUS_TIMEOUT_MS } from '../../utils/session-runtime-status';
import {
  createPhaseReminderHook,
  PHASE_REMINDER_METADATA_KEY,
} from '../phase-reminder';
import {
  type InjectionState,
  injectBackgroundJobBoard,
  pruneReopenCorrectionState,
} from './board-injection';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  createTaskSessionManagerHook,
} from './index';
import {
  createPendingCallTracker,
  type PendingCallTracker,
} from './pending-call-tracker';
import { resetUserWaitGateForTests } from './user-wait-gate';

// Route getClient back to _ctx.client so existing _ctx.client.session
// mocks continue to work through the new v2 lookup path.
mock.module('../../utils/opencode-client', () => ({
  getClient: (input: { client: unknown }) => input.client as never,
}));

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

function mockIdleClock() {
  const clock = createSupervisorClock();
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
    clock.setTimeout as never,
  );
  const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(
    clock.clearTimeout as never,
  );
  return {
    ...clock,
    restore: () => {
      timerSpy.mockRestore();
      clearSpy.mockRestore();
    },
  };
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
  terminalGate?: BackgroundJobTerminalGate;
  hostOutcomeClock?: 'shared-unix-ms';
  sessionStatus?: unknown;
  sessionClient?: Record<string, unknown>;
  idleReconcileDelayMs?: number;
  runtimeStatusReconcileDelayMs?: number;
  isFallbackInProgress?: (sessionID: string) => boolean;
  willAttemptFallback?: (sessionID: string) => boolean;
  fallbackFailureReason?: (sessionID: string) => string;
  coordinator?: SessionLifecycle;
  backgroundJobSupervisor?: BackgroundJobSupervisor;
  backgroundTaskConcurrency?: BackgroundTaskConcurrency;
  pendingCallTracker?: PendingCallTracker;
  getModelForAgent?: (agentType: string) => string | undefined;
  hostFlavor?: string;
  isDisposed?: () => boolean;
};

function createHook(options?: HookOptions) {
  // Adapter tests supply independent host transcript evidence explicitly.
  // A synthetic occurrence alone never seeds this source.
  const transcripts = new Map<
    string,
    { generation?: number; data: unknown[] }
  >();
  function complete(taskID: string, text: string, error = false) {
    transcripts.set(taskID, {
      generation: options?.backgroundJobBoard?.get(taskID)?.generation,
      data: [
        {
          info: {
            id: `answer-${taskID}`,
            role: 'assistant',
            finish: 'stop',
            time: { completed: Date.now() },
            ...(error ? { error: text } : {}),
          },
          parts: error ? [] : [{ type: 'text', text }],
        },
      ],
    });
  }
  const hook = createTaskSessionManagerHook(
    {
      client: {
        session: {
          status: mock(async () => ({ data: options?.sessionStatus ?? {} })),
          messages: async ({ path }: { path: { id: string } }) => {
            const transcript = transcripts.get(path.id);
            if (!transcript) return undefined;
            const generation = options?.backgroundJobBoard?.get(
              path.id,
            )?.generation;
            return {
              data:
                transcript.generation !== undefined &&
                generation !== transcript.generation
                  ? [
                      ...transcript.data,
                      {
                        info: {
                          role: 'assistant',
                          id: `pending-${generation}`,
                        },
                        parts: [],
                      },
                    ]
                  : transcript.data,
            };
          },
          ...options?.sessionClient,
        },
      },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 2,
      backgroundJobBoard: options?.backgroundJobBoard,
      terminalGate: options?.terminalGate,
      hostOutcomeClock: options?.hostOutcomeClock,
      backgroundJobSupervisor: options?.backgroundJobSupervisor,
      backgroundTaskConcurrency: options?.backgroundTaskConcurrency,
      pendingCallTracker: options?.pendingCallTracker,
      getModelForAgent: options?.getModelForAgent,
      shouldManageSession: options?.shouldManageSession ?? (() => true),
      registerSessionAsOrchestrator: options?.registerSessionAsOrchestrator,
      isFallbackInProgress: options?.isFallbackInProgress,
      willAttemptFallback: options?.willAttemptFallback,
      fallbackFailureReason: options?.fallbackFailureReason,
      coordinator: options?.coordinator,
      idleReconcileDelayMs: options?.idleReconcileDelayMs,
      runtimeStatusReconcileDelayMs: options?.runtimeStatusReconcileDelayMs,
      hostFlavor: options?.hostFlavor,
      isDisposed: options?.isDisposed,
    },
  );

  return { hook, complete };
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

/**
 * A request whose history carries an assistant turn NEWER than the record's
 * terminal time: the parent demonstrably moved past the terminal report.
 * That is the stale-terminal fallback's retirement trigger (issue #1647 —
 * the board no longer renders, so prompt-shape consumption is gone).
 */
function createMessagesAfterAssistantTurn(
  sessionID: string,
  text = 'user message',
  assistantAt = Date.now() + 60_000,
) {
  return {
    messages: [
      {
        info: {
          role: 'assistant',
          agent: 'orchestrator',
          sessionID,
          time: { created: assistantAt },
        },
        parts: [{ type: 'text', text: 'previous answer' }],
      },
      {
        info: { role: 'user', agent: 'orchestrator', sessionID },
        parts: [{ type: 'text', text }],
      },
    ],
  };
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

/** Direct board-injection state for a v2 boardless parent: enough wiring to
 *  drive `injectBackgroundJobBoard` and inspect its delivery seen-set. */
function createBoardlessInjectionState(
  board: BackgroundJobBoard,
): InjectionState {
  return {
    backgroundJobBoard: board,
    terminalGate: {} as never,
    lifecycleLedger: {} as never,
    hostFlavor: 'v2',
    boardInjection: false,
    processedInjectedCompletions: new Set(),
    processedInjectedCompletionOrder: [],
    terminalJobsInjectedByParent: new Map(),
    pendingInjectedTerminalJobsByParent: new Map(),
    metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
    shouldManageSession: () => true,
    taskContextTracker: {
      pendingManagedTaskIds: new Set(),
      contextFilesForPrompt: () => [],
      prune: () => {},
    },
  } as unknown as InjectionState;
}

/** Mirrors the native-delivery seen key built in board-injection.ts: host
 *  message id, first-part index, content hash. */
function deliverySeenKey(message: {
  info: { id: string };
  parts: { text: string }[];
}): string {
  const textHash = createHash('sha256')
    .update(message.parts[0].text)
    .digest('hex');
  return `${message.info.id}:0:${textHash}`;
}

describe('task-session-manager hook', () => {
  beforeEach(() => {
    // Process-global gate only — never reset inside createHook/production paths.
    resetUserWaitGateForTests();
  });

  test('queues background task admission until an earlier task releases its slot', async () => {
    const concurrency = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const { hook } = createHook({
      backgroundTaskConcurrency: concurrency,
      getModelForAgent: () => 'openai/fast',
    });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          background: true,
          subagent_type: 'explorer',
          description: 'first task',
        },
      },
    );

    const secondAdmission = hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      {
        args: {
          background: true,
          subagent_type: 'fixer',
          description: 'second task',
        },
      },
    );
    await Promise.resolve();
    expect(concurrency.snapshot()).toEqual({ active: 1, queued: 1 });

    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { output: taskLaunchOutput('ses_first') },
    );
    concurrency.releaseTask('ses_first');
    await secondAdmission;

    expect(concurrency.snapshot()).toEqual({ active: 1, queued: 0 });
  });

  test('only a fresh background launch by a tracked task call carries GC provenance', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    for (const [callID, background] of [
      ['call-bg', true],
      ['call-fg', false],
    ] as const) {
      await hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID },
        {
          args: {
            background,
            subagent_type: 'oracle',
            description: `${callID} work`,
          },
        },
      );
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'parent-1', callID },
        { output: taskLaunchOutput(`ses_${callID}`) },
      );
    }
    expect(board.get('ses_call-bg')).toMatchObject({
      background: true,
      pluginLaunched: true,
    });
    expect(board.get('ses_call-bg')?.externalOrigin).toBeUndefined();
    expect(board.get('ses_call-fg')?.background).toBe(false);
    expect(board.get('ses_call-fg')?.pluginLaunched).toBeUndefined();
  });

  test('an ID-only task output promotes its own placeholder with launch metadata', async () => {
    const board = new BackgroundJobBoard();
    const onLaunch = mock(() => {});
    const { hook } = createHook({
      backgroundJobBoard: board,
      backgroundJobSupervisor: { onLaunch } as never,
    });
    board.registerLaunch({
      taskID: 'ses_child',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      provisional: true,
      now: 100,
    });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          background: true,
          subagent_type: 'oracle',
          description: 'owned call',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output:
          'task_id: ses_child (for resuming to continue this task if needed)\n\n<task_result>done</task_result>',
      },
    );

    const record = board.get('ses_child');
    expect(record?.provisional).toBe(false);
    expect(record?.state).toBe('running');
    expect(record?.background).toBe(true);
    expect(record?.description).toBe('owned call');
    expect(record?.objective).toBe('owned call');
    // A once-provisional placeholder never becomes a GC candidate.
    expect(record?.externalOrigin).toBe(true);
    expect(record?.pluginLaunched).toBeUndefined();
    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ taskID: 'ses_child' }),
    );
  });

  test('a promoted foreground launch output marks the board record background', async () => {
    const board = new BackgroundJobBoard();
    const onLaunch = mock(() => {});
    const { hook } = createHook({
      backgroundJobBoard: board,
      backgroundJobSupervisor: { onLaunch } as never,
    });
    board.registerLaunch({
      taskID: 'ses_promoted',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      provisional: true,
      now: 100,
    });

    // Foreground call (no background arg): the child was awaited by a
    // synchronous task() that foreground-fallback promoted mid-flight.
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          subagent_type: 'oracle',
          description: 'foreground promoted call',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: taskLaunchOutput('ses_promoted'),
        metadata: { background: true },
      },
    );

    const record = board.get('ses_promoted');
    expect(record?.provisional).toBe(false);
    expect(record?.state).toBe('running');
    expect(record?.background).toBe(true);
    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ taskID: 'ses_promoted' }),
    );
  });

  test('finishes a queued call after its manager generation is replaced', async () => {
    const concurrency = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const pendingCallTracker = createPendingCallTracker();
    const firstGeneration = createHook({
      backgroundTaskConcurrency: concurrency,
      pendingCallTracker,
    });

    await firstGeneration.hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          background: true,
          subagent_type: 'explorer',
          description: 'first generation task',
        },
      },
    );
    await firstGeneration.hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { output: taskLaunchOutput('child-1') },
    );

    const queuedCall = firstGeneration.hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      {
        args: {
          background: true,
          subagent_type: 'fixer',
          description: 'handoff task',
        },
      },
    );
    expect(concurrency.snapshot()).toEqual({ active: 1, queued: 1 });

    await firstGeneration.hook.event({
      event: { type: 'server.instance.disposed' },
    });

    const secondGeneration = createHook({
      backgroundJobBoard: new BackgroundJobBoard(),
      backgroundTaskConcurrency: concurrency,
      pendingCallTracker,
    });
    concurrency.releaseTask('child-1');
    await queuedCall;
    await secondGeneration.hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      { output: taskLaunchOutput('child-2') },
    );

    expect(secondGeneration.hook).toBeDefined();
    expect(concurrency.snapshot()).toEqual({ active: 1, queued: 0 });
    concurrency.releaseTask('child-2');
  });

  test('hands an early session.created registration to the next generation', async () => {
    const concurrency = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const pendingCallTracker = createPendingCallTracker();
    const firstBoard = new BackgroundJobBoard();
    // Force the source registration onto a different board-generation number
    // than the fresh target board. The handoff must update the generation
    // fence rather than rejecting the valid terminal result as stale.
    firstBoard.registerLaunch({
      taskID: 'child-early',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'stale prior run',
    });
    firstBoard.drop('child-early');
    const firstGeneration = createHook({
      backgroundJobBoard: firstBoard,
      backgroundTaskConcurrency: concurrency,
      pendingCallTracker,
    });

    await firstGeneration.hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-early' },
      {
        args: {
          background: true,
          subagent_type: 'explorer',
          description: 'early handoff task',
        },
      },
    );
    await firstGeneration.hook.event({
      event: {
        type: 'session.created',
        properties: {
          info: {
            id: 'child-early',
            parentID: 'parent-1',
            agent: 'explorer',
          },
        },
      },
    });
    expect(firstBoard.get('child-early')).toMatchObject({
      state: 'running',
      agent: 'explorer',
    });

    await firstGeneration.hook.event({
      event: { type: 'server.instance.disposed' },
    });

    const secondBoard = new BackgroundJobBoard();
    // The assembly, not the after-hook, owns terminal capacity release.
    secondBoard.addTerminalOutcomeListener((record) =>
      concurrency.releaseTask(record.taskID),
    );
    const secondGeneration = createHook({
      backgroundJobBoard: secondBoard,
      backgroundTaskConcurrency: concurrency,
      pendingCallTracker,
    });

    expect(firstBoard.get('child-early')).toBeUndefined();
    expect(secondBoard.get('child-early')).toMatchObject({
      state: 'running',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const terminalOutput = [
      'task_id: child-early',
      'state: completed',
      '',
      '<task_result>',
      'completed after handoff',
      '</task_result>',
    ].join('\n');
    // The disposed generation must not consume the transferred pending call
    // or release its still-live admission ticket.
    await firstGeneration.hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-early' },
      { output: terminalOutput },
    );
    expect(concurrency.snapshot()).toEqual({ active: 1, queued: 0 });

    await secondGeneration.hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-early' },
      { output: terminalOutput },
    );

    expect(secondBoard.get('child-early')).toMatchObject({
      state: 'completed',
      resultSummary: 'completed after handoff',
    });
    expect(concurrency.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  test('parent deletion cancels queued calls owned by the shared tracker', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const concurrency = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const pendingCallTracker = createPendingCallTracker();
    const { hook } = createHook({
      coordinator,
      backgroundTaskConcurrency: concurrency,
      pendingCallTracker,
    });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args: { background: true, subagent_type: 'explorer' } },
    );
    const queuedCall = hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      { args: { background: true, subagent_type: 'fixer' } },
    );

    coordinator.dispatchSessionDeleted('parent-1');
    await expect(queuedCall).rejects.toThrow(
      'Background task concurrency queue was cancelled',
    );
    expect(concurrency.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  test('exempts managed-task sessions from background admission (nested orchestration)', async () => {
    const concurrency = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    // A session that is itself a managed background task.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'nested orchestrator',
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      backgroundTaskConcurrency: concurrency,
      getModelForAgent: () => 'openai/fast',
    });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          background: true,
          subagent_type: 'explorer',
          description: 'outer task',
        },
      },
    );
    expect(concurrency.snapshot()).toEqual({ active: 1, queued: 0 });

    // The only slot is taken, so a non-exempt caller would queue here and
    // never be admitted while the managed child stays blocked on itself.
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_child', callID: 'call-2' },
      {
        args: {
          background: true,
          subagent_type: 'explorer',
          description: 'nested task',
        },
      },
    );
    expect(concurrency.snapshot()).toEqual({ active: 1, queued: 0 });
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

    // The board is never rendered (issue #1647): the payload keeps its
    // message count and carries no board bytes.
    expect(messages.messages).toHaveLength(5);
    expect(boardText(messages)).toBeUndefined();
  });

  test('T-A: F4 resumes only a cropped own terminal child', async () => {
    const logs = spyOn(logger, 'log').mockImplementation(() => {});
    const host = (id: string) => {
      if (id === 'ses_missing') throw new Error('host unavailable');
      return {
        data: {
          parentID: id === 'ses_foreign' ? 'other' : 'parent-1',
          title:
            id === 'ses_other_agent'
              ? 'work (@oracle subagent)'
              : 'work (@explorer subagent)',
          time: { created: 150, updated: 160 },
        },
      };
    };
    const get = mock(async ({ path }: { path: { id: string } }) =>
      host(path.id),
    );
    const status = mock(
      async (): Promise<{ data: Record<string, unknown> }> => ({ data: {} }),
    );
    const fallback = new Set<string>();
    const coordinator = new SessionLifecycle(() => {});
    const board = new BackgroundJobBoard();
    const { hook, complete } = createHook({
      backgroundJobBoard: board,
      sessionClient: { get, status },
      coordinator,
      isFallbackInProgress: (id) => fallback.has(id),
    });
    complete('ses_own', 'done');
    complete('ses_error', 'child failed', true);
    complete('ses_foreign', 'done');
    complete('ses_other_agent', 'done');
    complete('ses_gone', 'done');
    complete('ses_slow', 'done');
    complete('ses_late', 'done');
    const visible = (created: number) => ({
      messages: [
        {
          info: { role: 'assistant', sessionID: 'parent-1', time: { created } },
          parts: [],
        },
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
            time: { created: 500 },
          },
          parts: [{ type: 'text', text: 'continue' }],
        },
      ],
    });
    const resume = (task_id: string) =>
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: task_id },
        { args: { task_id, subagent_type: 'explorer', prompt: 'continue' } },
      );
    const refuse = async (id: string) => {
      const message = await resume(id).then(
        () => 'unexpected resume',
        (error: Error) => error.message,
      );
      expect(message).toBe(
        `Task ${id}: task() cannot resolve this task_id. It was not dropped; no new session was created. Omit task_id on a separate call to start a new session.`,
      );
      expect(logs.mock.calls.at(-1)).toEqual([
        '[task-session-manager] refused explicit task_id',
        { task_id: id, unresolved: true },
      ]);
      expect(board.get(id)).toBeUndefined();
    };
    try {
      const full = visible(100);
      const before = structuredClone(full);
      await hook['experimental.chat.messages.transform']({}, full);
      expect(full).toEqual(before);
      expect(get).not.toHaveBeenCalled();
      await refuse('ses_own');
      await hook['experimental.chat.messages.transform']({}, visible(200));
      await hook['experimental.chat.messages.transform'](
        {},
        {
          messages: [
            {
              info: { role: 'user', sessionID: 'child', time: { created: 1 } },
              parts: [],
            },
          ],
        },
      );
      await refuse('ses_foreign');
      await refuse('ses_other_agent');
      await refuse('ses_missing');
      await refuse('ses_nonterminal');
      // G1 busy
      status.mockImplementationOnce(async () => ({
        data: { ses_own: { type: 'busy' } },
      }));
      await refuse('ses_own');
      // G1 status error
      status.mockImplementationOnce(async () => {
        throw new Error('status unavailable');
      });
      await refuse('ses_own');
      // G1 malformed status
      status.mockImplementationOnce(async () => ({
        data: { ses_own: { type: 'compacting' } },
      }));
      await refuse('ses_own');
      // G1 pending fallback
      fallback.add('ses_error');
      await refuse('ses_error');
      fallback.clear();
      // G2 deleted child
      get.mockImplementationOnce(async ({ path }) => {
        coordinator.dispatchSessionDeleted(path.id);
        return host(path.id);
      });
      await refuse('ses_gone');
      // G3 deadline and no late adoption
      const reached = Promise.withResolvers<void>();
      const delayed = Promise.withResolvers<void>();
      get.mockImplementationOnce(async ({ path }) => {
        reached.resolve();
        await delayed.promise;
        return host(path.id);
      });
      jest.useFakeTimers();
      const stalled = refuse('ses_slow');
      await reached.promise;
      jest.advanceTimersByTime(DEFAULT_RUNTIME_SESSION_STATUS_TIMEOUT_MS);
      delayed.resolve();
      await stalled;
      jest.useRealTimers();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(board.get('ses_slow')).toBeUndefined();
      await resume('ses_own');
      const own = board.get('ses_own');
      if (!own) throw new Error('own child was not adopted');
      expect(own?.state).toBe('reconciled');
      expect(own?.terminalState).toBe('completed');
      expect(
        board.acquireLease('ses_own', own.generation, 'relaunch'),
      ).toBeUndefined();
      await resume('ses_error');
      expect(board.get('ses_error')).toMatchObject({
        terminalState: 'error',
        resultSummary: 'child failed',
      });
      // G2 deleted parent
      get.mockImplementationOnce(async ({ path }) => {
        coordinator.dispatchSessionDeleted('parent-1');
        return host(path.id);
      });
      await refuse('ses_late');
    } finally {
      jest.useRealTimers();
      await hook.event({ event: { type: 'server.instance.disposed' } });
      logs.mockRestore();
    }
  });

  test('a timestampless busy on a restored round reads live status before trusting it', async () => {
    const board = new BackgroundJobBoard();
    board.restoreRetainedSession({
      taskID: 'ses_restored',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'restored',
      state: 'completed',
      background: true,
      resultSummary: 'old',
      launchedAt: 10,
      completedAt: 20,
    });
    const status = mock(async () => ({
      data: { ses_restored: { type: 'busy' } },
    }));
    const { hook } = createHook({
      backgroundJobBoard: board,
      sessionClient: { status },
    });
    try {
      await hook.event({
        event: {
          type: 'session.status',
          properties: { sessionID: 'ses_restored', status: { type: 'busy' } },
        },
      } as never);
      expect(status).toHaveBeenCalledTimes(1);
      expect(board.get('ses_restored')?.state).toBe('running');
      expect(board.hasRunningJobs()).toBe(true);
    } finally {
      await hook.event({ event: { type: 'server.instance.disposed' } });
    }
  });

  test('native v1 adoption waits for host evidence and dispose writes no lease', async () => {
    let disposed = false;
    let releaseGet: (value: unknown) => void = () => {};
    const get = mock(
      () =>
        new Promise((resolve) => {
          releaseGet = resolve;
        }),
    );
    const board = new BackgroundJobBoard();
    const pendingCallTracker = createPendingCallTracker();
    const markUsed = spyOn(board, 'markUsed');
    const acquire = spyOn(board, 'acquireLease');
    const adopt = spyOn(board, 'adoptTerminal');
    const { hook, complete } = createHook({
      backgroundJobBoard: board,
      pendingCallTracker,
      sessionClient: {
        get,
        status: mock(async () => ({ data: {} })),
      },
      isDisposed: () => disposed,
    });
    complete('ses_waiting', 'done');
    await hook['experimental.chat.messages.transform'](
      {},
      {
        messages: [
          {
            info: {
              role: 'assistant',
              sessionID: 'parent-1',
              time: { created: 100 },
            },
            parts: [],
          },
          {
            info: {
              role: 'user',
              agent: 'orchestrator',
              sessionID: 'parent-1',
              time: { created: 500 },
            },
            parts: [{ type: 'text', text: 'continue' }],
          },
        ],
      },
    );
    const pending = hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'dispose-adopt' },
      {
        args: {
          task_id: 'ses_waiting',
          subagent_type: 'explorer',
          prompt: 'continue',
        },
      },
    );
    disposed = true;
    releaseGet({
      data: {
        parentID: 'parent-1',
        title: 'work (@explorer subagent)',
        time: { created: 50, updated: 160 },
      },
    });
    await expect(pending).rejects.toThrow(
      'The plugin instance was disposed. No action was sent. No session was created.',
    );
    expect(board.get('ses_waiting')).toBeUndefined();
    expect(adopt).not.toHaveBeenCalled();
    // No relaunch lease was acquired (the collapsed single acquire seam is
    // spied: assert no acquisition of this flow's kind happened).
    expect(acquire.mock.calls.some((call) => call[2] === 'relaunch')).toBe(
      false,
    );
    expect(markUsed).not.toHaveBeenCalled();
    expect(pendingCallTracker.peekByParent('parent-1')).toBeUndefined();
  });

  test.each(['orchestrator', 'build', 'custom-primary'])(
    'rehydrates historical background tasks for managed %s and keeps absent children provisional',
    async (agent) => {
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
          ...createMessages('parent-1', 'continue').messages.map((message) => ({
            ...message,
            info: { ...message.info, agent },
          })),
        ],
      };

      await transformMessages(hook, messages as never);

      expect(board.get('historical-child')).toMatchObject({
        alias: 'historical-child',
        state: 'running',
        statusUncertain: true,
        background: true,
        agent: 'explorer',
        description: 'recover scheduler task',
        objective: 'recover scheduler task',
        // Rehydrated children are never terminal-session GC candidates.
        externalOrigin: true,
      });
      expect(board.get('historical-child')?.pluginLaunched).toBeUndefined();
      expect(board.get('historical-child')?.statusUncertain).toBe(true);
      // An existing child does not consume a number.
      expect(
        board.registerLaunch({
          taskID: 'new-child',
          parentSessionID: 'parent-1',
          agent: 'explorer',
        }).alias,
      ).toBe('exp-1');
    },
  );

  test('rehydrated long objectives keep the duplicate-spawn guard effective', async () => {
    const board = new BackgroundJobBoard();
    const status = mock(async () => ({ data: {} }));
    const { hook } = createHook({
      backgroundJobBoard: board,
      sessionClient: { status },
      runtimeStatusReconcileDelayMs: 60_000,
    });
    const longObjective = `${'z'.repeat(60)} rehydrated objective`;
    const messages = {
      messages: [
        {
          info: {
            role: 'assistant',
            sessionID: 'parent-1',
          },
          parts: [
            historicalRunningTaskPart('historical-long', {
              background: true,
              subagent_type: 'oracle',
              description: longObjective,
            }),
          ],
        },
        ...createMessages('parent-1', 'continue').messages,
      ],
    };

    await transformMessages(hook, messages as never);

    // Rehydration stores the untruncated objective, not just the label.
    expect(board.get('historical-long')).toMatchObject({
      description: longObjective.slice(0, 48),
      objective: longObjective,
    });

    // Mark it terminal-unreconciled, then spawn an exact duplicate.
    board.updateStatus({
      taskID: 'historical-long',
      state: 'stopped',
      resultSummary: 'no result',
      now: 200,
    });
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'rehydrated-dup' },
        {
          args: {
            subagent_type: 'oracle',
            background: true,
            description: longObjective,
          },
        },
      ),
    ).rejects.toThrow('awaiting acknowledgment');
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
      state: 'running',
      statusUncertain: true,
    });
  });

  test('contrasts current runtime and result evidence before consuming historical completion', async () => {
    const board = new BackgroundJobBoard();
    const status = mock(async () => ({ data: {} }));
    const { hook, complete } = createHook({
      backgroundJobBoard: board,
      sessionClient: { status },
      runtimeStatusReconcileDelayMs: 60_000,
    });
    complete('completed-child', 'historical result');
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
    expect(status).toHaveBeenCalled();
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
      state: 'running',
      statusUncertain: true,
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

    // The launch lives on the machine board (issue #1647): it is never
    // rendered into the payload.
    expect(board.get('child-1')).toMatchObject({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map scheduler hooks',
      state: 'running',
      alias: 'exp-1',
    });
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0].parts[0].text).toBe('do something');
    expect(boardText(messages)).toBeUndefined();
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

  test('board-off retires an observed native delivery without injecting any board part', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
      now: 500,
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
      now: 1000,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      boardInjection: false,
      hostFlavor: 'v2',
      idleReconcileDelayMs: 0,
    });

    // First real orchestrator turn, no delivery yet: no board part is
    // placed and the terminal job stays unreconciled — nothing is
    // registered against the prompt shape anymore.
    const firstRequest = createMessages('parent-1', 'first turn');
    await transformMessages(hook, firstRequest);
    expect(
      firstRequest.messages.flatMap((message) =>
        message.parts.filter((part) => isBoardPartForTest(part)),
      ),
    ).toHaveLength(0);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
    expect(board.hasTerminalUnreconciled('parent-1')).toBe(true);

    // The host's native delivery lands in history: the observer retires
    // the record on this transform, still with no board part placed.
    const deliveredRequest = {
      messages: [
        ...firstRequest.messages,
        {
          info: {
            id: 'delivery-1',
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
            time: { created: 2000 },
          },
          parts: [
            {
              type: 'text',
              text: '<subagent sessionID="child-1" state="completed" description="map hooks">\ndone\n</subagent>',
              metadata: {
                source: 'subagent',
                childID: 'child-1',
                state: 'completed',
              },
            },
          ],
        },
      ],
    };
    await transformMessages(hook, deliveredRequest as never);
    expect(
      deliveredRequest.messages.flatMap((message) =>
        (message as { parts: unknown[] }).parts.filter((part) =>
          isBoardPartForTest(part as { metadata?: Record<string, unknown> }),
        ),
      ),
    ).toHaveLength(0);
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
    expect(board.hasTerminalUnreconciled('parent-1')).toBe(false);

    // Replaying the same history is a dedupe no-op.
    await transformMessages(hook, deliveredRequest as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('board-off ignores deliveries for unknown sessionIDs', async () => {
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
      now: 1000,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      boardInjection: false,
      hostFlavor: 'v2',
      idleReconcileDelayMs: 0,
    });

    const deliveredRequest = {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ type: 'text', text: 'first turn' }],
        },
        {
          info: { id: 'delivery-unknown', role: 'user', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              text: '<subagent sessionID="child-unknown" state="completed" description="other">\ndone\n</subagent>',
              metadata: {
                source: 'subagent',
                childID: 'child-unknown',
                state: 'completed',
              },
            },
          ],
        },
      ],
    };
    await transformMessages(hook, deliveredRequest as never);
    expect(board.get('child-unknown')).toBeUndefined();
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('board-off ignores a mismatched delivery for a stopped record', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'stopped',
      resultSummary: 'stopped without a terminal result',
      now: 1000,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      boardInjection: false,
      hostFlavor: 'v2',
      idleReconcileDelayMs: 0,
    });

    // Even a completed-shaped delivery for the stopped taskID cannot retire
    // it: state equality fails, and stops retire only through the
    // recovery-wake + task_revive ack flow.
    const deliveredRequest = {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ type: 'text', text: 'first turn' }],
        },
        {
          info: { id: 'delivery-1', role: 'user', sessionID: 'parent-1' },
          parts: [
            {
              type: 'text',
              text: '<subagent sessionID="child-1" state="completed" description="map hooks">\ndone\n</subagent>',
              metadata: {
                source: 'subagent',
                childID: 'child-1',
                state: 'completed',
              },
            },
          ],
        },
      ],
    };
    await transformMessages(hook, deliveredRequest as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
    });
  });

  test('board-off pairs repeated deliveries FIFO across terminal revisions', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
      now: 500,
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'first result',
      now: 1000,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      boardInjection: false,
      hostFlavor: 'v2',
      idleReconcileDelayMs: 0,
    });
    const firstRevision = board.get('child-1')?.terminalRevision;

    const firstDelivery = {
      info: {
        id: 'delivery-1',
        role: 'user',
        sessionID: 'parent-1',
        time: { created: 1100 },
      },
      parts: [
        {
          type: 'text',
          text: '<subagent sessionID="child-1" state="completed" description="map hooks">\nfirst result\n</subagent>',
          metadata: {
            source: 'subagent',
            childID: 'child-1',
            state: 'completed',
          },
        },
      ],
    };
    await transformMessages(hook, {
      messages: [
        createMessages('parent-1', 'first turn').messages[0],
        firstDelivery,
      ],
    } as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
      terminalRevision: firstRevision,
    });

    // The run reopens and completes again: a second native delivery for
    // the newer revision retires it, while replaying the first delivery is
    // a dedupe no-op.
    board.markRunningFromLiveSession('child-1', 1500);
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'second result',
      now: 2000,
    });
    const secondRevision = board.get('child-1')?.terminalRevision;
    expect(secondRevision).not.toBe(firstRevision);
    expect(board.get('child-1')).toMatchObject({ terminalUnreconciled: true });

    const secondDelivery = {
      info: {
        id: 'delivery-2',
        role: 'user',
        sessionID: 'parent-1',
        time: { created: 2100 },
      },
      parts: [
        {
          type: 'text',
          text: '<subagent sessionID="child-1" state="completed" description="map hooks">\nsecond result\n</subagent>',
          metadata: {
            source: 'subagent',
            childID: 'child-1',
            state: 'completed',
          },
        },
      ],
    };
    const replayedHistory = {
      messages: [
        createMessages('parent-1', 'first turn').messages[0],
        firstDelivery,
        secondDelivery,
      ],
    };
    await transformMessages(hook, replayedHistory as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
      terminalRevision: secondRevision,
    });
  });

  test('board-off fallback retires a completed record older than the newest parent assistant turn', async () => {
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
      now: 1000,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      boardInjection: false,
      hostFlavor: 'v2',
      idleReconcileDelayMs: 0,
    });

    // No native delivery in history, but the parent demonstrably moved
    // past the terminal report: unconditional retire.
    const advancedRequest = {
      messages: [
        {
          info: { id: 'm-1', role: 'user', sessionID: 'parent-1' },
          parts: [{ type: 'text', text: 'first turn' }],
        },
        {
          info: {
            id: 'm-2',
            role: 'assistant',
            sessionID: 'parent-1',
            time: { created: 2000 },
          },
          parts: [{ type: 'text', text: 'consumed the native result' }],
        },
      ],
    };
    await transformMessages(hook, advancedRequest as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('board-off fallback retires on v2 wire-form numeric timestamps', async () => {
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
      now: 1000,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      boardInjection: false,
      idleReconcileDelayMs: 0,
    });

    // JSON round-trips of a v2 message carry `time` as a finite
    // epoch-millis number. The fallback must read it too.
    const advancedRequest = {
      messages: [
        {
          info: { id: 'm-1', role: 'user', sessionID: 'parent-1' },
          parts: [{ type: 'text', text: 'first turn' }],
        },
        {
          info: {
            id: 'm-2',
            role: 'assistant',
            sessionID: 'parent-1',
            time: 2000,
          },
          parts: [{ type: 'text', text: 'consumed the native result' }],
        },
      ],
    };
    await transformMessages(hook, advancedRequest as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('board-off fallback retires on v2 decoded DateTime.Utc timestamps', async () => {
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
      now: 1000,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      boardInjection: false,
      idleReconcileDelayMs: 0,
    });

    // The host decodes Session.Message.time into Effect DateTime.Utc
    // instances: `created` is a struct with `epochMilliseconds`, not a
    // number. The stale fallback must read it (greptile P1: the fallback
    // never fired on real v2 messages).
    const advancedRequest = {
      messages: [
        {
          info: { id: 'm-1', role: 'user', sessionID: 'parent-1' },
          parts: [{ type: 'text', text: 'first turn' }],
        },
        {
          info: {
            id: 'm-2',
            role: 'assistant',
            sessionID: 'parent-1',
            time: { created: { _tag: 'Utc', epochMilliseconds: 2000 } },
          },
          parts: [{ type: 'text', text: 'consumed the native result' }],
        },
      ],
    };
    await transformMessages(hook, advancedRequest as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('board-off fallback fails closed without comparable timestamps', async () => {
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
      now: 3000,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      boardInjection: false,
      hostFlavor: 'v2',
      idleReconcileDelayMs: 0,
    });

    // The terminal report (3000) is NEWER than the newest assistant turn
    // (2000): the parent has not moved past it, so it stays unreconciled.
    const pendingRequest = {
      messages: [
        {
          info: { id: 'm-1', role: 'user', sessionID: 'parent-1' },
          parts: [{ type: 'text', text: 'first turn' }],
        },
        {
          info: {
            id: 'm-2',
            role: 'assistant',
            sessionID: 'parent-1',
            time: { created: 2000 },
          },
          parts: [{ type: 'text', text: 'still working' }],
        },
      ],
    };
    await transformMessages(hook, pendingRequest as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });

    // And history without any assistant timestamps cannot retire either.
    await transformMessages(
      hook,
      createAnchoredMessages('parent-1', ['first turn', 'next step']) as never,
    );
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('cancelled records retire once the parent moved past the report', async () => {
    // Greptile P1-1 regression, migrated (issue #1647): v1 delivers
    // completions in untagged formats the native-delivery observer cannot
    // parse, and no plugin push carries a cancellation — so the stale-
    // terminal fallback must cover cancelled too, or cancelled records stay
    // unreconciled forever (pending delegated work, same-objective
    // rejections).
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'cancelled',
      resultSummary: 'cancelled by user',
      now: 1000,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      idleReconcileDelayMs: 0,
    });

    // First turn: the cancelled record is still unreconciled (cancelled is
    // not stopped — the recovery wake does not own it).
    await transformMessages(hook, createMessages('parent-1', 'first turn'));
    expect(board.get('child-1')).toMatchObject({
      state: 'cancelled',
      terminalUnreconciled: true,
    });

    // The parent demonstrably moved past the report: retire.
    await transformMessages(
      hook,
      createMessagesAfterAssistantTurn('parent-1', 'next step') as never,
    );
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('v2 board-off retries a delivery observed before its gate reconciled', async () => {
    // Greptile P1-2 regression: child idle events start terminalGate.reconcile
    // without awaiting it, so a delivery can reach a transform while the
    // board still says running. The observer must NOT consume that delivery —
    // a consumed-early key would forget it forever (cancelled has no
    // timestamp fallback).
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
      now: 500,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      boardInjection: false,
      hostFlavor: 'v2',
      idleReconcileDelayMs: 0,
    });

    const raceRequest = {
      messages: [
        createMessages('parent-1', 'first turn').messages[0],
        {
          info: {
            id: 'delivery-1',
            role: 'user',
            sessionID: 'parent-1',
            time: { created: 2000 },
          },
          parts: [
            {
              type: 'text',
              text: '<subagent sessionID="child-1" state="completed" description="map hooks">\ndone\n</subagent>',
              metadata: {
                source: 'subagent',
                childID: 'child-1',
                state: 'completed',
              },
            },
          ],
        },
      ],
    };
    // Record still running: the delivery is present but not consumable.
    await transformMessages(hook, raceRequest as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
    });

    // The gate finishes; the SAME delivery (still in history, still
    // unconsumed) retires the record on the next transform.
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
      now: 1000,
    });
    expect(board.get('child-1')).toMatchObject({ terminalUnreconciled: true });
    await transformMessages(hook, raceRequest as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('v2 board-off clears consumed delivery keys when the parent session ends', () => {
    // Greptile P2 regression: per-parent key sets must not outlive their
    // parent. pruneReopenCorrectionState is the session-end hook (wired at
    // task-session-manager/index.ts), so the keys die with the parent's
    // other bookkeeping; a recreated session only ever produces fresh
    // message IDs.
    const state = {
      reportedTerminalRunsByParent: new Map([
        ['parent-1', new Map()],
      ]) as unknown as InjectionState['reportedTerminalRunsByParent'],
      observedNativeDeliveries: new Map([
        ['parent-1', new Map([['delivery-1:0:abc', true as const]])],
        ['parent-2', new Map([['delivery-2:0:def', true as const]])],
      ]) as unknown as InjectionState['observedNativeDeliveries'],
    } as never as InjectionState;
    pruneReopenCorrectionState(state, 'parent-1');
    expect(state.observedNativeDeliveries?.has('parent-1')).toBe(false);
    // Other parents are untouched.
    expect(state.observedNativeDeliveries?.has('parent-2')).toBe(true);
    expect(state.reportedTerminalRunsByParent?.has('parent-1')).toBe(false);
  });

  test('v2 board-off never retires a reopened run through an older mismatched delivery', async () => {
    // Greptile P1-2: an old delivery left pending while a child runs can
    // mis-pair with a later same-state completion. Pairing is one-shot per
    // publication: the delivery below was authored for the FIRST terminal
    // publication (state mismatched, so it retired nothing); after the run
    // reopens and completes again, the remembered key can never pair the
    // NEWER publication — only the run's own delivery (or the
    // stale-terminal fallback) retires it. Council-b's "pending until
    // match" semantics are refuted: matching only by state and launch time
    // is exactly the mis-pairing Greptile flagged.
    const BASE = 1_760_000_000_000;
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
      now: BASE + 500,
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'error',
      resultSummary: 'failed',
      now: BASE + 1000,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      boardInjection: false,
      hostFlavor: 'v2',
      idleReconcileDelayMs: 0,
    });
    const staleDelivery = {
      info: {
        id: 'delivery-1',
        role: 'user',
        sessionID: 'parent-1',
        time: { created: BASE + 1200 },
      },
      parts: [
        {
          type: 'text',
          text: '<subagent sessionID="child-1" state="completed" description="map hooks">\ndone\n</subagent>',
          metadata: {
            source: 'subagent',
            childID: 'child-1',
            state: 'completed',
          },
        },
      ],
    };
    await transformMessages(hook, {
      messages: [
        createMessages('parent-1', 'first turn').messages[0],
        staleDelivery,
      ],
    } as never);
    // Observed while the record was error-terminal: state mismatch, key
    // remembered, nothing retired.
    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      terminalUnreconciled: true,
    });

    // The run reopens and completes with the state the OLD delivery
    // reports. The remembered key must not pair this newer publication.
    board.markRunningFromLiveSession('child-1', BASE + 1500);
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
      now: BASE + 2000,
    });
    expect(board.get('child-1')).toMatchObject({ terminalUnreconciled: true });
    await transformMessages(hook, {
      messages: [
        createMessages('parent-1', 'second turn').messages[0],
        staleDelivery,
      ],
    } as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });

    // The run's own delivery (authored after this publication) retires it.
    await transformMessages(hook, {
      messages: [
        createMessages('parent-1', 'second turn').messages[0],
        staleDelivery,
        {
          info: {
            id: 'delivery-2',
            role: 'user',
            sessionID: 'parent-1',
            time: { created: BASE + 2500 },
          },
          parts: [
            {
              type: 'text',
              text: '<subagent sessionID="child-1" state="completed" description="map hooks">\nnew result\n</subagent>',
              metadata: {
                source: 'subagent',
                childID: 'child-1',
                state: 'completed',
              },
            },
          ],
        },
      ],
    } as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('v2 board-off ignores pasted delivery-shaped text without host metadata', async () => {
    // Greptile P1: a user or assistant text part pasting a delivery-shaped
    // body must never acknowledge a child — only the host's
    // sessions.synthetic part carries
    // metadata {source:'subagent', childID, state}, and it must agree with
    // the tag header.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
      now: 500,
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
      now: 1000,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      boardInjection: false,
      hostFlavor: 'v2',
      idleReconcileDelayMs: 0,
    });
    const pastedRequest = {
      messages: [
        createMessages('parent-1', 'first turn').messages[0],
        {
          info: {
            id: 'delivery-1',
            role: 'user',
            sessionID: 'parent-1',
            time: { created: 3000 },
          },
          parts: [
            {
              type: 'text',
              text: '<subagent sessionID="child-1" state="completed" description="map hooks">\ndone\n</subagent>',
            },
          ],
        },
      ],
    };
    await transformMessages(hook, pastedRequest as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });

    // Metadata that disagrees with the tag header is equally rejected.
    const mismatched = {
      messages: [
        createMessages('parent-1', 'second turn').messages[0],
        {
          info: {
            id: 'delivery-2',
            role: 'user',
            sessionID: 'parent-1',
            time: { created: 3100 },
          },
          parts: [
            {
              type: 'text',
              text: '<subagent sessionID="child-1" state="completed" description="map hooks">\ndone\n</subagent>',
              metadata: {
                source: 'subagent',
                childID: 'child-1',
                state: 'error',
              },
            },
          ],
        },
      ],
    };
    await transformMessages(hook, mismatched as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('v2 board-off consumes a delivery provably older than the current launch', async () => {
    // Council-b blocker 2: state equality alone can mis-pair an older
    // run's delivery with a newer run. A delivery authored BEFORE the
    // record's last launch predates the current run and every future one
    // (lastLaunchedAt only advances), so it is consumed without retiring —
    // and cannot mis-retire a reopened run of the same state.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
      now: 500,
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
      now: 1000,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      boardInjection: false,
      hostFlavor: 'v2',
      idleReconcileDelayMs: 0,
    });
    const staleDelivery = {
      info: {
        id: 'delivery-1',
        role: 'user',
        sessionID: 'parent-1',
        time: { created: 400 },
      },
      parts: [
        {
          type: 'text',
          text: '<subagent sessionID="child-1" state="completed" description="map hooks">\nold result\n</subagent>',
          metadata: {
            source: 'subagent',
            childID: 'child-1',
            state: 'completed',
          },
        },
      ],
    };
    await transformMessages(hook, {
      messages: [
        createMessages('parent-1', 'first turn').messages[0],
        staleDelivery,
      ],
    } as never);
    // time 400 < lastLaunchedAt 500: consumed as provably stale, no retire.
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });

    // A later relaunch + same-state completion is NOT retired by the stale
    // delivery: its key is burned and the timestamp check rejects it anyway.
    board.markRunningFromLiveSession('child-1', 2000);
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'new result',
      now: 2500,
    });
    await transformMessages(hook, {
      messages: [
        createMessages('parent-1', 'second turn').messages[0],
        staleDelivery,
      ],
    } as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });

    // The run's own delivery (newer than the relaunch) retires it.
    await transformMessages(hook, {
      messages: [
        createMessages('parent-1', 'second turn').messages[0],
        staleDelivery,
        {
          info: {
            id: 'delivery-2',
            role: 'user',
            sessionID: 'parent-1',
            time: { created: 3000 },
          },
          parts: [
            {
              type: 'text',
              text: '<subagent sessionID="child-1" state="completed" description="map hooks">\nnew result\n</subagent>',
              metadata: {
                source: 'subagent',
                childID: 'child-1',
                state: 'completed',
              },
            },
          ],
        },
      ],
    } as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('board-off does not register stopped jobs (recovery wake owns their retirement)', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'stopped',
      resultSummary: 'stopped without a terminal result',
    });
    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      boardInjection: false,
      hostFlavor: 'v2',
      idleReconcileDelayMs: 0,
    });

    // A stop was never natively delivered, so it must stay unreconciled
    // for the stopped-job recovery wake to surface (retiring it here would
    // let the wake's isCurrent check drop the stop before the parent has
    // seen it, and would clear the same-objective dispatch safeguard).
    await transformMessages(hook, createMessages('parent-1', 'first turn'));
    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
    });

    // The recovery flow retires it: task_revive's ack marks the run
    // reconciled once the parent acts on the stop.
    const acked = board.markReconciled(
      'child-1',
      undefined,
      board.get('child-1')?.generation,
      board.get('child-1')?.terminalRevision,
    );
    expect(acked).toBeDefined();
    // Stopped records keep the 'stopped' state; reconciliation only clears
    // the unreconciled flag once the parent has acted on the stop.
    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: false,
    });
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

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'plan is sound',
    });
  });

  test('resumes acknowledged cancelled and errored sessions through task_id', async () => {
    for (const state of ['cancelled', 'error'] as const) {
      const board = new BackgroundJobBoard();
      const original = board.registerLaunch({
        taskID: `child-${state}`,
        parentSessionID: 'parent-1',
        agent: 'oracle',
        description: `${state} review`,
      });
      board.updateStatus({ taskID: original.taskID, state });
      const { hook } = createHook({ backgroundJobBoard: board });

      const beforeAcknowledgement = {
        args: { subagent_type: 'oracle', task_id: original.alias },
      };
      await expect(
        hook['tool.execute.before'](
          {
            tool: 'task',
            sessionID: 'parent-1',
            callID: `${state}-before-ack`,
          },
          beforeAcknowledgement,
        ),
      ).rejects.toThrow(
        /unreconciled; task\(\) cannot resume[\s\S]*task_revive\(task_id:/,
      );
      expect(beforeAcknowledgement.args.task_id).toBe(original.alias);

      board.markReconciled(original.taskID);

      const resume = {
        args: { subagent_type: 'oracle', task_id: original.alias },
      };
      await hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: `${state}-resume` },
        resume,
      );
      expect(resume.args.task_id).toBe(original.taskID);

      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'parent-1', callID: `${state}-resume` },
        {
          output: [`task_id: ${original.taskID}`, 'state: running'].join('\n'),
        },
      );

      expect(board.get(original.taskID)).toMatchObject({
        generation: original.generation + 1,
        state: 'running',
        terminalUnreconciled: false,
      });
    }
  });

  test('refuses stopped sessions through task() before and after acknowledgement', async () => {
    const board = new BackgroundJobBoard();
    const original = board.registerLaunch({
      taskID: 'child-stopped',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'idle review',
      now: 100,
    });
    board.markStopped(original.taskID, 'no native result', 110, undefined, 110);
    const { hook } = createHook({ backgroundJobBoard: board });

    const beforeAcknowledgement = {
      args: { subagent_type: 'oracle', task_id: original.alias },
    };
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'stopped-before-ack' },
        beforeAcknowledgement,
      ),
    ).rejects.toThrow(/stopped, unreconciled; task\(\) cannot resume/);
    expect(beforeAcknowledgement.args.task_id).toBe(original.alias);

    board.markReconciled(original.taskID);

    const afterAcknowledgement = {
      args: { subagent_type: 'oracle', task_id: original.alias },
    };
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'stopped-after-ack' },
        afterAcknowledgement,
      ),
    ).rejects.toThrow(/stopped, acknowledged; task\(\) cannot resume/);
    expect(afterAcknowledgement.args.task_id).toBe(original.alias);
    expect(board.get(original.taskID)).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: false,
    });
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

    // The timeout overlay is machine state now; the board is never rendered.
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      timedOut: true,
    });
    expect(boardText(messages)).toBeUndefined();
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
          activityAt: (board.get('child-1')?.lastLiveBusyAt ?? 0) + 1,
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

  test('holds a relaunch lease through after and releases it after registration', async () => {
    const board = new BackgroundJobBoard();
    setupCompletedJob(board, {
      taskID: 'child-1',
      parentSessionID: 'parent-1',
    });
    board.markReconciled('child-1');
    const { hook } = createHook({ backgroundJobBoard: board });
    const resume = {
      args: { subagent_type: 'oracle', task_id: 'ora-1' },
    };

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-1' },
      resume,
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-1' },
      { output: ['task_id: child-1', 'state: running'].join('\n') },
    );

    const relaunched = board.get('child-1');
    expect(resume.args.task_id).toBe('child-1');
    expect(relaunched).toMatchObject({ generation: 2, state: 'running' });
    const cancellationLease = board.acquireLease(
      'child-1',
      relaunched?.generation ?? -1,
      'cancellation',
    );
    expect(cancellationLease).toBeDefined();
    if (!cancellationLease) {
      throw new Error('cancellation lease was not acquired');
    }
    board.releaseLease(cancellationLease);
  });

  test('session.created cannot early-register over a live cancellation lease', async () => {
    const board = new BackgroundJobBoard();
    const first = board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    const cancellationLease = board.acquireLease(
      first.taskID,
      first.generation,
      'cancellation',
    );
    expect(cancellationLease).toBeDefined();
    const { hook } = createHook({ backgroundJobBoard: board });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'new-call' },
      { args: { subagent_type: 'oracle', background: true } },
    );
    await hook.event({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'child-1', parentID: 'parent-1', agent: 'oracle' },
        },
      },
    });
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'new-call' },
      { output: ['task_id: child-1', 'state: running'].join('\n') },
    );

    expect(board.get('child-1')).toMatchObject({
      generation: first.generation,
      state: 'running',
    });
    expect(board.acquireLease('child-1', first.generation, 'relaunch')).toBe(
      undefined,
    );
    if (!cancellationLease) {
      throw new Error('cancellation lease was not acquired');
    }
    board.releaseLease(cancellationLease);
  });

  test('tool.execute.before refuses a relaunch while cancellation owns the generation', async () => {
    const board = new BackgroundJobBoard();
    const first = board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    board.updateStatus({
      taskID: first.taskID,
      state: 'running',
      timedOut: true,
    });
    board.markRunningFromLiveSession(
      first.taskID,
      Date.now(),
      first.generation,
    );
    const cancellationLease = board.acquireLease(
      first.taskID,
      first.generation,
      'cancellation',
    );
    expect(cancellationLease).toBeDefined();
    const { hook } = createHook({ backgroundJobBoard: board });
    const resume = { args: { subagent_type: 'fixer', task_id: 'fix-1' } };

    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'blocked-resume' },
        resume,
      ),
    ).rejects.toThrow('cannot be resumed safely');
    expect(resume.args.task_id).toBe('fix-1');
    expect(board.get(first.taskID)?.generation).toBe(first.generation);
    if (!cancellationLease) {
      throw new Error('cancellation lease was not acquired');
    }
    board.releaseLease(cancellationLease);
  });

  test('blocks a new spawn duplicating an unreconciled terminal job objective', async () => {
    const board = new BackgroundJobBoard();
    setupCompletedJob(board, {
      taskID: 'child-1',
      parentSessionID: 'parent-1',
    });
    const { hook } = createHook({ backgroundJobBoard: board });

    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'dup-1' },
        {
          args: {
            subagent_type: 'oracle',
            background: true,
            description: '  Review   Plan ',
          },
        },
      ),
    ).rejects.toThrow('awaiting acknowledgment');
  });

  test('allows re-dispatch after the terminal result was retrieved', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
      now: 100,
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
      now: 200,
    });
    const { hook } = createHook({ backgroundJobBoard: board });

    const spawn = {
      args: {
        subagent_type: 'oracle',
        background: true,
        description: 'review plan',
      },
    };
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'retry-1' },
        spawn,
      ),
    ).rejects.toThrow('awaiting acknowledgment');

    // A task_status result read marks the job used after completion (#1070 escape hatch).
    board.markUsed('parent-1', 'child-1', 300);
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'retry-1' },
      spawn,
    );
  });

  test('does not block objectives truncated at the 48-char label boundary', async () => {
    const board = new BackgroundJobBoard();
    const sharedPrefix = 'x'.repeat(48);
    setupCompletedJob(board, {
      taskID: 'child-1',
      parentSessionID: 'parent-1',
    });
    board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: `${sharedPrefix} distinct suffix A`,
      now: 100,
    });
    board.updateStatus({
      taskID: 'child-2',
      state: 'completed',
      resultSummary: 'done',
      now: 200,
    });
    const { hook } = createHook({ backgroundJobBoard: board });

    // Different suffix after the shared 48-char prefix: the full objective
    // differs, so the guard must not treat it as a duplicate.
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'long-objective' },
        {
          args: {
            subagent_type: 'oracle',
            background: true,
            description: `${sharedPrefix} distinct suffix B`,
          },
        },
      ),
    ).resolves.toBeUndefined();
  });

  test('blocks an exact duplicate whose objective exceeds the 48-char label', async () => {
    const board = new BackgroundJobBoard();
    const longObjective = `${'y'.repeat(60)} exact duplicate`;
    setupCompletedJob(board, {
      taskID: 'child-1',
      parentSessionID: 'parent-1',
    });
    board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: longObjective,
      now: 100,
    });
    board.updateStatus({
      taskID: 'child-2',
      state: 'completed',
      resultSummary: 'done',
      now: 200,
    });
    const { hook } = createHook({ backgroundJobBoard: board });

    // Identical long objective: even though the derived label truncates at
    // 48 chars, the full-objective comparison must still block the duplicate.
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'exact-long-dup' },
        {
          args: {
            subagent_type: 'oracle',
            background: true,
            description: longObjective,
          },
        },
      ),
    ).rejects.toThrow('awaiting acknowledgment');
  });

  test('after output errors still release a pending relaunch lease', async () => {
    const board = new BackgroundJobBoard();
    setupCompletedJob(board, {
      taskID: 'child-1',
      parentSessionID: 'parent-1',
    });
    board.markReconciled('child-1');
    const { hook } = createHook({ backgroundJobBoard: board });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-error' },
      { args: { subagent_type: 'oracle', task_id: 'ora-1' } },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-error' },
      { output: undefined },
    );

    const secondLease = board.acquireLease('child-1', 1, 'relaunch');
    expect(secondLease).toBeDefined();
    if (!secondLease) throw new Error('relaunch lease was not released');
    board.releaseLease(secondLease);
  });

  test('after handler exceptions release a pending relaunch lease', async () => {
    const board = new BackgroundJobBoard();
    setupCompletedJob(board, {
      taskID: 'child-1',
      parentSessionID: 'parent-1',
    });
    board.markReconciled('child-1');
    board.addContext = () => {
      throw new Error('context tracking failed');
    };
    const { hook } = createHook({ backgroundJobBoard: board });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-throw' },
      { args: { subagent_type: 'oracle', task_id: 'ora-1' } },
    );
    await expect(
      hook['tool.execute.after'](
        { tool: 'task', sessionID: 'parent-1', callID: 'resume-throw' },
        { output: ['task_id: child-1', 'state: running'].join('\n') },
      ),
    ).rejects.toThrow('context tracking failed');

    const cancellationLease = board.acquireLease('child-1', 2, 'cancellation');
    expect(cancellationLease).toBeDefined();
    if (!cancellationLease) {
      throw new Error('cancellation lease was not acquired');
    }
    board.releaseLease(cancellationLease);
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
          activityAt: (board.get('ses_timeout')?.lastLiveBusyAt ?? 0) + 1,
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
    expect(board.get('child-1')).toMatchObject({ timedOut: true });

    await hook.event({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'child-1',
          status: { type: 'busy' },
          activityAt: (board.get('child-1')?.lastLiveBusyAt ?? 0) + 1,
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
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      timedOut: false,
      recoverableAfterLiveBusy: true,
    });
  });

  test('updates background job board from injected completion messages', async () => {
    const board = new BackgroundJobBoard();
    const { hook, complete } = createHook({ backgroundJobBoard: board });

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

    complete('child-1', 'found hook flow');
    await transformMessages(hook, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'found hook flow',
    });
    expect(boardText(messages)).toBeUndefined();
  });

  test.each(['orchestrator', 'build', 'custom-primary'])(
    'injected completion for managed %s through message transform remains terminal-unreconciled before parent idle, then reconciles after',
    async (agent) => {
      const board = new BackgroundJobBoard();
      const { hook, complete } = createHook({
        backgroundJobBoard: board,
        idleReconcileDelayMs: 0,
      });

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
            info: {
              role: 'user',
              agent: 'orchestrator',
              sessionID: 'parent-1',
            },
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

      // The native delivery is untagged on v1: the plugin commits the
      // terminal state from it, but retirement rides the stale-terminal
      // fallback (issue #1647) — not prompt-shape consumption.
      messages.messages[0].info.agent = agent;
      complete('child-1', 'found hook flow');
      await hook['experimental.chat.messages.transform']({}, messages as never);

      expect(board.get('child-1')).toMatchObject({
        state: 'completed',
        terminalUnreconciled: true,
        resultSummary: 'found hook flow',
      });

      // A duplicate occurrence is idempotent (no reprocess, no double commit).
      await hook['experimental.chat.messages.transform']({}, messages as never);
      expect(board.get('child-1')?.terminalUnreconciled).toBe(true);

      // The parent demonstrably moved past the report: retire.
      await transformMessages(
        hook,
        createMessagesAfterAssistantTurn('parent-1', 'later turn') as never,
      );

      expect(board.get('child-1')).toMatchObject({
        state: 'reconciled',
        terminalUnreconciled: false,
      });
    },
  );

  test('another terminal-unreconciled sibling remains unreconciled when only first child completion was injected', async () => {
    const board = new BackgroundJobBoard();
    const { hook, complete } = createHook({
      backgroundJobBoard: board,
      idleReconcileDelayMs: 0,
    });

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
    complete('child-1', 'done1');
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

    // The parent demonstrably moved past the delivered report: the
    // delivered child retires, the never-delivered sibling stays pending.
    await transformMessages(
      hook,
      createMessagesAfterAssistantTurn('parent-1', 'later turn') as never,
    );

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
    // The sibling never had a delivery observed, but the parent moved past
    // the terminal report — the fallback retires it too (it is a terminal
    // fact the parent demonstrably has moved beyond).
    expect(board.get('child-2')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('a later synthetic completion does not replace an older delivered terminal batch', async () => {
    const board = new BackgroundJobBoard({ maxReusablePerAgent: 3 });
    const { hook, complete } = createHook({
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

    // Process the later synthetic completion.
    complete('child-3', 'done3');
    await hook['experimental.chat.messages.transform'](
      {},
      laterCompletion as never,
    );
    // The parent demonstrably moved past every report: all three retire.
    await transformMessages(
      hook,
      createMessagesAfterAssistantTurn('parent-1', 'later turn') as never,
    );

    for (const taskID of ['child-1', 'child-2', 'child-3']) {
      expect(board.get(taskID)).toMatchObject({
        state: 'reconciled',
        terminalUnreconciled: false,
      });
    }
  });

  test('shape reconciliation leaves a pending synthetic completion unreconciled until its payload is delivered', async () => {
    const board = new BackgroundJobBoard({ maxReusablePerAgent: 3 });
    const { hook, complete } = createHook({
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
    complete('child-2', 'done2');
    await hook['experimental.chat.messages.transform'](
      {},
      pendingCompletion as never,
    );
    expect(board.get('child-2')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });

    // Without an observed delivery and without the parent having moved
    // past, both runs stay unreconciled: nothing was consumed.
    await hook.injectBackgroundJobBoard({}, pendingCompletion as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
    expect(board.get('child-2')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
    expect(boardText(pendingCompletion)).toBeUndefined();

    // The parent demonstrably moved past: both retire.
    await transformMessages(
      hook,
      createMessagesAfterAssistantTurn('parent-1', 'later turn') as never,
    );
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
    expect(board.get('child-2')).toMatchObject({
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
    const { hook, complete } = createHook({ backgroundJobBoard: board });

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

    complete('child-1', 'old result');
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

  test('does not accept an unobserved weak occurrence after task relaunch', async () => {
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
      state: 'running',
      statusUncertain: true,
      terminalUnreconciled: false,
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

    // A weak occurrence without runtime provenance remains fail-closed.
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

    // The unobserved weak occurrence remains fail-closed.
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      terminalUnreconciled: false,
    });
  });

  test('dedupes anonymous synthetic completions by content hash even when message index changes', async () => {
    const board = new BackgroundJobBoard();
    const { hook, complete } = createHook({ backgroundJobBoard: board });

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

    complete('child-1', 'same result');
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
    const { hook, complete } = createHook({ backgroundJobBoard: board });

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

    complete('child-1', 'successfully mapped');
    await transformMessages(hook, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'successfully mapped',
    });
  });

  test('valid synthetic failed message updates board to terminal error', async () => {
    const board = new BackgroundJobBoard();
    const { hook, complete } = createHook({ backgroundJobBoard: board });

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

    complete('child-1', 'mapping failed', true);
    await transformMessages(hook, messages);

    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      terminalUnreconciled: true,
      resultSummary: 'mapping failed',
    });
  });

  test('preserves historical injected failure while presenting current cancellation', async () => {
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

    expect(board.get('child-1')?.terminalUnreconciled).toBe(false);
    expect(board.get('child-1')?.resultSummary).toBe(
      'cancelled: user requested',
    );
    expect(messages.messages[0].parts[0].text).toContain(
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

    const messages = createMessages('parent-1', 'continue');
    await transformMessages(hook, messages);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });

    // The parent demonstrably moved past the report: retire.
    await transformMessages(
      hook,
      createMessagesAfterAssistantTurn('parent-1', 'continue again') as never,
    );

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });

    // The reconciled run is reusable by alias (the pull channel).
    expect(board.resolveReusable('parent-1', 'ora-1', 'oracle')).toMatchObject({
      taskID: 'child-1',
      state: 'reconciled',
    });
  });

  test('confirmed live busy reopens an acknowledged cancelled child', async () => {
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
        properties: {
          sessionID: 'child-1',
          status: { type: 'busy' },
          activityAt: (board.get('child-1')?.completedAt ?? 0) + 1,
        },
      },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
      terminalState: undefined,
      cancellationRequested: true,
    });
  });

  test('an earlier idle delivery cannot acknowledge a replacement publication', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      idleReconcileDelayMs: 0,
    });

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

    // Live activity withdraws A; a separately confirmed error publishes B.
    board.markRunningFromLiveSession(
      'child-1',
      (board.get('child-1')?.completedAt ?? Date.now()) + 1,
    );
    board.updateStatus({
      taskID: 'child-1',
      state: 'error',
      resultSummary: 'actual error from child',
    });

    await flushChildIdleReconcile();

    // The pending timer only acknowledges A's publication revision.
    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      terminalUnreconciled: true,
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
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      resultSummary: 'approved',
    });

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
            time: { created: Date.now() + 60_000 },
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
    // Change-only: an assistant tail renders nothing (the placement defers
    // to the next user-side tail), so the reconciled board surfaces on a
    // follow-up user turn — and no longer shows the Result line.
    const request3 = {
      messages: [
        ...request2.messages,
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ type: 'text', text: 'user is back' }],
        },
      ],
    };
    await transformMessages(hook, request3);
    // The reconciled run stays out of every prompt surface (issue #1647).
    expect(boardText(request3)).toBeUndefined();
    expect(board.resolveReusable('parent-1', 'ora-1', 'oracle')).toMatchObject({
      taskID: 'child-1',
      state: 'reconciled',
    });
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
    // retry). Nothing was delivered and the parent did not move past the
    // report, so the run stays unreconciled — a retry never consumes it.
    await transformMessages(hook, messages);
    const firstBoardText = boardText(messages);

    await transformMessages(hook, messages);
    const secondBoardText = boardText(messages);

    expect(firstBoardText).toBeUndefined();
    expect(secondBoardText).toBeUndefined();
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
    // Change-only: an assistant tail renders nothing and registers nothing
    // — the completion stays pending for the next user-side tail.
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

    // Still an assistant tail: still deferred, nothing consumed.
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });

    // The compaction preserved message and part counts, so counts alone
    // never consume a terminal run: only a timestamped assistant turn (the
    // parent demonstrably moved past) retires it (issue #1647).
    const resumed = {
      messages: [
        ...compactedWithNewTurn.messages,
        {
          info: {
            id: 'user-3',
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ type: 'text', text: 'user is back' }],
        },
      ],
    };
    await transformMessages(hook, resumed);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });

    const after = {
      messages: [
        ...resumed.messages,
        {
          info: {
            id: 'assistant-4',
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
            time: { created: Date.now() + 60_000 },
          },
          parts: [{ type: 'text', text: 'acknowledged the result' }],
        },
        {
          info: {
            id: 'user-5',
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ type: 'text', text: 'continue' }],
        },
      ],
    };
    await transformMessages(hook, after);
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
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

    const unreconciledStates: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      const request = buildRequest(i);
      await transformMessages(hook, request);
      unreconciledStates.push(
        board.get('child-1')?.terminalUnreconciled === true,
      );
    }

    // Nothing was delivered and no assistant turn carried a timestamp, so
    // the run is never consumed: the terminal fact stays pending until the
    // parent demonstrably moves past it (issue #1647).
    expect(unreconciledStates).toEqual([true, true, true, true, true]);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
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

    // Request 1: both jobs are terminal facts on the machine board; the
    // board is never rendered (issue #1647).
    const request1 = createMessages('parent-1', 'continue');
    await transformMessages(hook, request1);
    expect(boardText(request1)).toBeUndefined();

    // Request 2: same shape (no new part) — both jobs stay unreconciled
    const request2 = createMessages('parent-1', 'continue');
    await transformMessages(hook, request2);
    expect(board.get('child-A')).toMatchObject({ terminalUnreconciled: true });
    expect(board.get('child-B')).toMatchObject({ terminalUnreconciled: true });

    // Request 3: the parent demonstrably moved past both reports — both
    // jobs retire together.
    const request3 = {
      messages: [
        ...request1.messages,
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
            time: { created: Date.now() + 60_000 },
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
    const clock = mockIdleClock();
    const { hook } = createHook({
      backgroundJobBoard: board,
      willAttemptFallback: () => true,
      idleReconcileDelayMs: 10,
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
    await clock.advanceTo(10);
    for (let i = 0; i < 50; i++) await Promise.resolve();

    expect(board.get('parent-1')).toMatchObject({
      state: 'error',
      resultSummary:
        'Session error after failed model fallback (auth/model unavailable)',
    });
    clock.restore();
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

  test('child session.error preserves serialized NamedError detail (data.message)', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'audit the diff',
    });
    board.updateStatus({ taskID: 'child-1', state: 'running' });

    // The core publishes session errors via NamedError.toObject():
    // `{ name, data }` with the message inside data (APIError,
    // ProviderAuthError, ...). A top-level-only read loses it (#1200).
    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: {
            name: 'APIError',
            data: {
              message: 'stream stall timeout',
              isRetryable: true,
            },
          },
        },
      },
    });

    const job = board.get('child-1');
    expect(job?.state).toBe('error');
    expect(job?.resultSummary).toBe('stream stall timeout');
  });

  test('child session.error without any message falls back to generic summary', async () => {
    const board = new BackgroundJobBoard();
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
          error: { name: 'APIError', data: { isRetryable: false } },
        },
      },
    });

    const job = board.get('child-1');
    expect(job?.state).toBe('error');
    expect(job?.resultSummary).toBe('Session error');
  });

  test('child session.error prefers data.message over top-level message', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'audit the diff',
    });
    board.updateStatus({ taskID: 'child-1', state: 'running' });

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: {
            name: 'APIError',
            message: 'Instance name (generic)',
            data: { message: 'stream stall timeout', isRetryable: true },
          },
        },
      },
    });

    // NamedError instances carry their class name as the top-level
    // message; the human-readable detail is data.message.
    expect(board.get('child-1')?.resultSummary).toBe('stream stall timeout');
  });

  test('child session.error with empty data.message falls back to top-level message', async () => {
    const board = new BackgroundJobBoard();
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
            data: { message: '' },
          },
        },
      },
    });

    expect(board.get('child-1')?.resultSummary).toBe('Internal server error');
  });

  test('child session.error with whitespace-only data.message falls back to top-level message', async () => {
    const board = new BackgroundJobBoard();
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

    // A whitespace-only nested message must not bypass the fallback and
    // leave an empty board summary (Greptile PR #1202 review).
    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: {
            name: 'AI_APICallError',
            message: 'Internal server error',
            data: { message: '   ' },
          },
        },
      },
    });

    expect(board.get('child-1')?.resultSummary).toBe('Internal server error');
  });

  test('managed session.error preserves serialized NamedError detail (data.message)', async () => {
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
          error: {
            name: 'ProviderAuthError',
            data: { providerID: 'acme', message: 'Invalid API key' },
          },
        },
      },
    });

    const job = board.get('parent-1');
    expect(job?.state).toBe('error');
    expect(job?.resultSummary).toBe('Invalid API key');
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

  test('child failover error with an armed fallback chain defers terminalization', async () => {
    // The event router sees session.error BEFORE ForegroundFallbackManager
    // starts the fallback (event-hook dispatch order in src/index.ts), so
    // isFallbackInProgress cannot cover the fallback this error is about to
    // trigger. The record must not terminalize while a re-prompt is still
    // coming: the observation handoff for the substituted run only arms
    // while the record is 'running' (fallback-observation-transfer prepare
    // guard). An early error terminal publishes the failure to the parent
    // and orphans the retried run's result (issue #1321).
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      willAttemptFallback: () => true,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config schema',
    });
    board.updateStatus({ taskID: 'child-1', state: 'running' });

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: { statusCode: 429, message: 'rate limit exceeded' },
        },
      },
    });

    // Deferred: still running while the fallback may re-prompt.
    expect(board.get('child-1')?.state).toBe('running');
  });

  test('deferred child failover error resolves to the retried run result, published once', async () => {
    const board = new BackgroundJobBoard();
    const { hook, complete } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      willAttemptFallback: () => true,
      idleReconcileDelayMs: 0,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config schema',
    });
    board.updateStatus({ taskID: 'child-1', state: 'running' });

    // Failover error → deferred, record stays running for the handoff.
    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: { statusCode: 429, message: 'rate limit exceeded' },
        },
      },
    });
    expect(board.get('child-1')?.state).toBe('running');

    // The fallback re-prompt landed: live busy clears the deferral.
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-1', status: { type: 'busy' } },
      },
    });

    // The substituted run finished and produced its answer.
    complete('child-1', 'retried run result');
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });
    await flushChildIdleReconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      resultSummary: 'retried run result',
      terminalRevision: 1,
    });

    // A redelivered idle (v2 double-idle) must not publish a second
    // terminal state over the retried run's result.
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });
    await flushChildIdleReconcile();
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      resultSummary: 'retried run result',
      terminalRevision: 1,
    });
  });

  test('deferred child failover error terminalizes as error when the fallback never recovers', async () => {
    // The chain was armed but the re-prompt never landed (silent failure,
    // host rejection, or chain-exhaustion abort): the session went idle
    // without recovery — the idle backstop must publish the deferred error
    // so the parent still sees the failure instead of a false completion.
    const board = new BackgroundJobBoard();
    const clock = mockIdleClock();
    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      willAttemptFallback: () => true,
      fallbackFailureReason: () =>
        'Model fallback did not recover from test/primary.',
      idleReconcileDelayMs: 10,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config schema',
    });
    board.updateStatus({ taskID: 'child-1', state: 'running' });

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: { statusCode: 429, message: 'rate limit exceeded' },
        },
      },
    });
    expect(board.get('child-1')?.state).toBe('running');

    // No busy ever arrived: the fallback failed silently.
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });
    await clock.advanceTo(10);
    for (let i = 0; i < 50; i++) await Promise.resolve();

    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      resultSummary:
        'rate limit exceeded\nModel fallback did not recover from test/primary.',
    });
    clock.restore();
  });

  test('child failover error without a fallback chain terminalizes immediately', async () => {
    // No chain / fallback disabled / chain exhausted: nothing to retry
    // into, so the error is final at event time (regression guard for
    // the original child-branch contract).
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      willAttemptFallback: () => false,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config schema',
    });
    board.updateStatus({ taskID: 'child-1', state: 'running' });

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: { statusCode: 429, message: 'rate limit exceeded' },
        },
      },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      resultSummary: 'rate limit exceeded',
    });
  });

  test('child non-failover session.error terminalizes immediately despite an armed chain', async () => {
    // A genuine application-level failure (no failover pattern) must not
    // wait for a fallback that will never trigger.
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      willAttemptFallback: () => true,
      fallbackFailureReason: () => 'R',
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config schema',
    });
    board.updateStatus({ taskID: 'child-1', state: 'running' });

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: {
            name: 'AI_APICallError',
            message: 'Invalid request: unknown parameter',
          },
        },
      },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      resultSummary: 'Invalid request: unknown parameter',
    });
  });

  test('deferred child failover error survives idle before fallback is armed', async () => {
    // Host hooks are not awaited: idle can precede fallback delay arming.
    // Publishing now would orphan the replay before its handoff is prepared.
    const board = new BackgroundJobBoard();
    const clock = mockIdleClock();
    let fallbackInFlight = false;
    const { hook, complete } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      willAttemptFallback: () => true,
      isFallbackInProgress: (id) => fallbackInFlight && id === 'child-1',
      idleReconcileDelayMs: 10,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config schema',
    });
    board.updateStatus({ taskID: 'child-1', state: 'running' });

    // session.error → deferred (the fallback for it has not started yet).
    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: { statusCode: 429, message: 'rate limit exceeded' },
        },
      },
    });
    expect(board.get('child-1')?.state).toBe('running');

    try {
      // Idle arrives before the fallback manager arms its initial delay.
      await hook.event({
        event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
      });
      fallbackInFlight = true;
      await clock.advanceTo(10);
      await clock.advanceTo(20);
      for (let i = 0; i < 50; i++) await Promise.resolve();

      // The deferred error must NOT have been committed inside the window.
      expect(board.get('child-1')).toMatchObject({
        state: 'running',
        terminalRevision: 0,
        statusUncertain: false,
      });

      // The re-prompt lands: busy cancels the backstop and clears the
      // deferral; the retried run finishes and publishes exactly once.
      fallbackInFlight = false;
      await hook.event({
        event: {
          type: 'session.status',
          properties: { sessionID: 'child-1', status: { type: 'busy' } },
        },
      });
      complete('child-1', 'retried run result');
      await hook.event({
        event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
      });
      for (let i = 0; i < 50; i++) await Promise.resolve();

      expect(board.get('child-1')).toMatchObject({
        state: 'completed',
        resultSummary: 'retried run result',
        terminalRevision: 1,
      });
    } finally {
      await hook.event({ event: { type: 'server.instance.disposed' } });
      clock.restore();
    }
  });

  test('session.deleted inside the deferral window publishes the deferred error', async () => {
    // A genuine deletion between the deferred error and any recovery
    // means no idle can ever fire again — the backstop would never run.
    // Pre-fix semantics published the error at session.error time, so
    // the deletion path must publish the deferred error (for a
    // fence-passing running record) instead of leaving the parent with
    // a task that never resolves.
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      willAttemptFallback: () => true,
      fallbackFailureReason: () => 'R',
      idleReconcileDelayMs: 0,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config schema',
    });
    board.updateStatus({ taskID: 'child-1', state: 'running' });

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: { statusCode: 429, message: 'rate limit exceeded' },
        },
      },
    });
    expect(board.get('child-1')?.state).toBe('running');

    // The session is genuinely deleted before any recovery.
    await hook.event({
      event: { type: 'session.deleted', properties: { sessionID: 'child-1' } },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      resultSummary: 'rate limit exceeded\nR',
    });
  });

  test('bounded backstop commits the deferred error when the fallback never leaves the window', async () => {
    // The backstop's renewals are bounded: a fallback that silently hangs
    // in the preparation window must not defer the failure forever —
    // after the renewal cap the deferred error terminalizes.
    const board = new BackgroundJobBoard();
    let fallbackInFlight = false;
    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      willAttemptFallback: () => true,
      // Flips true after the error, simulating the fallback manager
      // picking it up and then hanging in the preparation window.
      isFallbackInProgress: (id) => fallbackInFlight && id === 'child-1',
      idleReconcileDelayMs: 5,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config schema',
    });
    board.updateStatus({ taskID: 'child-1', state: 'running' });

    // The error defers while the fallback has not started yet.
    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: { statusCode: 429, message: 'rate limit exceeded' },
        },
      },
    });
    expect(board.get('child-1')?.state).toBe('running');

    // The fallback picks the error up and hangs; its idle schedules the
    // backstop inside the window.
    fallbackInFlight = true;
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });
    expect(board.get('child-1')?.state).toBe('running');

    // The renewal cap (5 renewals × 5ms) bounds the wait; well past it the
    // deferred error must be published even though the fallback still
    // claims to be in flight.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      resultSummary: 'rate limit exceeded',
    });
  });

  test('chain-exhaustion flip commits the second error immediately and clears the deferral', async () => {
    // error#1 defers while the chain is armed; the chain then exhausts
    // (willAttemptFallback flips false), so error#2 is final: it must
    // commit immediately with its own message, and the stale deferral
    // from error#1 must be cleared — a later reuse of this session must
    // not have error#1's deferred error terminalize it.
    const board = new BackgroundJobBoard();
    let chainArmed = true;
    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      willAttemptFallback: () => chainArmed,
      idleReconcileDelayMs: 0,
    });

    const run = board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config schema',
    });
    board.updateStatus({ taskID: 'child-1', state: 'running' });

    // error#1: failover-worthy with an armed chain → deferred.
    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: { statusCode: 429, message: 'rate limit exceeded' },
        },
      },
    });
    expect(board.get('child-1')?.state).toBe('running');

    // The chain exhausts; error#2 is final and commits immediately.
    chainArmed = false;
    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: { statusCode: 429, message: 'quota exhausted on all models' },
        },
      },
    });
    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      resultSummary: 'quota exhausted on all models',
      terminalRevision: 1,
    });

    // The deferral entry from error#1 must be gone: relaunch the task and
    // prove a later idle runs the normal inspect path instead of the
    // deferred-error backstop with the stale message.
    const lease = board.acquireLease('child-1', run.generation, 'relaunch');
    if (!lease) throw new Error('missing relaunch lease');
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config schema',
      background: true,
      relaunchLease: lease,
    });
    board.releaseLease(lease);
    // Live busy first so the post-relaunch generation fence accepts the
    // subsequent idle (same-ID relaunch quarantines the first lifecycle
    // event without provenance).
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-1', status: { type: 'busy' } },
      },
    });
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });
    await flushChildIdleReconcile();

    const relaunched = board.get('child-1');
    expect(relaunched?.state).not.toBe('error');
    expect(relaunched?.resultSummary).not.toBe('rate limit exceeded');
  });

  test('busy clears the deferral; a later non-failover error commits immediately', async () => {
    // Behavioral pin for the busy-path consumption: after live busy
    // clears the deferred failover error, a subsequent non-failover
    // error must terminalize immediately with its own message — no
    // stale deferral may delay or replace it.
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      willAttemptFallback: () => true,
    });

    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config schema',
    });
    board.updateStatus({ taskID: 'child-1', state: 'running' });

    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: { statusCode: 429, message: 'rate limit exceeded' },
        },
      },
    });
    expect(board.get('child-1')?.state).toBe('running');

    // The re-prompt landed: live busy clears the deferral.
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-1', status: { type: 'busy' } },
      },
    });

    // A later non-failover error is final and commits immediately.
    await hook.event({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'child-1',
          error: {
            name: 'AI_APICallError',
            message: 'Invalid request: unknown parameter',
          },
        },
      },
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      resultSummary: 'Invalid request: unknown parameter',
      terminalRevision: 1,
    });
  });

  test('completed reconciled job appears reusable and resumes via task', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      idleReconcileDelayMs: 0,
    });

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
    // The parent demonstrably moved past the report: the run retires and
    // becomes reusable by alias.
    await transformMessages(
      hook,
      createMessagesAfterAssistantTurn('parent-1', 'reuse') as never,
    );
    expect(
      board.resolveReusable('parent-1', 'exp-1', 'explorer'),
    ).toMatchObject({ taskID: 'child-1', state: 'reconciled' });
    // Nothing about the reconciled run reaches the prompt (issue #1647).
    expect(boardText(messages)).toBeUndefined();

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

  test('only acknowledged terminal jobs resolve as reusable task sessions', async () => {
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
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
        unreconciled,
      ),
    ).rejects.toThrow(
      /unreconciled; task\(\) cannot resume[\s\S]*task_revive\(task_id:/,
    );
    expect(unreconciled.args.task_id).toBe('ora-1');

    board.markReconciled('done-1');

    const failed = { args: { subagent_type: 'oracle', task_id: 'ora-2' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      failed,
    );
    expect(failed.args.task_id).toBe('err-1');
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-2' },
      { output: ['task_id: err-1', 'state: running'].join('\n') },
    );

    const completed = { args: { subagent_type: 'oracle', task_id: 'ora-1' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'call-3' },
      completed,
    );
    expect(completed.args.task_id).toBe('done-1');

    const messages = createMessages('parent-1', 'continue');
    await transformMessages(hook, messages);
    expect(board.resolveReusable('parent-1', 'ora-1', 'oracle')).toMatchObject({
      taskID: 'done-1',
      state: 'reconciled',
    });
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

  test('task alias is refused when subagent_type is missing', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({ backgroundJobBoard: board });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });

    const resume = { args: { task_id: 'exp-1' } };
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
        resume,
      ),
    ).rejects.toThrow(/requires a valid subagent_type/);
    expect(resume.args.task_id).toBe('exp-1');
  });

  test('task alias is refused when subagent_type is invalid', async () => {
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
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
        resume,
      ),
    ).rejects.toThrow(/requires a valid subagent_type/);
    expect(resume.args.task_id).toBe('exp-1');
  });

  test('missing-agent refusal wording names the host delegation tool', async () => {
    const v1 = createHook({ backgroundJobBoard: new BackgroundJobBoard() });
    const v1Args = { args: { task_id: 'child-1' } };
    await expect(
      v1.hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'r' },
        v1Args,
      ),
    ).rejects.toThrow(
      'task() requires a valid subagent_type with an explicit task_id',
    );
    expect(v1Args.args.task_id).toBe('child-1');

    const v2 = createHook({
      backgroundJobBoard: new BackgroundJobBoard(),
      hostFlavor: 'v2',
    });
    const v2Args = { args: { task_id: 'child-1' } };
    let message = '';
    try {
      await v2.hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'r' },
        v2Args,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      'subagent() requires a valid agent with an explicit sessionID',
    );
    expect(message).not.toContain('task()');
    expect(message).not.toContain('subagent_type');
    expect(message).not.toContain('task_id');
    expect(v2Args.args.task_id).toBe('child-1');
  });

  test('known-task refusal wording names the host delegation tool', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({ taskID: 'child-1', state: 'completed' });
    board.markReconciled('child-1');
    const v2 = createHook({ backgroundJobBoard: board, hostFlavor: 'v2' });
    let message = '';
    try {
      await v2.hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
        { args: { subagent_type: 'oracle', task_id: 'exp-1' } },
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('subagent() cannot resume this session');
    expect(message).not.toContain('task()');
  });

  test('duplicate-objective refusal names the control-tool identifier param', async () => {
    const v1Board = new BackgroundJobBoard();
    setupCompletedJob(v1Board, {
      taskID: 'child-1',
      parentSessionID: 'parent-1',
    });
    const v1 = createHook({ backgroundJobBoard: v1Board });
    let v1Message = '';
    try {
      await v1.hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'dup-1' },
        {
          args: {
            subagent_type: 'oracle',
            background: true,
            description: 'Review Plan',
          },
        },
      );
    } catch (error) {
      v1Message = (error as Error).message;
    }
    expect(v1Message).toContain(
      'Call task_status with result true and task_id "child-1"',
    );

    const board = new BackgroundJobBoard();
    setupCompletedJob(board, {
      taskID: 'child-1',
      parentSessionID: 'parent-1',
    });
    const v2 = createHook({ backgroundJobBoard: board, hostFlavor: 'v2' });

    let message = '';
    try {
      await v2.hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'dup-1' },
        {
          args: {
            subagent_type: 'oracle',
            background: true,
            description: 'Review Plan',
          },
        },
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      'Call task_status with result true and sessionID "child-1"',
    );
    expect(message).not.toContain('task_id');
  });

  test('unknown native task_id refuses and keeps the id', async () => {
    const { hook } = createHook();
    const resume = {
      args: { subagent_type: 'repro-helper', task_id: 'ses_custom123' },
    };

    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
        resume,
      ),
    ).rejects.toThrow(
      /was not dropped; no new session was created[\s\S]*task_revive\(task_id: "ses_custom123"/,
    );
    expect(resume.args.task_id).toBe('ses_custom123');
  });

  test('unknown alias refuses and keeps the id', async () => {
    const { hook } = createHook();
    const resume = {
      args: { subagent_type: 'fixer', task_id: 'fix-99' },
    };

    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
        resume,
      ),
    ).rejects.toThrow(
      /was not dropped; no new session was created[\s\S]*task_revive\(task_id: "fix-99"/,
    );
    expect(resume.args.task_id).toBe('fix-99');
  });

  test('blank explicit task_id refuses instead of spawning', async () => {
    const { hook } = createHook();
    const resume = {
      args: { subagent_type: 'fixer', task_id: '   ' },
    };

    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
        resume,
      ),
    ).rejects.toThrow(/was not treated as omitted/);
    expect(resume.args.task_id).toBe('   ');
  });

  test('blank task_id refusal uses the v2 parameter name', async () => {
    const { hook } = createHook({ hostFlavor: 'v2' });
    const resume = {
      args: { subagent_type: 'fixer', task_id: '' },
    };

    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
        resume,
      ),
    ).rejects.toThrow(/empty sessionID/);
  });

  test('blank task_id with a missing agent still refuses', async () => {
    const { hook } = createHook();
    const resume = {
      args: { task_id: '   ' },
    };

    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'resume' },
        resume,
      ),
    ).rejects.toThrow(/was not treated as omitted/);
    expect(resume.args.task_id).toBe('   ');
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
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'agent' },
        wrongAgent,
      ),
    ).rejects.toThrow(/agent is explorer, not oracle/);
    expect(wrongAgent.args.task_id).toBe('exp-1');
  });

  test('resuming reusable job relaunches running and removes reusable entry', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      idleReconcileDelayMs: 0,
    });
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
    expect(board.get('child-1')?.state).toBe('running');
    expect(
      board.resolveReusable('parent-1', 'child-1', 'explorer'),
    ).toBeUndefined();
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

    const unreconciled = createMessages('parent-1', 'continue');
    await transformMessages(hook, unreconciled);
    expect(board.get('ses_child')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });

    // The parent demonstrably moved past the report: the run retires.
    await transformMessages(
      hook,
      createMessagesAfterAssistantTurn('parent-1', 'reuse') as never,
    );

    const reusable = createMessages('parent-1', 'reuse again');
    await transformMessages(hook, reusable);
    expect(board.resolveReusable('parent-1', 'fix-1', 'fixer')).toMatchObject({
      taskID: 'ses_child',
      state: 'reconciled',
    });

    const resume = { args: { subagent_type: 'fixer', task_id: 'fix-1' } };
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'resume-1' },
      resume,
    );
    expect(resume.args.task_id).toBe('ses_child');
  });

  test('confirmed child busy reopens completed foreground XML task', async () => {
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
        properties: {
          sessionID: 'ses_child',
          status: { type: 'busy' },
          activityAt: (board.get('ses_child')?.completedAt ?? 0) + 1,
        },
      },
    });

    expect(board.get('ses_child')).toMatchObject({
      state: 'running',
      terminalState: undefined,
      terminalUnreconciled: false,
    });
  });

  test('unresolved UUID task_ids refuse and keep the id', async () => {
    const { hook } = createHook();
    const spawn = {
      args: {
        subagent_type: 'fixer',
        task_id: '474bd269-eac6-40a9-9408-9fe430e8cd19',
      },
    };

    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: 'parent-1', callID: 'resume-1' },
        spawn,
      ),
    ).rejects.toThrow(
      /was not dropped; no new session was created[\s\S]*task_revive\(task_id: "474bd269-eac6-40a9-9408-9fe430e8cd19"/,
    );
    expect(spawn.args.task_id).toBe('474bd269-eac6-40a9-9408-9fe430e8cd19');
  });

  test('reads before and after launch attach, path-only, recency-capped', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      idleReconcileDelayMs: 0,
    });
    // Context entries are disk-validated before board commit: create the
    // files the simulated reads claim to inspect.
    mkdirSync('/tmp/src', { recursive: true });
    for (const name of ['small.ts', 'large.ts', 'medium.ts']) {
      writeFileSync(
        `/tmp/src/${name}`,
        Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n'),
      );
    }
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
      {
        output: [
          'task_id: child-1',
          'state: completed',
          '<task_result>inspected files</task_result>',
        ].join('\n'),
      },
    );
    const messages = createMessages('parent-1', 'continue');
    await transformMessages(hook, messages);
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    // The parent demonstrably moved past the report: the run retires.
    await transformMessages(
      hook,
      createMessagesAfterAssistantTurn('parent-1', 'reuse') as never,
    );

    const next = createMessages('parent-1', 'reuse again');
    await transformMessages(hook, next);
    // Path-only list (ruling: no line counts, no size threshold): deduped
    // per path, most-recent-first, capped at the internal file cap. Every
    // read path is tracked — small files are no longer filtered.
    const contextFiles = board.get('child-1')?.contextFiles ?? [];
    expect(contextFiles.map((file) => file.path).sort()).toEqual([
      'src/large.ts',
      'src/medium.ts',
      'src/small.ts',
    ]);
    expect(boardText(next)).toBeUndefined();
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

  test.each(['child-1', 'parent-1'])(
    'compensates late revive acceptance through the real deletion callback: %s',
    async (deletedID) => {
      const coordinator = new SessionLifecycle(() => {});
      const board = new BackgroundJobBoard();
      const { hook } = createHook({ backgroundJobBoard: board, coordinator });
      for (const taskID of ['child-1', 'sibling']) {
        board.registerLaunch({
          taskID,
          parentSessionID: 'parent-1',
          agent: 'explorer',
        });
        board.updateStatus({ taskID, state: 'completed' });
      }
      const send = Promise.withResolvers<unknown>();
      const stop = Promise.withResolvers<unknown>();
      const abortEntered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const deadline = Promise.withResolvers<() => void>();
      const realTimer = globalThis.setTimeout;
      const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
        (callback, ms, ...args) => {
          const timer = realTimer(callback, ms, ...args);
          if (ms === 1_000)
            deadline.resolve(() => {
              clearTimeout(timer);
              callback(...args);
            });
          return timer;
        },
      );
      const acquire = spyOn(ProductionBoard.prototype, 'acquireLease');
      const releaseLease = board.releaseLease.bind(board);
      const release = spyOn(
        ProductionBoard.prototype,
        'releaseLease',
      ).mockImplementation((lease) => {
        const result = releaseLease(lease);
        released.resolve();
        return result;
      });
      const promptAsync = mock(() => send.promise);
      const abort = mock(() => {
        abortEntered.resolve();
        return stop.promise;
      });
      const tracker = {
        captureBaseline: async () => 'baseline',
        register: mock(() => {}),
        probe: mock(async () => false),
      };
      const onLaunch = mock(() => {});
      const terminal = mock(() => {});
      board.addTerminalOutcomeListener(terminal);
      const { task_revive } = createTaskReviveTool({
        input: {
          directory: '/tmp',
          client: {
            session: {
              promptAsync,
              abort,
              status: async () => ({ data: {} }),
            },
          },
        } as never,
        backgroundJobBoard: board,
        shouldManageSession: () => true,
        revivedRunTracker: tracker as never,
        backgroundJobSupervisor: { onLaunch } as never,
        admissionTimeoutMs: 1_000,
      });
      try {
        const pending = task_revive.execute(
          { task_id: 'child-1', prompt: 'continue' },
          { sessionID: 'parent-1', agent: 'orchestrator' } as never,
        );
        (await deadline.promise)();
        expect(String(await pending)).toContain('status: admission_unknown');
        const lease = acquire.mock.results
          .map((result) => result?.value)
          .find((value) => value?.kind === 'relaunch');
        if (!lease) throw new Error('missing relaunch lease');
        coordinator.dispatchSessionDeleted(deletedID);
        expect(board.get('child-1')).toBeUndefined();
        expect(board.get('sibling') === undefined).toBe(
          deletedID === 'parent-1',
        );
        const tombstones = getBackgroundJobLifecycleLedger(board).tombstones;
        expect(tombstones.has('child-1')).toBe(true);
        send.resolve({});
        await abortEntered.promise;
        expect(board.validateLease(lease)).toBe(true);
        expect(() =>
          board.registerLaunch({
            taskID: 'child-1',
            parentSessionID: 'parent-1',
            agent: 'explorer',
          }),
        ).toThrow(/lease/);
        expect(release).not.toHaveBeenCalled();
        stop.resolve({});
        await released.promise;
        expect(release).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledWith(lease);
        expect(board.validateLease(lease)).toBe(false);
        expect(board.get('child-1')).toBeUndefined();
        expect(board.get('parent-1')).toBeUndefined();
        expect(tombstones.has('child-1')).toBe(true);
        expect(promptAsync).toHaveBeenCalledTimes(1); // no parent notification
        expect(abort).toHaveBeenCalledTimes(1);
        expect(abort).toHaveBeenCalledWith({ path: { id: 'child-1' } });
        expect(tracker.register).not.toHaveBeenCalled();
        expect(tracker.probe).not.toHaveBeenCalled();
        expect(onLaunch).not.toHaveBeenCalled();
        expect(terminal).not.toHaveBeenCalled();
      } finally {
        timerSpy.mockRestore();
        acquire.mockRestore();
        release.mockRestore();
        await hook.event({ event: { type: 'server.instance.disposed' } });
      }
    },
  );

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

  test('keeps a running child provisional when idle has no terminal task result', async () => {
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
      state: 'running',
      statusUncertain: true,
      lastStatusError:
        'Runtime session is idle; task termination is unconfirmed.',
    });
  });

  test('idle timer does not notify terminal listeners before a late completion', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-late',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'late completion',
    });
    const listener = mock(() => {});
    board.addTerminalOutcomeListener(listener);
    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'parent-1',
      idleReconcileDelayMs: 0,
    });

    await hook.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'child-late' },
      },
    });
    await flushChildIdleReconcile();

    expect(board.get('child-late')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
    expect(listener).not.toHaveBeenCalled();

    board.updateStatus({
      taskID: 'child-late',
      state: 'completed',
      resultSummary: 'late completion won',
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(board.get('child-late')).toMatchObject({
      state: 'completed',
      resultSummary: 'late completion won',
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
      state: 'running',
      statusUncertain: true,
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

  test('does not rehydrate a deleted historical running task as a new alias', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-deleted',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'deleted task',
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      coordinator,
      runtimeStatusReconcileDelayMs: 60_000,
    });

    coordinator.dispatchSessionDeleted('child-deleted');
    expect(board.get('child-deleted')).toBeUndefined();

    const messages = {
      messages: [
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [historicalRunningTaskPart('child-deleted')],
        },
        ...createMessages('parent-1', 'continue').messages,
      ],
    };

    await transformMessages(hook, messages as never);

    expect(board.get('child-deleted')).toBeUndefined();
    expect(board.list()).toHaveLength(0);
  });

  test('clears a delete tombstone for a legitimate subsequent launch', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-relaunched',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'first run',
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      coordinator,
      runtimeStatusReconcileDelayMs: 60_000,
    });

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'old-call' },
      {
        args: {
          subagent_type: 'fixer',
          background: true,
          description: 'old run',
        },
      },
    );
    coordinator.dispatchSessionDeleted('child-relaunched');
    expect(board.get('child-relaunched')).toBeUndefined();

    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'old-call' },
      { output: taskLaunchOutput('child-relaunched') },
    );
    expect(board.get('child-relaunched')).toBeUndefined();

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'new-call' },
      {
        args: {
          subagent_type: 'fixer',
          background: true,
          description: 'second run',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'new-call' },
      { output: taskLaunchOutput('child-relaunched') },
    );

    expect(board.get('child-relaunched')).toMatchObject({
      state: 'running',
      generation: 2,
      description: 'second run',
    });

    const messages = {
      messages: [
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [historicalRunningTaskPart('child-relaunched')],
        },
        ...createMessages('parent-1', 'continue').messages,
      ],
    };
    await transformMessages(hook, messages as never);

    expect(board.get('child-relaunched')).toMatchObject({
      state: 'running',
      generation: 2,
      description: 'second run',
    });
    expect(board.list()).toHaveLength(1);
  });

  test('fences a re-injected generation-one completion after deletion', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const board = new BackgroundJobBoard();
    const terminalListener = mock(() => {});
    board.addTerminalOutcomeListener(terminalListener);
    const first = createHook({
      backgroundJobBoard: board,
      coordinator,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-relaunch',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'first run',
    });

    const oldCompletion = {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [
            {
              type: 'text',
              id: 'generation-one-completion',
              synthetic: true,
              text: [
                '<task id="child-relaunch" state="completed">',
                '<summary>Background task completed: first run</summary>',
                '<task_result>',
                'old result',
                '</task_result>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    await first.hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: oldCompletion.messages[0].parts[0] },
      },
    });
    expect(board.get('child-relaunch')).toMatchObject({
      generation: 1,
      state: 'running',
    });

    // The runtime event observed P1, but its message has not reached the
    // transform hook yet.
    expect(terminalListener).not.toHaveBeenCalled();
    await first.hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'child-relaunch' },
      },
    });
    coordinator.dispatchSessionDeleted('child-relaunch');
    expect(board.get('child-relaunch')).toBeUndefined();

    // A recreated hook shares the board's lifecycle fence, while its local
    // processed-occurrence set is intentionally fresh.
    const { hook } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'generation-two' },
      {
        args: {
          subagent_type: 'explorer',
          background: true,
          description: 'second run',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'generation-two' },
      { output: taskLaunchOutput('child-relaunch') },
    );

    expect(board.get('child-relaunch')).toMatchObject({
      generation: 2,
      state: 'running',
    });
    expect(board.get('child-relaunch')?.resultSummary).toBeUndefined();
    expect(terminalListener).not.toHaveBeenCalled();

    const replayedCompletion = {
      messages: JSON.parse(JSON.stringify(oldCompletion.messages)),
    };
    await hook['experimental.chat.messages.transform'](
      {},
      replayedCompletion as never,
    );

    expect(board.get('child-relaunch')).toMatchObject({
      generation: 2,
      state: 'running',
      statusUncertain: true,
    });
    expect(board.get('child-relaunch')?.resultSummary).toBeUndefined();

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'generation-two-result' },
      {
        args: {
          subagent_type: 'explorer',
          background: true,
          description: 'second run result',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'generation-two-result' },
      {
        output: [
          'task_id: child-relaunch',
          'state: completed',
          '',
          '<task_result>',
          'new result',
          '</task_result>',
        ].join('\n'),
      },
    );

    expect(board.get('child-relaunch')).toMatchObject({
      generation: 2,
      state: 'completed',
      resultSummary: 'new result',
      statusUncertain: false,
    });
    expect(terminalListener).toHaveBeenCalledTimes(1);
  });

  test('keeps an ambiguous old completion fail-closed after a late event', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const board = new BackgroundJobBoard();
    const terminalListener = mock(() => {});
    board.addTerminalOutcomeListener(terminalListener);
    const first = createHook({
      backgroundJobBoard: board,
      coordinator,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-relaunch',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'first run',
    });

    const oldCompletion = {
      type: 'text',
      synthetic: true,
      messageID: 'generation-one-message',
      text: [
        '<task id="child-relaunch" state="completed">',
        '<summary>Background task completed: first run</summary>',
        '<task_result>',
        'old result',
        '</task_result>',
        '</task>',
      ].join('\n'),
    };

    await first.hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'child-relaunch' },
      },
    });
    coordinator.dispatchSessionDeleted('child-relaunch');
    expect(board.get('child-relaunch')).toBeUndefined();

    // The first event arrives after deletion, with no live board record to
    // establish which generation produced the terminal part.
    await first.hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: oldCompletion },
      },
    });

    const { hook } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'parent-1', callID: 'generation-two' },
      {
        args: {
          subagent_type: 'explorer',
          background: true,
          description: 'second run',
        },
      },
    );
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'parent-1', callID: 'generation-two' },
      { output: taskLaunchOutput('child-relaunch') },
    );
    expect(board.get('child-relaunch')).toMatchObject({
      generation: 2,
      state: 'running',
    });

    // A late event for the old P1 part must not replace the ambiguous origin
    // with G2 provenance.
    await hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: oldCompletion },
      },
    });

    const replay = {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [oldCompletion],
        },
      ],
    };
    await hook['experimental.chat.messages.transform']({}, replay as never);

    expect(board.get('child-relaunch')).toMatchObject({
      generation: 2,
      state: 'running',
      statusUncertain: true,
      terminalUnreconciled: false,
    });
    expect(board.get('child-relaunch')?.resultSummary).toBeUndefined();
    expect(terminalListener).not.toHaveBeenCalled();
  });

  test('fails closed for a newly observed synthetic completion after deletion', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const board = new BackgroundJobBoard();
    const first = createHook({
      backgroundJobBoard: board,
      coordinator,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-relaunch',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'first run',
    });

    await first.hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'child-relaunch' },
      },
    });
    coordinator.dispatchSessionDeleted('child-relaunch');

    const { hook } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-relaunch',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'second run',
    });

    const completion = {
      type: 'text',
      id: 'generation-two-completion',
      synthetic: true,
      sessionID: 'parent-1',
      messageID: 'message-generation-two',
      text: [
        '<task id="child-relaunch" state="completed">',
        '<summary>Background task completed: second run</summary>',
        '<task_result>',
        'new synthetic result',
        '</task_result>',
        '</task>',
      ].join('\n'),
    };
    await hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: completion },
      },
    });
    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [completion],
        },
      ],
    } as never);

    expect(board.get('child-relaunch')).toMatchObject({
      generation: 2,
      state: 'running',
      statusUncertain: true,
      terminalUnreconciled: false,
    });
    expect(board.get('child-relaunch')?.resultSummary).toBeUndefined();
  });

  test('allows an observed synthetic completion in the same generation', async () => {
    const board = new BackgroundJobBoard();
    const terminalListener = mock(() => {});
    board.addTerminalOutcomeListener(terminalListener);
    const { hook, complete } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-same-generation',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'same generation',
    });

    const completion = {
      type: 'text',
      id: 'same-generation-completion',
      synthetic: true,
      text: [
        '<task id="child-same-generation" state="completed">',
        '<summary>Background task completed: same generation</summary>',
        '<task_result>',
        'same generation result',
        '</task_result>',
        '</task>',
      ].join('\n'),
    };
    await hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: completion },
      },
    });
    complete('child-same-generation', 'same generation result');
    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [completion],
        },
      ],
    } as never);

    expect(board.get('child-same-generation')).toMatchObject({
      state: 'completed',
      resultSummary: 'same generation result',
    });
    expect(terminalListener).toHaveBeenCalledTimes(1);
  });

  test('fails closed for an unobserved synthetic completion after deletion', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const board = new BackgroundJobBoard();
    const terminalListener = mock(() => {});
    board.addTerminalOutcomeListener(terminalListener);
    const first = createHook({
      backgroundJobBoard: board,
      coordinator,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-relaunch',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'first run',
    });

    await first.hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'child-relaunch' },
      },
    });
    coordinator.dispatchSessionDeleted('child-relaunch');

    const { hook } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-relaunch',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'second run',
    });

    const replay = {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [
            {
              type: 'text',
              id: 'unobserved-completion',
              synthetic: true,
              text: [
                '<task id="child-relaunch" state="completed">',
                '<summary>Background task completed: unknown origin</summary>',
                '<task_result>',
                'ambiguous result',
                '</task_result>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };
    await hook['experimental.chat.messages.transform']({}, replay as never);

    expect(board.get('child-relaunch')).toMatchObject({
      generation: 2,
      state: 'running',
      statusUncertain: true,
      terminalUnreconciled: false,
    });
    expect(terminalListener).not.toHaveBeenCalled();
  });

  test('fail-closed after deletion defers to idle settle, not a wedge', async () => {
    // Documents why the retained fail-closed pin above is safe: the
    // statusUncertain running record is not a dead end. The synthesized
    // idle pair reaches the child idle-reconcile path, readSessionOutcome
    // confirms the terminal host outcome with final text, and the job
    // settles — the fail-closed branch only refuses the UNPROVEN injected
    // completion, it does not block reconciliation.
    const coordinator = new SessionLifecycle(() => {});
    const board = new BackgroundJobBoard();
    const first = createHook({
      backgroundJobBoard: board,
      coordinator,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-relaunch',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'first run',
    });

    await first.hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'child-relaunch' },
      },
    });
    coordinator.dispatchSessionDeleted('child-relaunch');

    const { hook } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
      idleReconcileDelayMs: 0,
      sessionClient: {
        get: mock(async () => {
          await Bun.sleep(1); // This positive fixture must finish strictly after admission.
          return { data: { outcome: 'succeeded', time: { idle: Date.now() } } };
        }),
        messages: mock(async () => ({
          data: [
            {
              info: { id: 'm1', role: 'assistant' },
              parts: [{ type: 'text', text: 'settled final answer' }],
            },
          ],
        })),
      },
      hostOutcomeClock: 'shared-unix-ms',
    });
    board.registerLaunch({
      taskID: 'child-relaunch',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'second run',
    });

    // Exact fail-closed shape as the pin above: unobserved, unfenced
    // explicit completion after delete + same-board relaunch.
    const replay = {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [
            {
              type: 'text',
              id: 'unobserved-completion',
              synthetic: true,
              text: [
                '<task id="child-relaunch" state="completed">',
                '<summary>Background task completed: unknown origin</summary>',
                '<task_result>',
                'ambiguous result',
                '</task_result>',
                '</task>',
              ].join('\n'),
            },
          ],
        },
      ],
    };
    await hook['experimental.chat.messages.transform']({}, replay as never);
    expect(board.get('child-relaunch')).toMatchObject({
      generation: 2,
      state: 'running',
      statusUncertain: true,
      terminalUnreconciled: false,
    });

    // The synthesized idle pair (event-adapter's terminal
    // session.execution.* products) settles the job via the host outcome.
    await hook.event({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'child-relaunch',
          status: { type: 'idle' },
        },
      },
    });
    await hook.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'child-relaunch' },
      },
    });
    await flushChildIdleReconcile();

    expect(board.get('child-relaunch')).toMatchObject({
      generation: 2,
      state: 'completed',
      terminalState: 'completed',
      statusUncertain: false,
      resultSummary: 'settled final answer',
    });
  });

  test('skips an old remembered completion after relaunch without poisoning status (fence-first)', async () => {
    const board = new BackgroundJobBoard();
    const { hook, complete } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-stale-fence',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'first run',
    });
    const completion = {
      type: 'text',
      id: 'stale-fence-occurrence',
      synthetic: true,
      text: [
        '<task id="child-stale-fence" state="completed">',
        '<summary>Background task completed: old run</summary>',
        '<task_result>old result</task_result>',
        '</task>',
      ].join('\n'),
    };
    const replayable = { ...completion };
    await hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: completion },
      },
    });
    complete('child-stale-fence', 'old result');
    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [completion],
        },
      ],
    } as never);
    expect(board.get('child-stale-fence')).toMatchObject({
      state: 'completed',
      resultSummary: 'old result',
    });

    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'child-stale-fence' },
      },
    });
    const relaunched = board.registerLaunch({
      taskID: 'child-stale-fence',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'second run',
    });

    // Simulate the older lifecycle's occurrence bookkeeping being absent
    // (only the processed-completion FENCE survives): the fence must skip
    // the replay cleanly BEFORE the deletion-epoch fail-closed branch can
    // mark the fresh running generation status-uncertain.
    getBackgroundJobLifecycleLedger(board).syntheticTerminalOccurrences.clear();

    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [replayable],
        },
      ],
    } as never);

    expect(board.get('child-stale-fence')).toMatchObject({
      generation: relaunched.generation,
      state: 'running',
      statusUncertain: false,
      resultSummary: undefined,
    });
  });

  test('keeps unobserved legacy and host-message completions fail-closed after deletion', async () => {
    const board = new BackgroundJobBoard();
    const terminalListener = mock(() => {});
    board.addTerminalOutcomeListener(terminalListener);
    const { hook } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-unobserved-weak',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'first run',
    });
    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'child-unobserved-weak' },
      },
    });
    board.registerLaunch({
      taskID: 'child-unobserved-weak',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'second run',
    });

    const legacyCompletion = {
      type: 'text',
      synthetic: true,
      text: [
        '<task id="child-unobserved-weak" state="completed">',
        '<summary>Background task completed: legacy</summary>',
        '<task_result>legacy result</task_result>',
        '</task>',
      ].join('\n'),
    };
    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [legacyCompletion],
        },
      ],
    } as never);
    expect(board.get('child-unobserved-weak')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });

    const hostMessageCompletion = {
      type: 'text',
      synthetic: true,
      messageID: 'unobserved-weak-message',
      text: [
        '<task id="child-unobserved-weak" state="completed">',
        '<summary>Background task completed: host</summary>',
        '<task_result>host result</task_result>',
        '</task>',
      ].join('\n'),
    };
    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
          parts: [hostMessageCompletion],
        },
      ],
    } as never);
    expect(board.get('child-unobserved-weak')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      resultSummary: undefined,
    });
    expect(terminalListener).not.toHaveBeenCalled();
  });

  test('accepts a host messageID occurrence in the current generation', async () => {
    const board = new BackgroundJobBoard();
    const terminalListener = mock(() => {});
    board.addTerminalOutcomeListener(terminalListener);
    const { hook, complete } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-ambiguous',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'ambiguous observation',
    });

    const observedCompletion = {
      type: 'text',
      synthetic: true,
      messageID: 'ambiguous-message',
      text: [
        '<task id="child-ambiguous" state="completed">',
        '<summary>Background task completed: uncertain</summary>',
        '<task_result>',
        'uncertain result',
        '</task_result>',
        '</task>',
      ].join('\n'),
    };
    await hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: observedCompletion },
      },
    });
    const transformedCompletion = { ...observedCompletion };
    delete transformedCompletion.messageID;
    complete('child-ambiguous', 'uncertain result');
    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: {
            id: 'ambiguous-message',
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [transformedCompletion],
        },
      ],
    } as never);

    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: {
            id: 'ambiguous-message',
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ ...transformedCompletion }],
        },
      ],
    } as never);

    expect(board.get('child-ambiguous')).toMatchObject({
      state: 'completed',
      resultSummary: 'uncertain result',
      terminalUnreconciled: true,
    });
    expect(terminalListener).toHaveBeenCalledTimes(1);
  });

  test('keeps a host completion without observed provenance fail-closed', async () => {
    const board = new BackgroundJobBoard();
    const terminalListener = mock(() => {});
    board.addTerminalOutcomeListener(terminalListener);
    const { hook } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-no-host-provenance',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'no host provenance',
    });

    const completion = {
      type: 'text',
      synthetic: true,
      messageID: 'unobserved-host-message',
      text: [
        '<task id="child-no-host-provenance" state="completed">',
        '<summary>Background task completed: unobserved</summary>',
        '<task_result>unobserved result</task_result>',
        '</task>',
      ].join('\n'),
    };
    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: {
            id: 'unobserved-host-message',
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ ...completion, messageID: undefined }],
        },
      ],
    } as never);

    expect(board.get('child-no-host-provenance')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      terminalUnreconciled: false,
    });
    expect(terminalListener).not.toHaveBeenCalled();
  });

  test('keeps an exact explicit ID collision independent from host provenance', async () => {
    const board = new BackgroundJobBoard();
    const terminalListener = mock(() => {});
    board.addTerminalOutcomeListener(terminalListener);
    const { hook, complete } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-explicit-host-prefix',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'explicit host prefix',
    });
    const hostCompletion = {
      type: 'text',
      synthetic: true,
      messageID: 'collision-host-message',
      text: [
        '<task id="child-explicit-host-prefix" state="completed">',
        '<summary>Background task completed: host</summary>',
        '<task_result>host result</task_result>',
        '</task>',
      ].join('\n'),
    };
    await hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: hostCompletion },
      },
    });
    const hostOrigin = [
      ...getBackgroundJobLifecycleLedger(
        board,
      ).syntheticTerminalOccurrences.values(),
    ][0];
    if (!hostOrigin) throw new Error('host origin was not recorded');

    const explicitCompletion = {
      type: 'text',
      id: hostOrigin.occurrenceID,
      synthetic: true,
      text: [
        '<task id="child-explicit-host-prefix" state="completed">',
        '<summary>Background task completed: explicit</summary>',
        '<task_result>explicit result</task_result>',
        '</task>',
      ].join('\n'),
    };
    await hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: explicitCompletion },
      },
    });
    complete('child-explicit-host-prefix', 'explicit result');
    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [hostCompletion],
        },
      ],
    } as never);
    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [explicitCompletion],
        },
      ],
    } as never);

    expect(board.get('child-explicit-host-prefix')).toMatchObject({
      state: 'completed',
      resultSummary: 'explicit result',
      terminalUnreconciled: true,
    });
    expect(terminalListener).toHaveBeenCalledTimes(1);
  });

  test('rejects weak provenance after relaunch without session deletion', async () => {
    const board = new BackgroundJobBoard();
    const terminalListener = mock(() => {});
    board.addTerminalOutcomeListener(terminalListener);
    const { hook } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-undetected-relaunch',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'first run',
    });
    const completion = {
      type: 'text',
      synthetic: true,
      messageID: 'undetected-relaunch-message',
      text: [
        '<task id="child-undetected-relaunch" state="completed">',
        '<summary>Background task completed: first run</summary>',
        '<task_result>old result</task_result>',
        '</task>',
      ].join('\n'),
    };
    board.updateStatus({
      taskID: 'child-undetected-relaunch',
      state: 'completed',
      resultSummary: 'first run',
    });
    const relaunched = board.registerLaunch({
      taskID: 'child-undetected-relaunch',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'second run',
    });
    terminalListener.mockClear();
    // The old message is first observed only after the same-ID relaunch.
    await hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: completion },
      },
    });

    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: {
            id: 'undetected-relaunch-message',
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ ...completion, messageID: undefined }],
        },
      ],
    } as never);

    expect(board.get('child-undetected-relaunch')).toMatchObject({
      generation: relaunched.generation,
      state: 'running',
      statusUncertain: true,
      resultSummary: undefined,
    });
    expect(terminalListener).not.toHaveBeenCalled();
  });

  test('does not reject weak provenance after an unrelated task deletion', async () => {
    const board = new BackgroundJobBoard();
    const terminalListener = mock(() => {});
    board.addTerminalOutcomeListener(terminalListener);
    const { hook, complete } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-unrelated-delete',
      parentSessionID: 'other-parent',
      agent: 'explorer',
      description: 'child-unrelated-delete',
    });
    board.registerLaunch({
      taskID: 'child-valid-host',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'child-valid-host',
    });
    const completion = {
      type: 'text',
      synthetic: true,
      messageID: 'valid-host-message',
      text: [
        '<task id="child-valid-host" state="completed">',
        '<summary>Background task completed: valid host</summary>',
        '<task_result>valid result</task_result>',
        '</task>',
      ].join('\n'),
    };
    await hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: completion },
      },
    });
    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'child-unrelated-delete' },
      },
    });

    complete('child-valid-host', 'valid result');
    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: {
            id: 'valid-host-message',
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ ...completion, messageID: undefined }],
        },
      ],
    } as never);

    expect(board.get('child-valid-host')).toMatchObject({
      state: 'completed',
      resultSummary: 'valid result',
      terminalUnreconciled: true,
    });
    expect(terminalListener).toHaveBeenCalledTimes(1);
  });

  test('keeps a distinct weak origin after processing the first one fail-closed', async () => {
    const board = new BackgroundJobBoard();
    const terminalListener = mock(() => {});
    board.addTerminalOutcomeListener(terminalListener);
    const { hook, complete } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-processed-weak-origin',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'processed weak origin',
    });
    const completion = (result: string) => ({
      type: 'text',
      synthetic: true,
      messageID: 'shared-processed-message',
      text: [
        '<task id="child-processed-weak-origin" state="completed">',
        '<summary>Background task completed: processed</summary>',
        `<task_result>${result}</task_result>`,
        '</task>',
      ].join('\n'),
    });
    const first = completion('first result');
    await hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: first },
      },
    });
    complete('child-processed-weak-origin', 'first result');
    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: {
            id: 'shared-processed-message',
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ ...first, messageID: undefined }],
        },
      ],
    } as never);

    const second = completion('second result');
    await hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: second },
      },
    });
    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: {
            id: 'shared-processed-message',
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [{ ...second, messageID: undefined }],
        },
      ],
    } as never);

    expect(board.get('child-processed-weak-origin')).toMatchObject({
      state: 'completed',
      resultSummary: 'first result',
      terminalUnreconciled: true,
    });
    expect(terminalListener).toHaveBeenCalledTimes(1);
  });

  test('keeps multiple current-generation host messageID origins fail-closed', async () => {
    const board = new BackgroundJobBoard();
    const terminalListener = mock(() => {});
    board.addTerminalOutcomeListener(terminalListener);
    const { hook } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-multiple-host-origins',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'multiple host origins',
    });

    const completion = (messageID: string, result: string) => ({
      type: 'text',
      synthetic: true,
      messageID,
      text: [
        '<task id="child-multiple-host-origins" state="completed">',
        '<summary>Background task completed: multiple origins</summary>',
        '<task_result>',
        result,
        '</task_result>',
        '</task>',
      ].join('\n'),
    });
    const first = completion('host-message-shared', 'first result');
    const second = completion('host-message-shared', 'second result');

    for (const part of [first, second]) {
      await hook.event({
        event: {
          type: 'message.part.updated',
          properties: { part },
        },
      });
    }

    await hook['experimental.chat.messages.transform']({}, {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [first],
        },
      ],
    } as never);

    expect(board.get('child-multiple-host-origins')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      terminalUnreconciled: false,
    });
    expect(terminalListener).not.toHaveBeenCalled();
  });

  test('retains an old occurrence provenance after more than 500 later occurrences', async () => {
    const board = new BackgroundJobBoard();
    const terminalListener = mock(() => {});
    board.addTerminalOutcomeListener(terminalListener);
    const { hook } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });

    board.registerLaunch({
      taskID: 'child-occurrence-ledger',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'generation one',
    });

    const completion = (id: string, result: string) => ({
      type: 'text',
      id,
      synthetic: true,
      text: [
        '<task id="child-occurrence-ledger" state="completed">',
        '<summary>Background task completed: occurrence</summary>',
        '<task_result>',
        result,
        '</task_result>',
        '</task>',
      ].join('\n'),
    });

    const firstCompletion = completion('p1-occurrence', 'old result');
    await hook.event({
      event: {
        type: 'message.part.updated',
        properties: { part: firstCompletion },
      },
    });

    for (let index = 0; index < 501; index += 1) {
      board.registerLaunch({
        taskID: 'child-occurrence-ledger',
        parentSessionID: 'parent-1',
        agent: 'explorer',
        description: `generation ${index + 2}`,
      });
      const laterCompletion = completion(
        `later-occurrence-${index}`,
        `result ${index}`,
      );
      await hook.event({
        event: {
          type: 'message.part.updated',
          properties: { part: laterCompletion },
        },
      });
      await hook['experimental.chat.messages.transform']({}, {
        messages: [
          {
            info: {
              role: 'user',
              agent: 'orchestrator',
              sessionID: 'parent-1',
            },
            parts: [laterCompletion],
          },
        ],
      } as never);
    }

    terminalListener.mockClear();
    const current = board.registerLaunch({
      taskID: 'child-occurrence-ledger',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'current generation',
    });
    expect(current.generation).toBe(503);

    const replay = {
      messages: [
        {
          info: {
            role: 'user',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [JSON.parse(JSON.stringify(firstCompletion))],
        },
      ],
    };
    await hook['experimental.chat.messages.transform']({}, replay as never);

    expect(board.get('child-occurrence-ledger')).toMatchObject({
      generation: current.generation,
      state: 'running',
      statusUncertain: true,
      resultSummary: undefined,
    });
    expect(terminalListener).not.toHaveBeenCalled();
  });

  test('direct drop suppresses historical rehydrate until a new launch clears it', async () => {
    const board = new BackgroundJobBoard();
    const { hook } = createHook({
      backgroundJobBoard: board,
      runtimeStatusReconcileDelayMs: 60_000,
    });
    board.registerLaunch({
      taskID: 'child-direct-drop',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'dropped run',
    });

    board.drop('child-direct-drop');
    const ledger = getBackgroundJobLifecycleLedger(board);
    expect(ledger.tombstones.has('child-direct-drop')).toBe(true);

    const historical = {
      messages: [
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [historicalRunningTaskPart('child-direct-drop')],
        },
        ...createMessages('parent-1', 'continue').messages,
      ],
    };
    await hook['experimental.chat.messages.transform']({}, historical as never);
    expect(board.get('child-direct-drop')).toBeUndefined();

    const relaunched = board.registerLaunch({
      taskID: 'child-direct-drop',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'new run',
    });
    expect(relaunched.generation).toBe(2);
    expect(ledger.tombstones.has('child-direct-drop')).toBe(false);

    const replay = {
      messages: [
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: 'parent-1',
          },
          parts: [historicalRunningTaskPart('child-direct-drop')],
        },
        ...createMessages('parent-1', 'continue again').messages,
      ],
    };
    await hook['experimental.chat.messages.transform']({}, replay as never);

    expect(board.get('child-direct-drop')).toMatchObject({
      generation: 2,
      state: 'running',
      description: 'new run',
    });
  });

  test('marks idle as provisional when fallback guard passes', async () => {
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
      state: 'running',
      statusUncertain: true,
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

    // Second idle remains provisional without an explicit task result.
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
      state: 'running',
      statusUncertain: true,
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

  test('deleting a parent releases its children admission slots (recursive-delete ordering)', async () => {
    // A recursive delete can arrive parent-first, and a child mid-fallback
    // is skipped entirely, so the parent's cleanup must release every
    // child's slot itself — otherwise capacity is leaked forever.
    const coordinator = new SessionLifecycle(() => {});
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'parent-1',
      parentSessionID: 'grandparent',
      agent: 'orchestrator',
      description: 'parent orchestrator',
    });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'child one',
    });
    board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'child two',
    });

    const concurrency = new BackgroundTaskConcurrency({
      defaultConcurrency: 10,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    // Every task holds an admission slot, as if it were running.
    concurrency.restoreTask('parent-1', 'openai/orch');
    concurrency.restoreTask('child-1', 'openai/child1');
    concurrency.restoreTask('child-2', 'openai/child2');
    expect(concurrency.snapshot()).toEqual({ active: 3, queued: 0 });

    createHook({
      backgroundJobBoard: board,
      coordinator,
      backgroundTaskConcurrency: concurrency,
      shouldManageSession: () => false,
      isFallbackInProgress: () => false,
    });

    coordinator.dispatchSessionDeleted('parent-1');

    expect(concurrency.snapshot()).toEqual({ active: 0, queued: 0 });
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
    // Child goes idle without task output — board remains provisional.
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'child-1' } },
    });
    await flushChildIdleReconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
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
        backgroundJobBoard: board,
        wallClockTimeoutMs: 100,
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
      backgroundJobBoard: board,
      wallClockTimeoutMs: 100,
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

  test('fallback delete/recreate/busy keeps the watchdog armed for the live run', async () => {
    const board = new BackgroundJobBoard();
    const coordinator = new SessionLifecycle(() => {});
    const clock = createSupervisorClock();
    const abort = mock(async () => undefined);
    const supervisor = new BackgroundJobSupervisor({
      backgroundJobBoard: board,
      wallClockTimeoutMs: 100,
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

    // A foreground-fallback delete/recreate does not consume the one-shot
    // deadline: the live run is still aborted through the host.
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith('fallback-child');
    expect(board.get('fallback-child')?.state).toBe('running');
  });

  test('a fallback deletion after the watchdog abort drops the row without inventing a terminal', async () => {
    const board = new BackgroundJobBoard();
    const coordinator = new SessionLifecycle(() => {});
    const clock = createSupervisorClock();
    const abort = mock(async () => undefined);
    const terminalGate = createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      now: clock.now,
    });
    const supervisor = new BackgroundJobSupervisor({
      backgroundJobBoard: board,
      wallClockTimeoutMs: 100,
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
      terminalGate,
      backgroundJobSupervisor: supervisor,
      coordinator,
      shouldManageSession: () => false,
      isFallbackInProgress: () => fallback,
    });

    await clock.advanceTo(100);
    expect(abort).toHaveBeenCalledTimes(1);
    // The watchdog aborted; no terminal state was fabricated locally.
    expect(board.get('fallback-grace-child')).toMatchObject({
      state: 'running',
      timedOut: false,
    });

    fallback = true;
    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'fallback-grace-child' },
      },
    });
    coordinator.dispatchSessionDeleted('fallback-grace-child');

    expect(abort).toHaveBeenCalledTimes(1);
    expect(board.get('fallback-grace-child')?.state).toBe('running');
    terminalGate.dispose();
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

  test('idle via session.status path remains provisional', async () => {
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
      state: 'running',
      statusUncertain: true,
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

  test('unmanaged Build history neither registers a parent nor adopts its tasks', async () => {
    const board = new BackgroundJobBoard();
    const registerSessionAsOrchestrator = mock(() => {});
    const { hook } = createHook({
      backgroundJobBoard: board,
      shouldManageSession: () => false,
      registerSessionAsOrchestrator,
    });
    const messages = {
      messages: [
        {
          info: { role: 'user', sessionID: 'parent-1', agent: 'build' },
          parts: [historicalRunningTaskPart('historical-child')],
        },
      ],
    };
    await transformMessages(hook, messages as never);
    expect(registerSessionAsOrchestrator).not.toHaveBeenCalled();
    expect(board.get('historical-child')).toBeUndefined();
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

    // After recovery: agentMap corrected. The board is never rendered
    // (issue #1647), so the payload carries no board bytes.
    expect(agentMap.get('orchestrator-1')).toBe('orchestrator');
    expect(boardText(messages)).toBeUndefined();
  });

  test('repairs session mapping before composed reminder transforms', async () => {
    const agentMap = new Map<string, string>();
    const shouldInject = (sessionID: string) =>
      agentMap.get(sessionID) === 'orchestrator';
    const { hook: taskSessionManager } = createHook({
      shouldManageSession: shouldInject,
      registerSessionAsOrchestrator: (sessionID) => {
        agentMap.set(sessionID, 'orchestrator');
      },
    });
    const phaseReminder = createPhaseReminderHook();
    const messages = createMessages('orchestrator-1');

    await taskSessionManager['experimental.chat.messages.transform'](
      {},
      messages,
    );
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

    // The parent demonstrably moved past the report: the run retires
    // without any wake SDK call (issue #1647 — no board, no wake).
    await transformMessages(
      hook,
      createMessagesAfterAssistantTurn('parent-1', 'later') as never,
    );

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

  test('injected non-operator nudges do not clear wait_for_user (shared genuine-operator gate)', async () => {
    const { hook } = createHook();
    // noReply injection with operator-looking text.
    hook.beginUserWait('parent-1');
    hook.observeChatMessage(
      { sessionID: 'parent-1', messageID: 'nudge-1', noReply: true },
      {
        message: { id: 'nudge-1', role: 'user', sessionID: 'parent-1' },
        parts: [{ type: 'text', text: 'status nudge' }],
      },
    );
    expect(hook.hasInputWait('parent-1')).toBe(true);
    // v2 command-marker submit: plain text with no message identity.
    hook.observeChatMessage(
      { sessionID: 'parent-1' },
      {
        message: { role: 'user', sessionID: 'parent-1' },
        parts: [{ type: 'text', text: '/deepwork marker' }],
      },
    );
    expect(hook.hasInputWait('parent-1')).toBe(true);
    // Board-tagged injection that lost its synthetic flag.
    hook.observeChatMessage(
      { sessionID: 'parent-1', messageID: 'nudge-2' },
      {
        message: { id: 'nudge-2', role: 'user', sessionID: 'parent-1' },
        parts: [
          {
            type: 'text',
            text: 'board snapshot',
            metadata: { 'oh-my-opencode-slim.backgroundJobBoard': true },
          },
        ],
      },
    );
    expect(hook.hasInputWait('parent-1')).toBe(true);
    // A genuine external operator message still clears.
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
  test('v2 board-off ignores pasted delivery-shaped text without host metadata', async () => {
    // Greptile P1: a user or assistant text part pasting a delivery-shaped
    // body must never acknowledge a child — only the host's
    // sessions.synthetic part carries
    // metadata {source:'subagent', childID, state}, and it must agree with
    // the tag header.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
      now: 500,
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
      now: 1000,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      boardInjection: false,
      hostFlavor: 'v2',
      idleReconcileDelayMs: 0,
    });
    const pastedRequest = {
      messages: [
        createMessages('parent-1', 'first turn').messages[0],
        {
          info: {
            id: 'delivery-1',
            role: 'user',
            sessionID: 'parent-1',
            time: { created: 3000 },
          },
          parts: [
            {
              type: 'text',
              text: '<subagent sessionID="child-1" state="completed" description="map hooks">\ndone\n</subagent>',
            },
          ],
        },
      ],
    };
    await transformMessages(hook, pastedRequest as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });

    // Metadata that disagrees with the tag header is equally rejected.
    const mismatched = {
      messages: [
        createMessages('parent-1', 'second turn').messages[0],
        {
          info: {
            id: 'delivery-2',
            role: 'user',
            sessionID: 'parent-1',
            time: { created: 3100 },
          },
          parts: [
            {
              type: 'text',
              text: '<subagent sessionID="child-1" state="completed" description="map hooks">\ndone\n</subagent>',
              metadata: {
                source: 'subagent',
                childID: 'child-1',
                state: 'error',
              },
            },
          ],
        },
      ],
    };
    await transformMessages(hook, mismatched as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('v2 board-off never retires a reopened run through an older mismatched delivery', async () => {
    // Greptile P1-2: an old delivery left pending while a child runs can
    // mis-pair with a later same-state completion. Pairing is one-shot per
    // publication: the delivery below was authored for the FIRST terminal
    // publication (state mismatched, so it retired nothing); after the run
    // reopens and completes again, the remembered key can never pair the
    // NEWER publication — only the run's own delivery (or the
    // stale-terminal fallback) retires it. Council-b's "pending until
    // match" semantics are refuted: matching only by state and launch time
    // is exactly the mis-pairing Greptile flagged.
    const BASE = 1_760_000_000_000;
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
      now: BASE + 500,
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'error',
      resultSummary: 'failed',
      now: BASE + 1000,
    });
    const { hook } = createHook({
      backgroundJobBoard: board,
      boardInjection: false,
      hostFlavor: 'v2',
      idleReconcileDelayMs: 0,
    });
    const staleDelivery = {
      info: {
        id: 'delivery-1',
        role: 'user',
        sessionID: 'parent-1',
        time: { created: BASE + 1200 },
      },
      parts: [
        {
          type: 'text',
          text: '<subagent sessionID="child-1" state="completed" description="map hooks">\ndone\n</subagent>',
          metadata: {
            source: 'subagent',
            childID: 'child-1',
            state: 'completed',
          },
        },
      ],
    };
    await transformMessages(hook, {
      messages: [
        createMessages('parent-1', 'first turn').messages[0],
        staleDelivery,
      ],
    } as never);
    // Observed while the record was error-terminal: state mismatch, key
    // remembered, nothing retired.
    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      terminalUnreconciled: true,
    });

    // The run reopens and completes with the state the OLD delivery
    // reports. The remembered key must not pair this newer publication.
    board.markRunningFromLiveSession('child-1', BASE + 1500);
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
      now: BASE + 2000,
    });
    expect(board.get('child-1')).toMatchObject({ terminalUnreconciled: true });
    await transformMessages(hook, {
      messages: [
        createMessages('parent-1', 'second turn').messages[0],
        staleDelivery,
      ],
    } as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });

    // The run's own delivery (authored after this publication) retires it.
    await transformMessages(hook, {
      messages: [
        createMessages('parent-1', 'second turn').messages[0],
        staleDelivery,
        {
          info: {
            id: 'delivery-2',
            role: 'user',
            sessionID: 'parent-1',
            time: { created: BASE + 2500 },
          },
          parts: [
            {
              type: 'text',
              text: '<subagent sessionID="child-1" state="completed" description="map hooks">\nnew result\n</subagent>',
              metadata: {
                source: 'subagent',
                childID: 'child-1',
                state: 'completed',
              },
            },
          ],
        },
      ],
    } as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('v2 board-off rejects an evicted pre-reopen delivery on its own causality (PR #1608 P1)', async () => {
    // Greptile P1 on PR #1608: the seen-set is an accelerator, not the
    // guarantee. The reopen regression above holds only while the old key is
    // retained; the LRU cap (1024) can evict it, after which reopening does
    // NOT bump lastLaunchedAt and the ±2s publication skew lets a pre-reopen
    // delivery through to the new same-state completion. The lastLiveBusyAt
    // gate makes causality hold independently of eviction. The injection
    // state is driven directly so the test can assert the eviction that puts
    // the replay on the gate path instead of the seen-set path.
    const BASE = 1_760_000_000_000;
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
      now: BASE + 500,
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'error',
      resultSummary: 'failed',
      now: BASE + 1000,
    });
    // Filler record: terminal in a state every filler delivery mismatches,
    // so each filler is remembered (driving the LRU eviction below) but can
    // never pair.
    board.registerLaunch({
      taskID: 'child-filler',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map hooks',
      now: BASE + 500,
    });
    board.updateStatus({
      taskID: 'child-filler',
      state: 'error',
      resultSummary: 'failed',
      now: BASE + 1000,
    });
    const state = createBoardlessInjectionState(board);
    const inject = (output: { messages: unknown[] }) =>
      injectBackgroundJobBoard(state, {}, output);
    const staleDelivery = {
      info: {
        id: 'delivery-1',
        role: 'user',
        sessionID: 'parent-1',
        time: { created: BASE + 1200 },
      },
      parts: [
        {
          type: 'text',
          text: '<subagent sessionID="child-1" state="completed" description="map hooks">\ndone\n</subagent>',
          metadata: {
            source: 'subagent',
            childID: 'child-1',
            state: 'completed',
          },
        },
      ],
    };
    const staleKey = deliverySeenKey(staleDelivery);
    await inject({
      messages: [
        createMessages('parent-1', 'first turn').messages[0],
        staleDelivery,
      ],
    });
    // Observed while the record was error-terminal: state mismatch, key
    // remembered, nothing retired.
    let seen = state.observedNativeDeliveries?.get('parent-1');
    expect(seen?.size).toBe(1);
    expect(seen?.has(staleKey)).toBe(true);
    expect(board.get('child-1')).toMatchObject({
      state: 'error',
      terminalUnreconciled: true,
    });

    // Reopen (lastLiveBusyAt = BASE+1500) and complete in the state the OLD
    // delivery reports, with completedAt inside the 2s publication skew of
    // it. The remembered key is pushed out of the LRU below by 1024 filler
    // deliveries that are themselves remembered.
    board.markRunningFromLiveSession('child-1', BASE + 1500);
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
      now: BASE + 2000,
    });
    expect(board.get('child-1')).toMatchObject({ terminalUnreconciled: true });
    // Every filler is a valid native delivery whose state mismatches the
    // filler record's terminal state: each is remembered (so it really does
    // take a seen-set slot) and none can pair.
    const fillers = Array.from({ length: 1024 }, (_, index) => ({
      info: {
        id: `noise-${index + 1}`,
        role: 'user',
        sessionID: 'parent-1',
        time: { created: BASE + 3000 + index },
      },
      parts: [
        {
          type: 'text',
          text: `<subagent sessionID="child-filler" state="completed" description="map hooks">\nfailed ${index + 1}\n</subagent>`,
          metadata: {
            source: 'subagent',
            childID: 'child-filler',
            state: 'completed',
          },
        },
      ],
    }));
    await inject({
      messages: [
        createMessages('parent-1', 'second turn').messages[0],
        staleDelivery,
        ...fillers,
      ],
    });
    expect(board.get('child-1')).toMatchObject({ terminalUnreconciled: true });
    seen = state.observedNativeDeliveries?.get('parent-1');
    // All 1024 fillers landed (the map is at the cap) and the stale key was
    // the oldest, so the eviction really happened before the replay below.
    expect(seen?.size).toBe(1024);
    expect(seen?.has(staleKey)).toBe(false);

    // The key is now evicted (asserted above), so the replay reaches the
    // pairing gates and must be rejected by the lastLiveBusyAt gate alone:
    // drop that gate and child-1 would pair and reconcile here.
    await inject({
      messages: [
        createMessages('parent-1', 'second turn').messages[0],
        staleDelivery,
      ],
    });
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });

    // The run's own delivery (authored after the reopen) still pairs.
    await inject({
      messages: [
        createMessages('parent-1', 'second turn').messages[0],
        staleDelivery,
        {
          info: {
            id: 'delivery-2',
            role: 'user',
            sessionID: 'parent-1',
            time: { created: BASE + 2500 },
          },
          parts: [
            {
              type: 'text',
              text: '<subagent sessionID="child-1" state="completed" description="map hooks">\nnew result\n</subagent>',
              metadata: {
                source: 'subagent',
                childID: 'child-1',
                state: 'completed',
              },
            },
          ],
        },
      ],
    });
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });
});
