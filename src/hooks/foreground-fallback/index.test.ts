import {
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from 'bun:test';
import { isInternalInitiatorPart } from '../../utils';
import * as logger from '../../utils/logger';
import { SessionLifecycle } from '../session-lifecycle';
import { ForegroundFallbackManager, isFailoverError } from './index';

// ACCEPTANCE GAP: config() hook behaviour is not covered by CI — verify live.

// Shared session reference so our mock.module for getClient returns the
// current test's mock session without relying on this.input (which is
// undefined in tests — always set in production).
let currentMockSession: Record<string, unknown> | null = null;
// Same idea for the raw transport used by foreground-waiter promotion.
let currentMockPost: ((args: unknown) => Promise<unknown>) | null = null;

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
      _client: currentMockPost ? { post: currentMockPost } : undefined,
    }),
  }));
}
installGetClientMock();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(overrides?: {
  promptAsyncImpl?: (args: unknown) => Promise<unknown>;
  abortImpl?: () => Promise<unknown>;
  includePromptAsync?: boolean;
  messagesData?: unknown[];
  messagesImpl?: (args: unknown) => Promise<unknown>;
  postImpl?: (args: unknown) => Promise<unknown>;
  includePostClient?: boolean;
}) {
  const promptAsync = mock(async (args: unknown) => {
    if (overrides?.promptAsyncImpl) return overrides.promptAsyncImpl(args);
    return {};
  });
  const abort = mock(async () => {
    if (overrides?.abortImpl) return overrides.abortImpl();
    return {};
  });
  const messages = mock(async (args: unknown) => {
    if (overrides?.messagesImpl) return overrides.messagesImpl(args);
    return {
      data: overrides?.messagesData ?? [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
      ],
    };
  });
  const post = mock(async (args: unknown) => {
    if (overrides?.postImpl) return overrides.postImpl(args);
    return true;
  });
  const session: Record<string, unknown> = {
    abort,
    messages,
  };
  if (overrides?.includePromptAsync !== false) {
    session.promptAsync = promptAsync;
  }

  // Store for getClient mock
  currentMockSession = session;
  currentMockPost = overrides?.includePostClient === false ? null : post;
  // Re-register the mock.module at test time so it survives any
  // overwrite from other test files loaded in the same process.
  installGetClientMock();

  return {
    client: {
      session,
      _client: { post },
    } as never,
    mocks: { promptAsync, abort, messages, post },
  };
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
  new ForegroundFallbackManager(
    { orchestrator: ids.map((id) => `test/${id}`) },
    true,
    { directory: '/test' } as any,
    0,
    undefined,
    onChanged,
  );

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

describe('ForegroundFallbackManager v2 retry hook', () => {
  test('shares the retry budget across in-place model switches', async () => {
    createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['test/A', 'test/B', 'test/C'] },
      true,
      { directory: '/test' } as any,
      1,
    );
    const switchModel = mock(async () => {});
    await mgr.handleV2Retry(retryEvent('budget', 'A'), switchModel);
    expect(switchModel).not.toHaveBeenCalled();
    await mgr.handleV2Retry(retryEvent('budget', 'A'), switchModel);
    expect(switchModel).toHaveBeenLastCalledWith('budget', {
      providerID: 'test',
      id: 'B',
    });
    await mgr.handleV2Retry(retryEvent('budget', 'B'), switchModel);
    expect(switchModel).toHaveBeenLastCalledWith('budget', {
      providerID: 'test',
      id: 'C',
    });
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
      expect(onChanged).toHaveBeenCalledWith('c', 'test/B');
      await mgr.handleV2Retry(
        retryEvent('c', 'A', { ...decision }),
        switchModel,
      );
      expect(switchModel).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    ['B', 'C'],
    ['C', 'D'],
  ])(
    'failed switch keeps its target retryable (next failure on %s switches to %s)',
    async (hostModel, target) => {
      const { mocks } = createMockClient();
      const mgr = retryMgr(['A', 'B', 'C', 'D']);
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
    jest.useFakeTimers();
    try {
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
      jest.advanceTimersByTime(2_500);
      await pending;
      expect(observed).toEqual([]);
      if (advance)
        await mgr.handleV2Retry(retryEvent(sid, 'B'), async () => {});
      // A late B must reconcile only if no later retry has advanced to C.
      resolveSwitch();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(observed).toEqual(calls);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a permanent quota exhaustion is terminal until a primary-model new turn', async () => {
    createMockClient();
    const mgr = retryMgr(['A']); // single-model chain
    const sid = 'retry-terminal-quota';
    const switchModel = mock(async () => {});

    const first = {
      ...retryEvent(sid, 'A'),
      error: { message: 'Monthly usage limit reached' },
      decision: { retry: true },
    };
    await mgr.handleV2Retry(first, switchModel);
    expect(switchModel).not.toHaveBeenCalled();
    expect(first.decision).toEqual({ retry: false });
    expect((mgr as any).v2RetryTerminal.has(sid)).toBe(true);

    // Later retry events keep answering { retry: false } without a switch.
    const second = { ...retryEvent(sid, 'A'), decision: { retry: true } };
    await mgr.handleV2Retry(second, switchModel);
    expect(second.decision).toEqual({ retry: false });
    expect(switchModel).not.toHaveBeenCalled();

    // A genuine primary-model user turn reopens the chain.
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: sid,
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'test', modelID: 'A' },
        },
      },
    });
    expect((mgr as any).v2RetryTerminal.has(sid)).toBe(false);
  });

  test('a completed assistant response clears the v2 terminal with stage-2', async () => {
    createMockClient();
    const mgr = retryMgr(['A']); // single-model chain can reach exhaustion
    const sid = 'retry-terminal-success';
    const switchModel = mock(async () => {});

    const first = {
      ...retryEvent(sid, 'A'),
      error: { message: 'Monthly usage limit reached' },
      decision: { retry: true },
    };
    await mgr.handleV2Retry(first, switchModel);
    expect(first.decision).toEqual({ retry: false });
    expect((mgr as any).v2RetryTerminal.has(sid)).toBe(true);
    expect((mgr as any).chainExhaustion.get(sid)).toBe(2);

    // A completed, successful assistant response proves recovery and must
    // clear BOTH terminal markers together.
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: sid,
          agent: 'orchestrator',
          role: 'assistant',
          time: { created: 1, completed: 2 },
        },
      },
    });
    expect((mgr as any).chainExhaustion.has(sid)).toBe(false);
    expect((mgr as any).v2RetryTerminal.has(sid)).toBe(false);

    // A genuine user turn after recovery is not short-circuited by a lingering
    // terminal marker.
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: sid,
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'test', modelID: 'A' },
        },
      },
    });
    expect((mgr as any).v2RetryTerminal.has(sid)).toBe(false);
  });

  test('an ordinary absorbed retry leaves the v2 host decision intact', async () => {
    createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['test/A', 'test/B'] },
      true,
      { directory: '/test' } as any,
      1, // maxRetries=1 → the first error is absorbed
    );
    const sid = 'retry-absorbed-decision';
    const decision = { retry: true, delay: 2000 };
    const event = { ...retryEvent(sid, 'A'), decision };
    const switchModel = mock(async () => {});
    await mgr.handleV2Retry(event, switchModel);
    expect(switchModel).not.toHaveBeenCalled();
    expect(event.decision).toBe(decision);
  });

  test('a session without a chain leaves the v2 host decision intact', async () => {
    createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['test/A', 'test/B'] },
      true,
      { directory: '/test' } as any,
      0,
    );
    const sid = 'retry-no-chain';
    const decision = { retry: true };
    const event = {
      ...retryEvent(sid, 'A'),
      agent: 'explorer', // no chain configured for this agent
      decision,
    };
    const switchModel = mock(async () => {});
    await mgr.handleV2Retry(event, switchModel);
    expect(switchModel).not.toHaveBeenCalled();
    expect(event.decision).toBe(decision);
  });

  test('an ordinary exhausted v2 chain becomes terminal for the session', async () => {
    createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['test/A'] },
      true,
      { directory: '/test' } as any,
      0,
    );
    const sid = 'retry-ordinary-terminal';
    const switchModel = mock(async () => {});

    const first = { ...retryEvent(sid, 'A'), decision: { retry: true } };
    await mgr.handleV2Retry(first, switchModel);
    expect(switchModel).not.toHaveBeenCalled();
    expect(first.decision).toEqual({ retry: false });
    expect((mgr as any).v2RetryTerminal.has(sid)).toBe(true);

    // Subsequent calls keep answering `{ retry: false }`.
    const second = { ...retryEvent(sid, 'A'), decision: { retry: true } };
    await mgr.handleV2Retry(second, switchModel);
    expect(second.decision).toEqual({ retry: false });
    expect(switchModel).not.toHaveBeenCalled();
  });

  test('the first ordinary v2 exhaustion still takes the sticky retry', async () => {
    createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['test/A', 'test/B'] },
      true,
      { directory: '/test' } as any,
      0,
    );
    const sid = 'retry-sticky-then-terminal';
    const switchModel = mock(async () => {});

    const first = { ...retryEvent(sid, 'A'), decision: { retry: true } };
    await mgr.handleV2Retry(first, switchModel);
    expect(first.decision).toEqual({ retry: true, delay: 500 }); // A → B

    // First exhaustion: sticky re-fallback, still retryable.
    const second = { ...retryEvent(sid, 'B'), decision: { retry: true } };
    await mgr.handleV2Retry(second, switchModel);
    expect(second.decision).toEqual({ retry: true, delay: 500 });

    // Second exhaustion: terminal.
    const third = { ...retryEvent(sid, 'B'), decision: { retry: true } };
    await mgr.handleV2Retry(third, switchModel);
    expect(third.decision).toEqual({ retry: false });
  });

  test('recovery clears the v2 terminal so the chain can advance again', async () => {
    createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['test/A', 'test/B'] },
      true,
      { directory: '/test' } as any,
      0,
    );
    const sid = 'retry-terminal-recover';
    const switchModel = mock(async () => {});

    const first = { ...retryEvent(sid, 'A'), decision: { retry: true } };
    await mgr.handleV2Retry(first, switchModel);
    const second = { ...retryEvent(sid, 'B'), decision: { retry: true } };
    await mgr.handleV2Retry(second, switchModel);
    const third = { ...retryEvent(sid, 'B'), decision: { retry: true } };
    await mgr.handleV2Retry(third, switchModel);
    expect(third.decision).toEqual({ retry: false });
    expect((mgr as any).v2RetryTerminal.has(sid)).toBe(true);

    // A completed successful assistant response clears the terminal (with 2).
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: sid,
          agent: 'orchestrator',
          role: 'assistant',
          time: { created: 1, completed: 2 },
        },
      },
    });
    expect((mgr as any).v2RetryTerminal.has(sid)).toBe(false);

    // The next ordinary failure is evaluated normally again: a stale terminal
    // would have forced `{ retry: false }` instead of advancing the chain.
    const later = { ...retryEvent(sid, 'A'), decision: { retry: true } };
    await mgr.handleV2Retry(later, switchModel);
    expect(later.decision).toEqual({ retry: true, delay: 500 });
  });

  test('a v2 retry switch resolving after a newer turn is superseded', async () => {
    createMockClient();
    const onChanged = mock(() => {});
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['test/A', 'test/B', 'test/C', 'test/D'] },
      true,
      { directory: '/test' } as any,
      1,
      undefined,
      onChanged,
      0,
      0,
    );
    const sid = 'retry-v2-superseded';
    // Budget already spent so the first event starts the A → B switch.
    (mgr as any).sessionRetries.set(sid, 1);

    const { promise: switchRequest, resolve: resolveSwitch } =
      Promise.withResolvers<void>();
    const decisionRef = { retry: true, delay: 9999 };
    const event = retryEvent(sid, 'A', decisionRef);
    const pending = mgr.handleV2Retry(event, () => switchRequest);

    // A genuine new user turn moves the session to C while the switch is in
    // flight.
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: sid,
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'test', modelID: 'C' },
        },
      },
    });
    expect((mgr as any).sessionModel.get(sid)).toBe('test/C');
    expect((mgr as any).sessionRetries.get(sid)).toBeUndefined();

    resolveSwitch();
    await pending;

    // The stale hook must not write B, notify, or overwrite the host decision.
    expect((mgr as any).sessionModel.get(sid)).toBe('test/C');
    expect(onChanged).not.toHaveBeenCalled();
    expect(event.decision).toBe(decisionRef);

    // The next failure uses C on the new turn's fresh budget: the first event
    // is absorbed (no switch), the second advances from C.
    const switchModel2 = mock(async () => {});
    await mgr.handleV2Retry(
      retryEvent(sid, 'C', { retry: true }),
      switchModel2,
    );
    expect((mgr as any).sessionRetries.get(sid)).toBe(1);
    expect(switchModel2).not.toHaveBeenCalled();
    await mgr.handleV2Retry(
      retryEvent(sid, 'C', { retry: true }),
      switchModel2,
    );
    expect(switchModel2).toHaveBeenCalledWith(sid, {
      providerID: 'test',
      id: 'D',
    });
  });

  test('a late-landing v2 switch cannot reconcile into a newer turn (different model)', async () => {
    jest.useFakeTimers();
    try {
      const observed: string[] = [];
      const mgr = retryMgr(
        ['A', 'B', 'C'],
        (_sid, model) => void observed.push(model),
      );
      const sid = 'retry-v2-late-different';
      const { promise: switchRequest, resolve: resolveSwitch } =
        Promise.withResolvers<void>();
      const decisionRef = { retry: true };
      const event = retryEvent(sid, 'A', decisionRef);
      const pending = mgr.handleV2Retry(event, () => switchRequest);
      jest.advanceTimersByTime(2_500);
      await pending;
      expect(observed).toEqual([]);
      expect(event.decision).toBe(decisionRef);

      // A genuine new turn moves the session to C before the timed-out switch
      // lands.
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID: sid,
            agent: 'orchestrator',
            role: 'user',
            model: { providerID: 'test', modelID: 'C' },
          },
        },
      });
      expect((mgr as any).sessionModel.get(sid)).toBe('test/C');

      resolveSwitch();
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // No reconcile: B must not be written or notified into the newer turn.
      expect((mgr as any).sessionModel.get(sid)).toBe('test/C');
      expect(observed).toEqual([]);

      // The next failure is evaluated normally (fresh turn budget).
      const follow = retryEvent(sid, 'C', { retry: true });
      await mgr.handleV2Retry(
        follow,
        mock(async () => {}),
      );
      expect(follow.decision).toEqual({ retry: true, delay: 500 });
    } finally {
      jest.useRealTimers();
    }
  });

  test('a late-landing v2 switch cannot reconcile into a newer turn on the same model', async () => {
    jest.useFakeTimers();
    try {
      const observed: string[] = [];
      const mgr = retryMgr(
        ['A', 'B'],
        (_sid, model) => void observed.push(model),
      );
      const sid = 'retry-v2-late-same';
      const { promise: switchRequest, resolve: resolveSwitch } =
        Promise.withResolvers<void>();
      const event = retryEvent(sid, 'A', { retry: true });
      const pending = mgr.handleV2Retry(event, () => switchRequest);
      jest.advanceTimersByTime(2_500);
      await pending;
      expect(observed).toEqual([]);

      // A genuine new turn returns the session to the SAME model A: the
      // sessionModel guard alone would pass, but the epoch must still fence
      // the late B.
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID: sid,
            agent: 'orchestrator',
            role: 'user',
            model: { providerID: 'test', modelID: 'A' },
          },
        },
      });
      expect((mgr as any).sessionModel.get(sid)).toBe('test/A');
      expect((mgr as any).turnEpoch.get(sid)).toBe(1);

      resolveSwitch();
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // The epoch check must stop the reconcile from writing B / notifying.
      expect((mgr as any).sessionModel.get(sid)).toBe('test/A');
      expect(observed).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
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
    // errors mentioning "flagged", "cybersecurity", or "policy" stay hard
    // errors.
    expect(
      isFailoverError({ message: 'request flagged for review by the proxy' }),
    ).toBe(false);
    expect(
      isFailoverError({ message: 'analysis of cybersecurity topics rejected' }),
    ).toBe(false);
    expect(
      isFailoverError({ message: 'policy update required for this model' }),
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

  test('recognises HTTP status codes across every supported nested path', () => {
    const paths: Array<{ name: string; make: (code: number) => unknown }> = [
      { name: 'statusCode', make: (code) => ({ statusCode: code }) },
      {
        name: 'data.statusCode',
        make: (code) => ({ data: { statusCode: code } }),
      },
      {
        name: 'cause.statusCode',
        make: (code) => ({ cause: { statusCode: code } }),
      },
      { name: 'status', make: (code) => ({ status: code }) },
      {
        name: 'response.status',
        make: (code) => ({ response: { status: code } }),
      },
      {
        name: 'response.statusCode',
        make: (code) => ({ response: { statusCode: code } }),
      },
      { name: 'data.status', make: (code) => ({ data: { status: code } }) },
      {
        name: 'data.response.status',
        make: (code) => ({ data: { response: { status: code } } }),
      },
      { name: 'cause.status', make: (code) => ({ cause: { status: code } }) },
      {
        name: 'cause.response.status',
        make: (code) => ({ cause: { response: { status: code } } }),
      },
    ];
    const failoverCodes = [401, 403, 410, 429, 500, 502, 503, 504];
    for (const path of paths) {
      for (const code of failoverCodes) {
        expect({
          path: path.name,
          code,
          result: isFailoverError(path.make(code)),
        }).toEqual({ path: path.name, code, result: true });
      }
    }
  });

  test('ignores non-numeric and out-of-range status values', () => {
    expect(isFailoverError({ statusCode: 'not-a-number' })).toBe(false);
    expect(isFailoverError({ status: { code: 429 } })).toBe(false);
    expect(isFailoverError({ data: { statusCode: '429O' } })).toBe(false);
    expect(isFailoverError({ statusCode: 999 })).toBe(false);
    expect(isFailoverError({ statusCode: 0 })).toBe(false);
    expect(isFailoverError({ statusCode: 200 })).toBe(false);
  });

  test('400 stays a hard error unless the text is a recognised failover reason', () => {
    expect(
      isFailoverError({ statusCode: 400, message: 'invalid request' }),
    ).toBe(false);
    expect(
      isFailoverError({ statusCode: 400, message: 'rate limit exceeded' }),
    ).toBe(true);
    expect(isFailoverError({ status: 400, message: 'provider outage' })).toBe(
      true,
    );
  });

  test('accepts a numeric-string status but keeps transport codes working', () => {
    expect(isFailoverError({ statusCode: '429' })).toBe(true);
    expect(isFailoverError({ cause: { code: 'ECONNRESET' } })).toBe(true);
    expect(isFailoverError({ message: 'fetch failed' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - disabled
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager (disabled)', () => {
  test('does nothing when enabled=false', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      false,
      {
        directory: '/test',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { message: 'rate limit exceeded' },
      },
    });

    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - session.error
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager session.error', () => {
  let mocks: ReturnType<typeof createMockClient>['mocks'];
  let mgr: ForegroundFallbackManager;

  beforeEach(() => {
    ({ mocks } = createMockClient());
    mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );
  });

  test('triggers fallback on rate-limit session.error', async () => {
    // First teach the manager which model is in use for this session
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { message: 'Rate limit exceeded' },
      },
    });

    // promptAsync is called directly (no abort needed when it succeeds)
    expect(mocks.abort).toHaveBeenCalledTimes(0);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    const call = mocks.promptAsync.mock.calls[0] as [
      {
        sessionID: string;
        model: { providerID: string; modelID: string };
      },
    ];
    expect(call[0].path.id).toBe('sess-1');
    // Should have picked the next model after anthropic/claude-opus-4-5
    expect(call[0].body.model.providerID).toBe('openai');
    expect(call[0].body.model.modelID).toBe('gpt-4o');
  });

  test('triggers fallback on content-policy moderation session.error', async () => {
    // End-to-end regression: a cyber_policy rejection (HTTP 400
    // invalid_request in production) must advance the fallback chain to the
    // next model instead of failing the session outright.
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: {
          message:
            'This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber',
        },
      },
    });

    expect(mocks.abort).toHaveBeenCalledTimes(0);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    const call = mocks.promptAsync.mock.calls[0] as [
      {
        sessionID: string;
        model: { providerID: string; modelID: string };
      },
    ];
    expect(call[0].path.id).toBe('sess-1');
    expect(call[0].body.model.providerID).toBe('openai');
    expect(call[0].body.model.modelID).toBe('gpt-4o');
  });

  test('triggers fallback on unavailable provider channel session.error', async () => {
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: {
          message:
            'No available channel for model gpt-6-luna under group Codex专用 (distributor)',
        },
      },
    });

    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    const call = mocks.promptAsync.mock.calls[0] as [
      {
        model: { providerID: string; modelID: string };
      },
    ];
    expect(call[0].body.model.providerID).toBe('openai');
    expect(call[0].body.model.modelID).toBe('gpt-4o');
  });

  test('triggers fallback on CliProxyAPI auth-unavailable session.error', async () => {
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: {
          message:
            'auth_unavailable: no auth available (providers=cli-proxy-api, model=gemini-3.6-flash)',
        },
      },
    });

    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    const call = mocks.promptAsync.mock.calls[0] as [
      {
        model: { providerID: string; modelID: string };
      },
    ];
    expect(call[0].body.model.providerID).toBe('openai');
    expect(call[0].body.model.modelID).toBe('gpt-4o');
  });

  test('triggers fallback on cannot-connect session.error', async () => {
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: {
          message: 'stream error: Cannot connect to API',
        },
      },
    });

    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    const call = mocks.promptAsync.mock.calls[0] as [
      {
        model: { providerID: string; modelID: string };
      },
    ];
    expect(call[0].body.model.providerID).toBe('openai');
    expect(call[0].body.model.modelID).toBe('gpt-4o');
  });

  test('triggers fallback on ProviderModelNotFoundError session.error', async () => {
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: {
          message:
            'ProviderModelNotFoundError: Model not found: custom/missing-model.',
        },
      },
    });

    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    const call = mocks.promptAsync.mock.calls[0] as [
      {
        model: { providerID: string; modelID: string };
      },
    ];
    expect(call[0].body.model.providerID).toBe('openai');
    expect(call[0].body.model.modelID).toBe('gpt-4o');
  });

  test('marks the replayed user prompt as an internal initiator', async () => {
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { message: 'Rate limit exceeded' },
      },
    });

    const call = mocks.promptAsync.mock.calls[0] as [{ parts: unknown[] }];
    expect(call[0].body.parts.some(isInternalInitiatorPart)).toBe(true);
  });

  test('skips malformed messages without info when locating the last user message', async () => {
    // OpenCode may return partial/streaming messages whose `info` is undefined;
    // the fallback must ignore those rather than crash, and still re-submit the
    // real last user message.
    ({ mocks } = createMockClient({
      messagesData: [
        {},
        { info: { role: 'assistant' }, parts: [] },
        { parts: [{ type: 'text', text: 'no info' }] },
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: 'real prompt' }],
        },
      ],
    }));
    mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { message: 'Rate limit exceeded' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      { parts: Array<{ text?: string }> },
    ];
    expect(call[0].body.parts[0]?.text).toBe('real prompt');
  });

  test('reads only the transcript tail for the replay and issues no full read', async () => {
    // The replay needs just the last replayable user message; long-lived
    // sessions serve the full listing in the hundreds of MB (measured
    // 463 MB / 11.7 s on a live months-old session), so the hot path
    // must stay O(tail).
    ({ mocks } = createMockClient({
      messagesData: [
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: 'tail prompt' }],
        },
      ],
    }));
    mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { message: 'Rate limit exceeded' },
      },
    });

    expect(mocks.messages).toHaveBeenCalledTimes(1);
    const listCall = mocks.messages.mock.calls[0] as [
      { query?: { limit?: number } },
    ];
    expect(listCall[0]?.query?.limit).toBe(50);
    const promptCall = mocks.promptAsync.mock.calls[0] as [
      { parts: Array<{ text?: string }> },
    ];
    expect(promptCall[0].body.parts[0]?.text).toBe('tail prompt');
  });

  test('falls back to the full transcript read when the tail has no replayable user message', async () => {
    // A host that ignores `limit` (or an exotic transcript whose tail
    // carries no user message) must still fail over: pay the full read
    // rather than skip the replay.
    let reads = 0;
    ({ mocks } = createMockClient({
      messagesImpl: async () => {
        reads += 1;
        if (reads === 1) {
          return { data: [{ info: { role: 'assistant' }, parts: [] }] };
        }
        return {
          data: [
            {
              info: { role: 'user' },
              parts: [{ type: 'text', text: 'deep prompt' }],
            },
          ],
        };
      },
    }));
    mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { message: 'Rate limit exceeded' },
      },
    });

    expect(reads).toBe(2);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const promptCall = mocks.promptAsync.mock.calls[0] as [
      { parts: Array<{ text?: string }> },
    ];
    expect(promptCall[0].body.parts[0]?.text).toBe('deep prompt');
  });

  test('keeps both errors when the tail and the full transcript reads fail', async () => {
    // A dual transcript-read incident must surface the tail error too:
    // the full-read error aggregates after it instead of overwriting it.
    let reads = 0;
    ({ mocks } = createMockClient({
      messagesImpl: async () => {
        reads += 1;
        return reads === 1
          ? { error: { message: 'tail down' }, data: [] }
          : { error: { message: 'full down' }, data: [] };
      },
    }));
    mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { message: 'Rate limit exceeded' },
      },
    });

    expect(reads).toBe(2);
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  function handoffMock() {
    const calls = {
      prepare: [] as Array<[string, number | undefined, string | undefined]>,
      admit: [] as Array<[string, number | undefined]>,
      reject: [] as Array<[string, number | undefined]>,
      settleUnresolved: [] as Array<[string, number | undefined]>,
    };
    return {
      calls,
      handoff: {
        prepare: (
          sessionID: string,
          generation: number | undefined,
          baseline: string | undefined,
        ) => {
          calls.prepare.push([sessionID, generation, baseline]);
          return true;
        },
        admit: (sessionID: string, generation: number | undefined) => {
          calls.admit.push([sessionID, generation]);
        },
        reject: (sessionID: string, generation: number | undefined) => {
          calls.reject.push([sessionID, generation]);
        },
        settleUnresolved: (
          sessionID: string,
          generation: number | undefined,
        ) => {
          calls.settleUnresolved.push([sessionID, generation]);
        },
      },
    };
  }

  /** Common handoff-scenario runner: builds the mock client, the
   * manager (with optional handoff/reader/modelChanged) and fires the
   * message.updated → session.error sequence that triggers a fallback
   * attempt on 'sess-1'. */
  async function runFallbackScenario(options?: {
    v2?: boolean;
    promptAsyncImpl?: () => Promise<unknown>;
    abortImpl?: () => Promise<unknown>;
    messagesData?: unknown[];
    handoff?: ReturnType<typeof handoffMock>['handoff'];
    readBackgroundGeneration?: (sessionID: string) => number | undefined;
    modelChanged?: () => void;
  }) {
    ({ mocks } = createMockClient({
      promptAsyncImpl: options?.promptAsyncImpl,
      abortImpl: options?.abortImpl,
      messagesData: options?.messagesData,
    }));
    mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test', hostFlavor: options?.v2 ? 'v2' : undefined } as any,
      0,
      undefined,
      options?.modelChanged,
      0,
      500,
      options?.handoff,
      options?.readBackgroundGeneration,
    );
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { message: 'Rate limit exceeded' },
      },
    });
    return mocks;
  }

  const taskPrompt = [
    {
      info: { id: 'm1', role: 'user' },
      parts: [{ type: 'text', text: 'task prompt' }],
    },
  ];

  test('arms the handoff before the admission await and admits after acceptance', async () => {
    // False-stop incident: for a background child the fallback PREPARES
    // the observation handoff before promptAsync is awaited (stop gate
    // defers terminal publication) and ADMITS it once the host accepts
    // the re-prompt — baseline = trailing message with a string id from
    // the same read that produced the replay.
    const { calls, handoff } = handoffMock();
    const mocks = await runFallbackScenario({
      handoff,
      messagesData: [
        ...taskPrompt,
        { info: { id: 'm2', role: 'assistant' }, parts: [] },
      ],
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(calls.prepare).toEqual([['sess-1', undefined, 'm2']]);
    expect(calls.admit).toEqual([['sess-1', undefined]]);
    expect(calls.reject).toEqual([]);
  });

  test('rejects the handoff when promptAsync resolves with an error envelope', async () => {
    const { calls, handoff } = handoffMock();
    const mocks = await runFallbackScenario({
      handoff,
      messagesData: taskPrompt,
      promptAsyncImpl: async () => ({
        error: { message: 'admission refused' },
      }),
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(calls.prepare).toHaveLength(1);
    expect(calls.admit).toEqual([]);
    expect(calls.reject).toHaveLength(1);
  });

  test('converts the handoff to a owner when every promptAsync attempt rejects', async () => {
    // A transport failure without a response does NOT prove the host
    // refused — the replay may have been accepted. The prepared
    // ownership converts into a tracked run instead of being dropped.
    const { calls, handoff } = handoffMock();
    const mocks = await runFallbackScenario({
      handoff,
      messagesData: taskPrompt,
      promptAsyncImpl: async () => {
        throw new Error('transport failed');
      },
      abortImpl: async () => {
        throw new Error('abort also failed');
      },
    });

    expect(calls.prepare).toHaveLength(1);
    expect(calls.admit).toEqual([]);
    expect(calls.reject).toEqual([]);
    expect(calls.settleUnresolved).toHaveLength(1);
    // The abort failed before any second prompt was attempted.
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mgr.isFallbackInProgress('sess-1')).toBe(false);
  });

  test('a second promptAsync failure is bounded and distinct from an abort failure', async () => {
    // First prompt rejected, abort succeeded, second prompt rejected: the
    // retry-prompt failure is bounded (no further retry), converts the armed
    // handoff, and leaves no permanent in-progress state.
    const { calls, handoff } = handoffMock();
    const mocks = await runFallbackScenario({
      handoff,
      messagesData: taskPrompt,
      promptAsyncImpl: async () => {
        throw new Error('transport failed twice');
      },
      abortImpl: async () => ({}),
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(calls.settleUnresolved).toHaveLength(1);
    expect(calls.admit).toEqual([]);
    expect(calls.reject).toEqual([]);
    expect(mgr.isFallbackInProgress('sess-1')).toBe(false);
  });

  test('switched:false still delivers — the handoff is admitted without the switch claim', async () => {
    // The v2 shim runs s.prompt even when switchModel fails;
    // `switched: false` means the replay WAS delivered on the current
    // model. Admission and switch confirmation are different facts:
    // the delivery keeps its owner; only sessionModel stays.
    const { calls, handoff } = handoffMock();
    const modelChanged = mock(() => {});
    const mocks = await runFallbackScenario({
      handoff,
      modelChanged,
      messagesData: taskPrompt,
      promptAsyncImpl: async () => ({ switched: false }),
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(calls.admit).toHaveLength(1);
    expect(calls.reject).toEqual([]);
    expect(calls.settleUnresolved).toEqual([]);
    // The switch claim is suppressed: no model migration.
    expect(modelChanged).not.toHaveBeenCalled();
  });

  test('a stale background generation during the transcript read aborts the replay', async () => {
    // The reader confirmed a BACKGROUND child, but the preparation lost
    // validity (generation changed during the read) — sending the stale
    // replay/baseline to a session that belongs to another execution
    // must not happen.
    const calls = {
      prepare: [] as Array<[string, number | undefined, string | undefined]>,
    };
    const mocks = await runFallbackScenario({
      messagesData: taskPrompt,
      handoff: {
        prepare: (
          sessionID: string,
          generation: number | undefined,
          baseline: string | undefined,
        ) => {
          calls.prepare.push([sessionID, generation, baseline]);
          return false; // superseded between the read and the arming
        },
        admit: () => {},
        reject: () => {},
        settleUnresolved: () => {},
      },
      readBackgroundGeneration: () => 7, // confirmed background child
    });

    expect(calls.prepare).toEqual([['sess-1', 7, 'm1']]);
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('passes the generation captured before any await', async () => {
    let generation = 7;
    const { calls, handoff } = handoffMock();
    await runFallbackScenario({
      handoff,
      messagesData: taskPrompt,
      readBackgroundGeneration: () => generation,
      promptAsyncImpl: async () => {
        generation = 8;
        return {};
      },
    });

    expect(calls.prepare).toEqual([['sess-1', 7, 'm1']]);
    expect(calls.admit).toEqual([['sess-1', 7]]);
    expect(generation).toBe(8);
  });

  test('replays the last user message from v2-shaped session.messages data', async () => {
    // OpenCode 1.18+ session.messages() returns v2 SessionMessage objects
    // ({ type, text }) instead of the v1 { info, parts } shape. The fallback
    // must locate and re-submit the v2 user text even when an assistant
    // message appears after it.
    ({ mocks } = createMockClient({
      messagesData: [
        { id: 'm1', type: 'user', text: 'v2 prompt' },
        {
          id: 'm2',
          type: 'assistant',
          parts: [{ type: 'text', text: 'reply' }],
        },
      ],
    }));
    mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { message: 'Rate limit exceeded' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      { parts: Array<{ text?: string }> },
    ];
    expect(call[0].body.parts[0]?.text).toBe('v2 prompt');
  });

  test('prefers the latest user message across mixed v1/v2 shapes', async () => {
    ({ mocks } = createMockClient({
      messagesData: [
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: 'legacy prompt' }],
        },
        { id: 'm2', type: 'user', text: 'v2 prompt' },
      ],
    }));
    mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { message: 'Rate limit exceeded' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      { parts: Array<{ text?: string }> },
    ];
    expect(call[0].body.parts[0]?.text).toBe('v2 prompt');
  });

  test('does nothing when error is not a rate limit', async () => {
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { message: 'invalid request' },
      },
    });

    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('does nothing when no chain configured for session', async () => {
    const emptyMgr = new ForegroundFallbackManager(
      {},
      true,
      {
        directory: '/test',
      } as any,
      0,
    );
    await emptyMgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { message: 'rate limit exceeded' },
      },
    });

    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('does not abort when promptAsync is unavailable', async () => {
    const { mocks } = createMockClient({ includePromptAsync: false });
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-no-prompt-async',
        error: { message: 'Rate limit exceeded' },
      },
    });

    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('falls back to abort+retry when promptAsync fails on busy session', async () => {
    const { mocks } = createMockClient({
      promptAsyncImpl: async () => {
        throw new Error('session busy');
      },
      abortImpl: async () => {
        // abort succeeds on first call
      },
    });
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-busy',
        error: { message: 'Rate limit exceeded' },
      },
    });

    // First promptAsync attempt failed → abort called, then promptAsync retried
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
  });

  test('promptAsync is invoked bound: a this-reading implementation must not throw', async () => {
    // Regression (issue #595): the extracted promptAsync was called as a
    // free function, so a real SDK implementation reading `this._client`
    // threw "undefined is not an object (evaluating 'this._client')" and
    // the fallback attempt died without delivering the replay.
    const session: Record<string, unknown> = {
      abort: mock(async () => {}),
      messages: mock(async () => ({
        data: [
          { info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
        ],
      })),
      promptAsync: async function (this: { _client: unknown }) {
        // Mirrors the generated SDK: touching the receiver crashes when
        // invoked unbound.
        void this._client;
        return {};
      },
    };
    currentMockSession = session;
    installGetClientMock();

    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-unbound',
        error: { message: 'Rate limit exceeded' },
      },
    });

    // No abort, no crash: the bound call delivered the replay directly.
    expect((session.abort as ReturnType<typeof mock>).mock.calls.length).toBe(
      0,
    );
  });

  test('v1 promptBody carries no v2 modelSwitch flag and still claims the switch', async () => {
    // v1 byte-identity: the shim-only `modelSwitch` arg must appear ONLY
    // on v2 hosts, and a v1-shaped result (no `switched` key) keeps the
    // model-switch bookkeeping.
    const { mocks } = createMockClient();
    const onModelChanged = mock();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
      undefined,
      onModelChanged,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { message: 'Rate limit exceeded' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [Record<string, unknown>];
    expect('modelSwitch' in call[0]).toBe(false);
    expect(onModelChanged).toHaveBeenCalledTimes(1);
    expect(onModelChanged).toHaveBeenCalledWith('sess-1', 'openai/gpt-4o');
  });

  test('v2 host promptBody requests a required model switch', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
        hostFlavor: 'v2',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-v2',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-v2',
        error: { message: 'Rate limit exceeded' },
      },
    });

    const call = mocks.promptAsync.mock.calls[0] as [Record<string, unknown>];
    expect(call[0].modelSwitch).toBe('required');
  });

  test('switched:false result (v2 switch failure) skips the switch claim', async () => {
    // The v2 shim degrades a failed switchModel into a prompt delivered on
    // the CURRENT model; the manager must not record a model switch that
    // did not happen (sessionModel feeds chain descent, the callback
    // migrates provider accounting, the toast claims a switch).
    const { mocks } = createMockClient({
      promptAsyncImpl: async () => ({ switched: false }),
    });
    const onModelChanged = mock();
    const showToast = mock(async () => ({}));
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test', hostFlavor: 'v2', client: { tui: { showToast } } },
      0,
      undefined,
      onModelChanged,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-degrade',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-degrade',
        error: { message: 'Rate limit exceeded' },
      },
    });

    // The prompt was delivered exactly once — no busy-session abort dance.
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(onModelChanged).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  const noSwitch = Object.assign(
    new Error(
      '[v2] host provides no session.switchModel; cannot switch model for fallback prompt',
    ),
    { name: 'V2SwitchModelUnavailableError' },
  );
  const conflict = Object.assign(new Error(''), {
    name: 'Session.SyntheticConflictError',
    _tag: 'Session.SyntheticConflictError',
    inputID: 'msg_omos_existing',
  });
  test.each([
    ['missing switchModel', noSwitch, /host provides no session\.switchModel/],
    [
      'synthetic id conflict',
      conflict,
      /"_tag":"Session\.SyntheticConflictError","inputID":"msg_omos_existing"/,
    ],
  ])(
    'v2 %s rejection is final and reports its cause',
    async (_kind, error, detail) => {
      const { calls, handoff } = handoffMock();
      const onModelChanged = mock();
      const logSpy = spyOn(logger, 'log').mockImplementation(() => {});
      try {
        const mocks = await runFallbackScenario({
          v2: true,
          handoff,
          modelChanged: onModelChanged,
          messagesData: taskPrompt,
          promptAsyncImpl: async () => {
            throw error;
          },
        });

        expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
        expect(mocks.abort).not.toHaveBeenCalled();
        expect(onModelChanged).not.toHaveBeenCalled();
        expect(calls.reject).toEqual([['sess-1', undefined]]);
        expect(calls.settleUnresolved).toEqual([]);
        expect(logSpy).toHaveBeenCalledWith(
          '[foreground-fallback] fallback attempt failed',
          expect.objectContaining({ error: expect.stringMatching(detail) }),
        );
      } finally {
        logSpy.mockRestore();
      }
    },
  );

  test('shows a toast when fallback switches models on a transient error', async () => {
    const { mocks } = createMockClient();
    const showToast = mock(async () => ({}));
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
        client: { tui: { showToast } },
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { statusCode: 429, message: 'Rate limit exceeded' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);
    const toastCall = showToast.mock.calls[0]?.[0] as {
      body?: { title?: string; message?: string; variant?: string };
    };
    expect(toastCall?.body?.title).toBe('Model fallback');
    expect(toastCall?.body?.variant).toBe('warning');
    expect(toastCall?.body?.message).toContain('openai');
  });

  test('does not toast when fallback is triggered by an inline 410/401 error', async () => {
    const { mocks } = createMockClient();
    const showToast = mock(async () => ({}));
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
        client: { tui: { showToast } },
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { statusCode: 410, message: 'AI_APICallError: Gone' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  test('does not toast when the inline 410 error arrives as a bare string', async () => {
    const { mocks } = createMockClient();
    const showToast = mock(async () => ({}));
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
        client: { tui: { showToast } },
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: 'AI_APICallError: Gone',
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  test('preserves nested spaced model IDs in the fallback prompt request', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      {
        explorer: [
          'opencode-omniroute-live/of/MiniMax M3',
          'opencode-omniroute-live/of/Qwen3.8 27b',
        ],
      },
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-spaced-model-id',
          agent: 'explorer',
          providerID: 'opencode-omniroute-live',
          modelID: 'of/MiniMax M3',
          role: 'assistant',
        },
      },
    });
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-spaced-model-id',
        error: { message: 'Rate limit exceeded' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      { body: { model: { providerID: string; modelID: string } } },
    ];
    expect(call[0].body.model).toEqual({
      providerID: 'opencode-omniroute-live',
      modelID: 'of/Qwen3.8 27b',
    });
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - message.updated
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager message.updated', () => {
  test('tracks model from message.updated and falls back on error', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-2',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          error: { message: 'rate limit exceeded' },
        },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      {
        model: { providerID: string; modelID: string };
      },
    ];
    expect(call[0].body.model.providerID).toBe('openai');
    expect(call[0].body.model.modelID).toBe('gpt-4o');
  });

  test('uses agent name from message.updated to select correct chain', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    // explorer message with its model
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-3',
          agent: 'explorer',
          providerID: 'openai',
          modelID: 'gpt-4o-mini',
          error: { message: 'quota exceeded' },
        },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      {
        model: { providerID: string; modelID: string };
      },
    ];
    // explorer chain: ['openai/gpt-4o-mini', 'anthropic/claude-haiku']
    // current=gpt-4o-mini is tried → next = claude-haiku
    expect(call[0].body.model.providerID).toBe('anthropic');
    expect(call[0].body.model.modelID).toBe('claude-haiku');
  });
});

