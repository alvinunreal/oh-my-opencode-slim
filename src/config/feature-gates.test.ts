import { describe, expect, test } from 'bun:test';
import {
  resolveFeatureGates,
  UnsupportedHostConfigError,
} from './feature-gates';
import type { PluginConfig } from './schema';

describe('resolveFeatureGates', () => {
  test('defaults every optional subsystem on with managed background jobs on v1 / undefined host', () => {
    for (const host of [undefined, 'v1']) {
      const gates = resolveFeatureGates({}, host);

      expect(gates).toEqual({
        backgroundJobsMode: 'managed',
        managedJobs: true,
        presetRouting: true,
        tui: true,
        sidebar: true,
        interview: true,
        marketplace: true,
        webfetch: true,
        liveConfigRefresh: true,
        updateChecker: true,
      });
      expect(Object.isFrozen(gates)).toBe(true);
    }
  });

  test('defaults background jobs to native on v2 with managedJobs false', () => {
    const gates = resolveFeatureGates({}, 'v2');

    expect(gates).toEqual({
      backgroundJobsMode: 'native',
      managedJobs: false,
      presetRouting: true,
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

  test('throws UnsupportedHostConfigError when mode is explicitly managed on v2', () => {
    expect(() =>
      resolveFeatureGates({ backgroundJobs: { mode: 'managed' } }, 'v2'),
    ).toThrow(UnsupportedHostConfigError);
    expect(() =>
      resolveFeatureGates({ backgroundJobs: { mode: 'managed' } }, 'v2'),
    ).toThrow(/Unsupported backgroundJobs\.mode "managed" on OpenCode v2/);

    // v1 and undefined host still accept managed normally
    expect(
      resolveFeatureGates({ backgroundJobs: { mode: 'managed' } }, 'v1')
        .managedJobs,
    ).toBe(true);
    expect(
      resolveFeatureGates({ backgroundJobs: { mode: 'managed' } }).managedJobs,
    ).toBe(true);
  });

  test('accepts explicit native and off modes across v1 and v2', () => {
    for (const host of [undefined, 'v1', 'v2']) {
      const native = resolveFeatureGates(
        { backgroundJobs: { mode: 'native' } },
        host,
      );
      expect(native.backgroundJobsMode).toBe('native');
      expect(native.managedJobs).toBe(false);
      expect(native.presetRouting).toBe(true);

      const off = resolveFeatureGates(
        { backgroundJobs: { mode: 'off' } },
        host,
      );
      expect(off.backgroundJobsMode).toBe('off');
      expect(off.managedJobs).toBe(false);
      expect(off.presetRouting).toBe(false);
    }
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

  test('disables the update checker via autoUpdate or the disabled hook', () => {
    expect(resolveFeatureGates({ autoUpdate: false }).updateChecker).toBe(
      false,
    );
    expect(
      resolveFeatureGates({ disabled_hooks: ['auto-update-checker'] })
        .updateChecker,
    ).toBe(false);
    expect(
      resolveFeatureGates({
        autoUpdate: false,
        disabled_hooks: ['auto-update-checker'],
      }).updateChecker,
    ).toBe(false);

    // Unrelated hooks and an explicit autoUpdate: true keep checking on.
    expect(
      resolveFeatureGates({
        autoUpdate: true,
        disabled_hooks: ['cache-monitor'],
      }).updateChecker,
    ).toBe(true);
  });

  test('keeps webfetch enabled by default', () => {
    expect(resolveFeatureGates().webfetch).toBe(true);
    expect(resolveFeatureGates({ webfetch: {} }).webfetch).toBe(true);
    expect(resolveFeatureGates({ webfetch: { enabled: true } }).webfetch).toBe(
      true,
    );
  });

  test('disables webfetch on the config switch', () => {
    expect(resolveFeatureGates({ webfetch: { enabled: false } }).webfetch).toBe(
      false,
    );
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
      webfetch: { enabled: false },
      liveConfigRefresh: false,
      autoUpdate: false,
      backgroundJobs: { mode: 'native' },
      disabled_hooks: ['auto-update-checker'],
    };

    const gates = resolveFeatureGates(config);
    expect(gates).toEqual({
      backgroundJobsMode: 'native',
      managedJobs: false,
      presetRouting: true,
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
