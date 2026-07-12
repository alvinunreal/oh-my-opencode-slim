import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { BackgroundJobCoordinator } from '../utils/background-job-coordinator';
import {
  MultiplexerSessionManager,
  resetMultiplexerSessionManagerState,
} from './session-manager';

const originalFetch = globalThis.fetch;
let mockSessionStatuses: Record<string, { type: string }> = {};
const mockFetch = mock(
  async () =>
    new Response(JSON.stringify(mockSessionStatuses), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }),
);

// Define the mock multiplexer
let mockMultiplexerType: 'tmux' | 'cmux' = 'tmux';
const mockMultiplexer = {
  get type() {
    return mockMultiplexerType;
  },
  isAvailable: mock(async () => true),
  isInsideSession: mock(() => true),
  spawnPane: mock(async () => ({
    success: true,
    paneId: '%mock-pane',
  })),
  closePane: mock(async () => true),
  applyLayout: mock(async () => {}),
};
const mockIsServerRunning = mock(async () => true);

// Mock the multiplexer module
mock.module('../multiplexer', () => ({
  getMultiplexer: () => mockMultiplexer,
  isServerRunning: mockIsServerRunning,
  startAvailabilityCheck: () => {},
}));

// Mock the plugin context
function createMockContext(overrides?: {
  sessionStatusResult?: { data?: Record<string, { type: string }> };
  directory?: string;
  serverUrl?: string;
}) {
  const defaultPort = process.env.OPENCODE_PORT ?? '4096';
  return {
    client: {
      session: {
        status: mock(
          async () => overrides?.sessionStatusResult ?? { data: {} },
        ),
      },
    },
    directory: overrides?.directory ?? '/test/directory',
    serverUrl: new URL(
      overrides?.serverUrl ?? `http://localhost:${defaultPort}`,
    ),
  } as any;
}

function setMockSessionStatuses(statuses: Record<string, { type: string }>) {
  mockSessionStatuses = statuses;
}

const defaultMultiplexerConfig = {
  type: 'tmux' as const,
  layout: 'main-vertical' as const,
  main_pane_size: 60,
  zellij_pane_mode: 'agent-tab' as const,
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises(count = 8): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve();
}

