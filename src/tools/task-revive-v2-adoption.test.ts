import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  FixtureBoard as BackgroundJobBoard,
  createBackgroundJobLifecycle,
  createBackgroundJobTerminalGate,
} from '../background-jobs';
import {
  createRevivedRunTracker,
  type RevivedRunTracker,
} from '../hooks/task-session-manager/revived-run-tracker';
import {
  appendChildRefSuffix,
  createAliasAuthority,
  createSessionRecovery,
} from '../hooks/task-session-manager/session-recovery';
import * as opencodeClient from '../utils/opencode-client';
import { buildPluginInput } from '../v2/client-shim';
import type { V2Context } from '../v2/types';
import { createTaskMessageTool } from './task-message';
import { createTaskReviveTool } from './task-revive';

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  mock.restore();
});

const childID = 'ses_v2_adoption';
const parentID = 'ses_parent';
type Prompt = Parameters<NonNullable<V2Context['session']['prompt']>>[0];

function assistant(id: string, text: string) {
  return {
    id,
    type: 'assistant',
    time: { completed: Date.now() },
    content: [{ type: 'text', text }],
  };
}

function harness(
  options: {
    busy?: boolean;
    foreign?: boolean;
    parentTranscript?: unknown[];
    admit?: (prompt: Prompt) => Promise<unknown>;
  } = {},
) {
  spyOn(opencodeClient, 'getClient').mockImplementation(
    (input) => input.client,
  );
  let transcript: unknown[] = [
    { id: 'old-user', type: 'user', time: { created: 1 } },
    ...(options.busy ? [] : [assistant('old-answer', 'old result')]),
  ];
  const wait = mock(async () => {});
  const interrupt = mock(async () => {});
  const synthetic = mock(async () => ({}));
  let queued: Prompt | undefined;
  const prompt = mock(async (input: Prompt) => {
    if (!input.id) return { state: 'pending' };
    queued = input;
    expect(input.delivery).toBe('queue');
    expect(input.sessionID).toBe(childID);
    expect(input.id).toStartWith('msg_omos_revive_');
    if (!options.busy)
      transcript.push({ id: input.id, type: 'user', text: input.text });
    return options.admit
      ? options.admit(input)
      : { id: input.id, state: 'pending' };
  });
  const input = buildPluginInput({
    session: {
      get: async () => ({
        id: childID,
        parentID: options.foreign ? 'foreign' : parentID,
        agent: 'explorer',
        outcome: 'completed',
        time: { idle: Date.now() },
      }),
      context: async ({ sessionID }: { sessionID: string }) =>
        sessionID === parentID ? (options.parentTranscript ?? []) : transcript,
      wait,
      prompt,
      interrupt,
      synthetic,
    },
    location: { directory: '/test/project' },
  } as unknown as V2Context) as unknown as PluginInput;
  const board = new BackgroundJobBoard();
  let tracker: RevivedRunTracker;
  const gate = createBackgroundJobTerminalGate({
    input,
    backgroundJobBoard: board,
    baselineFor: (id: string, generation: number) =>
      tracker.baselineFor(id, generation),
    promptMessageIDFor: (id: string, generation: number) =>
      tracker.promptMessageIDFor(id, generation),
    observationRevisionFor: (id: string, generation: number) =>
      tracker.revisionFor(id, generation),
    attemptStartedAtFor: (id: string, generation: number) =>
      tracker.attemptStartedAtFor(id, generation),
    isObservationPending: (id: string, generation: number) =>
      tracker.isObservationPending(id, generation),
    graceMs: 60_000,
  });
  // One facade per board: every consumer shares it so the gate binding
  // (last bind wins) stays on this factory's gate.
  const backgroundJobs = createBackgroundJobLifecycle({
    backgroundJobBoard: board,
    gate,
  });
  const recover = createSessionRecovery({
    input,
    backgroundJobs,
    hostFlavor: 'v2',
  });
  const authority = createAliasAuthority({ input, board, hostFlavor: 'v2' });
  tracker = createRevivedRunTracker({
    input,
    backgroundJobs,
  });
  const { task_revive } = createTaskReviveTool({
    input,
    backgroundJobs,
    shouldManageSession: () => true,
    revivedRunTracker: tracker,
    recoverRetainedSession: recover,
    resolveCanonicalTaskRef: authority.resolveCanonical,
    admissionTimeoutMs: 10,
  });
  disposals.push(() => {
    tracker.dispose();
    gate.dispose();
  });
  const revive = (sessionID = childID) =>
    task_revive.execute({ sessionID, prompt: 'Continue retained work' }, {
      sessionID: parentID,
      agent: 'orchestrator',
    } as never);
  const run = () => {
    const record = board.get(childID);
    if (!record) throw new Error('Expected a tracked continuation');
    return record;
  };
  const probe = async () => {
    await tracker.probe(childID, run().generation);
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };
  return {
    input,
    board,
    tracker,
    gate,
    prompt,
    synthetic,
    interrupt,
    wait,
    revive,
    recover,
    probe,
    run,
    message: (delivery: 'queue' | 'steer') =>
      createTaskMessageTool({
        input,
        backgroundJobs: createBackgroundJobLifecycle({
          backgroundJobBoard: board,
        }),
        promptMessageIDFor: tracker.promptMessageIDFor,
      }).task_message.execute(
        { sessionID: childID, message: 'Correction', delivery },
        { sessionID: parentID } as never,
      ),
    append: (...messages: unknown[]) => transcript.push(...messages),
    deliver: () => {
      if (!queued) throw new Error('Expected a queued prompt');
      transcript.push({ id: queued.id, type: 'user', text: queued.text });
    },
    replace: (messages: unknown[]) => {
      transcript = messages;
    },
  };
}

