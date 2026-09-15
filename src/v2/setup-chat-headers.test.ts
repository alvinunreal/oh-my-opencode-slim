import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createInternalAgentTextPart } from '../utils/internal-initiator';
import { buildPluginInput } from './client-shim';
import {
  __resetInternalAdmissionsForTesting,
  createInternalSyntheticMessageID,
  isInternalAdmission,
  recordInternalAdmission,
} from './internal-admissions';
import {
  __resetChatHeadersOrderingTripwireForTesting,
  type ChatHeaderSessionStates,
  createChatHeadersBridge,
  createSessionContextHandler,
  createSessionPromptBridge,
  observeChatHeaderState,
} from './setup';
import type {
  V2Context,
  V2SessionContextEvent,
  V2SessionModelRequestEvent,
  V2SessionPromptEvent,
} from './types';

const INTERNAL_KEY = 'oh-my-opencode-slim.internalInitiator';

function makeContextEvent(
  messages: Array<{
    id?: string;
    role: string;
    content?: unknown[];
    metadata?: Record<string, unknown>;
  }>,
  sessionID = 'ses_hdr',
): V2SessionContextEvent {
  return {
    sessionID,
    agent: 'orchestrator',
    model: {},
    system: [],
    tools: {},
    messages: messages as V2SessionContextEvent['messages'],
  };
}

function makeModelRequestEvent(
  overrides?: Partial<V2SessionModelRequestEvent>,
): V2SessionModelRequestEvent {
  return {
    sessionID: 'ses_hdr',
    agent: 'orchestrator',
    model: { id: 'claude-sonnet-4.6', providerID: 'github-copilot' },
    kind: 'primary',
    headers: {},
    ...overrides,
  };
}

describe('observeChatHeaderState', () => {
  let states: ChatHeaderSessionStates;

  beforeEach(() => {
    states = new Map();
    __resetInternalAdmissionsForTesting();
  });

  // NOTE: FIFO eviction itself is intentionally not unit-tested — it is
  // the shared `pruneSessionMap` bound (MAX_PROMPT_BRIDGE_SESSIONS),
  // already exercised by the prompt-bridge suite; pinning the numeric
  // bound here would only couple this suite to an internal constant.

  test('marks internal from the trailing user message envelope metadata', () => {
    observeChatHeaderState(
      states,
      makeContextEvent([
        { id: 'msg_1', role: 'assistant', content: [] },
        {
          id: 'msg_2',
          role: 'user',
          content: [{ type: 'text', text: 'wake reminder' }],
          metadata: { [INTERNAL_KEY]: true },
        },
      ]),
    );

    expect(states.get('ses_hdr')).toEqual({
      messageID: 'msg_2',
      internal: true,
    });
  });

  test('marks internal from a recorded admission (synthetic path)', () => {
    // Synthetic admissions: metadata is dropped from the LLM envelope, so
    // the shim records the admission id instead (see client-shim tests).
    recordInternalAdmission('ses_hdr', 'msg_syn');

    observeChatHeaderState(
      states,
      makeContextEvent([
        { id: 'msg_syn', role: 'user', content: [{ type: 'text', text: 'x' }] },
      ]),
    );

    expect(states.get('ses_hdr')).toEqual({
      messageID: 'msg_syn',
      internal: true,
    });
  });

  test('a later ordinary trailing user message resets the marker', () => {
    recordInternalAdmission('ses_hdr', 'msg_syn');
    observeChatHeaderState(
      states,
      makeContextEvent([
        { id: 'msg_syn', role: 'user', content: [{ type: 'text', text: 'x' }] },
      ]),
    );

    observeChatHeaderState(
      states,
      makeContextEvent([{ id: 'msg_user', role: 'user', content: [] }]),
    );

    expect(states.get('ses_hdr')).toEqual({
      messageID: 'msg_user',
      internal: false,
    });
  });

  test('keeps the previous state when the event has no trailing user message', () => {
    observeChatHeaderState(
      states,
      makeContextEvent([
        {
          id: 'msg_2',
          role: 'user',
          content: [],
          metadata: { [INTERNAL_KEY]: true },
        },
      ]),
    );
    observeChatHeaderState(states, makeContextEvent([]));

    expect(states.get('ses_hdr')?.internal).toBe(true);
  });

  test('does not trust marker metadata on assistant messages', () => {
    observeChatHeaderState(
      states,
      makeContextEvent([
        {
          id: 'msg_a',
          role: 'assistant',
          content: [],
          metadata: { [INTERNAL_KEY]: true },
        },
      ]),
    );

    expect(states.has('ses_hdr')).toBe(false);
  });

  test('tool-loop scan-back relearns an earlier internal user message', () => {
    // Mid tool loop the trailing context message is the assistant's
    // tool-result turn; trailingUserMessage scans back to the last USER
    // message, so the internal wake driving the loop is relearned (this
    // is the scan-back path, distinct from the keep-stale path above,
    // which only applies when the event carries NO user message at all).
    observeChatHeaderState(
      states,
      makeContextEvent([
        {
          id: 'msg_wake',
          role: 'user',
          content: [{ type: 'text', text: 'wake reminder' }],
          metadata: { [INTERNAL_KEY]: true },
        },
        {
          id: 'msg_tool_turn',
          role: 'assistant',
          content: [{ type: 'tool-result', id: 'call_1' }],
        },
      ]),
    );

    expect(states.get('ses_hdr')).toEqual({
      messageID: 'msg_wake',
      internal: true,
    });
  });
});

