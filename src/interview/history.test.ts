import { describe, expect, test } from 'bun:test';
import { collapseInterviewHistory, INTERVIEW_SUMMARY_STUB } from './history';

type SubmitPart = {
  type: string;
  tool: string;
  callID: string;
  state: {
    status: string;
    input: { state: Record<string, unknown> };
    output: string;
  };
};

function toolTurn(id: string, summary: string, patch?: string) {
  const state: Record<string, unknown> = {
    title: 'spec',
    summary,
    questions: [],
  };
  if (patch !== undefined) {
    state.patch = patch;
  }
  const part: SubmitPart = {
    type: 'tool',
    tool: 'interview_submit_state',
    callID: id,
    state: {
      status: 'completed',
      input: { state },
      output: 'ok',
    },
  };
  return { info: { role: 'assistant' }, parts: [part] };
}

function submitParts(messages: Array<{ parts?: unknown[] }>): SubmitPart[] {
  const result: SubmitPart[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (
        part &&
        typeof part === 'object' &&
        (part as SubmitPart).tool === 'interview_submit_state'
      ) {
        result.push(part as SubmitPart);
      }
    }
  }
  return result;
}

describe('collapseInterviewHistory', () => {
  test('collapses v2 tool-call parts', () => {
    const first = {
      info: { role: 'assistant' },
      parts: [
        {
          type: 'tool-call',
          toolName: 'interview_submit_state',
          input: {
            summary: '# Full V2\n\nDetailed specification.',
            title: 'spec',
            questions: [],
          },
        },
      ],
    };
    const second = {
      info: { role: 'assistant' },
      parts: [
        {
          type: 'tool-result',
          toolName: 'interview_submit_state',
          input: { summary: 'status', patch: 'x', questions: [] },
        },
      ],
    };

    collapseInterviewHistory([first, second]);

    expect(first.parts[0].input.summary).toBe(INTERVIEW_SUMMARY_STUB);
    expect(first.parts[0].input.patch).toBeUndefined();
  });

  test('keeps the v2 tool-call input wrapper while stubbing its state', () => {
    const first = {
      info: { role: 'assistant' },
      parts: [
        {
          type: 'tool-call',
          toolName: 'interview_submit_state',
          input: {
            state: {
              title: 'spec',
              summary: '# Full V2\n\nDetailed specification.',
              questions: [],
            },
          },
        },
      ],
    };
    const later = toolTurn('later', 'later', 'patch');

    collapseInterviewHistory([first, later]);

    expect(first.parts[0].input).toEqual({
      state: {
        title: 'spec',
        summary: INTERVIEW_SUMMARY_STUB,
        questions: [],
      },
    });
  });

  test('collapses the kickoff of each interview', () => {
    const first = toolTurn('a', '# FIRST\n\nFull specification.');
    const firstStatus = toolTurn('b', 'first status', 'x');
    const second = toolTurn('c', '# SECOND\n\nFull specification.');
    const secondStatus = toolTurn('d', 'second status', 'y');

    collapseInterviewHistory([first, firstStatus, second, secondStatus]);

    const parts = submitParts([first, firstStatus, second, secondStatus]);
    expect(parts[0].state.input.state.summary).toBe(INTERVIEW_SUMMARY_STUB);
    expect(parts[2].state.input.state.summary).toBe(INTERVIEW_SUMMARY_STUB);
    expect(parts[1].state.input.state.summary).toBe('first status');
    expect(parts[3].state.input.state.summary).toBe('second status');
  });

  test('collapses an empty-patch kickoff as a full specification', () => {
    const kickoff = toolTurn('empty', '# FIRST\n\nFull specification.', '');
    const later = toolTurn('later', 'status', 'patch');

    collapseInterviewHistory([kickoff, later]);

    expect(submitParts([kickoff])[0].state.input.state.summary).toBe(
      INTERVIEW_SUMMARY_STUB,
    );
  });

  test('keeps a one-line empty-patch status turn intact', () => {
    const status = toolTurn('status', 'No changes', '');
    const later = toolTurn('later', 'Later status', 'patch');

    collapseInterviewHistory([status, later]);

    expect(submitParts([status])[0].state.input.state.summary).toBe(
      'No changes',
    );
  });

  test('does not collapse a later full summary with an empty patch', () => {
    const kickoff = toolTurn('kickoff', '# FIRST\n\nFull specification.');
    const unchanged = toolTurn(
      'unchanged',
      '# STILL FULL\n\nSame specification.',
      '',
    );
    const later = toolTurn('later', 'Later status', 'patch');

    collapseInterviewHistory([kickoff, unchanged, later]);

    const parts = submitParts([kickoff, unchanged, later]);
    expect(parts[0].state.input.state.summary).toBe(INTERVIEW_SUMMARY_STUB);
    expect(parts[1].state.input.state.summary).toBe(
      '# STILL FULL\n\nSame specification.',
    );
  });
  test('stubs older assistant specs and leaves the latest plus user prompts', () => {
    const kickoff = {
      info: { role: 'user' },
      parts: [
        {
          type: 'text',
          text: 'Format example <interview_state>{"summary":"Full specification markdown","questions":[]}</interview_state>',
        },
      ],
    };
    const first = {
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: '<interview_state>{"summary":"# FULL SPEC ONE\\n\\nDetails","questions":[]}</interview_state>',
        },
      ],
    };
    const second = {
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: '<interview_state>{"summary":"short status","patch":"@@ -1 +1 @@\\n-a\\n+b","questions":[]}</interview_state>',
        },
      ],
    };

    collapseInterviewHistory([kickoff, first, second]);

    expect(kickoff.parts[0].text).toContain('Full specification markdown');
    expect(first.parts[0].text).toContain(INTERVIEW_SUMMARY_STUB);
    expect(first.parts[0].text).not.toContain('FULL SPEC ONE');
    expect(second.parts[0].text).toContain('short status');
    expect(second.parts[0].text).toContain('patch');
  });

  test('preserves non-kickoff blocks in the same text part', () => {
    const first = {
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: '<interview_state>{"summary":"# FULL\\n\\nDetails","questions":[]}</interview_state> tail <interview_state>{"summary":"later","patch":"x","questions":[]}</interview_state>',
        },
      ],
    };
    const second = {
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: '<interview_state>{"summary":"later two","patch":"y","questions":[]}</interview_state>',
        },
      ],
    };

    collapseInterviewHistory([first, second]);

    expect(first.parts[0].text).toContain('later');
    expect(first.parts[0].text).toContain('"patch":"x"');
    expect(first.parts[0].text).toContain(INTERVIEW_SUMMARY_STUB);
  });

  test('preserves a later text block byte-for-byte when only the first is stubbed', () => {
    const later =
      '<interview_state>\n{"summary":"later","patch":"+  blank","questions":[]}\n</interview_state>';
    const first = {
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: `<interview_state>{"summary":"# FULL\\n\\nDetails","questions":[]}</interview_state>\nseparator\n${later}`,
        },
      ],
    };
    const next = toolTurn('next', 'next', 'patch');

    collapseInterviewHistory([first, next]);

    expect(first.parts[0].text).toBe(
      `<interview_state>\n{"summary":"${INTERVIEW_SUMMARY_STUB}","questions":[]}\n</interview_state>\nseparator\n${later}`,
    );
  });

  test('chooses the first full tool state rather than the first tool call', () => {
    const earlier = toolTurn('c0', 'old', '@@ -1 +1 @@\n-a\n+b');
    const kickoff = toolTurn('c1', '# FULL SPEC\n\nDetails');
    const latest = toolTurn('c2', 'status two', '@@ -2 +2 @@\n-c\n+d');

    collapseInterviewHistory([earlier, kickoff, latest]);

    const parts = submitParts([earlier, kickoff, latest]);
    expect(parts[0].state.input.state.summary).toBe('old');
    expect(parts[1].state.input.state.summary).toBe(INTERVIEW_SUMMARY_STUB);
    expect('patch' in parts[1].state.input.state).toBe(false);
  });

  test('stubs the kickoff input and keeps later turns intact', () => {
    const first = toolTurn('c1', '# FULL SPEC ONE\n\nDetails');
    const second = toolTurn('c2', 'status two', '@@ -2 +2 @@\n-c\n+d');
    const third = toolTurn('c3', 'status three', '@@ -3 +3 @@\n-e\n+f');

    collapseInterviewHistory([first, second, third]);

    const parts = submitParts([first, second, third]);
    expect(parts.map((part) => part.state.input.state.summary)).toEqual([
      INTERVIEW_SUMMARY_STUB,
      'status two',
      'status three',
    ]);
    expect('patch' in parts[0].state.input.state).toBe(false);
    expect(parts[1].state.input.state.patch).toBe('@@ -2 +2 @@\n-c\n+d');
    expect(parts[2].state.input.state.patch).toBe('@@ -3 +3 @@\n-e\n+f');
    // Non-stubbed fields survive on older calls.
    expect(parts[0].state.input.state.title).toBe('spec');
    expect(parts[0].state.input.state.questions).toEqual([]);
  });

  test('is idempotent when applied repeatedly', () => {
    const messages = [
      toolTurn('c1', '# FULL SPEC ONE\n\nDetails'),
      toolTurn('c2', 'status two', '@@ -2 +2 @@\n-c\n+d'),
      toolTurn('c3', 'status three', '@@ -3 +3 @@\n-e\n+f'),
    ];

    collapseInterviewHistory(messages);
    const once = JSON.stringify(messages);
    collapseInterviewHistory(messages);
    expect(JSON.stringify(messages)).toBe(once);
  });

  test('leaves non-interview tool parts untouched', () => {
    const readPart = {
      type: 'tool',
      tool: 'read',
      callID: 'r1',
      state: {
        status: 'completed',
        input: { filePath: '/tmp/spec.md' },
        output: '{"ok":true}',
      },
    };
    const taskPart = {
      type: 'tool',
      tool: 'task',
      callID: 't1',
      state: {
        status: 'completed',
        input: { description: 'do work', subagent_type: 'fixer' },
        output: 'done',
      },
    };
    const before = JSON.stringify([readPart, taskPart]);

    collapseInterviewHistory([
      { info: { role: 'assistant' }, parts: [readPart, taskPart] },
    ]);

    expect(JSON.stringify([readPart, taskPart])).toBe(before);
  });

  test('ignores malformed interview_submit_state input shapes', () => {
    const stringInput = {
      type: 'tool',
      tool: 'interview_submit_state',
      callID: 'bad1',
      state: { status: 'completed', input: 'not-an-object', output: 'x' },
    };
    const noState = {
      type: 'tool',
      tool: 'interview_submit_state',
      callID: 'bad2',
      state: { status: 'pending' },
    };
    const arrState = {
      type: 'tool',
      tool: 'interview_submit_state',
      callID: 'bad3',
      state: { status: 'completed', input: { state: [1, 2, 3] } },
    };
    const before = JSON.stringify([stringInput, noState, arrState]);

    collapseInterviewHistory([
      {
        info: { role: 'assistant' },
        parts: [stringInput, noState, arrState],
      },
    ]);

    expect(JSON.stringify([stringInput, noState, arrState])).toBe(before);
  });
});

