import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import * as path from 'node:path';
import { InterviewConfigSchema } from '../config/schema';
import { createInterviewServer } from './server';
import { createInterviewService as createRealInterviewService } from './service';
import type { InterviewAnswer } from './types';
import { renderInterviewPage } from './ui';

// Mock the plugin context with mutable message array
function createMockContext(overrides?: {
  directory?: string;
  messagesData?: Array<{
    info?: { role: string };
    parts?: Array<{ type: string; text?: string }>;
  }>;
  promptImpl?: (args: any) => Promise<unknown>;
}) {
  // Use a mutable array that can be updated after creation
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

// Helper to extract text from prompt calls
function getPromptTexts(promptMock: {
  mock: { calls: Array<[{ body?: { parts?: Array<{ text?: string }> } }]> };
}): string[] {
  return promptMock.mock.calls
    .map((call) => call[0].body?.parts?.[0]?.text ?? '')
    .filter(Boolean);
}

// Helper to extract interview ID from the last prompt call
function extractInterviewIdFromLastPrompt(promptMock: {
  mock: { calls: Array<[{ body?: { parts?: Array<{ text?: string }> } }]> };
}): string | null {
  const calls = promptMock.mock.calls;
  if (calls.length === 0) return null;

  // Get the last call
  const lastCall = calls[calls.length - 1];
  const text = lastCall[0].body?.parts?.[0]?.text ?? '';
  const match = text.match(/interview\/([^\s]+)/);
  return match ? match[1] : null;
}

// Helper to extract text from output parts (kickoff/resume prompts go here)
function extractOutputText(output: {
  parts: Array<{ type: string; text?: string }>;
}): string {
  const textPart = output.parts.find((part) => part.type === 'text');
  return textPart?.text ?? '';
}

function requireInterviewId(value: string | null): string {
  expect(value).not.toBeNull();
  return value as string;
}

function createInterviewService(
  ctx: ReturnType<typeof createMockContext>,
  config?: Partial<Parameters<typeof createRealInterviewService>[1]>,
  deps?: Parameters<typeof createRealInterviewService>[2],
) {
  const resolvedConfig = config
    ? InterviewConfigSchema.parse(config)
    : undefined;

  return createRealInterviewService(ctx, resolvedConfig, {
    openBrowser: mock((_url: string) => {}),
    ...deps,
  });
}

function createTestService(
  ctx: ReturnType<typeof createMockContext>,
  config?: Partial<Parameters<typeof createRealInterviewService>[1]>,
  deps?: Parameters<typeof createRealInterviewService>[2],
) {
  const openBrowserMock = mock((_url: string) => {});
  const resolvedConfig = config
    ? InterviewConfigSchema.parse(config)
    : undefined;
  const service = createRealInterviewService(ctx, resolvedConfig, {
    openBrowser: openBrowserMock,
    ...deps,
  });

  return {
    service,
    openBrowserMock,
  };
}

function createRuntimeEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return { ...overrides };
}

