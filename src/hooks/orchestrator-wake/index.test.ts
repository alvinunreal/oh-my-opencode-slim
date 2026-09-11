import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createInternalAgentTextPart } from '../../utils';
import { SessionLifecycle } from '../session-lifecycle';
import { resetUserWaitGateForTests } from '../task-session-manager/user-wait-gate';
import {
  buildChildrenWakeFingerprint,
  buildOrchestratorWakeFingerprint,
  CHILD_STALENESS_INTERVALS,
  childUpdateEvidenceMs,
  createOrchestratorWakeScheduler,
  isWakeChildActive,
  mapWakeChild,
  ORCHESTRATOR_CHILDREN_WAKE_TEXT,
  ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT,
  ORCHESTRATOR_WAKE_TEXT,
  ORCHESTRATOR_WAKE_UNCHANGED_CAP,
  resolveWakeMode,
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
  list?: ReturnType<typeof mock>;
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
  mode?: 'auto' | 'todo' | 'children';
  hostFlavor?: string;
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
    ...(options?.hostFlavor ? { hostFlavor: options.hostFlavor } : {}),
  } as never;

  const scheduler = createOrchestratorWakeScheduler(ctx, {
    config: {
      enabled: options?.enabled ?? true,
      intervalMs: options?.intervalMs ?? 60_000,
      ...(options?.mode ? { mode: options.mode } : {}),
    },
    intervalMs: options?.intervalMs ?? 60_000,
    shouldManageSession: options?.shouldManageSession ?? (() => true),
    hasInputWait: options?.hasInputWait ?? (() => false),
    isFallbackInProgress: options?.isFallbackInProgress,
    coordinator: options?.coordinator,
  });

  return { scheduler, session: session as SessionClient | undefined };
}

/** v2-flavored session surface: list + promptAsync (get optional). */
function makeV2Client(overrides?: {
  listChildren?: Array<Record<string, unknown>>;
  listImpl?: ReturnType<typeof mock>;
  promptAsync?: ReturnType<typeof mock>;
  get?: ReturnType<typeof mock>;
  omitList?: boolean;
}): SessionClient {
  const client: SessionClient = {
    promptAsync: overrides?.promptAsync ?? mock(async () => ({})),
  };
  if (!overrides?.omitList) {
    client.list =
      overrides?.listImpl ??
      mock(async () => ({ data: overrides?.listChildren ?? [] }));
  }
  if (overrides?.get) client.get = overrides.get;
  return client;
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

describe('session API capability probe', () => {
  test('v1 requires the exact historical probe set (get/todo/children/status/promptAsync)', () => {
    const base = makeClient() as Record<string, unknown>;
    expect(
      createScheduler({
        sessionClient: base as SessionClient,
      }).scheduler._test.hasRequiredSessionApis(),
    ).toBe(true); // list is NOT required on v1

    for (const key of ['get', 'todo', 'children', 'status', 'promptAsync']) {
      const partial = { ...base };
      delete partial[key];
      expect(
        createScheduler({
          sessionClient: partial as SessionClient,
        }).scheduler._test.hasRequiredSessionApis(),
      ).toBe(false);
    }
  });

  test('v2 requires only list + promptAsync; get is optional', () => {
    expect(
      createScheduler({
        hostFlavor: 'v2',
        sessionClient: makeV2Client(),
      }).scheduler._test.hasRequiredSessionApis(),
    ).toBe(true);
    expect(
      createScheduler({
        hostFlavor: 'v2',
        sessionClient: makeV2Client({ omitList: true }),
      }).scheduler._test.hasRequiredSessionApis(),
    ).toBe(false);
    expect(
      createScheduler({
        hostFlavor: 'v2',
        sessionClient: { list: mock(async () => ({ data: [] })) },
      }).scheduler._test.hasRequiredSessionApis(),
    ).toBe(false);
  });

  test('v2 without todo resolves auto to children-driven mode', () => {
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      sessionClient: makeV2Client(),
    });
    expect(scheduler._test.wakeMode()).toBe('children');
    expect(scheduler._test.capabilities().flavor).toBe('v2');
  });

  test('explicit todo mode on v2 degrades to children; children pins children', () => {
    expect(
      createScheduler({
        hostFlavor: 'v2',
        mode: 'todo',
        sessionClient: makeV2Client(),
      }).scheduler._test.wakeMode(),
    ).toBe('children');
    expect(
      createScheduler({
        hostFlavor: 'v2',
        mode: 'children',
        sessionClient: makeV2Client(),
      }).scheduler._test.wakeMode(),
    ).toBe('children');
    // v1 with a todo API keeps explicit todo mode.
    expect(createScheduler({ mode: 'todo' }).scheduler._test.wakeMode()).toBe(
      'todo',
    );
    expect(
      createScheduler({ mode: 'children' }).scheduler._test.wakeMode(),
    ).toBe('children');
    expect(createScheduler().scheduler._test.wakeMode()).toBe('todo');
  });

  test('resolveWakeMode: auto maps per flavor; todo degrades without the todo API', () => {
    expect(resolveWakeMode('auto', { flavor: 'v1', hasTodo: true })).toBe(
      'todo',
    );
    expect(resolveWakeMode('auto', { flavor: 'v2', hasTodo: false })).toBe(
      'children',
    );
    expect(resolveWakeMode(undefined, { flavor: 'v1', hasTodo: true })).toBe(
      'todo',
    );
    expect(resolveWakeMode('todo', { flavor: 'v1', hasTodo: false })).toBe(
      'children',
    );
    expect(resolveWakeMode('children', { flavor: 'v1', hasTodo: true })).toBe(
      'children',
    );
  });
});

