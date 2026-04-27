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

function createHook(options: Parameters<typeof createTodoHygiene>[0]) {
  return createTodoHygiene({ reminderDebounceMs: 0, ...options });
}

describe('todo hygiene', () => {
  test('new request clears pending state from the previous turn', async () => {
    const hook = createHook({
      getTodoState: async () => createState(),
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    hook.handleRequestStart({ sessionID: 's1' });
    const stale = await hook.consumePendingReminder('s1');

    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    const fresh = await hook.consumePendingReminder('s1');

    expect(stale).toBeNull();
    expect(fresh).toBe(TODO_HYGIENE_REMINDER);
  });

  test('does not arm before the current request calls todowrite', async () => {
    const hook = createHook({
      getTodoState: async () => createState(),
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });

    expect(await hook.consumePendingReminder('s1')).toBeNull();
  });

  test('arms after the first relevant tool following todowrite', async () => {
    const hook = createHook({
      getTodoState: async () => createState(),
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });

    expect(await hook.consumePendingReminder('s1')).toBe(
      TODO_HYGIENE_REMINDER,
    );
  });

  test('chat system transform is a cache-friendly no-op', async () => {
    const hook = createHook({
      getTodoState: async () => createState(),
    });
    const system = { system: ['base'] };

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleChatSystemTransform({ sessionID: 's1' }, system);

    expect(system.system.join('\n')).not.toContain(TODO_HYGIENE_REMINDER);
    expect(await hook.consumePendingReminder('s1')).toBe(
      TODO_HYGIENE_REMINDER,
    );
  });

  test('multiple tools in the same round still consume only one reminder', async () => {
    const hook = createHook({
      getTodoState: async () => createState(),
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'glob', sessionID: 's1' });

    expect(await hook.consumePendingReminder('s1')).toBe(
      TODO_HYGIENE_REMINDER,
    );
    expect(await hook.consumePendingReminder('s1')).toBeNull();
  });

  test('injects again on a later round after new activity', async () => {
    const hook = createHook({
      getTodoState: async () => createState(),
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    const first = await hook.consumePendingReminder('s1');

    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    const second = await hook.consumePendingReminder('s1');

    expect(first).toBe(TODO_HYGIENE_REMINDER);
    expect(second).toBe(TODO_HYGIENE_REMINDER);
  });

  test('upgrades to final-active on a later round', async () => {
    let call = 0;
    const hook = createHook({
      getTodoState: async () => {
        call++;
        if (call <= 3) {
          return createState();
        }
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
    const first = await hook.consumePendingReminder('s1');

    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    const second = await hook.consumePendingReminder('s1');

    expect(first).toBe(TODO_HYGIENE_REMINDER);
    expect(second).toBe(TODO_FINAL_ACTIVE_REMINDER);
  });

  test('todowrite can arm final-active immediately', async () => {
    const hook = createHook({
      getTodoState: async () =>
        createState({
          openCount: 1,
          inProgressCount: 1,
          pendingCount: 0,
        }),
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });

    expect(await hook.consumePendingReminder('s1')).toBe(
      TODO_FINAL_ACTIVE_REMINDER,
    );
  });

  test('once final-active is armed, later tools skip extra todo lookups in the same round', async () => {
    let calls = 0;
    const hook = createHook({
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
    const hook = createHook({
      getTodoState: async () => createState(),
      shouldInject: () => false,
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });

    expect(await hook.consumePendingReminder('s1')).toBeNull();
    expect(await hook.consumePendingReminder('s1')).toBeNull();
  });

  test('final-active reminder wins when only one active todo remains', async () => {
    const hook = createHook({
      getTodoState: async () =>
        createState({
          openCount: 1,
          inProgressCount: 1,
          pendingCount: 0,
        }),
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });

    expect(await hook.consumePendingReminder('s1')).toBe(
      TODO_FINAL_ACTIVE_REMINDER,
    );
  });

  test('consuming a pending reminder does not inspect todos', async () => {
    let fail = false;
    const hook = createHook({
      getTodoState: async () => {
        if (fail) {
          throw new Error('boom');
        }
        return createState();
      },
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    fail = true;
    const failed = await hook.consumePendingReminder('s1');

    fail = false;
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    const recovered = await hook.consumePendingReminder('s1');

    expect(failed).toBe(TODO_HYGIENE_REMINDER);
    expect(recovered).toBe(TODO_HYGIENE_REMINDER);
  });

  test('a late tool failure does not clear a reminder already armed for the round', async () => {
    let call = 0;
    const hook = createHook({
      getTodoState: async () => {
        call++;
        if (call === 3) {
          throw new Error('boom');
        }
        return createState();
      },
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });

    expect(await hook.consumePendingReminder('s1')).toBe(
      TODO_HYGIENE_REMINDER,
    );
  });

  test('todowrite lookup failures do not disable the current request', async () => {
    let fail = false;
    const hook = createHook({
      getTodoState: async () => {
        if (fail) {
          throw new Error('boom');
        }
        return createState();
      },
    });

    hook.handleRequestStart({ sessionID: 's1' });
    fail = true;
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    fail = false;
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });

    expect(await hook.consumePendingReminder('s1')).toBe(
      TODO_HYGIENE_REMINDER,
    );
  });

  test('non-injectable sessions are ignored before todo lookups', async () => {
    let calls = 0;
    const hook = createHook({
      getTodoState: async () => {
        calls++;
        return createState();
      },
      shouldInject: () => false,
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.consumePendingReminder('s1');
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });

    expect(calls).toBe(0);
  });

  test('non-injectable todowrite sessions skip reset lookup and do not arm state', async () => {
    let calls = 0;
    const hook = createHook({
      getTodoState: async () => {
        calls++;
        return createState({
          openCount: 1,
          inProgressCount: 1,
          pendingCount: 0,
        });
      },
      shouldInject: () => false,
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });

    expect(calls).toBe(0);
    expect(await hook.consumePendingReminder('s1')).toBeNull();
  });

  test('session.deleted clears all state', async () => {
    const hook = createHook({
      getTodoState: async () => createState(),
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    hook.handleEvent({
      type: 'session.deleted',
      properties: { info: { id: 's1' } },
    });

    expect(await hook.consumePendingReminder('s1')).toBeNull();
  });

  test('default debounce avoids repeated todo lookups while a reminder is pending', async () => {
    let calls = 0;
    const hook = createTodoHygiene({
      getTodoState: async () => {
        calls++;
        return createState();
      },
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'glob', sessionID: 's1' });

    expect(calls).toBe(2);
    expect(await hook.consumePendingReminder('s1')).toBe(
      TODO_HYGIENE_REMINDER,
    );
  });

  test('reminderDebounceMs=0 permits immediate reinspection while pending', async () => {
    let calls = 0;
    const hook = createHook({
      getTodoState: async () => {
        calls++;
        return createState();
      },
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });

    expect(calls).toBe(3);
  });
});
