/**
 * Collapse a system message array into a single element by joining all
 * entries with double-newline separators. Mutates the array in-place so
 * that callers holding a reference to the original array see the change.
 */
export function collapseSystemInPlace(system: string[]): void {
  if (system.length === 0) {
    return;
  }

  if (system.length === 1) {
    if (system[0]) {
      return;
    }
    system.length = 0;
    return;
  }

  const joined = system.join('\n\n');
  system.length = 0;
  if (joined) {
    system.push(joined);
  }
}

/**
 * Heuristic for v1 hosts, where the system transform only receives the
 * sessionID: the session's tracked agent says "orchestrator" but auxiliary
 * LLM requests (title generation, compaction) run in the SAME session
 * under their own agent. Those requests are built with `system: []` and
 * never include the core's environment block, while every main chat
 * request does (the core prepends it to the request system). Structured
 * signal, not message text. Degradation if upstream renames both
 * markers: main-chat requests stop matching and the fallback stops
 * injecting there (missing serve-mode prompt) — auxiliaries were never
 * injected, so they cannot regress. A custom auxiliary prompt
 * CONTAINING these strings would false-positive; accepted as bounded
 * compatibility with this core.
 */
export function looksLikeMainChatRequest(system: string[]): boolean {
  return system.some(
    (entry) =>
      typeof entry === 'string' &&
      (entry.includes('<env>') || entry.includes('You are powered by')),
  );
}
