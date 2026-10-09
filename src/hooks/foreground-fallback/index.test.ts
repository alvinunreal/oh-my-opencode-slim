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
import { isInternalInitiatorPart } from '../../utils';
import * as logger from '../../utils/logger';
import { mapV2EventToV1 } from '../../v2/event-adapter';
import { SessionLifecycle } from '../session-lifecycle';
import type { FallbackNotice } from '../task-session-manager/revived-run-tracker';
import {
  ForegroundFallbackManager,
  isFailoverError,
  isInlineFailoverError,
  isPermanentQuotaBillingError,
} from './index';

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
  messageData?: unknown;
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
  const message = mock(async (_args: unknown) => ({
    data: overrides?.messageData,
  }));
  const post = mock(async (args: unknown) => {
    if (overrides?.postImpl) return overrides.postImpl(args);
    return true;
  });
  const session: Record<string, unknown> = {
    abort,
    messages,
    message,
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
    mocks: { promptAsync, abort, messages, message, post },
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
  new ForegroundFallbackManager(
    { orchestrator: ids.map((id) => `test/${id}`) },
    true,
    { directory: '/test' } as any,
    0, // Existing hook-switch tests isolate switching from host retry budgets.
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

// Host order: the assistant is announced before its error surfaces through
// session.error and message.updated. The transcript already contains the
// user's message and its parts when fallback requests a replay.
const redoEvents = {
  user: (sessionID: string, id: string, modelID = 'a') => ({
    type: 'message.updated',
    properties: {
      info: {
        id,
        sessionID,
        role: 'user',
        model: { providerID: 'test', modelID },
      },
      parts: [{ type: 'text', text: `turn ${id}` }],
    },
  }),
  assistant: (
    sessionID: string,
    modelID = 'a',
    error?: unknown,
    messageID = `assistant-${sessionID}-${modelID}`,
  ) => ({
    type: 'message.updated',
    properties: {
      info: {
        id: messageID,
        sessionID,
        role: 'assistant',
        agent: 'orchestrator',
        providerID: 'test',
        modelID,
        ...(error === undefined ? {} : { error }),
      },
    },
  }),
  error: (
    sessionID: string,
    error: unknown = { message: 'rate limit' },
    messageID = `assistant-${sessionID}-a`,
  ) => ({
    type: 'session.error',
    properties: { sessionID, info: { id: messageID }, error },
  }),
  retry: (sessionID: string, attempt = 1) => ({
    type: 'session.status',
    properties: {
      sessionID,
      status: { type: 'retry', attempt, message: 'rate limit' },
    },
  }),
  success: (sessionID: string, modelID = 'a') => ({
    type: 'message.updated',
    properties: {
      info: {
        sessionID,
        role: 'assistant',
        agent: 'orchestrator',
        providerID: 'test',
        modelID,
        time: { completed: 1 },
      },
    },
  }),
};

function makeManager({
  chain = ['test/a', 'test/b', 'test/c'],
  maxRetries = 3,
  initialRetryDelayMs = 0,
  retryDelayMs = 0,
  hostFlavor,
  onChanged,
}: {
  chain?: ReadonlyArray<string | { id: string; variant?: string }>;
  maxRetries?: number;
  initialRetryDelayMs?: number;
  retryDelayMs?: number;
  hostFlavor?: 'v2';
  onChanged?: (sessionID: string, model: string) => void;
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
      { orchestrator: chain },
      true,
      { directory: '/test', hostFlavor } as never,
      maxRetries,
      undefined,
      onChanged,
      initialRetryDelayMs,
      retryDelayMs,
    ),
    mocks,
  };
}

describe('foreground fallback redo harness', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
  });
  afterEach(() => jest.useRealTimers());

  test('host-ordered error replay selects the next model', async () => {
    const { manager, mocks } = makeManager();
    await manager.handleEvent(redoEvents.assistant('harness'));
    await manager.handleEvent(redoEvents.error('harness'));
    await manager.handleEvent(
      redoEvents.assistant('harness', 'a', { message: 'rate limit' }),
    );
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
      body: { model: { providerID: 'test', modelID: 'b' } },
    });
    expect(manager.getActiveFallback('harness')?.downProviders.size).toBe(0);
    expect(mocks.abort).not.toHaveBeenCalled();
  });

  test('uncorrelated session.error is correlated with its matching errored message update', async () => {
    const { manager, mocks } = makeManager();
    const error = {
      data: { statusCode: 429 },
      message: 'provider quota exhausted for request 17',
    };
    await manager.handleEvent(redoEvents.assistant('error-correlation'));
    await manager.handleEvent({
      type: 'session.error',
      properties: { sessionID: 'error-correlation', error },
    });
    await manager.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'failed-assistant-message',
          sessionID: 'error-correlation',
          role: 'assistant',
          providerID: 'test',
          modelID: 'a',
          error,
        },
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('a separate user turn is not suppressed by failure deduplication', async () => {
    const { manager, mocks } = makeManager({ maxRetries: 0 });
    await manager.handleEvent(redoEvents.assistant('turn-dedup'));
    await manager.handleEvent(redoEvents.error('turn-dedup'));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    await manager.handleEvent(redoEvents.user('turn-dedup', 'next-user-turn'));
    await manager.handleEvent(redoEvents.error('turn-dedup'));

    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
  });

  test('duplicate host user-message updates cannot rewind fallback descent', async () => {
    const { manager, mocks } = makeManager({
      chain: ['test/a', 'test/b', 'test/c'],
      maxRetries: 0,
    });
    const hostUserMessage = (id: string) => ({
      type: 'message.updated',
      properties: {
        info: {
          id,
          sessionID: 'stale-user-model',
          role: 'user',
          providerID: 'test',
          modelID: 'a',
        },
      },
    });

    await manager.handleEvent(hostUserMessage('user-turn-1'));
    await manager.handleEvent(redoEvents.assistant('stale-user-model', 'a'));
    await manager.handleEvent(redoEvents.error('stale-user-model'));
    expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
      body: { model: { providerID: 'test', modelID: 'b' } },
    });

    // The host can re-emit the original user message after the fallback
    // replay. Its original model must not replace the current fallback model.
    await manager.handleEvent(hostUserMessage('user-turn-1'));
    await manager.handleEvent(
      redoEvents.assistant('stale-user-model', 'b', { message: 'rate limit' }),
    );

    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    expect(mocks.promptAsync.mock.calls[1]?.[0]).toMatchObject({
      body: { model: { providerID: 'test', modelID: 'c' } },
    });
  });

  test('a re-emitted user-message update is inert while a newer turn classifies', async () => {
    // v1 republishes a turn's user message (info only) on every step finish.
    const { manager, mocks } = makeManager();
    const newerTurnRead = deferred<unknown>();
    mocks.messages
      .mockImplementationOnce(async () => ({ data: [] }))
      .mockImplementationOnce(() => newerTurnRead.promise);
    const update = (id: string, modelID: string) => ({
      type: 'message.updated',
      properties: {
        info: {
          id,
          sessionID: 'reemitted',
          role: 'user',
          model: { providerID: 'test', modelID },
        },
      },
    });

    await manager.handleEvent(update('turn-1', 'a'));
    const newerTurn = manager.handleEvent(update('turn-2', 'b'));
    await manager.handleEvent(update('turn-1', 'a'));
    newerTurnRead.resolve({ data: [] });
    await newerTurn;

    expect(mocks.messages).toHaveBeenCalledTimes(2);
    expect((manager as any).sessionModel.get('reemitted')).toBe('test/b');
  });

  test('v1 info-only replay notification is claimed by its reserved message ID', async () => {
    const transcript: unknown[] = [
      {
        info: { id: 'original-user', role: 'user' },
        parts: [{ type: 'text', text: 'hello' }],
      },
    ];
    let manager!: ForegroundFallbackManager;
    const onChanged = mock((_sessionID: string, _model: string) => {});
    const { mocks } = createMockClient({
      messagesData: transcript,
      promptAsyncImpl: async (args) => {
        const replayMessageID = (args as { body: { messageID: string } }).body
          .messageID;
        const replay = {
          info: {
            id: replayMessageID,
            role: 'user',
            model: { providerID: 'test', modelID: 'b' },
          },
          parts: [],
        };
        transcript.push(replay);
        await manager.handleEvent({
          type: 'message.updated',
          properties: {
            info: {
              id: replayMessageID,
              sessionID: 'v1-info-only-replay',
              role: 'user',
              model: { providerID: 'test', modelID: 'b' },
            },
          },
        });
        const markerPart = {
          type: 'text',
          text: '<!-- SLIM_INTERNAL_INITIATOR -->',
          synthetic: true,
          metadata: { 'oh-my-opencode-slim.internalInitiator': true },
          sessionID: 'v1-info-only-replay',
          messageID: replayMessageID,
        };
        replay.parts.push(markerPart);
        await manager.handleEvent({
          type: 'message.part.updated',
          properties: { part: markerPart },
        });
        return {};
      },
    });
    manager = new ForegroundFallbackManager(
      { orchestrator: ['test/a', 'test/b'] },
      true,
      { directory: '/test' } as never,
      0,
      undefined,
      onChanged,
      0,
      0,
    );

    await manager.handleEvent(redoEvents.assistant('v1-info-only-replay'));
    await manager.handleEvent(redoEvents.error('v1-info-only-replay'));

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
      body: { messageID: expect.stringMatching(/^msg/) },
    });
    expect(onChanged).toHaveBeenCalledWith('v1-info-only-replay', 'test/b');
  });

  test('identical external user content with another ID fences an in-flight replay', async () => {
    const transcript: unknown[] = [
      {
        info: { id: 'original-user', role: 'user' },
        parts: [{ type: 'text', text: 'hello' }],
      },
    ];
    let manager!: ForegroundFallbackManager;
    const onChanged = mock((_sessionID: string, _model: string) => {});
    const { mocks } = createMockClient({
      messagesData: transcript,
      promptAsyncImpl: async (args) => {
        const replayMessageID = (args as { body: { messageID: string } }).body
          .messageID;
        await manager.handleEvent({
          type: 'message.updated',
          properties: {
            info: {
              id: replayMessageID,
              sessionID: 'external-turn-fence',
              role: 'user',
              model: { providerID: 'test', modelID: 'b' },
            },
          },
        });
        await manager.handleEvent({
          type: 'message.updated',
          properties: {
            info: {
              id: 'actual-user-message',
              sessionID: 'external-turn-fence',
              role: 'user',
              model: { providerID: 'test', modelID: 'b' },
            },
          },
        });
        return {};
      },
    });
    manager = new ForegroundFallbackManager(
      { orchestrator: ['test/a', 'test/b'] },
      true,
      { directory: '/test' } as never,
      0,
      undefined,
      onChanged,
      0,
      0,
    );

    await manager.handleEvent(redoEvents.assistant('external-turn-fence'));
    await manager.handleEvent(redoEvents.error('external-turn-fence'));

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  test('an older transcript probe cannot overwrite a newer external turn', async () => {
    const olderProbe = deferred<unknown>();
    let lookupCount = 0;
    const onChanged = mock((_sessionID: string, _model: string) => {});
    const { mocks } = createMockClient({
      messagesImpl: async () => {
        lookupCount += 1;
        if (lookupCount === 1) return olderProbe.promise;
        if (lookupCount === 2) {
          return {
            data: [{ info: { id: 'newer-user', role: 'user' }, parts: [] }],
          };
        }
        return {
          data: [
            {
              info: { id: 'replay-source', role: 'user' },
              parts: [{ type: 'text', text: 'hello' }],
            },
          ],
        };
      },
    });
    const manager = new ForegroundFallbackManager(
      { orchestrator: ['test/a', 'test/b', 'test/c'] },
      true,
      { directory: '/test' } as never,
      0,
      undefined,
      onChanged,
    );
    const userEvent = (id: string, modelID: string) => ({
      type: 'message.updated',
      properties: {
        info: {
          id,
          sessionID: 'turn-probe-order',
          role: 'user',
          model: { providerID: 'test', modelID },
        },
      },
    });

    const oldEvent = manager.handleEvent(userEvent('older-user', 'a'));
    await manager.handleEvent(userEvent('newer-user', 'b'));
    olderProbe.resolve({
      data: [{ info: { id: 'older-user', role: 'user' }, parts: [] }],
    });
    await oldEvent;

    await manager.handleEvent(redoEvents.error('turn-probe-order'));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
      body: { model: { providerID: 'test', modelID: 'c' } },
    });
    expect(onChanged).toHaveBeenCalledWith('turn-probe-order', 'test/c');
  });

  test('an internal replay notification does not invalidate an external turn probe', async () => {
    const externalProbe = deferred<unknown>();
    const promptStarted = deferred<void>();
    const promptResponse = deferred<unknown>();
    let lookupCount = 0;
    let manager!: ForegroundFallbackManager;
    const onChanged = mock((_sessionID: string, _model: string) => {});
    const { mocks } = createMockClient({
      messagesImpl: async () => {
        lookupCount += 1;
        if (lookupCount === 1) return externalProbe.promise;
        return {
          data: [
            {
              info: { id: 'fallback-source', role: 'user' },
              parts: [{ type: 'text', text: 'hello' }],
            },
          ],
        };
      },
      promptAsyncImpl: async (args) => {
        const messageID = (args as { body: { messageID: string } }).body
          .messageID;
        await manager.handleEvent({
          type: 'message.updated',
          properties: {
            info: {
              id: messageID,
              sessionID: 'internal-does-not-fence',
              role: 'user',
            },
          },
        });
        promptStarted.resolve();
        return promptResponse.promise;
      },
    });
    manager = new ForegroundFallbackManager(
      { orchestrator: ['test/a', 'test/b'] },
      true,
      { directory: '/test' } as never,
      0,
      undefined,
      onChanged,
    );
    const sessionID = 'internal-does-not-fence';

    await manager.handleEvent(redoEvents.assistant(sessionID));
    const externalTurn = manager.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'genuine-external-turn',
          sessionID,
          role: 'user',
          model: { providerID: 'test', modelID: 'b' },
        },
      },
    });
    const fallback = manager.handleEvent(redoEvents.error(sessionID));
    await promptStarted.promise;
    externalProbe.resolve({
      data: [
        { info: { id: 'genuine-external-turn', role: 'user' }, parts: [] },
      ],
    });
    await externalTurn;
    promptResponse.resolve({});
    await fallback;

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  test('delayed fallback retains inline 410 context for toast suppression', async () => {
    const { mocks } = createMockClient();
    const showToast = mock(async () => ({}));
    const manager = new ForegroundFallbackManager(
      makeChains(),
      true,
      {
        directory: '/test',
        client: { tui: { showToast } },
      } as never,
      0,
      undefined,
      undefined,
      100,
      0,
    );
    const sessionID = 'delayed-inline-410';

    await manager.handleEvent(redoEvents.assistant(sessionID));
    await manager.handleEvent(
      redoEvents.assistant(sessionID, 'a', {
        data: { statusCode: 410 },
        message: 'AI_APICallError: Gone',
      }),
    );
    jest.advanceTimersByTime(100);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  test('permanent billing failure bypasses the configured initial delay', async () => {
    const { manager, mocks } = makeManager({ initialRetryDelayMs: 1_000 });
    const sessionID = 'permanent-billing-no-delay';
    await manager.handleEvent(redoEvents.assistant(sessionID));

    await manager.handleEvent(
      redoEvents.assistant(sessionID, 'a', {
        statusCode: 402,
        message: 'Payment Required',
      }),
    );

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('initial retry delay is used once per descent before normal retry backoff', async () => {
    const { manager, mocks } = makeManager({
      initialRetryDelayMs: 1_000,
      retryDelayMs: 100,
    });
    const sessionID = 'single-initial-delay';
    await manager.handleEvent(redoEvents.assistant(sessionID));
    await manager.handleEvent(redoEvents.error(sessionID));
    jest.advanceTimersByTime(1_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    const secondFailure = manager.handleEvent(
      redoEvents.assistant(sessionID, 'b', { message: 'rate limit' }),
    );
    jest.advanceTimersByTime(99);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await secondFailure;

    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    expect(mocks.promptAsync.mock.calls[1]?.[0]).toMatchObject({
      body: { model: { providerID: 'test', modelID: 'c' } },
    });
  });

  test('a new external turn clears prior consecutive-fallback backoff', async () => {
    const { manager, mocks } = makeManager({ retryDelayMs: 1_000 });
    const sessionID = 'turn-clears-backoff';
    await manager.handleEvent(redoEvents.assistant(sessionID));
    await manager.handleEvent(redoEvents.error(sessionID));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    await manager.handleEvent(redoEvents.user(sessionID, 'new-user'));
    const nextFailure = manager.handleEvent(
      redoEvents.error(sessionID, { message: 'rate limit' }, 'new-failure'),
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    await nextFailure;
  });

  test('a new external turn resets the retry budget before any model switch', async () => {
    const { manager, mocks } = makeManager({ maxRetries: 1 });
    await manager.handleEvent(redoEvents.assistant('early-turn-reset'));
    await manager.handleEvent(redoEvents.retry('early-turn-reset', 1));
    expect(mocks.promptAsync).not.toHaveBeenCalled();

    await manager.handleEvent(redoEvents.user('early-turn-reset', 'new-user'));
    await manager.handleEvent(redoEvents.retry('early-turn-reset', 1));
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();

    await manager.handleEvent(redoEvents.retry('early-turn-reset', 2));
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('an overlapping retry during fallback does not consume the host retry budget', async () => {
    const started = deferred<void>();
    const admission = deferred<unknown>();
    const { mocks } = createMockClient({
      promptAsyncImpl: async () => {
        started.resolve();
        return admission.promise;
      },
    });
    const manager = new ForegroundFallbackManager(
      { orchestrator: ['test/a', 'test/b'] },
      true,
      { directory: '/test' } as never,
      1,
    );
    const sessionID = 'overlapping-host-retry';

    await manager.handleEvent(redoEvents.assistant(sessionID));
    const fallback = manager.handleEvent(redoEvents.error(sessionID));
    await started.promise;
    await manager.handleEvent(redoEvents.retry(sessionID, 1));
    admission.resolve({ data: { error: { message: 'not admitted' } } });
    await fallback;

    await manager.handleEvent(redoEvents.retry(sessionID, 2));
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('uses fallback chains replaced after manager construction', async () => {
    const { mocks } = createMockClient({
      messagesData: [
        {
          info: { id: 'user-message', role: 'user' },
          parts: [{ type: 'text', text: 'hello' }],
        },
      ],
    });
    const chains: Record<
      string,
      ReadonlyArray<string | { id: string; variant?: string }>
    > = {
      orchestrator: ['test/a', 'test/old'],
    };
    const manager = new ForegroundFallbackManager(
      chains,
      true,
      { directory: '/test' } as never,
      0,
      undefined,
      undefined,
      0,
      0,
    );
    chains.orchestrator = ['test/a', { id: 'test/new', variant: 'fast' }];

    await manager.handleEvent(redoEvents.assistant('live-chain'));
    await manager.handleEvent(redoEvents.error('live-chain'));

    expect(mocks.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: 'test', modelID: 'new' },
          variant: 'fast',
        }),
      }),
    );
  });

  test('a newer turn during waiter promotion fences the retry abort', async () => {
    const promotion = deferred<unknown>();
    const { manager, mocks } = makeManager({ maxRetries: 0 });
    currentMockPost = mock(() => promotion.promise);
    await manager.handleEvent({
      type: 'session.created',
      properties: { info: { id: 'promotion-race', parentID: 'parent' } },
    });
    const pending = manager.handleEvent(redoEvents.retry('promotion-race'));
    await Promise.resolve();
    await Promise.resolve();
    await manager.handleEvent(redoEvents.user('promotion-race', 'new-turn'));
    promotion.resolve({});
    await pending;

    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('a newer turn during abort fences the subsequent replay', async () => {
    const abort = deferred<unknown>();
    const { manager, mocks } = makeManager({ maxRetries: 0 });
    mocks.abort.mockImplementation(() => abort.promise);
    const pending = manager.handleEvent(redoEvents.retry('abort-race'));
    await Promise.resolve();
    await Promise.resolve();
    await manager.handleEvent(redoEvents.user('abort-race', 'new-turn'));
    abort.resolve({});
    await pending;

    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('a newer turn during transcript read fences the replay', async () => {
    const transcript = deferred<{ data: unknown[] }>();
    const { manager, mocks } = makeManager({ maxRetries: 0 });
    currentMockSession = {
      abort: mocks.abort,
      messages: mock(() => transcript.promise),
      promptAsync: mocks.promptAsync,
    };
    installGetClientMock();
    const pending = manager.handleEvent(redoEvents.error('transcript-race'));
    await Promise.resolve();
    await manager.handleEvent(redoEvents.user('transcript-race', 'new-turn'));
    transcript.resolve({
      data: [
        {
          info: { id: 'last-user', role: 'user' },
          parts: [{ type: 'text', text: 'old turn' }],
        },
      ],
    });
    await pending;

    expect(mocks.promptAsync).not.toHaveBeenCalled();
  });

  test('a newer turn during busy promotion fences the busy abort and retry', async () => {
    const promotion = deferred<unknown>();
    const { manager, mocks } = makeManager({
      maxRetries: 0,
    });
    mocks.promptAsync.mockImplementationOnce(async () => {
      throw new Error('session busy');
    });
    currentMockPost = mock(() => promotion.promise);
    await manager.handleEvent({
      type: 'session.created',
      properties: { info: { id: 'busy-race', parentID: 'parent' } },
    });
    const pending = manager.handleEvent(redoEvents.error('busy-race'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await manager.handleEvent(redoEvents.user('busy-race', 'new-turn'));
    promotion.resolve({});
    await pending;

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.abort).not.toHaveBeenCalled();
  });

  test('a newer turn during fallback backoff fences the delayed replay', async () => {
    const { manager, mocks } = makeManager({ retryDelayMs: 500 });
    await manager.handleEvent(redoEvents.assistant('backoff-race'));
    await manager.handleEvent(redoEvents.error('backoff-race'));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    const pending = manager.handleEvent(
      redoEvents.assistant('backoff-race', 'b', { message: 'rate limit' }),
    );
    await manager.handleEvent(redoEvents.user('backoff-race', 'new-turn'));
    jest.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();
    await pending;

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });
});

describe('foreground fallback redo: host retry budget', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
  });
  afterEach(() => jest.useRealTimers());

  test('identical retry attempts are deduplicated before charging the budget', async () => {
    const { manager, mocks } = makeManager({ maxRetries: 1 });
    await manager.handleEvent(redoEvents.assistant('retry-attempt-dedup'));
    await manager.handleEvent(redoEvents.retry('retry-attempt-dedup', 1));
    await manager.handleEvent(redoEvents.retry('retry-attempt-dedup', 1));

    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();

    await manager.handleEvent(redoEvents.retry('retry-attempt-dedup', 2));
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('G2: retry statuses do not postpone the first scheduled abort', async () => {
    const sid = 'stable-initial-delay';
    const { manager, mocks } = makeManager({
      maxRetries: 0,
      initialRetryDelayMs: 1_000,
    });
    await manager.handleEvent(redoEvents.assistant(sid));
    await manager.handleEvent(redoEvents.retry(sid));
    jest.advanceTimersByTime(600);
    await manager.handleEvent(redoEvents.retry(sid, 2));
    expect(mocks.abort).not.toHaveBeenCalled();
    jest.advanceTimersByTime(400);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
      body: { model: { providerID: 'test', modelID: 'b' } },
    });
    jest.advanceTimersByTime(600);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('N1: terminal error updates the pending deadline to replay without abort', async () => {
    const sid = 'terminal-during-initial-delay';
    const { manager, mocks } = makeManager({
      maxRetries: 0,
      initialRetryDelayMs: 1_000,
    });
    await manager.handleEvent(redoEvents.assistant(sid));
    await manager.handleEvent(redoEvents.retry(sid));
    jest.advanceTimersByTime(300);
    await manager.handleEvent(redoEvents.error(sid));
    jest.advanceTimersByTime(700);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
      body: { model: { providerID: 'test', modelID: 'b' } },
    });
  });

  test('T-N3: an absorbed retry cancels a terminal delay before the next run', async () => {
    const sid = 'absorbed-retry-cancels-delay';
    const { manager, mocks } = makeManager({
      maxRetries: 1,
      initialRetryDelayMs: 1_000,
    });
    await manager.handleEvent(redoEvents.assistant(sid));
    await manager.handleEvent(redoEvents.error(sid));
    jest.advanceTimersByTime(300);
    await manager.handleEvent(redoEvents.retry(sid, 1));
    jest.advanceTimersByTime(700);
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();
    await manager.handleEvent(redoEvents.retry(sid, 2));
    jest.advanceTimersByTime(1_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
      body: { model: { providerID: 'test', modelID: 'b' } },
    });
  });

  test('T-LOCK: an unabsorbed retry upgrades a terminal delay to abort', async () => {
    const sid = 'unabsorbed-retry-upgrades-delay';
    const { manager, mocks } = makeManager({
      maxRetries: 0,
      initialRetryDelayMs: 1_000,
    });
    await manager.handleEvent(redoEvents.assistant(sid));
    await manager.handleEvent(redoEvents.error(sid));
    await manager.handleEvent(redoEvents.retry(sid));
    jest.advanceTimersByTime(1_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
      body: { model: { providerID: 'test', modelID: 'b' } },
    });
  });

  test.each([0, 1, 3])(
    'T1: %i host retries are absorbed before the first switch, not renewed by the switch',
    async (maxRetries) => {
      const sid = `budget-${maxRetries}`;
      const { manager, mocks } = makeManager({ maxRetries });
      await manager.handleEvent(redoEvents.assistant(sid));
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        await manager.handleEvent(redoEvents.retry(sid, attempt));
        expect(mocks.abort).not.toHaveBeenCalled();
        expect(mocks.promptAsync).not.toHaveBeenCalled();
      }
      await manager.handleEvent(redoEvents.retry(sid, maxRetries + 1));
      expect(mocks.abort).toHaveBeenCalledTimes(1);
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
      expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
        body: { model: { providerID: 'test', modelID: 'b' } },
      });
      await manager.handleEvent(redoEvents.assistant(sid, 'b'));
      await manager.handleEvent(redoEvents.retry(sid, 1));
      expect(mocks.abort).toHaveBeenCalledTimes(2);
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
      expect(mocks.promptAsync.mock.calls[1]?.[0]).toMatchObject({
        body: { model: { providerID: 'test', modelID: 'c' } },
      });
    },
  );

  test.each([
    ['401', { data: { statusCode: 401 } }],
    ['410', { data: { statusCode: 410 } }],
    ['not-found', { message: 'Model not found: test/a' }],
    ['policy', { data: { responseBody: '{"code":"cyber_policy"}' } }],
    ['429', { data: { statusCode: 429 } }],
  ])(
    'T2: terminal %s advances immediately via both error event paths',
    async (_label, error) => {
      for (const source of ['session.error', 'message.updated'] as const) {
        const sid = `terminal-${_label}-${source}`;
        const { manager, mocks } = makeManager();
        await manager.handleEvent(redoEvents.assistant(sid));
        const fail = () =>
          source === 'session.error'
            ? redoEvents.error(sid, error)
            : redoEvents.assistant(sid, 'a', error);
        await manager.handleEvent(fail());
        // The host re-emits the failed assistant after session.error. Its
        // model identifies the original incident even after the replay switch.
        await manager.handleEvent(redoEvents.assistant(sid, 'a', error));
        expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
        expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
          body: { model: { providerID: 'test', modelID: 'b' } },
        });
        expect(mocks.abort).not.toHaveBeenCalled();
      }
    },
  );

  test('T3: serial and concurrent observations of one failure replay only once', async () => {
    const sid = 'duplicate-observation';
    const { manager, mocks } = makeManager();
    await manager.handleEvent(redoEvents.assistant(sid));
    await Promise.all([
      manager.handleEvent(redoEvents.error(sid)),
      manager.handleEvent(
        redoEvents.assistant(sid, 'a', { message: 'rate limit' }),
      ),
    ]);
    await manager.handleEvent(
      redoEvents.assistant(sid, 'a', { message: 'rate limit' }),
    );
    await manager.handleEvent(redoEvents.error(sid));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('T4: fresh primary descent re-arms the full budget after stage 2', async () => {
    const sid = 'fresh-descent';
    const { manager, mocks } = makeManager({
      chain: ['test/a', 'test/b'],
      maxRetries: 2,
    });
    await manager.handleEvent(redoEvents.assistant(sid));
    for (let attempt = 1; attempt <= 3; attempt++)
      await manager.handleEvent(redoEvents.retry(sid, attempt));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    await manager.handleEvent(redoEvents.assistant(sid, 'b'));
    await manager.handleEvent(redoEvents.error(sid));
    jest.setSystemTime(1_006_000);
    await manager.handleEvent(redoEvents.error(sid));
    expect(mocks.abort).toHaveBeenCalledTimes(2);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);

    jest.setSystemTime(1_012_000);
    await manager.handleEvent(redoEvents.assistant(sid));
    await manager.handleEvent(redoEvents.retry(sid, 1));
    await manager.handleEvent(redoEvents.retry(sid, 2));
    expect(mocks.abort).toHaveBeenCalledTimes(2);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    await manager.handleEvent(redoEvents.retry(sid, 3));
    expect(mocks.abort).toHaveBeenCalledTimes(3);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(3);
  });

  test('S1: success on the fallback restores the full host retry budget', async () => {
    const sid = 'success-rearms-budget';
    const { manager, mocks } = makeManager({ maxRetries: 2 });
    await manager.handleEvent(redoEvents.assistant(sid));
    for (let attempt = 1; attempt <= 3; attempt++)
      await manager.handleEvent(redoEvents.retry(sid, attempt));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    jest.setSystemTime(1_006_000);
    await manager.handleEvent(redoEvents.success(sid, 'b'));
    for (let attempt = 1; attempt <= 2; attempt++) {
      await manager.handleEvent(redoEvents.retry(sid, attempt));
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    }
    await manager.handleEvent(redoEvents.retry(sid, 3));
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    expect(mocks.promptAsync.mock.calls[1]?.[0]).toMatchObject({
      body: { model: { providerID: 'test', modelID: 'c' } },
    });
    expect(mocks.abort).toHaveBeenCalledTimes(2);
  });

  test('T5: after stage 2 a non-primary new turn cannot abort again', async () => {
    const sid = 'exhausted-non-primary';
    const { manager, mocks } = makeManager({
      chain: ['test/a', 'test/b'],
      maxRetries: 0,
    });
    await manager.handleEvent(redoEvents.assistant(sid));
    await manager.handleEvent(redoEvents.error(sid));
    await manager.handleEvent(redoEvents.assistant(sid, 'b'));
    jest.setSystemTime(1_006_000);
    await manager.handleEvent(redoEvents.error(sid));
    jest.setSystemTime(1_012_000);
    await manager.handleEvent(redoEvents.error(sid));
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    expect(manager.fallbackFailureReason(sid)).toContain(
      'chain exhausted; tried: test/a, test/b.',
    );

    jest.setSystemTime(1_018_000);
    await manager.handleEvent(redoEvents.assistant(sid, 'b'));
    await manager.handleEvent(redoEvents.retry(sid));
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
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

    await manager.handleEvent(redoEvents.assistant(sid, 'a'));
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
  });

  test('v2 steering disabled leaves the retry hook inert', async () => {
    const mgr = new ForegroundFallbackManager(
      makeChains({ orchestrator: ['test/a', 'test/b', 'test/c'] }),
      false,
      { directory: '/test', hostFlavor: 'v2' } as never,
      0,
      undefined,
      undefined,
      0,
      0,
      undefined,
      undefined,
      undefined,
      false,
    );
    const switchModel = mock(async () => ({}));
    const event = retryEvent('v2-inert', 'a', { retry: true, delay: 77 });
    await mgr.handleV2Retry(event, switchModel);
    expect(switchModel).not.toHaveBeenCalled();
    expect(event.decision).toEqual({ retry: true, delay: 77 });
  });

  test('v2 retry hook logs a one-shot delivery notice per session and model', async () => {
    const captured: string[] = [];
    const capture = spyOn(logger, 'log').mockImplementation(
      (message: string) => {
        captured.push(message);
      },
    );
    try {
      const mgr = new ForegroundFallbackManager(
        makeChains({ orchestrator: ['test/a', 'test/b', 'test/c'] }),
        false,
        { directory: '/test', hostFlavor: 'v2' } as never,
        0,
        undefined,
        undefined,
        0,
        0,
        undefined,
        undefined,
        undefined,
        false,
      );
      const switchModel = mock(async () => ({}));
      await mgr.handleV2Retry(
        retryEvent('v2-notice', 'a', { retry: true }),
        switchModel,
      );
      await mgr.handleV2Retry(
        retryEvent('v2-notice', 'a', { retry: true }),
        switchModel,
      );
      // Same session, different failing model: a second notice.
      await mgr.handleV2Retry(
        retryEvent('v2-notice', 'b', { retry: true }),
        switchModel,
      );
      const notices = captured.filter(
        (message) => message === '[foreground-fallback] v2 retry hook observed',
      );
      expect(notices).toHaveLength(2);
    } finally {
      capture.mockRestore();
    }
  });

  test('v2 steering ignores the configured initial delay', async () => {
    const mgr = new ForegroundFallbackManager(
      makeChains({ orchestrator: ['test/a', 'test/b', 'test/c'] }),
      true,
      { directory: '/test', hostFlavor: 'v2' } as never,
      0,
      undefined,
      undefined,
      250, // initialRetryDelayMs — no replay to delay on the steering path
      0,
    );
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
    const mgr = new ForegroundFallbackManager(
      makeChains({ orchestrator: ['test/a', 'test/b', 'test/c'] }),
      false, // replay path off (v2)
      { directory: '/test', hostFlavor: 'v2' } as never,
      0,
      undefined,
      undefined,
      0,
      0,
      undefined,
      undefined,
      undefined,
      true, // steering on
    );
    const switchModel = mock(async () => ({}));
    // First descent: a -> b.
    await mgr.handleV2Retry(
      retryEvent('v2-reset', 'a', { retry: true }),
      switchModel,
    );
    expect(switchModel).toHaveBeenCalledTimes(1);
    // A completed successful assistant response resets the descent
    // bookkeeping even with the replay path disabled.
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'm-v2-ok',
          sessionID: 'v2-reset',
          role: 'assistant',
          agent: 'orchestrator',
          providerID: 'test',
          modelID: 'b',
          finish: 'stop',
          time: { completed: Date.now() },
        },
      },
    });
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

  test('willAttemptFallback follows the steering flag on v2', () => {
    const steering = new ForegroundFallbackManager(
      makeChains({ orchestrator: ['test/a', 'test/b', 'test/c'] }),
      false,
      { directory: '/test', hostFlavor: 'v2' } as never,
      0,
      undefined,
      undefined,
      0,
      0,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(steering.willAttemptFallback('v2-wa')).toBe(true);
    const inert = new ForegroundFallbackManager(
      makeChains({ orchestrator: ['test/a', 'test/b', 'test/c'] }),
      false,
      { directory: '/test', hostFlavor: 'v2' } as never,
      0,
      undefined,
      undefined,
      0,
      0,
      undefined,
      undefined,
      undefined,
      false,
    );
    expect(inert.willAttemptFallback('v2-wa')).toBe(false);
  });

  test('T7: mapped v2 failed execution prompts once without charging host retries', async () => {
    const sid = 'v2-failed-execution';
    const { manager, mocks } = makeManager({ maxRetries: 2 });
    await manager.handleEvent(redoEvents.assistant(sid));
    for (const mapped of mapV2EventToV1({
      type: 'session.execution.failed',
      data: { sessionID: sid, error: { message: 'rate limit' } },
    }))
      await manager.handleEvent(mapped);
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
      body: { model: { providerID: 'test', modelID: 'b' } },
    });
    const switchModel = mock(async () => {});
    const host = retryEvent(sid, 'b', { retry: true, delay: 77 });
    await manager.handleV2Retry(host, switchModel);
    expect(switchModel).not.toHaveBeenCalled();
    expect(host.decision).toEqual({ retry: true, delay: 77 });
  });

  test.each([
    ['v1', undefined],
    ['v2', 'v2'],
  ] as const)(
    'T8: %s replay carries the fallback entry variant',
    async (label, hostFlavor) => {
      const sid = `variant-replay-${label}`;
      const { manager, mocks } = makeManager({
        chain: ['test/a', { id: 'test/b', variant: 'fast' }],
        hostFlavor,
      });
      await manager.handleEvent(redoEvents.assistant(sid));
      await manager.handleEvent(redoEvents.error(sid));
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
      expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
        body: { model: { providerID: 'test', modelID: 'b' }, variant: 'fast' },
        ...(hostFlavor ? { modelVariant: 'fast' } : {}),
      });
    },
  );

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

  test('T10: entries without a variant add no replay or switch keys', async () => {
    for (const hostFlavor of [undefined, 'v2'] as const) {
      const sid = `no-variant-${hostFlavor ?? 'v1'}`;
      const { manager, mocks } = makeManager({
        chain: ['test/a', 'test/b'],
        hostFlavor,
      });
      await manager.handleEvent(redoEvents.assistant(sid));
      await manager.handleEvent(redoEvents.error(sid));
      const call = mocks.promptAsync.mock.calls[0]?.[0] as {
        body: Record<string, unknown>;
      };
      expect(Object.hasOwn(call.body, 'variant')).toBe(false);
      expect(Object.hasOwn(call, 'modelVariant')).toBe(false);
    }
    const { manager } = makeManager({ chain: ['test/a', 'test/b'] });
    const refs: Array<{ providerID: string; id: string; variant?: string }> =
      [];
    await manager.handleV2Retry(
      retryEvent('no-variant-hook', 'a', { retry: false }),
      async (_sid, ref) => {
        refs.push(ref);
      },
    );
    expect(refs).toHaveLength(1);
    expect(Object.hasOwn(refs[0], 'variant')).toBe(false);
  });

  test('T11: an unknown agent carries the inferred chain variant to replay and retry', async () => {
    const sid = 'inferred-variant-replay';
    const chain = ['test/a', { id: 'test/b', variant: 'fast' }];
    const assistant = {
      type: 'message.updated',
      properties: {
        info: {
          sessionID: sid,
          role: 'assistant',
          providerID: 'test',
          modelID: 'a',
        },
      },
    };
    const v1 = makeManager({ chain });
    await v1.manager.handleEvent(assistant);
    await v1.manager.handleEvent(redoEvents.error(sid));

    const v2 = makeManager({ chain, hostFlavor: 'v2' });
    await v2.manager.handleEvent(assistant);
    await v2.manager.handleEvent(redoEvents.error(sid));
    const refs: Array<{ providerID: string; id: string; variant?: string }> =
      [];
    await v2.manager.handleV2Retry(
      {
        sessionID: 'inferred-variant-hook',
        model: { providerID: 'test', id: 'a' },
        error: { message: 'rate limit' },
        decision: { retry: false },
      },
      async (_sid, ref) => {
        refs.push(ref);
      },
    );

    expect(v1.mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(v2.mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect({
      v1: v1.mocks.promptAsync.mock.calls[0]?.[0],
      v2: v2.mocks.promptAsync.mock.calls[0]?.[0],
      refs,
    }).toMatchObject({
      v1: {
        body: { model: { providerID: 'test', modelID: 'b' }, variant: 'fast' },
      },
      v2: {
        body: { model: { providerID: 'test', modelID: 'b' }, variant: 'fast' },
        modelVariant: 'fast',
      },
      refs: [{ providerID: 'test', id: 'b', variant: 'fast' }],
    });
  });
});

