/**
 * Shared promise timeout utility.
 * Races a promise against a timeout — rejects if the timeout fires first.
 */

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('sdk call timeout')), ms).unref(),
    ),
  ]);
}
