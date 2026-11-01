import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import * as loggerModule from '../../utils/logger';
import { mapV2EventToV1 } from '../../v2/event-adapter';
import { createTaskSessionManagerHook } from '../task-session-manager';
import {
  formatChildInputWaitDetail,
  getChildInputWait,
  noteChildInputWait,
  resetChildInputWaitForTests,
} from '../task-session-manager/child-input-wait';
import { resetUserWaitGateForTests } from '../task-session-manager/user-wait-gate';
import {
  CHILD_INPUT_OVERFLOW_TEXT,
  CHILD_INPUT_QUEUE_CAP,
  CHILD_INPUT_WAKE_CHUNK,
  CHILD_INPUT_WAKE_SETTLE_MS,
  createOrchestratorWakeScheduler,
  formatChildInputWaitDelta,
} from './index';
import { resetOrchestratorWakeGateForTests } from './wake-gate';

type SessionClient = {
  get?: ReturnType<typeof mock>;
  todo?: ReturnType<typeof mock>;
  children?: ReturnType<typeof mock>;
  status?: ReturnType<typeof mock>;
  list?: ReturnType<typeof mock>;
  promptAsync?: ReturnType<typeof mock>;
};

function makeCtx(session: SessionClient, directory = '/test') {
  return {
    directory,
    client: { session },
    hostFlavor: 'v1',
  } as never;
}

function v1Session(promptAsync?: ReturnType<typeof mock>): SessionClient {
  return {
    get: mock(async () => ({ data: {} })),
    todo: mock(async () => ({ data: [] })),
    children: mock(async () => ({ data: [] })),
    status: mock(async () => ({ data: {} })),
    promptAsync:
      promptAsync ?? mock(async () => ({ data: { info: { id: 'm' } } })),
  };
}

function makeScheduler(
  session: SessionClient,
  options?: {
    shouldManageSession?: (id: string) => boolean;
    isChildInputWaitCurrent?: (taskID: string, requestID: string) => boolean;
    mode?: 'todo' | 'children';
    childInputWakeKinds?: { permission: boolean; question: boolean };
    hasPendingDelegatedWork?: (id: string) => boolean;
    resolveSelection?: (id: string) => Promise<never>;
  },
) {
  return createOrchestratorWakeScheduler(makeCtx(session), {
    config: {
      enabled: true,
      intervalMs: 60_000,
      mode: options?.mode ?? 'todo',
    },
    shouldManageSession: options?.shouldManageSession ?? (() => true),
    hasInputWait: () => false,
    hasPendingDelegatedWork: options?.hasPendingDelegatedWork ?? (() => true),
    isChildInputWaitCurrent: options?.isChildInputWaitCurrent ?? (() => true),
    childInputWakeKinds: options?.childInputWakeKinds,
    resolveSelection: options?.resolveSelection,
  });
}