describe('interview service', () => {
  describe('/interview <idea> command', () => {
    test('creates interview and sends kickoff prompt with UI notification', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });
      const service = createInterviewService(ctx);
      // Set up base URL resolver to avoid server error
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await service.handleCommandExecuteBefore(
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

      // Should send UI notification prompt to session
      expect(ctx.client.session.prompt).toHaveBeenCalled();
      const promptTexts = getPromptTexts(ctx.client.session.prompt);
      expect(
        promptTexts.some((text) => text.includes('Interview UI ready')),
      ).toBe(true);
      expect(promptTexts.some((text) => text.includes('/interview/'))).toBe(
        true,
      );

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('creates markdown file with slug-only filename (no timestamp prefix)', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-456',
          arguments: 'Test Idea',
        },
        output,
      );

      // Check that interview directory and file were created
      const interviewDir = path.join(tempDir, 'interview');
      const files = await fs.readdir(interviewDir);
      expect(files.length).toBe(1);
      // Filename should be slug-only, no timestamp prefix
      expect(files[0]).toBe('test-idea.md');
      expect(files[0]).not.toMatch(/^\d+-/);

      // Check file content structure
      const content = await fs.readFile(
        path.join(interviewDir, files[0]),
        'utf8',
      );
      expect(content).toContain('# Test Idea');
      expect(content).toContain('## Current spec');
      expect(content).toContain('## Q&A history');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe('answer submission', () => {
    test('appends only Q/A history to markdown document', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');

      // Start with empty messages, then add questions after interview creation
      const messagesData: Array<{
        info?: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }> = [];

      const ctx = createMockContext({
        directory: tempDir,
        messagesData,
      });

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');

      // Create interview first (with empty messages, so baseMessageCount = 0)
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-789',
          arguments: 'Platform App',
        },
        output,
      );

      // Get the interview ID from the prompt calls
      const interviewId = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId = requireInterviewId(interviewId);

      // Now add the questions to messages (simulating agent response)
      messagesData.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: 'Here are some questions.\n<interview_state>\n{\n  "summary": "Building a test app",\n  "questions": [\n    {\n      "id": "q-1",\n      "question": "What platform?",\n      "options": ["Web", "Mobile"],\n      "suggested": "Web"\n    }\n  ]\n}\n</interview_state>',
          },
        ],
      });

      // Submit an answer
      const answers: InterviewAnswer[] = [{ questionId: 'q-1', answer: 'Web' }];
      await service.submitAnswers(requiredInterviewId, answers);

      // Read the markdown file
      const interviewDir = path.join(tempDir, 'interview');
      const files = await fs.readdir(interviewDir);
      const content = await fs.readFile(
        path.join(interviewDir, files[0]),
        'utf8',
      );

      // Verify Q/A was appended to history section
      expect(content).toContain('## Q&A history');
      expect(content).toContain('Q: What platform?');
      expect(content).toContain('A: Web');

      // Verify the Current spec section exists (even if empty after submission)
      expect(content).toContain('## Current spec');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('preserves existing history when appending new answers', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');

      // Start with messages that include one answered question and one pending
      const messagesData: Array<{
        info?: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }> = [
        // First question and answer
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'text',
              text: 'First question.\n<interview_state>\n{\n  "summary": "Building an app",\n  "questions": [\n    {\n      "id": "q-1",\n      "question": "What is the name?",\n      "options": ["App1", "App2"],\n      "suggested": "App1"\n    }\n  ]\n}\n</interview_state>',
            },
          ],
        },
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'App1' }] },
        // Second question (current)
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'text',
              text: 'Second question.\n<interview_state>\n{\n  "summary": "Building App1",\n  "questions": [\n    {\n      "id": "q-2",\n      "question": "What color?",\n      "options": ["Red", "Blue"],\n      "suggested": "Blue"\n    }\n  ]\n}\n</interview_state>',
            },
          ],
        },
      ];

      const ctx = createMockContext({
        directory: tempDir,
        messagesData,
      });

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');

      // Create interview (baseMessageCount will be 3)
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-abc',
          arguments: 'Multi Round App',
        },
        output,
      );

      // Get interview ID from prompt calls
      const interviewId = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId = requireInterviewId(interviewId);

      // Add a new message simulating agent response after interview creation
      // This ensures baseMessageCount (3) < current messages length
      messagesData.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: 'Acknowledged.\n<interview_state>\n{\n  "summary": "Building App1",\n  "questions": [\n    {\n      "id": "q-2",\n      "question": "What color?",\n      "options": ["Red", "Blue"],\n      "suggested": "Blue"\n    }\n  ]\n}\n</interview_state>',
          },
        ],
      });

      // Submit second answer (q-2 is the active question now)
      await service.submitAnswers(requiredInterviewId, [
        { questionId: 'q-2', answer: 'Blue' },
      ]);

      // Read file after submission
      const interviewDir = path.join(tempDir, 'interview');
      const files = await fs.readdir(interviewDir);
      const content = await fs.readFile(
        path.join(interviewDir, files[0]),
        'utf8',
      );

      // Verify Q/A is in history
      expect(content).toContain('Q: What color?');
      expect(content).toContain('A: Blue');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('replaces placeholder history on first answer submission', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');

      const messagesData: Array<{
        info?: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }> = [];

      const ctx = createMockContext({
        directory: tempDir,
        messagesData,
      });

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-placeholder',
          arguments: 'Placeholder Test',
        },
        output,
      );

      const interviewId = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId = requireInterviewId(interviewId);

      messagesData.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: 'Here are some questions.\n<interview_state>\n{\n  "summary": "Building a test app",\n  "questions": [\n    {\n      "id": "q-1",\n      "question": "What platform?",\n      "options": ["Web", "Mobile"],\n      "suggested": "Web"\n    }\n  ]\n}\n</interview_state>',
          },
        ],
      });

      await service.submitAnswers(requiredInterviewId, [
        { questionId: 'q-1', answer: 'Web' },
      ]);

      const interviewDir = path.join(tempDir, 'interview');
      const files = await fs.readdir(interviewDir);
      const content = await fs.readFile(
        path.join(interviewDir, files[0]),
        'utf8',
      );

      expect(content).not.toContain('## Q&A history\n\nNo answers yet.\n\nQ:');
      expect(content).toContain('## Q&A history\n\nQ: What platform?\nA: Web');

      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('rejects concurrent submission when first request holds busy lock', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');

      // Start with empty messages
      const messagesData: Array<{
        info?: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }> = [];

      // Create a prompt that delays to hold the lock
      let promptStarted = false;
      const ctx = createMockContext({
        directory: tempDir,
        messagesData,
        promptImpl: async () => {
          promptStarted = true;
          // Delay to hold the lock during test
          await new Promise((resolve) => setTimeout(resolve, 200));
          return {};
        },
      });

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');

      // Create interview first (baseMessageCount = 0)
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-concurrent',
          arguments: 'Concurrent Test',
        },
        output,
      );

      const interviewId = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId = requireInterviewId(interviewId);

      // Now add the agent response with questions
      messagesData.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: 'Here are some questions.\n<interview_state>\n{\n  "summary": "Building a test app",\n  "questions": [\n    {\n      "id": "q-1",\n      "question": "What platform?",\n      "options": ["Web", "Mobile"],\n      "suggested": "Web"\n    }\n  ]\n}\n</interview_state>',
          },
        ],
      });

      // Start first submission (will hold lock due to slow prompt)
      const firstSubmissionPromise = service.submitAnswers(
        requiredInterviewId,
        [{ questionId: 'q-1', answer: 'Web' }],
      );

      // Wait for prompt to start (indicates lock is acquired)
      while (!promptStarted) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Second submission should be rejected immediately (busy lock held)
      await expect(
        service.submitAnswers(requiredInterviewId, [
          { questionId: 'q-1', answer: 'Mobile' },
        ]),
      ).rejects.toThrow('Interview session is busy');

      // Wait for first submission to complete (it will succeed after 200ms delay)
      await firstSubmissionPromise;

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('busy lock released when validation fails after lock acquired', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');

      // Start with empty messages
      const messagesData: Array<{
        info?: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }> = [];

      const ctx = createMockContext({
        directory: tempDir,
        messagesData,
      });

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');

      // Create interview first (baseMessageCount = 0)
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-retry',
          arguments: 'Retry Test',
        },
        output,
      );

      const interviewId = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId = requireInterviewId(interviewId);

      // Add agent response with questions
      messagesData.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: 'Here are some questions.\n<interview_state>\n{\n  "summary": "Building a test app",\n  "questions": [\n    {\n      "id": "q-1",\n      "question": "What platform?",\n      "options": ["Web", "Mobile"],\n      "suggested": "Web"\n    }\n  ]\n}\n</interview_state>',
          },
        ],
      });

      // First submission with invalid answer (wrong question ID)
      await expect(
        service.submitAnswers(requiredInterviewId, [
          { questionId: 'invalid-id', answer: 'Web' },
        ]),
      ).rejects.toThrow('Answers do not match the current interview questions');

      // Second submission with correct answer should succeed (lock was released)
      await expect(
        service.submitAnswers(requiredInterviewId, [
          { questionId: 'q-1', answer: 'Web' },
        ]),
      ).resolves.toBeUndefined();

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('busy lock released when no active questions validation fails', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');

      // Start with empty messages (no questions)
      const messagesData: Array<{
        info?: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }> = [
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'text',
              text: 'Waiting.\n<interview_state>\n{\n  "summary": "Test",\n  "questions": []\n}\n</interview_state>',
            },
          ],
        },
      ];

      const ctx = createMockContext({
        directory: tempDir,
        messagesData,
      });

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');

      // Create interview (baseMessageCount will be 1)
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-no-questions',
          arguments: 'No Questions Test',
        },
        output,
      );

      const interviewId = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId = requireInterviewId(interviewId);

      // Submission with no active questions should fail and release lock
      await expect(
        service.submitAnswers(requiredInterviewId, [
          { questionId: 'q-1', answer: 'Web' },
        ]),
      ).rejects.toThrow('There are no active interview questions to answer');

      // Verify state is not busy after the failed submission
      const state = await service.getInterviewState(requiredInterviewId);
      expect(state.isBusy).toBe(false);

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe('session interview lifecycle', () => {
    test('starting /interview with different idea creates fresh interview', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const sessionID = 'session-reuse-test';

      // First interview with "Idea One"
      const output1 = { parts: [] as Array<{ type: string; text?: string }> };
      await service.handleCommandExecuteBefore(
        { command: 'interview', sessionID, arguments: 'Idea One' },
        output1,
      );

      const interviewId1 = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId1 = requireInterviewId(interviewId1);

      // Second interview with "Idea Two" - should create fresh interview
      const output2 = { parts: [] as Array<{ type: string; text?: string }> };
      await service.handleCommandExecuteBefore(
        { command: 'interview', sessionID, arguments: 'Idea Two' },
        output2,
      );

      // Get the second interview ID (should be the last prompt call)
      const interviewId2 = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId2 = requireInterviewId(interviewId2);

      // Should be different interview IDs
      expect(interviewId1).not.toBe(interviewId2);

      // First interview should be marked as abandoned
      const state1 = await service.getInterviewState(requiredInterviewId1);
      expect(state1.interview.status).toBe('abandoned');

      // Second interview should be active
      const state2 = await service.getInterviewState(requiredInterviewId2);
      expect(state2.interview.idea).toBe('Idea Two');
      expect(state2.interview.status).toBe('active');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('reusing same idea in same session returns existing interview', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const sessionID = 'session-same-idea';

      // First call with "Same Idea"
      const output1 = { parts: [] as Array<{ type: string; text?: string }> };
      await service.handleCommandExecuteBefore(
        { command: 'interview', sessionID, arguments: 'Same Idea' },
        output1,
      );

      const interviewId1 = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      expect(interviewId1).not.toBeNull();

      // Second call with same idea - should reuse
      const output2 = { parts: [] as Array<{ type: string; text?: string }> };
      await service.handleCommandExecuteBefore(
        { command: 'interview', sessionID, arguments: 'Same Idea' },
        output2,
      );

      const interviewId2 = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      expect(interviewId2).not.toBeNull();

      // Should be the same interview ID
      expect(interviewId1).toBe(interviewId2);

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('session.deleted event marks interview as abandoned', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const sessionID = 'session-delete-test';

      // Create interview
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await service.handleCommandExecuteBefore(
        { command: 'interview', sessionID, arguments: 'Delete Test' },
        output,
      );

      const interviewId = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId = requireInterviewId(interviewId);

      // Verify interview is active
      const stateBefore = await service.getInterviewState(requiredInterviewId);
      expect(stateBefore.interview.status).toBe('active');

      // Simulate session deletion
      await service.handleEvent({
        event: {
          type: 'session.deleted',
          properties: { sessionID },
        },
      });

      // Interview should now be abandoned
      const stateAfter = await service.getInterviewState(requiredInterviewId);
      expect(stateAfter.interview.status).toBe('abandoned');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe('session status handling', () => {
    test('session.status busy marks interview as awaiting-agent', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');

      // Start with no questions (awaiting-agent state)
      const messagesData: Array<{
        info?: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }> = [
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'text',
              text: 'Waiting for response.\n<interview_state>\n{\n  "summary": "Test",\n  "questions": []\n}\n</interview_state>',
            },
          ],
        },
      ];

      const ctx = createMockContext({
        directory: tempDir,
        messagesData,
      });

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const sessionID = 'session-busy-test';

      // Create interview
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await service.handleCommandExecuteBefore(
        { command: 'interview', sessionID, arguments: 'Busy Test' },
        output,
      );

      const interviewId = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId = requireInterviewId(interviewId);

      // Initially should be awaiting-agent (no questions)
      const stateBefore = await service.getInterviewState(requiredInterviewId);
      expect(stateBefore.mode).toBe('awaiting-agent');

      // Simulate busy status
      await service.handleEvent({
        event: {
          type: 'session.status',
          properties: { sessionID, status: { type: 'busy' } },
        },
      });

      // Should still be awaiting-agent and marked busy
      const stateAfter = await service.getInterviewState(requiredInterviewId);
      expect(stateAfter.mode).toBe('awaiting-agent');
      expect(stateAfter.isBusy).toBe(true);

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe('configurable output folder', () => {
    test('creates interview in configured output folder', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });

      // Create service with custom output folder config
      const service = createInterviewService(ctx, {
        maxQuestions: 2,
        outputFolder: 'custom-interviews',
        autoOpenBrowser: true,
      });
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-custom-folder',
          arguments: 'Custom Folder Idea',
        },
        output,
      );

      // Check that file was created in custom folder
      const customDir = path.join(tempDir, 'custom-interviews');
      const files = await fs.readdir(customDir);
      expect(files.length).toBe(1);
      expect(files[0]).toBe('custom-folder-idea.md');

      // Verify the markdownPath in state points to custom folder
      const interviewId = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId = requireInterviewId(interviewId);
      const state = await service.getInterviewState(requiredInterviewId);
      expect(state.markdownPath).toContain('custom-interviews');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('handles nested output folder paths', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });

      // Create service with nested output folder path
      const service = createInterviewService(ctx, {
        maxQuestions: 2,
        outputFolder: 'docs/interviews',
        autoOpenBrowser: true,
      });
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-nested',
          arguments: 'Nested Path Idea',
        },
        output,
      );

      // Check that file was created in nested folder
      const nestedDir = path.join(tempDir, 'docs', 'interviews');
      const files = await fs.readdir(nestedDir);
      expect(files.length).toBe(1);
      expect(files[0]).toBe('nested-path-idea.md');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe('resuming with existing markdown file', () => {
    test('resumes existing file and sends resume prompt instead of kickoff', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });

      // Pre-create an existing interview file
      const interviewDir = path.join(tempDir, 'interview');
      await fs.mkdir(interviewDir, { recursive: true });
      const existingFilePath = path.join(interviewDir, 'existing-idea.md');
      await fs.writeFile(
        existingFilePath,
        '# Existing Idea\n\n## Current spec\n\nExisting spec content.\n\n## Q&A history\n\nQ: What platform?\nA: Web\n',
        'utf8',
      );

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      // Resume by referencing the existing file basename
      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-resume',
          arguments: 'existing-idea',
        },
        output,
      );

      // Should send resume prompt (references existing document)
      const outputText = extractOutputText(output);
      expect(outputText).toContain('Resume the interview');
      expect(outputText).toContain('Existing Idea');
      expect(outputText).toContain('Existing spec content');

      // Should NOT send kickoff prompt
      expect(outputText).not.toContain(
        'You are running an interview q&a session',
      );
      expect(outputText).not.toContain('Initial idea:');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('resumes by full relative path to existing file', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });

      // Pre-create an existing interview file in custom location
      const customDir = path.join(tempDir, 'docs');
      await fs.mkdir(customDir, { recursive: true });
      const existingFilePath = path.join(customDir, 'my-project.md');
      await fs.writeFile(
        existingFilePath,
        '# My Project\n\n## Current spec\n\nProject spec here.\n\n## Q&A history\n\nNo answers yet.\n',
        'utf8',
      );

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      // Resume by referencing the relative path
      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-resume-path',
          arguments: 'docs/my-project.md',
        },
        output,
      );

      // Should send resume prompt
      const outputText = extractOutputText(output);
      expect(outputText).toContain('Resume the interview');
      expect(outputText).toContain('My Project');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('reuses same file when resuming multiple times', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });

      // Pre-create an existing interview file
      const interviewDir = path.join(tempDir, 'interview');
      await fs.mkdir(interviewDir, { recursive: true });
      const existingFilePath = path.join(interviewDir, 'reusable.md');
      await fs.writeFile(
        existingFilePath,
        '# Reusable Interview\n\n## Current spec\n\nOriginal content.\n\n## Q&A history\n\n',
        'utf8',
      );

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');

      // First resume
      const output1 = { parts: [] as Array<{ type: string; text?: string }> };
      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-reuse-1',
          arguments: 'reusable',
        },
        output1,
      );

      const interviewId1 = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );

      // Second resume (different session, same file)
      const output2 = { parts: [] as Array<{ type: string; text?: string }> };
      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-reuse-2',
          arguments: 'reusable',
        },
        output2,
      );

      const interviewId2 = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );

      // Both should reference the same file
      const state1 = await service.getInterviewState(
        requireInterviewId(interviewId1),
      );
      const state2 = await service.getInterviewState(
        requireInterviewId(interviewId2),
      );
      expect(state1.markdownPath).toBe(state2.markdownPath);
      expect(state1.markdownPath).toContain('reusable.md');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe('configurable maxQuestions', () => {
    test('kickoff prompt references configured maxQuestions count', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });

      // Create service with custom maxQuestions
      const service = createInterviewService(ctx, {
        maxQuestions: 5,
        outputFolder: 'interview',
        autoOpenBrowser: true,
      });
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-max-q',
          arguments: 'Max Questions Test',
        },
        output,
      );

      // Kickoff prompt should reference the configured maxQuestions
      const outputText = extractOutputText(output);
      expect(outputText).toContain('at most 5 questions');
      expect(outputText).toContain('Return 0 to 5 questions');
      expect(outputText).toContain('Do not ask more than 5 questions');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('resume prompt references configured maxQuestions count', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });

      // Pre-create an existing file to trigger resume
      const interviewDir = path.join(tempDir, 'interview');
      await fs.mkdir(interviewDir, { recursive: true });
      await fs.writeFile(
        path.join(interviewDir, 'resume-max.md'),
        '# Resume Max\n\n## Current spec\n\nSpec.\n\n## Q&A history\n\n',
        'utf8',
      );

      // Create service with custom maxQuestions
      const service = createInterviewService(ctx, {
        maxQuestions: 3,
        outputFolder: 'interview',
        autoOpenBrowser: true,
      });
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-resume-max',
          arguments: 'resume-max',
        },
        output,
      );

      // Resume prompt should reference the configured maxQuestions
      const outputText = extractOutputText(output);
      expect(outputText).toContain('up to 3 at a time');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('state exposes at most configured maxQuestions questions', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');

      // Start with empty messages
      const messagesData: Array<{
        info?: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }> = [];

      const ctx = createMockContext({
        directory: tempDir,
        messagesData,
      });

      // Create service with maxQuestions = 2
      const service = createInterviewService(ctx, {
        maxQuestions: 2,
        outputFolder: 'interview',
        autoOpenBrowser: true,
      });
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      // Create interview first (baseMessageCount = 0)
      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-parse-max',
          arguments: 'Parse Max Test',
        },
        output,
      );

      const interviewId = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId = requireInterviewId(interviewId);

      // Now add the agent response with more questions than maxQuestions
      messagesData.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: 'Questions.\n<interview_state>\n{\n  "summary": "Test",\n  "questions": [\n    {"id": "q-1", "question": "Q1?", "options": ["A", "B"]},\n    {"id": "q-2", "question": "Q2?", "options": ["A", "B"]},\n    {"id": "q-3", "question": "Q3?", "options": ["A", "B"]},\n    {"id": "q-4", "question": "Q4?", "options": ["A", "B"]}\n  ]\n}\n</interview_state>',
          },
        ],
      });

      // State should only expose at most maxQuestions questions
      const state = await service.getInterviewState(requiredInterviewId);
      expect(state.questions.length).toBeLessThanOrEqual(2);
      expect(state.questions.length).toBe(2);

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('answer prompt references configured maxQuestions count', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');

      // Start with empty messages
      const messagesData: Array<{
        info?: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }> = [];

      const ctx = createMockContext({
        directory: tempDir,
        messagesData,
      });

      // Create service with custom maxQuestions
      const service = createInterviewService(ctx, {
        maxQuestions: 4,
        outputFolder: 'interview',
        autoOpenBrowser: true,
      });
      service.setBaseUrlResolver(async () => 'http://localhost:9999');

      // Create interview first (baseMessageCount = 0)
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-answer-max',
          arguments: 'Answer Max Test',
        },
        output,
      );

      const interviewId = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId = requireInterviewId(interviewId);

      // Now add the agent response with a question
      messagesData.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: 'Question.\n<interview_state>\n{\n  "summary": "Test",\n  "questions": [{"id": "q-1", "question": "What?", "options": ["A", "B"]}]\n}\n</interview_state>',
          },
        ],
      });

      // Clear previous prompt calls to capture the answer prompt
      ctx.client.session.promptAsync.mock.calls.length = 0;

      // Submit an answer
      const answers: InterviewAnswer[] = [{ questionId: 'q-1', answer: 'A' }];
      await service.submitAnswers(requiredInterviewId, answers);

      // Answer prompt should reference the configured maxQuestions
      const lastPromptText = getPromptTexts(
        ctx.client.session.promptAsync,
      ).join('\n');
      expect(lastPromptText).toContain('Return 0 to 4 questions');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe('agent-provided title', () => {
    test('renames file when assistant provides title in interview_state', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');

      // Start with empty messages
      const messagesData: Array<{
        info?: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }> = [];

      const ctx = createMockContext({
        directory: tempDir,
        messagesData,
      });

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      // Create interview with user's idea
      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-title-test',
          arguments: 'My Great App Idea With Long Description',
        },
        output,
      );

      // Initial file should use slugified user input
      const interviewDir = path.join(tempDir, 'interview');
      let files = await fs.readdir(interviewDir);
      expect(files.length).toBe(1);
      expect(files[0]).toBe('my-great-app-idea-with-long-description.md');

      const interviewId = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId = requireInterviewId(interviewId);

      // Now add agent response with a concise title
      messagesData.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: 'Here are some questions.\n<interview_state>\n{\n  "summary": "Building a task management app",\n  "title": "task-manager",\n  "questions": [{"id": "q-1", "question": "What platform?", "options": ["Web", "Mobile"]}]\n}\n</interview_state>',
          },
        ],
      });

      // Sync interview (this triggers the rename)
      const state = await service.getInterviewState(requiredInterviewId);

      // File should be renamed to use assistant-provided title
      files = await fs.readdir(interviewDir);
      expect(files.length).toBe(1);
      expect(files[0]).toBe('task-manager.md');
      expect(state.markdownPath).toContain('task-manager.md');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('keeps original filename when assistant omits title', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');

      const messagesData: Array<{
        info?: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }> = [];

      const ctx = createMockContext({
        directory: tempDir,
        messagesData,
      });

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-no-title',
          arguments: 'Simple Idea',
        },
        output,
      );

      const interviewDir = path.join(tempDir, 'interview');
      let files = await fs.readdir(interviewDir);
      expect(files[0]).toBe('simple-idea.md');

      const interviewId = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId = requireInterviewId(interviewId);

      // Agent response without title field
      messagesData.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: 'Questions.\n<interview_state>\n{\n  "summary": "Building an app",\n  "questions": [{"id": "q-1", "question": "What?", "options": ["A", "B"]}]\n}\n</interview_state>',
          },
        ],
      });

      const state = await service.getInterviewState(requiredInterviewId);

      // Filename should remain unchanged
      files = await fs.readdir(interviewDir);
      expect(files[0]).toBe('simple-idea.md');
      expect(state.markdownPath).toContain('simple-idea.md');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('does not rename if target filename already exists', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');

      const messagesData: Array<{
        info?: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }> = [];

      const ctx = createMockContext({
        directory: tempDir,
        messagesData,
      });

      // Pre-create a file with the target name
      const interviewDir = path.join(tempDir, 'interview');
      await fs.mkdir(interviewDir, { recursive: true });
      await fs.writeFile(
        path.join(interviewDir, 'target-name.md'),
        '# Existing\n\n## Current spec\n\nExisting.\n\n## Q&A history\n\n',
        'utf8',
      );

      const service = createInterviewService(ctx);
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-existing',
          arguments: 'Original Idea',
        },
        output,
      );

      let files = await fs.readdir(interviewDir);
      expect(files).toContain('original-idea.md');
      expect(files).toContain('target-name.md');

      const interviewId = extractInterviewIdFromLastPrompt(
        ctx.client.session.prompt,
      );
      const requiredInterviewId = requireInterviewId(interviewId);

      // Agent suggests a title that matches existing file
      messagesData.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: 'Questions.\n<interview_state>\n{\n  "summary": "Building an app",\n  "title": "target-name",\n  "questions": [{"id": "q-1", "question": "What?", "options": ["A", "B"]}]\n}\n</interview_state>',
          },
        ],
      });

      const state = await service.getInterviewState(requiredInterviewId);

      // Should not rename (would overwrite existing file)
      files = await fs.readdir(interviewDir);
      expect(files).toContain('original-idea.md');
      expect(files).toContain('target-name.md');
      expect(state.markdownPath).toContain('original-idea.md');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe('autoOpenBrowser config', () => {
    test('does not open a browser during automated test runtimes', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });

      const { service, openBrowserMock } = createTestService(
        ctx,
        {
          maxQuestions: 2,
          outputFolder: 'interview',
          autoOpenBrowser: true,
        },
        {
          env: createRuntimeEnv({
            NODE_ENV: 'test',
            CI: '0',
          }),
        },
      );
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-browser-test-env',
          arguments: 'Browser Test Env',
        },
        output,
      );

      expect(openBrowserMock).not.toHaveBeenCalled();

      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('does not open a browser in CI even when auto-open is enabled', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });

      const { service, openBrowserMock } = createTestService(
        ctx,
        {
          maxQuestions: 2,
          outputFolder: 'interview',
          autoOpenBrowser: true,
        },
        {
          env: createRuntimeEnv({
            CI: 'true',
          }),
        },
      );
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-browser-ci-env',
          arguments: 'Browser CI Env',
        },
        output,
      );

      expect(openBrowserMock).not.toHaveBeenCalled();

      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('uses injected browser opener instead of opening a real browser in tests', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });

      const { service, openBrowserMock } = createTestService(
        ctx,
        {
          maxQuestions: 2,
          outputFolder: 'interview',
          autoOpenBrowser: true,
        },
        {
          env: createRuntimeEnv({
            NODE_ENV: 'development',
            CI: '0',
          }),
        },
      );
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-browser-open',
          arguments: 'Browser Open Test',
        },
        output,
      );

      expect(openBrowserMock).toHaveBeenCalledTimes(1);

      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('kickoff prompt includes title field guidance', async () => {
      const tempDir = await fs.mkdtemp('/tmp/interview-test-');
      const ctx = createMockContext({ directory: tempDir });

      const service = createInterviewService(ctx, {
        maxQuestions: 2,
        outputFolder: 'interview',
        autoOpenBrowser: true,
      });
      service.setBaseUrlResolver(async () => 'http://localhost:9999');
      const output = { parts: [] as Array<{ type: string; text?: string }> };

      await service.handleCommandExecuteBefore(
        {
          command: 'interview',
          sessionID: 'session-browser-config',
          arguments: 'Browser Config Test',
        },
        output,
      );

      // Kickoff prompt should mention title field
      const outputText = extractOutputText(output);
      expect(outputText).toContain('"title":');
      expect(outputText).toContain('concise-kebab-case-title-for-filename');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });
});

