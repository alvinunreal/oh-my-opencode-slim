/**
 * Tests for the v2 → v1 event mapper.
 *
 * The synthesized v1 shapes here are pinned to what the v1 consumers
 * actually read:
 * - `session.created` early registration (task-session-manager
 *   event-router): `properties.info.{id,parentID,agent?}` — plugin
 *   relevance is gated on `info.parentID` (child sessions only).
 * - `message.updated` telemetry (cache-monitor parseCompletedAssistantMessage):
 *   `properties.info.{role:'assistant', sessionID, id, time.completed,
 *   tokens.input, tokens.cache.read, tokens.cache.write}`.
 */
import { describe, expect, test } from 'bun:test';
import { createCacheMonitorHook } from '../hooks/cache-monitor';
import { mapV2EventToV1 } from './event-adapter';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function v2Usage(overrides: {
  input: number;
  read: number;
  write?: number;
  timestamp?: number;
  messageID?: string;
}): Record<string, unknown> {
  return {
    id: `evt_${overrides.messageID ?? 'msg_1'}`,
    created: overrides.timestamp ?? 0,
    type: 'session.step.ended',
    data: deepFreeze({
      sessionID: 'ses_map',
      assistantMessageID: overrides.messageID ?? 'msg_1',
      finish: 'stop',
      cost: 0,
      tokens: {
        input: overrides.input,
        output: 5,
        reasoning: 0,
        cache: { read: overrides.read, write: overrides.write ?? 0 },
      },
    }),
  };
}

/**
 * Plugin ctx for task-session-manager hooks built in this file. The
 * `client.session` stub (no `get`/`messages`) keeps the terminal gate's
 * reads inert by construction instead of relying on `{}` — a ctx without
 * `client` throws once another file's `mock.module` of
 * `utils/opencode-client` leaks into this one and dereferences
 * `ctx.client.session`.
 */
function createHookCtx(): never {
  return { client: { session: {} }, directory: '/tmp/proj' } as never;
}

