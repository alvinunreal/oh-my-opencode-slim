import { describe, expect, mock, test } from 'bun:test';
import {
  NO_ROUTE_CONTINUATION,
  REFUSAL_CONTINUATION,
} from '../hooks/foreground-fallback';
import { createSubagentRefusalContinuation } from './refusal-continuation';
import { noRouteOutcomeID } from './terminal-fallback';

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

  test('seeds no-route recovery with the observed failure time and outcome ID', async () => {
    const outcome = mock(
      async (_sessionID: string, _entry: Record<string, unknown>) =>
        'capture/backup',
    );
    const calls: Array<Record<string, unknown>> = [];
    const execute = mock(
      async (input: Record<string, unknown>, context: any) => {
        calls.push(input);
        await context.progress({ sessionID: 'child', status: 'running' });
        if (calls.length === 1)
          throw new Error(
            'Subagent failed (sessionID: child): Model unavailable: capture/child',
          );
        return { output: { sessionID: 'child', status: 'completed' } };
      },
    );
    const wrapper = createSubagentRefusalContinuation({
      context: async () => [
        { id: 'user-1', type: 'user', time: { created: 1 }, text: 'work' },
      ],
      refusalOutcome: outcome,
      onForegroundChild: () => {},
    });

    await wrapper.wrap(execute)(
      { agent: 'explorer', prompt: 'original' },
      { sessionID: 'parent', id: 'call_1', progress: async () => {} },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      sessionID: 'child',
      prompt: NO_ROUTE_CONTINUATION,
    });
    const entry = outcome.mock.calls[0]?.[1] as Record<string, unknown>;
    const completed = (entry.time as { completed?: number }).completed;
    expect(entry).toMatchObject({
      id: noRouteOutcomeID('user-1', 'Model unavailable: capture/child'),
      baselineMessageID: 'user-1',
      type: 'no-route',
      time: { created: 1, completed: expect.any(Number) },
      error: {
        type: 'provider.no-route',
        message: 'Model unavailable: capture/child',
      },
    });
    expect(Number.isFinite(completed)).toBe(true);
  });

  test('advances the fallback chain on each new refusal message', async () => {
    const refusedAgain = {
      ...refused,
      id: 'assistant-2',
      model: { providerID: 'capture', id: 'backup' },
      time: { completed: 2 },
    };
    let historyCalls = 0;
    const outcome = mock(
      async (_sessionID: string, _entry: Record<string, unknown>) =>
        'capture/model',
    );
    outcome.mockImplementation(async () =>
      outcome.mock.calls.length === 1 ? 'capture/backup' : 'capture/final',
    );
    const calls: Array<Record<string, unknown>> = [];
    const execute = mock(
      async (input: Record<string, unknown>, context: any) => {
        calls.push(input);
        await context.progress({ sessionID: 'child', status: 'running' });
        if (calls.length < 3)
          throw new Error('Subagent failed (sessionID: child): blocked');
        return { output: { sessionID: 'child', status: 'completed' } };
      },
    );
    const wrapper = createSubagentRefusalContinuation({
      context: async () =>
        ++historyCalls === 1 ? [refused] : [refused, refusedAgain],
      refusalOutcome: outcome,
      onForegroundChild: () => {},
    });

    await wrapper.wrap(execute)(
      { agent: 'explorer', prompt: 'original' },
      { sessionID: 'parent', id: 'call_1', progress: async () => {} },
    );

    expect(calls).toHaveLength(3);
    expect(calls[1]).toMatchObject({
      sessionID: 'child',
      prompt: REFUSAL_CONTINUATION,
    });
    expect(calls[2]).toMatchObject({
      sessionID: 'child',
      prompt: REFUSAL_CONTINUATION,
    });
    expect(outcome.mock.calls.map((call) => call[1].id)).toEqual([
      'assistant-1',
      'assistant-2',
    ]);
  });

  test('does not replay the same refusal twice', async () => {
    const outcome = mock(
      async (_sessionID: string, _entry: Record<string, unknown>) =>
        'capture/backup',
    );
    const calls: Array<Record<string, unknown>> = [];
    const execute = mock(
      async (input: Record<string, unknown>, context: any) => {
        calls.push(input);
        await context.progress({ sessionID: 'child', status: 'running' });
        throw new Error('Subagent failed (sessionID: child): blocked');
      },
    );
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
    ).rejects.toThrow('Subagent failed');
    expect(calls).toHaveLength(2);
    expect(outcome).toHaveBeenCalledTimes(2);
  });

  test('ignores an older refusal after a newer assistant response', async () => {
    const outcome = mock(
      async (_sessionID: string, _entry: Record<string, unknown>) =>
        'capture/backup',
    );
    const execute = mock(async (_input, context: any) => {
      await context.progress({ sessionID: 'child', status: 'running' });
      throw new Error('Subagent failed (sessionID: child): other');
    });
    const wrapper = createSubagentRefusalContinuation({
      context: async () => [
        refused,
        {
          id: 'assistant-2',
          type: 'assistant',
          finish: 'stop',
          time: { completed: 2 },
        },
      ],
      refusalOutcome: outcome,
      onForegroundChild: () => {},
    });

    await expect(
      wrapper.wrap(execute)(
        { agent: 'explorer', prompt: 'original' },
        { sessionID: 'parent', id: 'call_1', progress: async () => {} },
      ),
    ).rejects.toThrow('Subagent failed');
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
