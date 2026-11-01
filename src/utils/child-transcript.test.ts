import { describe, expect, spyOn, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import { buildPluginInput } from '../v2/client-shim';
import type { V2Context } from '../v2/types';
import {
  attributeHostRoundToTranscript,
  classifyAssistantTurnEvidence,
  classifyTerminalEvidence,
  classifyV2HistoricalRound,
  diagnosticExcerptOf,
  diagnosticTail,
  fetchChildTranscript,
  latestInputAtOf,
  stringifyError,
  terminalTextOf,
} from './child-transcript';
import { composeHostRound, hostRoundStateOf } from './session-runtime-status';

describe('diagnostic excerpts', () => {
  test('trims a multibyte tail once without splitting surrogate pairs', () => {
    const encode = spyOn(TextEncoder.prototype, 'encode');
    try {
      const tail = diagnosticTail(`${'界'.repeat(3000)}😀x`, 1024);
      expect(tail).toBe(`${'界'.repeat(339)}😀x`);
      expect(encode.mock.calls.length).toBeLessThanOrEqual(1);
      expect(diagnosticTail('\ud800x\udc00y', 7)).toBe('x\udc00y');
      expect(diagnosticTail('a\udc00\udc00b', 5)).toBe('\udc00b');
      expect(diagnosticTail('abc\ud800\ud800', 5)).toBe('bc');
    } finally {
      encode.mockRestore();
    }
  });

  test('a full text part followed by ignored tool output is not character-truncated', () => {
    const text = 'x'.repeat(2000);
    const result = diagnosticExcerptOf({
      data: [
        { info: { role: 'user' }, parts: [] },
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'tool', state: { status: 'completed' } },
            { type: 'text', text },
          ],
        },
      ],
    });
    if (!('text' in result)) throw new Error('expected excerpt');
    expect(result.text).toBe(text);
    expect(result.truncated).toBe('none');
  });

  test('an anchored run can excerpt without assistant creation timestamps', () => {
    const result = diagnosticExcerptOf(
      {
        data: [
          { info: { id: 'msg_input', role: 'user' }, parts: [] },
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'anchored partial evidence' }],
          },
        ],
      },
      { inputMessageID: 'msg_input', runStartedAt: 100 },
    );
    expect(result).toHaveProperty('text', 'anchored partial evidence');
  });

  test('a late-registered anchored run keeps output that predates its registration', () => {
    const transcript = {
      data: [
        {
          info: { id: 'msg_input', role: 'user', time: { created: 10 } },
          parts: [],
        },
        {
          info: { role: 'assistant', time: { created: 20 } },
          parts: [{ type: 'text', text: 'failed partial output' }],
        },
      ],
    };
    // A resumed foreground child can finish before the plugin registers the
    // generation. The recorded input, not the registration clock, proves the
    // excerpt boundary.
    const anchored = diagnosticExcerptOf(transcript, {
      inputMessageID: 'msg_input',
      runStartedAt: 100,
      completedAt: 200,
    });
    expect(anchored).toMatchObject({
      text: 'failed partial output',
      truncated: 'none',
    });
    // Without a recorded input id the timestamp fence still refuses.
    expect(
      diagnosticExcerptOf(transcript, { runStartedAt: 100, completedAt: 200 }),
    ).toEqual({
      unavailable: 'no assistant evidence at or after the tracked run start',
    });
  });

  test('an anchored run refuses a newer input even within the old publication window', () => {
    const result = diagnosticExcerptOf(
      {
        data: [
          {
            info: { id: 'msg_old', role: 'user', time: { created: 10 } },
            parts: [],
          },
          {
            info: { id: 'msg_new', role: 'user', time: { created: 20 } },
            parts: [],
          },
          {
            info: { role: 'assistant', time: { created: 30 } },
            parts: [{ type: 'text', text: 'NEW RUN' }],
          },
        ],
      },
      { inputMessageID: 'msg_old', runStartedAt: 10, completedAt: 40 },
    );
    expect(result).toEqual({
      unavailable:
        'latest input is not this run’s recorded input; a later run owns the tail',
    });
  });

  test('a recorded same-generation amendment is a legal excerpt boundary', () => {
    const result = diagnosticExcerptOf(
      {
        data: [
          {
            info: { id: 'msg_open', role: 'user', time: { created: 10 } },
            parts: [],
          },
          {
            info: { id: 'msg_amend', role: 'user', time: { created: 20 } },
            parts: [],
          },
          {
            info: { role: 'assistant', time: { created: 30 } },
            parts: [{ type: 'text', text: 'AMENDED RUN' }],
          },
        ],
      },
      {
        inputMessageID: 'msg_open',
        amendmentMessageID: 'msg_amend',
        runStartedAt: 10,
        completedAt: 40,
      },
    );
    if ('unavailable' in result) throw new Error(result.unavailable);
    expect(result.text).toContain('AMENDED RUN');
  });

  test('an anchored run refuses a boundary without a verifiable message id', () => {
    expect(
      diagnosticExcerptOf(
        {
          data: [
            { info: { role: 'user' }, parts: [] },
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'UNKNOWN' }],
            },
          ],
        },
        { inputMessageID: 'msg_missing' },
      ),
    ).toEqual({
      unavailable:
        'recorded run input is outside the diagnostic message window',
    });
  });

  test.each(['tool', 'assistant'])(
    'a %s error clipped to whitespace still reports truncation',
    (kind) => {
      const error = `permission denied${' '.repeat(480)}`;
      const result = diagnosticExcerptOf({
        data: [
          { info: { role: 'user' }, parts: [] },
          {
            info: {
              role: 'assistant',
              ...(kind === 'assistant' ? { error } : {}),
            },
            parts:
              kind === 'tool'
                ? [{ type: 'tool', state: { status: 'error', error } }]
                : [],
          },
        ],
      });
      if (!('text' in result)) throw new Error('expected excerpt');
      expect(result.truncated).toBe('chars');
      expect(result.text).toContain('error details truncated');
    },
  );

  test.each(['v1', 'v2'] as const)(
    'failed-tool diagnostic preserves %s host errors without inputs or outputs',
    async (flavor) => {
      const parts = [
        {
          type: 'tool',
          state: {
            status: 'error',
            input: { command: 'SECRET INPUT' },
            error:
              flavor === 'v2'
                ? { type: 'tool', message: 'permission denied' }
                : 'permission denied',
            content: [{ type: 'text', text: 'SECRET FAILED CONTENT' }],
          },
        },
        {
          type: 'tool',
          state: {
            status: 'completed',
            input: { command: 'SECRET INPUT' },
            output: 'SECRET OUTPUT',
            content: [{ type: 'text', text: 'SECRET SUCCESS CONTENT' }],
          },
        },
      ];
      const client =
        flavor === 'v2'
          ? buildPluginInput({
              session: {
                context: async () => [
                  { id: 'input', type: 'user', time: 100, content: [] },
                  {
                    id: 'answer',
                    type: 'assistant',
                    time: 110,
                    content: parts,
                  },
                ],
              },
            } as unknown as V2Context).client
          : ({
              session: {
                messages: async () => ({
                  data: [
                    {
                      info: { role: 'user', time: { created: 100 } },
                      parts: [],
                    },
                    {
                      info: { role: 'assistant', time: { created: 110 } },
                      parts,
                    },
                  ],
                }),
              },
            } as unknown as PluginInput['client']);
      const transcript = await fetchChildTranscript(
        client,
        'child',
        '/test',
        100,
      );
      const result = diagnosticExcerptOf(transcript, { runStartedAt: 100 });
      if (!('text' in result)) throw new Error('expected excerpt');
      expect(result.text).toContain('tool_error: permission denied');
      expect(result.text).not.toContain('SECRET');
      expect(result.truncated).toBe('none');
    },
  );

  test.each([false, true])(
    'budget stop counts only unvisited entries (earlier assistant=%s)',
    (earlierAssistant) => {
      const result = diagnosticExcerptOf(
        {
          data: [
            { info: { role: 'user', time: { created: 0 } }, parts: [] },
            ...(earlierAssistant
              ? [
                  {
                    info: { role: 'assistant', time: { created: 1 } },
                    parts: [{ type: 'text', text: 'earlier step' }],
                  },
                ]
              : []),
            {
              info: { role: 'assistant', time: { created: 2 } },
              parts: [{ type: 'text', text: '界'.repeat(2000) }],
            },
          ],
        },
        { runStartedAt: 0, maxBytes: 1000 },
      );
      if (!('text' in result)) throw new Error('expected excerpt');
      expect(result.omittedMessages).toBe(earlierAssistant ? 1 : 0);
      expect(result.truncated).toBe(
        earlierAssistant ? 'messages,chars' : 'chars',
      );
      if (earlierAssistant)
        expect(result.text).toContain('1 earlier messages omitted');
      else expect(result.text).not.toContain('earlier messages omitted');
      expect(
        new TextEncoder().encode(result.text).byteLength,
      ).toBeLessThanOrEqual(1000);
    },
  );

  test('budget truncation counts a pre-start boundary input only once', () => {
    const result = diagnosticExcerptOf(
      {
        data: [
          { info: { role: 'user', time: { created: 99 } }, parts: [] },
          {
            info: { role: 'assistant', time: { created: 110 } },
            parts: [{ type: 'text', text: 'x'.repeat(200) }],
          },
        ],
      },
      { runStartedAt: 100, maxBytes: 100 },
    );
    if (!('text' in result)) throw new Error('expected excerpt');
    expect(result.omittedMessages).toBe(1);
    expect(result.text).toContain('1 earlier messages omitted');
    expect(result.truncated).toBe('messages,chars');
    expect(
      new TextEncoder().encode(result.text).byteLength,
    ).toBeLessThanOrEqual(100);
  });

  test('real v2 compacted context reports omitted maintenance messages', async () => {
    const input = buildPluginInput({
      session: {
        context: async () => [
          { id: 'input', type: 'user', time: 10, content: [] },
          { id: 'compact', type: 'compaction', status: 'completed' },
          {
            id: 'answer',
            type: 'assistant',
            time: 11,
            content: [{ type: 'text', text: 'partial work' }],
          },
        ],
      },
    } as unknown as V2Context);
    const transcript = await fetchChildTranscript(
      input.client,
      'child',
      '/test',
      100,
    );
    expect(transcript).toMatchObject({ page: { complete: false } });
    const result = diagnosticExcerptOf(transcript);
    if (!('text' in result)) throw new Error('expected excerpt');
    expect(result.text).toContain('partial work');
    expect(result.text).toContain('1 compaction messages omitted');
    expect(result.truncated).toBe('messages');
    expect(result.omittedMessages).toBe(1);
  });
  test.each(['user', 'synthetic'])(
    'excerpts fence earlier runs at the latest real %s input',
    (role) => {
      const result = diagnosticExcerptOf({
        data: [
          { info: { role: 'user' }, parts: [] },
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'STALE SUCCESS' }],
          },
          { info: { id: 'new-input', role }, parts: [] },
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'current step' }],
          },
          { info: { role: 'user' }, parts: [{ type: 'compaction' }] },
          { info: { role: 'system' }, parts: [] },
          { info: { role: 'assistant', error: 'current failure' }, parts: [] },
        ],
      });
      if (!('text' in result)) throw new Error('expected excerpt');
      expect(result.text).not.toContain('STALE SUCCESS');
      expect(result.text).toContain('current step');
      expect(result.text).toContain('current failure');
      expect(result.text).toContain('2 earlier messages omitted');
      expect(result.omittedMessages).toBe(3);
    },
  );

  test('excerpts fail closed when the bounded window has no real input', () => {
    const result = diagnosticExcerptOf({
      data: Array.from({ length: 41 }, (_, i) => ({
        info: { role: i === 0 ? 'user' : 'assistant' },
        parts: [{ type: 'text', text: 'unattributable output' }],
      })),
    });
    expect(result).toEqual({
      unavailable: 'latest input is outside the diagnostic message window',
    });
  });

  test('v2 compaction source cannot fence an excerpt', () => {
    const transcript = {
      data: [
        {
          info: { id: 'compact', role: 'user', sourceType: 'compaction' },
          parts: [],
        },
        { info: { role: 'assistant', error: 'failure' }, parts: [] },
      ],
    };
    expect(diagnosticExcerptOf(transcript)).toHaveProperty('unavailable');
  });

  test('compaction triggers cannot fence an excerpt', () => {
    expect(
      diagnosticExcerptOf({
        data: [
          { info: { role: 'assistant', error: 'older failure' }, parts: [] },
          {
            info: { role: 'user' },
            parts: [{ type: 'compaction', auto: false }],
          },
        ],
      }),
    ).toEqual({
      unavailable: 'latest input is outside the diagnostic message window',
    });
  });

  test('excerpts omit and label compaction triggers and generated summaries', () => {
    const result = diagnosticExcerptOf({
      data: [
        { info: { role: 'user' }, parts: [] },
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'actual child findings' }],
        },
        {
          info: { role: 'user' },
          parts: [
            { type: 'compaction', auto: false },
            { type: 'text', text: 'compact request' },
          ],
        },
        {
          info: { role: 'assistant', summary: true },
          parts: [{ type: 'text', text: 'generated host summary' }],
        },
      ],
    });
    if (!('text' in result)) throw new Error('expected excerpt');
    expect(result.text).toContain('actual child findings');
    expect(result.text).not.toContain('generated host summary');
    expect(result.text).not.toContain('compact request');
    expect(result.text).toContain('[... 2 compaction messages omitted ...]');
    expect(result.truncated).toBe('messages');
    expect(result.omittedMessages).toBe(2);
    expect(
      new TextEncoder().encode(result.text).byteLength,
    ).toBeLessThanOrEqual(6144);
  });
  test('diagnostic excerpts cap errors without serializing arbitrary error data', () => {
    const result = diagnosticExcerptOf({
      data: [
        { info: { role: 'user' }, parts: [] },
        {
          info: {
            role: 'assistant',
            error: {
              message: 'x'.repeat(100_000),
              toJSON() {
                throw new Error('must not serialize');
              },
            },
          },
          parts: Array.from({ length: 100 }, () => ({
            type: 'text',
            text: 'x'.repeat(100_000),
          })),
        },
      ],
    });
    if (!('text' in result)) throw new Error('expected excerpt');
    expect(result.assistantError?.length).toBeLessThanOrEqual(480);
    expect(
      new TextEncoder().encode(result.text).byteLength,
    ).toBeLessThanOrEqual(6144);
  });
  test.each(['text', 'assistant error', 'tool error', 'structured tool error'])(
    'preserves surrogate pairs at intermediate %s boundaries',
    (kind) => {
      const text = `😀${'x'.repeat(kind === 'text' ? 1999 : 479)}`;
      const entry = {
        info: {
          role: 'assistant',
          ...(kind === 'assistant error' ? { error: { message: text } } : {}),
        },
        parts:
          kind === 'text'
            ? [{ type: 'text', text }]
            : kind.endsWith('tool error')
              ? [
                  {
                    type: 'tool',
                    state: {
                      status: 'error',
                      error:
                        kind === 'structured tool error'
                          ? { type: 'tool', message: text }
                          : text,
                    },
                  },
                ]
              : [],
      };
      for (const maxBytes of [6144, 2048, 97]) {
        const result = diagnosticExcerptOf(
          { data: [{ info: { role: 'user' }, parts: [] }, entry] },
          { maxBytes },
        );
        if (!('text' in result)) throw new Error('expected excerpt');
        if (kind === 'structured tool error' && maxBytes === 6144) {
          expect(result.text).toContain('tool_error:');
          expect(result.truncated).toBe('chars');
        }
        expect(
          Array.from(result.text).some((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code >= 0xd800 && code <= 0xdfff;
          }),
        ).toBe(false);
        expect(
          new TextDecoder().decode(new TextEncoder().encode(result.text)),
        ).not.toContain('\uFFFD');
        expect(
          new TextEncoder().encode(result.text).byteLength,
        ).toBeLessThanOrEqual(maxBytes);
      }
    },
  );
  test.each([
    undefined,
    { error: 'deleted' },
    { data: 'not-array' },
    { data: [null] },
  ])('unavailable input is explicit, not thrown: %j', (response) => {
    expect(diagnosticExcerptOf(response)).toHaveProperty('unavailable');
  });
  test('tail scan bounds ignored limit responses and marks omitted messages and character cuts', () => {
    const result = diagnosticExcerptOf({
      data: Array.from({ length: 100 }, (_, index) => ({
        info: { role: index === 61 ? 'user' : 'assistant' },
        parts: [{ type: 'text', text: `${index}: ${'界'.repeat(10_000)}` }],
      })),
    });
    expect('text' in result).toBe(true);
    if ('text' in result) {
      expect(
        new TextEncoder().encode(result.text).byteLength,
      ).toBeLessThanOrEqual(6144);
      expect(result.truncated).toBe('messages,chars');
      expect(result.omittedMessages).toBeGreaterThanOrEqual(60);
      expect(result.text).toContain('earlier messages omitted');
      expect(result.text).toContain('[... truncated ...]');
    }
  });
  test('assistant and failed-tool errors are labelled and capped; inputs and successful output are excluded', () => {
    const result = diagnosticExcerptOf({
      data: [
        { info: { role: 'user' }, parts: [] },
        {
          info: {
            role: 'assistant',
            error: { data: { message: 'provider broke' } },
          },
          parts: [
            {
              type: 'tool',
              state: {
                status: 'completed',
                input: 'SECRET INPUT',
                output: 'SECRET OUTPUT',
              },
            },
            {
              type: 'tool',
              state: {
                status: 'error',
                input: 'SECRET INPUT',
                error: `${'x'.repeat(3000)}failed command`,
              },
            },
            { type: 'text', text: 'partial answer' },
          ],
        },
      ],
    });
    if (!('text' in result)) throw new Error('expected excerpt');
    expect(result.text).toContain('assistant_error: provider broke');
    expect(result.text).toContain('tool_error:');
    expect(result.text).toContain('failed command');
    expect(result.text).toContain('partial answer');
    expect(result.text).not.toContain('SECRET');
    expect(result.text.length).toBeLessThan(1000);
    expect(result.truncated).toBe('chars');
  });
  test('a small transcript is untruncated and user input is never excerpted', () => {
    expect(
      diagnosticExcerptOf({
        data: [
          {
            info: { role: 'user' },
            parts: [{ type: 'text', text: 'private prompt' }],
          },
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'partial answer' }],
          },
        ],
      }),
    ).toEqual({
      text: 'partial answer',
      truncated: 'none',
      omittedMessages: 0,
    });
  });
  test('caps per-message work even when a host returns thousands of parts', () => {
    const result = diagnosticExcerptOf({
      data: [
        { info: { role: 'user' }, parts: [] },
        {
          info: { role: 'assistant' },
          parts: [
            ...Array.from({ length: 10_000 }, () => ({
              type: 'text',
              text: 'older',
            })),
            { type: 'text', text: 'tail evidence' },
          ],
        },
      ],
    });
    if (!('text' in result)) throw new Error('expected excerpt');
    expect(result.text).toContain('tail evidence');
    expect(result.text.length).toBeLessThanOrEqual(2040);
    expect(result.truncated).toContain('chars');
  });
});