test('steer refuses a queued revival until its exact user prompt is delivered', async () => {
  const h = harness({ busy: true });
  await h.revive();
  await expect(h.message('steer')).rejects.toThrow('queued continuation');
  expect(h.prompt).toHaveBeenCalledTimes(1);
  h.append({ id: 'unrelated', type: 'user', text: 'Different prompt' });
  await expect(h.message('steer')).rejects.toThrow('queued continuation');
  expect(h.prompt).toHaveBeenCalledTimes(1);
  h.deliver();
  await expect(h.message('steer')).resolves.toContain('accepted');
  expect(h.prompt.mock.calls[1]?.[0]).toMatchObject({
    sessionID: childID,
    delivery: 'steer',
    resume: false,
  });
  expect(h.interrupt).not.toHaveBeenCalled();
});

test('queue remains available while a revived continuation is pending', async () => {
  const h = harness({ busy: true });
  await h.revive();
  await expect(h.message('queue')).resolves.toContain('queued');
  expect(h.prompt.mock.calls[1]?.[0]).toMatchObject({
    delivery: 'queue',
    resume: false,
  });
});

test.each(['missing', 'malformed', 'error', 'timeout', 'generation'])(
  'steer fails closed when continuation evidence is %s',
  async (failure) => {
    const h = harness({ busy: true });
    await h.revive();
    h.deliver();
    const messages = spyOn(h.input.client.session, 'messages');
    if (failure === 'missing') messages.mockResolvedValue(undefined as never);
    if (failure === 'malformed')
      messages.mockResolvedValue({ data: {} } as never);
    if (failure === 'error')
      messages.mockRejectedValue(new Error('read failed'));
    if (failure === 'timeout')
      messages.mockImplementation(() => new Promise(() => {}));
    if (failure === 'generation')
      messages.mockImplementation(async () => {
        const record = h.run();
        const id = h.tracker.promptMessageIDFor(childID, record.generation);
        // Simulate an external lifecycle change during the awaited read.
        record.generation += 1;
        return { data: [{ info: { id, role: 'user' } }] } as never;
      });
    const tool = createTaskMessageTool({
      input: h.input,
      backgroundJobs: createBackgroundJobLifecycle({
        backgroundJobBoard: h.board,
      }),
      promptMessageIDFor: h.tracker.promptMessageIDFor,
      messageTimeoutMs: 5,
    }).task_message;
    await expect(
      tool.execute(
        { sessionID: childID, message: 'Correction', delivery: 'steer' },
        { sessionID: parentID } as never,
      ),
    ).rejects.toThrow();
    expect(h.prompt).toHaveBeenCalledTimes(1);
    const record = h.run();
    const lease = h.board.acquireMessageLease(childID, record.generation);
    expect(lease).toBeDefined();
    if (lease) h.board.releaseLease(lease);
  },
);

