import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { appendTaggedSyntheticPart } from '../hooks/cache-safe-injection';
import { createJsonErrorRecoveryHook } from '../hooks/json-error-recovery/hook';
import {
  createPhaseReminderHook,
  PHASE_REMINDER_METADATA_KEY,
} from '../hooks/phase-reminder';
import {
  createToolLoopGuardHook,
  LOOP_GUARD_WARNING,
} from '../hooks/tool-loop-guard/hook';
import { createV2InterviewBridge, markerText } from './interview-bridge';
import { createSessionSubmit } from './session-submit';
import {
  applyCommandMarkerToContext,
  createCommandRegistration,
  createSessionContextHandler,
  createSessionPromptBridge,
  createToolExecuteBridges,
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
  V2SessionPromptEvent,
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
      { sessionID: 'ses_cmd', agent: 'orchestrator', messageID: 'u' },
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

describe('context bridge: transcript user-message identity enrichment', () => {
  // Live v2 hosts carry only
  // {id, time, text, type} on transcript user messages; the v1 injection
  // gates (phase-reminder, board, nudge) key on info.sessionID/agent.
  test('user messages gain sessionID/agent when absent; content bytes untouched', async () => {
    const user = {
      id: 'u1',
      role: 'user',
      time: 123,
      content: [{ type: 'text', text: 'hello' }],
    };
    const contentBefore = structuredClone(user.content);
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async () => {},
    });

    await handler(makeEvent([user]));

    expect(user.sessionID).toBe('ses_cmd');
    expect(user.agent).toBe('orchestrator');
    expect(user.content).toEqual(contentBefore);

    // Idempotent + never overwrites: a later context event for a
    // different session/agent must not restamp the enriched message.
    await handler(
      makeEvent([user], { sessionID: 'ses_other', agent: 'fixer' }),
    );
    expect(user.sessionID).toBe('ses_cmd');
    expect(user.agent).toBe('orchestrator');
  });

  test('host-provided sessionID/agent values are preserved', async () => {
    const user = {
      id: 'u1',
      role: 'user',
      sessionID: 'host-ses',
      agent: 'planner',
      content: [{ type: 'text', text: 'hi' }],
    };
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async () => {},
    });

    await handler(makeEvent([user]));

    expect(user.sessionID).toBe('host-ses');
    expect(user.agent).toBe('planner');
  });

  test('assistant messages are left untouched', async () => {
    const assistant = {
      id: 'a1',
      role: 'assistant',
      time: 456,
      content: [{ type: 'text', text: 'response' }],
    };
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async () => {},
    });

    await handler(makeEvent([assistant]));

    expect(assistant.sessionID).toBeUndefined();
    expect(assistant.agent).toBeUndefined();
  });

  test('agent falls back to the prompt-bridge learned state when the event carries none', async () => {
    const user = {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    };
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async () => {},
      knownAgentForSession: (sessionID) =>
        sessionID === 'ses_cmd' ? 'oracle' : undefined,
    });

    await handler(makeEvent([user], { agent: '' }));

    expect(user.sessionID).toBe('ses_cmd');
    expect(user.agent).toBe('oracle');
  });

  test('no enrichment without a messagesTransform dep (mutation stays scoped)', async () => {
    const user = {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    };
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
    });

    await handler(makeEvent([user]));

    expect(user.sessionID).toBeUndefined();
    expect(user.agent).toBeUndefined();
  });

  test('end-to-end: a recognized agent now performs the phase-reminder injection it previously skipped', async () => {
    const phaseReminder = createPhaseReminderHook({
      shouldInject: () => true,
    });

    // The pre-fix behavior: the raw v2 transcript message (no
    // sessionID/agent) fails the gate inside the real v1 hook.
    const unenriched = {
      info: { role: 'user' },
      parts: [{ type: 'text', text: 'do the work' }],
    };
    await phaseReminder['experimental.chat.messages.transform'](
      {},
      { messages: [unenriched] },
    );
    expect(unenriched.parts).toHaveLength(1);

    // Through the v2 context bridge: identity enrichment makes the same
    // gate pass and the reminder lands as a tagged synthetic part.
    const message = {
      id: 'u1',
      role: 'user',
      time: 123,
      content: [{ type: 'text', text: 'do the work' }],
    };
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: phaseReminder['experimental.chat.messages.transform'],
    });

    await handler(makeEvent([message]));

    expect(message.content).toHaveLength(2);
    const injected = message.content[1] as Record<string, unknown>;
    expect(injected.synthetic).toBe(true);
    expect(
      (injected.metadata as Record<string, unknown>)[
        PHASE_REMINDER_METADATA_KEY
      ],
    ).toBe(true);
  });
});