describe('children-driven degraded mode (v2)', () => {
  test('wakes with active children using the children wake text and queue delivery', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler, session } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [
          {
            id: 'child-1',
            parentID: 'p1',
            directory: '/project',
            time: { updated: Date.now() },
          },
        ],
      }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as {
      path: { id: string };
      query: { directory: string };
      delivery?: string;
      body: { agent: string; parts: Array<{ text: string }> };
    };
    expect(call.path).toEqual({ id: 'p1' });
    expect(call.query).toEqual({ directory: '/project' });
    expect(call.delivery).toBe('queue');
    expect(call.body.agent).toBe('orchestrator');
    expect(call.body.parts[0]?.text).toBe(
      `${ORCHESTRATOR_CHILDREN_WAKE_TEXT}\n<!-- SLIM_INTERNAL_INITIATOR -->`,
    );
    expect(session?.list).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { parentID: 'p1', directory: '/project' },
      }),
    );
  });

  test('does not wake when every child has a terminal outcome', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [
          { id: 'c1', outcome: 'succeeded', time: { updated: Date.now() } },
          { id: 'c2', outcome: 'failed', time: { updated: Date.now() } },
          { id: 'c3', outcome: 'interrupted', time: { updated: Date.now() } },
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

  test('treats a child as inactive once its update evidence is stale', async () => {
    const promptAsync = mock(async () => ({}));
    const stalenessMs = 60_000 * CHILD_STALENESS_INTERVALS;
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [
          { id: 'c1', time: { updated: Date.now() - stalenessMs - 1 } },
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

  test('scopes children to the session workspace via reported directory', async () => {
    const promptAsyncLocal = mock(async () => ({}));
    const fresh = () => Date.now();
    const local = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync: promptAsyncLocal,
        listChildren: [
          { id: 'c-local', directory: '/project', time: { updated: fresh() } },
          {
            id: 'c-other',
            directory: '/elsewhere',
            time: { updated: fresh() },
          },
        ],
      }),
    });
    await local.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsyncLocal).toHaveBeenCalledTimes(1); // local child qualifies

    // Only a foreign-directory child: scoped out → no wake, spell ends.
    const promptAsyncOther = mock(async () => ({}));
    const other = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync: promptAsyncOther,
        listChildren: [
          {
            id: 'c-other',
            directory: '/elsewhere',
            time: { updated: fresh() },
          },
        ],
      }),
    });
    await other.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p2' } },
    });
    await clock.advance(60_000);
    expect(promptAsyncOther).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('stops after the unchanged cap when children make no progress', async () => {
    const promptAsync = mock(async () => ({}));
    const frozen = Date.now();
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [{ id: 'c1', time: { updated: frozen } }],
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(ORCHESTRATOR_WAKE_UNCHANGED_CAP);
    expect(getWakeProgress('p1').stopped).toBe(true);
    await clock.advance(180_000);
    expect(promptAsync).toHaveBeenCalledTimes(ORCHESTRATOR_WAKE_UNCHANGED_CAP);
  });

  test('child update progress resets the unchanged cap', async () => {
    const promptAsync = mock(async () => ({}));
    let updated = Date.now();
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listImpl: mock(async () => ({
          data: [{ id: 'c1', time: { updated } }],
        })),
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    // Each interval the host reports fresh child progress: every wake sees a
    // new fingerprint, so the two-wake cap keeps resetting.
    updated += 5_000;
    await clock.advance(60_000);
    updated += 5_000;
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(getWakeProgress('p1').stopped).toBe(false);
    expect(getWakeProgress('p1').unchangedWakeCount).toBe(1);
  });

  test('recovery wake bypasses the children condition', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [] }),
    });
    scheduler.triggerStoppedJobRecovery('p1');
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<
        [{ body: { parts: Array<{ text: string }> }; delivery?: string }]
      >
    )[0]?.[0];
    expect(call?.body.parts[0]?.text).toBe(
      `${ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT}\n<!-- SLIM_INTERNAL_INITIATOR -->`,
    );
    expect(call?.delivery).toBe('queue');
  });

  test('parent-active race guard: tracked busy parent blocks the wake', async () => {
    const promptAsync = mock(async () => ({}));
    let managed = false;
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      shouldManageSession: (id) => managed && id === 'p1',
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [{ id: 'c1', time: { updated: Date.now() } }],
      }),
    });
    // Busy while unmanaged: endIdleSpell does not run, but the status is
    // tracked (the race-guard source on hosts without a status map).
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    managed = true;
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
    expect(scheduler._test.lastStatusBySession.get('p1')?.status).toBe('busy');
  });

  test('event-tracked busy-set marks a child active without list evidence', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [{ id: 'c1' }], // no time fields at all
      }),
    });
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'c1', status: { type: 'busy' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('stale tracked busy child is bounded by the staleness window', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [{ id: 'c1' }],
      }),
    });
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'c1', status: { type: 'busy' } },
      },
    });
    // Backdate the tracked evidence past the staleness bound.
    scheduler._test.lastStatusBySession.set('c1', {
      status: 'busy',
      at: Date.now() - 60_000 * CHILD_STALENESS_INTERVALS - 1,
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });
});

