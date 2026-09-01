import { describe, expect, test } from 'bun:test';
import {
  buildTranscript,
  type PollSessionConfig,
  parseSdkMessage,
  pollSession,
} from '../polling-session';

describe('parseSdkMessage', () => {
  test('extracts text from parts', () => {
    const result = parseSdkMessage({
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: 'hello world' }],
    });
    expect(result.role).toBe('assistant');
    expect(result.text).toBe('hello world');
  });

  test('concatenates multiple text parts', () => {
    const result = parseSdkMessage({
      parts: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ],
    });
    expect(result.text).toBe('hello world');
  });

  test('extracts tool calls', () => {
    const result = parseSdkMessage({
      parts: [
        {
          type: 'tool',
          tool: 'read',
          state: { input: { path: 'foo.ts' }, output: 'content' },
        },
      ],
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('read');
    expect(result.toolCalls[0].args).toEqual({ path: 'foo.ts' });
    expect(result.toolCalls[0].result).toBe('content');
  });

  test('defaults role to unknown', () => {
    const result = parseSdkMessage({});
    expect(result.role).toBe('unknown');
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([]);
  });

  test('extracts agent metadata', () => {
    const result = parseSdkMessage({
      info: { agent: 'fixer', modelID: 'gpt-4', cost: 0.02, finish: 'stop' },
    });
    expect(result.agent).toBe('fixer');
    expect(result.modelID).toBe('gpt-4');
    expect(result.cost).toBe(0.02);
    expect(result.finish).toBe('stop');
  });

  test('extracts token info', () => {
    const result = parseSdkMessage({
      info: {
        tokens: {
          input: 100,
          output: 50,
          reasoning: 10,
          cache: { read: 20, write: 0 },
        },
      },
    });
    expect(result.tokens?.input).toBe(100);
    expect(result.tokens?.output).toBe(50);
    expect(result.tokens?.cache?.read).toBe(20);
  });

  test('skips non-text, non-tool parts', () => {
    const result = parseSdkMessage({
      parts: [{ type: 'unknown', data: 'junk' }],
    });
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([]);
  });
});

describe('buildTranscript', () => {
  test('builds messages array', () => {
    const result = buildTranscript([
      { role: 'user', text: 'hello', toolCalls: [] },
      { role: 'assistant', text: 'world', toolCalls: [] },
    ]);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toBe('hello');
    expect(result.messages[1].content).toBe('world');
  });

  test('counts tool calls', () => {
    const result = buildTranscript([
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ name: 'read', args: {}, result: 'ok' }],
      },
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          { name: 'write', args: {}, result: 'ok' },
          { name: 'read', args: {}, result: 'ok' },
        ],
      },
    ]);
    expect(result.toolCallCount).toBe(3);
  });

  test('counts assistant turns', () => {
    const result = buildTranscript([
      { role: 'user', text: 'hi', toolCalls: [] },
      { role: 'assistant', text: 'hello', toolCalls: [] },
      { role: 'user', text: 'again', toolCalls: [] },
      { role: 'assistant', text: 'world', toolCalls: [] },
    ]);
    expect(result.turnCount).toBe(2);
  });

  test('builds agentInvocations from task tool calls', () => {
    const result = buildTranscript([
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          { name: 'task', args: { subagent_type: 'fixer' }, result: {} },
          { name: 'read', args: {}, result: {} },
          { name: 'task', args: { subagent_type: 'explorer' }, result: {} },
        ],
      },
    ]);
    expect(result.agentInvocations).toHaveLength(2);
    expect(result.agentInvocations[0].agent).toBe('fixer');
    expect(result.agentInvocations[1].agent).toBe('explorer');
  });

  test('builds agentTokens from assistant messages', () => {
    const result = buildTranscript([
      {
        role: 'assistant',
        text: '',
        toolCalls: [],
        agent: 'orchestrator',
        tokens: {
          input: 100,
          output: 50,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0.01,
      },
      {
        role: 'assistant',
        text: '',
        toolCalls: [],
        agent: 'fixer',
        tokens: {
          input: 200,
          output: 30,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0.02,
      },
    ]);
    expect(result.agentTokens?.orchestrator?.input).toBe(100);
    expect(result.agentTokens?.orchestrator?.output).toBe(50);
    expect(result.agentTokens?.orchestrator?.cost).toBe(0.01);
    expect(result.agentTokens?.fixer?.input).toBe(200);
    expect(result.agentTokens?.fixer?.cost).toBe(0.02);
  });

  test('builds modelSwitches from modelID changes', () => {
    const result = buildTranscript([
      { role: 'assistant', text: '', toolCalls: [], modelID: 'gpt-4' },
      { role: 'assistant', text: '', toolCalls: [], modelID: 'gpt-4' },
      { role: 'assistant', text: '', toolCalls: [], modelID: 'gpt-3.5' },
    ]);
    expect(result.modelSwitches).toHaveLength(1);
    expect(result.modelSwitches[0]).toEqual({ from: 'gpt-4', to: 'gpt-3.5' });
  });

  test('handles empty input', () => {
    const result = buildTranscript([]);
    expect(result.messages).toEqual([]);
    expect(result.toolCallCount).toBe(0);
    expect(result.turnCount).toBe(0);
    expect(result.agentInvocations).toEqual([]);
    expect(result.agentTokens).toEqual({});
    expect(result.modelSwitches).toEqual([]);
  });
});