describe('ForegroundFallbackManager v1 abort protection for live children', () => {
  const live = new Set<string>();
  const checked: string[] = [];
  const retry = (sessionID: string, attempt = 1) => ({
    type: 'session.status',
    properties: {
      sessionID,
      status: { type: 'retry', attempt, message: 'rate limit' },
    },
  });
  const error = (sessionID: string) => ({
    type: 'session.error',
    properties: { sessionID, error: { message: 'rate limit exceeded' } },
  });
  const observe = (id: string) => {
    checked.push(id);
    return live.has(id);
  };
  const manager = (
    hostFlavor?: string,
    chain = makeChains(),
    handoff?: {
      prepare: (
        id: string,
        generation: number | undefined,
        baseline: string | undefined,
      ) => boolean;
      admit: (id: string, generation: number | undefined) => void;
      reject: (id: string, generation: number | undefined) => void;
      settleUnresolved: (id: string, generation: number | undefined) => void;
    },
    readGeneration?: (id: string) => number | undefined,
  ) =>
    new ForegroundFallbackManager(
      chain,
      true,
      { directory: '/test', hostFlavor } as any,
      0,
      undefined,
      undefined,
      0,
      0,
      handoff,
      readGeneration,
      observe,
    );
  const seed = (
    mgr: ForegroundFallbackManager,
    sessionID: string,
    modelID = 'claude-opus-4-5',
  ) =>
    mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          agent: 'orchestrator',
          providerID: 'anthropic',
          modelID,
        },
      },
    });

  beforeEach(() => {
    live.clear();
    checked.length = 0;
  });

  test('T1: retry with live children neither aborts nor replays or marks fallback active', async () => {
    const { mocks } = createMockClient();
    const mgr = manager();
    live.add('sess-parent');
    await seed(mgr, 'sess-parent');
    await mgr.handleEvent(retry('sess-parent'));
    expect(mocks.abort).toHaveBeenCalledTimes(0);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(0);
    expect(mgr.isFallbackInProgress('sess-parent')).toBe(false);
  });

  test('T2: held retry leaves dedup free for the next retry after children finish', async () => {
    const calls: string[] = [];
    const { mocks } = createMockClient({
      abortImpl: async () => {
        calls.push('abort');
      },
      promptAsyncImpl: async () => {
        calls.push('promptAsync');
        return {};
      },
    });
    const mgr = manager();
    live.add('sess-parent');
    await seed(mgr, 'sess-parent');
    await mgr.handleEvent(retry('sess-parent'));
    expect(mocks.abort).toHaveBeenCalledTimes(0);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(0);
    live.clear();
    await mgr.handleEvent(retry('sess-parent', 2));
    expect(calls).toEqual(['abort', 'promptAsync']);
    expect(mgr.isFallbackInProgress('sess-parent')).toBe(false);
  });

  test('T3: session.error can replay without abort while children are live', async () => {
    const { mocks } = createMockClient();
    const mgr = manager();
    live.add('sess-parent');
    await seed(mgr, 'sess-parent');
    await mgr.handleEvent(error('sess-parent'));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.abort).toHaveBeenCalledTimes(0);
  });

  test('T4: exhausted chain stops intervening without aborting live children', async () => {
    const { mocks } = createMockClient();
    const mgr = manager(undefined, { orchestrator: ['openai/model-y'] });
    live.add('sess-exhaust');
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-exhaust',
          agent: 'orchestrator',
          providerID: 'openai',
          modelID: 'model-y',
          error: { message: 'rate limit exceeded' },
        },
      },
    });
    expect(mocks.abort).toHaveBeenCalledTimes(0);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(0);
    expect(mgr.willAttemptFallback('sess-exhaust')).toBe(false);
  });

  test('T4b: second exhaustion stops intervening without aborting live children', async () => {
    const { mocks } = createMockClient();
    const mgr = manager(undefined, {
      orchestrator: ['openai/gpt-b', 'openai/gpt-c'],
    });
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-loop',
          agent: 'orchestrator',
          providerID: 'openai',
          modelID: 'gpt-b',
          role: 'assistant',
        },
      },
    });
    const originalNow = Date.now;
    let fakeNow = originalNow();
    Date.now = () => fakeNow;
    try {
      const fail = async () => {
        fakeNow += 6_000;
        await mgr.handleEvent(error('sess-loop'));
      };
      await fail();
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
      expect(mocks.abort).toHaveBeenCalledTimes(0);

      live.add('sess-loop');
      await fail();
      expect(mocks.abort).toHaveBeenCalledTimes(0);
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
      expect(mgr.willAttemptFallback('sess-loop')).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  test('T5: busy replay withdraws armed handoff without promoting, aborting or retrying', async () => {
    const { mocks } = createMockClient({
      promptAsyncImpl: async () => {
        throw new Error('session busy');
      },
    });
    const prepare = mock(() => true);
    const reject = mock(() => {});
    const settleUnresolved = mock(() => {});
    const mgr = manager(
      undefined,
      makeChains(),
      {
        prepare,
        admit: mock(() => {}),
        reject,
        settleUnresolved,
      },
      () => 1,
    );
    live.add('sess-child');
    await mgr.handleEvent({
      type: 'session.created',
      properties: { info: { id: 'sess-child', parentID: 'sess-parent' } },
    });
    await seed(mgr, 'sess-child');
    await mgr.handleEvent(error('sess-child'));
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledTimes(0);
    expect(mocks.abort).toHaveBeenCalledTimes(0);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(settleUnresolved).toHaveBeenCalledTimes(0);
  });

  test('T6: a background job for the failing child is not a child of that session', async () => {
    const { mocks } = createMockClient();
    const mgr = manager();
    live.add('sess-parent');
    await mgr.handleEvent({
      type: 'session.created',
      properties: { info: { id: 'sess-child', parentID: 'sess-parent' } },
    });
    await seed(mgr, 'sess-child');
    await mgr.handleEvent(retry('sess-child'));
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.every((id) => id === 'sess-child')).toBe(true);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.abort).toHaveBeenCalledTimes(1);
  });

  test('T7: v2 keeps aborting on retry even when children are live', async () => {
    const { mocks } = createMockClient();
    const mgr = manager('v2');
    live.add('sess-parent');
    await seed(mgr, 'sess-parent');
    await mgr.handleEvent(retry('sess-parent'));
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('T8: children appearing during waiter promotion prevent the retry abort', async () => {
    const { mocks } = createMockClient({
      postImpl: async () => {
        live.add('sess-child');
        return {};
      },
    });
    const mgr = manager();
    await mgr.handleEvent({
      type: 'session.created',
      properties: { info: { id: 'sess-child', parentID: 'sess-parent' } },
    });
    await seed(mgr, 'sess-child');
    await mgr.handleEvent(retry('sess-child'));
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.abort).toHaveBeenCalledTimes(0);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(0);
    expect(mgr.isFallbackInProgress('sess-child')).toBe(false);
  });

  test('T9: children appearing during busy promotion withdraw the armed handoff without abort', async () => {
    const { mocks } = createMockClient({
      postImpl: async () => {
        live.add('sess-child');
        return {};
      },
      promptAsyncImpl: async () => {
        throw new Error('session busy');
      },
    });
    const reject = mock(() => {});
    const settleUnresolved = mock(() => {});
    const mgr = manager(
      undefined,
      makeChains(),
      {
        prepare: mock(() => true),
        admit: mock(() => {}),
        reject,
        settleUnresolved,
      },
      () => 1,
    );
    await mgr.handleEvent({
      type: 'session.created',
      properties: { info: { id: 'sess-child', parentID: 'sess-parent' } },
    });
    await seed(mgr, 'sess-child');
    await mgr.handleEvent(error('sess-child'));
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.abort).toHaveBeenCalledTimes(0);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(settleUnresolved).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - session.status retry
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager session.status', () => {
  test('aborts session before fallback re-prompt on first failover retry', async () => {
    const calls: string[] = [];
    const { mocks } = createMockClient({
      abortImpl: async () => {
        calls.push('abort');
      },
      promptAsyncImpl: async () => {
        calls.push('promptAsync');
        return {};
      },
    });
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-retry-abort-before-prompt',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-retry-abort-before-prompt',
        status: {
          type: 'retry',
          attempt: 1,
          message: 'rate limit, retrying...',
        },
      },
    });

    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['abort', 'promptAsync']);
  });

  test('promotes foreground task waiter to background before abort when child has known parent', async () => {
    const calls: string[] = [];
    const postArgs: unknown[] = [];
    createMockClient({
      abortImpl: async () => {
        calls.push('abort');
      },
      promptAsyncImpl: async () => {
        calls.push('promptAsync');
        return {};
      },
      postImpl: async (args) => {
        postArgs.push(args);
        calls.push('promote');
        return true;
      },
    });
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'session.created',
      properties: {
        info: { id: 'sess-promoted-child', parentID: 'sess-promoted-parent' },
      },
    });

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-promoted-child',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-promoted-child',
        status: {
          type: 'retry',
          attempt: 1,
          message: 'rate limit, retrying...',
        },
      },
    });

    // Order-critical: the promotion must land before the abort settles
    // the job as "cancelled", or the foreground parent sees
    // "Task cancelled" instead of backgroundResult.
    expect(calls).toEqual(['promote', 'abort', 'promptAsync']);
    expect(postArgs[0]).toMatchObject({
      url: '/experimental/session/{sessionID}/background',
      path: { sessionID: 'sess-promoted-parent' },
    });
  });

  test('skips waiter promotion when the failing session has no known parent', async () => {
    const calls: string[] = [];
    createMockClient({
      abortImpl: async () => {
        calls.push('abort');
      },
      promptAsyncImpl: async () => {
        calls.push('promptAsync');
        return {};
      },
      postImpl: async () => {
        calls.push('promote');
        return true;
      },
    });
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-no-parent',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-no-parent',
        status: { type: 'retry', attempt: 1, message: 'rate limit' },
      },
    });

    expect(calls).toEqual(['abort', 'promptAsync']);
  });

  async function runWaiterFallback(
    sessionID: string,
    parentSessionID: string,
    calls: string[],
    overrides?: Parameters<typeof createMockClient>[0],
  ): Promise<void> {
    createMockClient({
      ...overrides,
      abortImpl: async () => {
        calls.push('abort');
      },
      promptAsyncImpl: async () => {
        calls.push('promptAsync');
        return {};
      },
    });
    const input = { directory: '/test' } as any;
    const mgr = new ForegroundFallbackManager(makeChains(), true, input, 0);
    mgr.registerSessionAgent(sessionID, 'orchestrator');
    await mgr.handleEvent({
      type: 'session.created',
      properties: { info: { id: sessionID, parentID: parentSessionID } },
    });
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID,
        status: { type: 'retry', message: 'rate limit' },
      },
    });
  }

  test.each([
    ['transport exception', false, 'endpoint missing'],
    ['SDK error envelope', true, '{"message":"endpoint missing"}'],
  ] as const)(
    'waiter promotion failure (%s) is fail-soft: abort and fallback still proceed',
    async (_kind, envelope, error) => {
      const calls: string[] = [];
      const logSpy = spyOn(logger, 'log').mockImplementation(() => {});
      try {
        await runWaiterFallback('child', 'parent', calls, {
          postImpl: async () => {
            calls.push('promote');
            if (envelope) {
              return { error: { message: 'endpoint missing' } };
            }
            throw new Error(error);
          },
        });
        expect(calls).toEqual(['promote', 'abort', 'promptAsync']);
        expect(logSpy).not.toHaveBeenCalledWith(
          '[foreground-fallback] promoted foreground task waiter to background',
          expect.objectContaining({ sessionID: 'child' }),
        );
        expect(logSpy).toHaveBeenCalledWith(
          '[foreground-fallback] foreground waiter promotion failed; continuing fallback',
          {
            sessionID: 'child',
            parentSessionID: 'parent',
            transport: 'sdk',
            error,
          },
        );
      } finally {
        logSpy.mockRestore();
      }
    },
  );

  test('promotes the waiter before the busy-session abort in execFallback too', async () => {
    const calls: string[] = [];
    const postArgs: unknown[] = [];
    const { mocks } = createMockClient({
      promptAsyncImpl: async () => {
        calls.push('promptAsync');
        throw new Error('session busy');
      },
      abortImpl: async () => {
        calls.push('abort');
      },
      postImpl: async (args) => {
        postArgs.push(args);
        calls.push('promote');
        return true;
      },
    });
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'session.created',
      properties: {
        info: {
          id: 'sess-busy-promoted',
          parentID: 'sess-busy-promoted-parent',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-busy-promoted',
        error: { message: 'Rate limit exceeded' },
      },
    });

    // Same ordering contract as tryFallbackWithAbort, exercised through
    // the promptAsync-busy abort inside execFallback: the promotion must
    // land between the first (busy) attempt and the abort.
    expect(calls[0]).toBe('promptAsync');
    expect(calls[1]).toBe('promote');
    expect(calls[2]).toBe('abort');
    expect(postArgs[0]).toMatchObject({
      url: '/experimental/session/{sessionID}/background',
      path: { sessionID: 'sess-busy-promoted-parent' },
    });
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
  });

  test('v2 without post reports promotion unavailable without network calls', async () => {
    const calls: string[] = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected fetch');
    });
    fetchSpy.mockClear();
    const logSpy = spyOn(logger, 'log').mockImplementation(() => {});
    try {
      await runWaiterFallback('sess-v2-child', 'sess-v2-parent', calls, {
        includePostClient: false,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(0);
      expect(calls).toEqual(['abort', 'promptAsync']);
      expect(logSpy).toHaveBeenCalledWith(
        '[foreground-fallback] foreground waiter promotion unavailable on this host; continuing fallback',
        {
          sessionID: 'sess-v2-child',
          parentSessionID: 'sess-v2-parent',
          transport: 'none',
        },
      );
    } finally {
      fetchSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test('does not abort through a stale client when disposed during promotion', async () => {
    const calls: string[] = [];
    let mgr: ForegroundFallbackManager | undefined;
    createMockClient({
      postImpl: async () => {
        calls.push('promote');
        mgr?.dispose();
        return true;
      },
      abortImpl: async () => {
        calls.push('abort');
      },
      promptAsyncImpl: async () => {
        calls.push('promptAsync');
        return {};
      },
    });
    const manager = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );
    mgr = manager;

    await manager.handleEvent({
      type: 'session.created',
      properties: {
        info: { id: 'sess-dispose-child', parentID: 'sess-dispose-parent' },
      },
    });
    await manager.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-dispose-child',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });
    await manager.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-dispose-child',
        status: { type: 'retry', attempt: 1, message: 'rate limit' },
      },
    });

    // The promotion landed, but the generation was disposed inside it:
    // neither the abort nor the replay may run through the stale client.
    expect(calls).toEqual(['promote']);
  });

  test('keeps registered child agent identity sticky for retry fallback chain', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains({
        oracle: ['anthropic/claude-sonnet-4-5', 'openai/o3'],
      }),
      true,
      { directory: '/test' } as any,
      0,
    );

    mgr.registerSessionAgent('child-oracle-sticky', 'oracle');
    mgr.registerSessionAgent('child-oracle-sticky', 'orchestrator');
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'child-oracle-sticky',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'child-oracle-sticky',
        status: { type: 'retry', message: 'usage limit reached, retrying...' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      { model: { providerID: string; modelID: string } },
    ];
    expect(call[0].body.model).toEqual({ providerID: 'openai', modelID: 'o3' });
  });

  test('includes the sticky child agent in fallback promptAsync body', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains({
        oracle: ['anthropic/claude-sonnet-4-5', 'openai/o3'],
      }),
      true,
      { directory: '/test' } as any,
      0,
    );

    mgr.registerSessionAgent('child-oracle-agent-body', 'oracle');
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'child-oracle-agent-body',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'child-oracle-agent-body',
        status: { type: 'retry', message: 'usage limit reached, retrying...' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      {
        agent?: string;
        model: { providerID: string; modelID: string };
      },
    ];
    expect(call[0].body.agent).toBe('oracle');
    expect(call[0].body.model).toEqual({ providerID: 'openai', modelID: 'o3' });
  });

  test('triggers fallback on retry status with rate limit message', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-4',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-4',
        status: { type: 'retry', message: 'usage limit reached, retrying...' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('triggers fallback on retry status with insufficient balance message', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-5',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-5',
        status: { type: 'retry', message: 'Insufficient balance.' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('ignores session.status with non-rate-limit retry message', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-4',
        status: { type: 'retry', message: 'connection timeout, retrying...' },
      },
    });

    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('does not abort or switch after retries without a failover reason', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-retry-no-reason',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    for (const attempt of [1, 2, 3]) {
      await mgr.handleEvent({
        type: 'session.status',
        properties: {
          sessionID: 'sess-retry-no-reason',
          status: { type: 'retry', attempt },
        },
      });
    }

    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('triggers immediate fallback on first failover retry', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-retry',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-retry',
        status: {
          type: 'retry',
          attempt: 1,
          message: 'Free usage exceeded, subscribe to Go',
        },
      },
    });
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('switches to fallback model on first failover retry', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-retry2',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-retry2',
        status: {
          type: 'retry',
          attempt: 1,
          message: 'rate limit, retrying...',
        },
      },
    });
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('triggers fallback when rate-limit text is in props.error instead of status.message', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-error-field',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    // status.message is benign but props.error carries the rate-limit signal
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-error-field',
        status: { type: 'retry', attempt: 1, message: 'retrying...' },
        error: { message: 'Usage exceeded for this billing period' },
      },
    });
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('triggers fallback when props.error is a plain string', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-str-error',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    // props.error is a plain string — no object wrapper
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-str-error',
        status: { type: 'retry', attempt: 1, message: 'retrying...' },
        error: 'Usage exceeded for this billing period',
      },
    });
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('does not toast when 410 signal arrives via status.message with no error property', async () => {
    const { mocks } = createMockClient();
    const showToast = mock(async () => ({}));
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
        client: { tui: { showToast } },
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-status-message-410',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    // The AI SDK surfaces HTTP 410 as a bare retry status message with no
    // separate error property. The runtime renders it inline — no toast.
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-status-message-410',
        status: { type: 'retry', attempt: 1, message: 'AI_APICallError: Gone' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  test('non-rate-limit retry does not trigger fallback but rate-limit does', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-nonrl',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    // Non-rate-limit retry (e.g. abort side effect): must NOT trigger fallback.
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-nonrl',
        status: { type: 'retry', attempt: 1, message: 'aborted' },
      },
    });
    expect(mocks.promptAsync).toHaveBeenCalledTimes(0);

    // Genuine rate-limit retry triggers immediate fallback.
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-nonrl',
        status: {
          type: 'retry',
          attempt: 1,
          message: 'rate limit, retrying...',
        },
      },
    });
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('ignores stale retry event from original model after fallback switches models', async () => {
    // greptile-apps race condition: after a fallback succeeds and the manager
    // switches to model B, a delayed retry event from model A's original retry
    // loop (already in-flight when the abort happened) should NOT trigger a
    // second fallback — it carries the old model's error, not model B's.
    const calls: string[] = [];
    const { mocks } = createMockClient({
      abortImpl: async () => {
        calls.push('abort');
      },
      promptAsyncImpl: async () => {
        calls.push('promptAsync');
        return {};
      },
    });
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    // Seed session with model A (anthropic/claude-opus-4-5)
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-stale',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    // First retry event: model A rate-limited → triggers fallback to model B
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-stale',
        status: {
          type: 'retry',
          attempt: 1,
          message: 'rate limit, retrying...',
        },
      },
    });

    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const firstCall = mocks.promptAsync.mock.calls[0] as [
      { model: { providerID: string; modelID: string } },
    ];
    expect(firstCall[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o',
    });

    // Stale retry event from the ORIGINAL model A arrives after the switch.
    // The session model is now openai/gpt-4o, so this event should be ignored.
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-stale',
        status: {
          type: 'retry',
          attempt: 2,
          message: 'rate limit, retrying...',
        },
      },
    });

    // Should NOT trigger another fallback — the event is stale
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('does NOT ignore genuine retry from fallback model within dedup window', async () => {
    // greptile-apps issue #2: a genuine retry from the fallback model (model B)
    // arriving within the dedup window should trigger a fallback, not be ignored.
    // The previous fix used lastTriggerModel which still held model A, causing
    // model B's genuine retry to be mistaken for a stale retry from model A.
    const calls: string[] = [];
    const { mocks } = createMockClient({
      abortImpl: async () => {
        calls.push('abort');
      },
      promptAsyncImpl: async () => {
        calls.push('promptAsync');
        return {};
      },
    });
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    ); // maxRetries=0: fall through on the first error (cascade-focused test)

    // Seed session with model A
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-genuine-retry',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    // First retry event: model A rate-limited → triggers fallback to model B
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-genuine-retry',
        status: {
          type: 'retry',
          attempt: 1,
          message: 'rate limit, retrying...',
        },
      },
    });

    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const firstCall = mocks.promptAsync.mock.calls[0] as [
      { model: { providerID: string; modelID: string } },
    ];
    expect(firstCall[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o',
    });

    // Now model B (openai/gpt-4o) is active. A GENUINE retry from model B
    // arrives within the dedup window (immediately after). This should trigger
    // another fallback to model C (google/gemini-2.5-pro), NOT be ignored.
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-genuine-retry',
        status: {
          type: 'retry',
          attempt: 1, // attempt resets for new model
          message: 'rate limit, retrying...',
        },
      },
    });

    // Should trigger a second fallback to model C
    expect(mocks.abort).toHaveBeenCalledTimes(2);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    const secondCall = mocks.promptAsync.mock.calls[1] as [
      { model: { providerID: string; modelID: string } },
    ];
    expect(secondCall[0].body.model).toEqual({
      providerID: 'google',
      modelID: 'gemini-2.5-pro',
    });
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - chain exhaustion
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager chain exhaustion', () => {
  test('re-walks from the second chain entry on each new user turn', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );
    const sessionID = 'sess-turns';

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          agent: 'orchestrator',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    const realNowFn = Date.now;
    let fakeNow = realNowFn();
    Date.now = () => fakeNow;
    try {
      fakeNow += 6_000;
      await mgr.handleEvent({
        type: 'session.error',
        properties: { sessionID, error: { message: 'rate limit exceeded' } },
      });
      expect(mocks.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            model: { providerID: 'openai', modelID: 'gpt-4o' },
          }),
        }),
      );

      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID,
            agent: 'orchestrator',
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-4o',
            time: { created: 1, completed: 2 },
          },
        },
      });
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID,
            agent: 'orchestrator',
            role: 'user',
            model: {
              providerID: 'anthropic',
              modelID: 'claude-opus-4-5',
            },
          },
        },
      });

      fakeNow += 6_000;
      await mgr.handleEvent({
        type: 'session.error',
        properties: { sessionID, error: { message: 'rate limit exceeded' } },
      });

      expect(mocks.promptAsync.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          body: expect.objectContaining({
            model: { providerID: 'openai', modelID: 'gpt-4o' },
          }),
        }),
      );
    } finally {
      Date.now = realNowFn;
    }
  });

  test('recovers fallback after a chain-exhaustion abort when a new turn returns to the primary', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      0,
    );
    const sessionID = 'sess-recover-after-abort';

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          agent: 'orchestrator',
          providerID: 'openai',
          modelID: 'gpt-b',
          role: 'assistant',
        },
      },
    });

    const realNowFn = Date.now;
    let fakeNow = realNowFn();
    Date.now = () => fakeNow;
    try {
      const fail = async () => {
        fakeNow += 6_000;
        await mgr.handleEvent({
          type: 'session.error',
          properties: {
            sessionID,
            error: { message: 'rate limit exceeded' },
          },
        });
      };

      await fail();
      await fail();
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
      expect(mocks.abort).toHaveBeenCalledTimes(1);

      // A confirmed new USER turn returning to the primary clears stage-2.
      // Uses the real SDK UserMessage shape: the model is nested.
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID,
            agent: 'orchestrator',
            role: 'user',
            model: { providerID: 'openai', modelID: 'gpt-b' },
          },
        },
      });

      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(3);
      expect(mocks.promptAsync.mock.calls[2]?.[0]).toEqual(
        expect.objectContaining({
          body: expect.objectContaining({
            model: { providerID: 'openai', modelID: 'gpt-c' },
          }),
        }),
      );
      expect(mgr.willAttemptFallback(sessionID)).toBe(true);
    } finally {
      Date.now = realNowFn;
    }
  });

  test('a real SDK user message resets exhaustion and the retry budget', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      1, // maxRetries=1 so the budget reset is observable
    );
    const sessionID = 'sess-sdk-user-reset';

    const realNowFn = Date.now;
    let fakeNow = realNowFn();
    Date.now = () => fakeNow;
    try {
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID,
            agent: 'orchestrator',
            providerID: 'openai',
            modelID: 'gpt-b',
            role: 'assistant',
          },
        },
      });

      const fail = async () => {
        fakeNow += 6_000;
        await mgr.handleEvent({
          type: 'session.error',
          properties: {
            sessionID,
            error: { message: 'rate limit exceeded' },
          },
        });
      };

      // maxRetries=1: error 1 absorbed (same-model retry), 2 falls back,
      // 3 sticky re-prompt, 4 second exhaustion → abort.
      await fail();
      await fail();
      await fail();
      await fail();
      expect(mocks.abort).toHaveBeenCalledTimes(1);
      expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);

      // Real SDK user message: model nested under info.model, back to primary.
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID,
            agent: 'orchestrator',
            role: 'user',
            model: { providerID: 'openai', modelID: 'gpt-b' },
          },
        },
      });

      expect((mgr as any).chainExhaustion.has(sessionID)).toBe(false);
      expect((mgr as any).sessionRetries.has(sessionID)).toBe(false);
      expect(mgr.willAttemptFallback(sessionID)).toBe(true);

      // The new turn's first failure must be absorbed as a same-model retry,
      // not jump straight to fallback — proving the budget was reset.
      const before = mocks.promptAsync.mock.calls.length;
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(before + 1);
      const lastCall = mocks.promptAsync.mock.calls.at(-1) as [
        { body: { model: { providerID: string; modelID: string } } },
      ];
      expect(lastCall[0].body.model).toEqual({
        providerID: 'openai',
        modelID: 'gpt-b',
      });
      expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);
    } finally {
      Date.now = realNowFn;
    }
  });

  test('a late primary event that is not a new user turn keeps exhaustion', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      0,
    );
    const sessionID = 'sess-late-primary';

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          agent: 'orchestrator',
          providerID: 'openai',
          modelID: 'gpt-b',
          role: 'assistant',
        },
      },
    });

    const realNowFn = Date.now;
    let fakeNow = realNowFn();
    Date.now = () => fakeNow;
    try {
      const fail = async () => {
        fakeNow += 6_000;
        await mgr.handleEvent({
          type: 'session.error',
          properties: {
            sessionID,
            error: { message: 'rate limit exceeded' },
          },
        });
      };

      await fail();
      await fail();
      await fail();
      expect(mocks.abort).toHaveBeenCalledTimes(1);
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);

      // A LATE primary-model event from the old request — assistant role, so
      // not a new user turn. It must not re-open the terminal guard.
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID,
            agent: 'orchestrator',
            providerID: 'openai',
            modelID: 'gpt-b',
            role: 'assistant',
          },
        },
      });

      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
      expect(mocks.abort).toHaveBeenCalledTimes(1);
      expect(mgr.willAttemptFallback(sessionID)).toBe(false);
    } finally {
      Date.now = realNowFn;
    }
  });

  test('does not fall back onto an earlier chain entry', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );
    const sessionID = 'sess-mid-chain';

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          agent: 'orchestrator',
          providerID: 'openai',
          modelID: 'gpt-4o',
          role: 'assistant',
        },
      },
    });
    await mgr.handleEvent({
      type: 'session.error',
      properties: { sessionID, error: { message: 'rate limit exceeded' } },
    });

    expect(mocks.promptAsync.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: 'google', modelID: 'gemini-2.5-pro' },
        }),
      }),
    );
    expect(mocks.promptAsync.mock.calls[0]?.[0].body.model).not.toEqual({
      providerID: 'anthropic',
      modelID: 'claude-opus-4-5',
    });
  });

  test('does not fall back onto the primary when the current model is off-chain', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );
    const sessionID = 'sess-off-chain';

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          agent: 'orchestrator',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    const realNowFn = Date.now;
    let fakeNow = realNowFn();
    Date.now = () => fakeNow;
    try {
      fakeNow += 6_000;
      await mgr.handleEvent({
        type: 'session.error',
        properties: { sessionID, error: { message: 'rate limit exceeded' } },
      });
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID,
            agent: 'orchestrator',
            providerID: 'openai',
            modelID: 'gpt-4o-mini',
            role: 'assistant',
          },
        },
      });

      fakeNow += 6_000;
      await mgr.handleEvent({
        type: 'session.error',
        properties: { sessionID, error: { message: 'rate limit exceeded' } },
      });

      expect(mocks.promptAsync.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          body: expect.objectContaining({
            model: { providerID: 'google', modelID: 'gemini-2.5-pro' },
          }),
        }),
      );
      expect(mocks.promptAsync.mock.calls[1]?.[0].body.model).not.toEqual({
        providerID: 'anthropic',
        modelID: 'claude-opus-4-5',
      });
    } finally {
      Date.now = realNowFn;
    }
  });

  test('does not reset the descent when the current model was inferred, not observed', async () => {
    createMockClient({ messagesData: [] });
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['a/1', 'b/2', 'c/3'] },
      true,
      { directory: '/test' } as any,
      0,
    );
    const sessionID = 'sess-inferred-model';

    await mgr.handleEvent({
      type: 'subagent.session.created',
      properties: { sessionID, agentName: 'orchestrator' },
    });

    const realNowFn = Date.now;
    let fakeNow = realNowFn();
    Date.now = () => fakeNow;
    try {
      const fail = async () => {
        fakeNow += 6_000;
        await mgr.handleEvent({
          type: 'session.error',
          properties: {
            sessionID,
            error: { message: 'rate limit exceeded' },
          },
        });
      };

      await fail();
      await fail();

      expect([...(mgr as any).sessionTried.get(sessionID)]).toEqual([
        'a/1',
        'b/2',
        'c/3',
      ]);
    } finally {
      Date.now = realNowFn;
    }
  });

  test('does not call promptAsync when the only chain model is already the current model', async () => {
    // Scenario: chain = ['openai/gpt-b'], current model IS 'openai/gpt-b'.
    // tryFallback adds 'openai/gpt-b' to tried → chain.find() returns undefined → exhausted.
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b'] },
      true,
      { directory: '/test' } as any,
      0,
    );

    // Seed current model as the only chain entry
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 's',
          providerID: 'openai',
          modelID: 'gpt-b',
        },
      },
    });

    // Rate limit fires - only model in chain is already current → nothing to fall back to
    await mgr.handleEvent({
      type: 'session.error',
      properties: { sessionID: 's', error: { message: 'rate limit exceeded' } },
    });

    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('aborts when all chain models have been tried', async () => {
    // Scenario: chain = ['anthropic/claude-a', 'openai/gpt-b'].
    // Current model is 'openai/gpt-b' (the last fallback already in use).
    // tried will contain: 'openai/gpt-b' (current) → chain.find() → 'anthropic/claude-a'
    // would be picked… unless we also mark it tried via a prior switch.
    // Use agent name tracking so we can target the right chain, then seed tried
    // by having the manager go through both models via sequential events
    // (each on a distinct session so dedup does not interfere).
    const { mocks } = createMockClient();
    const chain = ['openai/model-x', 'openai/model-y'];
    const mgr = new ForegroundFallbackManager(
      { orchestrator: chain },
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    // Session A: current model is model-x, which IS in the chain → picks model-y ✓
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-exhaust',
          agent: 'orchestrator',
          providerID: 'openai',
          modelID: 'model-x',
          error: { message: 'rate limit exceeded' },
        },
      },
    });
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    // Session B (fresh session, different ID): only model-y is in chain and it IS
    // the current model → tried gets model-y → chain.find() = undefined → exhausted
    // → abort called to stop the freeze
    const { mocks: mocks2 } = createMockClient();
    const mgr2 = new ForegroundFallbackManager(
      { orchestrator: ['openai/model-y'] }, // single-entry chain already in use
      true,
      { directory: '/test' } as any,
      0,
    );
    await mgr2.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-exhaust-2',
          agent: 'orchestrator',
          providerID: 'openai',
          modelID: 'model-y',
          error: { message: 'rate limit exceeded' },
        },
      },
    });
    expect(mocks2.abort).toHaveBeenCalledTimes(1);
    expect(mocks2.promptAsync).not.toHaveBeenCalled();
  });

  test('aborts after one re-fallback instead of looping when the whole chain keeps failing', async () => {
    // Regression for issue #966: two-model chain [gpt-b, gpt-c], both dead.
    // The reporter's log showed "from glm to glm" every ~10s: the reset path
    // re-prompted the sticky model forever. It must be allowed once (sticky
    // gets one retry), then abort and stop intervening. Failures are spaced
    // beyond the dedup window (as in the real 10s-interval report).
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-loop',
          providerID: 'openai',
          modelID: 'gpt-b',
          role: 'assistant',
        },
      },
    });

    const realNowFn = Date.now;
    let fakeNow = realNowFn();
    Date.now = () => fakeNow;
    try {
      const fail = async () => {
        fakeNow += 6_000; // skip the 5s dedup window
        await mgr.handleEvent({
          type: 'session.error',
          properties: {
            sessionID: 'sess-loop',
            error: { message: 'Rate limit exceeded' },
          },
        });
      };

      // Fail 1: gpt-b → gpt-c.
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
      expect(mocks.abort).toHaveBeenCalledTimes(0);

      // Fail 2: gpt-c fails → first chain exhaustion → reset, re-prompt gpt-c once.
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
      expect(mocks.abort).toHaveBeenCalledTimes(0);

      // Fail 3: gpt-c fails again → second exhaustion → abort, no re-prompt.
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
      expect(mocks.abort).toHaveBeenCalledTimes(1);

      // Fail 4/5: exhaustion state is terminal → no further intervention.
      await fail();
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
      expect(mocks.abort).toHaveBeenCalledTimes(1);
    } finally {
      Date.now = realNowFn;
    }
  });

  test('clears exhaustion state on a successful response (sticky fallback recovered)', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-recover',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    const realNowFn = Date.now;
    let fakeNow = realNowFn();
    Date.now = () => fakeNow;
    try {
      const fail = async () => {
        fakeNow += 6_000;
        await mgr.handleEvent({
          type: 'session.error',
          properties: {
            sessionID: 'sess-recover',
            error: { message: 'Rate limit exceeded' },
          },
        });
      };

      // Walk the chain to the first exhaustion reset (stage 1).
      await fail();
      await fail();
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(3);

      // Successful response clears the exhaustion stage.
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'sess-recover',
            providerID: 'google',
            modelID: 'gemini-2.5-pro',
            role: 'assistant',
            time: { created: 1, completed: 2 },
          },
        },
      });

      // Next failure gets a fresh reset chance instead of aborting immediately.
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(4);
      expect(mocks.abort).toHaveBeenCalledTimes(0);
    } finally {
      Date.now = realNowFn;
    }
  });

  test('does not recover from an incomplete assistant message', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-incomplete-recovery',
          providerID: 'openai',
          modelID: 'gpt-b',
          role: 'assistant',
        },
      },
    });

    const realNowFn = Date.now;
    let fakeNow = realNowFn();
    Date.now = () => fakeNow;
    try {
      const fail = async () => {
        fakeNow += 6_000;
        await mgr.handleEvent({
          type: 'session.error',
          properties: {
            sessionID: 'sess-incomplete-recovery',
            error: { message: 'Rate limit exceeded' },
          },
        });
      };

      // Reach stage 1: gpt-b → gpt-c, then the sticky gpt-c retry.
      await fail();
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);

      // A streaming assistant update is not proof of recovery.
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'sess-incomplete-recovery',
            providerID: 'openai',
            modelID: 'gpt-c',
            role: 'assistant',
            time: { created: 1 },
          },
        },
      });

      // Stage 1 remains terminal on the next exhaustion: abort, no third prompt.
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
      expect(mocks.abort).toHaveBeenCalledTimes(1);
    } finally {
      Date.now = realNowFn;
    }
  });

  // Protects the tried.size > 1 invariant in execFallback: a single-model
  // chain must not re-abort repeatedly after exhaustion.
  test('does not abort repeatedly for single-model chains after exhaustion', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b'] },
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-solo',
          providerID: 'openai',
          modelID: 'gpt-b',
        },
      },
    });

    const realNowFn = Date.now;
    let fakeNow = realNowFn();
    Date.now = () => fakeNow;
    try {
      const fail = async () => {
        fakeNow += 6_000;
        await mgr.handleEvent({
          type: 'session.error',
          properties: {
            sessionID: 'sess-solo',
            error: { message: 'rate limit exceeded' },
          },
        });
      };

      await fail();
      expect(mocks.abort).toHaveBeenCalledTimes(1);
      expect(mocks.promptAsync).not.toHaveBeenCalled();

      // Second error must not abort again (no abort loop).
      await fail();
      expect(mocks.abort).toHaveBeenCalledTimes(1);
      expect(mocks.promptAsync).not.toHaveBeenCalled();
    } finally {
      Date.now = realNowFn;
    }
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - combined inheritModelFrom + fallback chain
// ---------------------------------------------------------------------------

