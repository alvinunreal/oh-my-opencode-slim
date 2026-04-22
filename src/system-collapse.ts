/**
 * Collapse a system message array into a single element by joining all
 * entries with double-newline separators. Mutates the array in-place so
 * that callers holding a reference to the original array see the change.
 *
 * This is necessary because OpenCode core passes the system array as a
 * local const to the hook. Reassigning output.system creates a new array
 * that the core never reads from (JS reference semantics).
 */
export function collapseSystemInPlace(system: string[]): void {
  const joined = system.join('\n\n');
  system.length = 0;
  if (joined) {
    system.push(joined);
  }
}
