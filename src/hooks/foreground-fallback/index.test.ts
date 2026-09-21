import { beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { isInternalInitiatorPart } from '../../utils';
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
  const messages = mock(async () => ({
    data: overrides?.messagesData ?? [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
    ],
  }));
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
          'AI_APICallError: [codex/gpt-5.6-sol-medium] All codex accounts reached configured quota threshold (reset after 20h 41m 59s)',
      }),
    ).toBe(true);
    expect(
      isFailoverError(
        'AI_APICallError: [codex/gpt-5.6-sol-medium] All codex accounts reached configured quota threshold (reset after 20h 41m 59s)',
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
      'No available channel for model gpt-5.6-luna under group Codex专用 (distributor) (request id: abc123)';

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
        message: 'channel not found for model gpt-5.6-luna',
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
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager - disabled
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager (disabled)', () => {
  test('does nothing when enabled=false', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(makeChains(), false, {
      directory: '/test',
    } as any);

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
    mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);
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
            'No available channel for model gpt-5.6-luna under group Codex专用 (distributor)',
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
    mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
      { directory: '/test' } as any,
      3,
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
    await runFallbackScenario({
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
    mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
    mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
    const emptyMgr = new ForegroundFallbackManager({}, true, {
      directory: '/test',
    } as any);
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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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

    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
      3,
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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
      hostFlavor: 'v2',
    } as any);

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
      3,
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

  test('typed no-switchModel rejection is not treated as a busy session', async () => {
    // Hosts without session.switchModel reject the required-switch replay
    // with V2SwitchModelUnavailableError; aborting + retrying cannot fix a
    // missing host capability, so the error must surface after ONE call.
    const switchErr = new Error(
      '[v2] host provides no session.switchModel; cannot switch model for fallback prompt',
    );
    switchErr.name = 'V2SwitchModelUnavailableError';
    const { mocks } = createMockClient({
      promptAsyncImpl: async () => {
        throw switchErr;
      },
    });
    const onModelChanged = mock();
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test', hostFlavor: 'v2' } as any,
      3,
      undefined,
      onModelChanged,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-noswitch',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    });
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-noswitch',
        error: { message: 'Rate limit exceeded' },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(onModelChanged).not.toHaveBeenCalled();
  });

  test('shows a toast when fallback switches models on a transient error', async () => {
    const { mocks } = createMockClient();
    const showToast = mock(async () => ({}));
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
      client: { tui: { showToast } },
    } as any);

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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
      client: { tui: { showToast } },
    } as any);

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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
      client: { tui: { showToast } },
    } as any);

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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
      3,
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
      3,
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
      3,
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

  test('waiter promotion failure is fail-soft: abort and fallback still proceed', async () => {
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
        throw new Error('no experimental endpoint on this host');
      },
    });
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      3,
    );

    await mgr.handleEvent({
      type: 'session.created',
      properties: {
        info: {
          id: 'sess-promote-fails',
          parentID: 'sess-promote-fails-parent',
        },
      },
    });

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-promote-fails',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-promote-fails',
        status: { type: 'retry', attempt: 1, message: 'rate limit' },
      },
    });

    expect(calls).toEqual(['abort', 'promptAsync']);
  });

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
      3,
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

  test('promotes via serverUrl fetch when the client exposes no _client (v2)', async () => {
    const calls: string[] = [];
    const fetchTargets: string[] = [];
    createMockClient({
      includePostClient: false,
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
      {
        directory: '/test',
        serverUrl: new URL('http://127.0.0.1:4096'),
      } as any,
      3,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      fetchTargets.push(String(input));
      calls.push('promote');
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      await mgr.handleEvent({
        type: 'session.created',
        properties: {
          info: { id: 'sess-v2-child', parentID: 'sess-v2-parent' },
        },
      });
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'sess-v2-child',
            providerID: 'anthropic',
            modelID: 'claude-opus-4-5',
          },
        },
      });
      await mgr.handleEvent({
        type: 'session.status',
        properties: {
          sessionID: 'sess-v2-child',
          status: { type: 'retry', attempt: 1, message: 'rate limit' },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toEqual(['promote', 'abort', 'promptAsync']);
    expect(fetchTargets[0]).toBe(
      'http://127.0.0.1:4096/experimental/session/sess-v2-parent/background',
    );
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
      3,
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
      1,
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
      1,
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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
      3,
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
      3,
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
      3,
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
      1,
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
      1,
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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
      client: { tui: { showToast } },
    } as any);

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
      3,
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
      3,
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
      1,
    ); // maxRetries=1 for immediate fallback

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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);
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
            role: 'assistant',
            providerID: 'anthropic',
            modelID: 'claude-opus-4-5',
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

      // Deliberately omit time.completed: this is not a successful response;
      // recovery must come from the fresh descent reset instead.
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

  test('does not fall back onto an earlier chain entry', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);
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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);
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
    const mgr = new ForegroundFallbackManager({ orchestrator: chain }, true, {
      directory: '/test',
    } as any);

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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
// ForegroundFallbackManager - deduplication
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager deduplication', () => {
  test('ignores a second trigger within dedup window for same session', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
      { model: { providerID: string; modelID: string } },
    ];
    // orchestrator chain: ['anthropic/claude-opus-4-5', 'openai/gpt-4o', 'google/gemini-2.5-pro']
    // no current model → first untried = anthropic/claude-opus-4-5
    expect(call[0].body.model.providerID).toBe('anthropic');
    expect(call[0].body.model.modelID).toBe('claude-opus-4-5');
  });

  test('ignores session.deleted with no sessionID', async () => {
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);
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

  test('does NOT clear inProgress when session.deleted fires', () => {
    const coordinator = new SessionLifecycle(() => {});
    const mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test' } as any,
      3,
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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);
    mgr.registerSessionAgent('sess-1', 'orchestrator');
    expect(mgr.willAttemptFallback('sess-1')).toBe(true);
  });

  test('returns false when fallback is disabled', () => {
    const mgr = new ForegroundFallbackManager(makeChains(), false, {
      directory: '/test',
    } as any);
    mgr.registerSessionAgent('sess-1', 'orchestrator');
    expect(mgr.willAttemptFallback('sess-1')).toBe(false);
  });

  test('returns false for a known agent without a configured chain', () => {
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);
    // oracle has no chain in makeChains(); resolveChain must not bleed
    // into another agent's chain, so no fallback is possible.
    mgr.registerSessionAgent('sess-oracle', 'oracle');
    expect(mgr.willAttemptFallback('sess-oracle')).toBe(false);
  });

  test('returns false when the chain is exhausted (stage 2)', () => {
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);
    mgr.registerSessionAgent('sess-1', 'orchestrator');
    (mgr as any).chainExhaustion.set('sess-1', 2);
    expect(mgr.willAttemptFallback('sess-1')).toBe(false);
  });

  test('returns true while a fallback is in flight even after exhaustion', () => {
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);
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
      { orchestrator: ['openai/gpt-5.6', 'new-api/glm-5.2'] },
      true,
      { directory: '/test' } as any,
    );

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'build-sess',
          agent: 'build',
          providerID: 'openai',
          modelID: 'gpt-5.6',
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
      3,
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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
      3,
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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

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
      3, // maxRetries
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
      3, // maxRetries
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
        3, // maxRetries
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
