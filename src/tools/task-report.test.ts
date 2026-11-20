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

/** exact2.3 reconcile returns the FIRST record for a reused id; keep the
 * envelope identical and mutate only payload bytes. */
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
    onGet?: (sessionID: string) => void;
    syntheticResult?: (input: Record<string, unknown>) => unknown;
    syntheticThrows?: Error;
    getThrows?: { child?: Error; parent?: Error };
    omitGet?: boolean;
    omitSynthetic?: boolean;
    omitChildRecord?: boolean;
    omitParentRecord?: boolean;
    deferGet?: 'child' | 'parent';
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
  if (options.omitParentRecord) delete sessions.parent;
  const state = {
    getCalls: [] as string[],
    promptCalls: [] as unknown[],
    switchModelCalls: [] as unknown[],
    syntheticInputs: [] as Record<string, unknown>[],
  };
  let resolveGet: ((value: unknown) => void) | undefined;
  const gate = options.deferGet
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
              options.onGet?.(sessionID);
              const thrown =
                options.getThrows?.[sessionID as 'child' | 'parent'];
              if (thrown) throw thrown;
              if (gate && sessionID === options.deferGet) return gate;
              return sessions[sessionID];
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

const execute = (
  tool: ReturnType<typeof createTaskReportTool>,
  args: Record<string, unknown> = reportArgs,
) => tool.task_report.execute(args, { sessionID: 'child' } as never);

