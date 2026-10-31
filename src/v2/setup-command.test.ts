import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
  appendTaggedSyntheticPart,
  appendTrailingVolatileMessage,
  isTaggedPart,
} from '../hooks/cache-safe-injection';
import {
  assistantTurn,
  createPipeline,
  internalInitiatorTurn,
  SESSION_ID,
  userTurn,
} from '../hooks/cache-safety-harness.test';
import { createJsonErrorRecoveryHook } from '../hooks/json-error-recovery/hook';
import {
  createPhaseReminderHook,
  PHASE_REMINDER_METADATA_KEY,
} from '../hooks/phase-reminder';
import { BACKGROUND_JOB_BOARD_METADATA_KEY } from '../hooks/task-session-manager/board-injection';
import {
  createPendingCallTracker,
  type PendingTaskCall,
} from '../hooks/task-session-manager/pending-call-tracker';
import {
  createToolLoopGuardHook,
  LOOP_GUARD_WARNING,
} from '../hooks/tool-loop-guard/hook';
import {
  collapseInterviewHistory,
  INTERVIEW_SUMMARY_STUB,
} from '../interview/history';
import {
  INTERNAL_INITIATOR_METADATA_KEY,
  SLIM_INTERNAL_INITIATOR_MARKER,
} from '../utils/internal-initiator';
import { createV2InterviewBridge, markerText } from './interview-bridge';
import { createSessionSubmit } from './session-submit';
import {
  applyCommandMarkerToContext,
  attributeAgentsByHistory,
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

describe('attributeAgentsByHistory (marker-walk attribution)', () => {
  const user = (id: string): Record<string, unknown> => ({
    id,
    type: 'user',
    text: 'x',
    time: { created: 1 },
  });
  const marker = (
    id: string,
    agent: string,
    previous?: string,
  ): Record<string, unknown> => ({
    id,
    type: 'agent-switched',
    agent,
    ...(previous ? { previous } : {}),
    time: { created: 1 },
  });

  test('undefined/empty history yields an empty map', () => {
    expect(attributeAgentsByHistory(undefined).size).toBe(0);
    expect(attributeAgentsByHistory([]).size).toBe(0);
  });

  test('a marker without previous leaves its pre-segment unmapped', () => {
    const map = attributeAgentsByHistory([
      user('a'),
      user('b'),
      marker('m', 'build'),
      user('c'),
    ]);
    expect(map.has('a')).toBe(false);
    expect(map.has('b')).toBe(false);
    expect(map.get('c')).toBe('build');
  });

  test('previous seeds the pre-segment when no earlier marker established one', () => {
    // Doubles as the compaction-window-start case: a post-compaction
    // window whose first in-window marker carries `previous` attributes
    // the retained pre-segment from that field alone.
    const map = attributeAgentsByHistory([
      user('a'),
      marker('m', 'build', 'orchestrator'),
      user('b'),
    ]);
    expect(map.get('a')).toBe('orchestrator');
    expect(map.get('b')).toBe('build');
  });

  test('a preceding in-window marker is authoritative over previous', () => {
    const map = attributeAgentsByHistory([
      user('a'),
      marker('m1', 'build', 'orchestrator'),
      user('b'),
      marker('m2', 'design', 'stale'),
      user('c'),
    ]);
    expect(map.get('a')).toBe('orchestrator');
    expect(map.get('b')).toBe('build');
    expect(map.get('c')).toBe('design');
  });

  test('non-user/non-marker entries are ignored; ids are the join keys', () => {
    const map = attributeAgentsByHistory([
      { id: 'asst_1', type: 'assistant', agent: 'build', time: { created: 1 } },
      { id: 'idle_1', type: 'idle', time: { created: 2 } },
      user('msg_1'),
      marker('msg_m', 'design', 'build'),
    ]);
    expect(map.size).toBe(1);
    expect(map.get('msg_1')).toBe('build');
  });
});

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
    expect(wrapCommandMarker('deepwork', '')).toBe(
      '<omos-cmd-command data-name="deepwork"></omos-cmd-command>',
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
      'deepwork',
      {},
      submit,
    );

    await expect(
      added[0]?.execute({ sessionID: 'ses_2', prompt: { text: '' } }),
    ).resolves.toBeUndefined();
    expect(submit).toHaveBeenCalledWith(
      'ses_2',
      wrapCommandMarker('deepwork', ''),
    );
  });

  test('a throwing draft.add propagates to the caller (no internal catch)', () => {
    const draft: V2CommandDraft = {
      add: () => {
        throw new Error('draft rejected');
      },
    };
    expect(() =>
      createCommandRegistration(draft, 'deepwork', {}, async () => {}),
    ).toThrow('draft rejected');
  });

  test('draft without add is a logged no-op', () => {
    expect(() =>
      createCommandRegistration(
        {} as V2CommandDraft,
        'deepwork',
        {},
        async () => {},
      ),
    ).not.toThrow();
  });
});

