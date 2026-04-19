import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../config';
import { SLIM_INTERNAL_INITIATOR_MARKER } from '../utils';
import {
  type BackgroundTask,
  BackgroundTaskManager,
  loadPersistedTask,
} from './background-manager';

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
  promptImpl?: (args: any) => Promise<unknown>;
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
        prompt: mock(async (args: any) => {
          if (overrides?.promptImpl) {
            return await overrides.promptImpl(args);
          }
          return {};
        }),
        abort: mock(async () => ({})),
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

    test('resolves displayName alias to internal agent name on launch', () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx, undefined, {
        agents: {
          oracle: { displayName: 'advisor' },
        },
      });

      const task = manager.launch({
        agent: 'advisor',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      expect(task.agent).toBe('oracle');
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

    describe('disk persistence (survives manager reinitialization)', () => {
      let testDir: string;
      const origEnv = process.env.OPENCODE_LOG_DIR;

      beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-bg-test-'));
        process.env.OPENCODE_LOG_DIR = testDir;
      });

      afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
        if (origEnv === undefined) {
          delete process.env.OPENCODE_LOG_DIR;
        } else {
          process.env.OPENCODE_LOG_DIR = origEnv;
        }
      });

      test('completed task is retrievable by a new manager instance after reinitialization', async () => {
        const ctx = createMockContext({
          sessionMessagesResult: {
            data: [
              {
                info: { role: 'assistant' },
                parts: [{ type: 'text', text: 'Task result here' }],
              },
            ],
          },
        });

        // First manager: completes the task
        const manager1 = new BackgroundTaskManager(ctx);
        const task = manager1.launch({
          agent: 'explorer',
          prompt: 'test',
          description: 'Persistence test task',
          parentSessionId: 'parent-session',
        });

        await Promise.resolve();
        await Promise.resolve();

        await manager1.handleSessionStatus({
          type: 'session.status',
          properties: {
            sessionID: task.sessionId,
            status: { type: 'idle' },
          },
        });

        expect(task.status).toBe('completed');
        expect(task.result).toBe('Task result here');

        // Simulate reinitialization: new manager with empty in-memory state
        const manager2 = new BackgroundTaskManager(ctx);

        // Should recover from disk
        const recovered = manager2.getResult(task.id);
        expect(recovered).not.toBeNull();
        expect(recovered?.id).toBe(task.id);
        expect(recovered?.status).toBe('completed');
        expect(recovered?.result).toBe('Task result here');
        expect(recovered?.description).toBe('Persistence test task');
      });

      test('failed task is also recoverable after reinitialization', async () => {
        const ctx = createMockContext({
          sessionCreateResult: { data: {} }, // causes launch failure
        });

        const manager1 = new BackgroundTaskManager(ctx);
        const task = manager1.launch({
          agent: 'explorer',
          prompt: 'test',
          description: 'Failing task',
          parentSessionId: 'parent-session',
        });

        await Promise.resolve();
        await Promise.resolve();

        expect(task.status).toBe('failed');

        const manager2 = new BackgroundTaskManager(ctx);
        const recovered = manager2.getResult(task.id);
        expect(recovered).not.toBeNull();
        expect(recovered?.status).toBe('failed');
        expect(recovered?.error).toBe('Failed to create background session');
      });

      test('returns null for task that never completed (no disk file)', () => {
        const ctx = createMockContext();
        const manager = new BackgroundTaskManager(ctx);

        // Task that was only launched on a previous (lost) manager
        const result = manager.getResult('bg_nonexistent99');
        expect(result).toBeNull();
      });
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
    test('falls back to next model when first model prompt fails', async () => {
      let promptCalls = 0;
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
        promptImpl: async (args) => {
          const isTaskPrompt =
            typeof args.path?.id === 'string' &&
            args.path.id.startsWith('test-session-');
          const isParentNotification = !isTaskPrompt;
          if (isParentNotification) return {};

          promptCalls += 1;
          const modelRef = args.body?.model;
          if (
            modelRef?.providerID === 'openai' &&
            modelRef?.modelID === 'gpt-5.4'
          ) {
            throw new Error('primary failed');
          }
          return {};
        },
      });

      const manager = new BackgroundTaskManager(ctx, undefined, {
        fallback: {
          enabled: true,
          timeoutMs: 15000,
          retryDelayMs: 0,
          chains: {
            explorer: ['openai/gpt-5.4', 'opencode/gpt-5-nano'],
          },
        },
      });

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      // Yield to let the fire-and-forget async chain complete
      // (retryDelayMs: 0 eliminates the inter-attempt delay)
      await new Promise((r) => setTimeout(r, 10));

      expect(task.status).toBe('running');
      expect(promptCalls).toBe(2);
      // Verify session.abort was called between attempts
      expect(ctx.client.session.abort).toHaveBeenCalled();
    });

    test('fails task when all fallback models fail', async () => {
      const ctx = createMockContext({
        promptImpl: async (args) => {
          const isTaskPrompt =
            typeof args.path?.id === 'string' &&
            args.path.id.startsWith('test-session-');
          const isParentNotification = !isTaskPrompt;
          if (isParentNotification) return {};
          throw new Error('all models failing');
        },
      });

      const manager = new BackgroundTaskManager(ctx, undefined, {
        fallback: {
          enabled: true,
          timeoutMs: 15000,
          retryDelayMs: 0,
          chains: {
            explorer: ['openai/gpt-5.4', 'opencode/gpt-5-nano'],
          },
        },
      });

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      // Yield to let the fire-and-forget async chain complete
      // (retryDelayMs: 0 eliminates the inter-attempt delay)
      await new Promise((r) => setTimeout(r, 10));

      expect(task.status).toBe('failed');
      expect(task.error).toContain('All fallback models failed');
      // Verify session.abort was called: once between attempts + once in completeTask
      expect(ctx.client.session.abort).toHaveBeenCalledTimes(2);
    });

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

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body?: { parts?: Array<{ text?: string }> } }]
      >;
      const notificationCall = promptCalls[promptCalls.length - 1];
      expect(
        notificationCall[0].body?.parts?.[0]?.text?.includes(
          SLIM_INTERNAL_INITIATOR_MARKER,
        ),
      ).toBe(true);
    });

    test('sends completion notification to parent with parent agent', async () => {
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

      // Create a tracked orchestrator parent session
      const parentTask = manager.launch({
        agent: 'orchestrator',
        prompt: 'orchestrate',
        description: 'parent orchestration',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      const parentSessionId = parentTask.sessionId;
      if (!parentSessionId) throw new Error('Expected parent session id');

      // Launch nested subagent under orchestrator
      const childTask = manager.launch({
        agent: 'explorer',
        prompt: 'collect tests',
        description: 'nested subagent',
        parentSessionId,
      });

      await Promise.resolve();
      await Promise.resolve();

      await manager.handleSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: childTask.sessionId,
          status: { type: 'idle' },
        },
      });

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<{
        path: { id: string };
        body: { agent?: string; parts: Array<{ text?: string }> };
      }>;

      const notificationCall = promptCalls.find(
        (c) => c[0].path.id === parentSessionId,
      );

      expect(notificationCall).toBeDefined();
      expect(notificationCall?.[0].body.agent).toBe('orchestrator');
    });

    test('sends completion notification using orchestrator for untracked parent', async () => {
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
      const untrackedParentId = 'unknown-root';

      const childTask = manager.launch({
        agent: 'explorer',
        prompt: 'collect tests',
        description: 'orphan child',
        parentSessionId: untrackedParentId,
      });

      await Promise.resolve();
      await Promise.resolve();

      await manager.handleSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: childTask.sessionId,
          status: { type: 'idle' },
        },
      });

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<{
        path: { id: string };
        body: { agent?: string };
      }>;

      const notificationCall = promptCalls.find(
        (c) => c[0].path.id === untrackedParentId,
      );

      expect(notificationCall).toBeDefined();
      expect(notificationCall?.[0].body.agent).toBe('orchestrator');
    });

    test('retries next fallback model when first model returns empty response', async () => {
      let messagesCallCount = 0;
      const ctx = createMockContext({
        promptImpl: async (args) => {
          const isTaskPrompt =
            typeof args.path?.id === 'string' &&
            args.path.id.startsWith('test-session-');
          const isParentNotification = !isTaskPrompt;
          if (isParentNotification) return {};
          return {};
        },
      });

      // Override messages mock to return empty on first call, then real content
      ctx.client.session.messages = mock(async () => {
        messagesCallCount++;
        if (messagesCallCount === 1) {
          // First model: empty response
          return {
            data: [
              {
                info: { role: 'assistant' },
                parts: [{ type: 'text', text: '' }],
              },
            ],
          };
        }
        // Second model: real content
        return {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        };
      });

      const manager = new BackgroundTaskManager(ctx, undefined, {
        fallback: {
          enabled: true,
          timeoutMs: 15000,
          retryDelayMs: 0,
          chains: {
            explorer: ['openai/gpt-5.4', 'opencode/gpt-5-nano'],
          },
        },
      });

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      // Yield to let the fire-and-forget async chain complete
      await new Promise((r) => setTimeout(r, 10));

      expect(task.status).toBe('running');
      // Messages should have been called twice (once per fallback attempt)
      expect(messagesCallCount).toBe(2);
      // Session abort should have been called between attempts
      expect(ctx.client.session.abort).toHaveBeenCalled();
    });

    test('allows empty response when retry_on_empty is false (prompt loop)', async () => {
      const ctx = createMockContext({
        promptImpl: async (args) => {
          const isTaskPrompt =
            typeof args.path?.id === 'string' &&
            args.path.id.startsWith('test-session-');
          const isParentNotification = !isTaskPrompt;
          if (isParentNotification) return {};
          return {};
        },
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: '' }], // empty response
            },
          ],
        },
      });

      const manager = new BackgroundTaskManager(ctx, undefined, {
        fallback: {
          enabled: true,
          timeoutMs: 15000,
          retryDelayMs: 0,
          retry_on_empty: false,
          chains: {
            explorer: ['openai/gpt-5.4', 'opencode/gpt-5-nano'],
          },
        },
      });

      const task = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'parent-123',
      });

      // Yield to let the fire-and-forget async chain complete
      await new Promise((r) => setTimeout(r, 10));

      // Task should be running (not failed) — empty response accepted
      expect(task.status).toBe('running');
      // Only one prompt call (no fallback attempt)
      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body?: { model?: { providerID?: string; modelID?: string } } }]
      >;
      const taskPromptCalls = promptCalls.filter(
        (c) =>
          c[0].body?.model?.providerID === 'openai' &&
          c[0].body?.model?.modelID === 'gpt-5.4',
      );
      expect(taskPromptCalls.length).toBe(1);
    });

    test('completes task with empty text when retry_on_empty is false (extractAndCompleteTask)', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: '' }], // empty response
            },
          ],
        },
      });
      const manager = new BackgroundTaskManager(ctx, undefined, {
        fallback: {
          enabled: false, // fallback disabled, but retry_on_empty still applies
          timeoutMs: 15000,
          retryDelayMs: 0,
          chains: {},
          retry_on_empty: false,
        },
      } as any);

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

      // Empty response should be treated as completed, not failed
      expect(task.status).toBe('completed');
      expect(task.result).toBe(''); // empty text, not error
    });

    test('fails task on empty response when retry_on_empty is true (extractAndCompleteTask)', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: '' }], // empty response
            },
          ],
        },
      });
      const manager = new BackgroundTaskManager(ctx, undefined, {
        fallback: {
          enabled: false, // fallback disabled, but retry_on_empty still applies
          timeoutMs: 15000,
          retryDelayMs: 0,
          chains: {},
          retry_on_empty: true,
        },
      } as any);

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

      // Empty response should be treated as failed
      expect(task.status).toBe('failed');
      expect(task.error).toBe('Empty response from provider');
    });
  });

  describe('subagent delegation restrictions', () => {
    test('spawned explorer gets tools disabled (leaf node)', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      // First, simulate orchestrator starting (parent session with no parent)
      const orchestratorTask = manager.launch({
        agent: 'orchestrator',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      // Verify orchestrator's session is tracked
      const orchestratorSessionId = orchestratorTask.sessionId;
      if (!orchestratorSessionId)
        throw new Error('Expected sessionId to be defined');

      // Launch explorer from orchestrator - explorer is a leaf node so tools disabled
      manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: orchestratorSessionId,
      });

      await Promise.resolve();
      await Promise.resolve();

      // Explorer cannot delegate, so delegation tools are hidden
      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body: { tools?: Record<string, boolean> } }]
      >;
      const lastCall = promptCalls[promptCalls.length - 1];
      expect(lastCall[0].body.tools).toEqual({
        background_task: false,
        task: false,
        question: false,
      });
    });

    test('spawned designer gets tools disabled (leaf node)', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      // First, launch an orchestrator task
      const orchestratorTask = manager.launch({
        agent: 'orchestrator',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      // Launch designer from orchestrator - designer is a leaf node, so tools are disabled
      const orchestratorSessionId = orchestratorTask.sessionId;
      if (!orchestratorSessionId)
        throw new Error('Expected sessionId to be defined');

      manager.launch({
        agent: 'designer',
        prompt: 'test',
        description: 'test',
        parentSessionId: orchestratorSessionId,
      });

      await Promise.resolve();
      await Promise.resolve();

      // Designer is a leaf node, so delegation tools are hidden
      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body: { tools?: Record<string, boolean> } }]
      >;
      const lastCall = promptCalls[promptCalls.length - 1];
      expect(lastCall[0].body.tools).toEqual({
        background_task: false,
        task: false,
        question: false,
      });
    });

    test('spawned explorer from designer gets tools disabled (leaf node)', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      // Launch a designer task
      const designerTask = manager.launch({
        agent: 'designer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      // Launch explorer from designer - explorer is a leaf node so tools disabled
      const designerSessionId = designerTask.sessionId;
      if (!designerSessionId)
        throw new Error('Expected sessionId to be defined');

      manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: designerSessionId,
      });

      await Promise.resolve();
      await Promise.resolve();

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body: { tools?: Record<string, boolean> } }]
      >;
      const lastCall = promptCalls[promptCalls.length - 1];
      expect(lastCall[0].body.tools).toEqual({
        background_task: false,
        task: false,
        question: false,
      });
    });

    test('librarian cannot delegate to any subagents', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      // Launch a librarian task
      const librarianTask = manager.launch({
        agent: 'librarian',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      // Launch subagent from librarian - should have tools disabled
      const librarianSessionId = librarianTask.sessionId;
      if (!librarianSessionId)
        throw new Error('Expected sessionId to be defined');

      manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: librarianSessionId,
      });

      await Promise.resolve();
      await Promise.resolve();

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body: { tools?: Record<string, boolean> } }]
      >;
      const lastCall = promptCalls[promptCalls.length - 1];
      expect(lastCall[0].body.tools).toEqual({
        background_task: false,
        task: false,
        question: false,
      });
    });

    test('oracle cannot delegate to any subagents', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      // Launch an oracle task
      const oracleTask = manager.launch({
        agent: 'oracle',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      // Launch subagent from oracle - should have tools disabled
      const oracleSessionId = oracleTask.sessionId;
      if (!oracleSessionId) throw new Error('Expected sessionId to be defined');

      manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: oracleSessionId,
      });

      await Promise.resolve();
      await Promise.resolve();

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body: { tools?: Record<string, boolean> } }]
      >;
      const lastCall = promptCalls[promptCalls.length - 1];
      expect(lastCall[0].body.tools).toEqual({
        background_task: false,
        task: false,
        question: false,
      });
    });

    test('spawned explorer from unknown parent gets tools disabled (leaf node)', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      // Launch explorer from unknown parent session (root orchestrator)
      manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'unknown-session-id',
      });

      await Promise.resolve();
      await Promise.resolve();

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body: { tools?: Record<string, boolean> } }]
      >;
      const lastCall = promptCalls[promptCalls.length - 1];
      // Explorer is a leaf agent — tools disabled regardless of parent
      expect(lastCall[0].body.tools).toEqual({
        background_task: false,
        task: false,
        question: false,
      });
    });

    test('isAgentAllowed returns true for valid delegations', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      const orchestratorTask = manager.launch({
        agent: 'orchestrator',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      const orchestratorSessionId = orchestratorTask.sessionId;
      if (!orchestratorSessionId)
        throw new Error('Expected sessionId to be defined');

      // Orchestrator can delegate to all subagents
      expect(manager.isAgentAllowed(orchestratorSessionId, 'explorer')).toBe(
        true,
      );
      expect(manager.isAgentAllowed(orchestratorSessionId, 'fixer')).toBe(true);
      expect(manager.isAgentAllowed(orchestratorSessionId, 'designer')).toBe(
        true,
      );
      expect(manager.isAgentAllowed(orchestratorSessionId, 'librarian')).toBe(
        true,
      );
      expect(manager.isAgentAllowed(orchestratorSessionId, 'oracle')).toBe(
        true,
      );
    });

    test('isAgentAllowed returns false for invalid delegations', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      const fixerTask = manager.launch({
        agent: 'fixer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      const fixerSessionId = fixerTask.sessionId;
      if (!fixerSessionId) throw new Error('Expected sessionId to be defined');

      // Fixer cannot delegate to any subagents
      expect(manager.isAgentAllowed(fixerSessionId, 'explorer')).toBe(false);
      expect(manager.isAgentAllowed(fixerSessionId, 'oracle')).toBe(false);
      expect(manager.isAgentAllowed(fixerSessionId, 'designer')).toBe(false);
    });

    test('isAgentAllowed returns false for leaf agents', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      // Explorer is a leaf agent
      const explorerTask = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      const explorerSessionId = explorerTask.sessionId;
      if (!explorerSessionId)
        throw new Error('Expected sessionId to be defined');

      expect(manager.isAgentAllowed(explorerSessionId, 'fixer')).toBe(false);

      // Librarian is also a leaf agent
      const librarianTask = manager.launch({
        agent: 'librarian',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      const librarianSessionId = librarianTask.sessionId;
      if (!librarianSessionId)
        throw new Error('Expected sessionId to be defined');

      expect(manager.isAgentAllowed(librarianSessionId, 'explorer')).toBe(
        false,
      );
    });

    test('isAgentAllowed treats unknown session as root orchestrator', () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      // Unknown sessions default to orchestrator, which can delegate to all subagents
      expect(manager.isAgentAllowed('unknown-session', 'explorer')).toBe(true);
      expect(manager.isAgentAllowed('unknown-session', 'fixer')).toBe(true);
      expect(manager.isAgentAllowed('unknown-session', 'designer')).toBe(true);
      expect(manager.isAgentAllowed('unknown-session', 'librarian')).toBe(true);
      expect(manager.isAgentAllowed('unknown-session', 'oracle')).toBe(true);
    });

    test('unknown agent type defaults to explorer-only delegation', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      // Launch a task with an agent type not in SUBAGENT_DELEGATION_RULES
      const customTask = manager.launch({
        agent: 'custom-agent',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      const customSessionId = customTask.sessionId;
      if (!customSessionId) throw new Error('Expected sessionId to be defined');

      // Unknown agent types should default to explorer-only
      expect(manager.getAllowedSubagents(customSessionId)).toEqual([
        'explorer',
      ]);
      expect(manager.isAgentAllowed(customSessionId, 'explorer')).toBe(true);
      expect(manager.isAgentAllowed(customSessionId, 'fixer')).toBe(false);
      expect(manager.isAgentAllowed(customSessionId, 'oracle')).toBe(false);
    });

    test('spawned explorer from custom agent gets tools disabled (leaf node)', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      // Launch a custom agent first to get a tracked session
      const parentTask = manager.launch({
        agent: 'custom-agent',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      const parentSessionId = parentTask.sessionId;
      if (!parentSessionId) throw new Error('Expected sessionId to be defined');

      // Launch explorer from custom agent - explorer is leaf, tools disabled
      manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: parentSessionId,
      });

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body: { tools?: Record<string, boolean> } }]
      >;
      const lastCall = promptCalls[promptCalls.length - 1];
      expect(lastCall[0].body.tools).toEqual({
        background_task: false,
        task: false,
        question: false,
      });
    });

    test('full chain: orchestrator → designer → explorer', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      // Level 1: Launch orchestrator
      const orchestratorTask = manager.launch({
        agent: 'orchestrator',
        prompt: 'coordinate work',
        description: 'orchestrator',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      const orchestratorSessionId = orchestratorTask.sessionId;
      if (!orchestratorSessionId)
        throw new Error('Expected sessionId to be defined');

      // Level 2: Launch designer from orchestrator
      const designerTask = manager.launch({
        agent: 'designer',
        prompt: 'design UI',
        description: 'designer',
        parentSessionId: orchestratorSessionId,
      });

      await Promise.resolve();
      await Promise.resolve();

      const designerSessionId = designerTask.sessionId;
      if (!designerSessionId)
        throw new Error('Expected sessionId to be defined');

      // Designer is a leaf node, so delegation tools stay disabled
      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body: { tools?: Record<string, boolean> } }]
      >;
      const designerPromptCall = promptCalls[1];
      expect(designerPromptCall[0].body.tools).toEqual({
        background_task: false,
        task: false,
        question: false,
      });

      // Designer is a leaf node and cannot spawn subagents
      expect(manager.isAgentAllowed(designerSessionId, 'explorer')).toBe(false);
      expect(manager.isAgentAllowed(designerSessionId, 'fixer')).toBe(false);
      expect(manager.isAgentAllowed(designerSessionId, 'oracle')).toBe(false);

      // Level 3: Launch explorer from designer
      const explorerTask = manager.launch({
        agent: 'explorer',
        prompt: 'find patterns',
        description: 'explorer',
        parentSessionId: designerSessionId,
      });

      await Promise.resolve();
      await Promise.resolve();

      const explorerSessionId = explorerTask.sessionId;
      if (!explorerSessionId)
        throw new Error('Expected sessionId to be defined');

      // Explorer gets tools DISABLED
      const explorerPromptCall = promptCalls[2];
      expect(explorerPromptCall[0].body.tools).toEqual({
        background_task: false,
        task: false,
        question: false,
      });

      // Explorer is a dead end
      expect(manager.getAllowedSubagents(explorerSessionId)).toEqual([]);
    });

    test('chain enforcement: fixer cannot spawn unauthorized agents mid-chain', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      // Orchestrator spawns fixer
      const orchestratorTask = manager.launch({
        agent: 'orchestrator',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      const orchestratorSessionId = orchestratorTask.sessionId;
      if (!orchestratorSessionId)
        throw new Error('Expected sessionId to be defined');

      const fixerTask = manager.launch({
        agent: 'fixer',
        prompt: 'test',
        description: 'test',
        parentSessionId: orchestratorSessionId,
      });

      await Promise.resolve();
      await Promise.resolve();

      const fixerSessionId = fixerTask.sessionId;
      if (!fixerSessionId) throw new Error('Expected sessionId to be defined');

      // Fixer should be blocked from spawning these agents
      expect(manager.isAgentAllowed(fixerSessionId, 'oracle')).toBe(false);
      expect(manager.isAgentAllowed(fixerSessionId, 'designer')).toBe(false);
      expect(manager.isAgentAllowed(fixerSessionId, 'librarian')).toBe(false);
      expect(manager.isAgentAllowed(fixerSessionId, 'fixer')).toBe(false);

      // Explorer is also blocked (fixer is a leaf node)
      expect(manager.isAgentAllowed(fixerSessionId, 'explorer')).toBe(false);
      expect(manager.getAllowedSubagents(fixerSessionId)).toEqual([]);
    });

    test('chain: completed parent does not affect child permissions', async () => {
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

      // Launch designer
      const designerTask = manager.launch({
        agent: 'designer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      const designerSessionId = designerTask.sessionId;
      if (!designerSessionId)
        throw new Error('Expected sessionId to be defined');

      // Launch explorer from designer BEFORE designer completes
      const explorerTask = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: designerSessionId,
      });

      await Promise.resolve();
      await Promise.resolve();

      const explorerSessionId = explorerTask.sessionId;
      if (!explorerSessionId)
        throw new Error('Expected sessionId to be defined');

      // Explorer has its own tracking — tools disabled
      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body: { tools?: Record<string, boolean> } }]
      >;
      const explorerPromptCall = promptCalls[1];
      expect(explorerPromptCall[0].body.tools).toEqual({
        background_task: false,
        task: false,
        question: false,
      });

      // Now complete the designer (cleans up designer's agentBySessionId entry)
      await manager.handleSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: designerSessionId,
          status: { type: 'idle' },
        },
      });

      expect(designerTask.status).toBe('completed');

      // Explorer's own session tracking is independent — still works
      expect(manager.isAgentAllowed(explorerSessionId, 'fixer')).toBe(false);
      expect(manager.getAllowedSubagents(explorerSessionId)).toEqual([]);
    });

    test('getAllowedSubagents returns correct lists', async () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      // Orchestrator -> all 5 subagent names
      const orchestratorTask = manager.launch({
        agent: 'orchestrator',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      const orchestratorSessionId = orchestratorTask.sessionId;
      if (!orchestratorSessionId)
        throw new Error('Expected sessionId to be defined');

      // Default config: DEFAULT_DISABLED_AGENTS includes 'observer', so it's excluded
      expect(manager.getAllowedSubagents(orchestratorSessionId)).toEqual([
        'explorer',
        'librarian',
        'oracle',
        'designer',
        'fixer',
        'council',
      ]);

      // Fixer -> empty (leaf node)
      const fixerTask = manager.launch({
        agent: 'fixer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      const fixerSessionId = fixerTask.sessionId;
      if (!fixerSessionId) throw new Error('Expected sessionId to be defined');

      expect(manager.getAllowedSubagents(fixerSessionId)).toEqual([]);

      // Designer -> empty
      const designerTask = manager.launch({
        agent: 'designer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      const designerSessionId = designerTask.sessionId;
      if (!designerSessionId)
        throw new Error('Expected sessionId to be defined');

      expect(manager.getAllowedSubagents(designerSessionId)).toEqual([]);

      // Explorer -> empty (leaf)
      const explorerTask = manager.launch({
        agent: 'explorer',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      const explorerSessionId = explorerTask.sessionId;
      if (!explorerSessionId)
        throw new Error('Expected sessionId to be defined');

      expect(manager.getAllowedSubagents(explorerSessionId)).toEqual([]);

      // Unknown session -> orchestrator (all subagents minus disabled)
      expect(manager.getAllowedSubagents('unknown-session')).toEqual([
        'explorer',
        'librarian',
        'oracle',
        'designer',
        'fixer',
        'council',
      ]);
    });

    test('disabled_agents: [] enables all agents including observer', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = { disabled_agents: [] };
      const manager = new BackgroundTaskManager(ctx, undefined, config);

      const task = manager.launch({
        agent: 'orchestrator',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'root-session',
      });

      await Promise.resolve();
      await Promise.resolve();

      const sessionId = task.sessionId;
      if (!sessionId) throw new Error('Expected sessionId to be defined');

      expect(manager.getAllowedSubagents(sessionId)).toEqual([
        'explorer',
        'librarian',
        'oracle',
        'designer',
        'fixer',
        'observer',
        'council',
      ]);
    });

    describe('question tool permission', () => {
      test('question: false is passed to prompt for delegating agents', async () => {
        const ctx = createMockContext();
        const manager = new BackgroundTaskManager(ctx);

        // Launch a task with orchestrator (has delegation rules)
        const task = manager.launch({
          agent: 'orchestrator',
          prompt: 'coordinate work',
          description: 'orchestrator test',
          parentSessionId: 'root-session',
        });

        // Yield to allow async startTask to execute
        await Promise.resolve();
        await Promise.resolve();

        const sessionId = task.sessionId;
        if (!sessionId) throw new Error('Expected sessionId to be defined');

        // Find the prompt call for this session
        const promptCalls = ctx.client.session.prompt.mock.calls as Array<
          [{ path: { id: string }; body: { tools?: Record<string, boolean> } }]
        >;
        const taskPromptCall = promptCalls.find(
          (call) => call[0].path.id === sessionId,
        );

        expect(taskPromptCall).toBeDefined();
        expect(taskPromptCall?.[0].body.tools).toEqual({
          background_task: true,
          task: true,
          question: false,
        });
      });

      test('question: false is passed to prompt for leaf agents', async () => {
        const ctx = createMockContext();
        const manager = new BackgroundTaskManager(ctx);

        // Launch a task with explorer (leaf agent, no delegation rules)
        const task = manager.launch({
          agent: 'explorer',
          prompt: 'find patterns',
          description: 'explorer test',
          parentSessionId: 'root-session',
        });

        // Yield to allow async startTask to execute
        await Promise.resolve();
        await Promise.resolve();

        const sessionId = task.sessionId;
        if (!sessionId) throw new Error('Expected sessionId to be defined');

        // Find the prompt call for this session
        const promptCalls = ctx.client.session.prompt.mock.calls as Array<
          [{ path: { id: string }; body: { tools?: Record<string, boolean> } }]
        >;
        const taskPromptCall = promptCalls.find(
          (call) => call[0].path.id === sessionId,
        );

        expect(taskPromptCall).toBeDefined();
        expect(taskPromptCall?.[0].body.tools).toEqual({
          background_task: false,
          task: false,
          question: false,
        });
      });
    });

    describe('addQuestion', () => {
      test('records question on the correct task via session ID', async () => {
        const ctx = createMockContext();
        const manager = new BackgroundTaskManager(ctx);

        const task = manager.launch({
          agent: 'explorer',
          prompt: 'find patterns',
          description: 'test',
          parentSessionId: 'root-session',
        });

        await Promise.resolve();
        await Promise.resolve();

        const sessionId = task.sessionId;
        if (!sessionId) throw new Error('Expected sessionId');

        const result = manager.addQuestion(
          sessionId,
          'Should I search tests too?',
        );

        expect(result).toBe('recorded');
        expect(task.questions).toEqual(['Should I search tests too?']);
      });

      test('returns not-found for unknown session', () => {
        const ctx = createMockContext();
        const manager = new BackgroundTaskManager(ctx);

        const result = manager.addQuestion(
          'nonexistent-session',
          'Anybody there?',
        );

        expect(result).toBe('not-found');
      });

      test('accumulates multiple questions', async () => {
        const ctx = createMockContext();
        const manager = new BackgroundTaskManager(ctx);

        const task = manager.launch({
          agent: 'oracle',
          prompt: 'review',
          description: 'test',
          parentSessionId: 'root-session',
        });

        await Promise.resolve();
        await Promise.resolve();

        const sessionId = task.sessionId;
        if (!sessionId) throw new Error('Expected sessionId');

        manager.addQuestion(sessionId, 'First question?');
        manager.addQuestion(sessionId, 'Second question?');

        expect(task.questions).toEqual(['First question?', 'Second question?']);
      });

      test('returns terminal for completed task (race window guard)', async () => {
        const ctx = createMockContext();
        const manager = new BackgroundTaskManager(ctx);

        const task = manager.launch({
          agent: 'explorer',
          prompt: 'find patterns',
          description: 'test',
          parentSessionId: 'root-session',
        });

        await Promise.resolve();
        await Promise.resolve();

        const sessionId = task.sessionId;
        if (!sessionId) throw new Error('Expected sessionId');

        // Simulate task completion
        (task as BackgroundTask & { status: string }).status = 'completed';
        task.completedAt = new Date();
        task.result = 'Done.';

        const result = manager.addQuestion(sessionId, 'Too late question?');

        expect(result).toBe('terminal');
        expect(task.questions).toEqual([]); // No question recorded
      });

      describe('question disk persistence (temp-dir isolated)', () => {
        let testDir: string;
        const origEnv = process.env.OPENCODE_LOG_DIR;

        beforeEach(() => {
          testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-bg-question-'));
          process.env.OPENCODE_LOG_DIR = testDir;
        });

        afterEach(() => {
          fs.rmSync(testDir, { recursive: true, force: true });
          if (origEnv === undefined) {
            delete process.env.OPENCODE_LOG_DIR;
          } else {
            process.env.OPENCODE_LOG_DIR = origEnv;
          }
        });

        test('persists questions to disk on each addQuestion call', async () => {
          const ctx = createMockContext();
          const manager = new BackgroundTaskManager(ctx);

          const task = manager.launch({
            agent: 'explorer',
            prompt: 'find patterns',
            description: 'test',
            parentSessionId: 'root-session',
          });

          await Promise.resolve();
          await Promise.resolve();

          const sessionId = task.sessionId;
          if (!sessionId) throw new Error('Expected sessionId');

          manager.addQuestion(sessionId, 'Should I search tests too?');

          // Load from disk — question should be persisted even though task is still running
          const fromDisk = loadPersistedTask(task.id);
          expect(fromDisk).not.toBeNull();
          expect(fromDisk?.questions).toEqual(['Should I search tests too?']);
        });
      });

      test('rejects questions beyond cap (50 questions max)', async () => {
        const ctx = createMockContext();
        const manager = new BackgroundTaskManager(ctx);

        const task = manager.launch({
          agent: 'explorer',
          prompt: 'find patterns',
          description: 'test',
          parentSessionId: 'root-session',
        });

        await Promise.resolve();
        await Promise.resolve();

        const sessionId = task.sessionId;
        if (!sessionId) throw new Error('Expected sessionId');

        // Fill to cap
        for (let i = 0; i < 50; i++) {
          manager.addQuestion(sessionId, `Question ${i}`);
        }

        expect(task.questions.length).toBe(50);

        // 51st should be rejected
        const result = manager.addQuestion(sessionId, 'One too many');
        expect(result).toBe('cap-reached');
        expect(task.questions.length).toBe(50);
        expect(task.questions).not.toContain('One too many');
      });

      test('completion notification includes question count', async () => {
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
          agent: 'explorer',
          prompt: 'find patterns',
          description: 'search task',
          parentSessionId: 'parent-session',
        });

        await Promise.resolve();
        await Promise.resolve();

        const sessionId = task.sessionId;
        if (!sessionId) throw new Error('Expected sessionId');

        // Add questions before completion
        manager.addQuestion(sessionId, 'Should I check tests too?');
        manager.addQuestion(sessionId, 'What about config files?');

        // Trigger completion
        await manager.handleSessionStatus({
          type: 'session.status',
          properties: {
            sessionID: sessionId,
            status: { type: 'idle' },
          },
        });

        // Find the notification call
        const promptCalls = ctx.client.session.prompt.mock.calls as Array<
          [{ body?: { parts?: Array<{ text?: string }> } }]
        >;
        const notificationCall = promptCalls[promptCalls.length - 1];
        const notificationText =
          notificationCall[0].body?.parts?.[0]?.text ?? '';

        expect(notificationText).toContain('search task');
        expect(notificationText).toContain('2 questions relayed');
      });
    });
  });
});
