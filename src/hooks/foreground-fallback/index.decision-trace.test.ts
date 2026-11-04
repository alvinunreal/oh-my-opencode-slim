import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createTimerHarness } from '../../utils/test-timers';
import {
  ForegroundFallbackManager,
  type ForegroundFallbackTimers,
} from './index';

let currentMockSession: Record<string, unknown> | null = null;

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

afterEach(() => {
  currentMockSession = null;
  const globalSet = (globalThis as Record<symbol, Set<string>>)[
    Symbol.for('oh-my-opencode-slim.foreground-fallback.in-progress')
  ];
  globalSet?.clear();
});

function createMockClient() {
  const promptAsync = mock(async (_args: unknown) => ({}));
  const abort = mock(async () => ({}));
  const messages = mock(async (_args: unknown) => ({
    data: [
      {
        info: { id: 'user-message', role: 'user' },
        parts: [{ type: 'text', text: 'hello' }],
      },
    ],
  }));
  const session: Record<string, unknown> = {
    get: mock(async (args: { path: { id: string } }) => ({
      data: { id: args.path.id, agent: 'orchestrator' },
    })),
    abort,
    messages,
    promptAsync,
  };

  currentMockSession = session;
  installGetClientMock();

  return { mocks: { promptAsync, abort, messages } };
}

const redoEvents = {
  assistant: (sessionID: string, modelID = 'a') => ({
    type: 'message.updated',
    properties: {
      info: {
        id: `assistant-${sessionID}-${modelID}`,
        sessionID,
        role: 'assistant',
        agent: 'orchestrator',
        providerID: 'test',
        modelID,
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
};

function createTestClock(start = 1_000_000): ForegroundFallbackTimers {
  const harness = createTimerHarness();
  const now = start;
  return {
    now: () => now,
    setTimeout: harness.setTimeout,
    clearTimeout: harness.clearTimeout,
  };
}

let clock: ForegroundFallbackTimers;
beforeEach(() => {
  clock = createTestClock();
});

function timedManager(
  ...args: ConstructorParameters<typeof ForegroundFallbackManager>
) {
  const wired: unknown[] = [...args];
  while (wired.length < 12) wired.push(undefined);
  wired.push(clock);
  return new ForegroundFallbackManager(
    ...(wired as unknown as ConstructorParameters<
      typeof ForegroundFallbackManager
    >),
  );
}

function makeManager({
  chain = ['test/a', 'test/b', 'test/c'],
  maxRetries = 3,
  onChanged,
}: {
  chain?: ReadonlyArray<string | { id: string; variant?: string }>;
  maxRetries?: number;
  onChanged?: (sessionID: string, model: string) => void;
} = {}) {
  const { mocks } = createMockClient();
  return {
    manager: new ForegroundFallbackManager(
      { orchestrator: chain },
      true,
      { directory: '/test' } as never,
      maxRetries,
      undefined,
      onChanged,
      0,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      clock,
    ),
    mocks,
  };
}

describe('foreground fallback replay routing', () => {
  test('decision trace: no-chain session retries without switching models', async () => {
    const onChanged = mock((_sessionID: string, _model: string) => {});
    const { manager, mocks } = makeManager({ onChanged });
    const sessionID = 'decision-trace-no-chain';
    manager.registerSessionAgent(sessionID, 'councillor');
    await manager.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          agent: 'councillor',
          providerID: 'test',
          modelID: 'a',
        },
      },
    });

    await manager.handleEvent(
      redoEvents.error(sessionID, { message: 'rate limit' }, 'failure-1'),
    );

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  test('decision trace: a healthy chain head receives the replay', async () => {
    const onChanged = mock((_sessionID: string, _model: string) => {});
    const { manager, mocks } = makeManager({
      chain: ['healthy/head', 'backup/next'],
      onChanged,
    });
    const sessionID = 'decision-trace-healthy-head';
    manager.registerSessionAgent(sessionID, 'orchestrator');
    await manager.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          role: 'assistant',
          agent: 'orchestrator',
          providerID: 'outside',
          modelID: 'current',
        },
      },
    });

    await manager.handleEvent(
      redoEvents.error(sessionID, { message: 'rate limit' }, 'failure-1'),
    );

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith(sessionID, 'healthy/head');
  });

  test('decision trace: an abandoned head provider is skipped', async () => {
    const onChanged = mock((_sessionID: string, _model: string) => {});
    const { mocks } = createMockClient();
    const manager = timedManager(
      {
        orchestrator: ['primary/a', 'backup/b'],
        explorer: ['primary/head', 'backup/child'],
      },
      true,
      { directory: '/test' } as never,
      0,
      undefined,
      onChanged,
    );
    const parentID = 'decision-trace-parent';
    const childID = 'decision-trace-child';
    manager.registerSessionAgent(parentID, 'orchestrator');
    await manager.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: parentID,
          role: 'assistant',
          agent: 'orchestrator',
          providerID: 'primary',
          modelID: 'a',
        },
      },
    });
    await manager.handleEvent(
      redoEvents.error(parentID, { message: 'rate limit' }, 'parent-failure'),
    );
    await manager.handleEvent({
      type: 'session.created',
      properties: { info: { id: childID, parentID } },
    });
    manager.registerSessionAgent(childID, 'explorer');
    await manager.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: childID,
          role: 'assistant',
          agent: 'explorer',
          providerID: 'outside',
          modelID: 'current',
        },
      },
    });

    await manager.handleEvent(
      redoEvents.error(childID, { message: 'rate limit' }, 'child-failure'),
    );

    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledWith(childID, 'backup/child');
  });

  test('decision trace: exhausted retry budget switches to the fallback', async () => {
    const onChanged = mock((_sessionID: string, _model: string) => {});
    const { manager, mocks } = makeManager({
      chain: ['test/a', 'backup/b'],
      maxRetries: 1,
      onChanged,
    });
    const sessionID = 'decision-trace-retry-budget';
    manager.registerSessionAgent(sessionID, 'orchestrator');
    await manager.handleEvent(redoEvents.assistant(sessionID));
    await manager.handleEvent(redoEvents.retry(sessionID, 1));
    expect(mocks.promptAsync).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();

    await manager.handleEvent(redoEvents.retry(sessionID, 2));

    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith(sessionID, 'backup/b');
  });
});