async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function flush(): Promise<void> {
  jest.advanceTimersByTime(CHILD_INPUT_WAKE_SETTLE_MS);
  await flushMicrotasks();
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

const delta = (taskID = 'ses_child1', requestID = 'que_1') =>
  formatChildInputWaitDelta({
    alias: 'fix-1',
    taskID,
    kind: 'question',
    requestID,
    detail: 'question: Which env?',
  });

describe('child input-wait wake', () => {
  test('triggerChildInputWaitWake delivers a queued promptAsync wake with the ask inline', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const session = v1Session(promptAsync);
    const scheduler = makeScheduler(session);

    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta(),
      'ses_child1:que_1',
    );
    await flushMicrotasks();
    expect(promptAsync).not.toHaveBeenCalled();
    await flush();

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = promptAsync.mock.calls[0]?.[0] as {
      body: { parts: Array<{ text: string }> };
    };
    const text = call.body.parts[0]?.text ?? '';
    expect(text).toContain('ses_child1');
    expect(text).toContain('que_1');
    expect(text).toContain('Which env?');
  });

  test.each(['question', 'permission'] as const)(
    'v2 %s wakes carry only the applicable reply guidance',
    async (kind) => {
      resetOrchestratorWakeGateForTests();
      resetChildInputWaitForTests();
      const promptAsync = mock(async () => ({}));
      const session = v1Session(promptAsync);
      const scheduler = makeScheduler(session);
      const wait = noteChildInputWait({
        taskID: 'ses_child1',
        parentSessionID: 'parent-1',
        kind,
        requestID: kind === 'question' ? 'form_1' : 'per_1',
        questions: [{ question: 'Which env?', header: 'Env', options: [] }],
        permission: 'bash',
        patterns: ['git status'],
      });
      if (!wait) throw new Error('missing test request');
      scheduler.triggerChildInputWaitWake(
        'parent-1',
        formatChildInputWaitDelta({
          alias: 'fix-1',
          ...wait,
          detail: formatChildInputWaitDetail(wait, 'v1'),
        }),
        `${wait.taskID}:${wait.requestID}`,
      );
      await flush();

      const text = promptAsync.mock.calls[0]?.[0]?.body.parts[0]?.text ?? '';
      expect(promptAsync).toHaveBeenCalledTimes(1);
      expect(text.match(/\nrequest:/g)).toHaveLength(1);
      expect(text.match(/\nkind:/g)).toHaveLength(1);
      expect(text).not.toContain('Do not respond');
      expect(text).toContain('next: task_reply');
      expect(text).not.toContain('v2 forms');
    },
  );

  test('duplicate asks do not double-wake', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const session = v1Session(promptAsync);
    const scheduler = makeScheduler(session);

    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta(),
      'ses_child1:que_1',
    );
    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta(),
      'ses_child1:que_1',
    );
    await flush();

    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('a resolved ask is pruned and does not wake', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const session = v1Session(promptAsync);
    let current = true;
    const scheduler = makeScheduler(session, {
      isChildInputWaitCurrent: () => current,
    });

    current = false;
    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta(),
      'ses_child1:que_1',
    );
    await flush();

    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('queue is bounded and each wake sends a chunk', async () => {
    expect(CHILD_INPUT_QUEUE_CAP).toBe(32);
    expect(CHILD_INPUT_WAKE_CHUNK).toBe(4);
  });

  test('a permission resolved after evaluation could have sent is dropped during settling', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    let current = true;
    const scheduler = makeScheduler(v1Session(promptAsync), {
      isChildInputWaitCurrent: () => current,
    });
    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta('ses_child1', 'per_1'),
      'ses_child1:per_1',
    );
    // The original immediate evaluation would send during these microtasks.
    await flushMicrotasks();
    jest.advanceTimersByTime(39);
    current = false;
    await scheduler.event({
      event: {
        type: 'permission.replied',
        properties: { sessionID: 'ses_child1', requestID: 'per_1' },
      },
    });
    await flush();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('settling revalidates even when a reply event is missed', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    let current = true;
    const scheduler = makeScheduler(v1Session(promptAsync), {
      isChildInputWaitCurrent: () => current,
    });
    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta(),
      'ses_child1:que_1',
    );
    await flushMicrotasks();
    current = false;
    await flush();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('a reply during the host snapshot read does not turn into a generic recovery wake', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const session = v1Session(promptAsync);
    let current = true;
    const scheduler = makeScheduler(session, {
      isChildInputWaitCurrent: () => current,
    });
    session.get = mock(async () => {
      current = false;
      await scheduler.event({
        event: {
          type: 'permission.replied',
          properties: { sessionID: 'ses_child1', requestID: 'per_1' },
        },
      });
      return { data: {} };
    });
    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta('ses_child1', 'per_1'),
      'ses_child1:per_1',
    );
    await flush();
    expect(session.get).toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('a duplicate followed by a reply during a host read cancels the older wake too', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const session = v1Session(promptAsync);
    let current = true;
    const scheduler = makeScheduler(session, {
      isChildInputWaitCurrent: () => current,
    });
    const ask = () =>
      scheduler.triggerChildInputWaitWake(
        'parent-1',
        delta('ses_child1', 'per_1'),
        'ses_child1:per_1',
      );
    session.get = mock(async () => {
      if (current) {
        ask();
        current = false;
        await scheduler.event({
          event: {
            type: 'permission.replied',
            properties: { sessionID: 'ses_child1', requestID: 'per_1' },
          },
        });
      }
      return { data: {} };
    });
    ask();
    await flush();
    await flush();
    expect(session.get).toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('resolving one ask keeps a different pending ask in the same batch', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const pending = new Set(['per_1', 'per_2']);
    const scheduler = makeScheduler(v1Session(promptAsync), {
      isChildInputWaitCurrent: (_, requestID) => pending.has(requestID),
    });
    for (const requestID of pending) {
      scheduler.triggerChildInputWaitWake(
        'parent-1',
        delta('ses_child1', requestID),
        `ses_child1:${requestID}`,
      );
    }
    pending.delete('per_1');
    await scheduler.event({
      event: {
        type: 'permission.replied',
        properties: { sessionID: 'ses_child1', requestID: 'per_1' },
      },
    });
    await flush();
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = promptAsync.mock.calls[0]?.[0] as {
      body: { parts: Array<{ text: string }> };
    };
    expect(call.body.parts[0]?.text).toContain('request: per_2');
    expect(call.body.parts[0]?.text).not.toContain('request: per_1');
  });

  test('duplicate asks do not restart the settling deadline', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const scheduler = makeScheduler(v1Session(promptAsync));
    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta(),
      'ses_child1:que_1',
    );
    jest.advanceTimersByTime(CHILD_INPUT_WAKE_SETTLE_MS - 1);
    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta(),
      'ses_child1:que_1',
    );
    jest.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test.each(['server.instance.disposed', 'session.deleted'])(
    '%s cancels a settling wake',
    async (type) => {
      resetOrchestratorWakeGateForTests();
      const promptAsync = mock(async () => ({}));
      const scheduler = makeScheduler(v1Session(promptAsync));
      scheduler.triggerChildInputWaitWake(
        'parent-1',
        delta(),
        'ses_child1:que_1',
      );
      await scheduler.event({
        event: { type, properties: { sessionID: 'parent-1' } },
      });
      await flush();
      expect(promptAsync).not.toHaveBeenCalled();
    },
  );

  test('stopped-job recovery stays immediate and excludes settling asks', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const scheduler = makeScheduler(v1Session(promptAsync));
    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta(),
      'ses_child1:que_1',
    );
    scheduler.triggerStoppedJobRecovery(
      'parent-1',
      'stop: child-2',
      'child-2:1',
    );
    await flushMicrotasks();
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = promptAsync.mock.calls[0]?.[0] as {
      body: { parts: Array<{ text: string }> };
    };
    expect(call.body.parts[0]?.text).toContain('stop: child-2');
    expect(call.body.parts[0]?.text).not.toContain('<child-input-wait>');
    await flush();
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test.each(['archive', 'suppress'])(
    '%s cancels settling and a later idle still delivers the pending ask',
    async (action) => {
      resetOrchestratorWakeGateForTests();
      const promptAsync = mock(async () => ({}));
      const scheduler = makeScheduler(v1Session(promptAsync));
      scheduler.triggerChildInputWaitWake(
        'parent-1',
        delta(),
        'ses_child1:que_1',
      );
      if (action === 'archive') {
        await scheduler.event({
          event: {
            type: 'session.updated',
            properties: { info: { id: 'parent-1', time: { archived: 123 } } },
          },
        });
      } else {
        scheduler.suppress('parent-1');
      }
      await flush();
      expect(promptAsync).not.toHaveBeenCalled();
      if (action === 'archive') {
        await scheduler.event({
          event: {
            type: 'session.updated',
            properties: { info: { id: 'parent-1', time: { archived: null } } },
          },
        });
      }
      await scheduler.event({
        event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
      });
      await flush();
      expect(promptAsync).toHaveBeenCalledTimes(1);
    },
  );

  test('overflowing the queue keeps an overflow marker telling the parent to run task_status', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const session = v1Session(promptAsync);
    const scheduler = makeScheduler(session);

    for (let i = 0; i < CHILD_INPUT_QUEUE_CAP + 1; i++) {
      scheduler.triggerChildInputWaitWake(
        'parent-1',
        formatChildInputWaitDelta({
          alias: `fix-${i}`,
          taskID: `ses_child${i}`,
          kind: 'question',
          requestID: `que_${i}`,
          detail: `request: que_${i}\nkind: question\nquestion: Q${i}`,
        }),
        `ses_child${i}:que_${i}`,
      );
    }
    await flush();

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = promptAsync.mock.calls[0]?.[0] as {
      body: { parts: Array<{ text: string }> };
    };
    const text = call.body.parts[0]?.text ?? '';
    // Oldest delta (ses_child0) was evicted; the overflow marker survives
    // and directs the parent to the remaining open requests.
    expect(text).not.toContain('task: ses_child0\n');
    expect(text).toContain('task: ses_child1\n');
    expect(text).toContain(CHILD_INPUT_OVERFLOW_TEXT);
    expect(text).toContain('task_status');
    expect(text.match(/<child-input-wait>/g)?.length).toBe(
      CHILD_INPUT_WAKE_CHUNK,
    );
  });

  test.each([false, true])(
    'overflow-only requests wake only while still pending (%s)',
    async (overflowPending) => {
      resetOrchestratorWakeGateForTests();
      const promptAsync = mock(async () => ({}));
      const session = v1Session(promptAsync);
      let current = true;
      const scheduler = makeScheduler(session, {
        isChildInputWaitCurrent: (taskID) =>
          current || (overflowPending && taskID === 'ses_child0'),
      });
      for (let i = 0; i < CHILD_INPUT_QUEUE_CAP + 1; i++) {
        scheduler.triggerChildInputWaitWake(
          'parent-1',
          delta(`ses_child${i}`, `que_${i}`),
          `ses_child${i}:que_${i}`,
        );
      }
      current = false;
      await flush();

      expect(promptAsync).toHaveBeenCalledTimes(overflowPending ? 1 : 0);
      if (overflowPending) {
        const text = promptAsync.mock.calls[0]?.[0]?.body.parts[0]?.text ?? '';
        expect(text).toContain('Handle the pending request below');
        expect(text).toContain(CHILD_INPUT_OVERFLOW_TEXT);
        expect(text).toContain('ses_child0');
        expect(text).not.toContain('stopped without a terminal result');
      } else {
        expect(session.get).not.toHaveBeenCalled();
      }
    },
  );

  test('pruning during delivery preserves new overflow requests', async () => {
    resetOrchestratorWakeGateForTests();
    let release: (() => void) | undefined;
    const promptAsync = mock(
      () =>
        new Promise<void>((resolve) => {
          if (!release) release = resolve;
          else resolve();
        }),
    );
    let current = true;
    const scheduler = makeScheduler(v1Session(promptAsync), {
      isChildInputWaitCurrent: (taskID) =>
        current || ['ses_child2', 'ses_new1', 'ses_new2'].includes(taskID),
    });
    for (let i = 0; i <= CHILD_INPUT_QUEUE_CAP; i++) {
      scheduler.triggerChildInputWaitWake(
        'parent-1',
        delta(`ses_child${i}`, `que_${i}`),
        `ses_child${i}:que_${i}`,
      );
    }
    await flush();
    expect(promptAsync).toHaveBeenCalledTimes(1);
    for (const id of ['ses_new1', 'ses_new2']) {
      scheduler.triggerChildInputWaitWake(
        'parent-1',
        delta(id, 'que_new'),
        `${id}:que_new`,
      );
    }
    current = false;
    await scheduler.event({
      event: {
        type: 'question.replied',
        properties: { sessionID: 'ses_child0', requestID: 'que_0' },
      },
    });
    release?.();
    await flushMicrotasks();
    await flush();
    expect(promptAsync).toHaveBeenCalledTimes(2);
    const text = promptAsync.mock.calls[1]?.[0]?.body.parts[0]?.text ?? '';
    expect(text).toContain('ses_child2');
    expect(text).toContain('ses_new1');
    expect(text).not.toContain('ses_child0');
  });

  test('raw then normalized v2 permission replaces the queued wake delta with action/resources', async () => {
    resetOrchestratorWakeGateForTests();
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    const promptAsync = mock(async () => ({}));
    const session = v1Session(promptAsync);
    const scheduler = makeScheduler(session);
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      background: true,
    });
    const hook = createTaskSessionManagerHook(
      {
        client: { session: { status: mock(async () => ({ data: {} })) } },
        directory: '/test',
        worktree: '/test',
      } as never,
      {
        maxSessionsPerAgent: 2,
        maxRetainedSnapshots: 20,
        backgroundJobBoard: board,
        shouldManageSession: (sessionID: string) => sessionID === 'parent-1',
        idleReconcileDelayMs: 0,
        runtimeStatusReconcileDelayMs: 0,
        onChildInputWait: ({ parentSessionID, taskID, kind, requestID }) => {
          const wait = getChildInputWait(taskID, requestID);
          if (!wait) throw new Error('missing notified request');
          scheduler.triggerChildInputWaitWake(
            parentSessionID,
            formatChildInputWaitDelta({
              alias: 'fix-1',
              taskID,
              kind,
              requestID,
              detail: formatChildInputWaitDetail(wait, 'v1'),
            }),
            `${taskID}:${requestID}`,
          );
        },
      },
    );

    for (const event of mapV2EventToV1({
      type: 'permission.asked',
      data: {
        id: 'per_1',
        sessionID: 'ses_child1',
        action: 'tool.execute',
        resources: ['bash:*'],
      },
    })) {
      await hook.event({ event } as never);
    }
    await flush();

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = promptAsync.mock.calls[0]?.[0] as {
      body: { parts: Array<{ text: string }> };
    };
    const text = call.body.parts[0]?.text ?? '';
    expect(text).toContain('permission: tool.execute');
    expect(text).toContain('patterns: bash:*');
    expect(text).not.toContain('permission: unknown');
  });
});