describe('tool execute bridge normalization', () => {
  test('before bridge maps subagent call into v1 task shape and writes back', async () => {
    const seen: Array<{ tool: string; args: unknown }> = [];
    const before = async (
      i: { tool: string; sessionID: string; callID: string },
      o: { args: unknown },
    ) => {
      seen.push({ tool: i.tool, args: { ...(o.args as object) } });
      (o.args as Record<string, unknown>).task_id = 'ses_rewritten';
    };
    const event = {
      tool: 'subagent',
      sessionID: 'ses_parent',
      agent: 'orchestrator',
      messageID: 'msg_1',
      id: 'call_1',
      input: {
        agent: 'fixer',
        description: 'd',
        prompt: 'p',
        sessionID: 'ses_old',
      },
    };
    const { beforeBridge } = createToolExecuteBridges(before, undefined);
    await beforeBridge(event);
    expect(seen[0]).toMatchObject({ tool: 'task' });
    expect(seen[0]?.args).toMatchObject({
      subagent_type: 'fixer',
      task_id: 'ses_old',
    });
    expect(event.input).toEqual({
      agent: 'fixer',
      description: 'd',
      prompt: 'p',
      sessionID: 'ses_rewritten',
    });
  });

  test('before bridge rethrows hook rejection so v2 refuses the call', async () => {
    const before = async () => {
      throw new Error('duplicate spawn refused');
    };
    const { beforeBridge } = createToolExecuteBridges(before, undefined);
    await expect(
      beforeBridge({
        tool: 'subagent',
        sessionID: 's',
        agent: 'a',
        messageID: 'm',
        id: 'c',
        input: {},
      }),
    ).rejects.toThrow('duplicate spawn refused');
  });

  test('after bridge presents subagent output under task name', async () => {
    const seen: Array<{ tool: string; output: unknown }> = [];
    const after = async (_i: unknown, o: { output: unknown }) => {
      seen.push({ tool: 'task', output: o.output });
    };
    const { afterBridge } = createToolExecuteBridges(undefined, after);
    await afterBridge({
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'completed',
      result: {
        content:
          'The subagent is working in the background (sessionID: ses_x).',
      },
    });
    expect(seen[0]?.output).toContain('(sessionID: ses_x)');
  });

  test('after bridge leaves unchanged mixed content untouched', async () => {
    const content = [
      { type: 'text', text: 'before' },
      { type: 'image', source: { type: 'url', url: 'image://one' } },
      { type: 'text', text: 'after' },
    ];
    const event = {
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'completed' as const,
      result: { content },
    };
    const { afterBridge } = createToolExecuteBridges(undefined, async () => {});

    await afterBridge(event);

    expect(event.result.content).toBe(content);
    expect(event.result.content).toEqual(content);
  });

  test('after bridge retains output-only result fallback', async () => {
    const event = {
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'completed' as const,
      result: { output: 'fallback output' },
    };
    const { afterBridge } = createToolExecuteBridges(undefined, async () => {});

    await afterBridge(event);

    expect(event.result).toEqual({ output: 'fallback output' });
  });

  test('after bridge renders changing structured outputs distinctly', async () => {
    const seen: unknown[] = [];
    const { afterBridge } = createToolExecuteBridges(
      undefined,
      async (_input, output: { output: unknown }) => {
        seen.push(output.output);
      },
    );
    const makeEvent = (value: number) => ({
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: `c-${value}`,
      input: {},
      status: 'completed' as const,
      result: { content: [], output: { value } },
    });

    await afterBridge(makeEvent(1));
    await afterBridge(makeEvent(2));

    expect(seen).toEqual(['{"value":1}', '{"value":2}']);
  });

  test('after bridge keeps structured output when appending warning text', async () => {
    const event = {
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'completed' as const,
      result: { content: [], output: { value: 1 } },
    };
    const { afterBridge } = createToolExecuteBridges(
      undefined,
      async (_input, output: { output: unknown }) => {
        output.output = `${output.output}\nwarning`;
      },
    );

    await afterBridge(event);

    expect(event.result.output).toEqual({ value: 1 });
    expect(event.result.content).toBe('{"value":1}\nwarning');
  });

  test('after bridge preserves string content when the v1 output changes', async () => {
    const event = {
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'completed' as const,
      result: { content: 'original' },
    };
    const { afterBridge } = createToolExecuteBridges(
      undefined,
      async (_input, output: { output: unknown }) => {
        output.output = 'rewritten';
      },
    );

    await afterBridge(event);

    expect(event.result.content).toBe('rewritten');
  });

  test('after bridge appends warnings without disturbing mixed content order', async () => {
    const event = {
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'completed' as const,
      result: {
        content: [
          { type: 'text', text: 'before' },
          { type: 'image', source: { type: 'url', url: 'image://one' } },
          { type: 'text', text: 'after' },
        ],
      },
    };
    const { afterBridge } = createToolExecuteBridges(
      undefined,
      async (
        _input,
        output: { output: unknown; metadata: Record<string, unknown> },
      ) => {
        output.output = 'beforeafter\nwarning';
      },
    );

    await afterBridge(event);

    expect(event.result.content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', source: { type: 'url', url: 'image://one' } },
      { type: 'text', text: 'after\nwarning' },
    ]);
  });

  test('context continuations do not reset alternating poll detection', async () => {
    const loopGuard = createToolLoopGuardHook();
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      chatMessage: async (input) => {
        if (input.messageID) {
          loopGuard.observeNewUserMessage(input.sessionID, input.messageID);
        }
      },
    });
    const context = makeEvent(
      [
        {
          id: 'user-1',
          role: 'user',
          content: [{ type: 'text', text: 'poll' }],
        },
      ],
      { sessionID: 'ses_parent' },
    );
    const poll = async (
      tool: string,
      callID: string,
      output: string,
    ): Promise<unknown> => {
      await loopGuard['tool.execute.before'](
        { tool, sessionID: 'ses_parent', callID },
        { args: { task_id: 'ses_child' } },
      );
      const result = { output };
      await loopGuard['tool.execute.after'](
        { tool, sessionID: 'ses_parent', callID },
        result,
      );
      return result.output;
    };

    await handler(context);
    await poll('task_status', 'poll-1', 'task_id: ses_child\nstate: busy');
    await handler(context);
    await poll('task_result', 'poll-2', 'task_id: ses_child\nstate: running');
    await handler(context);
    const third = await poll(
      'task_status',
      'poll-3',
      'task_id: ses_child\nstate: busy',
    );

    expect(third).toContain(LOOP_GUARD_WARNING);

    await handler(
      makeEvent(
        [
          {
            id: 'user-2',
            role: 'user',
            content: [{ type: 'text', text: 'next' }],
          },
        ],
        { sessionID: 'ses_parent' },
      ),
    );
    const nextTurn = await poll(
      'task_result',
      'poll-4',
      'task_id: ses_child\nstate: running',
    );
    expect(nextTurn).not.toContain(LOOP_GUARD_WARNING);
  });

  test('per-request chat.message emulation keys on the trailing user message', async () => {
    const chatCalls: Array<Record<string, unknown>> = [];
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      chatMessage: async (input) => {
        chatCalls.push(input as Record<string, unknown>);
      },
    });
    const base = { sessionID: 'ses_cmd', agent: 'orchestrator' };

    // user-last: the trailing user message id is forwarded.
    await handler(
      makeEvent([
        { id: 'a1', role: 'assistant', content: [] },
        { id: 'u1', role: 'user', content: [] },
      ]),
    );
    expect(chatCalls.at(-1)).toEqual({ ...base, messageID: 'u1' });

    // user-not-last: the LAST user message wins, not the first —
    // and a trailing NON-user message must be skipped by the
    // backward scan (a `messages.at(-1)`-only regression would fail).
    await handler(
      makeEvent([
        { id: 'u2', role: 'user', content: [] },
        { id: 'a2', role: 'assistant', content: [] },
        { id: 'u3', role: 'user', content: [] },
        { id: 'a3', role: 'assistant', content: [] },
      ]),
    );
    expect(chatCalls.at(-1)).toEqual({ ...base, messageID: 'u3' });

    // no-user: no messageID.
    await handler(makeEvent([{ id: 'a3', role: 'assistant', content: [] }]));
    expect(chatCalls.at(-1)).toEqual(base);

    // empty message list: no messageID.
    await handler(makeEvent([]));
    expect(chatCalls.at(-1)).toEqual(base);

    // trailing user message with an empty-string id: no messageID.
    await handler(makeEvent([{ id: '', role: 'user', content: [] }]));
    expect(chatCalls.at(-1)).toEqual(base);
  });
});

