/**
 * Process-local lazy singleton on `globalThis`, keyed through the global
 * symbol registry (`Symbol.for`) so independently created hook instances
 * in the same JS process share one store per key.
 */
export function getGlobalStore<T>(key: string, init: () => T): T {
  const storeKey = Symbol.for(key);
  const globalWithStore = globalThis as typeof globalThis & {
    [storeKey]?: T;
  };
  globalWithStore[storeKey] ??= init();
  return globalWithStore[storeKey];
}
