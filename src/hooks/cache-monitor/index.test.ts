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

  test('stays silent for providers that never report cache tokens', async () => {
    const { hook, warnings } = createHarness();

    for (const id of ['c1', 'c2', 'c3']) {
      await hook.event(
        assistantMessageEvent({ messageID: id, input: 20000, cacheRead: 0 }),
      );
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
