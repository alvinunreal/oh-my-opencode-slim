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
    app: { name: 'opencode2', version: 'test' },
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
  test('sends an attributed update to only the host-owned parent', async () => {
    let admission: Record<string, unknown> | undefined;
    const input = createContext({
      onSynthetic: (value) => {
        admission = value;
      },
    });
    const { task_report } = createTaskReportTool({ input });

    const result = await task_report.execute(reportArgs, {
      sessionID: 'child',
    } as never);

    expect(admission).toMatchObject({
      sessionID: 'parent',
      delivery: 'steer',
      resume: true,
      description: 'oh-my-opencode-slim internal initiator',
    });
    expect(admission?.text).toContain('kind="progress"');
    expect(admission?.text).toContain('From @fixer (session child)');
    expect(admission?.text).toContain(reportArgs.message);
    expect(result).toMatch(/Update [a-f0-9-]{36} queued for the parent/);
    expect(result).toContain('processing is not confirmed');
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

  test('queues without waking a parent that is waiting for user input', async () => {
    let admission: Record<string, unknown> | undefined;
    const input = createContext({
      onSynthetic: (value) => {
        admission = value;
      },
    });
    const { task_report } = createTaskReportTool({
      input,
      hasInputWait: (sessionID) => sessionID === 'parent',
    });

    const result = await task_report.execute(
      { ...reportArgs, kind: 'escalation' },
      { sessionID: 'child' } as never,
    );

    expect(admission).toMatchObject({
      sessionID: 'parent',
      delivery: 'steer',
      resume: false,
    });
    expect(result).toContain('without waking it');
  });

  test('queues without waking a parent whose last run was interrupted', async () => {
    let admission: Record<string, unknown> | undefined;
    const input = createContext({
      parent: { outcome: 'interrupted' },
      onSynthetic: (value) => {
        admission = value;
      },
    });
    const { task_report } = createTaskReportTool({ input });

    await task_report.execute({ ...reportArgs, kind: 'escalation' }, {
      sessionID: 'child',
    } as never);

    expect(admission).toMatchObject({ delivery: 'steer', resume: false });
  });

  test('does not accept a caller-selected parent ID', () => {
    const input = createContext({});
    const { task_report } = createTaskReportTool({ input });
    expect(Object.keys(task_report.args).sort()).toEqual(['kind', 'message']);
  });
});
