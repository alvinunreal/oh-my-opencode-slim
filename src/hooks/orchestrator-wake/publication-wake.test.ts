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
import { resetUserWaitGateForTests } from '../task-session-manager/user-wait-gate';
import {
  createOrchestratorWakeScheduler,
  ORCHESTRATOR_CHILDREN_WAKE_TEXT,
  ORCHESTRATOR_WAKE_TEXT,
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
  };
}

/** v2-flavored session surface: list + promptAsync (get optional). */
function makeV2Client(overrides?: {
  listChildren?: Array<Record<string, unknown>>;
  promptAsync?: ReturnType<typeof mock>;
  get?: ReturnType<typeof mock>;
}): SessionClient {
  const client: SessionClient = {
    promptAsync: overrides?.promptAsync ?? mock(async () => ({})),
  };
  client.list = mock(async () => ({
    data: overrides?.listChildren ?? [],
  }));
  if (overrides?.get) client.get = overrides.get;
  return client;
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
  publicationWakeMinIntervalMs?: number;
  sessionClient: SessionClient;
  shouldManageSession?: (id: string) => boolean;
  hasInputWait?: (id: string) => boolean;
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
      ...(options.publicationWakeMinIntervalMs === undefined
        ? {}
        : {
            publicationWakeMinIntervalMs: options.publicationWakeMinIntervalMs,
          }),
    },
    intervalMs: options.intervalMs ?? 60_000,
    shouldManageSession: options.shouldManageSession ?? (() => true),
    hasInputWait: options.hasInputWait ?? (() => false),
  });

  return { scheduler };
}

