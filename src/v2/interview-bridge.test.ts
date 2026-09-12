import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { bindFreePort } from '../interview/test-port';
import {
  applyInterviewCommandParts,
  createV2InterviewBridge,
  markerText,
} from './interview-bridge';
import type { V2SessionContextEvent } from './types';

function createContext(overrides?: {
  synthetic?: (input: Record<string, unknown>) => Promise<unknown>;
  rename?: (input: Record<string, unknown>) => Promise<unknown>;
  prompt?: (input: Record<string, unknown>) => Promise<unknown>;
}): any {
  return {
    session: {
      hook: mock(async () => ({ dispose() {} })),
      synthetic: overrides?.synthetic,
      rename: overrides?.rename,
      prompt: overrides?.prompt,
    },
  };
}

/** Minimal context event whose trailing user message is the given marker. */
function markerContextEvent(
  sessionID: string,
  idea: string,
  id = 'tail',
): V2SessionContextEvent {
  return {
    sessionID,
    agent: 'orchestrator',
    model: {},
    system: [],
    tools: {},
    messages: [
      { id, role: 'user', content: [{ type: 'text', text: markerText(idea) }] },
    ],
  };
}

/** Wrap a messages array so each full projection pass is counted:
 * toInterviewMessages reads `.map` on the array exactly once per pass. */
function countProjections(messages: V2SessionContextEvent['messages']): {
  proxied: V2SessionContextEvent['messages'];
  count: () => number;
} {
  let projections = 0;
  return {
    proxied: new Proxy(messages, {
      get(target, prop) {
        if (prop === 'map') projections += 1;
        return Reflect.get(target, prop, target);
      },
    }),
    count: () => projections,
  };
}

describe('markerText', () => {
  test('renders args byte-exact', () => {
    expect(markerText('build a notes app')).toBe(
      '<omos-interview-command>build a notes app</omos-interview-command>',
    );
    expect(markerText('')).toBe(
      '<omos-interview-command></omos-interview-command>',
    );
  });

  test('does not mangle $-sequences in args (regression)', () => {
    // A string replacer would turn $$ into $, $& into the whole match, and
    // $` into the preceding text. Function replacer keeps them byte-exact.
    expect(markerText('pay $$ now')).toBe(
      '<omos-interview-command>pay $$ now</omos-interview-command>',
    );
    expect(markerText('a $& b')).toBe(
      '<omos-interview-command>a $& b</omos-interview-command>',
    );
    expect(markerText('a $` b')).toBe(
      '<omos-interview-command>a $` b</omos-interview-command>',
    );
  });
});

