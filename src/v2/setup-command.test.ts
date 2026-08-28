import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { createV2InterviewBridge, markerText } from './interview-bridge';
import { createSessionSubmit } from './session-submit';
import {
  applyCommandMarkerToContext,
  createCommandRegistration,
  createSessionContextHandler,
  parseCommandMarker,
  registerSynthCommands,
  stripCommandMarker,
  type V1CommandBeforeHook,
  wrapCommandMarker,
} from './setup';
import type {
  V2CommandDefinition,
  V2CommandDraft,
  V2SessionContextEvent,
} from './types';

function makeEvent(
  messages: Array<{ id?: string; role: string; content: unknown[] }>,
  overrides?: Partial<V2SessionContextEvent>,
): V2SessionContextEvent {
  return {
    sessionID: 'ses_cmd',
    agent: 'orchestrator',
    model: {},
    system: [],
    tools: {},
    messages: messages as V2SessionContextEvent['messages'],
    ...overrides,
  };
}

describe('command marker wrap/parse', () => {
  test('round-trips empty, simple, and multiline args', () => {
    for (const args of ['', 'focus 25m', 'line one\nline two\nline three']) {
      expect(parseCommandMarker(wrapCommandMarker('deepwork', args))).toEqual({
        name: 'deepwork',
        args,
      });
    }
  });

  test('round-trips widened name charsets (\\w . -)', () => {
    for (const name of ['git_commit', 'Task.v2', 'deepwork', 'a-b-c']) {
      expect(parseCommandMarker(wrapCommandMarker(name, 'args'))).toEqual({
        name,
        args: 'args',
      });
    }
  });

  test('renders the exact marker shape', () => {
    expect(wrapCommandMarker('deepwork', 'focus')).toBe(
      '<omos-cmd-command data-name="deepwork">focus</omos-cmd-command>',
    );
    expect(wrapCommandMarker('loop', '')).toBe(
      '<omos-cmd-command data-name="loop"></omos-cmd-command>',
    );
  });

  test('whole-text anchored: embedded markers never match', () => {
    expect(
      parseCommandMarker(
        'before <omos-cmd-command data-name="reflect">a b</omos-cmd-command> after',
      ),
    ).toBeUndefined();
  });

  test('whole-text anchored: surrounding whitespace is tolerated', () => {
    expect(
      parseCommandMarker(`  \n${wrapCommandMarker('reflect', 'a b')}\n  `),
    ).toEqual({ name: 'reflect', args: 'a b' });
  });

  test('returns undefined without a marker', () => {
    expect(parseCommandMarker('plain user text')).toBeUndefined();
    expect(parseCommandMarker(markerText('x'))).toBeUndefined();
  });

  test('stripCommandMarker leaves the raw args on marker-only text', () => {
    expect(stripCommandMarker(wrapCommandMarker('deepwork', 'focus 25m'))).toBe(
      'focus 25m',
    );
    // Only runs on marker-only text (anchored pattern): other text is a no-op.
    expect(
      stripCommandMarker(`pre ${wrapCommandMarker('deepwork', 'x')} post`),
    ).toBe(`pre ${wrapCommandMarker('deepwork', 'x')} post`);
  });
});