// A deterministic LCG so a generated history is reproducible from its seed.
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function buildGeneratedHistory(seed: number): unknown[] {
  const random = createRandom(seed);
  const messages: unknown[] = [];
  for (let turn = 0; turn < 10; turn += 1) {
    const roll = random();
    if (roll < 0.4) {
      messages.push(
        toolTurn(`t${seed}-${turn}`, `summary ${turn}`, `patch ${turn}`),
      );
    } else if (roll < 0.65) {
      messages.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: `<interview_state>{"summary":"text summary ${turn}","questions":[]}</interview_state>`,
          },
        ],
      });
    } else if (roll < 0.8) {
      messages.push({
        info: { role: 'user' },
        parts: [{ type: 'text', text: `question ${turn}` }],
      });
    } else {
      messages.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            tool: 'read',
            callID: `r${seed}-${turn}`,
            state: {
              status: 'completed',
              input: { filePath: `/tmp/${turn}.md` },
              output: 'ok',
            },
          },
        ],
      });
    }
  }
  return messages;
}

describe('collapseInterviewHistory properties', () => {
  test('is deterministic and idempotent across generated histories', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const left = buildGeneratedHistory(seed);
      const right = buildGeneratedHistory(seed);

      collapseInterviewHistory(left);
      collapseInterviewHistory(right);
      expect(JSON.stringify(left)).toBe(JSON.stringify(right));

      const once = JSON.stringify(left);
      collapseInterviewHistory(left);
      expect(JSON.stringify(left)).toBe(once);
    }
  });

  test('keeps collapsed history as an exact prefix for text and tool turns', () => {
    const textHead = [
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: '<interview_state>{"summary":"FULL","questions":[]}</interview_state>',
          },
        ],
      },
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: '<interview_state>{"summary":"status","patch":"x","questions":[]}</interview_state>',
          },
        ],
      },
    ];
    const toolHead = [toolTurn('p1', 'FULL'), toolTurn('p2', 'status', 'x')];
    for (const head of [textHead, toolHead]) {
      const withNewTurn = [...head, toolTurn('p3', 'new', 'y')];
      collapseInterviewHistory(head);
      collapseInterviewHistory(withNewTurn);
      expect(withNewTurn.slice(0, head.length)).toEqual(head);
    }
  });

  test('keeps the two-interview collapsed prefix monotone', () => {
    const head = [
      toolTurn('first', 'FIRST'),
      toolTurn('first-status', 'first status', 'x'),
      toolTurn('second', 'SECOND'),
      toolTurn('second-status', 'second status', 'y'),
    ];
    const extended = [...structuredClone(head), toolTurn('third', 'THIRD')];

    collapseInterviewHistory(head);
    collapseInterviewHistory(extended);

    expect(extended.slice(0, head.length)).toEqual(head);
  });
});
