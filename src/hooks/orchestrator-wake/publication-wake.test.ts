/**
 * Terminal-publication wake (bounded, idle-parent-only).
 *
 * OpenCode's native notifier delivers a child's FIRST completion to the
 * parent. When the parent is idle at a later terminal publication — a child
 * that self-continues and finishes again, or any publication while the
 * parent sits idle — nothing nudges the parent until the periodic 5-minute
 * idle evaluation. The publication wake closes that gap with the SAME
 * delivery machinery and wake gate as the periodic scheduler:
 *
 * - trigger: published completed|error + parent idle + no input wait +
 *   per-parent throttle window (publicationWakeMinIntervalMs, default 30s);
 * - skip: busy parent (native steer already delivered the completion);
 * - share: one-flight, the two-wake no-progress cap, expectingWakeBusy;
 * - thread: a publication flag through classifyChildrenSnapshot so an idle
 *   parent with no active children is not classified 'no-work' (the same
 *   trap triggerStoppedJobRecovery solves with its recovery flag).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import * as loggerModule from '../../utils/logger';
import { createTimerHarness } from '../../utils/test-timers';
import { resetUserWaitGateForTests } from '../task-session-manager/user-wait-gate';
import {
  createOrchestratorWakeScheduler,
  formatCompletedJobDelta,
  formatStoppedJobDelta,
  ORCHESTRATOR_WAKE_TEXT,
} from './index';
import {
  getWakeProgress,
  resetOrchestratorWakeGateForTests,
} from './wake-gate';

type SessionClient = {
  get?: ReturnType<typeof mock>;
  todo?: ReturnType<typeof mock>;
  children?: ReturnType<typeof mock>;
  status?: ReturnType<typeof mock>;
  promptAsync?: ReturnType<typeof mock>;
};

function createClock() {
  let now = 0;
  let nextID = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const setTimeoutImpl = ((callback: () => void, delay?: number) => {
    const id = nextID++;
    timers.set(id, { at: now + (delay ?? 0), callback });
    const handle = {
      __id: id,
      unref() {
        return handle;
      },
    };
    return handle as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  const clearTimeoutImpl = ((handle: unknown) => {
    if (handle == null) return;
    const id =
      typeof handle === 'object' &&
      handle !== null &&
      '__id' in handle &&
      typeof (handle as { __id: unknown }).__id === 'number'
        ? (handle as { __id: number }).__id
        : Number(handle);
    timers.delete(id);
  }) as unknown as typeof clearTimeout;

  async function flushMicrotasks(times = 30): Promise<void> {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
    }
  }

  return {
    now: () => now,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    async advance(ms: number) {
      now += ms;
      for (let round = 0; round < 5; round++) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        for (const [id, timer] of due) {
          timers.delete(id);
          timer.callback();
        }
        await flushMicrotasks();
      }
      await flushMicrotasks();
    },
  };
}

/** v1 session surface: todo/children/status/get/promptAsync. */
function makeV1Client(overrides?: {
  todos?: Array<Record<string, unknown>>;
  childrenData?: Array<Record<string, unknown>>;
  statusData?: Record<string, unknown>;
  promptAsync?: ReturnType<typeof mock>;
}): SessionClient {
  return {
    get: mock(async () => ({
      data: {
        model: { providerID: 'test', id: 'model-a', variant: 'high' },
      },
    })),
    todo: mock(async () => ({
      data: overrides?.todos ?? [{ id: 't1', status: 'pending' }],
    })),
    children: mock(async () => ({
      data: overrides?.childrenData ?? [],
    })),
    status: mock(async () => ({ data: overrides?.statusData ?? {} })),
    promptAsync: overrides?.promptAsync ?? mock(async () => ({})),
  };
}