// #1642's host-attribution cases, expressed through #1635's parser/composer
// rather than restoring the superseded historical-round classifier.
describe('V2 host outcome attribution', () => {
  const input = {
    info: { id: 'input', role: 'user', time: { created: 10 } },
    parts: [{ type: 'text', text: 'work' }],
  };
  const answer = {
    info: {
      id: 'answer',
      role: 'assistant',
      time: { created: 11, completed: 12 },
    },
    parts: [{ type: 'text', text: 'RESULT' }],
  };
  const host = { outcome: 'succeeded', time: { idle: 13 } };
  const classify = (transcript: unknown, info = host) =>
    composeHostRound(
      attributeHostRoundToTranscript(hostRoundStateOf(info), transcript),
      latestInputAtOf(transcript),
    );

  test('uses the host outcome without requiring a transcript idle marker', () => {
    const transcript = { data: [input, answer] };
    expect(classify(transcript)).toMatchObject({ verdict: 'completed' });
    expect(terminalTextOf(transcript)).toBe('RESULT');
  });

  test.each([{ created: 14 }, { created: 11, completed: 14 }])(
    'never attributes assistant activity newer than the terminal (%j)',
    (time) => {
      const newer = { ...answer, info: { ...answer.info, time } };
      expect(classify({ data: [input, answer, newer] }).verdict).toBe(
        'incomplete',
      );
      expect(classify({ data: [input, newer, answer] }).verdict).toBe(
        'incomplete',
      );
    },
  );

  test.each(['failed', 'interrupted'])(
    'recognizes textless %s outcomes',
    (outcome) => {
      const round = classify({ data: [input] }, { ...host, outcome });
      expect(round.verdict).toBe(
        outcome === 'failed' ? 'error' : 'interrupted',
      );
      if (outcome === 'failed') {
        expect(round.text).toBe(
          'The historical round failed before an assistant result.',
        );
      }
    },
  );

  test.each([
    { outcome: 'succeeded' },
    { time: { idle: 13 } },
    { outcome: 'succeeded', time: { idle: Number.NaN } },
  ])('refuses partial or malformed host projections (%j)', (info) => {
    const transcript = { data: [input, answer] };
    expect(
      composeHostRound(
        attributeHostRoundToTranscript(hostRoundStateOf(info), transcript),
        latestInputAtOf(transcript),
      ).verdict,
    ).toBe('unreadable');
  });

  test('pending host work cannot borrow a historical transcript terminal', () => {
    const transcript = {
      data: [
        input,
        answer,
        {
          info: {
            id: 'idle',
            sourceType: 'idle',
            outcome: 'succeeded',
            time: { created: 13 },
          },
          parts: [],
        },
      ],
    };
    expect(
      composeHostRound(
        attributeHostRoundToTranscript(hostRoundStateOf({}), transcript),
        latestInputAtOf(transcript),
      ).verdict,
    ).toBe('incomplete');
  });

  test('newer input invalidates the older host terminal', () => {
    const newerInput = {
      ...input,
      info: { ...input.info, time: { created: 14 } },
    };
    expect(classify({ data: [input, answer, newerInput] }).verdict).toBe(
      'incomplete',
    );
  });

  test.each([
    undefined,
    { data: [input, { ...answer, info: { role: 'assistant' } }] },
  ])('unreadable transcript evidence fails closed (%j)', (transcript) => {
    expect(classify(transcript).verdict).toBe('unreadable');
  });
});

