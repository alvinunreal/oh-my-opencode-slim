import { describe, expect, test } from 'bun:test';
import { resolveFeatureGates } from './feature-gates';
import type { PluginConfig } from './schema';

describe('resolveFeatureGates', () => {
  test('defaults every optional subsystem on with managed background jobs', () => {
    const gates = resolveFeatureGates();

    expect(gates).toEqual({
      backgroundJobsMode: 'managed',
      managedJobs: true,
      tui: true,
      sidebar: true,
      interview: true,
      marketplace: true,
      webfetch: true,
      liveConfigRefresh: true,
      updateChecker: true,
    });
    expect(Object.isFrozen(gates)).toBe(true);
  });

  test('resolves the background-jobs lifecycle mode and managed flag', () => {
    expect(resolveFeatureGates().backgroundJobsMode).toBe('managed');
    expect(resolveFeatureGates().managedJobs).toBe(true);

    const native = resolveFeatureGates({ backgroundJobs: { mode: 'native' } });
    expect(native.backgroundJobsMode).toBe('native');
    expect(native.managedJobs).toBe(false);

    const off = resolveFeatureGates({ backgroundJobs: { mode: 'off' } });
    expect(off.backgroundJobsMode).toBe('off');
    expect(off.managedJobs).toBe(false);
  });

  test('keeps the sidebar off whenever the TUI master switch is off', () => {
    expect(resolveFeatureGates({ tui: false }).tui).toBe(false);
    expect(resolveFeatureGates({ tui: false }).sidebar).toBe(false);
    // An explicit sidebar: true cannot re-enable the sidebar while the
    // surrounding TUI surface is off.
    expect(resolveFeatureGates({ tui: false, sidebar: true }).sidebar).toBe(
      false,
    );

    // The sidebar switch leaves the other TUI surfaces on.
    const sidebarOff = resolveFeatureGates({ sidebar: false });
    expect(sidebarOff.tui).toBe(true);
    expect(sidebarOff.sidebar).toBe(false);
  });

  test('reads the nested interview and marketplace enabled switches', () => {
    expect(resolveFeatureGates({ interview: {} }).interview).toBe(true);
    expect(
      resolveFeatureGates({ interview: { enabled: false } }).interview,
    ).toBe(false);
    expect(resolveFeatureGates({ marketplace: {} }).marketplace).toBe(true);
    expect(
      resolveFeatureGates({ marketplace: { enabled: false } }).marketplace,
    ).toBe(false);
  });

  test('disables live config refresh only on an explicit false', () => {
    expect(
      resolveFeatureGates({ liveConfigRefresh: true }).liveConfigRefresh,
    ).toBe(true);
    expect(
      resolveFeatureGates({ liveConfigRefresh: false }).liveConfigRefresh,
    ).toBe(false);
  });

  test('disables the update checker via the disabled hook', () => {
    expect(
      resolveFeatureGates({ disabled_hooks: ['auto-update-checker'] })
        .updateChecker,
    ).toBe(false);

    // Unrelated hooks keep checking on.
    expect(
      resolveFeatureGates({
        disabled_hooks: ['cache-monitor'],
      }).updateChecker,
    ).toBe(true);
  });

  test('keeps webfetch enabled by default', () => {
    expect(resolveFeatureGates().webfetch).toBe(true);
  });

  test('disables webfetch when disabled_tools lists it', () => {
    expect(resolveFeatureGates({ disabled_tools: ['webfetch'] }).webfetch).toBe(
      false,
    );
  });

  test('keeps webfetch enabled for unrelated disabled tools', () => {
    expect(
      resolveFeatureGates({
        disabled_tools: ['ast_grep_search', 'task_cancel'],
      }).webfetch,
    ).toBe(true);
  });

  test('ignores malformed disabled lists like the runtime getters', () => {
    for (const value of [{}, null, 42, 'webfetch']) {
      const gates = resolveFeatureGates({
        disabled_tools: value as unknown as readonly string[],
        disabled_hooks: value as unknown as readonly string[],
      });
      expect(gates.webfetch).toBe(true);
      expect(gates.updateChecker).toBe(true);
    }
  });

  test('accepts a resolved plugin config and freezes the projection', () => {
    const config: PluginConfig = {
      tui: false,
      sidebar: true,
      interview: { enabled: false },
      marketplace: { enabled: false },
      disabled_tools: ['webfetch'],
      liveConfigRefresh: false,
      backgroundJobs: { mode: 'native' },
      disabled_hooks: ['auto-update-checker'],
    };

    const gates = resolveFeatureGates(config);
    expect(gates).toEqual({
      backgroundJobsMode: 'native',
      managedJobs: false,
      tui: false,
      sidebar: false,
      interview: false,
      marketplace: false,
      webfetch: false,
      liveConfigRefresh: false,
      updateChecker: false,
    });
    expect(Object.isFrozen(gates)).toBe(true);
    expect(Reflect.set(gates as object, 'tui', true)).toBe(false);
    expect(gates.tui).toBe(false);
  });
});