describe('child-input wake kind policy (#1504)', () => {
  test('default kinds suppress a permission ask but let a question ask wake', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const scheduler = makeScheduler(v1Session(promptAsync));

    // Default policy ships permission off: the ask is dropped before any
    // timer or batch entry exists, so nothing wakes.
    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta('ses_child1', 'per_1'),
      'ses_child1:per_1',
      'permission',
    );
    await flush();
    expect(promptAsync).not.toHaveBeenCalled();

    // Question asks ship on.
    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta('ses_child1', 'que_1'),
      'ses_child1:que_1',
      'question',
    );
    await flush();
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('childInputWakeKinds { permission: true } lets a permission ask wake', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const scheduler = makeScheduler(v1Session(promptAsync), {
      childInputWakeKinds: { permission: true, question: true },
    });

    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta('ses_child1', 'per_1'),
      'ses_child1:per_1',
      'permission',
    );
    await flush();
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('a no-kind re-drive is never gated, even with both kinds disabled', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const scheduler = makeScheduler(v1Session(promptAsync), {
      childInputWakeKinds: { permission: false, question: false },
    });

    // The idle retrigger re-drives an already-admitted batch with no kind;
    // the per-kind ingestion gate must not drop it.
    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta(),
      'ses_child1:que_1',
    );
    await flush();
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });
});