function message(overrides: {
  id?: string;
  role?: string;
  finish?: string;
  completed?: number | null;
  error?: unknown;
  parts?: unknown[];
}) {
  return {
    info: {
      id: overrides.id ?? 'm1',
      role: overrides.role ?? 'assistant',
      ...(overrides.finish !== undefined ? { finish: overrides.finish } : {}),
      ...(overrides.completed !== null && overrides.completed !== undefined
        ? { time: { completed: overrides.completed } }
        : {}),
      ...(overrides.error !== undefined ? { error: overrides.error } : {}),
    },
    parts: overrides.parts ?? [{ type: 'text', text: 'the answer' }],
  };
}

describe('host transcript round helpers', () => {
  const transcript = {
    data: [
      {
        info: {
          role: 'user',
          sourceType: 'user',
          time: { created: 10 },
        },
        parts: [],
      },
      {
        info: {
          role: 'assistant',
          sourceType: 'assistant',
          time: { completed: 11 },
        },
        parts: [{ type: 'text', text: 'older answer' }],
      },
      {
        info: {
          id: 'synthetic-input',
          role: 'synthetic',
          sourceType: 'synthetic',
          time: { created: 12 },
        },
        parts: [],
      },
      {
        info: {
          role: 'assistant',
          sourceType: 'assistant',
          time: { completed: 13 },
        },
        parts: [
          { type: 'text', text: ' latest ' },
          { type: 'text', text: 'answer ' },
        ],
      },
    ],
  };

  test('latestInputAtOf uses the newest user or synthetic boundary', () => {
    expect(latestInputAtOf(transcript)).toBe(12);
    expect(latestInputAtOf({ data: [] })).toBeUndefined();
    expect(latestInputAtOf(undefined)).toBeUndefined();
  });

  test('terminal text and attribution respect the latest synthetic input', () => {
    const state = hostRoundStateOf({
      outcome: 'succeeded',
      time: { idle: 13 },
    });
    expect(attributeHostRoundToTranscript(state, transcript)).toEqual(state);
    expect(terminalTextOf(transcript)).toBe('latest\nanswer');
    expect(
      attributeHostRoundToTranscript(
        hostRoundStateOf({ outcome: 'succeeded', time: { idle: 12 } }),
        transcript,
      ),
    ).toEqual({ kind: 'pending' });
  });

  test.each([
    { data: [transcript.data[0], { info: null }, transcript.data[2]] },
    { data: 'nope' },
    undefined,
  ])(
    'malformed history fails closed in every shared helper (%j)',
    (history) => {
      expect(
        attributeHostRoundToTranscript(
          hostRoundStateOf({ outcome: 'succeeded', time: { idle: 13 } }),
          history,
        ).kind,
      ).toBe('unknown');
      expect(latestInputAtOf(history)).toBeUndefined();
      expect(terminalTextOf(history)).toBeUndefined();
    },
  );

  test('textless assistant evidence is preserved as empty text', () => {
    expect(
      terminalTextOf({
        data: [
          transcript.data[0],
          {
            info: { role: 'assistant', time: { created: 13 } },
            parts: [{ type: 'text', text: '   ' }],
          },
        ],
      }),
    ).toBe('');
  });
});

