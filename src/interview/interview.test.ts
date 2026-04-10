import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterviewService } from './service';
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

function requireInterviewId(value: string | null): string {
  expect(value).not.toBeNull();
  return value as string;
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

    test('creates markdown file with correct structure', async () => {
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
      expect(files[0]).toMatch(/\d+-test-idea\.md$/);

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
});

describe('renderInterviewPage', () => {
  test('escapes HTML special characters in interviewId for title', () => {
    const maliciousId = '<script>alert("xss")</script>';
    const html = renderInterviewPage(maliciousId);

    // Should not contain raw script tags in title
    expect(html).not.toContain('<title>Interview <script>');

    // Should contain escaped version in title
    expect(html).toContain(
      '<title>Interview &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</title>',
    );
  });

  test('escapes ampersand in interviewId', () => {
    const idWithAmpersand = 'A&B Test';
    const html = renderInterviewPage(idWithAmpersand);

    expect(html).toContain('<title>Interview A&amp;B Test</title>');
    expect(html).not.toContain('<title>Interview A&B Test</title>');
  });

  test('escapes single quotes in interviewId', () => {
    const idWithQuote = "test'quote";
    const html = renderInterviewPage(idWithQuote);

    expect(html).toContain('<title>Interview test&#39;quote</title>');
  });

  test('preserves safe interviewId characters', () => {
    const safeId = 'my-interview-123_test';
    const html = renderInterviewPage(safeId);

    expect(html).toContain(`<title>Interview ${safeId}</title>`);
  });

  test('interviewId in JSON script tag is properly stringified', () => {
    const idWithQuotes = 'test"onclick"evil';
    const html = renderInterviewPage(idWithQuotes);

    // The interviewId in the JavaScript should be JSON.stringify'd
    // JSON.stringify escapes quotes as \"
    expect(html).toContain('const interviewId = ');
    // The actual output has escaped quotes for JavaScript string
    expect(html).toContain('"test\\"onclick\\"evil"');
  });

  test('does not inject raw interviewId into HTML title', () => {
    const xssAttempt = '<img src=x onerror=alert(1)>';
    const html = renderInterviewPage(xssAttempt);

    // Title should be escaped
    expect(html).not.toContain(`<title>Interview ${xssAttempt}</title>`);
    expect(html).toContain(
      '<title>Interview &lt;img src=x onerror=alert(1)&gt;</title>',
    );
  });
});
