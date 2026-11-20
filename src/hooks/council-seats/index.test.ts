import { describe, expect, mock, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import { createTimerHarness } from '../../utils/test-timers';
import { buildPluginInput } from '../../v2/client-shim';
import { createToolExecuteBridges } from '../../v2/setup';
import type { V2Context } from '../../v2/types';
import { createCouncilSeatHook } from './index';

const PARENT = 'ses_parent';
const CHILD = 'ses_child';
const LABEL = 'councillor-alpha';
const ANSWER = 'Seat answer.\n  Indented detail.';
const NOW = 300;
const CALL = { tool: 'task', sessionID: PARENT, callID: 'call_council' };
const PROMPT = `Question?\nSeats: ${CHILD}`;
const ARGS = { subagent_type: 'council', prompt: PROMPT };

function hostInfo(overrides: Record<string, unknown> = {}) {
  return {
    id: CHILD,
    parentID: PARENT,
    agent: LABEL,
    outcome: 'succeeded',
    time: { idle: 90 },
    ...overrides,
  };
}

function user(at: number) {
  return { info: { id: `user-${at}`, role: 'user', time: { created: at } } };
}

function answer(at: number, text = ANSWER) {
  return {
    info: {
      id: `answer-${at}`,
      role: 'assistant',
      time: { created: at, completed: at + 1 },
    },
    parts: [{ type: 'text', text }],
  };
}

function pluginInput(session: object) {
  return {
    client: { session },
    directory: '/fixture',
  } as unknown as PluginInput;
}

type HookOptions = Parameters<typeof createCouncilSeatHook>[1];

function beforeFor(input: PluginInput, options?: HookOptions) {
  return createCouncilSeatHook(input, {
    ...options,
    now: options?.now ?? (() => NOW),
    timers: options?.timers ?? createTimerHarness(),
  })['tool.execute.before'];
}

type ReadArgs = { path: { id: string } };
type Read = (args: ReadArgs) => unknown;

function fakeHost(
  {
    get = () => ({ data: hostInfo() }),
    messages = () => ({ data: [user(50), answer(60)] }),
  }: { get?: Read; messages?: Read } = {},
  options?: HookOptions,
) {
  const session = { get: mock(get), messages: mock(messages) };
  return { before: beforeFor(pluginInput(session), options), ...session };
}

function readIDs(calls: ReadArgs[][]) {
  return calls.map(([args]) => args.path.id);
}

async function assemble(before: ReturnType<typeof beforeFor>, prompt = PROMPT) {
  const args = { ...ARGS, prompt };
  await before(CALL, { args });
  return args.prompt;
}

function assembled(body: string, label = LABEL) {
  return `Question?\n\n## Seat: ${label}\n${body}`;
}

function syncFailure(): never {
  throw new Error('host unavailable');
}

async function rejectedRead() {
  syncFailure();
}

describe('council seat hook', () => {
  test.each([
    ['another tool', { tool: 'edit' }, ARGS],
    ['task control', { tool: 'TASK_STATUS' }, ARGS],
    [
      'raw subagent call',
      { tool: 'subagent' },
      { agent: 'council', prompt: PROMPT },
    ],
    ['unnormalized agent key', {}, { agent: 'council', prompt: PROMPT }],
    ['missing session', { sessionID: undefined }, ARGS],
    ['blank session', { sessionID: ' \t' }, ARGS],
    ['absent args', {}, undefined],
    ['string args', {}, PROMPT],
    ['array args', {}, [PROMPT]],
    [
      'similarly named agent',
      {},
      { ...ARGS, subagent_type: 'councillor-alpha' },
    ],
    ['differently cased agent', {}, { ...ARGS, subagent_type: 'Council' }],
    ['non-string prompt', {}, { ...ARGS, prompt: { text: PROMPT } }],
  ] as const)('leaves %s untouched', async (_name, call, args) => {
    const host = fakeHost();
    const output = { args: structuredClone(args) };
    await host.before({ ...CALL, ...call }, output);
    expect(output.args).toEqual(args);
    expect(host.get).not.toHaveBeenCalled();
    expect(host.messages).not.toHaveBeenCalled();
  });

  test.each([
    '  Synthesize this pasted context.\n\n## Seat: old\nAnswer  \n\n',
    `Question?\nseats: ${CHILD}\n`,
    `Question?\n  Seats: ${CHILD}\n`,
    'Question?\nSeats:\n\n',
  ])(
    'passes prompts without a matching line through byte-identically (%j)',
    async (prompt) => {
      const host = fakeHost();
      expect(await assemble(host.before, prompt)).toBe(prompt);
      expect(host.get).not.toHaveBeenCalled();
      expect(host.messages).not.toHaveBeenCalled();
    },
  );

  test('uses only the last matching Seats line, retaining order, duplicates and full answers', async () => {
    const beta = 'ses_Beta-2';
    const longAnswer = `${ANSWER}\n${'界'.repeat(8192)}\nTail.`;
    const kept = '  Question?  \nSeats: ses_quoted\nContext. ';
    const tail = 'Keep this suffix.  \nSeats:';
    const host = fakeHost({
      get: ({ path: { id } }) => ({
        data: hostInfo({ id, agent: id === CHILD ? `  ${LABEL} \t` : ' ' }),
      }),
      messages: ({ path: { id } }) => ({
        data: [
          user(50),
          answer(60, id === CHILD ? longAnswer : 'Beta answer.'),
        ],
      }),
    });
    const args = {
      subagent_type: '  council  ',
      prompt: `${kept}\nSeats:\t${CHILD},, ${beta}, ${CHILD}  ,\n${tail}\n\n`,
    };
    await host.before({ ...CALL, tool: 'TASK' }, { args });
    expect(args.prompt).toBe(
      `${kept}\n${tail}\n\n## Seat: ${LABEL}\n${longAnswer}\n\n## Seat: ${beta}\nBeta answer.\n\n## Seat: ${LABEL}\n${longAnswer}`,
    );
    expect(readIDs(host.get.mock.calls)).toEqual([CHILD, beta, CHILD]);
    expect(readIDs(host.messages.mock.calls)).toEqual([CHILD, beta, CHILD]);
  });

  test.each(['Seats: ,  ,', 'Seats: \t'])(
    'reports an empty list without reads (%j)',
    async (line) => {
      const host = fakeHost();
      expect(await assemble(host.before, `Question?  \n\n${line}\n\n`)).toBe(
        'Question?  \n\n[no seat references were provided]',
      );
      expect(host.get).not.toHaveBeenCalled();
      expect(host.messages).not.toHaveBeenCalled();
    },
  );

  test.each(['councillor-1', 'ses_', 'ses_child!', 'prefix ses_child'])(
    'does not look up an inexact session ref (%j)',
    async (ref) => {
      const host = fakeHost();
      expect(await assemble(host.before, `Question?\nSeats: ${ref}`)).toBe(
        assembled('[no response — unresolved ref]', ref),
      );
      expect(host.get).not.toHaveBeenCalled();
      expect(host.messages).not.toHaveBeenCalled();
    },
  );
});

describe('council seat attribution', () => {
  test.each([
    ['ses_other_parent', 'session belongs to another parent'],
    [undefined, 'session has no parent'],
  ] as const)(
    'requires the exact parent before a transcript read (%j)',
    async (parentID, reason) => {
      const host = fakeHost({ get: () => ({ data: hostInfo({ parentID }) }) });
      expect(await assemble(host.before)).toBe(
        assembled(`[no response — ${reason}]`, CHILD),
      );
      expect(readIDs(host.get.mock.calls)).toEqual([CHILD]);
      expect(host.messages).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['synchronous throw', syncFailure],
    ['rejection', rejectedRead],
    ['error payload', () => ({ error: 'unavailable', data: hostInfo() })],
    ['absent session', () => ({ data: undefined })],
  ] as const)(
    'contains a host session read failure (%s)',
    async (_name, get) => {
      const host = fakeHost({ get });
      expect(await assemble(host.before)).toBe(
        assembled('[no response — session unreadable]', CHILD),
      );
      expect(host.messages).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['synchronous throw', syncFailure, 'transcript unreadable'],
    [
      'error payload',
      () => ({ error: 'unavailable' }),
      'transcript unreadable',
    ],
    [
      'no input',
      () => ({ data: [answer(60)] }),
      'seat prompt boundary unknown',
    ],
  ] as const)(
    'does not guess when child transcript evidence is missing (%s)',
    async (_name, messages, reason) => {
      const host = fakeHost({ messages });
      expect(await assemble(host.before)).toBe(
        assembled(`[no response — ${reason}]`),
      );
      expect(readIDs(host.messages.mock.calls)).toEqual([CHILD]);
    },
  );

  test.each([
    ['pending', { outcome: undefined, time: {} }, 'still running'],
    ['failed', { outcome: 'failed' }, 'failed'],
    ['interrupted', { outcome: 'interrupted' }, 'failed'],
    ['partial projection', { time: {} }, 'host outcome and idle time disagree'],
  ] as const)(
    'requires terminal success before including text (%s)',
    async (_name, info, reason) => {
      const host = fakeHost({ get: () => ({ data: hostInfo(info) }) });
      expect(await assemble(host.before)).toBe(
        assembled(`[no response — ${reason}]`),
      );
    },
  );

  test.each([undefined, ' \t\n'])(
    'a completed round without usable answer text is empty (%j)',
    async (text) => {
      const host = fakeHost({
        messages: () => ({
          data: text === undefined ? [user(50)] : [user(50), answer(60, text)],
        }),
      });
      expect(await assemble(host.before)).toBe(
        assembled('[no response — empty result]'),
      );
    },
  );

  test.each([
    [
      'new input past the old idle',
      [user(100)],
      90,
      '[no response — still running]',
    ],
    [
      'assistant newer than observed idle',
      [user(80), answer(100)],
      90,
      '[no response — still running]',
    ],
    ['new completed round', [user(100), answer(110)], 120, ANSWER],
  ] as const)(
    'uses evidence only from the newest round (%s)',
    async (_name, tail, idle, body) => {
      const host = fakeHost({
        get: () => ({ data: hostInfo({ time: { idle } }) }),
        messages: () => ({
          data: [user(50), answer(60, 'OLD ANSWER'), ...tail],
        }),
      });
      expect(await assemble(host.before)).toBe(assembled(body));
    },
  );

  test.each([
    ['same-turn dispatch', 200, 230, ANSWER],
    ['later idle for an earlier input', 299, 330, ANSWER],
    [
      'input at synthesis start',
      300,
      330,
      '[no response — seat prompt is newer than the synthesis call]',
    ],
    [
      'input after synthesis start',
      301,
      330,
      '[no response — seat prompt is newer than the synthesis call]',
    ],
  ] as const)(
    'uses the synthesis-start cutoff, not the parent input or idle time (%s)',
    async (_name, at, idle, body) => {
      let clock = NOW;
      const host = fakeHost(
        {
          get: () => {
            clock = NOW + 100;
            return { data: hostInfo({ time: { idle } }) };
          },
          messages: ({ path: { id } }) => ({
            data: id === PARENT ? [user(25)] : [user(at), answer(at + 10)],
          }),
        },
        { now: () => clock },
      );
      expect(await assemble(host.before)).toBe(assembled(body));
      expect(readIDs(host.get.mock.calls)).toEqual([CHILD]);
      expect(readIDs(host.messages.mock.calls)).toEqual([CHILD]);
    },
  );

  test('uses the SDK session receiver for each read', async () => {
    const session = {
      _client: 'receiver',
      get: mock(function (this: { _client: string }, args: ReadArgs) {
        expect(this?._client).toBe('receiver');
        expect(args).toEqual({
          path: { id: CHILD },
          query: { directory: '/fixture' },
        });
        return Promise.resolve({ data: hostInfo() });
      }),
      messages: mock(function (this: { _client: string }, args: ReadArgs) {
        expect(this?._client).toBe('receiver');
        expect(args.path.id).toBe(CHILD);
        return Promise.resolve({ data: [user(50), answer(60)] });
      }),
    };
    expect(await assemble(beforeFor(pluginInput(session)))).toBe(
      assembled(ANSWER),
    );
    expect(session.get).toHaveBeenCalledTimes(1);
    expect(session.messages).toHaveBeenCalledTimes(1);
  });

  test('contains a synchronous failure accessing the session API', async () => {
    const before = beforeFor(
      pluginInput({
        get get() {
          return syncFailure();
        },
      }),
    );
    expect(
      await assemble(before, `Question?\nSeats: ${CHILD}, ses_another`),
    ).toBe(
      `${assembled('[no response — resolver error]', CHILD)}\n\n## Seat: ses_another\n[no response — resolver error]`,
    );
  });

  test('runs seats in parallel under one default five-second read budget', async () => {
    const timers = createTimerHarness();
    const delayedInfo = Promise.withResolvers<unknown>();
    const held = Promise.withResolvers<unknown>().promise;
    const host = fakeHost(
      {
        get: ({ path: { id } }) => {
          if (id === CHILD) return delayedInfo.promise;
          if (id === 'ses_held') return held;
          return { data: hostInfo({ id, agent: 'councillor-fast' }) };
        },
        messages: ({ path: { id } }) =>
          id === CHILD ? held : { data: [user(50), answer(60)] },
      },
      { timers, now: () => NOW + timers.now() },
    );
    const call = assemble(
      host.before,
      `Question?\nSeats: ${CHILD}, ses_held, ses_fast`,
    );
    await timers.tick();
    expect(readIDs(host.get.mock.calls)).toEqual([
      CHILD,
      'ses_held',
      'ses_fast',
    ]);
    expect(readIDs(host.messages.mock.calls)).toEqual(['ses_fast']);

    await timers.advance(4_000);
    delayedInfo.resolve({ data: hostInfo() });
    await timers.tick();
    expect(readIDs(host.messages.mock.calls)).toEqual(['ses_fast', CHILD]);
    await timers.advance(999);
    expect(timers.pending()).toBe(2);
    await timers.advance(1);
    expect(timers.pending()).toBe(0);
    expect(await call).toBe(
      `${assembled('[no response — transcript unreadable]')}\n\n## Seat: ses_held\n[no response — session unreadable]\n\n## Seat: councillor-fast\n${ANSWER}`,
    );
  });
});

test('the real V2 bridge normalizes subagent and serializes the rewritten input', async () => {
  const session = {
    get: mock(async () => hostInfo()),
    context: mock(async () => [
      { id: 'msg_seat', type: 'user', time: 50, text: 'Seat prompt' },
      {
        id: 'msg_answer',
        type: 'assistant',
        time: { created: 60, completed: 70 },
        content: [{ type: 'text', text: ANSWER }],
      },
    ]),
  };
  const input = buildPluginInput({
    session,
  } as unknown as V2Context) as unknown as PluginInput;
  const before = beforeFor(input);
  const original = {
    agent: 'council',
    description: 'Synthesize the seats',
    sessionID: 'ses_previous_synthesis',
    model: 'test/model',
    prompt: PROMPT,
  };
  const event = {
    tool: 'subagent',
    sessionID: PARENT,
    id: CALL.callID,
    agent: 'orchestrator',
    messageID: 'msg_parent',
    input: original,
  };
  const { beforeBridge } = createToolExecuteBridges(async (call, output) => {
    expect(call).toEqual(CALL);
    expect(output.args).toEqual({
      ...ARGS,
      description: original.description,
      task_id: original.sessionID,
      model: original.model,
    });
    await before(call, output);
  }, undefined);
  await beforeBridge(event);
  expect(JSON.parse(JSON.stringify(event.input))).toEqual({
    ...original,
    prompt: assembled(ANSWER),
  });
  expect(original.prompt).toBe(PROMPT);
  expect(session.get.mock.calls).toEqual([[{ sessionID: CHILD }]]);
  expect(session.context.mock.calls).toEqual([[{ sessionID: CHILD }]]);
});

test('assembles seats for the finalized renamed Council identity', async () => {
  const host = fakeHost({}, { isCouncilAgent: (name) => name === 'judge' });
  const args = { ...ARGS, subagent_type: '  judge  ' };
  await host.before(CALL, { args });
  expect(args.prompt).toBe(assembled(ANSWER));
  expect(host.get).toHaveBeenCalledTimes(1);
});
