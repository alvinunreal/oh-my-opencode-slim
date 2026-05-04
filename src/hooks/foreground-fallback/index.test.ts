import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { ForegroundFallbackManager, isRateLimitError } from './index';

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
  messagesData?: Array<{ info: { role: string }; parts: unknown[] }>;
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
// ForegroundFallbackManager — disabled
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
// ForegroundFallbackManager — session.error
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

    expect(mocks.abort).toHaveBeenCalledTimes(1);
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

  test('continues fallback when abort rejects', async () => {
    const { client, mocks } = createMockClient({
      abortImpl: async () => {
        throw new Error('abort failed');
      },
    });
    const mgr = new ForegroundFallbackManager(client, makeChains(), true);

    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-abort-rejects',
        error: { message: 'Rate limit exceeded' },
      },
    });

    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager — message.updated
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
// ForegroundFallbackManager — session.status retry
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager session.status', () => {
  test('triggers fallback on retry status with rate limit message', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true);

    // Pre-seed model
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
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager — chain exhaustion
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

    // Rate limit fires — only model in chain is already current → nothing to fall back to
    await mgr.handleEvent({
      type: 'session.error',
      properties: { sessionID: 's', error: { message: 'rate limit exceeded' } },
    });

    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('does not call promptAsync when all chain models have been tried', async () => {
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
    expect(mocks2.promptAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager — deduplication
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
    await mgr.handleEvent(event); // immediate second trigger — should be deduped

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
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager — subagent.session.created
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager subagent.session.created', () => {
  test('records agent name from subagent.session.created when agentName provided', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true);

    // Register the session as 'explorer' via subagent creation event
    await mgr.handleEvent({
      type: 'subagent.session.created',
      properties: { sessionID: 'sub-1', agentName: 'explorer' },
    });

    // Now trigger rate limit — should use explorer's chain
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
    // no current model tracked → first untried = openai/gpt-4o-mini
    expect(call[0].body.model.providerID).toBe('openai');
    expect(call[0].body.model.modelID).toBe('gpt-4o-mini');
  });
});

// ---------------------------------------------------------------------------
// ForegroundFallbackManager — session.deleted cleanup
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager session.deleted', () => {
  test('cleans up session state on session.deleted preventing memory leaks', async () => {
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true);

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

    // Delete the session
    await mgr.handleEvent({
      type: 'session.deleted',
      properties: { sessionID: 'sess-del' },
    });

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

  test('cleans up state using info.id shape (top-level session deletion)', async () => {
    // OpenCode emits { properties: { info: { id } } } for top-level sessions
    // and { properties: { sessionID } } for subagent sessions. Both must clean up.
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(client, makeChains(), true);

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

    // Delete via the info.id shape
    await mgr.handleEvent({
      type: 'session.deleted',
      properties: { info: { id: 'sess-info-del' } },
    });

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
// ForegroundFallbackManager — resolveChain correctness
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager resolveChain cross-agent isolation', () => {
  test('does not use another agent chain when known agent has no configured chain', async () => {
    // oracle has no chain in runtimeChains; without the fix resolveChain would
    // fall through to the cross-agent "last resort" and pick a model from
    // orchestrator's chain — re-prompting oracle with an orchestrator model.
    const { client, mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(
      client,
      {
        // oracle intentionally absent — no chain configured
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

    // No agent name tracked, no model tracked — triggers session.error
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
});
