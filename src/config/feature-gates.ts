/**
 * Pure feature-gate projection over the plugin config.
 *
 * Every optional subsystem reads one frozen object, so the enable/disable
 * decisions live in one place and cannot drift between the v1 factory, the v2
 * setup pre-flight, the TUI gates, and the runtime getters. No IO or registry;
 * the v2 host owns the native background lifecycle.
 *
 * Fallback is deliberately not projected here: `fallback.enabled` and the
 * `foreground-fallback` hook differ on v2 (the former keeps retry bookkeeping
 * alive for a live per-session enable; the latter removes the hook entirely).
 */
import type { BackgroundJobsMode } from './schema';

/** Structural slice of the plugin config the gates depend on. */
export interface FeatureGateConfig {
  readonly backgroundJobs?: {
    readonly mode?: BackgroundJobsMode;
  };
  readonly sessionPresetRouting?: boolean;
  readonly replaceBuiltinSubagents?: boolean;
  readonly tui?: boolean;
  readonly sidebar?: boolean;
  readonly interview?: {
    readonly enabled?: boolean;
  };
  readonly marketplace?: {
    readonly enabled?: boolean;
  };
  readonly liveConfigRefresh?: boolean;
  readonly autoUpdate?: boolean;
  readonly disabled_tools?: readonly string[];
}

/** Unsupported host settings must escape the loader's non-fatal read path. */
export class UnsupportedHostConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedHostConfigError';
  }
}

const UNSUPPORTED_MANAGED_MODE_MESSAGE =
  'Unsupported backgroundJobs.mode "managed" on OpenCode v2; use "native" or "off".';

/**
 * Validate explicit config before sanitization or schema defaults are applied.
 * Reject retired fallback keys, invalid lifecycle switches and unenforced limits.
 * The retired managed mode is normalized by the loader after this validation.
 */
export function validateExplicitHostConfig(
  config: unknown,
  hostFlavor?: string,
  sourcePath?: string,
): void {
  if (hostFlavor !== 'v2' || !config || typeof config !== 'object') return;
  const source = sourcePath ? `${sourcePath}: ` : '';
  const raw = config as Record<string, unknown>;
  const fallback = raw.fallback;
  if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
    const removed = ['continuationPolicy', 'initialRetryDelayMs'].filter(
      (key) => Object.hasOwn(fallback, key),
    );
    if (removed.length > 0) {
      throw new UnsupportedHostConfigError(
        `${source}Removed ${removed.map((key) => `fallback.${key}`).join(', ')} on OpenCode v2. Remove the retired ${removed.length === 1 ? 'key' : 'keys'}, then run /reload.`,
      );
    }
  }
  const backgroundJobs = raw.backgroundJobs;
  if (
    !backgroundJobs ||
    typeof backgroundJobs !== 'object' ||
    Array.isArray(backgroundJobs)
  ) {
    return;
  }
  const jobs = backgroundJobs as Record<string, unknown>;
  if (
    Object.hasOwn(jobs, 'mode') &&
    jobs.mode !== undefined &&
    jobs.mode !== 'native' &&
    jobs.mode !== 'off' &&
    jobs.mode !== 'managed'
  ) {
    throw new UnsupportedHostConfigError(
      `${source}Invalid backgroundJobs.mode ${JSON.stringify(jobs.mode)}; use "native" or "off", then run /reload.`,
    );
  }
  const unsupported: string[] = [];
  const collectLimit = (key: string, value: unknown) => {
    if (typeof value === 'number' && value > 0) {
      unsupported.push(`backgroundJobs.${key} = ${value}`);
    }
  };
  collectLimit('wallClockTimeoutMs', jobs.wallClockTimeoutMs);
  const concurrency = jobs.concurrency;
  if (
    concurrency &&
    typeof concurrency === 'object' &&
    !Array.isArray(concurrency)
  ) {
    const limits = concurrency as Record<string, unknown>;
    collectLimit('concurrency.defaultConcurrency', limits.defaultConcurrency);
    for (const key of ['providerConcurrency', 'modelConcurrency']) {
      const entries = limits[key];
      if (!entries || typeof entries !== 'object' || Array.isArray(entries))
        continue;
      for (const [id, value] of Object.entries(entries)) {
        collectLimit(`concurrency.${key}.${id}`, value);
      }
    }
  }
  if (unsupported.length > 0) {
    const remedy =
      unsupported.length === 1
        ? 'this limit. Remove the key or set it'
        : 'these limits. Remove the keys or set them';
    throw new UnsupportedHostConfigError(
      `${source}Unsupported ${unsupported.join(', ')} on OpenCode v2: Slim no longer enforces ${remedy} to 0, then run /reload.`,
    );
  }
}

/** Resolved enable/disable decisions for the optional subsystems. */
export interface FeatureGates {
  readonly backgroundJobsMode: BackgroundJobsMode;
  readonly presetRouting: boolean;
  readonly replaceBuiltinSubagents: boolean;
  readonly tui: boolean;
  readonly sidebar: boolean;
  readonly interview: boolean;
  readonly marketplace: boolean;
  readonly webfetch: boolean;
  readonly liveConfigRefresh: boolean;
  readonly updateChecker: boolean;
}

/**
 * Resolve the optional-subsystem gates from a resolved or partial plugin
 * config. Absent keys keep their documented defaults; the returned object is
 * frozen so callers share one immutable projection.
 */
export function resolveFeatureGates(
  config: FeatureGateConfig = {},
): Readonly<FeatureGates> {
  if (config.backgroundJobs?.mode === 'managed') {
    throw new UnsupportedHostConfigError(UNSUPPORTED_MANAGED_MODE_MESSAGE);
  }
  validateExplicitHostConfig(config, 'v2');
  const backgroundJobsMode = config.backgroundJobs?.mode ?? 'native';
  const tui = config.tui !== false;
  // User-edited config can be malformed despite the declared type; treat a
  // non-array disabled list as empty instead of failing plugin init.
  const disabledTools = Array.isArray(config.disabled_tools)
    ? config.disabled_tools
    : [];
  return Object.freeze({
    backgroundJobsMode,
    presetRouting:
      config.sessionPresetRouting ?? backgroundJobsMode === 'native',
    replaceBuiltinSubagents: config.replaceBuiltinSubagents !== false,
    tui,
    sidebar: tui && config.sidebar !== false,
    interview: config.interview?.enabled !== false,
    marketplace: config.marketplace?.enabled !== false,
    webfetch: !disabledTools.includes('webfetch'),
    liveConfigRefresh: config.liveConfigRefresh !== false,
    updateChecker: config.autoUpdate !== false,
  });
}