// A combined agent (array `model` + `inheritModelFrom`) runs the session's
// live model, which is typically NOT part of the configured chain. The live
// model becomes the dynamic chain head; the configured entries back it.
describe('ForegroundFallbackManager inherit + fallback chain', () => {
  const LIVE_MODEL = 'test/live-session-model';

  function observe(
    mgr: ForegroundFallbackManager,
    sessionID: string,
    modelID: string,
    completed = false,
  ): Promise<void> {
    const [providerID, id] = modelID.split('/');
    return mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          agent: 'oracle',
          providerID,
          modelID: id,
          role: 'assistant',
          ...(completed ? { time: { created: 1, completed: 2 } } : {}),
        },
      },
    });
  }

  test('falls back from an out-of-chain live model to the configured chain head', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { oracle: ['openai/gpt-a', 'openai/gpt-b'] },
      true,
      { directory: '/test' } as any,
      0,
    );
    const sessionID = 'sess-combined-first';

    await observe(mgr, sessionID, LIVE_MODEL);
    await mgr.handleEvent({
      type: 'session.error',
      properties: { sessionID, error: { message: 'rate limit exceeded' } },
    });

    // The dynamic head (the live session model) is never re-picked; the
    // first configured entry takes over.
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: 'openai', modelID: 'gpt-a' },
        }),
      }),
    );
  });

  test('keeps descending through the configured chain behind the dynamic head', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { oracle: ['openai/gpt-a', 'openai/gpt-b'] },
      true,
      { directory: '/test' } as any,
      0,
    );
    const sessionID = 'sess-combined-descend';

    const realNowFn = Date.now;
    let fakeNow = realNowFn();
    Date.now = () => fakeNow;
    try {
      await observe(mgr, sessionID, LIVE_MODEL);
      const fail = async () => {
        fakeNow += 6_000;
        await mgr.handleEvent({
          type: 'session.error',
          properties: {
            sessionID,
            error: { message: 'rate limit exceeded' },
          },
        });
      };

      await fail(); // live model → gpt-a
      await observe(mgr, sessionID, 'openai/gpt-a');
      await fail(); // gpt-a → gpt-b

      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
      expect(mocks.promptAsync.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          body: expect.objectContaining({
            model: { providerID: 'openai', modelID: 'gpt-b' },
          }),
        }),
      );
    } finally {
      Date.now = realNowFn;
    }
  });

  test('in-chain models keep the static chain behavior', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { oracle: ['openai/gpt-a', 'openai/gpt-b'] },
      true,
      { directory: '/test' } as any,
      0,
    );
    const sessionID = 'sess-combined-inchain';

    await observe(mgr, sessionID, 'openai/gpt-a');
    await mgr.handleEvent({
      type: 'session.error',
      properties: { sessionID, error: { message: 'rate limit exceeded' } },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: 'openai', modelID: 'gpt-b' },
        }),
      }),
    );
  });

  test('an out-of-chain live model does not resurrect a disabled chain', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { oracle: ['openai/gpt-a'] },
      true,
      { directory: '/test' } as any,
      0,
    );
    mgr.disableChain('oracle');
    const sessionID = 'sess-combined-disabled';

    await observe(mgr, sessionID, LIVE_MODEL);
    await mgr.handleEvent({
      type: 'session.error',
      properties: { sessionID, error: { message: 'rate limit exceeded' } },
    });

    expect(mocks.promptAsync).not.toHaveBeenCalled();
    expect(mocks.abort).not.toHaveBeenCalled();
  });

  test('exhaustion stays bounded with a dynamic head (no ping-pong re-arm)', async () => {
    // Combined agent: live session model X + configured chain [gpt-a, gpt-b],
    // everything failing. The re-arm check must compare against the STATIC
    // chain head: the dynamic head always equals the observed model, so
    // comparing against chain[0] would reset the tried set on every error
    // and re-descend forever (issue #1292).
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { oracle: ['openai/gpt-a', 'openai/gpt-b'] },
      true,
      { directory: '/test' } as any,
      0,
    );
    const sessionID = 'sess-combined-bounded';

    const realNowFn = Date.now;
    let fakeNow = realNowFn();
    Date.now = () => fakeNow;
    try {
      const fail = async (modelID: string) => {
        fakeNow += 6_000;
        await observe(mgr, sessionID, modelID);
        await mgr.handleEvent({
          type: 'session.error',
          properties: {
            sessionID,
            error: { message: 'rate limit exceeded' },
          },
        });
      };

      // Fail 1: live model → gpt-a.
      await fail(LIVE_MODEL);
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

      // Fail 2: gpt-a → gpt-b.
      await fail('openai/gpt-a');
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);

      // Fail 3: gpt-b → first exhaustion → sticky re-prompt of gpt-b.
      await fail('openai/gpt-b');
      expect(mocks.promptAsync).toHaveBeenCalledTimes(3);
      expect(mocks.abort).toHaveBeenCalledTimes(0);

      // Fail 4: sticky gpt-b fails again → second exhaustion → abort once.
      await fail('openai/gpt-b');
      expect(mocks.promptAsync).toHaveBeenCalledTimes(3);
      expect(mocks.abort).toHaveBeenCalledTimes(1);

      // Fail 5: a new turn re-sends the live session model (out-of-chain).
      // The dynamic-head bug would re-arm here (observed === chain[0]) and
      // start a fresh descent; the static-head check must stay terminal.
      await fail(LIVE_MODEL);
      expect(mocks.promptAsync).toHaveBeenCalledTimes(3);
      expect(mocks.abort).toHaveBeenCalledTimes(1);

      // Fail 6: still terminal.
      await fail(LIVE_MODEL);
      expect(mocks.promptAsync).toHaveBeenCalledTimes(3);
      expect(mocks.abort).toHaveBeenCalledTimes(1);
    } finally {
      Date.now = realNowFn;
    }
  });

  test('re-arm still fires when the session returns to the configured chain head', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { oracle: ['openai/gpt-a', 'openai/gpt-b'] },
      true,
      { directory: '/test' } as any,
      0,
    );
    const sessionID = 'sess-combined-rearm';

    const realNowFn = Date.now;
    let fakeNow = realNowFn();
    Date.now = () => fakeNow;
    try {
      const fail = async (modelID: string) => {
        fakeNow += 6_000;
        await observe(mgr, sessionID, modelID);
        await mgr.handleEvent({
          type: 'session.error',
          properties: {
            sessionID,
            error: { message: 'rate limit exceeded' },
          },
        });
      };

      // Exhaust the chain starting from the live model, ending aborted.
      await fail(LIVE_MODEL); // → gpt-a
      await fail('openai/gpt-a'); // → gpt-b
      await fail('openai/gpt-b'); // sticky gpt-b
      await fail('openai/gpt-b'); // abort
      expect(mocks.abort).toHaveBeenCalledTimes(1);

      // The session returns to the CONFIGURED primary (gpt-a): the tried
      // set resets and a fresh descent from gpt-a is allowed.
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID,
            agent: 'oracle',
            role: 'user',
            model: { providerID: 'openai', modelID: 'gpt-a' },
          },
        },
      });
      await fail('openai/gpt-a');
      expect(mocks.promptAsync).toHaveBeenCalledTimes(4);
      expect(mocks.promptAsync.mock.calls[3]?.[0]).toEqual(
        expect.objectContaining({
          body: expect.objectContaining({
            model: { providerID: 'openai', modelID: 'gpt-b' },
          }),
        }),
      );
    } finally {
      Date.now = realNowFn;
    }
  });

  test('a successful response resets the tried set so the next descent starts fresh', async () => {
    // The combined agent's live model never equals the configured head, so
    // the re-arm reset cannot clear cross-turn state; without a reset on
    // success, each new descent would sink one link deeper (turn 2 would
    // skip gpt-a because turn 1 already tried it, even though the streak
    // ended with a success on gpt-a).
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { oracle: ['openai/gpt-a', 'openai/gpt-b'] },
      true,
      { directory: '/test' } as any,
      0,
    );
    const sessionID = 'sess-combined-success-reset';

    const realNowFn = Date.now;
    let fakeNow = realNowFn();
    Date.now = () => fakeNow;
    try {
      const fail = async (modelID: string) => {
        fakeNow += 6_000;
        await observe(mgr, sessionID, modelID);
        await mgr.handleEvent({
          type: 'session.error',
          properties: {
            sessionID,
            error: { message: 'rate limit exceeded' },
          },
        });
      };

      // Turn 1: live model fails → fall back to gpt-a, which then
      // completes successfully.
      await fail(LIVE_MODEL);
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
      await observe(mgr, sessionID, 'openai/gpt-a', true);

      // Turn 2: back on the live model, it fails again. gpt-a proved
      // healthy last turn — the descent must revisit it, not skip to
      // gpt-b.
      await fail(LIVE_MODEL);
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
      expect(mocks.promptAsync.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          body: expect.objectContaining({
            model: { providerID: 'openai', modelID: 'gpt-a' },
          }),
        }),
      );
    } finally {
      Date.now = realNowFn;
    }
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - deduplication
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager deduplication', () => {
  test('terminal events without a correlatable id are never deduped by time', async () => {
    // Two independent session.error events with identical text and no shared
    // id must BOTH be processed: a fixed time window must never swallow the
    // next real failure.
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    const event = {
      type: 'session.error',
      properties: {
        sessionID: 'sess-dup',
        error: { message: 'rate limit exceeded' },
      },
    };

    await mgr.handleEvent(event);
    await mgr.handleEvent(event);

    // maxRetries=0: both advance the chain (link 2, then link 3).
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
  });

  test('duplicate message.updated notifications sharing a message id dedupe', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    const event = {
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-dup-id',
          id: 'msg-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          error: { message: 'rate limit exceeded' },
        },
      },
    };

    await mgr.handleEvent(event);
    await mgr.handleEvent(event);

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('a new message id with identical error text is a new incident', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    const event = (id: string) => ({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-new-id',
          id,
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          error: { message: 'rate limit exceeded' },
        },
      },
    });

    await mgr.handleEvent(event('msg-1'));
    await mgr.handleEvent(event('msg-2'));

    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
  });

  test('session.status dedupes a repeated attempt but processes an incremented one', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      1, // maxRetries=1: attempt 1 is host-absorbed, attempt 2 falls back
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-ep',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });
    const retry = (attempt: number) => ({
      type: 'session.status',
      properties: {
        sessionID: 'sess-ep',
        status: {
          type: 'retry',
          attempt,
          message: 'rate limit, retrying...',
        },
      },
    });

    await mgr.handleEvent(retry(1)); // host-absorbed
    expect(mocks.promptAsync).not.toHaveBeenCalled();
    await mgr.handleEvent(retry(1)); // duplicate attempt -> deduped, no charge
    expect(mocks.promptAsync).not.toHaveBeenCalled();
    await mgr.handleEvent(retry(2)); // next attempt -> budget exhausted -> fallback
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('reusing a deleted session id starts from fresh fallback state', async () => {
    const coordinator = new SessionLifecycle();
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
      coordinator,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-reuse',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          error: { message: 'rate limit exceeded' },
        },
      },
    });
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    await mgr.handleEvent({
      type: 'session.deleted',
      properties: { info: { id: 'sess-reuse' } },
    });

    const internal = mgr as unknown as {
      sessionModel: Map<string, string>;
      sessionTried: Map<string, Set<string>>;
      lastTriggerMap: Map<string, unknown>;
      chainExhaustion: Map<string, number>;
    };
    expect(internal.sessionModel.has('sess-reuse')).toBe(false);
    expect(internal.sessionTried.has('sess-reuse')).toBe(false);
    expect(internal.lastTriggerMap.has('sess-reuse')).toBe(false);
    expect(internal.chainExhaustion.has('sess-reuse')).toBe(false);
  });

  test('a concurrent terminal event does not consume budget while a retry is in flight', async () => {
    let resolveMessages!: (value: unknown) => void;
    const messagesPromise = new Promise((resolve) => {
      resolveMessages = resolve;
    });
    const { mocks } = createMockClient({
      messagesImpl: () => messagesPromise,
    });
    const mgr = new ForegroundFallbackManager(
      makeChains({
        orchestrator: ['openai/gpt-b', 'openai/gpt-c', 'openai/gpt-d'],
      }),
      true,
      { directory: '/test' } as any,
      1,
    );
    const sessionID = 'sess-concurrent-budget';

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: { sessionID, providerID: 'openai', modelID: 'gpt-b' },
      },
    });

    const error = (id: string) => ({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id,
          providerID: 'openai',
          modelID: 'gpt-b',
          error: { message: 'rate limit exceeded' },
        },
      },
    });

    // First event consumes one budget slot and suspends on the transcript read.
    const first = mgr.handleEvent(error('m1'));
    expect(mgr.isFallbackInProgress(sessionID)).toBe(true);

    // A distinct event arriving while in flight must NOT burn budget.
    await mgr.handleEvent(error('m2'));
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);

    resolveMessages({
      data: [
        {
          info: { role: 'user', id: 'u1' },
          parts: [{ type: 'text', text: 'hi' }],
        },
      ],
    });
    await first;

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);
  });

  test('a repeated out-of-order retry attempt is deduped, not a new episode', async () => {
    createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      3,
    );
    const sessionID = 'sess-out-of-order';

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });
    const retry = (attempt: number) => ({
      type: 'session.status',
      properties: {
        sessionID,
        status: {
          type: 'retry',
          attempt,
          message: 'rate limit, retrying...',
        },
      },
    });

    await mgr.handleEvent(retry(1));
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);
    await mgr.handleEvent(retry(2));
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(2);
    // Re-sent / out-of-order attempt 1 must dedupe, not start a new episode.
    await mgr.handleEvent(retry(1));
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(2);
  });

  test('different sessions are not deduplicated against each other', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'session.error',
      properties: { sessionID: 'sess-A', error: { message: 'rate limit' } },
    });
    await mgr.handleEvent({
      type: 'session.error',
      properties: { sessionID: 'sess-B', error: { message: 'rate limit' } },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
  });

  test('cascade continues when second error arrives within dedup window after model switch', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    // Seed session: current model is first entry in orchestrator chain
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-cascade',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    // First error - model A fails, falls back to model B (openai/gpt-4o)
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-cascade',
        error: { message: 'Rate limit exceeded' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: 'openai', modelID: 'gpt-4o' },
        }),
      }),
    );

    // Second error - model B also fails within the 5s dedup window.
    // This is a DIFFERENT incident (new model), so dedup is bypassed
    // because the current model differs from lastTriggerModel.
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-cascade',
        error: { message: 'Monthly usage limit reached' },
      },
    });

    // Should trigger a second fallback despite being within the original
    // 5-second dedup window, because the model changed (modelChanged bypass).
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    expect(mocks.promptAsync.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: 'google', modelID: 'gemini-2.5-pro' },
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - subagent.session.created
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager subagent.session.created', () => {
  test('records agent name from subagent.session.created and falls back correctly', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    // Register the session as 'explorer' via subagent creation event
    await mgr.handleEvent({
      type: 'subagent.session.created',
      properties: { sessionID: 'sub-1', agentName: 'explorer' },
    });

    // Now trigger rate limit - should use explorer's chain
    await mgr.handleEvent({
      type: 'session.error',
      properties: { sessionID: 'sub-1', error: { message: 'rate limit' } },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      {
        model: { providerID: string; modelID: string };
      },
    ];
    // explorer chain: ['openai/gpt-4o-mini', 'anthropic/claude-haiku']
    // agentName known → currentModel inferred as chain[0] (primary)
    // primary is tried → fallback picks claude-haiku
    expect(call[0].body.model.providerID).toBe('anthropic');
    expect(call[0].body.model.modelID).toBe('claude-haiku');
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - session.deleted cleanup
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager session.deleted', () => {
  test('cleans up session state on session.deleted via coordinator', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
      coordinator,
    );

    // Populate all maps for this session
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-del',
          agent: 'orchestrator',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    // Cleanup via coordinator
    coordinator.dispatchSessionDeleted('sess-del');

    // After deletion, a new rate-limit on the same ID should behave as a fresh
    // session (no prior model known → uses chain from start, dedup cleared)
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-del',
        error: { message: 'rate limit exceeded' },
      },
    });

    // Should have triggered (dedup was cleared by session.deleted)
    // and should pick the first chain model (no current model seed after deletion)
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      { model: { providerID: string; modelID: string } },
    ];
    // orchestrator chain: ['anthropic/claude-opus-4-5', 'openai/gpt-4o', 'google/gemini-2.5-pro']
    // no current model → first untried = anthropic/claude-opus-4-5
    expect(call[0].body.model.providerID).toBe('anthropic');
    expect(call[0].body.model.modelID).toBe('claude-opus-4-5');
  });

  test('ignores session.deleted with no sessionID', async () => {
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );
    // Should not throw
    await expect(
      mgr.handleEvent({ type: 'session.deleted', properties: {} }),
    ).resolves.toBeUndefined();
  });

  test('cleans up state using info.id shape via coordinator', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
      coordinator,
    );

    // Seed state for the session
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-info-del',
          agent: 'orchestrator',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    // Cleanup via coordinator
    coordinator.dispatchSessionDeleted('sess-info-del');

    // State is cleared: a new rate-limit on same ID should behave as fresh session
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-info-del',
        error: { message: 'rate limit exceeded' },
      },
    });

    // Triggered (dedup was cleared by deletion)
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('does NOT clear inProgress when session.deleted fires', () => {
    const coordinator = new SessionLifecycle(() => {});
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
      coordinator,
    );

    // Simulate: fallback is in progress
    const sessionID = 'sess-inprog';
    (mgr as any).inProgress.add(sessionID);
    expect(mgr.isFallbackInProgress(sessionID)).toBe(true);

    // Session deleted fires (as it does during abort in tryFallbackWithAbort)
    coordinator.dispatchSessionDeleted(sessionID);

    // inProgress must survive — the finally block of tryFallback/WithAbort
    // manages it, not the session.deleted callback
    expect(mgr.isFallbackInProgress(sessionID)).toBe(true);
    (mgr as any).inProgress.delete(sessionID);
  });

  test('shares fallback progress across plugin manager instances', () => {
    const first = new ForegroundFallbackManager(
      createMockClient().client,
      makeChains(),
      true,
    );
    const replacement = new ForegroundFallbackManager(
      createMockClient().client,
      makeChains(),
      true,
    );
    const sessionID = 'sess-shared-in-progress';

    (first as any).inProgress.add(sessionID);
    expect(replacement.isFallbackInProgress(sessionID)).toBe(true);
    (first as any).inProgress.delete(sessionID);
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - willAttemptFallback
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager willAttemptFallback', () => {
  test('returns true when the session has a chain and it is not exhausted', () => {
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );
    mgr.registerSessionAgent('sess-1', 'orchestrator');
    expect(mgr.willAttemptFallback('sess-1')).toBe(true);
  });

  test('returns false when fallback is disabled', () => {
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      false,
      {
        directory: '/test',
      } as any,
      0,
    );
    mgr.registerSessionAgent('sess-1', 'orchestrator');
    expect(mgr.willAttemptFallback('sess-1')).toBe(false);
  });

  test('returns false for a known agent without a configured chain', () => {
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );
    // oracle has no chain in makeChains(); resolveChain must not bleed
    // into another agent's chain, so no fallback is possible.
    mgr.registerSessionAgent('sess-oracle', 'oracle');
    expect(mgr.willAttemptFallback('sess-oracle')).toBe(false);
  });

  test('returns false when the chain is exhausted (stage 2)', () => {
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );
    mgr.registerSessionAgent('sess-1', 'orchestrator');
    (mgr as any).chainExhaustion.set('sess-1', 2);
    expect(mgr.willAttemptFallback('sess-1')).toBe(false);
  });

  test('returns true while a fallback is in flight even after exhaustion', () => {
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );
    (mgr as any).inProgress.add('sess-1');
    expect(mgr.willAttemptFallback('sess-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - resolveChain correctness
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager resolveChain cross-agent isolation', () => {
  test('does not use another agent chain when known agent has no configured chain', async () => {
    // oracle has no chain in runtimeChains; without the fix resolveChain would
    // fall through to the cross-agent "last resort" and pick a model from
    // orchestrator's chain - re-prompting oracle with an orchestrator model.
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      {
        // oracle intentionally absent - no chain configured
        orchestrator: ['openai/gpt-4o', 'google/gemini-2.5-pro'],
      },
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'oracle-sess',
          agent: 'oracle', // agent IS known
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          error: { message: 'rate limit exceeded' },
        },
      },
    });

    // oracle has no chain → should not fall back at all
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('uses cross-agent last-resort only when agent name is unknown', async () => {
    // When the agent name is genuinely unknown AND current model is not in any
    // chain, the last-resort flattened chain is acceptable.
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-4o'] },
      true,
      { directory: '/test' } as any,
      0,
    );

    // No agent name tracked, no model tracked - triggers session.error
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'unknown-agent-sess',
        error: { message: 'rate limit exceeded' },
      },
    });

    // Falls through to last-resort → picks first model from any chain
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      { model: { providerID: string; modelID: string } },
    ];
    expect(call[0].body.model.providerID).toBe('openai');
    expect(call[0].body.model.modelID).toBe('gpt-4o');
  });

  test('does NOT bleed into other agent chains for non-omos agents without a chain', async () => {
    // A user-defined agent (e.g. Build) shares its model with the orchestrator
    // chain but has no chain of its own. It must NOT inherit the orchestrator
    // chain — that would switch the session from Build to Orchestrator.
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-6', 'new-api/glm-5.2'] },
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'build-sess',
          agent: 'build',
          providerID: 'openai',
          modelID: 'gpt-6',
          error: { message: 'rate limit exceeded' },
        },
      },
    });

    // build has no configured chain and must not inherit orchestrator's
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No-chain sessions (councillor / self-managed agents)
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager no-chain sessions', () => {
  test('councillor session.status retry: no abort and no re-prompt', async () => {
    // Councillor is owned by CouncilManager (own model chain + timeout).
    // FG must not abort or re-prompt — that races the council lifecycle and
    // previously produced "[foreground-fallback] no chain configured" noise.
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'councillor-sess',
          agent: 'councillor',
          providerID: 'openai',
          modelID: 'gpt-5.4',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'councillor-sess',
        status: {
          type: 'retry',
          attempt: 1,
          message: 'rate limit, retrying...',
        },
      },
    });

    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('councillor session.error: no abort and no re-prompt', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'councillor-err',
          agent: 'councillor',
          providerID: 'openai',
          modelID: 'gpt-5.4',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'councillor-err',
        error: { message: 'rate limit exceeded' },
      },
    });

    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('disableChain agent on session.status: no abort (not just no re-prompt)', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      0,
    );
    mgr.disableChain('orchestrator');

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'disabled-status',
          agent: 'orchestrator',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'disabled-status',
        status: {
          type: 'retry',
          attempt: 1,
          message: 'rate limit, retrying...',
        },
      },
    });

    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// disableChain API
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager disableChain', () => {
  test('after disableChain, rate-limit error surfaces instead of falling back', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    mgr.disableChain('orchestrator');

    // Seed session with orchestrator model and trigger rate-limit
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-disabled',
          agent: 'orchestrator',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          error: { message: 'rate limit exceeded' },
        },
      },
    });

    // Chain disabled → no fallback, error surfaces
    expect(mocks.promptAsync).not.toHaveBeenCalled();
    expect(mocks.abort).not.toHaveBeenCalled();
  });

  test('other agents chains are unaffected by disableChain', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
      } as any,
      0,
    );

    mgr.disableChain('orchestrator');

    // Explorer session — should still fall back normally
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-other',
          agent: 'explorer',
          providerID: 'openai',
          modelID: 'gpt-4o-mini',
          error: { message: 'quota exceeded' },
        },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      { model: { providerID: string; modelID: string } },
    ];
    // explorer chain: ['openai/gpt-4o-mini', 'anthropic/claude-haiku']
    // current = gpt-4o-mini is tried → next = claude-haiku
    expect(call[0].body.model.providerID).toBe('anthropic');
    expect(call[0].body.model.modelID).toBe('claude-haiku');
  });
});

