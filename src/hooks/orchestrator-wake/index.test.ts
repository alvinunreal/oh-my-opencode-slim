import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createInternalAgentTextPart } from '../../utils';
import { SessionLifecycle } from '../session-lifecycle';
import { resetUserWaitGateForTests } from '../task-session-manager/user-wait-gate';
import {
  buildOrchestratorWakeFingerprint,
  createOrchestratorWakeScheduler,
  ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT,
  ORCHESTRATOR_WAKE_TEXT,
  ORCHESTRATOR_WAKE_UNCHANGED_CAP,
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
    pendingCount() {
      return timers.size;
    },
  };
}

type SessionClientFactory = Partial<SessionClient> & {
  todos?: Array<Record<string, unknown>>;
  childrenData?: Array<Record<string, unknown>>;
  statusData?: Record<string, unknown>;
  model?: unknown;
};

function makeClient(overrides?: SessionClientFactory): SessionClient {
  const todos = overrides?.todos ?? [{ id: 't1', status: 'pending' }];
  const childrenData = overrides?.childrenData ?? [];
  const statusData = overrides?.statusData ?? {};
  return {
    get:
      overrides?.get ??
      mock(async () => ({
        data: {
          model: overrides?.model ?? {
            providerID: 'test',
            id: 'model-a',
            variant: 'high',
          },
        },
      })),
    todo: overrides?.todo ?? mock(async () => ({ data: todos })),
    children: overrides?.children ?? mock(async () => ({ data: childrenData })),
    status: overrides?.status ?? mock(async () => ({ data: statusData })),
    promptAsync: overrides?.promptAsync ?? mock(async () => ({})),
  };
}

