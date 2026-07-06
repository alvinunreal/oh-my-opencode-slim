import { describe, expect, test } from 'bun:test';
import { HookRegistry } from './hook-registry';

describe('HookRegistry', () => {
  test('dispatch runs handlers in registration order', async () => {
    const r = new HookRegistry();
    const order: number[] = [];
    r.register('test', async () => {
      order.push(1);
    });
    r.register('test', async () => {
      order.push(2);
    });
    await r.dispatch('test', {}, {});
    expect(order).toEqual([1, 2]);
  });

  test('unregistered hook point is no-op', async () => {
    const r = new HookRegistry();
    await r.dispatch('none', {}, {});
  });

  test('handlers returns empty for unregistered point', () => {
    const r = new HookRegistry();
    expect(r.handlers('x')).toEqual([]);
  });

  test('dispatch passes input and output to handlers', async () => {
    const r = new HookRegistry();
    const captured: unknown[] = [];
    r.register('test', async (i, o) => {
      captured.push(i, o);
    });
    await r.dispatch('test', { a: 1 }, { b: 2 });
    expect(captured).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