test('v2 adapter wakes an idle untracked owned session once and delivers its new answer', async () => {
  const h = harness();
  expect(h.input.client.session.status).toBeUndefined();
  expect(await h.revive()).toContain('status: started');
  expect(h.prompt).toHaveBeenCalledTimes(1);
  expect(h.wait).not.toHaveBeenCalled();
  expect(h.interrupt).not.toHaveBeenCalled();
  expect(h.synthetic).not.toHaveBeenCalled();
  h.append(assistant('new-answer', 'new result'));
  await h.probe();
  await h.probe();
  expect(h.board.get(childID)?.resultSummary).toBe('new result');
  expect(h.synthetic).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(h.synthetic.mock.calls)).toContain('new result');
  const token = h.gate.capture(h.run());
  if (!token) throw new Error('Expected an observation token');
  h.gate.observe(token, {
    kind: 'busy',
    origin: 'session.status',
    readStartedAt: token.readStartedAt,
    observedAt: Date.now() + 10,
  });
  await h.probe();
  expect(h.run().state).not.toBe('running');
  expect(h.synthetic).toHaveBeenCalledTimes(1);
});

test('busy queue ignores old completion and errors, then delivers only the new turn once', async () => {
  const h = harness({ busy: true });
  await h.revive();
  h.append(assistant('old-answer', 'old result completed after admission'));
  await h.gate.reconcile(h.run(), {
    kind: 'session-error',
    message: 'old execution failed',
  });
  await h.probe();
  expect(h.board.get(childID)?.state).toBe('running');
  expect(h.synthetic).not.toHaveBeenCalled();
  await expect(h.revive()).rejects.toThrow('already has a queued continuation');
  h.deliver();
  await h.probe();
  expect(h.board.get(childID)?.state).toBe('running');
  h.append(assistant('new-answer', 'continued result'));
  await h.probe();
  await h.probe();
  expect(h.board.get(childID)?.resultSummary).toBe('continued result');
  expect(h.synthetic).toHaveBeenCalledTimes(1);
  expect(h.prompt).toHaveBeenCalledTimes(1);
  expect(h.wait).not.toHaveBeenCalled();
  expect(h.interrupt).not.toHaveBeenCalled();
});

test('foreign ownership refuses adoption without an admission or interrupt', async () => {
  const h = harness({ foreign: true });
  await expect(h.revive()).rejects.toThrow('Unknown or unowned');
  expect(h.board.get(childID)).toBeUndefined();
  expect(h.prompt).not.toHaveBeenCalled();
  expect(h.interrupt).not.toHaveBeenCalled();
});

test('ordinary v2 recovery still refuses an incomplete round without importing it', async () => {
  const h = harness({ busy: true });
  const result = await h.recover({
    parentSessionID: parentID,
    requested: childID,
  });
  expect(result.kind).toBe('refused');
  expect(h.board.get(childID)).toBeUndefined();
  expect(h.prompt).not.toHaveBeenCalled();
});

