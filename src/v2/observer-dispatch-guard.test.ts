import { describe, expect, test } from 'bun:test';
import type { ModelImageCapabilityRef } from '../utils/model-image-capability';
import { createTimerHarness } from '../utils/test-timers';
import { createObserverDispatchGuard } from './observer-dispatch-guard';
import type { V2ToolBeforeEvent } from './types';

const REFUSAL_MESSAGE =
  'Observer delegation is unnecessary: the current model accepts images. Read and analyze the visual file directly.';

const VISION: ModelImageCapabilityRef = { providerID: 'acme', id: 'vision' };
const TEXT_ONLY: ModelImageCapabilityRef = { providerID: 'acme', id: 'text' };

function assistantRow(id: string, model: unknown): Record<string, unknown> {
  return { id, type: 'assistant', model };
}

function makeEvent(
  overrides: Partial<V2ToolBeforeEvent> = {},
): V2ToolBeforeEvent {
  return {
    tool: 'subagent',
    sessionID: 'ses_parent',
    agent: 'orchestrator',
    messageID: 'msg_call',
    id: 'call_1',
    input: { agent: 'observer', prompt: 'analyze shot.png' },
    ...overrides,
  };
}

interface GuardHarnessOptions {
  rows?: unknown;
  names?: readonly string[];
  observerNames?: () => readonly string[];
  context?: (input: {
    sessionID: string;
  }) => Promise<Array<Record<string, unknown>>>;
  /** Omit the host context read entirely. */
  withoutContext?: boolean;
  getSession?: (input: { sessionID: string }) => Promise<unknown>;
  accepts?: (ref: ModelImageCapabilityRef) => Promise<boolean | undefined>;
}

function observe(options: GuardHarnessOptions = {}) {
  const contextReads: Array<{ sessionID: string }> = [];
  const capabilityReads: ModelImageCapabilityRef[] = [];
  const getSessionReads: Array<{ sessionID: string }> = [];
  const contextImpl =
    options.context ??
    (async () => (options.rows ?? []) as Array<Record<string, unknown>>);
  const getSessionImpl = options.getSession;
  const guard = createObserverDispatchGuard({
    observerNames:
      options.observerNames ?? (() => options.names ?? ['observer']),
    ...(options.withoutContext
      ? {}
      : {
          context: async (input: { sessionID: string }) => {
            contextReads.push(input);
            return contextImpl(input);
          },
        }),
    ...(getSessionImpl
      ? {
          getSession: async (input: { sessionID: string }) => {
            getSessionReads.push(input);
            return getSessionImpl(input);
          },
        }
      : {}),
    acceptsImages: async (ref) => {
      capabilityReads.push(ref);
      return options.accepts ? options.accepts(ref) : true;
    },
  });
  return { guard, contextReads, capabilityReads, getSessionReads };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the guard to reject');
}

function expectRefusal(error: unknown): void {
  if (!(error instanceof Error)) throw new Error('expected an Error');
  expect(error.message).toBe(REFUSAL_MESSAGE);
}