describe('tool execute bridge status discrimination', () => {
  test('error status synthesizes the v1 output from the error text', async () => {
    const seen: Array<{ tool: string; output: unknown }> = [];
    const after = async (_i: unknown, o: { output: unknown }) => {
      seen.push({ tool: 'task', output: o.output });
    };
    const { afterBridge } = createToolExecuteBridges(undefined, after);
    const event = {
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'error' as const,
      error: 'invalid JSON in tool arguments',
      // Stale result content that must NOT be presented as success.
      result: { content: 'previous successful output' },
    };
    await afterBridge(event);
    expect(seen[0]?.output).toBe('invalid JSON in tool arguments');
    // Hook saw the error text; the stale content was never surfaced.
  });

  test('error status with an Error-like payload uses message', async () => {
    const seen: unknown[] = [];
    const { afterBridge } = createToolExecuteBridges(
      undefined,
      async (_i, o: { output: unknown }) => {
        seen.push(o.output);
      },
    );
    await afterBridge({
      tool: 'read',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'error',
      error: { message: 'file not found' },
      result: undefined,
    });
    expect(seen).toEqual(['file not found']);
  });

  test('errored output still feeds json-error-recovery (reminder appended)', async () => {
    const recovery = createJsonErrorRecoveryHook({} as never);
    const event = {
      tool: 'task',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'error' as const,
      error: 'SyntaxError: Unexpected token in JSON',
      result: {},
    };
    const { afterBridge } = createToolExecuteBridges(
      undefined,
      recovery['tool.execute.after'],
    );
    await afterBridge(event);
    // The reminder the recovery hook appended to output.output must land
    // in the model-visible content field of the errored result.
    expect(event.result.content).toContain('invalid JSON arguments');
    expect(event.result.content).toContain('SyntaxError');
  });

  test('error status with no error field never presents result content as success', async () => {
    const seen: unknown[] = [];
    const { afterBridge } = createToolExecuteBridges(
      undefined,
      async (_i, o: { output: unknown }) => {
        seen.push(o.output);
      },
    );
    const event = {
      tool: 'bash',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'error' as const,
      result: { content: [], output: { stale: true } },
    };
    await afterBridge(event);
    // Neither the empty content nor the structured stale output is
    // rendered as a successful output.
    expect(seen).toEqual(['']);
  });

  test('absent status (older hosts) keeps the completed path', async () => {
    const seen: unknown[] = [];
    const event = {
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      result: { content: 'plain output' },
    } as Record<string, unknown> & { result?: unknown };
    const { afterBridge } = createToolExecuteBridges(
      undefined,
      async (_i, o: { output: unknown }) => {
        seen.push(o.output);
      },
    );
    await afterBridge(event);
    expect(seen).toEqual(['plain output']);
  });
});

