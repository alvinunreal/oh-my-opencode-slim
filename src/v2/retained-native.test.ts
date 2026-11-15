import { describe, expect, mock, test } from 'bun:test';
import { createToolExecuteBridges } from './setup';

const PARENT = 'ses_parent';
const CHILD = 'ses_child';

function continuation(input: Record<string, unknown>) {
  return {
    tool: 'subagent',
    sessionID: PARENT,
    id: 'call_continue',
    input,
  };
}

describe('native continuation through the shared tool guard bridge', () => {
  test('keeps the exact child identity without adopting or reconciling it', async () => {
    const before = mock(async () => {});
    const event = continuation({ sessionID: CHILD, prompt: 'Continue' });
    await createToolExecuteBridges(before, undefined).beforeBridge(event);
    expect(before).toHaveBeenCalledWith(
      { tool: 'task', sessionID: PARENT, callID: 'call_continue' },
      { args: { task_id: CHILD, prompt: 'Continue' } },
    );
    expect(event.input).toEqual({ sessionID: CHILD, prompt: 'Continue' });
  });

  test.each(['ses', 'ses_unknown', 'ses_foreign', 'exp-1', ''])(
    'leaves resume reference %j for the host rather than inventing a replacement',
    async (sessionID) => {
      const event = continuation({ sessionID, prompt: 'Continue' });
      await createToolExecuteBridges(async () => {}, undefined).beforeBridge(
        event,
      );
      expect(event.input).toEqual({ sessionID, prompt: 'Continue' });
    },
  );

  test('preset capture still runs for a continuation that omitted the agent', async () => {
    const capture = mock(async () => undefined);
    const event = continuation({ sessionID: CHILD, prompt: 'Continue' });
    await createToolExecuteBridges(
      async () => {},
      undefined,
      capture,
    ).beforeBridge(event);
    expect(capture).toHaveBeenCalledWith({
      agentType: '',
      parentSessionID: PARENT,
      callID: 'call_continue',
      args: { task_id: CHILD, prompt: 'Continue' },
    });
    expect(event.input).toEqual({ sessionID: CHILD, prompt: 'Continue' });
  });

  test('passes native structured completion through unchanged', async () => {
    const result = {
      output: { sessionID: CHILD, status: 'completed' },
      content: `<subagent sessionID="${CHILD}" state="completed">\nResult\n</subagent>`,
    };
    const event = {
      ...continuation({ sessionID: CHILD, prompt: 'Continue' }),
      status: 'completed',
      result,
    };
    await createToolExecuteBridges(undefined, async () => {}).afterBridge(
      event,
    );
    expect(event.result).toBe(result);
    expect(event.result).toEqual({
      output: { sessionID: CHILD, status: 'completed' },
      content: `<subagent sessionID="${CHILD}" state="completed">\nResult\n</subagent>`,
    });
  });

  test('keeps a host refusal readable without retrying or rewriting child identity', async () => {
    const error = new Error(`Subagent session not found: ${CHILD}`);
    const after = mock(async () => {});
    const event = {
      ...continuation({ sessionID: CHILD, prompt: 'Continue' }),
      status: 'error',
      error,
    };
    await createToolExecuteBridges(undefined, after).afterBridge(event);
    expect(event.error).toBe(error);
    expect(event.input.sessionID).toBe(CHILD);
    expect(after).toHaveBeenCalledTimes(1);
  });
});