describe('createChatHeadersBridge', () => {
  beforeEach(() => {
    __resetInternalAdmissionsForTesting();
    __resetChatHeadersOrderingTripwireForTesting();
  });

  test('sets x-initiator: agent for an internal Copilot primary request', async () => {
    const states: ChatHeaderSessionStates = new Map([
      ['ses_hdr', { messageID: 'msg_1', internal: true }],
    ]);
    const event = makeModelRequestEvent();

    await createChatHeadersBridge(states)(event);

    expect(event.headers['x-initiator']).toBe('agent');
  });

  test('skips non-Copilot providers', async () => {
    const states: ChatHeaderSessionStates = new Map([
      ['ses_hdr', { messageID: 'msg_1', internal: true }],
    ]);
    const event = makeModelRequestEvent({
      model: { id: 'claude-sonnet-4.6', providerID: 'anthropic' },
    });

    await createChatHeadersBridge(states)(event);

    expect(event.headers['x-initiator']).toBeUndefined();
  });

  test('covers github-copilot-enterprise too', async () => {
    const states: ChatHeaderSessionStates = new Map([
      ['ses_hdr', { messageID: 'msg_1', internal: true }],
    ]);
    const event = makeModelRequestEvent({
      model: { id: 'gpt-5', providerID: 'github-copilot-enterprise' },
    });

    await createChatHeadersBridge(states)(event);

    expect(event.headers['x-initiator']).toBe('agent');
  });

  test('skips auxiliary kinds (built-in Copilot hook owns those)', async () => {
    const states: ChatHeaderSessionStates = new Map([
      ['ses_hdr', { messageID: 'msg_1', internal: true }],
    ]);
    for (const kind of ['title', 'compaction', 'generate'] as const) {
      const event = makeModelRequestEvent({ kind });
      await createChatHeadersBridge(states)(event);
      expect(event.headers['x-initiator']).toBeUndefined();
    }
  });

  test('skips sessions whose trailing user message is not internal', async () => {
    const states: ChatHeaderSessionStates = new Map([
      ['ses_hdr', { messageID: 'msg_1', internal: false }],
    ]);
    const event = makeModelRequestEvent();

    await createChatHeadersBridge(states)(event);

    expect(event.headers['x-initiator']).toBeUndefined();
  });

  test('skips unknown sessions', async () => {
    const event = makeModelRequestEvent();

    await createChatHeadersBridge(new Map())(event);

    expect(event.headers['x-initiator']).toBeUndefined();
  });

  test('ordering tripwire: unobserved session warns once, header stays unset', async () => {
    // A primary model.request with no context-event observation for the
    // session means the host fired the request hook before/instead of the
    // context hook — the stale-marking direction. Drift canary only: the
    // warning fires ONCE per process (module-global latch, verified here
    // via the injected sink); behavior is unchanged (missing state still
    // skips the header). The default sink logs the fixed deterministic
    // text (see MODEL_REQUEST_BEFORE_CONTEXT_WARNING in setup.ts).
    let driftWarnings = 0;
    const bridge = createChatHeadersBridge(new Map(), () => {
      driftWarnings += 1;
    });
    const first = makeModelRequestEvent();
    const second = makeModelRequestEvent();

    await bridge(first);
    await bridge(second);

    expect(driftWarnings).toBe(1);
    expect(first.headers['x-initiator']).toBeUndefined();
    expect(second.headers['x-initiator']).toBeUndefined();
  });

  test('ordering tripwire stays silent for auxiliary kinds and observed sessions', async () => {
    let driftWarnings = 0;
    const sink = () => {
      driftWarnings += 1;
    };
    const states: ChatHeaderSessionStates = new Map([
      ['ses_hdr', { messageID: 'msg_1', internal: false }],
    ]);
    // Auxiliary kinds never see context events (title/compaction/generate
    // run their own hook shapes) — must not trip the canary.
    await createChatHeadersBridge(
      new Map(),
      sink,
    )(makeModelRequestEvent({ kind: 'title' }));
    // Observed session (marker false): no warning, no header.
    await createChatHeadersBridge(states, sink)(makeModelRequestEvent());

    expect(driftWarnings).toBe(0);
  });

  test('escalation-only: never rewrites a pre-set agent value', async () => {
    // Mirrors the upstream fetch-layer contract (built-in Copilot hook /
    // applyHeaders): a pre-set x-initiator: agent is honored, never
    // touched; a lower value (or none) escalates to agent.
    const states: ChatHeaderSessionStates = new Map([
      ['ses_hdr', { messageID: 'msg_1', internal: true }],
    ]);

    const preSetAgent = makeModelRequestEvent({
      headers: { 'x-initiator': 'agent', 'x-session-affinity': 'ses_hdr' },
    });
    await createChatHeadersBridge(states)(preSetAgent);
    expect(preSetAgent.headers).toEqual({
      'x-initiator': 'agent',
      'x-session-affinity': 'ses_hdr',
    });

    const preSetUser = makeModelRequestEvent({
      headers: { 'x-initiator': 'user' },
    });
    await createChatHeadersBridge(states)(preSetUser);
    expect(preSetUser.headers['x-initiator']).toBe('agent');
  });

  test('never throws on malformed events (fail-soft, logged)', async () => {
    const states: ChatHeaderSessionStates = new Map([
      ['ses_hdr', { internal: true }],
    ]);
    const malformed = {
      sessionID: 'ses_hdr',
      model: { providerID: 'github-copilot' },
      kind: 'primary',
    } as unknown as V2SessionModelRequestEvent;

    await expect(
      createChatHeadersBridge(states)(malformed),
    ).resolves.toBeUndefined();
  });
});