describe('renderInterviewPage', () => {
  test('escapes HTML special characters in interviewId for title', () => {
    const maliciousId = '<script>alert("xss")</script>';
    const html = renderInterviewPage(maliciousId, maliciousId);

    // Should not contain raw script tags in title
    expect(html).not.toContain('<title>Interview <script>');

    // Should contain escaped version in title
    expect(html).toContain(
      '<title>Interview &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</title>',
    );
  });

  test('escapes ampersand in interviewId', () => {
    const idWithAmpersand = 'A&B Test';
    const html = renderInterviewPage(idWithAmpersand, idWithAmpersand);

    expect(html).toContain('<title>Interview A&amp;B Test</title>');
    expect(html).not.toContain('<title>Interview A&B Test</title>');
  });

  test('escapes single quotes in interviewId', () => {
    const idWithQuote = "test'quote";
    const html = renderInterviewPage(idWithQuote, idWithQuote);

    expect(html).toContain('<title>Interview test&#39;quote</title>');
  });

  test('preserves safe interviewId characters', () => {
    const safeId = 'my-interview-123_test';
    const html = renderInterviewPage(safeId, safeId);

    expect(html).toContain(`<title>Interview ${safeId}</title>`);
  });

  test('interviewId in JSON script tag is properly stringified', () => {
    const idWithQuotes = 'test"onclick"evil';
    const html = renderInterviewPage(idWithQuotes, idWithQuotes);

    // The interviewId in the JavaScript should be JSON.stringify'd
    // JSON.stringify escapes quotes as \"
    expect(html).toContain('const interviewId = ');
    // The actual output has escaped quotes for JavaScript string
    expect(html).toContain('"test\\"onclick\\"evil"');
  });

  test('does not inject raw interviewId into HTML title', () => {
    const xssAttempt = '<img src=x onerror=alert(1)>';
    const html = renderInterviewPage(xssAttempt, xssAttempt);

    // Title should be escaped
    expect(html).not.toContain(`<title>Interview ${xssAttempt}</title>`);
    expect(html).toContain(
      '<title>Interview &lt;img src=x onerror=alert(1)&gt;</title>',
    );
  });

  test('renders a self-contained brand mark', () => {
    const html = renderInterviewPage('brand-test', 'brand-test');

    expect(html).toContain('<svg');
    expect(html).not.toContain('https://ohmyopencodeslim.com');
  });

  test('includes smooth scroll-to-top behavior in the submit handler', () => {
    const html = renderInterviewPage('scroll-test', 'scroll-test');

    expect(html).toContain('function scrollToTop()');
    expect(html).toContain(
      "window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });",
    );
    expect(html).toContain('overlayText.textContent = "Submitting Answers...";');
    expect(html).toContain('scrollToTop();');
  });
});

