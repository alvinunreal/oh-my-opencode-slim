import { describe, expect, mock, test } from 'bun:test';
import { REFUSAL_CONTINUATION } from '../hooks/foreground-fallback';
import { createSubagentRefusalContinuation } from './refusal-continuation';

const refused = {
  id: 'assistant-1',
  type: 'assistant',
  finish: 'content-filter',
  agent: 'explorer',
  model: { providerID: 'capture', id: 'child' },
  time: { completed: 1 },
  error: { message: 'blocked' },
};

describe('v2 subagent refusal continuation', () => {
  test('re-attaches a foreground child once with its exact session ID', async () => {
    const outcome = mock(async () => 'capture/backup');
    const progress = mock(async () => {});
    const active = mock(() => {});
    const calls: Array<Record<string, unknown>> = [];
    const execute = mock(
      async (input: Record<string, unknown>, context: any) => {
        calls.push(input);
        await context.progress({ sessionID: 'child', status: 'running' });
        if (calls.length === 1)
          throw new Error('Subagent failed (sessionID: child): blocked');
        return { output: { sessionID: 'child', status: 'completed' } };
      },
    );
    const wrapper = createSubagentRefusalContinuation({
      context: async () => [refused],
      refusalOutcome: outcome,
      onForegroundChild: active,
    });
    const executeWrapped = wrapper.wrap(execute);

    const result = await executeWrapped(
      { agent: 'explorer', prompt: 'original', background: false },
      { sessionID: 'parent', id: 'call_1', progress },
    );

    expect(result).toEqual({
      output: { sessionID: 'child', status: 'completed' },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      sessionID: 'child',
      prompt: REFUSAL_CONTINUATION,
      background: false,
    });
    expect(calls[1]?.model).toBeUndefined();
    expect(outcome).toHaveBeenCalledTimes(1);
    expect(active.mock.calls).toEqual([
      ['child', true],
      ['child', true],
      ['child', false],
    ]);
  });

  test('leaves a background child to the manager continuation', async () => {
    const active = mock(() => {});
    const execute = mock(async (_input, context: any) => {
      await context.progress({ sessionID: 'child', status: 'running' });
      return { output: { sessionID: 'child', status: 'running' } };
    });
    const wrapper = createSubagentRefusalContinuation({
      context: async () => [refused],
      refusalOutcome: async () => 'capture/backup',
      onForegroundChild: active,
    });

    await wrapper.wrap(execute)(
      { agent: 'explorer', prompt: 'original', background: true },
      { sessionID: 'parent', id: 'call_1', progress: async () => {} },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(active).not.toHaveBeenCalled();
  });

  test('does not retry a cancelled subagent', async () => {
    const outcome = mock(async () => 'capture/backup');
    const execute = mock(async (_input, context: any) => {
      await context.progress({ sessionID: 'child', status: 'running' });
      throw new Error('Subagent cancelled (sessionID: child)');
    });
    const wrapper = createSubagentRefusalContinuation({
      context: async () => [refused],
      refusalOutcome: outcome,
      onForegroundChild: () => {},
    });

    await expect(
      wrapper.wrap(execute)(
        { agent: 'explorer', prompt: 'original' },
        { sessionID: 'parent', id: 'call_1', progress: async () => {} },
      ),
    ).rejects.toThrow('Subagent cancelled');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(outcome).not.toHaveBeenCalled();
  });

  test('propagates a failure without a refusal outcome', async () => {
    const execute = mock(async (_input, context: any) => {
      await context.progress({ sessionID: 'child', status: 'running' });
      throw new Error('Subagent failed (sessionID: child): other');
    });
    const wrapper = createSubagentRefusalContinuation({
      context: async () => [
        {
          ...refused,
          finish: 'error',
          error: { message: 'other' },
        },
      ],
      refusalOutcome: async () => undefined,
      onForegroundChild: () => {},
    });

    await expect(
      wrapper.wrap(execute)(
        { agent: 'explorer', prompt: 'original' },
        { sessionID: 'parent', id: 'call_1', progress: async () => {} },
      ),
    ).rejects.toThrow('Subagent failed');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
