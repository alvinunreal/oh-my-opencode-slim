import { describe, expect, test } from 'bun:test';
import {
  buildFallbackState,
  findLatestAssistantState,
  flattenMessage,
  parseAssistantState,
} from './parser';

describe('parseAssistantState', () => {
  test('parses valid interview state with questions', () => {
    const text =
      'Here are questions.\n<interview_state>\n{"summary":"Test app","questions":[{"id":"q-1","question":"Platform?","options":["Web","Mobile"],"suggested":"Web"}]}\n</interview_state>';
    const result = parseAssistantState(text, 2);

    expect(result.state).not.toBeNull();
    expect(result.state?.summary).toBe('Test app');
    expect(result.state?.questions).toHaveLength(1);
    expect(result.state?.questions[0].id).toBe('q-1');
    expect(result.state?.questions[0].question).toBe('Platform?');
    expect(result.state?.questions[0].options).toEqual(['Web', 'Mobile']);
    expect(result.state?.questions[0].suggested).toBe('Web');
  });

  test('parses state with title field', () => {
    const text =
      '<interview_state>\n{"summary":"Building X","title":"my-project","questions":[]}\n</interview_state>';
    const result = parseAssistantState(text);

    expect(result.state).not.toBeNull();
    expect(result.state?.title).toBe('my-project');
  });

  test('returns null when no interview_state block', () => {
    const result = parseAssistantState('No state block here.');
    expect(result.state).toBeNull();
    expect(result.error).toBeUndefined();
  });

  test('returns error for invalid JSON inside block', () => {
    const text = '<interview_state>\n{not valid json}\n</interview_state>';
    const result = parseAssistantState(text);

    expect(result.state).toBeNull();
    expect(result.error).toBeDefined();
  });

  test('handles malformed question objects gracefully', () => {
    const text =
      '<interview_state>\n{"summary":"Test","questions":[null,123,"string",{"question":"Valid?"}]}\n</interview_state>';
    const result = parseAssistantState(text, 5);

    expect(result.state).not.toBeNull();
    // Only the valid question should survive Zod validation
    expect(result.state?.questions).toHaveLength(1);
    expect(result.state?.questions[0].question).toBe('Valid?');
  });

  test('respects maxQuestions limit', () => {
    const text =
      '<interview_state>\n{"summary":"Test","questions":[{"id":"q-1","question":"Q1?"},{"id":"q-2","question":"Q2?"},{"id":"q-3","question":"Q3?"},{"id":"q-4","question":"Q4?"}]}\n</interview_state>';
    const result = parseAssistantState(text, 2);

    expect(result.state?.questions).toHaveLength(2);
  });

  test('handles empty questions array', () => {
    const text =
      '<interview_state>\n{"summary":"Waiting","questions":[]}\n</interview_state>';
    const result = parseAssistantState(text);

    expect(result.state).not.toBeNull();
    expect(result.state?.questions).toHaveLength(0);
    expect(result.state?.summary).toBe('Waiting');
  });

  test('strips whitespace from question text', () => {
    const text =
      '<interview_state>\n{"summary":"Test","questions":[{"question":"  Spaced question  ","options":["  A  ","  B  "]}]}\n</interview_state>';
    const result = parseAssistantState(text);

    expect(result.state?.questions[0].question).toBe('Spaced question');
    expect(result.state?.questions[0].options).toEqual(['A', 'B']);
  });

  test('generates fallback ID when question has no id', () => {
    const text =
      '<interview_state>\n{"summary":"Test","questions":[{"question":"No ID?"}]}\n</interview_state>';
    const result = parseAssistantState(text);

    expect(result.state?.questions[0].id).toBe('q-1');
  });

  test('trims options to max 4', () => {
    const text =
      '<interview_state>\n{"summary":"Test","questions":[{"question":"Q?","options":["A","B","C","D","E","F"]}]}\n</interview_state>';
    const result = parseAssistantState(text);

    expect(result.state?.questions[0].options).toHaveLength(4);
  });

  test('filters out non-string options', () => {
    const text =
      '<interview_state>\n{"summary":"Test","questions":[{"question":"Q?","options":["A",42,true,null,"B"]}]}\n</interview_state>';
    const result = parseAssistantState(text);

    expect(result.state?.questions[0].options).toEqual(['A', 'B']);
  });

  test('handles non-string summary gracefully', () => {
    const text =
      '<interview_state>\n{"summary":123,"questions":[]}\n</interview_state>';
    const result = parseAssistantState(text);

    expect(result.state).not.toBeNull();
    expect(result.state?.summary).toBe('');
  });

  test('handles non-string title gracefully', () => {
    const text =
      '<interview_state>\n{"summary":"Test","title":456,"questions":[]}\n</interview_state>';
    const result = parseAssistantState(text);

    expect(result.state).not.toBeNull();
    expect(result.state?.title).toBeUndefined();
  });

  test('handles missing questions field', () => {
    const text =
      '<interview_state>\n{"summary":"No questions field"}\n</interview_state>';
    const result = parseAssistantState(text);

    expect(result.state).not.toBeNull();
    expect(result.state?.questions).toHaveLength(0);
  });

  test('handles question with empty question text', () => {
    const text =
      '<interview_state>\n{"summary":"Test","questions":[{"question":"  "}]}\n</interview_state>';
    const result = parseAssistantState(text);

    expect(result.state?.questions).toHaveLength(0);
  });

  test('is case-insensitive for interview_state tag', () => {
    const text =
      '<INTERVIEW_STATE>\n{"summary":"Upper","questions":[]}\n</INTERVIEW_STATE>';
    const result = parseAssistantState(text);

    expect(result.state).not.toBeNull();
    expect(result.state?.summary).toBe('Upper');
  });

  test('handles deeply nested unexpected objects', () => {
    const text =
      '<interview_state>\n{"summary":"Test","questions":[{"question":"Q?","options":[{"nested":true}]}]}\n</interview_state>';
    const result = parseAssistantState(text);

    expect(result.state?.questions[0].options).toEqual([]);
  });

  test('handles extremely large input gracefully', () => {
    const questions = Array.from({ length: 100 }, (_, i) => ({
      id: `q-${i}`,
      question: `Question ${i}?`,
    }));
    const text = `<interview_state>\n${JSON.stringify({ summary: 'Large', questions })}\n</interview_state>`;
    const result = parseAssistantState(text, 5);

    expect(result.state?.questions).toHaveLength(5);
  });
});