/** Discover a free port by briefly binding to port 0, then closing. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => {
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to find free port'));
          return;
        }
        resolve(addr.port);
      });
    });
    srv.on('error', reject);
  });
}

describe('interview server port configuration', () => {
  const noopDeps = {
    getState: mock(
      async (_id: string) =>
        ({
          interview: {
            id: 'x',
            idea: 'x',
            status: 'active',
            markdownPath: 'x',
          },
          questions: [],
          mode: 'awaiting-agent' as const,
          isBusy: false,
        }) as any,
    ),
    submitAnswers: mock(async (_id: string, _answers: InterviewAnswer[]) => {}),
  };

  test('server starts on a specific port when port is non-zero', async () => {
    const freePort = await findFreePort();
    const server = createInterviewServer({ ...noopDeps, port: freePort });
    try {
      const baseUrl = await server.ensureStarted();
      expect(baseUrl).toBe(`http://127.0.0.1:${freePort}`);
    } finally {
      server.close();
    }
  });

  test('server starts on a random port when port is 0', async () => {
    const server = createInterviewServer({ ...noopDeps, port: 0 });
    try {
      const baseUrl = await server.ensureStarted();
      expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const portStr = baseUrl.split(':').pop();
      const port = Number.parseInt(portStr ?? '0', 10);
      expect(port).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  test('baseUrl contains the correct port number for fixed port', async () => {
    const freePort = await findFreePort();
    const server = createInterviewServer({ ...noopDeps, port: freePort });
    try {
      const baseUrl = await server.ensureStarted();
      const portStr = baseUrl.split(':').pop();
      const port = Number.parseInt(portStr ?? '0', 10);
      expect(port).toBe(freePort);
    } finally {
      server.close();
    }
  });

  test('baseUrl contains a valid port number for random port', async () => {
    const server = createInterviewServer({ ...noopDeps, port: 0 });
    try {
      const baseUrl = await server.ensureStarted();
      const portStr = baseUrl.split(':').pop();
      const port = Number.parseInt(portStr ?? '0', 10);
      expect(port).toBeGreaterThanOrEqual(1);
      expect(port).toBeLessThanOrEqual(65535);
    } finally {
      server.close();
    }
  });

  test('rejects with friendly error when port is already in use', async () => {
    // Occupy a port first
    const blocker = createServer();
    const occupiedPort = await new Promise<number>((resolve, reject) => {
      blocker.listen(0, '127.0.0.1', () => {
        const addr = blocker.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to bind blocker'));
          return;
        }
        resolve(addr.port);
      });
      blocker.on('error', reject);
    });

    const server = createInterviewServer({
      ...noopDeps,
      port: occupiedPort,
    });
    try {
      await expect(server.ensureStarted()).rejects.toThrow(
        `Interview server port ${occupiedPort} is already in use`,
      );
    } finally {
      server.close();
      blocker.close();
    }
  });
});

describe('InterviewConfigSchema port validation', () => {
  test('accepts valid port 0', () => {
    const result = InterviewConfigSchema.parse({ port: 0 });
    expect(result.port).toBe(0);
  });

  test('accepts valid port 8080', () => {
    const result = InterviewConfigSchema.parse({ port: 8080 });
    expect(result.port).toBe(8080);
  });

  test('accepts valid port 65535', () => {
    const result = InterviewConfigSchema.parse({ port: 65535 });
    expect(result.port).toBe(65535);
  });

  test('defaults port to 0 when omitted', () => {
    const result = InterviewConfigSchema.parse({});
    expect(result.port).toBe(0);
  });

  test('rejects negative port', () => {
    expect(() => InterviewConfigSchema.parse({ port: -1 })).toThrow();
  });

  test('rejects port above 65535', () => {
    expect(() => InterviewConfigSchema.parse({ port: 70000 })).toThrow();
  });

  test('rejects float port', () => {
    expect(() => InterviewConfigSchema.parse({ port: 3.5 })).toThrow();
  });
});
