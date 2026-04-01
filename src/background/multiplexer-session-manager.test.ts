import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { MultiplexerSessionManager } from './multiplexer-session-manager';

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
    serverUrl: new URL(`http://localhost:${defaultPort}`),
  } as any;
}

const defaultMultiplexerConfig = {
  type: 'tmux' as const,
  layout: 'main-vertical' as const,
  main_pane_size: 60,
};

describe('MultiplexerSessionManager', () => {
  beforeEach(() => {
    mockMultiplexer.spawnPane.mockClear();
    mockMultiplexer.closePane.mockClear();
    mockMultiplexer.isInsideSession.mockClear();
    mockMultiplexer.isInsideSession.mockReturnValue(true);
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

      // Mock status
      ctx.client.session.status.mockResolvedValue({
        data: { c1: { type: 'idle' } },
      });

      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-1');
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

      ctx.client.session.status.mockResolvedValue({ data: {} });
      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
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
  });
});

// Backward compatibility test
describe('TmuxSessionManager (backward compatibility)', () => {
  test('TmuxSessionManager is alias for MultiplexerSessionManager', async () => {
    const { TmuxSessionManager } = await import(
      './multiplexer-session-manager'
    );
    expect(TmuxSessionManager).toBe(MultiplexerSessionManager);
  });
});
