import { describe, expect, test } from 'bun:test';
import { SLIM_INTERNAL_INITIATOR_MARKER } from '../../utils';
import { createPhaseReminderHook, PHASE_REMINDER } from './index';

describe('createPhaseReminderHook', () => {
  test('appends reminder as a separate part for orchestrator sessions', async () => {
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

    // Reminder is appended as a new part, not merged into the original text
    expect(output.messages[0].parts.length).toBe(2);
    expect(output.messages[0].parts[0].text).toBe('hello');
    expect(output.messages[0].parts[1].text).toBe(PHASE_REMINDER);
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

  test('does not mutate internal notification turns', async () => {
    const hook = createPhaseReminderHook();
    const text = `[Background task "x" completed]\n${SLIM_INTERNAL_INITIATOR_MARKER}`;
    const output = {
      messages: [
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toBe(text);
    expect(output.messages[0].parts.length).toBe(1);
  });

  test('does not append duplicate reminder', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator' },
          parts: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: PHASE_REMINDER },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts.length).toBe(2);
    expect(output.messages[0].parts[0].text).toBe('hello');
  });

  test('does not modify original user message text (bug #448)', async () => {
    const hook = createPhaseReminderHook();
    const originalText = 'Hello world';
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator' },
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
          info: { role: 'user', agent: 'orchestrator' },
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
          info: { role: 'user', agent: 'orchestrator' },
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