describe('createObserverDispatchGuard', () => {
  test('timeout allows the call even when the capability resolves true later', async () => {
    const timers = createTimerHarness();
    let resolveCapability!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      resolveCapability = resolve;
    });
    const event = makeEvent();
    const snapshot = structuredClone(event);
    const guard = createObserverDispatchGuard({
      observerNames: () => ['observer'],
      context: async () => [assistantRow('msg_call', VISION)],
      acceptsImages: () => pending,
      timers,
    });
    const operation = guard(event);
    await timers.tick();
    expect(timers.pending()).toBe(1);
    await timers.advance(2_000);
    await expect(operation).resolves.toBeUndefined();
    resolveCapability(true);
    await timers.tick();
    expect(timers.pending()).toBe(0);
    expect(event).toEqual(snapshot);
    await expect(operation).resolves.toBeUndefined();
  });

  test('denies observer delegation when the exact caller model accepts images', async () => {
    const { guard, contextReads, capabilityReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
    });

    expectRefusal(await rejection(guard(makeEvent())));
    expect(contextReads).toEqual([{ sessionID: 'ses_parent' }]);
    expect(capabilityReads).toEqual([VISION]);
  });

  test('allows when the caller model is known not to accept images', async () => {
    const { guard, capabilityReads } = observe({
      rows: [assistantRow('msg_call', TEXT_ONLY)],
      accepts: async () => false,
    });

    await expect(guard(makeEvent())).resolves.toBeUndefined();
    expect(capabilityReads).toEqual([TEXT_ONLY]);
  });

  test('allows when image capability is unknown', async () => {
    const { guard, capabilityReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
      accepts: async () => undefined,
    });

    await expect(guard(makeEvent())).resolves.toBeUndefined();
    expect(capabilityReads).toEqual([VISION]);
  });

  test('allows a malformed capability result', async () => {
    const { guard } = observe({
      rows: [assistantRow('msg_call', VISION)],
      accepts: async () => null as unknown as undefined,
    });

    await expect(guard(makeEvent())).resolves.toBeUndefined();
  });

  test('allows without any read when the host exposes no context read', async () => {
    const { guard, contextReads, capabilityReads } = observe({
      withoutContext: true,
      rows: [assistantRow('msg_call', VISION)],
    });

    await expect(guard(makeEvent())).resolves.toBeUndefined();
    expect(contextReads).toHaveLength(0);
    expect(capabilityReads).toHaveLength(0);
  });

  test('reads nothing for non-subagent tools', async () => {
    const { guard, contextReads, capabilityReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
    });

    for (const tool of ['task', 'read', 'patch']) {
      await expect(guard(makeEvent({ tool }))).resolves.toBeUndefined();
    }
    expect(contextReads).toHaveLength(0);
    expect(capabilityReads).toHaveLength(0);
  });

  test('reads nothing for non-observer targets', async () => {
    const { guard, contextReads, capabilityReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
      names: ['observer', 'visual-analyst'],
    });

    await expect(
      guard(makeEvent({ input: { agent: 'fixer' } })),
    ).resolves.toBeUndefined();
    await expect(
      guard(makeEvent({ input: { agent: 'observer-extra' } })),
    ).resolves.toBeUndefined();
    expect(contextReads).toHaveLength(0);
    expect(capabilityReads).toHaveLength(0);
  });

  test('reads nothing for malformed inputs or missing identifiers', async () => {
    const cases: Array<Partial<V2ToolBeforeEvent>> = [
      { input: null },
      { input: undefined },
      { input: [{ agent: 'observer' }] },
      { input: 'observer' },
      { input: { agent: 42 } },
      { input: { prompt: 'no agent' } },
      { messageID: '' },
      { messageID: 42 as unknown as string },
      { sessionID: '' },
      { sessionID: null as unknown as string },
    ];

    for (const overrides of cases) {
      const { guard, contextReads, capabilityReads } = observe({
        rows: [assistantRow('msg_call', VISION)],
      });
      await expect(guard(makeEvent(overrides))).resolves.toBeUndefined();
      expect(contextReads).toHaveLength(0);
      expect(capabilityReads).toHaveLength(0);
    }
  });

  test('allows when the context read fails', async () => {
    const { guard, capabilityReads } = observe({
      context: async () => {
        throw new Error('context read failed');
      },
    });

    await expect(guard(makeEvent())).resolves.toBeUndefined();
    expect(capabilityReads).toHaveLength(0);
  });

  test('allows when the capability read fails', async () => {
    const { guard, contextReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
      accepts: async () => {
        throw new Error('registry read failed');
      },
    });

    await expect(guard(makeEvent())).resolves.toBeUndefined();
    expect(contextReads).toEqual([{ sessionID: 'ses_parent' }]);
  });

  test('allows and reads no capability for malformed transcript/model shapes', async () => {
    const malformedRows: unknown[] = [
      'not-an-array',
      {},
      [{}],
      [{ id: 'msg_call' }],
      [{ id: 'msg_call', type: 'user', model: VISION }],
      [{ id: 'msg_call', type: 'assistant' }],
      [assistantRow('msg_call', null)],
      [assistantRow('msg_call', [])],
      [assistantRow('msg_call', {})],
      [assistantRow('msg_call', { providerID: '', id: 'vision' })],
      [assistantRow('msg_call', { providerID: 'acme', id: '' })],
      [assistantRow('msg_call', { providerID: 42, id: 'vision' })],
      [assistantRow('msg_call', { providerID: 'acme', id: 42 })],
    ];

    for (const rows of malformedRows) {
      const { guard, capabilityReads } = observe({ rows });
      await expect(guard(makeEvent())).resolves.toBeUndefined();
      expect(capabilityReads).toHaveLength(0);
    }
  });

  test('never reuses an assistant row for a different message ID', async () => {
    const { guard, capabilityReads } = observe({
      rows: [
        assistantRow('msg_other', VISION),
        { id: 'msg_call', type: 'user', model: VISION },
      ],
    });

    await expect(guard(makeEvent())).resolves.toBeUndefined();
    expect(capabilityReads).toHaveLength(0);
  });

  test('reads the tool-call message model, never the latest assistant', async () => {
    const { guard, capabilityReads } = observe({
      rows: [
        assistantRow('msg_older', TEXT_ONLY),
        assistantRow('msg_latest', VISION),
      ],
      accepts: async (ref) => ref.id === VISION.id,
    });

    await expect(
      guard(makeEvent({ messageID: 'msg_older' })),
    ).resolves.toBeUndefined();
    expectRefusal(
      await rejection(guard(makeEvent({ messageID: 'msg_latest' }))),
    );
    expect(capabilityReads).toEqual([TEXT_ONLY, VISION]);
  });

  test('recognizes a runtime observer display-name alias', async () => {
    const { guard, capabilityReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
      names: ['observer', 'visual-analyst'],
    });

    expectRefusal(
      await rejection(guard(makeEvent({ input: { agent: 'visual-analyst' } }))),
    );
    expect(capabilityReads).toEqual([VISION]);
  });

  test('ignores the child target model when judging the parent capability', async () => {
    const { guard, capabilityReads } = observe({
      rows: [assistantRow('msg_call', TEXT_ONLY)],
      accepts: async () => false,
    });

    await expect(
      guard(
        makeEvent({
          input: {
            agent: 'observer',
            sessionID: 'ses_child',
            model: { providerID: 'child', id: 'child-vision' },
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(capabilityReads).toEqual([TEXT_ONLY]);
  });

  test('judges a resume on the parent caller, never the resumed child session', async () => {
    const { guard, contextReads, capabilityReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
    });

    expectRefusal(
      await rejection(
        guard(
          makeEvent({
            input: {
              agent: 'observer',
              sessionID: 'ses_observer_child',
              prompt: 'continue the analysis',
            },
          }),
        ),
      ),
    );
    expect(contextReads).toEqual([{ sessionID: 'ses_parent' }]);
    expect(capabilityReads).toEqual([VISION]);
  });

  test('leaves non-observer resumes untouched with zero reads', async () => {
    const { guard, contextReads, capabilityReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
    });

    await expect(
      guard(
        makeEvent({
          input: {
            agent: 'fixer',
            sessionID: 'ses_child',
            prompt: 'continue',
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(contextReads).toHaveLength(0);
    expect(capabilityReads).toHaveLength(0);
  });

  test('one callable re-resolves image → text → image with no ledger', async () => {
    let currentModel = VISION;
    const contextReads: string[] = [];
    const capabilityReads: ModelImageCapabilityRef[] = [];
    const guard = createObserverDispatchGuard({
      observerNames: () => ['observer'],
      context: async ({ sessionID }) => {
        contextReads.push(sessionID);
        return [assistantRow('msg_call', currentModel)];
      },
      acceptsImages: async (ref) => {
        capabilityReads.push(ref);
        return ref.id === VISION.id;
      },
    });

    expectRefusal(await rejection(guard(makeEvent())));
    currentModel = TEXT_ONLY;
    await expect(guard(makeEvent())).resolves.toBeUndefined();
    currentModel = VISION;
    expectRefusal(await rejection(guard(makeEvent())));

    expect(contextReads).toEqual(['ses_parent', 'ses_parent', 'ses_parent']);
    expect(capabilityReads).toEqual([VISION, TEXT_ONLY, VISION]);
  });

  test('never mutates the event, its input, or the transcript rows', async () => {
    const input = Object.freeze({
      agent: 'observer',
      prompt: 'analyze shot.png',
      model: Object.freeze({ providerID: 'child', id: 'child-vision' }),
    });
    const rows = Object.freeze([
      Object.freeze(assistantRow('msg_call', Object.freeze({ ...VISION }))),
    ]);
    const event = Object.freeze(makeEvent({ input }));
    const snapshot = structuredClone({ event: { ...event }, rows });
    const guard = createObserverDispatchGuard({
      observerNames: () => ['observer'],
      context: async () => rows as unknown as Array<Record<string, unknown>>,
      acceptsImages: async () => true,
    });

    expectRefusal(await rejection(guard(event)));
    expect(event.input).toBe(input);
    expect(event).toEqual(snapshot.event);
    expect(rows).toEqual(snapshot.rows);
    expect(rows[0]).toEqual(assistantRow('msg_call', VISION));
  });

  test('refuses an omitted-agent observer resume on a known vision caller', async () => {
    const { guard, getSessionReads, contextReads, capabilityReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
      getSession: async () => ({
        id: 'ses_observer_child',
        parentID: 'ses_parent',
        agent: 'observer',
      }),
    });

    expectRefusal(
      await rejection(
        guard(
          makeEvent({
            input: {
              sessionID: 'ses_observer_child',
              prompt: 'continue the analysis',
            },
          }),
        ),
      ),
    );
    expect(getSessionReads).toEqual([{ sessionID: 'ses_observer_child' }]);
    expect(contextReads).toEqual([{ sessionID: 'ses_parent' }]);
    expect(capabilityReads).toEqual([VISION]);
  });

  test('allows an omitted-agent observer resume on a text-only caller', async () => {
    const { guard, getSessionReads, capabilityReads } = observe({
      rows: [assistantRow('msg_call', TEXT_ONLY)],
      accepts: async () => false,
      getSession: async () => ({
        id: 'ses_observer_child',
        parentID: 'ses_parent',
        agent: 'observer',
      }),
    });

    await expect(
      guard(
        makeEvent({
          input: { sessionID: 'ses_observer_child', prompt: 'continue' },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(getSessionReads).toEqual([{ sessionID: 'ses_observer_child' }]);
    expect(capabilityReads).toEqual([TEXT_ONLY]);
  });

  test('allows an omitted-agent nonobserver resume with no context or capability reads', async () => {
    const { guard, getSessionReads, contextReads, capabilityReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
      getSession: async () => ({
        id: 'ses_child',
        parentID: 'ses_parent',
        agent: 'fixer',
      }),
    });

    await expect(
      guard(
        makeEvent({
          input: { sessionID: 'ses_child', prompt: 'continue' },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(getSessionReads).toEqual([{ sessionID: 'ses_child' }]);
    expect(contextReads).toHaveLength(0);
    expect(capabilityReads).toHaveLength(0);
  });

  test('leaves a foreign-parent or malformed child resume to native validation', async () => {
    const childPayloads: unknown[] = [
      { id: 'ses_child', parentID: 'ses_other', agent: 'observer' },
      { id: 'ses_child', agent: 'observer' },
      { id: 'ses_child', parentID: 'ses_parent' },
      { id: 'ses_child', parentID: 'ses_parent', agent: '' },
      { id: 'ses_child', parentID: 'ses_parent', agent: 42 },
      { id: 'ses_child', parentID: 'ses_parent', agent: null },
      null,
      'not-an-object',
      { data: { parentID: 'ses_other', agent: 'observer' } },
    ];

    for (const payload of childPayloads) {
      const { guard, getSessionReads, contextReads, capabilityReads } = observe(
        {
          rows: [assistantRow('msg_call', VISION)],
          getSession: async () => payload,
        },
      );
      await expect(
        guard(
          makeEvent({
            input: { sessionID: 'ses_child', prompt: 'continue' },
          }),
        ),
      ).resolves.toBeUndefined();
      expect(getSessionReads).toEqual([{ sessionID: 'ses_child' }]);
      expect(contextReads).toHaveLength(0);
      expect(capabilityReads).toHaveLength(0);
    }
  });

  test('unwraps a data-wrapped session.get payload for an omitted-agent resume', async () => {
    const { guard, capabilityReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
      names: ['observer', 'visual-analyst'],
      getSession: async () => ({
        data: {
          id: 'ses_child',
          parentID: 'ses_parent',
          agent: 'visual-analyst',
        },
      }),
    });

    expectRefusal(
      await rejection(
        guard(
          makeEvent({ input: { sessionID: 'ses_child', prompt: 'continue' } }),
        ),
      ),
    );
    expect(capabilityReads).toEqual([VISION]);
  });

  test('fails open when session.get throws for an omitted-agent resume', async () => {
    const { guard, getSessionReads, contextReads, capabilityReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
      getSession: async () => {
        throw new Error('session.get failed');
      },
    });

    await expect(
      guard(
        makeEvent({ input: { sessionID: 'ses_child', prompt: 'continue' } }),
      ),
    ).resolves.toBeUndefined();
    expect(getSessionReads).toEqual([{ sessionID: 'ses_child' }]);
    expect(contextReads).toHaveLength(0);
    expect(capabilityReads).toHaveLength(0);
  });

  test('allows an omitted-agent resume untouched when session.get is absent', async () => {
    const { guard, getSessionReads, contextReads, capabilityReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
    });

    await expect(
      guard(
        makeEvent({ input: { sessionID: 'ses_child', prompt: 'continue' } }),
      ),
    ).resolves.toBeUndefined();
    expect(getSessionReads).toHaveLength(0);
    expect(contextReads).toHaveLength(0);
    expect(capabilityReads).toHaveLength(0);
  });

  test('normalizes a legacy task_id resume and prefers a canonical sessionID', async () => {
    const { guard, getSessionReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
      getSession: async () => ({
        id: 'ses_child',
        parentID: 'ses_parent',
        agent: 'observer',
      }),
    });

    expectRefusal(
      await rejection(
        guard(
          makeEvent({ input: { task_id: 'ses_legacy', prompt: 'continue' } }),
        ),
      ),
    );
    expectRefusal(
      await rejection(
        guard(
          makeEvent({
            input: {
              sessionID: 'ses_canonical',
              task_id: 'ses_legacy',
              prompt: 'continue',
            },
          }),
        ),
      ),
    );
    expect(getSessionReads).toEqual([
      { sessionID: 'ses_legacy' },
      { sessionID: 'ses_canonical' },
    ]);
  });

  test('explicit nonobserver target with a resume id performs zero host reads', async () => {
    const { guard, getSessionReads, contextReads, capabilityReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
      getSession: async () => ({
        id: 'ses_child',
        parentID: 'ses_parent',
        agent: 'observer',
      }),
    });

    await expect(
      guard(
        makeEvent({
          input: {
            agent: 'fixer',
            sessionID: 'ses_child',
            prompt: 'continue',
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(getSessionReads).toHaveLength(0);
    expect(contextReads).toHaveLength(0);
    expect(capabilityReads).toHaveLength(0);
  });

  test('a throwing name resolver degrades to canonical observer only', async () => {
    const { guard, contextReads, capabilityReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
      observerNames: () => {
        throw new Error('registry not finalized');
      },
    });

    expectRefusal(
      await rejection(guard(makeEvent({ input: { agent: 'observer' } }))),
    );
    await expect(
      guard(makeEvent({ input: { agent: 'fixer' } })),
    ).resolves.toBeUndefined();
    // The alias no longer matches with the runtime names unavailable.
    await expect(
      guard(makeEvent({ input: { agent: 'visual-analyst' } })),
    ).resolves.toBeUndefined();
    expect(contextReads).toEqual([{ sessionID: 'ses_parent' }]);
    expect(capabilityReads).toEqual([VISION]);
  });

  test('a throwing name resolver never rejects unrelated calls', async () => {
    const { guard, getSessionReads, contextReads, capabilityReads } = observe({
      rows: [assistantRow('msg_call', VISION)],
      observerNames: () => {
        throw new Error('registry not finalized');
      },
      getSession: async () => ({
        id: 'ses_child',
        parentID: 'ses_parent',
        agent: 'observer',
      }),
    });

    await expect(
      guard(
        makeEvent({
          input: {
            agent: 'fixer',
            sessionID: 'ses_child',
            prompt: 'continue',
          },
        }),
      ),
    ).resolves.toBeUndefined();
    // Canonical still classifies an omitted-agent observer resume.
    expectRefusal(
      await rejection(
        guard(
          makeEvent({ input: { sessionID: 'ses_child', prompt: 'continue' } }),
        ),
      ),
    );
    expect(getSessionReads).toEqual([{ sessionID: 'ses_child' }]);
    expect(contextReads).toEqual([{ sessionID: 'ses_parent' }]);
    expect(capabilityReads).toEqual([VISION]);
  });
});
