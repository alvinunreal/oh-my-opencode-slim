/**
 * Pure feature-gate projection over the plugin config.
 *
 * Every optional subsystem reads one frozen object, so the enable/disable
 * decisions live in one place and cannot drift between the v1 factory, the v2
 * setup pre-flight, the TUI gates, and the runtime getters. No IO, no registry,
 * no host flavor: the same config always resolves the same gates.
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
  readonly liveConfigRefresh?: boolean;
  readonly autoUpdate?: boolean;
  readonly disabled_hooks?: readonly string[];
}

/** Resolved enable/disable decisions for the optional subsystems. */
export interface FeatureGates {
  readonly backgroundJobsMode: BackgroundJobsMode;
  readonly managedJobs: boolean;
  readonly tui: boolean;
  readonly sidebar: boolean;
  readonly interview: boolean;
  readonly marketplace: boolean;
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
  const backgroundJobsMode = config.backgroundJobs?.mode ?? 'managed';
  const tui = config.tui !== false;
  return Object.freeze({
    backgroundJobsMode,
    managedJobs: backgroundJobsMode === 'managed',
    tui,
    sidebar: tui && config.sidebar !== false,
    interview: config.interview?.enabled !== false,
    marketplace: config.marketplace?.enabled !== false,
    liveConfigRefresh: config.liveConfigRefresh !== false,
    updateChecker:
      config.autoUpdate !== false &&
      !(config.disabled_hooks ?? []).includes('auto-update-checker'),
  });
}
