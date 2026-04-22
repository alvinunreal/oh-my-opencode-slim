/**
 * Collapse a system message array into a single element by joining all
 * entries with double-newline separators. Mutates the array in-place so
 * that callers holding a reference to the original array see the change.
 */
export function collapseSystemInPlace(system: string[]): void {
  const joined = system.join('\n\n');
  system.length = 0;
  if (joined) {
    system.push(joined);
  }
}
