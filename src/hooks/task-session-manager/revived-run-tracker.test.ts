import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-fixture';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
} from '../../utils/background-job-terminal-gate';
import { SLIM_INTERNAL_INITIATOR_MARKER } from '../../utils/internal-initiator';
import * as opencodeClient from '../../utils/opencode-client';
import { createRevivedRunTracker } from './revived-run-tracker';

const gates: BackgroundJobTerminalGate[] = [];

function createHarness(
  messages: () => unknown,
  prompt = mock(async () => ({})),
  assertBound = false,
  options: {
    maxNotificationRetries?: number;
    stabilizationProbeDelayMs?: number;
    handoffExpiryMs?: number;
    onOwnershipReleased?: (
      parentSessionID: string,
      taskID: string,
      generation: number,
    ) => void;
    resolveSelection?: (sessionID: string) => Promise<{
      agent?: string;
      model?: { providerID: string; modelID: string };
      variant?: string;
      provenance: 'host-persisted' | 'observed-external' | 'unknown';
    }>;
  } = {},
) {
  // Other suites install process-global getClient mocks; restore in afterEach.
  spyOn(opencodeClient, 'getClient').mockImplementation(
    (input) => input.client,
  );
  const board = new BackgroundJobBoard();
  board.registerLaunch({
    taskID: 'ses_child',
    parentSessionID: 'parent',
    agent: 'explorer',
    background: true,
  });
  board.updateStatus({
    taskID: 'ses_child',
    state: 'completed',
    resultSummary: 'old result',
  });
  board.markReconciled('ses_child');
  const lease = board.acquireRelaunchLease('ses_child', 1);
  if (!lease) throw new Error('missing relaunch lease');
  const run = board.registerLaunch({
    taskID: 'ses_child',
    parentSessionID: 'parent',
    agent: 'explorer',
    description: 'inspect the change',
    background: true,
    relaunchLease: lease,
  });
  board.releaseLease(lease);
  let session: {
    messages: ReturnType<typeof mock>;
    promptAsync: ReturnType<typeof mock>;
  };
  session = {
    messages: mock(function (this: unknown) {
      if (assertBound) expect(this).toBe(session);
      return messages();
    }),
    promptAsync: mock(function (this: unknown, ..._args: unknown[]) {
      if (assertBound) expect(this).toBe(session);
      return prompt();
    }),
  };
  const input = {
    directory: '/test',
    client: {
      session,
    },
  } as never;
  const settled = mock(() => {});
  const pruned = mock(() => {});
  const gate = createBackgroundJobTerminalGate({
    backgroundJobBoard: board,
    input,
    readRuntime: async (_run, readStartedAt) => ({
      kind: 'quiescent',
      origin: 'test-host',
      readStartedAt,
    }),
    baselineFor: (taskID, generation) =>
      tracker.baselineFor(taskID, generation),
    observationRevisionFor: (taskID, generation) =>
      tracker.revisionFor(taskID, generation),
    attemptStartedAtFor: (taskID, generation) =>
      tracker.attemptStartedAtFor(taskID, generation),
    isObservationPending: (taskID, generation) =>
      tracker.isObservationPending(taskID, generation),
    graceMs: options.stabilizationProbeDelayMs ?? 150,
  });
  gates.push(gate);
  const tracker = createRevivedRunTracker({
    input,
    terminalGate: gate,
    backgroundJobBoard: board,
    notificationRetryDelayMs: 0,
    ...options,
    onSettled: settled,
    pruneContext: pruned,
  });
  return {
    board,
    run,
    tracker,
    gate,
    prompt: session.promptAsync,
    settled,
    pruned,
  };
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** notifyParent is fire-and-forget from probe(); drain its microtasks. */
async function flushNotify(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** Toggle-able transcript: baseline only until `probe` flips true, then a
 * completed assistant turn after the baseline. */
function completedTranscript(
  probe: () => boolean,
  text = 'new result',
): () => unknown {
  return () =>
    probe()
      ? {
          data: [
            { info: { id: 'baseline', role: 'user' }, parts: [] },
            {
              info: {
                id: 'assistant-1',
                role: 'assistant',
                time: { completed: 2 },
              },
              parts: [{ type: 'text', text }],
            },
          ],
        }
      : { data: [{ info: { id: 'baseline', role: 'user' }, parts: [] }] };
}

afterEach(() => {
  for (const gate of gates.splice(0)) gate.dispose();
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  mock.restore();
});

describe('revived run tracker', () => {
  test('publishes a newer completed assistant turn and notifies the parent', async () => {
    let probe = false;
    const harness = createHarness(
      completedTranscript(() => probe),
      undefined,
      true,
    );
    const baseline = await harness.tracker.captureBaseline('ses_child');
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: baseline,
      description: 'inspect the change',
    });
    probe = true;
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);

    expect(harness.board.get('ses_child')).toMatchObject({
      state: 'completed',
      resultSummary: 'new result',
    });
    expect(harness.prompt).toHaveBeenCalledTimes(1);
    expect(harness.prompt.mock.calls[0]?.[0]).toMatchObject({
      path: { id: 'parent' },
      body: {
        agent: 'orchestrator',
        // The notification part must carry the internal-initiator metadata
        // (and marker suffix) so the v2 client-shim routes it through
        // session.synthetic — a bare `synthetic: true` part drops its flag
        // in the flat prompt translation and regresses into a visible
        // user message + external-user-activity classification (#1157).
        parts: [
          {
            type: 'text',
            synthetic: true,
            metadata: { 'oh-my-opencode-slim.internalInitiator': true },
          },
        ],
      },
    });
    const notifiedText = (
      harness.prompt.mock.calls[0]?.[0] as
        | { body?: { parts?: Array<{ text?: string }> } }
        | undefined
    )?.body?.parts?.[0]?.text;
    expect(notifiedText).toContain('<task ');
    expect(notifiedText).toContain(SLIM_INTERNAL_INITIATOR_MARKER);
    expect(
      (harness.prompt.mock.calls[0]?.[0] as { delivery?: string } | undefined)
        ?.delivery,
    ).toBe('queue');
  });

  // ── v2-sim pin: queue delivery + exactly-once across the double-idle ──
  //
  // On a v2 host the event adapter synthesizes BOTH a `session.status`
  // idle and a `session.idle` for one terminal execution event (the
  // documented double-idle invariant), so the terminal observation is
  // redelivered to every publication listener and the tracker's probe
  // can be re-driven. The parent notification must still be delivered
  // EXACTLY ONCE, via promptAsync with `delivery: 'queue'` (v1
  // prompt_async parity — 'steer' would hijack an in-flight parent,
  // #1192) and `modelSelection: 'inherit'` (lifecycle continuation,
  // #1079): the exact argument pair the v2 client shim translates.
  test('v2-sim: double-delivered terminal observation notifies the parent exactly once with queue delivery', async () => {
    let probe = false;
    const harness = createHarness(
      completedTranscript(() => probe),
      undefined,
      false,
    );
    const baseline = await harness.tracker.captureBaseline('ses_child');
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: baseline,
      description: 'inspect the change',
    });
    probe = true;
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);
    await flushNotify();

    // The second half of the double-idle pair: the coordinator's
    // terminal-outcome listener redelivers the SAME publication, and a
    // re-driven probe reconciles to the already-terminal record.
    const published = harness.board.get('ses_child');
    if (!published) throw new Error('missing publication');
    harness.tracker.onTerminal(published);
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);
    await flushNotify();

    expect(harness.prompt).toHaveBeenCalledTimes(1);
    expect(harness.prompt.mock.calls[0]?.[0]).toMatchObject({
      path: { id: 'parent' },
      delivery: 'queue',
      modelSelection: 'inherit',
    });
    const body = (
      harness.prompt.mock.calls[0]?.[0] as
        | {
            body?: {
              agent?: string;
              parts?: Array<{
                text?: string;
                metadata?: Record<string, unknown>;
              }>;
            };
          }
        | undefined
    )?.body;
    expect(body?.agent).toBe('orchestrator');
    expect(body?.parts?.[0]?.text).toContain('<task ');
    expect(body?.parts?.[0]?.text).toContain('state="completed"');
    expect(body?.parts?.[0]?.text).toContain(SLIM_INTERNAL_INITIATOR_MARKER);
    expect(
      body?.parts?.[0]?.metadata?.['oh-my-opencode-slim.internalInitiator'],
    ).toBe(true);
    // The board stays settled after the redelivery — no second terminal.
    expect(harness.board.get('ses_child')).toMatchObject({
      state: 'completed',
      resultSummary: 'new result',
    });
  });

  test('notifies the parent in its current selection instead of hardcoded orchestrator', async () => {
    let probe = false;
    const harness = createHarness(
      completedTranscript(() => probe),
      undefined,
      false,
      {
        resolveSelection: async () => ({
          agent: 'plan',
          model: { providerID: 'test', modelID: 'plan-model' },
          provenance: 'host-persisted',
        }),
      },
    );
    const baseline = await harness.tracker.captureBaseline('ses_child');
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: baseline,
      description: 'inspect the change',
    });
    probe = true;
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);
    await flushNotify();

    expect(harness.prompt.mock.calls[0]?.[0]).toMatchObject({
      delivery: 'queue',
      body: {
        agent: 'plan',
        model: { providerID: 'test', modelID: 'plan-model' },
      },
    });
  });

  test('forwards the resolved variant as modelVariant on the notification', async () => {
    let probe = false;
    const harness = createHarness(
      completedTranscript(() => probe),
      undefined,
      false,
      {
        resolveSelection: async () => ({
          agent: 'plan',
          model: { providerID: 'test', modelID: 'plan-model' },
          variant: 'max',
          provenance: 'host-persisted',
        }),
      },
    );
    const baseline = await harness.tracker.captureBaseline('ses_child');
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: baseline,
      description: 'inspect the change',
    });
    probe = true;
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);
    await flushNotify();

    expect(harness.prompt.mock.calls[0]?.[0]).toMatchObject({
      delivery: 'queue',
      modelVariant: 'max',
      body: {
        agent: 'plan',
        model: { providerID: 'test', modelID: 'plan-model' },
      },
    });
  });

  test('does not send after dispose during selection resolve', async () => {
    let probe = false;
    let entered = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness(
      completedTranscript(() => probe),
      undefined,
      false,
      {
        resolveSelection: async () => {
          entered = true;
          await gate;
          return { agent: 'plan', provenance: 'host-persisted' };
        },
      },
    );
    const baseline = await harness.tracker.captureBaseline('ses_child');
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: baseline,
      description: 'inspect the change',
    });
    probe = true;
    const pending = harness.tracker.probe(
      harness.run.taskID,
      harness.run.generation,
    );
    for (let i = 0; i < 20 && !entered; i += 1) await Promise.resolve();
    expect(entered).toBe(true);
    harness.tracker.dispose();
    release?.();
    await pending;
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  test('keeps a non-terminal idle turn running and rejects historical output', async () => {
    const harness = createHarness(() => ({
      data: [
        { info: { id: 'baseline', role: 'user' }, parts: [] },
        {
          info: {
            id: 'assistant-old',
            role: 'assistant',
            time: { completed: 1 },
          },
          parts: [{ type: 'text', text: 'old result' }],
        },
        {
          info: { id: 'assistant-new', role: 'assistant' },
          parts: [{ type: 'text', text: 'partial' }],
        },
      ],
    }));
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);

    expect(harness.board.get('ses_child')).toMatchObject({ state: 'running' });
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  test('delegates inspection without maintaining a terminal policy or stabilization timer', async () => {
    const harness = createHarness(() => {
      throw new Error('tracker must not read evidence');
    });
    const inspect = mock(async () => ({
      kind: 'deferred' as const,
      record: harness.run,
    }));
    harness.gate.reconcile = inspect;
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });

    expect(
      await harness.tracker.probe(harness.run.taskID, harness.run.generation),
    ).toBe(false);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({
        taskID: harness.run.taskID,
        generation: harness.run.generation,
      }),
      { kind: 'inspect' },
    );
    expect(harness.board.get('ses_child')?.state).toBe('running');
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  test('publishes immediate child errors and ignores stale generations', async () => {
    const harness = createHarness(() => ({
      data: [
        { info: { id: 'baseline', role: 'user' }, parts: [] },
        {
          info: {
            id: 'assistant-error',
            role: 'assistant',
            time: { completed: 3 },
            error: { message: 'provider failed' },
          },
          parts: [],
        },
      ],
    }));
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });
    const staleLease = harness.board.acquireRelaunchLease(
      harness.run.taskID,
      harness.run.generation,
    );
    if (!staleLease) throw new Error('missing stale lease');
    const newer = harness.board.registerLaunch({
      taskID: harness.run.taskID,
      parentSessionID: 'parent',
      agent: 'explorer',
      background: true,
      relaunchLease: staleLease,
    });
    harness.board.releaseLease(staleLease);
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);
    expect(harness.board.get('ses_child')).toMatchObject({
      generation: newer.generation,
      state: 'running',
    });
  });

  test('retries parent notification without changing the terminal board state', async () => {
    let attempts = 0;
    const prompt = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('parent unavailable');
      return {};
    });
    const harness = createHarness(
      () => ({
        data: [
          { info: { id: 'baseline', role: 'user' }, parts: [] },
          {
            info: {
              id: 'assistant-1',
              role: 'assistant',
              time: { completed: 2 },
            },
            parts: [{ type: 'text', text: 'done' }],
          },
        ],
      }),
      prompt,
    );
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.board.markReconciled(harness.run.taskID);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.board.get('ses_child')?.state).toBe('reconciled');
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  test('re-resolves agent and model on each notification retry', async () => {
    let attempts = 0;
    const prompt = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('parent unavailable');
      return {};
    });
    const selections = [
      {
        agent: 'orchestrator',
        model: { providerID: 'test', modelID: 'model-a' },
        provenance: 'host-persisted' as const,
      },
      {
        agent: 'plan',
        model: { providerID: 'test', modelID: 'model-b' },
        provenance: 'host-persisted' as const,
      },
    ];
    const harness = createHarness(
      () => ({
        data: [
          { info: { id: 'baseline', role: 'user' }, parts: [] },
          {
            info: {
              id: 'assistant-1',
              role: 'assistant',
              time: { completed: 2 },
            },
            parts: [{ type: 'text', text: 'done' }],
          },
        ],
      }),
      prompt,
      false,
      {
        resolveSelection: async () =>
          selections[Math.min(attempts, selections.length - 1)] ??
          selections[0],
      },
    );
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);
    await flushNotify();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await flushNotify();

    expect(harness.prompt).toHaveBeenCalledTimes(2);
    expect(harness.prompt.mock.calls[0]?.[0]).toMatchObject({
      body: {
        agent: 'orchestrator',
        model: { providerID: 'test', modelID: 'model-a' },
      },
    });
    expect(harness.prompt.mock.calls[1]?.[0]).toMatchObject({
      body: {
        agent: 'plan',
        model: { providerID: 'test', modelID: 'model-b' },
      },
    });
  });

  test('holds the terminal notification lease while parent transport is active', async () => {
    const harness = createHarness(() => ({ data: [] }));
    let relaunchLease: unknown;
    harness.prompt.mockImplementation(async () => {
      relaunchLease = harness.board.acquireRelaunchLease(
        harness.run.taskID,
        harness.run.generation,
      );
      return {};
    });
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      description: 'inspect the change',
    });
    const terminal = harness.board.updateStatus({
      taskID: harness.run.taskID,
      expectedGeneration: harness.run.generation,
      state: 'completed',
      resultSummary: 'done',
    });
    if (!terminal) throw new Error('missing terminal record');
    harness.tracker.onTerminal(terminal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(relaunchLease).toBeUndefined();
    expect(harness.board.get(harness.run.taskID)).toMatchObject({
      generation: harness.run.generation,
      state: 'completed',
    });
  });

  test('forwards coordinator terminal outcomes to one parent notification', async () => {
    const harness = createHarness(() => ({ data: [] }));
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      description: 'inspect the change',
    });
    const terminal = harness.board.updateStatus({
      taskID: harness.run.taskID,
      expectedGeneration: harness.run.generation,
      state: 'error',
      resultSummary: 'timeout',
    });
    if (!terminal) throw new Error('missing terminal record');
    harness.tracker.onTerminal(terminal);
    harness.tracker.onTerminal(terminal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.prompt).toHaveBeenCalledTimes(1);
  });

  test('discards a retry when the task generation is relaunched', async () => {
    const prompt = mock(async () => {
      throw new Error('parent unavailable');
    });
    const harness = createHarness(() => ({ data: [] }), prompt);
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      description: 'inspect the change',
    });
    const terminal = harness.board.updateStatus({
      taskID: harness.run.taskID,
      expectedGeneration: harness.run.generation,
      state: 'completed',
      resultSummary: 'done',
    });
    if (!terminal) throw new Error('missing terminal record');
    harness.tracker.onTerminal(terminal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const lease = harness.board.acquireRelaunchLease(
      harness.run.taskID,
      harness.run.generation,
    );
    if (!lease) throw new Error('missing relaunch lease');
    const newer = harness.board.registerLaunch({
      taskID: harness.run.taskID,
      parentSessionID: 'parent',
      agent: 'explorer',
      background: true,
      relaunchLease: lease,
    });
    harness.board.releaseLease(lease);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(
      harness.tracker.isTracked(harness.run.taskID, newer.generation),
    ).toBe(false);
  });

  test('retains cancelled ownership for repairs, clearing pending context without notifying', () => {
    const harness = createHarness(() => ({ data: [] }));
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      description: 'inspect the change',
    });
    const cancelled = harness.board.updateStatus({
      taskID: harness.run.taskID,
      expectedGeneration: harness.run.generation,
      state: 'cancelled',
      resultSummary: 'cancelled by user',
    });
    if (!cancelled) throw new Error('missing cancelled record');
    harness.tracker.onTerminal(cancelled);

    expect(
      harness.tracker.isTracked(harness.run.taskID, harness.run.generation),
    ).toBe(true);
    expect(harness.settled).toHaveBeenCalledTimes(1);
    expect(harness.pruned).toHaveBeenCalledTimes(1);
    expect(harness.prompt).not.toHaveBeenCalled();

    const lease = harness.board.acquireRelaunchLease(
      harness.run.taskID,
      harness.run.generation,
    );
    if (!lease) throw new Error('missing revive lease');
    const next = harness.board.registerLaunch({
      taskID: harness.run.taskID,
      parentSessionID: 'parent',
      agent: 'explorer',
      background: true,
      relaunchLease: lease,
    });
    harness.board.releaseLease(lease);
    harness.tracker.register({
      taskID: next.taskID,
      generation: next.generation,
      parentSessionID: 'parent',
      description: 'second revive',
    });
    harness.tracker.onTerminal(cancelled);
    expect(harness.tracker.isTracked(next.taskID, next.generation)).toBe(true);
  });

  // Controlled clock for the transport-timeout scenarios below: capture
  // timer registrations so the 10s transport timeout can be fired without
  // waiting, and track clearTimeout so a cancelled retry is provable.
  function installCapturedTimers() {
    const timers = new Map<number, { delay: number; callback: () => void }>();
    const cleared = new Set<number>();
    let nextId = 0;
    globalThis.setTimeout = ((callback: () => void, delay = 0) => {
      const id = ++nextId;
      timers.set(id, { delay, callback });
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      cleared.add(id);
      timers.delete(id);
    }) as typeof clearTimeout;
    const settle = async () => {
      for (let i = 0; i < 15; i += 1) await Promise.resolve();
    };
    const fire = (delay: number) => {
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.delay !== delay) continue;
        timers.delete(id);
        timer.callback();
        return id;
      }
      return undefined;
    };
    const soleSurviving = (delay: number) =>
      [...timers.values()].find((timer) => timer.delay === delay);
    return { timers, cleared, settle, fire, soleSurviving };
  }

  function publish(harness: ReturnType<typeof createHarness>) {
    harness.tracker.register({
      ...harness.run,
      parentSessionID: 'parent',
      description: 'inspect the change',
    });
    const terminal = harness.board.updateStatus({
      taskID: harness.run.taskID,
      expectedGeneration: harness.run.generation,
      state: 'completed',
      resultSummary: 'done',
    });
    if (!terminal) throw new Error('missing terminal record');
    harness.tracker.onTerminal(terminal);
    return terminal;
  }

  function expectRelaunchAvailable(harness: ReturnType<typeof createHarness>) {
    const lease = harness.board.acquireRelaunchLease(
      harness.run.taskID,
      harness.run.generation,
    );
    expect(lease).toBeDefined();
    if (lease) harness.board.releaseLease(lease);
  }

  test.each([0, 1, 3])(
    'hung transport releases before retries with budget %i',
    async (maxNotificationRetries) => {
      const clock = installCapturedTimers();
      const harness = createHarness(
        () => ({ data: [] }),
        mock(() => new Promise(() => {})),
        false,
        { maxNotificationRetries },
      );
      const terminal = publish(harness);
      for (
        let attempt = 1;
        attempt <= Math.max(1, maxNotificationRetries);
        attempt++
      ) {
        await clock.settle();
        expect(harness.prompt).toHaveBeenCalledTimes(attempt);
        expect(
          harness.board.acquireRelaunchLease(
            terminal.taskID,
            terminal.generation,
          ),
        ).toBeUndefined();
        expect(clock.fire(10_000)).toBeDefined();
        await clock.settle();
        // Availability must precede retry execution, even if no transport settles.
        expectRelaunchAvailable(harness);
        if (attempt < maxNotificationRetries) {
          expect(clock.fire(0)).toBeDefined();
        } else {
          expect(clock.soleSurviving(0)).toBeUndefined();
        }
      }
      expect(harness.board.get(terminal.taskID)).toMatchObject(terminal);
      harness.tracker.dispose();
    },
  );

  function deferred() {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  test.each(['success', 'sync throw', 'async rejection', 'error envelope'])(
    '%s releases the lease; only success accepts the publication',
    async (outcome) => {
      const clock = installCapturedTimers();
      const harness = createHarness(
        () => ({ data: [] }),
        mock(() => {
          if (outcome === 'sync throw') throw new Error('host unavailable');
          if (outcome === 'async rejection')
            return Promise.reject(new Error('host unavailable'));
          return Promise.resolve(
            outcome === 'success' ? {} : { error: 'host rejected' },
          );
        }),
      );
      const terminal = publish(harness);
      await clock.settle();
      expectRelaunchAvailable(harness);
      expect(clock.soleSurviving(10_000)).toBeUndefined();
      expect(Boolean(clock.soleSurviving(0))).toBe(outcome !== 'success');
      if (outcome === 'success') {
        harness.tracker.onTerminal(terminal);
        await clock.settle();
        expect(harness.prompt).toHaveBeenCalledTimes(1);
      } else {
        clock.fire(0);
        await clock.settle();
        expect(harness.prompt).toHaveBeenCalledTimes(2);
      }
      expect(harness.board.get(terminal.taskID)).toMatchObject(terminal);
      harness.tracker.dispose();
    },
  );

  test.each(['before timeout', 'timer first', 'settlement first'])(
    'acceptance survives the timeout race: %s',
    async (order) => {
      const clock = installCapturedTimers();
      const transport = deferred();
      const harness = createHarness(
        () => ({ data: [] }),
        mock(() => transport.promise),
      );
      const terminal = publish(harness);
      await clock.settle();
      const timeout = clock.soleSurviving(10_000);
      expect(timeout).toBeDefined();
      if (order === 'timer first') timeout?.callback();
      transport.resolve({});
      if (order === 'settlement first') timeout?.callback();
      await clock.settle();
      expectRelaunchAvailable(harness);
      expect(clock.soleSurviving(0)).toBeUndefined();
      expect(clock.soleSurviving(10_000)).toBeUndefined();
      harness.tracker.onTerminal(terminal);
      await clock.settle();
      expect(harness.prompt).toHaveBeenCalledTimes(1);
      harness.tracker.dispose();
    },
  );

  test.each(['before retry', 'during selection'])(
    'late success cancels further sends: %s',
    async (phase) => {
      const clock = installCapturedTimers();
      const transport = deferred();
      const secondSelection = deferred();
      let selectionCalls = 0;
      const harness = createHarness(
        () => ({ data: [] }),
        mock(() => transport.promise),
        false,
        {
          resolveSelection: async () => {
            selectionCalls += 1;
            if (selectionCalls >= 2) await secondSelection.promise;
            return { agent: 'plan', provenance: 'host-persisted' };
          },
        },
      );
      const terminal = publish(harness);
      await clock.settle();
      expect(harness.prompt).toHaveBeenCalledTimes(1);
      clock.fire(10_000);
      await clock.settle();
      expectRelaunchAvailable(harness);
      const retry = clock.soleSurviving(0);
      expect(retry).toBeDefined();
      if (phase === 'during selection') {
        clock.fire(0);
        await clock.settle();
        expect(selectionCalls).toBe(2);
      }
      transport.resolve({});
      await clock.settle();
      secondSelection.resolve(undefined);
      await clock.settle();
      expect(clock.soleSurviving(0)).toBeUndefined();
      // Even an already-queued callback must respect the acceptance latch.
      retry?.callback();
      harness.tracker.onTerminal(terminal);
      await clock.settle();
      expect(harness.prompt).toHaveBeenCalledTimes(1);
      expectRelaunchAvailable(harness);
      harness.tracker.dispose();
    },
  );

  test.each(
    ['rejection', 'error envelope'].flatMap((outcome) =>
      [1, 3].map((budget) => ({ outcome, budget })),
    ),
  )(
    'late $outcome preserves the retry budget $budget',
    async ({ outcome, budget }) => {
      const clock = installCapturedTimers();
      const transport = deferred();
      const harness = createHarness(
        () => ({ data: [] }),
        mock(() => transport.promise),
        false,
        { maxNotificationRetries: budget },
      );
      publish(harness);
      await clock.settle();
      clock.fire(10_000);
      await clock.settle();
      const retry = clock.soleSurviving(0);
      expect(Boolean(retry)).toBe(budget > 1);
      if (outcome === 'rejection')
        transport.reject(new Error('host unavailable'));
      else transport.resolve({ error: 'host rejected' });
      await clock.settle();
      expect(clock.soleSurviving(0)).toBe(retry);
      expectRelaunchAvailable(harness);
      for (let attempt = 2; attempt <= budget; attempt++) {
        expect(clock.fire(0)).toBeDefined();
        await clock.settle();
        expect(harness.prompt).toHaveBeenCalledTimes(attempt);
        expectRelaunchAvailable(harness);
      }
      expect(clock.soleSurviving(0)).toBeUndefined();
      expect(harness.prompt).toHaveBeenCalledTimes(budget);
      harness.tracker.dispose();
    },
  );

  test.each(['rejection', 'error envelope', 'timeout'])(
    'A accepts while B is sending; B %s cannot trigger C or lose its lease',
    async (outcome) => {
      const clock = installCapturedTimers();
      const a = deferred();
      const b = deferred();
      const prompt = mock(() =>
        prompt.mock.calls.length === 1 ? a.promise : b.promise,
      );
      const harness = createHarness(() => ({ data: [] }), prompt);
      const terminal = publish(harness);
      await clock.settle();
      clock.fire(10_000);
      await clock.settle();
      expectRelaunchAvailable(harness);
      clock.fire(0);
      await clock.settle();
      expect(harness.prompt).toHaveBeenCalledTimes(2);
      a.resolve({});
      await clock.settle();
      expect(
        harness.board.acquireRelaunchLease(
          terminal.taskID,
          terminal.generation,
        ),
      ).toBeUndefined();
      if (outcome === 'timeout') clock.fire(10_000);
      else if (outcome === 'rejection') b.reject(new Error('host unavailable'));
      else b.resolve({ error: 'host rejected' });
      await clock.settle();
      expectRelaunchAvailable(harness);
      expect(clock.soleSurviving(0)).toBeUndefined();
      harness.tracker.onTerminal(terminal);
      await clock.settle();
      expect(harness.prompt).toHaveBeenCalledTimes(2);
      expect(harness.board.get(terminal.taskID)).toMatchObject(terminal);
      harness.tracker.dispose();
    },
  );

  test.each(
    [
      { replacement: 'same generation', timedOut: false },
      { replacement: 'same generation', timedOut: true },
      { replacement: 'new generation', timedOut: true },
      { replacement: 'discardRun', timedOut: false },
      { replacement: 'discardRun', timedOut: true },
      { replacement: 'dispose', timedOut: false },
      { replacement: 'dispose', timedOut: true },
    ].flatMap((scenario) =>
      ['success', 'rejection', 'error envelope'].map((outcome) => ({
        ...scenario,
        outcome,
      })),
    ),
  )(
    'stale $outcome after $replacement (timeout=$timedOut) cannot alter its successor',
    async ({ replacement, timedOut, outcome }) => {
      const clock = installCapturedTimers();
      const a = deferred();
      const b = deferred();
      const prompt = mock(() =>
        prompt.mock.calls.length === 1 ? a.promise : b.promise,
      );
      const harness = createHarness(() => ({ data: [] }), prompt);
      const terminal = publish(harness);
      await clock.settle();
      if (timedOut) {
        clock.fire(10_000);
        await clock.settle();
      }
      const oldRetry = clock.soleSurviving(0);
      const hasSuccessor = replacement.includes('generation');
      let current = terminal;
      if (replacement === 'new generation') {
        const lease = harness.board.acquireRelaunchLease(
          terminal.taskID,
          terminal.generation,
        );
        if (!lease) throw new Error('missing relaunch lease');
        harness.board.registerLaunch({ ...harness.run, relaunchLease: lease });
        harness.board.releaseLease(lease);
        const next = harness.board.updateStatus({
          taskID: terminal.taskID,
          state: 'completed',
          resultSummary: 'new generation',
        });
        if (!next) throw new Error('missing new-generation terminal record');
        current = next;
      }
      if (hasSuccessor) {
        harness.tracker.register({ ...current, description: 'successor' });
        harness.tracker.onTerminal(current);
      } else if (replacement === 'discardRun') {
        harness.board.markRunningFromLiveSession(
          terminal.taskID,
          terminal.updatedAt + 1,
          terminal.generation,
          terminal.terminalRevision,
        );
        expect(
          harness.tracker.prepareObservation({
            ...harness.run,
            description: 'replacement observation',
          }),
        ).toBe(true);
        harness.tracker.rejectObservation(terminal.taskID, terminal.generation);
      } else {
        harness.tracker.dispose();
      }
      await clock.settle();
      if (outcome === 'success') a.resolve({});
      else if (outcome === 'rejection') a.reject(new Error('old failure'));
      else a.resolve({ error: 'old failure' });
      await clock.settle();
      if (hasSuccessor) {
        if (!timedOut) {
          expect(clock.fire(0)).toBeDefined();
          await clock.settle();
        }
        expect(harness.prompt).toHaveBeenCalledTimes(2);
        expect(
          harness.board.acquireRelaunchLease(
            current.taskID,
            current.generation,
          ),
        ).toBeUndefined();
        b.reject(new Error('successor not accepted'));
        await clock.settle();
        const newRetry = clock.soleSurviving(0);
        expect(newRetry).toBeDefined();
        oldRetry?.callback();
        await clock.settle();
        expect(clock.soleSurviving(0)).toBe(newRetry);
        clock.fire(0);
        await clock.settle();
        expect(harness.prompt).toHaveBeenCalledTimes(3);
        expect(harness.board.get(current.taskID)).toMatchObject(current);
      } else {
        oldRetry?.callback();
        await clock.settle();
        expect(clock.soleSurviving(0)).toBeUndefined();
        expect(harness.prompt).toHaveBeenCalledTimes(1);
        expectRelaunchAvailable(harness);
      }
      harness.tracker.dispose();
    },
  );

  test.each([
    'withdraw publication',
    'replace run',
    'dispose',
    'release lease',
  ])(
    'invalidating between acquisition and the deferred send prevents promptAsync: %s',
    async (invalidation) => {
      const clock = installCapturedTimers();
      const harness = createHarness(() => ({ data: [] }));
      const acquire = harness.board.acquireTerminalNotificationLease.bind(
        harness.board,
      );
      let acquired = false;
      let invalidated = false;
      harness.board.acquireTerminalNotificationLease = (...args) => {
        const lease = acquire(...args);
        acquired = lease !== undefined && harness.board.validateLease(lease);
        queueMicrotask(() => {
          if (invalidation === 'withdraw publication')
            harness.board.markRunningFromLiveSession(
              harness.run.taskID,
              Date.now(),
              harness.run.generation,
              lease?.terminalRevision,
            );
          else if (invalidation === 'replace run')
            harness.tracker.register({
              ...harness.run,
              description: 'successor',
            });
          else if (invalidation === 'dispose') harness.tracker.dispose();
          else if (lease) harness.board.releaseLease(lease);
          invalidated = true;
        });
        return lease;
      };
      publish(harness);
      await clock.settle();
      expect(acquired).toBe(true);
      expect(invalidated).toBe(true);
      expect(harness.prompt).not.toHaveBeenCalled();
      expectRelaunchAvailable(harness);
      expect(clock.soleSurviving(10_000)).toBeUndefined();
      harness.tracker.dispose();
    },
  );

  test('a pending probe replaced by another same-generation registration does not terminalize', async () => {
    let resolveMessages: ((value: unknown) => void) | undefined;
    const harness = createHarness(
      () =>
        new Promise((resolve) => {
          resolveMessages = resolve;
        }),
    );
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline-1',
      description: 'first fallback',
    });
    const firstProbe = harness.tracker.probe(
      harness.run.taskID,
      harness.run.generation,
    );
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline-2',
      description: 'second fallback',
    });
    resolveMessages?.({
      data: [
        { info: { id: 'baseline-1', role: 'user' }, parts: [] },
        {
          info: {
            id: 'assistant-1',
            role: 'assistant',
            time: { completed: 2 },
          },
          parts: [{ type: 'text', text: 'stale first-run answer' }],
        },
      ],
    });
    expect(await firstProbe).toBe(false);
    expect(harness.board.get('ses_child')?.state).toBe('running');
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  test('handoff: prepare defers, admit enrolls and probes immediately', async () => {
    // A fallback re-prompt whose result is ALREADY persisted must be
    // delivered on admission — no idle event will fire again.
    const harness = createHarness(
      completedTranscript(() => true),
      undefined,
      false,
      {
        stabilizationProbeDelayMs: 0,
      },
    );
    const gen = harness.run.generation;

    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(false);
    expect(
      harness.tracker.prepareObservation({
        taskID: 'ses_child',
        generation: gen,
        parentSessionID: 'parent',
        baselineMessageID: 'baseline',
        description: 'inspect the change',
      }),
    ).toBe(true);
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(true);

    const attemptStart = harness.tracker.attemptStartedAtFor('ses_child', gen);
    expect(typeof attemptStart).toBe('number');
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(harness.tracker.admitObservation('ses_child', gen)).toBe(true);
    expect(harness.tracker.attemptStartedAtFor('ses_child', gen)).toBe(
      attemptStart,
    );
    expect(harness.tracker.isTracked('ses_child', gen)).toBe(true);
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(false);

    await flushNotify();
    expect(harness.board.get('ses_child')?.state).toBe('completed');
    expect(harness.board.get('ses_child')?.resultSummary).toBe('new result');
    expect(harness.prompt).toHaveBeenCalledTimes(1);
  });

  test('handoff: reject withdraws the preparation without enrolling', () => {
    const harness = createHarness(completedTranscript(() => false));
    const gen = harness.run.generation;
    harness.tracker.prepareObservation({
      taskID: 'ses_child',
      generation: gen,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });

    harness.tracker.rejectObservation('ses_child', gen);

    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(false);
    expect(harness.tracker.isTracked('ses_child', gen)).toBe(false);
  });

  test('handoff: promotion keeps fencing the gate and a late admit delivers without reinstalling', async () => {
    // Expiry converts the preparation into the owning run, but the
    // ADMISSION is still unresolved — the gate must stay deferred
    // (no absent→stopped while the re-prompt may yet start). The late
    // acceptance then resolves it: probe runs and the already persisted
    // result is delivered exactly once, without resetting the installed
    // owner's identity.
    let resultReady = false;
    const harness = createHarness(
      completedTranscript(() => resultReady),
      undefined,
      false,
      { handoffExpiryMs: 40, stabilizationProbeDelayMs: 0 },
    );
    const gen = harness.run.generation;

    expect(
      harness.tracker.prepareObservation({
        taskID: 'ses_child',
        generation: gen,
        parentSessionID: 'parent',
        baselineMessageID: 'baseline',
        description: 'inspect the change',
      }),
    ).toBe(true);

    // First expiry promotes; the unresolved-admission bound is a second
    // window of the same length. Assert the fenced promoted state in
    // between, then admit before that bound lifts.
    const attemptStart = harness.tracker.attemptStartedAtFor('ses_child', gen);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.tracker.attemptStartedAtFor('ses_child', gen)).toBe(
      attemptStart,
    );
    const revision = harness.tracker.revisionFor('ses_child', gen);
    expect(harness.tracker.isTracked('ses_child', gen)).toBe(true);
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(true);
    expect(harness.board.get('ses_child')?.state).toBe('running');

    // The late acceptance resolves it and fires the delivering probe.
    resultReady = true;
    expect(harness.tracker.admitObservation('ses_child', gen)).toBe(true);
    expect(harness.tracker.attemptStartedAtFor('ses_child', gen)).toBe(
      attemptStart,
    );
    expect(harness.tracker.revisionFor('ses_child', gen)).toBe(revision);
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(false);
    await flushNotify();
    expect(harness.board.get('ses_child')?.state).toBe('completed');
    expect(harness.board.get('ses_child')?.resultSummary).toBe('new result');
    expect(harness.prompt).toHaveBeenCalledTimes(1);
  });

  test('handoff: unresolved transport failure converts the preparation into the owner', () => {
    // A transport failure without a response does not prove refusal —
    // ownership converts instead of being dropped.
    const harness = createHarness(completedTranscript(() => false));
    const gen = harness.run.generation;
    harness.tracker.prepareObservation({
      taskID: 'ses_child',
      generation: gen,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });

    expect(harness.tracker.settleObservationUnresolved('ses_child', gen)).toBe(
      true,
    );
    // Owner installed, admission still unresolved → gate still fenced.
    expect(harness.tracker.isTracked('ses_child', gen)).toBe(true);
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(true);

    // A subsequent explicit host refusal releases it.
    harness.tracker.rejectObservation('ses_child', gen);
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(false);
  });

  test('handoff: unresolved admission lifts the fence after a bound without dropping the owner', async () => {
    const harness = createHarness(
      completedTranscript(() => false),
      undefined,
      false,
      { handoffExpiryMs: 5, stabilizationProbeDelayMs: 0 },
    );
    const gen = harness.run.generation;
    harness.tracker.prepareObservation({
      taskID: 'ses_child',
      generation: gen,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });

    expect(harness.tracker.settleObservationUnresolved('ses_child', gen)).toBe(
      true,
    );
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(true);
    expect(harness.tracker.isTracked('ses_child', gen)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(false);
    expect(harness.tracker.isTracked('ses_child', gen)).toBe(true);
  });

  test('handoff: prepare refuses a stale generation', () => {
    const harness = createHarness(completedTranscript(() => false));
    const gen = harness.run.generation;

    expect(
      harness.tracker.prepareObservation({
        taskID: 'ses_child',
        generation: gen + 1,
        parentSessionID: 'parent',
        description: 'stale attempt',
      }),
    ).toBe(false);
    expect(harness.tracker.isObservationPending('ses_child', gen + 1)).toBe(
      false,
    );
  });

  test('revision changes on re-registration even with an identical baseline', () => {
    // Baseline value alone is not an observation identity — two
    // fallback observations can both carry undefined (or the same)
    // baseline; the monotonic revision fences them.
    const harness = createHarness(completedTranscript(() => false));
    const gen = harness.run.generation;
    harness.tracker.register({
      taskID: 'ses_child',
      generation: gen,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'first',
    });
    const first = harness.tracker.revisionFor('ses_child', gen);
    expect(typeof first).toBe('number');

    harness.tracker.register({
      taskID: 'ses_child',
      generation: gen,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'second',
    });
    expect(harness.tracker.revisionFor('ses_child', gen)).not.toBe(first);

    // Stale generations never resolve a revision.
    expect(harness.tracker.revisionFor('ses_child', gen + 1)).toBeUndefined();
  });

  // ── willNotifyParent: publication-wake suppression predicate ──
  //
  // The terminal-publication wake listener (src/index.ts) consults this
  // predicate to skip the wake when the tracker owns delivery for the
  // exact (taskID, generation): a revived run's completion must produce
  // ONE queued admission (the tracker's notifyParent), never two.
  describe('willNotifyParent', () => {
    test('claims delivery for a tracked run before, during, and after its notification', async () => {
      let resultReady = false;
      const harness = createHarness(completedTranscript(() => resultReady));
      const gen = harness.run.generation;

      // Untracked / stale: the wake is the deliverer.
      expect(harness.tracker.willNotifyParent('ses_child', gen)).toBe(false);
      expect(harness.tracker.willNotifyParent('unknown', gen)).toBe(false);

      harness.tracker.register({
        taskID: 'ses_child',
        generation: gen,
        parentSessionID: 'parent',
        baselineMessageID: 'baseline',
        description: 'inspect the change',
      });
      expect(harness.tracker.willNotifyParent('ses_child', gen)).toBe(true);
      expect(harness.tracker.willNotifyParent('ses_child', gen + 1)).toBe(
        false,
      );

      resultReady = true;
      await harness.tracker.probe('ses_child', gen);
      await flushNotify();
      expect(harness.prompt).toHaveBeenCalledTimes(1);
      // Delivered (sent): the tracker still owns this run's delivery —
      // a wake beside it would double-notify.
      expect(harness.tracker.willNotifyParent('ses_child', gen)).toBe(true);
    });

    test('releases ownership once the retry budget is exhausted', async () => {
      const harness = createHarness(
        () => ({ data: [] }),
        mock(async () => {
          throw new Error('parent unavailable');
        }),
        false,
        { maxNotificationRetries: 1 },
      );
      publish(harness);
      await flushNotify();
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Attempt 1 of 1 failed; no retry is scheduled, so the tracker
      // will never deliver — the publication wake is the legitimate
      // degraded fallback and must not be suppressed.
      expect(harness.prompt).toHaveBeenCalledTimes(1);
      expect(
        harness.tracker.willNotifyParent(
          harness.run.taskID,
          harness.run.generation,
        ),
      ).toBe(false);

      // Contrast: with budget remaining (a retry scheduled), the
      // tracker still owns delivery.
      const retrying = createHarness(
        () => ({ data: [] }),
        mock(async () => {
          throw new Error('parent unavailable');
        }),
      );
      publish(retrying);
      await flushNotify();
      expect(retrying.prompt).toHaveBeenCalledTimes(1);
      expect(
        retrying.tracker.willNotifyParent(
          retrying.run.taskID,
          retrying.run.generation,
        ),
      ).toBe(true);
      retrying.tracker.dispose();
    });
  });

  describe('onOwnershipReleased', () => {
    test('fires exactly once with the run ids when every retry fails', async () => {
      const released: Array<{
        parentSessionID: string;
        taskID: string;
        generation: number;
      }> = [];
      const harness = createHarness(
        () => ({ data: [] }),
        mock(async () => {
          throw new Error('parent unavailable');
        }),
        false,
        {
          maxNotificationRetries: 2,
          onOwnershipReleased: (parentSessionID, taskID, generation) => {
            released.push({ parentSessionID, taskID, generation });
          },
        },
      );
      const terminal = publish(harness);
      await flushNotify();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Attempt 1 failed, one retry fired and failed: the budget is
      // spent with nothing sent and no timer armed — the organic
      // give-up point.
      expect(harness.prompt).toHaveBeenCalledTimes(2);
      expect(released).toEqual([
        {
          parentSessionID: 'parent',
          taskID: harness.run.taskID,
          generation: harness.run.generation,
        },
      ]);

      // A duplicate terminal observation of the SAME revision re-enters
      // notifyParent (a third transport attempt) but must NOT re-fire
      // the release: exactly-once per notification lifecycle.
      harness.tracker.onTerminal(terminal);
      await flushNotify();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(harness.prompt).toHaveBeenCalledTimes(3);
      expect(released).toHaveLength(1);

      // Plain dispose never fires the release either.
      harness.tracker.dispose();
      expect(released).toHaveLength(1);
    });

    test('never fires on successful delivery', async () => {
      const released: string[] = [];
      let resultReady = false;
      const harness = createHarness(
        completedTranscript(() => resultReady),
        mock(async () => ({})),
        false,
        {
          onOwnershipReleased: (parentSessionID) =>
            released.push(parentSessionID),
        },
      );
      harness.tracker.register({
        taskID: harness.run.taskID,
        generation: harness.run.generation,
        parentSessionID: 'parent',
        baselineMessageID: 'baseline',
        description: 'inspect the change',
      });
      resultReady = true;
      await harness.tracker.probe(harness.run.taskID, harness.run.generation);
      await flushNotify();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(harness.prompt).toHaveBeenCalledTimes(1);
      expect(released).toEqual([]);
      harness.tracker.dispose();
    });
  });
});
