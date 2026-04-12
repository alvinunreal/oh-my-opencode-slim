import { describe, expect, mock, test } from 'bun:test';
import { SLIM_INTERNAL_INITIATOR_MARKER } from '../../utils';
import { createTodoContinuationHook } from './index';

describe('createTodoContinuationHook', () => {
  function createMockContext(overrides?: {
    todoResult?: {
      data?: Array<{
        id: string;
        content: string;
        status: string;
        priority: string;
      }>;
    };
    messagesResult?: {
      data?: Array<{
        info?: { role?: string };
        parts?: Array<{ type?: string; text?: string }>;
      }>;
    };
  }) {
    return {
      client: {
        session: {
          todo: mock(async () => overrides?.todoResult ?? { data: [] }),
          messages: mock(async () => overrides?.messagesResult ?? { data: [] }),
          prompt: mock(async () => ({})),
        },
      },
    } as any;
  }

  async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Notification prompts (noReply:true, no marker) fire immediately when
  // scheduling a continuation. These helpers check only for actual
  // continuation prompts (with SLIM_INTERNAL_INITIATOR_MARKER).
  function hasContinuation(m: ReturnType<typeof mock>): boolean {
    return m.mock.calls.some((c: any[]) =>
      (c[0]?.body?.parts as any[])?.some((p: any) =>
        p.text?.includes(SLIM_INTERNAL_INITIATOR_MARKER),
      ),
    );
  }
  function contCount(m: ReturnType<typeof mock>): number {
    return m.mock.calls.filter((c: any[]) =>
      (c[0]?.body?.parts as any[])?.some((p: any) =>
        p.text?.includes(SLIM_INTERNAL_INITIATOR_MARKER),
      ),
    ).length;
  }
  function contCall(m: ReturnType<typeof mock>): any[] {
    const call = m.mock.calls.find((c: any[]) =>
      (c[0]?.body?.parts as any[])?.some((p: any) =>
        p.text?.includes(SLIM_INTERNAL_INITIATOR_MARKER),
      ),
    );
    if (!call) {
      throw new Error('No continuation call found');
    }
    return call;
  }

  describe('tool toggle', () => {
    test('calling auto_continue execute with { enabled: true } sets state', async () => {
      const ctx = createMockContext();
      const hook = createTodoContinuationHook(ctx);

      const result = await hook.tool.auto_continue.execute({ enabled: true });

      expect(result).toContain('Auto-continue enabled');
      expect(result).toContain('up to 5');
    });

    test('calling auto_continue execute with { enabled: false } disables', async () => {
      const ctx = createMockContext();
      const hook = createTodoContinuationHook(ctx);

      const result = await hook.tool.auto_continue.execute({ enabled: false });

      expect(result).toBe('Auto-continue disabled.');
    });
  });

  describe('continuation scheduling', () => {
    test('session idle + enabled + incomplete todos → schedules continuation', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
            { id: '2', content: 'todo2', status: 'completed', priority: 'low' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Here is the result' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 5,
        cooldownMs: 50,
      });

      // Enable auto-continue
      await hook.tool.auto_continue.execute({ enabled: true });

      // Fire session.idle event
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      // Wait for cooldown
      await delay(60);

      // Verify session.prompt was called with continuation prompt
      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
      const promptCall = contCall(ctx.client.session.prompt);
      expect(promptCall[0].path.id).toBe('session-123');
      expect(promptCall[0].body.parts[0].text).toContain(
        '[Auto-continue: enabled - there are incomplete todos remaining.',
      );
      expect(promptCall[0].body.parts[0].text).toContain(
        SLIM_INTERNAL_INITIATOR_MARKER,
      );
    });

    test('disabled → no continuation', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Done' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });

      // Do NOT enable auto-continue

      // Fire session.idle event
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      // Wait for cooldown
      await delay(60);

      // Verify session.prompt was NOT called
      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('last message is a question → skip', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [
                { type: 'text', text: 'Should I proceed with the next step?' },
              ],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });

      // Enable auto-continue
      await hook.tool.auto_continue.execute({ enabled: true });

      // Fire session.idle event
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      // Wait for cooldown
      await delay(60);

      // Verify continuation NOT scheduled
      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('question detection with question mark → skip', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Ready to continue?' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });

      await hook.tool.auto_continue.execute({ enabled: true });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      await delay(60);

      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('question detection with "would you like" phrase → skip', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [
                {
                  type: 'text',
                  text: 'Would you like me to proceed?',
                },
              ],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });

      await hook.tool.auto_continue.execute({ enabled: true });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      await delay(60);

      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('max continuations reached → skip', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Working...' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 2,
        cooldownMs: 50,
      });

      await hook.tool.auto_continue.execute({ enabled: true });

      // Fire idle events up to maxContinuations
      for (let i = 0; i < 2; i++) {
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 'session-123' },
          },
        });
        await delay(60);
      }

      // Reset mock for the 3rd attempt
      ctx.client.session.prompt.mockClear();

      // On the N+1th idle, verify no continuation scheduled
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      await delay(60);

      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('abort suppress window → skip', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Working...' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });

      // Seed orchestrator session
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      await hook.tool.auto_continue.execute({ enabled: true });

      // Fire session.error with MessageAbortedError
      await hook.handleEvent({
        event: {
          type: 'session.error',
          properties: {
            sessionID: 'session-123',
            error: { name: 'MessageAbortedError' },
          },
        },
      });

      // Immediately fire session.idle
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      // Wait less than suppress window (5s) - just enough to verify it's working
      await delay(100);

      // Verify no continuation within suppress window
      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('session busy → cancel pending timer', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Working...' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 5,
        cooldownMs: 500,
      });

      await hook.tool.auto_continue.execute({ enabled: true });

      // Schedule a continuation
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      // After the notification grace but before cooldown expires, fire busy.
      await delay(300);
      await hook.handleEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'session-123',
            status: { type: 'busy' },
          },
        },
      });

      // Advance past original cooldown
      await delay(250);

      // Verify timer was cancelled and prompt NOT called
      expect(hasContinuation(ctx.client.session.prompt)).toBe(false);
    });

    test('sub-agent session.busy does NOT cancel orchestrator timer', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Working...' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 5,
        cooldownMs: 100,
      });

      await hook.tool.auto_continue.execute({ enabled: true });

      // Schedule a continuation for orchestrator session
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      // A sub-agent (different session) goes busy
      await delay(50);
      await hook.handleEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'sub-agent-456',
            status: { type: 'busy' },
          },
        },
      });

      // Advance past original cooldown
      await delay(250);

      // Orchestrator timer should still fire — prompt was called
      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
    });

    test('all todos complete → skip', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            {
              id: '1',
              content: 'todo1',
              status: 'completed',
              priority: 'high',
            },
            { id: '2', content: 'todo2', status: 'cancelled', priority: 'low' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'All done' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });

      await hook.tool.auto_continue.execute({ enabled: true });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      await delay(60);

      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('non-orchestrator session → skip', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Working...' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });

      await hook.tool.auto_continue.execute({ enabled: true });

      // First idle from session A (becomes orchestrator)
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-A' },
        },
      });

      await delay(60);

      // Verify prompt was called for session A
      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);

      // Reset mock
      ctx.client.session.prompt.mockClear();

      // Second idle from session B (different sessionID)
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-B' },
        },
      });

      await delay(60);

      // Verify no continuation for session B
      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('cooldownMs from config', async () => {
      const customCooldownMs = 100;
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Working...' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 5,
        cooldownMs: customCooldownMs,
      });

      await hook.tool.auto_continue.execute({ enabled: true });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      // Advance timer by less than custom cooldown
      await delay(customCooldownMs - 1);

      // Verify prompt not called yet
      expect(hasContinuation(ctx.client.session.prompt)).toBe(false);

      // Advance timer by remaining 1ms
      await delay(1);

      // Now prompt should be called
      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
    });
  });

  describe('event handling - session.error', () => {
    test('MessageAbortedError sets suppress window', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Working...' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });

      // Seed orchestrator session
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      await hook.tool.auto_continue.execute({ enabled: true });

      // Fire session.error with MessageAbortedError
      await hook.handleEvent({
        event: {
          type: 'session.error',
          properties: {
            sessionID: 'session-123',
            error: { name: 'MessageAbortedError' },
          },
        },
      });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      // Wait less than suppress window
      await delay(100);

      // Verify no continuation within suppress window
      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('AbortError sets suppress window', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Working...' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });

      // Seed orchestrator session (disabled, so no continuation fires)
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      await hook.tool.auto_continue.execute({ enabled: true });

      await hook.handleEvent({
        event: {
          type: 'session.error',
          properties: {
            sessionID: 'session-123',
            error: { name: 'AbortError' },
          },
        },
      });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      // Wait less than suppress window
      await delay(100);

      // Verify no continuation within suppress window
      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('other errors do not set suppress window', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Working...' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });

      await hook.tool.auto_continue.execute({ enabled: true });

      await hook.handleEvent({
        event: {
          type: 'session.error',
          properties: {
            sessionID: 'session-123',
            error: { name: 'NetworkError' },
          },
        },
      });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      await delay(60);

      // Prompt should be called immediately (no suppress window)
      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
    });
  });

  describe('event handling - session.deleted', () => {
    test('clears pending timer on session delete', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Working...' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 5,
        cooldownMs: 100,
      });

      await hook.tool.auto_continue.execute({ enabled: true });

      // Schedule continuation
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      // Delete session before timer fires
      await delay(50);
      await hook.handleEvent({
        event: {
          type: 'session.deleted',
          properties: {
            sessionID: 'session-123',
          },
        },
      });

      // Advance past original cooldown
      await delay(250);

      // Verify timer was cancelled and prompt NOT called
      expect(hasContinuation(ctx.client.session.prompt)).toBe(false);
    });

    test('sub-agent session.deleted does NOT cancel orchestrator timer', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Working...' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 5,
        cooldownMs: 100,
      });

      await hook.tool.auto_continue.execute({ enabled: true });

      // Schedule continuation for orchestrator session
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      // A sub-agent (different session) gets deleted
      await delay(50);
      await hook.handleEvent({
        event: {
          type: 'session.deleted',
          properties: {
            sessionID: 'sub-agent-456',
          },
        },
      });

      // Advance past original cooldown
      await delay(250);

      // Orchestrator timer should still fire — prompt was called
      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
    });

    test('resets orchestrator session when deleted session matches', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Working...' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });

      await hook.tool.auto_continue.execute({ enabled: true });

      // First idle sets orchestrator
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-A' },
        },
      });

      await delay(60);

      // Delete orchestrator session
      await hook.handleEvent({
        event: {
          type: 'session.deleted',
          properties: {
            sessionID: 'session-A',
          },
        },
      });

      // Second idle from new session should become orchestrator
      ctx.client.session.prompt.mockClear();
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-B' },
        },
      });

      await delay(60);

      // Prompt should be called for session-B (new orchestrator)
      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
      const promptCall = contCall(ctx.client.session.prompt);
      expect(promptCall[0].path.id).toBe('session-B');
    });
  });

  describe('error handling', () => {
    test('fetch todos failure → skips continuation', async () => {
      const ctx = createMockContext({
        todoResult: undefined as any,
      });
      ctx.client.session.todo = mock(async () => {
        throw new Error('Failed to fetch todos');
      });

      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });

      await hook.tool.auto_continue.execute({ enabled: true });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      await delay(60);

      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('fetch messages failure → skips continuation', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
      });
      ctx.client.session.messages = mock(async () => {
        throw new Error('Failed to fetch messages');
      });

      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });

      await hook.tool.auto_continue.execute({ enabled: true });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      await delay(60);

      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });
  });

  describe('command.execute.before interception', () => {
    test('unrelated command → no interception', async () => {
      const ctx = createMockContext();
      const hook = createTodoContinuationHook(ctx);
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await hook.handleCommandExecuteBefore(
        { command: 'help', sessionID: 'session-123', arguments: '' },
        output,
      );

      expect(output.parts).toHaveLength(0);
    });

    test('/auto-continue enables and injects continuation when incomplete todos', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            {
              id: '1',
              content: 'todo1',
              status: 'pending',
              priority: 'high',
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx);
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await hook.handleCommandExecuteBefore(
        { command: 'auto-continue', sessionID: 'session-123', arguments: '' },
        output,
      );

      expect(output.parts).toHaveLength(1);
      expect(output.parts[0].text).toContain(
        '[Auto-continue: enabled - there are incomplete todos remaining.',
      );
      expect(output.parts[0].text).toContain(SLIM_INTERNAL_INITIATOR_MARKER);
    });

    test('/auto-continue enables but no continuation when all todos complete', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            {
              id: '1',
              content: 'todo1',
              status: 'completed',
              priority: 'high',
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx);
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await hook.handleCommandExecuteBefore(
        { command: 'auto-continue', sessionID: 'session-123', arguments: '' },
        output,
      );

      expect(output.parts).toHaveLength(1);
      expect(output.parts[0].text).toContain('No incomplete todos right now');
    });

    test('/auto-continue toggles off when already enabled', async () => {
      const ctx = createMockContext();
      const hook = createTodoContinuationHook(ctx);
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      // Enable via tool
      await hook.tool.auto_continue.execute({ enabled: true });

      // Toggle off via command
      await hook.handleCommandExecuteBefore(
        { command: 'auto-continue', sessionID: 'session-123', arguments: '' },
        output,
      );

      expect(output.parts).toHaveLength(1);
      expect(output.parts[0].text).toContain('disabled by user command');
    });

    test('/auto-continue resets consecutive continuations on toggle', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            {
              id: '1',
              content: 'todo1',
              status: 'pending',
              priority: 'high',
            },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Working...' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 2,
        cooldownMs: 50,
      });

      // Enable and run up to max
      await hook.tool.auto_continue.execute({ enabled: true });
      for (let i = 0; i < 2; i++) {
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 'session-123' },
          },
        });
        await delay(60);
      }

      // Toggle off then on via command (resets count)
      const outputOff = {
        parts: [] as Array<{ type: string; text?: string }>,
      };
      await hook.handleCommandExecuteBefore(
        { command: 'auto-continue', sessionID: 'session-123', arguments: '' },
        outputOff,
      );
      expect(outputOff.parts[0].text).toContain('disabled');

      const outputOn = {
        parts: [] as Array<{ type: string; text?: string }>,
      };
      await hook.handleCommandExecuteBefore(
        { command: 'auto-continue', sessionID: 'session-123', arguments: '' },
        outputOn,
      );
      // Should have continuation prompt again (count was reset)
      expect(outputOn.parts[0].text).toContain(
        '[Auto-continue: enabled - there are incomplete todos remaining.',
      );
    });

    test('/auto-continue with todo fetch failure → enables without continuation', async () => {
      const ctx = createMockContext();
      ctx.client.session.todo = mock(async () => {
        throw new Error('Network error');
      });
      const hook = createTodoContinuationHook(ctx);
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await hook.handleCommandExecuteBefore(
        { command: 'auto-continue', sessionID: 'session-123', arguments: '' },
        output,
      );

      // Should still enable but skip continuation (no todos fetched)
      expect(output.parts).toHaveLength(1);
      expect(output.parts[0].text).toContain('No incomplete todos right now');
    });
  });

  describe('config defaults', () => {
    test('default config: maxContinuations = 5, cooldownMs = 3000', async () => {
      const ctx = createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Working...' }],
            },
          ],
        },
      });
      const hook = createTodoContinuationHook(ctx); // No config passed

      const result = await hook.tool.auto_continue.execute({ enabled: true });

      expect(result).toContain('up to 5');

      // Test default cooldown - we'll just verify it waits before calling
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      });

      // Wait less than default cooldown
      await delay(100);
      expect(hasContinuation(ctx.client.session.prompt)).toBe(false);

      // Wait past default cooldown
      await delay(2900);
      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
    });
  });

  describe('council review findings', () => {
    describe('CRITICAL-1: counter bypass via session.status→busy', () => {
      test('counter persists when busy fires during auto-injection', async () => {
        let promptResolve!: () => void;
        const ctx = createMockContext({
          todoResult: {
            data: [
              {
                id: '1',
                content: 't1',
                status: 'pending',
                priority: 'high',
              },
            ],
          },
          messagesResult: {
            data: [
              {
                info: { role: 'assistant' },
                parts: [{ type: 'text', text: 'Work' }],
              },
            ],
          },
        });

        // Make prompt hang so isAutoInjecting stays true
        ctx.client.session.prompt = mock(async () => {
          await new Promise<void>((r) => {
            promptResolve = r;
          });
        });

        const hook = createTodoContinuationHook(ctx, {
          maxContinuations: 2,
          cooldownMs: 50,
        });
        await hook.tool.auto_continue.execute({ enabled: true });

        // Cycle 1: idle → timer → prompt hangs
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });
        await delay(60);

        // Session goes busy from prompt — isAutoInjecting is true,
        // so counter should NOT be reset
        await hook.handleEvent({
          event: {
            type: 'session.status',
            properties: {
              sessionID: 's1',
              status: { type: 'busy' },
            },
          },
        });

        // Resolve prompt → counter = 1
        promptResolve();
        await delay(10);

        // Cycle 2: idle → timer → prompt hangs
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });
        await delay(60);

        // Session goes busy again — counter still not reset
        await hook.handleEvent({
          event: {
            type: 'session.status',
            properties: {
              sessionID: 's1',
              status: { type: 'busy' },
            },
          },
        });

        // Resolve prompt → counter = 2
        promptResolve();
        await delay(10);

        // Cycle 3: counter = 2 >= maxContinuations = 2 → BLOCKED
        ctx.client.session.prompt = mock(async () => ({}));
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });
        await delay(60);

        expect(hasContinuation(ctx.client.session.prompt)).toBe(false);
      });
    });

    describe('CRITICAL-2: disable cancels pending timer', () => {
      test('tool disable during cooldown prevents injection', async () => {
        const ctx = createMockContext({
          todoResult: {
            data: [
              {
                id: '1',
                content: 't1',
                status: 'pending',
                priority: 'high',
              },
            ],
          },
          messagesResult: {
            data: [
              {
                info: { role: 'assistant' },
                parts: [{ type: 'text', text: 'Work' }],
              },
            ],
          },
        });
        const hook = createTodoContinuationHook(ctx, { cooldownMs: 100 });
        await hook.tool.auto_continue.execute({ enabled: true });

        // Fire idle → timer scheduled (100ms cooldown)
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });

        // Disable before timer fires
        await delay(50);
        await hook.tool.auto_continue.execute({ enabled: false });

        // Wait past original cooldown
        await delay(60);

        expect(hasContinuation(ctx.client.session.prompt)).toBe(false);
      });

      test('command disable during cooldown prevents injection', async () => {
        const ctx = createMockContext({
          todoResult: {
            data: [
              {
                id: '1',
                content: 't1',
                status: 'pending',
                priority: 'high',
              },
            ],
          },
          messagesResult: {
            data: [
              {
                info: { role: 'assistant' },
                parts: [{ type: 'text', text: 'Work' }],
              },
            ],
          },
        });
        const hook = createTodoContinuationHook(ctx, { cooldownMs: 100 });

        // Enable via command
        const outputOn = {
          parts: [] as Array<{ type: string; text?: string }>,
        };
        await hook.handleCommandExecuteBefore(
          {
            command: 'auto-continue',
            sessionID: 's1',
            arguments: 'on',
          },
          outputOn,
        );

        // Fire idle → timer scheduled
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });

        // Disable via command before timer fires
        await delay(50);
        const outputOff = {
          parts: [] as Array<{ type: string; text?: string }>,
        };
        await hook.handleCommandExecuteBefore(
          {
            command: 'auto-continue',
            sessionID: 's1',
            arguments: 'off',
          },
          outputOff,
        );

        // Wait past original cooldown
        await delay(60);

        expect(hasContinuation(ctx.client.session.prompt)).toBe(false);
      });
    });

    describe('MAJOR-1: session.deleted resets counter', () => {
      test('deleted orchestrator session resets counter for next session', async () => {
        const ctx = createMockContext({
          todoResult: {
            data: [
              {
                id: '1',
                content: 't1',
                status: 'pending',
                priority: 'high',
              },
            ],
          },
          messagesResult: {
            data: [
              {
                info: { role: 'assistant' },
                parts: [{ type: 'text', text: 'Work' }],
              },
            ],
          },
        });
        const hook = createTodoContinuationHook(ctx, {
          maxContinuations: 2,
          cooldownMs: 50,
        });
        await hook.tool.auto_continue.execute({ enabled: true });

        // Cycle 1: idle → inject → counter = 1
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });
        await delay(60);

        // Delete orchestrator session → counter should reset
        await hook.handleEvent({
          event: {
            type: 'session.deleted',
            properties: { sessionID: 's1' },
          },
        });

        // New session becomes orchestrator — counter starts from 0
        ctx.client.session.prompt.mockClear();
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's2' },
          },
        });
        await delay(60); // counter = 1

        // One more cycle → counter = 2 (reaches max)
        ctx.client.session.prompt.mockClear();
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's2' },
          },
        });
        await delay(60);

        // Third cycle blocked (counter = 2 >= max = 2)
        ctx.client.session.prompt.mockClear();
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's2' },
          },
        });
        await delay(60);

        expect(ctx.client.session.prompt).not.toHaveBeenCalled();
      });
    });

    describe('MAJOR-2: suppressUntil cleared on re-enable', () => {
      test('tool re-enable clears suppress window', async () => {
        const ctx = createMockContext({
          todoResult: {
            data: [
              {
                id: '1',
                content: 't1',
                status: 'pending',
                priority: 'high',
              },
            ],
          },
          messagesResult: {
            data: [
              {
                info: { role: 'assistant' },
                parts: [{ type: 'text', text: 'Work' }],
              },
            ],
          },
        });
        const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });
        await hook.tool.auto_continue.execute({ enabled: true });

        // Fire abort → sets suppress window
        await hook.handleEvent({
          event: {
            type: 'session.error',
            properties: {
              sessionID: 's1',
              error: { name: 'AbortError' },
            },
          },
        });

        // Re-enable within suppress window → clears suppressUntil
        await hook.tool.auto_continue.execute({ enabled: true });

        // Fire idle → should NOT be suppressed
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });
        await delay(60);

        expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
      });

      test('command re-enable clears suppress window', async () => {
        const ctx = createMockContext({
          todoResult: {
            data: [
              {
                id: '1',
                content: 't1',
                status: 'pending',
                priority: 'high',
              },
            ],
          },
          messagesResult: {
            data: [
              {
                info: { role: 'assistant' },
                parts: [{ type: 'text', text: 'Work' }],
              },
            ],
          },
        });
        const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });
        await hook.tool.auto_continue.execute({ enabled: true });

        // Fire abort → sets suppress window
        await hook.handleEvent({
          event: {
            type: 'session.error',
            properties: {
              sessionID: 's1',
              error: { name: 'AbortError' },
            },
          },
        });

        // Re-enable via command → clears suppressUntil
        const output = {
          parts: [] as Array<{ type: string; text?: string }>,
        };
        await hook.handleCommandExecuteBefore(
          {
            command: 'auto-continue',
            sessionID: 's1',
            arguments: 'on',
          },
          output,
        );

        // Fire idle → should NOT be suppressed
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });
        await delay(60);

        expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
      });
    });

    describe('error paths', () => {
      test('prompt failure in timer callback is handled gracefully', async () => {
        const ctx = createMockContext({
          todoResult: {
            data: [
              {
                id: '1',
                content: 't1',
                status: 'pending',
                priority: 'high',
              },
            ],
          },
          messagesResult: {
            data: [
              {
                info: { role: 'assistant' },
                parts: [{ type: 'text', text: 'Work' }],
              },
            ],
          },
        });
        ctx.client.session.prompt = mock(async () => {
          throw new Error('API error');
        });
        const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });

        // Seed orchestrator session
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });

        await hook.tool.auto_continue.execute({ enabled: true });

        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });
        await delay(60);

        // Error caught; isAutoInjecting should be cleared via finally.
        // Verify by checking a second idle still works.
        ctx.client.session.prompt = mock(async () => ({}));
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });
        await delay(60);

        expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
      });
    });

    describe('edge cases', () => {
      test('session.idle with missing sessionID returns early', async () => {
        const ctx = createMockContext();
        const hook = createTodoContinuationHook(ctx);
        await hook.tool.auto_continue.execute({ enabled: true });

        // Fire idle without sessionID — should not throw
        await hook.handleEvent({
          event: { type: 'session.idle', properties: {} },
        });

        expect(ctx.client.session.todo).not.toHaveBeenCalled();
      });

      test('session.deleted with properties.info.id path', async () => {
        const ctx = createMockContext({
          todoResult: {
            data: [
              {
                id: '1',
                content: 't1',
                status: 'pending',
                priority: 'high',
              },
            ],
          },
          messagesResult: {
            data: [
              {
                info: { role: 'assistant' },
                parts: [{ type: 'text', text: 'Work' }],
              },
            ],
          },
        });
        const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });
        await hook.tool.auto_continue.execute({ enabled: true });

        // Set orchestrator via idle
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });
        await delay(60);
        expect(hasContinuation(ctx.client.session.prompt)).toBe(true);

        // Delete via info.id path (alternative shape from session store)
        await hook.handleEvent({
          event: {
            type: 'session.deleted',
            properties: { info: { id: 's1' } },
          },
        });

        // New session should become orchestrator
        ctx.client.session.prompt.mockClear();
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's2' },
          },
        });
        await delay(60);

        expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
        expect(contCall(ctx.client.session.prompt)[0].path.id).toBe('s2');
      });

      test('cooldownMs = 0 fires on next tick', async () => {
        const ctx = createMockContext({
          todoResult: {
            data: [
              {
                id: '1',
                content: 't1',
                status: 'pending',
                priority: 'high',
              },
            ],
          },
          messagesResult: {
            data: [
              {
                info: { role: 'assistant' },
                parts: [{ type: 'text', text: 'Work' }],
              },
            ],
          },
        });
        const hook = createTodoContinuationHook(ctx, {
          cooldownMs: 0,
          maxContinuations: 5,
        });
        await hook.tool.auto_continue.execute({ enabled: true });

        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });
        await delay(10);

        expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
      });
    });

    describe('MAJOR-3: double-fire prevention', () => {
      test('rapid idle events during prompt delivery — single continuation', async () => {
        let promptResolve!: () => void;
        const ctx = createMockContext({
          todoResult: {
            data: [
              {
                id: '1',
                content: 't1',
                status: 'pending',
                priority: 'high',
              },
            ],
          },
          messagesResult: {
            data: [
              {
                info: { role: 'assistant' },
                parts: [{ type: 'text', text: 'Work' }],
              },
            ],
          },
        });
        ctx.client.session.prompt = mock(async () => {
          await new Promise<void>((r) => {
            promptResolve = r;
          });
        });

        const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });
        await hook.tool.auto_continue.execute({ enabled: true });

        // Fire idle → timer → prompt hangs (isAutoInjecting = true)
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });
        await delay(60);

        // Fire another idle while prompt is in flight
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });

        // Only one prompt call (blocked by isAutoInjecting gate)
        expect(contCount(ctx.client.session.prompt)).toBe(1);

        // Resolve prompt
        promptResolve();
        await delay(10);

        // Now idle should schedule a new timer
        ctx.client.session.prompt = mock(async () => ({}));
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 's1' },
          },
        });
        await delay(60);

        expect(contCount(ctx.client.session.prompt)).toBe(1);
      });
    });

    describe('MAJOR-4: command explicit on|off arguments', () => {
      test('command "on" keeps enabled state when already enabled', async () => {
        const ctx = createMockContext();
        const hook = createTodoContinuationHook(ctx);

        // Enable via tool
        await hook.tool.auto_continue.execute({ enabled: true });

        // /auto-continue on → should KEEP enabled (not toggle to off)
        const output = {
          parts: [] as Array<{ type: string; text?: string }>,
        };
        await hook.handleCommandExecuteBefore(
          {
            command: 'auto-continue',
            sessionID: 's1',
            arguments: 'on',
          },
          output,
        );

        expect(output.parts[0].text).not.toContain('disabled');
      });

      test('command "off" keeps disabled state when already disabled', async () => {
        const ctx = createMockContext();
        const hook = createTodoContinuationHook(ctx);

        // Start disabled (default)
        const output = {
          parts: [] as Array<{ type: string; text?: string }>,
        };
        await hook.handleCommandExecuteBefore(
          {
            command: 'auto-continue',
            sessionID: 's1',
            arguments: 'off',
          },
          output,
        );

        expect(output.parts[0].text).toContain('disabled');
      });

      test('command with no argument toggles state', async () => {
        const ctx = createMockContext();
        const hook = createTodoContinuationHook(ctx);

        // First toggle: disabled → enabled
        const output1 = {
          parts: [] as Array<{ type: string; text?: string }>,
        };
        await hook.handleCommandExecuteBefore(
          {
            command: 'auto-continue',
            sessionID: 's1',
            arguments: '',
          },
          output1,
        );
        expect(output1.parts[0].text).not.toContain('disabled');

        // Second toggle: enabled → disabled
        const output2 = {
          parts: [] as Array<{ type: string; text?: string }>,
        };
        await hook.handleCommandExecuteBefore(
          {
            command: 'auto-continue',
            sessionID: 's1',
            arguments: '',
          },
          output2,
        );
        expect(output2.parts[0].text).toContain('disabled');
      });
    });
  });

  describe('session routing and notification cancellation', () => {
    function createPendingCtx() {
      return createMockContext({
        todoResult: {
          data: [
            { id: '1', content: 'todo1', status: 'pending', priority: 'high' },
          ],
        },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Work in progress' }],
            },
          ],
        },
      });
    }

    test('chat.message registers orchestrator sessions without first-idle lockout', async () => {
      const ctx = createPendingCtx();
      const hook = createTodoContinuationHook(ctx, {
        cooldownMs: 50,
      });
      await hook.tool.auto_continue.execute({ enabled: true });

      hook.handleChatMessage({ sessionID: 'sub1', agent: 'fixer' });
      hook.handleChatMessage({ sessionID: 'main1', agent: 'orchestrator' });
      hook.handleChatMessage({ sessionID: 'main2', agent: 'orchestrator' });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'sub1' },
        },
      });
      await delay(60);
      expect(hasContinuation(ctx.client.session.prompt)).toBe(false);

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'main2' },
        },
      });
      await delay(60);

      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
      expect(contCall(ctx.client.session.prompt)[0].path.id).toBe('main2');
    });

    test('chat.message without agent does not block legacy first-idle fallback', async () => {
      const ctx = createPendingCtx();
      const hook = createTodoContinuationHook(ctx, {
        cooldownMs: 50,
        autoEnable: true,
        autoEnableThreshold: 1,
      });

      hook.handleChatMessage({ sessionID: 'main1' });
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'main1' },
        },
      });
      await delay(60);

      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
    });

    test('subagent chat.message prevents first-idle fallback registration', async () => {
      const ctx = createPendingCtx();
      const hook = createTodoContinuationHook(ctx, {
        cooldownMs: 50,
        autoEnable: true,
        autoEnableThreshold: 1,
      });

      hook.handleChatMessage({ sessionID: 'sub1', agent: 'fixer' });
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'sub1' },
        },
      });
      await delay(60);

      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('session.status idle triggers continuation like session.idle', async () => {
      const ctx = createPendingCtx();
      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });
      await hook.tool.auto_continue.execute({ enabled: true });
      hook.handleChatMessage({ sessionID: 'main1', agent: 'orchestrator' });

      await hook.handleEvent({
        event: {
          type: 'session.status',
          properties: { sessionID: 'main1', status: { type: 'idle' } },
        },
      });
      await delay(60);

      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
    });

    test('deleting another orchestrator does not cancel the active session timer', async () => {
      const ctx = createPendingCtx();
      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });
      await hook.tool.auto_continue.execute({ enabled: true });
      hook.handleChatMessage({ sessionID: 'main1', agent: 'orchestrator' });
      hook.handleChatMessage({ sessionID: 'main2', agent: 'orchestrator' });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'main1' },
        },
      });
      await hook.handleEvent({
        event: {
          type: 'session.deleted',
          properties: { sessionID: 'main2' },
        },
      });
      await delay(60);

      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
      expect(contCall(ctx.client.session.prompt)[0].path.id).toBe('main1');
    });

    test('deleting all orchestrators restores legacy first-idle fallback', async () => {
      const ctx = createPendingCtx();
      const hook = createTodoContinuationHook(ctx, {
        cooldownMs: 50,
        autoEnable: true,
        autoEnableThreshold: 1,
      });
      hook.handleChatMessage({ sessionID: 'main1', agent: 'orchestrator' });
      hook.handleChatMessage({ sessionID: 'main2', agent: 'orchestrator' });

      await hook.handleEvent({
        event: {
          type: 'session.deleted',
          properties: { sessionID: 'main1' },
        },
      });
      await hook.handleEvent({
        event: {
          type: 'session.deleted',
          properties: { sessionID: 'main2' },
        },
      });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'legacy-main' },
        },
      });
      await delay(60);

      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
      expect(contCall(ctx.client.session.prompt)[0].path.id).toBe(
        'legacy-main',
      );
    });

    test('countdown notification busy status does not reset max-continuation counter', async () => {
      const ctx = createPendingCtx();
      const releaseNotifications: Array<() => void> = [];
      ctx.client.session.prompt = mock(async (args: any) => {
        if (args?.body?.noReply === true) {
          await new Promise<void>((resolve) => {
            releaseNotifications.push(resolve);
          });
        }
        return {};
      });
      const hook = createTodoContinuationHook(ctx, {
        cooldownMs: 50,
        maxContinuations: 2,
      });
      await hook.tool.auto_continue.execute({ enabled: true });
      hook.handleChatMessage({ sessionID: 'main1', agent: 'orchestrator' });

      for (let i = 0; i < 2; i++) {
        await hook.handleEvent({
          event: {
            type: 'session.idle',
            properties: { sessionID: 'main1' },
          },
        });
        await hook.handleEvent({
          event: {
            type: 'session.status',
            properties: { sessionID: 'main1', status: { type: 'busy' } },
          },
        });
        await delay(60);
        releaseNotifications.shift()?.();
        await delay(10);
      }

      ctx.client.session.prompt.mockClear();
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'main1' },
        },
      });
      await delay(60);

      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('late countdown notification busy status does not cancel continuation timer', async () => {
      const ctx = createPendingCtx();
      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });
      await hook.tool.auto_continue.execute({ enabled: true });
      hook.handleChatMessage({ sessionID: 'main1', agent: 'orchestrator' });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'main1' },
        },
      });
      await delay(10);
      await hook.handleEvent({
        event: {
          type: 'session.status',
          properties: { sessionID: 'main1', status: { type: 'busy' } },
        },
      });
      await delay(60);

      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
    });

    test('countdown notification busy status does not cancel continuation timer', async () => {
      const ctx = createPendingCtx();
      let callCount = 0;
      ctx.client.session.prompt = mock(async () => {
        callCount++;
        return {};
      });
      const hook = createTodoContinuationHook(ctx, { cooldownMs: 50 });
      await hook.tool.auto_continue.execute({ enabled: true });
      hook.handleChatMessage({ sessionID: 'main1', agent: 'orchestrator' });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'main1' },
        },
      });
      await hook.handleEvent({
        event: {
          type: 'session.status',
          properties: { sessionID: 'main1', status: { type: 'busy' } },
        },
      });
      await delay(60);

      expect(callCount).toBeGreaterThanOrEqual(2);
      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
    });
  });

  describe('auto-enable on todo count', () => {
    function createAutoEnableCtx(
      todos: Array<{
        id: string;
        content: string;
        status: string;
        priority: string;
      }>,
    ) {
      return createMockContext({
        todoResult: { data: todos },
        messagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Working...' }],
            },
          ],
        },
      });
    }

    test('autoEnable=true, todos >= threshold → auto-enables and continues', async () => {
      const ctx = createAutoEnableCtx([
        { id: '1', content: 't1', status: 'pending', priority: 'high' },
        { id: '2', content: 't2', status: 'pending', priority: 'high' },
        { id: '3', content: 't3', status: 'pending', priority: 'high' },
        { id: '4', content: 't4', status: 'pending', priority: 'high' },
      ]);
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 5,
        cooldownMs: 50,
        autoEnable: true,
        autoEnableThreshold: 4,
      });

      // Do NOT manually enable — auto-enable should trigger
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 's1' },
        },
      });

      await delay(60);

      // Should have scheduled continuation (auto-enabled)
      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
    });

    test('autoEnable=true, todos < threshold → does NOT auto-enable', async () => {
      const ctx = createAutoEnableCtx([
        { id: '1', content: 't1', status: 'pending', priority: 'high' },
        { id: '2', content: 't2', status: 'pending', priority: 'high' },
        { id: '3', content: 't3', status: 'pending', priority: 'high' },
      ]);
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 5,
        cooldownMs: 50,
        autoEnable: true,
        autoEnableThreshold: 4,
      });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 's1' },
        },
      });

      await delay(60);

      // Should NOT auto-enable or continue
      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('autoEnable=false (default) → never auto-enables regardless of todo count', async () => {
      const ctx = createAutoEnableCtx(
        Array.from({ length: 10 }, (_, i) => ({
          id: String(i),
          content: `t${i}`,
          status: 'pending',
          priority: 'high',
        })),
      );
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 5,
        cooldownMs: 50,
        // autoEnable defaults to false
      });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 's1' },
        },
      });

      await delay(60);

      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('auto-enable does not re-enable if already manually enabled', async () => {
      const ctx = createAutoEnableCtx([
        { id: '1', content: 't1', status: 'pending', priority: 'high' },
        { id: '2', content: 't2', status: 'pending', priority: 'high' },
      ]);
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 5,
        cooldownMs: 50,
        autoEnable: true,
        autoEnableThreshold: 4,
      });

      // Manually enable first
      await hook.tool.auto_continue.execute({ enabled: true });

      // Only 2 todos (< threshold) — but already enabled, so should continue
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 's1' },
        },
      });

      await delay(60);

      // Continues because already manually enabled (auto-enable check skipped)
      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
    });

    test('auto-enable respects custom threshold', async () => {
      const ctx = createAutoEnableCtx([
        { id: '1', content: 't1', status: 'pending', priority: 'high' },
        { id: '2', content: 't2', status: 'pending', priority: 'high' },
      ]);
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 5,
        cooldownMs: 50,
        autoEnable: true,
        autoEnableThreshold: 2,
      });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 's1' },
        },
      });

      await delay(60);

      // 2 todos >= threshold 2 → auto-enables
      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
    });

    test('auto-enable skipped for non-orchestrator session', async () => {
      const ctx = createAutoEnableCtx([
        { id: '1', content: 't1', status: 'pending', priority: 'high' },
        { id: '2', content: 't2', status: 'pending', priority: 'high' },
        { id: '3', content: 't3', status: 'pending', priority: 'high' },
        { id: '4', content: 't4', status: 'pending', priority: 'high' },
      ]);
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 5,
        cooldownMs: 50,
        autoEnable: true,
        autoEnableThreshold: 4,
      });

      // First idle sets orchestrator to session-A
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-A' },
        },
      });
      await delay(60);

      // Reset mock
      ctx.client.session.prompt.mockClear();

      // Second idle from session-B — not orchestrator, should skip
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-B' },
        },
      });
      await delay(60);

      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('auto-enable with todo fetch failure → no auto-enable, no crash', async () => {
      const ctx = createMockContext();
      ctx.client.session.todo = mock(async () => {
        throw new Error('Network error');
      });
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 5,
        cooldownMs: 50,
        autoEnable: true,
        autoEnableThreshold: 4,
      });

      // Should not throw
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 's1' },
        },
      });

      await delay(60);

      // No auto-enable, no continuation
      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });

    test('auto-enable resets consecutive counter and suppress window', async () => {
      const ctx = createAutoEnableCtx([
        { id: '1', content: 't1', status: 'pending', priority: 'high' },
        { id: '2', content: 't2', status: 'pending', priority: 'high' },
        { id: '3', content: 't3', status: 'pending', priority: 'high' },
        { id: '4', content: 't4', status: 'pending', priority: 'high' },
      ]);
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 5,
        cooldownMs: 50,
        autoEnable: true,
        autoEnableThreshold: 4,
      });

      // Manually enable, run a continuation, disable
      await hook.tool.auto_continue.execute({ enabled: true });
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 's1' },
        },
      });
      await delay(60);

      // Fire abort to set suppress window
      await hook.handleEvent({
        event: {
          type: 'session.error',
          properties: {
            sessionID: 's1',
            error: { name: 'AbortError' },
          },
        },
      });

      // Disable
      await hook.tool.auto_continue.execute({ enabled: false });

      // Reset mock
      ctx.client.session.prompt.mockClear();

      // Fire idle again — auto-enable should trigger (4 todos >= 4),
      // resetting counter and suppress window
      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 's1' },
        },
      });

      await delay(60);

      // Should continue (suppressed window was cleared by auto-enable)
      expect(hasContinuation(ctx.client.session.prompt)).toBe(true);
    });

    test('auto-enable counts incomplete todos only, not completed', async () => {
      const ctx = createAutoEnableCtx([
        { id: '1', content: 't1', status: 'completed', priority: 'high' },
        { id: '2', content: 't2', status: 'completed', priority: 'high' },
        { id: '3', content: 't3', status: 'pending', priority: 'high' },
        { id: '4', content: 't4', status: 'pending', priority: 'high' },
      ]);
      const hook = createTodoContinuationHook(ctx, {
        maxContinuations: 5,
        cooldownMs: 50,
        autoEnable: true,
        autoEnableThreshold: 4,
      });

      await hook.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 's1' },
        },
      });

      await delay(60);

      // Only 2 incomplete todos < threshold 4 → does NOT auto-enable
      expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    });
  });
});
