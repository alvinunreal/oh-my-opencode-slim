/**
 * Native council seat assembly (boardless, managed lifecycle OFF).
 *
 * The resolver reads the host session domain directly: one `session.get`
 * + one transcript per seat, every read bounded by one whole-call deadline
 * driven by the deterministic timer harness — no real sleeps, no polling,
 * no retries.
 */
import { describe, expect, test } from 'bun:test';

import type { PluginInput } from '@opencode-ai/plugin';

import { createTimerHarness } from '../../utils/test-timers';
import { createCouncilSeatHook } from './index';
import { createNativeSeatResolver, type NativeSeatTimers } from './native';

const PARENT = 'ses_parent';
const CHILD = 'ses_child';
const OTHER_PARENT = 'ses_other';

/** Build one transcript message. */
function message(input: {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text?: string;
  created?: number;
  completed?: number;
  error?: unknown;
  finish?: string;
  parentID?: string;
}): Record<string, unknown> {
  return {
    info: {
      id: input.id,
      role: input.role,
      ...(input.parentID ? { parentID: input.parentID } : {}),
      ...(input.created !== undefined
        ? { time: { created: input.created } }
        : {}),
      ...(input.completed !== undefined
        ? { time: { created: input.created, completed: input.completed } }
        : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.finish !== undefined ? { finish: input.finish } : {}),
    },
    parts: input.text === undefined ? [] : [{ type: 'text', text: input.text }],
  };
}

/** A child transcript whose latest user input is at `at`. */
function childTranscript(at: number, text?: string): unknown {
  const messages = [
    message({ id: 'msg_seat', role: 'user', text: 'seat prompt', created: at }),
  ];
  if (text !== undefined) {
    messages.push(
      message({
        id: 'msg_seat_answer',
        role: 'assistant',
        text,
        created: at + 10,
        completed: at + 20,
      }),
    );
  }
  return { data: messages };
}

interface SeatFixture {
  transcripts?: Record<string, unknown>;
  hostInfos?: Record<string, Record<string, unknown>>;
  /** v2 host info writes outcome + idle; omit for a pending round. */
}

/** Fake host client. Any method not provided rejects never (so a budget
 * test can hold it open) — callers always pass what they need. */
function fakeInput(
  fixture: SeatFixture,
  options: { hostFlavor?: 'v2' } = {},
): PluginInput {
  const client = {
    session: {
      messages: async (args: Record<string, unknown>) => {
        const id = (args?.path as { id?: string } | undefined)?.id ?? '';
        return fixture.transcripts?.[id] ?? { data: [] };
      },
      get: async (args: Record<string, unknown>) => {
        const id = (args?.path as { id?: string } | undefined)?.id ?? '';
        return { data: fixture.hostInfos?.[id] ?? { id } };
      },
    },
  };
  return {
    client,
    directory: '/tmp',
    ...(options.hostFlavor ? { hostFlavor: options.hostFlavor } : {}),
  } as unknown as PluginInput;
}

/** Default: one completed child at 50. */
function defaultFixture(overrides: SeatFixture = {}): SeatFixture {
  return {
    transcripts: {
      [CHILD]: childTranscript(50, 'CHILD VERBATIM TEXT'),
    },
    hostInfos: {
      [CHILD]: {
        id: CHILD,
        parentID: PARENT,
        agent: 'councillor-alpha',
        outcome: 'succeeded',
        time: { created: 1, idle: 90 },
      },
    },
    ...overrides,
  };
}

async function resolve(
  fixture: SeatFixture,
  refs: string[],
  options: {
    hostFlavor?: 'v2';
    timeoutMs?: number;
    now?: () => number;
    timers?: NativeSeatTimers;
  } = {},
) {
  const input = fakeInput(fixture, { hostFlavor: options.hostFlavor });
  const resolver = createNativeSeatResolver(input, {
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.timers ? { timers: options.timers } : {}),
  });
  return resolver(
    PARENT,
    refs.map((ref) => ({
      seat: ref,
      ...(ref.startsWith('ses_') ? { childID: ref } : {}),
    })),
  );
}