describe('child-input parent-active admission gate (#1504)', () => {
  test('a parent that goes busy mid-evaluation aborts at admission and the idle retrigger still delivers', async () => {
    resetOrchestratorWakeGateForTests();
    const entries: Array<{ message: string; data: unknown }> = [];
    const spy = spyOn(loggerModule, 'log').mockImplementation(
      (message: string, data?: unknown) => entries.push({ message, data }),
    );
    try {
      const promptAsync = mock(async () => ({}));
      // The parent is momentarily unobservable when the activation lands:
      // its busy status is recorded (the race guard) but the generation
      // does not bump, so the recheck verdict stays 'wake' and the race is
      // caught only at the admission gate.
      let observable = true;
      let injectBusy = true;
      let scheduler: ReturnType<typeof makeScheduler> | undefined;
      const resolveSelection = async (): Promise<never> => {
        if (injectBusy) {
          injectBusy = false;
          observable = false;
          await scheduler?.event({
            event: {
              type: 'session.status',
              properties: {
                sessionID: 'parent-1',
                status: { type: 'busy' },
              },
            },
          });
          observable = true;
        }
        return { agent: 'orchestrator' } as never;
      };
      scheduler = makeScheduler(v1Session(promptAsync), {
        mode: 'children',
        shouldManageSession: () => observable,
        hasPendingDelegatedWork: () => observable,
        resolveSelection,
      });

      scheduler.triggerChildInputWaitWake(
        'parent-1',
        delta(),
        'ses_child1:que_1',
        'question',
      );
      await flush();

      // Aborted at the admission checkpoint; the queued batch is retained.
      expect(promptAsync).not.toHaveBeenCalled();
      expect(
        entries.some((entry) => {
          const data = entry.data as
            | { checkpoint?: string; reason?: string }
            | undefined;
          return (
            entry.message === '[orchestrator-wake] evaluate aborted' &&
            data?.checkpoint === 'admission' &&
            data?.reason === 'parent-active'
          );
        }),
      ).toBe(true);

      // Parent goes idle: the idle retrigger re-drives the retained batch.
      await scheduler.event({
        event: {
          type: 'session.status',
          properties: { sessionID: 'parent-1', status: { type: 'idle' } },
        },
      });
      await flush();
      expect(promptAsync).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
