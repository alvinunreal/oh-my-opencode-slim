import { describe, expect, test } from 'bun:test';
import { SLIM_INTERNAL_INITIATOR_MARKER } from '../../utils';
import { createPhaseReminderHook, PHASE_REMINDER } from './index';

describe('createPhaseReminderHook', () => {
  test('prepends reminder for orchestrator sessions', async () => {
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

    expect(output.messages[0].parts[0].text).toBe(
      `${PHASE_REMINDER}\n\n---\n\nhello`,
    );
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

    expect(output.messages[0].parts[0].text).toBe('hello');
  });

  test('skips internal notification turns', async () => {
    const hook = createPhaseReminderHook();
    const output = {
      messages: [
        {
          info: { role: 'user' },
          parts: [
            {
              type: 'text',
              text: `[Background task "x" completed]\n${SLIM_INTERNAL_INITIATOR_MARKER}`,
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toContain(
      SLIM_INTERNAL_INITIATOR_MARKER,
    );
    expect(output.messages[0].parts[0].text).not.toContain(PHASE_REMINDER);
  });
});
