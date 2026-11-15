import { describe, expect, test } from 'bun:test';
import {
  INTERNAL_INITIATOR_METADATA_KEY,
  SLIM_INTERNAL_INITIATOR_MARKER,
} from '../utils/internal-initiator';
import { buildPluginInput } from '../v2/client-shim';
import { isInternalAdmission } from '../v2/internal-admissions';
import type { V2Context } from '../v2/types';
import { createTaskReportTool } from './task-report';

/** exact2.3 `SessionInbox.Synthetic` record returned by session.synthetic. */
function nativeSyntheticRecord(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: input.id,
    sessionID: input.sessionID,
    time: { created: 1 },
    type: 'synthetic',
    payload: {
      text: input.text,
      description: input.description,
      metadata: input.metadata,
    },
    delivery: input.delivery,
  };
}

/** exact2.3 reconcile can return the FIRST record for a reused id even when
 * the new payload differs. Keep the envelope identical; mutate only payload. */
function staleSyntheticRecord(
  input: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const record = nativeSyntheticRecord(input);
  return {
    ...record,
    payload: { ...(record.payload as Record<string, unknown>), ...patch },
  };
}

function createContext(
  options: {
    child?: Record<string, unknown>;
    parent?: Record<string, unknown>;
    onSynthetic?: (input: Record<string, unknown>) => void;
    syntheticResult?: (input: Record<string, unknown>) => unknown;
    syntheticThrows?: Error;
    omitGet?: boolean;
    omitSynthetic?: boolean;
    omitChildRecord?: boolean;
    deferredGet?: boolean;
  } = {},
) {
  const sessions: Record<string, Record<string, unknown>> = {
    child: {
      id: 'child',
      parentID: 'parent',
      agent: 'fixer',
      ...(options.child ?? {}),
    },
    parent: {
      id: 'parent',
      agent: 'orchestrator',
      outcome: 'succeeded',
      ...(options.parent ?? {}),
    },
  };
  if (options.omitChildRecord) delete sessions.child;
  const state = {
    getCalls: [] as string[],
    promptCalls: [] as unknown[],
    switchModelCalls: [] as unknown[],
    syntheticInputs: [] as Record<string, unknown>[],
  };
  let resolveGet: ((value: unknown) => void) | undefined;
  const getGate = options.deferredGet
    ? new Promise<unknown>((resolve) => {
        resolveGet = resolve;
      })
    : undefined;
  const ctx = {
    app: { name: 'opencode', version: 'test' },
    options: {},
    agent: {
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
      list: async () => [],
    },
    tool: {
      transform: async () => ({ dispose() {} }),
      hook: async () => ({ dispose() {} }),
    },
    command: {
      transform: async () => ({ dispose() {} }),
      list: async () => [],
    },
    session: {
      hook: async () => ({ dispose() {} }),
      ...(options.omitGet
        ? {}
        : {
            get: async ({ sessionID }: { sessionID: string }) => {
              state.getCalls.push(sessionID);
              return getGate ?? sessions[sessionID];
            },
          }),
      prompt: async (input: unknown) => {
        state.promptCalls.push(input);
        return {};
      },
      switchModel: async (input: unknown) => {
        state.switchModelCalls.push(input);
      },
      ...(options.omitSynthetic
        ? {}
        : {
            synthetic: async (input: Record<string, unknown>) => {
              state.syntheticInputs.push(input);
              options.onSynthetic?.(input);
              if (options.syntheticThrows) throw options.syntheticThrows;
              const result = options.syntheticResult ?? nativeSyntheticRecord;
              return result(input);
            },
          }),
    },
    event: { subscribe: () => ({}) },
    location: {
      directory: '/test',
      project: { id: 'project', directory: '/test', canonical: '/test' },
    },
  } as unknown as V2Context;
  return { input: buildPluginInput(ctx) as never, state, resolveGet };
}

const reportArgs = {
  kind: 'progress',
  message: 'The focused implementation is complete.',
};