function createScheduler(options?: {
  enabled?: boolean;
  intervalMs?: number;
  sessionClient?: SessionClient | null;
  shouldManageSession?: (id: string) => boolean;
  hasInputWait?: (id: string) => boolean;
  isFallbackInProgress?: (id: string) => boolean;
  coordinator?: SessionLifecycle;
  directory?: string;
}) {
  const client = options?.sessionClient;
  const session = client === null ? undefined : (client ?? makeClient());
  const ctx = {
    directory: options?.directory ?? '/project',
    client: { session },
  } as never;

  const scheduler = createOrchestratorWakeScheduler(ctx, {
    config: {
      enabled: options?.enabled ?? true,
      intervalMs: options?.intervalMs ?? 60_000,
    },
    intervalMs: options?.intervalMs ?? 60_000,
    shouldManageSession: options?.shouldManageSession ?? (() => true),
    hasInputWait: options?.hasInputWait ?? (() => false),
    isFallbackInProgress: options?.isFallbackInProgress,
    coordinator: options?.coordinator,
  });

  return { scheduler, session: session as SessionClient | undefined };
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

describe('buildOrchestratorWakeFingerprint', () => {
  test('includes todo statuses and child status/update evidence', () => {
    const fp = buildOrchestratorWakeFingerprint(
      [
        { id: 'b', status: 'pending' },
        { id: 'a', status: 'in_progress' },
      ],
      [{ id: 'child-1', time: { updated: 42 } }],
      { 'child-1': { type: 'busy' } },
    );
    expect(fp).toContain('a:in_progress');
    expect(fp).toContain('b:pending');
    expect(fp).toContain('child-1:busy:42');
  });
});

describe('orchestrator wake scheduler', () => {
  test('immediately wakes an idle parent after a stopped child with an active sibling', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-2' }],
        statusData: { 'child-2': { type: 'busy' } },
      }),
    });

    scheduler.triggerStoppedJobRecovery('p1');
    await clock.advance(0);

    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          parts: [
            createInternalAgentTextPart(ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT),
          ],
        }),
      }),
    );
  });

  test('does not recover-wake when disabled, waiting for input, busy, or disposed', async () => {
    const cases = [
      createScheduler({ enabled: false }),
      createScheduler({ hasInputWait: () => true }),
      createScheduler({
        sessionClient: makeClient({ statusData: { p1: { type: 'busy' } } }),
      }),
      createScheduler(),
    ];
    const disposed = cases[3];
    await disposed?.scheduler.event({
      event: { type: 'server.instance.disposed' },
    });

    for (const item of cases) item?.scheduler.triggerStoppedJobRecovery('p1');
    await clock.advance(0);

    for (const item of cases) {
      expect(item?.session?.promptAsync).not.toHaveBeenCalled();
    }
  });
  test('does nothing when disabled', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      enabled: false,
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(120_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('is inactive when required session APIs are missing', async () => {
    const { scheduler } = createScheduler({
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
      },
    });
    expect(scheduler._test.hasRequiredSessionApis()).toBe(false);
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(120_000);
    expect(clock.pendingCount()).toBe(0);
  });

  test('wakes after continuous idle interval with exact prompt text and directory query', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler, session } = createScheduler({
      intervalMs: 60_000,
      sessionClient: makeClient({ promptAsync }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(1);

    await clock.advance(59_999);
    expect(promptAsync).not.toHaveBeenCalled();

    await clock.advance(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<[unknown]>
    )[0]?.[0] as {
      path: { id: string };
      query: { directory: string };
      body: {
        agent: string;
        model?: { providerID: string; modelID: string };
        variant?: string;
        parts: Array<{ text: string }>;
      };
    };
    expect(call.path).toEqual({ id: 'p1' });
    expect(call.query).toEqual({ directory: '/project' });
    expect(call.body.agent).toBe('orchestrator');
    expect(call.body.model).toEqual({
      providerID: 'test',
      modelID: 'model-a',
    });
    expect(call.body.variant).toBeUndefined();
    expect(call.body.parts[0]?.text).toBe(
      `${ORCHESTRATOR_WAKE_TEXT}\n<!-- SLIM_INTERNAL_INITIATOR -->`,
    );

    expect(session?.todo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: 'p1' },
        query: { directory: '/project' },
      }),
    );
    expect(session?.status).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { directory: '/project' },
      }),
    );
  });

  test('targets only orchestrator-managed sessions', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      shouldManageSession: (id) => id === 'orch',
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'child' } },
    });
    await clock.advance(120_000);
    expect(promptAsync).not.toHaveBeenCalled();

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'orch' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('suppresses a periodic wake when the initial snapshot has an active child', async () => {
    const promptAsync = mock(async () => ({}));
    let statusReads = 0;
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        childrenData: [{ id: 'child-1', time: { updated: 1 } }],
        status: mock(async () => ({
          data: statusReads++ === 0 ? { 'child-1': { type: 'busy' } } : {},
        })),
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(1);

    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('suppresses a periodic wake when a child becomes active before the latest snapshot', async () => {
    const promptAsync = mock(async () => ({}));
    let statusReads = 0;
    let releaseFirstGet!: () => void;
    const firstGet = new Promise<void>((resolve) => {
      releaseFirstGet = resolve;
    });
    let getCalls = 0;
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        childrenData: [{ id: 'child-1' }],
        status: mock(async () => ({
          data: statusReads++ === 0 ? {} : { 'child-1': { type: 'busy' } },
        })),
        get: mock(async () => {
          if (getCalls++ === 0) await firstGet;
          return {
            data: {
              model: { providerID: 'test', id: 'model-a', variant: 'high' },
            },
          };
        }),
      }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(statusReads).toBe(1);

    releaseFirstGet();
    await clock.advance(0);

    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(1);
  });

  test('wakes when host children have no active status', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        childrenData: [{ id: 'child-1', time: { updated: 1 } }],
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('does not wake when parent is busy according to host status', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        statusData: { p1: { type: 'busy' } },
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('does not wake when todos are only completed or cancelled', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        todos: [
          { id: 't1', status: 'completed' },
          { id: 't2', status: 'cancelled' },
        ],
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('fails closed on unknown todo status', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        todos: [
          { id: 't1', status: 'pending' },
          { id: 't2', status: 'blocked' },
        ],
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('fails closed on malformed host responses', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        todo: mock(async () => ({ data: 'not-array' })),
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('suppresses on input wait, fallback, busy, and disposal without stuck in-flight', async () => {
    const promptAsync = mock(async () => ({}));
    let waiting = false;
    let fallback = false;
    const { scheduler } = createScheduler({
      sessionClient: makeClient({ promptAsync }),
      hasInputWait: () => waiting,
      isFallbackInProgress: () => fallback,
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    expect(clock.pendingCount()).toBe(1);

    waiting = true;
    scheduler.suppress('p1');
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);

    waiting = false;
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    fallback = true;
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();

    fallback = false;
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await scheduler.event({
      event: { type: 'server.instance.disposed' },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('disposal releases a reservation blocked on host reads', async () => {
    let releaseReads!: () => void;
    const blockedReads = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const a = createScheduler({
      intervalMs: 60_000,
      sessionClient: makeClient({
        todo: mock(async () => {
          await blockedReads;
          return { data: [{ id: 't1', status: 'pending' }] };
        }),
        children: mock(async () => {
          await blockedReads;
          return { data: [] };
        }),
        status: mock(async () => {
          await blockedReads;
          return { data: {} };
        }),
      }),
    });
    const promptAsync = mock(async () => ({}));
    const b = createScheduler({
      intervalMs: 60_000,
      sessionClient: makeClient({ promptAsync }),
    });

    await a.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    await a.scheduler.event({ event: { type: 'server.instance.disposed' } });

    await b.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    releaseReads();
  });

  test('clears in-flight ownership when suppress races an evaluation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const promptAsync = mock(async () => {
      await gate;
      return {};
    });
    const todo = mock(async () => {
      await gate;
      return { data: [{ id: 't1', status: 'pending' }] };
    });
    const { scheduler } = createScheduler({
      intervalMs: 10_000,
      sessionClient: makeClient({
        promptAsync,
        todo,
        children: mock(async () => {
          await gate;
          return { data: [] };
        }),
        status: mock(async () => {
          await gate;
          return { data: {} };
        }),
      }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(10_000);
    // Evaluation is blocked on host reads.
    scheduler.suppress('p1');
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // A later idle must be able to claim in-flight again.
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(10_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('session deletion clears scheduled wakes via coordinator', async () => {
    const promptAsync = mock(async () => ({}));
    const coordinator = new SessionLifecycle(() => {});
    const { scheduler } = createScheduler({
      sessionClient: makeClient({ promptAsync }),
      coordinator,
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    expect(clock.pendingCount()).toBe(1);
    coordinator.dispatchSessionDeleted('p1');
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('external user message re-arms and cancels pending wake', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    scheduler.observeChatMessage(
      { sessionID: 'p1', messageID: 'm1' },
      {
        message: { id: 'm1', role: 'user', sessionID: 'p1' },
        parts: [{ type: 'text', text: 'continue please' }],
      },
    );
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(getWakeProgress('p1').stopped).toBe(false);
    expect(getWakeProgress('p1').unchangedWakeCount).toBe(0);
  });

  test('internal initiator parts do not re-arm as external user messages', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    scheduler.observeChatMessage(
      { sessionID: 'p1', messageID: 'm-internal' },
      {
        message: { id: 'm-internal', role: 'user', sessionID: 'p1' },
        parts: [createInternalAgentTextPart(ORCHESTRATOR_WAKE_TEXT)],
      },
    );
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('wake→busy→idle preserves the two-wake no-progress cap', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      intervalMs: 60_000,
      sessionClient: makeClient({ promptAsync }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // Realistic host reaction to promptAsync: busy then idle again.
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(ORCHESTRATOR_WAKE_UNCHANGED_CAP);

    // Cap stops further wakes even after another busy→idle from the second wake.
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(180_000);
    expect(promptAsync).toHaveBeenCalledTimes(ORCHESTRATOR_WAKE_UNCHANGED_CAP);
  });

  test('external busy (not wake-initiated) rearms the no-progress cap', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      intervalMs: 60_000,
      sessionClient: makeClient({ promptAsync }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(getWakeProgress('p1').stopped).toBe(true);

    // External user message rearms.
    scheduler.observeChatMessage(
      { sessionID: 'p1', messageID: 'user-rearm' },
      {
        message: { id: 'user-rearm', role: 'user', sessionID: 'p1' },
        parts: [{ type: 'text', text: 'keep going' }],
      },
    );
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(3);
  });

  test('host-observed progress rearms the unchanged cap', async () => {
    const promptAsync = mock(async () => ({}));
    let todos: Array<Record<string, unknown>> = [
      { id: 't1', status: 'pending' },
    ];
    const { scheduler } = createScheduler({
      intervalMs: 60_000,
      sessionClient: makeClient({
        promptAsync,
        todo: mock(async () => ({ data: todos })),
      }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    // Simulate wake busy→idle without rearm (cap preserved at 1).
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    todos = [{ id: 't1', status: 'in_progress' }];
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    // Progress reset count; this is wake #1 of the new fingerprint.
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(getWakeProgress('p1').unchangedWakeCount).toBe(1);
    expect(getWakeProgress('p1').stopped).toBe(false);
  });

  test('failed promptAsync does not storm retries within the interval', async () => {
    let calls = 0;
    const promptAsync = mock(async () => {
      calls += 1;
      throw new Error('boom');
    });
    const { scheduler } = createScheduler({
      intervalMs: 60_000,
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(calls).toBe(1);
    await clock.advance(1_000);
    expect(calls).toBe(1);
    await clock.advance(59_000);
    expect(calls).toBe(2);
  });

  test('two hook instances share process-global in-flight and progress', async () => {
    const promptAsync = mock(async () => ({}));
    const client = makeClient({ promptAsync });
    const a = createScheduler({ sessionClient: client, intervalMs: 60_000 });
    const b = createScheduler({ sessionClient: client, intervalMs: 60_000 });

    await a.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await b.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    // Two local timers may exist; process gate dedupes wakes.
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await a.scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await b.scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await a.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await b.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);

    await a.scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await a.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(180_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test('disposing one hook leaves another hook’s shared progress cap intact', async () => {
    const promptAsync = mock(async () => ({}));
    const client = makeClient({ promptAsync });
    const a = createScheduler({ sessionClient: client, intervalMs: 60_000 });
    const b = createScheduler({ sessionClient: client, intervalMs: 60_000 });

    await a.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await b.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await a.scheduler.event({ event: { type: 'server.instance.disposed' } });
    await b.scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await b.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);

    await b.scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await b.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(180_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test('uses observed external model when session.get model is unavailable', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        get: mock(async () => {
          throw new Error('no model field');
        }),
      }),
    });
    scheduler.observeChatMessage(
      {
        sessionID: 'p1',
        messageID: 'm1',
        model: { providerID: 'obs', modelID: 'seen' },
        variant: 'low',
      },
      {
        message: { id: 'm1', role: 'user', sessionID: 'p1' },
        parts: [{ type: 'text', text: 'go' }],
      },
    );
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { directory: '/project' },
        body: expect.objectContaining({
          model: { providerID: 'obs', modelID: 'seen' },
        }),
      }),
    );
    const call = (
      promptAsync.mock.calls as unknown as Array<
        [{ body: { variant?: string } }]
      >
    )[0]?.[0];
    expect(call?.body.variant).toBeUndefined();
  });

  test('paired idle events do not create duplicate timers on one instance', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'idle' } },
      },
    });
    expect(clock.pendingCount()).toBe(1);
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });
});