describe('classifyV2HistoricalRound (startup path)', () => {
  function v2Message(overrides: {
    id: string;
    sourceType: string;
    time?: Record<string, number>;
    outcome?: string;
    text?: string;
  }) {
    return {
      info: {
        id: overrides.id,
        role: overrides.sourceType === 'idle' ? 'system' : overrides.sourceType,
        sourceType: overrides.sourceType,
        ...(overrides.time !== undefined ? { time: overrides.time } : {}),
        ...(overrides.outcome !== undefined
          ? { outcome: overrides.outcome }
          : {}),
      },
      parts:
        overrides.text !== undefined
          ? [{ type: 'text', text: overrides.text }]
          : [],
    };
  }

  test('classifies a migrated v1 completion without an idle marker', () => {
    expect(
      classifyV2HistoricalRound({
        data: [
          { info: { role: 'user', time: { created: 10 } }, parts: [] },
          {
            info: {
              role: 'assistant',
              finish: 'stop',
              time: { created: 11, completed: 12 },
            },
            parts: [{ type: 'text', text: 'migrated answer' }],
          },
        ],
      }),
    ).toMatchObject({ verdict: 'completed', text: 'migrated answer' });
    expect(
      classifyV2HistoricalRound(
        {
          data: [
            { info: { role: 'user', time: { created: 10 } }, parts: [] },
            {
              info: {
                role: 'assistant',
                finish: 'stop',
                time: { created: 11, completed: 12 },
              },
              parts: [{ type: 'text', text: 'not yet idle' }],
            },
          ],
        },
        true,
      ).verdict,
    ).toBe('incomplete');
    expect(
      classifyV2HistoricalRound({
        data: [
          v2Message({ id: 'u', sourceType: 'user', time: { created: 10 } }),
          v2Message({
            id: 'a',
            sourceType: 'assistant',
            time: { created: 11, streamed: 12, completed: 13 },
            text: 'not yet delivered',
          }),
        ],
      }).verdict,
    ).toBe('incomplete');
    expect(
      classifyV2HistoricalRound({
        data: [
          v2Message({ id: 'u', sourceType: 'user', time: { created: 10 } }),
          v2Message({
            id: 'a',
            sourceType: 'assistant',
            time: { created: 11 },
            text: 'partial',
          }),
        ],
      }).verdict,
    ).toBe('incomplete');
  });

  test('interrupted idle is interrupted without an assistant', () => {
    expect(
      classifyV2HistoricalRound({
        data: [
          v2Message({ id: 'u', sourceType: 'user', time: { created: 10 } }),
          v2Message({
            id: 'i',
            sourceType: 'idle',
            time: { created: 11 },
            outcome: 'interrupted',
          }),
        ],
      }),
    ).toMatchObject({ verdict: 'interrupted', startedAt: 10 });
  });

  test('failed idle keeps the fallback when no assistant text exists', () => {
    const round = classifyV2HistoricalRound({
      data: [
        v2Message({ id: 'u', sourceType: 'user', time: { created: 10 } }),
        v2Message({
          id: 'i',
          sourceType: 'idle',
          time: { created: 11 },
          outcome: 'failed',
        }),
      ],
    });
    expect(round).toMatchObject({
      verdict: 'error',
      text: 'The historical round failed before an assistant result.',
    });
    expect(round.text).not.toContain('ask');
  });

  test('succeeded idle without an assistant stays incomplete', () => {
    expect(
      classifyV2HistoricalRound({
        data: [
          v2Message({ id: 'u', sourceType: 'user', time: { created: 10 } }),
          v2Message({
            id: 'i',
            sourceType: 'idle',
            time: { created: 11 },
            outcome: 'succeeded',
          }),
        ],
      }),
    ).toMatchObject({ verdict: 'incomplete', startedAt: 10 });
  });

  test('a newer assistant after the closing idle is rejected', () => {
    const round = classifyV2HistoricalRound({
      data: [
        v2Message({ id: 'u', sourceType: 'user', time: { created: 10 } }),
        v2Message({
          id: 'a',
          sourceType: 'assistant',
          time: { created: 11, completed: 12 },
          text: 'ANSWER-A',
        }),
        v2Message({
          id: 'ia',
          sourceType: 'idle',
          time: { created: 13 },
          outcome: 'succeeded',
        }),
        v2Message({
          id: 'b',
          sourceType: 'assistant',
          time: { created: 14 },
          text: 'ANSWER-B',
        }),
      ],
    });
    expect(round.verdict).toBe('incomplete');
    expect(JSON.stringify(round)).not.toContain('ANSWER-A');
    expect(JSON.stringify(round)).not.toContain('ANSWER-B');
  });

  test.each([
    ['succeeded', 'completed'],
    ['failed', 'error'],
    ['interrupted', 'interrupted'],
  ] as const)(
    'startup %s uses the idle boundary and rejects a later assistant completion',
    (outcome, verdict) => {
      const answer = v2Message({
        id: 'a',
        sourceType: 'assistant',
        time: { created: 13, completed: 14 },
        text: 'ANSWER',
      });
      const history = {
        data: [
          v2Message({ id: 'u', sourceType: 'user', time: { created: 12 } }),
          answer,
          v2Message({
            id: 'idle',
            sourceType: 'idle',
            time: { created: 14 },
            outcome,
          }),
        ],
      };
      expect(classifyV2HistoricalRound(history)).toMatchObject({
        verdict,
        completedAt: 14,
      });
      answer.info.time = { created: 13, completed: 16 };
      expect(classifyV2HistoricalRound(history)).toEqual({
        verdict: 'incomplete',
        startedAt: 12,
      });
    },
  );

  test('an idle without a timestamp never borrows assistant completion', () => {
    expect(
      classifyV2HistoricalRound({
        data: [
          v2Message({ id: 'u', sourceType: 'user', time: { created: 12 } }),
          v2Message({
            id: 'a',
            sourceType: 'assistant',
            time: { created: 13, completed: 16 },
            text: 'ANSWER',
          }),
          v2Message({ id: 'idle', sourceType: 'idle', outcome: 'succeeded' }),
        ],
      }).verdict,
    ).toBe('unreadable');
  });

  test('a newer synthetic blocks an older succeeded outcome', () => {
    const round = classifyV2HistoricalRound({
      data: [
        v2Message({ id: 'u', sourceType: 'user', time: { created: 10 } }),
        v2Message({
          id: 'a',
          sourceType: 'assistant',
          time: { created: 11, completed: 12 },
          text: 'OLD',
        }),
        v2Message({
          id: 'i',
          sourceType: 'idle',
          time: { created: 13 },
          outcome: 'succeeded',
        }),
        v2Message({
          id: 's',
          sourceType: 'synthetic',
          time: { created: 14 },
        }),
      ],
    });
    expect(round.verdict).toBe('incomplete');
    expect(JSON.stringify(round)).not.toContain('OLD');
  });
});

