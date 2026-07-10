import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { SessionLifecycle } from '../session-lifecycle';
import {
  ForegroundFallbackManager,
  isFailoverError,
  isRateLimitError,
} from './index';

type ForegroundFallbackClient = ConstructorParameters<
  typeof ForegroundFallbackManager
>[0];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(overrides?: {
  promptAsyncImpl?: (args: unknown) => Promise<unknown>;
  abortImpl?: () => Promise<unknown>;
  includePromptAsync?: boolean;
  messagesData?: unknown[];
}) {
  const promptAsync = mock(async (args: unknown) => {
    if (overrides?.promptAsyncImpl) return overrides.promptAsyncImpl(args);
    return {};
  });
  const abort = mock(async () => {
    if (overrides?.abortImpl) return overrides.abortImpl();
    return {};
  });
  const messages = mock(async () => ({
    data: overrides?.messagesData ?? [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
    ],
  }));
  const session: Record<string, unknown> = {
    abort,
    messages,
  };
  if (overrides?.includePromptAsync !== false) {
    session.promptAsync = promptAsync;
  }

  return {
    client: {
      session,
    } as unknown as ForegroundFallbackClient,
    mocks: { promptAsync, abort, messages },
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

// ---------------------------------------------------------------------------
// isRateLimitError
// ---------------------------------------------------------------------------

describe('isRateLimitError', () => {
  test('exports isFailoverError as the preferred classifier name', () => {
    expect(typeof isFailoverError).toBe('function');
  });

  test('returns true for 429 status code', () => {
    expect(isRateLimitError({ data: { statusCode: 429 } })).toBe(true);
  });

  test('returns true for "rate limit" in message', () => {
    expect(isRateLimitError({ message: 'Rate limit exceeded' })).toBe(true);
  });

  test('returns true for "quota exceeded" in responseBody', () => {
    expect(isRateLimitError({ data: { responseBody: 'quota exceeded' } })).toBe(
      true,
    );
  });

  test('returns true for "usage exceeded"', () => {
    expect(isRateLimitError({ message: 'usage exceeded' })).toBe(true);
  });

  test('returns true for "overloaded"', () => {
    expect(isRateLimitError({ message: 'overloaded_error' })).toBe(true);
  });

  test('returns true for "Insufficient balance."', () => {
    expect(isRateLimitError({ message: 'Insufficient balance.' })).toBe(true);
  });

  test('returns true for "Service Unavailable"', () => {
    expect(isRateLimitError({ message: 'Service Unavailable' })).toBe(true);
  });

  test('alias remains behaviorally compatible with isFailoverError', () => {
    const controls = [
      { data: { statusCode: 429 } },
      { message: 'Rate limit exceeded' },
      { message: 'internal server error' },
      { data: { statusCode: 400, message: 'application invalid request' } },
      { message: 'retried provider 503 times' },
      null,
      'string error',
    ];

    for (const error of controls) {
      expect(isRateLimitError(error)).toBe(isFailoverError(error));
    }
  });

  test('classifies textual provider outage errors as failover errors', () => {
    for (const message of [
      'internal server error',
      'bad gateway',
      'gateway timeout',
    ]) {
      expect(isFailoverError({ message })).toBe(true);
    }
  });

  test('returns true for structured outage status codes', () => {
    for (const statusCode of [500, 502, 503, 504]) {
      expect(isRateLimitError({ data: { statusCode } })).toBe(true);
    }
  });

  test('does not match outage status codes from arbitrary free text only', () => {
    expect(isRateLimitError({ message: 'retried provider 503 times' })).toBe(
      false,
    );
    expect(isFailoverError({ message: 'retried provider 503 times' })).toBe(
      false,
    );
  });

  test('returns true for transport-level provider errors', () => {
    for (const error of [
      { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1' },
      { code: 'ECONNRESET', message: 'socket hang up' },
      { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.provider.test' },
      { message: 'fetch failed' },
      { message: 'provider request timeout' },
    ]) {
      expect(isRateLimitError(error)).toBe(true);
    }
  });

  test('classifies nested transport cause codes as failover errors', () => {
    expect(
      isFailoverError({
        message: 'wrapped provider failure',
        cause: { code: 'ECONNREFUSED' },
      }),
    ).toBe(true);
  });

  test('returns false for HTTP 400 application invalid request', () => {
    expect(
      isRateLimitError({
        data: {
          statusCode: 400,
          message: 'application invalid request: missing required field',
        },
      }),
    ).toBe(false);
    expect(
      isFailoverError({
        data: {
          statusCode: 400,
          message: 'application invalid request: missing required field',
        },
      }),
    ).toBe(false);
  });

  test('returns true for "Monthly usage limit reached"', () => {
    expect(
      isRateLimitError({
        message: 'Monthly usage limit reached. Resets in X days.',
      }),
    ).toBe(true);
  });

  test('returns true for "5-hour usage limit reached"', () => {
    expect(
      isRateLimitError({
        message: '5-hour usage limit reached. Resets in 36min.',
      }),
    ).toBe(true);
  });

  test('returns true for "Weekly usage limit reached"', () => {
    expect(
      isRateLimitError({
        message: 'Weekly usage limit reached. Resets in 2 days.',
      }),
    ).toBe(true);
  });

  test('returns false for non-rate-limit error', () => {
    expect(isRateLimitError({ message: 'invalid API key' })).toBe(false);
  });

  test('returns false for null', () => {
    expect(isRateLimitError(null)).toBe(false);
  });

  test('returns false for non-object', () => {
    expect(isRateLimitError('string error')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - disabled
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager (disabled)', () => {
  test('does nothing when enabled=false', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), false);

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
  let client: ReturnType<typeof createMockClient>['client'];
  let mocks: ReturnType<typeof createMockClient>['mocks'];
  let mgr: ForegroundFallbackManager;

  beforeEach(() => {
    ({ client, mocks } = createMockClient());
    mgr = new ForegroundFallbackManager(client, makeChains(), true);
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
        path: { id: string };
        body: { model: { providerID: string; modelID: string } };
      },
    ];
    expect(call[0].path.id).toBe('sess-1');
    // Should have picked the next model after anthropic/claude-opus-4-5
    expect(call[0].body.model.providerID).toBe('openai');
    expect(call[0].body.model.modelID).toBe('gpt-4o');
  });

  test('extracts session ID from properties.info.id on session.error', async () => {
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-info-error',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        info: { id: 'sess-info-error' },
        error: { message: 'Rate limit exceeded' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      {
        path: { id: string };
        body: { model: { providerID: string; modelID: string } };
      },
    ];
    expect(call[0].path.id).toBe('sess-info-error');
    expect(call[0].body.model.providerID).toBe('openai');
    expect(call[0].body.model.modelID).toBe('gpt-4o');
  });

  test('skips malformed messages without info when locating the last user message', async () => {
    // OpenCode may return partial/streaming messages whose `info` is undefined;
    // the fallback must ignore those rather than crash, and still re-submit the
    // real last user message.
    ({ client, mocks } = createMockClient({
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
    mgr = new ForegroundFallbackManager(client, makeChains(), true);

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
      { body: { parts: Array<{ text?: string }> } },
    ];
    expect(call[0].body.parts[0]?.text).toBe('real prompt');
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
    const emptyMgr = new ForegroundFallbackManager(client, {}, true);
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
    const { client, mocks } = createMockClient({ includePromptAsync: false });
    const mgr = new ForegroundFallbackManager(client, makeChains(), true);

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
    const { client, mocks } = createMockClient({
      promptAsyncImpl: async () => {
        throw new Error('session busy');
      },
      abortImpl: async () => {
        // abort succeeds on first call
      },
    });
    const mgr = new ForegroundFallbackManager(client, makeChains(), true);

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
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - message.updated
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager message.updated', () => {
  test('tracks model from message.updated and falls back on error', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true);

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
        body: { model: { providerID: string; modelID: string } };
      },
    ];
    expect(call[0].body.model.providerID).toBe('openai');
    expect(call[0].body.model.modelID).toBe('gpt-4o');
  });

  test('uses agent name from message.updated to select correct chain', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true);

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
        body: { model: { providerID: string; modelID: string } };
      },
    ];
    // explorer chain: ['openai/gpt-4o-mini', 'anthropic/claude-haiku']
    // current=gpt-4o-mini is tried → next = claude-haiku
    expect(call[0].body.model.providerID).toBe('anthropic');
    expect(call[0].body.model.modelID).toBe('claude-haiku');
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - session.status retry
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager session.status', () => {
  test('aborts active retry-budget-exhausted session before fallback re-prompt', async () => {
    const calls: string[] = [];
    const { client, mocks } = createMockClient({
      abortImpl: async () => {
        calls.push('abort');
      },
      promptAsyncImpl: async () => {
        calls.push('promptAsync');
        return {};
      },
    });
    const mgr = new ForegroundFallbackManager(client, makeChains(), true, 3);

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

    for (const attempt of [1, 2, 3]) {
      await mgr.handleEvent({
        type: 'session.status',
        properties: {
          sessionID: 'sess-retry-abort-before-prompt',
          status: {
            type: 'retry',
            attempt,
            message: 'rate limit, retrying...',
          },
        },
      });
    }

    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['abort', 'promptAsync']);
  });

  test('keeps registered child agent identity sticky for retry fallback chain', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      makeChains({
        oracle: ['anthropic/claude-sonnet-4-5', 'openai/o3'],
      }),
      true,
      1,
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
      { body: { model: { providerID: string; modelID: string } } },
    ];
    expect(call[0].body.model).toEqual({ providerID: 'openai', modelID: 'o3' });
  });

  test('includes the sticky child agent in fallback promptAsync body', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      makeChains({
        oracle: ['anthropic/claude-sonnet-4-5', 'openai/o3'],
      }),
      true,
      1,
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
      { body: { agent?: string; model: { providerID: string; modelID: string } } },
    ];
    expect(call[0].body.agent).toBe('oracle');
    expect(call[0].body.model).toEqual({ providerID: 'openai', modelID: 'o3' });
  });

  test('triggers fallback on retry status with rate limit message', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true, 1);

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

  test('extracts session ID from properties.info.id on session.status', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true, 1);

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-info-status',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        info: { id: 'sess-info-status' },
        status: { type: 'retry', message: 'usage limit reached, retrying...' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      { path: { id: string } },
    ];
    expect(call[0].path.id).toBe('sess-info-status');
  });

  test('triggers fallback on retry status with insufficient balance message', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true, 1);

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
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true);

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-4',
        status: { type: 'retry', message: 'connection timeout, retrying...' },
      },
    });

    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('tracks retries and only intervenes after maxRetries', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true, 3);

    // Pre-seed model
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

    // First two retries should be absorbed (maxRetries - 1 = 2)
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-retry',
        status: {
          type: 'retry',
          attempt: 1,
          message: 'rate limit, retrying...',
        },
      },
    });
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-retry',
        status: {
          type: 'retry',
          attempt: 2,
          message: 'rate limit, retrying...',
        },
      },
    });
    expect(mocks.promptAsync).not.toHaveBeenCalled();

    // Third retry exhausts the budget → tryFallback intervenes
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-retry',
        status: {
          type: 'retry',
          attempt: 3,
          message: 'rate limit, retrying...',
        },
      },
    });
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('retry status with absent or unrecognized message still counts and triggers at maxRetries', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true, 3);

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-retry-any-message',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-retry-any-message',
        status: { type: 'retry' },
      },
    });
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-retry-any-message',
        status: { type: 'retry', message: 'provider is trying again' },
      },
    });
    expect(mocks.promptAsync).not.toHaveBeenCalled();

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-retry-any-message',
        status: { type: 'retry' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('busy statuses between retries do not reset the retry budget', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true, 3);

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-retry-busy-retry',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    for (const status of [
      { type: 'retry' },
      { type: 'busy' },
      { type: 'retry' },
      { type: 'busy' },
    ]) {
      await mgr.handleEvent({
        type: 'session.status',
        properties: {
          sessionID: 'sess-retry-busy-retry',
          status,
        },
      });
    }
    expect(mocks.promptAsync).not.toHaveBeenCalled();

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-retry-busy-retry',
        status: { type: 'retry' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('debounces outage retry statuses before fallback', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true, 3);

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-outage-retry',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-outage-retry',
        status: {
          type: 'retry',
          attempt: 1,
          message: 'service unavailable, retrying...',
        },
      },
    });
    expect(mocks.promptAsync).not.toHaveBeenCalled();

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-outage-retry',
        status: {
          type: 'retry',
          attempt: 2,
          message: 'service unavailable, retrying...',
        },
      },
    });
    expect(mocks.promptAsync).not.toHaveBeenCalled();

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-outage-retry',
        status: {
          type: 'retry',
          attempt: 3,
          message: 'service unavailable, retrying...',
        },
      },
    });
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - chain exhaustion
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager chain exhaustion', () => {
  test('does not call promptAsync when the only chain model is already the current model', async () => {
    // Scenario: chain = ['openai/gpt-b'], current model IS 'openai/gpt-b'.
    // tryFallback adds 'openai/gpt-b' to tried → chain.find() returns undefined → exhausted.
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      { orchestrator: ['openai/gpt-b'] },
      true,
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
    const { client, mocks } = createMockClient();
    const chain = ['openai/model-x', 'openai/model-y'];
    const mgr = new ForegroundFallbackManager(
      client,
      { orchestrator: chain },
      true,
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
    const { client: client2, mocks: mocks2 } = createMockClient();
    const mgr2 = new ForegroundFallbackManager(
      client2,
      { orchestrator: ['openai/model-y'] }, // single-entry chain already in use
      true,
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
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - deduplication
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager deduplication', () => {
  test('ignores a second trigger within dedup window for same session', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true);

    const event = {
      type: 'session.error',
      properties: {
        sessionID: 'sess-dup',
        error: { message: 'rate limit exceeded' },
      },
    };

    await mgr.handleEvent(event);
    await mgr.handleEvent(event); // immediate second trigger - should be deduped

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('different sessions are not deduplicated against each other', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true);

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
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true);

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
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true);

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
        body: { model: { providerID: string; modelID: string } };
      },
    ];
    // explorer chain: ['openai/gpt-4o-mini', 'anthropic/claude-haiku']
    // agentName known → currentModel inferred as chain[0] (primary)
    // primary is tried → fallback picks claude-haiku
    expect(call[0].body.model.providerID).toBe('anthropic');
    expect(call[0].body.model.modelID).toBe('claude-haiku');
  });

  test('child Oracle first provider outage uses only Oracle fallback chain', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      {
        orchestrator: ['google/gemini-2.5-pro', 'openai/gpt-4o'],
        oracle: ['openai/gpt-4.1', 'anthropic/claude-sonnet-4-5'],
      },
      true,
    );

    mgr.registerSessionAgent('oracle-first-call', 'oracle');

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'oracle-first-call',
        error: { data: { statusCode: 503, message: 'upstream outage' } },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      {
        body: { model: { providerID: string; modelID: string } };
      },
    ];
    expect(call[0].body.model.providerID).toBe('anthropic');
    expect(call[0].body.model.modelID).toBe('claude-sonnet-4-5');
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - session.deleted cleanup
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager session.deleted', () => {
  test('cleans up session state on session.deleted via coordinator', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      makeChains(),
      true,
      3,
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
      { body: { model: { providerID: string; modelID: string } } },
    ];
    // orchestrator chain: ['anthropic/claude-opus-4-5', 'openai/gpt-4o', 'google/gemini-2.5-pro']
    // no current model → first untried = anthropic/claude-opus-4-5
    expect(call[0].body.model.providerID).toBe('anthropic');
    expect(call[0].body.model.modelID).toBe('claude-opus-4-5');
  });

  test('ignores session.deleted with no sessionID', async () => {
    const { client } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true);
    // Should not throw
    await expect(
      mgr.handleEvent({ type: 'session.deleted', properties: {} }),
    ).resolves.toBeUndefined();
  });

  test('cleans up state using info.id shape via coordinator', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      makeChains(),
      true,
      3,
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
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - resolveChain correctness
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager resolveChain cross-agent isolation', () => {
  test('does not use another agent chain when known agent has no configured chain', async () => {
    // oracle has no chain in runtimeChains; without the fix resolveChain would
    // fall through to the cross-agent "last resort" and pick a model from
    // orchestrator's chain - re-prompting oracle with an orchestrator model.
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      {
        // oracle intentionally absent - no chain configured
        orchestrator: ['openai/gpt-4o', 'google/gemini-2.5-pro'],
      },
      true,
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
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      { orchestrator: ['openai/gpt-4o'] },
      true,
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
      { body: { model: { providerID: string; modelID: string } } },
    ];
    expect(call[0].body.model.providerID).toBe('openai');
    expect(call[0].body.model.modelID).toBe('gpt-4o');
  });

  test('falls through to model matching for non-omos agents (e.g. compaction)', async () => {
    // compaction is an OpenCode built-in agent that is NOT an omos agent,
    // so it has no chain configured. It should fall through to model
    // matching and inherit a chain from a configured agent that shares
    // its model, instead of being silently excluded from fallback.
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      { orchestrator: ['openai/gpt-5.6', 'new-api/glm-5.2'] },
      true,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'compaction-sess',
          agent: 'compaction', // NOT a known omos built-in agent
          providerID: 'openai',
          modelID: 'gpt-5.6',
          error: { message: 'rate limit exceeded' },
        },
      },
    });

    // compaction's model (openai/gpt-5.6) matches orchestrator's chain
    // → should fall back to the next untried model in that chain
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      { body: { model: { providerID: string; modelID: string } } },
    ];
    expect(call[0].body.model.providerID).toBe('new-api');
    expect(call[0].body.model.modelID).toBe('glm-5.2');
  });
});

