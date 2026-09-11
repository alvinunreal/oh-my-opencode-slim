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
}): Record<string, unknown> {
  return {
    type: 'session.usage.updated',
    properties: deepFreeze({
      sessionID: 'ses_map',
      ...(overrides.timestamp !== undefined
        ? { timestamp: overrides.timestamp }
        : {}),
      tokens: {
        input: overrides.input,
        output: 5,
        reasoning: 0,
        cache: { read: overrides.read, write: overrides.write ?? 0 },
      },
    }),
  };
}

describe('mapV2EventToV1', () => {
  test('passes unknown events through unchanged (raw reference first)', () => {
    const ev = { type: 'permission.asked', properties: { sessionID: 's' } };
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

  test('synthesizes session.idle from idle session.status', () => {
    const ev = {
      type: 'session.status',
      properties: { sessionID: 's', status: { type: 'idle' } },
    };
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    expect(out[1]).toEqual({
      type: 'session.idle',
      properties: { sessionID: 's' },
    });
  });

  test('busy status does not synthesize idle', () => {
    expect(
      mapV2EventToV1({
        type: 'session.status',
        properties: { sessionID: 's', status: { type: 'busy' } },
      }),
    ).toHaveLength(1);
  });

  test('idle status without a sessionID does not synthesize idle', () => {
    expect(
      mapV2EventToV1({
        type: 'session.status',
        properties: { status: { type: 'idle' } },
      }),
    ).toHaveLength(1);
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
    // Exact field paths parseCompletedAssistantMessage reads. The id is a
    // deterministic fingerprint (v2 usage events carry no message id) so
    // replays and the step.ended/usage.updated pair for one request dedup.
    expect(out[1]).toEqual({
      type: 'message.updated',
      properties: {
        info: {
          id: 'v2-usage:ses_map:10:5:100:20',
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
  });

  test('maps session.step.ended telemetry with timestamp passthrough', () => {
    const out = mapV2EventToV1({
      type: 'session.step.ended',
      properties: {
        sessionID: 'ses_map',
        timestamp: 1_700_000_000,
        tokens: { input: 7, output: 3, cache: { read: 40, write: 5 } },
      },
    });
    expect(out[1]).toEqual({
      type: 'message.updated',
      properties: {
        info: {
          id: 'v2-usage:ses_map:7:3:40:5',
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

  test('usage telemetry with incomplete tokens synthesizes nothing', () => {
    // Fail-open like the consumers: partial token blocks are dropped
    // rather than mapped into a shape cache-monitor would half-read.
    expect(
      mapV2EventToV1({
        type: 'session.usage.updated',
        properties: { sessionID: 's', tokens: { input: 10 } },
      }),
    ).toHaveLength(1);
    expect(
      mapV2EventToV1({
        type: 'session.usage.updated',
        properties: { sessionID: 's' },
      }),
    ).toHaveLength(1);
  });

  test('mapped message.updated feeds the real cache-monitor (bust warning fires)', async () => {
    const warnings: string[] = [];
    const monitor = createCacheMonitorHook({
      logger: (message) => warnings.push(message),
    });
    await monitor.event({
      event: mapV2EventToV1(v2Usage({ input: 8000, read: 0, write: 7000 }))[1],
    });
    await monitor.event({
      event: mapV2EventToV1(v2Usage({ input: 500, read: 9000 }))[1],
    });
    await monitor.event({
      event: mapV2EventToV1(v2Usage({ input: 12000, read: 0 }))[1],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('prompt-cache bust');
  });
});

describe('mapV2EventToV1 session.execution.* lifecycle synthesis', () => {
  // Newer v2 hosts (verified live beta-19365/beta-19378) publish durable
  // session.execution.* events and no longer stream busy/idle
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

  test('older host emitting BOTH session.status idle and execution.succeeded keeps single logical idle (double-idle invariant)', () => {
    // Composition is per-event and additive; a consumer watching idle
    // across both deliveries sees idle four times (raw idle
    // session.status + its synthesized session.idle; succeeded's
    // synthesized idle session.status + session.idle) — all for the
    // same single logical idle transition, tolerated because every
    // idle consumer is idempotent per session (the documented invariant
    // beginContinuousIdle / idle-reconciliation rely on).
    const idleDeliveries: string[] = [];
    for (const ev of [
      {
        type: 'session.status',
        properties: { sessionID: 's', status: { type: 'idle' } },
      },
      { type: 'session.execution.succeeded', properties: { sessionID: 's' } },
    ]) {
      for (const mapped of mapV2EventToV1(ev)) {
        if (mapped.type === 'session.idle') {
          idleDeliveries.push(
            (mapped.properties as { sessionID: string }).sessionID,
          );
        }
        if (
          mapped.type === 'session.status' &&
          (mapped.properties as { status?: { type?: string } }).status?.type ===
            'idle'
        ) {
          idleDeliveries.push(
            (mapped.properties as { sessionID: string }).sessionID,
          );
        }
      }
    }
    expect(idleDeliveries).toEqual(['s', 's', 's', 's']);
  });

  test('synthesized lifecycle pair feeds the real task-session-manager busy path', async () => {
    // End-to-end against the consumer: the synthesized busy status must
    // mark a tracked child running-from-live-session on the board.
    const { createTaskSessionManagerHook } = await import(
      '../hooks/task-session-manager'
    );
    const { BackgroundJobBoard } = await import('../utils');
    const board = new BackgroundJobBoard();
    const hook = createTaskSessionManagerHook({} as never, {
      maxSessionsPerAgent: 2,
      maxRetainedSnapshots: 2,
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
  // `{id, created, type, location?, durable?, data}` — the OpenCodeEvent
  // wire shape (verified live on beta-19365: every event keys observed as
  // ["id","created","type","durable","data"] with no `properties` key).
  // The `properties` spelling used by the tests above is the legacy
  // fallback. These tests pin the live-observed shapes end-to-end through
  // the exact wake-arming chain: execution.succeeded → idle pair →
  // beginContinuousIdle, and session.created → child registration.
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
    expect(out.slice(1)).toEqual([
      {
        type: 'session.status',
        properties: { sessionID: 'ses_live', status: { type: 'idle' } },
      },
      { type: 'session.idle', properties: { sessionID: 'ses_live' } },
    ]);
  });

  test('live execution.started synthesizes v1 busy from `data`', () => {
    const out = mapV2EventToV1(
      liveEvent('session.execution.started', { sessionID: 'ses_live' }),
    );
    expect(out.slice(1)).toEqual([
      {
        type: 'session.status',
        properties: { sessionID: 'ses_live', status: { type: 'busy' } },
      },
    ]);
  });

  test('live session.created (flat `data` fields incl. parentID) maps to the v1 early-registration shape', () => {
    // Shape captured from the live beta-19365 host: a subagent child
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
        version: '0.0.0-beta-19365',
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

  test('live usage.updated telemetry maps to message.updated from `data`', () => {
    const out = mapV2EventToV1(
      liveEvent('session.usage.updated', {
        sessionID: 'ses_live',
        cost: 0,
        tokens: {
          input: 1,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      type: 'message.updated',
      properties: {
        info: {
          id: 'v2-usage:ses_live:1:1:0:0',
          role: 'assistant',
          sessionID: 'ses_live',
          time: { completed: 0 },
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    });
  });

  test('live idle session.status synthesizes session.idle from `data`', () => {
    const out = mapV2EventToV1(
      liveEvent('session.status', {
        sessionID: 'ses_live',
        status: { type: 'idle' },
      }),
    );
    expect(out.slice(1)).toEqual([
      { type: 'session.idle', properties: { sessionID: 'ses_live' } },
    ]);
  });

  test('live-shape wake chain end-to-end: idle arms the real wake scheduler with a tracked child', async () => {
    // The exact live-observed break: raw `data`-keyed events must reach
    // the v1 consumers. Arm the real scheduler with the synthesized idle
    // for a managed orchestrator whose child was registered from a live
    // session.created, then advance past the interval and require the
    // queued v2 wake prompt.
    const { createOrchestratorWakeScheduler } = await import(
      '../hooks/orchestrator-wake'
    );
    const prompted: Array<Record<string, unknown>> = [];
    const sessionSdk = {
      list: async (args: Record<string, unknown>) => {
        // In-process v2 hosts expose no session.list → shim-level honest
        // empty page; the event-tracked fallback must cover enumeration.
        void args;
        return { data: [] };
      },
      promptAsync: async (args: Record<string, unknown>) => {
        prompted.push(args);
        return {};
      },
    };
    const scheduler = createOrchestratorWakeScheduler(
      {
        client: { session: sessionSdk },
        directory: '/tmp/proj',
        hostFlavor: 'v2',
      } as never,
      {
        config: { enabled: true, intervalMs: 10 },
        shouldManageSession: (id: string) => id === 'ses_parent',
        hasInputWait: () => false,
        intervalMs: 10,
      },
    );
    await scheduler.event({
      event: mapV2EventToV1(
        liveEvent('session.created', {
          sessionID: 'ses_child',
          parentID: 'ses_parent',
          slug: 's',
          version: 'v',
        }),
      )[1],
    });
    await scheduler.event({
      event: mapV2EventToV1(
        liveEvent('session.execution.started', { sessionID: 'ses_child' }),
      )[1],
    });
    await scheduler.event({
      event: mapV2EventToV1(
        liveEvent('session.execution.succeeded', { sessionID: 'ses_parent' }),
      )[2],
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The live-shape chain armed and fired the queued v2 wake. With the
    // 10ms test interval the two-wake no-progress cap is the stop bound
    // (the cap itself is pinned by the dedicated wake-scheduler tests).
    expect(prompted.length).toBeGreaterThanOrEqual(1);
    expect(prompted.length).toBeLessThanOrEqual(2);
    expect(prompted[0]?.delivery).toBe('queue');
    const body = prompted[0]?.body as {
      parts: Array<{ type: string; text: string }>;
    };
    expect(body.parts[0]?.type).toBe('text');
    expect(body.parts[0]?.text).toContain(
      'unfinished background child sessions',
    );
  });
});

describe('mapV2EventToV1 form → question bridge', () => {
  test('form.created synthesizes v1 question.asked with QuestionV1 shape', () => {
    const ev = deepFreeze({
      type: 'form.created',
      properties: {
        form: {
          id: 'frm_1',
          sessionID: 'ses_q',
          title: 'Pick one',
          fields: [
            {
              key: 'flavor',
              type: 'string',
              title: 'Which flavor?',
              options: [
                { value: 'a', label: 'Vanilla', description: 'plain' },
                { value: 'b', label: 'Chocolate' },
              ],
            },
            {
              key: 'extras',
              type: 'multiselect',
              title: 'Extras',
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
            question: 'Which flavor?',
            header: 'Which flavor?',
            options: [
              { label: 'Vanilla', description: 'plain' },
              { label: 'Chocolate', description: '' },
            ],
          },
          {
            question: 'Extras',
            header: 'Extras',
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
    const hook = createTaskSessionManagerHook({} as never, {
      maxSessionsPerAgent: 2,
      maxRetainedSnapshots: 2,
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

  test('synthesized ask/replied pair arms then resolves the input-wait tracker', async () => {
    const { createTaskSessionManagerHook } = await import(
      '../hooks/task-session-manager'
    );
    const hook = createTaskSessionManagerHook({} as never, {
      maxSessionsPerAgent: 2,
      maxRetainedSnapshots: 2,
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
