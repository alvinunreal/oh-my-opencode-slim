/**
 * Config keys removed in this version (dropped, not migrated, except that
 * `backgroundJobs.enabled: false` maps to `"off"` and `"managed"` to `"native"`).
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
const REMOVED_MANAGED_KEYS = [
  'backgroundJobs.maxSessionsPerAgent',
  'backgroundJobs.stopConfirmationMs',
  'backgroundJobs.wallClockTimeoutMs',
  'backgroundJobs.concurrency',
  'backgroundJobs.sameProviderPolicy',
  'backgroundJobs.waitForUserGuard',
  'backgroundJobs.childInputWake',
  'backgroundJobs.childInputWakeKinds',
  'backgroundJobs.pruneEvictedSessions',
] as const;

const REMOVED_CONFIG_KEYS = [
  'tmux',
  'agents.*.primary',
  'presets.*.*.primary',
  'presets.*.agents.*.primary',
  'council.master',
  'council.master_timeout',
  'council.master_fallback',
  'council.presets.*.master',
  'council.presets.*.councillors',
  'backgroundJobs.continueOnIdle',
  'backgroundJobs.orchestratorWake',
  'backgroundJobs.enabled',
  'backgroundJobs.maxContextLines',
  'backgroundJobs.readContextMinLines',
  'backgroundJobs.readContextMaxFiles',
  'backgroundJobs.strategy',
  'backgroundJobs.maxRetainedSnapshots',
  'backgroundJobs.boardInjection',
  'backgroundJobs.abortGraceMs',
  ...REMOVED_MANAGED_KEYS,
  'fallback.timeoutMs',
  'fallback.retry_on_empty',
  'fallback.runtimeOverride',
  'multiplexer.zellij_pane_mode',
  'webfetch',
] as const;

/** Removed keys whose successor needs a specific message. */
const REMOVED_CONFIG_KEY_MESSAGES: Readonly<Record<string, string>> = {
  'backgroundJobs.enabled':
    'Config key "backgroundJobs.enabled" was removed; use backgroundJobs.mode ("native" | "off") instead. enabled: false is still applied as mode "off".',
  webfetch:
    'webfetch config was removed; use disabled_tools: ["webfetch"] to use the native host tool',
  ...Object.fromEntries(
    REMOVED_MANAGED_KEYS.map((path) => [
      path,
      `Config key "${path}" belonged to the retired managed lifecycle and is ignored.`,
    ]),
  ),
};

function removedConfigKeyMessage(path: string): string {
  return (
    REMOVED_CONFIG_KEY_MESSAGES[path] ??
    `Config key "${path}" was removed in this version and is ignored; see docs/configuration.md`
  );
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
    // In a structured preset, the flat path can land on an agent named
    // "primary". Its object is an agent override, never a legacy flag.
    if (
      head === 'primary' &&
      trail.length === 3 &&
      trail[0] === 'presets' &&
      trail[2] === 'agents' &&
      isPlainObject(node[head])
    ) {
      return;
    }
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
  // The one removed key with a behavior to keep: a stale opt-out must not
  // silently re-enable the managed lifecycle (and its task_* tools).
  const jobs = rawConfig.backgroundJobs;
  if (
    isPlainObject(jobs) &&
    jobs.enabled === false &&
    jobs.mode === undefined
  ) {
    jobs.mode = 'off';
  }
  if (isPlainObject(jobs) && jobs.mode === 'managed') {
    jobs.mode = 'native';
    onRemoved(
      'Config value backgroundJobs.mode "managed" was removed; "native" is applied instead. Use "off" to disable Slim task tools and session presets.',
      'backgroundJobs.mode',
    );
  }
  const removed: string[] = [];
  for (const path of REMOVED_CONFIG_KEYS) {
    stripPath(rawConfig, path.split('.'), [], removed);
  }
  for (const path of removed) onRemoved(removedConfigKeyMessage(path), path);
}

/**
 * Enum-backed `disabled_*` values removed in this version, keyed by config
 * key then value. A stale member must not invalidate the whole config file:
 * the loader strips it from the raw value before schema validation (the
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
    'auto-update-checker':
      'The disabled_hooks entry "auto-update-checker" was removed and is ignored; use autoUpdate: false to disable update checks, notices, and installation.',
    'json-error-recovery':
      'json-error-recovery is no longer a hook: OpenCode 2.3 rejects tool calls with malformed JSON arguments itself and asks the model to reissue them — remove this entry.',
  },
};

/**
 * Strip every {@link REMOVED_DISABLED_VALUES} member from its raw
 * `disabled_*` value (mutates in place) and report each concrete value once.
 * Arrays and the supported single string are both inspected; a string with
 * no retired member stays untouched for the later array normalization. A
 * value left empty by the strip is deleted, so a lower config layer's list
 * still applies.
 */
export function stripRemovedDisabledValues(
  rawConfig: unknown,
  onRemoved: (message: string, value: string) => void,
): void {
  if (!isPlainObject(rawConfig)) return;
  for (const [key, messages] of Object.entries(REMOVED_DISABLED_VALUES)) {
    const value = rawConfig[key];
    if (!Array.isArray(value) && typeof value !== 'string') continue;
    // The supported string shape is normalized to an array later; inspect it
    // here as a one-entry list so a retired value gets the removal warning
    // instead of a generic unknown-value diagnostic.
    const list: unknown[] = typeof value === 'string' ? [value] : value;
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
    for (const name of removed) onRemoved(messages[name] as string, name);
    if (kept.length === 0) delete rawConfig[key];
    else rawConfig[key] = kept;
  }
}