describe('mapV2EventToV1', () => {
  test('shutdown interruption preserves a suspended round without synthesizing idle', () => {
    // v2.1.2 execution/restart.ts resumes the claim; message-updater.ts and
    // projector.ts deliberately do not publish an idle for shutdown.
    const event = {
      id: 'evt_shutdown',
      created: 100,
      type: 'session.execution.interrupted',
      durable: { aggregateID: 'ses_child', seq: 1, version: 1 },
      data: { sessionID: 'ses_child', reason: 'shutdown' },
    };
    const events = mapV2EventToV1(event);
    expect(events).toEqual([event]);
    expect(events[0]).toBe(event);
  });

  test('passes unknown events through unchanged (raw reference first)', () => {
    const ev = { type: 'permission.asked', properties: { sessionID: 's' } };
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(ev);
  });

  test('does not map session.retry.scheduled into a v1 retry status', () => {
    // Mapping it to session.status retry would reactivate the broken abort path.
    const event = {
      type: 'session.retry.scheduled',
      properties: { sessionID: 's' },
    };
    expect(mapV2EventToV1(event)).toEqual([event]);
  });

  test('v2.0.7 location.shutdown (config reload) stays passthrough-only', () => {
    // Ephemeral host event (payload under `data`, live framing) published
    // when `opencode reload` tears down and rebuilds every location.
    // Nothing is synthesized from it: raw passthrough, no throw, no v1
    // shape fabrication — v1 consumers ignore event types they do not
    // know, and plugin teardown rides the dispose chain instead.
    const ev = deepFreeze({
      id: 'evt_shutdown',
      created: '2026-09-18T00:00:00.000Z',
      type: 'location.shutdown',
      durable: false,
      data: {},
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(ev);
  });

  test('never mutates the input event', () => {
    const ev = deepFreeze(
      v2Usage({ input: 10, read: 100, write: 20, timestamp: 1_700_000_000 }),
    );
    expect(() => mapV2EventToV1(ev)).not.toThrow();
  });

  test('maps session.created with parentID into v1 early-registration shape', () => {
    const ev = {
      type: 'session.created',
      properties: { sessionID: 'child_1', parentID: 'parent_1', title: 't' },
    };
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    // Exact shape event-router reads: info.id + info.parentID gate the
    // early board registration; info.agent disambiguates parallel task
    // calls (absent here → omitted).
    expect(out[1]).toEqual({
      type: 'session.created',
      properties: { info: { id: 'child_1', parentID: 'parent_1', title: 't' } },
    });
  });

  test('passes agent through on session.created when the host provides it', () => {
    const out = mapV2EventToV1({
      type: 'session.created',
      properties: {
        sessionID: 'child_1',
        parentID: 'parent_1',
        agent: 'fixer',
      },
    });
    expect(out[1]).toEqual({
      type: 'session.created',
      properties: {
        info: { id: 'child_1', parentID: 'parent_1', agent: 'fixer' },
      },
    });
  });

  test('session.created without parentID stays passthrough-only', () => {
    // Root sessions are not plugin-relevant for early registration —
    // event-router gates on info.parentID, so no v1 shape is synthesized.
    expect(
      mapV2EventToV1({
        type: 'session.created',
        properties: { sessionID: 'root_1', title: 't' },
      }),
    ).toHaveLength(1);
  });

  test('maps usage telemetry into v1 message.updated shape for cache-monitor', () => {
    const out = mapV2EventToV1(v2Usage({ input: 10, read: 100, write: 20 }));
    expect(out).toHaveLength(2);
    // The assistant identity deduplicates replays without merging requests.
    expect(out[1]).toEqual({
      type: 'message.updated',
      properties: {
        info: {
          id: 'v2-usage:msg_1',
          role: 'assistant',
          sessionID: 'ses_map',
          time: { completed: 0 },
          tokens: {
            input: 10,
            output: 5,
            reasoning: 0,
            cache: { read: 100, write: 20 },
          },
        },
      },
    });
    expect(
      mapV2EventToV1(v2Usage({ input: 10, read: 100, write: 20 }))[1],
    ).toEqual(out[1]);
    expect(
      mapV2EventToV1(
        v2Usage({ input: 10, read: 100, write: 20, messageID: 'msg_2' }),
      )[1],
    ).not.toEqual(out[1]);
  });

  test('maps session.step.ended telemetry with timestamp passthrough', () => {
    const out = mapV2EventToV1({
      id: 'evt_2',
      created: 1_700_000_000,
      type: 'session.step.ended',
      data: {
        sessionID: 'ses_map',
        assistantMessageID: 'msg_2',
        finish: 'stop',
        cost: 0,
        tokens: { input: 7, output: 3, cache: { read: 40, write: 5 } },
      },
    });
    expect(out[1]).toEqual({
      type: 'message.updated',
      properties: {
        info: {
          id: 'v2-usage:msg_2',
          role: 'assistant',
          sessionID: 'ses_map',
          time: { completed: 1_700_000_000 },
          tokens: {
            input: 7,
            output: 3,
            reasoning: 0,
            cache: { read: 40, write: 5 },
          },
        },
      },
    });
  });

  test('mapped steps feed the real cache-monitor', async () => {
    const warnings: Array<{ message: string; data: unknown }> = [];
    const monitor = createCacheMonitorHook({
      logger: (message, data) => warnings.push({ message, data }),
    });
    for (const event of [
      v2Usage({ messageID: 'msg_1', input: 8000, read: 20082 }),
      v2Usage({ messageID: 'msg_2', input: 8000, read: 20248 }),
      v2Usage({ messageID: 'msg_3', input: 12000, read: 0 }),
    ]) {
      for (const mapped of mapV2EventToV1(event))
        await monitor.event({ event: mapped });
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('prompt-cache bust');
    expect(warnings[0]?.data).toMatchObject({
      requestNumber: 3,
      previousCacheRead: 20248,
    });
  });

  test('raw session.status events stay passthrough-only', () => {
    const ev = deepFreeze({
      id: 'evt_status',
      created: 1_788_961_637_000,
      type: 'session.status',
      data: { sessionID: 'ses_status', status: { type: 'idle' } },
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(ev);
  });
});

describe('mapV2EventToV1 session.execution.* lifecycle synthesis', () => {
  // v2 hosts publish durable
  // session.execution.* events and stream no busy/idle
  // session.status — these tests pin the synthesized v1 lifecycle shapes
  // the wake scheduler / task-session-manager / fallback consumers read.
  test('execution.started synthesizes v1 busy session.status', () => {
    const ev = deepFreeze({
      type: 'session.execution.started',
      properties: { sessionID: 'ses_exec' },
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    expect(out[1]).toEqual({
      type: 'session.status',
      properties: { sessionID: 'ses_exec', status: { type: 'busy' } },
    });
  });

  test('execution.succeeded synthesizes idle session.status + session.idle', () => {
    const ev = deepFreeze({
      type: 'session.execution.succeeded',
      properties: { sessionID: 'ses_exec' },
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(ev);
    expect(out[1]).toEqual({
      type: 'session.status',
      properties: { sessionID: 'ses_exec', status: { type: 'idle' } },
    });
    expect(out[2]).toEqual({
      type: 'session.idle',
      properties: { sessionID: 'ses_exec' },
    });
  });

  test('execution.interrupted synthesizes the same idle pair as succeeded', () => {
    const out = mapV2EventToV1({
      type: 'session.execution.interrupted',
      properties: { sessionID: 'ses_exec', reason: 'user cancel' },
    });
    expect(out).toHaveLength(3);
    expect(out.slice(1)).toEqual([
      {
        type: 'session.status',
        properties: { sessionID: 'ses_exec', status: { type: 'idle' } },
      },
      { type: 'session.idle', properties: { sessionID: 'ses_exec' } },
    ]);
  });

  test.each([
    ['succeeded', ['session.status', 'session.idle']],
    ['interrupted', ['session.status', 'session.idle']],
    ['failed', ['session.error', 'session.status', 'session.idle']],
  ] as const)(
    'execution.%s stamps every synthesized terminal event with envelope `created` in exact order',
    (subtype, expectedTypes) => {
      const created = 1_788_961_638_000;
      const ev = deepFreeze({
        id: `evt_terminal_${subtype}`,
        created,
        type: `session.execution.${subtype}`,
        data: { sessionID: 'ses_exec' },
      });
      const out = mapV2EventToV1(ev);
      expect(out.map((mapped) => mapped.type)).toEqual([
        `session.execution.${subtype}`,
        ...expectedTypes,
      ]);
      expect(out[0]).toBe(ev);
      expect(out[out.length - 2]).toEqual({
        type: 'session.status',
        properties: {
          sessionID: 'ses_exec',
          status: { type: 'idle' },
          activityAt: created,
        },
      });
      // Every synthesized event from the terminal envelope carries the
      // same host activity boundary. A companion without it would fall
      // back to local receipt time and could act on a newer run.
      for (const synthesized of out.slice(1)) {
        expect(
          (synthesized as { properties: Record<string, unknown> }).properties,
        ).toMatchObject({ activityAt: created });
      }
      expect(out[out.length - 1]).toEqual({
        type: 'session.idle',
        properties: { sessionID: 'ses_exec', activityAt: created },
      });
    },
  );

  test.each([
    ['succeeded', ['session.status', 'session.idle']],
    ['interrupted', ['session.status', 'session.idle']],
    ['failed', ['session.error', 'session.status', 'session.idle']],
  ] as const)(
    'execution.%s without a usable envelope `created` omits activityAt in exact order',
    (subtype, expectedTypes) => {
      const missing = Symbol('missing');
      for (const created of [
        missing,
        undefined,
        null,
        'nope',
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        const ev: Record<string, unknown> = {
          id: `evt_terminal_${subtype}`,
          type: `session.execution.${subtype}`,
          data: { sessionID: 'ses_exec' },
        };
        if (created !== missing) ev.created = created;
        const out = mapV2EventToV1(ev);
        expect(out.map((mapped) => mapped.type)).toEqual([
          `session.execution.${subtype}`,
          ...expectedTypes,
        ]);
        for (const synthesized of out.slice(1)) {
          expect(
            Object.hasOwn(
              (synthesized as { properties: Record<string, unknown> })
                .properties,
              'activityAt',
            ),
          ).toBe(false);
        }
        const status = out[out.length - 2];
        expect(status).toEqual({
          type: 'session.status',
          properties: {
            sessionID: 'ses_exec',
            status: { type: 'idle' },
          },
        });
      }
    },
  );

  test('execution.failed emits v1 session.error (host error verbatim) before the idle pair', () => {
    const ev = deepFreeze({
      type: 'session.execution.failed',
      properties: {
        sessionID: 'ses_exec',
        error: { message: 'rate limited', statusCode: 429 },
      },
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(ev);
    // Error-before-idle: the event-router's deferred-inline-error flow
    // expects the error first and terminalizes on the following idle.
    expect(out[1]).toEqual({
      type: 'session.error',
      properties: {
        sessionID: 'ses_exec',
        error: { message: 'rate limited', statusCode: 429 },
      },
    });
    expect(out[2]).toEqual({
      type: 'session.status',
      properties: { sessionID: 'ses_exec', status: { type: 'idle' } },
    });
    expect(out[3]).toEqual({
      type: 'session.idle',
      properties: { sessionID: 'ses_exec' },
    });
  });

  test('execution.failed without an error field degrades to a best-effort message', async () => {
    const out = mapV2EventToV1({
      type: 'session.execution.failed',
      properties: { sessionID: 'ses_exec' },
    });
    expect(out[1]).toEqual({
      type: 'session.error',
      properties: {
        sessionID: 'ses_exec',
        error: { message: 'v2 session execution failed' },
      },
    });
    // The fallback message must NOT classify as a failover error.
    const { isFailoverError } = await import('../hooks/foreground-fallback');
    expect(
      isFailoverError(
        (out[1] as { properties: { error: unknown } }).properties.error,
      ),
    ).toBe(false);
  });

  test('execution events without a sessionID synthesize nothing', () => {
    for (const type of [
      'session.execution.started',
      'session.execution.succeeded',
      'session.execution.failed',
      'session.execution.interrupted',
    ]) {
      expect(mapV2EventToV1({ type, properties: {} })).toHaveLength(1);
    }
  });

  test('unrelated session.execution.* subtypes stay passthrough-only', () => {
    // Only the four verified subtypes map; an unknown variant must not
    // guess a lifecycle meaning.
    const ev = deepFreeze({
      type: 'session.execution.resumed',
      properties: { sessionID: 'ses_exec' },
    });
    expect(mapV2EventToV1(ev)).toEqual([ev]);
  });

  test('synthesized lifecycle pair feeds the real task-session-manager busy path', async () => {
    // End-to-end against the consumer: the synthesized busy status must
    // mark a tracked child running-from-live-session on the board.
    const { createTaskSessionManagerHook } = await import(
      '../hooks/task-session-manager'
    );
    const { BackgroundJobBoard } = await import('../utils');
    const board = new BackgroundJobBoard();
    const hook = createTaskSessionManagerHook(createHookCtx(), {
      maxSessionsPerAgent: 2,
      backgroundJobBoard: board,
      shouldManageSession: (id: string) => id === 'parent-1',
    });
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'exec lifecycle e2e',
      now: 0,
    });
    for (const mapped of mapV2EventToV1({
      type: 'session.execution.started',
      properties: { sessionID: 'child-1' },
    })) {
      await hook.event({ event: mapped });
    }
    // Busy observation landed: lastLiveBusyAt recorded on the running job.
    expect(board.get('child-1')).toMatchObject({ state: 'running' });
    expect(board.get('child-1')?.lastLiveBusyAt).toBeDefined();
  });
});

describe('mapV2EventToV1 live wire shape (payload under `data`)', () => {
  // Live v2 hosts deliver plugin/SSE events as
  // `{id, created, type, location?, durable?, metadata?, data}` with the
  // payload always under `data`. The `properties`
  // spelling used by the tests above is the legacy fallback. These tests
  // pin the live-observed shapes end-to-end through the exact wake-arming
  // chain: execution.succeeded → idle pair → beginContinuousIdle, and
  // session.created → child registration.
  function liveEvent(
    type: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    return deepFreeze({
      id: `evt_${type.replace(/\./g, '_')}`,
      created: 1_788_961_637_000,
      type,
      durable: { aggregateID: data.sessionID ?? 'agg', seq: 1, version: 1 },
      data,
    });
  }

  test('live execution.succeeded synthesizes the v1 idle pair from `data`', () => {
    const ev = liveEvent('session.execution.succeeded', {
      sessionID: 'ses_live',
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(ev);
    // The terminal idle carries the host envelope `created` exactly like
    // the busy status: a delayed delivery must keep the host activity
    // boundary (the terminal gate attributes the run's idle with it).
    expect(out.slice(1)).toEqual([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_live',
          status: { type: 'idle' },
          activityAt: 1_788_961_637_000,
        },
      },
      {
        type: 'session.idle',
        properties: {
          sessionID: 'ses_live',
          activityAt: 1_788_961_637_000,
        },
      },
    ]);
  });

  test.each([
    'session.execution.succeeded',
    'session.execution.failed',
    'session.execution.interrupted',
  ])(
    'live %s carries the envelope `created` onto the synthesized idle status',
    (type) => {
      const ev = liveEvent(type, { sessionID: 'ses_live' });
      const out = mapV2EventToV1(ev);
      const idle = out.find(
        (entry) =>
          entry.type === 'session.status' &&
          (entry.properties as { status?: { type?: string } }).status?.type ===
            'idle',
      );
      expect(idle).toEqual({
        type: 'session.status',
        properties: {
          sessionID: 'ses_live',
          status: { type: 'idle' },
          activityAt: 1_788_961_637_000,
        },
      });
      // The documentation pins the exact consumer bytes; keep them honest.
      expect(out[out.length - 1]).toEqual({
        type: 'session.idle',
        properties: {
          sessionID: 'ses_live',
          activityAt: 1_788_961_637_000,
        },
      });
    },
  );

  test('terminal idle without a usable `created` carries no activityAt', () => {
    for (const created of [
      undefined,
      null,
      'nope',
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const ev = {
        ...liveEvent('session.execution.succeeded', {
          sessionID: 'ses_live',
        }),
        created,
      };
      const out = mapV2EventToV1(ev);
      expect(out[1]).toEqual({
        type: 'session.status',
        properties: {
          sessionID: 'ses_live',
          status: { type: 'idle' },
        },
      });
      expect(out[2]).toEqual({
        type: 'session.idle',
        properties: { sessionID: 'ses_live' },
      });
    }
  });

  test('live execution.failed keeps error-before-idle with the terminal activityAt', () => {
    const ev = liveEvent('session.execution.failed', {
      sessionID: 'ses_live',
      error: { message: 'rate limited' },
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(4);
    expect(out[1]).toEqual({
      type: 'session.error',
      properties: {
        sessionID: 'ses_live',
        error: { message: 'rate limited' },
        activityAt: 1_788_961_637_000,
      },
    });
    expect(out[2]).toEqual({
      type: 'session.status',
      properties: {
        sessionID: 'ses_live',
        status: { type: 'idle' },
        activityAt: 1_788_961_637_000,
      },
    });
    expect(out[3]).toEqual({
      type: 'session.idle',
      properties: {
        sessionID: 'ses_live',
        activityAt: 1_788_961_637_000,
      },
    });
  });

  test('legacy `properties` spellings without `created` stay byte-identical', () => {
    // The regression baseline: shapes synthesized from a payload that has
    // no envelope timestamp must not grow an activityAt field.
    const out = mapV2EventToV1({
      type: 'session.execution.succeeded',
      properties: { sessionID: 'ses_exec' },
    });
    expect(out.slice(1)).toEqual([
      {
        type: 'session.status',
        properties: { sessionID: 'ses_exec', status: { type: 'idle' } },
      },
      { type: 'session.idle', properties: { sessionID: 'ses_exec' } },
    ]);
  });

  test('live execution.started synthesizes v1 busy from `data`', () => {
    const out = mapV2EventToV1(
      liveEvent('session.execution.started', { sessionID: 'ses_live' }),
    );
    expect(out.slice(1)).toEqual([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_live',
          status: { type: 'busy' },
          activityAt: 1_788_961_637_000,
        },
      },
    ]);
  });

  test.each([0, 1_788_961_637_000])(
    'live execution.started preserves a valid envelope `created` as activityAt: %d',
    (created) => {
      const ev = {
        ...liveEvent('session.execution.started', { sessionID: 'ses_live' }),
        created,
      };
      const out = mapV2EventToV1(ev);
      expect(out[0]).toBe(ev);
      expect(out[1]).toEqual({
        type: 'session.status',
        properties: {
          sessionID: 'ses_live',
          status: { type: 'busy' },
          activityAt: created,
        },
      });
    },
  );

  test.each([
    undefined,
    null,
    'nope',
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])(
    'live execution.started without a usable `created` synthesizes no receipt time: %j',
    (created) => {
      const ev = {
        ...liveEvent('session.execution.started', { sessionID: 'ses_live' }),
        created,
      };
      const out = mapV2EventToV1(ev);
      expect(out[1]).toEqual({
        type: 'session.status',
        properties: { sessionID: 'ses_live', status: { type: 'busy' } },
      });
    },
  );

  test('live session.created (flat `data` fields incl. parentID) maps to the v1 early-registration shape', () => {
    // Shape captured from a live v2 host: a subagent child
    // session.created with data.parentID linking it to the orchestrator.
    const out = mapV2EventToV1(
      liveEvent('session.created', {
        sessionID: 'ses_child',
        projectID: 'prj_1',
        location: { directory: '/tmp/proj' },
        subpath: '',
        parentID: 'ses_parent',
        slug: 'playful-orchid',
        title: 'live child detection',
        agent: 'general',
        version: '2.0.2',
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      type: 'session.created',
      properties: {
        info: {
          id: 'ses_child',
          parentID: 'ses_parent',
          title: 'live child detection',
          agent: 'general',
        },
      },
    });
  });
});

describe('mapV2EventToV1 form → question bridge', () => {
  test('form.created synthesizes v1 question.asked with QuestionV1 shape', () => {
    const ev = deepFreeze({
      type: 'form.created',
      data: {
        form: {
          id: 'frm_1',
          sessionID: 'ses_q',
          title: 'Pick one',
          fields: [
            {
              key: 'q0',
              type: 'string',
              title: 'Flavor',
              description: 'Which flavor should I use?',
              options: [
                { value: 'a', label: 'Vanilla', description: 'plain' },
                { value: 'b', label: 'Chocolate' },
              ],
            },
            {
              key: 'q1',
              type: 'multiselect',
              title: 'Extras',
              description: 'Which extras should I add?',
              options: [{ value: 'x', label: 'Sprinkles' }],
            },
          ],
        },
      },
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    // Exact fields the v1 consumers read (input-wait tracker: id +
    // sessionID as the ask requestID) plus the v1 QuestionV1 questions
    // contract (question/header ≤30 chars/options/multiple).
    expect(out[1]).toEqual({
      type: 'question.asked',
      properties: {
        id: 'frm_1',
        sessionID: 'ses_q',
        questions: [
          {
            question: 'Which flavor should I use?',
            header: 'Flavor',
            // The form field key rides along: form replies must key
            // answers by this exact value.
            key: 'q0',
            options: [
              { label: 'Vanilla', description: 'plain' },
              { label: 'Chocolate', description: '' },
            ],
          },
          {
            question: 'Which extras should I add?',
            header: 'Extras',
            key: 'q1',
            options: [{ label: 'Sprinkles', description: '' }],
            multiple: true,
          },
        ],
      },
    });
  });

  test('form.created falls back to the field key and caps the header', () => {
    const out = mapV2EventToV1({
      type: 'form.created',
      properties: {
        form: {
          id: 'frm_2',
          sessionID: 'ses_q',
          title: 't',
          fields: [
            {
              key: 'a-very-long-identifier-key-name-over-limit',
              type: 'string',
            },
          ],
        },
      },
    });
    const question = (
      out[1] as {
        properties: { questions: Array<{ header: string; question: string }> };
      }
    ).properties.questions[0];
    expect(question.question).toBe(
      'a-very-long-identifier-key-name-over-limit',
    );
    expect(question.header).toHaveLength(30);
  });

  test('"global"-owned forms (MCP elicitation) synthesize nothing', () => {
    expect(
      mapV2EventToV1({
        type: 'form.created',
        properties: {
          form: { id: 'frm_g', sessionID: 'global', title: 't', fields: [] },
        },
      }),
    ).toHaveLength(1);
    expect(
      mapV2EventToV1({
        type: 'form.replied',
        properties: { id: 'frm_g', sessionID: 'global', answer: {} },
      }),
    ).toHaveLength(1);
    expect(
      mapV2EventToV1({
        type: 'form.cancelled',
        properties: { id: 'frm_g', sessionID: 'global' },
      }),
    ).toHaveLength(1);
  });

  test('form.replied synthesizes v1 question.replied with requestID + answers', () => {
    const out = mapV2EventToV1({
      type: 'form.replied',
      properties: {
        id: 'frm_1',
        sessionID: 'ses_q',
        answer: {
          flavor: 'Vanilla',
          count: 2,
          approved: true,
          extras: ['Sprinkles', 'Fudge'],
        },
      },
    });
    expect(out).toHaveLength(2);
    // input-wait-tracker resolves the ask keyed `question:<id>` by reading
    // properties.requestID — must be the form id, not a fresh value.
    expect(out[1]).toEqual({
      type: 'question.replied',
      properties: {
        sessionID: 'ses_q',
        requestID: 'frm_1',
        answers: [['Vanilla'], ['2'], ['true'], ['Sprinkles', 'Fudge']],
      },
    });
  });

  test('form.cancelled synthesizes v1 question.rejected', () => {
    const out = mapV2EventToV1({
      type: 'form.cancelled',
      properties: { id: 'frm_1', sessionID: 'ses_q' },
    });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      type: 'question.rejected',
      properties: { sessionID: 'ses_q', requestID: 'frm_1' },
    });
  });

  test('malformed form events synthesize nothing (fail-open)', () => {
    expect(
      mapV2EventToV1({ type: 'form.created', properties: {} }),
    ).toHaveLength(1);
    expect(
      mapV2EventToV1({
        type: 'form.created',
        properties: { form: { sessionID: 'ses_q' } }, // no id
      }),
    ).toHaveLength(1);
    expect(
      mapV2EventToV1({
        type: 'form.replied',
        properties: { sessionID: 'ses_q', answer: {} }, // no id
      }),
    ).toHaveLength(1);
  });

  test('ask/reply round-trip arms then resolves the real input-wait tracker', async () => {
    // End-to-end against the consumer that matters: the task-session-
    // manager input-wait gate must arm on the synthesized ask and clear
    // on the synthesized reply.
    const { createTaskSessionManagerHook } = await import(
      '../hooks/task-session-manager'
    );
    const hook = createTaskSessionManagerHook(createHookCtx(), {
      maxSessionsPerAgent: 2,
      shouldManageSession: (id: string) => id === 'parent-1',
    });
    const asked = mapV2EventToV1({
      type: 'form.created',
      properties: {
        form: {
          id: 'frm_w',
          sessionID: 'parent-1',
          title: 't',
          fields: [{ key: 'k', type: 'string' }],
        },
      },
    })[1];
    await hook.event({ event: asked });
    expect(hook.hasInputWait('parent-1')).toBe(true);
    const replied = mapV2EventToV1({
      type: 'form.replied',
      properties: { id: 'frm_w', sessionID: 'parent-1', answer: { k: 'v' } },
    })[1];
    await hook.event({ event: replied });
    expect(hook.hasInputWait('parent-1')).toBe(false);
  });
});

describe('mapV2EventToV1 permission field mapping', () => {
  test('permission.asked synthesizes the v1 field names after the raw event', () => {
    const ev = deepFreeze({
      type: 'permission.asked',
      properties: {
        id: 'per_1',
        sessionID: 'ses_p',
        action: 'execute',
        resources: ['bash'],
        metadata: { callID: 'call_1' },
      },
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    // v1 PermissionV1 names: permission ← action, patterns ← resources.
    // The repo consumers (input-wait tracker, wake scheduler, companion)
    // read {id, sessionID} — present on both shapes.
    expect(out[1]).toEqual({
      type: 'permission.asked',
      properties: {
        id: 'per_1',
        sessionID: 'ses_p',
        permission: 'execute',
        patterns: ['bash'],
        metadata: { callID: 'call_1' },
        always: [],
      },
    });
  });

  test('permission.asked maps save → always and degrades missing fields', () => {
    const out = mapV2EventToV1({
      type: 'permission.asked',
      properties: {
        id: 'per_2',
        sessionID: 'ses_p',
        action: 'edit',
        resources: ['file:///a', 42],
        save: ['file:///a'],
      },
    });
    expect(out[1]).toEqual({
      type: 'permission.asked',
      properties: {
        id: 'per_2',
        sessionID: 'ses_p',
        permission: 'edit',
        patterns: ['file:///a'],
        metadata: {},
        always: ['file:///a'],
      },
    });
  });

  test('permission.asked without id/sessionID stays passthrough-only', () => {
    expect(
      mapV2EventToV1({
        type: 'permission.asked',
        properties: { sessionID: 'ses_p' },
      }),
    ).toHaveLength(1);
    expect(
      mapV2EventToV1({ type: 'permission.asked', properties: {} }),
    ).toHaveLength(1);
  });

  test('permission.replied passes through raw — v2 shape already matches v1', () => {
    // v2 replied {sessionID, requestID, reply} IS the v1 PermissionV1
    // event shape; the consumers read sessionID + requestID directly.
    const ev = deepFreeze({
      type: 'permission.replied',
      properties: { sessionID: 'ses_p', requestID: 'per_1', reply: 'once' },
    });
    expect(mapV2EventToV1(ev)).toEqual([ev]);
  });

  test('permission.replied with data payload plus empty properties still synthesizes (#1375)', () => {
    const ev = deepFreeze({
      type: 'permission.replied',
      data: { sessionID: 'ses_p', requestID: 'per_1', reply: 'once' },
      properties: {},
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    expect(out[1]).toEqual({
      type: 'permission.replied',
      properties: { sessionID: 'ses_p', requestID: 'per_1', reply: 'once' },
    });
  });

  test('permission.replied with data payload plus foreign properties still synthesizes (#1375)', () => {
    const out = mapV2EventToV1({
      type: 'permission.replied',
      data: { sessionID: 'ses_p', requestID: 'per_1', reply: 'always' },
      properties: { sessionID: 'ses_p', requestID: 'per_other' },
    });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      type: 'permission.replied',
      properties: { sessionID: 'ses_p', requestID: 'per_1', reply: 'always' },
    });
  });

  test('permission.replied accepts id as a requestID fallback (#1375)', () => {
    const out = mapV2EventToV1({
      type: 'permission.replied',
      data: { sessionID: 'ses_p', id: 'per_1', reply: 'once' },
    });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      type: 'permission.replied',
      properties: { sessionID: 'ses_p', requestID: 'per_1', reply: 'once' },
    });
  });

  test('permission.replied with id-only properties still synthesizes (#1375)', () => {
    // Reply consumers read `properties.requestID`, never `properties.id`,
    // so an envelope carrying the id under the ask spelling must not
    // suppress synthesis.
    const out = mapV2EventToV1({
      type: 'permission.replied',
      data: { sessionID: 'ses_p', requestID: 'per_1', reply: 'once' },
      properties: { sessionID: 'ses_p', id: 'per_1' },
    });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      type: 'permission.replied',
      properties: { sessionID: 'ses_p', requestID: 'per_1', reply: 'once' },
    });
  });

  test('permission.replied without identity stays passthrough-only (#1375)', () => {
    expect(
      mapV2EventToV1({
        type: 'permission.replied',
        data: { sessionID: 'ses_p', reply: 'once' },
      }),
    ).toHaveLength(1);
    expect(
      mapV2EventToV1({ type: 'permission.replied', properties: {} }),
    ).toHaveLength(1);
  });

  test('synthesized ask/replied pair arms then resolves the input-wait tracker', async () => {
    const { createTaskSessionManagerHook } = await import(
      '../hooks/task-session-manager'
    );
    const hook = createTaskSessionManagerHook(createHookCtx(), {
      maxSessionsPerAgent: 2,
      shouldManageSession: (id: string) => id === 'parent-1',
    });
    const asked = mapV2EventToV1({
      type: 'permission.asked',
      properties: {
        id: 'per_w',
        sessionID: 'parent-1',
        action: 'execute',
        resources: [],
      },
    })[1];
    await hook.event({ event: asked });
    expect(hook.hasInputWait('parent-1')).toBe(true);
    await hook.event({
      event: {
        type: 'permission.replied',
        properties: {
          sessionID: 'parent-1',
          requestID: 'per_w',
          reply: 'once',
        },
      },
    });
    expect(hook.hasInputWait('parent-1')).toBe(false);
  });
});

describe('mapV2EventToV1 session.deleted synthesis', () => {
  // v2 delivers deletion flat ({sessionID}) under `data` on live hosts;
  // without synthesis the v1 deletion cleanup (task-session-manager
  // rememberDeletedSession + cache-monitor deletedSessionID) never fires on
  // v2. The v1 consumers read two different spellings of the session id —
  // properties.info.id (cache-monitor) and properties.sessionID (event
  // router) — so the synthesized event must carry BOTH.
  function liveDeletedEvent(sessionID: string): Record<string, unknown> {
    return deepFreeze({
      id: 'evt_session_deleted',
      created: 1_788_961_637_000,
      type: 'session.deleted',
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: { sessionID },
    });
  }

  test('legacy `properties` spelling synthesizes the dual-spelling v1 shape', () => {
    const ev = deepFreeze({
      type: 'session.deleted',
      properties: { sessionID: 'ses_del' },
    });
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    expect(out[1]).toEqual({
      type: 'session.deleted',
      properties: {
        info: { id: 'ses_del' },
        sessionID: 'ses_del',
      },
    });
  });

  test('live `data` spelling synthesizes the same dual-spelling v1 shape', () => {
    const ev = liveDeletedEvent('ses_gone');
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    expect(out[1]).toEqual({
      type: 'session.deleted',
      properties: {
        info: { id: 'ses_gone' },
        sessionID: 'ses_gone',
      },
    });
  });

  test('session.deleted without a sessionID stays passthrough-only', () => {
    const ev = deepFreeze({ type: 'session.deleted', properties: {} });
    expect(mapV2EventToV1(ev)).toEqual([ev]);
    const emptyData = deepFreeze({
      type: 'session.deleted',
      data: {},
    });
    expect(mapV2EventToV1(emptyData)).toEqual([emptyData]);
  });

  test('synthesized session.deleted feeds the real task-session-manager cleanup (tombstone)', async () => {
    const { createTaskSessionManagerHook } = await import(
      '../hooks/task-session-manager'
    );
    const { BackgroundJobBoard, getBackgroundJobLifecycleLedger } =
      await import('../utils');
    const board = new BackgroundJobBoard();
    const hook = createTaskSessionManagerHook(createHookCtx(), {
      maxSessionsPerAgent: 2,
      backgroundJobBoard: board,
      shouldManageSession: (id: string) => id === 'parent-1',
    });
    board.registerLaunch({
      taskID: 'child-del',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'deletion synthesis e2e',
      now: 0,
    });
    // Dispatch like the v2 pump: raw first, then every synthesized product.
    // The raw data-keyed event is inert in the v1 handler (no properties);
    // only the synthesized dual-spelling shape can record the tombstone.
    for (const mapped of mapV2EventToV1(liveDeletedEvent('child-del'))) {
      await hook.event({ event: mapped });
    }
    expect(
      getBackgroundJobLifecycleLedger(board).tombstones.has('child-del'),
    ).toBe(true);
  });
});

describe('mapV2EventToV1 shared payload fact (resolveV2EventPayload)', () => {
  test('data and properties spellings map identically, raw first and unmutated', () => {
    // The mapper resolves the event payload through the ONE shared fact
    // (resolveV2EventPayload, also used by the permission-rules and
    // runtime-profile bridges) instead of a private copy: both wire
    // spellings of the same event must synthesize the exact same v1
    // shapes, and the raw event stays the byte-identical first element.
    const base = {
      id: 'evt_shared_1',
      created: 1_788_961_637_000,
      durable: { aggregateID: 'ses_shared', seq: 1, version: 1 },
    };
    const viaData = deepFreeze({
      ...base,
      type: 'session.execution.succeeded',
      data: { sessionID: 'ses_shared' },
    });
    const viaProperties = deepFreeze({
      ...base,
      type: 'session.execution.succeeded',
      properties: { sessionID: 'ses_shared' },
    });
    const outData = mapV2EventToV1(viaData);
    const outProperties = mapV2EventToV1(viaProperties);
    expect(outData[0]).toBe(viaData);
    expect(outProperties[0]).toBe(viaProperties);
    expect(outProperties.slice(1)).toEqual(outData.slice(1));
    expect(outData.slice(1)).toEqual([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_shared',
          status: { type: 'idle' },
          activityAt: 1_788_961_637_000,
        },
      },
      {
        type: 'session.idle',
        properties: {
          sessionID: 'ses_shared',
          activityAt: 1_788_961_637_000,
        },
      },
    ]);
  });
});
