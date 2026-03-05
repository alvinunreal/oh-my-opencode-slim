import { describe, expect, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import type { PluginConfig } from '../../config';
import { createAutopilotHook } from './index';

function createHarness(todoSequence: unknown[], config?: PluginConfig) {
  let todoCallCount = 0;
  let promptCallCount = 0;

  const todo = async () => {
    const index = Math.min(todoCallCount, Math.max(todoSequence.length - 1, 0));
    const data = todoSequence[index];
    todoCallCount += 1;
    return { data };
  };

  const prompt = async () => {
    promptCallCount += 1;
    return { data: {} };
  };

  const ctx = {
    client: {
      session: {
        todo,
        prompt,
      },
    },
    directory: '/tmp/test',
  } as unknown as PluginInput;

  const hook = createAutopilotHook(ctx, (config ?? {}) as PluginConfig);

  return {
    hook,
    getTodoCallCount: () => todoCallCount,
    getPromptCallCount: () => promptCallCount,
  };
}

function createMessages(text: string, sessionID = 's1') {
  return {
    messages: [
      {
        info: { role: 'user', agent: 'orchestrator', sessionID },
        parts: [{ type: 'text', text }],
      },
    ],
  };
}

describe('autopilot hook', () => {
  test('enables on keyword and continues when todos are active', async () => {
    const harness = createHarness([[{ status: 'pending' }]]);

    await harness.hook['experimental.chat.messages.transform'](
      {},
      createMessages('autopilot'),
    );

    await harness.hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 's1', status: { type: 'idle' } },
      },
    });

    expect(harness.getPromptCallCount()).toBe(1);
    expect(harness.getTodoCallCount()).toBe(1);
  });

  test('auto-disables when all todos are completed', async () => {
    const harness = createHarness([
      [{ status: 'completed' }],
      [{ status: 'pending' }],
    ]);

    await harness.hook['experimental.chat.messages.transform'](
      {},
      createMessages('autopilot'),
    );

    await harness.hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 's1', status: { type: 'idle' } },
      },
    });

    await harness.hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 's1', status: { type: 'idle' } },
      },
    });

    expect(harness.getPromptCallCount()).toBe(0);
    expect(harness.getTodoCallCount()).toBe(1);
  });

  test('disable keyword turns autopilot off for the session', async () => {
    const harness = createHarness([[{ status: 'pending' }]]);

    await harness.hook['experimental.chat.messages.transform'](
      {},
      createMessages('autopilot'),
    );
    await harness.hook['experimental.chat.messages.transform'](
      {},
      createMessages('manual'),
    );

    await harness.hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 's1', status: { type: 'idle' } },
      },
    });

    expect(harness.getPromptCallCount()).toBe(0);
    expect(harness.getTodoCallCount()).toBe(0);
  });

  test('stops auto-continuing after maxAutoContinues', async () => {
    const harness = createHarness([[{ status: 'pending' }]], {
      autopilot: {
        enabled: true,
        keyword: 'autopilot',
        disableKeyword: 'manual',
        cooldownMs: 0,
        maxAutoContinues: 1,
      },
    } as PluginConfig);

    await harness.hook['experimental.chat.messages.transform'](
      {},
      createMessages('autopilot'),
    );

    await harness.hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 's1', status: { type: 'idle' } },
      },
    });
    await harness.hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 's1', status: { type: 'idle' } },
      },
    });

    expect(harness.getPromptCallCount()).toBe(1);
    expect(harness.getTodoCallCount()).toBe(1);
  });
});