describe('createCommandRegistration', () => {
  test('add-only draft registers via add and execute submits the marker', async () => {
    const added: V2CommandDefinition[] = [];
    const submit = mock(async () => {});
    createCommandRegistration(
      { add: (def) => added.push(def) },
      'deepwork',
      { description: 'Start a deep work block' },
      submit,
    );

    expect(added).toHaveLength(1);
    expect(added[0]?.name).toBe('deepwork');
    expect(added[0]?.description).toBe('Start a deep work block');
    expect(added[0]?.execute).toBeTypeOf('function');

    await added[0]?.execute({
      sessionID: 'ses_1',
      prompt: { text: 'focus on tests' },
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      'ses_1',
      wrapCommandMarker('deepwork', 'focus on tests'),
    );
  });

  test('execute swallows submit errors and empty prompts', async () => {
    const added: V2CommandDefinition[] = [];
    const submit = mock(async () => {
      throw new Error('transport down');
    });
    createCommandRegistration(
      { add: (def) => added.push(def) },
      'loop',
      {},
      submit,
    );

    await expect(
      added[0]?.execute({ sessionID: 'ses_2', prompt: { text: '' } }),
    ).resolves.toBeUndefined();
    expect(submit).toHaveBeenCalledWith('ses_2', wrapCommandMarker('loop', ''));
  });

  test('a throwing draft.add propagates to the caller (no internal catch)', () => {
    const draft: V2CommandDraft = {
      add: () => {
        throw new Error('draft rejected');
      },
    };
    expect(() =>
      createCommandRegistration(draft, 'loop', {}, async () => {}),
    ).toThrow('draft rejected');
  });

  test('draft without add is a logged no-op', () => {
    expect(() =>
      createCommandRegistration(
        {} as V2CommandDraft,
        'loop',
        {},
        async () => {},
      ),
    ).not.toThrow();
  });
});

describe('registerSynthCommands (generic loop skips bridge-owned interview)', () => {
  test('interview is NOT add()ed from the generic path; the bridge registers it', () => {
    const added: V2CommandDefinition[] = [];
    const draft: V2CommandDraft = { add: (def) => added.push(def) };

    registerSynthCommands(
      draft,
      [
        ['interview', { description: 'Open a localhost interview UI' }],
        ['deepwork', { description: 'Start a deep work block' }],
      ],
      async () => {},
    );
    expect(added.map((def) => def.name)).toEqual(['deepwork']);

    const bridge = createV2InterviewBridge({ session: {} } as never, undefined);
    bridge.registerCommand(draft);
    expect(added.map((def) => def.name)).toEqual(['deepwork', 'interview']);
    bridge.dispose();
  });

  test('a failing command is skipped without blocking the rest', () => {
    const added: V2CommandDefinition[] = [];
    const draft: V2CommandDraft = {
      add: (def) => {
        if (def.name === 'deepwork') throw new Error('draft rejected');
        added.push(def);
      },
    };

    registerSynthCommands(
      draft,
      [
        ['deepwork', {}],
        ['loop', {}],
      ],
      async () => {},
    );
    expect(added.map((def) => def.name)).toEqual(['loop']);
  });
});

describe('createSessionSubmit', () => {
  test('submits via ctx.session.prompt only', async () => {
    const prompt = mock(async () => ({}));
    await createSessionSubmit({
      session: { prompt },
    } as never)('ses_a', 'hello');
    expect(prompt).toHaveBeenCalledWith({ sessionID: 'ses_a', text: 'hello' });
  });

  test('logs and gives up when prompt is unavailable', async () => {
    await expect(
      createSessionSubmit({ session: {} } as never)('ses_c', 'hello'),
    ).resolves.toBeUndefined();
  });

  test('undefined session domain resolves without throwing', async () => {
    // Reduced hosts may omit ctx.session entirely; the probe inside must
    // take the unavailable path, not die on `session.prompt` of undefined.
    await expect(
      createSessionSubmit({} as never)('ses_e', 'hello'),
    ).resolves.toBeUndefined();
  });

  test('never throws on transport errors', async () => {
    const prompt = mock(async () => {
      throw new Error('boom');
    });
    await expect(
      createSessionSubmit({ session: { prompt } } as never)('ses_d', 'x'),
    ).resolves.toBeUndefined();
  });
});

describe('interview registerCommand (add-only draft)', () => {
  test('registers via add and execute submits the interview marker', async () => {
    const prompt = mock(async () => ({}));
    const bridge = createV2InterviewBridge(
      { session: { prompt } } as never,
      undefined,
    );
    const added: V2CommandDefinition[] = [];
    bridge.registerCommand({ add: (def) => added.push(def) });

    expect(added).toHaveLength(1);
    expect(added[0]?.name).toBe('interview');
    expect(added[0]?.description).toBe(
      'Open a localhost interview UI for a feature idea',
    );

    await added[0]?.execute({
      sessionID: 'ses_iv',
      prompt: { text: 'build a notes app' },
    });
    expect(prompt).toHaveBeenCalledWith({
      sessionID: 'ses_iv',
      text: markerText('build a notes app'),
    });
    bridge.dispose();
  });
});

describe('applyCommandMarkerToContext', () => {
  test('replaces the trailing marker with hook parts; other messages untouched', async () => {
    const earlier = {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'earlier context' }],
    };
    const trailing = {
      id: 'm2',
      role: 'user',
      content: [
        { type: 'text', text: wrapCommandMarker('deepwork', 'focus 25m') },
      ],
    };
    const event = makeEvent([earlier, trailing]);
    const earlierBefore = structuredClone(earlier);

    const calls: Array<{
      command: string;
      sessionID: string;
      arguments: string;
    }> = [];
    const commandBefore: V1CommandBeforeHook = async (input, output) => {
      calls.push(input);
      output.parts.push({
        type: 'text',
        text: 'DEEPWORK EXPANDED',
        synthetic: true,
      });
    };

    await applyCommandMarkerToContext(event, commandBefore);

    expect(earlier).toEqual(earlierBefore);
    expect(calls).toEqual([
      { command: 'deepwork', sessionID: 'ses_cmd', arguments: 'focus 25m' },
    ]);
    expect(trailing.content).toEqual([
      { type: 'text', text: 'DEEPWORK EXPANDED', synthetic: true },
    ]);
  });

  test('empty hook parts strip the marker and leave the raw args', async () => {
    const trailing = {
      id: 'm1',
      role: 'user',
      content: [
        { type: 'text', text: wrapCommandMarker('reflect', 'standup notes') },
      ],
    };
    const event = makeEvent([trailing]);
    const calls: unknown[] = [];
    const commandBefore: V1CommandBeforeHook = async (input) => {
      calls.push(input);
    };

    await applyCommandMarkerToContext(event, commandBefore);

    expect(calls).toHaveLength(1);
    expect(trailing.content).toEqual([{ type: 'text', text: 'standup notes' }]);
  });

  test('no-ops for assistant trailing messages and marker-less text', async () => {
    const calls: unknown[] = [];
    const commandBefore: V1CommandBeforeHook = async (input) => {
      calls.push(input);
    };

    const assistant = makeEvent([
      { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);
    await applyCommandMarkerToContext(assistant, commandBefore);

    const plain = makeEvent([
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'plain' }] },
    ]);
    await applyCommandMarkerToContext(plain, commandBefore);

    expect(calls).toEqual([]);
  });
});