/** A terminal child entry as v2 session.list reports it post-completion. */
function terminalChild(id: string): Record<string, unknown> {
  return {
    id,
    parentID: 'p1',
    directory: '/project',
    outcome: 'succeeded',
    time: { updated: Date.now() },
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
  test('idle parent + completed publication → exactly ONE queue wake with inherit selection (v2)', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      publicationWakeMinIntervalMs: 1,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as {
      path: { id: string };
      query: { directory: string };
      delivery?: string;
      modelSelection?: string;
      body: { agent: string; parts: Array<{ text: string }> };
    };
    expect(call.path).toEqual({ id: 'p1' });
    expect(call.query).toEqual({ directory: '/project' });
    expect(call.delivery).toBe('queue');
    expect(call.modelSelection).toBe('inherit');
    expect(call.body.agent).toBe('orchestrator');
    expect(call.body.parts[0]?.text).toBe(
      `${ORCHESTRATOR_CHILDREN_WAKE_TEXT}\n<!-- SLIM_INTERNAL_INITIATOR -->`,
    );
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
      `${ORCHESTRATOR_WAKE_TEXT}\n<!-- SLIM_INTERNAL_INITIATOR -->`,
    );
  });

  test('throttle window blocks a second publication wake', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      publicationWakeMinIntervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1'), terminalChild('child-2')],
      }),
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // A second publication inside the window must not wake again.
    await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 1);
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('busy parent is skipped entirely (native steer already delivered)', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      publicationWakeMinIntervalMs: 1,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });

    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('hasInputWait suppresses the publication wake', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      publicationWakeMinIntervalMs: 1,
      hasInputWait: () => true,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('input-wait suppression does not consume the throttle window', async () => {
    const promptAsync = mock(async () => ({}));
    let inputWait = true;
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      // A wide window: the second publication below lands WELL inside it,
      // so it may only wake when the suppressed attempt burned nothing.
      publicationWakeMinIntervalMs: 60_000,
      hasInputWait: (id) => id === 'p1' && inputWait,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1'), terminalChild('child-2')],
      }),
    });

    // First publication while an input wait is open: suppressed.
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);
    expect(promptAsync).not.toHaveBeenCalled();

    // The wait clears; the very next publication still wakes: the
    // suppressed attempt must not have consumed the throttle window.
    inputWait = false;
    await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 1);
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('evaluation vetoed mid-evaluate (SDK error) burns no throttle and logs no waking verdict', async () => {
    let failDelivery = true;
    const promptAsync = mock(async () => {
      if (failDelivery) throw new Error('sdk unavailable');
      return {};
    });
    const entries: Array<{ message: string; data: unknown }> = [];
    const spy = spyOn(loggerModule, 'log').mockImplementation(
      (message: string, data?: unknown) => {
        entries.push({ message, data });
      },
    );
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      // A wide window: the second publication below lands WELL inside
      // it, so it may only wake when the vetoed evaluation burned
      // nothing.
      publicationWakeMinIntervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1'), terminalChild('child-2')],
      }),
    });
    const wakingLogs = () =>
      entries.filter(
        (entry) =>
          entry.message === '[orchestrator-wake] terminal publication wake' &&
          (entry.data as { verdict?: string } | undefined)?.verdict ===
            'waking',
      );

    try {
      // First publication: canSchedule passes, but the evaluation is
      // vetoed at the delivery step (promptAsync rejects → the SDK
      // error no-delivery exit). Nothing may be logged or consumed.
      await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
      await clock.advance(0);
      expect(promptAsync).toHaveBeenCalledTimes(1);
      expect(wakingLogs()).toHaveLength(0);

      // Second publication well inside the 60s window: the vetoed
      // first attempt must not have consumed the throttle, and once the
      // transport recovers the wake delivers — logging exactly one
      // waking verdict.
      failDelivery = false;
      await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 1);
      await clock.advance(0);
      expect(promptAsync).toHaveBeenCalledTimes(2);
      expect(wakingLogs()).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('no waking log unless a wake is actually delivered', async () => {
    const promptAsync = mock(async () => ({}));
    const entries: Array<{ message: string; data: unknown }> = [];
    const spy = spyOn(loggerModule, 'log').mockImplementation(
      (message: string, data?: unknown) => {
        entries.push({ message, data });
      },
    );
    let inputWait = true;
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      publicationWakeMinIntervalMs: 60_000,
      hasInputWait: (id) => id === 'p1' && inputWait,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });
    const wakingLogs = () =>
      entries.filter(
        (entry) =>
          entry.message === '[orchestrator-wake] terminal publication wake' &&
          (entry.data as { verdict?: string } | undefined)?.verdict ===
            'waking',
      );

    try {
      // Suppressed by the input wait: no wake may be logged as waking.
      await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
      await clock.advance(0);
      expect(wakingLogs()).toHaveLength(0);
      expect(promptAsync).not.toHaveBeenCalled();

      // Delivered once the wait clears: exactly one waking log line.
      inputWait = false;
      entries.length = 0;
      await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
      await clock.advance(0);
      expect(wakingLogs()).toHaveLength(1);
      expect(promptAsync).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('wakeOnTerminalPublication=false disables the wake', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      wakeOnTerminalPublication: false,
      publicationWakeMinIntervalMs: 1,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('shares the two-wake no-progress cap with the periodic scheduler', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      // 0 disables the throttle so the shared cap is the only bound.
      publicationWakeMinIntervalMs: 0,
      sessionClient: makeV2Client({
        promptAsync,
        // Both children already terminal in every snapshot: the children
        // fingerprint never changes across the three publications below.
        listChildren: [terminalChild('child-1'), terminalChild('child-2')],
      }),
    });

    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await scheduler.triggerTerminalPublicationWake('p1', 'child-2', 1);
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(2);

    // Third publication, unchanged fingerprint: the shared cap must stop it.
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 2);
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test('publication flag threads the no-work classifier; periodic wakes stay suppressed', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createPublicationScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      // 0 disables the throttle so only the classifier behavior is observed.
      publicationWakeMinIntervalMs: 0,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [terminalChild('child-1')],
      }),
    });

    // Without the publication flag, an idle parent whose children are all
    // terminal classifies 'no-work' and the wake silently no-ops.
    await scheduler.triggerTerminalPublicationWake('p1', 'child-1', 1);
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // The periodic scheduler in the same state must NOT wake: the flag is
    // exclusive to the publication path.
    await clock.advance(60_000);
    await clock.advance(60_000);
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });
});
