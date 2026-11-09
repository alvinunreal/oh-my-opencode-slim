/**
 * Pure feature-gate projection over the plugin config.
 *
 * Every optional subsystem reads one frozen object, so the enable/disable
 * decisions live in one place and cannot drift between the v1 factory, the v2
 * setup pre-flight, the TUI gates, and the runtime getters. No IO or registry;
 * the host flavor selects the lifecycle supported by the two adapters.
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
  readonly tui?: boolean;
  readonly sidebar?: boolean;
  readonly interview?: {
    readonly enabled?: boolean;
  };
  readonly marketplace?: {
    readonly enabled?: boolean;
  };
  readonly webfetch?: {
    readonly enabled?: boolean;
  };
  readonly liveConfigRefresh?: boolean;
  readonly autoUpdate?: boolean;
  readonly disabled_hooks?: readonly string[];
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
 * Resolved configs contain V1 defaults for these keys, so must not be checked
 * here. Lifecycle mode itself has no schema default and is also checked by
 * resolveFeatureGates for direct runtime seeds.
 */
export function validateExplicitHostConfig(
  config: unknown,
  hostFlavor?: string,
  sourcePath?: string,
): void {
  if (hostFlavor !== 'v2' || !config || typeof config !== 'object') return;
  const source = sourcePath ? `${sourcePath}: ` : '';
  const backgroundJobs = (config as Record<string, unknown>).backgroundJobs;
  if (
    !backgroundJobs ||
    typeof backgroundJobs !== 'object' ||
    Array.isArray(backgroundJobs)
  ) {
    return;
  }
  if ((backgroundJobs as Record<string, unknown>).mode === 'managed') {
    throw new UnsupportedHostConfigError(
      `${source}${UNSUPPORTED_MANAGED_MODE_MESSAGE}`,
    );
  }
  for (const key of [
    'concurrency',
    'wallClockTimeoutMs',
    'maxSessionsPerAgent',
    'stopConfirmationMs',
  ]) {
    if (Object.hasOwn(backgroundJobs, key)) {
      throw new UnsupportedHostConfigError(
        `${source}Unsupported backgroundJobs.${key} on OpenCode v2; this setting requires the V1 managed lifecycle. Remove it and use the native host lifecycle.`,
      );
    }
  }
}

/** Resolved enable/disable decisions for the optional subsystems. */
export interface FeatureGates {
  readonly backgroundJobsMode: BackgroundJobsMode;
  readonly managedJobs: boolean;
  readonly presetRouting: boolean;
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
  hostFlavor?: string,
): Readonly<FeatureGates> {
  if (hostFlavor === 'v2' && config.backgroundJobs?.mode === 'managed') {
    throw new UnsupportedHostConfigError(UNSUPPORTED_MANAGED_MODE_MESSAGE);
  }
  const backgroundJobsMode =
    config.backgroundJobs?.mode ?? (hostFlavor === 'v2' ? 'native' : 'managed');
  const tui = config.tui !== false;
  // User-edited config can be malformed despite the declared type; treat a
  // non-array disabled list as empty instead of failing plugin init.
  const disabledTools = Array.isArray(config.disabled_tools)
    ? config.disabled_tools
    : [];
  const disabledHooks = Array.isArray(config.disabled_hooks)
    ? config.disabled_hooks
    : [];
  return Object.freeze({
    backgroundJobsMode,
    managedJobs: hostFlavor !== 'v2' && backgroundJobsMode === 'managed',
    presetRouting: backgroundJobsMode !== 'off',
    tui,
    sidebar: tui && config.sidebar !== false,
    interview: config.interview?.enabled !== false,
    marketplace: config.marketplace?.enabled !== false,
    webfetch:
      config.webfetch?.enabled !== false && !disabledTools.includes('webfetch'),
    liveConfigRefresh: config.liveConfigRefresh !== false,
    updateChecker:
      config.autoUpdate !== false &&
      !disabledHooks.includes('auto-update-checker'),
  });
}