test('ordinary v2 recovery imports a historical terminal without prompting', async () => {
  const h = harness();
  h.append({
    id: 'old-idle',
    type: 'idle',
    outcome: 'succeeded',
    time: { created: Date.now() + 1 },
  });
  const result = await h.recover({
    parentSessionID: parentID,
    requested: childID,
  });
  expect(result.kind).toBe('recovered');
  expect(h.run().resultSummary).toBe('old result');
  expect(h.prompt).not.toHaveBeenCalled();
  expect(h.synthetic).not.toHaveBeenCalled();
});

test('queued recovery refuses conflicting agent evidence before admission', async () => {
  const h = harness({ busy: true });
  h.replace([
    { id: 'old-user', type: 'user', agent: 'fixer', time: { created: 1 } },
  ]);
  await expect(h.revive()).rejects.toThrow('agent evidence conflicts');
  expect(h.board.get(childID)).toBeUndefined();
  expect(h.prompt).not.toHaveBeenCalled();
});

test('queued recovery refuses unreadable history before admission', async () => {
  const h = harness({ busy: true });
  h.replace([assistant('orphan-answer', 'no delivered input')]);
  await expect(h.revive()).rejects.toThrow('no delivered user round');
  expect(h.board.get(childID)).toBeUndefined();
  expect(h.prompt).not.toHaveBeenCalled();
});

test('a host-proven alias queues into its original busy child', async () => {
  const output = appendChildRefSuffix(
    `<task id="${childID}" state="completed">\n<task_result>old result</task_result>\n</task>`,
    {
      parentSessionID: parentID,
      sessionID: childID,
      agent: 'explorer',
      alias: 'exp-1',
    },
  );
  const h = harness({
    busy: true,
    parentTranscript: [
      {
        id: 'parent-answer',
        type: 'assistant',
        time: { created: 1 },
        content: [
          {
            type: 'tool',
            name: 'subagent',
            state: {
              status: 'completed',
              input: { agent: 'explorer' },
              content: [{ type: 'text', text: output }],
            },
          },
        ],
      },
    ],
  });
  expect(await h.revive('exp-1')).toContain('status: started');
  expect(h.prompt).toHaveBeenCalledTimes(1);
  expect(h.wait).not.toHaveBeenCalled();
  expect(h.interrupt).not.toHaveBeenCalled();
});

test('an unproven alias cannot queue a continuation', async () => {
  const h = harness({ busy: true });
  await expect(h.revive('exp-1')).rejects.toThrow('no saved host pairing');
  expect(h.prompt).not.toHaveBeenCalled();
});

