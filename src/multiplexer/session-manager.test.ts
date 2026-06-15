import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../utils/background-job-board';
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
const mockMultiplexer = {
  type: 'tmux' as const,
  isAvailable: mock(async () => true),
  isInsideSession: mock(() => true),
  spawnPane: mock(async () => ({
    success: true,
    paneId: '%mock-pane',
  })),
  closePane: mock(async () => true),
  applyLayout: mock(async () => {}),
};

// Mock the multiplexer module
mock.module('../multiplexer', () => ({
  getMultiplexer: () => mockMultiplexer,
  isServerRunning: mock(async () => true),
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

    test('does not close long-running pane based on age alone', async () => {
      const ctx = createMockContext();
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-long-running',
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'long-running', parentID: 'p1' } },
      });

      const tracked = (manager as any).sessions.get('long-running');
      tracked.createdAt = Date.now() - 11 * 60 * 1000;

      setMockSessionStatuses({ 'long-running': { type: 'running' } });
      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('does not close never-seen pane when missing from status', async () => {
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

    test('does not close previously seen session when later missing from status', async () => {
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

    test('does not respawn duplicate pane when missing session becomes busy again', async () => {
      const ctx = createMockContext();
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-seen-before-busy-again',
      });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'seen-before-busy-again', parentID: 'p1' },
        },
      });

      setMockSessionStatuses({ 'seen-before-busy-again': { type: 'busy' } });
      await (manager as any).pollSessions();

      setMockSessionStatuses({});
      await (manager as any).pollSessions();

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'seen-before-busy-again',
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

  describe('cleanup', () => {
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

      await manager.cleanup();

      await manager.onSessionCreated(event);

      deferred.resolve({ success: true, paneId: 'p-cleanup' });
      await createPromise;

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
