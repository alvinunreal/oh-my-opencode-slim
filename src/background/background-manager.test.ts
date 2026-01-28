import { describe, expect, mock, test } from 'bun:test';
import { BackgroundTaskManager } from './background-manager';

// Mock the plugin context
function createMockContext(overrides?: {
  sessionCreateResult?: { data?: { id?: string } };
  sessionStatusResult?: { data?: Record<string, { type: string }> };
  sessionMessagesResult?: {
    data?: Array<{
      info?: { role: string };
      parts?: Array<{ type: string; text?: string }>;
    }>;
  };
}) {
  let callCount = 0;
  return {
    client: {
      session: {
        create: mock(async () => {
          callCount++;
          return (
            overrides?.sessionCreateResult ?? {
              data: { id: `test-session-${callCount}` },
            }
          );
        }),
        status: mock(
          async () => overrides?.sessionStatusResult ?? { data: {} },
        ),
        messages: mock(
          async () => overrides?.sessionMessagesResult ?? { data: [] },
        ),
        prompt: mock(async () => ({})),
      },
    },
    directory: '/test/directory',
  } as any;
}

describe('BackgroundTaskManager', () => {
  describe('constructor', () => {
    test('creates manager with defaults', () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);
      expect(manager).toBeDefined();
    });

    test('creates manager with tmux config', () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx, {
        enabled: true,
        layout: 'main-vertical',
        main_pane_size: 60,
      });
      expect(manager).toBeDefined();
    });

    test('creates manager with background config', () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx, undefined, {
        background: {
          maxConcurrentStarts: 5,
        },
      });
      expect(manager).toBeDefined();
    });
  });

  describe('launch (fire-and-forget)', () => {
    test('returns task immediately with pending or starting status', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'Find all test files',
        description: 'Test file search',
        parentSessionId: 'parent-123',
      });

      expect(task.id).toMatch(/^bg_/);
      // Task may be pending (in queue) or starting (already started)
      expect(['pending', 'starting']).toContain(task.status);
      expect(task.sessionId).toBeUndefined();
      expect(task.agent).toBe('explorer');
      expect(task.description).toBe('Test file search');
      expect(task.startedAt).toBeDefined();
    });

    test('sessionId is set asynchronously when task starts', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      // Immediately after launch, no sessionId
      expect(task.sessionId).toBeUndefined();

      // Wait for microtask queue to process
      await Promise.resolve();
      await Promise.resolve();

      // After background start, sessionId should be set
      expect(task.sessionId).toBeDefined();
      expect(task.status).toBe('running');
    });

    test('task fails when session creation fails', async () => {
      const ctx = createMockContext({ sessionCreateResult: { data: {} } });
      const manager = new BackgroundTaskManager(ctx);

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(task.status).toBe('failed');
      expect(task.error).toBe('Failed to create background session');
    });

    test('multiple launches return immediately', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      const task1 = manager.launch({
        agent: 'explorer',
        prompt: 'test1',
        description: 'test1',
        parentSessionId: 'parent-123',
      });

      const task2 = manager.launch({
        agent: 'oracle',
        prompt: 'test2',
        description: 'test2',
        parentSessionId: 'parent-123',
      });

      const task3 = manager.launch({
        agent: 'fixer',
        prompt: 'test3',
        description: 'test3',
        parentSessionId: 'parent-123',
      });

      // All return immediately with pending or starting status
      expect(['pending', 'starting']).toContain(task1.status);
      expect(['pending', 'starting']).toContain(task2.status);
      expect(['pending', 'starting']).toContain(task3.status);
    });
  });

  describe('handleSessionStatus', () => {
    test('completes task when session becomes idle', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Result text' }],
            },
          ],
        },
      });
      const manager = new BackgroundTaskManager(ctx);

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      // Wait for task to start
      await Promise.resolve();
      await Promise.resolve();

      // Simulate session.idle event
      await manager.handleSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: task.sessionId,
          status: { type: 'idle' },
        },
      });

      expect(task.status).toBe('completed');
      expect(task.result).toBe('Result text');
    });

    test('ignores non-idle status', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      await Promise.resolve();
      await Promise.resolve();

      // Simulate session.busy event
      await manager.handleSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: task.sessionId,
          status: { type: 'busy' },
        },
      });

      expect(task.status).toBe('running');
    });

    test('ignores non-matching session ID', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      await Promise.resolve();
      await Promise.resolve();

      // Simulate event for different session
      await manager.handleSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'other-session-id',
          status: { type: 'idle' },
        },
      });

      expect(task.status).toBe('running');
    });
  });

  describe('getResult', () => {
    test('returns null for unknown task', () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      const result = manager.getResult('unknown-task-id');
      expect(result).toBeNull();
    });

    test('returns task immediately (no blocking)', () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      const result = manager.getResult(task.id);
      expect(result).toBeDefined();
      expect(result?.id).toBe(task.id);
    });
  });

  describe('waitForCompletion', () => {
    test('waits for task to complete', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Done' }],
            },
          ],
        },
      });
      const manager = new BackgroundTaskManager(ctx);

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      // Wait for task to start
      await Promise.resolve();
      await Promise.resolve();

      // Trigger completion via session.status event
      await manager.handleSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: task.sessionId,
          status: { type: 'idle' },
        },
      });

      // Now waitForCompletion should return immediately
      const result = await manager.waitForCompletion(task.id, 5000);
      expect(result?.status).toBe('completed');
      expect(result?.result).toBe('Done');
    });

    test('returns immediately if already completed', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Done' }],
            },
          ],
        },
      });
      const manager = new BackgroundTaskManager(ctx);

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      // Wait for task to start
      await Promise.resolve();
      await Promise.resolve();

      // Trigger completion
      await manager.handleSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: task.sessionId,
          status: { type: 'idle' },
        },
      });

      // Now wait should return immediately
      const result = await manager.waitForCompletion(task.id, 5000);
      expect(result?.status).toBe('completed');
    });

    test('returns null for unknown task', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      const result = await manager.waitForCompletion('unknown-task-id', 5000);
      expect(result).toBeNull();
    });
  });

  describe('cancel', () => {
    test('cancels pending task before it starts', () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      const count = manager.cancel(task.id);
      expect(count).toBe(1);

      const result = manager.getResult(task.id);
      expect(result?.status).toBe('cancelled');
    });

    test('cancels running task', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      // Wait for task to start
      await Promise.resolve();
      await Promise.resolve();

      const count = manager.cancel(task.id);
      expect(count).toBe(1);

      const result = manager.getResult(task.id);
      expect(result?.status).toBe('cancelled');
    });

    test('returns 0 when cancelling unknown task', () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      const count = manager.cancel('unknown-task-id');
      expect(count).toBe(0);
    });

    test('cancels all pending/running tasks when no ID provided', () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      manager.launch({
        agent: 'explorer',
        prompt: 'test1',
        description: 'test1',
        parentSessionId: 'parent-123',
      });

      manager.launch({
        agent: 'oracle',
        prompt: 'test2',
        description: 'test2',
        parentSessionId: 'parent-123',
      });

      const count = manager.cancel();
      expect(count).toBe(2);
    });

    test('does not cancel already completed tasks', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Done' }],
            },
          ],
        },
      });
      const manager = new BackgroundTaskManager(ctx);

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      // Wait for task to start
      await Promise.resolve();
      await Promise.resolve();

      // Trigger completion
      await manager.handleSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: task.sessionId,
          status: { type: 'idle' },
        },
      });

      // Now try to cancel - should fail since already completed
      const count = manager.cancel(task.id);
      expect(count).toBe(0);
    });
  });

  describe('BackgroundTask logic', () => {
    test('extracts content from multiple types and messages', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [
                { type: 'reasoning', text: 'I am thinking...' },
                { type: 'text', text: 'First part.' },
              ],
            },
            {
              info: { role: 'assistant' },
              parts: [
                { type: 'text', text: 'Second part.' },
                { type: 'text', text: '' }, // Should be ignored
              ],
            },
          ],
        },
      });
      const manager = new BackgroundTaskManager(ctx);

      const task = manager.launch({
        agent: 'test',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'p1',
      });

      // Wait for task to start
      await Promise.resolve();
      await Promise.resolve();

      // Trigger completion
      await manager.handleSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: task.sessionId,
          status: { type: 'idle' },
        },
      });

      expect(task.status).toBe('completed');
      expect(task.result).toContain('I am thinking...');
      expect(task.result).toContain('First part.');
      expect(task.result).toContain('Second part.');
      // Check for double newline join
      expect(task.result).toBe(
        'I am thinking...\n\nFirst part.\n\nSecond part.',
      );
    });

    test('task has completedAt timestamp on completion or cancellation', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'done' }],
            },
          ],
        },
      });
      const manager = new BackgroundTaskManager(ctx);

      // Test completion timestamp
      const task1 = manager.launch({
        agent: 'test',
        prompt: 't1',
        description: 'd1',
        parentSessionId: 'p1',
      });

      await Promise.resolve();
      await Promise.resolve();

      await manager.handleSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: task1.sessionId,
          status: { type: 'idle' },
        },
      });

      expect(task1.completedAt).toBeInstanceOf(Date);
      expect(task1.status).toBe('completed');

      // Test cancellation timestamp
      const task2 = manager.launch({
        agent: 'test',
        prompt: 't2',
        description: 'd2',
        parentSessionId: 'p2',
      });

      manager.cancel(task2.id);
      expect(task2.completedAt).toBeInstanceOf(Date);
      expect(task2.status).toBe('cancelled');
    });

    test('always sends notification to parent session on completion', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'done' }],
            },
          ],
        },
      });
      const manager = new BackgroundTaskManager(ctx, undefined, {
        background: { maxConcurrentStarts: 10 },
      });

      const task = manager.launch({
        agent: 'test',
        prompt: 't',
        description: 'd',
        parentSessionId: 'parent-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      await manager.handleSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: task.sessionId,
          status: { type: 'idle' },
        },
      });

      // Should have called prompt.append for notification
      expect(ctx.client.session.prompt).toHaveBeenCalled();
    });
  });
});
