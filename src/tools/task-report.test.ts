import { describe, expect, test } from 'bun:test';
import { buildPluginInput } from '../v2/client-shim';
import type { V2Context } from '../v2/types';
import { createTaskReportTool } from './task-report';

function createContext(options: {
  child?: Record<string, unknown>;
  parent?: Record<string, unknown>;
  onSynthetic?: (input: Record<string, unknown>) => void;
}) {
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
      get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID],
      prompt: async () => ({}),
      synthetic: async (input: Record<string, unknown>) => {
        options.onSynthetic?.(input);
        return { admitted: true };
      },
    },
    event: { subscribe: () => ({}) },
    location: {
      directory: '/test',
      project: { id: 'project', directory: '/test', canonical: '/test' },
    },
  } as unknown as V2Context;
  return buildPluginInput(ctx) as never;
}

const reportArgs = {
  kind: 'progress',
  message: 'The focused implementation is complete.',
};

describe('task_report', () => {
  test('contract: idle escalation steers and requests a wake', async () => {
    let admission: Record<string, unknown> | undefined;
    const input = createContext({
      parent: { outcome: 'succeeded', time: { idle: 2_000 } },
      onSynthetic: (value) => {
        admission = value;
      },
    });
    const { task_report } = createTaskReportTool({ input });

    await task_report.execute({ ...reportArgs, kind: 'escalation' }, {
      sessionID: 'child',
    } as never);

    expect(admission).toMatchObject({
      sessionID: 'parent',
      delivery: 'steer',
      resume: true,
      description: 'oh-my-opencode-slim internal initiator',
    });
    expect(admission?.text).toContain('kind="escalation"');
    expect(admission?.text).toContain('From @fixer (session child)');
    expect(admission?.text).toContain(reportArgs.message);
  });

  test('does not send from a parentless session', async () => {
    let sent = false;
    const input = createContext({
      child: { parentID: undefined },
      onSynthetic: () => {
        sent = true;
      },
    });
    const { task_report } = createTaskReportTool({ input });

    await expect(
      task_report.execute(reportArgs, { sessionID: 'child' } as never),
    ).rejects.toThrow('only available in a child session');
    expect(sent).toBe(false);
  });

  test('contract: progress steers and requests a wake', async () => {
    let admission: Record<string, unknown> | undefined;
    const input = createContext({
      onSynthetic: (value) => {
        admission = value;
      },
    });
    const { task_report } = createTaskReportTool({ input });
    await task_report.execute(reportArgs, { sessionID: 'child' } as never);

    expect(admission).toMatchObject({
      sessionID: 'parent',
      delivery: 'steer',
      resume: true,
    });
    expect(admission?.text).toContain('kind="progress"');
  });

  test('reports to a parent without an explicit agent', async () => {
    let admission: Record<string, unknown> | undefined;
    const input = createContext({
      parent: { agent: undefined },
      onSynthetic: (value) => {
        admission = value;
      },
    });
    const { task_report } = createTaskReportTool({ input });
    await task_report.execute(reportArgs, { sessionID: 'child' } as never);

    expect(admission).toMatchObject({
      sessionID: 'parent',
      delivery: 'steer',
      resume: true,
    });
  });

  test('contract: interrupted parent is not resumed for either kind', async () => {
    const admissions: Record<string, unknown>[] = [];
    const input = createContext({
      parent: { outcome: 'interrupted', time: { idle: 2_000 } },
      onSynthetic: (value) => {
        admissions.push(value);
      },
    });
    const { task_report } = createTaskReportTool({ input });
    await task_report.execute(reportArgs, { sessionID: 'child' } as never);
    await task_report.execute({ ...reportArgs, kind: 'escalation' }, {
      sessionID: 'child',
    } as never);

    expect(admissions).toHaveLength(2);
    expect(admissions[0]).toMatchObject({
      sessionID: 'parent',
      delivery: 'steer',
      resume: false,
    });
    expect(admissions[0].text).toContain('kind="progress"');
    expect(admissions[1]).toMatchObject({
      sessionID: 'parent',
      delivery: 'steer',
      resume: false,
    });
    expect(admissions[1].text).toContain('kind="escalation"');
  });

  test('contract: busy parent does not change admission', async () => {
    let admission: Record<string, unknown> | undefined;
    const input = createContext({
      parent: { time: { busy: 2_000 } },
      onSynthetic: (value) => {
        admission = value;
      },
    });
    const { task_report } = createTaskReportTool({ input });
    await task_report.execute(reportArgs, { sessionID: 'child' } as never);

    expect(admission).toMatchObject({
      sessionID: 'parent',
      delivery: 'steer',
      resume: true,
    });
  });

  test('contract: result distinguishes wake request from interrupted parent', async () => {
    const normal = createTaskReportTool({ input: createContext({}) });
    const interrupted = createTaskReportTool({
      input: createContext({ parent: { outcome: 'interrupted' } }),
    });
    const awakeResult = await normal.task_report.execute(reportArgs, {
      sessionID: 'child',
    } as never);
    const interruptedResult = await interrupted.task_report.execute(
      reportArgs,
      {
        sessionID: 'child',
      } as never,
    );

    expect(awakeResult).toMatch(/Update [a-f0-9-]{36}/);
    expect(awakeResult).toContain('wake requested');
    expect(awakeResult).not.toContain('without waking');
    expect(interruptedResult).toContain('without waking');
    expect(awakeResult).toContain('processing is not confirmed');
    expect(interruptedResult).toContain('processing is not confirmed');
    expect(awakeResult).not.toContain('processed');
    expect(interruptedResult).not.toContain('processed');
  });

  test('disposal still prevents admission', async () => {
    let sent = false;
    const input = createContext({
      onSynthetic: () => {
        sent = true;
      },
    });
    const { task_report } = createTaskReportTool({
      input,
      isDisposed: () => true,
    });

    await expect(
      task_report.execute(reportArgs, { sessionID: 'child' } as never),
    ).rejects.toThrow('Plugin is disposing');
    expect(sent).toBe(false);
  });

  test('does not accept a caller-selected parent ID', () => {
    const input = createContext({});
    const { task_report } = createTaskReportTool({ input });
    expect(Object.keys(task_report.args).sort()).toEqual(['kind', 'message']);
  });
});