describe('chat.headers context wiring', () => {
  beforeEach(() => {
    __resetInternalAdmissionsForTesting();
  });

  test('the merged context handler invokes the chat.headers observer', async () => {
    const seen: string[] = [];
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      observeChatHeaders: (event) => {
        seen.push(event.sessionID);
      },
    });

    await handler(makeContextEvent([{ id: 'm1', role: 'user', content: [] }]));

    expect(seen).toEqual(['ses_hdr']);
  });

  test('an observer throw does not break the rest of the handler', async () => {
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      observeChatHeaders: () => {
        throw new Error('boom');
      },
    });

    await expect(
      handler(makeContextEvent([{ id: 'm1', role: 'user', content: [] }])),
    ).resolves.toBeUndefined();
  });

  test('end to end: context event then model request sets the header', async () => {
    const states: ChatHeaderSessionStates = new Map();
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      observeChatHeaders: (event) => observeChatHeaderState(states, event),
    });

    await handler(
      makeContextEvent([
        {
          id: 'msg_wake',
          role: 'user',
          content: [{ type: 'text', text: 'wake' }],
          metadata: { [INTERNAL_KEY]: true },
        },
      ]),
    );
    const event = makeModelRequestEvent();
    await createChatHeadersBridge(states)(event);

    expect(event.headers['x-initiator']).toBe('agent');
  });
});

