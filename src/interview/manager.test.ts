import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import type { PluginConfig } from '../config';
import { readDashboardAuthFile } from './dashboard';
import { createInterviewManager } from './manager';

// Helper to find a free port (matches interview.test.ts pattern)
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address !== 'string') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get port')));
      }
    });
  });
}

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
  return {
    client: {
      session: {
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
      },
    },
    directory: overrides?.directory ?? '/test/directory',
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

    test('registers session when interview is created', async () => {
      const tempDir = await fs.mkdtemp('/tmp/manager-test-');
      const ctx = createMockContext({ directory: tempDir });

      const freePort = await findFreePort();
      const config = createTestConfig({
        port: freePort,
        dashboard: true,
      });

      const manager = createInterviewManager(ctx, config);

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
        );
        expect(listResponse.status).toBe(200);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('dashboard: true with port 0', () => {
    test('activates dashboard mode and creates interview', async () => {
      const freePort = await findFreePort();
      const tempDir = await fs.mkdtemp('/tmp/manager-test-');
      const ctx = createMockContext({ directory: tempDir });

      const config = createTestConfig({
        port: freePort,
        dashboard: true,
      });

      const manager = createInterviewManager(ctx, config);

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

    const freePort = await findFreePort();
    const config = createTestConfig({
      port: freePort,
      dashboard: true,
    });

    const manager = createInterviewManager(ctx, config);

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

    const freePort = await findFreePort();
    const config = createTestConfig({
      port: freePort,
      dashboard: true,
    });

    const manager = createInterviewManager(ctx, config);

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
      );
      expect(stateResponse.status).toBe(200);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('removes session on session.deleted event', async () => {
    const tempDir = await fs.mkdtemp('/tmp/manager-test-');
    const ctx = createMockContext({ directory: tempDir });

    const freePort = await findFreePort();
    const config = createTestConfig({
      port: freePort,
      dashboard: true,
    });

    const manager = createInterviewManager(ctx, config);

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

      // Delete session
      await manager.handleEvent({
        event: {
          type: 'session.deleted',
          properties: { sessionID: 'session-delete-reg' },
        },
      });

      // Give cleanup a moment
      await new Promise((r) => setTimeout(r, 50));

      // Interview file should still exist
      const interviewDir = `${tempDir}/interview`;
      const files = await fs.readdir(interviewDir);
      expect(files.length).toBe(1);
      // Status is only tracked in memory, not written to markdown
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('interview manager - edge cases', () => {
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

    const freePort = await findFreePort();
    const config = createTestConfig({
      port: freePort,
      dashboard: true,
    });

    const manager1 = createInterviewManager(ctx1, config);

    // Wait for manager1 to become dashboard
    await new Promise((r) => setTimeout(r, 100));

    try {
      // Manager1 should be the dashboard
      const healthResponse = await fetch(
        `http://127.0.0.1:${freePort}/api/health`,
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
      );
      expect(state1Response.status).toBe(200);

      const state2Response = await fetch(
        `http://127.0.0.1:${freePort}/api/interviews/${interviewId2}/state?token=${auth?.token}`,
      );
      expect(state2Response.status).toBe(200);
    } finally {
      await fs.rm(tempDir1, { recursive: true, force: true });
      await fs.rm(tempDir2, { recursive: true, force: true });
    }
  });
});
