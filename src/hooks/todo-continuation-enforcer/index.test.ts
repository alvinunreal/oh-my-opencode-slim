import { describe, expect, test } from 'bun:test';
import { createTodoContinuationEnforcer } from './index';

describe('todo continuation enforcer', () => {
  test('toggles off/on via chat commands', async () => {
    const prompts: string[] = [];
    const hook = createTodoContinuationEnforcer({
      ctx: {
        directory: '/tmp',
        client: {
          session: {
            todo: async () => [{ content: 'a', status: 'in_progress' }],
            promptAsync: async (input: { body: { parts: Array<{ text: string }> } }) => {
              prompts.push(input.body.parts[0].text);
            },
          },
        },
      },
      defaultEnabled: true,
    });

    const out = { parts: [{ type: 'text', text: '/todo-cont off' }] };
    await hook['chat.message']({ sessionID: 's1' }, out);
    expect((out.parts[0] as { text: string }).text).toContain('OFF');

    await hook.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
    expect(prompts.length).toBe(0);

    const outOn = { parts: [{ type: 'text', text: '/todo-cont on' }] };
    await hook['chat.message']({ sessionID: 's1' }, outOn);
    await hook.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
    expect(prompts.length).toBe(1);
  });

  test('status command reports current state', async () => {
    const hook = createTodoContinuationEnforcer({
      ctx: { directory: '/tmp', client: { session: {} } },
      defaultEnabled: false,
    });

    const out = { parts: [{ type: 'text', text: '/todo-cont status' }] };
    await hook['chat.message']({ sessionID: 's2' }, out);
    expect((out.parts[0] as { text: string }).text).toContain('OFF');
  });
});
