import { describe, expect, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  extractChildTerminalEvidence,
  fetchChildTranscript,
} from './child-transcript';

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

describe('extractChildTerminalEvidence', () => {
  test('trailing assistant with text is ready', () => {
    const evidence = extractChildTerminalEvidence({
      data: [message({ id: 'base' }), message({ id: 'last', completed: 5 })],
    });
    expect(evidence).toEqual({ kind: 'ready', text: 'the answer' });
  });

  test('trailing assistant without text is textless', () => {
    const evidence = extractChildTerminalEvidence({
      data: [message({ id: 'last', completed: 5, parts: [] })],
    });
    expect(evidence).toEqual({ kind: 'textless' });
  });

  test('non-assistant trailing message is no-assistant', () => {
    const evidence = extractChildTerminalEvidence({
      data: [message({ id: 'u', role: 'user', completed: 5 })],
    });
    expect(evidence).toEqual({ kind: 'no-assistant' });
  });

  test('finish tool-calls is pending', () => {
    const evidence = extractChildTerminalEvidence({
      data: [message({ id: 'last', completed: 5, finish: 'tool-calls' })],
    });
    expect(evidence).toEqual({ kind: 'pending' });
  });

  test('an in-flight tool part after the baseline is pending', () => {
    const evidence = extractChildTerminalEvidence({
      data: [
        message({ id: 'base', role: 'user' }),
        message({
          id: 'tool',
          role: 'assistant',
          completed: 4,
          parts: [{ type: 'tool', state: { status: 'running' } }],
        }),
        message({ id: 'last', completed: 5 }),
      ],
    });
    expect(evidence).toEqual({ kind: 'pending' });
  });

  test('completed tool parts do not block readiness', () => {
    const evidence = extractChildTerminalEvidence({
      data: [
        message({
          id: 'tool',
          role: 'assistant',
          completed: 4,
          parts: [
            { type: 'tool', state: { status: 'completed' } },
            { type: 'text', text: 'done summary' },
          ],
        }),
      ],
    });
    expect(evidence).toEqual({ kind: 'ready', text: 'done summary' });
  });

  test('trailing assistant error is error with text', () => {
    const evidence = extractChildTerminalEvidence({
      data: [message({ id: 'last', completed: 5, error: 'model exploded' })],
    });
    expect(evidence).toEqual({ kind: 'error', errorText: 'model exploded' });
  });

  test('error objects are stringified', () => {
    const evidence = extractChildTerminalEvidence({
      data: [message({ id: 'last', completed: 5, error: { code: 500 } })],
    });
    expect(evidence.kind).toBe('error');
    expect(evidence.errorText).toContain('500');
  });

  test('requireCompletionTime treats a missing completion time as pending', () => {
    const messages = { data: [message({ id: 'last', completed: null })] };
    expect(
      extractChildTerminalEvidence(messages, {
        requireCompletionTime: true,
      }),
    ).toEqual({ kind: 'pending' });
    // v2 shim shape: info carries no time at all — tolerated when the
    // strictness flag is off (the host outcome gate already confirmed
    // terminal upstream).
    expect(
      extractChildTerminalEvidence(messages, {
        requireCompletionTime: false,
      }),
    ).toEqual({ kind: 'ready', text: 'the answer' });
  });

  test('baseline scoping: no messages after the baseline is no-new-messages', () => {
    const evidence = extractChildTerminalEvidence(
      { data: [message({ id: 'base', role: 'user' })] },
      { baselineMessageID: 'base' },
    );
    expect(evidence).toEqual({ kind: 'no-new-messages' });
  });

  test('missing baseline message yields no-new-messages (caller retries)', () => {
    const evidence = extractChildTerminalEvidence(
      { data: [message({ id: 'last', completed: 5 })] },
      { baselineMessageID: 'gone' },
    );
    expect(evidence).toEqual({ kind: 'no-new-messages' });
  });

  test('malformed responses degrade to no-assistant, never throw', () => {
    expect(extractChildTerminalEvidence(undefined)).toEqual({
      kind: 'no-assistant',
    });
    expect(extractChildTerminalEvidence({})).toEqual({ kind: 'no-assistant' });
    expect(extractChildTerminalEvidence({ data: 'nope' })).toEqual({
      kind: 'no-assistant',
    });
    expect(extractChildTerminalEvidence({ data: [null, 42, 'x'] })).toEqual({
      kind: 'no-assistant',
    });
  });

  test('truthy non-array parts never throw (entry-level malformation)', () => {
    // `?? []` would NOT replace a truthy non-array; the tracker calls the
    // extractor outside its try/catch, so a throw would reject the probe
    // promise unhandled. Both parts sites must degrade to empty.
    const badParts = [
      {
        info: { id: 'm', role: 'assistant', time: { completed: 1 } },
        parts: {},
      },
    ];
    expect(extractChildTerminalEvidence({ data: badParts })).toEqual({
      kind: 'textless',
    });
    const badPartsOnTool = [
      {
        info: { id: 'm', role: 'assistant', time: { completed: 1 } },
        parts: [{ type: 'text', text: 'ok' }],
      },
      { info: { id: 't', role: 'assistant' }, parts: 'garbage' },
    ];
    expect(
      extractChildTerminalEvidence(
        { data: badPartsOnTool },
        { requireCompletionTime: false },
      ),
    ).toEqual({ kind: 'textless' });
  });

  test('error: null is not an error (pinned semantics)', () => {
    // Old tracker code treated error:null as an error; the shared
    // extractor deliberately reads null as "no error" and extracts text.
    const evidence = extractChildTerminalEvidence({
      data: [message({ id: 'last', completed: 5, error: null })],
    });
    expect(evidence).toEqual({ kind: 'ready', text: 'the answer' });
  });

  test("finish 'unknown' is pending (not only 'tool-calls')", () => {
    const evidence = extractChildTerminalEvidence({
      data: [message({ id: 'last', completed: 5, finish: 'unknown' })],
    });
    expect(evidence).toEqual({ kind: 'pending' });
  });

  test('scanBackToLastAssistant classifies a non-assistant tail from the last assistant', () => {
    const transcript = {
      data: [
        message({ id: 'u', role: 'user' }),
        message({
          id: 'final',
          completed: 5,
          parts: [{ type: 'text', text: 'real answer' }],
        }),
        // Structurally valid v2 tail (e.g. host synthetic state message).
        {
          info: { id: 'tail', role: 'synthetic' },
          parts: [{ type: 'text', text: '<subagent/>' }],
        },
      ],
    };
    // Default: strict trailing semantics (revive probe) → not ready.
    expect(extractChildTerminalEvidence(transcript)).toEqual({
      kind: 'no-assistant',
    });
    // v2 consumer: scan back to the last assistant.
    expect(
      extractChildTerminalEvidence(transcript, {
        scanBackToLastAssistant: true,
        requireCompletionTime: false,
      }),
    ).toEqual({ kind: 'ready', text: 'real answer' });
  });

  test('scanBackToLastAssistant with no assistant at all stays no-assistant', () => {
    const transcript = {
      data: [
        message({ id: 'u', role: 'user' }),
        { info: { id: 'tail', role: 'system' }, parts: [] },
      ],
    };
    expect(
      extractChildTerminalEvidence(transcript, {
        scanBackToLastAssistant: true,
      }),
    ).toEqual({ kind: 'no-assistant' });
  });

  test('multi-part text is joined and the whole string trimmed', () => {
    const evidence = extractChildTerminalEvidence({
      data: [
        message({
          id: 'last',
          completed: 5,
          parts: [
            { type: 'text', text: '  first  ' },
            { type: 'tool', state: { status: 'error' } },
            { type: 'text', text: 'second  ' },
          ],
        }),
      ],
    });
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
