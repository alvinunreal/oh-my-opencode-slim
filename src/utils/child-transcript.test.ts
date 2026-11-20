import { describe, expect, spyOn, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import { buildPluginInput } from '../v2/client-shim';
import type { V2Context } from '../v2/types';
import {
  attributeHostRoundToTranscript,
  classifyAssistantTurnEvidence,
  classifyMigratedV1Round,
  diagnosticTail,
  fetchChildTranscript,
  latestInputAtOf,
  stringifyError,
  terminalTextOf,
} from './child-transcript';
import { composeHostRound, hostRoundStateOf } from './session-runtime-status';

describe('diagnostic tail and transcript', () => {
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

test('classifies a migrated v1 completion without an idle marker', () => {
  expect(
    classifyMigratedV1Round({
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
