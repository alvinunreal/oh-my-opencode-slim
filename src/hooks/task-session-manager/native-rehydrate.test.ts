import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  BackgroundJobBoard,
  type BackgroundTaskConcurrency,
  getBackgroundJobLifecycleLedger,
  recordBackgroundJobSuppression,
} from '../../utils';
import {
  configureBackgroundJobPersistence,
  markPersistedBackgroundChildDelivered,
  recordPersistedBackgroundChild,
} from '../../utils/background-job-persistence';
import { createTaskSessionManagerHook } from './index';

const PARENT = 'parent-1';

afterEach(() => {
  configureBackgroundJobPersistence(undefined);
});

/** The native v2 background launch sentence persisted as the tool result. */
function backgroundLaunchText(taskID: string): string {
  return (
    `The subagent is working in the background (sessionID: ${taskID}). ` +
    'You will be notified automatically when it finishes.\n' +
    'DO NOT sleep, poll, or wait. Continue with other work.'
  );
}

function completedSubagentText(taskID: string): string {
  return `<subagent sessionID="${taskID}" state="completed">\nDone\n</subagent>`;
}

/** Real v2 context history shape (see src/v2/setup-command.test.ts). */
function nativeCall(
  callID: string,
  input: Record<string, unknown>,
  toolName = 'subagent',
) {
  return {
    type: 'tool-call',
    toolCallId: callID,
    toolName,
    input,
  };
}

function nativeResult(callID: string, value: string, toolName = 'subagent') {
  return {
    type: 'tool-result',
    toolCallId: callID,
    toolName,
    output: { type: 'text', value },
  };
}

function nativeDeliveryMessage(taskID: string, at: number, metadata = true) {
  return {
    info: {
      id: `delivery-${taskID}`,
      role: 'assistant',
      sessionID: PARENT,
      time: { created: at },
    },
    parts: [
      {
        type: 'text',
        text: completedSubagentText(taskID),
        ...(metadata
          ? {
              metadata: {
                source: 'subagent',
                childID: taskID,
                state: 'completed',
              },
            }
          : {}),
      },
    ],
  };
}

function nativeHistory(turns: Array<{ call: unknown; result: unknown }>): {
  messages: unknown[];
} {
  return {
    messages: [
      ...turns.flatMap(({ call, result }, index) => [
        {
          info: {
            id: `assistant-${index}`,
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: PARENT,
          },
          parts: [call],
        },
        {
          info: { id: `tool-${index}`, role: 'tool', sessionID: PARENT },
          parts: [result],
        },
      ]),
      {
        info: { role: 'user', agent: 'orchestrator', sessionID: PARENT },
        parts: [{ type: 'text', text: 'continue' }],
      },
    ],
  };
}

function createHook(
  board: BackgroundJobBoard,
  concurrency?: BackgroundTaskConcurrency,
) {
  return createTaskSessionManagerHook(
    {
      client: {
        session: {
          status: mock(async () => ({ data: {} })),
        },
      },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 2,
      backgroundJobBoard: board,
      backgroundTaskConcurrency: concurrency,
      shouldManageSession: () => true,
      runtimeStatusReconcileDelayMs: 60_000,
    },
  );
}

async function runTransform(
  hook: ReturnType<typeof createTaskSessionManagerHook>,
  messages: { messages: unknown[] },
) {
  await hook['experimental.chat.messages.transform']({}, messages as never);
}