describe('registerSynthCommands (generic path skips bridge-owned interview)', () => {
  test('interview is NOT add()ed from the generic path; the bridge registers it', () => {
    const added: V2CommandDefinition[] = [];
    const draft: V2CommandDraft = { add: (def) => added.push(def) };

    registerSynthCommands(
      draft,
      [
        ['interview', { description: 'Open a localhost interview UI' }],
        ['implement', { description: 'Read the completed interview markdown' }],
        ['deepwork', { description: 'Start a deep work block' }],
      ],
      async () => {},
    );
    expect(added.map((def) => def.name)).toEqual(['deepwork']);

    const bridge = createV2InterviewBridge({ session: {} } as never, undefined);
    bridge.registerCommand(draft);
    expect(added.map((def) => def.name)).toEqual([
      'deepwork',
      'interview',
      'implement',
    ]);
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
        ['reflect', {}],
      ],
      async () => {},
    );
    expect(added.map((def) => def.name)).toEqual(['reflect']);
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

    expect(added).toHaveLength(2);
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

  test('ignores synthetic text when detecting markers and preserves it', async () => {
    const trailing = {
      id: 'm1',
      role: 'user',
      content: [
        { type: 'text', text: wrapCommandMarker('reflect', 'standup notes') },
        { type: 'text', text: '[chair] guard', synthetic: true },
      ],
    };
    const event = makeEvent([trailing]);
    const commandBefore: V1CommandBeforeHook = async () => {};

    await applyCommandMarkerToContext(event, commandBefore);

    expect(trailing.content).toEqual([
      { type: 'text', text: 'standup notes' },
      { type: 'text', text: '[chair] guard', synthetic: true },
    ]);
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
      {
        session: {
          synthetic,
          rename,
          create: mock(async () => ({ id: 'side-session' })),
        },
      } as never,
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

  test('context bridge exposes the stored synthetic delivery time to the observer', async () => {
    const text =
      '<subagent sessionID="ses_child" state="completed" description="work">\ndone\n</subagent>';
    const event = makeEvent([
      { id: 'msg_delivery', role: 'user', content: [{ type: 'text', text }] },
    ]);
    let observedTime: unknown;
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      sessionContext: async () => [
        {
          id: 'msg_delivery',
          type: 'synthetic',
          text,
          time: { created: 2000 },
        },
      ],
      messagesTransform: async (_input, output) => {
        observedTime = (
          output.messages[0]?.info as { time?: unknown } | undefined
        )?.time;
      },
    });

    await handler(event);
    expect(observedTime).toEqual({ created: 2000 });
    expect(event.messages[0]).not.toHaveProperty('time');
  });

  test('context bridge projects delivery time when every user message has an agent', async () => {
    const text =
      '<subagent sessionID="ses_child" state="completed" description="work">\ndone\n</subagent>';
    const event = makeEvent([
      {
        id: 'msg_delivery',
        role: 'user',
        agent: 'orchestrator',
        content: [{ type: 'text', text }],
      },
    ]);
    let observedTime: unknown;
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      sessionContext: async () => [
        {
          id: 'msg_delivery',
          type: 'synthetic',
          text,
          time: { created: 2000 },
        },
      ],
      messagesTransform: async (_input, output) => {
        observedTime = (
          output.messages[0]?.info as { time?: unknown } | undefined
        )?.time;
      },
    });

    await handler(event);
    expect(observedTime).toEqual({ created: 2000 });
  });

  test('context bridge collapses v2 tool parts without mutating them', async () => {
    const kickoff = {
      type: 'tool-call',
      toolName: 'interview_submit_state',
      input: {
        summary: '# Full specification\n\nDetailed requirements.',
        title: 'spec',
        questions: [],
      },
    };
    const status = {
      type: 'tool-call',
      toolName: 'interview_submit_state',
      input: { summary: 'status', patch: 'x', questions: [] },
    };
    const originalKickoff = structuredClone(kickoff);
    const event = makeEvent([
      { id: 'one', role: 'assistant', content: [kickoff] },
      { id: 'two', role: 'assistant', content: [status] },
    ]);
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async (_input, output) =>
        collapseInterviewHistory(output.messages as never),
    });

    await handler(event);

    expect(kickoff).toEqual(originalKickoff);
    expect(
      (event.messages[0].content[0] as { input: { summary: string } }).input
        .summary,
    ).toBe(INTERVIEW_SUMMARY_STUB);
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

