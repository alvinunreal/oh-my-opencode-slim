import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  createRevivedRunTracker,
  type RevivedRunTracker,
} from '../hooks/task-session-manager/revived-run-tracker';
import { BackgroundJobBoard } from '../utils/background-job-fixture';
import { createBackgroundJobTerminalGate } from '../utils/background-job-terminal-gate';
import * as opencodeClient from '../utils/opencode-client';
import { buildPluginInput } from '../v2/client-shim';
import type { V2Context } from '../v2/types';
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
    admit?: (prompt: Prompt) => Promise<unknown>;
  } = {},
) {
  spyOn(opencodeClient, 'getClient').mockImplementation(
    (input) => input.client,
  );
  let transcript: unknown[] = [
    { id: 'old-user', type: 'user' },
    ...(options.busy ? [] : [assistant('old-answer', 'old result')]),
  ];
  const wait = mock(async () => {});
  const interrupt = mock(async () => {});
  const synthetic = mock(async () => ({}));
  let queued: Prompt | undefined;
  const prompt = mock(async (input: Prompt) => {
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
      context: async () => transcript,
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
    baselineFor: (id, generation) => tracker.baselineFor(id, generation),
    promptMessageIDFor: (id, generation) =>
      tracker.promptMessageIDFor(id, generation),
    observationRevisionFor: (id, generation) =>
      tracker.revisionFor(id, generation),
    attemptStartedAtFor: (id, generation) =>
      tracker.attemptStartedAtFor(id, generation),
    isObservationPending: (id, generation) =>
      tracker.isObservationPending(id, generation),
    graceMs: 60_000,
  });
  tracker = createRevivedRunTracker({
    input,
    backgroundJobBoard: board,
    terminalGate: gate,
  });
  const { task_revive } = createTaskReviveTool({
    input,
    backgroundJobBoard: board,
    shouldManageSession: () => true,
    revivedRunTracker: tracker,
    admissionTimeoutMs: 10,
  });
  disposals.push(() => {
    tracker.dispose();
    gate.dispose();
  });
  const revive = () =>
    task_revive.execute(
      { sessionID: childID, prompt: 'Continue retained work' },
      { sessionID: parentID, agent: 'orchestrator' } as never,
    );
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
    probe,
    run,
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
