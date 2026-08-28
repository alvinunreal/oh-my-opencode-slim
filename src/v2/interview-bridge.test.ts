import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import {
  applyInterviewCommandParts,
  createV2InterviewBridge,
  markerText,
} from './interview-bridge';

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

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to get free port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
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
      input: { sessionID: 'ses_n', text: 'ready' },
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

  test('projects text events and removes a deleted session', async () => {
    const bridge = createV2InterviewBridge(createContext());
    await bridge.handleContext({
      sessionID: 'ses_text',
      agent: 'orchestrator',
      model: {},
      system: [],
      tools: {},
      messages: [
        {
          id: 'u',
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    });
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
    expect(bridge.getTranscript('ses_text').at(-1)?.parts?.[0]?.text).toBe(
      'one two',
    );

    await bridge.handleEvent({
      type: 'session.deleted',
      properties: { sessionID: 'ses_text' },
    });
    expect(bridge.getTranscript('ses_text')).toEqual([]);
    bridge.dispose();
  });

  test('shares one configured dashboard across multiple v2 sessions', async () => {
    const directory = `.tmp-v2-dashboard-${Date.now()}`;
    const port = await findFreePort();
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
      await fs.rm(`${process.cwd()}/${directory}`, {
        recursive: true,
        force: true,
      });
    }
  });
});
