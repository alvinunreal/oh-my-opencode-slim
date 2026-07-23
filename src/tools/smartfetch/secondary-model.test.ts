import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { _testConfig, runSecondaryModelWithFallback } from './secondary-model';
import type { SecondaryModel } from './types';

type PromptStep = {
  text?: string;
  error?: Error;
};

// Mock getClient so internal calls use our mock v2 client.
// The variable is reassigned per-test to control behavior.
let mockV2Client: Record<string, unknown>;
let mockV2Session: {
  create: ReturnType<typeof mock>;
  prompt: ReturnType<typeof mock>;
  delete: ReturnType<typeof mock>;
};
let mockV2Tool: {
  ids: ReturnType<typeof mock>;
};

mock.module('../../utils/opencode-client', () => ({
  getClient: () => mockV2Client,
}));

function createV2ClientMock(
  steps: PromptStep[],
  deleteBehavior?: {
    failTimes?: number;
  },
) {
  let createCount = 0;
  let promptCount = 0;
  let deleteCallCount = 0;
  const failTimes = deleteBehavior?.failTimes ?? 0;

  mockV2Session = {
    create: mock(async () => ({ data: { id: `session-${createCount++}` } })),
    prompt: mock(async () => {
      const step = steps[promptCount++] ?? {};
      if (step.error) {
        throw step.error;
      }
      return {
        data: {
          parts: [{ type: 'text', text: step.text ?? '' }],
        },
      };
    }),
    delete: mock(async () => {
      deleteCallCount++;
      if (deleteCallCount <= failTimes) {
        throw new Error('delete failed');
      }
      return { data: true };
    }),
  };
  mockV2Tool = {
    ids: mock(async () => ({ data: ['read', 'bash'] })),
  };

  return {
    session: mockV2Session,
    tool: mockV2Tool,
  };
}

describe('smartfetch/secondary-model', () => {
  const models: SecondaryModel[] = [
    { providerID: 'provider-a', modelID: 'small' },
    { providerID: 'provider-b', modelID: 'fallback' },
  ];

  const testInput = { directory: '/tmp/project' } as never;

  afterEach(() => {
    mock.restore();
  });

  test('falls back when the first model returns empty text', async () => {
    mockV2Client = createV2ClientMock([
      { text: '   ' },
      { text: 'Useful answer' },
    ]);

    const result = await runSecondaryModelWithFallback(
      testInput,
      models,
      'Summarize the page',
      'This is enough fetched content to clear the short-content guard.',
    );

    expect(result.text).toBe('Useful answer');
    expect(result.model).toEqual(models[1]);
    expect(mockV2Session.prompt).toHaveBeenCalledTimes(2);
    expect(mockV2Session.delete).toHaveBeenCalledTimes(2);
  });

  test('falls back when the first model throws', async () => {
    mockV2Client = createV2ClientMock([
      { error: new Error('primary failed') },
      { text: 'Recovered answer' },
    ]);

    const result = await runSecondaryModelWithFallback(
      testInput,
      models,
      'Extract the answer',
      'This is enough fetched content to clear the short-content guard.',
    );

    expect(result.text).toBe('Recovered answer');
    expect(result.model).toEqual(models[1]);
    expect(mockV2Session.prompt).toHaveBeenCalledTimes(2);
    expect(mockV2Session.delete).toHaveBeenCalledTimes(2);
  });

  test('retries session delete on transient failure', async () => {
    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnCalls.push(args);
    const originalDelay = _testConfig.deleteRetryDelayMs;
    _testConfig.deleteRetryDelayMs = 0;
    try {
      mockV2Client = createV2ClientMock([{ text: 'Answer' }], { failTimes: 1 });

      const result = await runSecondaryModelWithFallback(
        testInput,
        [models[0]],
        'Summarize',
        'This is enough fetched content to clear the short-content guard.',
      );

      expect(result.text).toBe('Answer');
      // First attempt failed, second succeeded → 2 calls for one session
      expect(mockV2Session.delete).toHaveBeenCalledTimes(2);
      expect(warnCalls.length).toBe(0);
    } finally {
      console.warn = originalWarn;
      _testConfig.deleteRetryDelayMs = originalDelay;
    }
  });

  test('logs warning when all delete retries fail but does not throw', async () => {
    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnCalls.push(args);
    const originalDelay = _testConfig.deleteRetryDelayMs;
    _testConfig.deleteRetryDelayMs = 0;
    try {
      mockV2Client = createV2ClientMock([{ text: 'Answer' }], {
        failTimes: 99,
      });

      const result = await runSecondaryModelWithFallback(
        testInput,
        [models[0]],
        'Summarize',
        'This is enough fetched content to clear the short-content guard.',
      );

      // Secondary model still succeeds despite cleanup failure
      expect(result.text).toBe('Answer');
      expect(warnCalls.length).toBe(1);
      expect(String(warnCalls[0][0])).toContain('smartfetch');
    } finally {
      console.warn = originalWarn;
      _testConfig.deleteRetryDelayMs = originalDelay;
    }
  });

  test('falls back to next model when prompt times out', async () => {
    mockV2Session = {
      create: mock(async () => ({ data: { id: 'session-timeout' } })),
      prompt: mock(async (opts: any) => {
        const model = opts.model;
        if (model.modelID === 'small') {
          throw new Error('Secondary model timed out');
        }
        return {
          data: {
            parts: [{ type: 'text', text: 'Fallback answer' }],
          },
        };
      }),
      delete: mock(async () => ({ data: true })),
    };
    mockV2Tool = {
      ids: mock(async () => ({ data: ['read'] })),
    };
    mockV2Client = {
      session: mockV2Session,
      tool: mockV2Tool,
    };

    const result = await runSecondaryModelWithFallback(
      testInput,
      models,
      'Summarize',
      'This is enough fetched content to clear the short-content guard.',
    );

    expect(result.text).toBe('Fallback answer');
    expect(result.model).toEqual(models[1]);
  });
});
