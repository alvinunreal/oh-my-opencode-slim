import { describe, expect, test } from 'bun:test';
import { createCacheMonitorHook } from './index';

interface Warning {
  message: string;
  data: unknown;
}

function createHarness() {
  const warnings: Warning[] = [];
  const hook = createCacheMonitorHook({
    logger: (message, data) => warnings.push({ message, data }),
  });
  return { hook, warnings };
}

function assistantMessageEvent(options: {
  sessionID?: string;
  messageID: string;
  input: number;
  cacheRead: number;
  cacheWrite?: number;
  completed?: boolean;
}) {
  return {
    event: {
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          sessionID: options.sessionID ?? 'ses_monitor',
          id: options.messageID,
          time: options.completed === false ? {} : { completed: 1_700_000_000 },
          tokens: {
            input: options.input,
            output: 100,
            reasoning: 0,
            cache: {
              read: options.cacheRead,
              write: options.cacheWrite ?? 0,
            },
          },
        },
      },
    },
  };
}

function stepStarted(agent: string) {
  return {
    event: {
      type: 'session.step.started',
      data: {
        sessionID: 'ses_monitor',
        assistantMessageID: 'msg',
        agent,
        model: { id: 'model-a', providerID: 'provider-a' },
      },
    },
  };
}

describe('createCacheMonitorHook', () => {
  test('warns when a cache-hitting session drops to zero cache reads', async () => {
    const { hook, warnings } = createHarness();

    await hook.event(
      assistantMessageEvent({
        messageID: 'a1',
        input: 8000,
        cacheRead: 0,
        cacheWrite: 7000,
      }),
    );
    await hook.event(
      assistantMessageEvent({ messageID: 'a2', input: 500, cacheRead: 9000 }),
    );
    expect(warnings).toHaveLength(0);

    await hook.event(
      assistantMessageEvent({ messageID: 'a3', input: 12000, cacheRead: 0 }),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('prompt-cache bust');
    expect(warnings[0].data).toMatchObject({
      sessionID: 'ses_monitor',
      requestNumber: 3,
      inputTokens: 12000,
      previousCacheRead: 9000,
    });
  });

  test('warns once per bust streak, re-arming after a cache hit', async () => {
    const { hook, warnings } = createHarness();

    await hook.event(
      assistantMessageEvent({ messageID: 'b1', input: 8000, cacheRead: 6000 }),
    );
    await hook.event(
      assistantMessageEvent({ messageID: 'b2', input: 9000, cacheRead: 0 }),
    );
    await hook.event(
      assistantMessageEvent({ messageID: 'b3', input: 9500, cacheRead: 0 }),
    );
    expect(warnings).toHaveLength(1);

    await hook.event(
      assistantMessageEvent({ messageID: 'b4', input: 9500, cacheRead: 9000 }),
    );
    await hook.event(
      assistantMessageEvent({ messageID: 'b5', input: 9600, cacheRead: 0 }),
    );
    expect(warnings).toHaveLength(2);
  });

  test('stays silent for modest sessions that never report cache tokens', async () => {
    const { hook, warnings } = createHarness();

    // Cache-less providers are indistinguishable from busted sessions
    // (OpenCode coalesces missing telemetry to zeros); below the cumulative
    // input threshold the monitor must give them the benefit of the doubt.
    for (const id of ['c1', 'c2', 'c3']) {
      await hook.event(
        assistantMessageEvent({ messageID: id, input: 20000, cacheRead: 0 }),
      );
    }

    expect(warnings).toHaveLength(0);
  });

  test('warns once for a large session that never hits the cache', async () => {
    const { hook, warnings } = createHarness();

    // The v2.2.5 checkpoint-board signature: consecutive ~146K-input
    // requests, zero cache reads from the very first turn.
    for (const id of ['g1', 'g2']) {
      await hook.event(
        assistantMessageEvent({ messageID: id, input: 146000, cacheRead: 0 }),
      );
    }
    expect(warnings).toHaveLength(0);

    await hook.event(
      assistantMessageEvent({ messageID: 'g3', input: 146000, cacheRead: 0 }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('not hitting the provider cache');
    expect(warnings[0].data).toMatchObject({
      sessionID: 'ses_monitor',
      consecutiveUncachedRequests: 3,
      uncachedInputTokens: 438000,
    });

    // Once per session, even as the streak keeps growing.
    await hook.event(
      assistantMessageEvent({ messageID: 'g4', input: 146000, cacheRead: 0 }),
    );
    expect(warnings).toHaveLength(1);
  });

  test('any reported cache activity disarms the never-cached warning', async () => {
    const { hook, warnings } = createHarness();

    // An Anthropic-style first request reports a cache write; later misses
    // are the everReportedCache bust signature, not the never-cached one.
    await hook.event(
      assistantMessageEvent({
        messageID: 'h1',
        input: 146000,
        cacheRead: 0,
        cacheWrite: 140000,
      }),
    );
    for (const id of ['h2', 'h3', 'h4']) {
      await hook.event(
        assistantMessageEvent({ messageID: id, input: 146000, cacheRead: 0 }),
      );
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('prompt-cache bust');
  });

  test('warns when cache-read plateaus while sizeable input accumulates', async () => {
    const { hook, warnings } = createHarness();

    // Issue #874 signature: read frozen at one boundary while uncached
    // input keeps growing turn over turn.
    await hook.event(
      assistantMessageEvent({ messageID: 'p1', input: 7000, cacheRead: 42496 }),
    );
    for (const [index, id] of ['p2', 'p3', 'p4', 'p5'].entries()) {
      await hook.event(
        assistantMessageEvent({
          messageID: id,
          input: 15000 + index,
          cacheRead: 42496,
        }),
      );
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('cache-read plateau');
    expect(warnings[0].data).toMatchObject({
      sessionID: 'ses_monitor',
      frozenCacheRead: 42496,
      consecutiveFrozenRequests: 4,
    });

    // Once per plateau, even as the streak keeps growing.
    await hook.event(
      assistantMessageEvent({
        messageID: 'p6',
        input: 20000,
        cacheRead: 42496,
      }),
    );
    expect(warnings).toHaveLength(1);

    // Growth ends the plateau and re-arms the warning for a new one.
    await hook.event(
      assistantMessageEvent({ messageID: 'p7', input: 900, cacheRead: 60416 }),
    );
    for (const id of ['p8', 'p9', 'p10', 'p11']) {
      await hook.event(
        assistantMessageEvent({
          messageID: id,
          input: 16000,
          cacheRead: 60416,
        }),
      );
    }
    expect(warnings).toHaveLength(2);
  });

  test('stays silent on frozen reads with small accumulated input', async () => {
    const { hook, warnings } = createHarness();

    // Providers round reads to coarse boundaries; identical reads across
    // small turns are normal and must not warn.
    await hook.event(
      assistantMessageEvent({ messageID: 'q1', input: 8000, cacheRead: 17920 }),
    );
    for (const id of ['q2', 'q3', 'q4', 'q5', 'q6']) {
      await hook.event(
        assistantMessageEvent({ messageID: id, input: 400, cacheRead: 17920 }),
      );
    }

    expect(warnings).toHaveLength(0);
  });

  test('stays silent while cache-read keeps growing', async () => {
    const { hook, warnings } = createHarness();

    let read = 17920;
    for (const [index, id] of ['r1', 'r2', 'r3', 'r4', 'r5'].entries()) {
      await hook.event(
        assistantMessageEvent({
          messageID: `${id}-${index}`,
          input: 20000,
          cacheRead: read,
        }),
      );
      read += 1024;
    }

    expect(warnings).toHaveLength(0);
  });

  test('stays silent on the first request and on tiny prompts', async () => {
    const { hook, warnings } = createHarness();

    // First request of a session writes the cache; zero reads are expected.
    await hook.event(
      assistantMessageEvent({
        messageID: 'd1',
        input: 30000,
        cacheRead: 0,
        cacheWrite: 29000,
      }),
    );
    // Small prompts sit below provider minimum cacheable prefixes.
    await hook.event(
      assistantMessageEvent({ messageID: 'd2', input: 900, cacheRead: 0 }),
    );

    expect(warnings).toHaveLength(0);
  });

  test('ignores streaming updates and duplicate completion events', async () => {
    const { hook, warnings } = createHarness();

    await hook.event(
      assistantMessageEvent({ messageID: 'e1', input: 8000, cacheRead: 5000 }),
    );
    await hook.event(
      assistantMessageEvent({
        messageID: 'e2',
        input: 8000,
        cacheRead: 0,
        completed: false,
      }),
    );
    // Same completed message delivered twice must count once.
    await hook.event(
      assistantMessageEvent({ messageID: 'e3', input: 9000, cacheRead: 0 }),
    );
    await hook.event(
      assistantMessageEvent({ messageID: 'e3', input: 9000, cacheRead: 0 }),
    );

    expect(warnings).toHaveLength(1);
  });

  test('tracks sessions independently and forgets deleted sessions', async () => {
    const { hook, warnings } = createHarness();

    await hook.event(
      assistantMessageEvent({
        sessionID: 's-a',
        messageID: 'f1',
        input: 8000,
        cacheRead: 5000,
      }),
    );
    await hook.event(
      assistantMessageEvent({
        sessionID: 's-b',
        messageID: 'f2',
        input: 8000,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    );
    expect(warnings).toHaveLength(0);

    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 's-a' } },
      },
    });
    // After deletion the session history is gone; a zero-read request looks
    // like a fresh session again and must not warn.
    await hook.event(
      assistantMessageEvent({
        sessionID: 's-a',
        messageID: 'f3',
        input: 8000,
        cacheRead: 0,
      }),
    );
    expect(warnings).toHaveLength(0);
  });

  test('re-arms the cache baseline after an agent switch', async () => {
    const { hook, warnings } = createHarness();

    await hook.event(stepStarted('agent-a'));
    await hook.event(
      assistantMessageEvent({ messageID: 'm1', input: 8000, cacheRead: 6000 }),
    );
    await hook.event(stepStarted('agent-b'));
    await hook.event(
      assistantMessageEvent({ messageID: 'm2', input: 20000, cacheRead: 0 }),
    );

    expect(warnings).toHaveLength(0);
  });

  test('fails open on malformed events', async () => {
    const { hook, warnings } = createHarness();

    await hook.event({ event: null });
    await hook.event({ event: { type: 'message.updated' } });
    await hook.event({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            role: 'assistant',
            sessionID: 's',
            id: 'x',
            time: { completed: 1 },
            tokens: { input: 'NaN' },
          },
        },
      },
    });

    expect(warnings).toHaveLength(0);
  });
});
