import { afterEach, describe, expect, mock, test } from 'bun:test';

import { createNativeTaskControlTools } from './native-task-control';

type HostFixture = {
  parentID?: string;
  agent?: string;
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  idleAt?: number;
  inputAt?: number;
  assistantText?: string;
};

function transcript(fixture: HostFixture) {
  const inputAt = fixture.inputAt ?? 1_000;
  const entries: unknown[] = [
    { info: { id: 'msg_u', role: 'user', time: { created: inputAt } } },
  ];
  if (fixture.assistantText !== undefined) {
    entries.push({
      info: { id: 'msg_a', role: 'assistant', time: { completed: 2_000 } },
      parts: [{ type: 'text', text: fixture.assistantText }],
    });
  }
  return { data: entries };
}

/**
 * SDK session methods read `this._client`, so the abort mock must depend on
 * its receiver: a detached call fails loudly instead of silently posting.
 */
function abortOnReceiver(response: unknown) {
  return mock(function (this: { _client: string }) {
    if (this?._client !== 'client') {
      throw new Error('session method called without its receiver');
    }
    return Promise.resolve(response);
  });
}

function createTools(
  fixture: HostFixture = {},
  options?: {
    noGet?: boolean;
    noAbort?: boolean;
    flavor?: 'v1' | 'v2';
    liveStatus?: string;
    abortResponse?: unknown;
    abortImpl?: () => Promise<unknown>;
    messages?: () => Promise<unknown>;
    abortTimeoutMs?: number;
  },
) {
  const parentID = fixture.parentID ?? 'ses_parent';
  const get = mock(async () => ({
    data: {
      id: 'ses_child',
      parentID,
      agent: fixture.agent ?? 'explorer',
      ...(fixture.outcome
        ? { outcome: fixture.outcome, time: { idle: fixture.idleAt ?? 2_500 } }
        : { time: { created: 500 } }),
    },
  }));
  const messages = mock(options?.messages ?? (async () => transcript(fixture)));
  const status = mock(async () => ({
    data:
      options?.liveStatus !== undefined
        ? { ses_child: { type: options.liveStatus } }
        : {},
  }));
  const abort = options?.abortImpl
    ? mock(function (this: unknown) {
        if (this !== session) 'use the receiver';
        return options.abortImpl?.();
      })
    : abortOnReceiver(options?.abortResponse ?? { interrupted: true });
  const session = {
    _client: 'client',
    ...(options?.noGet ? {} : { get }),
    messages,
    status,
    ...(options?.noAbort ? {} : { abort }),
  } as { _client: string } & Record<string, unknown>;
  const client = { session, delete: mock(async () => ({})) };
  const tools = createNativeTaskControlTools({
    input: {
      directory: '/test/project',
      client,
      ...(options?.flavor === 'v1' ? {} : { hostFlavor: 'v2' }),
    } as never,
    ...(options?.abortTimeoutMs !== undefined
      ? { abortTimeoutMs: options.abortTimeoutMs }
      : {}),
  });
  return { tools, get, messages, abort, status, client };
}

const v2Context = { sessionID: 'ses_parent', agent: 'orchestrator' } as never;

afterEach(() => {
  mock.restore();
});

