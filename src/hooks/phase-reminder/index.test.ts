import { describe, expect, test } from 'bun:test';
import {
  createInternalAgentTextPart,
  SLIM_INTERNAL_INITIATOR_MARKER,
} from '../../utils';
import {
  createPhaseReminderHook,
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

  test('skips non-orchestrator sessions', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'explorer' },
          parts: [{ type: 'text', text: 'hello' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts.length).toBe(1);
    expect(output.messages[0].parts[0].text).toBe('hello');
  });

  test('skips turns without an explicit orchestrator agent', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user', sessionID: 's1' },
          parts: [{ type: 'text', text: 'hello' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts).toHaveLength(1);
  });

  test('skips turns without a session ID', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator' },
          parts: [{ type: 'text', text: 'hello' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts).toHaveLength(1);
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
});
