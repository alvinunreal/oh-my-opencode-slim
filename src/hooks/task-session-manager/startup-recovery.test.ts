import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  BackgroundJobBoard,
  recordBackgroundJobSuppression,
} from '../../utils';
import {
  configureBackgroundJobPersistence,
  loadInitialBackgroundJobPersistence,
  markPersistedBackgroundChildDelivered,
  type PersistedBackgroundChild,
  persistedBackgroundChildren,
  recordPersistedBackgroundChild,
} from '../../utils/background-job-persistence';
import { createBackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import { BackgroundTaskConcurrency } from '../../utils/background-task-concurrency';
import { createTimerHarness, tick } from '../../utils/test-timers';
import { buildPluginInput } from '../../v2/client-shim';
import { recoverSubagentSessionsAtStartup } from './session-recovery';

const PARENT = 'ses_parent';
const RUNNING = 'ses_running';
const DONE = 'ses_done';
const FOREGROUND = 'ses_foreground';

function launchText(taskID: string): string {
  return (
    `The subagent is working in the background (sessionID: ${taskID}). ` +
    'You will be notified automatically when it finishes.\n' +
    'DO NOT sleep, poll, or wait. Continue with other work.'
  );
}

function completedText(taskID: string): string {
  return `<subagent sessionID="${taskID}" state="completed">\nDone\n</subagent>`;
}

function deliveryMessage(
  taskID: string,
  at: number,
  state: 'completed' | 'error' | 'cancelled' = 'completed',
  metadata = true,
) {
  return {
    info: {
      id: `delivery-${taskID}`,
      role: 'assistant',
      time: { created: at },
    },
    parts: [
      {
        type: 'text',
        text:
          state === 'completed'
            ? completedText(taskID)
            : `<subagent sessionID="${taskID}" state="${state}">\nEnded\n</subagent>`,
        ...(metadata
          ? { metadata: { source: 'subagent', childID: taskID, state } }
          : {}),
      },
    ],
  };
}

function parentTranscript(
  entries: Array<{
    callID: string;
    sessionID: string;
    value: string;
    background?: boolean;
  }>,
): { data: unknown[] } {
  return {
    data: entries.flatMap(({ callID, sessionID, value, background }) => [
      {
        info: {
          id: `assistant-${callID}`,
          role: 'assistant',
          agent: 'orchestrator',
          time: { created: 10 },
        },
        parts: [
          {
            type: 'tool-call',
            toolCallId: callID,
            toolName: 'subagent',
            input: {
              agent: 'explorer',
              description: `delegated ${sessionID}`,
              prompt: 'find it',
              ...(background === true ? { background: true } : {}),
            },
          },
        ],
      },
      {
        info: { id: `tool-${callID}`, role: 'tool', time: { created: 11 } },
        parts: [
          {
            type: 'tool-result',
            toolCallId: callID,
            toolName: 'subagent',
            output: { type: 'text', value },
          },
        ],
      },
    ]),
  };
}

function runningChildTranscript(startedAt = 12): { data: unknown[] } {
  return {
    data: [
      {
        info: { id: 'u', role: 'user', time: { created: startedAt } },
        parts: [{ type: 'text', text: 'go' }],
      },
    ],
  };
}

function completedChildTranscript(text: string): { data: unknown[] } {
  return {
    data: [
      {
        info: { id: 'u', role: 'user', time: { created: 12 } },
        parts: [{ type: 'text', text: 'go' }],
      },
      {
        info: {
          id: 'a',
          role: 'assistant',
          finish: 'stop',
          time: { created: 13, completed: 14 },
        },
        parts: [{ type: 'text', text }],
      },
      {
        info: {
          id: 'idle',
          sourceType: 'idle',
          outcome: 'succeeded',
          time: { created: 14 },
        },
        parts: [],
      },
    ],
  };
}

function client(options: {
  sessions: Array<Record<string, unknown>>;
  parent: unknown;
  children?: Record<string, unknown>;
  childOutcome?: 'succeeded' | 'failed' | 'interrupted';
}) {
  return {
    session: {
      list: mock(async () => ({ data: options.sessions })),
      get: mock(async ({ path }: { path: { id: string } }) => ({
        data:
          path.id === PARENT
            ? { id: PARENT, agent: 'orchestrator' }
            : {
                id: path.id,
                parentID: PARENT,
                agent: 'explorer',
                ...(options.childOutcome
                  ? { outcome: options.childOutcome }
                  : {}),
              },
      })),
      messages: mock(async ({ path }: { path: { id: string } }) =>
        path.id === PARENT
          ? options.parent
          : (options.children?.[path.id] ?? { data: [] }),
      ),
      status: mock(async () => ({ data: {} })),
    },
  };
}

function input(options: Parameters<typeof client>[0]) {
  return {
    client: client(options) as never,
    directory: '/tmp',
    worktree: '/tmp',
  };
}

function memoryStorage(): {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  remove(key: string): void;
  scan(options: { prefix: string }): {
    entries: Array<{ key: string; value: unknown }>;
  };
} {
  const values = new Map<string, unknown>();
  return {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
    scan: ({ prefix }) => ({
      entries: [...values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    }),
  };
}

function persistedChild(
  taskID: string,
  overrides: Partial<PersistedBackgroundChild> = {},
): PersistedBackgroundChild {
  return {
    taskID,
    parentSessionID: PARENT,
    agent: 'explorer',
    description: `delegated ${taskID}`,
    launchedAt: 6,
    background: true,
    ...overrides,
  };
}

async function seedPersistence(
  storage: ReturnType<typeof memoryStorage>,
  children: PersistedBackgroundChild[],
): Promise<void> {
  configureBackgroundJobPersistence(storage);
  for (const child of children) {
    recordPersistedBackgroundChild(child);
    if (child.deliveredAt !== undefined) {
      markPersistedBackgroundChildDelivered(child.taskID, child.deliveredAt);
    }
  }
  await tick();
  await tick();
  configureBackgroundJobPersistence(storage);
  await loadInitialBackgroundJobPersistence();
}

afterEach(() => {
  configureBackgroundJobPersistence(undefined);
});

describe('startup subagent recovery', () => {
  test.each([
    ['empty', false],
    ['running', true],
  ] as const)(
    'assistant completion after an older idle cannot settle a newer execution (%s board)',
    async (_state, onBoard) => {
      const storage = memoryStorage();
      await seedPersistence(storage, [
        persistedChild(RUNNING, { launchedAt: 15 }),
      ]);
      const board = new BackgroundJobBoard();
      if (onBoard) {
        board.registerLaunch({
          taskID: RUNNING,
          parentSessionID: PARENT,
          agent: 'explorer',
          background: true,
          adopted: true,
          now: 15,
        });
      }
      const concurrency = new BackgroundTaskConcurrency({
        defaultConcurrency: 1,
        providerConcurrency: {},
        modelConcurrency: {},
      });
      concurrency.restoreTask(RUNNING);
      const release = spyOn(concurrency, 'releaseTask');
      const wake = mock(() => true);
      const history = completedChildTranscript('old answer');
      (
        history.data[1] as { info: { time: { completed: number } } }
      ).info.time.completed = 16;

      await recoverSubagentSessionsAtStartup({
        input: input({
          sessions: [{ id: RUNNING, parentID: PARENT, outcome: 'succeeded' }],
          parent: parentTranscript([]),
          children: { [RUNNING]: history },
        }),
        backgroundJobBoard: board,
        backgroundTaskConcurrency: concurrency,
        hostFlavor: 'v2',
        shouldManageSession: () => true,
        onRecoveredTerminal: wake,
      });

      expect(board.get(RUNNING)).toMatchObject({
        state: 'running',
        runStartedAt: 15,
      });
      expect(release).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
      expect(
        persistedBackgroundChildren().get(RUNNING)?.deliveredAt,
      ).toBeUndefined();
      release.mockRestore();
      concurrency.dispose();
    },
  );

  test.each([
    ['unmarked', undefined],
    ['marked', 31],
  ] as const)(
    'a delayed prior-result delivery cannot acknowledge an explicitly incomplete run (%s)',
    async (_state, deliveredAt) => {
      const storage = memoryStorage();
      await seedPersistence(storage, [
        persistedChild(RUNNING, { launchedAt: 30, deliveredAt }),
      ]);
      const board = new BackgroundJobBoard();
      const wake = mock(() => true);
      const parent = parentTranscript([]);
      parent.data.push(deliveryMessage(RUNNING, 31));

      const recovered = await recoverSubagentSessionsAtStartup({
        input: input({
          sessions: [{ id: RUNNING, parentID: PARENT }],
          parent,
          children: { [RUNNING]: runningChildTranscript(30) },
        }),
        backgroundJobBoard: board,
        hostFlavor: 'v2',
        shouldManageSession: () => true,
        onRecoveredTerminal: wake,
      });

      expect(recovered).toEqual([RUNNING]);
      expect(board.get(RUNNING)).toMatchObject({
        state: 'running',
        runStartedAt: 30,
      });
      expect(
        persistedBackgroundChildren().get(RUNNING)?.deliveredAt,
      ).toBeUndefined();
      expect(wake).not.toHaveBeenCalled();
    },
  );

  test('a parent delivery preceding the latest terminal cannot acknowledge that round', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [persistedChild(DONE, { launchedAt: 30 })]);
    const board = new BackgroundJobBoard();
    const parent = parentTranscript([]);
    parent.data.push(deliveryMessage(DONE, 31));
    const wake = mock(() => false);
    const history = {
      data: [
        { info: { id: 'u', role: 'user', time: { created: 30 } }, parts: [] },
        {
          info: {
            id: 'a',
            role: 'assistant',
            time: { created: 32, completed: 34 },
          },
          parts: [{ type: 'text', text: 'new answer' }],
        },
        {
          info: {
            id: 'idle',
            sourceType: 'idle',
            time: { created: 35 },
            outcome: 'succeeded',
          },
          parts: [],
        },
      ],
    };

    await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [{ id: DONE, parentID: PARENT, outcome: 'succeeded' }],
        parent,
        children: { [DONE]: history },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => true,
      onRecoveredTerminal: wake,
    });

    expect(board.get(DONE)).toMatchObject({
      state: 'completed',
      resultSummary: 'new answer',
      completedAt: 35,
    });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(
      persistedBackgroundChildren().get(DONE)?.deliveredAt,
    ).toBeUndefined();
  });

  test.each(['session', 'child', 'parent'] as const)(
    'a stalled first %s read does not block the next persisted child',
    async (stage) => {
      const storage = memoryStorage();
      const otherParent = 'ses_other_parent';
      await seedPersistence(storage, [
        persistedChild(RUNNING),
        persistedChild(DONE, { parentSessionID: otherParent }),
      ]);
      const clock = createTimerHarness();
      const held = new Promise<never>(() => {});
      const get = mock(async ({ path }: { path: { id: string } }) =>
        path.id === RUNNING && stage === 'session'
          ? held
          : { data: { id: path.id, parentID: otherParent } },
      );
      const messages = mock(async ({ path }: { path: { id: string } }) => {
        if (
          (stage === 'child' && path.id === RUNNING) ||
          (stage === 'parent' && path.id === PARENT)
        )
          return held;
        if (path.id === RUNNING) return runningChildTranscript();
        if (path.id === DONE)
          return completedChildTranscript('next child answer');
        return parentTranscript([]);
      });
      const board = new BackgroundJobBoard();
      const wake = mock(() => true);
      const options = {
        input: {
          client: {
            session: {
              list: mock(async () => ({
                data: [
                  {
                    id: RUNNING,
                    parentID: PARENT,
                    ...(stage !== 'session' ? { outcome: 'succeeded' } : {}),
                  },
                  { id: DONE, parentID: otherParent, outcome: 'succeeded' },
                ],
              })),
              get,
              messages,
            },
          } as never,
          directory: '/tmp',
          worktree: '/tmp',
        },
        backgroundJobBoard: board,
        hostFlavor: 'v2',
        shouldManageSession: () => true,
        onRecoveredTerminal: wake,
        readTimeoutMs: 20,
        timers: {
          setTimeout: clock.setTimeout,
          clearTimeout: (timer: unknown) => clock.clearTimeout(timer as number),
        },
      };
      let recovered: string[] | undefined;
      void recoverSubagentSessionsAtStartup(options).then((result) => {
        recovered = result;
      });
      await clock.tick();
      await clock.advance(20);

      expect(recovered).toContain(DONE);
      expect(board.get(DONE)).toMatchObject({
        state: 'completed',
        resultSummary: 'next child answer',
      });
      expect(board.get(RUNNING)?.state).not.toBe('completed');
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledWith(otherParent, DONE);
      expect(clock.pending()).toBe(0);
      if (stage === 'session') {
        void recoverSubagentSessionsAtStartup(options);
        await clock.tick();
        await clock.advance(20);
        expect(get).toHaveBeenCalledTimes(1);
        expect(wake).toHaveBeenCalledTimes(1);
      }
    },
  );

  test('a stalled listing still allows persisted-only recovery', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [persistedChild(DONE)]);
    const clock = createTimerHarness();
    const scanInput = input({
      sessions: [],
      parent: parentTranscript([]),
      children: { [DONE]: completedChildTranscript('persisted answer') },
      childOutcome: 'succeeded',
    });
    (scanInput.client as ReturnType<typeof client>).session.list = mock(
      () => new Promise<never>(() => {}),
    );
    const board = new BackgroundJobBoard();
    const wake = mock(() => true);
    let recovered: string[] | undefined;
    void recoverSubagentSessionsAtStartup({
      input: scanInput,
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => true,
      onRecoveredTerminal: wake,
      readTimeoutMs: 20,
      timers: {
        setTimeout: clock.setTimeout,
        clearTimeout: (timer: unknown) => clock.clearTimeout(timer as number),
      },
    }).then((result) => {
      recovered = result;
    });
    await clock.tick();
    await clock.advance(20);

    expect(recovered).toEqual([DONE]);
    expect(board.get(DONE)).toMatchObject({
      state: 'completed',
      resultSummary: 'persisted answer',
    });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
  });

  test('adopts a running native background child without a parent transform', async () => {
    const board = new BackgroundJobBoard();
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: RUNNING, parentID: PARENT, agent: 'explorer' },
        ],
        parent: parentTranscript([
          {
            callID: 'call-running',
            sessionID: RUNNING,
            value: launchText(RUNNING),
          },
        ]),
        children: { [RUNNING]: runningChildTranscript() },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(result).toEqual([RUNNING]);
    expect(board.get(RUNNING)).toMatchObject({
      parentSessionID: PARENT,
      agent: 'explorer',
      background: true,
      state: 'running',
      externalOrigin: true,
      recoveredAtStartup: true,
    });
    expect(board.get(RUNNING)?.pluginLaunched).toBeUndefined();
  });

  test('is idempotent across repeated startup scans', async () => {
    const board = new BackgroundJobBoard();
    const options = {
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: RUNNING, parentID: PARENT, agent: 'explorer' },
        ],
        parent: parentTranscript([
          {
            callID: 'call-running',
            sessionID: RUNNING,
            value: launchText(RUNNING),
          },
        ]),
        children: { [RUNNING]: runningChildTranscript() },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    };
    await recoverSubagentSessionsAtStartup(options);
    const generation = board.get(RUNNING)?.generation;
    const repeated = await recoverSubagentSessionsAtStartup(options);

    expect(repeated).toEqual([]);
    expect(board.get(RUNNING)?.generation).toBe(generation);
  });

  test('restores a persisted migrated child as terminal on startup', async () => {
    const board = new BackgroundJobBoard();
    await seedPersistence(memoryStorage(), [persistedChild(DONE)]);
    const migrated = completedChildTranscript('migrated answer');
    migrated.data.pop();

    await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [{ id: DONE, parentID: PARENT, agent: 'explorer' }],
        parent: parentTranscript([]),
        children: { [DONE]: migrated },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(board.get(DONE)).toMatchObject({
      state: 'completed',
      resultSummary: 'migrated answer',
      verifiedRetainedRound: true,
    });
  });

  test('restores a child that completed during downtime and requests one wake', async () => {
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    await seedPersistence(memoryStorage(), [persistedChild(DONE)]);
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: DONE,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([
          {
            callID: 'call-done',
            sessionID: DONE,
            value: completedText(DONE),
            background: true,
          },
        ]),
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: (parentSessionID, taskID) => {
        wakes.push(`${parentSessionID}:${taskID}`);
        return true;
      },
    });

    expect(result).toEqual([DONE]);
    expect(board.get(DONE)).toMatchObject({
      parentSessionID: PARENT,
      state: 'completed',
      externalOrigin: true,
    });
    expect(wakes).toEqual([`${PARENT}:${DONE}`]);
  });

  test('does not replay a terminal child whose outcome was delivered', async () => {
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    await seedPersistence(memoryStorage(), [
      persistedChild(DONE, { deliveredAt: 20 }),
    ]);
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: DONE,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([]),
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: (parentSessionID, taskID) => {
        wakes.push(`${parentSessionID}:${taskID}`);
        return true;
      },
    });

    expect(result).toEqual([]);
    expect(board.get(DONE)).toBeUndefined();
    expect(wakes).toEqual([]);
  });

  test('treats a trusted delivery in parent history as already delivered', async () => {
    const storage = memoryStorage();
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    await seedPersistence(storage, [persistedChild(DONE)]);
    const parent = parentTranscript([
      {
        callID: 'call-done',
        sessionID: DONE,
        value: launchText(DONE),
      },
    ]);
    parent.data.push(deliveryMessage(DONE, 20));

    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: DONE, parentID: PARENT, agent: 'explorer' },
        ],
        parent,
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      onRecoveredTerminal: (_parent, taskID) => {
        wakes.push(taskID);
        return true;
      },
    });

    expect(result).toEqual([]);
    expect(wakes).toEqual([]);
    expect(board.get(DONE)).toBeUndefined();
    expect(persistedBackgroundChildren().get(DONE)?.deliveredAt).toBe(20);
  });

  test('does not adopt a history-delivered child without persistence', async () => {
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    const parent = parentTranscript([
      {
        callID: 'call-done',
        sessionID: DONE,
        value: launchText(DONE),
      },
    ]);
    parent.data.push(deliveryMessage(DONE, 20));

    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: DONE, parentID: PARENT, agent: 'explorer' },
        ],
        parent,
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      onRecoveredTerminal: (_parent, taskID) => {
        wakes.push(taskID);
        return true;
      },
    });

    expect(result).toEqual([]);
    expect(wakes).toEqual([]);
    expect(board.get(DONE)).toBeUndefined();
  });

  test('does not acknowledge a different launch fence', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [persistedChild(DONE, { launchedAt: 6 })]);

    expect(markPersistedBackgroundChildDelivered(DONE, 30, 7)).toBe(false);
    expect(persistedBackgroundChildren().get(DONE)?.deliveredAt).toBe(
      undefined,
    );
  });

  test('an old or forged delivery does not suppress the current run', async () => {
    const storage = memoryStorage();
    const board = new BackgroundJobBoard();
    await seedPersistence(storage, [
      persistedChild(RUNNING, { launchedAt: 100 }),
    ]);
    const parent = parentTranscript([
      {
        callID: 'call-running',
        sessionID: RUNNING,
        value: launchText(RUNNING),
      },
    ]);
    parent.data.push(deliveryMessage(RUNNING, 20, 'completed', false));

    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: RUNNING, parentID: PARENT, agent: 'explorer' },
        ],
        parent,
        children: { [RUNNING]: runningChildTranscript() },
      }),
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      onRecoveredTerminal: () => true,
    });

    expect(result).toEqual([RUNNING]);
    expect(board.get(RUNNING)?.state).toBe('running');
    expect(persistedBackgroundChildren().get(RUNNING)?.deliveredAt).toBe(
      undefined,
    );
  });

  test('reads host outcome for a listed child that omits it', async () => {
    const storage = memoryStorage();
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    await seedPersistence(storage, [persistedChild(DONE)]);
    const parent = parentTranscript([
      {
        callID: 'call-done',
        sessionID: DONE,
        value: launchText(DONE),
        background: true,
      },
    ]);

    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: DONE, parentID: PARENT, agent: 'explorer' },
        ],
        parent,
        children: { [DONE]: { data: [] } },
        childOutcome: 'succeeded',
      }),
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      onRecoveredTerminal: (_parent, taskID) => {
        wakes.push(taskID);
        return true;
      },
    });

    expect(result).toEqual([DONE]);
    expect(board.get(DONE)?.state).toBe('completed');
    expect(wakes).toEqual([DONE]);
  });

  test.each(['succeeded', 'failed', 'interrupted'] as const)(
    'an unfinished latest round is not settled by an older %s host outcome',
    async (outcome) => {
      const storage = memoryStorage();
      await seedPersistence(storage, [persistedChild(RUNNING)]);
      const board = new BackgroundJobBoard();
      const wake = mock(() => true);

      await recoverSubagentSessionsAtStartup({
        input: input({
          sessions: [{ id: RUNNING, parentID: PARENT, outcome }],
          parent: parentTranscript([]),
          children: { [RUNNING]: runningChildTranscript(21) },
        }),
        backgroundJobBoard: board,
        hostFlavor: 'v2',
        shouldManageSession: () => true,
        onRecoveredTerminal: wake,
      });

      expect(board.get(RUNNING)?.state).toBe('running');
      expect(wake).not.toHaveBeenCalled();
      expect(
        persistedBackgroundChildren().get(RUNNING)?.deliveredAt,
      ).toBeUndefined();
    },
  );

  test('a textless succeeded round remains pending at startup', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [persistedChild(DONE)]);
    const board = new BackgroundJobBoard();
    const wake = mock(() => true);

    await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [{ id: DONE, parentID: PARENT, outcome: 'succeeded' }],
        parent: parentTranscript([]),
        children: { [DONE]: completedChildTranscript('') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => true,
      onRecoveredTerminal: wake,
    });

    expect(board.get(DONE)?.state).toBe('running');
    expect(wake).not.toHaveBeenCalled();
  });

  test('an outcome without a transcript boundary cannot settle a persisted v2 run', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [persistedChild(DONE)]);
    const board = new BackgroundJobBoard();
    const wake = mock(() => true);

    const recovered = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [{ id: DONE, parentID: PARENT, outcome: 'succeeded' }],
        parent: parentTranscript([]),
        children: { [DONE]: { data: [] } },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => true,
      onRecoveredTerminal: wake,
    });

    expect(recovered).toEqual([]);
    expect(board.get(DONE)).toBeUndefined();
    expect(wake).not.toHaveBeenCalled();
    expect(
      persistedBackgroundChildren().get(DONE)?.deliveredAt,
    ).toBeUndefined();
  });

  test.each([
    ['empty', false],
    ['running', true],
  ] as const)(
    'old terminal history cannot settle a newer persisted run (%s board)',
    async (_state, onBoard) => {
      const storage = memoryStorage();
      await seedPersistence(storage, [
        persistedChild(RUNNING, { launchedAt: 30 }),
      ]);
      const board = new BackgroundJobBoard();
      if (onBoard) {
        board.registerLaunch({
          taskID: RUNNING,
          parentSessionID: PARENT,
          agent: 'explorer',
          description: 'new run',
          background: true,
          now: 30,
        });
      }
      const concurrency = new BackgroundTaskConcurrency({
        defaultConcurrency: 1,
        providerConcurrency: {},
        modelConcurrency: {},
      });
      concurrency.restoreTask(RUNNING);
      const release = spyOn(concurrency, 'releaseTask');
      const wake = mock(() => true);

      const recovered = await recoverSubagentSessionsAtStartup({
        input: input({
          sessions: [{ id: RUNNING, parentID: PARENT, outcome: 'succeeded' }],
          parent: parentTranscript([]),
          children: { [RUNNING]: completedChildTranscript('old result') },
        }),
        backgroundJobBoard: board,
        backgroundTaskConcurrency: concurrency,
        hostFlavor: 'v2',
        shouldManageSession: () => true,
        onRecoveredTerminal: wake,
      });

      expect(recovered).toEqual([]);
      expect(board.get(RUNNING)?.state).toBe(onBoard ? 'running' : undefined);
      expect(release).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
      expect(
        persistedBackgroundChildren().get(RUNNING)?.deliveredAt,
      ).toBeUndefined();
      release.mockRestore();
      concurrency.dispose();
    },
  );

  test('corrects a running startup row once the child is terminal', async () => {
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    const storage = memoryStorage();
    await seedPersistence(storage, [persistedChild(RUNNING)]);
    board.registerLaunch({
      taskID: RUNNING,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'delegated',
      background: true,
      adopted: true,
      now: 0,
    });
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: RUNNING,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([]),
        children: { [RUNNING]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: (parentSessionID, taskID) => {
        wakes.push(`${parentSessionID}:${taskID}`);
        return true;
      },
    });

    expect(result).toEqual([RUNNING]);
    expect(board.get(RUNNING)).toMatchObject({
      state: 'completed',
      resultSummary: 'Done',
    });
    expect(wakes).toEqual([`${PARENT}:${RUNNING}`]);
    await tick();
    await tick();
    configureBackgroundJobPersistence(storage);
    await loadInitialBackgroundJobPersistence();
    const restarted = new BackgroundJobBoard();
    const rerun = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: RUNNING,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([]),
        children: { [RUNNING]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: restarted,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: (parentSessionID, taskID) => {
        wakes.push(`${parentSessionID}:${taskID}`);
        return true;
      },
    });
    expect(rerun).toEqual([]);
    expect(restarted.get(RUNNING)).toBeUndefined();
    expect(wakes).toEqual([`${PARENT}:${RUNNING}`]);
  });

  test('host restart re-delivery plus startup recovery notify the parent exactly once (v2)', async () => {
    // The v2 host re-delivers a background subagent's terminal outcome on its
    // own restart (core/session/execution/restart.ts recoverSubagent ->
    // SubagentCompletion.deliver with resume:false), which lands in the
    // parent's history as a trusted <subagent> delivery. omos's startup
    // recovery must publish beside it exactly zero times: the host's
    // re-delivery is the single notification for that run.
    const storage = memoryStorage();
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    const publications: string[] = [];
    board.addTerminalOutcomeListener((record) => {
      publications.push(`${record.taskID}:${record.terminalRevision}`);
    });
    await seedPersistence(storage, [persistedChild(DONE)]);
    board.registerLaunch({
      taskID: DONE,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'delegated',
      background: true,
      adopted: true,
      now: 0,
    });
    const parent = parentTranscript([
      {
        callID: 'call-done',
        sessionID: DONE,
        value: launchText(DONE),
        background: true,
      },
    ]);
    // The host's restart re-delivery, timestamped after the child's terminal
    // boundary so it covers this run.
    parent.data.push(deliveryMessage(DONE, 20));

    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: DONE,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent,
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: (parentSessionID, taskID) => {
        wakes.push(`${parentSessionID}:${taskID}`);
        return true;
      },
    });

    expect(result).toEqual([]);
    expect(wakes).toEqual([]);
    // The running startup row is corrected to terminal without a publication:
    // correctStartupRecoveredTerminal deliberately fires no terminal listener
    // so a restart cannot double-wake the parent.
    expect(board.get(DONE)).toMatchObject({
      state: 'completed',
      resultSummary: 'Done',
      recoveredAtStartup: true,
      verifiedRetainedRound: true,
    });
    expect(publications).toEqual([]);
    // The host's re-delivery is recorded as the run's single delivery.
    expect(persistedBackgroundChildren().get(DONE)?.deliveredAt).toBe(20);

    // A later plugin reconcile of the corrected run stays a retained round:
    // it neither re-reads evidence nor publishes a second terminal.
    const gate = createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      readTerminalEvidence: async () => completedChildTranscript('Done'),
      baselineFor: () => undefined,
      now: () => 100,
    });
    const corrected = board.get(DONE);
    if (!corrected) throw new Error('missing corrected row');
    const reconcile = await gate.reconcile({
      taskID: DONE,
      generation: corrected.generation,
    });
    gate.dispose();
    expect(reconcile).toEqual({ kind: 'committed', record: corrected });
    expect(publications).toEqual([]);
    expect(board.get(DONE)?.terminalRevision).toBe(corrected.terminalRevision);
  });

  test('keeps an undelivered identity when a terminal wake is declined', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [persistedChild(DONE)]);
    const scanInput = () =>
      input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: DONE,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([]),
        children: { [DONE]: completedChildTranscript('Done') },
      });
    const firstBoard = new BackgroundJobBoard();
    await recoverSubagentSessionsAtStartup({
      input: scanInput(),
      backgroundJobBoard: firstBoard,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: () => false,
    });

    expect(firstBoard.get(DONE)?.state).toBe('completed');
    expect(
      persistedBackgroundChildren().get(DONE)?.deliveredAt,
    ).toBeUndefined();

    await tick();
    await tick();
    configureBackgroundJobPersistence(storage);
    await loadInitialBackgroundJobPersistence();
    const restarted = new BackgroundJobBoard();
    let retried = 0;
    const result = await recoverSubagentSessionsAtStartup({
      input: scanInput(),
      backgroundJobBoard: restarted,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: () => {
        retried += 1;
        return true;
      },
    });

    expect(result).toEqual([DONE]);
    expect(retried).toBe(1);
    expect(persistedBackgroundChildren().get(DONE)?.deliveredAt).toBeDefined();
  });

  test('keeps an undelivered identity when the terminal wake rejects', async () => {
    await seedPersistence(memoryStorage(), [persistedChild(DONE)]);
    const board = new BackgroundJobBoard();
    await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: DONE,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([]),
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: async () => {
        throw new Error('transport failed');
      },
    });

    expect(board.get(DONE)?.state).toBe('completed');
    expect(
      persistedBackgroundChildren().get(DONE)?.deliveredAt,
    ).toBeUndefined();
  });

  test('keeps an undelivered identity when no wake callback is configured', async () => {
    await seedPersistence(memoryStorage(), [persistedChild(DONE)]);
    const board = new BackgroundJobBoard();
    await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: DONE,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([]),
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(board.get(DONE)?.state).toBe('completed');
    expect(
      persistedBackgroundChildren().get(DONE)?.deliveredAt,
    ).toBeUndefined();
  });

  test('marks delivery only after the accepted wake resolves', async () => {
    await seedPersistence(memoryStorage(), [persistedChild(DONE)]);
    let observedDuringWake: number | undefined;
    const board = new BackgroundJobBoard();
    await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: DONE,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
        ],
        parent: parentTranscript([]),
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: async () => {
        observedDuringWake =
          persistedBackgroundChildren().get(DONE)?.deliveredAt;
        return true;
      },
    });

    expect(observedDuringWake).toBeUndefined();
    expect(persistedBackgroundChildren().get(DONE)?.deliveredAt).toBeDefined();
  });

  test('clears the delivered marker on a new running generation', async () => {
    await seedPersistence(memoryStorage(), [
      persistedChild(DONE, { deliveredAt: 7 }),
    ]);
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: DONE,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'relaunched',
      background: true,
      now: 9,
    });

    expect(
      persistedBackgroundChildren().get(DONE)?.deliveredAt,
    ).toBeUndefined();
  });

  test('preserves a delivered marker when a running row is observed again', async () => {
    await seedPersistence(memoryStorage(), [persistedChild(RUNNING)]);
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: RUNNING,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'still running',
      background: true,
      now: 9,
    });
    markPersistedBackgroundChildDelivered(RUNNING, 12);
    board.registerLaunch({
      taskID: RUNNING,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'still running',
      background: true,
      preserveRun: true,
      adopted: true,
      now: 10,
    });

    expect(persistedBackgroundChildren().get(RUNNING)?.deliveredAt).toBe(12);
  });

  test('rechecks the board after asynchronous classification', async () => {
    const board = new BackgroundJobBoard();
    let registered = false;
    const raceClient = {
      session: {
        list: async () => ({
          data: [
            { id: PARENT, agent: 'orchestrator' },
            { id: RUNNING, parentID: PARENT, agent: 'explorer' },
          ],
        }),
        get: async ({ path }: { path: { id: string } }) => ({
          data:
            path.id === PARENT
              ? { id: PARENT, agent: 'orchestrator' }
              : { id: path.id, parentID: PARENT, agent: 'explorer' },
        }),
        messages: async ({ path }: { path: { id: string } }) => {
          if (path.id === PARENT) {
            return parentTranscript([
              {
                callID: 'call-race',
                sessionID: RUNNING,
                value: launchText(RUNNING),
              },
            ]);
          }
          if (!registered) {
            registered = true;
            board.registerLaunch({
              taskID: RUNNING,
              parentSessionID: PARENT,
              agent: 'explorer',
              description: 'transform won the race',
              background: true,
              adopted: true,
              now: 1,
            });
          }
          return runningChildTranscript();
        },
      },
    };

    const result = await recoverSubagentSessionsAtStartup({
      input: {
        client: raceClient as never,
        directory: '/tmp',
        worktree: '/tmp',
      },
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(result).toEqual([]);
    expect(board.get(RUNNING)).toMatchObject({
      state: 'running',
      recoveredAtStartup: true,
    });
  });

  test('does not correct a relaunch registered while startup reads are pending', async () => {
    await seedPersistence(memoryStorage(), [
      persistedChild(RUNNING, { launchedAt: 6 }),
    ]);
    const concurrency = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const release = spyOn(concurrency, 'releaseTask');
    const board = new BackgroundJobBoard();
    const original = board.registerLaunch({
      taskID: RUNNING,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'original run',
      background: true,
      adopted: true,
      now: 6,
    });
    const wakes: string[] = [];
    let relaunched = false;
    const raceClient = {
      session: {
        list: async () => ({
          data: [
            { id: PARENT, agent: 'orchestrator' },
            { id: RUNNING, parentID: PARENT, agent: 'explorer' },
          ],
        }),
        get: async ({ path }: { path: { id: string } }) => ({
          data:
            path.id === PARENT
              ? { id: PARENT, agent: 'orchestrator' }
              : {
                  id: path.id,
                  parentID: PARENT,
                  agent: 'explorer',
                  outcome: 'succeeded',
                },
        }),
        messages: async ({ path }: { path: { id: string } }) => {
          if (path.id === PARENT) return { data: [] };
          if (!relaunched) {
            relaunched = true;
            board.registerLaunch({
              taskID: RUNNING,
              parentSessionID: PARENT,
              agent: 'explorer',
              description: 'relaunched while reading',
              background: true,
              now: 30,
            });
          }
          return completedChildTranscript('Done');
        },
      },
    };

    const result = await recoverSubagentSessionsAtStartup({
      input: {
        client: raceClient as never,
        directory: '/tmp',
        worktree: '/tmp',
      },
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      backgroundTaskConcurrency: concurrency,
      onRecoveredTerminal: (parentSessionID, taskID) => {
        wakes.push(`${parentSessionID}:${taskID}`);
        return true;
      },
    });

    expect(result).toEqual([]);
    expect(board.get(RUNNING)).toMatchObject({
      state: 'running',
      description: 'relaunched while reading',
      runStartedAt: 30,
    });
    expect(board.get(RUNNING)?.generation).toBeGreaterThan(original.generation);
    expect(board.get(RUNNING)?.recoveredAtStartup).toBeUndefined();
    expect(release).not.toHaveBeenCalled();
    expect(wakes).toEqual([]);
    expect(
      persistedBackgroundChildren().get(RUNNING)?.deliveredAt,
    ).toBeUndefined();
    concurrency.dispose();
  });

  test('does not correct a same-generation reopen registered while startup reads are pending', async () => {
    await seedPersistence(memoryStorage(), [
      persistedChild(RUNNING, { launchedAt: 6 }),
    ]);
    const concurrency = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const release = spyOn(concurrency, 'releaseTask');
    const board = new BackgroundJobBoard();
    const restored = board.restoreRetainedSession({
      taskID: RUNNING,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'finished before restart',
      state: 'completed',
      resultSummary: 'Old result',
      background: true,
      launchedAt: 6,
    });
    expect(restored?.generation).toBeDefined();
    const wakes: string[] = [];
    let reopened = false;
    const raceClient = {
      session: {
        list: async () => ({
          data: [
            { id: PARENT, agent: 'orchestrator' },
            { id: RUNNING, parentID: PARENT, agent: 'explorer' },
          ],
        }),
        get: async ({ path }: { path: { id: string } }) => ({
          data:
            path.id === PARENT
              ? { id: PARENT, agent: 'orchestrator' }
              : {
                  id: path.id,
                  parentID: PARENT,
                  agent: 'explorer',
                  outcome: 'succeeded',
                },
        }),
        messages: async ({ path }: { path: { id: string } }) => {
          if (path.id === PARENT) return { data: [] };
          if (!reopened) {
            reopened = true;
            board.markRunningFromLiveSession(RUNNING, 30);
          }
          return completedChildTranscript('Done');
        },
      },
    };

    const result = await recoverSubagentSessionsAtStartup({
      input: {
        client: raceClient as never,
        directory: '/tmp',
        worktree: '/tmp',
      },
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      backgroundTaskConcurrency: concurrency,
      onRecoveredTerminal: (parentSessionID, taskID) => {
        wakes.push(`${parentSessionID}:${taskID}`);
        return true;
      },
    });

    expect(result).toEqual([]);
    expect(board.get(RUNNING)).toMatchObject({
      state: 'running',
      runStartedAt: 30,
    });
    expect(board.get(RUNNING)?.generation).toBe(restored?.generation);
    expect(release).not.toHaveBeenCalled();
    expect(wakes).toEqual([]);
    expect(
      persistedBackgroundChildren().get(RUNNING)?.deliveredAt,
    ).toBeUndefined();
    concurrency.dispose();
  });

  test('corrects a same-run adoption registered while startup reads are pending', async () => {
    await seedPersistence(memoryStorage(), [
      persistedChild(RUNNING, { launchedAt: 6 }),
    ]);
    const concurrency = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const release = spyOn(concurrency, 'releaseTask');
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    let adopted = false;
    const raceClient = {
      session: {
        list: async () => ({
          data: [
            { id: PARENT, agent: 'orchestrator' },
            { id: RUNNING, parentID: PARENT, agent: 'explorer' },
          ],
        }),
        get: async ({ path }: { path: { id: string } }) => ({
          data:
            path.id === PARENT
              ? { id: PARENT, agent: 'orchestrator' }
              : {
                  id: path.id,
                  parentID: PARENT,
                  agent: 'explorer',
                  outcome: 'succeeded',
                },
        }),
        messages: async ({ path }: { path: { id: string } }) => {
          if (path.id === PARENT) return { data: [] };
          if (!adopted) {
            adopted = true;
            board.registerLaunch({
              taskID: RUNNING,
              parentSessionID: PARENT,
              agent: 'explorer',
              description: 'adopted while reading',
              background: true,
              adopted: true,
              now: 6,
            });
          }
          return completedChildTranscript('Done');
        },
      },
    };

    const result = await recoverSubagentSessionsAtStartup({
      input: {
        client: raceClient as never,
        directory: '/tmp',
        worktree: '/tmp',
      },
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      backgroundTaskConcurrency: concurrency,
      onRecoveredTerminal: (parentSessionID, taskID) => {
        wakes.push(`${parentSessionID}:${taskID}`);
        return true;
      },
    });

    expect(result).toEqual([RUNNING]);
    expect(board.get(RUNNING)).toMatchObject({
      state: 'completed',
      resultSummary: 'Done',
    });
    expect(release).toHaveBeenCalledWith(RUNNING);
    expect(wakes).toEqual([`${PARENT}:${RUNNING}`]);
    expect(
      persistedBackgroundChildren().get(RUNNING)?.deliveredAt,
    ).toBeDefined();
    concurrency.dispose();
  });

  test('adopts a delivered terminal child after it resumes as a live run', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [
      persistedChild(RUNNING, { deliveredAt: 7 }),
    ]);
    const board = new BackgroundJobBoard();
    board.restoreRetainedSession({
      taskID: RUNNING,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'delegated ses_running',
      state: 'completed',
      resultSummary: 'Done',
      background: true,
      launchedAt: 6,
    });
    board.markRunningFromLiveSession(RUNNING, 20);
    await tick();
    await tick();
    configureBackgroundJobPersistence(storage);
    await loadInitialBackgroundJobPersistence();

    const ctx = {
      location: {
        directory: '/tmp',
        project: {
          id: 'project',
          directory: '/tmp',
          canonical: '/tmp',
        },
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID,
          parentID: PARENT,
          agent: 'explorer',
        }),
        context: async () => [
          {
            type: 'user',
            id: 'user-1',
            time: { created: 21 },
            content: [{ type: 'text', text: 'continue' }],
          },
        ],
      },
    };
    const pluginInput = buildPluginInput(ctx as never) as never;
    const freshBoard = new BackgroundJobBoard();
    const result = await recoverSubagentSessionsAtStartup({
      input: pluginInput,
      backgroundJobBoard: freshBoard,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(result).toEqual([RUNNING]);
    expect(freshBoard.get(RUNNING)).toMatchObject({
      state: 'running',
      recoveredAtStartup: true,
    });
  });

  test('does not let a prior delivery marker hide a new downtime round', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [
      persistedChild(RUNNING, { launchedAt: 6, deliveredAt: 7 }),
    ]);
    const board = new BackgroundJobBoard();
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: RUNNING, parentID: PARENT, agent: 'explorer' },
        ],
        parent: { data: [] },
        children: { [RUNNING]: runningChildTranscript(21) },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(result).toEqual([RUNNING]);
    expect(board.get(RUNNING)).toMatchObject({
      state: 'running',
      recoveredAtStartup: true,
      launchedAt: 21,
    });
    expect(persistedBackgroundChildren().get(RUNNING)?.launchedAt).toBe(21);
    expect(
      persistedBackgroundChildren().get(RUNNING)?.deliveredAt,
    ).toBeUndefined();
  });

  test('does not adopt a v1 completed child with no persisted identity', async () => {
    const board = new BackgroundJobBoard();
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: DONE, parentID: PARENT, agent: 'explorer' },
        ],
        parent: {
          data: [
            {
              info: {
                id: 'assistant-v1',
                role: 'assistant',
                agent: 'orchestrator',
                time: { created: 10 },
              },
              parts: [
                {
                  type: 'tool',
                  tool: 'task',
                  state: {
                    input: {
                      subagent_type: 'explorer',
                      description: 'delegated',
                      prompt: 'find it',
                      background: true,
                    },
                    output: completedText(DONE),
                  },
                },
              ],
            },
          ],
        },
        children: { [DONE]: completedChildTranscript('Done') },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v1',
      shouldManageSession: () => false,
    });

    expect(result).toEqual([]);
    expect(board.get(DONE)).toBeUndefined();
  });

  test('recovers from persisted identity on a real v2 context without list', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [persistedChild(RUNNING)]);
    const ctx = {
      location: {
        directory: '/tmp',
        project: {
          id: 'project',
          directory: '/tmp',
          canonical: '/tmp',
        },
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID,
          parentID: PARENT,
          agent: 'explorer',
        }),
        context: async ({ sessionID }: { sessionID: string }) =>
          sessionID === RUNNING
            ? [
                {
                  type: 'user',
                  id: 'user-1',
                  time: { created: 12 },
                  content: [{ type: 'text', text: 'go' }],
                },
              ]
            : [],
      },
    };
    const pluginInput = buildPluginInput(ctx as never) as never;
    const board = new BackgroundJobBoard();
    const result = await recoverSubagentSessionsAtStartup({
      input: pluginInput,
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(
      typeof (
        pluginInput as {
          client: { session: { list?: unknown } };
        }
      ).client.session.list,
    ).toBe('function');
    expect(result).toEqual([RUNNING]);
    expect(board.get(RUNNING)).toMatchObject({
      parentSessionID: PARENT,
      state: 'running',
      recoveredAtStartup: true,
    });
  });

  test('a persisted child without list stays pending without its terminal answer', async () => {
    const storage = memoryStorage();
    await seedPersistence(storage, [persistedChild(DONE)]);
    const ctx = {
      location: {
        directory: '/tmp',
        project: {
          id: 'project',
          directory: '/tmp',
          canonical: '/tmp',
        },
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID,
          parentID: PARENT,
          agent: 'explorer',
          outcome: 'succeeded',
        }),
        context: async () => [
          {
            type: 'user',
            id: 'user-1',
            time: { created: 12 },
            content: [{ type: 'text', text: 'go' }],
          },
        ],
      },
    };
    const pluginInput = buildPluginInput(ctx as never) as never;
    const board = new BackgroundJobBoard();
    const wakes: string[] = [];
    const result = await recoverSubagentSessionsAtStartup({
      input: pluginInput,
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      onRecoveredTerminal: (_parentSessionID, taskID) => {
        wakes.push(taskID);
        return true;
      },
    });

    expect(result).toEqual([DONE]);
    expect(board.get(DONE)).toMatchObject({
      state: 'running',
    });
    expect(wakes).toEqual([]);
  });

  test('does not expose live children without a storage backend', async () => {
    configureBackgroundJobPersistence(undefined);
    const stale = new BackgroundJobBoard();
    stale.registerLaunch({
      taskID: RUNNING,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'stale launch',
      objective: 'stale launch',
      background: true,
      now: 1,
    });

    expect(persistedBackgroundChildren().size).toBe(0);
    const board = new BackgroundJobBoard();
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [],
        parent: { data: [] },
        children: { [RUNNING]: runningChildTranscript() },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(result).toEqual([]);
    expect(board.get(RUNNING)).toBeUndefined();
  });

  test('excludes foreground, tombstoned, and unrelated children', async () => {
    const board = new BackgroundJobBoard();
    recordBackgroundJobSuppression(board, DONE);
    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: RUNNING, parentID: PARENT, agent: 'explorer' },
          { id: DONE, parentID: PARENT, agent: 'explorer' },
          {
            id: FOREGROUND,
            parentID: PARENT,
            agent: 'explorer',
            outcome: 'succeeded',
          },
          { id: 'ses_orphan' },
        ],
        parent: parentTranscript([
          {
            callID: 'call-running',
            sessionID: RUNNING,
            value: launchText(RUNNING),
          },
          { callID: 'call-done', sessionID: DONE, value: launchText(DONE) },
          {
            callID: 'call-foreground',
            sessionID: FOREGROUND,
            value: completedText(FOREGROUND),
          },
        ]),
        children: {
          [RUNNING]: runningChildTranscript(),
          [DONE]: completedChildTranscript('Done'),
        },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
    });

    expect(result).toEqual([RUNNING]);
    expect(board.get(DONE)).toBeUndefined();
    expect(board.get(FOREGROUND)).toBeUndefined();
    expect(board.get('ses_orphan')).toBeUndefined();
  });

  test('releases the restored admission slot when an adoption race is corrected', async () => {
    await seedPersistence(memoryStorage(), [persistedChild(RUNNING)]);
    const concurrency = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const release = spyOn(concurrency, 'releaseTask');
    const board = new BackgroundJobBoard();
    const scan = (child: unknown, outcome?: 'succeeded') =>
      input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          {
            id: RUNNING,
            parentID: PARENT,
            agent: 'explorer',
            ...(outcome ? { outcome } : {}),
          },
        ],
        parent: { data: [] },
        children: { [RUNNING]: child },
        ...(outcome ? { childOutcome: outcome } : {}),
      });
    const options = {
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      backgroundTaskConcurrency: concurrency,
      onRecoveredTerminal: () => true,
    };

    // First scan adopts the running child and restores its slot.
    expect(
      await recoverSubagentSessionsAtStartup({
        ...options,
        input: scan(runningChildTranscript()),
      }),
    ).toEqual([RUNNING]);
    expect(concurrency.snapshot()).toEqual({ active: 1, queued: 0 });
    expect(release).not.toHaveBeenCalled();

    // Adoption race: the row came from a running snapshot, but the child
    // finished before this correction read it.
    const corrected = await recoverSubagentSessionsAtStartup({
      ...options,
      input: scan(completedChildTranscript('Done'), 'succeeded'),
    });

    expect(corrected).toEqual([RUNNING]);
    expect(board.get(RUNNING)).toMatchObject({ state: 'completed' });
    expect(release).toHaveBeenCalledWith(RUNNING);
    expect(concurrency.snapshot()).toEqual({ active: 0, queued: 0 });

    // The freed slot admits the next background launch.
    const next = concurrency.acquire({ model: 'anthropic/claude' });
    await next.ready;
    next.bind('ses_next');
    expect(concurrency.snapshot()).toEqual({ active: 1, queued: 0 });
    concurrency.dispose();
  });

  test('does not release the admission slot while the adopted child still runs', async () => {
    await seedPersistence(memoryStorage(), [persistedChild(RUNNING)]);
    const concurrency = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const release = spyOn(concurrency, 'releaseTask');
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: RUNNING,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'adopted by the parent transform',
      background: true,
      adopted: true,
      now: 6,
    });
    concurrency.restoreTask(RUNNING);

    const result = await recoverSubagentSessionsAtStartup({
      input: input({
        sessions: [
          { id: PARENT, agent: 'orchestrator' },
          { id: RUNNING, parentID: PARENT, agent: 'explorer' },
        ],
        parent: { data: [] },
        children: { [RUNNING]: runningChildTranscript() },
      }),
      backgroundJobBoard: board,
      hostFlavor: 'v2',
      shouldManageSession: () => false,
      backgroundTaskConcurrency: concurrency,
    });

    expect(result).toEqual([]);
    expect(release).not.toHaveBeenCalled();
    expect(concurrency.snapshot()).toEqual({ active: 1, queued: 0 });
    concurrency.dispose();
  });
});