describe('pollSession', () => {
  const MINIMAL_TERMINAL_MSG = {
    info: { role: 'assistant', finish: 'stop' },
    parts: [{ type: 'text', text: 'hello' }],
  };
  const MINIMAL_USER_MSG = {
    info: { role: 'user' },
    parts: [],
  };

  function makeConfig(
    overrides?: Partial<PollSessionConfig>,
  ): PollSessionConfig {
    return {
      fetchMessages: async () => [],
      agent: 'orchestrator',
      prompt: 'test',
      label: 'test',
      attempt: 1,
      directory: '/tmp',
      timeoutMs: 5000,
      stallMs: 200,
      graceMs: 200,
      ...overrides,
    };
  }

  test('returns success on terminal session with text', async () => {
    const config = makeConfig({
      timeoutMs: 5000,
      stallMs: 5000, // long so stall doesn't fire
      graceMs: 5000,
      fetchMessages: async () => {
        return [{ info: { role: 'user' }, parts: [] }, MINIMAL_TERMINAL_MSG];
      },
    });
    const result = await pollSession(config, 'test-sid');
    expect(result.success).toBe(true);
    expect(result.response).toBe('hello');
  });

  test('returns stall error when no activity', async () => {
    const config = makeConfig({
      stallMs: 100,
      timeoutMs: 5000,
      fetchMessages: async () => {
        await Bun.sleep(50);
        return [
          { info: { role: 'user' }, parts: [] },
          { info: { role: 'assistant' }, parts: [] },
        ];
      },
    });
    const result = await pollSession(config, 'test-sid');
    expect(result.success).toBe(false);
    expect(result.error).toContain('stalled');
  });

  test('returns timeout when session produces no output', async () => {
    const config = makeConfig({
      timeoutMs: 100,
      stallMs: 5000,
      graceMs: 5000,
      fetchMessages: async () => [],
    });
    const result = await pollSession(config, 'test-sid');
    expect(result.success).toBe(false);
    expect(result.error).toContain('no output');
  });

  test('grace window extends for pending task', async () => {
    let callCount = 0;
    const config = makeConfig({
      timeoutMs: 5000,
      stallMs: 5000,
      graceMs: 300,
      fetchMessages: async () => {
        callCount++;
        if (callCount <= 3) {
          // Terminal session with a pending task call.
          // status='waiting' makes isTerminalSession return true (not pending/running),
          // but the inner hasPendingTask check sees it as uncompleted (not 'completed'/'error').
          return [
            MINIMAL_USER_MSG,
            {
              info: { role: 'assistant', finish: 'stop' },
              parts: [
                {
                  type: 'tool',
                  tool: 'task',
                  state: { input: {}, output: '' },
                },
                {
                  type: 'text',
                  text: 'working...',
                },
              ],
            },
          ];
        }
        // After grace expires, return terminal session with completed task
        return [
          MINIMAL_USER_MSG,
          {
            info: { role: 'assistant', finish: 'stop' },
            parts: [{ type: 'text', text: 'done' }],
          },
        ];
      },
    });

    const result = await pollSession(config, 'test-sid');
    expect(result.success).toBe(true);
    expect(result.response).toBe('working...');
  });

  test('error handling returns failure', async () => {
    const config = makeConfig({
      fetchMessages: async () => {
        throw new Error('network failure');
      },
    });
    const result = await pollSession(config, 'test-sid');
    expect(result.success).toBe(false);
  });
});
