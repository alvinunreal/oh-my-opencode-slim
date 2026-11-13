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
  error: (
    sessionID: string,
    error: unknown = { message: 'rate limit' },
    messageID = `assistant-${sessionID}-a`,
  ) => ({
    type: 'session.error',
    properties: { sessionID, info: { id: messageID }, error },
  }),
};

function createTestClock(start = 1_000_000) {
  const harness = createTimerHarness();
  return {
    timers: {
      now: () => start + harness.now(),
      setTimeout: harness.setTimeout,
      clearTimeout: harness.clearTimeout,
    },
    harness,
  };
}

let clock: ForegroundFallbackTimers;
let harness: ReturnType<typeof createTestClock>['harness'];
beforeEach(() => {
  ({ timers: clock, harness } = createTestClock());
});

describe('foreground fallback replay routing', () => {
  test('decision trace: an abandoned head provider is skipped', async () => {
    const onChanged = mock((_sessionID: string, _model: string) => {});
    const { mocks } = createMockClient();
    const manager = new ForegroundFallbackManager({
      chains: {
        orchestrator: ['primary/a', 'backup/b'],
        explorer: ['primary/head', 'backup/child'],
      },
      enabled: true,
      input: { directory: '/test' } as never,
      maxRetries: 0,
      onSessionModelChanged: onChanged,
      timers: clock,
    });
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

  test('contract: decision trace: a same-ID error from a new turn replays', async () => {
    const { mocks } = createMockClient();
    const manager = new ForegroundFallbackManager({
      chains: { orchestrator: ['primary/a', 'backup/b'] },
      enabled: true,
      input: { directory: '/test' } as never,
      maxRetries: 3,
      timers: clock,
    });
    const sessionID = 'decision-trace-cross-turn';
    manager.registerSessionAgent(sessionID, 'orchestrator');
    await manager.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          role: 'assistant',
          agent: 'orchestrator',
          providerID: 'primary',
          modelID: 'a',
        },
      },
    });
    await manager.handleEvent(
      redoEvents.error(sessionID, { message: 'rate limit' }, 'shared-id'),
    );
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);

    // New external prompt with the same incident ID, still inside the dedup
    // window. It bumps the turn epoch without clearing incidents, so the
    // turn check in isDeduped is what lets the replay through.
    manager.observeExternalPromptIntent(sessionID, 'user-2');
    const second = manager.handleEvent(
      redoEvents.error(sessionID, { message: 'rate limit' }, 'shared-id'),
    );
    await harness.advance(2_000);
    await second;
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
  });

  test('contract: decision trace: a no-chain retry from a new turn charges the budget', async () => {
    const { mocks } = createMockClient();
    const manager = new ForegroundFallbackManager({
      chains: { orchestrator: ['primary/a', 'backup/b'] },
      enabled: true,
      input: { directory: '/test' } as never,
      maxRetries: 3,
      timers: clock,
    });
    const sessionID = 'decision-trace-no-chain';
    manager.registerSessionAgent(sessionID, 'bare');
    await manager.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          role: 'assistant',
          agent: 'bare',
          providerID: 'primary',
          modelID: 'a',
        },
      },
    });
    await manager.handleEvent(
      redoEvents.error(sessionID, { message: 'rate limit' }, 'shared-id'),
    );
    const before = mocks.promptAsync.mock.calls.length;
    expect((manager as any).sessionRetries.get(sessionID)).toBe(1);
    manager.observeExternalPromptIntent(sessionID, 'user-2');
    const retry = manager.handleEvent({
      type: 'session.status',
      properties: {
        sessionID,
        status: { type: 'retry', attempt: 1, message: 'rate limit' },
      },
    });
    await harness.advance(2_000);
    await retry;
    expect(mocks.promptAsync.mock.calls.length).toBe(before);
    expect((manager as any).sessionRetries.get(sessionID)).toBe(2);
  });

  test('decision trace: a same-ID error after the dedup window replays in the same turn', async () => {
    const { mocks } = createMockClient();
    const manager = new ForegroundFallbackManager({
      chains: { orchestrator: ['primary/a', 'backup/b'] },
      enabled: true,
      input: { directory: '/test' } as never,
      maxRetries: 3,
      timers: clock,
    });
    const sessionID = 'decision-trace-window';
    manager.registerSessionAgent(sessionID, 'orchestrator');
    await manager.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          role: 'assistant',
          agent: 'orchestrator',
          providerID: 'primary',
          modelID: 'a',
        },
      },
    });
    const first = manager.handleEvent(
      redoEvents.error(sessionID, { message: 'rate limit' }, 'shared-id'),
    );
    await harness.advance(2_000);
    await first;
    expect(mocks.promptAsync).toHaveBeenCalledTimes(1);
    // Move past the 5s window; the same incident ID must now replay.
    await harness.advance(3_000);
    const second = manager.handleEvent(
      redoEvents.error(sessionID, { message: 'rate limit' }, 'shared-id'),
    );
    await harness.advance(2_000);
    await second;
    expect(mocks.promptAsync).toHaveBeenCalledTimes(2);
  });

  test('decision trace: a no-chain retry after the dedup window charges the budget', async () => {
    createMockClient();
    const manager = new ForegroundFallbackManager({
      chains: { orchestrator: ['primary/a', 'backup/b'] },
      enabled: true,
      input: { directory: '/test' } as never,
      maxRetries: 3,
      timers: clock,
    });
    const sessionID = 'decision-trace-no-chain-window';
    manager.registerSessionAgent(sessionID, 'bare');
    await manager.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID,
          role: 'assistant',
          agent: 'bare',
          providerID: 'primary',
          modelID: 'a',
        },
      },
    });
    await manager.handleEvent(
      redoEvents.error(sessionID, { message: 'rate limit' }, 'shared-id'),
    );
    expect((manager as any).sessionRetries.get(sessionID)).toBe(1);
    // Same turn, same model, but past the 5s window: the incident is stale.
    await harness.advance(5_000);
    const retry = manager.handleEvent({
      type: 'session.status',
      properties: {
        sessionID,
        status: { type: 'retry', attempt: 1, message: 'rate limit' },
      },
    });
    await harness.advance(2_000);
    await retry;
    expect((manager as any).sessionRetries.get(sessionID)).toBe(2);
  });
});
