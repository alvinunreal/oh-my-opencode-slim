import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import { createInternalAgentTextPart } from '../utils';
import {
  __resetInternalMarkerCacheForTesting,
  createChatHeadersHook,
} from './chat-headers';

function createMockContext(parts: unknown[] = []) {
  return {
    client: {
      session: {
        message: mock(async () => ({
          data: {
            info: { role: 'user' },
            parts,
          },
        })),
      },
    },
  } as unknown as PluginInput;
}

function createInput(
  overrides?: Partial<{
    providerID: string;
    npm: string;
    messageID: string;
  }>,
) {
  return {
    sessionID: 'session-1',
    agent: 'orchestrator',
    model: {
      id: 'github-copilot/claude',
      providerID: overrides?.providerID ?? 'github-copilot',
      api: {
        id: 'copilot',
        url: 'https://example.com',
        npm: overrides?.npm ?? '@custom/copilot',
      },
      name: 'Claude',
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
      },
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      limit: { context: 0, output: 0 },
      status: 'active' as const,
      options: {},
      headers: {},
    },
    provider: {
      id: overrides?.providerID ?? 'github-copilot',
      source: 'config' as const,
      info: {
        id: overrides?.providerID ?? 'github-copilot',
      } as never,
      options: {},
    },
    message: {
      id: overrides?.messageID ?? 'message-1',
      sessionID: 'session-1',
      role: 'user' as const,
      time: { created: Date.now() },
      agent: 'orchestrator',
      model: {
        providerID: 'github-copilot',
        modelID: 'claude',
      },
      tools: {},
    },
  };
}

describe('createChatHeadersHook', () => {
  beforeEach(() => {
    __resetInternalMarkerCacheForTesting();
  });

  test('sets x-initiator for marked Copilot messages', async () => {
    const ctx = createMockContext([
      createInternalAgentTextPart('internal notification'),
    ]);
    const hook = createChatHeadersHook(ctx);
    const output = { headers: {} };

    await hook['chat.headers'](createInput(), output);

    expect(output.headers['x-initiator']).toBe('agent');
  });

  test('skips non-Copilot providers', async () => {
    const ctx = createMockContext([
      createInternalAgentTextPart('internal notification'),
    ]);
    const hook = createChatHeadersHook(ctx);
    const output = { headers: {} };

    await hook['chat.headers'](
      createInput({ providerID: 'anthropic' }),
      output,
    );

    expect(output.headers['x-initiator']).toBeUndefined();
  });

  test('skips requests handled by @ai-sdk/github-copilot', async () => {
    const ctx = createMockContext([
      createInternalAgentTextPart('internal notification'),
    ]);
    const hook = createChatHeadersHook(ctx);
    const output = { headers: {} };

    await hook['chat.headers'](
      createInput({ npm: '@ai-sdk/github-copilot' }),
      output,
    );

    expect(output.headers['x-initiator']).toBeUndefined();
  });

  test('skips normal user messages', async () => {
    const ctx = createMockContext([{ type: 'text', text: 'normal prompt' }]);
    const hook = createChatHeadersHook(ctx);
    const output = { headers: {} };

    await hook['chat.headers'](
      createInput({ messageID: 'message-normal' }),
      output,
    );

    expect(output.headers['x-initiator']).toBeUndefined();
  });
});