describe('internal admission recording', () => {
  beforeEach(() => {
    __resetInternalAdmissionsForTesting();
  });

  test('prompt-hook admissions with internal metadata are recorded', async () => {
    const chatMessage = mock(async () => {});
    const bridge = createSessionPromptBridge(chatMessage);
    const event = {
      sessionID: 'ses_hdr',
      messageID: 'msg_adm_1',
      prompt: { text: 'wake reminder' },
      metadata: { [INTERNAL_KEY]: true },
    } as V2SessionPromptEvent;

    await bridge.handlePrompt(event);

    expect(isInternalAdmission('ses_hdr', 'msg_adm_1')).toBe(true);
  });

  test('ordinary prompt admissions are not recorded', async () => {
    const chatMessage = mock(async () => {});
    const bridge = createSessionPromptBridge(chatMessage);
    const event = {
      sessionID: 'ses_hdr',
      messageID: 'msg_adm_2',
      prompt: { text: 'user says hi' },
    } as V2SessionPromptEvent;

    await bridge.handlePrompt(event);

    expect(isInternalAdmission('ses_hdr', 'msg_adm_2')).toBe(false);
  });

  test('shim synthetic admissions pass a msg_-prefixed id and are recorded', async () => {
    const seq: Array<{ m: string; i: unknown }> = [];
    const input = buildPluginInput({
      app: { name: 'opencode2', version: 'test' },
      options: {},
      agent: {
        transform: async () => ({ dispose() {} }),
        reload: async () => {},
        list: async () => [],
      },
      tool: {
        transform: async () => ({ dispose() {} }),
        hook: async () => ({ dispose() {} }),
      },
      command: {
        transform: async () => ({ dispose() {} }),
        list: async () => [],
      },
      session: {
        hook: async () => ({ dispose() {} }),
        synthetic: async (i: unknown) => {
          seq.push({ m: 'synthetic', i });
          return { admitted: true };
        },
      },
      event: { subscribe: () => ({}) as never },
    } as never as V2Context);

    await (
      input.client as {
        session: {
          promptAsync: (a: Record<string, unknown>) => Promise<unknown>;
        };
      }
    ).session.promptAsync({
      path: { id: 'ses_syn' },
      body: {
        agent: 'orchestrator',
        parts: [createInternalAgentTextPart('wake reminder')],
      },
      delivery: 'queue',
    });

    expect(seq).toHaveLength(1);
    const admitted = seq[0].i as { id?: string };
    expect(admitted.id).toMatch(/^msg_/);
    expect(isInternalAdmission('ses_syn', admitted.id ?? '')).toBe(true);
  });

  test('synthetic admission id matches the context-event message id end to end', () => {
    const id = createInternalSyntheticMessageID();
    recordInternalAdmission('ses_syn', id);
    const states: ChatHeaderSessionStates = new Map();

    observeChatHeaderState(
      states,
      makeContextEvent(
        [{ id, role: 'user', content: [{ type: 'text', text: 'wake' }] }],
        'ses_syn',
      ),
    );

    expect(states.get('ses_syn')?.internal).toBe(true);
  });
});
