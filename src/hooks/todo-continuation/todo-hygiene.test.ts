import { describe, expect, test } from 'bun:test';
import {
  createTodoHygiene,
  TODO_FINAL_ACTIVE_REMINDER,
  TODO_HYGIENE_REMINDER,
} from './todo-hygiene';

function createState(
  overrides?: Partial<{
    hasOpenTodos: boolean;
    openCount: number;
    inProgressCount: number;
    pendingCount: number;
  }>,
) {
  return {
    hasOpenTodos: overrides?.hasOpenTodos ?? true,
    openCount: overrides?.openCount ?? 1,
    inProgressCount: overrides?.inProgressCount ?? 0,
    pendingCount: overrides?.pendingCount ?? 1,
  };
}

describe('todo hygiene', () => {
  test('new request clears pending state from the previous turn', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => createState(),
    });
    const stale = { system: ['base'] };
    const fresh = { system: ['base'] };

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, stale);

    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, fresh);

    expect(stale.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
    expect(fresh.system.join('\n')).toContain(TODO_HYGIENE_REMINDER);
  });

  test('does not arm before the current request calls todowrite', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => createState(),
    });
    const system = { system: ['base'] };

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);

    expect(system.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
  });

  test('arms after the first relevant tool following todowrite', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => createState(),
    });
    const system = { system: ['base'] };

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);

    expect(system.system.join('\n')).toContain(TODO_HYGIENE_REMINDER);
  });

  test('multiple tools in the same round still inject only one reminder', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => createState(),
    });
    const system = { system: ['base'] };

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'glob', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);

    expect(
      system.system.filter((item) => item.includes(TODO_HYGIENE_REMINDER)),
    ).toHaveLength(1);
  });

  test('injects again on a later round after new activity', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => createState(),
    });
    const first = { system: ['base'] };
    const second = { system: ['base'] };

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, first);

    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, second);

    expect(first.system.join('\n')).toContain(TODO_HYGIENE_REMINDER);
    expect(second.system.join('\n')).toContain(TODO_HYGIENE_REMINDER);
  });

  test('upgrades to final-active on a later round', async () => {
    let call = 0;
    const hook = createTodoHygiene({
      getTodoState: async () => {
        call++;
        if (call <= 4) {
          return createState();
        }
        return createState({
          openCount: 1,
          inProgressCount: 1,
          pendingCount: 0,
        });
      },
    });
    const first = { system: ['base'] };
    const second = { system: ['base'] };

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, first);

    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, second);

    expect(first.system.join('\n')).toContain(TODO_HYGIENE_REMINDER);
    expect(second.system.join('\n')).toContain(TODO_FINAL_ACTIVE_REMINDER);
  });

  test('todowrite can arm final-active immediately', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () =>
        createState({
          openCount: 1,
          inProgressCount: 1,
          pendingCount: 0,
        }),
    });
    const system = { system: ['base'] };

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);

    expect(system.system.join('\n')).toContain(TODO_FINAL_ACTIVE_REMINDER);
  });

  test('once final-active is armed, later tools skip extra todo lookups in the same round', async () => {
    let calls = 0;
    const hook = createTodoHygiene({
      getTodoState: async () => {
        calls++;
        return createState({
          openCount: 1,
          inProgressCount: 1,
          pendingCount: 0,
        });
      },
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });

    expect(calls).toBe(1);
  });

  test('shouldInject rejection consumes the pending reminder', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => createState(),
      shouldInject: () => false,
    });
    const first = { system: ['base'] };
    const second = { system: ['base'] };

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, first);
    await hook.handleChatSystemTransform({ sessionID: 's1' }, second);

    expect(first.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
    expect(second.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
  });

  test('final-active reminder wins when only one active todo remains', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () =>
        createState({
          openCount: 1,
          inProgressCount: 1,
          pendingCount: 0,
        }),
    });
    const system = { system: ['base'] };

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);

    expect(system.system.join('\n')).toContain(TODO_FINAL_ACTIVE_REMINDER);
  });

  test('transform lookup failures are best-effort and do not drop later reminders', async () => {
    let fail = false;
    const hook = createTodoHygiene({
      getTodoState: async () => {
        if (fail) {
          throw new Error('boom');
        }
        return createState();
      },
    });
    const failed = { system: ['base'] };
    const recovered = { system: ['base'] };

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    fail = true;
    await hook.handleChatSystemTransform({ sessionID: 's1' }, failed);

    fail = false;
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, recovered);

    expect(failed.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
    expect(recovered.system.join('\n')).toContain(TODO_HYGIENE_REMINDER);
  });

  test('a late tool failure does not clear a reminder already armed for the round', async () => {
    let call = 0;
    const hook = createTodoHygiene({
      getTodoState: async () => {
        call++;
        if (call === 3) {
          throw new Error('boom');
        }
        return createState();
      },
    });
    const system = { system: ['base'] };

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);

    expect(system.system.join('\n')).toContain(TODO_HYGIENE_REMINDER);
  });

  test('todowrite lookup failures do not disable the current request', async () => {
    let fail = false;
    const hook = createTodoHygiene({
      getTodoState: async () => {
        if (fail) {
          throw new Error('boom');
        }
        return createState();
      },
    });
    const system = { system: ['base'] };

    hook.handleRequestStart({ sessionID: 's1' });
    fail = true;
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    fail = false;
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);

    expect(system.system.join('\n')).toContain(TODO_HYGIENE_REMINDER);
  });

  test('non-injectable sessions are fully cleared after a rejected round', async () => {
    let calls = 0;
    const hook = createTodoHygiene({
      getTodoState: async () => {
        calls++;
        return createState();
      },
      shouldInject: () => false,
    });
    const system = { system: ['base'] };

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });

    expect(calls).toBe(1);
    expect(system.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
  });

  test('session.deleted clears all state', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => createState(),
    });
    const system = { system: ['base'] };

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    hook.handleEvent({
      type: 'session.deleted',
      properties: { info: { id: 's1' } },
    });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);

    expect(system.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
  });
});