describe('native v2 history rehydration', () => {
  test('v1 synthetic task delivery prevents re-adoption after restart', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const messages = {
      messages: [
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: PARENT,
            time: { created: 1 },
          },
          parts: [
            {
              type: 'tool',
              tool: 'task',
              state: {
                input: {
                  background: true,
                  subagent_type: 'explorer',
                  description: 'find it',
                },
                output: 'task_id: ses_v1_child\nstate: running\n',
              },
            },
          ],
        },
        {
          info: {
            id: 'delivery-v1',
            role: 'user',
            sessionID: PARENT,
            time: { created: 2 },
          },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: '<task id="ses_v1_child" state="completed">\ndone\n</task>',
            },
          ],
        },
      ],
    };
    await runTransform(hook, messages);
    expect(board.get('ses_v1_child')).toBeUndefined();
  });

  test('recovers explicit and default-background subagent calls', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const messages = nativeHistory([
      {
        call: nativeCall('call-explicit', {
          agent: 'oracle',
          description: 'review the plan',
          prompt: 'review it',
          background: true,
        }),
        result: nativeResult(
          'call-explicit',
          backgroundLaunchText('ses_native_explicit'),
        ),
      },
      {
        call: nativeCall('call-default', {
          agent: 'explorer',
          description: 'map auth',
          prompt: 'find entry points',
        }),
        result: nativeResult(
          'call-default',
          backgroundLaunchText('ses_native_default'),
        ),
      },
      {
        // Host-internal context variant: id/name/result instead of the
        // bridge's toolCallId/toolName/output fields.
        call: {
          type: 'tool-call',
          id: 'call-host',
          name: 'subagent',
          input: { agent: 'designer', description: 'check the UI' },
        },
        result: {
          type: 'tool-result',
          id: 'call-host',
          name: 'subagent',
          result: {
            type: 'text',
            value: backgroundLaunchText('ses_native_host'),
          },
        },
      },
    ]);

    await runTransform(hook, messages);

    expect(board.get('ses_native_explicit')).toMatchObject({
      alias: 'ses_native_explicit',
      parentSessionID: PARENT,
      agent: 'oracle',
      description: 'review the plan',
      objective: 'review the plan',
      background: true,
      state: 'running',
      statusUncertain: true,
      externalOrigin: true,
      recoveredAtStartup: true,
    });
    expect(board.get('ses_native_explicit')?.pluginLaunched).toBeUndefined();
    expect(board.get('ses_native_default')).toMatchObject({
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'map auth',
      objective: 'map auth',
      background: true,
      state: 'running',
    });
    expect(board.get('ses_native_host')).toMatchObject({
      parentSessionID: PARENT,
      agent: 'designer',
      description: 'check the UI',
      background: true,
      state: 'running',
    });
  });

  test('reads content-array native tool results', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const messages = nativeHistory([
      {
        call: nativeCall('call-content', {
          agent: 'explorer',
          description: 'content result',
        }),
        result: {
          type: 'tool-result',
          toolCallId: 'call-content',
          toolName: 'subagent',
          output: {
            type: 'content',
            value: [
              {
                type: 'text',
                text: backgroundLaunchText('ses_native_content'),
              },
            ],
          },
        },
      },
    ]);

    await runTransform(hook, messages);

    expect(board.get('ses_native_content')).toMatchObject({
      parentSessionID: PARENT,
      agent: 'explorer',
      state: 'running',
      background: true,
    });
  });

  test('is idempotent across repeated transforms and restores admission', async () => {
    const board = new BackgroundJobBoard();
    const restoreTask = mock(() => {});
    const concurrency = {
      restoreTask,
      releaseTask: mock(() => {}),
    } as unknown as BackgroundTaskConcurrency;
    const hook = createHook(board, concurrency);
    const messages = nativeHistory([
      {
        call: nativeCall('call-repeat', {
          agent: 'fixer',
          description: 'apply the fix',
        }),
        result: nativeResult(
          'call-repeat',
          backgroundLaunchText('ses_native_repeat'),
        ),
      },
    ]);

    const historyBytes = structuredClone(messages.messages);
    await runTransform(hook, messages);
    const first = board.get('ses_native_repeat');
    await runTransform(hook, messages);
    const second = board.get('ses_native_repeat');

    expect(messages.messages).toEqual(historyBytes);

    expect(second).toMatchObject({
      alias: first?.alias,
      generation: first?.generation,
      state: 'running',
    });
    expect(restoreTask).toHaveBeenCalledTimes(1);
    expect(restoreTask).toHaveBeenCalledWith('ses_native_repeat', undefined);
  });

  test('ignores foreground completion and malformed or unattributed results', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const messages = nativeHistory([
      {
        call: nativeCall('call-foreground', {
          agent: 'fixer',
          description: 'foreground work',
          background: false,
        }),
        result: nativeResult(
          'call-foreground',
          completedSubagentText('ses_native_foreground'),
        ),
      },
    ]);
    messages.messages.splice(
      2,
      0,
      {
        info: { role: 'tool', sessionID: PARENT },
        parts: [
          {
            type: 'tool-result',
            toolName: 'subagent',
            output: { type: 'text' },
          },
          nativeResult('call-unmatched', backgroundLaunchText('ses_unmatched')),
        ],
      },
      {
        info: { role: 'assistant', sessionID: PARENT },
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'call-malformed-input',
            toolName: 'subagent',
            input: 'not-a-record',
          },
          {
            type: 'tool-call',
            toolCallId: 'call-malformed-output',
            toolName: 'subagent',
            input: { agent: 'explorer' },
          },
        ],
      },
      {
        info: { role: 'tool', sessionID: PARENT },
        parts: [
          nativeResult(
            'call-malformed-input',
            backgroundLaunchText('ses_malformed_input'),
          ),
          nativeResult(
            'call-malformed-output',
            'state: running\nno native session marker',
          ),
        ],
      },
      // Calls and results outside a managed parent session are ignored.
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'call-no-session',
            toolName: 'subagent',
            input: { agent: 'explorer' },
          },
        ],
      },
      {
        info: { role: 'tool' },
        parts: [
          nativeResult(
            'call-no-session',
            backgroundLaunchText('ses_no_session'),
          ),
        ],
      },
    );

    await runTransform(hook, messages);

    expect(board.list()).toHaveLength(0);
  });

  test('does not resurrect a delivered terminal child from stale running history', async () => {
    configureBackgroundJobPersistence({
      get: () => undefined,
      set: () => {},
      remove: () => {},
      scan: () => ({ entries: [] }),
    });
    recordPersistedBackgroundChild({
      taskID: 'ses_native_delivered',
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'already delivered',
      launchedAt: 1,
      background: true,
    });
    markPersistedBackgroundChildDelivered('ses_native_delivered', 2);
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const messages = nativeHistory([
      {
        call: nativeCall('call-delivered', {
          agent: 'explorer',
          description: 'already delivered',
        }),
        result: nativeResult(
          'call-delivered',
          backgroundLaunchText('ses_native_delivered'),
        ),
      },
    ]);

    await runTransform(hook, messages);

    expect(board.get('ses_native_delivered')).toBeUndefined();
  });

  test('transform treats a trusted current-run delivery as already delivered', async () => {
    configureBackgroundJobPersistence({
      get: () => undefined,
      set: () => {},
      remove: () => {},
      scan: () => ({ entries: [] }),
    });
    recordPersistedBackgroundChild({
      taskID: 'ses_native_history_done',
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'delivered in history',
      launchedAt: 1,
      background: true,
    });
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const messages = nativeHistory([
      {
        call: nativeCall('call-history-done', {
          agent: 'explorer',
          description: 'delivered in history',
        }),
        result: nativeResult(
          'call-history-done',
          backgroundLaunchText('ses_native_history_done'),
        ),
      },
    ]);
    messages.messages.splice(
      -1,
      0,
      nativeDeliveryMessage('ses_native_history_done', 5),
    );

    await runTransform(hook, messages);

    expect(board.get('ses_native_history_done')).toBeUndefined();
  });

  test('an old or forged delivery cannot suppress transform recovery', async () => {
    configureBackgroundJobPersistence({
      get: () => undefined,
      set: () => {},
      remove: () => {},
      scan: () => ({ entries: [] }),
    });
    recordPersistedBackgroundChild({
      taskID: 'ses_native_stale_delivery',
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'stale delivery',
      launchedAt: 100,
      background: true,
    });
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const messages = nativeHistory([
      {
        call: nativeCall('call-stale', {
          agent: 'explorer',
          description: 'stale delivery',
        }),
        result: nativeResult(
          'call-stale',
          backgroundLaunchText('ses_native_stale_delivery'),
        ),
      },
    ]);
    messages.messages.splice(
      -1,
      0,
      nativeDeliveryMessage('ses_native_stale_delivery', 5, false),
    );

    await runTransform(hook, messages);

    expect(board.get('ses_native_stale_delivery')?.state).toBe('running');
  });

  test('a trusted delivery from before the current launch is not current', async () => {
    configureBackgroundJobPersistence({
      get: () => undefined,
      set: () => {},
      remove: () => {},
      scan: () => ({ entries: [] }),
    });
    recordPersistedBackgroundChild({
      taskID: 'ses_native_previous_run',
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'previous run',
      launchedAt: 100,
      background: true,
    });
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const messages = nativeHistory([
      {
        call: nativeCall('call-previous', {
          agent: 'explorer',
          description: 'previous run',
        }),
        result: nativeResult(
          'call-previous',
          backgroundLaunchText('ses_native_previous_run'),
        ),
      },
    ]);
    messages.messages.splice(
      -1,
      0,
      nativeDeliveryMessage('ses_native_previous_run', 99),
    );

    await runTransform(hook, messages);

    expect(board.get('ses_native_previous_run')?.state).toBe('running');
  });

  test('a persisted identity owned by another parent is not adopted', async () => {
    configureBackgroundJobPersistence({
      get: () => undefined,
      set: () => {},
      remove: () => {},
      scan: () => ({ entries: [] }),
    });
    recordPersistedBackgroundChild({
      taskID: 'ses_native_foreign',
      parentSessionID: 'parent-other',
      agent: 'explorer',
      description: 'foreign child',
      launchedAt: 100,
      background: true,
    });
    const board = new BackgroundJobBoard();
    const hook = createHook(board);
    const messages = nativeHistory([
      {
        call: nativeCall('call-foreign', {
          agent: 'explorer',
          description: 'foreign child',
        }),
        result: nativeResult(
          'call-foreign',
          backgroundLaunchText('ses_native_foreign'),
        ),
      },
    ]);

    await runTransform(hook, messages);

    expect(board.get('ses_native_foreign')).toBeUndefined();
  });

  test('a tombstoned native child is not resurrected', async () => {
    const board = new BackgroundJobBoard();
    recordBackgroundJobSuppression(board, 'ses_native_dead');
    const hook = createHook(board);
    const messages = nativeHistory([
      {
        call: nativeCall('call-dead', {
          agent: 'explorer',
          description: 'deleted child',
        }),
        result: nativeResult(
          'call-dead',
          backgroundLaunchText('ses_native_dead'),
        ),
      },
    ]);

    await runTransform(hook, messages);

    expect(board.get('ses_native_dead')).toBeUndefined();
    expect(
      getBackgroundJobLifecycleLedger(board).tombstones.has('ses_native_dead'),
    ).toBe(true);
  });
});