describe('createSessionPromptBridge (native session.prompt hook)', () => {
  function makePromptEvent(
    overrides: Partial<V2SessionPromptEvent> = {},
  ): V2SessionPromptEvent {
    return {
      sessionID: 'ses_p',
      messageID: 'msg_1',
      prompt: { text: 'do the thing' },
      delivery: 'steer',
      ...overrides,
    };
  }

  test('handlePrompt delivers chat.message once per admission with parts', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const bridge = createSessionPromptBridge(async (input) => {
      calls.push(input as Record<string, unknown>);
    });
    // Pre-learn the agent so the admission delivers immediately (the
    // first-admission deferral is covered by its own tests below).
    await bridge.observeContext(
      makeEvent(
        [{ id: 'msg_0', role: 'user', content: [{ type: 'text', text: 'x' }] }],
        { sessionID: 'ses_p', agent: 'orchestrator' },
      ),
    );
    calls.length = 0;
    await bridge.handlePrompt(makePromptEvent());
    expect(calls).toEqual([
      {
        sessionID: 'ses_p',
        messageID: 'msg_1',
        agent: 'orchestrator',
        parts: [{ type: 'text', text: 'do the thing' }],
      },
    ]);

    // Re-fired admission with the same messageID: still once.
    await bridge.handlePrompt(makePromptEvent());
    expect(calls).toHaveLength(1);

    // A new admission: fires again.
    await bridge.handlePrompt(makePromptEvent({ messageID: 'msg_2' }));
    expect(calls).toHaveLength(2);
  });

  test('handlePrompt maps prompt files into v1 file parts', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const bridge = createSessionPromptBridge(async (input) => {
      calls.push(input as Record<string, unknown>);
    });
    await bridge.observeContext(
      makeEvent(
        [{ id: 'msg_0', role: 'user', content: [{ type: 'text', text: 'x' }] }],
        { sessionID: 'ses_p', agent: 'orchestrator' },
      ),
    );
    calls.length = 0;
    await bridge.handlePrompt(
      makePromptEvent({
        messageID: 'msg_f',
        prompt: {
          text: '',
          files: [{ uri: 'file:///a.txt', name: 'a.txt' }],
        },
      }),
    );
    // observeChatMessage (task-session-manager + wake scheduler) gates on
    // a non-synthetic text/file part — the file part keeps that gate
    // passable for attachment-only prompts.
    expect(calls[0]?.parts).toEqual([
      { type: 'file', uri: 'file:///a.txt', name: 'a.txt' },
    ]);
  });

  test('observeContext forwards newly learned agent/model, then goes quiet', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const bridge = createSessionPromptBridge(async (input) => {
      calls.push(input as Record<string, unknown>);
    });
    const contextEvent = makeEvent(
      [
        {
          id: 'msg_1',
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
        },
      ],
      {
        sessionID: 'ses_p',
        agent: 'orchestrator',
        model: { id: 'claude-x', providerID: 'anthropic' },
      },
    );
    await bridge.observeContext(contextEvent);
    expect(calls).toEqual([
      {
        sessionID: 'ses_p',
        agent: 'orchestrator',
        model: { providerID: 'anthropic', modelID: 'claude-x' },
        messageID: 'msg_1',
      },
    ]);

    // Repeated context events with the same agent/model: no more calls
    // (once-per-admission fidelity — message-scoped delivery belongs to
    // the prompt hook).
    await bridge.observeContext(contextEvent);
    await bridge.observeContext(contextEvent);
    expect(calls).toHaveLength(1);

    // A model change is newly learned state → one forwarded call.
    await bridge.observeContext(
      makeEvent(
        [{ id: 'msg_2', role: 'user', content: [{ type: 'text', text: 'x' }] }],
        {
          sessionID: 'ses_p',
          agent: 'orchestrator',
          model: { id: 'claude-fallback', providerID: 'anthropic' },
        },
      ),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-fallback',
    });
  });

  test('observeContext omits messageID when the trailing user id is empty or absent', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const bridge = createSessionPromptBridge(async (input) => {
      calls.push(input as Record<string, unknown>);
    });
    // Trailing user message with an empty-string id: the newly-learned
    // forward carries state but no messageID.
    await bridge.observeContext(
      makeEvent([{ id: '', role: 'user', content: [] }], {
        sessionID: 'ses_p',
        agent: 'orchestrator',
      }),
    );
    expect(calls).toEqual([{ sessionID: 'ses_p', agent: 'orchestrator' }]);

    // No user message at all: same omission (the model change forces a
    // new forward, so the shape is observable).
    await bridge.observeContext(
      makeEvent([{ id: 'a1', role: 'assistant', content: [] }], {
        sessionID: 'ses_p',
        agent: 'orchestrator',
        model: { id: 'claude-x', providerID: 'anthropic' },
      }),
    );
    expect(calls).toEqual([
      { sessionID: 'ses_p', agent: 'orchestrator' },
      {
        sessionID: 'ses_p',
        agent: 'orchestrator',
        model: { providerID: 'anthropic', modelID: 'claude-x' },
      },
    ]);
  });

  test('agent learned from context is carried by the next admission', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const bridge = createSessionPromptBridge(async (input) => {
      calls.push(input as Record<string, unknown>);
    });
    await bridge.observeContext(
      makeEvent(
        [
          {
            id: 'msg_1',
            role: 'user',
            content: [{ type: 'text', text: 'hi' }],
          },
        ],
        { sessionID: 'ses_p', agent: 'orchestrator' },
      ),
    );
    await bridge.handlePrompt(makePromptEvent({ messageID: 'msg_2' }));
    expect(calls.at(-1)).toMatchObject({
      sessionID: 'ses_p',
      messageID: 'msg_2',
      agent: 'orchestrator',
    });
  });

  test('handlePrompt feeds the real observeChatMessage consumers', async () => {
    // The v1 observeChatMessage gate that never passed via the context
    // emulation (no parts) must pass via the prompt hook: a non-synthetic
    // text part + messageID present. Agent is pre-learned so the delivery
    // is immediate (deferral is covered below).
    const observed: Array<{ sessionID: string; messageID?: string }> = [];
    const bridge = createSessionPromptBridge((input) => {
      observed.push({
        sessionID: input.sessionID,
        messageID: input.messageID,
      });
      return Promise.resolve();
    });
    await bridge.observeContext(
      makeEvent(
        [{ id: 'msg_0', role: 'user', content: [{ type: 'text', text: 'x' }] }],
        { sessionID: 'ses_p', agent: 'orchestrator' },
      ),
    );
    observed.length = 0;
    await bridge.handlePrompt(makePromptEvent());
    expect(observed).toEqual([{ sessionID: 'ses_p', messageID: 'msg_1' }]);
  });

  test('first prompt is deferred until the context event learns the agent (parts + agent together)', async () => {
    // P1 regression: forwarding the first admitted prompt before the
    // agent is learned gets it dropped by every v1 consumer (no
    // sessionMetadata.setAgent → shouldManageSession false), and the
    // agent-only context forward is dropped by the parts gate. The
    // bridge must latch the first prompt and flush it when the first
    // agent-bearing context event arrives.
    const calls: Array<Record<string, unknown>> = [];
    const bridge = createSessionPromptBridge(async (input) => {
      calls.push(input as Record<string, unknown>);
    });
    await bridge.handlePrompt(makePromptEvent());
    expect(calls).toEqual([]); // deferred, not dropped-then-duplicated

    await bridge.observeContext(
      makeEvent(
        [
          {
            id: 'msg_1',
            role: 'user',
            content: [{ type: 'text', text: 'hi' }],
          },
        ],
        {
          sessionID: 'ses_p',
          agent: 'orchestrator',
          model: { id: 'claude-x', providerID: 'anthropic' },
        },
      ),
    );
    // Exactly ONE delivery, carrying parts + agent + model + messageID
    // together (the no-parts state forward is superseded by the flush).
    expect(calls).toEqual([
      {
        sessionID: 'ses_p',
        messageID: 'msg_1',
        agent: 'orchestrator',
        model: { providerID: 'anthropic', modelID: 'claude-x' },
        parts: [{ type: 'text', text: 'do the thing' }],
      },
    ]);

    // Re-fired admission + repeated context events: still once.
    await bridge.handlePrompt(makePromptEvent());
    await bridge.observeContext(
      makeEvent(
        [
          {
            id: 'msg_1',
            role: 'user',
            content: [{ type: 'text', text: 'hi' }],
          },
        ],
        {
          sessionID: 'ses_p',
          agent: 'orchestrator',
          model: { id: 'claude-x', providerID: 'anthropic' },
        },
      ),
    );
    expect(calls).toHaveLength(1);
  });

  test('deferred flush satisfies the v1 setAgent-before-consumers ordering', async () => {
    // Replica of the real v1 chat.message handler ordering: an agent on
    // the delivery registers the session agent BEFORE the consumers gate
    // on it. The deferred flush must pass the consumers' gate where the
    // old immediate forward (agent-less) and the old context forward
    // (parts-less) both failed.
    const sessionAgents = new Map<string, string>();
    const consumerObserved: Array<string | undefined> = [];
    const bridge = createSessionPromptBridge(async (input) => {
      if (input.agent) sessionAgents.set(input.sessionID, input.agent);
      const isOrchestrator =
        sessionAgents.get(input.sessionID) === 'orchestrator';
      const hasExternalPart = Array.isArray(input.parts)
        ? input.parts.some(
            (part) =>
              part &&
              typeof part === 'object' &&
              part.type === 'text' &&
              part.synthetic !== true,
          )
        : false;
      if (isOrchestrator && hasExternalPart) {
        consumerObserved.push(input.messageID);
      }
    });
    await bridge.handlePrompt(makePromptEvent());
    await bridge.observeContext(
      makeEvent(
        [
          {
            id: 'msg_1',
            role: 'user',
            content: [{ type: 'text', text: 'hi' }],
          },
        ],
        { sessionID: 'ses_p', agent: 'orchestrator' },
      ),
    );
    expect(consumerObserved).toEqual(['msg_1']);
  });

  test('fallback: next admission flushes a still-pending prompt best-known', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const bridge = createSessionPromptBridge(async (input) => {
      calls.push(input as Record<string, unknown>);
    });
    await bridge.handlePrompt(makePromptEvent()); // pending (no agent yet)
    await bridge.handlePrompt(makePromptEvent({ messageID: 'msg_2' }));
    // The pending first admission flushed best-known (no agent learned),
    // the new one latched — order preserved.
    expect(calls).toEqual([
      {
        sessionID: 'ses_p',
        messageID: 'msg_1',
        parts: [{ type: 'text', text: 'do the thing' }],
      },
    ]);
    await bridge.observeContext(
      makeEvent(
        [{ id: 'msg_2', role: 'user', content: [{ type: 'text', text: 'x' }] }],
        { sessionID: 'ses_p', agent: 'orchestrator' },
      ),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      sessionID: 'ses_p',
      messageID: 'msg_2',
      agent: 'orchestrator',
      parts: [{ type: 'text', text: 'do the thing' }],
    });
  });

  test('fallback: a context event past the pending admission flushes best-known', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const bridge = createSessionPromptBridge(async (input) => {
      calls.push(input as Record<string, unknown>);
    });
    await bridge.handlePrompt(makePromptEvent()); // pending msg_1
    // Synthetic/compaction request for the same session: agent absent,
    // trailing user message already past the pending admission.
    await bridge.observeContext(
      makeEvent(
        [{ id: 'msg_9', role: 'user', content: [{ type: 'text', text: 's' }] }],
        { sessionID: 'ses_p', agent: undefined as unknown as string },
      ),
    );
    expect(calls).toEqual([
      {
        sessionID: 'ses_p',
        messageID: 'msg_1',
        parts: [{ type: 'text', text: 'do the thing' }],
      },
      // The no-agent state forward itself (trailing id of the new turn).
      { sessionID: 'ses_p', messageID: 'msg_9' },
    ]);
  });

  test('handlePrompt restores the internal-initiator marker from prompt metadata (wake admissions stay internal)', async () => {
    // The v2 orchestrator-wake queue prompt arrives with the marker as
    // prompt metadata (part metadata cannot survive the text-only v2
    // translation). The rebuilt parts view must carry the v1 part marker
    // so isInternalInitiatorPart consumers — orchestrator-wake's
    // observeChatMessage in particular — treat the admission as internal
    // (no no-progress rearm, no timer clear). The marker must survive
    // the deferred first-admission flush too.
    const calls: Array<Record<string, unknown>> = [];
    const bridge = createSessionPromptBridge(async (input) => {
      calls.push(input as Record<string, unknown>);
    });
    await bridge.handlePrompt(
      makePromptEvent({
        prompt: { text: '<system-reminder>wake</system-reminder>' },
        metadata: { 'oh-my-opencode-slim.internalInitiator': true },
      }),
    );
    expect(calls).toEqual([]); // deferred
    await bridge.observeContext(
      makeEvent(
        [{ id: 'msg_1', role: 'user', content: [{ type: 'text', text: 'w' }] }],
        { sessionID: 'ses_p', agent: 'orchestrator' },
      ),
    );
    expect(calls[0]?.parts).toEqual([
      {
        type: 'text',
        text: '<system-reminder>wake</system-reminder>',
        synthetic: true,
        metadata: { 'oh-my-opencode-slim.internalInitiator': true },
      },
    ]);
    expect(calls[0]?.agent).toBe('orchestrator');
    // The restored marker must satisfy the real v1 gate.
    const { isInternalInitiatorPart } = await import(
      '../utils/internal-initiator'
    );
    const parts = calls[0]?.parts as unknown[];
    expect(parts.some((part) => isInternalInitiatorPart(part))).toBe(true);

    // Without the metadata flag the parts view stays plain (external).
    const plainCalls: Array<Record<string, unknown>> = [];
    const bridge2 = createSessionPromptBridge(async (input) => {
      plainCalls.push(input as Record<string, unknown>);
    });
    await bridge2.observeContext(
      makeEvent(
        [{ id: 'msg_1', role: 'user', content: [{ type: 'text', text: 'x' }] }],
        { sessionID: 'ses_p', agent: 'orchestrator' },
      ),
    );
    await bridge2.handlePrompt(
      makePromptEvent({ messageID: 'msg_2', prompt: { text: 'user text' } }),
    );
    expect(plainCalls.at(-1)?.parts).toEqual([
      { type: 'text', text: 'user text' },
    ]);
  });

  test('malformed prompt events are ignored without throwing', async () => {
    const calls: unknown[] = [];
    const bridge = createSessionPromptBridge(async (input) => {
      calls.push(input);
    });
    await expect(
      bridge.handlePrompt({
        sessionID: '',
        messageID: 'm',
        prompt: { text: 't' },
      }),
    ).resolves.toBeUndefined();
    await expect(
      bridge.handlePrompt({
        sessionID: 's',
        messageID: '',
        prompt: { text: 't' },
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('context handler: native prompt mode + CacheHint', () => {
  test('observeContextAgent runs and the per-request emulation is skipped', async () => {
    const observed: string[] = [];
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      // Native prompt-hook mode: no chatMessage emulation dep — agent
      // tracking flows through observeContextAgent instead.
      observeContextAgent: async (event) => {
        observed.push(event.sessionID);
      },
    });
    await handler(makeEvent([{ id: 'u', role: 'user', content: [] }]));
    expect(observed).toEqual(['ses_cmd']);
  });

  test('v2-injected parts carry cache:{type:"ephemeral"} via the bridge', async () => {
    const message = {
      id: 'u',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    };
    const event = makeEvent([message]);
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async (_input, output) => {
        const target = output.messages.at(-1);
        if (!target) throw new Error('no message');
        appendTaggedSyntheticPart(target, {
          text: 'INJECTED REMINDER',
          metadataKey: 'omos_test_tag',
        });
      },
      syntheticPartCacheHint: { type: 'ephemeral' },
    });

    await handler(event);

    const injected = message.content.at(-1) as Record<string, unknown>;
    expect(injected.cache).toEqual({ type: 'ephemeral' });
  });

  test('without the hint dep injected parts stay byte-identical to v1', async () => {
    const message = {
      id: 'u',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    };
    const event = makeEvent([message]);
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async (_input, output) => {
        const target = output.messages.at(-1);
        if (!target) throw new Error('no message');
        appendTaggedSyntheticPart(target, {
          text: 'INJECTED REMINDER',
          metadataKey: 'omos_test_tag',
        });
      },
    });

    await handler(event);

    const injected = message.content.at(-1) as Record<string, unknown>;
    expect(injected.cache).toBeUndefined();
    expect(injected).toEqual({
      type: 'text',
      synthetic: true,
      text: 'INJECTED REMINDER',
      metadata: { omos_test_tag: true },
    });
  });

  test('hint scoping restores the default after the transform', async () => {
    // Outside the bridged transform, injection must not carry the hint —
    // proves the set/restore wrapper cannot leak into v1-path calls.
    const probe: Array<Record<string, unknown>> = [];
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async (_input, output) => {
        const target = output.messages.at(-1);
        if (!target) throw new Error('no message');
        appendTaggedSyntheticPart(target, {
          text: 'inside',
          metadataKey: 'omos_test_tag',
        });
      },
      syntheticPartCacheHint: { type: 'ephemeral' },
    });
    await handler(makeEvent([{ id: 'u', role: 'user', content: [] }]));
    appendTaggedSyntheticPart(
      {
        info: { role: 'user' },
        get parts() {
          return probe;
        },
        set parts(value) {
          probe.push(...(value as Array<Record<string, unknown>>));
        },
      } as never,
      { text: 'outside', metadataKey: 'omos_test_tag' },
    );
    const outside = { ...probe.at(-1) } as Record<string, unknown>;
    expect(outside.cache).toBeUndefined();
  });

  test('interleaved transforms for two sessions keep their cache-hint scopes (P2 race)', async () => {
    // Greptile P2 scenario: the v2 host serves different sessions'
    // requests concurrently (per-session serialization only), so two
    // context-hook invocations can overlap across the awaited messages
    // transform. Session A's restore must not clear the scoped default
    // session B's still-running transform injects with.
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const gates: Record<string, Array<() => void>> = {
      ses_a: [],
      ses_b: [],
    };
    const makeGatedTransform = (session: string) => {
      return async (
        _input: unknown,
        output: {
          messages: Array<{ info: { role: string }; parts: unknown[] }>;
        },
      ) => {
        const target = output.messages.at(-1);
        if (!target) throw new Error('no message');
        await new Promise<void>((resolve) => {
          gates[session].push(resolve);
        });
        appendTaggedSyntheticPart(target, {
          text: `INJECTED ${session}`,
          metadataKey: 'omos_test_tag',
        });
      };
    };
    const makeSessionEvent = (session: string) =>
      makeEvent([{ id: 'u', role: 'user', content: [] }], {
        sessionID: session,
      });
    const makeHandler = (session: string) =>
      createSessionContextHandler({
        interviewHandleContext: async () => {},
        messagesTransform: makeGatedTransform(session),
        syntheticPartCacheHint: { type: 'ephemeral' },
      });

    const eventA = makeSessionEvent('ses_a');
    const eventB = makeSessionEvent('ses_b');
    const pendingA = makeHandler('ses_a')(eventA);
    await tick(); // A reaches its transform and parks on its gate
    const pendingB = makeHandler('ses_b')(eventB);
    await tick(); // B enters its transform scope and parks (A still set)

    // Release A: it injects and restores its hint scope while B is parked.
    for (const resolve of gates.ses_a ?? []) resolve();
    await pendingA;
    // Only now release B: its part must still carry the v2 cache hint.
    for (const resolve of gates.ses_b ?? []) resolve();
    await pendingB;

    const injectedA = eventA.messages[0]?.content.at(-1) as Record<
      string,
      unknown
    >;
    const injectedB = eventB.messages[0]?.content.at(-1) as Record<
      string,
      unknown
    >;
    expect(injectedA.cache).toEqual({ type: 'ephemeral' });
    expect(injectedB.cache).toEqual({ type: 'ephemeral' });
  });
});
