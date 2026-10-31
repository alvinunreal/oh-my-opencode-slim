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
const REMOVED_CONFIG_KEYS = [
  'tmux',
  'council.master',
  'council.master_timeout',
  'council.master_fallback',
  'council.presets.*.master',
  'council.presets.*.councillors',
  'backgroundJobs.continueOnIdle',
  'backgroundJobs.maxContextLines',
  'backgroundJobs.readContextMinLines',
  'backgroundJobs.readContextMaxFiles',
  'backgroundJobs.strategy',
  'backgroundJobs.maxRetainedSnapshots',
  'backgroundJobs.boardInjection',
  'backgroundJobs.abortGraceMs',
  'fallback.timeoutMs',
  'fallback.retry_on_empty',
  'fallback.runtimeOverride',
  'multiplexer.zellij_pane_mode',
  'webfetch.model',
] as const;

function removedConfigKeyMessage(path: string): string {
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

/**
 * Enum-backed `disabled_*` values removed in this version, keyed by config
 * key then value. A stale member must not invalidate the whole config file:
 * the loader strips it from the raw array before schema validation (the
 * value enum no longer accepts it) and reports the removal message through
 * the same `removed-key` channel as removed keys — the generic
 * unknown-value normalization would otherwise label it a typo.
 */
const REMOVED_DISABLED_VALUES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  disabled_hooks: {
    'council-assembly':
      'council-assembly is no longer a hook: council seat assembly is unconditional and fail-open — remove this entry.',
  },
};

/**
 * Strip every {@link REMOVED_DISABLED_VALUES} member from its raw array
 * (mutates in place) and report each concrete value once. An array left
 * empty by the strip is deleted, so a lower config layer's list still
 * applies.
 */
export function stripRemovedDisabledValues(
  rawConfig: unknown,
  onRemoved: (message: string, value: string) => void,
): void {
  if (!isPlainObject(rawConfig)) return;
  for (const [key, messages] of Object.entries(REMOVED_DISABLED_VALUES)) {
    const list = rawConfig[key];
    if (!Array.isArray(list)) continue;
    const removed = new Set<string>();
    const kept: unknown[] = [];
    for (const entry of list) {
      if (typeof entry === 'string' && Object.hasOwn(messages, entry)) {
        removed.add(entry);
      } else {
        kept.push(entry);
      }
    }
    if (removed.size === 0) continue;
    for (const value of removed) onRemoved(messages[value] as string, value);
    if (kept.length === 0) delete rawConfig[key];
    else rawConfig[key] = kept;
  }
}