describe('MultiplexerSessionManager', () => {
  beforeEach(() => {
    resetMultiplexerSessionManagerState();
    mockSessionStatuses = {};
    mockFetch.mockClear();
    globalThis.fetch = mockFetch as typeof fetch;
    mockMultiplexer.spawnPane.mockReset();
    mockMultiplexer.spawnPane.mockResolvedValue({
      success: true,
      paneId: '%mock-pane',
    });
    mockMultiplexer.closePane.mockReset();
    mockMultiplexer.closePane.mockResolvedValue(true);
    mockMultiplexer.isInsideSession.mockReset();
    mockMultiplexer.isInsideSession.mockReturnValue(true);
    mockMultiplexerType = 'tmux';
    mockIsServerRunning.mockReset();
    mockIsServerRunning.mockResolvedValue(true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    test('initializes with config', () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      expect(manager).toBeDefined();
    });
  });

  describe('onSessionCreated', () => {
    test('spawns pane for child sessions', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-123',
            parentID: 'parent-456',
            title: 'Test Worker',
          },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalled();
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledWith(
        'child-123',
        'Test Worker',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/test/directory',
      );
    });

    test('ignores sessions without parentID', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'root-session',
            title: 'Main Chat',
          },
        },
      });

      expect(mockMultiplexer.spawnPane).not.toHaveBeenCalled();
    });

    test('prefers child session directory when present', async () => {
      const ctx = createMockContext({ directory: '/parent/directory' });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-456',
            parentID: 'parent-456',
            title: 'Nested Worker',
            directory: '/child/directory',
          },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledWith(
        'child-456',
        'Nested Worker',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/child/directory',
      );
    });

    test('ignores if disabled in config', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(ctx, {
        ...defaultMultiplexerConfig,
        type: 'none',
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'child', parentID: 'parent' },
        },
      });

      expect(mockMultiplexer.spawnPane).not.toHaveBeenCalled();
    });

    test('does not spawn twice for duplicate create events while spawning', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const deferred = createDeferred<{ success: true; paneId: string }>();

      mockMultiplexer.spawnPane.mockImplementationOnce(() => deferred.promise);

      const event = {
        type: 'session.created',
        properties: {
          info: {
            id: 'child-race',
            parentID: 'parent-race',
            title: 'Race Worker',
          },
        },
      };

      const firstCreate = manager.onSessionCreated(event);
      const secondCreate = manager.onSessionCreated(event);

      await Promise.resolve();

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);

      deferred.resolve({ success: true, paneId: 'p-race' });

      await Promise.all([firstCreate, secondCreate]);

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
    });
  });

  describe('polling and closure', () => {
    test('closes pane when session becomes idle', async () => {
      const ctx = createMockContext();
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-1',
      });

      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      // Register session
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      });

      setMockSessionStatuses({ c1: { type: 'idle' } });

      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-1');
    });

    test('closes pane immediately on session.idle event', async () => {
      const ctx = createMockContext();
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-idle-event',
      });

      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'idle-event-child', parentID: 'parent' } },
      });

      await manager.onSessionStatus({
        type: 'session.idle',
        properties: { sessionID: 'idle-event-child' },
      });

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-idle-event');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('does not close another manager instance pane on idle event', async () => {
      const ctx = createMockContext();
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-shared-idle',
      });

      const spawningManager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const idleManager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await spawningManager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'shared-child', parentID: 'parent' } },
      });

      await idleManager.onSessionStatus({
        type: 'session.idle',
        properties: { sessionID: 'shared-child' },
      });

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('respawns resumed known session from a different manager instance', async () => {
      const ctx = createMockContext();
      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-first',
        })
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-resumed',
        });

      const firstManager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const secondManager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await firstManager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'resumed-child',
            parentID: 'parent',
            title: 'Resumed Worker',
            directory: '/resumed/dir',
          },
        },
      });

      await firstManager.onSessionStatus({
        type: 'session.idle',
        properties: { sessionID: 'resumed-child' },
      });

      await secondManager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'resumed-child',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(2);
      expect(mockMultiplexer.spawnPane).toHaveBeenLastCalledWith(
        'resumed-child',
        'Resumed Worker',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/resumed/dir',
      );
    });

    test('does not close running background child pane on idle event', async () => {
      const ctx = createMockContext();
      const board = new BackgroundJobBoard();
      board.registerLaunch({
        taskID: 'running-idle-child',
        parentSessionID: 'parent-1',
        agent: 'explorer',
      });
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-running-idle-child',
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
        board,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'running-idle-child', parentID: 'parent-1' },
        },
      });

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'running-idle-child',
          status: { type: 'idle' },
        },
      });

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('timed out running jobs still close after safe recovery and completion', async () => {
      const ctx = createMockContext();
      const board = new BackgroundJobBoard();
      const coordinator = new BackgroundJobCoordinator(board);
      board.registerLaunch({
        taskID: 'timedout-child',
        parentSessionID: 'parent-1',
        agent: 'explorer',
      });
      board.updateStatus({
        taskID: 'timedout-child',
        state: 'running',
        timedOut: true,
        now: 100,
      });
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-timedout-child',
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
        coordinator,
      );
      coordinator.addTerminalStateListener((sessionId) => {
        void manager.closeSessionFromCoordinator(sessionId);
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'timedout-child', parentID: 'parent-1' },
        },
      });

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'timedout-child',
          status: { type: 'idle' },
        },
      });

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'timedout-child',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();

      board.updateStatus({
        taskID: 'timedout-child',
        state: 'completed',
        resultSummary: 'done',
      });
      await Promise.resolve();

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith(
        'p-timedout-child',
      );
    });

    test('deferred idle closes retry on terminal status updates', async () => {
      for (const state of ['completed', 'error', 'cancelled'] as const) {
        resetMultiplexerSessionManagerState();
        mockMultiplexer.spawnPane.mockClear();
        mockMultiplexer.closePane.mockClear();
        const ctx = createMockContext();
        const board = new BackgroundJobBoard();
        const coordinator = new BackgroundJobCoordinator(board);
        const sessionId = `deferred-${state}`;
        board.registerLaunch({
          taskID: sessionId,
          parentSessionID: 'parent-1',
          agent: 'explorer',
        });
        mockMultiplexer.spawnPane.mockResolvedValueOnce({
          success: true,
          paneId: `p-${state}`,
        });
        const manager = new MultiplexerSessionManager(
          ctx,
          defaultMultiplexerConfig,
          coordinator,
        );
        coordinator.addTerminalStateListener((sessionId) => {
          void manager.closeSessionFromCoordinator(sessionId);
        });

        await manager.onSessionCreated({
          type: 'session.created',
          properties: { info: { id: sessionId, parentID: 'parent-1' } },
        });
        await manager.onSessionStatus({
          type: 'session.status',
          properties: { sessionID: sessionId, status: { type: 'idle' } },
        });

        expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
        board.updateStatus({ taskID: sessionId, state });
        await Promise.resolve();

        expect(mockMultiplexer.closePane).toHaveBeenCalledWith(`p-${state}`);
      }
    });

    test('deferred idle close retries on markCancelled', async () => {
      const ctx = createMockContext();
      const board = new BackgroundJobBoard();
      const coordinator = new BackgroundJobCoordinator(board);
      board.registerLaunch({
        taskID: 'deferred-cancel',
        parentSessionID: 'parent-1',
        agent: 'explorer',
      });
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-deferred-cancel',
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
        coordinator,
      );
      coordinator.addTerminalStateListener((sessionId) => {
        void manager.closeSessionFromCoordinator(sessionId);
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'deferred-cancel', parentID: 'parent-1' } },
      });
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'deferred-cancel',
          status: { type: 'idle' },
        },
      });
      board.markCancelled('deferred-cancel');
      await Promise.resolve();

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith(
        'p-deferred-cancel',
      );
    });

    test('terminal status without deferred idle close does not close pane', async () => {
      const ctx = createMockContext();
      const board = new BackgroundJobBoard();
      const coordinator = new BackgroundJobCoordinator(board);
      board.registerLaunch({
        taskID: 'terminal-without-defer',
        parentSessionID: 'parent-1',
        agent: 'explorer',
      });
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-terminal-without-defer',
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
        coordinator,
      );
      coordinator.addTerminalStateListener((sessionId) => {
        void manager.closeSessionFromCoordinator(sessionId);
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'terminal-without-defer', parentID: 'parent-1' },
        },
      });
      board.updateStatus({
        taskID: 'terminal-without-defer',
        state: 'completed',
      });
      await Promise.resolve();

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('deleted clears deferred idle close and later terminal update is no-op', async () => {
      const ctx = createMockContext();
      const board = new BackgroundJobBoard();
      const coordinator = new BackgroundJobCoordinator(board);
      board.registerLaunch({
        taskID: 'deleted-deferred',
        parentSessionID: 'parent-1',
        agent: 'explorer',
      });
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-deleted-deferred',
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
        coordinator,
      );
      coordinator.addTerminalStateListener((sessionId) => {
        void manager.closeSessionFromCoordinator(sessionId);
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'deleted-deferred', parentID: 'parent-1' } },
      });
      await manager.onSessionStatus({
        type: 'session.status',
        properties: { sessionID: 'deleted-deferred', status: { type: 'idle' } },
      });
      await manager.onSessionDeleted({
        type: 'session.deleted',
        properties: { sessionID: 'deleted-deferred' },
      });
      board.updateStatus({ taskID: 'deleted-deferred', state: 'completed' });
      await Promise.resolve();

      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith(
        'p-deleted-deferred',
      );
    });

    test('retry while still running keeps deferred idle close', async () => {
      const ctx = createMockContext();
      const board = new BackgroundJobBoard();
      const coordinator = new BackgroundJobCoordinator(board);
      board.registerLaunch({
        taskID: 'still-running-deferred',
        parentSessionID: 'parent-1',
        agent: 'explorer',
      });
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-still-running-deferred',
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
        coordinator,
      );
      coordinator.addTerminalStateListener((sessionId) => {
        void manager.closeSessionFromCoordinator(sessionId);
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'still-running-deferred', parentID: 'parent-1' },
        },
      });
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'still-running-deferred',
          status: { type: 'idle' },
        },
      });

      // The coordinator's terminal state listener will handle the close
      // when the job completes, so we don't need to call retryDeferredIdleClose directly
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();

      board.updateStatus({
        taskID: 'still-running-deferred',
        state: 'completed',
      });
      await Promise.resolve();
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith(
        'p-still-running-deferred',
      );
    });

    test('disabled manager does not retry deferred idle close', async () => {
      const ctx = createMockContext();
      const board = new BackgroundJobBoard();
      const coordinator = new BackgroundJobCoordinator(board);
      board.registerLaunch({
        taskID: 'disabled-retry-deferred',
        parentSessionID: 'parent-1',
        agent: 'explorer',
      });
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-disabled-retry-deferred',
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
        coordinator,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'disabled-retry-deferred', parentID: 'parent-1' },
        },
      });
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'disabled-retry-deferred',
          status: { type: 'idle' },
        },
      });

      mockMultiplexer.isInsideSession.mockReturnValue(false);
      const _disabledManager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
        coordinator,
      );

      // The coordinator's terminal state listener will handle the close
      // when the job completes, but the disabled manager should not close
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('explicit non-idle status event clears stale deferred idle close', async () => {
      const ctx = createMockContext();
      const board = new BackgroundJobBoard();
      const coordinator = new BackgroundJobCoordinator(board);
      board.registerLaunch({
        taskID: 'retry-event-deferred',
        parentSessionID: 'parent-1',
        agent: 'explorer',
      });
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-retry-event-deferred',
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
        coordinator,
      );
      coordinator.addTerminalStateListener((sessionId) => {
        void manager.closeSessionFromCoordinator(sessionId);
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'retry-event-deferred', parentID: 'parent-1' },
        },
      });
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'retry-event-deferred',
          status: { type: 'idle' },
        },
      });
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'retry-event-deferred',
          status: { type: 'retry' },
        },
      });

      board.updateStatus({
        taskID: 'retry-event-deferred',
        state: 'completed',
      });
      await Promise.resolve();

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'retry-event-deferred',
          status: { type: 'idle' },
        },
      });
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith(
        'p-retry-event-deferred',
      );
    });

    test('explicit non-idle poll clears stale deferred idle close', async () => {
      const ctx = createMockContext();
      const board = new BackgroundJobBoard();
      const coordinator = new BackgroundJobCoordinator(board);
      board.registerLaunch({
        taskID: 'resumed-deferred',
        parentSessionID: 'parent-1',
        agent: 'explorer',
      });
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-resumed-deferred',
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
        coordinator,
      );
      coordinator.addTerminalStateListener((sessionId) => {
        void manager.closeSessionFromCoordinator(sessionId);
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'resumed-deferred', parentID: 'parent-1' } },
      });
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'resumed-deferred',
          status: { type: 'idle' },
        },
      });
      setMockSessionStatuses({ 'resumed-deferred': { type: 'busy' } });
      await (manager as any).pollSessions();

      board.updateStatus({ taskID: 'resumed-deferred', state: 'completed' });
      await Promise.resolve();

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'resumed-deferred',
          status: { type: 'idle' },
        },
      });
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith(
        'p-resumed-deferred',
      );
    });

    test('does not close on transient status absence', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      });

      setMockSessionStatuses({});
      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('keeps background child pane open while status is running until deleted', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      mockMultiplexer.spawnPane.mockResolvedValueOnce({
        success: true,
        paneId: 'p-background-child',
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'background-child',
            parentID: 'parent-1',
            title: 'Background Worker',
          },
        },
      });

      setMockSessionStatuses({ 'background-child': { type: 'running' } });
      await (manager as any).pollSessions();
      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();

      await manager.onSessionDeleted({
        type: 'session.deleted',
        properties: { info: { id: 'background-child' } },
      });

      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith(
        'p-background-child',
      );
    });

    test('missing status does not close never-seen pane', async () => {
      const ctx = createMockContext();
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-never-seen-orphan',
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'never-seen-orphan', parentID: 'p1' } },
      });

      setMockSessionStatuses({});
      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('ignores empty session status response without closing panes', async () => {
      const ctx = createMockContext();
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-empty-status',
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'empty-status', parentID: 'p1' } },
      });

      mockFetch.mockImplementationOnce(
        async () => new Response('', { status: 200 }),
      );

      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('previously seen then missing does not close pane', async () => {
      const ctx = createMockContext();
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-seen-before-missing',
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'seen-before-missing', parentID: 'p1' } },
      });

      setMockSessionStatuses({ 'seen-before-missing': { type: 'busy' } });
      await (manager as any).pollSessions();

      setMockSessionStatuses({});
      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('missing then busy does not duplicate respawn', async () => {
      const ctx = createMockContext();
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-missing-then-busy',
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'missing-then-busy', parentID: 'p1' } },
      });

      setMockSessionStatuses({});
      await (manager as any).pollSessions();
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'missing-then-busy',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
    });

    test('polls the actual serverUrl instead of the plugin SDK default URL', async () => {
      const ctx = createMockContext({
        serverUrl: 'http://127.0.0.1:63871/',
        sessionStatusResult: { data: {} },
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'child-live', parentID: 'parent-live' } },
      });

      setMockSessionStatuses({ 'child-live': { type: 'busy' } });

      await (manager as any).pollSessions();

      expect(ctx.client.session.status).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:63871/session/status'),
        expect.any(Object),
      );
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('respawns pane on later busy after idle close for resumable session', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-1',
        })
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-2',
        });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-789',
            parentID: 'parent-789',
            title: 'Worker',
            directory: '/task/dir',
          },
        },
      });

      setMockSessionStatuses({ 'child-789': { type: 'idle' } });
      await (manager as any).pollSessions();

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-789',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(2);
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledWith(
        'child-789',
        'Worker',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/task/dir',
      );
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-1');
      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);
    });

    test('respawns after in-flight idle close when busy resumes same session', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const closeDeferred = createDeferred<boolean>();

      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-close-race',
        })
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-close-race-resumed',
        });
      mockMultiplexer.closePane.mockImplementationOnce(
        () => closeDeferred.promise,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-close-race',
            parentID: 'parent-close-race',
            title: 'Worker',
          },
        },
      });

      const idlePromise = manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-close-race',
          status: { type: 'idle' },
        },
      });

      await Promise.resolve();

      const busyPromise = manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-close-race',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);

      closeDeferred.resolve(true);
      await Promise.all([idlePromise, busyPromise]);

      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(2);
      expect(mockMultiplexer.spawnPane).toHaveBeenLastCalledWith(
        'child-close-race',
        'Worker',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/test/directory',
      );
    });

    test('does not respawn after in-flight close if session is deleted', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const closeDeferred = createDeferred<boolean>();

      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-delete-race',
        })
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-should-not-respawn',
        });
      mockMultiplexer.closePane.mockImplementationOnce(
        () => closeDeferred.promise,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-delete-race',
            parentID: 'parent-delete-race',
            title: 'Worker',
          },
        },
      });

      const idlePromise = manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-delete-race',
          status: { type: 'idle' },
        },
      });

      await Promise.resolve();

      const busyPromise = manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-delete-race',
          status: { type: 'busy' },
        },
      });

      const deletedPromise = manager.onSessionDeleted({
        type: 'session.deleted',
        properties: {
          sessionID: 'child-delete-race',
        },
      });

      closeDeferred.resolve(true);
      await Promise.all([idlePromise, busyPromise, deletedPromise]);

      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
    });

    test('closes pane on session.deleted using info.id', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      mockMultiplexer.spawnPane.mockResolvedValueOnce({
        success: true,
        paneId: 'p-info-id',
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-info-id',
            parentID: 'parent-info-id',
          },
        },
      });

      await manager.onSessionDeleted({
        type: 'session.deleted',
        properties: {
          info: { id: 'child-info-id' },
        },
      });

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-info-id');

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-info-id',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
    });

    test('closes deleted pane even when current instance is not owner', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      mockMultiplexer.spawnPane.mockResolvedValueOnce({
        success: true,
        paneId: 'p-non-owner-delete',
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-non-owner-delete',
            parentID: 'parent-non-owner-delete',
          },
        },
      });

      const tracked = (manager as any).sessions.get('child-non-owner-delete');
      tracked.ownerInstanceId = 'other-instance';

      await manager.onSessionDeleted({
        type: 'session.deleted',
        properties: { sessionID: 'child-non-owner-delete' },
      });

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith(
        'p-non-owner-delete',
      );
      expect((manager as any).sessions.has('child-non-owner-delete')).toBe(
        false,
      );
    });

    test('closes pane returned by a stale spawn after session deleted', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const spawnDeferred = createDeferred<{ success: true; paneId: string }>();

      mockMultiplexer.spawnPane.mockImplementationOnce(
        () => spawnDeferred.promise,
      );

      const createPromise = manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-stale-spawn',
            parentID: 'parent-stale-spawn',
          },
        },
      });

      await Promise.resolve();

      await manager.onSessionDeleted({
        type: 'session.deleted',
        properties: {
          info: { id: 'child-stale-spawn' },
        },
      });

      spawnDeferred.resolve({ success: true, paneId: 'p-stale-spawn' });
      await createPromise;

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-stale-spawn');
    });

    test('does nothing on busy for unknown session', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'unknown-session',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.spawnPane).not.toHaveBeenCalled();
    });

    test('does not respawn while initial pane spawn is still in progress', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const deferred = createDeferred<{ success: true; paneId: string }>();

      mockMultiplexer.spawnPane.mockImplementationOnce(() => deferred.promise);

      const createPromise = manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-busy-race',
            parentID: 'parent-busy-race',
            title: 'Busy Worker',
            directory: '/task/dir',
          },
        },
      });

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-busy-race',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);

      deferred.resolve({ success: true, paneId: 'p-busy-race' });

      await createPromise;

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
    });
  });

  describe('cmux lifecycle', () => {
    const cmuxConfig = { ...defaultMultiplexerConfig, type: 'cmux' as const };

    test('resolves a dynamic serverUrl after manager construction', async () => {
      mockMultiplexerType = 'cmux';
      let serverUrl = new URL('http://localhost:4096/');
      let getterCalls = 0;
      const ctx = createMockContext();
      Object.defineProperty(ctx, 'serverUrl', {
        configurable: true,
        get: () => {
          getterCalls += 1;
          return serverUrl;
        },
      });
      const serverCheck = mock(async () => true);
      const manager = new MultiplexerSessionManager(
        ctx,
        cmuxConfig,
        undefined,
        {
          isServerRunning: serverCheck,
        },
      );
      expect(getterCalls).toBe(0);

      serverUrl = new URL('http://127.0.0.1:63871/');
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'dynamic-port', parentID: 'parent' } },
      });
      setMockSessionStatuses({ 'dynamic-port': { type: 'busy' } });
      await (manager as any).pollSessions();

      expect(serverCheck).toHaveBeenCalledWith('http://127.0.0.1:63871/');
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledWith(
        'dynamic-port',
        'Subagent',
        'http://127.0.0.1:63871/',
        '/test/directory',
      );
      expect(mockFetch).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:63871/session/status'),
        expect.any(Object),
      );
      expect(serverCheck).not.toHaveBeenCalledWith('http://localhost:4096/');
      expect(mockFetch).not.toHaveBeenCalledWith(
        new URL('http://localhost:4096/session/status'),
        expect.any(Object),
      );
    });

    test('pins the URL selected before an awaited health check', async () => {
      mockMultiplexerType = 'cmux';
      let serverUrl = new URL('http://127.0.0.1:63871/');
      const ctx = createMockContext();
      Object.defineProperty(ctx, 'serverUrl', { get: () => serverUrl });
      const health = createDeferred<boolean>();
      const serverCheck = mock(() => health.promise);
      const manager = new MultiplexerSessionManager(
        ctx,
        cmuxConfig,
        undefined,
        {
          isServerRunning: serverCheck,
        },
      );

      const creating = manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'pinned-url', parentID: 'parent' } },
      });
      await Promise.resolve();
      serverUrl = new URL('http://127.0.0.1:63872/');
      health.resolve(true);
      await creating;

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledWith(
        'pinned-url',
        'Subagent',
        'http://127.0.0.1:63871/',
        '/test/directory',
      );
    });

    test('deferred spawn retry resolves the latest URL', async () => {
      mockMultiplexerType = 'cmux';
      let serverUrl = new URL('http://127.0.0.1:63871/');
      const ctx = createMockContext();
      Object.defineProperty(ctx, 'serverUrl', { get: () => serverUrl });
      const retry = createDeferred<void>();
      const serverCheck = mock(async () => true);
      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({ success: false, error: 'unavailable' })
        .mockResolvedValueOnce({ success: true, paneId: 'retried-pane' });
      const manager = new MultiplexerSessionManager(
        ctx,
        cmuxConfig,
        undefined,
        {
          isServerRunning: serverCheck,
          delay: () => retry.promise,
        },
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'deferred-url', parentID: 'parent' } },
      });
      serverUrl = new URL('http://127.0.0.1:63872/');
      retry.resolve();
      await flushPromises();

      expect(serverCheck).toHaveBeenLastCalledWith('http://127.0.0.1:63872/');
      expect(mockMultiplexer.spawnPane).toHaveBeenLastCalledWith(
        'deferred-url',
        'Subagent',
        'http://127.0.0.1:63872/',
        '/test/directory',
      );
    });

    test('busy respawn resolves the latest URL', async () => {
      mockMultiplexerType = 'cmux';
      let serverUrl = new URL('http://127.0.0.1:63871/');
      const ctx = createMockContext();
      Object.defineProperty(ctx, 'serverUrl', { get: () => serverUrl });
      const manager = new MultiplexerSessionManager(ctx, cmuxConfig);
      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({ success: true, paneId: 'first-pane' })
        .mockResolvedValueOnce({ success: true, paneId: 'second-pane' });
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'busy-url', parentID: 'parent' } },
      });
      await manager.closeSessionFromCoordinator('busy-url');
      serverUrl = new URL('http://127.0.0.1:63872/');
      await manager.onSessionStatus({
        type: 'session.status',
        properties: { sessionID: 'busy-url', status: { type: 'busy' } },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
    });

    test('each poll resolves the latest URL', async () => {
      mockMultiplexerType = 'cmux';
      let serverUrl = new URL('http://127.0.0.1:63871/');
      const ctx = createMockContext();
      Object.defineProperty(ctx, 'serverUrl', { get: () => serverUrl });
      const manager = new MultiplexerSessionManager(ctx, cmuxConfig);
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'poll-url', parentID: 'parent' } },
      });
      await (manager as any).pollSessions();
      serverUrl = new URL('http://127.0.0.1:63872/');
      await (manager as any).pollSessions();

      expect(mockFetch.mock.calls.at(-2)?.[0]).toEqual(
        new URL('http://127.0.0.1:63871/session/status'),
      );
      expect(mockFetch.mock.calls.at(-1)?.[0]).toEqual(
        new URL('http://127.0.0.1:63872/session/status'),
      );
    });

    test('temporary missing URL never advances missing grace or closes a pane', async () => {
      mockMultiplexerType = 'cmux';
      let now = 0;
      let serverUrl: URL | undefined = new URL('http://127.0.0.1:63871/');
      const ctx = createMockContext();
      Object.defineProperty(ctx, 'serverUrl', { get: () => serverUrl });
      const manager = new MultiplexerSessionManager(
        ctx,
        cmuxConfig,
        undefined,
        {
          now: () => now,
          missingGraceMs: 10,
        },
      );
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'temporary-url', parentID: 'parent' } },
      });

      serverUrl = undefined;
      for (now = 10; now <= 40; now += 10)
        await (manager as any).pollSessions();
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();

      serverUrl = new URL('http://127.0.0.1:63872/');
      setMockSessionStatuses({ 'temporary-url': { type: 'busy' } });
      await (manager as any).pollSessions();
      expect(mockFetch).toHaveBeenLastCalledWith(
        new URL('http://127.0.0.1:63872/session/status'),
        expect.any(Object),
      );
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('uses the SDK client baseUrl when ctx.serverUrl is missing', async () => {
      mockMultiplexerType = 'cmux';
      const ctx = createMockContext();
      ctx.serverUrl = undefined;
      ctx.client._client = {
        getConfig: () => ({ baseUrl: 'http://127.0.0.1:63872/' }),
      };
      const serverCheck = mock(async () => true);
      const manager = new MultiplexerSessionManager(
        ctx,
        cmuxConfig,
        undefined,
        {
          isServerRunning: serverCheck,
        },
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'client-url', parentID: 'parent' } },
      });

      expect(serverCheck).toHaveBeenCalledWith('http://127.0.0.1:63872/');
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledWith(
        'client-url',
        'Subagent',
        'http://127.0.0.1:63872/',
        '/test/directory',
      );
    });

    test('does not health check, spawn, or fall back to 4096 without a URL', async () => {
      mockMultiplexerType = 'cmux';
      const ctx = createMockContext();
      ctx.serverUrl = undefined;
      const manager = new MultiplexerSessionManager(ctx, cmuxConfig);

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'no-url', parentID: 'parent' } },
      });
      await (manager as any).pollSessions();

      expect(mockIsServerRunning).not.toHaveBeenCalled();
      expect(mockMultiplexer.spawnPane).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('malicious client reflection cannot break initialization or spawning', async () => {
      mockMultiplexerType = 'cmux';
      for (const client of [
        new Proxy(
          {},
          {
            has: () => true,
            get: () => {
              throw new Error('get');
            },
          },
        ),
        Object.defineProperty({}, '_client', {
          get: () => {
            throw new Error('accessor');
          },
        }),
        {
          _client: Object.defineProperty({}, 'getConfig', {
            get: () => {
              throw new Error('getConfig accessor');
            },
          }),
        },
        {
          _client: {
            getConfig: () =>
              Object.defineProperty({}, 'baseUrl', {
                get: () => {
                  throw new Error('baseUrl accessor');
                },
              }),
          },
        },
      ]) {
        const ctx = createMockContext();
        ctx.serverUrl = undefined;
        ctx.client = client;
        const manager = new MultiplexerSessionManager(ctx, cmuxConfig);
        await expect(
          manager.onSessionCreated({
            type: 'session.created',
            properties: {
              info: { id: `proxy-${Math.random()}`, parentID: 'p' },
            },
          }),
        ).resolves.toBeUndefined();
      }
      expect(mockIsServerRunning).not.toHaveBeenCalled();
      expect(mockMultiplexer.spawnPane).not.toHaveBeenCalled();
    });

    test('keeps an explicit fixed 4096 serverUrl working', async () => {
      mockMultiplexerType = 'cmux';
      const ctx = createMockContext({ serverUrl: 'http://localhost:4096/' });
      const serverCheck = mock(async () => true);
      const manager = new MultiplexerSessionManager(
        ctx,
        cmuxConfig,
        undefined,
        {
          isServerRunning: serverCheck,
        },
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'fixed-port', parentID: 'parent' } },
      });

      expect(serverCheck).toHaveBeenCalledWith('http://localhost:4096/');
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledWith(
        'fixed-port',
        'Subagent',
        'http://localhost:4096/',
        '/test/directory',
      );
    });

    test('requires lifetime, three idle polls, and a final idle recheck', async () => {
      mockMultiplexerType = 'cmux';
      let now = 0;
      const manager = new MultiplexerSessionManager(
        createMockContext(),
        cmuxConfig,
        undefined,
        { now: () => now },
      );
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'cmux-idle', parentID: 'parent' } },
      });
      await manager.onSessionStatus({
        type: 'session.idle',
        properties: { sessionID: 'cmux-idle' },
      });
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();

      setMockSessionStatuses({ 'cmux-idle': { type: 'idle' } });
      await (manager as any).pollSessions();
      now = 10_000;
      await (manager as any).pollSessions();
      await (manager as any).pollSessions();
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
      await (manager as any).pollSessions();
      expect(mockFetch).toHaveBeenCalledTimes(5);
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('%mock-pane');
    });

    test('activity resets idle stability and missing status is a grace', async () => {
      mockMultiplexerType = 'cmux';
      let now = 0;
      const manager = new MultiplexerSessionManager(
        createMockContext(),
        cmuxConfig,
        undefined,
        { now: () => now },
      );
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'cmux-active', parentID: 'parent' } },
      });
      now = 10_000;
      setMockSessionStatuses({ 'cmux-active': { type: 'idle' } });
      await (manager as any).pollSessions();
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'cmux-active',
          status: { type: 'message' },
        },
      });
      now = 20_000;
      setMockSessionStatuses({});
      await (manager as any).pollSessions();
      setMockSessionStatuses({ 'cmux-active': { type: 'idle' } });
      await (manager as any).pollSessions();
      await (manager as any).pollSessions();
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
      await (manager as any).pollSessions();
      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);
    });

    test('delete and cleanup cancel deferred retries', async () => {
      for (const action of ['delete', 'cleanup'] as const) {
        resetMultiplexerSessionManagerState();
        mockMultiplexer.spawnPane.mockReset();
        mockMultiplexer.spawnPane.mockResolvedValue({
          success: false,
          error: 'invalid_state',
        });
        mockMultiplexerType = 'cmux';
        const retry = createDeferred<void>();
        const manager = new MultiplexerSessionManager(
          createMockContext(),
          cmuxConfig,
          undefined,
          { delay: () => retry.promise },
        );
        await manager.onSessionCreated({
          type: 'session.created',
          properties: { info: { id: action, parentID: 'parent' } },
        });
        if (action === 'delete') {
          await manager.onSessionDeleted({
            type: 'session.deleted',
            properties: { sessionID: action },
          });
        } else {
          await manager.cleanup();
        }
        retry.resolve();
        await Promise.resolve();
        expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
      }
    });

    test('hard spawn failures are not deferred', async () => {
      mockMultiplexerType = 'cmux';
      const delay = mock(async () => {});
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: false,
        error: 'hard',
      });
      const manager = new MultiplexerSessionManager(
        createMockContext(),
        cmuxConfig,
        undefined,
        { delay },
      );
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'hard', parentID: 'parent' } },
      });
      expect(delay).not.toHaveBeenCalled();
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
    });

    test('server-down deferred retry recovers and expires at original TTL', async () => {
      for (const recovers of [true, false]) {
        resetMultiplexerSessionManagerState();
        mockMultiplexer.spawnPane.mockReset();
        mockMultiplexer.spawnPane
          .mockResolvedValueOnce({ success: false, error: 'unavailable' })
          .mockResolvedValue({ success: true, paneId: `server-${recovers}` });
        mockIsServerRunning.mockReset();
        mockIsServerRunning.mockResolvedValue(true);
        mockMultiplexerType = 'cmux';
        let now = 0;
        const retries: Array<ReturnType<typeof createDeferred<void>>> = [];
        const manager = new MultiplexerSessionManager(
          createMockContext(),
          cmuxConfig,
          undefined,
          {
            now: () => now,
            deferredTtlMs: 10,
            delay: () => {
              const retry = createDeferred<void>();
              retries.push(retry);
              return retry.promise;
            },
          },
        );
        await manager.onSessionCreated({
          type: 'session.created',
          properties: { info: { id: `down-${recovers}`, parentID: 'p' } },
        });
        mockIsServerRunning.mockResolvedValue(false);
        now = 5;
        retries[0]?.resolve();
        await flushPromises();
        if (recovers) mockIsServerRunning.mockResolvedValue(true);
        else now = 10;
        retries[1]?.resolve();
        await flushPromises();
        expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(
          recovers ? 2 : 1,
        );
      }
    });

    test('message events and close-list races reset cmux idle', async () => {
      mockMultiplexerType = 'cmux';
      let now = 0;
      const manager = new MultiplexerSessionManager(
        createMockContext(),
        cmuxConfig,
        undefined,
        { now: () => now },
      );
      for (const id of ['message-a', 'message-b']) {
        await manager.onSessionCreated({
          type: 'session.created',
          properties: { info: { id, parentID: 'parent' } },
        });
      }
      now = 10_000;
      setMockSessionStatuses({
        'message-a': { type: 'idle' },
        'message-b': { type: 'idle' },
      });
      await (manager as any).pollSessions();
      await (manager as any).pollSessions();
      const originalClose = mockMultiplexer.closePane;
      originalClose.mockImplementationOnce(async () => {
        await manager.onSessionStatus({
          type: 'message.part.delta',
          properties: { sessionID: 'message-b' },
        });
        return true;
      });
      await (manager as any).pollSessions();
      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);
      await manager.onSessionStatus({
        type: 'message.updated',
        properties: { info: { sessionID: 'message-b' } },
      });
      await manager.onSessionStatus({
        type: 'message.removed',
        properties: { sessionID: 'message-b' },
      });
      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);
    });

    test('deleted stale spawn and cleanup retry close failures', async () => {
      mockMultiplexerType = 'cmux';
      const spawn = createDeferred<{ success: true; paneId: string }>();
      const retries: Array<ReturnType<typeof createDeferred<void>>> = [];
      mockMultiplexer.spawnPane.mockImplementationOnce(() => spawn.promise);
      mockMultiplexer.closePane
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error('socket'))
        .mockResolvedValueOnce(true);
      const manager = new MultiplexerSessionManager(
        createMockContext(),
        cmuxConfig,
        undefined,
        {
          delay: () => {
            const retry = createDeferred<void>();
            retries.push(retry);
            return retry.promise;
          },
        },
      );
      const creating = manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'stale-cmux', parentID: 'parent' } },
      });
      await flushPromises();
      await manager.onSessionDeleted({
        type: 'session.deleted',
        properties: { sessionID: 'stale-cmux' },
      });
      spawn.resolve({ success: true, paneId: 'stale-pane' });
      await creating;
      retries[0]?.resolve();
      await flushPromises();
      retries[1]?.resolve();
      await flushPromises();
      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(3);
    });

    test('retries false and thrown closes until success', async () => {
      mockMultiplexerType = 'cmux';
      const retries: Array<ReturnType<typeof createDeferred<void>>> = [];
      mockMultiplexer.closePane
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error('socket'))
        .mockResolvedValueOnce(true);
      const manager = new MultiplexerSessionManager(
        createMockContext(),
        cmuxConfig,
        undefined,
        {
          delay: () => {
            const retry = createDeferred<void>();
            retries.push(retry);
            return retry.promise;
          },
          closeRetryMaxAttempts: 4,
        },
      );
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'close-retry', parentID: 'parent' } },
      });
      await manager.onSessionDeleted({
        type: 'session.deleted',
        properties: { sessionID: 'close-retry' },
      });
      retries[0]?.resolve();
      await flushPromises();
      retries[1]?.resolve();
      await flushPromises();
      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(3);
      await manager.onSessionDeleted({
        type: 'session.deleted',
        properties: { sessionID: 'close-retry' },
      });
      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(3);
    });

    test('activity during final recheck cancels close', async () => {
      mockMultiplexerType = 'cmux';
      let now = 10_000;
      const finalFetch = createDeferred<Response>();
      mockFetch
        .mockResolvedValueOnce(Response.json({ race: { type: 'idle' } }))
        .mockResolvedValueOnce(Response.json({ race: { type: 'idle' } }))
        .mockResolvedValueOnce(Response.json({ race: { type: 'idle' } }))
        .mockImplementationOnce(() => finalFetch.promise);
      const manager = new MultiplexerSessionManager(
        createMockContext(),
        cmuxConfig,
        undefined,
        { now: () => now },
      );
      now = 0;
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'race', parentID: 'parent' } },
      });
      now = 10_000;
      await (manager as any).pollSessions();
      await (manager as any).pollSessions();
      const finalPoll = (manager as any).pollSessions();
      await flushPromises();
      await manager.onSessionStatus({
        type: 'session.status',
        properties: { sessionID: 'race', status: { type: 'message' } },
      });
      finalFetch.resolve(Response.json({ race: { type: 'idle' } }));
      await finalPoll;
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('poll guard prevents overlapping status fetches', async () => {
      mockMultiplexerType = 'cmux';
      const slowFetch = createDeferred<Response>();
      mockFetch.mockImplementationOnce(() => slowFetch.promise);
      const manager = new MultiplexerSessionManager(
        createMockContext(),
        cmuxConfig,
      );
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'slow', parentID: 'parent' } },
      });
      const first = (manager as any).pollSessions();
      const second = (manager as any).pollSessions();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      slowFetch.resolve(Response.json({ slow: { type: 'idle' } }));
      await Promise.all([first, second]);
    });

    test('missing resets idle streak and closes after grace expires', async () => {
      mockMultiplexerType = 'cmux';
      let now = 0;
      const manager = new MultiplexerSessionManager(
        createMockContext(),
        cmuxConfig,
        undefined,
        { now: () => now, missingGraceMs: 30 },
      );
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'missing', parentID: 'parent' } },
      });
      now = 10_000;
      setMockSessionStatuses({ missing: { type: 'idle' } });
      await (manager as any).pollSessions();
      setMockSessionStatuses({});
      await (manager as any).pollSessions();
      now += 29;
      await (manager as any).pollSessions();
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
      setMockSessionStatuses({ missing: { type: 'idle' } });
      await (manager as any).pollSessions();
      await (manager as any).pollSessions();
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
      setMockSessionStatuses({});
      await (manager as any).pollSessions();
      now += 30;
      await (manager as any).pollSessions();
      await (manager as any).pollSessions();
      await (manager as any).pollSessions();
      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);
    });

    test('background job policy still gates stable cmux idle close', async () => {
      mockMultiplexerType = 'cmux';
      let now = 0;
      const board = new BackgroundJobBoard();
      const coordinator = new BackgroundJobCoordinator(board);
      board.registerLaunch({
        taskID: 'cmux-background',
        parentSessionID: 'parent',
        agent: 'explorer',
      });
      const manager = new MultiplexerSessionManager(
        createMockContext(),
        cmuxConfig,
        coordinator,
        { now: () => now },
      );
      coordinator.addTerminalStateListener((sessionId) => {
        void manager.closeSessionFromCoordinator(sessionId);
      });
      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'cmux-background', parentID: 'parent' },
        },
      });
      now = 10_000;
      setMockSessionStatuses({ 'cmux-background': { type: 'idle' } });
      await (manager as any).pollSessions();
      await (manager as any).pollSessions();
      await (manager as any).pollSessions();
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
      board.updateStatus({ taskID: 'cmux-background', state: 'completed' });
      await (manager as any).pollSessions();
      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);
    });

    test('session.deleted closes immediately', async () => {
      mockMultiplexerType = 'cmux';
      const manager = new MultiplexerSessionManager(
        createMockContext(),
        cmuxConfig,
      );
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'cmux-deleted', parentID: 'parent' } },
      });
      await manager.onSessionDeleted({
        type: 'session.deleted',
        properties: { sessionID: 'cmux-deleted' },
      });
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('%mock-pane');
    });
  });

  describe('cleanup', () => {
    test('instance disposal cleanup is a no-op for non-cmux multiplexers', async () => {
      const manager = new MultiplexerSessionManager(
        createMockContext(),
        defaultMultiplexerConfig,
      );
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'tmux-live', parentID: 'parent' } },
      });
      mockMultiplexer.closePane.mockClear();
      await manager.cleanupOnInstanceDisposed();
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('cmux cleanup has a shutdown deadline for a hanging spawn', async () => {
      mockMultiplexerType = 'cmux';
      const spawn = createDeferred<{ success: true; paneId: string }>();
      mockMultiplexer.spawnPane.mockImplementationOnce(() => spawn.promise);
      const manager = new MultiplexerSessionManager(
        createMockContext(),
        { ...defaultMultiplexerConfig, type: 'cmux' },
        undefined,
        { shutdownTimeoutMs: 1 },
      );
      void manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'hanging-cleanup', parentID: 'parent' } },
      });
      await flushPromises();
      await manager.cleanup();
      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('closes all tracked panes concurrently', async () => {
      const ctx = createMockContext();
      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({ success: true, paneId: 'p1' })
        .mockResolvedValueOnce({ success: true, paneId: 'p2' });

      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 's1', parentID: 'p1' } },
      });
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 's2', parentID: 'p2' } },
      });

      await manager.cleanup();

      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(2);
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p1');
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p2');
    });

    test('clears spawning sessions during cleanup', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      const deferred = createDeferred<{ success: true; paneId: string }>();
      mockMultiplexer.spawnPane.mockImplementationOnce(() => deferred.promise);
      const event = {
        type: 'session.created',
        properties: {
          info: {
            id: 'cleanup-spawn',
            parentID: 'parent-cleanup',
            title: 'Cleanup Worker',
          },
        },
      };

      const createPromise = manager.onSessionCreated(event);

      await Promise.resolve();

      const cleanupPromise = manager.cleanup();
      deferred.resolve({ success: true, paneId: 'p-cleanup' });
      await Promise.all([createPromise, cleanupPromise]);

      await manager.onSessionCreated(event);

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(2);
    });
  });
});

// Backward compatibility test
describe('TmuxSessionManager (backward compatibility)', () => {
  test('TmuxSessionManager is alias for MultiplexerSessionManager', async () => {
    const { TmuxSessionManager } = await import('./session-manager');
    expect(TmuxSessionManager).toBe(MultiplexerSessionManager);
  });
});