test('concurrent adoption and late admission never duplicate the prompt or result', async () => {
  let accept!: (value: unknown) => void;
  const admission = new Promise((resolve) => {
    accept = resolve;
  });
  const h = harness({ busy: true, admit: () => admission });
  const results = await Promise.allSettled([h.revive(), h.revive()]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(h.prompt).toHaveBeenCalledTimes(1);
  const generation = h.run().generation;
  h.deliver();
  h.append(assistant('new-answer', 'completed before acknowledgement'));
  await h.probe();
  expect(h.synthetic).toHaveBeenCalledTimes(1);
  accept({ id: h.prompt.mock.calls[0][0].id });
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await h.probe();
  expect(h.run().generation).toBe(generation);
  expect(h.synthetic).toHaveBeenCalledTimes(1);
  expect(h.prompt).toHaveBeenCalledTimes(1);
  expect(h.interrupt).not.toHaveBeenCalled();
});

test('unknown transport admission retains exclusion until its exact answer proves admission', async () => {
  const h = harness({
    busy: true,
    admit: async () => {
      throw new Error('connection lost after write');
    },
  });
  expect(await h.revive()).toContain('admission_unknown');
  await expect(h.revive()).rejects.toThrow('already has a queued continuation');
  h.append(assistant('old-answer', 'old result'));
  await h.probe();
  expect(h.synthetic).not.toHaveBeenCalled();
  h.deliver();
  h.append(assistant('new-answer', 'answer despite lost acknowledgement'));
  await h.probe();
  expect(h.synthetic).toHaveBeenCalledTimes(1);
  expect(h.prompt).toHaveBeenCalledTimes(1);
  expect(h.interrupt).not.toHaveBeenCalled();
});

test('missing prompt identity and a later unrelated answer cannot satisfy queued continuation', async () => {
  const h = harness({ busy: true });
  await h.revive();
  h.replace([assistant('newer-old-answer', 'not our result')]);
  await h.probe();
  expect(h.synthetic).not.toHaveBeenCalled();
  h.deliver();
  h.append(
    { id: 'unrelated-user', type: 'user' },
    assistant('unrelated-answer', 'not our result either'),
  );
  await h.probe();
  expect(h.board.get(childID)?.state).toBe('running');
  expect(h.synthetic).not.toHaveBeenCalled();
});

test('deletion during admission suppresses late delivery without interrupting the original execution', async () => {
  let accept!: (value: unknown) => void;
  const admission = new Promise((resolve) => {
    accept = resolve;
  });
  const h = harness({ busy: true, admit: () => admission });
  expect(await h.revive()).toContain('admission_unknown');
  h.board.drop(childID);
  h.deliver();
  h.append(assistant('new-answer', 'late result'));
  accept({ id: h.prompt.mock.calls[0][0].id });
  for (let i = 0; i < 50; i++) await Promise.resolve();
  expect(h.board.get(childID)).toBeUndefined();
  expect(h.synthetic).not.toHaveBeenCalled();
  expect(h.interrupt).not.toHaveBeenCalled();
  await expect(h.revive()).rejects.toThrow();
  expect(h.prompt).toHaveBeenCalledTimes(1);
});

test('late acknowledgement cannot replace a successor or deliver the predecessor twice', async () => {
  let accept!: (value: unknown) => void;
  const admission = new Promise((resolve) => {
    accept = resolve;
  });
  let count = 0;
  const h = harness({
    busy: true,
    admit: async (input) => (++count === 1 ? admission : { id: input.id }),
  });
  await h.revive();
  h.deliver();
  h.append(assistant('first-answer', 'first result'));
  await h.probe();
  await h.revive();
  const successor = h.run();
  accept({ id: h.prompt.mock.calls[0][0].id });
  for (let i = 0; i < 50; i++) await Promise.resolve();
  expect(h.board.get(childID)?.generation).toBe(successor.generation);
  expect(h.board.get(childID)?.state).toBe('running');
  expect(h.synthetic).toHaveBeenCalledTimes(1);
  h.deliver();
  h.append(assistant('second-answer', 'second result'));
  await h.probe();
  expect(h.synthetic).toHaveBeenCalledTimes(2);
  expect(h.prompt).toHaveBeenCalledTimes(2);
  expect(h.interrupt).not.toHaveBeenCalled();
});

test('explicit host rejection releases the queued generation for a retry', async () => {
  let refuse = true;
  const h = harness({
    busy: true,
    admit: async (input) =>
      refuse ? { error: { message: 'queue refused' } } : { id: input.id },
  });
  await expect(h.revive()).rejects.toThrow('queue refused');
  const restored = h.run();
  expect(restored.recoveredWithoutPrompt).toBe(true);
  expect(restored.statusUncertain).toBeFalsy();
  expect(
    h.tracker.promptMessageIDFor(childID, restored.generation),
  ).toBeUndefined();
  refuse = false;
  expect(await h.revive()).toContain('status: started');
  expect(h.run().generation).not.toBe(restored.generation);
  h.deliver();
  h.append(assistant('new-answer', 'result after refusal'));
  await h.probe();
  await h.probe();
  expect(h.board.get(childID)?.resultSummary).toBe('result after refusal');
  expect(h.synthetic).toHaveBeenCalledTimes(1);
  expect(h.prompt).toHaveBeenCalledTimes(2);
  expect(h.interrupt).not.toHaveBeenCalled();
});
