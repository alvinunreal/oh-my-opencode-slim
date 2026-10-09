import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { mapV2EventToV1 } from '../../v2/event-adapter';
import { createTaskSessionManagerHook } from '../task-session-manager';
import {
  getChildInputWait,
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
  },
) {
  return createOrchestratorWakeScheduler(makeCtx(session), {
    config: { enabled: true, intervalMs: 60_000, mode: 'todo' },
    shouldManageSession: options?.shouldManageSession ?? (() => true),
    hasInputWait: () => false,
    hasPendingDelegatedWork: () => true,
    isChildInputWaitCurrent: options?.isChildInputWaitCurrent ?? (() => true),
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

function formatTestChildInputWaitDetail(taskID: string, requestID: string) {
  const wait = getChildInputWait(taskID, requestID);
  if (!wait) return `request: ${requestID}\nkind: unknown`;
  const lines = [`request: ${wait.requestID}`, `kind: ${wait.kind}`];
  if (wait.kind === 'permission') {
    lines.push(`permission: ${wait.permission ?? 'unknown'}`);
    if (wait.patterns && wait.patterns.length > 0) {
      lines.push(`patterns: ${wait.patterns.join(', ')}`);
    }
  }
  return lines.join('\n');
}

const delta = (taskID = 'ses_child1', requestID = 'que_1') =>
  formatChildInputWaitDelta({
    alias: 'fix-1',
    taskID,
    kind: 'question',
    requestID,
    detail: `request: ${requestID}\nkind: question\nquestion: Which env?`,
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
    expect(text).toContain('task_reply');
  });

  test('child-input wake text carries the v2-form caveat (negative invariant pin)', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const session = v1Session(promptAsync);
    const scheduler = makeScheduler(session);

    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta(),
      'ses_child1:que_1',
    );
    await flush();

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = promptAsync.mock.calls[0]?.[0] as {
      body: { parts: Array<{ text: string }> };
    };
    const text = call.body.parts[0]?.text ?? '';
    // Negative invariant: a wake delivering a child-input ask always uses
    // ORCHESTRATOR_CHILD_INPUT_WAKE_TEXT, which carries the v2-form caveat.
    // If a new delta-send branch ever bypasses it, this pin goes red.
    expect(text).toContain(
      'form-created question requests are observable but not answerable',
    );
  });

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

  test('the overflow marker keeps waking when retained details go stale', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const session = v1Session(promptAsync);
    let current = true;
    const scheduler = makeScheduler(session, {
      isChildInputWaitCurrent: () => current,
    });

    for (let i = 0; i < CHILD_INPUT_QUEUE_CAP + 1; i++) {
      scheduler.triggerChildInputWaitWake(
        'parent-1',
        delta(`ses_child${i}`, `que_${i}`),
        `ses_child${i}:que_${i}`,
      );
    }
    // All retained asks resolve while queued; the overflow count alone
    // must still produce a wake carrying the marker.
    current = false;
    scheduler.triggerChildInputWaitWake('parent-1');
    await flush();

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = promptAsync.mock.calls[0]?.[0] as {
      body: { parts: Array<{ text: string }> };
    };
    const text = call.body.parts[0]?.text ?? '';
    expect(text).toContain(CHILD_INPUT_OVERFLOW_TEXT);
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
          scheduler.triggerChildInputWaitWake(
            parentSessionID,
            formatChildInputWaitDelta({
              alias: 'fix-1',
              taskID,
              kind,
              requestID,
              detail: formatTestChildInputWaitDetail(taskID, requestID),
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
