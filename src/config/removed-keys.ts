/**
 * Config keys removed in this version (no migration, only dropped).
 *
 * A stale removed key must not invalidate the whole config file: the loader
 * strips each one from the raw layer before schema validation and reports a
 * "removed" warning, so every other user setting still loads. The schema
 * keeps rejecting these keys (`z.never`), which is what editors see through
 * the published JSON schema.
 *
 * Paths use `*` for one arbitrary record key (a council preset name).
 * Delete entries (or this whole module) once the compatibility window ends.
 */
export const REMOVED_CONFIG_KEYS = [
  'tmux',
  'council.master',
  'council.master_timeout',
  'council.master_fallback',
  'council.presets.*.master',
  'council.presets.*.councillors',
  'backgroundJobs.continueOnIdle',
  'fallback.timeoutMs',
  'fallback.retry_on_empty',
  'fallback.runtimeOverride',
  'multiplexer.zellij_pane_mode',
] as const;

export function removedConfigKeyMessage(path: string): string {
  return `Config key "${path}" was removed in this version and is ignored; see docs/configuration.md`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripPath(
  node: Record<string, unknown>,
  segments: string[],
  trail: string[],
  removed: string[],
): void {
  const [head, ...rest] = segments;
  if (head === undefined) return;
  if (rest.length === 0) {
    if (Object.hasOwn(node, head)) {
      delete node[head];
      removed.push([...trail, head].join('.'));
    }
    return;
  }
  const keys = head === '*' ? Object.keys(node) : [head];
  for (const key of keys) {
    const child = node[key];
    if (isPlainObject(child)) stripPath(child, rest, [...trail, key], removed);
  }
}

/**
 * Remove every {@link REMOVED_CONFIG_KEYS} entry from a raw parsed config
 * (mutates in place, like `normalizeDisabledArrayKeys`) and report each
 * concrete path that was dropped.
 */
export function stripRemovedConfigKeys(
  rawConfig: unknown,
  onRemoved: (message: string, path: string) => void,
): void {
  if (!isPlainObject(rawConfig)) return;
  const removed: string[] = [];
  for (const path of REMOVED_CONFIG_KEYS) {
    stripPath(rawConfig, path.split('.'), [], removed);
  }
  for (const path of removed) onRemoved(removedConfigKeyMessage(path), path);
}