describe('context bridge: transcript identity enrichment', () => {
  test('job launches never touch the payload and never split tool pairs', async () => {
    const pipeline = createPipeline();
    const launch = (taskID: string) =>
      pipeline.board.registerLaunch({
        taskID,
        parentSessionID: SESSION_ID,
        agent: 'fixer',
        description: taskID,
        background: true,
      });
    launch('ses_first_child');
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async (_input, output) => pipeline.run(output),
    });
    const history: V2SessionContextEvent['messages'] = [
      {
        id: 'user',
        role: 'user',
        content: [{ type: 'text', text: 'Continue.' }],
      },
    ];
    const transform = async () => {
      const event = makeEvent(structuredClone(history), {
        sessionID: SESSION_ID,
      });
      await handler(event);
      return event.messages;
    };
    const boards = (messages: V2SessionContextEvent['messages']) =>
      messages.filter((message) =>
        message.content.some((part) =>
          isTaggedPart(part, BACKGROUND_JOB_BOARD_METADATA_KEY),
        ),
      );
    const projection = (messages: V2SessionContextEvent['messages']) =>
      messages.map((message) => [
        message.role,
        message.content.map((part) => {
          const { cache, metadata, synthetic, ...content } = part;
          return content;
        }),
      ]);
    const initial = await transform();
    // The job board is never rendered (issue #1647): no launch ever adds a
    // byte to the payload.
    expect(boards(initial)).toHaveLength(0);
    launch('ses_second_child');
    history.push({
      id: 'assistant-call',
      role: 'assistant',
      content: ['call-1', 'call-2'].map((toolCallId) => ({
        type: 'tool-call',
        toolCallId,
        toolName: 'read',
        input: {},
      })),
    });
    const pending = await transform();
    expect(boards(pending)).toHaveLength(0);
    expect(projection(pending).slice(0, initial.length)).toEqual(
      projection(initial),
    );
    for (const toolCallId of ['call-1', 'call-2']) {
      history.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName: 'read',
            output: { type: 'text', value: 'contents' },
          },
        ],
      });
      const current = await transform();
      // A tool-result tail changes nothing: no board, no payload churn, and
      // every prefix stays stable.
      expect(boards(current)).toHaveLength(0);
      expect(projection(current).slice(0, pending.length)).toEqual(
        projection(pending),
      );
      const callIndex = current.findIndex(
        (message) => message.id === 'assistant-call',
      );
      expect(current[callIndex + 1].role).toBe('tool');
      if (toolCallId === 'call-2') {
        expect(current[callIndex + 2].role).toBe('tool');
        history.push({
          id: 'after',
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
        });
        const replay = await transform();
        expect(projection(replay).slice(0, current.length)).toEqual(
          projection(current),
        );
      }
    }
  });

  test('a completion changes nothing in the payload across tool continuations', async () => {
    const pipeline = createPipeline();
    pipeline.board.registerLaunch({
      taskID: 'ses_remaining_child',
      parentSessionID: SESSION_ID,
      agent: 'fixer',
      description: 'remaining job',
      background: true,
    });
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async (_input, output) => pipeline.run(output),
    });
    const history: V2SessionContextEvent['messages'] = [
      {
        id: 'msg_completion',
        role: 'user',
        content: [{ type: 'text', text: 'A background child completed.' }],
      },
    ];
    const completion = makeEvent(structuredClone(history), {
      sessionID: SESSION_ID,
    });
    await handler(completion);

    const providerContent = (messages: V2SessionContextEvent['messages']) =>
      messages.map((message) => [
        message.role,
        message.content.map((part) => {
          const { cache, metadata, synthetic, ...content } = part;
          return content;
        }),
      ]);
    const boardMessages = (event: V2SessionContextEvent) =>
      event.messages.filter((message) =>
        message.content.some((part) =>
          isTaggedPart(part, BACKGROUND_JOB_BOARD_METADATA_KEY),
        ),
      );
    expect(boardMessages(completion)).toHaveLength(0);
    let previous = providerContent(completion.messages);

    for (let step = 1; step <= 2; step++) {
      // Fresh host-shaped context: injected parts are not persisted, and
      // neither the assistant nor the anonymous tool result has sessionID.
      history.push(
        {
          id: `a${step}`,
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: `call-${step}`,
              toolName: 'read',
              input: {},
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: `call-${step}`,
              toolName: 'read',
              output: { type: 'text', value: `File ${step} contents.` },
            },
          ],
        },
      );
      const continuation = makeEvent(structuredClone(history), {
        sessionID: SESSION_ID,
      });
      await handler(continuation);
      expect(boardMessages(continuation)).toHaveLength(0);
      const current = providerContent(continuation.messages);
      expect(current.slice(0, previous.length)).toEqual(previous);
      previous = current;
    }
  });

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

  test.each(['user', 'assistant', 'tool'])(
    '%s host-provided sessionID/agent values are preserved',
    async (role) => {
      const user = {
        id: 'u1',
        role,
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
    },
  );

  test.each(['assistant', 'tool'])(
    '%s messages gain sessionID without changing agent or content',
    async (role) => {
      const assistant = {
        id: 'a1',
        role,
        time: 456,
        content: [{ type: 'text', text: 'response' }],
      };
      const contentBefore = structuredClone(assistant.content);
      const handler = createSessionContextHandler({
        interviewHandleContext: async () => {},
        messagesTransform: async () => {},
      });

      await handler(makeEvent([assistant]));

      expect(assistant.sessionID).toBe('ses_cmd');
      expect(assistant.agent).toBeUndefined();
      expect(assistant.content).toEqual(contentBefore);
      await handler(makeEvent([assistant], { sessionID: 'ses_other' }));
      expect(assistant.sessionID).toBe('ses_cmd');
    },
  );

  test('attributed user messages skip the stored-history read', async () => {
    const sessionContext = mock(async () => []);
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async () => {},
      sessionContext,
    });
    const user = {
      id: 'u1',
      role: 'user',
      agent: 'planner',
      content: [{ type: 'text', text: 'hi' }],
    };
    await handler(makeEvent([user]));
    expect(sessionContext).not.toHaveBeenCalled();
    expect(user.agent).toBe('planner');
    await handler(makeEvent([{ id: 'a1', role: 'assistant', content: [] }]));
    expect(sessionContext).not.toHaveBeenCalled();
  });

  test('attribution falls back to the event agent on a markerless history', async () => {
    const user = {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    };
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async () => {},
      // v1-migrated / markerless session: no per-message data exists, so
      // the context event's current agent is the exact attribution.
      sessionContext: async () => [{ id: 'u9', type: 'user', text: 'x' }],
    });

    await handler(makeEvent([user], { agent: 'build' }));

    expect(user.sessionID).toBe('ses_cmd');
    expect(user.agent).toBe('build');
  });

  test('a failed history read degrades attribution to the event agent', async () => {
    const user = {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    };
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async () => {},
      sessionContext: async () => {
        throw new Error('store unavailable');
      },
    });

    await handler(makeEvent([user], { agent: 'build' }));

    expect(user.agent).toBe('build');
  });

  test('attribution joins payload users to their send-time agent across switches (issue #1640 v2)', async () => {
    const mkUser = (id: string) => ({
      id,
      role: 'user',
      content: [{ type: 'text', text: `msg ${id}` }],
    });
    const u1 = mkUser('msg_1');
    const u1b = mkUser('msg_2');
    const u2 = mkUser('msg_3');
    const u3 = mkUser('msg_4');
    const marker = (id: string, agent: string, previous?: string) => ({
      id,
      type: 'agent-switched',
      agent,
      ...(previous ? { previous } : {}),
      time: { created: 1 },
    });
    const history = [
      { id: 'msg_1', type: 'user', text: 'x', time: { created: 1 } },
      { id: 'msg_2', type: 'user', text: 'x', time: { created: 2 } },
      marker('msg_m1', 'build', 'orchestrator'),
      { id: 'msg_3', type: 'user', text: 'x', time: { created: 3 } },
      marker('msg_m2', 'design', 'build'),
      { id: 'msg_4', type: 'user', text: 'x', time: { created: 4 } },
    ];
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async () => {},
      sessionContext: async () => history,
    });

    const ghost = mkUser('msg_ghost');
    await handler(makeEvent([u1, u1b, u2, u3, ghost], { agent: 'design' }));

    // u1/u1b were sent under orchestrator (marker.previous), u2 under
    // build, u3 under design — attribution survives the switches.
    // msg_ghost has no history row: per-message fallback → event.agent.
    expect(u1.agent).toBe('orchestrator');
    expect(u1b.agent).toBe('orchestrator');
    expect(u2.agent).toBe('build');
    expect(u3.agent).toBe('design');
    expect(ghost.agent).toBe('design');
  });

  test('attribution is stateless: a fresh handler instance reproduces it from the same history', async () => {
    const mkUser = (id: string) => ({
      id,
      role: 'user',
      content: [{ type: 'text', text: `msg ${id}` }],
    });
    const history = [
      { id: 'msg_1', type: 'user', text: 'x', time: { created: 1 } },
      {
        id: 'msg_m1',
        type: 'agent-switched',
        agent: 'build',
        previous: 'orchestrator',
        time: { created: 2 },
      },
      { id: 'msg_2', type: 'user', text: 'x', time: { created: 3 } },
    ];
    const deps = () =>
      createSessionContextHandler({
        interviewHandleContext: async () => {},
        messagesTransform: async () => {},
        sessionContext: async () => history,
      });
    const first = mkUser('msg_1');
    const second = mkUser('msg_1');

    await deps()(makeEvent([first], { agent: 'build' }));
    await deps()(makeEvent([second], { agent: 'build' }));

    // Simulated restart (fresh instance, same durable rows): identical
    // attribution — no in-memory state participates.
    expect(first.agent).toBe('orchestrator');
    expect(second.agent).toBe('orchestrator');
  });

  test('the attribution read never mutates stored history (#448 guard)', async () => {
    const user = {
      id: 'msg_1',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    };
    const history = [
      { id: 'msg_1', type: 'user', text: 'x', time: { created: 1 } },
    ];
    const historyBefore = JSON.stringify(history);
    let seen: Array<{ id?: string; parts: unknown[] }> = [];
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async (_input, output) => {
        seen = output.messages as never;
      },
      sessionContext: async () => history,
    });

    await handler(makeEvent([user], { agent: 'orchestrator' }));

    expect(JSON.stringify(history)).toBe(historyBefore);
    // The bridge itself adds nothing: the transform sees exactly the
    // payload message, no synthetic part injected by the bridge (the only
    // enrichment is the absence-gated envelope stamp).
    expect(seen).toHaveLength(1);
    expect(seen[0]?.parts).toHaveLength(1);
    expect(user.agent).toBe('orchestrator');
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

  test('v2 synthetic wake is internal: no new phase reminder or job board (T4)', async () => {
    const pipeline = createPipeline();
    pipeline.board.registerLaunch({
      taskID: 'ses_child',
      parentSessionID: SESSION_ID,
      agent: 'explorer',
      description: 'running job',
      background: true,
    });
    const wake = {
      id: 'msg_omos_wake',
      role: 'user',
      content: [
        {
          type: 'text',
          text: `wake\n${SLIM_INTERNAL_INITIATOR_MARKER}`,
          metadata: { source: 'host' },
        },
      ],
    };
    const event = makeEvent(
      [
        { id: 'u1', role: 'user', content: [{ type: 'text', text: 'start' }] },
        {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'text', text: 'working' }],
        },
        wake,
      ],
      { sessionID: SESSION_ID },
    );
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async (_input, output) => pipeline.run(output),
    });

    await handler(event);

    expect(event.messages.at(-1)).toBe(wake);
    expect(wake.content[0]).toMatchObject({
      synthetic: true,
      metadata: { source: 'host', [INTERNAL_INITIATOR_METADATA_KEY]: true },
    });
    expect(
      wake.content.some(
        (part) =>
          isTaggedPart(part, PHASE_REMINDER_METADATA_KEY) ||
          isTaggedPart(part, BACKGROUND_JOB_BOARD_METADATA_KEY),
      ),
    ).toBe(false);
  });

  test('v1 flagged wake likewise gets no fresh phase reminder or job board (T5)', async () => {
    const pipeline = createPipeline();
    pipeline.board.registerLaunch({
      taskID: 'ses_child',
      parentSessionID: SESSION_ID,
      agent: 'explorer',
      description: 'running job',
      background: true,
    });
    const wake = internalInitiatorTurn('wake', 'continue');
    const output: { messages: unknown[] } = {
      messages: [userTurn('u1', 'start'), assistantTurn('a1', 'working'), wake],
    };
    await pipeline.run(output);
    expect(output.messages.at(-1)).toBe(wake);
    expect(
      wake.parts.some(
        (part) =>
          isTaggedPart(part, PHASE_REMINDER_METADATA_KEY) ||
          isTaggedPart(part, BACKGROUND_JOB_BOARD_METADATA_KEY),
      ),
    ).toBe(false);
  });

  test('ordinary ids remain external even with message-level internal metadata', async () => {
    const message = {
      id: 'msg_regular',
      role: 'user',
      metadata: { [INTERNAL_INITIATOR_METADATA_KEY]: true },
      content: [{ type: 'text', text: 'user prompt' }],
    };
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async () => {},
    });
    await handler(makeEvent([message]));
    expect(message.content).toEqual([{ type: 'text', text: 'user prompt' }]);
  });

  test('end-to-end: a recognized agent now performs the phase-reminder injection it previously skipped', async () => {
    const phaseReminder = createPhaseReminderHook();

    // The pre-fix behavior: the raw v2 transcript message (no agent) fails
    // per-message eligibility inside the real v1 hook.
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

  test('before bridge normalizes a legacy task_id to sessionID', async () => {
    const before = async () => {};
    const event = {
      tool: 'subagent',
      sessionID: 'ses_parent',
      agent: 'orchestrator',
      messageID: 'msg_1',
      id: 'call_legacy',
      input: {
        agent: 'fixer',
        description: 'd',
        prompt: 'p',
        task_id: 'ses_legacy',
      },
    };
    const { beforeBridge } = createToolExecuteBridges(before, undefined);
    await beforeBridge(event);
    expect(event.input).toEqual({
      agent: 'fixer',
      description: 'd',
      prompt: 'p',
      sessionID: 'ses_legacy',
    });
    expect(event.input).not.toHaveProperty('task_id');
  });

  test('before bridge preserves a fresh spawn when a hook deletes task_id', async () => {
    const before = async (_i: unknown, o: { args: unknown }) => {
      delete (o.args as Record<string, unknown>).task_id;
    };
    const event = {
      tool: 'subagent',
      sessionID: 'ses_parent',
      agent: 'orchestrator',
      messageID: 'msg_1',
      id: 'call_drop',
      input: {
        agent: 'fixer',
        description: 'd',
        prompt: 'p',
        task_id: 'ses_x',
      },
    };
    const { beforeBridge } = createToolExecuteBridges(before, undefined);
    await beforeBridge(event);
    // A dropped resume id must NOT resurrect as a sessionID (which would
    // resume the wrong child instead of spawning fresh).
    expect(event.input).toEqual({
      agent: 'fixer',
      description: 'd',
      prompt: 'p',
    });
    expect(event.input).not.toHaveProperty('sessionID');
    expect(event.input).not.toHaveProperty('task_id');
  });

  test('before bridge lets canonical sessionID win over a legacy task_id', async () => {
    const before = async () => {};
    const event = {
      tool: 'subagent',
      sessionID: 'ses_parent',
      agent: 'orchestrator',
      messageID: 'msg_1',
      id: 'call_both',
      input: {
        agent: 'fixer',
        description: 'd',
        prompt: 'p',
        task_id: 'ses_legacy',
        sessionID: 'ses_canonical',
      },
    };
    const { beforeBridge } = createToolExecuteBridges(before, undefined);
    await beforeBridge(event);
    expect(event.input).toEqual({
      agent: 'fixer',
      description: 'd',
      prompt: 'p',
      sessionID: 'ses_canonical',
    });
    expect(event.input).not.toHaveProperty('task_id');
  });

  test('before bridge leaves a non-delegation call and absent hook untouched', async () => {
    const before = async () => {};
    const readEvent = {
      tool: 'read',
      sessionID: 'ses_parent',
      agent: 'fixer',
      messageID: 'msg_1',
      id: 'call_read',
      input: { filePath: 'src/x.ts' },
    };
    const { beforeBridge } = createToolExecuteBridges(before, undefined);
    await beforeBridge(readEvent);
    expect(readEvent.input).toEqual({ filePath: 'src/x.ts' });

    const noHookEvent = {
      tool: 'subagent',
      sessionID: 'ses_parent',
      agent: 'orchestrator',
      messageID: 'msg_1',
      id: 'call_no_hook',
      input: { agent: 'fixer', task_id: 'ses_untouched' },
    };
    const inert = createToolExecuteBridges(undefined, undefined);
    await inert.beforeBridge(noHookEvent);
    expect(noHookEvent.input).toEqual({
      agent: 'fixer',
      task_id: 'ses_untouched',
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

  test('before bridge carries the parent fallback model into delegated children', async () => {
    let seenArgs: Record<string, unknown> | undefined;
    const before = async (
      _i: { tool: string; sessionID: string; callID: string },
      o: { args: unknown },
    ) => {
      seenArgs = { ...(o.args as Record<string, unknown>) };
    };
    const { beforeBridge } = createToolExecuteBridges(
      before,
      undefined,
      () => 'openai/gpt-6-luna',
    );
    const event = {
      tool: 'subagent',
      sessionID: 'ses_parent',
      agent: 'orchestrator',
      messageID: 'msg_1',
      id: 'call_1',
      input: { agent: 'operator', prompt: 'continue' },
    };

    await beforeBridge(event);

    expect(seenArgs).toMatchObject({
      subagent_type: 'operator',
      model: 'openai/gpt-6-luna',
    });
    expect(event.input).toMatchObject({
      agent: 'operator',
      model: 'openai/gpt-6-luna',
    });
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
    await poll(
      'task_status',
      'poll-2',
      'task_id: ses_child\nstate: running\nresult: true',
    );
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
      'task_status',
      'poll-4',
      'task_id: ses_child\nstate: running\nresult: true',
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

  test('absent status (defensive) keeps the completed path', async () => {
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
  test('handlePrompt delivers chat.message once per admission with parts', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const bridge = createSessionPromptBridge(async (input) => {
      calls.push(input as Record<string, unknown>);
    });
    // Pre-learn the agent so the admission delivers immediately.
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
    // The file part keeps the real consumers' non-synthetic-part gate passable.
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

    // Repeated context events with the same agent/model: no more calls.
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
    // Empty-string trailing id: the forward carries state but no messageID.
    await bridge.observeContext(
      makeEvent([{ id: '', role: 'user', content: [] }], {
        sessionID: 'ses_p',
        agent: 'orchestrator',
      }),
    );
    expect(calls).toEqual([{ sessionID: 'ses_p', agent: 'orchestrator' }]);

    // No user message at all: same omission.
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
    // P1 regression: an early forward is dropped by every v1 consumer, so the
    // bridge latches the first prompt until the agent-bearing context event.
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
    // Exactly ONE delivery carrying parts + agent + model + messageID together.
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
    // Replica of the v1 handler ordering: setAgent before the consumers gate;
    // the flush passes where the agent-less and parts-less forwards failed.
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
    // The pending admission flushed best-known; the new one latched.
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
    // Agent-absent request whose trailing id is past the pending admission.
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
    // Wake metadata must survive the deferred flush as a v1 part marker so
    // isInternalInitiatorPart consumers treat the admission as internal.
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

describe('createSessionPromptBridge raw admission feed', () => {
  /** A live resumed pending, mirroring the run-input-anchor setup. */
  function resumedPending(sessionID: string): PendingTaskCall {
    return {
      callId: 'call_resume',
      parentSessionId: 'ses_parent',
      agentType: 'fixer',
      label: 'label',
      fullObjective: 'objective',
      background: true,
      lifecycleEpoch: 0,
      resumedTaskId: sessionID,
    };
  }

  test('the raw feed precedes the chat.message delivery, deferred or immediate', async () => {
    // The raw prompt-hook feed is the earliest authoritative admission
    // evidence: it always fires ahead of the (possibly deferred) delivery.
    const fed: Array<{ sessionID: string; messageID: string }> = [];
    const order: string[] = [];
    const bridge = createSessionPromptBridge(
      async (input) => {
        order.push(`chat.message:${input.messageID}`);
      },
      (sessionID, messageID) => {
        fed.push({ sessionID, messageID });
        order.push(`admission:${messageID}`);
      },
    );

    // Unknown agent: fed immediately while chat.message stays latched...
    await bridge.handlePrompt(makePromptEvent());
    expect(fed).toEqual([{ sessionID: 'ses_p', messageID: 'msg_1' }]);
    expect(order).toEqual(['admission:msg_1']);

    // ...learning the agent flushes the deferred delivery; the replay does
    // not re-feed.
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
    expect(order).toEqual(['admission:msg_1', 'chat.message:msg_1']);
    expect(fed).toHaveLength(1);

    // Known agent: the next admission delivers immediately, still after its
    // feed.
    await bridge.handlePrompt(makePromptEvent({ messageID: 'msg_2' }));
    expect(order).toEqual([
      'admission:msg_1',
      'chat.message:msg_1',
      'admission:msg_2',
      'chat.message:msg_2',
    ]);
  });

  test('a throwing feed never refuses the admission or loses the delivery', async () => {
    // A feed throw must be swallowed: the dedupe record is already written.
    const calls: Array<Record<string, unknown>> = [];
    const bridge = createSessionPromptBridge(
      async (input) => {
        calls.push(input as Record<string, unknown>);
      },
      () => {
        throw new Error('feed exploded');
      },
    );
    await bridge.observeContext(
      makeEvent(
        [{ id: 'msg_0', role: 'user', content: [{ type: 'text', text: 'x' }] }],
        { sessionID: 'ses_p', agent: 'orchestrator' },
      ),
    );
    calls.length = 0;

    await expect(
      bridge.handlePrompt(makePromptEvent()),
    ).resolves.toBeUndefined();
    // The admission still reaches the v1 consumer (deferred or immediate).
    expect(calls).toEqual([
      {
        sessionID: 'ses_p',
        messageID: 'msg_1',
        agent: 'orchestrator',
        parts: [{ type: 'text', text: 'do the thing' }],
      },
    ]);
  });

  test('duplicate and malformed admissions never feed', async () => {
    const fed: Array<{ sessionID: string; messageID: string }> = [];
    const bridge = createSessionPromptBridge(
      async () => {},
      (sessionID, messageID) => fed.push({ sessionID, messageID }),
    );

    await bridge.handlePrompt(makePromptEvent());
    // Re-fired admission with the same messageID: deduped, not re-fed.
    await bridge.handlePrompt(makePromptEvent());
    expect(fed).toEqual([{ sessionID: 'ses_p', messageID: 'msg_1' }]);

    // Malformed ids: ignored before the feed.
    await bridge.handlePrompt(
      makePromptEvent({ sessionID: '', messageID: 'msg_x' }),
    );
    await bridge.handlePrompt(
      makePromptEvent({ sessionID: 'ses_p', messageID: '' }),
    );
    await bridge.handlePrompt(
      makePromptEvent({ sessionID: '', messageID: '' }),
    );
    expect(fed).toHaveLength(1);

    // A later, distinct admission still feeds (once).
    await bridge.handlePrompt(makePromptEvent({ messageID: 'msg_2' }));
    expect(fed).toEqual([
      { sessionID: 'ses_p', messageID: 'msg_1' },
      { sessionID: 'ses_p', messageID: 'msg_2' },
    ]);
  });

  test('agent/model-only state forwards never feed', async () => {
    const tracker = createPendingCallTracker();
    tracker.add(resumedPending('ses_p'));
    const calls: Array<Record<string, unknown>> = [];
    const { bridge } = trackedBridge(tracker, async (input) => {
      calls.push(input);
    });

    // State forwards with a trailing id reach chat.message but never feed.
    await bridge.observeContext(
      makeEvent([{ id: 'msg_state', role: 'user', content: [] }], {
        sessionID: 'ses_p',
        agent: 'orchestrator',
        model: { id: 'claude-x', providerID: 'anthropic' },
      }),
    );
    // A model-only change forces another state forward.
    await bridge.observeContext(
      makeEvent([{ id: 'msg_state', role: 'user', content: [] }], {
        sessionID: 'ses_p',
        agent: 'orchestrator',
        model: { id: 'claude-y', providerID: 'anthropic' },
      }),
    );

    expect(calls.map((call) => call.messageID)).toEqual([
      'msg_state',
      'msg_state',
    ]);
    // Nothing was bound to the live pending either.
    expect(
      tracker.peekByCallId('call_resume', 'ses_parent')?.inputMessageID,
    ).toBeUndefined();
    expect(tracker.firstAdmission('ses_p')).toBeUndefined();

    // The real first admission is what feeds.
    await bridge.handlePrompt(makePromptEvent({ messageID: 'msg_real' }));
    expect(tracker.firstAdmission('ses_p')).toBe('msg_real');
    expect(
      tracker.peekByCallId('call_resume', 'ses_parent')?.inputMessageID,
    ).toBe('msg_real');
  });

  /** Feed a real tracker from the bridge's raw admission feed. */
  function trackedBridge(
    tracker: ReturnType<typeof createPendingCallTracker>,
    chatMessage?: (input: Record<string, unknown>) => Promise<void>,
  ) {
    return {
      bridge: createSessionPromptBridge(
        async (input) => {
          await chatMessage?.(input as Record<string, unknown>);
        },
        (sessionID, messageID) => tracker.noteAdmission(sessionID, messageID),
      ),
    };
  }

  // Bridge feed ordering, dedupe, and state-forward exclusion are pinned
  // above; first-wins/binding/ambiguity tracker semantics (firstAdmission,
  // peekByCallId) are pinned in pending-call-tracker.test.ts and
  // run-input-anchor.test.ts.
});

describe('context handler: v2 single cache breakpoint', () => {
  test('observeContextAgent runs and the per-request emulation is skipped', async () => {
    const observed: string[] = [];
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      // Native prompt-hook mode: agent tracking flows through observeContextAgent.
      observeContextAgent: async (event) => {
        observed.push(event.sessionID);
      },
    });
    await handler(makeEvent([{ id: 'u', role: 'user', content: [] }]));
    expect(observed).toEqual(['ses_cmd']);
  });

  const partsWithCache = (event: V2SessionContextEvent) =>
    event.messages.flatMap((message) =>
      message.content
        .filter((part) => part.cache !== undefined)
        .map((part) => ({ id: message.id, part })),
    );

  test('T1: tagged injections never individually spend cache breakpoints', async () => {
    const event = makeEvent([
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'first' }] },
      { id: 'u2', role: 'user', content: [{ type: 'text', text: 'last' }] },
      {
        id: 'tool',
        role: 'tool',
        content: [{ type: 'tool-result', text: 'ok' }],
      },
    ]);
    await createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async (_input, output) => {
        for (const message of output.messages.slice(0, 2)) {
          appendTaggedSyntheticPart(message as never, {
            text: 'reminder',
            metadataKey: PHASE_REMINDER_METADATA_KEY,
          });
        }
      },
    })(event);
    expect(
      event.messages.flatMap((message) =>
        message.content.filter((part) =>
          isTaggedPart(part, PHASE_REMINDER_METADATA_KEY),
        ),
      ),
    ).toHaveLength(2);
    expect(
      partsWithCache(event).filter(({ part }) =>
        isTaggedPart(part, PHASE_REMINDER_METADATA_KEY),
      ),
    ).toHaveLength(0);
    expect(partsWithCache(event)).toEqual([
      {
        id: 'tool',
        part: { type: 'tool-result', text: 'ok', cache: { type: 'ephemeral' } },
      },
    ]);
  });

  test('T2: volatile board tail leaves exactly one mark on copied tool result', async () => {
    const toolPart = { type: 'tool-result', text: 'stable result' };
    const lastToolPart = { type: 'tool-result', text: 'last result' };
    const event = makeEvent([
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { id: 'tool', role: 'tool', content: [toolPart, lastToolPart] },
    ]);
    await createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async (_input, output) => {
        appendTaggedSyntheticPart(output.messages[0] as never, {
          text: 'reminder',
          metadataKey: PHASE_REMINDER_METADATA_KEY,
        });
        appendTrailingVolatileMessage(
          output.messages,
          { id: 'board', role: 'user' },
          { text: 'volatile', metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY },
        );
      },
    })(event);
    expect(event.messages.at(-1)?.id).toBe('board');
    expect(partsWithCache(event)).toEqual([
      { id: 'tool', part: { ...lastToolPart, cache: { type: 'ephemeral' } } },
    ]);
    expect(event.messages[1]?.content[0]).toBe(toolPart);
    expect(event.messages[1]?.content[1]).not.toBe(lastToolPart);
    expect(toolPart).toEqual({ type: 'tool-result', text: 'stable result' });
    expect(lastToolPart).toEqual({ type: 'tool-result', text: 'last result' });
  });

  test('preserves an existing hint and the selected part identity', async () => {
    const toolPart = {
      type: 'tool-result',
      text: 'cached result',
      cache: { type: 'ephemeral', ttlSeconds: 3600 },
    };
    const event = makeEvent([
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { id: 'tool', role: 'tool', content: [toolPart] },
    ]);
    await createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async (_input, output) => {
        appendTaggedSyntheticPart(output.messages[0] as never, {
          text: 'reminder',
          metadataKey: PHASE_REMINDER_METADATA_KEY,
        });
      },
    })(event);
    expect(partsWithCache(event)).toEqual([{ id: 'tool', part: toolPart }]);
    expect(event.messages[1]?.content[0]).toBe(toolPart);
  });

  test('a foreign hint elsewhere does not suppress the last-part mark', async () => {
    const foreignPart = {
      type: 'text',
      text: 'user',
      cache: { type: 'ephemeral', ttlSeconds: 3600 },
    };
    const event = makeEvent([
      { id: 'u', role: 'user', content: [foreignPart] },
      {
        id: 'tool',
        role: 'tool',
        content: [{ type: 'tool-result', text: 'ok' }],
      },
    ]);
    await createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async (_input, output) => {
        appendTaggedSyntheticPart(output.messages[0] as never, {
          text: 'reminder',
          metadataKey: PHASE_REMINDER_METADATA_KEY,
        });
      },
    })(event);
    expect(partsWithCache(event)).toEqual([
      { id: 'u', part: foreignPart },
      {
        id: 'tool',
        part: { type: 'tool-result', text: 'ok', cache: { type: 'ephemeral' } },
      },
    ]);
    expect(event.messages[0]?.content[0]).toBe(foreignPart);
  });

  test('inline board on a user turn owns the single cache mark', async () => {
    const event = makeEvent([
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
    await createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async (_input, output) => {
        appendTaggedSyntheticPart(output.messages[0] as never, {
          text: 'reminder',
          metadataKey: PHASE_REMINDER_METADATA_KEY,
        });
        appendTaggedSyntheticPart(output.messages[0] as never, {
          text: 'inline board',
          metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
        });
      },
    })(event);
    const board = event.messages[0]?.content.at(-1);
    expect(isTaggedPart(board, BACKGROUND_JOB_BOARD_METADATA_KEY)).toBe(true);
    expect(partsWithCache(event)).toEqual([{ id: 'u', part: board }]);
    expect(board?.cache).toEqual({ type: 'ephemeral' });
  });

  test('T3: user queue marks exactly its last part, not the trailing board', async () => {
    const userPart = { type: 'text', text: 'new user request' };
    const event = makeEvent([{ id: 'u', role: 'user', content: [userPart] }]);
    await createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async (_input, output) => {
        appendTrailingVolatileMessage(
          output.messages,
          { id: 'board', role: 'user' },
          { text: 'volatile', metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY },
        );
      },
    })(event);
    expect(partsWithCache(event)).toEqual([
      { id: 'u', part: { ...userPart, cache: { type: 'ephemeral' } } },
    ]);
    expect('cache' in userPart).toBe(false);
  });

  test('T6: four-slot host policy leaves the deepest breakpoint readable next request', async () => {
    // Port of v2 cache-policy.ts: existing inline hints consume the 4 slots
    // first; auto then tries the last tool, first/last system, and the last
    // message (last text part, or last non-text part). OpenRouter uses only
    // the manual hints with its default policy.
    const hostMarks = (
      event: V2SessionContextEvent,
      route: 'anthropic-messages' | 'openrouter',
    ) => {
      const messages = structuredClone(event.messages);
      const existing = messages.flatMap((message) =>
        message.content.filter((part) => part.cache !== undefined),
      ).length;
      let remaining = Math.max(0, 4 - existing);
      if (route === 'anthropic-messages') {
        if (remaining > 0) remaining -= 1; // one tool definition
        for (const index of [0, event.system.length - 1]) {
          if (index >= 0 && remaining > 0) remaining -= 1;
        }
        const last = messages.at(-1);
        if (last && remaining > 0) {
          const index = last.content.findLastIndex(
            (part) => part.type === 'text',
          );
          const target = index >= 0 ? index : last.content.length - 1;
          const part = last.content[target];
          if (part && !part.cache) {
            last.content[target] = { ...part, cache: { type: 'ephemeral' } };
          }
        }
      }
      const marked = messages.flatMap((message) =>
        message.content
          .filter((part) => part.cache !== undefined)
          .map((part) => ({ id: message.id, part })),
      );
      return { messages, deepest: marked.at(-1) };
    };
    const prefixThrough = (
      messages: V2SessionContextEvent['messages'],
      id: string,
      target: Record<string, unknown>,
    ) => {
      const parts: string[] = [];
      for (const message of messages) {
        for (const part of message.content) {
          const { cache: _cache, ...uncached } = part;
          parts.push(JSON.stringify(uncached));
          if (message.id === id && part === target) return parts.join('');
        }
      }
      throw new Error('breakpoint not found');
    };
    const history = (count: number) =>
      Array.from({ length: count }, (_, index) => [
        {
          id: `u${index}`,
          role: 'user',
          content: [{ type: 'text', text: `request ${index}` }],
        },
        {
          id: `a${index}`,
          role: 'assistant',
          content: [{ type: 'text', text: `calling ${index}` }],
        },
        {
          id: `tool${index}`,
          role: 'tool',
          content: [{ type: 'tool-result', text: `result ${index}` }],
        },
      ]).flat();
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async (_input, output) => {
        for (const message of output.messages) {
          if (message.info.role !== 'user') continue;
          appendTaggedSyntheticPart(message as never, {
            text: 'deterministic reminder',
            metadataKey: PHASE_REMINDER_METADATA_KEY,
          });
        }
        appendTrailingVolatileMessage(
          output.messages,
          { id: 'volatile', role: 'user' },
          {
            text: 'changing board',
            metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
          },
        );
      },
    });
    for (const count of [5, 8, 12]) {
      const current = makeEvent(history(count), {
        system: [
          { type: 'text', text: 'base' },
          { type: 'text', text: 'project' },
        ],
      });
      const next = makeEvent(history(count + 1), { system: current.system });
      await handler(current);
      await handler(next);
      for (const route of ['anthropic-messages', 'openrouter'] as const) {
        const { messages, deepest } = hostMarks(current, route);
        expect(deepest?.id).toBe(`tool${count - 1}`);
        if (!deepest?.id) throw new Error('missing breakpoint');
        const currentPrefix = prefixThrough(messages, deepest.id, deepest.part);
        const nextPart = next.messages
          .find((message) => message.id === deepest.id)
          ?.content.find((part) => part.type === 'tool-result');
        if (!nextPart) throw new Error('missing next tool result');
        expect(prefixThrough(next.messages, deepest.id, nextPart)).toBe(
          currentPrefix,
        );
      }
    }
  });

  test('without tagged injections, v2 does not place a manual mark', async () => {
    const event = makeEvent([
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
    await createSessionContextHandler({
      interviewHandleContext: async () => {},
      messagesTransform: async () => {},
    })(event);
    expect(partsWithCache(event)).toEqual([]);
  });
});
