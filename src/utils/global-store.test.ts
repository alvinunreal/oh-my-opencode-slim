import { describe, expect, test } from 'bun:test';
import { getGlobalStore } from './global-store';

describe('getGlobalStore', () => {
  test('returns the same instance per key across calls', () => {
    const first = getGlobalStore('test.global-store.a', () => ({ n: 1 }));
    const second = getGlobalStore('test.global-store.a', () => ({ n: 2 }));
    expect(second).toBe(first);
    expect(second.n).toBe(1);
  });

  test('distinct keys get distinct stores', () => {
    const a = getGlobalStore('test.global-store.b', () => ({ tag: 'b' }));
    const c = getGlobalStore('test.global-store.c', () => ({ tag: 'c' }));
    expect(a).not.toBe(c);
    expect(c.tag).toBe('c');
  });

  test('init runs only when the store is absent', () => {
    let inits = 0;
    const init = () => {
      inits += 1;
      return { count: inits };
    };
    const first = getGlobalStore('test.global-store.lazy', init);
    const second = getGlobalStore('test.global-store.lazy', init);
    expect(inits).toBe(1);
    expect(second).toBe(first);
    expect(first.count).toBe(1);
  });

  test('adopts a store planted under the same Symbol.for key', () => {
    // Same global symbol registry: a value stored under Symbol.for(key)
    // must be adopted instead of re-initialized.
    const key = 'test.global-store.planted';
    const planted = { planted: true };
    (globalThis as Record<symbol, unknown>)[Symbol.for(key)] = planted;
    const got = getGlobalStore(key, () => ({ planted: false }));
    expect(got).toBe(planted);
  });

  test('preserves a falsy-but-present store value', () => {
    // `??=` assigns only on null/undefined, matching the inline pattern
    // both gates used before extraction.
    const key = 'test.global-store.empty-string';
    (globalThis as Record<symbol, unknown>)[Symbol.for(key)] = '';
    expect(getGlobalStore(key, () => 'init')).toBe('');
  });
});