async function runHook(
  fixture: SeatFixture,
  prompt: string,
  options: { hostFlavor?: 'v2'; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const input = fakeInput(fixture, { hostFlavor: options.hostFlavor });
  const hook = createCouncilSeatHook({
    resolveSeats: createNativeSeatResolver(input, {
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
    }),
  });
  const args: Record<string, unknown> = {
    subagent_type: 'council',
    prompt,
    background: false,
  };
  await hook['tool.execute.before'](
    { tool: 'task', sessionID: PARENT, callID: 'call_council' },
    { args },
  );
  return args;
}

describe('native council seat resolver (v2)', () => {
  test('a completed child inlines its answer text with the host agent label', async () => {
    const results = await resolve(defaultFixture(), [CHILD], {
      hostFlavor: 'v2',
    });
    expect(results).toEqual([
      {
        kind: 'completed',
        text: 'CHILD VERBATIM TEXT',
        label: 'councillor-alpha',
      },
    ]);
  });

  test('a child belonging to another parent is missing, never resolved', async () => {
    const fixture = defaultFixture();
    fixture.hostInfos = {
      [CHILD]: { id: CHILD, parentID: OTHER_PARENT, agent: 'councillor-alpha' },
    };
    const results = await resolve(fixture, [CHILD], { hostFlavor: 'v2' });
    expect(results[0]?.kind).toBe('missing');
  });

  test('a host round with no terminal outcome is still running', async () => {
    const fixture = defaultFixture();
    fixture.hostInfos = {
      [CHILD]: { id: CHILD, parentID: PARENT, agent: 'councillor-alpha' },
    };
    const results = await resolve(fixture, [CHILD], { hostFlavor: 'v2' });
    expect(results[0]?.kind).toBe('running');
  });

  test('a completed host round without answer text is empty, not completed', async () => {
    const fixture = defaultFixture();
    fixture.transcripts = {
      ...fixture.transcripts,
      [CHILD]: childTranscript(50),
    };
    const results = await resolve(fixture, [CHILD], { hostFlavor: 'v2' });
    expect(results[0]?.kind).toBe('empty');
  });

  test('a seat dispatched after the parent question resolves (same-turn council)', async () => {
    // Foreground seats are launched and collected within the same turn:
    // their prompts are newer than the parent's user input. The trailing
    // round is the seat's answer and must resolve.
    const fixture = defaultFixture();
    fixture.transcripts = {
      ...fixture.transcripts,
      [CHILD]: childTranscript(200, 'FRESH SEAT ANSWER'),
    };
    fixture.hostInfos = {
      [CHILD]: {
        id: CHILD,
        parentID: PARENT,
        agent: 'councillor-alpha',
        outcome: 'succeeded',
        time: { created: 1, idle: 230 },
      },
    };
    const results = await resolve(fixture, [CHILD], { hostFlavor: 'v2' });
    expect(results[0]?.kind).toBe('completed');
    expect(results[0]).toHaveProperty('text', 'FRESH SEAT ANSWER');
  });

  test('an unreadable session is ambiguous, never a guess', async () => {
    const input = fakeInput(defaultFixture(), { hostFlavor: 'v2' });
    const rejecting = {
      ...input,
      client: {
        session: {
          messages: async () => ({ data: [] }),
          get: async () => {
            throw new Error('host unavailable');
          },
        },
      },
    } as unknown as PluginInput;
    const resolver = createNativeSeatResolver(rejecting);
    const results = await resolver(PARENT, [{ seat: CHILD, childID: CHILD }]);
    expect(results[0]?.kind).toBe('ambiguous');
  });

  test('session.get runs on the session receiver it was read from', async () => {
    // SDK-generated session methods read `this._client`: a detached
    // invocation sees no client, so this fixture resolves only when the
    // resolver binds the receiver. No extra host calls: one get + one
    // transcript per seat.
    const receivers: unknown[] = [];
    let getCalls = 0;
    let messagesCalls = 0;
    const session = {
      _client: 'receiver-marker',
      get(this: { _client?: string }, args: { path: { id: string } }) {
        getCalls += 1;
        receivers.push(this?._client);
        return Promise.resolve({
          data: {
            id: args.path.id,
            parentID: PARENT,
            agent: 'councillor-alpha',
            outcome: 'succeeded',
            time: { created: 1, idle: 90 },
          },
        });
      },
      messages: async () => {
        messagesCalls += 1;
        return childTranscript(50, 'RECEIVER BOUND ANSWER');
      },
    };
    const input = {
      client: { session },
      directory: '/tmp',
      hostFlavor: 'v2',
    } as unknown as PluginInput;
    const resolver = createNativeSeatResolver(input);
    const results = await resolver(PARENT, [{ seat: CHILD, childID: CHILD }]);
    expect(results[0]).toMatchObject({
      kind: 'completed',
      text: 'RECEIVER BOUND ANSWER',
    });
    expect(receivers).toEqual(['receiver-marker']);
    expect(getCalls).toBe(1);
    expect(messagesCalls).toBe(1);
  });

  test('a session.get that throws synchronously degrades to ambiguous', async () => {
    // Sync throws must never reject the resolver call: absence of evidence,
    // never a throw.
    let messagesCalls = 0;
    const input = {
      client: {
        session: {
          get: () => {
            throw new Error('sync host failure');
          },
          messages: async () => {
            messagesCalls += 1;
            return { data: [] };
          },
        },
      },
      directory: '/tmp',
      hostFlavor: 'v2',
    } as unknown as PluginInput;
    const resolver = createNativeSeatResolver(input);
    const results = await resolver(PARENT, [{ seat: CHILD, childID: CHILD }]);
    expect(results[0]).toMatchObject({
      kind: 'ambiguous',
      reason: 'session unreadable',
    });
    // The transcript read is never reached after the unreadable session.
    expect(messagesCalls).toBe(0);
  });

  test('a missing session id ref never resolves', async () => {
    const results = await resolve(defaultFixture(), ['ses_absent'], {
      hostFlavor: 'v2',
    });
    expect(results[0]?.kind).toBe('ambiguous');
  });

  test('an unreadable child transcript is ambiguous, never a guess', async () => {
    const fixture = defaultFixture();
    fixture.transcripts = {};
    const results = await resolve(fixture, [CHILD], { hostFlavor: 'v2' });
    expect(results[0]?.kind).toBe('ambiguous');
  });

  test('end-to-end through the hook: completed text is inlined', async () => {
    const args = await runHook(
      defaultFixture(),
      'Question?\nSeats: ses_child',
      { hostFlavor: 'v2' },
    );
    expect(args.prompt).toBe(
      [
        'Question?',
        '',
        '## Seat: councillor-alpha',
        'CHILD VERBATIM TEXT',
      ].join('\n'),
    );
  });

  test('non-session refs are missing', async () => {
    const results = await resolve(defaultFixture(), ['councillor-1'], {
      hostFlavor: 'v2',
    });
    expect(results[0]?.kind).toBe('missing');
  });

  test('the whole call is bounded by one deadline: a held host read yields placeholders', async () => {
    const timers = createTimerHarness();
    // A client whose reads never settle.
    const held = {
      client: {
        session: {
          messages: () => new Promise(() => {}),
          get: () => new Promise(() => {}),
        },
      },
      directory: '/tmp',
      hostFlavor: 'v2',
    } as unknown as PluginInput;
    const resolver = createNativeSeatResolver(held, {
      timeoutMs: 100,
      timers,
      now: timers.now,
    });
    const call = resolver(PARENT, [{ seat: CHILD, childID: CHILD }]);
    await timers.advance(100);
    const results = await call;
    expect(results[0]?.kind).toBe('ambiguous');
    // No timer is left pending: the budget released the whole call.
    expect(timers.pending()).toBe(0);
  });
});

describe('native council seat resolver synthesis-time cutoff', () => {
  // Oracle decision: the resolver stamps synthesisStartedAt synchronously and
  // fails closed on any seat prompt whose input boundary lands at or after it.
  // Injected now = 300 fixes the cutoff; the default budget keeps every read
  // well inside the deadline.
  const cutoffNow = () => 300;

  function cutoffFixture(
    childInputAt: number,
    text?: string,
    idleAt = childInputAt + 30,
  ) {
    const fixture = defaultFixture();
    fixture.transcripts = {
      ...fixture.transcripts,
      [CHILD]: childTranscript(childInputAt, text),
    };
    fixture.hostInfos = {
      [CHILD]: {
        id: CHILD,
        parentID: PARENT,
        agent: 'councillor-alpha',
        outcome: 'succeeded',
        time: { created: 1, idle: idleAt },
      },
    };
    return fixture;
  }

  test('a seat prompt before the cutoff with a trailing answer is completed', async () => {
    const results = await resolve(
      cutoffFixture(200, 'ANSWER BEFORE CUTOFF'),
      [CHILD],
      { hostFlavor: 'v2', now: cutoffNow },
    );
    expect(results[0]).toMatchObject({
      kind: 'completed',
      text: 'ANSWER BEFORE CUTOFF',
      label: 'councillor-alpha',
    });
  });

  test('host idle/outcome timestamps after the cutoff do not fail the seat', async () => {
    // The cutoff compares the child's INPUT boundary to the synthesis stamp;
    // host terminal evidence that lands after the stamp belongs to a prompt
    // the synthesis observed, so the seat still resolves.
    const results = await resolve(
      cutoffFixture(200, 'ANSWER WITH LATE HOST ROUND'),
      [CHILD],
      { hostFlavor: 'v2', now: cutoffNow },
    );
    expect(results[0]?.kind).toBe('completed');
  });

  test('a seat prompt strictly after the cutoff is ambiguous with no text', async () => {
    const results = await resolve(
      cutoffFixture(301, 'TOO LATE ANSWER'),
      [CHILD],
      { hostFlavor: 'v2', now: cutoffNow },
    );
    expect(results[0]).toMatchObject({
      kind: 'ambiguous',
      reason: 'seat prompt is newer than the synthesis call',
    });
    expect(results[0]).not.toHaveProperty('text');
  });

  test('a seat prompt exactly on the cutoff is ambiguous', async () => {
    const results = await resolve(
      cutoffFixture(300, 'EXACT CUTOFF ANSWER'),
      [CHILD],
      { hostFlavor: 'v2', now: cutoffNow },
    );
    expect(results[0]?.kind).toBe('ambiguous');
    expect(results[0]).not.toHaveProperty('text');
  });
});