describe('v2 interview bridge', () => {
  test('registers an add-only marker command and rewrites only the tail', async () => {
    const directory = `.tmp-v2-interview-${Date.now()}`;
    const synthetic = mock(async () => ({}));
    const rename = mock(async () => ({}));
    const bridge = createV2InterviewBridge(
      createContext({ synthetic, rename }),
      {
        outputFolder: directory,
      } as never,
    );
    const added: Array<{ name: string; description?: string }> = [];
    bridge.registerCommand({
      add: (def) =>
        added.push({ name: def.name, description: def.description }),
    });

    expect(added).toEqual([
      {
        name: 'interview',
        description: 'Open a localhost interview UI for a feature idea',
      },
    ]);

    const earlier = {
      id: 'old',
      role: 'user',
      content: [{ type: 'text', text: 'Earlier context' }],
    };
    const event = {
      sessionID: 'ses_v2',
      agent: 'orchestrator',
      model: {},
      system: [],
      tools: {},
      messages: [
        earlier,
        {
          id: 'tail',
          role: 'user',
          content: [
            {
              type: 'text',
              text: markerText('build a notes app'),
            },
          ],
        },
      ],
    };
    const earlierBefore = structuredClone(earlier);
    await bridge.handleContext(event);

    expect(earlier).toEqual(earlierBefore);
    expect(event.messages[1].content[0].text).toContain('build a notes app');
    expect(event.messages[1].content[0].text).toContain('<interview_state>');
    expect(synthetic).toHaveBeenCalled();
    expect(rename).toHaveBeenCalledWith({
      sessionID: 'ses_v2',
      title: 'Interview: build a notes app',
    });

    bridge.dispose();
    await fs.rm(`${process.cwd()}/${directory}`, {
      recursive: true,
      force: true,
    });
  });

  test('registerCommand is a no-op when the draft has no add', () => {
    const bridge = createV2InterviewBridge(createContext());
    expect(() => bridge.registerCommand({} as never)).not.toThrow();
    bridge.dispose();
  });

  test('embedded interview markers are not dispatched (whole-text anchor)', async () => {
    const synthetic = mock(async () => ({}));
    const bridge = createV2InterviewBridge(createContext({ synthetic }), {
      outputFolder: `.tmp-v2-embedded-${Date.now()}`,
    } as never);
    const trailing = {
      id: 't',
      role: 'user',
      content: [
        {
          type: 'text',
          text: `before ${markerText('hijack')} after`,
        },
      ],
    };
    const before = structuredClone(trailing.content);

    await bridge.handleContext({
      sessionID: 'ses_embed',
      agent: 'orchestrator',
      model: {},
      system: [],
      tools: {},
      messages: [trailing],
    });

    expect(trailing.content).toEqual(before);
    expect(synthetic).not.toHaveBeenCalled();
    bridge.dispose();
  });

  test('runtime methods probe the v2 session domain with flat inputs', async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const track =
      (method: string) =>
      async (input: Record<string, unknown>): Promise<unknown> => {
        calls.push({ method, input });
        return {};
      };
    const bridge = createV2InterviewBridge({
      session: {
        prompt: track('prompt'),
        synthetic: track('synthetic'),
        switchAgent: track('switchAgent'),
        rename: track('rename'),
      },
    } as never);

    await bridge.runtime.notify('ses_n', 'ready');
    expect(calls).toContainEqual({
      method: 'synthetic',
      // resume:false = admit the interview URL without waking the session
      // (v1's noReply prompt equivalent; no agent turn, no double-send).
      input: { sessionID: 'ses_n', text: 'ready', resume: false },
    });

    await bridge.runtime.continue('ses_c', 'go on');
    expect(calls).toContainEqual({
      method: 'switchAgent',
      input: { sessionID: 'ses_c', agent: 'orchestrator' },
    });
    expect(calls).toContainEqual({
      method: 'prompt',
      input: { sessionID: 'ses_c', text: 'go on' },
    });

    await bridge.runtime.rename('ses_r', 'Interview: x');
    expect(calls).toContainEqual({
      method: 'rename',
      input: { sessionID: 'ses_r', title: 'Interview: x' },
    });

    bridge.dispose();
  });

  test('notify is a no-op (no prompt fallback) when synthetic is unavailable', async () => {
    const prompt = mock(async () => ({}));
    const bridge = createV2InterviewBridge({
      session: { prompt },
    } as never);
    await bridge.runtime.notify('ses_f', 'hey');
    expect(prompt).not.toHaveBeenCalled();
    bridge.dispose();
  });

  test('rename logs and skips when unavailable', async () => {
    const prompt = mock(async () => ({}));
    const bridge = createV2InterviewBridge({
      session: { prompt },
    } as never);
    await expect(
      bridge.runtime.rename('ses_ru', 'Interview: x'),
    ).resolves.toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
    bridge.dispose();
  });

  test('applyInterviewCommandParts: empty parts strip the marker, keep args', () => {
    const trailing = {
      role: 'user',
      content: [{ type: 'text', text: markerText('standup notes') }],
    };
    applyInterviewCommandParts(
      trailing,
      trailing.content[0].text as string,
      [],
    );
    expect(trailing.content).toEqual([{ type: 'text', text: 'standup notes' }]);
  });

  test('applyInterviewCommandParts: non-empty parts replace the content', () => {
    const trailing = {
      role: 'user',
      content: [{ type: 'text', text: markerText('idea') }],
    };
    applyInterviewCommandParts(trailing, trailing.content[0].text as string, [
      { type: 'text', text: 'EXPANDED', synthetic: true },
    ]);
    expect(trailing.content).toEqual([
      { type: 'text', text: 'EXPANDED', synthetic: true },
    ]);
  });

  test('no transcript projection for sessions without an active interview', async () => {
    const bridge = createV2InterviewBridge(createContext());
    const { proxied, count } = countProjections([
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);

    await bridge.handleContext({
      sessionID: 'ses_plain',
      agent: 'orchestrator',
      model: {},
      system: [],
      tools: {},
      messages: proxied,
    });

    // Eager design: one full projection per context event. Lazy design:
    // none — nothing consumes the transcript without an interview.
    expect(count()).toBe(0);
    expect(await bridge.runtime.messages('ses_plain')).toEqual([]);

    // Streaming text events for a non-interview session stay inert too.
    await bridge.handleEvent({
      type: 'session.next.text.started',
      properties: { sessionID: 'ses_plain' },
    });
    await bridge.handleEvent({
      type: 'session.next.text.delta',
      properties: { sessionID: 'ses_plain', delta: 'ignored' },
    });
    await bridge.handleEvent({
      type: 'session.next.text.ended',
      properties: { sessionID: 'ses_plain', text: 'ignored' },
    });
    expect(count()).toBe(0);
    expect(await bridge.runtime.messages('ses_plain')).toEqual([]);
    bridge.dispose();
  });

  test('marker dispatch projects the transcript exactly once', async () => {
    const directory = `.tmp-v2-once-${Date.now()}`;
    const synthetic = mock(async () => ({}));
    const rename = mock(async () => ({}));
    const bridge = createV2InterviewBridge(
      createContext({ synthetic, rename }),
      { outputFolder: directory } as never,
    );
    try {
      const earlier = {
        id: 'old',
        role: 'user',
        content: [{ type: 'text', text: 'Earlier context' }],
      };
      const event = markerContextEvent('ses_once', 'single projection idea');
      event.messages.unshift(earlier);
      const { proxied, count } = countProjections(event.messages);
      event.messages = proxied;

      await bridge.handleContext(event);

      // One projection only — the dispatch's createInterview
      // loadMessages. The eager design ran the full projection twice.
      expect(count()).toBe(1);

      // Memoized: consumption does not re-derive, and the projected
      // trailing message reflects the marker rewrite.
      const transcript = await bridge.runtime.messages('ses_once');
      expect(count()).toBe(1);
      expect(await bridge.runtime.messages('ses_once')).toBe(transcript);
      expect(transcript).toHaveLength(2);
      expect(transcript[0]).toEqual({
        info: { role: 'user', id: 'old' },
        parts: [{ type: 'text', text: 'Earlier context' }],
      });
      expect(transcript[1]?.parts?.[0]?.text).not.toContain(
        '<omos-interview-command>',
      );
      expect(transcript[1]?.parts?.[0]?.text).toContain(
        'single projection idea',
      );
      expect(transcript[1]?.parts?.[0]?.text).toContain('<interview_state>');
    } finally {
      bridge.dispose();
      await fs.rm(`${process.cwd()}/${directory}`, {
        recursive: true,
        force: true,
      });
    }
  });

  test('marker dispatch that creates no interview retains nothing', async () => {
    const bridge = createV2InterviewBridge(createContext());
    // Bare /interview: the service pushes an ask-for-idea prompt and
    // creates no interview — the transcript has no consumer.
    await bridge.handleContext(markerContextEvent('ses_bare', ''));
    expect(bridge.service.getActiveInterviewId('ses_bare')).toBeNull();
    expect(await bridge.runtime.messages('ses_bare')).toEqual([]);
    bridge.dispose();
  });

  test('streams assistant text for interview sessions and drops deleted sessions', async () => {
    const directory = `.tmp-v2-text-${Date.now()}`;
    const synthetic = mock(async () => ({}));
    const bridge = createV2InterviewBridge(createContext({ synthetic }), {
      outputFolder: directory,
    } as never);
    try {
      // The marker dispatch creates the interview that activates retention.
      await bridge.handleContext(markerContextEvent('ses_text', 'streaming'));
      await bridge.handleEvent({
        type: 'session.next.text.started',
        properties: { sessionID: 'ses_text' },
      });
      await bridge.handleEvent({
        type: 'session.next.text.delta',
        properties: { sessionID: 'ses_text', delta: 'one' },
      });
      await bridge.handleEvent({
        type: 'session.next.text.delta',
        properties: { sessionID: 'ses_text', delta: ' two' },
      });
      await bridge.handleEvent({
        type: 'session.next.text.ended',
        properties: { sessionID: 'ses_text', text: 'one two' },
      });
      expect(
        (await bridge.runtime.messages('ses_text')).at(-1)?.parts?.[0]?.text,
      ).toBe('one two');

      // A follow-up context event refreshes the retained transcript while
      // the interview stays active (earlier turns become raw history).
      await bridge.handleContext({
        sessionID: 'ses_text',
        agent: 'orchestrator',
        model: {},
        system: [],
        tools: {},
        messages: [
          { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] },
          {
            id: 'a1',
            role: 'assistant',
            content: [{ type: 'text', text: 'one two' }],
          },
          {
            id: 'u2',
            role: 'user',
            content: [{ type: 'text', text: 'ANSWER' }],
          },
        ],
      });
      expect(
        (await bridge.runtime.messages('ses_text')).at(-1)?.parts?.[0]?.text,
      ).toBe('ANSWER');

      await bridge.handleEvent({
        type: 'session.deleted',
        properties: { sessionID: 'ses_text' },
      });
      expect(await bridge.runtime.messages('ses_text')).toEqual([]);
    } finally {
      bridge.dispose();
      await fs.rm(`${process.cwd()}/${directory}`, {
        recursive: true,
        force: true,
      });
    }
  });

  test('retained per-session transcripts are bounded (FIFO eviction)', async () => {
    const directory = `.tmp-v2-bound-${Date.now()}`;
    const synthetic = mock(async () => ({}));
    const bridge = createV2InterviewBridge(
      createContext({ synthetic }),
      { outputFolder: directory } as never,
      { maxRetainedSessions: 3 },
    );
    try {
      for (let i = 0; i < 5; i++) {
        await bridge.handleContext(
          markerContextEvent(`ses_b${i}`, `bounded idea ${i}`),
        );
      }

      // Oldest two sessions were evicted from bridge-side retention...
      expect(await bridge.runtime.messages('ses_b0')).toEqual([]);
      expect(await bridge.runtime.messages('ses_b1')).toEqual([]);
      // ...the interviews themselves are service state and remain.
      expect(bridge.service.getActiveInterviewId('ses_b0')).not.toBeNull();
      // Newest retained sessions still project.
      expect(await bridge.runtime.messages('ses_b2')).toHaveLength(1);
      expect(await bridge.runtime.messages('ses_b4')).toHaveLength(1);
    } finally {
      bridge.dispose();
      await fs.rm(`${process.cwd()}/${directory}`, {
        recursive: true,
        force: true,
      });
    }
  });

  test('shares one configured dashboard across multiple v2 sessions', async () => {
    const directory = `.tmp-v2-dashboard-${Date.now()}`;
    const { port, server } = await bindFreePort();
    const config = {
      outputFolder: directory,
      dashboard: true,
      port,
    } as never;
    const synthetic1 = mock(async () => ({}));
    const synthetic2 = mock(async () => ({}));
    const bridge1 = createV2InterviewBridge(
      createContext({ synthetic: synthetic1 }),
      config,
      { server },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const bridge2 = createV2InterviewBridge(
      createContext({ synthetic: synthetic2 }),
      config,
    );

    try {
      const createEvent = (sessionID: string, idea: string) => ({
        sessionID,
        agent: 'orchestrator',
        model: {},
        system: [],
        tools: {},
        messages: [
          {
            id: `${sessionID}-command`,
            role: 'user',
            content: [
              {
                type: 'text',
                text: markerText(idea),
              },
            ],
          },
        ],
      });

      const event1 = createEvent('v2-session-1', 'first dashboard idea');
      const event2 = createEvent('v2-session-2', 'second dashboard idea');
      await bridge1.handleContext(event1);
      await bridge2.handleContext(event2);

      expect(synthetic1.mock.calls[0]?.[0].text).toContain(
        `http://127.0.0.1:${port}/interview/`,
      );
      expect(synthetic2.mock.calls[0]?.[0].text).toContain(
        `http://127.0.0.1:${port}/interview/`,
      );
    } finally {
      await bridge1.dispose();
      await bridge2.dispose();
      // Safety net: close the held server if the dashboard never adopted it.
      if (server.listening) {
        server.closeAllConnections();
        server.close();
      }
      await fs.rm(`${process.cwd()}/${directory}`, {
        recursive: true,
        force: true,
      });
    }
  });
});
