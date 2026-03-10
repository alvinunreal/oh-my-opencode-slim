import { describe, expect, mock, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import { createPhaseReminderHook, PHASE_REMINDER } from './index';

function createMockContext(agent?: string) {
  return {
    client: {
      session: {
        messages: mock(async () => ({
          data: [
            {
              info: {
                id: 'message-1',
                sessionID: 'session-1',
                role: 'user',
                time: { created: Date.now() },
                agent: agent ?? 'orchestrator',
                model: {
                  providerID: 'github-copilot',
                  modelID: 'claude',
                },
              },
              parts: [{ type: 'text', text: 'hello' }],
            },
          ],
        })),
      },
    },
  } as unknown as PluginInput;
}

describe('createPhaseReminderHook', () => {
  test('appends reminder for orchestrator sessions', async () => {
    const hook = createPhaseReminderHook(createMockContext());
    const output = { system: ['base system'] };

    await hook['experimental.chat.system.transform'](
      { sessionID: 'session-1' },
      output,
    );

    expect(output.system).toEqual(['base system', PHASE_REMINDER]);
  });

  test('skips non-orchestrator sessions', async () => {
    const hook = createPhaseReminderHook(createMockContext('explorer'));
    const output = { system: ['base system'] };

    await hook['experimental.chat.system.transform'](
      { sessionID: 'session-1' },
      output,
    );

    expect(output.system).toEqual(['base system']);
  });

  test('does not add duplicate reminders', async () => {
    const hook = createPhaseReminderHook(createMockContext());
    const output = { system: ['base system', PHASE_REMINDER] };

    await hook['experimental.chat.system.transform'](
      { sessionID: 'session-1' },
      output,
    );

    expect(output.system).toEqual(['base system', PHASE_REMINDER]);
  });
});
