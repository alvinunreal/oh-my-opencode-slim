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
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isInternalInitiatorPart } from '../../utils';
import {
  INTERNAL_INITIATOR_METADATA_KEY,
  SLIM_INTERNAL_INITIATOR_MARKER,
} from '../../utils/internal-initiator';
import * as logger from '../../utils/logger';
import { createTimerHarness } from '../../utils/test-timers';
import { buildPluginInput } from '../../v2/client-shim';
import { mapV2EventToV1 } from '../../v2/event-adapter';
import { recordInternalAdmission } from '../../v2/internal-admissions';
import { createV2InterviewBridge, markerText } from '../../v2/interview-bridge';
import { createSessionPromptBridge } from '../../v2/setup';
import { SessionLifecycle } from '../session-lifecycle';
import {
  ForegroundFallbackManager,
  type ForegroundFallbackOptions,
  type ForegroundFallbackTimers,
  isFailoverError,
  isInlineFailoverError,
  isPermanentQuotaBillingError,
  isSpentQuotaError,
} from './index';

// ACCEPTANCE GAP: config() hook behaviour is not covered by CI — verify live.

// Shared session reference so our mock.module for getClient returns the
// current test's mock session without relying on this.input (which is
// undefined in tests — always set in production).
let currentMockSession: Record<string, unknown> | null = null;

afterEach(() => {
  currentMockSession = null;
  const globalSet = (globalThis as Record<symbol, Set<string>>)[
    Symbol.for('oh-my-opencode-slim.foreground-fallback.in-progress')
  ];
  globalSet?.clear();
});