// ---------------------------------------------------------------------------
// runtimeOverride config
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager runtimeOverride', () => {
  test('falls back for out-of-chain model when runtimeOverride=true (default)', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      makeChains(),
      true,
      3,
      undefined,
      true, // runtimeOverride
    );

    // Simulate session using a model NOT in any chain
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          agent: 'orchestrator',
          providerID: 'custom',
          modelID: 'expensive-model',
          error: { message: 'rate limit exceeded' },
        },
      },
    });

    // runtimeOverride=true → should fall back even for out-of-chain model
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      { body: { model: { providerID: string; modelID: string } } },
    ];
    // Falls back to chain[0] = anthropic/claude-opus-4-5
    expect(call[0].body.model.providerID).toBe('anthropic');
    expect(call[0].body.model.modelID).toBe('claude-opus-4-5');
  });

  test('skips fallback for out-of-chain model when runtimeOverride=false', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      makeChains(),
      true,
      3,
      undefined,
      false, // runtimeOverride
    );

    // Simulate session using a model NOT in any chain
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-2',
          agent: 'orchestrator',
          providerID: 'custom',
          modelID: 'expensive-model',
          error: { message: 'rate limit exceeded' },
        },
      },
    });

    // runtimeOverride=false + model not in chain → abort session, no fallback
    expect(mocks.promptAsync).toHaveBeenCalledTimes(0);
    expect(mocks.abort).toHaveBeenCalledTimes(1);
  });

  test('always falls back for in-chain model regardless of runtimeOverride=false', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      makeChains(),
      true,
      3,
      undefined,
      false, // runtimeOverride
    );

    // Simulate session using a model that IS in the chain
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-3',
          agent: 'orchestrator',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          error: { message: 'rate limit exceeded' },
        },
      },
    });

    // Model IS in chain → should fall back regardless of runtimeOverride
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      { body: { model: { providerID: string; modelID: string } } },
    ];
    // Falls back to chain[1] = openai/gpt-4o (chain[0] is the current model)
    expect(call[0].body.model.providerID).toBe('openai');
    expect(call[0].body.model.modelID).toBe('gpt-4o');
  });

  test('falls back for in-chain secondary model when runtimeOverride=false', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      makeChains(),
      true,
      3,
      undefined,
      false, // runtimeOverride
    );

    // Simulate session using chain[1] — still in chain
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-4',
          agent: 'orchestrator',
          providerID: 'openai',
          modelID: 'gpt-4o',
          error: { message: 'rate limit exceeded' },
        },
      },
    });

    // Model IS in chain → should fall back
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    const call = mocks.promptAsync.mock.calls[0] as [
      { body: { model: { providerID: string; modelID: string } } },
    ];
    // Falls back to chain[0] = anthropic/claude-opus-4-5 (chain[1] is tried)
    expect(call[0].body.model.providerID).toBe('anthropic');
    expect(call[0].body.model.modelID).toBe('claude-opus-4-5');
  });

  test('falls back for unknown agent with in-chain model when runtimeOverride=false', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      makeChains(),
      true,
      3,
      undefined,
      false, // runtimeOverride
    );

    // Simulate unknown agent (e.g. "compaction") using a model that IS in
    // the orchestrator chain — resolveChain infers the chain from the model.
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-5',
          agent: 'compaction',
          providerID: 'openai',
          modelID: 'gpt-4o',
          error: { message: 'rate limit exceeded' },
        },
      },
    });

    // Model IS in chain (resolved via model matching) → should fall back
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('session.error with runtimeOverride=false and out-of-chain model aborts session', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      makeChains(),
      true,
      3,
      undefined,
      false, // runtimeOverride
    );

    // Seed session with out-of-chain model
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-err-override',
          agent: 'orchestrator',
          providerID: 'custom',
          modelID: 'expensive-model',
        },
      },
    });

    // Trigger session.error with rate limit
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-err-override',
        error: { message: 'Rate limit exceeded' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(0);
    expect(mocks.abort).toHaveBeenCalledTimes(1);
  });

  test('session.status with runtimeOverride=false and out-of-chain model aborts after retry budget exhausted', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      makeChains(),
      true,
      3, // maxRetries
      undefined,
      false, // runtimeOverride
    );

    // Seed session with out-of-chain model
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-status-override',
          agent: 'orchestrator',
          providerID: 'custom',
          modelID: 'expensive-model',
        },
      },
    });

    // First retry (attempt 1) — absorbed by retry budget
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-status-override',
        status: { type: 'retry', message: 'rate limit, retrying...' },
      },
    });
    expect(mocks.abort).toHaveBeenCalledTimes(0);

    // Second retry (attempt 2) — absorbed
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-status-override',
        status: { type: 'retry', message: 'rate limit, retrying...' },
      },
    });
    expect(mocks.abort).toHaveBeenCalledTimes(0);

    // Third retry (attempt 3) — budget exhausted, tryFallback runs, guard aborts
    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-status-override',
        status: { type: 'retry', message: 'rate limit, retrying...' },
      },
    });
    expect(mocks.promptAsync).toHaveBeenCalledTimes(0);
    expect(mocks.abort).toHaveBeenCalledTimes(1);
  });
});