describe('task_report', () => {
  test('contract: idle escalation steers and requests a wake', async () => {
    const { input, state } = createContext({
      parent: { outcome: 'succeeded', time: { idle: 2_000 } },
    });

    await execute(createTaskReportTool({ input }), {
      ...reportArgs,
      kind: 'escalation',
    });

    const admission = state.syntheticInputs[0];
    expect(admission).toMatchObject({
      sessionID: 'parent',
      delivery: 'steer',
      resume: true,
      description: 'oh-my-opencode-slim internal initiator',
      metadata: { [INTERNAL_INITIATOR_METADATA_KEY]: true },
    });
    expect(admission?.text).toContain('kind="escalation"');
    expect(admission?.text).toContain('From @fixer (session child)');
    expect(admission?.text).toContain(reportArgs.message);
    expect(admission?.text).toContain(SLIM_INTERNAL_INITIATOR_MARKER);
  });

  test('contract: progress steers and requests a wake', async () => {
    const { input, state } = createContext({});

    await execute(createTaskReportTool({ input }));

    expect(state.syntheticInputs[0]).toMatchObject({
      sessionID: 'parent',
      delivery: 'steer',
      resume: true,
    });
    expect(state.syntheticInputs[0]?.text).toContain('kind="progress"');
  });

  test('reads exactly the child then the parent; no user prompt or model switch', async () => {
    const { input, state } = createContext({});

    await execute(createTaskReportTool({ input }));

    expect(state.getCalls).toEqual(['child', 'parent']);
    expect(state.promptCalls).toEqual([]);
    expect(state.switchModelCalls).toEqual([]);
    expect(state.syntheticInputs).toHaveLength(1);
  });

  test('header tracker classifies the admitted synthetic id as internal', async () => {
    const { input, state } = createContext({});

    await execute(createTaskReportTool({ input }));

    const id = state.syntheticInputs[0]?.id as string;
    expect(isInternalAdmission('parent', id)).toBe(true);
  });

  test('reports to a parent without an explicit agent', async () => {
    const { input, state } = createContext({ parent: { agent: undefined } });

    await execute(createTaskReportTool({ input }));

    expect(state.syntheticInputs[0]).toMatchObject({
      sessionID: 'parent',
      delivery: 'steer',
      resume: true,
    });
  });

  test('normalizes a non-string child agent to the subagent attribution', async () => {
    const { input, state } = createContext({ child: { agent: 42 } });

    await execute(createTaskReportTool({ input }));

    expect(state.syntheticInputs[0]?.text).toContain(
      'From @subagent (session child)',
    );
  });

  test('contract: interrupted parent is not resumed for either kind', async () => {
    const { input, state } = createContext({
      parent: { outcome: 'interrupted', time: { idle: 2_000 } },
    });
    const tool = createTaskReportTool({ input });

    await execute(tool);
    await execute(tool, { ...reportArgs, kind: 'escalation' });

    expect(state.syntheticInputs).toHaveLength(2);
    expect(state.syntheticInputs[0]).toMatchObject({
      sessionID: 'parent',
      delivery: 'steer',
      resume: false,
    });
    expect(state.syntheticInputs[0]?.text).toContain('kind="progress"');
    expect(state.syntheticInputs[1]).toMatchObject({
      sessionID: 'parent',
      delivery: 'steer',
      resume: false,
    });
    expect(state.syntheticInputs[1]?.text).toContain('kind="escalation"');
  });

  test('contract: busy parent does not change admission', async () => {
    const { input, state } = createContext({
      parent: { time: { busy: 2_000 } },
    });

    await execute(createTaskReportTool({ input }));

    expect(state.syntheticInputs[0]).toMatchObject({
      sessionID: 'parent',
      delivery: 'steer',
      resume: true,
    });
  });

  test('contract: result distinguishes wake request from interrupted parent', async () => {
    const normal = createTaskReportTool({ input: createContext({}).input });
    const interrupted = createTaskReportTool({
      input: createContext({ parent: { outcome: 'interrupted' } }).input,
    });
    const awake = await execute(normal);
    const dormant = await execute(interrupted);

    expect(awake).toMatch(/Update [a-f0-9-]{36}/);
    expect(awake).toContain('wake requested');
    expect(awake).not.toContain('without waking');
    expect(dormant).toContain('without waking');
    expect(awake).toContain('processing is not confirmed');
    expect(dormant).toContain('processing is not confirmed');
    expect(awake).not.toContain('processed');
    expect(dormant).not.toContain('processed');
  });

  test('does not send from a parentless session', async () => {
    const { input, state } = createContext({ child: { parentID: undefined } });

    await expect(execute(createTaskReportTool({ input }))).rejects.toThrow(
      'only available in a child session',
    );
    expect(state.syntheticInputs).toHaveLength(0);
  });

  test('refuses an empty parentID', async () => {
    const { input, state } = createContext({ child: { parentID: '' } });

    await expect(execute(createTaskReportTool({ input }))).rejects.toThrow(
      'only available in a child session',
    );
    expect(state.syntheticInputs).toHaveLength(0);
  });

  test('refuses a foreign child id or a missing child record', async () => {
    const contexts = [
      createContext({ child: { id: 'foreign' } }),
      createContext({ omitChildRecord: true }),
    ];
    for (const ctx of contexts) {
      await expect(
        execute(createTaskReportTool({ input: ctx.input })),
      ).rejects.toThrow('Could not verify the calling subagent session');
      expect(ctx.state.syntheticInputs).toHaveLength(0);
    }
  });

  test('missing native get/synthetic fails honestly with no prompt fallback', async () => {
    for (const options of [{ omitSynthetic: true }, { omitGet: true }]) {
      const { input, state } = createContext(options);

      await expect(execute(createTaskReportTool({ input }))).rejects.toThrow(
        /native v2 session/,
      );
      expect(state.syntheticInputs).toHaveLength(0);
      expect(state.promptCalls).toEqual([]);
    }
  });

  test('does not accept a parent record that is missing or mismatched', async () => {
    const contexts = [
      createContext({ omitParentRecord: true }),
      createContext({ parent: { id: 'other' } }),
    ];
    for (const ctx of contexts) {
      await expect(
        execute(createTaskReportTool({ input: ctx.input })),
      ).rejects.toThrow('Could not verify the owning parent session');
      expect(ctx.state.syntheticInputs).toHaveLength(0);
    }
  });

  test('propagates a thrown parent get or native synthetic error', async () => {
    const getFailure = new Error('parent get failed');
    const getThrows = createContext({ getThrows: { parent: getFailure } });
    await expect(
      execute(createTaskReportTool({ input: getThrows.input })),
    ).rejects.toBe(getFailure);
    expect(getThrows.state.syntheticInputs).toHaveLength(0);

    const admissionFailure = new Error('Session not found');
    const syntheticThrows = createContext({
      syntheticThrows: admissionFailure,
    });
    await expect(
      execute(createTaskReportTool({ input: syntheticThrows.input })),
    ).rejects.toBe(admissionFailure);
  });

  test.each([
    ['false', () => false],
    ['undefined', () => undefined],
    ['malformed record', () => ({ id: 'wrong', type: 'synthetic' })],
    [
      'wrong-id record',
      (sent: Record<string, unknown>) => ({
        ...nativeSyntheticRecord(sent),
        id: 'msg_omos_other',
      }),
    ],
  ])('does not acknowledge a %s synthetic response', async (_, result) => {
    const { input, state } = createContext({
      syntheticResult: result as (input: Record<string, unknown>) => unknown,
    });

    await expect(execute(createTaskReportTool({ input }))).rejects.toThrow(
      'The parent session did not accept the report',
    );
    expect(state.syntheticInputs).toHaveLength(1);
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
    'rejects a same-id stale record with %s instead of claiming success',
    async (_, stale) => {
      const { input, state } = createContext({
        syntheticResult: stale as (input: Record<string, unknown>) => unknown,
      });

      // The envelope stays identical: id/sessionID/type/delivery all match.
      await expect(execute(createTaskReportTool({ input }))).rejects.toThrow(
        'The parent session did not accept the report',
      );
      expect(state.syntheticInputs).toHaveLength(1);
    },
  );

  test('disposal at entry still prevents admission', async () => {
    const { input, state } = createContext({});
    const { task_report } = createTaskReportTool({
      input,
      isDisposed: () => true,
    });

    await expect(execute({ task_report })).rejects.toThrow(
      'Plugin is disposing',
    );
    expect(state.syntheticInputs).toHaveLength(0);
  });

  test('disposal during a deferred child get prevents admission', async () => {
    let disposed = false;
    const { input, state, resolveGet } = createContext({ deferGet: 'child' });
    const tool = createTaskReportTool({
      input,
      isDisposed: () => disposed,
    });

    const pending = execute(tool);
    disposed = true;
    resolveGet?.({ id: 'child', parentID: 'parent', agent: 'fixer' });

    await expect(pending).rejects.toThrow('Plugin is disposing');
    expect(state.syntheticInputs).toHaveLength(0);
  });

  test('disposal during a deferred parent get prevents admission', async () => {
    let disposed = false;
    let parentReadStarted!: () => void;
    const parentRead = new Promise<void>((resolve) => {
      parentReadStarted = resolve;
    });
    const { input, state, resolveGet } = createContext({
      deferGet: 'parent',
      onGet: (sessionID) => {
        if (sessionID === 'parent') parentReadStarted();
      },
    });
    const tool = createTaskReportTool({
      input,
      isDisposed: () => disposed,
    });

    const pending = execute(tool);
    await parentRead;
    expect(state.getCalls).toEqual(['child', 'parent']);
    disposed = true;
    resolveGet?.({ id: 'parent', outcome: 'succeeded' });

    await expect(pending).rejects.toThrow('Plugin is disposing');
    expect(state.syntheticInputs).toHaveLength(0);
  });

  test('does not accept a caller-selected parent ID', () => {
    const { input } = createContext({});
    const { task_report } = createTaskReportTool({ input });
    expect(Object.keys(task_report.args).sort()).toEqual(['kind', 'message']);
  });
});