describe('ForegroundFallbackManager v2 retry hook', () => {
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

  test('permanent quota error skips the host retry budget', async () => {
    const { manager } = makeManager({ maxRetries: 3 });
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
  });

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
});

describe('isPermanentQuotaBillingError', () => {
  test('returns true for free-tier usage exhaustion', () => {
    expect(
      isPermanentQuotaBillingError('Free usage exceeded, subscribe to Go'),
    ).toBe(true);
    expect(
      isPermanentQuotaBillingError({
        message: 'Free usage exceeded, subscribe to Go',
      }),
    ).toBe(true);
  });

  test('returns false for transient rate limits', () => {
    expect(isPermanentQuotaBillingError('rate limit, retrying...')).toBe(false);
    expect(
      isPermanentQuotaBillingError({ message: '429 Too Many Requests' }),
    ).toBe(false);
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
    const finishEvent = {
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
        },
      },
    };
    await mgr.handleEvent(finishEvent);
    await mgr.handleEvent(finishEvent);

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
    const activeFallback = {
      model: 'openai/gpt-4o',
      downProviders: new Set(['anthropic']),
    };
    expect(mgr.getActiveFallback('sess-1')).toEqual(activeFallback);

    mgr.observeExternalTurn('sess-1', undefined);
    expect(mgr.getActiveFallback('sess-1')).toEqual(activeFallback);
    mgr.observeExternalTurn('sess-1', 'openai/gpt-4o');
    expect(mgr.getActiveFallback('sess-1')).toEqual(activeFallback);
    mgr.observeExternalTurn('sess-1', 'anthropic/claude-opus-4-5');
    expect(mgr.getActiveFallback('sess-1')).toBeUndefined();
  });

  async function expectErrorFallback(
    statusCode: number,
    message: string,
    responseBody: string,
    downProviders: string[] = [],
  ) {
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
          name: 'APIError',
          data: { statusCode, message, responseBody },
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
    expect(mgr.getActiveFallback('sess-1')?.downProviders).toEqual(
      new Set(downProviders),
    );
  }

  test('triggers fallback on content-policy moderation session.error', () =>
    expectErrorFallback(
      403,
      'Forbidden',
      '{"error":{"code":403,"message":"This content was flagged for possible cybersecurity risk."}}',
    ));

  test('routes the documented Z.ai quoted 1301 code as a request rejection', () =>
    expectErrorFallback(400, 'Bad Request', '{"error":{"code":"1301"}}'));

  test('routes the documented Z.ai rejection wording as a request rejection', () =>
    expectErrorFallback(
      400,
      'Bad Request',
      '{"error":{"message":"System detected potentially unsafe or sensitive content in input or generation. Please avoid using prompts that may generate sensitive content. Thank you for your cooperation."}}',
    ));

  test('routes the documented Kimi content filter as a request rejection', () =>
    expectErrorFallback(
      400,
      'Bad Request',
      '{"error":{"type":"content_filter","message":"The request was rejected because it was considered high risk"}}',
    ));

  test('routes the documented Qwen DataInspectionFailed code as a request rejection', () =>
    expectErrorFallback(400, 'Bad Request', '{"code":"DataInspectionFailed"}'));

  test('routes the documented Qwen data_inspection_failed code as a request rejection', () =>
    expectErrorFallback(
      400,
      'Bad Request',
      '{"code":"data_inspection_failed"}',
    ));

  test('routes the documented Qwen rejection wording as a request rejection', () =>
    expectErrorFallback(
      400,
      'Bad Request',
      '{"message":"Input or output data may contain inappropriate content."}',
    ));

  test('routes the documented Mistral guardrail block as a request rejection', () =>
    expectErrorFallback(
      403,
      'Forbidden',
      '{"error":{"message":"Content blocked by guardrail","status":403}}',
    ));

  test('routes the documented OpenRouter flagged_input as a request rejection', () =>
    expectErrorFallback(
      403,
      'Forbidden',
      '{"error":{"code":403,"message":"Forbidden","metadata":{"flagged_input":"input"}}}',
    ));

  test('routes the documented OpenRouter error_type refusal as a request rejection', () =>
    expectErrorFallback(
      403,
      'Forbidden',
      '{"error":{"code":403,"message":"The provider refused to respond","metadata":{"error_type": "refusal"}}}',
    ));

  test('routes the documented Xiaomi HTTP 421 as a request rejection', () =>
    expectErrorFallback(
      421,
      'Misdirected Request',
      '{"error":{"message":"Content moderation and blocking"}}',
    ));

  test('routes the documented StepFun HTTP 451 as a request rejection', () =>
    expectErrorFallback(
      451,
      'Unavailable For Legal Reasons',
      '{"error":{"message":"请求内容或者响应内容未审核通过"}}',
    ));

  test('keeps the documented Qwen moderation service failure provider-scoped', () =>
    expectErrorFallback(
      500,
      'Internal Server Error',
      '{"code":"InternalError.DataInspection","message":"Content moderation service unavailable."}',
      ['anthropic'],
    ));

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
        isEligible: () => true,
        prepare: (
          sessionID: string,
          generation: number | undefined,
          baseline: string | undefined,
        ) => {
          calls.prepare.push([sessionID, generation, baseline]);
          return true;
        },
        admit: (
          sessionID: string,
          generation: number | undefined,
          _notice?: FallbackNotice,
        ) => {
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
    messageData?: unknown;
    handoff?: ReturnType<typeof handoffMock>['handoff'];
    readBackgroundGeneration?: (sessionID: string) => number | undefined;
    modelChanged?: () => void;
  }) {
    ({ mocks } = createMockClient({
      promptAsyncImpl: options?.promptAsyncImpl,
      abortImpl: options?.abortImpl,
      messagesData: options?.messagesData,
      messageData: options?.messageData,
    }));
    mgr = new ForegroundFallbackManager(
      makeChains(),
      true,
      { directory: '/test', hostFlavor: options?.v2 ? 'v2' : undefined } as any,
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

  test('retry-path fallback admits without a notice', async () => {
    jest.useFakeTimers();
    const { handoff } = handoffMock();
    const admit = spyOn(handoff, 'admit');
    ({ mocks } = createMockClient({ messagesData: taskPrompt }));
    mgr = new ForegroundFallbackManager(
      { orchestrator: ['test/a', 'test/b', 'test/c'] },
      true,
      { directory: '/test' } as never,
      0,
      undefined,
      undefined,
      0,
      0,
      handoff,
      () => 1,
    );
    try {
      await mgr.handleEvent(redoEvents.assistant('retry-notice'));
      await mgr.handleEvent(redoEvents.retry('retry-notice'));
      expect(mocks.abort).toHaveBeenCalledTimes(1);
      expect(admit).toHaveBeenCalledTimes(1);
      expect(admit.mock.calls[0]?.[2]).toBeUndefined();
    } finally {
      mgr.dispose();
      admit.mockRestore();
      jest.useRealTimers();
    }
  });

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

  test('a turn longer than the tail replays its parent user message without a full read', async () => {
    const { calls, handoff } = handoffMock();
    const mocks = await runFallbackScenario({
      handoff,
      messagesData: [
        { info: { id: 'm2', role: 'assistant', parentID: 'm1' }, parts: [] },
      ],
      messageData: taskPrompt[0],
    });

    expect(mocks.messages).toHaveBeenCalledTimes(1);
    expect(mocks.message.mock.calls[0]?.[0]).toMatchObject({
      path: { id: 'sess-1', messageID: 'm1' },
    });
    const call = mocks.promptAsync.mock.calls[0] as [
      { body: { parts: Array<{ text?: string }> } },
    ];
    expect(call[0].body.parts[0]?.text).toBe('task prompt');
    expect(calls.prepare).toEqual([['sess-1', undefined, 'm2']]);
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
        isEligible: () => false,
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

  test('content-filter finish triggers fallback and dedupes its later error', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);
    const sessionID = 'sess-content-filter-finish';
    const messageID = 'assistant-content-filter';
    const contentFilterError = {
      name: 'ContentFilterError',
      data: {
        message: "The response was blocked by the provider's content filter",
      },
    };

    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: messageID,
          sessionID,
          agent: 'orchestrator',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
          finish: 'content-filter',
          time: { created: 1, completed: 2 },
        },
      },
    });
    await mgr.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: messageID,
          sessionID,
          agent: 'orchestrator',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
          role: 'assistant',
          error: contentFilterError,
          time: { created: 1, completed: 2 },
        },
      },
    });
    await mgr.handleEvent({
      type: 'session.error',
      properties: {
        sessionID,
        error: contentFilterError,
      },
    });

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect((mgr as any).sessionModel.get(sessionID)).toBe('openai/gpt-4o');
  });

  describe('unknown finish streak', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(1_015_000);
    });
    afterEach(() => jest.useRealTimers());

    const info = {
      id: 'msgUnknownFinish',
      sessionID: 'sess-unknown-finish',
      parentID: 'msgUser',
      role: 'assistant',
      agent: 'orchestrator',
      providerID: 'anthropic',
      modelID: 'claude-opus-4-5',
      finish: 'unknown',
      tokens: {
        input: 30_000,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: { created: 1_000_000, completed: 1_015_000 },
    };
    const message = {
      info,
      parts: [
        { type: 'step-start' },
        {
          type: 'reasoning',
          text: '',
          time: { start: info.time.created, end: info.time.completed },
        },
        { type: 'text', text: 'Gateway notice.' },
        {
          type: 'step-finish',
          reason: 'unknown',
          cost: 0,
          tokens: info.tokens,
        },
      ].map((part, index) => ({
        ...part,
        id: `prtUnknown${index}`,
        sessionID: info.sessionID,
        messageID: info.id,
      })),
    };

    async function update(
      mgr: ForegroundFallbackManager,
      mocks: ReturnType<typeof createMockClient>['mocks'],
      id: string,
      finish: 'unknown' | 'stop' = 'unknown',
      parts: Array<{ type: string } & Record<string, unknown>> = message.parts,
    ) {
      const updatedInfo = { ...info, id, finish };
      mocks.message.mockImplementation(async () => ({
        data: {
          info: updatedInfo,
          parts: parts.map((part, index) => ({
            ...part,
            id: `prt${id}${index}`,
            sessionID: info.sessionID,
            messageID: id,
            ...(part.type === 'step-finish' ? { reason: finish } : {}),
          })),
        },
      }));
      await mgr.handleEvent({
        type: 'message.updated',
        properties: { info: updatedInfo },
      });
    }

    function updateBackup(
      mgr: ForegroundFallbackManager,
      mocks: ReturnType<typeof createMockClient>['mocks'],
      id: string,
    ) {
      const updatedInfo = {
        ...info,
        id,
        providerID: 'openai',
        modelID: 'gpt-4o',
      };
      mocks.message.mockImplementation(async () => ({
        data: { ...message, info: updatedInfo },
      }));
      return mgr.handleEvent({
        type: 'message.updated',
        properties: { info: updatedInfo },
      });
    }

    test('three distinct tool-free messages abort once and preserve retries', async () => {
      const calls: string[] = [];
      const { mocks } = createMockClient({
        abortImpl: async () => {
          calls.push('abort');
          return { data: true };
        },
        promptAsyncImpl: async () => {
          calls.push('replay');
          return {};
        },
      });
      const mgr = new ForegroundFallbackManager(makeChains(), true, {
        directory: '/test',
      } as never);
      await mgr.handleEvent(redoEvents.retry(info.sessionID));
      expect((mgr as any).sessionRetries.get(info.sessionID)).toBe(1);

      await update(mgr, mocks, 'msgUnknown1');
      await update(mgr, mocks, 'msgUnknown1');
      expect(mocks.abort).not.toHaveBeenCalled();
      expect(mocks.promptAsync).not.toHaveBeenCalled();
      expect((mgr as any).sessionRetries.get(info.sessionID)).toBe(1);

      jest.setSystemTime(1_030_000);
      await update(mgr, mocks, 'msgUnknown2');
      mocks.message.mockImplementation(async () => ({
        error: { name: 'NotFoundError' },
      }));
      await mgr.handleEvent({
        type: 'message.updated',
        properties: { info: { ...info, id: 'msgUnreadable' } },
      });
      expect(mocks.abort).not.toHaveBeenCalled();
      expect(mocks.promptAsync).not.toHaveBeenCalled();

      jest.setSystemTime(1_045_000);
      await update(mgr, mocks, 'msgUnknown3');
      jest.setSystemTime(1_060_000);
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            ...info,
            id: 'msgUnknown4',
            providerID: 'openai',
            modelID: 'gpt-4o',
          },
        },
      });

      expect((mgr as any).sessionRetries.get(info.sessionID)).toBe(1);
      expect(calls).toEqual(['abort', 'replay']);
      expect(mocks.abort).toHaveBeenCalledTimes(1);
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
      expect(mocks.message).toHaveBeenCalledWith({
        path: { id: info.sessionID, messageID: 'msgUnknown3' },
      });
      expect(mocks.promptAsync.mock.calls[0]?.[0]).toMatchObject({
        body: { model: { providerID: 'openai', modelID: 'gpt-4o' } },
      });
      expect(mgr.getActiveFallback(info.sessionID)).toEqual({
        model: 'openai/gpt-4o',
        downProviders: new Set(),
      });
      expect((mgr as any).sessionTried.get(info.sessionID)).toEqual(
        new Set(['anthropic/claude-opus-4-5', 'openai/gpt-4o']),
      );
      expect((mgr as any).sessionModel.get(info.sessionID)).toBe(
        'openai/gpt-4o',
      );
    });

    test('a tool-bearing message breaks the streak', async () => {
      const { mocks } = createMockClient();
      const mgr = new ForegroundFallbackManager(makeChains(), true, {
        directory: '/test',
      } as never);

      await update(mgr, mocks, 'msgUnknown0');
      const partsRead = deferred<{ data: typeof message }>();
      mocks.message.mockImplementationOnce(() => partsRead.promise);
      const pending = mgr.handleEvent({
        type: 'message.updated',
        properties: { info: { ...info, id: 'msgUnknown1' } },
      });
      await update(mgr, mocks, 'msgUnknown2', 'unknown', [
        ...message.parts.slice(0, -1),
        {
          type: 'tool',
          callID: 'callUnknown',
          tool: 'read',
          state: {
            status: 'completed',
            input: { filePath: 'README.md' },
            output: 'README',
            title: 'README.md',
            metadata: {},
            time: { start: 1_002_000, end: 1_005_000 },
          },
        },
        ...message.parts.slice(-1),
      ]);
      partsRead.resolve({
        data: { ...message, info: { ...info, id: 'msgUnknown1' } },
      });
      await pending;
      await update(mgr, mocks, 'msgUnknown3');
      await update(mgr, mocks, 'msgUnknown4');

      expect(mocks.abort).not.toHaveBeenCalled();
      expect(mocks.promptAsync).not.toHaveBeenCalled();
      expect(mgr.getActiveFallback(info.sessionID)).toBeUndefined();
    });

    test('completed or errored messages and new turns break the streak', async () => {
      const { mocks } = createMockClient();
      const mgr = new ForegroundFallbackManager(makeChains(), true, {
        directory: '/test',
      } as never);

      await update(mgr, mocks, 'msgUnknown1');
      await update(mgr, mocks, 'msgUnknown2');
      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msgErrored',
            sessionID: info.sessionID,
            role: 'assistant',
            error: {
              name: 'APIError',
              data: { statusCode: 400, message: 'Bad Request' },
            },
            time: { created: 1_015_000, completed: 1_016_000 },
          },
        },
      });
      await update(mgr, mocks, 'msgUnknownAfterError');
      expect(mocks.abort).not.toHaveBeenCalled();
      expect(mocks.promptAsync).not.toHaveBeenCalled();

      await update(mgr, mocks, 'msgStop', 'stop');
      await update(mgr, mocks, 'msgUnknown3');
      await update(mgr, mocks, 'msgUnknown4');
      await mgr.handleEvent(redoEvents.user(info.sessionID, 'msgUser2'));
      await update(mgr, mocks, 'msgUnknown5');

      expect(mocks.abort).not.toHaveBeenCalled();
      expect(mocks.promptAsync).not.toHaveBeenCalled();
      expect(mgr.getActiveFallback(info.sessionID)).toBeUndefined();
    });

    test('a failover without an errored message starts a fresh streak on the backup', async () => {
      const { manager: mgr, mocks } = makeManager({
        chain: makeChains().orchestrator,
      });
      await update(mgr, mocks, 'msgUnknown1');
      await update(mgr, mocks, 'msgUnknown2');
      await mgr.handleEvent({
        type: 'session.error',
        properties: {
          sessionID: info.sessionID,
          error: {
            name: 'UnknownError',
            data: { message: 'Model not found: anthropic/claude-opus-4-5.' },
          },
        },
      });
      expect(mgr.getActiveFallback(info.sessionID)?.model).toBe(
        'openai/gpt-4o',
      );
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
      expect(mocks.abort).not.toHaveBeenCalled();

      await updateBackup(mgr, mocks, 'msgBackup1');
      expect(mocks.abort).not.toHaveBeenCalled();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
      await updateBackup(mgr, mocks, 'msgBackup2');
      expect(mocks.abort).not.toHaveBeenCalled();
      expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
      await updateBackup(mgr, mocks, 'msgBackup3');
      expect(mocks.abort).toHaveBeenCalledTimes(1);
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
      expect(mocks.promptAsync.mock.calls[1]?.[0]).toMatchObject({
        body: { model: { providerID: 'google', modelID: 'gemini-2.5-pro' } },
      });
    });

    test('a reply read across a failover does not count against the backup', async () => {
      const { manager: mgr, mocks } = makeManager({
        chain: makeChains().orchestrator,
      });
      await update(mgr, mocks, 'msgUnknown1');
      await update(mgr, mocks, 'msgUnknown2');
      const partsRead = deferred<{ data: typeof message }>();
      mocks.message.mockImplementationOnce(() => partsRead.promise);
      const pending = mgr.handleEvent({
        type: 'message.updated',
        properties: { info: { ...info, id: 'msgUnknown3' } },
      });
      await update(mgr, mocks, 'msgUnknown4');
      expect(mocks.abort).toHaveBeenCalledTimes(1);
      expect(mgr.getActiveFallback(info.sessionID)?.model).toBe(
        'openai/gpt-4o',
      );

      await mgr.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            ...info,
            id: 'msgUnknown5',
            finish: undefined,
            error: {
              name: 'MessageAbortedError',
              data: { message: 'aborted' },
            },
          },
        },
      });
      partsRead.resolve({
        data: { ...message, info: { ...info, id: 'msgUnknown3' } },
      });
      await pending;

      await updateBackup(mgr, mocks, 'msgBackup1');
      await updateBackup(mgr, mocks, 'msgBackup2');
      expect(mocks.abort).toHaveBeenCalledTimes(1);
      await updateBackup(mgr, mocks, 'msgBackup3');
      expect(mocks.abort).toHaveBeenCalledTimes(2);
      expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    });
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
    handoff?: ConstructorParameters<typeof ForegroundFallbackManager>[8],
    readGeneration?: (id: string) => number | undefined,
  ) =>
    new ForegroundFallbackManager(
      chain,
      true,
      { directory: '/test', hostFlavor } as any,
      0, // Exercise abort/handoff guards on the first host retry.
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
    await mgr.handleEvent(retry('sess-parent', 1));
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
        isEligible: () => true,
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
        isEligible: () => true,
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

  test('permanent quota error skips the host retry budget', async () => {
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
          sessionID: 'sess-retry-permanent',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5',
        },
      },
    });

    await mgr.handleEvent({
      type: 'session.status',
      properties: {
        sessionID: 'sess-retry-permanent',
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
    ); // No host retries: test the model-change guard directly.

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
  test('ignores a second trigger within dedup window for same session', async () => {
    const { mocks } = createMockClient();
    const mgr = new ForegroundFallbackManager(makeChains(), true, {
      directory: '/test',
    } as any);

    const event = {
      type: 'session.error',
      properties: {
        sessionID: 'sess-dup',
        info: { id: 'failed-message' },
        error: { message: 'rate limit exceeded' },
      },
    };

    await mgr.handleEvent(event);
    await mgr.handleEvent(event); // immediate second trigger - should be deduped

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
  });

  test('distinct failure incidents on the same turn and model are not time-deduped', async () => {
    const { mocks } = createMockClient({
      promptAsyncImpl: async () => ({
        data: { error: { message: 'replay admission rejected' } },
      }),
    });
    const mgr = new ForegroundFallbackManager(
      { orchestrator: ['test/a', 'test/b', 'test/c'] },
      true,
      { directory: '/test' } as any,
    );
    const errorEvent = (incidentID: string) => ({
      type: 'session.error',
      properties: {
        sessionID: 'same-model-incidents',
        info: { id: incidentID },
        error: { message: 'rate limit' },
      },
    });

    await mgr.handleEvent(redoEvents.assistant('same-model-incidents'));
    await mgr.handleEvent(errorEvent('failure-one'));
    await mgr.handleEvent(errorEvent('failure-two'));

    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
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
      makeChains(),
      true,
      createMockClient().client,
    );
    const replacement = new ForegroundFallbackManager(
      makeChains(),
      true,
      createMockClient().client,
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
    // oracle has no configured chain; without the fix resolveChain would
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
      { orchestrator: ['openai/gpt-6', 'new-api/glm-5.2'] },
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

// ---------------------------------------------------------------------------