describe('children enumeration fallback (v2)', () => {
  test('falls back to event-tracked bookkeeping when the list yields nothing', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [] }),
    });
    // Synthesized v1-shape session.created carrying parentID.
    await scheduler.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('accepts the raw flat v2 session.created shape too', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [] }),
    });
    await scheduler.event({
      event: {
        type: 'session.created',
        properties: { sessionID: 'c1', parentID: 'p1' },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('falls back when session.list rejects', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listImpl: mock(async () => {
          throw new Error('list unavailable');
        }),
      }),
    });
    await scheduler.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('event child gone stale no longer wakes', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [] }),
    });
    await scheduler.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      },
    });
    scheduler._test.childEvidence.set(
      'c1',
      Date.now() - 60_000 * CHILD_STALENESS_INTERVALS - 1,
    );
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('session.deleted forgets event-tracked children', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [] }),
    });
    await scheduler.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      },
    });
    await scheduler.event({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 'c1' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(scheduler._test.childEvidence.has('c1')).toBe(false);
  });
});

describe('children mode on v1 (explicit opt-in)', () => {
  test('enumerates via session.children and keeps the v1 promptAsync call shape', async () => {
    const promptAsync = mock(async () => ({}));
    const children = mock(async () => ({
      data: [{ id: 'c1', time: { updated: Date.now() } }],
    }));
    const status = mock(async () => ({ data: {} }));
    const { scheduler } = createScheduler({
      mode: 'children',
      intervalMs: 60_000,
      sessionClient: makeClient({ promptAsync, children, status }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as {
      delivery?: string;
      body: { parts: Array<{ text: string }> };
    };
    expect(call.delivery).toBeUndefined(); // v1 call shape unchanged
    expect(call.body.parts[0]?.text).toBe(
      `${ORCHESTRATOR_CHILDREN_WAKE_TEXT}\n<!-- SLIM_INTERNAL_INITIATOR -->`,
    );
  });

  test('v1 status-map parent activity ends the idle spell', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      mode: 'children',
      intervalMs: 60_000,
      sessionClient: makeClient({
        promptAsync,
        childrenData: [{ id: 'c1', time: { updated: Date.now() } }],
        statusData: { p1: { type: 'busy' } },
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });
});

describe('children-mode helpers', () => {
  test('childUpdateEvidenceMs follows the update-evidence cascade numerically', () => {
    expect(
      childUpdateEvidenceMs({ id: 'c', time: { updated: 42, created: 1 } }),
    ).toBe(42);
    expect(childUpdateEvidenceMs({ id: 'c', updatedAt: 7 })).toBe(7);
    expect(childUpdateEvidenceMs({ id: 'c', time: { created: 3 } })).toBe(3);
    expect(childUpdateEvidenceMs({ id: 'c', time: { updated: 'x' } })).toBe(
      undefined,
    );
    expect(childUpdateEvidenceMs({ id: 'c' })).toBe(undefined);
  });

  test('mapWakeChild copies id/outcome/directory/evidence and drops unknowns', () => {
    expect(
      mapWakeChild({
        id: 'c1',
        outcome: 'succeeded',
        directory: '/project',
        time: { updated: 10 },
      }),
    ).toEqual({
      id: 'c1',
      outcome: 'succeeded',
      directory: '/project',
      evidenceAt: 10,
    });
    expect(mapWakeChild({ nope: 1 })).toBeUndefined();
    expect(mapWakeChild({ id: '' })).toBeUndefined();
  });

  test('isWakeChildActive: outcome wins, freshness bounds both branches', () => {
    const now = 1_000_000;
    const staleness = 180_000;
    expect(
      isWakeChildActive(
        { id: 'c', outcome: 'failed', evidenceAt: now },
        undefined,
        now,
        staleness,
      ),
    ).toBe(false);
    expect(
      isWakeChildActive(
        { id: 'c', evidenceAt: now - staleness },
        undefined,
        now,
        staleness,
      ),
    ).toBe(true);
    expect(
      isWakeChildActive(
        { id: 'c', evidenceAt: now - staleness - 1 },
        undefined,
        now,
        staleness,
      ),
    ).toBe(false);
    // Busy-set with no list evidence.
    expect(
      isWakeChildActive(
        { id: 'c' },
        { status: 'busy', at: now },
        now,
        staleness,
      ),
    ).toBe(true);
    // Stale busy-set is bounded.
    expect(
      isWakeChildActive(
        { id: 'c' },
        { status: 'busy', at: now - staleness - 1 },
        now,
        staleness,
      ),
    ).toBe(false);
    // No evidence at all → inactive.
    expect(isWakeChildActive({ id: 'c' }, undefined, now, staleness)).toBe(
      false,
    );
  });

  test('buildChildrenWakeFingerprint includes outcome, tracked status, and evidence', () => {
    const tracked = new Map([['c1', { status: 'busy' as const, at: 5 }]]);
    const fp = buildChildrenWakeFingerprint(
      [
        { id: 'c1', evidenceAt: 42 },
        { id: 'c2', outcome: 'succeeded' },
      ],
      tracked,
    );
    expect(fp).toContain('c1::busy:42');
    expect(fp).toContain('c2:succeeded::');
    expect(buildChildrenWakeFingerprint([], tracked)).toBe('');
  });
});