// ---------------------------------------------------------------------------
// dispose (reload generation cleanup)
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager dispose', () => {
  test('dispose cancels pending initial-delay timers and empties the map', async () => {
    // `opencode reload` destroys the plugin instance while an initial
    // fallback delay may still be scheduled. The stale timer must not
    // fire through the old context after dispose.
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      0, // maxRetries — first error exhausts the budget
      undefined, // coordinator
      undefined, // onSessionModelChanged
      40, // initialRetryDelayMs
    );

    // First failover error on a fresh session schedules the initial
    // delay instead of intervening immediately.
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-dispose-delay',
        error: { message: 'Rate limit exceeded' },
      },
    });
    expect(mocks.promptAsync).not.toHaveBeenCalled();
    expect((mgr as any).pendingInitialDelay.size).toBe(1);

    mgr.dispose();

    expect((mgr as any).pendingInitialDelay.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('dispose abandons an in-flight fallback before the replay reaches the old client', async () => {
    // Reload fencing (upstream PR #1218 P1): the transcript read can
    // suspend across dispose(); the continuation must not re-prompt,
    // abort, or otherwise touch the destroyed generation's client.
    let resolveMessages!: (value: unknown) => void;
    const messagesPromise = new Promise((resolve) => {
      resolveMessages = resolve;
    });
    const promptAsync = mock(async () => ({}));
    const abort = mock(async () => ({}));
    currentMockSession = {
      messages: mock(() => messagesPromise),
      promptAsync,
      abort,
    };
    installGetClientMock();

    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      0, // maxRetries — first error exhausts the budget
      undefined, // coordinator
      undefined, // onSessionModelChanged
      0, // initialRetryDelayMs — intervene immediately
    );

    // Runs synchronously into the hanging transcript read.
    const pending = mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-stale-generation',
        error: { message: 'Rate limit exceeded' },
      },
    });

    // Reload happens while the transcript read is suspended.
    mgr.dispose();
    resolveMessages({
      data: [
        {
          info: { role: 'user', id: 'm1' },
          parts: [{ type: 'text', text: 'hello' }],
        },
      ],
    });
    await pending;

    expect(promptAsync).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    // The finally cleanup must still release the process-global
    // inProgress slot so the reloaded generation is not blocked.
    expect(mgr.isFallbackInProgress('sess-stale-generation')).toBe(false);
  });

  test('dispose during retry backoff abandons the attempt with zero further client calls', async () => {
    // Fake timers (bun:test's jest-compat layer) drive the whole backoff
    // window so no real wall-clock is awaited. The former real ~500ms
    // backoff sleep held the event loop open, and concurrently scheduled
    // test files could poll the shared getClient mock during that window,
    // polluting the call-count assertions below (the full-suite flake;
    // the test always passed in isolation).
    jest.useFakeTimers();
    try {
      const { mocks } = createMockClient();
      const mgr = new ForegroundFallbackManager(
        { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
        true,
        { directory: '/test' } as any,
        0, // maxRetries — first error exhausts the budget
        undefined, // coordinator
        undefined, // onSessionModelChanged
        0, // initialRetryDelayMs — intervene immediately
        6_500, // retryDelayMs — backoff outlives the dedup spacing below
      );

      // First fallback completes normally: one transcript read + replay.
      // (Pure microtasks — this path arms no timer.)
      await mgr.handleEvent({
        type: 'session.error',
        properties: {
          sessionID: 'sess-backoff-dispose',
          error: { message: 'Rate limit exceeded' },
        },
      });
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

      // Second trigger: beyond the 5s dedup window but inside the
      // retryDelayMs backoff, so tryFallback sleeps before
      // execFallback. Advance the faked clock (moves the mocked
      // Date.now() past the dedup window without firing any timer),
      // then run the trigger synchronously into the faked backoff sleep.
      jest.setSystemTime(Date.now() + 6_000);
      const pending = mgr.handleEvent({
        type: 'session.error',
        properties: {
          sessionID: 'sess-backoff-dispose',
          error: { message: 'Rate limit exceeded' },
        },
      });

      // Reload during the backoff sleep, then fire the faked timer:
      // the computed delay is retryDelayMs 6_500 − 6_000 elapsed =
      // 500ms; advance past it so the sleep settles synchronously.
      mgr.dispose();
      jest.advanceTimersByTime(1_000);
      await pending;

      expect(mocks.messages).toHaveBeenCalledTimes(1); // no second read
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1); // no second replay
      expect(mocks.abort).not.toHaveBeenCalled();
      expect(mgr.isFallbackInProgress('sess-backoff-dispose')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Retry budget semantics (issue #955)
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager retry budget', () => {
  const failoverError = { message: 'Rate limit exceeded' };

  function seedModelEvent(sessionID: string, modelID: string) {
    return {
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          agent: 'orchestrator',
          providerID: 'openai',
          modelID,
          role: 'assistant',
        },
      },
    };
  }

  function errorEvent(sessionID: string) {
    return {
      type: 'session.error',
      properties: { sessionID, error: failoverError },
    };
  }

  function successEvent(sessionID: string, modelID: string) {
    return {
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          agent: 'orchestrator',
          providerID: 'openai',
          modelID,
          role: 'assistant',
          time: { created: 1, completed: 2 },
        },
      },
    };
  }

  function createBudgetManager(
    maxRetries: number,
    initialRetryDelayMs = 0,
    clientOverrides?: Parameters<typeof createMockClient>[0],
  ) {
    const { mocks } = createMockClient(clientOverrides);
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c', 'openai/gpt-d'] },
      true,
      { directory: '/test' } as any,
      maxRetries,
      undefined, // coordinator
      undefined, // onSessionModelChanged
      initialRetryDelayMs,
      0, // retryDelayMs — no backoff between triggers in budget tests
    );
    return { mocks, mgr };
  }

  test('maxRetries=1 absorbs the first error and falls back on the second', async () => {
    const { mocks, mgr } = createBudgetManager(1);
    const sessionID = 'sess-budget-1';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));

    // Error 1 of maxRetries=1 → absorbed on the current model via same-model retry.
    await mgr.handleEvent(errorEvent(sessionID));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);
    const call0 = mocks.promptAsync.mock.calls[0] as [
      { body: { model: { providerID: string; modelID: string } } },
    ];
    expect(call0[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-b',
    });

    // Error 2 (maxRetries+1) → advance the chain to gpt-c.
    await mgr.handleEvent(errorEvent(sessionID));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    const call = mocks.promptAsync.mock.calls[1] as [
      { model: { providerID: string; modelID: string } },
    ];
    expect(call[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-c',
    });
  });

  test('maxRetries=0 falls back on the first retryable error', async () => {
    const { mocks, mgr } = createBudgetManager(0);
    const sessionID = 'sess-budget-0';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));

    await mgr.handleEvent(errorEvent(sessionID));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      { model: { providerID: string; modelID: string } },
    ];
    expect(call[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-c',
    });
  });

  test('session.status retry path absorbs the first retry with maxRetries=1', async () => {
    const { mocks, mgr } = createBudgetManager(1);
    const sessionID = 'sess-budget-status-retry';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));

    const statusRetry = (attempt: number) => ({
      type: 'session.status',
      properties: {
        sessionID,
        status: {
          type: 'retry',
          attempt,
          message: 'rate limit, retrying...',
        },
      },
    });

    // Retry event 1 → absorbed but NO-OP for session.status (per spec).
    await mgr.handleEvent(statusRetry(1));
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);

    // Retry event 2 exhausts the budget → advance to gpt-c via fallback path.
    await mgr.handleEvent(statusRetry(2));
    expect(mocks.abort).toHaveBeenCalledTimes(1); // fallback path DOES abort
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      { model: { providerID: string; modelID: string } },
    ];
    expect(call[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-c',
    });
  });

  test('budget accumulates across the whole chain and stays spent', async () => {
    const { mocks, mgr } = createBudgetManager(2);
    const sessionID = 'sess-budget-chain';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));

    const realNowFn = Date.now;
    let fakeNow = realNowFn();
    Date.now = () => fakeNow;
    try {
      const fail = async () => {
        fakeNow += 6_000; // keep every trigger outside the dedup window
        await mgr.handleEvent(errorEvent(sessionID));
      };

      // Errors 1 and 2 are absorbed as same-model retries (gpt-b): promptAsync called twice.
      await fail();
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
      // Both retries use the same model gpt-b.
      expect(mocks.promptAsync.mock.calls[0]?.[0].body.model).toEqual({
        providerID: 'openai',
        modelID: 'gpt-b',
      });
      expect(mocks.promptAsync.mock.calls[1]?.[0].body.model).toEqual({
        providerID: 'openai',
        modelID: 'gpt-b',
      });

      // Error 3 advances gpt-b → gpt-c.
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(3);
      const call2 = mocks.promptAsync.mock.calls[2] as [
        { model: { providerID: string; modelID: string } },
      ];
      expect(call2[0].body.model).toEqual({
        providerID: 'openai',
        modelID: 'gpt-c',
      });
      // The spent budget is NOT reset by the model switch.
      expect((mgr as any).sessionRetries.get(sessionID)).toBe(2);

      // Error 4: still exhausted, advance to gpt-d.
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(4);
      const third = mocks.promptAsync.mock.calls[3] as [
        { model: { providerID: string; modelID: string } },
      ];
      expect(third[0].body.model).toEqual({
        providerID: 'openai',
        modelID: 'gpt-d',
      });

      // Error 5: first exhaustion → sticky re-prompt on gpt-d (promptAsync 5× total).
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(5);

      // Error 6: second exhaustion → abort once, no more re-prompts.
      await fail();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(5);
      expect(mocks.abort).toHaveBeenCalledTimes(1);
    } finally {
      Date.now = realNowFn;
    }
  });

  test('a completed successful assistant response refills the budget', async () => {
    const { mocks, mgr } = createBudgetManager(1);
    const sessionID = 'sess-budget-success';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));

    // Exhaust the budget: error absorbed (same-model retry), second would trigger…
    await mgr.handleEvent(errorEvent(sessionID));
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-b',
    });

    // …but a completed successful response clears the count first.
    await mgr.handleEvent(successEvent(sessionID, 'gpt-b'));
    expect((mgr as any).sessionRetries.get(sessionID)).toBeUndefined();

    // The next failure sequence starts absorbed again (maxRetries=1).
    await mgr.handleEvent(errorEvent(sessionID));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    expect(mocks.promptAsync.mock.calls[1]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-b',
    });

    await mgr.handleEvent(errorEvent(sessionID));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(3);
    expect(mocks.promptAsync.mock.calls[2]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-c',
    });
  });

  test('initialRetryDelayMs delays the first trigger once the budget is exhausted', async () => {
    const { mocks, mgr } = createBudgetManager(1, 40);
    const sessionID = 'sess-budget-delay';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));

    // Error 1 is absorbed as same-model retry: delay must not start before exhaustion.
    await mgr.handleEvent(errorEvent(sessionID));
    expect((mgr as any).pendingInitialDelay.size).toBe(0);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-b',
    });

    // Error 2 exhausts the budget → schedules the delayed trigger.
    await mgr.handleEvent(errorEvent(sessionID));
    // Delayed trigger fires immediately after scheduling (not called yet).
    expect((mgr as any).pendingInitialDelay.size).toBe(1);

    // Errors arriving while the delayed trigger is pending must not jump
    // the queue or re-anchor the timer.
    await mgr.handleEvent(errorEvent(sessionID));
    expect((mgr as any).pendingInitialDelay.size).toBe(1);

    // The delayed trigger fires and advances the chain.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    const call = mocks.promptAsync.mock.calls[1] as [
      { model: { providerID: string; modelID: string } },
    ];
    expect(call[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-c',
    });
  });

  test('permanent usage limits skip same-model retries even with budget remaining', async () => {
    const { mocks, mgr } = createBudgetManager(3);
    const sessionID = 'sess-permanent-usage';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID,
        error: { message: 'Monthly usage limit reached. Resets tomorrow.' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-c',
    });
    expect((mgr as any).sessionRetries.get(sessionID)).toBeUndefined();
  });

  test('permanent usage limits walk the chain without sticky re-fallback', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      {
        orchestrator: ['openai/gpt-b', 'openai/gpt-c', 'openai/gpt-d'],
      },
      true,
      { directory: '/test' } as any,
      3,
      undefined,
      undefined,
      0,
      0,
    );
    const sessionID = 'sess-permanent-chain';
    const permanentError = {
      message: 'Your quota has been exhausted for this billing period.',
    };

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent({
      type: 'session.error',
      properties: { sessionID, error: permanentError },
    });
    await mgr.handleEvent({
      type: 'session.error',
      properties: { sessionID, error: permanentError },
    });
    await mgr.handleEvent({
      type: 'session.error',
      properties: { sessionID, error: permanentError },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    expect(mocks.promptAsync.mock.calls[0]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-c',
    });
    expect(mocks.promptAsync.mock.calls[1]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-d',
    });
    expect(mocks.abort).toHaveBeenCalledTimes(1);
  });

  test('a confirmed primary user turn resets descent state before the next error', async () => {
    const { mocks, mgr } = createBudgetManager(2);
    const sessionID = 'sess-primary-turn-reset';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent(errorEvent(sessionID));
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        },
      },
    });

    expect((mgr as any).sessionRetries.get(sessionID)).toBeUndefined();
    expect((mgr as any).sessionTried.get(sessionID)).toBeUndefined();

    await mgr.handleEvent(errorEvent(sessionID));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    expect(mocks.promptAsync.mock.calls[1]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-b',
    });
  });

  test('initial delayed fallback preserves the original inline error', async () => {
    const { mocks } = createMockClient();
    const showToast = mock(async () => ({}));
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      {
        directory: '/test',
        client: { tui: { showToast } },
      } as any,
      0,
      undefined,
      undefined,
      20,
      0,
    );
    const sessionID = 'sess-delayed-original-error';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID,
        error: { statusCode: 410, message: 'Gone' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-c',
    });
    expect(showToast).not.toHaveBeenCalled();
  });

  test('session.status retry with a permanent usage error aborts and switches', async () => {
    const { mocks, mgr } = createBudgetManager(3);
    const sessionID = 'sess-permanent-status';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID,
        status: {
          type: 'retry',
          attempt: 1,
          message: 'Monthly usage limit reached',
        },
      },
    });

    // Permanent: abort the retry loop, switch immediately, no budget charge.
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-c',
    });
    expect((mgr as any).sessionRetries.get(sessionID)).toBeUndefined();
  });

  test('a permanent quota error bypasses the initial retry delay', async () => {
    const { mocks, mgr } = createBudgetManager(3, 500); // delay configured, budget to spare
    const sessionID = 'sess-permanent-no-delay';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID,
        error: { message: 'Monthly usage limit reached.' },
      },
    });

    // Immediate fallback: no delayed trigger queued, no same-model retry.
    expect((mgr as any).pendingInitialDelay.size).toBe(0);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-c',
    });
  });

  test('an ordinary 429 still uses the initial retry delay', async () => {
    const { mocks, mgr } = createBudgetManager(0, 40);
    const sessionID = 'sess-429-initial-delay';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID,
        error: { statusCode: 429, message: 'Rate limit exceeded' },
      },
    });

    // Transient: the first fallback is deferred by initialRetryDelayMs.
    expect((mgr as any).pendingInitialDelay.size).toBe(1);
    expect(mocks.promptAsync).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('a confirmed new user turn cancels a pending initial delay', async () => {
    const { mocks, mgr } = createBudgetManager(1, 40);
    const sessionID = 'sess-cancel-delay';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent(errorEvent(sessionID)); // absorbed → same-model retry
    await mgr.handleEvent(errorEvent(sessionID)); // budget spent → schedules delay
    expect((mgr as any).pendingInitialDelay.size).toBe(1);

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        },
      },
    });
    expect((mgr as any).pendingInitialDelay.size).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 80));
    // The cancelled timer never fired a fallback for the old descent.
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('a delayed fallback with the original 429 still shows the toast', async () => {
    const showToast = mock(async () => ({}));
    createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test', client: { tui: { showToast } } } as any,
      0,
      undefined,
      undefined,
      20,
      0,
    );
    const sessionID = 'sess-delay-toast-429';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID,
        error: { statusCode: 429, message: 'Rate limit exceeded' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(showToast).toHaveBeenCalledTimes(1);
  });

  test("the fallback's own replay user message does not reset the descent", async () => {
    let mgr!: ForegroundFallbackManager;
    const sessionID = 'sess-replay-reset-guard';
    createMockClient({
      promptAsyncImpl: async () => {
        // The replayed prompt makes the host emit a user message while the
        // fallback is still in flight; it must not reset the budget.
        await mgr.handleEvent({
          type: 'message.updated',
          properties: {
            info: {
              sessionID,
              agent: 'orchestrator',
              role: 'user',
              model: { providerID: 'openai', modelID: 'gpt-b' },
            },
          },
        });
        return {};
      },
    });
    mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      1,
      undefined,
      undefined,
      0,
      0,
    );

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent(errorEvent(sessionID)); // absorbed → same-model retry

    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);
  });

  test('a delayed internal replay user event does not reset the retry budget', async () => {
    const sessionID = 'sess-delayed-replay';
    const replayMessageId = 'replay-msg-1';
    const baseMessages = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'hello' }],
      },
    ];
    let reads = 0;
    const { mocks } = createMockClient({
      messagesImpl: async () => {
        reads += 1;
        // First read = the replay's own tail transcript (replay message not
        // persisted yet); later reads include the persisted replay message.
        if (reads === 1) return { data: baseMessages };
        return {
          data: [
            ...baseMessages,
            {
              info: { id: replayMessageId, role: 'user' },
              parts: [
                {
                  type: 'text',
                  text: 'hello\n<!-- SLIM_INTERNAL_INITIATOR -->',
                  synthetic: true,
                  metadata: { 'oh-my-opencode-slim.internalInitiator': true },
                },
              ],
            },
          ],
        };
      },
    });
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      1,
      undefined,
      undefined,
      0,
      0,
    );

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent(errorEvent(sessionID)); // absorbed → replay registered
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);

    // The replay's own user message arrives AFTER promptAsync returned.
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id: replayMessageId,
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        },
      },
    });

    // Identified as our replay: the budget survives.
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);

    // The next failure continues the SAME budget → exhausted → fallback.
    await mgr.handleEvent(errorEvent(sessionID));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    expect(mocks.promptAsync.mock.calls[1]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-c',
    });
  });

  test('a genuinely new user message id resets the retry budget', async () => {
    const sessionID = 'sess-new-user-id';
    const base = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'hello' }],
      },
    ];
    let reads = 0;
    const { mgr } = createBudgetManager(2, 0, {
      messagesImpl: async () => {
        reads += 1;
        // The replay's tail read sees only the prior turn; the host persists
        // the new user message before its event fires.
        if (reads === 1) return { data: base };
        return {
          data: [
            ...base,
            {
              info: { id: 'fresh-user-msg', role: 'user' },
              parts: [{ type: 'text', text: 'a fresh turn' }],
            },
          ],
        };
      },
    });

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent(errorEvent(sessionID)); // absorbed → replay registered
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id: 'fresh-user-msg',
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        },
      },
    });

    expect((mgr as any).sessionRetries.get(sessionID)).toBeUndefined();
  });

  test('session deletion clears the replay identity', async () => {
    const { mgr } = createBudgetManager(1);
    const sessionID = 'sess-replay-delete';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent(errorEvent(sessionID));
    expect((mgr as any).pendingReplay.has(sessionID)).toBe(true);

    await mgr.handleEvent({
      type: 'session.deleted',
      properties: { info: { id: sessionID } },
    });

    expect((mgr as any).pendingReplay.has(sessionID)).toBe(false);
  });

  test('dispose clears the replay identity', async () => {
    const { mgr } = createBudgetManager(1);
    const sessionID = 'sess-replay-dispose';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent(errorEvent(sessionID));
    expect((mgr as any).pendingReplay.has(sessionID)).toBe(true);

    mgr.dispose();

    expect((mgr as any).pendingReplay.size).toBe(0);
  });

  test('a failed replay leaves no identity that blocks a later real turn', async () => {
    createMockClient({
      promptAsyncImpl: async () => {
        throw new Error('transport failed');
      },
      abortImpl: async () => {
        throw new Error('abort failed');
      },
    });
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      1,
      undefined,
      undefined,
      0,
      0,
    );
    const sessionID = 'sess-replay-failure';

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent(errorEvent(sessionID)); // replay fails → identity cleared
    expect((mgr as any).pendingReplay.has(sessionID)).toBe(false);

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id: 'later-user',
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        },
      },
    });
    expect((mgr as any).sessionRetries.get(sessionID)).toBeUndefined();
  });

  test('a delayed v2 replay user event does not reset the retry budget', async () => {
    const sessionID = 'sess-v2-delayed-replay';
    const replayMessageId = 'replay-msg-1';
    const v2Base = { id: 'u1', type: 'user', text: 'hello' };
    let reads = 0;
    const { mocks } = createMockClient({
      messagesImpl: async () => {
        reads += 1;
        if (reads === 1) return { data: [v2Base] };
        return {
          data: [
            v2Base,
            {
              id: replayMessageId,
              type: 'user',
              text: 'hello\n<!-- SLIM_INTERNAL_INITIATOR -->',
            },
          ],
        };
      },
    });
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      1,
      undefined,
      undefined,
      0,
      0,
    );

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent(errorEvent(sessionID)); // absorbed → replay registered
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);

    // The v2 replay message (flat id/text) arrives after promptAsync returned.
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id: replayMessageId,
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        },
      },
    });

    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);

    await mgr.handleEvent(errorEvent(sessionID));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    expect(mocks.promptAsync.mock.calls[1]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-c',
    });
  });

  test('a genuinely new v2 user message resets the retry budget', async () => {
    const sessionID = 'sess-v2-new-user';
    const v2Base = { id: 'u1', type: 'user', text: 'hello' };
    let reads = 0;
    const { mgr } = createBudgetManager(2, 0, {
      messagesImpl: async () => {
        reads += 1;
        // The replay's tail read sees only the prior turn; the host persists
        // the new user message before its event fires.
        if (reads === 1) return { data: [v2Base] };
        return {
          data: [
            v2Base,
            { id: 'v2-fresh-user', type: 'user', text: 'a fresh turn' },
          ],
        };
      },
    });

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent(errorEvent(sessionID)); // absorbed → replay registered
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id: 'v2-fresh-user',
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        },
      },
    });

    expect((mgr as any).sessionRetries.get(sessionID)).toBeUndefined();
  });

  test('the transcript baseline reads the v2 top-level id', async () => {
    const sessionID = 'sess-v2-baseline';
    const v2Base = { id: 'baseline-1', type: 'user', text: 'hello' };
    createMockClient({ messagesImpl: async () => ({ data: [v2Base] }) });
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      1,
      undefined,
      undefined,
      0,
      0,
    );

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent(errorEvent(sessionID)); // replay → baseline = 'baseline-1'

    // A re-emission of the baseline message (same id) is not a new turn: this
    // only holds if the baseline was read from the v2 top-level id.
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id: 'baseline-1',
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        },
      },
    });

    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);
  });

  test('a retained replay id suppresses repeated notifications without re-reading', async () => {
    const sessionID = 'sess-replay-retained';
    const replayMessageId = 'replay-msg-1';
    const baseMessages = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'hello' }],
      },
    ];
    let reads = 0;
    createMockClient({
      messagesImpl: async () => {
        reads += 1;
        if (reads === 1) return { data: baseMessages };
        return {
          data: [
            ...baseMessages,
            {
              info: { id: replayMessageId, role: 'user' },
              parts: [
                {
                  type: 'text',
                  text: 'hello\n<!-- SLIM_INTERNAL_INITIATOR -->',
                  synthetic: true,
                  metadata: { 'oh-my-opencode-slim.internalInitiator': true },
                },
              ],
            },
          ],
        };
      },
    });
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      1,
      undefined,
      undefined,
      0,
      0,
    );

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent(errorEvent(sessionID)); // absorbed → replay (read #1)
    const afterReplay = reads;

    const notify = () =>
      mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID,
            id: replayMessageId,
            agent: 'orchestrator',
            role: 'user',
            model: { providerID: 'openai', modelID: 'gpt-b' },
          },
        },
      });

    await notify(); // confirmed via transcript read (#2)
    const afterConfirm = reads;
    expect(
      (mgr as any).replayMessageIds.get(sessionID)?.has(replayMessageId),
    ).toBe(true);
    expect(afterConfirm).toBeGreaterThan(afterReplay);

    await notify(); // retained id → no further transcript read
    expect(reads).toBe(afterConfirm);
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);
  });

  test('an async old-message lookup does not erase a newer pending replay', async () => {
    const sessionID = 'sess-replay-race';
    let resolveRead!: (value: unknown) => void;
    const read = new Promise((resolve) => {
      resolveRead = resolve;
    });
    createMockClient({ messagesImpl: () => read });
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      1,
      undefined,
      undefined,
      0,
      0,
    );

    const oldRecord = {
      targetModel: 'openai/gpt-b',
      baselineMessageID: 'u0',
      startedAt: Date.now(),
      admitted: true,
    };
    (mgr as any).pendingReplay.set(sessionID, oldRecord);

    const pending = mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id: 'old-replay-msg',
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        },
      },
    });

    // A newer replay registers while the old transcript read is in flight.
    const newerRecord = {
      targetModel: 'openai/gpt-c',
      baselineMessageID: 'u1',
      startedAt: Date.now(),
      admitted: true,
    };
    (mgr as any).pendingReplay.set(sessionID, newerRecord);

    resolveRead({
      data: [
        {
          info: { id: 'old-replay-msg', role: 'user' },
          parts: [
            {
              type: 'text',
              text: 'x\n<!-- SLIM_INTERNAL_INITIATOR -->',
              synthetic: true,
              metadata: { 'oh-my-opencode-slim.internalInitiator': true },
            },
          ],
        },
      ],
    });
    await pending;

    // The old lookup confirmed and retained its id without deleting the
    // newer pending record.
    expect((mgr as any).pendingReplay.get(sessionID)).toBe(newerRecord);
    expect(
      (mgr as any).replayMessageIds.get(sessionID)?.has('old-replay-msg'),
    ).toBe(true);
  });

  test('session deletion and disposal clear retained replay ids and the v2 terminal', async () => {
    createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b'] },
      true,
      { directory: '/test' } as any,
      1,
    );
    const sessionID = 'sess-retained-clear';
    (mgr as any).replayMessageIds.set(sessionID, new Set(['m1']));
    (mgr as any).v2RetryTerminal.add(sessionID);

    await mgr.handleEvent({
      type: 'session.deleted',
      properties: { info: { id: sessionID } },
    });
    expect((mgr as any).replayMessageIds.has(sessionID)).toBe(false);
    expect((mgr as any).v2RetryTerminal.has(sessionID)).toBe(false);

    (mgr as any).replayMessageIds.set(sessionID, new Set(['m2']));
    (mgr as any).v2RetryTerminal.add(sessionID);
    mgr.dispose();
    expect((mgr as any).replayMessageIds.size).toBe(0);
    expect((mgr as any).v2RetryTerminal.size).toBe(0);
  });

  test('a late confirmed replay notification does not overwrite the active model', async () => {
    createMockClient();
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      1,
    );
    const sessionID = 'sess-late-replay-model';
    (mgr as any).sessionModel.set(sessionID, 'openai/gpt-c');
    (mgr as any).sessionRetries.set(sessionID, 1);
    (mgr as any).replayMessageIds.set(sessionID, new Set(['replay-1']));

    const notify = () =>
      mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID,
            id: 'replay-1',
            agent: 'orchestrator',
            role: 'user',
            // The replay's older model (A); the session has since moved to B.
            model: { providerID: 'openai', modelID: 'gpt-b' },
          },
        },
      });

    await notify();
    await notify(); // duplicate notification

    expect((mgr as any).sessionModel.get(sessionID)).toBe('openai/gpt-c');
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);
  });

  test('a real turn during an in-flight same-model retry resets the budget', async () => {
    const sessionID = 'sess-concurrent-absorb';
    let resolvePrompt!: (value: unknown) => void;
    const promptGate = new Promise((resolve) => {
      resolvePrompt = resolve;
    });
    let reads = 0;
    createMockClient({
      messagesImpl: async () => {
        reads += 1;
        const base = [
          {
            info: { id: 'u1', role: 'user' },
            parts: [{ type: 'text', text: 'hello' }],
          },
        ];
        // The replay's own read does not yet see the concurrent user turn.
        if (reads === 1) return { data: base };
        return {
          data: [
            ...base,
            {
              info: { id: 'user-turn-2', role: 'user' },
              parts: [{ type: 'text', text: 'second' }],
            },
          ],
        };
      },
      promptAsyncImpl: () => promptGate,
    });
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      1,
    );

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    const retry = mgr.handleEvent(errorEvent(sessionID)); // absorbed → same-model retry
    expect(mgr.isFallbackInProgress(sessionID)).toBe(true);
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);

    // A genuine external user turn arrives while the replay is in flight and
    // must get its own fresh fallback state.
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id: 'user-turn-2',
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        },
      },
    });
    expect((mgr as any).sessionRetries.has(sessionID)).toBe(false);
    expect((mgr as any).sessionTried.has(sessionID)).toBe(false);

    resolvePrompt({});
    await retry;
  });

  test('an in-flight fallback cannot claim a switch after a newer turn', async () => {
    const sessionID = 'sess-concurrent-switch';
    let resolvePrompt!: (value: unknown) => void;
    const promptGate = new Promise((resolve) => {
      resolvePrompt = resolve;
    });
    let reads = 0;
    const onChanged = mock(() => {});
    createMockClient({
      messagesImpl: async () => {
        reads += 1;
        const base = [
          {
            info: { id: 'u1', role: 'user' },
            parts: [{ type: 'text', text: 'hello' }],
          },
        ];
        if (reads === 1) return { data: base };
        return {
          data: [
            ...base,
            {
              info: { id: 'user-turn-2', role: 'user' },
              parts: [{ type: 'text', text: 'second' }],
            },
          ],
        };
      },
      promptAsyncImpl: () => promptGate,
    });
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c'] },
      true,
      { directory: '/test' } as any,
      0,
      undefined,
      onChanged,
      0,
      0,
    );

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    const fallback = mgr.handleEvent(errorEvent(sessionID)); // fallback → replay (hangs)
    expect(mgr.isFallbackInProgress(sessionID)).toBe(true);

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id: 'user-turn-2',
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        },
      },
    });

    resolvePrompt({});
    await fallback;

    // The superseded replay must not claim the switch for the new turn.
    expect((mgr as any).sessionModel.get(sessionID)).toBe('openai/gpt-b');
    expect(onChanged).not.toHaveBeenCalled();
  });

  test('the replay epoch is captured before the transcript read', async () => {
    const sessionID = 'sess-replay-epoch-before-read';
    let releaseTail!: (value: unknown) => void;
    const tailGate = new Promise((resolve) => {
      releaseTail = resolve;
    });
    let reads = 0;
    const onChanged = mock(() => {});
    const { mocks } = createMockClient({
      messagesImpl: async () => {
        reads += 1;
        // Call #1 = the suspended fallback replay tail read. Later calls = the
        // new turn's identity probe, which sees the persisted new turn.
        if (reads === 1) return tailGate;
        return {
          data: [
            {
              info: { id: 'new-user-turn', role: 'user' },
              parts: [{ type: 'text', text: 'a genuinely new turn' }],
            },
          ],
        };
      },
    });
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c', 'openai/gpt-d'] },
      true,
      { directory: '/test' } as any,
      1,
      undefined,
      onChanged,
      0,
      0,
    );

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));

    // Suspend a fallback replay (switch claim) on its transcript read.
    const staleReplay = (mgr as any).replayFallbackPrompt(
      sessionID,
      'openai/gpt-c',
      'openai/gpt-b',
      true,
      undefined,
    );

    // A genuine new user turn arrives while the read is suspended: it is
    // persisted and the session model moves to gpt-d.
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id: 'new-user-turn',
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-d' },
        },
      },
    });
    expect((mgr as any).sessionModel.get(sessionID)).toBe('openai/gpt-d');
    expect((mgr as any).sessionRetries.get(sessionID)).toBeUndefined();

    // The transcript read now resolves with the OLD transcript.
    releaseTail({
      data: [
        {
          info: { id: 'u1', role: 'user' },
          parts: [{ type: 'text', text: 'old turn' }],
        },
      ],
    });
    await staleReplay;

    // The stale replay must not send, claim the switch, or migrate state.
    expect(mocks.promptAsync).not.toHaveBeenCalled();
    expect((mgr as any).sessionModel.get(sessionID)).toBe('openai/gpt-d');
    expect(onChanged).not.toHaveBeenCalled();

    // The next failure still uses the new turn's model on a fresh budget.
    await mgr.handleEvent(errorEvent(sessionID));
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-d',
    });
  });

  test('a late replay notification stays internal after a new turn supersedes it', async () => {
    const sessionID = 'sess-late-replay-after-new-turn';
    const replayMessageId = 'late-replay-msg';
    const base = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'hello' }],
      },
    ];
    const persistedNewTurn = {
      info: { id: 'new-user-turn', role: 'user' },
      parts: [{ type: 'text', text: 'a genuinely new turn' }],
    };
    let reads = 0;
    const { mgr } = createBudgetManager(1, 0, {
      messagesImpl: async () => {
        reads += 1;
        // #1 = the replay's tail read: only the prior turn.
        if (reads === 1) return { data: base };
        // #2 = new-turn probe: the new turn is persisted (external).
        // #3 = late replay probe: the replay's own message is NOT persisted
        //      yet (unknown), so only the retained record can recognise it.
        return { data: [...base, persistedNewTurn] };
      },
    });

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    await mgr.handleEvent(errorEvent(sessionID)); // absorbed → replay completes
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);
    expect((mgr as any).pendingReplay.has(sessionID)).toBe(true);

    // A genuine new turn arrives after the replay's prompt returned.
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id: 'new-user-turn',
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-d' },
        },
      },
    });
    expect((mgr as any).sessionModel.get(sessionID)).toBe('openai/gpt-d');
    expect((mgr as any).sessionRetries.get(sessionID)).toBeUndefined();
    const epochAfterNewTurn = (mgr as any).turnEpoch.get(sessionID);
    // The unconfirmed record survives the new turn so the late replay can
    // still be recognised.
    expect((mgr as any).pendingReplay.has(sessionID)).toBe(true);

    // The replay's own user message notification arrives late, for the first
    // time, and is not persisted yet (unknown identity).
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id: replayMessageId,
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        },
      },
    });

    // Recognised as internal: model, budget and epoch all survive.
    expect((mgr as any).sessionModel.get(sessionID)).toBe('openai/gpt-d');
    expect((mgr as any).sessionRetries.get(sessionID)).toBeUndefined();
    expect((mgr as any).turnEpoch.get(sessionID)).toBe(epochAfterNewTurn);

    // The next failure uses the new turn's model on a fresh budget.
    await mgr.handleEvent(errorEvent(sessionID));
    expect((mgr as any).sessionModel.get(sessionID)).toBe('openai/gpt-d');
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);
  });

  test('a fallback suspended on the abort is superseded by a newer turn', async () => {
    const sessionID = 'sess-abort-superseded';
    let releaseAbort!: (value: unknown) => void;
    const abortGate = new Promise((resolve) => {
      releaseAbort = resolve;
    });
    let reads = 0;
    const onChanged = mock(() => {});
    const { mocks } = createMockClient({
      abortImpl: () => abortGate,
      messagesImpl: async () => {
        reads += 1;
        const base = [
          {
            info: { id: 'u1', role: 'user' },
            parts: [{ type: 'text', text: 'hello' }],
          },
        ];
        // #1 = the first absorb's replay tail. #2 = the new-turn probe; #3 =
        // the next failure's replay tail. Both see the persisted new turn.
        if (reads === 1) return { data: base };
        return {
          data: [
            ...base,
            {
              info: { id: 'new-user-turn', role: 'user' },
              parts: [{ type: 'text', text: 'new turn' }],
            },
          ],
        };
      },
    });
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['openai/gpt-b', 'openai/gpt-c', 'openai/gpt-d'] },
      true,
      { directory: '/test' } as any,
      1,
      undefined,
      onChanged,
      0,
      0,
    );

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));
    // Error #1 absorbed on gpt-b → same-model replay (promptAsync call #1).
    await mgr.handleEvent(errorEvent(sessionID));
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    // Budget spent → the session.status retry path aborts, then falls back.
    const fallback = mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID,
        status: {
          type: 'retry',
          attempt: 1,
          message: 'rate limit, retrying...',
        },
      },
    });
    // Let the promotion await settle so the abort is actually issued; it then
    // suspends on the deferred abortImpl.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.abort).toHaveBeenCalledTimes(1);

    // A genuine new user turn arrives while the abort is suspended.
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id: 'new-user-turn',
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-d' },
        },
      },
    });
    expect((mgr as any).sessionModel.get(sessionID)).toBe('openai/gpt-d');
    expect((mgr as any).sessionRetries.get(sessionID)).toBeUndefined();

    // Release the abort: the stale fallback must not switch to gpt-c or replay.
    releaseAbort({});
    await fallback;

    expect((mgr as any).sessionModel.get(sessionID)).toBe('openai/gpt-d');
    expect(onChanged).not.toHaveBeenCalled();
    // Only the pre-abort absorb's replay reached promptAsync.
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    // The next failure uses the new turn's model on a fresh budget.
    await mgr.handleEvent(errorEvent(sessionID));
    expect((mgr as any).sessionModel.get(sessionID)).toBe('openai/gpt-d');
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    expect(mocks.promptAsync.mock.calls[1]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-d',
    });
  });

  test('out-of-order user-turn probes cannot roll back a newer turn', async () => {
    const sessionID = 'sess-out-of-order-turns';
    let releaseA!: (value: unknown) => void;
    const gateA = new Promise((resolve) => {
      releaseA = resolve;
    });
    let reads = 0;
    const { mocks, mgr } = createBudgetManager(2, 0, {
      messagesImpl: async () => {
        reads += 1;
        // A's identity probe hangs; C's probe (and later replay tails) see C
        // persisted and external.
        if (reads === 1) return gateA;
        return {
          data: [
            {
              info: { id: 'msg-C', role: 'user' },
              parts: [{ type: 'text', text: 'C' }],
            },
          ],
        };
      },
    });

    await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));

    // A arrives first but its probe hangs; C arrives second and resolves first.
    const eventA = mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id: 'msg-A',
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-c' },
        },
      },
    });
    const eventC = mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          id: 'msg-C',
          agent: 'orchestrator',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-d' },
        },
      },
    });
    await eventC;

    expect((mgr as any).sessionModel.get(sessionID)).toBe('openai/gpt-d');
    expect((mgr as any).sessionRetries.get(sessionID)).toBeUndefined();

    // C's turn then consumes one retry.
    await mgr.handleEvent(errorEvent(sessionID));
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-d',
    });

    // A's old probe finally resolves, still classified external.
    releaseA({
      data: [
        {
          info: { id: 'msg-A', role: 'user' },
          parts: [{ type: 'text', text: 'A' }],
        },
      ],
    });
    await eventA;

    // No rollback: A must not switch the model or clear C's already-spent
    // budget.
    expect((mgr as any).sessionModel.get(sessionID)).toBe('openai/gpt-d');
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);

    // The next failure uses C's model and continues C's budget.
    await mgr.handleEvent(errorEvent(sessionID));
    expect((mgr as any).sessionModel.get(sessionID)).toBe('openai/gpt-d');
    expect((mgr as any).sessionRetries.get(sessionID)).toBe(2);
    expect(mocks.promptAsync.mock.calls[1]?.[0].body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-d',
    });
  });

  test('a superseded fallback does not record lastFallbackTime or delay the next turn', async () => {
    jest.useFakeTimers();
    try {
      const sessionID = 'sess-superseded-last-fallback';
      const base = [
        {
          info: { id: 'u1', role: 'user' },
          parts: [{ type: 'text', text: 'hello' }],
        },
      ];
      const persistedNewTurn = {
        info: { id: 'new-user-turn', role: 'user' },
        parts: [{ type: 'text', text: 'a genuinely new turn' }],
      };
      let reads = 0;
      let releaseTail!: (value: unknown) => void;
      const tailGate = new Promise((resolve) => {
        releaseTail = resolve;
      });
      const { mocks } = createMockClient({
        messagesImpl: async () => {
          reads += 1;
          // #1 = the first fallback's transcript read (suspended). Later reads
          // (the new turn's probe and the next fallback's tail) see the new turn.
          if (reads === 1) return tailGate;
          return { data: [...base, persistedNewTurn] };
        },
      });
      const mgr = new ForegroundFallbackManager(
        {
          orchestrator: [
            'openai/gpt-b',
            'openai/gpt-c',
            'openai/gpt-d',
            'openai/gpt-e',
          ],
        },
        true,
        { directory: '/test' } as any,
        0, // maxRetries=0 → the first error falls back
        undefined,
        undefined,
        0, // initialRetryDelayMs
        1000, // retryDelayMs — a superseded attempt must not record this backoff
      );

      await mgr.handleEvent(seedModelEvent(sessionID, 'gpt-b'));

      // Start a fallback; its transcript read hangs inside execFallback.
      const fallback = mgr.handleEvent(errorEvent(sessionID));

      // A genuine new user turn moves the session to gpt-d (bumping the epoch)
      // while execFallback is suspended.
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID,
            id: 'new-user-turn',
            agent: 'orchestrator',
            role: 'user',
            model: { providerID: 'openai', modelID: 'gpt-d' },
          },
        },
      });
      expect((mgr as any).sessionModel.get(sessionID)).toBe('openai/gpt-d');

      // Release the read: the superseded attempt aborts without sending.
      releaseTail({ data: base });
      await fallback;

      expect(mocks.promptAsync).not.toHaveBeenCalled();
      // The cancelled attempt must not have recorded the backoff anchor.
      expect((mgr as any).lastFallbackTime.has(sessionID)).toBe(false);

      // The new turn's next fallback must not inherit the 1000ms backoff: it
      // reaches promptAsync without any timer advance.
      const next = mgr.handleEvent(errorEvent(sessionID));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
      expect(mocks.promptAsync.mock.calls[0]?.[0].body.model).toEqual({
        providerID: 'openai',
        modelID: 'gpt-e',
      });
      await next;
    } finally {
      jest.useRealTimers();
    }
  });

  // ===========================================================================
  // Terminal absorb tests (new semantics)
  // ===========================================================================

  describe('Terminal absorb semantics', () => {
    test('message.updated error with maxRetries=1 absorbs and replays same model', async () => {
      const { mocks, mgr } = createBudgetManager(1);
      const sessionID = 'sess-msg-absorb';

      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID,
            agent: 'orchestrator',
            providerID: 'openai',
            modelID: 'gpt-b',
            error: { message: 'Rate limit exceeded' },
          },
        },
      });

      // First error absorbed: replay on same model gpt-b via promptAsync.
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
      expect(mocks.abort).not.toHaveBeenCalled();
      expect(mocks.promptAsync.mock.calls[0]?.[0].body.model).toEqual({
        providerID: 'openai',
        modelID: 'gpt-b',
      });
      expect((mgr as any).sessionRetries.get(sessionID)).toBe(1);

      // Second error exhausts budget → next chain model gpt-c.
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID,
            agent: 'orchestrator',
            providerID: 'openai',
            modelID: 'gpt-b',
            error: { message: 'Rate limit exceeded' },
          },
        },
      });
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
      expect(mocks.promptAsync.mock.calls[1]?.[0].body.model).toEqual({
        providerID: 'openai',
        modelID: 'gpt-c',
      });
    });

    test('same-model retry does NOT call onSessionModelChanged or showFallbackToast', async () => {
      const showToast = mock(async () => ({}));
      const { mocks } = createMockClient();
      const onModelChanged = mock();
      const mgr = new ForegroundFallbackManager(
        makeChains(),
        true,
        {
          directory: '/test',
          client: { tui: { showToast } },
        } as any,
        1,
        undefined,
        onModelChanged,
      );

      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'sess-no-switch',
            providerID: 'openai',
            modelID: 'gpt-b',
            role: 'assistant',
          },
        },
      });

      await mgr.handleEvent({
        type: 'session.error',
        properties: {
          sessionID: 'sess-no-switch',
          error: { message: 'Rate limit exceeded' },
        },
      });

      // Same-model retry should NOT change sessionModel or call toast.
      expect(onModelChanged).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
      // Replay is on the same model gpt-b.
      expect(mocks.promptAsync.mock.calls[0]?.[0].body.model).toEqual({
        providerID: 'openai',
        modelID: 'gpt-b',
      });
    });

    test('same-model retry where promptAsync rejects handles boundedly without re-consumption', async () => {
      createMockClient({
        promptAsyncImpl: async () => {
          throw new Error('generic prompt failure');
        },
      });
      const sessionID = 'sess-retry-bound';
      const manager = new ForegroundFallbackManager(
        makeChains({ orchestrator: ['openai/gpt-b', 'openai/gpt-c'] }),
        true,
        { directory: '/test' } as any,
        1, // maxRetries=1
      );

      await manager.handleEvent({
        type: 'message.updated',
        properties: {
          info: { sessionID, providerID: 'openai', modelID: 'gpt-b' },
        },
      });

      // Terminal absorb: promptAsync throws generic error, handleEvent returns cleanly.
      const result = await manager.handleEvent(errorEvent(sessionID));

      expect(result).toBeUndefined(); // resolves successfully
      expect(manager.isFallbackInProgress(sessionID)).toBe(false);
      // Budget consumed once (absorbed), not re-consumed.
      expect((manager as any).sessionRetries.get(sessionID)).toBe(1);
    });

    test('no-chain disabled session: terminal absorb does NOT call promptAsync', async () => {
      const { mocks } = createMockClient();
      const mgr = new ForegroundFallbackManager(
        {}, // No chains configured
        true,
        { directory: '/test' } as any,
        1,
      );

      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'sess-no-chain',
            providerID: 'openai',
            modelID: 'gpt-b',
          },
        },
      });

      // No chain → no intervention for terminal absorb.
      await mgr.handleEvent({
        type: 'session.error',
        properties: {
          sessionID: 'sess-no-chain',
          error: { message: 'Rate limit exceeded' },
        },
      });

      expect(mocks.promptAsync).not.toHaveBeenCalled();
    });
  });
});
