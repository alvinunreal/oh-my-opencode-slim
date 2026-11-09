import { describe, expect, test } from 'bun:test';
import {
  createInternalAgentTextPart,
  SLIM_INTERNAL_INITIATOR_MARKER,
} from '../../utils/internal-initiator';
import {
  createPhaseReminderHook,
  hasPhaseReminder,
  PHASE_REMINDER,
  PHASE_REMINDER_METADATA_KEY,
} from './index';

describe('createPhaseReminderHook', () => {
  test('appends reminder as a separate part for orchestrator sessions', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'hello' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    // Reminder is appended as a new part, not merged into the original text
    expect(output.messages[0].parts.length).toBe(2);
    expect(output.messages[0].parts[0].text).toBe('hello');
    expect(output.messages[0].parts[1].text).toBe(PHASE_REMINDER);
    expect(output.messages[0].parts[1].text).toStartWith('<system-reminder>');
    expect(output.messages[0].parts[1].text).toEndWith('</system-reminder>');
    expect(output.messages[0].parts[1]).toMatchObject({
      synthetic: true,
      metadata: { [PHASE_REMINDER_METADATA_KEY]: true },
    });
  });

  test('appends one reminder, anchored on the first eligible orchestrator user message', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'first' }],
        },
        {
          info: { role: 'user', agent: 'explorer', sessionID: 's1' },
          parts: [{ type: 'text', text: 'specialist' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's2' },
          parts: [{ type: 'text', text: 'other session' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'latest' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts).toHaveLength(2);
    expect(output.messages[3].parts).toHaveLength(1);
    expect(output.messages[1].parts).toHaveLength(1);
    expect(output.messages[2].parts).toHaveLength(1);
  });

  test('reconstructs the anchored message byte-identically on the next turn', async () => {
    const hook = createPhaseReminderHook();
    const turnN = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'first' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'second' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, turnN);
    const anchor = JSON.stringify(turnN.messages[0]);
    const turnNPlusOne = {
      messages: [
        ...turnN.messages.map((message) => ({
          ...message,
          parts: message.parts.filter((part) => !part.synthetic),
        })),
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'third' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, turnNPlusOne);

    // The anchor's rendered bytes are identical on the next request; the
    // non-anchor messages stay untouched (no reminder churn behind it).
    expect(JSON.stringify(turnNPlusOne.messages[0])).toBe(anchor);
    expect(turnNPlusOne.messages[1].parts).toHaveLength(1);
    expect(turnNPlusOne.messages[2].parts).toHaveLength(1);
  });

  test('is idempotent when run twice on the same messages', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'first' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'latest' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);
    await hook['experimental.chat.messages.transform']({}, output);

    const tagged = output.messages.flatMap((message) =>
      message.parts.filter(hasPhaseReminder),
    );
    expect(tagged).toHaveLength(1);
    expect(output.messages[0].parts).toHaveLength(2);
  });

  test('does not mutate internal notification turns', async () => {
    const hook = createPhaseReminderHook();
    const text = `[Background task "x" completed]\n${SLIM_INTERNAL_INITIATOR_MARKER}`;
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [
            createInternalAgentTextPart('[Background task "x" completed]'),
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toBe(text);
    expect(output.messages[0].parts.length).toBe(1);
  });

  test('does not mutate persisted internal notification turns', async () => {
    const hook = createPhaseReminderHook();
    const internalPart = JSON.parse(
      JSON.stringify(createInternalAgentTextPart('internal notification')),
    ) as ReturnType<typeof createInternalAgentTextPart>;
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [internalPart],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts).toHaveLength(1);
    expect(
      output.messages[0].parts.some((part) => part.text === PHASE_REMINDER),
    ).toBe(false);
  });

  test('replays historical reminders when the latest user message is internal', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'historical' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [createInternalAgentTextPart('internal notification')],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts).toHaveLength(2);
    expect(output.messages[1].parts).toHaveLength(1);
  });

  test('does not let user-visible internal marker suppress injection', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [
            {
              type: 'text',
              synthetic: true,
              text: `hello ${SLIM_INTERNAL_INITIATOR_MARKER}`,
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts).toHaveLength(2);
    expect(output.messages[0].parts[1].text).toBe(PHASE_REMINDER);
  });

  test('does not append duplicate reminder after JSON persistence', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [
            { type: 'text', text: 'hello' },
            JSON.parse(
              JSON.stringify({
                type: 'text',
                synthetic: true,
                text: PHASE_REMINDER,
                metadata: { [PHASE_REMINDER_METADATA_KEY]: true },
              }),
            ),
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts.length).toBe(2);
    expect(output.messages[0].parts[0].text).toBe('hello');
  });

  test('does not trust ordinary reminder text for dedupe', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: PHASE_REMINDER }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts).toHaveLength(2);
  });

  test('does not modify original user message text (bug #448)', async () => {
    const hook = createPhaseReminderHook();
    const originalText = 'Hello world';
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: originalText }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    // The original text part must remain unchanged so it doesn't leak into UI/history
    expect(output.messages[0].parts[0].text).toBe(originalText);
    expect(output.messages[0].parts[1].text).toBe(PHASE_REMINDER);
  });

  test('handles messages without text parts', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'image', url: 'http://example.com/img.png' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts.length).toBe(1);
  });

  test('handles empty messages array', async () => {
    const hook = createPhaseReminderHook();
    const output = { messages: [] };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages).toEqual([]);
  });

  test('handles missing or non-array messages', async () => {
    const hook = createPhaseReminderHook();

    await expect(
      hook['experimental.chat.messages.transform']({}, {}),
    ).resolves.toBeUndefined();
    await expect(
      hook['experimental.chat.messages.transform']({}, { messages: {} }),
    ).resolves.toBeUndefined();
  });

  test('handles no user messages', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'Hi' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toBe('Hi');
  });

  test('skips malformed messages while still appending to latest valid user message', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {},
        { info: { role: 'assistant' } },
        { parts: [{ type: 'text', text: 'missing info' }] },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'hello' }],
        },
      ],
    };

    await expect(
      hook['experimental.chat.messages.transform']({}, output as never),
    ).resolves.toBeUndefined();

    expect(output.messages[3].parts.length).toBe(2);
    expect(output.messages[3].parts[0].text).toBe('hello');
    expect(output.messages[3].parts[1].text).toBe(PHASE_REMINDER);
  });

  test('T1: anchor rendered bytes are identical across simulated successive turns', async () => {
    const turn = (texts: string[]) => ({
      messages: texts.map((text) => ({
        info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
        parts: [{ type: 'text', text }],
      })),
    });
    const hook = createPhaseReminderHook();

    const firstTurn = turn(['a', 'b']);
    await hook['experimental.chat.messages.transform']({}, firstTurn);
    const anchorBytes = JSON.stringify(firstTurn.messages[0]);

    const secondTurn = turn(['a', 'b', 'c']);
    await hook['experimental.chat.messages.transform']({}, secondTurn);
    const thirdTurn = turn(['a', 'b', 'c', 'd']);
    await hook['experimental.chat.messages.transform']({}, thirdTurn);

    expect(JSON.stringify(secondTurn.messages[0])).toBe(anchorBytes);
    expect(JSON.stringify(thirdTurn.messages[0])).toBe(anchorBytes);
    expect(
      secondTurn.messages
        .slice(1)
        .flatMap((message) => message.parts.filter(hasPhaseReminder)),
    ).toHaveLength(0);
  });

  test('T2: exactly one tagged part exists in the whole array, invariant to N', async () => {
    const hook = createPhaseReminderHook();
    for (const count of [1, 2, 3, 5, 8]) {
      const output = {
        messages: Array.from({ length: count }, (_, index) => ({
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: `turn ${index}` }],
        })),
      };

      await hook['experimental.chat.messages.transform']({}, output);

      const tagged = output.messages.flatMap((message) =>
        message.parts.filter(hasPhaseReminder),
      );
      expect(tagged).toHaveLength(1);
      expect(output.messages[0].parts).toHaveLength(2);
    }
  });

  test('T3: messages after the anchor carry no reminder', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: ['first', 'second', 'third', 'fourth'].map((text) => ({
        info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
        parts: [{ type: 'text', text }],
      })),
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts.some(hasPhaseReminder)).toBe(true);
    for (const message of output.messages.slice(1)) {
      expect(message.parts.some(hasPhaseReminder)).toBe(false);
      expect(message.parts).toHaveLength(1);
    }
  });

  test('T4: re-anchors to the new first eligible message after compaction/truncation', async () => {
    const hook = createPhaseReminderHook();

    // Start from an already-anchored view, then drop the anchor from the
    // prefix (compaction/truncation) and transform the truncated view.
    const turnN = {
      messages: ['anchor', 'survived summary tail', 'latest'].map((text) => ({
        info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
        parts: [{ type: 'text', text }],
      })),
    };

    await hook['experimental.chat.messages.transform']({}, turnN);
    expect(turnN.messages[0].parts[1].text).toBe(PHASE_REMINDER);

    const truncated = { messages: turnN.messages.slice(1) };

    await hook['experimental.chat.messages.transform']({}, truncated);

    // The new first eligible message carries the single reminder; the old
    // anchor's copy did not persist anywhere in the truncated view.
    expect(truncated.messages[0].parts).toHaveLength(2);
    expect(truncated.messages[0].parts[1].text).toBe(PHASE_REMINDER);
    expect(truncated.messages[1].parts).toHaveLength(1);
    expect(
      truncated.messages.flatMap((message) =>
        message.parts.filter(hasPhaseReminder),
      ),
    ).toHaveLength(1);
  });

  test('T5: running the transform twice in one request still yields exactly one reminder', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: ['first', 'second'].map((text) => ({
        info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
        parts: [{ type: 'text', text }],
      })),
    };

    await hook['experimental.chat.messages.transform']({}, output);
    await hook['experimental.chat.messages.transform']({}, output);

    expect(
      output.messages.flatMap((message) =>
        message.parts.filter(hasPhaseReminder),
      ),
    ).toHaveLength(1);
    expect(output.messages[0].parts).toHaveLength(2);
    expect(output.messages[1].parts).toHaveLength(1);
  });

  test('T6: an internal-initiator first text part pushes the anchor to the next eligible message', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [createInternalAgentTextPart('internal notification')],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'real user turn' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'latest' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts).toHaveLength(1);
    expect(output.messages[1].parts).toHaveLength(2);
    expect(output.messages[1].parts[1].text).toBe(PHASE_REMINDER);
    expect(output.messages[2].parts).toHaveLength(1);
  });

  test('anchor persists across an agent switch (issue #1640)', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'first' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'second' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);
    const anchorBytes = JSON.stringify(output.messages[0]);
    expect(output.messages[0].parts.some(hasPhaseReminder)).toBe(true);

    output.messages.push({
      info: { role: 'user', agent: 'build', sessionID: 's1' },
      parts: [{ type: 'text', text: 'next phase' }],
    });
    await hook['experimental.chat.messages.transform']({}, output);

    expect(JSON.stringify(output.messages[0])).toBe(anchorBytes);
    expect(output.messages[0].parts.some(hasPhaseReminder)).toBe(true);
    expect(output.messages[2].parts).toHaveLength(1);
  });

  test('T8: injected text is the PHASE_REMINDER constant byte-for-byte', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'hello' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[1].text).toBe(PHASE_REMINDER);
    // Guards accidental edits to the constant: the exact bytes pinned here
    // must match (the cache-payload snapshot owns the same value).
    expect(output.messages[0].parts[1].text).toBe(
      '<system-reminder>\n' +
        '!IMPORTANT! Scheduler workflow: pick the lightest workflow that fits. Direct work: execute and verify proportionately. Otherwise: plan lanes → dispatch background specialists → track task IDs → await hook-driven completion → reconcile terminal results → verify. !END!\n' +
        '</system-reminder>',
    );
  });

  test('fork edge: mixed sessionIDs anchor on the first message matching the latest session, deterministically', async () => {
    const hook = createPhaseReminderHook();
    // Forked view: older turns carry the parent sessionID, only the fork
    // turns match the latest user message's sessionID.
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent' },
          parts: [{ type: 'text', text: 'inherited turn' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'fork' },
          parts: [{ type: 'text', text: 'fork turn 1' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'fork' },
          parts: [{ type: 'text', text: 'fork turn 2' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);
    const firstRun = JSON.stringify(output);

    expect(output.messages[0].parts).toHaveLength(1);
    expect(output.messages[1].parts).toHaveLength(2);
    expect(output.messages[1].parts[1].text).toBe(PHASE_REMINDER);
    expect(output.messages[2].parts).toHaveLength(1);

    // Deterministic on a second run over the same view.
    await hook['experimental.chat.messages.transform']({}, output);
    expect(JSON.stringify(output)).toBe(firstRun);
  });

  test('fork edge: no message matches the latest sessionID, so nothing is injected', async () => {
    const hook = createPhaseReminderHook();
    // The latest user message carries a sessionID that no earlier message
    // shares; the eligible-message scan finds no matching anchor.
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'parent' },
          parts: [{ type: 'text', text: 'inherited turn' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'fork' },
          parts: [{ type: 'text', text: 'fork turn' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'other' },
          parts: [{ type: 'image', url: 'http://example.com/img.png' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(
      output.messages.flatMap((message) =>
        message.parts.filter(hasPhaseReminder),
      ),
    ).toHaveLength(0);
  });
});
