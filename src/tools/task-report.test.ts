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
  test('queues an attributed update to only the host-owned parent', async () => {
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
      delivery: 'queue',
      resume: false,
      description: 'oh-my-opencode-slim internal initiator',
    });
    expect(admission?.text).toContain('kind="progress"');
    expect(admission?.text).toContain('From @fixer (session child)');
    expect(admission?.text).toContain(reportArgs.message);
    expect(result).toMatch(/Update [a-f0-9-]{36} queued for the parent/);
    expect(result).toContain('without waking it');
    expect(result).toContain('processing is not confirmed');
    expect(result).not.toContain('processed');
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

    for (const [state, parent] of parentStates) {
      let admission: Record<string, unknown> | undefined;
      const input = createContext({
        parent,
        onSynthetic: (value) => {
          admission = value;
        },
      });
      const { task_report } = createTaskReportTool({ input });
      const result = await task_report.execute(
        { ...reportArgs, kind: 'escalation' },
        { sessionID: 'child' } as never,
      );

      expect(admission, state).toMatchObject({
        sessionID: 'parent',
        delivery: 'queue',
        resume: false,
      });
      expect(result, state).toContain('without waking it');
      expect(result, state).toContain('processing is not confirmed');
    }
  });

  test('disposal still prevents queue admission', async () => {
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
