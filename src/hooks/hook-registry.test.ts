import { describe, expect, test } from 'bun:test';
import { HookRegistry } from './hook-registry';

describe('HookRegistry', () => {
  test('registers and dispatches handlers in priority order', async () => {
    const registry = new HookRegistry();
    const calls: number[] = [];

    registry.register('test.hook', async (_, __) => { calls.push(1); }, 50);
    registry.register('test.hook', async (_, __) => { calls.push(2); }, 10);
    registry.register('test.hook', async (_, __) => { calls.push(3); }, 100);

    await registry.dispatch('test.hook', {}, {});

    expect(calls).toEqual([2, 1, 3]); // priority 10, 50, 100
  });

  test('errors in one handler do not stop others', async () => {
    const registry = new HookRegistry();
    const calls: string[] = [];

    registry.register('test.hook', async (_, __) => { calls.push('a'); throw new Error('fail'); }, 10);
    registry.register('test.hook', async (_, __) => { calls.push('b'); }, 20);
    registry.register('test.hook', async (_, __) => { calls.push('c'); }, 30);

    await registry.dispatch('test.hook', {}, {});

    expect(calls).toEqual(['a', 'b', 'c']);
  });

  test('getHandlers returns sorted handlers', () => {
    const registry = new HookRegistry();
    registry.register('test.hook', async (_, __) => {}, 50);
    registry.register('test.hook', async (_, __) => {}, 10);
    registry.register('test.hook', async (_, __) => {}, 100);

    const handlers = registry.getHandlers('test.hook');
    expect(handlers.map(h => h.priority)).toEqual([10, 50, 100]);
  });

  test('dispatch on unknown hook point does nothing', async () => {
    const registry = new HookRegistry();
    await expect(registry.dispatch('unknown', {}, {})).resolves.toBeUndefined();
  });
});
