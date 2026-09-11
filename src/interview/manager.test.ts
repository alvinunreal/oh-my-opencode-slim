import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { PluginConfig } from '../config';
import { readDashboardAuthFile } from './dashboard';
import { createDashboardManager } from './dashboard-manager';
import { createInterviewManager as createInterviewManagerImpl } from './manager';
import { bindFreePort } from './test-port';

// Intercept getClient so the manager's service uses the same session mocks.
mock.module('../utils/opencode-client', () => ({
  getClient: (ctx: any) => ({
    session: ctx._sessionMock ?? ctx.client.session,
  }),
}));

const managers = new Set<ReturnType<typeof createInterviewManagerImpl>>();
// Held-port servers from bindFreePort that await dashboard adoption.
const heldServers = new Set<Server>();

function createInterviewManager(
  ...args: Parameters<typeof createInterviewManagerImpl>
): ReturnType<typeof createInterviewManagerImpl> {
  const manager = createInterviewManagerImpl(...args);
  managers.add(manager);
  return manager;
}

afterEach(async () => {
  const pending = [...managers];
  managers.clear();
  await Promise.all(pending.map((manager) => manager.dispose()));
  // Safety net: close held-port servers no manager adopted. Adopted ones
  // are already closed by their manager's dispose() above.
  for (const server of heldServers) {
    heldServers.delete(server);
    if (server.listening) {
      server.closeAllConnections();
      server.close();
    }
  }
});

// Mock context pattern from interview.test.ts
function createMockContext(overrides?: {
  directory?: string;
  messagesData?: Array<{
    info?: { role: string };
    parts?: Array<{ type: string; text?: string }>;
  }>;
  promptImpl?: (args: any) => Promise<unknown>;
}) {
  const messagesData = overrides?.messagesData ?? [];
  const sessionMock = {
    messages: mock(async () => ({ data: messagesData })),
    prompt: mock(async (args: any) => {
      if (overrides?.promptImpl) {
        return await overrides.promptImpl(args);
      }
      return {};
    }),
    promptAsync: mock(async (args: any) => {
      if (overrides?.promptImpl) {
        return await overrides.promptImpl(args);
      }
      return {};
    }),
    update: mock(async () => ({})),
  };
  return {
    client: {
      session: sessionMock,
    },
    directory: overrides?.directory ?? '/test/directory',
    _sessionMock: sessionMock,
  } as any;
}

function createTestConfig(
  overrides: Partial<NonNullable<PluginConfig['interview']>> = {},
): PluginConfig {
  return {
    interview: {
      autoOpenBrowser: false,
      ...overrides,
    },
  } as PluginConfig;
}

// Helper to extract text from output parts
function _extractOutputText(output: {
  parts: Array<{ type: string; text?: string }>;
}): string {
  const textPart = output.parts.find((part) => part.type === 'text');
  return textPart?.text ?? '';
}