describe('createSessionContextHandler (merged context hook seam)', () => {
  function recordCommandCalls(): {
    calls: Array<{
      command: string;
      sessionID: string;
      arguments: string;
    }>;
    hook: V1CommandBeforeHook;
  } {
    const calls: Array<{
      command: string;
      sessionID: string;
      arguments: string;
    }> = [];
    return {
      calls,
      hook: async (input) => {
        calls.push(input);
      },
    };
  }

  test('(a) interview-marker-only tail: interview handler fires, generic dispatch no-op', async () => {
    const directory = `.tmp-v2-seam-a-${Date.now()}`;
    const synthetic = mock(async () => ({}));
    const rename = mock(async () => ({}));
    const bridge = createV2InterviewBridge(
      { session: { synthetic, rename } } as never,
      { outputFolder: directory } as never,
    );
    const { calls, hook } = recordCommandCalls();
    const handler = createSessionContextHandler({
      interviewHandleContext: (event) => bridge.handleContext(event),
      commandBefore: hook,
    });

    const earlier = {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'earlier context' }],
    };
    const trailing = {
      id: 'm2',
      role: 'user',
      content: [{ type: 'text', text: markerText('build a notes app') }],
    };
    const event = makeEvent([earlier, trailing]);
    const earlierBefore = structuredClone(earlier);

    await handler(event);

    expect(calls).toEqual([]); // generic dispatch no-op
    expect(earlier).toEqual(earlierBefore);
    // The interview bridge consumed the marker (tail rewritten).
    expect(JSON.stringify(trailing.content)).toContain('<interview_state>');

    bridge.dispose();
    await fs.rm(`${process.cwd()}/${directory}`, {
      recursive: true,
      force: true,
    });
  });

  test('(b) generic-marker-only tail: generic dispatch fires, interview no-op', async () => {
    const directory = `.tmp-v2-seam-b-${Date.now()}`;
    const synthetic = mock(async () => ({}));
    const bridge = createV2InterviewBridge(
      { session: { synthetic } } as never,
      { outputFolder: directory } as never,
    );
    const calls: Array<{
      command: string;
      sessionID: string;
      arguments: string;
    }> = [];
    const handler = createSessionContextHandler({
      interviewHandleContext: (event) => bridge.handleContext(event),
      commandBefore: async (input, output) => {
        calls.push(input);
        output.parts.push({ type: 'text', text: 'GENERIC EXPANDED' });
      },
    });

    const trailing = {
      id: 'm1',
      role: 'user',
      content: [
        { type: 'text', text: wrapCommandMarker('deepwork', 'focus 25m') },
      ],
    };
    const event = makeEvent([trailing]);

    await handler(event);

    expect(calls).toEqual([
      { command: 'deepwork', sessionID: 'ses_cmd', arguments: 'focus 25m' },
    ]);
    expect(trailing.content).toEqual([
      { type: 'text', text: 'GENERIC EXPANDED' },
    ]);
    // Interview bridge no-op on generic markers: no synthetic notification.
    expect(synthetic).not.toHaveBeenCalled();

    bridge.dispose();
    await fs.rm(`${process.cwd()}/${directory}`, {
      recursive: true,
      force: true,
    });
  });

  test('(c) system/messages transforms + chat.message run on the same event', async () => {
    const chatCalls: Array<{ sessionID: string; agent?: string }> = [];
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      chatMessage: async (input) => {
        chatCalls.push(input);
      },
      systemTransform: async (_input, output) => {
        output.system.push('INJECTED');
      },
      messagesTransform: async (_input, output) => {
        output.messages[0]?.parts.push({ type: 'text', text: 'APPENDED' });
      },
    });

    const message = {
      id: 'u',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    };
    const event = makeEvent([message], {
      system: [{ type: 'text', text: 'base' }],
    });

    await handler(event);

    expect(chatCalls).toEqual([
      { sessionID: 'ses_cmd', agent: 'orchestrator' },
    ]);
    expect(event.system).toEqual([
      { type: 'text', text: 'base' },
      { type: 'text', text: 'INJECTED' },
    ]);
    expect(message.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: 'APPENDED' },
    ]);
  });

  test('(d) embedded markers inside other text never fire either dispatcher', async () => {
    const directory = `.tmp-v2-seam-d-${Date.now()}`;
    const synthetic = mock(async () => ({}));
    const bridge = createV2InterviewBridge(
      { session: { synthetic } } as never,
      { outputFolder: directory } as never,
    );
    const { calls, hook } = recordCommandCalls();
    const handler = createSessionContextHandler({
      interviewHandleContext: (event) => bridge.handleContext(event),
      commandBefore: hook,
    });

    const trailing = {
      id: 'm1',
      role: 'user',
      content: [
        {
          type: 'text',
          text: `look at ${wrapCommandMarker('deepwork', 'x')} and ${markerText('idea')} please`,
        },
      ],
    };
    const event = makeEvent([trailing]);
    const contentBefore = structuredClone(trailing.content);

    await handler(event);

    expect(calls).toEqual([]);
    expect(synthetic).not.toHaveBeenCalled();
    expect(trailing.content).toEqual(contentBefore);

    bridge.dispose();
    await fs.rm(`${process.cwd()}/${directory}`, {
      recursive: true,
      force: true,
    });
  });
});