test('stringifyError never throws on unserializable empty-message errors', () => {
  const error = Object.assign(new Error(''), { name: 'E', self: {} });
  error.self = error;
  expect(stringifyError(error)).toBe('E');
});

test('stringifyError never returns undefined for unserializable values', () => {
  expect(typeof stringifyError(undefined)).toBe('string');
  expect(typeof stringifyError(Symbol('cause'))).toBe('string');
});

describe('classifyAssistantTurnEvidence', () => {
  test('trailing assistant with text is ready', () => {
    const messages = [
      message({ id: 'base' }),
      message({ id: 'last', completed: 5 }),
    ];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'ready', text: 'the answer' });
  });

  test('trailing assistant without text is textless', () => {
    const messages = [message({ id: 'last', completed: 5, parts: [] })];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'textless' });
  });

  test('finish tool-calls is pending', () => {
    const messages = [
      message({ id: 'last', completed: 5, finish: 'tool-calls' }),
    ];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'pending' });
  });

  test('an in-flight tool part after the baseline is pending', () => {
    const messages = [
      message({ id: 'base', role: 'user' }),
      message({
        id: 'tool',
        role: 'assistant',
        completed: 4,
        parts: [{ type: 'tool', state: { status: 'running' } }],
      }),
      message({ id: 'last', completed: 5 }),
    ];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'pending' });
  });

  test('completed tool parts do not block readiness', () => {
    const messages = [
      message({
        id: 'tool',
        role: 'assistant',
        completed: 4,
        parts: [
          { type: 'tool', state: { status: 'completed' } },
          { type: 'text', text: 'done summary' },
        ],
      }),
    ];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'ready', text: 'done summary' });
  });

  test('trailing assistant error is error with text', () => {
    const messages = [
      message({ id: 'last', completed: 5, error: 'model exploded' }),
    ];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'error', errorText: 'model exploded' });
  });

  test('error objects are stringified', () => {
    const messages = [
      message({ id: 'last', completed: 5, error: { code: 500 } }),
    ];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence.kind).toBe('error');
    expect(evidence.errorText).toContain('500');
  });

  test('requireCompletionTime treats a missing completion time as pending', () => {
    const messages = [message({ id: 'last', completed: null })];
    expect(
      classifyAssistantTurnEvidence(messages, messages.length - 1, -1, true),
    ).toEqual({ kind: 'pending' });
    // v2 shim shape: info carries no time at all — tolerated when the
    // strictness flag is off (the host outcome gate already confirmed
    // terminal upstream).
    expect(
      classifyAssistantTurnEvidence(messages, messages.length - 1, -1, false),
    ).toEqual({ kind: 'ready', text: 'the answer' });
  });

  test('error: null is not an error (pinned semantics)', () => {
    // Old tracker code treated error:null as an error; the shared
    // extractor deliberately reads null as "no error" and extracts text.
    const messages = [message({ id: 'last', completed: 5, error: null })];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'ready', text: 'the answer' });
  });

  test("finish 'unknown' is pending (not only 'tool-calls')", () => {
    const messages = [message({ id: 'last', completed: 5, finish: 'unknown' })];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    expect(evidence).toEqual({ kind: 'pending' });
  });

  test('multi-part text is joined and the whole string trimmed', () => {
    const messages = [
      message({
        id: 'last',
        completed: 5,
        parts: [
          { type: 'text', text: '  first  ' },
          { type: 'tool', state: { status: 'error' } },
          { type: 'text', text: 'second  ' },
        ],
      }),
    ];
    const evidence = classifyAssistantTurnEvidence(
      messages,
      messages.length - 1,
      -1,
    );
    // Whole-string trim only: inner padding between parts is preserved.
    expect(evidence).toEqual({ kind: 'ready', text: 'first  \n\nsecond' });
  });
});