describe('native task controls', () => {
  test('task_status reports a completed child and its latest result', async () => {
    const { tools, messages } = createTools({
      outcome: 'succeeded',
      assistantText: 'the seat answer',
    });
    const output = await tools.task_status.execute(
      { task_id: 'ses_child' },
      v2Context,
    );
    expect(output).toContain('Session ses_child');
    expect(output).toContain('agent: explorer');
    expect(output).toContain('state: completed');
    expect(output).toContain('the seat answer');
    // Read-only: no delete, no interrupt.
    expect(messages).toHaveBeenCalledTimes(1);
  });

  test('task_status never claims a live run from transcript-only evidence', async () => {
    const { tools } = createTools();
    const output = await tools.task_status.execute(
      { task_id: 'ses_child' },
      v2Context,
    );
    expect(output).toContain('state: unknown (incomplete');
    expect(output).not.toContain('It is still working');
    expect(output).toContain('host notifies on completion');
  });

  test('task_status reports a textless success as incomplete, not running', async () => {
    const { tools } = createTools({ outcome: 'succeeded' });
    const output = await tools.task_status.execute(
      { task_id: 'ses_child' },
      v2Context,
    );
    expect(output).toContain('state: unknown (incomplete');
    expect(output).not.toContain('state: completed');
  });

  test('task_status refuses a child owned by another parent without reading further', async () => {
    const { tools, messages } = createTools({ parentID: 'ses_other' });
    await expect(
      tools.task_status.execute({ task_id: 'ses_child' }, v2Context),
    ).rejects.toThrow('does not belong to this session');
    expect(messages).not.toHaveBeenCalled();
  });

  test('task_status accepts the host-native identifier parameter', async () => {
    const { tools } = createTools({
      outcome: 'succeeded',
      assistantText: 'ok',
    });
    const output = await tools.task_status.execute(
      { sessionID: 'ses_child' },
      v2Context,
    );
    expect(output).toContain('state: completed');
  });

  test('task_status surfaces an unreadable transcript as unknown', async () => {
    const { tools } = createTools(
      {},
      {
        messages: async () => {
          throw new Error('gone');
        },
      },
    );
    const output = await tools.task_status.execute(
      { task_id: 'ses_child' },
      v2Context,
    );
    expect(output).toContain('transcript could not be read');
  });

  test('v1 live busy is reported as a confirmed running state', async () => {
    const { tools } = createTools({}, { flavor: 'v1', liveStatus: 'busy' });
    const output = await tools.task_status.execute(
      { task_id: 'ses_child' },
      v2Context,
    );
    expect(output).toContain('state: busy (live)');
    expect(output).toContain('Do not poll');
  });

  test('task_cancel interrupts through the host method with its receiver', async () => {
    const { tools, abort, client } = createTools();
    const output = await tools.task_cancel.execute(
      { task_id: 'ses_child' },
      v2Context,
    );
    expect(abort).toHaveBeenCalledTimes(1);
    expect(output).toContain('Interrupt accepted for ses_child');
    expect(output).toContain('session retained');
    expect(client.delete).not.toHaveBeenCalled();
  });

  test('task_cancel reads no transcript and polls no host state', async () => {
    const { tools, messages, get } = createTools();
    await tools.task_cancel.execute({ task_id: 'ses_child' }, v2Context);
    expect(messages).not.toHaveBeenCalled();
    // Exactly one ownership read; no post-abort observation.
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('an idle host interrupt reports that nothing was interrupted', async () => {
    const { tools } = createTools(
      {},
      { abortResponse: { interrupted: false } },
    );
    const output = await tools.task_cancel.execute(
      { task_id: 'ses_child' },
      v2Context,
    );
    expect(output).toContain('No active execution interrupted');
    expect(output).not.toContain('Interrupt accepted');
  });

  test('v1 {data:false} is reported as nothing interrupted', async () => {
    const { tools } = createTools({}, { abortResponse: { data: false } });
    const output = await tools.task_cancel.execute(
      { task_id: 'ses_child' },
      v2Context,
    );
    expect(output).toContain('No active execution interrupted');
  });

  test('v1 {data:true} is reported as accepted', async () => {
    const { tools } = createTools({}, { abortResponse: { data: true } });
    const output = await tools.task_cancel.execute(
      { task_id: 'ses_child' },
      v2Context,
    );
    expect(output).toContain('Interrupt accepted');
  });

  test('an absent outcome is never reported as a stop or a failure', async () => {
    const { tools } = createTools({}, { abortResponse: {} });
    const output = await tools.task_cancel.execute(
      { task_id: 'ses_child' },
      v2Context,
    );
    expect(output).toContain('did not report an interruption outcome');
    expect(output).not.toContain('No active execution interrupted');
    expect(output).not.toContain('Interrupt accepted');
  });

  test('an error envelope fails honestly instead of claiming success', async () => {
    const { tools } = createTools(
      {},
      { abortResponse: { error: { message: 'nope' } } },
    );
    await expect(
      tools.task_cancel.execute({ task_id: 'ses_child' }, v2Context),
    ).rejects.toThrow('was rejected for ses_child');
  });

  test('a thrown transport error stays uncertain and is not swallowed', async () => {
    const { tools } = createTools(
      {},
      {
        abortImpl: async () => {
          throw new Error('socket closed');
        },
      },
    );
    await expect(
      tools.task_cancel.execute({ task_id: 'ses_child' }, v2Context),
    ).rejects.toThrow('could not confirm the interruption');
  });

  test('task_cancel surfaces an honest failure when the host has no abort API', async () => {
    const { tools } = createTools({}, { noAbort: true });
    await expect(
      tools.task_cancel.execute({ task_id: 'ses_child' }, v2Context),
    ).rejects.toThrow('no session.abort API');
  });

  test('task_cancel refuses a child owned by another parent', async () => {
    const { tools, abort } = createTools({ parentID: 'ses_other' });
    await expect(
      tools.task_cancel.execute({ task_id: 'ses_child' }, v2Context),
    ).rejects.toThrow('does not belong to this session');
    expect(abort).not.toHaveBeenCalled();
  });

  test('tasks require the host identifier parameter', async () => {
    const { tools } = createTools();
    await expect(tools.task_status.execute({}, v2Context)).rejects.toThrow(
      'task_status requires sessionID',
    );
    await expect(tools.task_cancel.execute({}, v2Context)).rejects.toThrow(
      'task_cancel requires sessionID',
    );
  });

  test('missing session.get is reported as capability absence', async () => {
    const { tools } = createTools({}, { noGet: true });
    await expect(
      tools.task_status.execute({ task_id: 'ses_child' }, v2Context),
    ).rejects.toThrow('no session.get API');
  });
});
