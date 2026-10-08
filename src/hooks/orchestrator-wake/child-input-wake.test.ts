import { describe, expect, mock, test } from 'bun:test';
import {
  BackgroundJobBoard,
  createBackgroundJobLifecycle,
} from '../../background-jobs';
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

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

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
    detail: 'request: que_1\nkind: question\nquestion: Which env?',
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
        backgroundJobs: createBackgroundJobLifecycle({
          backgroundJobBoard: board,
        }),
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
