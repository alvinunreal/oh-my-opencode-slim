import { afterEach, describe, expect, mock, test } from 'bun:test';
import { runSecondaryModelWithFallback } from './secondary-model';
import type { SecondaryModel } from './types';

type PromptStep = {
  text?: string;
  error?: Error;
};

function createMockClient(steps: PromptStep[]) {
  let createCount = 0;
  let promptCount = 0;

  return {
    session: {
      create: mock(async () => ({ id: `session-${createCount++}` })),
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
      delete: mock(async () => ({})),
    },
    tool: {
      ids: mock(async () => ({ data: ['read', 'bash'] })),
    },
  } as any;
}

describe('smartfetch/secondary-model', () => {
  const models: SecondaryModel[] = [
    { providerID: 'provider-a', modelID: 'small' },
    { providerID: 'provider-b', modelID: 'fallback' },
  ];

  afterEach(() => {
    mock.restore();
  });

  test('falls back when the first model returns empty text', async () => {
    const client = createMockClient([
      { text: '   ' },
      { text: 'Useful answer' },
    ]);

    const result = await runSecondaryModelWithFallback(
      client,
      '/tmp/project',
      models,
      'Summarize the page',
      'This is enough fetched content to clear the short-content guard.',
    );

    expect(result.text).toBe('Useful answer');
    expect(result.model).toEqual(models[1]);
    expect(client.session.prompt).toHaveBeenCalledTimes(2);
    expect(client.session.delete).toHaveBeenCalledTimes(2);
  });

  test('falls back when the first model throws', async () => {
    const client = createMockClient([
      { error: new Error('primary failed') },
      { text: 'Recovered answer' },
    ]);

    const result = await runSecondaryModelWithFallback(
      client,
      '/tmp/project',
      models,
      'Extract the answer',
      'This is enough fetched content to clear the short-content guard.',
    );

    expect(result.text).toBe('Recovered answer');
    expect(result.model).toEqual(models[1]);
    expect(client.session.prompt).toHaveBeenCalledTimes(2);
    expect(client.session.delete).toHaveBeenCalledTimes(2);
  });
});
