import { describe, expect, mock, test } from 'bun:test';
import { createTaskSessionManagerHook } from './index';

function createHook(options?: {
  shouldManageSession?: (sessionID: string) => boolean;
}) {
  const hook = createTaskSessionManagerHook(
    {
      client: { session: { status: mock(async () => ({ data: {} })) } },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 2,
      shouldManageSession: options?.shouldManageSession ?? (() => true),
    },
  );

  return { hook };
}

describe('task-session-manager hook', () => {
  test('stores task sessions and injects resumable-session prompt block', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
          prompt: 'inspect config schema',
        },
      },
    );

    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const system = { system: ['base'] };
    await hook['experimental.chat.system.transform'](
      { sessionID: 'parent-1' },
      system,
    );

    expect(system.system.join('\n')).toContain('### Resumable Sessions');
    expect(system.system.join('\n')).toContain('explorer: exp-1 config schema');
  });

  test('resolves remembered aliases to real task ids before execution', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
          prompt: 'inspect config schema',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const next = {
      args: {
        subagent_type: 'explorer',
        description: 'continue schema work',
        task_id: 'exp-1',
      },
    };
    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      next,
    );

    expect(next.args.task_id).toBe('child-1');
  });

  test('drops stale remembered sessions and falls back to fresh', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const next = {
      args: {
        subagent_type: 'explorer',
        description: 'continue schema work',
        task_id: 'exp-1',
      },
    };
    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      next,
    );

    expect(next.args.task_id).toBe('child-1');

    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      {
        output: '[ERROR] Session not found',
      },
    );

    const system = { system: ['base'] };
    await hook['experimental.chat.system.transform'](
      { sessionID: 'parent-1' },
      system,
    );
    expect(system.system.join('\n')).not.toContain('exp-1');
  });

  test('drops resumed predecessor when success returns a new task id', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'continue schema work',
          task_id: 'exp-1',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      {
        output:
          'task_id: child-2 (for resuming to continue this task if needed)',
      },
    );

    const system = { system: ['base'] };
    await hook['experimental.chat.system.transform'](
      { sessionID: 'parent-1' },
      system,
    );

    expect(system.system.join('\n')).toContain('continue schema work');
    expect(system.system.join('\n')).not.toContain('config schema');
  });

  test('does not drop remembered session on non-runtime session text', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'continue schema work',
          task_id: 'exp-1',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      {
        output: 'Found no session cookies in fixtures, continuing analysis.',
      },
    );

    const system = { system: ['base'] };
    await hook['experimental.chat.system.transform'](
      { sessionID: 'parent-1' },
      system,
    );

    expect(system.system.join('\n')).toContain('exp-1 config schema');
  });

  test('ignores sessions that are not orchestrator-managed', async () => {
    const { hook } = createHook({ shouldManageSession: () => false });

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'manual-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'manual-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const system = { system: ['base'] };
    await hook['experimental.chat.system.transform'](
      { sessionID: 'manual-1' },
      system,
    );

    expect(system.system).toEqual(['base']);
  });

  test('cleans up remembered sessions when parent or child is deleted', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'oracle',
          description: 'architecture review',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'child-1' },
      },
    });

    const afterChildDelete = { system: ['base'] };
    await hook['experimental.chat.system.transform'](
      { sessionID: 'parent-1' },
      afterChildDelete,
    );
    expect(afterChildDelete.system).toEqual(['base']);
  });

  test('cleans pending calls when parent session is deleted', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'oracle',
          description: 'architecture review',
        },
      },
    );

    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'parent-1' },
      },
    });

    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    const system = { system: ['base'] };
    await hook['experimental.chat.system.transform'](
      { sessionID: 'parent-1' },
      system,
    );

    expect(system.system).toEqual(['base']);
  });

  test('deduplicates pending call order when a resume call is recorded twice', async () => {
    const { hook } = createHook();

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'config schema',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-1',
      },
      {
        output:
          'task_id: child-1 (for resuming to continue this task if needed)',
      },
    );

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      {
        args: {
          subagent_type: 'explorer',
          description: 'continue schema work',
          task_id: 'exp-1',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-2',
      },
      {
        output: '[ERROR] Session not found',
      },
    );

    await hook['tool.execute.before'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-3',
      },
      {
        args: {
          subagent_type: 'oracle',
          description: 'architecture review',
        },
      },
    );
    await hook['tool.execute.after'](
      {
        tool: 'task',
        sessionID: 'parent-1',
        callID: 'call-3',
      },
      {
        output:
          'task_id: child-3 (for resuming to continue this task if needed)',
      },
    );

    const system = { system: ['base'] };
    await hook['experimental.chat.system.transform'](
      { sessionID: 'parent-1' },
      system,
    );

    expect(system.system.join('\n')).toContain(
      'oracle: ora-1 architecture review',
    );
  });
});