describe('classifyTerminalEvidence', () => {
  test('a role-less message after the baseline is unrecognized, never an answer', () => {
    const response = {
      data: [
        message({ id: 'base', role: 'user' }),
        {
          info: { id: 'odd', time: { completed: 5 } },
          parts: [{ type: 'text', text: 'the answer' }],
        },
      ],
    };
    expect(
      classifyTerminalEvidence(response, { baselineMessageID: 'base' }),
    ).toEqual({ verdict: 'retry', reason: 'unrecognized segment shape' });
  });

  test('a compaction round after the baseline is not the answer', () => {
    const summary = message({
      id: 'sum',
      finish: 'stop',
      completed: 9,
      parts: [{ type: 'text', text: 'SUMMARY' }],
    });
    const response = {
      data: [
        message({ id: 'base', role: 'user' }),
        message({ id: 'main', finish: 'stop', completed: 5 }),
        message({ id: 'cut', role: 'user', parts: [{ type: 'compaction' }] }),
        { ...summary, info: { ...summary.info, summary: true } },
      ],
    };
    expect(
      classifyTerminalEvidence(response, { baselineMessageID: 'base' }),
    ).toEqual({ verdict: 'completed', text: 'the answer' });
  });
});

describe('fetchChildTranscript', () => {
  function clientWith(
    session: Record<string, unknown> | undefined,
  ): PluginInput['client'] {
    // Structural stand-in mirroring the v2 client-shim's degraded hosts.
    return { session } as PluginInput['client'];
  }

  test('returns the raw response on success', async () => {
    const response = { data: [] };
    const client = clientWith({ messages: () => response });
    await expect(
      fetchChildTranscript(client, 'ses_child', '/test'),
    ).resolves.toBe(response);
  });

  test('passes sessionID and directory through path and query', async () => {
    const seen: unknown[] = [];
    const client = clientWith({
      messages(...args: unknown[]) {
        seen.push(args[0]);
        return { data: [] };
      },
    });
    await fetchChildTranscript(client, 'ses_child', '/test');
    expect(seen[0]).toEqual({
      path: { id: 'ses_child' },
      query: { directory: '/test' },
    });
  });

  test('binds session.messages to the session object', async () => {
    const session: Record<string, unknown> = {};
    session.messages = function (this: unknown) {
      expect(this).toBe(session);
      return { data: [] };
    };
    await fetchChildTranscript(clientWith(session), 'ses_child', '/test');
  });

  test('returns undefined when session.messages is not callable', async () => {
    await expect(
      fetchChildTranscript(clientWith({}), 'ses_child', '/test'),
    ).resolves.toBeUndefined();
    await expect(
      fetchChildTranscript(clientWith(undefined), 'ses_child', '/test'),
    ).resolves.toBeUndefined();
  });

  test('propagates transport failures', async () => {
    const client = clientWith({
      messages: () => Promise.reject(new Error('transport down')),
    });
    await expect(
      fetchChildTranscript(client, 'ses_child', '/test'),
    ).rejects.toThrow('transport down');
  });

  test('string error payload is surfaced as-is', async () => {
    const client = clientWith({
      messages: () => ({ error: 'session not found' }),
    });
    await expect(
      fetchChildTranscript(client, 'ses_child', '/test'),
    ).rejects.toThrow('session not found');
  });

  test('Error payload is surfaced via its message', async () => {
    const client = clientWith({
      messages: () => ({ error: new Error('boom') }),
    });
    await expect(
      fetchChildTranscript(client, 'ses_child', '/test'),
    ).rejects.toThrow('boom');
  });

  test('object error payload is JSON-stringified', async () => {
    const client = clientWith({
      messages: () => ({ error: { code: 500, message: 'internal' } }),
    });
    await expect(
      fetchChildTranscript(client, 'ses_child', '/test'),
    ).rejects.toThrow('{"code":500,"message":"internal"}');
  });

  test('error: null is not an error (mirrors pinned extractor semantics)', async () => {
    const response = { data: [], error: null };
    const client = clientWith({ messages: () => response });
    await expect(
      fetchChildTranscript(client, 'ses_child', '/test'),
    ).resolves.toBe(response);
  });

  test('non-record responses are returned untouched', async () => {
    const client = clientWith({ messages: () => 'flat-shape' });
    await expect(
      fetchChildTranscript(client, 'ses_child', '/test'),
    ).resolves.toBe('flat-shape');
  });
});
