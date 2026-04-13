import { describe, expect, test } from 'bun:test';
import {
  TODO_FINAL_ACTIVE_REMINDER,
  TODO_HYGIENE_REMINDER,
  createTodoHygiene,
} from './todo-hygiene';

describe('todo hygiene', () => {
  test('injects once after a normal tool when todos stay open', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => ({
        hasOpenTodos: true,
        openCount: 1,
        inProgressCount: 0,
        pendingCount: 1,
      }),
    });
    const first = { system: ['base'] };
    const second = { system: ['base'] };

    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, first);
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, second);

    expect(first.system.join('\n')).toContain(TODO_HYGIENE_REMINDER);
    expect(second.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
  });

  test('multiple tools are deduplicated while reminder is pending', async () => {
    let count = 0;
    const hook = createTodoHygiene({
      getTodoState: async () => {
        count++;
        return {
          hasOpenTodos: true,
          openCount: 1,
          inProgressCount: 0,
          pendingCount: 1,
        };
      },
    });

    await hook.handleToolExecuteAfter({ tool: 'task', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'background_output', sessionID: 's1' });

    expect(count).toBe(1);
  });

  test('does not re-arm until todowrite resets the cycle', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => ({
        hasOpenTodos: true,
        openCount: 1,
        inProgressCount: 0,
        pendingCount: 1,
      }),
    });
    const first = { system: ['base'] };
    const second = { system: ['base'] };

    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, first);
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, second);

    expect(first.system.join('\n')).toContain(TODO_HYGIENE_REMINDER);
    expect(second.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
  });

  test('consumes pending reminder when shouldInject rejects the session', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => ({
        hasOpenTodos: true,
        openCount: 1,
        inProgressCount: 0,
        pendingCount: 1,
      }),
      shouldInject: () => false,
    });
    const first = { system: ['base'] };
    const second = { system: ['base'] };

    await hook.handleToolExecuteAfter({ tool: 'task', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, first);
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, second);

    expect(first.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
    expect(second.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
  });

  test('todowrite clears a pending reminder', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => ({
        hasOpenTodos: true,
        openCount: 1,
        inProgressCount: 0,
        pendingCount: 1,
      }),
    });
    const system = { system: ['base'] };

    await hook.handleToolExecuteAfter({ tool: 'task', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);

    expect(system.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
  });

  test('todowrite re-enables the cycle when todos remain open', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => ({
        hasOpenTodos: true,
        openCount: 1,
        inProgressCount: 0,
        pendingCount: 1,
      }),
    });
    const first = { system: ['base'] };
    const second = { system: ['base'] };

    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, first);
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, second);

    expect(first.system.join('\n')).toContain(TODO_HYGIENE_REMINDER);
    expect(second.system.join('\n')).toContain(TODO_HYGIENE_REMINDER);
  });

  test('cleans pending reminder on session.deleted', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => ({
        hasOpenTodos: true,
        openCount: 1,
        inProgressCount: 0,
        pendingCount: 1,
      }),
    });
    const system = { system: ['base'] };

    await hook.handleToolExecuteAfter({ tool: 'task', sessionID: 's1' });
    hook.handleEvent({
      type: 'session.deleted',
      properties: { info: { id: 's1' } },
    });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);

    expect(system.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
  });

  test('handleChatSystemTransform failures are best-effort and do not reject', async () => {
    let calls = 0;
    const hook = createTodoHygiene({
      getTodoState: async () => {
        calls++;
        if (calls === 1) {
          return {
            hasOpenTodos: true,
            openCount: 1,
            inProgressCount: 0,
            pendingCount: 1,
          };
        }
        throw new Error('boom');
      },
    });
    const system = { system: ['base'] };

    await expect(
      hook.handleToolExecuteAfter({ tool: 'task', sessionID: 's1' }),
    ).resolves.toBeUndefined();
    await expect(
      hook.handleChatSystemTransform({ sessionID: 's1' }, system),
    ).resolves.toBeUndefined();

    expect(system.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
    expect(system.system.join('\n')).not.toContain(TODO_FINAL_ACTIVE_REMINDER);
  });

  test('todowrite state lookup failure clears stale pending state', async () => {
    let fail = false;
    const hook = createTodoHygiene({
      getTodoState: async () => {
        if (fail) {
          throw new Error('boom');
        }
        return {
          hasOpenTodos: true,
          openCount: 1,
          inProgressCount: 0,
          pendingCount: 1,
        };
      },
    });
    const system = { system: ['base'] };

    await hook.handleToolExecuteAfter({ tool: 'task', sessionID: 's1' });
    fail = true;
    await expect(
      hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' }),
    ).resolves.toBeUndefined();
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);

    expect(system.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
    expect(system.system.join('\n')).not.toContain(TODO_FINAL_ACTIVE_REMINDER);
  });

  test('uses the final-active reminder when only one in_progress remains', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => ({
        hasOpenTodos: true,
        openCount: 1,
        inProgressCount: 1,
        pendingCount: 0,
      }),
    });
    const system = { system: ['base'] };

    await hook.handleToolExecuteAfter({ tool: 'task', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);

    expect(system.system.join('\n')).toContain(TODO_FINAL_ACTIVE_REMINDER);
    expect(system.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
  });

  test('todowrite rearms the final-active reminder when only one in_progress remains', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => ({
        hasOpenTodos: true,
        openCount: 1,
        inProgressCount: 1,
        pendingCount: 0,
      }),
    });
    const system = { system: ['base'] };

    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);

    expect(system.system.join('\n')).toContain(TODO_FINAL_ACTIVE_REMINDER);
    expect(system.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
  });

  test('does not use final-active reminder when another open status exists', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => ({
        hasOpenTodos: true,
        openCount: 2,
        inProgressCount: 1,
        pendingCount: 0,
      }),
    });
    const system = { system: ['base'] };

    await hook.handleToolExecuteAfter({ tool: 'task', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);

    expect(system.system.join('\n')).toContain(TODO_HYGIENE_REMINDER);
    expect(system.system.join('\n')).not.toContain(TODO_FINAL_ACTIVE_REMINDER);
  });
});