function createPublicationScheduler(options: {
  hostFlavor?: string;
  intervalMs?: number;
  wakeOnTerminalPublication?: boolean;
  periodicWakeEnabled?: boolean;
  publicationWakeMinIntervalMs?: number;
  sessionClient: SessionClient;
  shouldManageSession?: (id: string) => boolean;
  hasInputWait?: (id: string) => boolean;
  isFallbackInProgress?: (id: string) => boolean;
  onPublicationAccepted?: Parameters<
    typeof createOrchestratorWakeScheduler
  >[1]['onPublicationAccepted'];
  isPublicationCurrent?: Parameters<
    typeof createOrchestratorWakeScheduler
  >[1]['isPublicationCurrent'];
  setTimeout?: Parameters<
    typeof createOrchestratorWakeScheduler
  >[1]['setTimeout'];
  clearTimeout?: Parameters<
    typeof createOrchestratorWakeScheduler
  >[1]['clearTimeout'];
  now?: () => number;
}) {
  const ctx = {
    directory: '/project',
    client: { session: options.sessionClient },
    ...(options.hostFlavor ? { hostFlavor: options.hostFlavor } : {}),
  } as never;

  const scheduler = createOrchestratorWakeScheduler(ctx, {
    config: {
      enabled: true,
      intervalMs: options.intervalMs ?? 60_000,
      ...(options.wakeOnTerminalPublication === undefined
        ? {}
        : { wakeOnTerminalPublication: options.wakeOnTerminalPublication }),
      ...(options.periodicWakeEnabled === undefined
        ? {}
        : { periodicWakeEnabled: options.periodicWakeEnabled }),
      ...(options.publicationWakeMinIntervalMs === undefined
        ? {}
        : {
            publicationWakeMinIntervalMs: options.publicationWakeMinIntervalMs,
          }),
    },
    intervalMs: options.intervalMs ?? 60_000,
    shouldManageSession: options.shouldManageSession ?? (() => true),
    hasInputWait: options.hasInputWait ?? (() => false),
    isFallbackInProgress: options.isFallbackInProgress,
    ...(options.onPublicationAccepted
      ? { onPublicationAccepted: options.onPublicationAccepted }
      : {}),
    ...(options.isPublicationCurrent
      ? { isPublicationCurrent: options.isPublicationCurrent }
      : {}),
    ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
    ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
    now: options.now ?? clock.now,
  });

  return { scheduler };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function captureWakeLogs() {
  const entries: Array<{ message: string; data: Record<string, unknown> }> = [];
  const spy = spyOn(loggerModule, 'log').mockImplementation(
    (message: string, data?: unknown) => {
      entries.push({ message, data: (data ?? {}) as Record<string, unknown> });
    },
  );
  return {
    entries,
    restore: () => spy.mockRestore(),
    matching: (message: string) =>
      entries.filter(
        (entry) => entry.message === `[orchestrator-wake] ${message}`,
      ),
  };
}

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let clock = createClock();

beforeEach(() => {
  resetUserWaitGateForTests();
  resetOrchestratorWakeGateForTests();
  clock = createClock();
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

describe('terminal-publication wake', () => {
  test('v1 retains a publication while the parent is busy and delivers it on idle', async () => {
    const promptAsync = mock(async () => ({}));
    const accepted: Array<Record<string, unknown>> = [];
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v1',
      intervalMs: 1000,
      periodicWakeEnabled: false,
      sessionClient: makeV1Client({ promptAsync, todos: [] }),
      onPublicationAccepted: (publication) => accepted.push(publication),
    });
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    expect(
      await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 3, 4),
    ).toBe(false);
    expect(promptAsync).not.toHaveBeenCalled();
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'idle' } },
      },
    });
    await clock.advance(1000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = promptAsync.mock.calls[0]?.[0] as {
      body: { parts: Array<{ text: string }> };
    };
    expect(call.body.parts[0]?.text).toBe(
      `${ORCHESTRATOR_WAKE_TEXT}\nBackground task results available: child-1.\n<!-- SLIM_INTERNAL_INITIATOR -->`,
    );
    expect(accepted).toEqual([
      {
        sessionID: 'p1',
        taskID: 'child-1',
        generation: 3,
        terminalRevision: 4,
      },
    ]);
  });

  test('v1 input-wait suppresses a publication without consuming its throttle', async () => {
    let waiting = true;
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v1',
      publicationWakeMinIntervalMs: 60_000,
      hasInputWait: () => waiting,
      sessionClient: makeV1Client({ promptAsync, todos: [] }),
    });
    expect(
      await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1),
    ).toBe(false);
    expect(promptAsync).not.toHaveBeenCalled();
    waiting = false;
    expect(
      await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 1),
    ).toBe(true);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = promptAsync.mock.calls[0]?.[0] as {
      body: { parts: Array<{ text: string }> };
    };
    expect(call.body.parts[0]?.text).toContain(ORCHESTRATOR_WAKE_TEXT);
    expect(call.body.parts[0]?.text).toContain(
      'Background task results available: child-1, child-2.',
    );
  });

  test('v1 stale publication batches return their wake reservation', async () => {
    let current = false;
    const accepted: Array<Record<string, unknown>> = [];
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v1',
      intervalMs: 1000,
      publicationWakeMinIntervalMs: 1000,
      sessionClient: makeV1Client({ promptAsync, todos: [] }),
      isPublicationCurrent: () => current,
      onPublicationAccepted: (publication) => accepted.push(publication),
    });
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 3, 4);
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'idle' } },
      },
    });
    await clock.advance(1000);
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 3, 4);
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 3, 4);
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 3, 4);
    expect(promptAsync).not.toHaveBeenCalled();
    current = true;
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 5, 1);
    expect(accepted.map((entry) => entry.generation)).toEqual([5]);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('v1 deletion drops the retained publication for the deleted child', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v1',
      intervalMs: 1000,
      periodicWakeEnabled: false,
      sessionClient: makeV1Client({ promptAsync, todos: [] }),
    });
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 2);
    await scheduler.event({
      event: { type: 'session.deleted', properties: { sessionID: 'child-1' } },
    });
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'idle' } },
      },
    });
    await clock.advance(1000);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('v1 publication wakes share the two-wake no-progress cap', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v1',
      publicationWakeMinIntervalMs: 0,
      sessionClient: makeV1Client({ promptAsync, todos: [] }),
    });
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 1);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 2);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(getWakeProgress('p1')).toMatchObject({
      stopped: true,
      unchangedWakeCount: 2,
    });
  });
  test('G1a v1: a timer-delivered publication retry consumes the throttle', async () => {
    const capture = captureWakeLogs();
    try {
      let fail = true;
      const promptAsync = mock(async () => {
        if (fail) throw new Error('transport unavailable');
        return {};
      });
      const { scheduler } = createPublicationScheduler({
        hostFlavor: 'v1',
        publicationWakeMinIntervalMs: 3_600_000,
        sessionClient: makeV1Client({
          promptAsync,
          todos: [{ id: 't1', status: 'completed' }],
        }),
      });
      await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
      expect(promptAsync).toHaveBeenCalledTimes(1);
      fail = false;
      await clock.advance(60_000);
      expect(promptAsync).toHaveBeenCalledTimes(2);

      await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 1);
      expect(promptAsync).toHaveBeenCalledTimes(2);
      expect(
        capture.matching('terminal publication wake skipped'),
      ).toContainEqual({
        message: '[orchestrator-wake] terminal publication wake skipped',
        data: expect.objectContaining({
          taskID: 'child-2',
          generation: 1,
          reason: 'throttled',
        }),
      });
    } finally {
      capture.restore();
    }
  });

  test('G1b v1: a publication delivered by a one-flight waiter consumes the throttle', async () => {
    const capture = captureWakeLogs();
    try {
      const firstRead = deferred<{ data: Array<Record<string, unknown>> }>();
      const promptAsync = mock(async () => ({}));
      const client = makeV1Client({ promptAsync });
      let reads = 0;
      client.todo = mock(async () => {
        if (++reads === 1) return firstRead.promise;
        return { data: [{ id: 't1', status: 'pending' }] };
      });
      const { scheduler } = createPublicationScheduler({
        hostFlavor: 'v1',
        publicationWakeMinIntervalMs: 3_600_000,
        sessionClient: client,
      });
      await scheduler.event({
        event: { type: 'session.idle', properties: { sessionID: 'p1' } },
      });
      await clock.advance(60_000);
      expect(reads).toBe(1);
      await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 2);
      expect(promptAsync).not.toHaveBeenCalled();
      firstRead.resolve({ data: [] });
      await clock.advance(0);
      expect(promptAsync).toHaveBeenCalledTimes(1);

      await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 2);
      expect(promptAsync).toHaveBeenCalledTimes(1);
      expect(
        capture.matching('terminal publication wake skipped'),
      ).toContainEqual({
        message: '[orchestrator-wake] terminal publication wake skipped',
        data: expect.objectContaining({
          taskID: 'child-2',
          reason: 'throttled',
        }),
      });
    } finally {
      capture.restore();
    }
  });

  test('idle parent + error publication on v1 uses the periodic wake text', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      sessionClient: makeV1Client({
        // All todos completed: a periodic wake would classify 'no-work'.
        todos: [{ id: 't1', status: 'completed' }],
        promptAsync,
      }),
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as {
      modelSelection?: string;
      body: { parts: Array<{ text: string }> };
    };
    expect(call.modelSelection).toBe('inherit');
    expect(call.body.parts[0]?.text).toBe(
      `${ORCHESTRATOR_WAKE_TEXT}\nBackground task results available: child-1.\n<!-- SLIM_INTERNAL_INITIATOR -->`,
    );
  });

  test('v1 failed terminal publication retries with its publication reason when no periodic work remains', async () => {
    const triggers: string[] = [];
    const spy = spyOn(loggerModule, 'log').mockImplementation(
      (message: string, data?: unknown) => {
        const details = data as
          | { trigger?: string; checkpoint?: string }
          | undefined;
        if (
          message === '[orchestrator-wake] evaluate verdict' &&
          details?.checkpoint === 'initial'
        ) {
          triggers.push(details.trigger ?? 'missing');
        }
      },
    );
    try {
      let fail = true;
      const promptAsync = mock(async () => {
        if (fail) throw new Error('transport down');
        return {};
      });
      const { scheduler } = createPublicationScheduler({
        hostFlavor: 'v1',
        sessionClient: makeV1Client({
          promptAsync,
          todos: [{ id: 't1', status: 'completed' }],
        }),
      });
      await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
      expect(promptAsync).toHaveBeenCalledTimes(1);
      fail = false;
      await clock.advance(60_000);
      expect(promptAsync).toHaveBeenCalledTimes(2);
      expect(getWakeProgress('p1').stopped).toBe(false);
      expect(triggers).toEqual(['publication', 'publication']);
    } finally {
      spy.mockRestore();
    }
  });

  test('completed-result pushes honor publication spacing and coalesce instead of dropping', async () => {
    // Repo timer harness on both seams: deterministic, no real delay.
    const harness = createTimerHarness();
    const bodies: string[] = [];
    const promptAsync = mock(async (args: Record<string, unknown>) => {
      const body = args.body as { parts?: Array<{ text?: string }> };
      bodies.push(body.parts?.[0]?.text ?? '');
      return {};
    });
    const { scheduler } = createPublicationScheduler({
      publicationWakeMinIntervalMs: 30_000,
      setTimeout: harness.setTimeout as unknown as Parameters<
        typeof createOrchestratorWakeScheduler
      >[1]['setTimeout'],
      clearTimeout: harness.clearTimeout as unknown as Parameters<
        typeof createOrchestratorWakeScheduler
      >[1]['clearTimeout'],
      now: harness.now,
      sessionClient: makeV1Client({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-busy' }],
        statusData: { 'child-busy': { type: 'busy' } },
      }),
    });
    const push = (taskID: string, result: string) =>
      scheduler.triggerCompletedJobPublication(
        'p1',
        formatCompletedJobDelta({
          alias: taskID,
          taskID,
          state: 'completed',
          resultSummary: result,
        }),
        `${taskID}:2`,
        { taskID, generation: 2, terminalRevision: 3, state: 'completed' },
      );

    push('ses_a', 'result-a');
    await harness.tick();
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // Inside the window: both results stay queued, no extra model turn.
    push('ses_b', 'result-b');
    await harness.tick();
    push('ses_c', 'result-c');
    await harness.tick();
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await harness.advance(29_999);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // Window elapsed: ONE wake carries both deferred results.
    await harness.advance(1);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toContain('result: result-b');
    expect(bodies[1]).toContain('result: result-c');
    expect(bodies[1]).not.toContain('result-a');
  });

  test('results queued while a send is in flight are re-driven after an idle invalidates the flight', async () => {
    // Repo timer harness on both seams: deterministic, no real delay.
    const harness = createTimerHarness();
    const bodies: string[] = [];
    const sends: Array<ReturnType<typeof deferred<unknown>>> = [];
    const promptAsync = mock((args: Record<string, unknown>) => {
      const body = args.body as { parts?: Array<{ text?: string }> };
      bodies.push(body.parts?.[0]?.text ?? '');
      const send = deferred<unknown>();
      sends.push(send);
      return send.promise;
    });
    const { scheduler } = createPublicationScheduler({
      publicationWakeMinIntervalMs: 30_000,
      setTimeout: harness.setTimeout as unknown as Parameters<
        typeof createOrchestratorWakeScheduler
      >[1]['setTimeout'],
      clearTimeout: harness.clearTimeout as unknown as Parameters<
        typeof createOrchestratorWakeScheduler
      >[1]['clearTimeout'],
      now: harness.now,
      sessionClient: makeV1Client({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-busy' }],
        statusData: { 'child-busy': { type: 'busy' } },
      }),
    });
    const push = (taskID: string, result: string) =>
      scheduler.triggerCompletedJobPublication(
        'p1',
        formatCompletedJobDelta({
          alias: taskID,
          taskID,
          state: 'completed',
          resultSummary: result,
        }),
        `${taskID}:2`,
        { taskID, generation: 2, terminalRevision: 3, state: 'completed' },
      );

    push('ses_a', 'result-a');
    await harness.tick();
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // While the send is pending: two more results queue and the parent
    // reports idle. Both re-drives lose the one-flight race and wait behind
    // the committed send, which never releases its waiters.
    push('ses_b', 'result-b');
    push('ses_c', 'result-c');
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await harness.tick();
    sends[0]?.resolve({});
    await harness.tick();
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // The accepted send consumed the spacing window: the leftover results
    // are delivered together, once, when it elapses — not stranded.
    await harness.advance(30_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toContain('result: result-b');
    expect(bodies[1]).toContain('result: result-c');
    expect(bodies[1]).not.toContain('result-a');
    sends[1]?.resolve({});
    await harness.advance(30_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test('a stop queued while a send is in flight is re-driven after an idle invalidates the flight', async () => {
    // Repo timer harness on both seams: deterministic, no real delay.
    const harness = createTimerHarness();
    const bodies: string[] = [];
    const sends: Array<ReturnType<typeof deferred<unknown>>> = [];
    const promptAsync = mock((args: Record<string, unknown>) => {
      const body = args.body as { parts?: Array<{ text?: string }> };
      bodies.push(body.parts?.[0]?.text ?? '');
      const send = deferred<unknown>();
      sends.push(send);
      return send.promise;
    });
    const { scheduler } = createPublicationScheduler({
      intervalMs: 60_000,
      setTimeout: harness.setTimeout as unknown as Parameters<
        typeof createOrchestratorWakeScheduler
      >[1]['setTimeout'],
      clearTimeout: harness.clearTimeout as unknown as Parameters<
        typeof createOrchestratorWakeScheduler
      >[1]['clearTimeout'],
      now: harness.now,
      sessionClient: makeV1Client({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-busy' }],
        statusData: { 'child-busy': { type: 'busy' } },
      }),
    });
    const stop = (taskID: string, generation: number) =>
      scheduler.triggerStoppedJobRecovery(
        'p1',
        formatStoppedJobDelta({
          alias: taskID,
          taskID,
          generation,
          state: 'stopped',
          reason: 'stopped without a terminal result',
        }),
        `${taskID}:${generation}`,
      );

    stop('ses_a', 1);
    await harness.tick();
    expect(promptAsync).toHaveBeenCalledTimes(1);

    stop('ses_b', 2);
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await harness.tick();
    sends[0]?.resolve({});
    await harness.tick();
    // No back-to-back prompt: after a commit a timer controls cadence.
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await harness.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toContain('task: ses_b');
    expect(bodies[1]).not.toContain('task: ses_a');
  });
});