// Override manager.test.ts's global mock.module for getClient. Called
// at module load AND from createMockClient so it takes effect regardless of
// test file load order.
function installGetClientMock(): void {
  mock.module('../../utils/opencode-client', () => ({
    getClient: () => ({
      session: currentMockSession ?? {
        abort: mock(() => Promise.resolve()),
        messages: mock(() => Promise.resolve({ data: [] })),
        promptAsync: mock(() => Promise.resolve()),
      },
    }),
  }));
}
installGetClientMock();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(overrides?: {
  promptAsyncImpl?: (args: unknown) => Promise<unknown>;
  messagesData?: unknown[];
  messagesImpl?: (args: unknown) => Promise<unknown>;
  getData?: unknown;
}) {
  const promptAsync = mock(async (args: unknown) => {
    if (overrides?.promptAsyncImpl) return overrides.promptAsyncImpl(args);
    return {};
  });
  const abort = mock(async () => ({}));
  const messages = mock(async (args: unknown) => {
    if (overrides?.messagesImpl) return overrides.messagesImpl(args);
    return {
      data: overrides?.messagesData ?? [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
      ],
    };
  });
  const session: Record<string, unknown> = {
    get: mock(async (args: { path: { id: string } }) => ({
      data:
        overrides && 'getData' in overrides
          ? overrides.getData
          : { id: args.path.id, agent: 'orchestrator' },
    })),
    abort,
    messages,
    promptAsync,
  };

  // Store for getClient mock
  currentMockSession = session;
  // Re-register the mock.module at test time so it survives any
  // overwrite from other test files loaded in the same process.
  installGetClientMock();

  return {
    client: {
      session,
    } as never,
    session,
    mocks: { promptAsync, abort, messages },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeChains(
  overrides?: Record<string, string[]>,
): Record<string, string[]> {
  return {
    orchestrator: [
      'anthropic/claude-opus-4-5',
      'openai/gpt-4o',
      'google/gemini-2.5-pro',
    ],
    explorer: ['openai/gpt-4o-mini', 'anthropic/claude-haiku'],
    ...overrides,
  };
}

const retryMgr = (
  ids: string[],
  onChanged?: (sessionID: string, model: string) => void,
): ForegroundFallbackManager =>
  timedManager({
    chains: { orchestrator: ids.map((id) => `test/${id}`) },
    input: { directory: '/test' } as any,
    maxRetries: 0, // Existing hook-switch tests isolate switching from host retry budgets.
    onSessionModelChanged: onChanged,
  });

const retryEvent = (
  sessionID: string,
  id: string,
  decision?: { retry: boolean; delay?: number },
) => ({
  sessionID,
  agent: 'orchestrator',
  model: { providerID: 'test', id },
  error: { message: 'rate limit' },
  decision,
});

function makeOptions(
  overrides: Partial<ForegroundFallbackOptions> = {},
): ForegroundFallbackOptions {
  const input = overrides.input ?? ({ directory: '/test' } as never);
  return {
    chains: { orchestrator: ['test/a', 'test/b', 'test/c'] },
    maxRetries: 3,
    coordinator: undefined,
    onSessionModelChanged: undefined,
    initialRetryDelayMs: 0,
    retryDelayMs: 500,
    timers: undefined,
    ...overrides,
    v2RetryEnabled: overrides.v2RetryEnabled ?? true,
    input: { ...input, hostFlavor: 'v2' },
  };
}

function makeManager({
  chain = ['test/a', 'test/b', 'test/c'],
  maxRetries = 3,
  initialRetryDelayMs = 0,
  retryDelayMs = 0,
  hostFlavor,
  onChanged,
  timers = clock,
}: {
  chain?: ReadonlyArray<string | { id: string; variant?: string }>;
  maxRetries?: number;
  initialRetryDelayMs?: number;
  retryDelayMs?: number;
  hostFlavor?: 'v2';
  onChanged?: (sessionID: string, model: string) => void;
  timers?: ForegroundFallbackTimers;
} = {}) {
  const { mocks } = createMockClient({
    messagesData: [
      {
        info: { id: 'user-message', role: 'user' },
        parts: [{ type: 'text', text: 'hello' }],
      },
    ],
  });
  return {
    manager: new ForegroundFallbackManager(
      makeOptions({
        chains: { orchestrator: chain },
        input: { directory: '/test', hostFlavor } as never,
        maxRetries: maxRetries,
        onSessionModelChanged: onChanged,
        initialRetryDelayMs: initialRetryDelayMs,
        retryDelayMs: retryDelayMs,
        timers: timers,
      }),
    ),
    mocks,
  };
}

/** Shared clock base so the boundary fixtures and expectStampSplit cannot
 *  drift apart. */
const TEST_CLOCK_BASE = 1_000_000;

/** Split time control: scheduling through the harness, observation through
 *  an independent clock so jumps fire nothing (the jest.setSystemTime /
 *  advanceTimersByTime distinction). */
function createTestClock(start = TEST_CLOCK_BASE) {
  const harness = createTimerHarness();
  let now = start;

  return {
    now: () => now,
    set: (target: number) => {
      now = target;
    },
    advance: async (ms: number) => {
      now += ms;
      await harness.advance(ms);
    },
    setTimeout: harness.setTimeout,
    clearTimeout: harness.clearTimeout,
    pending: harness.pending,
  };
}

// Per-test clock: managers wired through the timers port (makeManager /
// makeBoundaryManager default to it, raw constructions pass it explicitly)
// observe and schedule on it; it is replaced fresh for every test.
let clock: ReturnType<typeof createTestClock>;
beforeEach(() => {
  clock = createTestClock();
});

/** Ctor passthrough for tests that drive the clock. */
function timedManager(options: ForegroundFallbackOptions) {
  return new ForegroundFallbackManager(
    makeOptions({ ...options, timers: clock }),
  );
}

describe('foreground fallback redo harness', () => {
  test('FB-01: provider marks expire after 30 minutes for the session and its children', async () => {
    const { manager } = makeManager({
      chain: ['primary/a', 'backup/b', 'primary/c', 'last/d'],
      hostFlavor: 'v2',
      maxRetries: 0,
    });
    const switchModel = mock(async (_sessionID: string, _model: unknown) => {});
    const fail = (sessionID: string, model: string) => {
      const [providerID, id] = model.split('/');
      return manager.handleV2Retry(
        {
          sessionID,
          agent: 'orchestrator',
          model: { providerID, id },
          error: { type: 'provider.rate-limit', status: 429, message: '429' },
          decision: { retry: true },
        },
        switchModel,
      );
    };
    const recordedAt = clock.now();

    await fail('expiry-parent', 'primary/a');
    expect(manager.getActiveFallback('expiry-parent')).toEqual({
      model: 'backup/b',
      downProviders: new Set(['primary']),
    });
    await manager.handleEvent({
      type: 'session.execution.succeeded',
      data: { sessionID: 'expiry-parent' },
    });
    expect(manager.getActiveFallback('expiry-parent')?.downProviders).toEqual(
      new Set(['primary']),
    );
    await manager.handleEvent({
      type: 'session.created',
      properties: { info: { id: 'expiry-child', parentID: 'expiry-parent' } },
    });

    clock.set(recordedAt + 30 * 60_000 - 1);
    await fail('expiry-parent', 'backup/b');
    expect(switchModel.mock.calls.at(-1)).toEqual([
      'expiry-parent',
      { providerID: 'last', id: 'd' },
    ]);
    await fail('expiry-child', 'backup/b');
    expect(switchModel.mock.calls.at(-1)).toEqual([
      'expiry-child',
      { providerID: 'last', id: 'd' },
    ]);

    clock.set(recordedAt + 30 * 60_000);
    await fail('expiry-child', 'last/d');
    expect(switchModel.mock.calls.at(-1)).toEqual([
      'expiry-child',
      { providerID: 'primary', id: 'a' },
    ]);
    expect(manager.getActiveFallback('expiry-parent')).toEqual({
      model: 'last/d',
      downProviders: new Set(['backup']),
    });
    await fail('expiry-parent', 'last/d');
    expect(switchModel.mock.calls.at(-1)).toEqual([
      'expiry-parent',
      { providerID: 'primary', id: 'a' },
    ]);
  });
  test('T2: v2 chain walk skips providers abandoned by the session or its parent', async () => {
    const { mocks } = createMockClient();
    const manager = timedManager({
      chains: {
        orchestrator: [
          'anthropic/claude-opus-5-5',
          'openai/gpt-6.1-sol-fast',
          'anthropic/claude-sonnet-5-5',
          'opencode-go/muse-spark-1.3-contributor',
        ],
        explorer: [
          'openai/gpt-6-mini',
          'anthropic/claude-haiku-5',
          'google/gemini-3-flash',
        ],
      },
      input: { directory: '/test', hostFlavor: 'v2' } as never,
      maxRetries: 0,
      initialRetryDelayMs: 0,
      retryDelayMs: 0,
      v2RetryEnabled: true,
    });
    const switchModel = mock(async (_sessionID: string, _model: unknown) => {});
    const fail = (sessionID: string, agent: string, model: string) => {
      const [providerID, id] = model.split('/');
      return manager.handleV2Retry(
        {
          sessionID,
          agent,
          model: { providerID, id },
          error: { type: 'provider.rate-limit', status: 429, message: '429' },
          decision: { retry: true },
        },
        switchModel,
      );
    };

    await fail(
      'parent-chain-walk',
      'orchestrator',
      'anthropic/claude-opus-5-5',
    );
    expect(
      manager.getActiveFallback('parent-chain-walk')?.downProviders,
    ).toEqual(new Set(['anthropic']));
    for (const mapped of mapV2EventToV1({
      type: 'session.created',
      data: { sessionID: 'child-chain-walk', parentID: 'parent-chain-walk' },
    })) {
      await manager.handleEvent(mapped);
    }
    await fail('child-chain-walk', 'explorer', 'openai/gpt-6-mini');
    await fail('parent-chain-walk', 'orchestrator', 'openai/gpt-6.1-sol-fast');

    expect(switchModel.mock.calls).toEqual([
      ['parent-chain-walk', { providerID: 'openai', id: 'gpt-6.1-sol-fast' }],
      ['child-chain-walk', { providerID: 'google', id: 'gemini-3-flash' }],
      [
        'parent-chain-walk',
        { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor' },
      ],
    ]);
    expect(
      manager.getActiveFallback('parent-chain-walk')?.downProviders,
    ).toEqual(new Set(['anthropic', 'openai']));
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });
  test('F1: successive v2 content-filter failures walk the chain', async () => {
    createMockClient();
    const chain = [
      'anthropic/claude-opus-5-5',
      'openai/gpt-6.1-sol-fast',
      'anthropic/claude-sonnet-5-5',
      'opencode-go/muse-spark-1.3-contributor',
    ];
    const manager = timedManager({
      chains: { orchestrator: chain },
      input: { directory: '/test', hostFlavor: 'v2' } as never,
      maxRetries: 0,
      initialRetryDelayMs: 0,
      retryDelayMs: 0,
      v2RetryEnabled: true,
    });
    const sessionID = 'v2-content-filter';
    const switchModel = mock(async (_sessionID: string, _model: unknown) => {});
    const error = {
      type: 'provider.content-filter',
      message: "The response was blocked by the provider's content filter",
    };

    for (const model of [chain[2], chain[0], chain[1]]) {
      await clock.advance(6_000);
      const [providerID, id] = model.split('/');
      await manager.handleV2Retry(
        {
          sessionID,
          agent: 'orchestrator',
          model: { providerID, id },
          error,
          decision: { retry: false },
        },
        switchModel,
      );
    }

    expect(switchModel.mock.calls).toEqual([
      [sessionID, { providerID: 'anthropic', id: 'claude-opus-5-5' }],
      [sessionID, { providerID: 'openai', id: 'gpt-6.1-sol-fast' }],
      [
        sessionID,
        { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor' },
      ],
    ]);
  });
  test('G1: successful mapped v2 steps re-arm retries within one execution', async () => {
    createMockClient();
    const manager = timedManager({
      chains: {
        orchestrator: ['anthropic/claude-opus-5-5', 'openai/gpt-6.1-sol-fast'],
      },
      input: { directory: '/test', hostFlavor: 'v2' } as never,
      maxRetries: 3,
      initialRetryDelayMs: 0,
      retryDelayMs: 0,
      v2RetryEnabled: true,
    });
    const sessionID = 'v2-step-recovery';
    const switchModel = mock(async () => {});

    // One ongoing execution: each transient error is followed by a tool step.
    for (let step = 1; step <= 4; step++) {
      await clock.advance(1_000);
      await manager.handleV2Retry(
        {
          sessionID,
          agent: 'orchestrator',
          model: { providerID: 'anthropic', id: 'claude-opus-5-5' },
          error: { type: 'provider.rate-limit', status: 429, message: '429' },
          decision: { retry: true },
        },
        switchModel,
      );
      for (const mapped of mapV2EventToV1({
        type: 'session.step.ended',
        data: {
          sessionID,
          finish: 'tool-calls',
          tokens: {
            input: step * 100,
            output: step * 10,
            cache: { read: 0, write: 0 },
          },
        },
      })) {
        await manager.handleEvent(mapped);
      }
    }

    expect(switchModel).not.toHaveBeenCalled();
  });
  test('H1: v2 content-filter errors switch models without abandoning the provider', async () => {
    const { manager } = makeManager({
      chain: ['test/a', 'other/b'],
      hostFlavor: 'v2',
    });
    const sessionID = 'v2-content-policy';
    const switchModel = mock(async () => {});
    const event = {
      ...retryEvent(sessionID, 'a', { retry: false }),
      error: {
        type: 'provider.content-filter',
        message: 'Provider blocked the response',
        status: 400,
      },
    };

    await manager.handleV2Retry(event, switchModel);

    expect(switchModel).toHaveBeenCalledWith(sessionID, {
      providerID: 'other',
      id: 'b',
    });
    expect(manager.getActiveFallback(sessionID)).toEqual({
      model: 'other/b',
      downProviders: new Set(),
    });
    expect(event.decision).toEqual({ retry: true, delay: 0 });
  });
});

describe('foreground fallback redo: host retry budget', () => {
  test('v2 skips a day-long host retry wait before spending the retry budget', async () => {
    const { manager, mocks } = makeManager({ hostFlavor: 'v2' });
    const switchModel = mock(async () => {});
    const event = {
      ...retryEvent('long-host-wait-v2', 'a', {
        retry: true,
        delay: (23 * 60 + 55) * 60_000,
      }),
      error: {
        type: 'provider.rate-limit',
        status: 429,
        message:
          "This request would exceed your account's rate limit. Please try again later.",
      },
    };
    await manager.handleV2Retry(event, switchModel);

    expect(switchModel).toHaveBeenCalledWith(event.sessionID, {
      providerID: 'test',
      id: 'b',
    });
    expect(event.decision).toEqual({ retry: true, delay: 0 });
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });
  test.each([
    { retry: true, maxRetries: 0 },
    { retry: true, maxRetries: 2 },
    { retry: false, maxRetries: 0 },
    { retry: false, maxRetries: 2 },
  ])(
    'T6: v2 host decision retry=$retry with budget $maxRetries',
    async ({ retry, maxRetries }) => {
      const sid = `v2-${retry}-${maxRetries}`;
      const { manager, mocks } = makeManager({ maxRetries });
      const switchModel = mock(async () => {});
      const decision = { retry, delay: 77 };
      const first = retryEvent(sid, 'a', decision);
      if (retry) {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          await manager.handleV2Retry(
            retryEvent(sid, 'a', decision),
            switchModel,
          );
          expect(switchModel).not.toHaveBeenCalled();
          expect(decision).toEqual({ retry: true, delay: 77 });
        }
      }
      await manager.handleV2Retry(first, switchModel);
      expect(switchModel).toHaveBeenCalledWith(sid, {
        providerID: 'test',
        id: 'b',
      });
      expect(first.decision).toEqual({ retry: true, delay: 0 });

      const next = retryEvent(sid, 'b', { retry: true, delay: 77 });
      await manager.handleV2Retry(next, switchModel);
      if (retry || maxRetries === 0) {
        expect(switchModel).toHaveBeenCalledTimes(2);
        expect(switchModel).toHaveBeenLastCalledWith(sid, {
          providerID: 'test',
          id: 'c',
        });
      } else {
        expect(switchModel).toHaveBeenCalledTimes(1);
        expect(next.decision).toEqual({ retry: true, delay: 77 });
      }
      expect(mocks.abort).not.toHaveBeenCalled();
      expect(mocks.promptAsync).not.toHaveBeenCalled();
    },
  );

  test('T6: v2 primary re-emission after exhaustion earns a fresh budget', async () => {
    const sid = 'v2-fresh-descent';
    const { manager } = makeManager({
      chain: ['test/a', 'test/b'],
      maxRetries: 2,
    });
    const switchModel = mock(async () => {});
    for (let attempt = 0; attempt < 2; attempt++)
      await manager.handleV2Retry(
        retryEvent(sid, 'a', { retry: true }),
        switchModel,
      );
    expect(switchModel).not.toHaveBeenCalled();
    for (const id of ['a', 'b'])
      await manager.handleV2Retry(
        retryEvent(sid, id, { retry: false }),
        switchModel,
      );
    const exhausted = retryEvent(sid, 'b', { retry: false });
    await manager.handleV2Retry(exhausted, switchModel);
    expect(exhausted.decision).toEqual({ retry: false });
    expect(switchModel).toHaveBeenCalledTimes(2);

    manager.registerSessionAgent(sid, 'orchestrator');
    manager.noteExternalTurn(sid, 'test/a');
    for (let attempt = 0; attempt < 2; attempt++) {
      const host = retryEvent(sid, 'a', { retry: true, delay: 77 });
      await manager.handleV2Retry(host, switchModel);
      expect(host.decision).toEqual({ retry: true, delay: 77 });
      expect(switchModel).toHaveBeenCalledTimes(2);
    }
    await manager.handleV2Retry(
      retryEvent(sid, 'a', { retry: true }),
      switchModel,
    );
    expect(switchModel).toHaveBeenCalledTimes(3);

    const single = makeManager({ chain: ['test/a'], maxRetries: 1 }).manager;
    const singleSwitch = mock(async () => {});
    await single.handleV2Retry(
      retryEvent('single-exhausted', 'a', { retry: false }),
      singleSwitch,
    );
    single.pinSessionChains('single-exhausted', { orchestrator: [] }, true);
    const disabled = retryEvent('single-exhausted', 'a', { retry: true });
    await single.handleV2Retry(disabled, singleSwitch);
    expect(disabled.decision).toEqual({ retry: true });
    expect(singleSwitch).not.toHaveBeenCalled();

    const spent = makeManager({
      chain: ['p1/a', 'p2/b', 'p3/c'],
      maxRetries: 1,
    }).manager;
    const spentSwitch = mock(async () => {});
    await spent.handleV2Retry(
      {
        sessionID: 'spent-primary',
        agent: 'orchestrator',
        model: { providerID: 'p1', id: 'a' },
        error: { message: 'The usage limit has been reached' },
        decision: { retry: false },
      },
      spentSwitch,
    );
    spent.noteExternalTurn('spent-primary', 'p1/a');
    const retry = {
      sessionID: 'spent-primary',
      agent: 'orchestrator',
      model: { providerID: 'p1', id: 'a' },
      error: { message: 'rate limit' },
      decision: { retry: true },
    };
    await spent.handleV2Retry(retry, spentSwitch);
    expect(retry.decision).toEqual({ retry: true });
    expect(spentSwitch).toHaveBeenCalledTimes(1);
  });
  test('v2 steering disabled leaves the retry hook inert', async () => {
    const mgr = timedManager({
      chains: makeChains({ orchestrator: ['test/a', 'test/b', 'test/c'] }),
      input: { directory: '/test', hostFlavor: 'v2' } as never,
      maxRetries: 0,
      initialRetryDelayMs: 0,
      retryDelayMs: 0,
      v2RetryEnabled: false,
    });
    const switchModel = mock(async () => ({}));
    const event = retryEvent('v2-inert', 'a', { retry: true, delay: 77 });
    await mgr.handleV2Retry(event, switchModel);
    expect(switchModel).not.toHaveBeenCalled();
    expect(event.decision).toEqual({ retry: true, delay: 77 });
  });
  test('v2 retry hook logs every failure and its final decision', async () => {
    const captured: Array<{ message: string; data: unknown }> = [];
    const capture = spyOn(logger, 'log').mockImplementation(
      (message: string, data?: unknown) => {
        captured.push({ message, data });
      },
    );
    try {
      const { manager: mgr } = makeManager({ hostFlavor: 'v2', maxRetries: 2 });
      const switchModel = mock(async () => ({}));
      const secret = 'sk-secret0123456789abcdefghijklmnopqrstuv';
      const event = {
        ...retryEvent('v2-notice', 'a', { retry: true, delay: 77 }),
        error: {
          type: 'provider.rate-limit',
          status: 429,
          message: `${'rate limit '.repeat(26)}Bearer ${secret}`,
          retryAfterMs: 1_250,
        },
      };
      await mgr.handleV2Retry(event, switchModel);
      await mgr.handleV2Retry(event, switchModel);
      await mgr.handleV2Retry(
        {
          ...retryEvent('v2-notice', 'a', { retry: false }),
          error: { type: 'provider.auth', status: 403, message: 'Forbidden' },
        },
        switchModel,
      );
      (mgr as any).sessionRetryEnabled.set('v2-disabled-notice', false);
      await mgr.handleV2Retry(
        { ...event, sessionID: 'v2-disabled-notice' },
        switchModel,
      );
      const notices = captured.filter(
        ({ message }) =>
          message === '[foreground-fallback] v2 retry hook observed',
      );
      expect(notices).toHaveLength(4);
      expect(notices[0]?.data).toMatchObject({
        type: 'provider.rate-limit',
        status: 429,
        retryAfterMs: 1_250,
        decision: { retry: true, delay: 77 },
      });
      const loggedMessage = (
        notices[0]?.data as { message: string } | undefined
      )?.message;
      expect(loggedMessage?.length).toBeLessThanOrEqual(300);
      expect(loggedMessage).not.toContain(secret.slice(0, 11));
      expect(notices[2]?.data).toMatchObject({
        type: 'provider.auth',
        status: 403,
        message: 'Forbidden',
        decision: { retry: true, delay: 0 },
      });
      expect(notices[3]?.data).toMatchObject({ steering: false });
    } finally {
      capture.mockRestore();
    }
  });
  test('v2 steering ignores the configured initial delay', async () => {
    const mgr = timedManager({
      chains: makeChains({ orchestrator: ['test/a', 'test/b', 'test/c'] }),
      input: { directory: '/test', hostFlavor: 'v2' } as never,
      maxRetries: 0,
      initialRetryDelayMs: 250,
      // initialRetryDelayMs — no replay to delay on the steering path
      retryDelayMs: 0,
    });
    const switchModel = mock(async () => ({}));
    const event = retryEvent('v2-delay', 'a', { retry: true, delay: 77 });
    await mgr.handleV2Retry(event, switchModel);
    // No deferred same-model retry: the first failover event switches.
    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(switchModel).toHaveBeenCalledWith('v2-delay', {
      providerID: 'test',
      id: 'b',
    });
    expect(event.decision).toEqual({ retry: true, delay: 0 });
  });
  test('v2 bookkeeping resets descent state without replay interventions', async () => {
    const mgr = timedManager({
      chains: makeChains({ orchestrator: ['test/a', 'test/b', 'test/c'] }),
      input: { directory: '/test', hostFlavor: 'v2' } as never,
      maxRetries: 0,
      initialRetryDelayMs: 0,
      retryDelayMs: 0,
      v2RetryEnabled: true,
    });
    const switchModel = mock(async () => ({}));
    // First descent: a -> b.
    await mgr.handleV2Retry(
      retryEvent('v2-reset', 'a', { retry: true }),
      switchModel,
    );
    expect(switchModel).toHaveBeenCalledTimes(1);
    // A successful host execution resets the descent bookkeeping.
    for (const mapped of mapV2EventToV1({
      type: 'session.execution.succeeded',
      data: { sessionID: 'v2-reset' },
    })) {
      await mgr.handleEvent(mapped);
    }
    // The next failure on the primary starts a fresh descent: b is
    // available again instead of being skipped for c.
    await mgr.handleV2Retry(
      retryEvent('v2-reset', 'a', { retry: true }),
      switchModel,
    );
    expect(switchModel).toHaveBeenCalledTimes(2);
    expect(switchModel).toHaveBeenLastCalledWith('v2-reset', {
      providerID: 'test',
      id: 'b',
    });
  });
  test('T9: v2 retry hook switches with the fallback entry variant', async () => {
    const { manager } = makeManager({
      chain: ['test/a', { id: 'test/b', variant: 'fast' }],
    });
    const switchModel = mock(async () => {});
    await manager.handleV2Retry(
      retryEvent('variant-hook', 'a', { retry: false }),
      switchModel,
    );
    expect(switchModel).toHaveBeenCalledWith('variant-hook', {
      providerID: 'test',
      id: 'b',
      variant: 'fast',
    });
  });
});

describe('ForegroundFallbackManager v2 content-filter refusal', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function fixture(options?: {
    parentID?: string;
    chains?: Record<string, Array<string | { id: string; variant: string }>>;
    switchModel?: (sessionID: string, model: unknown) => Promise<unknown>;
    promptAsyncImpl?: (args: unknown) => Promise<unknown>;
    messagesData?: unknown[];
    messagesImpl?: (args: unknown) => Promise<unknown>;
    retryEnabled?: boolean;
    maxRetries?: number;
    timers?: ReturnType<typeof createTimerHarness>;
  }) {
    const durable = { providerID: 'test', id: 'a', variant: 'source' };
    const info: { model?: typeof durable; parentID?: string; agent?: string } =
      {
        model: durable,
        parentID: options?.parentID,
        agent: 'orchestrator',
      };
    const { client, mocks } = createMockClient({
      getData: info,
      promptAsyncImpl: options?.promptAsyncImpl,
      messagesData: options?.messagesData,
      messagesImpl: options?.messagesImpl,
    });
    const switchModel = mock(
      options?.switchModel ??
        (async (_sessionID: string, _model: unknown) => {}),
    );
    const onChanged = mock();
    const manager = new ForegroundFallbackManager(
      makeOptions({
        chains: options?.chains ?? {
          orchestrator: ['test/a', { id: 'test/b', variant: 'high' }],
        },
        input: {
          directory: '/test',
          hostFlavor: 'v2',
          client,
          experimental_v2: { switchModel },
        } as never,
        maxRetries: options?.maxRetries ?? 0,
        onSessionModelChanged: onChanged,
        initialRetryDelayMs: 0,
        retryDelayMs: 0,
        v2RetryEnabled: options?.retryEnabled ?? true,
        timers: options?.timers,
      }),
    );
    return { manager, mocks, switchModel, onChanged, durable, info };
  }

  const started = (id: string, model = 'a', message = 'assistant-1') => ({
    type: 'session.step.started',
    data: {
      sessionID: id,
      assistantMessageID: message,
      agent: 'orchestrator',
      model: {
        providerID: 'test',
        id: model,
        ...(model === 'a' ? { variant: 'source' } : { variant: 'high' }),
      },
    },
  });
  const failed = (
    id: string,
    message = 'assistant-1',
    finish = 'content-filter',
  ) => ({
    type: 'session.step.failed',
    data: {
      sessionID: id,
      assistantMessageID: message,
      finish,
      rawFinish: 'refusal',
      error: {
        type: 'provider.content-filter',
        message: 'Provider blocked the response',
      },
    },
  });
  const settle = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };

  const noRoute = (sessionID: string, model = 'test/a') => ({
    type: 'session.execution.failed',
    created: Date.now(),
    data: {
      sessionID,
      error: {
        type: 'provider.no-route',
        message: `Model unavailable: ${model}`,
      },
    },
  });
  function installV2History(history: Array<Record<string, unknown>>) {
    const context = mock(async () => history);
    const messages = mock(async ({ limit }: { limit: number }) => ({
      data: history.slice(-limit).reverse(),
    }));
    const input = buildPluginInput({ session: { context, messages } } as never);
    if (!currentMockSession) throw new Error('fixture session missing');
    currentMockSession.messages = (
      input.client as { session: { messages: unknown } }
    ).session.messages;
    return { context, messages };
  }

  test('promptAsync is invoked bound: a this-reading implementation must not throw', async () => {
    const { manager } = fixture();
    const session = currentMockSession;
    if (!session) throw new Error('fixture session missing');
    const receivers: unknown[] = [];
    session._client = {};
    session.promptAsync = async function (this: { _client: unknown }) {
      receivers.push(this);
      void this._client;
      return {};
    };
    installV2History([
      { id: 'user', type: 'user', time: { created: Date.now() - 1 } },
    ]);

    for (const event of mapV2EventToV1(noRoute('sess-unbound')))
      await manager.handleEvent(event);
    await settle();

    expect(receivers).toEqual([session]);
    manager.dispose();
  });

  test('v2 no-route continues a root after a long compacted turn', async () => {
    const created = Date.now() - 60_000;
    const history = [
      {
        id: 'compact',
        type: 'compaction',
        status: 'completed',
        time: { created },
      },
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `step-${i}`,
        type: 'assistant',
        time: { created: created + i + 1 },
      })),
    ];
    const { manager, mocks, switchModel } = fixture();
    const host = installV2History(history);
    for (const event of mapV2EventToV1(noRoute('root-no-route')))
      await manager.handleEvent(event);
    await settle();
    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(manager.getActiveFallback('root-no-route')?.model).toBe('test/b');
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
      body: {
        parts: [
          expect.objectContaining({
            text: expect.stringContaining('model was unavailable'),
          }),
        ],
      },
    });
    expect(host.context).toHaveBeenCalled();
    expect(host.messages).not.toHaveBeenCalled();
    manager.dispose();
  });

  test('v2 root no-route falls back to the bounded tail if context fails', async () => {
    const { manager, mocks, switchModel } = fixture();
    const host = installV2History([
      { id: 'user', type: 'user', time: { created: Date.now() - 1 } },
    ]);
    host.context.mockImplementationOnce(async () => {
      throw new Error('context unavailable');
    });
    for (const event of mapV2EventToV1(noRoute('root-tail')))
      await manager.handleEvent(event);
    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(host.messages).toHaveBeenCalledWith({
      sessionID: 'root-tail',
      limit: 50,
      order: 'desc',
    });
    manager.dispose();
  });

  test('v2 no-route falls back when the session has no selected model', async () => {
    const { manager, mocks, switchModel, info } = fixture();
    info.model = undefined;
    installV2History([
      {
        id: 'user',
        type: 'user',
        agent: 'orchestrator',
        time: { created: Date.now() - 1 },
      },
    ]);
    const event = noRoute('no-selected-model');
    event.data.error.message =
      'No model is available for session no-selected-model';
    for (const mapped of mapV2EventToV1(event))
      await manager.handleEvent(mapped);
    expect(switchModel).toHaveBeenCalledWith('no-selected-model', {
      providerID: 'test',
      id: 'b',
      variant: 'high',
    });
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  test('v2 native child no-route continues in place without a parent completion write', async () => {
    const { manager, mocks, switchModel } = fixture({ parentID: 'parent' });
    installV2History([
      { id: 'user', type: 'user', time: { created: Date.now() - 1 } },
    ]);
    await manager.handleEvent({
      type: 'session.created',
      properties: { info: { id: 'native-child', parentID: 'parent' } },
    });
    for (const event of mapV2EventToV1(noRoute('native-child')))
      await manager.handleEvent(event);
    await settle();
    expect(switchModel).toHaveBeenCalledWith('native-child', {
      providerID: 'test',
      id: 'b',
      variant: 'high',
    });
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
      path: { id: 'native-child' },
      body: {
        agent: 'orchestrator',
        parts: [
          expect.objectContaining({
            text: expect.stringContaining('selected model was unavailable'),
          }),
        ],
      },
    });

    // A stale previous-period terminal and its synthesized idle must not
    // produce a synthetic parent completion write: the continuation run
    // only ever prompts the child itself.
    for (const event of mapV2EventToV1({
      type: 'session.execution.succeeded',
      created: Date.now() + 1,
      data: { sessionID: 'native-child' },
    }))
      await manager.handleEvent(event);
    await settle();
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(
      mocks.promptAsync.mock.calls.map(
        ([input]) => (input as { path?: { id?: string } }).path?.id,
      ),
    ).toEqual(['native-child']);
    manager.dispose();
  });

  test('a recovered interview refusal reports only the continued turn', async () => {
    jest.useRealTimers();
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'interview-refusal-'),
    );
    const { manager, mocks } = fixture();
    const synthetic = mock(async (_input: Record<string, unknown>) => ({}));
    const bridge = createV2InterviewBridge(
      { location: { directory }, session: { synthetic } } as never,
      { outputFolder: 'interview', autoOpenBrowser: false } as never,
      {
        refusalOutcome: (id, messageID) =>
          manager.pendingRefusalOutcome(id, messageID),
      },
    );
    const sessionID = 'interview-refusal';
    try {
      await bridge.handleEvent({
        type: 'session.execution.started',
        data: { sessionID },
      });
      await bridge.handleContext({
        sessionID,
        agent: 'orchestrator',
        model: {},
        system: [],
        tools: {},
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: markerText('Test idea') }],
          },
        ],
      });
      await manager.handleEvent(started(sessionID));
      await bridge.handleEvent(failed(sessionID));
      await manager.handleEvent(failed(sessionID));
      await bridge.handleEvent({
        type: 'session.execution.failed',
        data: { sessionID },
      });
      expect(
        await manager.pendingRefusalOutcome(sessionID, 'assistant-1'),
      ).toBe('test/b');
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
      await bridge.handleEvent({
        type: 'session.execution.started',
        data: { sessionID },
      });
      expect(
        (
          await bridge.service.submitState(sessionID, {
            summary: 'Spec',
            questions: [],
          })
        ).ok,
      ).toBe(true);
      await bridge.handleEvent({
        type: 'session.execution.succeeded',
        data: { sessionID },
      });
      const notices = synthetic.mock.calls.map(([input]) =>
        String(input.text ?? ''),
      );
      expect(
        notices.filter((text) => text.includes('Interview update failed')),
      ).toEqual([]);
      expect(
        notices.filter((text) => text.includes('Spec updated')),
      ).toHaveLength(1);
    } finally {
      await bridge.dispose();
      manager.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('v2 request rejections survive a successful tool step on the fallback', async () => {
    const { manager, switchModel } = fixture({
      chains: { orchestrator: ['test/a', 'test/b', 'test/c'] },
    });
    const sessionID = 'request-rejection-v2';
    await manager.handleEvent(started(sessionID));
    await manager.handleEvent(failed(sessionID));
    await settle();
    await manager.handleEvent({
      type: 'session.step.ended',
      data: { sessionID, finish: 'tool-calls' },
    });
    await manager.handleV2Retry(
      {
        sessionID,
        agent: 'orchestrator',
        model: { providerID: 'test', id: 'b' },
        error: { type: 'provider.invalid-request', message: 'cyber_policy' },
        decision: { retry: false },
      },
      switchModel,
    );
    expect(switchModel.mock.calls.map(([, model]) => model)).toEqual([
      { providerID: 'test', id: 'b' },
      { providerID: 'test', id: 'c' },
    ]);
  });

  test('v2 retryable cyber policy errors switch without consuming the host retry budget', async () => {
    const { manager, switchModel } = fixture({
      chains: { orchestrator: ['test/a', 'test/b', 'test/c'] },
      maxRetries: 1,
    });
    const sessionID = 'policy-retry-budget-v2';
    const policy = {
      sessionID,
      agent: 'orchestrator',
      model: { providerID: 'test', id: 'a' },
      error: { type: 'provider.transport', message: 'cyber_policy' },
      decision: { retry: true, delay: 2_000 },
    };
    await manager.handleV2Retry(policy, switchModel);
    expect(switchModel.mock.calls.map(([, model]) => model)).toEqual([
      { providerID: 'test', id: 'b' },
    ]);
    expect(policy.decision).toEqual({ retry: true, delay: 0 });

    const transport = {
      sessionID,
      agent: 'orchestrator',
      model: { providerID: 'test', id: 'b' },
      error: { type: 'provider.transport', message: 'socket hang up' },
      decision: { retry: true, delay: 2_000 },
    };
    await manager.handleV2Retry(transport, switchModel);
    expect(switchModel).toHaveBeenCalledTimes(1);
    await manager.handleV2Retry(transport, switchModel);
    expect(switchModel.mock.calls.map(([, model]) => model)).toEqual([
      { providerID: 'test', id: 'b' },
      { providerID: 'test', id: 'c' },
    ]);
  });

  test('v2 external prompt makes request-rejected models selectable again', async () => {
    const { manager, switchModel } = fixture({
      chains: { orchestrator: ['test/a', 'test/b', 'test/c'] },
    });
    const sessionID = 'new-prompt-request-rejection-v2';
    await manager.handleEvent(started(sessionID));
    await manager.handleEvent(failed(sessionID));
    await settle();
    await manager.handleEvent({
      type: 'session.step.ended',
      data: { sessionID, finish: 'tool-calls' },
    });
    const policy = (id: string) => ({
      sessionID,
      agent: 'orchestrator',
      model: { providerID: 'test', id },
      error: { type: 'provider.invalid-request', message: 'cyber_policy' },
      decision: { retry: false },
    });
    await manager.handleV2Retry(policy('b'), switchModel);
    await manager.handleEvent({
      type: 'session.step.ended',
      data: { sessionID, finish: 'stop' },
    });
    manager.noteV2Prompt(sessionID);
    await manager.handleV2Retry(policy('c'), switchModel);
    expect(switchModel.mock.calls.map(([, model]) => model)).toEqual([
      { providerID: 'test', id: 'b' },
      { providerID: 'test', id: 'c' },
      { providerID: 'test', id: 'a' },
    ]);
  });

  test('v2 refusal continuation names the refused step agent', async () => {
    const { manager, mocks } = fixture();
    await manager.handleEvent(started('agent'));
    await manager.handleEvent(failed('agent'));
    await settle();
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
      body: { agent: 'orchestrator' },
    });
  });

  test('v2 refusal reports a failed switch without implying a retry hook', async () => {
    const logSpy = spyOn(logger, 'log').mockImplementation(() => {});
    try {
      const { manager } = fixture({
        switchModel: async () => {
          throw new Error('denied');
        },
      });
      await manager.handleEvent(started('failed-log'));
      await manager.handleEvent(failed('failed-log'));
      await settle();
      expect(logSpy).toHaveBeenCalledWith(
        '[foreground-fallback] v2 model switch failed',
        expect.objectContaining({ sessionID: 'failed-log' }),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  test('v2 refusal consumes one step and accepts the next distinct step', async () => {
    const { manager, mocks, switchModel, durable } = fixture();
    await manager.handleEvent(started('consume'));
    await manager.handleEvent(failed('consume'));
    await settle();
    await manager.handleEvent(failed('consume'));
    await settle();
    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    durable.id = 'b';
    durable.variant = 'high';
    await manager.handleEvent(started('consume', 'b', 'assistant-2'));
    await manager.handleEvent(failed('consume'));
    await settle();
    expect(switchModel).toHaveBeenCalledTimes(1);
    await manager.handleEvent(failed('consume', 'assistant-2'));
    await settle();
    expect(switchModel).toHaveBeenCalledTimes(2);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
  });

  test('v2 refusal does not race a pending retry-hook switch', async () => {
    const pending = deferred<void>();
    const { manager, mocks, switchModel } = fixture({
      switchModel: () => pending.promise,
    });
    await manager.handleEvent(started('retry-race'));
    const retry = manager.handleV2Retry(
      retryEvent('retry-race', 'a', { retry: false }),
      switchModel,
    );
    try {
      await settle();
      expect(switchModel).toHaveBeenCalledTimes(1);
      await manager.handleEvent(failed('retry-race'));
      await settle();
      expect(switchModel).toHaveBeenCalledTimes(1);
      expect(mocks.promptAsync).not.toHaveBeenCalled();
    } finally {
      pending.resolve();
      await retry;
      await settle();
    }
  });

  test('v2 refusal from a tried model does not poison a later retry-hook fallback', async () => {
    const { manager, mocks, switchModel, durable } = fixture();
    await manager.handleV2Retry(
      retryEvent('late-refusal', 'a', { retry: false }),
      switchModel,
    );
    durable.id = 'b';
    durable.variant = 'high';
    await manager.handleEvent(started('late-refusal'));
    await manager.handleEvent(failed('late-refusal'));
    expect(manager.isFallbackInProgress('late-refusal')).toBe(false);
    await settle();
    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).not.toHaveBeenCalled();
    const retry = retryEvent('late-refusal', 'b', { retry: false });
    await manager.handleV2Retry(retry, switchModel);
    expect(switchModel).toHaveBeenCalledTimes(2);
    expect(retry.decision).toEqual({ retry: true, delay: 0 });
  });

  test('v2 child refusal with no chain does not delay terminal bookkeeping', async () => {
    const { manager, mocks, switchModel } = fixture({
      parentID: 'parent',
      chains: { orchestrator: [] },
    });
    const get = spyOn(currentMockSession as any, 'get');
    await manager.handleEvent({
      type: 'session.created',
      properties: { info: { id: 'no-chain-child', parentID: 'parent' } },
    });
    await manager.handleEvent(started('no-chain-child'));
    await manager.handleEvent(failed('no-chain-child'));
    await settle();
    expect(get).not.toHaveBeenCalled();
    expect(manager.isFallbackInProgress('no-chain-child')).toBe(false);
    expect(switchModel).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('v2 stale durable selection does not overwrite the observed session model', async () => {
    const { manager, mocks, switchModel, durable } = fixture();
    durable.id = 'b';
    durable.variant = 'high';
    manager.noteExternalTurn('stale-model', 'test/b');
    await manager.handleEvent(started('stale-model'));
    await manager.handleEvent(failed('stale-model'));
    await settle();
    expect(switchModel).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('v2 refusal from a step predating an external prompt neither switches nor continues', async () => {
    const { manager, mocks, switchModel } = fixture();
    await manager.handleEvent(started('old-step'));
    manager.noteV2Prompt('old-step');
    await manager.handleEvent(failed('old-step'));
    await settle();
    expect(switchModel).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('v2 content-filter ignores a failure before step start', async () => {
    const { manager, switchModel } = fixture();
    await manager.handleEvent(failed('root'));
    await settle();
    expect(switchModel).not.toHaveBeenCalled();
  });

  test('v2 content-filter ignores a failure for a different step', async () => {
    const { manager, switchModel } = fixture();
    await manager.handleEvent(started('root'));
    await manager.handleEvent(failed('root', 'other'));
    await settle();
    expect(switchModel).not.toHaveBeenCalled();
  });

  test('v2 content-filter ignores other step finishes', async () => {
    const { manager, switchModel } = fixture();
    await manager.handleEvent(started('root'));
    await manager.handleEvent(failed('root', 'assistant-1', ''));
    await settle();
    expect(switchModel).not.toHaveBeenCalled();
  });

  test('v2 content-filter switches to the configured fallback variant', async () => {
    const { manager, switchModel } = fixture();
    await manager.handleEvent(started('root'));
    await manager.handleEvent(failed('root'));
    await settle();
    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(switchModel).toHaveBeenCalledWith('root', {
      providerID: 'test',
      id: 'b',
      variant: 'high',
    });
  });

  test('v2 content-filter projects the confirmed agent and variant', async () => {
    const { manager, onChanged } = fixture();
    await manager.handleEvent(started('root'));
    await manager.handleEvent(failed('root'));
    await settle();
    expect(onChanged).toHaveBeenCalledWith('root', 'test/b', {
      agentName: 'orchestrator',
      variant: 'high',
    });
  });

  test('v2 content-filter does not mark the provider down', async () => {
    const { manager } = fixture();
    await manager.handleEvent(started('root'));
    await manager.handleEvent(failed('root'));
    await settle();
    expect(manager.getActiveFallback('root')?.downProviders.size).toBe(0);
  });

  test('v2 content-filter continuation is internal and does not override the model', async () => {
    const { manager, mocks } = fixture();
    await manager.handleEvent(started('root'));
    await manager.handleEvent(failed('root'));
    await settle();
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const request = mocks.promptAsync.mock.calls[0]?.[0] as {
      body: { parts: unknown[]; model?: unknown };
    };
    expect(request.body.model).toBeUndefined();
    expect(isInternalInitiatorPart(request.body.parts[0])).toBe(true);
  });

  test('v2 content-filter remains in progress until continuation admission settles', async () => {
    const admission = deferred<void>();
    const { manager } = fixture({ promptAsyncImpl: () => admission.promise });
    await manager.handleEvent(started('root'));
    await manager.handleEvent(failed('root'));
    await settle();
    expect(manager.isFallbackInProgress('root')).toBe(true);
    admission.resolve();
    await settle();
    expect(manager.isFallbackInProgress('root')).toBe(false);
  });

  test('v2 content-filter child continues in place', async () => {
    const { manager, mocks, switchModel } = fixture({ parentID: 'parent' });
    await manager.handleEvent(started('child'));
    await manager.handleEvent(failed('child'));
    await settle();
    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
      path: { id: 'child' },
    });
  });

  test('refusal recovery survives rejected idle until continuation idle', async () => {
    const switching = deferred<void>();
    const { manager, switchModel } = fixture({
      parentID: 'parent',
      switchModel: () => switching.promise,
    });
    await manager.handleEvent(started('recovery-child'));
    await manager.handleEvent(failed('recovery-child'));
    await settle();
    expect(switchModel).toHaveBeenCalledTimes(1);
    await manager.handleEvent({
      type: 'session.status',
      properties: { sessionID: 'recovery-child', status: { type: 'idle' } },
    });
    expect(manager.refusalRecovery('recovery-child')).toBeDefined();
    switching.resolve();
    await settle();
    expect(await manager.refusalRecovery('recovery-child')?.model).toBe(
      'test/b',
    );
    await manager.handleEvent({
      type: 'session.status',
      properties: { sessionID: 'recovery-child', status: { type: 'idle' } },
    });
    expect(manager.refusalRecovery('recovery-child')).toBeDefined();
    await manager.handleEvent({
      type: 'session.status',
      properties: { sessionID: 'recovery-child', status: { type: 'busy' } },
    });
    await manager.handleEvent({
      type: 'session.status',
      properties: { sessionID: 'recovery-child', status: { type: 'idle' } },
    });
    expect(manager.refusalRecovery('recovery-child')).toBeUndefined();
    manager.dispose();
  });

  test('an undefined refusal decision remains until idle', async () => {
    const { manager } = fixture({ chains: { orchestrator: ['test/a'] } });
    await manager.handleEvent(started('no-fallback'));
    await manager.handleEvent(failed('no-fallback'));
    await settle();
    const recovery = manager.refusalRecovery('no-fallback');
    expect(recovery).toBeDefined();
    expect(await recovery?.model).toBeUndefined();
    await manager.handleEvent({
      type: 'session.status',
      properties: { sessionID: 'no-fallback', status: { type: 'idle' } },
    });
    expect(manager.refusalRecovery('no-fallback')).toBeUndefined();
    manager.dispose();
  });

  test('refusal recovery decision has a two-second fake-timer bound', async () => {
    const timers = createTimerHarness();
    const pending = deferred<void>();
    const { manager } = fixture({
      timers,
      promptAsyncImpl: () => pending.promise,
    });
    await manager.handleEvent(started('recovery-timeout'));
    await manager.handleEvent(failed('recovery-timeout'));
    await settle();
    const recovery = manager.refusalRecovery('recovery-timeout');
    expect(recovery).toBeDefined();
    const model = recovery?.model;
    let settled = false;
    void model?.then(() => {
      settled = true;
    });
    await timers.advance(2_000);
    expect(settled).toBe(true);
    expect(await model).toBeUndefined();
    pending.resolve();
    await settle();
    manager.dispose();
  });

  test('v2 content-filter uses the step model when the session has no explicit model', async () => {
    const { manager, mocks, switchModel, info } = fixture();
    delete info.model;
    info.agent = 'explorer';
    await manager.handleEvent(started('implicit'));
    await manager.handleEvent(failed('implicit'));
    await settle();
    expect(switchModel).not.toHaveBeenCalled();
    info.agent = 'orchestrator';
    await manager.handleEvent(started('implicit', 'a', 'assistant-2'));
    await manager.handleEvent(failed('implicit', 'assistant-2'));
    await settle();
    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('v2 content-filter matches the host default variant to an unpinned durable selection', async () => {
    const { manager, mocks, switchModel, durable } = fixture();
    (durable as { variant?: string }).variant = undefined;
    const start = started('default');
    start.data.model.variant = 'default';
    await manager.handleEvent(start);
    await manager.handleEvent(failed('default'));
    await settle();
    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('v2 content-filter refuses a stale durable variant then handles the current step', async () => {
    const { manager, mocks, switchModel, durable } = fixture();
    durable.variant = 'newer';
    await manager.handleEvent(started('stale'));
    await manager.handleEvent(failed('stale'));
    await settle();
    expect(switchModel).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();
    durable.variant = 'source';
    await manager.handleEvent(started('stale', 'a', 'assistant-2'));
    await manager.handleEvent(failed('stale', 'assistant-2'));
    await settle();
    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('v2 content-filter does not continue over a newer external prompt', async () => {
    const pending = deferred<void>();
    const { manager, mocks, switchModel } = fixture({
      switchModel: () => pending.promise,
    });
    await manager.handleEvent(started('epoch'));
    await manager.handleEvent(failed('epoch'));
    await settle();
    expect(switchModel).toHaveBeenCalledTimes(1);
    manager.noteV2Prompt('epoch');
    pending.resolve();
    await settle();
    expect(manager.getActiveFallback('epoch')?.model).toBe('test/b');
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('v2 content-filter rejected switch leaves its target available to the next step', async () => {
    let calls = 0;
    const { manager, mocks, switchModel } = fixture({
      switchModel: async () => {
        if (++calls === 1) throw new Error('denied');
      },
    });
    await manager.handleEvent(started('retry'));
    await manager.handleEvent(failed('retry'));
    await settle();
    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).not.toHaveBeenCalled();
    await manager.handleEvent(started('retry', 'a', 'assistant-2'));
    await manager.handleEvent(failed('retry', 'assistant-2'));
    await settle();
    expect(switchModel).toHaveBeenCalledTimes(2);
    expect(switchModel.mock.calls[1]?.[1]).toEqual({
      providerID: 'test',
      id: 'b',
      variant: 'high',
    });
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('v2 content-filter keeps the existing sticky retry and exhaustion policy', async () => {
    const { manager, mocks, switchModel, durable } = fixture();
    await manager.handleEvent(started('exhaust'));
    await manager.handleEvent(failed('exhaust'));
    await settle();
    durable.id = 'b';
    durable.variant = 'high';
    await manager.handleEvent(started('exhaust', 'b', 'assistant-2'));
    await manager.handleEvent(failed('exhaust', 'assistant-2'));
    await settle();
    await manager.handleEvent(started('exhaust', 'b', 'assistant-3'));
    await manager.handleEvent(failed('exhaust', 'assistant-3'));
    await settle();
    expect(switchModel).toHaveBeenCalledTimes(2);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
  });
});

describe('ForegroundFallbackManager v2 retry hook', () => {
  test('shows a toast when fallback switches models on a transient error', async () => {
    const showToast = mock(async (_args: unknown) => ({}));
    const manager = new ForegroundFallbackManager(
      makeOptions({
        chains: makeChains(),
        input: {
          directory: '/test',
          client: { tui: { showToast } },
        } as never,
        maxRetries: 0,
      }),
    );
    const switchModel = mock(async () => {});
    await manager.handleV2Retry(
      {
        sessionID: 'sess-1',
        agent: 'orchestrator',
        model: { providerID: 'anthropic', id: 'claude-opus-4-5' },
        error: { statusCode: 429, message: 'Rate limit exceeded' },
        decision: { retry: false },
      },
      switchModel,
    );

    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);
    const toastCall = showToast.mock.calls[0]?.[0] as {
      body?: { title?: string; message?: string; variant?: string };
    };
    expect(toastCall?.body?.title).toBe('Model fallback');
    expect(toastCall?.body?.variant).toBe('warning');
    expect(toastCall?.body?.message).toContain('openai');
  });

  test('falls back from an out-of-chain live model to the configured chain head', async () => {
    const manager = new ForegroundFallbackManager(
      makeOptions({
        chains: { oracle: ['openai/gpt-a', 'openai/gpt-b'] },
        maxRetries: 0,
      }),
    );
    const switchModel = mock(async () => {});
    await manager.handleV2Retry(
      {
        sessionID: 'sess-combined-first',
        agent: 'oracle',
        model: { providerID: 'anthropic', id: 'live-model' },
        error: { message: 'rate limit exceeded' },
        decision: { retry: false },
      },
      switchModel,
    );

    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(switchModel).toHaveBeenCalledWith('sess-combined-first', {
      providerID: 'openai',
      id: 'gpt-a',
    });
  });

  test('retains a confirmed switch when the projection callback throws', async () => {
    const retryManager = retryMgr(['A', 'B'], () => {
      throw new Error('projection failed');
    });
    const retry = retryEvent('retry-projection-error', 'A', { retry: false });
    await retryManager.handleV2Retry(retry, async () => {});
    expect(retry.decision).toEqual({ retry: true, delay: 500 });
    expect(
      retryManager.getActiveFallback('retry-projection-error')?.model,
    ).toBe('test/B');
  });

  test('v2 transport timeout switches providers and continues the turn', async () => {
    createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeOptions({
        chains: { orchestrator: ['p1/a', 'p2/b'] },
        input: { directory: '/test', hostFlavor: 'v2' } as never,
        maxRetries: 0,
        initialRetryDelayMs: 0,
        retryDelayMs: 0,
        v2RetryEnabled: true,
      }),
    );
    const switchModel = mock(async () => {});
    const event = {
      sessionID: 'v2-transport',
      agent: 'orchestrator',
      model: { providerID: 'p1', id: 'a' },
      error: {
        type: 'provider.transport',
        message: 'Timed out waiting for response headers',
      },
      decision: { retry: true, delay: 2_000 },
    };
    await mgr.handleV2Retry(event, switchModel);
    expect(switchModel).toHaveBeenCalledWith('v2-transport', {
      providerID: 'p2',
      id: 'b',
    });
    expect(event.decision).toEqual({ retry: true, delay: 0 });
    expect(mgr.getActiveFallback('v2-transport')?.downProviders).toEqual(
      new Set(['p1']),
    );
  });

  test.each([{ retry: true, delay: 2000 }, { retry: false }])(
    'switches in place without abort or re-prompt (initial decision %p)',
    async (decision) => {
      const { mocks } = createMockClient();
      const onChanged = mock();
      const mgr = retryMgr(['A', 'B'], onChanged);
      const switchModel = mock(async () => {});
      const event = retryEvent('c', 'A', { ...decision });
      await mgr.handleV2Retry(event, switchModel);
      expect(switchModel).toHaveBeenCalledWith('c', {
        providerID: 'test',
        id: 'B',
      });
      expect(event.decision).toEqual({ retry: true, delay: 500 });
      expect(mocks.abort).not.toHaveBeenCalled();
      expect(mocks.promptAsync).not.toHaveBeenCalled();
      expect(onChanged).toHaveBeenCalledWith('c', 'test/B', {
        agentName: 'orchestrator',
        variant: undefined,
      });
      await mgr.handleV2Retry(
        retryEvent('c', 'A', { ...decision }),
        switchModel,
      );
      expect(switchModel).toHaveBeenCalledTimes(1);
    },
  );

  test('v2 401 gets one grace retry while quota and 403 still switch', async () => {
    const { manager } = makeManager({ hostFlavor: 'v2', maxRetries: 3 });
    const switchModel = mock(async () => {});
    const event = {
      sessionID: 'v2-permanent',
      agent: 'orchestrator',
      model: { providerID: 'test', id: 'a' },
      error: { message: 'Free usage exceeded, subscribe to Go' },
      decision: { retry: true, delay: 77 },
    };
    await manager.handleV2Retry(event, switchModel);
    expect(switchModel).toHaveBeenCalledWith('v2-permanent', {
      providerID: 'test',
      id: 'b',
    });

    const auth = (sessionID: string, status: number, retry = false) => ({
      sessionID,
      agent: 'orchestrator',
      model: { providerID: 'test', id: 'a' },
      error: { type: 'provider.auth', status, message: 'Unauthorized' },
      decision: (retry ? { retry: true, delay: 0 } : { retry: false }) as {
        retry: boolean;
        delay?: number;
      },
    });
    const first = auth('v2-auth', 401);
    await manager.handleV2Retry(first, switchModel);
    expect(first.decision).toEqual({ retry: true, delay: 0 });
    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(manager.getActiveFallback('v2-auth')).toBeUndefined();
    expect((manager as any).downProviders.has('v2-auth')).toBe(false);
    await manager.handleV2Retry(auth('v2-auth', 401), switchModel);
    expect(switchModel).toHaveBeenCalledTimes(2);
    expect(manager.getActiveFallback('v2-auth')?.model).toBe('test/b');

    // Another auth plugin may already have changed the host decision.
    const preapproved = auth('v2-auth-plugin-first', 401, true);
    await manager.handleV2Retry(preapproved, switchModel);
    expect(preapproved.decision).toEqual({ retry: true, delay: 0 });
    expect(switchModel).toHaveBeenCalledTimes(2);
    await manager.handleV2Retry(
      auth('v2-auth-plugin-first', 401, true),
      switchModel,
    );
    expect(switchModel).toHaveBeenCalledTimes(3);

    manager.noteV2Prompt('v2-auth');
    const nextTurn = {
      ...auth('v2-auth', 401),
      model: { providerID: 'test', id: 'b' },
    };
    await manager.handleV2Retry(nextTurn, switchModel);
    expect(nextTurn.decision).toEqual({ retry: true, delay: 0 });
    expect(switchModel).toHaveBeenCalledTimes(3);

    await manager.handleV2Retry(auth('v2-forbidden', 403), switchModel);
    expect(switchModel).toHaveBeenCalledWith('v2-forbidden', {
      providerID: 'test',
      id: 'b',
    });
    await manager.handleV2Retry(
      {
        ...auth('v2-transport-401', 401),
        error: {
          type: 'provider.transport',
          status: 401,
          message: 'Unauthorized',
        },
      },
      switchModel,
    );
    expect(switchModel).toHaveBeenCalledWith('v2-transport-401', {
      providerID: 'test',
      id: 'b',
    });
  });

  test.each([
    ['B', 'C'],
    ['C', 'D'],
  ])(
    'failed switch keeps its target retryable (next failure on %s switches to %s)',
    async (hostModel, target) => {
      const { mocks } = createMockClient();
      const mgr = retryMgr(['B', 'C', 'D']);
      const sessionID = 'retry-unconsumed';
      const decision = { retry: false };
      const failed = retryEvent(sessionID, 'B', decision);
      await mgr.handleV2Retry(failed, () =>
        Promise.reject(new Error('switch denied')),
      );
      expect(failed.decision).toBe(decision);
      expect(mocks.abort).not.toHaveBeenCalled();
      expect(mocks.promptAsync).not.toHaveBeenCalled();
      const switchModel = mock(async () => {});
      await mgr.handleV2Retry(retryEvent(sessionID, hostModel), switchModel);
      expect(switchModel).toHaveBeenCalledWith(sessionID, {
        providerID: 'test',
        id: target,
      });
    },
  );

  test.each([
    { kind: 'reconciles B', advance: false, calls: ['test/B'] },
    { kind: 'does not roll C back to B', advance: true, calls: ['test/C'] },
  ])('late-landing switch $kind', async ({ advance, calls }) => {
    const observed: string[] = [];
    const mgr = retryMgr(
      ['A', 'B', 'C'],
      (_sid, model) => void observed.push(model),
    );
    const sid = 'retry-late-landing';
    const { promise: switchRequest, resolve: resolveSwitch } =
      Promise.withResolvers<void>();
    const pending = mgr.handleV2Retry(
      retryEvent(sid, 'A'),
      () => switchRequest,
    );
    await clock.advance(2_500);
    await pending;
    expect(observed).toEqual([]);
    if (advance) await mgr.handleV2Retry(retryEvent(sid, 'B'), async () => {});
    // A late B must reconcile only if no later retry has advanced to C.
    resolveSwitch();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(observed).toEqual(calls);
  });

  describe('v2 retry turn-epoch and late-landing race guards', () => {
    function promptBridgeFor(mgr: ForegroundFallbackManager) {
      return createSessionPromptBridge(
        async () => {},
        (sid, msgId) => mgr.observeExternalPromptIntent(sid, msgId),
      );
    }

    test('normal current epoch switch succeeds and mutates decision', async () => {
      const observed: string[] = [];
      const mgr = retryMgr(
        ['A', 'B'],
        (_sid, model) => void observed.push(model),
      );
      const sid = 'retry-epoch-normal-success';
      const switchModel = mock(async () => {});
      const decision = { retry: false };
      const event = retryEvent(sid, 'A', decision);

      await mgr.handleV2Retry(event, switchModel);

      expect(switchModel).toHaveBeenCalledWith(sid, {
        providerID: 'test',
        id: 'B',
      });
      expect(event.decision).toEqual({ retry: true, delay: 500 });
      expect(observed).toEqual(['test/B']);
      expect(mgr.getActiveFallback(sid)).toEqual({
        model: 'test/B',
        downProviders: expect.any(Set),
      });
    });

    test('new user prompt intent arriving before normal switch resolution suppresses stale decision and bookkeeping', async () => {
      const observed: string[] = [];
      const mgr = retryMgr(
        ['A', 'B'],
        (_sid, model) => void observed.push(model),
      );
      const bridge = promptBridgeFor(mgr);
      const sid = 'retry-epoch-normal-new-turn';
      const { promise: switchRequest, resolve: resolveSwitch } =
        Promise.withResolvers<void>();
      const switchModel = mock(() => switchRequest);
      const decision = { retry: false };
      const event = retryEvent(sid, 'A', decision);

      const pending = mgr.handleV2Retry(event, switchModel);
      expect(switchModel).toHaveBeenCalledTimes(1);

      // New genuine user prompt intent arrives through the prompt bridge
      bridge.observePromptIntent({
        sessionID: sid,
        messageID: 'msg-new-intent',
        prompt: { text: 'new prompt' },
      });

      // Switch resolves normally before timeout
      resolveSwitch();
      await pending;

      // Decision must NOT be mutated to retry
      expect(event.decision).toEqual({ retry: false });
      // Callback must NOT be invoked
      expect(observed).toEqual([]);
      // Active fallback must NOT be committed
      expect(mgr.getActiveFallback(sid)).toBeUndefined();
      // Host dispatch was called exactly once
      expect(switchModel).toHaveBeenCalledTimes(1);
    });

    test('timed-out switch settling late is suppressed when a new user prompt intent arrived on the same from model', async () => {
      const observed: string[] = [];
      const mgr = retryMgr(
        ['A', 'B'],
        (_sid, model) => void observed.push(model),
      );
      const bridge = promptBridgeFor(mgr);
      const sid = 'retry-epoch-late-new-turn';
      const { promise: switchRequest, resolve: resolveSwitch } =
        Promise.withResolvers<void>();
      const decision = { retry: false };
      const event = retryEvent(sid, 'A', decision);

      const pending = mgr.handleV2Retry(event, () => switchRequest);

      // Timeout fires on the old turn
      await clock.advance(2_500);
      await pending;
      expect(observed).toEqual([]);
      expect(event.decision).toEqual({ retry: false });

      // New genuine user prompt intent arrives on the same model A
      bridge.observePromptIntent({
        sessionID: sid,
        messageID: 'msg-new-intent-late',
        prompt: { text: 'new prompt' },
      });

      // Old switch resolves late
      resolveSwitch();
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Reconcile must be suppressed by epoch check even though session model is still 'test/A'
      expect(observed).toEqual([]);
      expect(mgr.getActiveFallback(sid)).toBeUndefined();
    });

    test('current epoch late-landing switch control successfully reconciles when no intent arrived', async () => {
      const observed: string[] = [];
      const mgr = retryMgr(
        ['A', 'B'],
        (_sid, model) => void observed.push(model),
      );
      const sid = 'retry-epoch-late-control';
      const { promise: switchRequest, resolve: resolveSwitch } =
        Promise.withResolvers<void>();
      const decision = { retry: false };
      const event = retryEvent(sid, 'A', decision);

      const pending = mgr.handleV2Retry(event, () => switchRequest);
      await clock.advance(2_500);
      await pending;
      expect(observed).toEqual([]);

      // Turn is still current (no intent arrived); resolve late switch
      resolveSwitch();
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // In current epoch without newer selection, late B must reconcile
      expect(observed).toEqual(['test/B']);
      expect(mgr.getActiveFallback(sid)?.model).toBe('test/B');
    });

    test('dedup trap: a duplicate prompt intent does not suppress the switch started after the first intent; the next new ID supersedes', async () => {
      const observed: string[] = [];
      const mgr = retryMgr(
        ['A', 'B', 'C'],
        (_sid, model) => void observed.push(model),
      );
      const bridge = promptBridgeFor(mgr);
      const sid = 'retry-dedup-trap';

      // 1. First intent arrives for msg-1 -> advances turnEpoch from 0 to 1
      bridge.observePromptIntent({
        sessionID: sid,
        messageID: 'msg-1',
        prompt: { text: 'turn 1' },
      });

      // 2. A switch starts on turn 1 (captures epoch = 1)
      const { promise: switchReq1, resolve: resolveSwitch1 } =
        Promise.withResolvers<void>();
      const event1 = retryEvent(sid, 'A', { retry: false });
      const pending1 = mgr.handleV2Retry(event1, () => switchReq1);

      // 3. Duplicate prepared ID arrives with same msg-1 -> MUST NOT bump epoch again
      bridge.observePromptIntent({
        sessionID: sid,
        messageID: 'msg-1',
        prompt: { text: 'turn 1 duplicate' },
      });

      // 4. Switch 1 resolves -> must SUCCEED because turn 1 is still current
      resolveSwitch1();
      await pending1;

      expect(event1.decision).toEqual({ retry: true, delay: 500 });
      expect(observed).toEqual(['test/B']);
      expect(mgr.getActiveFallback(sid)?.model).toBe('test/B');

      // 5. Next switch starts on model B (still turn 1)
      const { promise: switchReq2, resolve: resolveSwitch2 } =
        Promise.withResolvers<void>();
      const event2 = retryEvent(sid, 'B', { retry: false });
      const pending2 = mgr.handleV2Retry(event2, () => switchReq2);

      // 6. Next NEW ID intent arrives: msg-2 -> advances turnEpoch to 2
      bridge.observePromptIntent({
        sessionID: sid,
        messageID: 'msg-2',
        prompt: { text: 'turn 2' },
      });

      // 7. Switch 2 resolves -> must be SUPERSEDED by turn 2
      resolveSwitch2();
      await pending2;

      expect(event2.decision).toEqual({ retry: false });
      expect(observed).toEqual(['test/B']); // did not add test/C
    });

    test('admission failure leaves old switch superseded without granting new fallback budget', async () => {
      const observed: string[] = [];
      const mgr = retryMgr(
        ['A', 'B'],
        (_sid, model) => void observed.push(model),
      );
      const bridge = promptBridgeFor(mgr);
      const sid = 'retry-admission-failure';

      // Set up an existing consumed retry count on turn 0
      (mgr as any).sessionRetries.set(sid, 2);

      // Old switch is in flight
      const { promise: switchRequest, resolve: resolveSwitch } =
        Promise.withResolvers<void>();
      const event = retryEvent(sid, 'A', { retry: false });
      const pending = mgr.handleV2Retry(event, () => switchRequest);

      // New prompt intent arrives, but admission will fail (e.g. permission check rejects)
      bridge.observePromptIntent({
        sessionID: sid,
        messageID: 'msg-admit-fail',
        prompt: { text: 'prompt that fails admission' },
      });

      // The failed admission never reaches chat.message; the old switch finishes.
      resolveSwitch();
      await pending;

      // Old switch was superseded
      expect(event.decision).toEqual({ retry: false });
      expect(observed).toEqual([]);
      expect(mgr.getActiveFallback(sid)).toBeUndefined();

      // But fallback budget was NOT granted/cleared (still 2)
      expect((mgr as any).sessionRetries.get(sid)).toBe(2);
    });

    test('internal prompt intent with metadata, text marker, or existing internal admission does not bump epoch', async () => {
      const observed: string[] = [];
      const mgr = retryMgr(
        ['A', 'B'],
        (_sid, model) => void observed.push(model),
      );
      const bridge = promptBridgeFor(mgr);
      const sid = 'retry-internal-intent';
      const { promise: switchRequest, resolve: resolveSwitch } =
        Promise.withResolvers<void>();
      const decision = { retry: false };
      const event = retryEvent(sid, 'A', decision);

      const pending = mgr.handleV2Retry(event, () => switchRequest);

      // 1. Internal metadata prompt intent
      bridge.observePromptIntent({
        sessionID: sid,
        messageID: 'msg-meta',
        metadata: { [INTERNAL_INITIATOR_METADATA_KEY]: true },
        prompt: { text: 'wake queue' },
      });

      // 2. Text marker prompt intent
      bridge.observePromptIntent({
        sessionID: sid,
        messageID: 'msg-marker',
        prompt: { text: `wake ${SLIM_INTERNAL_INITIATOR_MARKER}` },
      });

      // 3. Pre-recorded internal admission
      recordInternalAdmission(sid, 'msg-pre-recorded');
      bridge.observePromptIntent({
        sessionID: sid,
        messageID: 'msg-pre-recorded',
        prompt: { text: 'normal text' },
      });

      // Switch resolves
      resolveSwitch();
      await pending;

      // None of the internal prompts bumped epoch, so switch succeeds
      expect(event.decision).toEqual({ retry: true, delay: 500 });
      expect(observed).toEqual(['test/B']);
      expect(mgr.getActiveFallback(sid)?.model).toBe('test/B');
    });

    test('other-session prompt intent does not suppress the in-flight switch of this session', async () => {
      const observed: string[] = [];
      const mgr = retryMgr(
        ['A', 'B'],
        (_sid, model) => void observed.push(model),
      );
      const bridge = promptBridgeFor(mgr);
      const sid1 = 'retry-session-1';
      const sid2 = 'retry-session-2';
      const { promise: switchRequest, resolve: resolveSwitch } =
        Promise.withResolvers<void>();
      const decision = { retry: false };
      const event1 = retryEvent(sid1, 'A', decision);

      const pending = mgr.handleV2Retry(event1, () => switchRequest);

      // Another session has a prompt intent
      bridge.observePromptIntent({
        sessionID: sid2,
        messageID: 'msg-session-2',
        prompt: { text: 'prompt for sid2' },
      });

      // Session 1 resolves
      resolveSwitch();
      await pending;

      // Session 1 must succeed normally
      expect(event1.decision).toEqual({ retry: true, delay: 500 });
      expect(observed).toEqual(['test/B']);
      expect(mgr.getActiveFallback(sid1)?.model).toBe('test/B');
    });

    test('disposing manager suppresses in-flight normal resolution and in-flight late reconciliation', async () => {
      // Normal in-flight disposal
      const observedNormal: string[] = [];
      const mgrNormal = retryMgr(
        ['A', 'B'],
        (_sid, model) => void observedNormal.push(model),
      );
      const sidNormal = 'retry-dispose-normal';
      const { promise: switchReq1, resolve: resolve1 } =
        Promise.withResolvers<void>();
      const decision1 = { retry: false };
      const event1 = retryEvent(sidNormal, 'A', decision1);

      const pendingNormal = mgrNormal.handleV2Retry(event1, () => switchReq1);
      mgrNormal.dispose();
      resolve1();
      await pendingNormal;
      expect(event1.decision).toEqual({ retry: false });
      expect(observedNormal).toEqual([]);
      expect(mgrNormal.getActiveFallback(sidNormal)).toBeUndefined();

      // Late in-flight disposal
      const observedLate: string[] = [];
      const mgrLate = retryMgr(
        ['A', 'B'],
        (_sid, model) => void observedLate.push(model),
      );
      const sidLate = 'retry-dispose-late';
      const { promise: switchReq2, resolve: resolve2 } =
        Promise.withResolvers<void>();
      const event2 = retryEvent(sidLate, 'A');

      const pendingLate = mgrLate.handleV2Retry(event2, () => switchReq2);
      await clock.advance(2_500);
      await pendingLate;

      mgrLate.dispose();
      resolve2();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(observedLate).toEqual([]);
      expect(mgrLate.getActiveFallback(sidLate)).toBeUndefined();
    });

    test('late rejection after a new user turn does not alter fresh tried state', async () => {
      const mgr = retryMgr(['A', 'B', 'C']);
      const sid = 'retry-late-rejection';
      const { promise: switchRequest, reject: rejectSwitch } =
        Promise.withResolvers<void>();
      const pending = mgr.handleV2Retry(
        retryEvent(sid, 'A'),
        () => switchRequest,
      );

      await clock.advance(2_500);
      await pending;

      // Advance to a fresh turn
      promptBridgeFor(mgr).observePromptIntent({
        sessionID: sid,
        messageID: 'msg-turn-2',
        prompt: { text: 'turn 2' },
      });

      // In turn 2, a descent tries B
      const triedSet = (mgr as any).sessionTried.get(sid) as Set<string>;
      expect(triedSet).toBeDefined();
      triedSet.add('test/B');

      // Late rejection arrives from turn 1
      rejectSwitch(new Error('late host error'));
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Fresh tried state for B must remain intact
      expect(triedSet.has('test/B')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// isFailoverError
// ---------------------------------------------------------------------------

describe('isFailoverError', () => {
  test('classifies recoverable HTTP 400 response bodies as failover errors', () => {
    expect(
      isFailoverError({
        data: { statusCode: 400, responseBody: 'rate limit exceeded' },
      }),
    ).toBe(true);
    expect(
      isFailoverError({
        data: { statusCode: 400, message: 'invalid request: missing field' },
      }),
    ).toBe(false);
  });

  test('returns true for 429 status code', () => {
    expect(isFailoverError({ data: { statusCode: 429 } })).toBe(true);
  });

  test.each([
    [
      'nested data response numeric string',
      { data: { response: { status: '503' } } },
    ],
    [
      'cause response numeric string',
      { cause: { response: { status: '429' } } },
    ],
    ['top-level status numeric string', { status: '410' }],
  ])('extracts HTTP status from %s', (_label, error) => {
    expect(isFailoverError(error)).toBe(true);
  });

  test('nested numeric-string 410 remains inline', () => {
    expect(
      isInlineFailoverError({ cause: { response: { status: '410' } } }),
    ).toBe(true);
  });

  test.each([
    ['provider.quota', 'rpm exhausted', 429, true],
    ['provider.rate-limit', 'inference exceeds tpm/rpm limit', 429, true],
    ['provider.quota', 'You exceeded your current quota', undefined, true],
    ['provider.invalid-request', 'prompt is too long', undefined, false],
    ['provider.error', 'invalid request', 400, false],
  ])(
    'classifies v2 provider error %s (issue #1283)',
    (type, message, status, expected) => {
      expect(
        isFailoverError({
          type,
          message,
          ...(status === undefined ? {} : { status }),
        }),
      ).toBe(expected);
    },
  );

  test('returns true for "rate limit" in message', () => {
    expect(isFailoverError({ message: 'Rate limit exceeded' })).toBe(true);
  });

  test('returns true for "quota exceeded" in responseBody', () => {
    expect(isFailoverError({ data: { responseBody: 'quota exceeded' } })).toBe(
      true,
    );
  });

  test('returns true for bailian "quota has been exhausted" (issue #1083)', () => {
    expect(
      isFailoverError({
        message:
          'Your token-plan 1-week quota has been exhausted. The quota will reset at 08-27 15:33:00 UTC.',
      }),
    ).toBe(true);
  });

  test('returns true for client-side response header timeouts (held upstreams)', () => {
    expect(
      isFailoverError({
        message: 'Provider response headers timed out after 300000ms',
      }),
    ).toBe(true);
  });

  test('returns true for codex quota-threshold errors', () => {
    expect(
      isFailoverError({
        message:
          'AI_APICallError: [codex/gpt-6-astra-medium] All codex accounts reached configured quota threshold (reset after 20h 41m 59s)',
      }),
    ).toBe(true);
    expect(
      isFailoverError(
        'AI_APICallError: [codex/gpt-6-astra-medium] All codex accounts reached configured quota threshold (reset after 20h 41m 59s)',
      ),
    ).toBe(true);
  });

  test('returns true for the claude-agent weekly subscription limit (issue #1918)', () => {
    // Deterministic provider.unknown signature from the claude-agent
    // adapter: no HTTP status, so only the message can classify it.
    // The weekly limit resets at a fixed time, so it is also permanent
    // billing (immediate failover, no initial delay).
    const error = {
      type: 'provider.unknown',
      message:
        "You've hit your weekly limit · resets 1pm (Europe/Berlin) Resets at 2026-11-15T12:00:00.000Z.",
    };
    expect(isFailoverError(error)).toBe(true);
    expect(isPermanentQuotaBillingError(error)).toBe(true);
    // The 5-hour variant carries the same signature.
    expect(
      isFailoverError({
        type: 'provider.unknown',
        message:
          "You've hit your 5-hour limit · Resets at 2026-11-15T14:00:00.000Z.",
      }),
    ).toBe(true);
    // Narrow by design: a bare "weekly limit" without the deterministic
    // "You've hit your" prefix stays a hard error.
    expect(
      isFailoverError({
        type: 'provider.unknown',
        message: 'weekly limit reached for this workspace',
      }),
    ).toBe(false);
  });

  test('returns true for content-policy moderation rejections (cyber_policy)', () => {
    // OpenAI moderation surfaces as HTTP 400 invalid_request with the
    // provider-specific policy code; deterministic per provider, so the next
    // model in the chain must be tried instead of failing the request.
    expect(
      isFailoverError(
        'AI_APICallError: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber',
      ),
    ).toBe(true);
    expect(
      isFailoverError({
        data: {
          statusCode: 400,
          message:
            'This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber',
        },
      }),
    ).toBe(true);
    expect(
      isFailoverError({
        data: {
          statusCode: 400,
          responseBody:
            '{"error":{"type":"invalid_request","code":"cyber_policy"}}',
        },
      }),
    ).toBe(true);
    expect(
      isFailoverError({
        data: {
          statusCode: 400,
          responseBody:
            '{"error":{"code":"content_policy_violation","message":"Your request was rejected as a result of our safety system."}}',
        },
      }),
    ).toBe(true);
  });

  test('returns true for the host content-filter finish error', () => {
    // OpenCode v1 surfaces a `content-filter` finish reason (Anthropic
    // refusal, OpenAI content_filter, ...) as a status-less ContentFilterError.
    expect(
      isFailoverError({
        name: 'ContentFilterError',
        data: {
          message: "The response was blocked by the provider's content filter",
        },
      }),
    ).toBe(true);
  });

  test('returns true for billing/quota rejections (xAI spending-limit)', () => {
    // xAI billing surfaces as HTTP 400/402 with the structured billing code;
    // deterministic for the same account, so the next model in the chain
    // must be tried instead of failing the request.
    expect(
      isFailoverError(
        'AI_APICallError: personal-team-blocked:spending-limit: You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok.',
      ),
    ).toBe(true);
    expect(
      isFailoverError({
        data: {
          statusCode: 400,
          message:
            'personal-team-blocked:spending-limit: You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok.',
        },
      }),
    ).toBe(true);
    // 402 Payment Required is the standard billing class: no pattern needed.
    expect(
      isFailoverError({
        data: {
          statusCode: 402,
          message: 'payment required',
        },
      }),
    ).toBe(true);
    // Official xAI fixture: same billing family, different wording, code
    // embedded in the body.
    expect(
      isFailoverError(
        '{"code":429,"error":"You ran out of credits. [WKE=personal-team-blocked:spending-limit]"}',
      ),
    ).toBe(true);
  });

  test('returns true for Zhipu GLM quota exhaustion codes', () => {
    // GLM surfaces quota/billing as 429 with a structured code in the JSON
    // body; the Chinese wire variants and Anthropic-style type envelopes
    // carry no English text, so the quoted code is the stable signature.
    expect(
      isFailoverError({
        data: {
          statusCode: 429,
          responseBody:
            '{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}',
        },
      }),
    ).toBe(true);
    expect(
      isFailoverError({
        data: {
          statusCode: 429,
          responseBody:
            '{"error":{"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-05-09 20:42:25 重置。"}}',
        },
      }),
    ).toBe(true);
    expect(
      isFailoverError({
        data: {
          statusCode: 429,
          message:
            'Your GLM Coding Plan package has expired and is temporarily unavailable. You can resume using it after renewing the subscription on the official website.',
        },
      }),
    ).toBe(true);
    expect(
      isFailoverError({
        message:
          'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-05-11 00:00:00',
      }),
    ).toBe(true);
  });

  test('returns false for ordinary wording that merely mentions credits', () => {
    // Only the structured code or the exact billing wording match; ordinary
    // errors mentioning "credits" stay hard errors.
    expect(
      isFailoverError({
        message: 'how many credits does this request cost',
      }),
    ).toBe(false);
  });

  test('returns false for generic limit/expiry wording outside the quota family', () => {
    // The GLM English patterns anchor to the provider wording; generic
    // exhaustion or expiry phrases from unrelated failures stay hard errors.
    expect(
      isFailoverError({ message: 'file descriptor limit exhausted' }),
    ).toBe(false);
    expect(
      isFailoverError({ message: 'TLS certificate package has expired' }),
    ).toBe(false);
  });

  test('returns false for generic flagged/policy wording without the moderation signature', () => {
    // Only the structured code or the exact provider wording match; ordinary
    // errors mentioning "flagged", "cybersecurity", "policy" or "content
    // filter" stay hard errors.
    expect(
      isFailoverError({ message: 'request flagged for review by the proxy' }),
    ).toBe(false);
    expect(
      isFailoverError({ message: 'analysis of cybersecurity topics rejected' }),
    ).toBe(false);
    expect(
      isFailoverError({ message: 'policy update required for this model' }),
    ).toBe(false);
    expect(
      isFailoverError({ message: 'content filter settings updated' }),
    ).toBe(false);
  });

  test('returns true for "usage exceeded"', () => {
    expect(isFailoverError({ message: 'usage exceeded' })).toBe(true);
  });

  test('returns true for "overloaded"', () => {
    expect(isFailoverError({ message: 'overloaded_error' })).toBe(true);
  });

  test('returns true for "Insufficient balance."', () => {
    expect(isFailoverError({ message: 'Insufficient balance.' })).toBe(true);
  });

  test('returns true for "Service Unavailable"', () => {
    expect(isFailoverError({ message: 'Service Unavailable' })).toBe(true);
  });

  test('returns true for "Monthly usage limit reached"', () => {
    expect(
      isFailoverError({
        message: 'Monthly usage limit reached. Resets in X days.',
      }),
    ).toBe(true);
  });

  test('returns true for "5-hour usage limit reached"', () => {
    expect(
      isFailoverError({
        message: '5-hour usage limit reached. Resets in 36min.',
      }),
    ).toBe(true);
  });

  test('returns true for "Weekly usage limit reached"', () => {
    expect(
      isFailoverError({
        message: 'Weekly usage limit reached. Resets in 2 days.',
      }),
    ).toBe(true);
  });

  test('returns false for non-rate-limit error', () => {
    expect(isFailoverError({ message: 'invalid API key' })).toBe(false);
  });

  test('returns false for null', () => {
    expect(isFailoverError(null)).toBe(false);
  });

  test('returns true for string error with rate-limit message', () => {
    expect(isFailoverError('Usage exceeded')).toBe(true);
    expect(isFailoverError('rate limit exceeded')).toBe(true);
    expect(isFailoverError('quota exceeded')).toBe(true);
  });

  test('returns false for non-object', () => {
    expect(isFailoverError(42)).toBe(false);
  });

  test('returns true for 403 status code', () => {
    expect(isFailoverError({ data: { statusCode: 403 } })).toBe(true);
  });

  test('returns true for 401 status code', () => {
    expect(isFailoverError({ statusCode: 401 })).toBe(true);
    expect(isFailoverError({ data: { statusCode: 401 } })).toBe(true);
  });

  test('returns true for 410 Gone (model end-of-life)', () => {
    expect(isFailoverError({ statusCode: 410 })).toBe(true);
    expect(isFailoverError({ data: { statusCode: 410 } })).toBe(true);
    expect(
      isFailoverError({
        message:
          "The model 'mistralai/mistral-small-4-119b-2603' has reached its end of life on 2026-07-27T00:00:00Z and is no longer available.",
      }),
    ).toBe(true);
    // The AI SDK surfaces HTTP 410 as the bare title "Gone" in the message.
    expect(isFailoverError({ message: 'AI_APICallError: Gone' })).toBe(true);
    expect(isFailoverError('Gone')).toBe(true);
  });

  test('returns true for 401 upstream provider error message', () => {
    expect(
      isFailoverError(
        'AI_APICallError: Upstream request failed: [401] Provider returned error',
      ),
    ).toBe(true);
    expect(
      isFailoverError({
        message:
          'AI_APICallError: Upstream request failed: [401] Provider returned error',
      }),
    ).toBe(true);
    expect(
      isFailoverError({ data: { message: 'Upstream request failed [401]' } }),
    ).toBe(true);
  });

  test('returns true for streaming/proxy backpressure without an HTTP status', () => {
    // Issue #947: gateways shed load with these wordings; the failure
    // carries no 4xx determinism, so the chain (or a same-model replay)
    // should be tried.
    for (const message of [
      'streaming response failed: connection reset',
      'request queue is full, try again later',
      'worker local total request limit reached',
    ]) {
      expect(isFailoverError(message)).toBe(true);
      expect(isFailoverError({ message })).toBe(true);
    }
  });

  test('returns true for "upstream error" only with transient context', () => {
    // A 5xx status, outage marker, or timeout/unavailable marker in the
    // same message proves the upstream failure is transient.
    for (const message of [
      'upstream error (status 500)',
      'upstream error: 503 Service Unavailable',
      'upstream error: request timeout after 30s',
      'upstream error: upstream unavailable, try again',
    ]) {
      expect(isFailoverError(message)).toBe(true);
      expect(isFailoverError({ message })).toBe(true);
    }
  });

  test('returns false for bare or 400-bodied "upstream error"', () => {
    // Proxies wrap deterministic 4xx in the same wording; without
    // transient context these stay hard errors.
    expect(isFailoverError('upstream error')).toBe(false);
    expect(isFailoverError({ message: 'upstream error' })).toBe(false);
    expect(
      isFailoverError({
        message: 'upstream error: request failed with status code 400',
      }),
    ).toBe(false);
  });

  test('returns false for policy-flavored "upstream error" without transient context', () => {
    // A policy rejection retried on the same model fails again; without a
    // transient marker it stays a hard error even under proxy wording.
    expect(
      isFailoverError({
        message: 'upstream error: content policy violation, request denied',
      }),
    ).toBe(false);
  });

  test('returns true for "Forbidden" in message', () => {
    expect(isFailoverError({ message: '403 Forbidden' })).toBe(true);
  });

  test('returns true for "blocked by gateway" in message', () => {
    expect(isFailoverError({ message: 'blocked by gateway' })).toBe(true);
  });

  test('returns true for "forbidden" (lowercase) in message', () => {
    expect(isFailoverError({ message: 'forbidden' })).toBe(true);
  });

  test('returns true for NewAPI "no available channel" error shapes', () => {
    const message =
      'No available channel for model gpt-6-luna under group Codex专用 (distributor) (request id: abc123)';

    expect(isFailoverError(message)).toBe(true);
    expect(isFailoverError({ message })).toBe(true);
    expect(
      isFailoverError({
        data: { statusCode: 400, responseBody: message },
      }),
    ).toBe(true);
  });

  test('returns true for CliProxyAPI "auth unavailable" error shapes', () => {
    const message =
      'auth_unavailable: no auth available (providers=cli-proxy-api, model=gemini-3.6-flash)';

    expect(isFailoverError(message)).toBe(true);
    expect(isFailoverError({ message })).toBe(true);
    expect(
      isFailoverError({
        data: { statusCode: 400, responseBody: message },
      }),
    ).toBe(true);
    expect(
      isFailoverError({
        data: {
          responseBody:
            '{"error":{"message":"auth_unavailable: no auth available","type":"server_error","code":"internal_server_error"}}',
        },
      }),
    ).toBe(true);
  });

  test('returns true for "cannot connect to API" transport errors', () => {
    expect(isFailoverError('Cannot connect to API')).toBe(true);
    expect(isFailoverError('stream error: Cannot connect to API')).toBe(true);
    expect(
      isFailoverError({ message: 'stream error: Cannot connect to API' }),
    ).toBe(true);
  });

  test('returns true for disposed provider plugin errors', () => {
    expect(isFailoverError('Antigravity plugin has been disposed')).toBe(true);
    expect(
      isFailoverError({
        name: 'UnknownError',
        data: { message: 'Error: Antigravity plugin has been disposed' },
      }),
    ).toBe(true);
  });

  test('returns false for non-API connection errors', () => {
    expect(isFailoverError('Cannot connect to database')).toBe(false);
  });

  test('returns false for permanent channel-not-found errors', () => {
    expect(
      isFailoverError({
        message: 'channel not found for model gpt-6-luna',
      }),
    ).toBe(false);
  });

  test('returns true for OpenCode ProviderModelNotFoundError "Model not found" errors', () => {
    // Issue #1034: OpenCode's ProviderModelNotFoundError ("Model not found:
    // <model>") was not classified as a failover error, so a missing primary
    // model failed the task outright instead of advancing the fallback chain.
    // The reporter's error string always carries the message; the bare
    // camelCase class name "ProviderModelNotFoundError" (no spaces) does not
    // match /\bmodel not found\b/i and is intentionally not covered here.
    expect(
      isFailoverError(
        'ProviderModelNotFoundError: Model not found: custom/missing-model.',
      ),
    ).toBe(true);
    expect(
      isFailoverError({ message: 'Model not found: custom/missing-model' }),
    ).toBe(true);
  });

  test('returns true for model unavailable error', () => {
    expect(isFailoverError('Model unavailable: test/provider')).toBe(true);
    expect(
      isFailoverError({ message: 'Model unavailable: anthropic/claude-3' }),
    ).toBe(true);
  });

  test('returns true for variant unavailable error', () => {
    expect(
      isFailoverError('Variant unavailable for test/provider: test-variant'),
    ).toBe(true);
    expect(
      isFailoverError({
        message: 'Variant unavailable for openai/gpt-4o: max',
      }),
    ).toBe(true);
  });

  test.each([
    'Model unavailable: test/a',
    'Variant unavailable for test/a: max',
  ])('keeps %s request-scoped during v2 retry', async (message) => {
    const { manager } = makeManager({
      chain: ['test/a', 'test/b'],
      hostFlavor: 'v2',
    });
    const switchModel = mock(async () => {});
    const event = {
      sessionID: 'request-scoped-model-error',
      agent: 'orchestrator',
      model: { providerID: 'test', id: 'a' },
      error: { message },
      decision: { retry: false },
    };
    await manager.handleV2Retry(event, switchModel);
    expect(switchModel).toHaveBeenCalledWith(event.sessionID, {
      providerID: 'test',
      id: 'b',
    });
    const mgr = manager as any;
    expect(mgr.downProviders.get(event.sessionID)?.has('test')).toBeFalsy();
    expect(mgr.requestRejected.get(event.sessionID)?.has('test/a')).toBe(true);
  });

  test('returns true for existing model-outage patterns (regression guard)', () => {
    expect(isFailoverError('model not available')).toBe(true);
    expect(isFailoverError('unsupported model')).toBe(true);
    expect(isFailoverError('unknown model')).toBe(true);
  });

  test('returns false for normal errors and model mentions without outage wording', () => {
    expect(isFailoverError('Cannot connect to database')).toBe(false);
    expect(isFailoverError({ message: 'invalid model configuration' })).toBe(
      false,
    );
  });
});

// hasDeterministic4xx status-code boundary (issue #1710): pins when a 4xx
// is deterministic (reproduces on every replay) vs transient. Probe message
// 'upstream error overload' matches only the transient path (no digits for
// DETERMINISTIC_4XX_PATTERN, no provider pattern; keep it that way), so
// the statusCode clauses decide; 400/499 also sit outside
// PROVIDER_STATUS_CODES. No 429/500 rows: those inputs fail over through
// other paths whatever the clauses say (transient wording, or
// PROVIDER_STATUS_CODES once a clause flips) — nothing observable there.

describe('hasDeterministic4xx status-code boundary (issue #1710)', () => {
  const transientText = 'upstream error overload';

  test.each([
    [
      'statusCode 300 (below 400): not a 4xx, transient carries failover',
      300,
      true,
    ],
    [
      'statusCode 400 (lower bound): deterministic 4xx suppresses failover',
      400,
      false,
    ],
    ['statusCode 408 is exempt (request timeout is retriable)', 408, true],
    ['statusCode 499 (upper bound): still a deterministic 4xx', 499, false],
    ['statusCode 550 (5xx): not a 4xx, transient carries failover', 550, true],
  ])('%s', (_label, status, expected) => {
    expect(
      isFailoverError({ data: { statusCode: status }, message: transientText }),
    ).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// asHttpStatus bounds (issue #1721): pin the 100/599 accepted range in
// asHttpStatus. A bare out-of-range status is indistinguishable through the
// public classifiers (extractStatusCode finds no accepted candidate, so all
// of them return false), so the fixture pairs an out-of-range outer status
// with an accepted inner 401: in range the outer value shadows the inner,
// out of range it falls through and the inner flips the classification.
// Boundary rows kill the relational flips and bound shifts; 101/598 alone
// kill `==` narrowing of either bound.
// ---------------------------------------------------------------------------

describe('asHttpStatus bounds (issue #1721)', () => {
  // Inner 401 is always a failover (PROVIDER_STATUS_CODES). The outer value
  // decides: out-of-range falls through to 401 (failover), in-range shadows
  // it with a non-failover status (not in PROVIDER_STATUS_CODES).
  const shadow = (outer: number | string) => ({
    statusCode: outer,
    data: { statusCode: 401 },
  });

  test.each([
    ['99 (below lower bound) falls through to the accepted 401', 99, true],
    ['100 (lower bound) shadows the 401, so not a failover', 100, false],
    ['101 (just above lower bound) shadows the 401', 101, false],
    ['598 (just below upper bound) shadows the 401', 598, false],
    ['599 (upper bound) shadows the 401, so not a failover', 599, false],
    ['600 (above upper bound) falls through to the accepted 401', 600, true],
  ])('%s', (_label, status, expected) => {
    expect(isFailoverError(shadow(status))).toBe(expected);
    expect(isInlineFailoverError(shadow(status))).toBe(expected);
  });

  test.each([
    [
      '"099" (below lower bound) falls through to the accepted 401',
      '099',
      true,
    ],
    ['"100" (lower bound) shadows the 401', '100', false],
    ['"599" (upper bound) shadows the 401', '599', false],
    [
      '"600" (above upper bound) falls through to the accepted 401',
      '600',
      true,
    ],
  ])('string %s', (_label, status, expected) => {
    expect(isFailoverError(shadow(status))).toBe(expected);
    expect(isInlineFailoverError(shadow(status))).toBe(expected);
  });

  // Shape guards: the numeric branch rejects non-integers, the string
  // branch anything but a bare 3-digit numeral. Both rows fall through to
  // the accepted 401; deleting either guard shadows it instead.
  test.each([
    ['100.5 (non-integer) falls through to the accepted 401', 100.5],
    ['"0100" (padded numeral) falls through to the accepted 401', '0100'],
  ])('%s', (_label, status) => {
    expect(isFailoverError(shadow(status))).toBe(true);
  });

  // Contract pin: isPermanentQuotaBillingError follows the same outer-bound
  // gating, so the inner 402 is permanent only when the outer bound rejects.
  test('upper bound gates the permanent-billing 402 fallthrough', () => {
    expect(
      isPermanentQuotaBillingError({
        statusCode: 599,
        data: { statusCode: 402 },
      }),
    ).toBe(false);
    expect(
      isPermanentQuotaBillingError({
        statusCode: 600,
        data: { statusCode: 402 },
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Spent allowance (issue #966): provider exhaustion, not a failover veto
// ---------------------------------------------------------------------------

describe('isSpentQuotaError (issue #966)', () => {
  test.each([
    'quota exceeded',
    'usage exceeded',
    'usage limit reached',
    'Monthly usage limit reached. Resets in X days.',
    '5-hour usage limit reached. Resets in 36min.',
    'Weekly usage limit reached. Resets in 2 days.',
    'AI_APICallError: The usage limit has been reached',
    'Usage exceeded for this billing period',
  ])('classifies "%s" as spent allowance that still fails over', (signal) => {
    expect(isSpentQuotaError({ message: signal })).toBe(true);
    expect(isSpentQuotaError(signal)).toBe(true);
    expect(
      isSpentQuotaError({ data: { statusCode: 429, responseBody: signal } }),
    ).toBe(true);
    expect(isFailoverError({ message: signal })).toBe(true);
    // Spent wording is not permanent billing: it keeps the initial delay.
    expect(isPermanentQuotaBillingError({ message: signal })).toBe(false);
  });

  test.each([
    'quota exceeded, retry after 20s',
    'Quota exceeded for quota metric, try again in 30s',
    'quota exceeded, retry in 20s',
    'quota exceeded, will reset at midnight',
    'quota exceeded; resets at 15:00 UTC',
    'quota exceeded per minute',
  ])('short-horizon "%s" is not spent allowance', (signal) => {
    expect(isSpentQuotaError({ message: signal })).toBe(false);
    expect(isFailoverError({ message: signal })).toBe(true);
  });

  test('free-tier exhaustion is exempt and stays permanent billing', () => {
    const error = { message: 'Free usage exceeded, subscribe to Go' };
    expect(isSpentQuotaError(error)).toBe(false);
    expect(isPermanentQuotaBillingError(error)).toBe(true);
    expect(isFailoverError(error)).toBe(true);
  });

  test('reads nested carriers without cross-carrier escapes', () => {
    expect(isSpentQuotaError({ cause: { message: 'quota exceeded' } })).toBe(
      true,
    );
    expect(isSpentQuotaError({ data: { code: 'usage exceeded' } })).toBe(true);
    expect(isSpentQuotaError({ message: 'Monthly usage limit exceeded' })).toBe(
      false,
    );
    // Short-horizon phrasing in an unrelated carrier does not lift the mark.
    expect(
      isSpentQuotaError({
        message: 'quota exceeded',
        data: { responseBody: 'try again later for other errors' },
      }),
    ).toBe(true);
  });
});

describe('ForegroundFallbackManager spent allowance (issue #966)', () => {
  const SPENT = {
    message: 'AI_APICallError: The usage limit has been reached',
  };
  test('v2 retry hook attributes spent quota to the model it names', async () => {
    const { manager } = makeManager({
      chain: ['p1/a', 'p2/b', 'p3/c'],
      hostFlavor: 'v2',
    });
    const sid = 'spent-v2-cascade';
    const exhausted = () =>
      (manager as any).quotaExhaustedProviders.get(sid) as Set<string>;
    const switchModel = mock(async () => {});
    // Host retry-hook input as the v2 bridge delivers it (src/v2/setup.ts):
    // the failing attempt's model, the host error and its retry decision.
    const retry = (providerID: string, id: string) => ({
      sessionID: sid,
      agent: 'orchestrator',
      model: { providerID, id },
      error: { message: SPENT.message, statusCode: 429, isRetryable: true },
      decision: { retry: true } as { retry: boolean; delay?: number },
    });
    await manager.handleV2Retry(retry('p1', 'a'), switchModel);
    expect(switchModel).toHaveBeenCalledTimes(1);
    // True echo: the host's late retry for p1 after the switch.
    const echo = retry('p1', 'a');
    await manager.handleV2Retry(echo, switchModel);
    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(echo.decision).toEqual({ retry: true });
    expect(exhausted()).toEqual(new Set(['p1']));
    // p2 rejects at once with the same text and no message in between:
    // the hook names p2, so p2 is exhausted and p3 takes over.
    await manager.handleV2Retry(retry('p2', 'b'), switchModel);
    expect(switchModel).toHaveBeenCalledTimes(2);
    expect((switchModel.mock.calls[1] as unknown[])[1]).toMatchObject({
      providerID: 'p3',
      id: 'c',
    });
    expect(exhausted()).toEqual(new Set(['p1', 'p2']));
    // p3 spent too: every provider is exhausted, the decision stands.
    const last = retry('p3', 'c');
    await manager.handleV2Retry(last, switchModel);
    expect(switchModel).toHaveBeenCalledTimes(2);
    expect(last.decision).toEqual({ retry: true });
  });
  test('session delete clears the exhausted providers', () => {
    const coordinator = new SessionLifecycle(() => {});
    createMockClient();
    const mgr = timedManager({
      chains: { orchestrator: ['p1/a', 'p2/b'] },
      input: { directory: '/test' } as any,
      maxRetries: 3,
      coordinator: coordinator,
    });
    (mgr as any).quotaExhaustedProviders.set('gone', new Set(['p1']));
    coordinator.dispatchSessionDeleted('gone');
    expect((mgr as any).quotaExhaustedProviders.has('gone')).toBe(false);
  });
  test('v2 retry hook steers a spent quota to another provider', async () => {
    const { manager } = makeManager({ chain: ['p1/a', 'p1/b', 'p2/c'] });
    const switchModel = mock(async () => {});
    const event = {
      sessionID: 'spent-v2',
      agent: 'orchestrator',
      model: { providerID: 'p1', id: 'a' },
      error: SPENT,
      decision: { retry: true },
    };
    await manager.handleV2Retry(event, switchModel);
    expect(switchModel).toHaveBeenCalledTimes(1);
    expect((switchModel.mock.calls[0] as unknown[])[1]).toMatchObject({
      providerID: 'p2',
      id: 'c',
    });
  });
  test('v2 retry hook leaves the host decision on a same-provider chain', async () => {
    const { manager } = makeManager({ maxRetries: 0 });
    const switchModel = mock(async () => {});
    const event = {
      sessionID: 'spent-v2-same',
      agent: 'orchestrator',
      model: { providerID: 'test', id: 'a' },
      error: SPENT,
      decision: { retry: false },
    };
    await manager.handleV2Retry(event, switchModel);
    expect(switchModel).not.toHaveBeenCalled();
    expect(event.decision).toEqual({ retry: false });
  });
});

describe('isPermanentQuotaBillingError', () => {
  test('returns true for free-tier usage exhaustion and Antigravity quota or pool exhaustion', () => {
    expect(
      isPermanentQuotaBillingError('Free usage exceeded, subscribe to Go'),
    ).toBe(true);
    expect(
      isPermanentQuotaBillingError({
        message: 'Free usage exceeded, subscribe to Go',
      }),
    ).toBe(true);
    expect(
      isPermanentQuotaBillingError({
        message:
          'Individual quota reached. Please upgrade your subscription to increase your limits. quota resets in 150h 8m 15s.',
      }),
    ).toBe(true);
    const poolError = {
      status: 412,
      message:
        'Antigravity account pool has no account available within the configured wait limit. Add accounts with `opencode auth login` or wait for account availability. Quota resets in 142h 40m 46s.',
    };
    expect(isFailoverError(poolError)).toBe(true);
    expect(isPermanentQuotaBillingError(poolError)).toBe(true);
    // A generic HTTP 412 is a request rejection: no Antigravity signal, no
    // failover, and the host's own verdict stands.
    const genericPrecondition = {
      status: 412,
      message: 'Precondition Failed',
    };
    expect(isFailoverError(genericPrecondition)).toBe(false);
    expect(isPermanentQuotaBillingError(genericPrecondition)).toBe(false);
    expect(
      isFailoverError({
        cause: {
          message:
            'Antigravity account pool is unavailable under the quota protection policy. Add accounts, wait for quota reset, or disable soft quota protection.',
        },
      }),
    ).toBe(true);
    expect(
      isFailoverError({
        message:
          'Antigravity did not begin a response within the pre-response time limit. Check your connection and try again later.',
      }),
    ).toBe(true);
  });

  test('returns false for transient rate limits', () => {
    expect(isPermanentQuotaBillingError('rate limit, retrying...')).toBe(false);
    expect(
      isPermanentQuotaBillingError({ message: '429 Too Many Requests' }),
    ).toBe(false);
    expect(
      isPermanentQuotaBillingError('Rate limited, quota resets in 30s'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - session.deleted cleanup
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager session.deleted', () => {
  test('ignores session.deleted with no sessionID', async () => {
    const mgr = new ForegroundFallbackManager(
      makeOptions({
        chains: makeChains(),
        input: {
          directory: '/test',
        } as any,
      }),
    );
    // Should not throw
    await expect(
      mgr.handleEvent({ type: 'session.deleted', properties: {} }),
    ).resolves.toBeUndefined();
  });

  test('does NOT clear inProgress when session.deleted fires', () => {
    const coordinator = new SessionLifecycle(() => {});
    const mgr = new ForegroundFallbackManager(
      makeOptions({
        chains: makeChains(),
        input: { directory: '/test' } as any,
        maxRetries: 3,
        coordinator: coordinator,
      }),
    );

    // Simulate: fallback is in progress
    const sessionID = 'sess-inprog';
    (mgr as any).inProgress.add(sessionID);
    expect(mgr.isFallbackInProgress(sessionID)).toBe(true);

    // Session deletion must not clear the shared in-progress slot.
    coordinator.dispatchSessionDeleted(sessionID);

    // The retry or continuation owns the slot until its finally cleanup.
    expect(mgr.isFallbackInProgress(sessionID)).toBe(true);
    (mgr as any).inProgress.delete(sessionID);
  });

  test('handleEvent session.deleted clears sessionParent without a coordinator', async () => {
    const mgr = new ForegroundFallbackManager(
      makeOptions({
        chains: makeChains(),
        input: {
          directory: '/test',
        } as never,
      }),
    );

    await mgr.handleEvent({
      type: 'session.created',
      properties: { info: { id: 'child', parentID: 'parent' } },
    });
    expect((mgr as any).sessionParent.has('child')).toBe(true);

    await mgr.handleEvent({
      type: 'session.deleted',
      properties: { info: { id: 'child' } },
    });
    expect((mgr as any).sessionParent.has('child')).toBe(false);
  });

  test('shares fallback progress across plugin manager instances', () => {
    const first = new ForegroundFallbackManager(
      makeOptions({
        chains: makeChains(),
        input: createMockClient().client,
      }),
    );
    const replacement = new ForegroundFallbackManager(
      makeOptions({
        chains: makeChains(),
        input: createMockClient().client,
      }),
    );
    const sessionID = 'sess-shared-in-progress';

    (first as any).inProgress.add(sessionID);
    expect(replacement.isFallbackInProgress(sessionID)).toBe(true);
    (first as any).inProgress.delete(sessionID);
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - cleanup semantics (issue #1721)
// ---------------------------------------------------------------------------

// Teardown must actually drop per-session state. None of the maps below
// have a per-entry TTL or prune sweep, so a leaked entry outlives its session
// and can change later behavior — e.g. one stale sessionRetryEnabled entry
// reopens handleEvent's idle gate for every session (see the behavioral
// test below).

function seedMap(target, id) {
  if (typeof target.add === 'function') target.add(id);
  else target.set(id, 1);
}

describe('ForegroundFallbackManager forgetSession cleanup', () => {
  test.each([
    'sessionModel',
    'sessionParent',
    'activeFallback',
    'restoredFrom',
    'downProviders',
    'sessionAgent',
    'sessionTried',
    'sessionChains',
    'sessionRetryEnabled',
    'authGrace',
    'observedUserMessageIds',
    'sessionRetries',
    'initialDelayUsed',
    'chainExhaustion',
    'quotaExhaustedProviders',
  ])('%s entry is removed on session.deleted', (mapName) => {
    const coordinator = new SessionLifecycle(() => {});
    const mgr = new ForegroundFallbackManager(
      makeOptions({
        chains: makeChains(),
        input: { directory: '/test' } as never,
        maxRetries: 3,
        coordinator: coordinator,
      }),
    );
    const target = (mgr as any)[mapName];
    expect(target).toBeDefined();
    seedMap(target, 'gone');
    seedMap(target, 'keep');
    coordinator.dispatchSessionDeleted('gone');
    expect(target.has('gone')).toBe(false);
    expect(target.has('keep')).toBe(true);
  });

  test('teardown closes the idle gate for a disabled manager', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const mgr = new ForegroundFallbackManager(
      makeOptions({
        chains: makeChains(),
        v2RetryEnabled: false,
        input: { directory: '/test' } as never,
        maxRetries: 3,
        coordinator: coordinator,
      }),
    );
    (mgr as any).sessionRetryEnabled.set('gone', true);
    coordinator.dispatchSessionDeleted('gone');
    const event = {
      type: 'session.step.started',
      data: {
        sessionID: 'live',
        assistantMessageID: 'assistant-live',
        agent: 'orchestrator',
        model: { providerID: 'test', id: 'a' },
      },
    };
    await mgr.handleEvent(event);
    expect((mgr as any).v2Steps.has('live')).toBe(false);
    (mgr as any).sessionRetryEnabled.set('keep', true);
    await mgr.handleEvent(event);
    expect((mgr as any).v2Steps.has('live')).toBe(true);
  });
});

describe('ForegroundFallbackManager noteExternalTurn cleanup', () => {
  test('preserves provider marks for the fallback or an unknown model, but clears them on an external return to primary', () => {
    const mgr = new ForegroundFallbackManager(
      makeOptions({
        chains: makeChains(),
        input: {
          directory: '/test',
        },
      }),
    );
    const marks = (mgr as any).downProviders as Map<
      string,
      Map<string, number>
    >;
    (mgr as any).activeFallback.set('session', 'backup/b');
    marks.set('session', new Map([['primary', Date.now()]]));
    mgr.noteExternalTurn('session', 'backup/b');
    mgr.noteExternalTurn('session');
    expect(marks.has('session')).toBe(true);
    mgr.noteExternalTurn('session', 'primary/a');
    expect(marks.has('session')).toBe(false);
  });
});

describe('ForegroundFallbackManager dispose cleanup', () => {
  test.each([
    'observedUserMessageIds',
    'downProviders',
    'restoredFrom',
    'authGrace',
  ])('%s is cleared on dispose', (mapName) => {
    const mgr = new ForegroundFallbackManager(
      makeOptions({
        chains: makeChains(),
        input: {
          directory: '/test',
        },
      }),
    );
    const target = (mgr as any)[mapName];
    expect(target).toBeDefined();
    target.set('gone', 1);
    mgr.dispose();
    expect(target.has('gone')).toBe(false);
  });
});

describe('ForegroundFallbackManager resetRecoveryState cleanup', () => {
  test.each([
    'initialDelayUsed',
    'authGrace',
    'sessionRetries',
    'chainExhaustion',
    'sessionTried',
    'quotaExhaustedProviders',
  ])('%s entry is removed on resetRecoveryState', (mapName) => {
    const mgr = new ForegroundFallbackManager(
      makeOptions({
        chains: makeChains(),
        input: {
          directory: '/test',
        },
      }),
    );
    const target = (mgr as any)[mapName];
    expect(target).toBeDefined();
    seedMap(target, 'gone');
    seedMap(target, 'keep');
    (mgr as any).resetRecoveryState('gone');
    expect(target.has('gone')).toBe(false);
    expect(target.has('keep')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - chain generation pins (#1527)
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager chain generation pins', () => {
  const makeGenerationManager = (
    chains: Record<
      string,
      ReadonlyArray<string | { id: string; variant?: string }>
    >,
    startupEnabled = true,
  ) =>
    new ForegroundFallbackManager(
      makeOptions({
        chains: chains,
        input: { directory: '/test', hostFlavor: 'v2' } as never,
        maxRetries: 0,
        initialRetryDelayMs: 0,
        retryDelayMs: 0,
        v2RetryEnabled: startupEnabled,
      }),
    );

  test('durable team chains override an early event pin and isolate new A/B children from global refresh', async () => {
    createMockClient();
    const chains = {
      orchestrator: [{ id: 'test/global' }, { id: 'test/new-global' }],
    };
    const manager = makeGenerationManager(chains);
    const switchModel = mock(async () => {});
    try {
      for (const name of ['A', 'B']) {
        const id = `new-child-${name}`;
        // The async created event can reach the old global pin first.
        manager.registerSessionAgent(id, 'orchestrator');
        const snapshot = {
          orchestrator: [
            { id: `test/${name}` },
            { id: `backup/${name}`, variant: 'high' },
          ],
        };
        manager.pinSessionChains(id, snapshot);
        snapshot.orchestrator[1].id = 'mutated/not-a-snapshot';
        chains.orchestrator = [{ id: 'global/edited-again' }];
        await manager.handleV2Retry(
          {
            sessionID: id,
            agent: 'orchestrator',
            model: { providerID: 'test', id: name },
            error: { message: 'Rate limit exceeded' },
            decision: { retry: true },
          },
          switchModel,
        );
        expect(switchModel).toHaveBeenLastCalledWith(id, {
          providerID: 'backup',
          id: name,
          variant: 'high',
        });
      }
    } finally {
      manager.dispose();
    }
    // Restart under globally disabled fallback: a recovered enabled bundle
    // still steers, while a disabled bundle never follows the new global flag.
    const restored = makeGenerationManager(chains, false);
    try {
      const snapshot = {
        orchestrator: [{ id: 'test/old' }, { id: 'backup/old' }],
      };
      for (const enabled of [true, false]) {
        const sessionID = `restored-${enabled}`;
        restored.pinSessionChains(sessionID, snapshot, enabled);
        const decision = { retry: true };
        const switched = mock(async () => {});
        await restored.handleV2Retry(
          {
            sessionID,
            agent: 'orchestrator',
            model: { providerID: 'test', id: 'old' },
            error: { message: 'Rate limit exceeded' },
            decision,
          },
          switched,
        );
        expect(switched).toHaveBeenCalledTimes(enabled ? 1 : 0);
      }
    } finally {
      restored.dispose();
    }
  });

  test('registered child finishes its descent on its original chain across a swap', async () => {
    createMockClient();
    const chains: Record<
      string,
      ReadonlyArray<string | { id: string; variant?: string }>
    > = { orchestrator: ['test/a', 'test/b', 'test/c'] };
    const manager = makeGenerationManager(chains);
    const switchModel = mock(async () => {});
    const fail = (sessionID: string, model: string) => {
      const [providerID, id] = model.split('/');
      return manager.handleV2Retry(
        {
          sessionID,
          agent: 'orchestrator',
          model: { providerID, id },
          error: { message: 'Rate limit exceeded' },
          decision: { retry: true },
        },
        switchModel,
      );
    };

    // Registration pins the startup generation — the same moment the v2
    // profile bridge freezes the child's profile.
    manager.registerSessionAgent('child', 'orchestrator');

    // Hot refresh publishes a new chain generation before the first failure.
    chains.orchestrator = ['test/x', 'test/y'];

    // The pinned child keeps descending its original chain: a -> b -> c.
    await fail('child', 'test/a');
    expect(switchModel).toHaveBeenLastCalledWith('child', {
      providerID: 'test',
      id: 'b',
    });
    // Mid-descent swap (refresh while retrying) must not corrupt the
    // sequence: the next target still comes from the original chain.
    await fail('child', 'test/b');
    expect(switchModel).toHaveBeenLastCalledWith('child', {
      providerID: 'test',
      id: 'c',
    });

    // A child registered after the swap gets the new generation.
    manager.registerSessionAgent('child-new', 'orchestrator');
    await fail('child-new', 'test/x');
    expect(switchModel).toHaveBeenLastCalledWith('child-new', {
      providerID: 'test',
      id: 'y',
    });
  });

  test('lazy pin at first descent uses the generation current at that descent', async () => {
    createMockClient();
    const chains: Record<
      string,
      ReadonlyArray<string | { id: string; variant?: string }>
    > = { orchestrator: ['test/a', 'test/b'] };
    const manager = makeGenerationManager(chains);
    const switchModel = mock(async () => {});
    // Session never registered: the first descent pins whatever generation is
    // current (safety net for v1 hosts and roots).
    chains.orchestrator = ['test/x', 'test/y'];
    await manager.handleV2Retry(
      {
        sessionID: 'child-unseen',
        agent: 'orchestrator',
        model: { providerID: 'test', id: 'x' },
        error: { message: 'Rate limit exceeded' },
        decision: { retry: true },
      },
      switchModel,
    );
    expect(switchModel).toHaveBeenCalledWith('child-unseen', {
      providerID: 'test',
      id: 'y',
    });
  });

  test('releaseSessionChains lets a retry pin the current generation', async () => {
    createMockClient();
    const chains: Record<
      string,
      ReadonlyArray<string | { id: string; variant?: string }>
    > = { orchestrator: ['test/a', 'test/b'] };
    const manager = makeGenerationManager(chains);
    const switchModel = mock(async () => {});
    const fail = (sessionID: string, id: string) =>
      manager.handleV2Retry(
        {
          sessionID,
          agent: 'orchestrator',
          model: { providerID: 'test', id },
          error: { message: 'Rate limit exceeded' },
          decision: { retry: true },
        },
        switchModel,
      );

    // Failed admission: the capture-time pin existed (same call the bridge
    // makes), then was released before the retry.
    manager.pinSessionChains('release-child');
    manager.releaseSessionChains('release-child');
    // Refresh publishes gen B before the retry.
    chains.orchestrator = ['test/x', 'test/y'];

    // The retry lazily pins the current generation: descent follows x -> y.
    // A stale gen-A pin would descend a -> b instead.
    await fail('release-child', 'x');
    expect(switchModel).toHaveBeenLastCalledWith('release-child', {
      providerID: 'test',
      id: 'y',
    });
  });

  test('a pinned snapshot without a chain for the agent falls back to the live chain table (#1927)', async () => {
    createMockClient();
    const chains: Record<
      string,
      ReadonlyArray<string | { id: string; variant?: string }>
    > = {
      orchestrator: ['test/a', 'test/b'],
      designer: ['glm/glm-5.3', 'kimi/kimi-k2.8-preview'],
    };
    const manager = makeGenerationManager(chains);
    const switchModel = mock(async () => {});
    try {
      // Scalar-era frozen bundle: the snapshot predates fallback chains, so
      // it carries no entry for designer at all. Unlike disableChain, which
      // keeps an explicit empty entry, a missing key means "never configured
      // when this snapshot was taken".
      manager.pinSessionChains('stale-parent', {
        orchestrator: ['test/a', 'test/b'],
      });

      // The frozen model goes down: failover must engage the live chain
      // instead of erroring on every request with no fallback.
      await manager.handleV2Retry(
        {
          sessionID: 'stale-parent',
          agent: 'designer',
          model: { providerID: 'kimi', id: 'kimi-k2.8-preview' },
          error: { message: 'Rate limit exceeded' },
          decision: { retry: true },
        },
        switchModel,
      );
      expect(switchModel).toHaveBeenCalledWith('stale-parent', {
        providerID: 'glm',
        id: 'glm-5.3',
      });
    } finally {
      manager.dispose();
    }
  });

  test('an adopted live chain keeps its models and variants across refresh', async () => {
    createMockClient();
    const chains: Record<
      string,
      ReadonlyArray<string | { id: string; variant?: string }>
    > = {
      designer: [
        'first/a',
        { id: 'second/b', variant: 'high' },
        { id: 'third/c', variant: 'low' },
      ],
    };
    const manager = makeGenerationManager(chains);
    const switchModel = mock(async () => {});
    const fail = (providerID: string, id: string, variant?: string) =>
      manager.handleV2Retry(
        {
          sessionID: 'stale-descent',
          agent: 'designer',
          model: { providerID, id, ...(variant ? { variant } : {}) },
          error: { message: 'Rate limit exceeded' },
          decision: { retry: true },
        },
        switchModel,
      );
    try {
      manager.pinSessionChains('stale-descent', {});
      await fail('first', 'a');
      expect(switchModel).toHaveBeenLastCalledWith('stale-descent', {
        providerID: 'second',
        id: 'b',
        variant: 'high',
      });

      chains.designer = [{ id: 'second/b', variant: 'new-variant' }];
      await fail('second', 'b', 'high');
      expect(switchModel).toHaveBeenCalledTimes(2);
      expect(switchModel).toHaveBeenLastCalledWith('stale-descent', {
        providerID: 'third',
        id: 'c',
        variant: 'low',
      });
    } finally {
      manager.dispose();
    }
  });

  test('an explicitly disabled chain stays disabled even when the live table has a chain (#1927)', async () => {
    createMockClient();
    const chains: Record<
      string,
      ReadonlyArray<string | { id: string; variant?: string }>
    > = {
      orchestrator: ['test/a', 'test/b'],
      designer: ['glm/glm-5.3', 'kimi/kimi-k2.8-preview'],
    };
    const manager = makeGenerationManager(chains);
    const switchModel = mock(async () => {});
    try {
      // Same stale snapshot as above, but the agent's chain was explicitly
      // disabled afterwards: the empty entry must keep failover off.
      manager.pinSessionChains('stale-parent', {
        orchestrator: ['test/a', 'test/b'],
      });
      manager.disableChain('designer');

      await manager.handleV2Retry(
        {
          sessionID: 'stale-parent',
          agent: 'designer',
          model: { providerID: 'kimi', id: 'kimi-k2.8-preview' },
          error: { message: 'Rate limit exceeded' },
          decision: { retry: true },
        },
        switchModel,
      );
      expect(switchModel).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - resolveChain correctness
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager resolveChain cross-agent isolation', () => {
  test('suppresses fallback when the session agent cannot be resolved', async () => {
    const { client } = createMockClient({ getData: null });
    const switchModel = mock(async () => {});
    const mgr = new ForegroundFallbackManager(
      makeOptions({
        chains: { orchestrator: ['openai/gpt-4o', 'anthropic/claude'] },
        input: {
          client,
          directory: '/test',
          hostFlavor: 'v2',
          experimental_v2: { switchModel },
        } as any,
        maxRetries: 0,
      }),
    );

    await mgr.handleV2Retry(
      {
        sessionID: 'known-without-chain',
        agent: 'unknown',
        model: { providerID: 'openai', id: 'gpt-4o' },
        error: { message: 'rate limit' },
        decision: { retry: false },
      },
      switchModel,
    );
    expect(switchModel).not.toHaveBeenCalled();

    await mgr.handleV2Retry(
      {
        sessionID: 'infer-by-model',
        model: { providerID: 'openai', id: 'gpt-4o' },
        error: { message: 'rate limit' },
        decision: { retry: false },
      },
      switchModel,
    );
    expect(switchModel).toHaveBeenCalledWith('infer-by-model', {
      providerID: 'anthropic',
      id: 'claude',
    });

    await mgr.handleEvent({
      type: 'session.step.started',
      data: {
        sessionID: 'no-agent-or-model',
        assistantMessageID: 'refused',
        agent: '',
        model: { providerID: 'openai', id: 'gpt-4o' },
      },
    });
    await mgr.handleEvent({
      type: 'session.step.failed',
      data: {
        sessionID: 'no-agent-or-model',
        assistantMessageID: 'refused',
        finish: 'content-filter',
        error: { type: 'provider.content-filter', message: 'content filter' },
      },
    });
    await mgr.pendingRefusalOutcome('no-agent-or-model', 'refused');
    expect(switchModel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// disableChain API
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager disableChain', () => {
  test('after disableChain, rate-limit error surfaces instead of falling back', async () => {
    const { manager } = makeManager({ maxRetries: 0 });
    const switchModel = mock(async () => {});
    const event = retryEvent('sess-disabled', 'a', { retry: false });
    manager.disableChain('orchestrator');

    await manager.handleV2Retry(event, switchModel);
    expect(switchModel).not.toHaveBeenCalled();
    expect(event.decision).toEqual({ retry: false });

    const { manager: enabled } = makeManager({ maxRetries: 0 });
    const control = retryEvent('sess-enabled', 'a', { retry: false });
    await enabled.handleV2Retry(control, switchModel);
    expect(switchModel).toHaveBeenCalledWith('sess-enabled', {
      providerID: 'test',
      id: 'b',
    });
    expect(control.decision).toEqual({ retry: true, delay: 0 });
  });
});

// ---------------------------------------------------------------------------
// dispose (reload generation cleanup)
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager dispose', () => {
  test('dispose leaves a later v2 retry decision untouched', async () => {
    const { manager } = makeManager({ maxRetries: 0 });
    const switchModel = mock(async () => {});
    const event = retryEvent('sess-stale-generation', 'a', { retry: false });
    manager.dispose();

    await manager.handleV2Retry(event, switchModel);

    expect(switchModel).not.toHaveBeenCalled();
    expect(event.decision).toEqual({ retry: false });
  });
});

// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager failover classification', () => {
  test('backpressure wording with a deterministic 4xx stays a hard error', () => {
    const message = 'Streaming response failed: [400] invalid request';
    expect(isFailoverError(message)).toBe(false);
    expect(isFailoverError({ message })).toBe(false);
    expect(
      isFailoverError({
        statusCode: 400,
        message: 'streaming response failed',
      }),
    ).toBe(false);
    // 429 is transient backpressure, not a deterministic rejection.
    expect(isFailoverError('request queue is full (429)')).toBe(true);
  });
});

describe('ForegroundFallbackManager failover classification hardening', () => {
  test('"upstream error" with a deterministic 4xx status stays a hard error', () => {
    expect(
      isFailoverError({
        statusCode: 400,
        message: 'upstream error: timeout must be positive',
      }),
    ).toBe(false);
    expect(
      isFailoverError({ statusCode: 429, message: 'upstream error: 429' }),
    ).toBe(true);
  });
  describe('Antigravity 412 and quota-reset recognition on v2', () => {
    test('handleV2Retry switches immediately on Antigravity 412 account pool unavailable without status field', async () => {
      const { client } = createMockClient();
      const mgr = new ForegroundFallbackManager(
        makeOptions({
          chains: {
            reviewer: [
              { id: 'google/antigravity-claude-sonnet-5-5', variant: 'medium' },
              { id: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
              { id: 'google/antigravity-gemini-3.8-flash', variant: 'high' },
            ],
          },
          input: { client, directory: '/test', hostFlavor: 'v2' } as any,
          maxRetries: 3,
        }),
      );
      const switched: Array<{
        sessionID: string;
        model: { providerID: string; id: string; variant?: string };
      }> = [];
      const event = {
        sessionID: 'ses-ag-pool-412',
        agent: 'reviewer',
        model: { providerID: 'google', id: 'antigravity-claude-sonnet-5-5' },
        error: {
          message:
            'Antigravity account pool has no account available within the configured wait limit. Add accounts with `opencode auth login` or wait for account availability. Quota resets in 142h 40m 46s.',
        },
        decision: { retry: false },
      };

      await mgr.handleV2Retry(event, async (sessionID, model) => {
        switched.push({ sessionID, model });
      });

      expect(switched).toEqual([
        {
          sessionID: 'ses-ag-pool-412',
          model: {
            providerID: 'opencode-go',
            id: 'deepseek-v4.1-flash',
            variant: 'high',
          },
        },
      ]);
      expect(event.decision.retry).toBe(true);
    });

    test('handleV2Retry switches immediately on Antigravity HTTP 412 account pool error with top-level status and active retry decision', async () => {
      const { client } = createMockClient();
      const mgr = new ForegroundFallbackManager(
        makeOptions({
          chains: {
            reviewer: [
              { id: 'google/antigravity-claude-sonnet-5-5', variant: 'medium' },
              { id: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
            ],
          },
          input: { client, directory: '/test', hostFlavor: 'v2' } as any,
          maxRetries: 3,
        }),
      );
      const switched: Array<{
        sessionID: string;
        model: { providerID: string; id: string; variant?: string };
      }> = [];
      const event = {
        sessionID: 'ses-ag-412-status',
        agent: 'reviewer',
        model: { providerID: 'google', id: 'antigravity-claude-sonnet-5-5' },
        error: {
          status: 412,
          message:
            'Precondition Failed: Antigravity account pool is unavailable',
        },
        decision: { retry: true, delay: 1000 },
      };

      await mgr.handleV2Retry(event, async (sessionID, model) => {
        switched.push({ sessionID, model });
      });

      expect(switched).toEqual([
        {
          sessionID: 'ses-ag-412-status',
          model: {
            providerID: 'opencode-go',
            id: 'deepseek-v4.1-flash',
            variant: 'high',
          },
        },
      ]);
      expect(event.decision.retry).toBe(true);
      expect((mgr as any).sessionRetries.get('ses-ag-412-status') ?? 0).toBe(0);
    });

    test('handleV2Retry switches immediately on Antigravity Quota resets in ... error with nested body error code', async () => {
      const { client } = createMockClient();
      const mgr = new ForegroundFallbackManager(
        makeOptions({
          chains: {
            reviewer: [
              { id: 'google/antigravity-claude-sonnet-5-5' },
              { id: 'opencode-go/deepseek-v4.1-flash' },
            ],
          },
          input: { client, directory: '/test', hostFlavor: 'v2' } as any,
        }),
      );
      const switched: Array<{
        sessionID: string;
        model: { providerID: string; id: string };
      }> = [];
      const event = {
        sessionID: 'ses-ag-quota-reset',
        agent: 'reviewer',
        model: { providerID: 'google', id: 'antigravity-claude-sonnet-5-5' },
        error: {
          data: {
            body: {
              error: {
                code: 412,
                message: 'Quota resets in 10h 30m. Please try again later.',
              },
            },
          },
        },
        decision: { retry: false },
      };

      await mgr.handleV2Retry(event, async (sessionID, model) => {
        switched.push({ sessionID, model });
      });

      expect(switched).toEqual([
        {
          sessionID: 'ses-ag-quota-reset',
          model: {
            providerID: 'opencode-go',
            id: 'deepseek-v4.1-flash',
          },
        },
      ]);
      expect(event.decision.retry).toBe(true);
    });

    test('handleV2Retry switches immediately on FAILED_PRECONDITION error without top-level status field', async () => {
      const { client } = createMockClient();
      const mgr = new ForegroundFallbackManager(
        makeOptions({
          chains: {
            reviewer: [
              { id: 'google/antigravity-claude-sonnet-5-5' },
              { id: 'opencode-go/deepseek-v4.1-flash' },
            ],
          },
          input: { client, directory: '/test', hostFlavor: 'v2' } as any,
        }),
      );
      const switched: Array<{
        sessionID: string;
        model: { providerID: string; id: string };
      }> = [];
      const event = {
        sessionID: 'ses-ag-failed-precondition',
        agent: 'reviewer',
        model: { providerID: 'google', id: 'antigravity-claude-sonnet-5-5' },
        error: {
          message:
            'FAILED_PRECONDITION: requested Antigravity model is not available to the configured accounts',
        },
        decision: { retry: true, delay: 500 },
      };

      await mgr.handleV2Retry(event, async (sessionID, model) => {
        switched.push({ sessionID, model });
      });

      expect(switched).toEqual([
        {
          sessionID: 'ses-ag-failed-precondition',
          model: {
            providerID: 'opencode-go',
            id: 'deepseek-v4.1-flash',
          },
        },
      ]);
      expect(event.decision.retry).toBe(true);
    });

    test('handleV2Retry switches immediately on bare FAILED_PRECONDITION error with status 412', async () => {
      const { client } = createMockClient();
      const mgr = new ForegroundFallbackManager(
        makeOptions({
          chains: {
            reviewer: [
              { id: 'google/antigravity-claude-sonnet-5-5' },
              { id: 'opencode-go/deepseek-v4.1-flash' },
            ],
          },
          input: { client, directory: '/test', hostFlavor: 'v2' } as any,
        }),
      );
      const switched: Array<{
        sessionID: string;
        model: { providerID: string; id: string };
      }> = [];
      const event = {
        sessionID: 'ses-bare-412-precondition',
        agent: 'reviewer',
        model: { providerID: 'google', id: 'antigravity-claude-sonnet-5-5' },
        error: {
          status: 412,
          message: 'FAILED_PRECONDITION',
        },
        decision: { retry: false },
      };

      await mgr.handleV2Retry(event, async (sessionID, model) => {
        switched.push({ sessionID, model });
      });

      expect(switched).toEqual([
        {
          sessionID: 'ses-bare-412-precondition',
          model: {
            providerID: 'opencode-go',
            id: 'deepseek-v4.1-flash',
          },
        },
      ]);
      expect(event.decision.retry).toBe(true);
    });

    test('handleV2Retry does not switch on generic 412 without Antigravity pool or precondition text', async () => {
      const { client } = createMockClient();
      const mgr = new ForegroundFallbackManager(
        makeOptions({
          chains: {
            reviewer: [
              { id: 'google/antigravity-claude-sonnet-5-5' },
              { id: 'opencode-go/deepseek-v4.1-flash' },
            ],
          },
          input: { client, directory: '/test', hostFlavor: 'v2' } as any,
        }),
      );
      const switched: Array<{
        sessionID: string;
        model: { providerID: string; id: string };
      }> = [];
      const event = {
        sessionID: 'ses-generic-412',
        agent: 'reviewer',
        model: { providerID: 'google', id: 'antigravity-claude-sonnet-5-5' },
        error: {
          status: 412,
          message: 'If-Match header validation failed',
        },
        decision: { retry: false },
      };

      await mgr.handleV2Retry(event, async (sessionID, model) => {
        switched.push({ sessionID, model });
      });

      expect(switched).toHaveLength(0);
      expect(event.decision.retry).toBe(false);
    });

    test('handleV2Retry absorbs host retry for HTTP 412 with short-horizon quota reset instead of switching immediately', async () => {
      const { client } = createMockClient();
      const mgr = new ForegroundFallbackManager(
        makeOptions({
          chains: {
            reviewer: [
              { id: 'google/antigravity-claude-sonnet-5-5' },
              { id: 'opencode-go/deepseek-v4.1-flash' },
            ],
          },
          input: { client, directory: '/test', hostFlavor: 'v2' } as any,
          maxRetries: 3,
        }),
      );
      const switched: Array<{
        sessionID: string;
        model: { providerID: string; id: string };
      }> = [];
      const error = {
        status: 412,
        message: 'Rate limited, quota resets in 30s',
      };
      expect(isPermanentQuotaBillingError(error)).toBe(false);

      const event = {
        sessionID: 'ses-412-short-reset',
        agent: 'reviewer',
        model: { providerID: 'google', id: 'antigravity-claude-sonnet-5-5' },
        error,
        decision: { retry: true, delay: 1000 },
      };

      await mgr.handleV2Retry(event, async (sessionID, model) => {
        switched.push({ sessionID, model });
      });

      expect(switched).toHaveLength(0);
      expect(event.decision.retry).toBe(true);
      expect((mgr as any).sessionRetries.get('ses-412-short-reset')).toBe(1);
    });

    test('isSpentQuotaError keeps whole JSON responseBody together and does not classify retry-eligible bodies as spent', () => {
      const error = {
        data: {
          responseBody: JSON.stringify({
            error: {
              message: 'Quota exceeded',
              details: 'Please retry after 30s',
            },
          }),
        },
      };
      expect(isSpentQuotaError(error)).toBe(false);
    });
  });
});

describe('fallback restoration', () => {
  const sid = 'restore-session';
  const ttl = 30 * 60 * 1000;
  const origin = { providerID: 'primary', id: 'a', variant: 'high' };
  const backup = { providerID: 'backup', id: 'b' };
  const outage = { status: 503, message: 'provider unavailable' };
  const rejection = { type: 'provider.content-filter', message: 'blocked' };
  const idle = (activityAt = clock.now()) => ({
    type: 'session.idle',
    properties: { sessionID: sid, activityAt },
  });
  const busy = () => ({
    type: 'session.status',
    properties: { sessionID: sid, status: { type: 'busy' } },
  });

  function fixture(options?: {
    parentID?: string;
    promptAsyncImpl?: (args: unknown) => Promise<unknown>;
    chain?: string[];
    retryDelayMs?: number;
  }) {
    const info: {
      model:
        | typeof origin
        | { providerID: string; id: string; variant?: string };
      agent: string;
      parentID?: string;
    } = {
      model: { ...origin },
      agent: 'orchestrator',
      parentID: options?.parentID,
    };
    const { client, session, mocks } = createMockClient({
      getData: info,
      promptAsyncImpl: options?.promptAsyncImpl,
    });
    const switchModel = mock(
      async (_sessionID: string, model: typeof info.model) => {
        info.model = model;
      },
    );
    const changed = mock();
    const manager = timedManager({
      chains: {
        orchestrator: options?.chain ?? ['primary/a', 'backup/b', 'third/c'],
      },
      v2RetryEnabled: true,
      maxRetries: 0,
      retryDelayMs: options?.retryDelayMs ?? 0,
      input: {
        directory: '/test',
        hostFlavor: 'v2',
        client,
        experimental_v2: { switchModel },
      } as never,
      onSessionModelChanged: changed,
    });
    const retry = (model = origin, error: unknown = rejection) =>
      manager.handleV2Retry(
        { sessionID: sid, agent: 'orchestrator', model, error },
        switchModel,
      );
    const refuse = async (
      id = 'refused',
      model: typeof info.model = origin,
    ) => {
      await manager.handleEvent({
        type: 'session.step.started',
        data: {
          sessionID: sid,
          assistantMessageID: id,
          agent: 'orchestrator',
          model,
        },
      });
      await manager.handleEvent({
        type: 'session.step.failed',
        data: {
          sessionID: sid,
          assistantMessageID: id,
          finish: 'content-filter',
          error: rejection,
        },
      });
      for (let i = 0; i < 40; i++) await Promise.resolve();
    };
    return {
      manager,
      info,
      switchModel,
      changed,
      retry,
      refuse,
      session,
      mocks,
    };
  }

  async function startStep(
    manager: ForegroundFallbackManager,
    assistantMessageID: string,
    model: { providerID: string; id: string; variant?: string },
  ) {
    await manager.handleEvent({
      type: 'session.step.started',
      data: {
        sessionID: sid,
        assistantMessageID,
        agent: 'orchestrator',
        model,
      },
    });
  }

  async function toolStep(
    manager: ForegroundFallbackManager,
    assistantMessageID?: string,
  ) {
    await manager.handleEvent({
      type: 'session.step.ended',
      data: { sessionID: sid, assistantMessageID, finish: 'tool-calls' },
    });
    for (let i = 0; i < 40; i++) await Promise.resolve();
  }

  async function restoreWithInFlightStep(f: ReturnType<typeof fixture>) {
    await f.manager.handleEvent(busy());
    await f.retry(origin, outage);
    await clock.advance(ttl);
    await toolStep(f.manager);
    // The host can start this step before the event subscriber restores.
    await startStep(f.manager, 'in-flight', backup);
  }

  async function restoreWithPendingAck(f: ReturnType<typeof fixture>) {
    await f.manager.handleEvent(busy());
    await f.retry(origin, outage);
    await startStep(f.manager, 'before-restore', backup);
    await clock.advance(ttl);
    const applied = deferred<void>();
    const ack = Promise.withResolvers<void>();
    const lookup = deferred<{ data: typeof f.info }>();
    const get = f.session.get;
    f.session.get = mock(() => lookup.promise);
    f.switchModel.mockImplementationOnce(async (_sessionID, model) => {
      f.info.model = model;
      applied.resolve();
      await ack.promise;
    });
    const pending = toolStep(f.manager, 'before-restore');
    expect((f.manager as any).restoredFrom.has(sid)).toBe(false);
    expect(f.switchModel).toHaveBeenCalledTimes(1);
    f.session.get = get;
    lookup.resolve({ data: f.info });
    await applied.promise;
    return { ack, pending };
  }

  test('mid-turn restores after the original outage deadline even after another switch', async () => {
    const f = fixture({
      chain: ['primary/a', 'primary/y', 'backup/b', 'third/c'],
    });
    const sibling = { providerID: 'primary', id: 'y' };
    await f.manager.handleEvent(busy());
    await f.retry(origin, outage);
    expect(f.info.model).toEqual(sibling);
    await clock.advance(ttl / 2);
    await f.retry(sibling, rejection);
    await f.retry(backup, { message: 'usage limit reached' });
    await toolStep(f.manager);
    expect(f.switchModel).toHaveBeenCalledTimes(3);
    expect(clock.pending()).toBe(0);
    await clock.advance(ttl / 2 - 1);
    await toolStep(f.manager);
    expect(f.switchModel).toHaveBeenCalledTimes(3);
    await clock.advance(1);
    await f.manager.handleEvent({
      type: 'session.step.ended',
      data: { sessionID: sid, finish: 'length' },
    });
    expect(f.switchModel).toHaveBeenCalledTimes(3);
    await toolStep(f.manager);
    expect(f.switchModel).toHaveBeenLastCalledWith(sid, origin);
    expect(f.manager.getActiveFallback(sid)).toBeUndefined();
  });

  test('mid-turn does not probe a spent quota even after a later outage', async () => {
    const f = fixture();
    await f.manager.handleEvent(busy());
    await f.retry(origin, { message: 'usage limit reached' });
    await f.retry(backup, outage);
    await clock.advance(ttl);
    await toolStep(f.manager);
    expect(f.switchModel).toHaveBeenCalledTimes(2);
    expect(f.info.model).toEqual({ providerID: 'third', id: 'c' });
  });

  test('mid-turn does not probe permanent billing failures', async () => {
    const initial = fixture();
    await initial.manager.handleEvent(busy());
    await initial.retry(origin, { status: 402, message: 'payment required' });
    await clock.advance(ttl);
    await toolStep(initial.manager);
    expect(initial.switchModel).toHaveBeenCalledTimes(1);
    expect(initial.info.model).toEqual(backup);
    initial.manager.dispose();

    const f = fixture({ chain: ['primary/a', 'primary/y', 'backup/b'] });
    await f.manager.handleEvent(busy());
    await f.retry(origin, outage);
    await f.retry(
      { providerID: 'primary', id: 'y' },
      { status: 402, message: 'payment required' },
    );
    await clock.advance(ttl);
    await toolStep(f.manager);
    expect(f.switchModel).toHaveBeenCalledTimes(2);
  });

  test('mid-turn does not probe a request rejection even after a later outage', async () => {
    const f = fixture();
    await f.manager.handleEvent(busy());
    await f.retry();
    await f.retry(backup, outage);
    await clock.advance(ttl);
    await toolStep(f.manager);
    expect(f.switchModel).toHaveBeenCalledTimes(2);
    await f.manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenLastCalledWith(sid, origin);
  });

  test('mid-turn repeated outages start a fresh deadline without timers', async () => {
    const f = fixture();
    await f.manager.handleEvent(busy());
    await f.retry(origin, outage);
    await clock.advance(ttl);
    await toolStep(f.manager);
    expect(f.info.model).toEqual(origin);
    await f.retry(origin, outage);
    expect(f.info.model).toEqual(backup);
    await toolStep(f.manager);
    await clock.advance(ttl - 1);
    await toolStep(f.manager);
    expect(f.switchModel).toHaveBeenCalledTimes(3);
    expect(clock.pending()).toBe(0);
    await clock.advance(1);
    await toolStep(f.manager);
    expect(f.switchModel).toHaveBeenCalledTimes(4);
    expect(f.info.model).toEqual(origin);
  });

  test('mid-turn preserves a manually selected fallback variant', async () => {
    const f = fixture();
    await f.manager.handleEvent(busy());
    await f.retry(origin, outage);
    f.info.model = { ...backup, variant: 'manual' };
    await clock.advance(ttl);
    await toolStep(f.manager);
    expect(f.switchModel).toHaveBeenCalledTimes(1);
    expect(f.info.model).toEqual({ ...backup, variant: 'manual' });
    expect(f.manager.getActiveFallback(sid)).toBeUndefined();
  });

  test('F1 queued fallback success retains attribution for the next fallback refusal', async () => {
    const f = fixture();
    await f.manager.handleEvent(busy());
    await f.retry(origin, outage);
    await startStep(f.manager, 'fallback-n', backup);
    await clock.advance(ttl);
    await toolStep(f.manager, 'fallback-n');
    expect(f.info.model).toEqual(origin);
    await startStep(f.manager, 'fallback-n1', backup);
    await toolStep(f.manager, 'fallback-n1');
    await f.refuse('fallback-n2', backup);
    expect(await f.manager.pendingRefusalOutcome(sid, 'fallback-n2')).toBe(
      'primary/a',
    );
    expect(f.switchModel).toHaveBeenCalledTimes(2);
    expect(f.mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('F2 spent quota on the origin provider disables a later mid-turn probe', async () => {
    const f = fixture({ chain: ['primary/a', 'primary/y', 'backup/b'] });
    await f.manager.handleEvent(busy());
    await f.retry(origin, outage);
    await f.retry(
      { providerID: 'primary', id: 'y' },
      { message: 'usage limit reached' },
    );
    expect(f.info.model).toEqual(backup);
    await toolStep(f.manager);
    await clock.advance(ttl);
    await toolStep(f.manager);
    expect(f.switchModel).toHaveBeenCalledTimes(2);
    expect(f.info.model).toEqual(backup);
  });

  test('mid-turn restore holds the event pump until the switch is acknowledged', async () => {
    const f = fixture();
    await f.manager.handleEvent(busy());
    await f.retry(origin, outage);
    await startStep(f.manager, 'before-restore', backup);
    await clock.advance(ttl);
    const applied = deferred<void>();
    const ack = deferred<void>();
    f.switchModel.mockImplementationOnce(async (_sessionID, model) => {
      f.info.model = model;
      applied.resolve();
      await ack.promise;
    });
    let settled = false;
    const processing = f.manager
      .handleEvent({
        type: 'session.step.ended',
        data: {
          sessionID: sid,
          assistantMessageID: 'before-restore',
          finish: 'tool-calls',
        },
      })
      .then(() => {
        settled = true;
      });
    try {
      await applied.promise;
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      ack.resolve();
      await processing;
    }
    expect(settled).toBe(true);
    expect(f.info.model).toEqual(origin);
  });

  test('N1 retry hook during restore ACK keeps the original and spent-quota evidence', async () => {
    const f = fixture();
    const { ack, pending } = await restoreWithPendingAck(f);
    const event = {
      sessionID: sid,
      agent: 'orchestrator',
      model: backup,
      error: { message: 'usage limit reached' },
      decision: { retry: false },
    };
    await f.manager.handleV2Retry(event, f.switchModel);
    const callsBeforeAck = f.switchModel.mock.calls.length;
    ack.resolve();
    await pending;
    expect(event.decision).toEqual({ retry: true, delay: 0 });
    expect(callsBeforeAck).toBe(2);
    expect(f.info.model).toEqual(origin);
    expect(f.manager.getActiveFallback(sid)).toBeUndefined();
    expect((f.manager as any).restoredFrom.has(sid)).toBe(false);
    await f.retry(origin, outage);
    expect(f.info.model).toEqual({ providerID: 'third', id: 'c' });
    f.manager.dispose();

    const failed = fixture();
    const waiting = await restoreWithPendingAck(failed);
    waiting.ack.reject(new Error('restore rejected'));
    await waiting.pending;
    expect((failed.manager as any).restoredFrom.has(sid)).toBe(false);
    expect(failed.manager.getActiveFallback(sid)?.model).toBe('backup/b');
  });

  test('F3 late request rejection excludes the failed fallback on the next outage', async () => {
    const provider = fixture({ retryDelayMs: 250 });
    await restoreWithInFlightStep(provider);
    expect(provider.info.model).toEqual(origin);
    const providerEvent = {
      sessionID: sid,
      agent: 'orchestrator',
      model: backup,
      error: outage,
      decision: { retry: false, delay: 900 },
    };
    await provider.manager.handleV2Retry(providerEvent, provider.switchModel);
    expect(providerEvent.decision).toEqual({ retry: true, delay: 250 });
    expect(provider.info.model).toEqual(origin);
    expect(provider.switchModel).toHaveBeenCalledTimes(2);
    expect(provider.manager.getActiveFallback(sid)).toBeUndefined();
    provider.manager.dispose();

    const f = fixture();
    await restoreWithInFlightStep(f);
    const event = {
      sessionID: sid,
      agent: 'orchestrator',
      model: backup,
      error: rejection,
      decision: { retry: false },
    };
    await f.manager.handleV2Retry(event, f.switchModel);
    expect(event.decision).toEqual({ retry: true, delay: 0 });
    expect(f.info.model).toEqual(origin);
    await f.retry(origin, outage);
    expect(f.info.model).toEqual({ providerID: 'third', id: 'c' });
  });

  test('F3 late spent quota excludes the failed provider on the next outage', async () => {
    const f = fixture();
    await restoreWithInFlightStep(f);
    const event = {
      sessionID: sid,
      agent: 'orchestrator',
      model: backup,
      error: { message: 'usage limit reached' },
      decision: { retry: false },
    };
    await f.manager.handleV2Retry(event, f.switchModel);
    expect(event.decision).toEqual({ retry: true, delay: 0 });
    expect(f.info.model).toEqual(origin);
    await f.retry(origin, outage);
    expect(f.info.model).toEqual({ providerID: 'third', id: 'c' });
  });

  test('F4 interrupted run drops attribution on a new external prompt', async () => {
    const f = fixture();
    await restoreWithInFlightStep(f);
    for (const event of mapV2EventToV1({
      type: 'session.execution.interrupted',
      data: { sessionID: sid, reason: 'abort' },
    }))
      await f.manager.handleEvent(event);
    const bridge = createSessionPromptBridge(
      async () => {},
      (sessionID, messageID) =>
        f.manager.observeExternalPromptIntent(sessionID, messageID),
    );
    bridge.observePromptIntent({
      sessionID: sid,
      messageID: 'new-external',
      prompt: { text: 'continue on the selected model' },
    } as never);
    f.info.model = backup;
    await f.retry(backup, outage);
    expect(f.switchModel).toHaveBeenCalledTimes(3);
    expect(f.info.model).toEqual({ providerID: 'primary', id: 'a' });
    expect(f.manager.getActiveFallback(sid)?.model).toBe('primary/a');
  });

  test('mid-turn success clears attribution of the previous fallback', async () => {
    const f = fixture();
    await restoreWithInFlightStep(f);
    expect(f.info.model).toEqual(origin);
    await startStep(f.manager, 'original-success', origin);
    await f.manager.handleEvent({
      type: 'session.step.ended',
      data: {
        sessionID: sid,
        assistantMessageID: 'original-success',
        finish: 'stop',
      },
    });
    expect((f.manager as any).restoredFrom.has(sid)).toBe(false);
    await f.retry(origin, outage);
    expect(f.info.model).toEqual(backup);
    await f.retry(backup, outage);
    expect(f.info.model).toEqual({ providerID: 'third', id: 'c' });
  });

  test('mid-turn consumes attribution on a nonmatching retry', async () => {
    const f = fixture();
    await restoreWithInFlightStep(f);
    expect(f.info.model).toEqual(origin);
    await f.retry(origin, outage);
    await f.retry(backup, outage);
    expect(f.info.model).toEqual({ providerID: 'third', id: 'c' });
    expect(f.switchModel).toHaveBeenCalledTimes(4);
  });

  test('mid-turn late refusal respects a manual variant selected after restoration', async () => {
    const f = fixture();
    await restoreWithInFlightStep(f);
    f.info.model = { ...origin, variant: 'manual' };
    await f.manager.handleEvent({
      type: 'session.step.failed',
      data: {
        sessionID: sid,
        assistantMessageID: 'in-flight',
        finish: 'content-filter',
        error: rejection,
      },
    });
    expect(
      await f.manager.pendingRefusalOutcome(sid, 'in-flight'),
    ).toBeUndefined();
    expect(f.switchModel).toHaveBeenCalledTimes(2);
    expect(f.mocks.promptAsync).not.toHaveBeenCalled();
    expect(f.info.model).toEqual({ ...origin, variant: 'manual' });
  });

  test('mid-turn late root refusal continues on the origin and excludes the rejected fallback', async () => {
    const f = fixture();
    await restoreWithInFlightStep(f);
    expect(f.info.model).toEqual(origin);
    await f.manager.handleEvent({
      type: 'session.step.failed',
      data: {
        sessionID: sid,
        assistantMessageID: 'in-flight',
        finish: 'content-filter',
        error: rejection,
      },
    });
    expect(await f.manager.pendingRefusalOutcome(sid, 'in-flight')).toBe(
      'primary/a',
    );
    expect(f.switchModel).toHaveBeenCalledTimes(2);
    expect(f.mocks.promptAsync).toHaveBeenCalledTimes(1);
    const request = f.mocks.promptAsync.mock.calls[0]?.[0] as {
      body: { agent: string; model?: unknown; parts: unknown[] };
    };
    expect(request.body.agent).toBe('orchestrator');
    expect(request.body.model).toBeUndefined();
    expect(isInternalInitiatorPart(request.body.parts[0])).toBe(true);
    await f.manager.handleEvent(busy());
    await f.retry(origin, outage);
    expect(f.info.model).toEqual({ providerID: 'third', id: 'c' });
  });

  test('T1: v2 restores the first origin and variant after multiple switches', async () => {
    const f = fixture();
    await f.retry();
    await f.retry({ providerID: 'backup', id: 'b', variant: 'default' });
    await f.manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenLastCalledWith(sid, origin);
    expect(f.manager.getActiveFallback(sid)).toBeUndefined();
    expect(f.changed).toHaveBeenLastCalledWith(sid, 'primary/a', {
      agentName: 'orchestrator',
      variant: 'high',
    });
  });

  test('T2: v2 ignores the failed run idle after continuation admission', async () => {
    const f = fixture();
    await f.refuse();
    clock.set(clock.now() + 10);
    await f.manager.handleEvent({
      type: 'session.execution.failed',
      created: clock.now(),
      data: { sessionID: sid, error: rejection },
    });
    await f.manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenCalledTimes(1);
    await f.manager.handleEvent({
      type: 'session.status',
      properties: { sessionID: sid, status: { type: 'busy' } },
    });
    await f.manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenLastCalledWith(sid, origin);
  });

  test('T3: v2 does not restore during an in-flight refusal', async () => {
    const pending = deferred<unknown>();
    const f = fixture({ promptAsyncImpl: () => pending.promise });
    await f.refuse();
    expect(f.manager.isFallbackInProgress(sid)).toBe(true);
    await f.manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenCalledTimes(1);
    pending.resolve({});
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await f.manager.handleEvent({
      type: 'session.status',
      properties: { sessionID: sid, status: { type: 'busy' } },
    });
    await f.manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenLastCalledWith(sid, origin);
  });

  test('v2 retry status releases the continuation fence', async () => {
    const f = fixture();
    await f.refuse();
    await f.manager.handleEvent({
      type: 'session.status',
      properties: { sessionID: sid, status: { type: 'retry' } },
    });
    await f.manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenLastCalledWith(sid, origin);
  });

  test.each(['succeeded', 'interrupted'] as const)(
    'stale execution.%s and mapped idle keep the child continuation fence',
    async (ending) => {
      const f = fixture({ parentID: 'parent' });
      await f.refuse();
      expect(f.manager.restoreTarget(sid)).toBeUndefined();
      expect(f.switchModel).toHaveBeenCalledTimes(1);

      for (const event of mapV2EventToV1({
        type: `session.execution.${ending}`,
        created: clock.now() + 1,
        data: {
          sessionID: sid,
          ...(ending === 'interrupted' ? { reason: 'user' } : {}),
        },
      }))
        await f.manager.handleEvent(event);
      expect(f.manager.restoreTarget(sid)).toBeUndefined();
      expect(f.switchModel).toHaveBeenCalledTimes(1);

      // Only the continuation's actual started event admits the restore after
      // its subsequent idle, not the stale period's synthesized idle above.
      for (const event of mapV2EventToV1({
        type: 'session.execution.started',
        created: clock.now() + 2,
        data: { sessionID: sid },
      }))
        await f.manager.handleEvent(event);
      expect(f.manager.restoreTarget(sid)).toBeUndefined();
      await f.manager.handleEvent(idle());
      expect(f.switchModel).toHaveBeenLastCalledWith(sid, origin);
    },
  );

  test('S6: exhausted chain restores after an idle during refusal handling', async () => {
    const f = fixture({ chain: ['primary/a', 'backup/b'] });
    const fallback = { providerID: 'backup', id: 'b' };
    await f.manager.handleEvent(busy());
    await f.refuse('first', origin);
    await f.manager.handleEvent(busy());
    await f.refuse('second', fallback);
    await f.manager.handleEvent(idle());
    await f.manager.handleEvent(busy());
    const pending = deferred<unknown>();
    f.session.get = mock(() => pending.promise);
    await f.refuse('exhausted', fallback);
    await f.manager.handleEvent(idle());
    pending.resolve({ data: f.info });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(f.switchModel).toHaveBeenLastCalledWith(sid, origin);
  });

  test('S7: a rejected continuation releases the fence', async () => {
    const f = fixture({
      promptAsyncImpl: async () => ({ error: { name: 'BadRequest' } }),
    });
    await f.manager.handleEvent(busy());
    await f.refuse();
    await f.manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenLastCalledWith(sid, origin);
  });

  test('S9: continuation busy before prompt acknowledgement releases the fence', async () => {
    let manager!: ForegroundFallbackManager;
    const f = fixture({
      promptAsyncImpl: async () => {
        await manager.handleEvent(idle());
        await manager.handleEvent(busy());
        return {};
      },
    });
    manager = f.manager;
    await manager.handleEvent(busy());
    await f.refuse();
    expect(f.switchModel).toHaveBeenCalledTimes(1);
    await manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenLastCalledWith(sid, origin);
  });

  test('an uncertain continuation keeps the fence until busy', async () => {
    const f = fixture({
      promptAsyncImpl: async () => {
        throw new Error('connection lost');
      },
    });
    await f.manager.handleEvent(busy());
    await f.refuse();
    await f.manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenCalledTimes(1);
    await f.manager.handleEvent(busy());
    await f.manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenLastCalledWith(sid, origin);
  });

  test('T5: v2 waits for the provider mark timer to expire', async () => {
    const f = fixture();
    await f.retry(origin, { message: '429 rate limit' });
    await f.manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenCalledTimes(1);
    await clock.advance(ttl - 1);
    expect(f.switchModel).toHaveBeenCalledTimes(1);
    await clock.advance(1);
    expect(f.switchModel).toHaveBeenLastCalledWith(sid, origin);
  });

  test('T6: v2 preserves a manually changed fallback variant', async () => {
    const f = fixture();
    await f.retry();
    f.info.model = { providerID: 'backup', id: 'b', variant: 'manual' };
    await f.manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenCalledTimes(1);
    expect(f.manager.getActiveFallback(sid)).toBeUndefined();
    expect(f.manager.restoreTarget(sid)).toBeUndefined();
  });

  test('T6b: v2 preserves a manual model with the fallback variant', async () => {
    const f = fixture();
    await f.retry();
    f.info.model = { providerID: 'third', id: 'c', variant: 'default' };
    await f.manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenCalledTimes(1);
    expect(f.manager.getActiveFallback(sid)).toBeUndefined();
    expect(f.manager.restoreTarget(sid)).toBeUndefined();
  });

  test('v2 restores a manual model after that model fails over', async () => {
    const f = fixture({
      chain: ['primary/a', 'backup/b', 'third/c', 'fourth/d'],
    });
    await f.retry();
    const manual = { providerID: 'third', id: 'c', variant: 'high' };
    f.info.model = manual;
    await f.retry(manual);
    expect(f.info.model).toEqual({ providerID: 'fourth', id: 'd' });
    await f.manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenLastCalledWith(sid, manual);
  });

  test('v2 ignores a stale origin observed on a new prompt', async () => {
    const f = fixture();
    await f.retry();
    f.manager.noteExternalTurn(sid, 'primary/a');
    await f.manager.handleEvent(idle());
    expect(f.switchModel).toHaveBeenLastCalledWith(sid, origin);
    expect(f.switchModel).toHaveBeenCalledTimes(2);
  });

  test('v2 native child no-route continues in place and never writes a parent completion', async () => {
    const f = fixture({ parentID: 'parent' });
    await f.manager.handleEvent({
      type: 'session.created',
      properties: { info: { id: sid, parentID: 'parent' } },
    });
    await f.retry();
    await f.manager.handleEvent({
      type: 'session.status',
      properties: { sessionID: sid, status: { type: 'busy' } },
    });
    clock.set(clock.now() + 10);
    const error = {
      type: 'provider.no-route',
      message: 'no route for backup/b',
    };
    for (const event of mapV2EventToV1({
      type: 'session.execution.failed',
      created: clock.now(),
      data: { sessionID: sid, error },
    }))
      await f.manager.handleEvent(event);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(f.switchModel).toHaveBeenCalledTimes(2);

    for (const event of mapV2EventToV1({
      type: 'session.execution.succeeded',
      created: clock.now() + 1,
      data: { sessionID: sid },
    }))
      await f.manager.handleEvent(event);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(f.manager.restoreTarget(sid)).toBeUndefined();
    expect(
      f.session.promptAsync.mock.calls.every(
        (call) => (call[0] as { path: { id: string } }).path.id === sid,
      ),
    ).toBe(true);
  });
});