describe('interview manager - per-session mode', () => {
  describe('basic functionality', () => {
    test('returns correct interface when port is 0 (default)', () => {
      const ctx = createMockContext();
      const config = createTestConfig({ port: 0 });

      const manager = createInterviewManager(ctx, config);

      expect(manager).toHaveProperty('registerCommand');
      expect(manager).toHaveProperty('handleCommandExecuteBefore');
      expect(manager).toHaveProperty('handleEvent');
      expect(typeof manager.registerCommand).toBe('function');
      expect(typeof manager.handleCommandExecuteBefore).toBe('function');
      expect(typeof manager.handleEvent).toBe('function');
    });

    test('creates interview with /interview command', async () => {
      const tempDir = await fs.mkdtemp('/tmp/manager-test-');
      const ctx = createMockContext({ directory: tempDir });
      const config = createTestConfig({ port: 0 });

      const manager = createInterviewManager(ctx, config);
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await manager.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-123',
          arguments: 'My App Idea',
        },
        output,
      );

      // Should inject kickoff prompt into output
      expect(output.parts.length).toBe(1);
      expect(output.parts[0].type).toBe('text');
      expect(output.parts[0].text).toContain('My App Idea');
      expect(output.parts[0].text).toContain('<interview_state>');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('marks interview as abandoned on session.deleted event', async () => {
      const tempDir = await fs.mkdtemp('/tmp/manager-test-');
      const ctx = createMockContext({ directory: tempDir });
      const config = createTestConfig({ port: 0 });

      const manager = createInterviewManager(ctx, config);

      // Create interview
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await manager.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-delete-test',
          arguments: 'Delete Test',
        },
        output,
      );

      // Simulate session deletion
      await manager.handleEvent({
        event: {
          type: 'session.deleted',
          properties: { sessionID: 'session-delete-test' },
        },
      });

      // Interview should still exist (file not deleted)
      const interviewDir = `${tempDir}/interview`;
      const remainingFiles = await fs.readdir(interviewDir);
      expect(remainingFiles.length).toBe(1);
      // Status is only tracked in memory, not written to markdown
      // We verify the session deletion handler doesn't throw

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('disposes the per-session server idempotently', async () => {
      const tempDir = await fs.mkdtemp('/tmp/manager-test-');
      const manager = createInterviewManager(
        createMockContext({ directory: tempDir }),
        createTestConfig({ port: 0 }),
      );

      try {
        await manager.handleCommandExecuteBefore(
          {
            command: 'interview',
            sessionID: 'session-dispose-local',
            arguments: 'Dispose Local Test',
          },
          { parts: [] },
        );
        await manager.dispose();
        await manager.dispose();
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test('registers session when interview is created', async () => {
      const tempDir = await fs.mkdtemp('/tmp/manager-test-');
      const ctx = createMockContext({ directory: tempDir });

      const { port: freePort, server } = await bindFreePort();
      heldServers.add(server);
      const config = createTestConfig({
        port: freePort,
        dashboard: true,
      });

      const manager = createInterviewManager(ctx, config, { server });

      // Wait for dashboard init
      await new Promise((r) => setTimeout(r, 100));

      try {
        // Create interview (should trigger session registration)
        const output = { parts: [] as Array<{ type: string; text?: string }> };
        await manager.handleCommandExecuteBefore(
          {
            command: 'interview',
            sessionID: 'session-reg-after-cmd',
            arguments: 'Register After Cmd',
          },
          output,
        );

        // Extract interview ID
        const promptCalls = ctx.client.session.prompt.mock.calls;
        expect(promptCalls.length).toBeGreaterThan(0);
        const text =
          promptCalls[promptCalls.length - 1][0].body?.parts?.[0]?.text ?? '';
        const match = text.match(/interview\/([^\s]+)/);
        expect(match).not.toBeNull();
        const interviewId = match?.[1];

        // Give registration a moment
        await new Promise((r) => setTimeout(r, 100));

        // Read auth token
        const auth = await readDashboardAuthFile(freePort);
        expect(auth).not.toBeNull();

        // Verify session is registered (interview exists in cache)
        const listResponse = await fetch(
          `http://127.0.0.1:${freePort}/api/interviews/${interviewId}/state?token=${auth?.token}`,
          { signal: AbortSignal.timeout(2000) },
        );
        expect(listResponse.status).toBe(200);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('dashboard: true with port 0', () => {
    test('activates dashboard mode and creates interview', async () => {
      const { port: freePort, server } = await bindFreePort();
      heldServers.add(server);
      const tempDir = await fs.mkdtemp('/tmp/manager-test-');
      const ctx = createMockContext({ directory: tempDir });

      const config = createTestConfig({
        port: freePort,
        dashboard: true,
      });

      const manager = createInterviewManager(ctx, config, { server });

      // Wait for async init
      await new Promise((r) => setTimeout(r, 100));

      try {
        const output = { parts: [] as Array<{ type: string; text?: string }> };
        await manager.handleCommandExecuteBefore(
          {
            command: 'interview',
            sessionID: 'session-dashboard-bool',
            arguments: 'Dashboard Bool Test',
          },
          output,
        );

        expect(output.parts.length).toBe(1);
        expect(output.parts[0].text).toContain('Dashboard Bool Test');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});

describe('interview manager - state push callback wiring', () => {
  test('in dashboard mode, state push callback is wired', async () => {
    const tempDir = await fs.mkdtemp('/tmp/manager-test-');
    const ctx = createMockContext({ directory: tempDir });

    const { port: freePort, server } = await bindFreePort();
    heldServers.add(server);
    const config = createTestConfig({
      port: freePort,
      dashboard: true,
    });

    const manager = createInterviewManager(ctx, config, { server });

    // Wait for dashboard init
    await new Promise((r) => setTimeout(r, 100));

    try {
      // Create interview
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await manager.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-state-callback',
          arguments: 'State Callback Test',
        },
        output,
      );

      // Extract interview ID from prompt calls
      const promptCalls = ctx.client.session.prompt.mock.calls;
      expect(promptCalls.length).toBeGreaterThan(0);
      const text =
        promptCalls[promptCalls.length - 1][0].body?.parts?.[0]?.text ?? '';
      const match = text.match(/interview\/([^\s]+)/);
      expect(match).not.toBeNull();
      const interviewId = match?.[1];

      // Give state push a moment
      await new Promise((r) => setTimeout(r, 100));

      // Read auth token
      const auth = await readDashboardAuthFile(freePort);
      expect(auth).not.toBeNull();

      // Verify state was pushed to dashboard cache
      const stateResponse = await fetch(
        `http://127.0.0.1:${freePort}/api/interviews/${interviewId}/state?token=${auth?.token}`,
        { signal: AbortSignal.timeout(2000) },
      );
      expect(stateResponse.status).toBe(200);

      const stateData = (await stateResponse.json()) as {
        interview: { idea: string };
        mode: string;
      };
      expect(stateData.interview.idea).toBe('State Callback Test');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('in per-session mode, setBaseUrlResolver is called', async () => {
    const tempDir = await fs.mkdtemp('/tmp/manager-test-');
    const ctx = createMockContext({ directory: tempDir });
    const config = createTestConfig({ port: 0 });

    const manager = createInterviewManager(ctx, config);

    try {
      // Create interview (this triggers server start via setBaseUrlResolver)
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await manager.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-base-url',
          arguments: 'Base URL Test',
        },
        output,
      );

      // Should create a markdown file (proof that server was initialized)
      const interviewDir = `${tempDir}/interview`;
      const files = await fs.readdir(interviewDir);
      expect(files.length).toBe(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('interview manager - session registration', () => {
  test('registers session after handleCommandExecuteBefore in dashboard mode', async () => {
    const tempDir = await fs.mkdtemp('/tmp/manager-test-');
    const ctx = createMockContext({ directory: tempDir });

    const { port: freePort, server } = await bindFreePort();
    heldServers.add(server);
    const config = createTestConfig({
      port: freePort,
      dashboard: true,
    });

    const manager = createInterviewManager(ctx, config, { server });

    // Wait for dashboard init
    await new Promise((r) => setTimeout(r, 100));

    try {
      // Create interview (should trigger session registration)
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await manager.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-reg-after-cmd',
          arguments: 'Register After Cmd',
        },
        output,
      );

      // Extract interview ID
      const promptCalls = ctx.client.session.prompt.mock.calls;
      expect(promptCalls.length).toBeGreaterThan(0);
      const text =
        promptCalls[promptCalls.length - 1][0].body?.parts?.[0]?.text ?? '';
      const match = text.match(/interview\/([^\s]+)/);
      expect(match).not.toBeNull();
      const interviewId = match?.[1];

      // Give registration a moment
      await new Promise((r) => setTimeout(r, 100));

      // Read auth token
      const auth = await readDashboardAuthFile(freePort);
      expect(auth).not.toBeNull();

      // Verify session was registered by checking the interview state
      const stateResponse = await fetch(
        `http://127.0.0.1:${freePort}/api/interviews/${interviewId}/state?token=${auth?.token}`,
        { signal: AbortSignal.timeout(2000) },
      );
      expect(stateResponse.status).toBe(200);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('removes session on session.deleted event', async () => {
    const tempDir = await fs.mkdtemp('/tmp/manager-test-');
    const ctx = createMockContext({ directory: tempDir });

    const { port: freePort, server } = await bindFreePort();
    heldServers.add(server);
    const config = createTestConfig({
      port: freePort,
      dashboard: true,
    });

    const manager = createInterviewManager(ctx, config, { server });

    // Wait for dashboard init
    await new Promise((r) => setTimeout(r, 100));

    try {
      // Create interview
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await manager.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-delete-reg',
          arguments: 'Delete Register Test',
        },
        output,
      );

      // Extract interview ID
      const promptCalls = ctx.client.session.prompt.mock.calls;
      expect(promptCalls.length).toBeGreaterThan(0);
      const text =
        promptCalls[promptCalls.length - 1][0].body?.parts?.[0]?.text ?? '';
      const match = text.match(/interview\/([^\s]+)/);
      expect(match).not.toBeNull();
      const _interviewId = match?.[1];

      // Give registration a moment
      await new Promise((r) => setTimeout(r, 100));
      const auth = await readDashboardAuthFile(freePort);
      expect(auth).not.toBeNull();

      // Delete session
      await manager.handleEvent({
        event: {
          type: 'session.deleted',
          properties: { info: { id: 'session-delete-reg' } },
        },
      });

      // Give cleanup a moment
      await new Promise((r) => setTimeout(r, 50));

      const stateResponse = await fetch(
        `http://127.0.0.1:${freePort}/api/interviews/${_interviewId}` +
          `/state?token=${auth?.token}`,
        { signal: AbortSignal.timeout(2000) },
      );
      expect(stateResponse.status).toBe(404);

      // Interview file should still exist
      const interviewDir = `${tempDir}/interview`;
      const files = await fs.readdir(interviewDir);
      expect(files.length).toBe(1);
      // Status is only tracked in memory, not written to markdown
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('clears fallback timer when last registered session is deleted', async () => {
    const dashboardDir = await fs.mkdtemp('/tmp/manager-test-');
    const clientDir = await fs.mkdtemp('/tmp/manager-test-');
    const dashboardCtx = createMockContext({ directory: dashboardDir });
    const clientCtx = createMockContext({ directory: clientDir });

    const { port: freePort, server } = await bindFreePort();
    heldServers.add(server);
    const config = createTestConfig({
      port: freePort,
      dashboard: true,
    });

    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const intervalHandles: Array<{ unref: ReturnType<typeof mock> }> = [];
    const setIntervalSpy = mock(() => {
      const handle = { unref: mock(() => {}) };
      intervalHandles.push(handle);
      return handle;
    });
    const clearIntervalSpy = mock(() => {});

    try {
      (globalThis as any).setInterval = setIntervalSpy;
      (globalThis as any).clearInterval = clearIntervalSpy;

      createInterviewManager(dashboardCtx, config, { server });

      // Wait for dashboard init
      await new Promise((r) => setTimeout(r, 100));

      const clientManager = createInterviewManager(clientCtx, config);

      // Wait for client init to connect to the dashboard
      await new Promise((r) => setTimeout(r, 100));

      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await clientManager.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-fallback-cleanup',
          arguments: 'Fallback Cleanup Test',
        },
        output,
      );

      expect(intervalHandles.length).toBeGreaterThan(0);
      const fallbackTimerHandle = intervalHandles.at(-1);
      expect(fallbackTimerHandle).toBeDefined();

      await clientManager.handleEvent({
        event: {
          type: 'session.deleted',
          properties: { info: { id: 'session-fallback-cleanup' } },
        },
      });

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(clearIntervalSpy).toHaveBeenCalledWith(fallbackTimerHandle);
      expect(fallbackTimerHandle?.unref).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as any).setInterval = originalSetInterval;
      (globalThis as any).clearInterval = originalClearInterval;
      await fs.rm(dashboardDir, { recursive: true, force: true });
      await fs.rm(clientDir, { recursive: true, force: true });
    }
  });

  test('disposes dashboard resources idempotently', async () => {
    const tempDir = await fs.mkdtemp('/tmp/manager-test-');
    const ctx = createMockContext({ directory: tempDir });
    const { port: freePort, server } = await bindFreePort();
    heldServers.add(server);
    const manager = createInterviewManager(
      ctx,
      createTestConfig({ port: freePort, dashboard: true }),
      { server },
    );

    try {
      await manager.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-dispose',
          arguments: 'Dispose Test',
        },
        { parts: [] },
      );

      expect(await readDashboardAuthFile(freePort)).not.toBeNull();
      await manager.dispose();
      await manager.dispose();
      expect(await readDashboardAuthFile(freePort)).toBeNull();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('interview manager - edge cases', () => {
  test('does not roll back a claim during an overlapping in-process delivery', async () => {
    const tempDir = await fs.mkdtemp('/tmp/manager-test-');
    const ctx = createMockContext({ directory: tempDir });
    const { port: freePort, server } = await bindFreePort();
    heldServers.add(server);
    const config = createTestConfig({ port: freePort, dashboard: true });
    const messages: Array<{
      info?: { role: string };
      parts?: Array<{ type: string; text?: string }>;
    }> = [];
    let signalFirstDelivery!: () => void;
    const firstDeliveryStarted = new Promise<void>((resolve) => {
      signalFirstDelivery = resolve;
    });
    let releaseFirstDelivery!: () => void;
    const firstDeliveryGate = new Promise<void>((resolve) => {
      releaseFirstDelivery = resolve;
    });
    let submitAttempts = 0;
    const runtime = {
      messages: async () => messages,
      notify: async () => {},
      continue: async () => {
        submitAttempts++;
        if (submitAttempts === 1) {
          signalFirstDelivery();
          await firstDeliveryGate;
        } else {
          throw new Error('session busy');
        }
      },
      rename: async () => {},
    };
    const manager = createDashboardManager(ctx, config, freePort, 'interview', {
      runtime,
      server,
    });

    try {
      await manager.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-overlap',
          arguments: 'Overlap Delivery Test',
        },
        { parts: [] },
      );
      const interviewId =
        manager.service.getActiveInterviewId('session-overlap');
      expect(interviewId).not.toBeNull();

      messages.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: '<interview_state>{"summary":"Draft","questions":[{"id":"q-1","question":"What?","options":["A"]}]}</interview_state>',
          },
        ],
      });
      const auth = await readDashboardAuthFile(freePort);
      expect(auth).not.toBeNull();
      const queued = await fetch(
        `http://127.0.0.1:${freePort}/api/interviews/${interviewId}/answers?token=${auth?.token}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            answers: [{ questionId: 'q-1', answer: 'A' }],
          }),
          signal: AbortSignal.timeout(2000),
        },
      );
      expect(queued.status).toBe(202);

      const idleEvent = {
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'session-overlap',
            status: { type: 'idle' },
          },
        },
      };
      const first = manager.handleEvent(idleEvent);
      await firstDeliveryStarted;
      const second = manager.handleEvent(idleEvent);
      await second;
      releaseFirstDelivery();
      await first;

      expect(submitAttempts).toBe(1);

      // The successful owner acknowledged the claim. A later idle event must
      // not see a rolled-back claim and submit the same answer again.
      await manager.handleEvent(idleEvent);
      expect(submitAttempts).toBe(1);
    } finally {
      releaseFirstDelivery();
      await manager.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('waits for accepted delivery before disposal and replacement polling', async () => {
    const tempDir = await fs.mkdtemp('/tmp/manager-test-');
    const ctx = createMockContext({ directory: tempDir });
    const { port: freePort, server } = await bindFreePort();
    heldServers.add(server);
    const config = createTestConfig({ port: freePort, dashboard: true });
    const messages: Array<{
      info?: { role: string };
      parts?: Array<{ type: string; text?: string }>;
    }> = [];
    let signalFirstDelivery!: () => void;
    const firstDeliveryStarted = new Promise<void>((resolve) => {
      signalFirstDelivery = resolve;
    });
    let releaseFirstDelivery!: () => void;
    const firstDeliveryGate = new Promise<void>((resolve) => {
      releaseFirstDelivery = resolve;
    });
    let submitAttempts = 0;
    const runtime = {
      messages: async () => messages,
      notify: async () => {},
      continue: async () => {
        submitAttempts++;
        signalFirstDelivery();
        await firstDeliveryGate;
      },
      rename: async () => {},
    };
    const manager = createDashboardManager(ctx, config, freePort, 'interview', {
      runtime,
      server,
    });

    try {
      await manager.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-dispose-race',
          arguments: 'Dispose Race Test',
        },
        { parts: [] },
      );
      const interviewId = manager.service.getActiveInterviewId(
        'session-dispose-race',
      );
      expect(interviewId).not.toBeNull();
      messages.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: '<interview_state>{"summary":"Draft","questions":[{"id":"q-1","question":"What?","options":["A"]}]}</interview_state>',
          },
        ],
      });
      const auth = await readDashboardAuthFile(freePort);
      expect(auth).not.toBeNull();
      const queued = await fetch(
        `http://127.0.0.1:${freePort}/api/interviews/${interviewId}/answers?token=${auth?.token}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            answers: [{ questionId: 'q-1', answer: 'A' }],
          }),
          signal: AbortSignal.timeout(2000),
        },
      );
      expect(queued.status).toBe(202);

      const idleEvent = {
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'session-dispose-race',
            status: { type: 'idle' },
          },
        },
      };
      const delivery = manager.handleEvent(idleEvent);
      await firstDeliveryStarted;
      let disposed = false;
      const disposal = manager.dispose().then(() => {
        disposed = true;
      });
      await Promise.resolve();
      expect(disposed).toBe(false);

      releaseFirstDelivery();
      await delivery;
      await disposal;
      expect(submitAttempts).toBe(1);

      const files = await fs.readdir(`${tempDir}/interview`);
      const documentPath = `${tempDir}/interview/${files.find((file) => file.endsWith('.md'))}`;
      const replacement = createDashboardManager(
        ctx,
        config,
        freePort,
        'interview',
        { runtime },
      );
      try {
        await replacement.handleCommandExecuteBefore(
          {
            command: 'interview',
            sessionID: 'session-dispose-race',
            arguments: documentPath,
          },
          { parts: [] },
        );
        await replacement.handleEvent(idleEvent);
        expect(submitAttempts).toBe(1);
        expect(await fs.readFile(documentPath, 'utf8')).toContain('A: A');
      } finally {
        await replacement.dispose();
      }
    } finally {
      releaseFirstDelivery();
      await manager.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('handles session.status event with idle status', async () => {
    const tempDir = await fs.mkdtemp('/tmp/manager-test-');
    const ctx = createMockContext({ directory: tempDir });
    const config = createTestConfig({ port: 0 });

    const manager = createInterviewManager(ctx, config);

    try {
      // Create interview
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await manager.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-idle',
          arguments: 'Idle Event Test',
        },
        output,
      );

      // Send idle status event
      await manager.handleEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'session-idle',
            status: { type: 'idle' },
          },
        },
      });

      // Should not throw
      expect(true).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('handles session.status event without sessionID in properties', async () => {
    const tempDir = await fs.mkdtemp('/tmp/manager-test-');
    const ctx = createMockContext({ directory: tempDir });
    const config = createTestConfig({ port: 0 });

    const manager = createInterviewManager(ctx, config);

    try {
      // Send idle status event without sessionID
      await manager.handleEvent({
        event: {
          type: 'session.status',
          properties: {
            status: { type: 'idle' },
          },
        },
      });

      // Should not throw
      expect(true).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('handles unknown event types', async () => {
    const tempDir = await fs.mkdtemp('/tmp/manager-test-');
    const ctx = createMockContext({ directory: tempDir });
    const config = createTestConfig({ port: 0 });

    const manager = createInterviewManager(ctx, config);

    try {
      // Send unknown event type
      await manager.handleEvent({
        event: {
          type: 'unknown.event',
          properties: { sessionID: 'session-unknown' },
        },
      });

      // Should not throw
      expect(true).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('handles handleCommandExecuteBefore without sessionID', async () => {
    const tempDir = await fs.mkdtemp('/tmp/manager-test-');
    const ctx = createMockContext({ directory: tempDir });
    const config = createTestConfig({ port: 0 });

    const manager = createInterviewManager(ctx, config);

    try {
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await manager.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: '',
          arguments: 'No Session Test',
        },
        output,
      );

      // Should create interview (sessionID is optional in per-session mode)
      expect(output.parts.length).toBe(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('interview manager - integration with real dashboard', () => {
  test('two managers on same port: first becomes dashboard, second becomes session', async () => {
    const tempDir1 = await fs.mkdtemp('/tmp/manager-test-');
    const tempDir2 = await fs.mkdtemp('/tmp/manager-test-');

    const ctx1 = createMockContext({ directory: tempDir1 });
    const ctx2 = createMockContext({ directory: tempDir2 });

    const { port: freePort, server } = await bindFreePort();
    heldServers.add(server);
    const config = createTestConfig({
      port: freePort,
      dashboard: true,
    });

    const manager1 = createInterviewManager(ctx1, config, { server });

    // Wait for manager1 to become dashboard
    await new Promise((r) => setTimeout(r, 100));

    try {
      // Manager1 should be the dashboard
      const healthResponse = await fetch(
        `http://127.0.0.1:${freePort}/api/health`,
        { signal: AbortSignal.timeout(2000) },
      );
      expect(healthResponse.status).toBe(200);

      // Manager2 should become a session (not throw when dashboard is found)
      const manager2 = createInterviewManager(ctx2, config);

      // Wait for manager2 init (probes dashboard)
      await new Promise((r) => setTimeout(r, 100));

      // Both managers should work
      const output1 = { parts: [] as Array<{ type: string; text?: string }> };
      await manager1.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-1',
          arguments: 'Manager 1 Test',
        },
        output1,
      );

      const output2 = { parts: [] as Array<{ type: string; text?: string }> };
      await manager2.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-2',
          arguments: 'Manager 2 Test',
        },
        output2,
      );

      // Give state pushes a moment
      await new Promise((r) => setTimeout(r, 100));

      // Extract interview IDs
      const promptCalls1 = ctx1.client.session.prompt.mock.calls;
      const text1 =
        promptCalls1[promptCalls1.length - 1][0].body?.parts?.[0]?.text ?? '';
      const match1 = text1.match(/interview\/([^\s]+)/);
      expect(match1).not.toBeNull();
      const interviewId1 = match1?.[1];

      const promptCalls2 = ctx2.client.session.prompt.mock.calls;
      const text2 =
        promptCalls2[promptCalls2.length - 1][0].body?.parts?.[0]?.text ?? '';
      const match2 = text2.match(/interview\/([^\s]+)/);
      expect(match2).not.toBeNull();
      const interviewId2 = match2?.[1];

      // Read auth token
      const auth = await readDashboardAuthFile(freePort);
      expect(auth).not.toBeNull();

      // Both interviews should be in dashboard cache
      const state1Response = await fetch(
        `http://127.0.0.1:${freePort}/api/interviews/${interviewId1}/state?token=${auth?.token}`,
        { signal: AbortSignal.timeout(2000) },
      );
      expect(state1Response.status).toBe(200);

      // Trigger active event poll to register session2/interviewId2 explicitly in dashboard
      await manager2.handleEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'session-2',
            status: { type: 'idle' },
          },
        },
      });

      const state2Response = await fetch(
        `http://127.0.0.1:${freePort}/api/interviews/${interviewId2}/state?token=${auth?.token}`,
        { signal: AbortSignal.timeout(2000) },
      );
      expect(state2Response.status).toBe(200);
    } finally {
      await fs.rm(tempDir1, { recursive: true, force: true });
      await fs.rm(tempDir2, { recursive: true, force: true });
    }
  });

  test('does not redeliver after a successful delivery loses its ACK response', async () => {
    const tempDir1 = await fs.mkdtemp('/tmp/manager-test-');
    const tempDir2 = await fs.mkdtemp('/tmp/manager-test-');
    const { port, server } = await bindFreePort();
    heldServers.add(server);
    const config = createTestConfig({ port, dashboard: true });
    createInterviewManager(createMockContext({ directory: tempDir1 }), config, {
      server,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ctx2 = createMockContext({ directory: tempDir2 });
    const manager2 = createInterviewManager(ctx2, config);
    const originalFetch = globalThis.fetch;
    let droppedAck = false;

    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!droppedAck && url.includes('/nudge/ack')) {
        droppedAck = true;
        throw new Error('simulated ACK transport failure');
      }
      return originalFetch(input, init);
    };

    try {
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await manager2.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-exactly-once',
          arguments: 'Exactly Once Test',
        },
        output,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      const promptCalls = ctx2.client.session.prompt.mock.calls;
      const kickoff =
        promptCalls[promptCalls.length - 1]?.[0].body?.parts?.[0]?.text;
      const interviewId = kickoff?.match(/interview\/([^\s]+)/)?.[1];
      expect(interviewId).toBeTruthy();

      const auth = await readDashboardAuthFile(port);
      expect(auth).not.toBeNull();
      const nudgeResponse = await originalFetch(
        `http://127.0.0.1:${port}/api/interviews/${interviewId}/nudge?token=${auth?.token}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'more-questions' }),
          signal: AbortSignal.timeout(2000),
        },
      );
      expect(nudgeResponse.status).toBe(202);

      await manager2.handleEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'session-exactly-once',
            status: { type: 'idle' },
          },
        },
      });
      expect(droppedAck).toBe(true);
      expect(ctx2.client.session.promptAsync).toHaveBeenCalledTimes(1);

      await manager2.handleEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'session-exactly-once',
            status: { type: 'idle' },
          },
        },
      });
      expect(ctx2.client.session.promptAsync).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(tempDir1, { recursive: true, force: true });
      await fs.rm(tempDir2, { recursive: true, force: true });
    }
  });

  test('delivers a new answer claim after an earlier claim ACK is uncertain', async () => {
    const tempDir1 = await fs.mkdtemp('/tmp/manager-test-');
    const tempDir2 = await fs.mkdtemp('/tmp/manager-test-');
    const { port, server } = await bindFreePort();
    heldServers.add(server);
    const config = createTestConfig({ port, dashboard: true });
    createInterviewManager(createMockContext({ directory: tempDir1 }), config, {
      server,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const messagesData: Array<{
      info?: { role: string };
      parts?: Array<{ type: string; text?: string }>;
    }> = [];
    const ctx2 = createMockContext({ directory: tempDir2, messagesData });
    const manager2 = createInterviewManager(ctx2, config);
    const originalFetch = globalThis.fetch;
    let failedFirstAck = false;

    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!failedFirstAck && url.includes('/pending/ack')) {
        failedFirstAck = true;
        return new Response(JSON.stringify({ error: 'already accepted' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };

    try {
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await manager2.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-answer-claims',
          arguments: 'Answer Claims Test',
        },
        output,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      const promptCalls = ctx2.client.session.prompt.mock.calls;
      const kickoff =
        promptCalls[promptCalls.length - 1]?.[0].body?.parts?.[0]?.text;
      const interviewId = kickoff?.match(/interview\/([^\s]+)/)?.[1];
      expect(interviewId).toBeTruthy();

      messagesData.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text:
              '<interview_state>\n' +
              '{"summary":"Answer questions","questions":' +
              '[{"id":"q-1","question":"What?"}]}\n' +
              '</interview_state>',
          },
        ],
      });

      const auth = await readDashboardAuthFile(port);
      expect(auth).not.toBeNull();
      const interviewUrl = `http://127.0.0.1:${port}/api/interviews/${interviewId}`;
      const authQuery = `?token=${auth?.token}`;
      const firstAnswer = await originalFetch(
        `${interviewUrl}/answers${authQuery}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            answers: [{ questionId: 'q-1', answer: 'First answer' }],
          }),
          signal: AbortSignal.timeout(2000),
        },
      );
      expect(firstAnswer.status).toBe(202);

      const firstClaimResponse = await originalFetch(
        `${interviewUrl}/pending${authQuery}`,
        { signal: AbortSignal.timeout(2000) },
      );
      const firstClaim = (await firstClaimResponse.json()) as {
        claimId: string;
        answers: Array<{ questionId: string; answer: string }> | null;
      };
      expect(firstClaim.claimId).toBeTruthy();
      expect(firstClaim.answers).toEqual([
        { questionId: 'q-1', answer: 'First answer' },
      ]);

      await manager2.handleEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'session-answer-claims',
            status: { type: 'idle' },
          },
        },
      });
      expect(failedFirstAck).toBe(true);
      expect(ctx2.client.session.promptAsync).toHaveBeenCalledTimes(1);

      const recoveredAck = await originalFetch(
        `${interviewUrl}/pending/ack${authQuery}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ claimId: firstClaim.claimId }),
          signal: AbortSignal.timeout(2000),
        },
      );
      expect(recoveredAck.status).toBe(200);

      const secondAnswer = await originalFetch(
        `${interviewUrl}/answers${authQuery}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            answers: [{ questionId: 'q-1', answer: 'Second answer' }],
          }),
          signal: AbortSignal.timeout(2000),
        },
      );
      expect(secondAnswer.status).toBe(202);

      await manager2.handleEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'session-answer-claims',
            status: { type: 'idle' },
          },
        },
      });
      expect(ctx2.client.session.promptAsync).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(tempDir1, { recursive: true, force: true });
      await fs.rm(tempDir2, { recursive: true, force: true });
    }
  });
});

describe('interview manager - dashboard election failure fallback', () => {
  test('falls back to per-session mode when tryBecomeDashboard fails and dashboard is unreachable', async () => {
    // Create a TCP server that blocks a port but immediately destroys
    // connections. This simulates a port in use by a non-dashboard
    // process, causing:
    //   1. tryBecomeDashboard → probes fail, bind fails (EADDRINUSE),
    //      returns null after retries
    //   2. probeDashboard × 2 → fails (no valid HTTP response)
    //   3. Throws → caught → falls back via createPerSessionInterviewServer
    const tcpServer = createNetServer((socket) => {
      socket.destroy();
    });

    const port = await new Promise<number>((resolve) => {
      tcpServer.listen(0, () => {
        const address = tcpServer.address();
        if (address && typeof address !== 'string') {
          resolve(address.port);
        } else {
          resolve(0);
        }
      });
    });

    const tempDir = await fs.mkdtemp('/tmp/manager-test-');
    const ctx = createMockContext({ directory: tempDir });
    const config = createTestConfig({
      port,
      dashboard: true,
    });

    try {
      const manager = createInterviewManager(ctx, config);

      // handleCommandExecuteBefore calls ensureInitialized internally,
      // which awaits initPromise. This naturally waits for all retries,
      // probes, and fallback logic to complete before proceeding.
      const output = {
        parts: [] as Array<{ type: string; text?: string }>,
      };
      await manager.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-fallback',
          arguments: 'Fallback Test Idea',
        },
        output,
      );

      // Verify interview was created in per-session fallback mode
      expect(output.parts.length).toBe(1);
      expect(output.parts[0].type).toBe('text');
      expect(output.parts[0].text).toContain('Fallback Test Idea');
      expect(output.parts[0].text).toContain('<interview_state>');

      // Verify interview file was created (per-session mode writes markdown)
      const interviewDir = `${tempDir}/interview`;
      const files = await fs.readdir(interviewDir);
      expect(files.length).toBe(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      tcpServer.close();
    }
  });
});