describe('task_report', () => {
  test('queues a native synthetic update with internal metadata and no user prompt or model switch', async () => {
    const { input, state } = createContext({});
    const { task_report } = createTaskReportTool({ input });

    const result = await task_report.execute(reportArgs, {
      sessionID: 'child',
    } as never);

    expect(state.syntheticInputs).toHaveLength(1);
    const admission = state.syntheticInputs[0];
    expect(admission).toMatchObject({
      sessionID: 'parent',
      delivery: 'queue',
      resume: false,
      description: 'oh-my-opencode-slim internal initiator',
      metadata: { [INTERNAL_INITIATOR_METADATA_KEY]: true },
    });
    expect(admission?.id).toMatch(/^msg_omos_[0-9a-f-]{36}$/);
    expect(admission?.text).toContain('kind="progress"');
    expect(admission?.text).toContain('From @fixer (session child)');
    expect(admission?.text).toContain(reportArgs.message);
    expect(admission?.text).toContain(SLIM_INTERNAL_INITIATOR_MARKER);
    // Exactly one native read: the calling child, never a parent lookup.
    expect(state.getCalls).toEqual(['child']);
    // No v1 user-prompt/model-switch transport remains.
    expect(state.promptCalls).toEqual([]);
    expect(state.switchModelCalls).toEqual([]);
    expect(result).toMatch(/Update [a-f0-9-]{36} queued for the parent/);
    expect(result).toContain('without waking it');
    expect(result).toContain('processing is not confirmed');
    expect(result).not.toContain('processed');
  });

  test('header tracker classifies the admitted synthetic id as internal', async () => {
    const { input, state } = createContext({});
    const { task_report } = createTaskReportTool({ input });

    await task_report.execute(reportArgs, { sessionID: 'child' } as never);

    const id = state.syntheticInputs[0]?.id as string;
    expect(isInternalAdmission('parent', id)).toBe(true);
  });

  test('does not send from a parentless session', async () => {
    const { input, state } = createContext({
      child: { parentID: undefined },
    });
    const { task_report } = createTaskReportTool({ input });

    await expect(
      task_report.execute(reportArgs, { sessionID: 'child' } as never),
    ).rejects.toThrow('only available in a child session');
    expect(state.syntheticInputs).toHaveLength(0);
  });

  test('refuses an empty parentID', async () => {
    const { input, state } = createContext({ child: { parentID: '' } });
    const { task_report } = createTaskReportTool({ input });

    await expect(
      task_report.execute(reportArgs, { sessionID: 'child' } as never),
    ).rejects.toThrow('only available in a child session');
    expect(state.syntheticInputs).toHaveLength(0);
  });

  test('refuses a foreign child id, a non-string agent, or a missing child record', async () => {
    const contexts = [
      createContext({ child: { id: 'foreign' } }),
      createContext({ child: { agent: 42 } }),
      createContext({ omitChildRecord: true }),
    ];
    for (const ctx of contexts) {
      const { task_report } = createTaskReportTool({ input: ctx.input });
      await expect(
        task_report.execute(reportArgs, { sessionID: 'child' } as never),
      ).rejects.toThrow('Could not verify the calling subagent session');
      expect(ctx.state.syntheticInputs).toHaveLength(0);
    }
  });

  test('missing native synthetic fails honestly with no user-prompt fallback', async () => {
    for (const options of [{ omitSynthetic: true }, { omitGet: true }]) {
      const { input, state } = createContext(options);
      const { task_report } = createTaskReportTool({ input });

      await expect(
        task_report.execute(reportArgs, { sessionID: 'child' } as never),
      ).rejects.toThrow(/native v2 session/);
      expect(state.syntheticInputs).toHaveLength(0);
      expect(state.promptCalls).toEqual([]);
    }
  });

  test.each([
    ['false', () => false],
    ['undefined', () => undefined],
    ['malformed record', () => ({ id: 'wrong', type: 'synthetic' })],
    [
      'wrong-id record',
      (input: Record<string, unknown>) => ({
        ...nativeSyntheticRecord(input),
        id: 'msg_omos_other',
      }),
    ],
  ])('does not acknowledge a %s synthetic response', async (_, result) => {
    const { input } = createContext({
      syntheticResult: result as (input: Record<string, unknown>) => unknown,
    });
    const { task_report } = createTaskReportTool({ input });

    await expect(
      task_report.execute(reportArgs, { sessionID: 'child' } as never),
    ).rejects.toThrow('The parent session did not accept the report');
  });

  test.each([
    [
      'different text',
      (sent: Record<string, unknown>) =>
        staleSyntheticRecord(sent, { text: 'a stale report from another run' }),
    ],
    [
      'different description',
      (sent: Record<string, unknown>) =>
        staleSyntheticRecord(sent, { description: 'stale description' }),
    ],
    [
      'absent payload',
      (sent: Record<string, unknown>) => ({
        ...nativeSyntheticRecord(sent),
        payload: undefined,
      }),
    ],
    [
      'absent metadata',
      (sent: Record<string, unknown>) =>
        staleSyntheticRecord(sent, { metadata: undefined }),
    ],
    [
      'false internal marker',
      (sent: Record<string, unknown>) =>
        staleSyntheticRecord(sent, {
          metadata: { [INTERNAL_INITIATOR_METADATA_KEY]: false },
        }),
    ],
  ])(
    'rejects a same-id stale record with %s instead of claiming queued',
    async (_, stale) => {
      const { input, state } = createContext({
        syntheticResult: stale as (input: Record<string, unknown>) => unknown,
      });
      const { task_report } = createTaskReportTool({ input });

      // The envelope stays identical: id/sessionID/type/delivery all match.
      await expect(
        task_report.execute(reportArgs, { sessionID: 'child' } as never),
      ).rejects.toThrow('The parent session did not accept the report');
      expect(state.syntheticInputs).toHaveLength(1);
    },
  );

  test('propagates a thrown parent-not-found instead of claiming queued', async () => {
    const failure = new Error('Session not found');
    const { input } = createContext({ syntheticThrows: failure });
    const { task_report } = createTaskReportTool({ input });

    await expect(
      task_report.execute(reportArgs, { sessionID: 'child' } as never),
    ).rejects.toBe(failure);
  });

  test('always queues without resuming for busy, idle, interrupted, and form-wait parents', async () => {
    const parentStates: Array<[string, Record<string, unknown>]> = [
      ['busy', { outcome: 'busy', time: { busy: 2_000 } }],
      ['idle', { outcome: 'succeeded', time: { idle: 2_000 } }],
      ['interrupted', { outcome: 'interrupted', time: { idle: 2_000 } }],
      [
        'pending form',
        {
          outcome: 'running',
          pendingForm: { id: 'form-1', status: 'pending' },
        },
      ],
    ];

    for (const [stateName, parent] of parentStates) {
      const { input, state } = createContext({ parent });
      const { task_report } = createTaskReportTool({ input });
      const result = await task_report.execute(
        { ...reportArgs, kind: 'escalation' },
        { sessionID: 'child' } as never,
      );

      expect(state.syntheticInputs[0], stateName).toMatchObject({
        sessionID: 'parent',
        delivery: 'queue',
        resume: false,
      });
      expect(result, stateName).toContain('without waking it');
      expect(result, stateName).toContain('processing is not confirmed');
    }
  });

  test('disposal at entry still prevents queue admission', async () => {
    const { input, state } = createContext({});
    const { task_report } = createTaskReportTool({
      input,
      isDisposed: () => true,
    });

    await expect(
      task_report.execute(reportArgs, { sessionID: 'child' } as never),
    ).rejects.toThrow('Plugin is disposing');
    expect(state.syntheticInputs).toHaveLength(0);
  });

  test('disposal during a deferred child get prevents synthetic admission', async () => {
    let disposed = false;
    const { input, state, resolveGet } = createContext({ deferredGet: true });
    const { task_report } = createTaskReportTool({
      input,
      isDisposed: () => disposed,
    });

    const pending = task_report.execute(reportArgs, {
      sessionID: 'child',
    } as never);
    disposed = true;
    resolveGet?.({ id: 'child', parentID: 'parent', agent: 'fixer' });

    await expect(pending).rejects.toThrow('Plugin is disposing');
    expect(state.syntheticInputs).toHaveLength(0);
  });

  test('does not accept a caller-selected parent ID', () => {
    const { input } = createContext({});
    const { task_report } = createTaskReportTool({ input });
    expect(Object.keys(task_report.args).sort()).toEqual(['kind', 'message']);
  });
});