describe('flattenMessage', () => {
  test('joins text parts with newline', () => {
    const message = {
      parts: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'World' },
      ],
    };
    expect(flattenMessage(message as any)).toBe('Hello\nWorld');
  });

  test('handles missing parts', () => {
    expect(flattenMessage({} as any)).toBe('');
  });

  test('handles parts without text', () => {
    const message = {
      parts: [{ type: 'image' }, { type: 'text', text: 'only this' }],
    };
    expect(flattenMessage(message as any)).toBe('only this');
  });
});

describe('buildFallbackState', () => {
  test('returns waiting message for no answers', () => {
    const state = buildFallbackState([]);
    expect(state.summary).toContain('Waiting');
    expect(state.questions).toHaveLength(0);
  });

  test('returns in-progress message when answers exist', () => {
    const messages = [
      { info: { role: 'user' } },
      { info: { role: 'assistant' } },
    ];
    const state = buildFallbackState(messages as any);
    expect(state.summary).toContain('in progress');
  });
});

describe('findLatestAssistantState', () => {
  test('finds state in last assistant message', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: '<interview_state>\n{"summary":"First","questions":[]}\n</interview_state>',
          },
        ],
      },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'reply' }] },
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: '<interview_state>\n{"summary":"Latest","questions":[]}\n</interview_state>',
          },
        ],
      },
    ];

    const result = findLatestAssistantState(messages as any);
    expect(result.state).not.toBeNull();
    expect(result.state?.summary).toBe('Latest');
  });

  test('returns null when no assistant messages', () => {
    const messages = [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
    ];

    const result = findLatestAssistantState(messages as any);
    expect(result.state).toBeNull();
  });

  test('captures parse error from earlier messages', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: '<interview_state>\n{bad json}\n</interview_state>',
          },
        ],
      },
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: '<interview_state>\n{"summary":"Recovery","questions":[]}\n</interview_state>',
          },
        ],
      },
    ];

    const result = findLatestAssistantState(messages as any);
    expect(result.state).not.toBeNull();
    expect(result.state?.summary).toBe('Recovery');
  });

  test('returns latest error when no valid state found', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'No state block here.' }],
      },
    ];

    const result = findLatestAssistantState(messages as any);
    expect(result.state).toBeNull();
    expect(result.latestAssistantError).toContain('Missing');
  });
});
