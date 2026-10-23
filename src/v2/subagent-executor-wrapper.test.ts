import { describe, expect, test } from 'bun:test';
import {
  HOST_FAILURE_MESSAGE_PATTERN,
  type SubagentStructuredLaunch,
  createSubagentExecutorWrapper,
} from './subagent-executor-wrapper';

function recorder() {
  const launches: SubagentStructuredLaunch[] = [];
  return {
    launches,
    register: (launch: SubagentStructuredLaunch) => {
      launches.push(launch);
    },
  };
}

const ctx = { id: 'call_1' };

describe('createSubagentExecutorWrapper', () => {
  test('registers a running background launch from the structured result', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const result = {
      output: { sessionID: 'ses_child', status: 'running' },
      content:
        'The subagent is working in the background (sessionID: ses_child).',
      metadata: { sessionID: 'ses_child', status: 'running' },
    };
    const original = async () => result;
    const wrapped = wrapper.wrap(original);

    const returned = await wrapped({}, ctx);

    // Result is passed through byte-for-byte (same object identity).
    expect(returned).toBe(result);
    expect(rec.launches).toEqual([
      {
        callID: 'call_1',
        childTaskID: 'ses_child',
        state: 'running',
        background: false,
      },
    ]);
  });

  test('carries host-confirmed background promotion from metadata', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const wrapped = wrapper.wrap(async () => ({
      output: { sessionID: 'ses_promoted', status: 'running' },
      metadata: { sessionID: 'ses_promoted', background: true },
    }));

    await wrapped({}, ctx);

    expect(rec.launches).toHaveLength(1);
    expect(rec.launches[0]).toMatchObject({
      childTaskID: 'ses_promoted',
      state: 'running',
      background: true,
    });
  });

  test('maps a completed foreground result to the terminal state', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const content =
      '<subagent sessionID="ses_done" state="completed">ok</subagent>';
    const wrapped = wrapper.wrap(async () => ({
      output: { sessionID: 'ses_done', status: 'completed' },
      content,
      metadata: { sessionID: 'ses_done', status: 'completed' },
    }));

    const returned = await wrapped({}, ctx);

    expect((returned as { content: string }).content).toBe(content);
    expect(rec.launches[0]).toMatchObject({
      childTaskID: 'ses_done',
      state: 'completed',
    });
  });

  test('fails open when the result carries no structured session ID', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const result = { content: 'not a delegated launch' };
    const wrapped = wrapper.wrap(async () => result);

    expect(await wrapped({}, ctx)).toBe(result);
    expect(rec.launches).toHaveLength(0);
  });

  test('fails open when the call has no call ID', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const wrapped = wrapper.wrap(async () => ({
      output: { sessionID: 'ses_child', status: 'running' },
    }));

    await wrapped({}, {});
    await wrapped({}, undefined);

    expect(rec.launches).toHaveLength(0);
  });

  test('registers a failed launch from the host failure sentence and rethrows the original error', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const failure = new Error('Subagent failed (sessionID: ses_fail): boom');
    const wrapped = wrapper.wrap(async () => {
      throw failure;
    });

    let thrown: unknown;
    try {
      await wrapped({}, ctx);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(rec.launches).toEqual([
      {
        callID: 'call_1',
        childTaskID: 'ses_fail',
        state: 'error',
        background: false,
      },
    ]);
  });

  test('registers a cancelled launch from the host failure sentence', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const wrapped = wrapper.wrap(async () => {
      throw new Error('Subagent cancelled (sessionID: ses_stop): stopped');
    });

    await expect(wrapped({}, ctx)).rejects.toThrow('Subagent cancelled');

    expect(rec.launches[0]).toMatchObject({
      childTaskID: 'ses_stop',
      state: 'cancelled',
    });
  });

  test('fails open on an unrecognized failure message', async () => {
    const rec = recorder();
    const wrapper = createSubagentExecutorWrapper({ register: rec.register });
    const failure = new Error('network down');
    const wrapped = wrapper.wrap(async () => {
      throw failure;
    });

    let thrown: unknown;
    try {
      await wrapped({}, ctx);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(rec.launches).toHaveLength(0);
  });

  test('a throwing register never alters the tool result', async () => {
    const wrapper = createSubagentExecutorWrapper({
      register: () => {
        throw new Error('registration exploded');
      },
    });
    const result = {
      output: { sessionID: 'ses_child', status: 'running' },
    };
    const wrapped = wrapper.wrap(async () => result);

    expect(await wrapped({}, ctx)).toBe(result);
  });

  test('an async registration rejection never alters the tool result', async () => {
    const wrapper = createSubagentExecutorWrapper({
      register: async () => {
        throw new Error('registration rejected');
      },
    });
    const result = {
      output: { sessionID: 'ses_child', status: 'running' },
    };
    const wrapped = wrapper.wrap(async () => result);

    expect(await wrapped({}, ctx)).toBe(result);
    // Let the swallowed rejection settle before the test ends.
    await Promise.resolve();
  });

  test('owns() marks wrapped executors so replays cannot double-wrap', () => {
    const wrapper = createSubagentExecutorWrapper({ register: () => {} });
    const original = async () => ({});
    const wrapped = wrapper.wrap(original);

    expect(wrapper.owns(wrapped)).toBe(true);
    expect(wrapper.owns(original)).toBe(false);
    expect(wrapper.owns(undefined)).toBe(false);
  });

  test('HOST_FAILURE_MESSAGE_PATTERN pins the verbatim host sentences', () => {
    expect(
      HOST_FAILURE_MESSAGE_PATTERN.exec(
        'Subagent failed (sessionID: ses_abc): provider timeout',
      )?.[2],
    ).toBe('ses_abc');
    expect(
      HOST_FAILURE_MESSAGE_PATTERN.exec(
        'Subagent cancelled (sessionID: ses_def): user interrupt',
      )?.[2],
    ).toBe('ses_def');
    expect(HOST_FAILURE_MESSAGE_PATTERN.exec('Subagent finished')).toBeNull();
  });
});
