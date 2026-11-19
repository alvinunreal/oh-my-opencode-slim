import { describe, expect, test } from 'bun:test';
import {
  type FeatureGateConfig,
  resolveFeatureGates,
  UnsupportedHostConfigError,
  validateExplicitHostConfig,
} from './feature-gates';
import type { PluginConfig } from './schema';

test('explicit positive managed limits are refused with their full paths', () => {
  const cases = [
    [
      { concurrency: { providerConcurrency: { openai: 2 } } },
      'concurrency.providerConcurrency.openai',
      2,
    ],
    [
      { concurrency: { modelConcurrency: { 'openai/model': 3 } } },
      'concurrency.modelConcurrency.openai/model',
      3,
    ],
    [
      { concurrency: { defaultConcurrency: 4 } },
      'concurrency.defaultConcurrency',
      4,
    ],
    [{ wallClockTimeoutMs: 900000 }, 'wallClockTimeoutMs', 900000],
  ] as const;
  for (const [backgroundJobs, key, value] of cases) {
    const validate = () =>
      validateExplicitHostConfig({ backgroundJobs }, 'v2', '/config/slim.json');
    expect(validate).toThrow(UnsupportedHostConfigError);
    expect(validate).toThrow('/config/slim.json');
    expect(validate).toThrow(`backgroundJobs.${key}`);
    expect(validate).toThrow(String(value));
    expect(validate).toThrow('then run /reload');
  }
});

test('reports every positive managed limit in one error', () => {
  const validate = () =>
    validateExplicitHostConfig(
      {
        backgroundJobs: {
          wallClockTimeoutMs: 900000,
          concurrency: {
            defaultConcurrency: 4,
            providerConcurrency: { openai: 2 },
            modelConcurrency: { 'openai/model': 3 },
          },
        },
      },
      'v2',
      '/config/slim.json',
    );

  expect(validate).toThrow('/config/slim.json');
  expect(validate).toThrow('backgroundJobs.wallClockTimeoutMs = 900000');
  expect(validate).toThrow('backgroundJobs.concurrency.defaultConcurrency = 4');
  expect(validate).toThrow(
    'backgroundJobs.concurrency.providerConcurrency.openai = 2',
  );
  expect(validate).toThrow(
    'backgroundJobs.concurrency.modelConcurrency.openai/model = 3',
  );
});

describe('resolveFeatureGates', () => {
  test('defaults background jobs to native on v2', () => {
    const gates = resolveFeatureGates({});

    expect(gates).toEqual({
      backgroundJobsMode: 'native',
      presetRouting: true,
      replaceBuiltinSubagents: true,
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
      resolveFeatureGates({ backgroundJobs: { mode: 'managed' } }),
    ).toThrow(UnsupportedHostConfigError);
    expect(() =>
      resolveFeatureGates({ backgroundJobs: { mode: 'managed' } }),
    ).toThrow(/Unsupported backgroundJobs\.mode "managed" on OpenCode v2/);
  });

  test('accepts explicit native and off modes on v2', () => {
    const native = resolveFeatureGates({ backgroundJobs: { mode: 'native' } });
    expect(native.backgroundJobsMode).toBe('native');
    expect(native.presetRouting).toBe(true);

    const off = resolveFeatureGates({ backgroundJobs: { mode: 'off' } });
    expect(off.backgroundJobsMode).toBe('off');
    expect(off.presetRouting).toBe(false);
  });

  test('session preset routing is independent of native task controls', () => {
    expect(
      resolveFeatureGates({
        backgroundJobs: { mode: 'off' },
        sessionPresetRouting: true,
      }),
    ).toMatchObject({ backgroundJobsMode: 'off', presetRouting: true });
    expect(
      resolveFeatureGates({
        backgroundJobs: { mode: 'native' },
        sessionPresetRouting: false,
      }),
    ).toMatchObject({ backgroundJobsMode: 'native', presetRouting: false });
    expect(
      resolveFeatureGates({ replaceBuiltinSubagents: false })
        .replaceBuiltinSubagents,
    ).toBe(false);
  });

  test('rejects invalid explicit modes before sanitization or runtime seeding', () => {
    for (const mode of ['of', null, false, 42, {}]) {
      const config = { backgroundJobs: { mode } };
      expect(() =>
        validateExplicitHostConfig(config, 'v2', '/config/slim.json'),
      ).toThrow('Invalid backgroundJobs.mode');
      expect(() => resolveFeatureGates(config as FeatureGateConfig)).toThrow(
        'Invalid backgroundJobs.mode',
      );
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

  test('disables the update checker only on autoUpdate: false', () => {
    expect(resolveFeatureGates({ autoUpdate: false }).updateChecker).toBe(
      false,
    );
    expect(resolveFeatureGates({ autoUpdate: true }).updateChecker).toBe(true);
    // The retired disabled_hooks alias has no effect on the gate.
    expect(
      resolveFeatureGates({
        autoUpdate: true,
        disabled_hooks: ['auto-update-checker'],
      } as FeatureGateConfig).updateChecker,
    ).toBe(true);

    // Unrelated hooks and an explicit autoUpdate: true keep checking on.
    expect(
      resolveFeatureGates({
        autoUpdate: true,
        disabled_hooks: ['cache-monitor'],
      } as FeatureGateConfig).updateChecker,
    ).toBe(true);
  });

  test('keeps webfetch enabled by default', () => {
    expect(resolveFeatureGates().webfetch).toBe(true);
    expect(resolveFeatureGates({ disabled_tools: [] }).webfetch).toBe(true);
    expect(
      resolveFeatureGates({ disabled_tools: ['ast_grep_search'] }).webfetch,
    ).toBe(true);
  });

  test('disables webfetch only when disabled_tools lists it', () => {
    expect(resolveFeatureGates({ disabled_tools: ['webfetch'] }).webfetch).toBe(
      false,
    );
    // The retired root webfetch block is not a gate input.
    expect(
      resolveFeatureGates({
        webfetch: { enabled: false },
      } as unknown as FeatureGateConfig).webfetch,
    ).toBe(true);
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
      } as FeatureGateConfig);
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
      autoUpdate: false,
      backgroundJobs: { mode: 'native' },
      disabled_hooks: ['cache-monitor'],
    };

    const gates = resolveFeatureGates(config);
    expect(gates).toEqual({
      backgroundJobsMode: 'native',
      presetRouting: true,
      replaceBuiltinSubagents: true,
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
