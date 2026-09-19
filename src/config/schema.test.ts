import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  spyOn,
} from 'bun:test';
import { z } from 'zod';
import {
  InterviewConfigSchema,
  MultiplexerConfigSchema,
  MultiplexerConfigStrictSchema,
  PluginConfigSchema,
  PresetSchema,
  ProviderModelIdSchema,
  resetMultiplexerDiagnostics,
  sanitizeMultiplexerConfig,
} from './schema';

describe('ProviderModelIdSchema', () => {
  it('accepts and preserves model remainders with spaces and nested segments', () => {
    const ids = [
      'of/MiniMax M3',
      'of/Kimi K2.6',
      'opencode-omniroute-live/of/Qwen3.8 27b',
      'openai/gpt-5.6-luna',
    ];

    for (const id of ids) {
      const result = ProviderModelIdSchema.safeParse(id);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(id);
      }
    }
  });

  it('rejects missing provider/model parts and whitespace in the provider', () => {
    for (const id of [
      'model',
      '/model',
      'provider/',
      ' provider/model',
      'provider name/model',
    ]) {
      expect(ProviderModelIdSchema.safeParse(id).success).toBe(false);
    }
  });
});

describe('PluginConfigSchema ACP wrapper models', () => {
  it('accepts and preserves a wrapper model ID with spaces and nested segments', () => {
    const wrapperModel = 'opencode-omniroute-live/of/MiniMax M3';
    const result = PluginConfigSchema.safeParse({
      acpAgents: {
        helper: {
          command: 'acp-helper',
          wrapperModel,
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.acpAgents?.helper?.wrapperModel).toBe(wrapperModel);
    }
  });
});

describe('PluginConfigSchema preset syntax', () => {
  it('accepts legacy custom names that resemble metadata fields', () => {
    const result = PluginConfigSchema.safeParse({
      presets: {
        legacy: {
          extends: { model: 'provider/extends' },
          agents: { model: 'provider/agents' },
          model: { model: 'provider/model' },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an ambiguous agents wrapper with an actionable error', () => {
    const result = PluginConfigSchema.safeParse({
      presets: {
        ambiguous: { agents: { options: { model: 'provider/model' } } },
      },
    });

    expect(result.success).toBe(false);
  });

  it('emits oneOf for preset alternatives so public schema matches xor', () => {
    const generated = z.toJSONSchema(PresetSchema) as { oneOf?: unknown[] };

    expect(generated.oneOf).toHaveLength(3);
  });
});

describe('PluginConfigSchema image_routing', () => {
  it('accepts image_routing: direct with observer disabled', () => {
    const result = PluginConfigSchema.safeParse({
      disabled_agents: ['observer'],
      image_routing: 'direct',
    });
    expect(result.success).toBe(true);
  });

  it('accepts image_routing: auto with observer enabled', () => {
    const result = PluginConfigSchema.safeParse({
      disabled_agents: [],
      image_routing: 'auto',
    });
    expect(result.success).toBe(true);
  });

  it('accepts image_routing: auto with observer disabled until layers merge', () => {
    const result = PluginConfigSchema.safeParse({
      disabled_agents: ['observer'],
      image_routing: 'auto',
    });
    expect(result.success).toBe(true);
  });

  it('leaves image_routing undefined when omitted (default applied downstream)', () => {
    const result = PluginConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.image_routing).toBeUndefined();
    }
  });

  it('accepts image_routing: auto when disabled_agents is omitted', () => {
    const result = PluginConfigSchema.safeParse({ image_routing: 'auto' });
    expect(result.success).toBe(true);
  });
});

describe('PluginConfigSchema webfetch', () => {
  it('defaults the enhanced webfetch tool to enabled', () => {
    const result = PluginConfigSchema.safeParse({ webfetch: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.webfetch?.enabled).toBe(true);
    }
  });

  it('accepts dedicated model fallback entries with variants', () => {
    const result = PluginConfigSchema.safeParse({
      webfetch: {
        model: [
          'openai/gpt-4o-mini',
          { id: 'anthropic/claude-3-haiku', variant: 'low-latency' },
        ],
      },
    });

    expect(result.success).toBe(true);
  });
});

describe('MultiplexerConfigSchema', () => {
  let warnSpy: Mock<typeof console.warn>;

  beforeEach(() => {
    resetMultiplexerDiagnostics();
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    // Spies on console.warn can be shared across test files in one process;
    // clear call history so each test counts only its own warnings.
    warnSpy.mockClear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('applies the documented defaults when the block is empty', () => {
    expect(MultiplexerConfigSchema.parse({})).toEqual({
      type: 'none',
      layout: 'main-vertical',
      main_pane_size: 60,
    });
  });

  it('exports an unsanitized schema that keeps invalid values visible', () => {
    const strict = MultiplexerConfigStrictSchema.safeParse({ type: 'screen' });

    expect(strict.success).toBe(false);
    if (!strict.success) {
      expect(strict.error.issues.map((i) => i.path.join('.'))).toContain(
        'type',
      );
    }

    // Runtime behavior is unchanged: the sanitizing entry point still
    // accepts the value, disables panes, and warns once.
    const runtime = MultiplexerConfigSchema.safeParse({ type: 'screen' });
    expect(runtime.success).toBe(true);
    if (runtime.success) {
      expect(runtime.data.type).toBe('none');
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts every supported type and layout', () => {
    for (const type of [
      'auto',
      'tmux',
      'zellij',
      'herdr',
      'kitty',
      'cmux',
      'none',
    ] as const) {
      expect(MultiplexerConfigSchema.parse({ type }).type).toBe(type);
    }
    for (const layout of [
      'main-horizontal',
      'main-vertical',
      'tiled',
      'even-horizontal',
      'even-vertical',
    ] as const) {
      expect(MultiplexerConfigSchema.parse({ layout }).layout).toBe(layout);
    }
  });

  it('accepts the main_pane_size bounds', () => {
    for (const size of [20, 60, 80]) {
      expect(
        MultiplexerConfigSchema.parse({ main_pane_size: size }).main_pane_size,
      ).toBe(size);
    }
  });

  it('does not warn for a valid multiplexer config', () => {
    MultiplexerConfigSchema.parse({
      type: 'tmux',
      layout: 'tiled',
      main_pane_size: 40,
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('strips the removed zellij_pane_mode key with exactly one deprecation warning', () => {
    // Two parses stand in for the user + project config layers: the rest of
    // the config must load and the warning must fire only once per process.
    const first = PluginConfigSchema.safeParse({
      multiplexer: {
        type: 'tmux',
        layout: 'tiled',
        main_pane_size: 40,
        zellij_pane_mode: 'current-tab',
      },
      agents: { oracle: { model: 'valid/model' } },
    });
    const second = PluginConfigSchema.safeParse({
      multiplexer: { type: 'zellij', zellij_pane_mode: 'agent-tab' },
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success) {
      expect(first.data.multiplexer).toEqual({
        type: 'tmux',
        layout: 'tiled',
        main_pane_size: 40,
      });
      expect(first.data.agents?.oracle?.model).toBe('valid/model');
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('Deprecated');
    expect(message).toContain('zellij_pane_mode');
  });

  it('does not mutate the raw config while stripping the deprecated key', () => {
    const raw = { type: 'tmux', zellij_pane_mode: 'agent-tab' };
    const sanitized = sanitizeMultiplexerConfig(raw);

    expect(sanitized).not.toHaveProperty('zellij_pane_mode');
    expect(raw).toHaveProperty('zellij_pane_mode');
  });

  it('disables pane management for an invalid type and keeps the rest of the config', () => {
    const result = PluginConfigSchema.safeParse({
      multiplexer: { type: 'screen', main_pane_size: 40 },
      agents: { oracle: { model: 'valid/model' } },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.multiplexer?.type).toBe('none');
      expect(result.data.multiplexer?.main_pane_size).toBe(40);
      expect(result.data.agents?.oracle?.model).toBe('valid/model');
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('Invalid multiplexer config value');
    expect(message).toContain('type');
  });

  it('disables pane management for an invalid layout', () => {
    const result = PluginConfigSchema.safeParse({
      multiplexer: { type: 'tmux', layout: 'grid' },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.multiplexer?.type).toBe('none');
      expect(result.data.multiplexer?.layout).toBe('main-vertical');
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('disables pane management for an out-of-range main_pane_size', () => {
    const result = PluginConfigSchema.safeParse({
      multiplexer: { type: 'tmux', main_pane_size: 10 },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.multiplexer?.type).toBe('none');
      expect(result.data.multiplexer?.main_pane_size).toBe(60);
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('main_pane_size');
  });

  it('emits the invalid-value diagnostic at most once per process', () => {
    expect(MultiplexerConfigSchema.safeParse({ type: 'bogus' }).success).toBe(
      true,
    );
    expect(MultiplexerConfigSchema.safeParse({ layout: 'bogus' }).success).toBe(
      true,
    );
    expect(
      MultiplexerConfigSchema.safeParse({ main_pane_size: 0 }).success,
    ).toBe(true);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('treats a non-object multiplexer value as invalid and disables panes', () => {
    for (const value of ['tmux', [], null]) {
      const result = PluginConfigSchema.safeParse({ multiplexer: value });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.multiplexer?.type).toBe('none');
      }
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves multiplexer undefined when the block is omitted', () => {
    const result = PluginConfigSchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.multiplexer).toBeUndefined();
    }
  });
});

describe('InterviewConfigSchema outputFolder', () => {
  it('accepts relative output folders', () => {
    expect(
      InterviewConfigSchema.safeParse({ outputFolder: 'interviews/specs' })
        .success,
    ).toBe(true);
    expect(
      InterviewConfigSchema.safeParse({
        outputFolder: String.raw`interviews\specs`,
      }).success,
    ).toBe(true);
  });

  it('rejects absolute and parent-directory output folders', () => {
    const invalidOutputFolders = [
      '/tmp/interviews',
      String.raw`\tmp\interviews`,
      'C:/tmp/interviews',
      String.raw`C:\tmp\interviews`,
      '..',
      '../interviews',
      String.raw`..\interviews`,
      'interviews/../outside',
      String.raw`interviews\..\outside`,
    ];

    for (const outputFolder of invalidOutputFolders) {
      expect(InterviewConfigSchema.safeParse({ outputFolder }).success).toBe(
        false,
      );
      expect(
        PluginConfigSchema.safeParse({ interview: { outputFolder } }).success,
      ).toBe(false);
    }
  });

  it('rejects whitespace-wrapped parent-directory output folders', () => {
    const invalidOutputFolders = [' ../outside ', String.raw` ..\outside `];

    for (const outputFolder of invalidOutputFolders) {
      expect(InterviewConfigSchema.safeParse({ outputFolder }).success).toBe(
        false,
      );
      expect(
        PluginConfigSchema.safeParse({ interview: { outputFolder } }).success,
      ).toBe(false);
    }
  });

  it('stores the trimmed output folder', () => {
    const outputFolder = '  interviews/specs  ';
    const interviewResult = InterviewConfigSchema.safeParse({ outputFolder });
    const pluginResult = PluginConfigSchema.safeParse({
      interview: { outputFolder },
    });

    expect(interviewResult.success).toBe(true);
    expect(pluginResult.success).toBe(true);
    if (interviewResult.success) {
      expect(interviewResult.data.outputFolder).toBe('interviews/specs');
    }
    if (pluginResult.success) {
      expect(pluginResult.data.interview?.outputFolder).toBe(
        'interviews/specs',
      );
    }
  });
});

describe('PluginConfigSchema backgroundJobs', () => {
  it('defaults board injection to the legacy latest strategy', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.strategy).toBe('latest');
      expect(result.data.backgroundJobs?.maxRetainedSnapshots).toBe(20);
    }
  });

  it('defaults orchestratorWake to enabled with a 5-minute interval and auto mode', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.orchestratorWake).toEqual({
        enabled: true,
        intervalMs: 300_000,
        mode: 'auto',
        wakeOnTerminalPublication: true,
        publicationWakeMinIntervalMs: 30_000,
      });
    }
  });

  it('accepts explicit orchestratorWake overrides', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        orchestratorWake: {
          enabled: false,
          intervalMs: 120_000,
          wakeOnTerminalPublication: false,
          publicationWakeMinIntervalMs: 120_000,
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.orchestratorWake).toEqual({
        enabled: false,
        intervalMs: 120_000,
        mode: 'auto',
        wakeOnTerminalPublication: false,
        publicationWakeMinIntervalMs: 120_000,
      });
    }
  });

  it('rejects out-of-bounds publicationWakeMinIntervalMs values', () => {
    for (const publicationWakeMinIntervalMs of [0, 999, -1, 2_147_483_648]) {
      expect(
        PluginConfigSchema.safeParse({
          backgroundJobs: {
            orchestratorWake: { publicationWakeMinIntervalMs },
          },
        }).success,
      ).toBe(false);
    }
  });

  it('defaults backgroundJobs.stopConfirmationMs to 5 seconds', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.stopConfirmationMs).toBe(5_000);
    }
  });

  it('accepts explicit stopConfirmationMs within bounds and rejects outside', () => {
    for (const stopConfirmationMs of [1_000, 5_000, 60_000]) {
      expect(
        PluginConfigSchema.safeParse({
          backgroundJobs: { stopConfirmationMs },
        }).success,
      ).toBe(true);
    }
    for (const stopConfirmationMs of [999, 60_001, 0, -1]) {
      expect(
        PluginConfigSchema.safeParse({
          backgroundJobs: { stopConfirmationMs },
        }).success,
      ).toBe(false);
    }
  });

  it('accepts explicit orchestratorWake.mode values', () => {
    for (const mode of ['auto', 'todo', 'children'] as const) {
      const result = PluginConfigSchema.safeParse({
        backgroundJobs: { orchestratorWake: { mode } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.backgroundJobs?.orchestratorWake?.mode).toBe(mode);
      }
    }
  });

  it('rejects unknown orchestratorWake.mode values', () => {
    for (const mode of ['child', 'todos', 'AUTO', '', null]) {
      expect(
        PluginConfigSchema.safeParse({
          backgroundJobs: { orchestratorWake: { mode } },
        }).success,
      ).toBe(false);
    }
  });

  it('rejects orchestratorWake.intervalMs below 60_000 including 0', () => {
    for (const intervalMs of [0, 1, 59_999, 60_000.5, -1]) {
      expect(
        PluginConfigSchema.safeParse({
          backgroundJobs: { orchestratorWake: { intervalMs } },
        }).success,
      ).toBe(false);
    }
  });

  it('accepts orchestratorWake.intervalMs bounds', () => {
    for (const intervalMs of [60_000, 300_000, 2_147_483_647]) {
      const result = PluginConfigSchema.safeParse({
        backgroundJobs: { orchestratorWake: { intervalMs } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.backgroundJobs?.orchestratorWake?.intervalMs).toBe(
          intervalMs,
        );
      }
    }
  });

  it('accepts checkpoint-compatible board injection', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: { strategy: 'checkpoint-compatible' },
    });

    expect(result.success).toBe(true);
  });

  it('accepts a bounded checkpoint snapshot retention limit', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: { maxRetainedSnapshots: 3 },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.maxRetainedSnapshots).toBe(3);
    }
  });

  it('rejects checkpoint snapshot retention limits outside 1–100', () => {
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: { maxRetainedSnapshots: 0 },
      }).success,
    ).toBe(false);
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: { maxRetainedSnapshots: 101 },
      }).success,
    ).toBe(false);
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: { maxRetainedSnapshots: 20.5 },
      }).success,
    ).toBe(false);
  });

  it('defaults the wall-clock supervisor to disabled with a 10 second grace', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.wallClockTimeoutMs).toBe(0);
      expect(result.data.backgroundJobs?.abortGraceMs).toBe(10_000);
    }
  });

  it('defaults background task concurrency limits to disabled', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.concurrency).toEqual({
        defaultConcurrency: 0,
        providerConcurrency: {},
        modelConcurrency: {},
      });
    }
  });

  it('accepts default, provider, and model concurrency limits', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        concurrency: {
          defaultConcurrency: 2,
          providerConcurrency: { openai: 3 },
          modelConcurrency: { 'openai/gpt-5.6-luna': 1 },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid background task concurrency limits', () => {
    for (const concurrency of [
      { defaultConcurrency: -1 },
      { defaultConcurrency: 1001 },
      { defaultConcurrency: 1.5 },
      { providerConcurrency: { openai: -1 } },
      { providerConcurrency: { openai: 1.5 } },
      { modelConcurrency: { 'openai/gpt-5.6-luna': -1 } },
      { modelConcurrency: { 'openai/gpt-5.6-luna': 1.5 } },
    ]) {
      expect(
        PluginConfigSchema.safeParse({ backgroundJobs: { concurrency } })
          .success,
      ).toBe(false);
    }
  });

  it('accepts zero as unlimited for provider and model caps', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        concurrency: {
          defaultConcurrency: 2,
          providerConcurrency: { openai: 0 },
          modelConcurrency: { 'openai/gpt-5.6-luna': 0 },
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        result.data.backgroundJobs?.concurrency?.providerConcurrency,
      ).toEqual({ openai: 0 });
      expect(result.data.backgroundJobs?.concurrency?.modelConcurrency).toEqual(
        { 'openai/gpt-5.6-luna': 0 },
      );
    }
  });

  it('accepts the documented wall-clock supervisor bounds', () => {
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: {
          wallClockTimeoutMs: 0,
          abortGraceMs: 1_000,
        },
      }).success,
    ).toBe(true);
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: {
          wallClockTimeoutMs: 60_000,
          abortGraceMs: 60_000,
        },
      }).success,
    ).toBe(true);
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: {
          wallClockTimeoutMs: 2_147_483_647,
        },
      }).success,
    ).toBe(true);
  });

  it('rejects wall-clock supervisor values outside the safe integer bounds', () => {
    const invalid = [
      { wallClockTimeoutMs: -1 },
      { wallClockTimeoutMs: 1 },
      { wallClockTimeoutMs: 59_999 },
      { wallClockTimeoutMs: 2_147_483_648 },
      { wallClockTimeoutMs: 60_000.5 },
      { abortGraceMs: 999 },
      { abortGraceMs: 60_001 },
      { abortGraceMs: 1_000.5 },
    ];

    for (const backgroundJobs of invalid) {
      expect(PluginConfigSchema.safeParse({ backgroundJobs }).success).toBe(
        false,
      );
    }
  });

  it('accepts sameProviderPolicy entries with the foreground policy', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        sameProviderPolicy: { 'lm-nexus': 'foreground' },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.sameProviderPolicy).toEqual({
        'lm-nexus': 'foreground',
      });
    }
  });

  it('accepts an empty sameProviderPolicy map', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: { sameProviderPolicy: {} },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.sameProviderPolicy).toEqual({});
    }
  });

  it('leaves default behavior unchanged when sameProviderPolicy is omitted', () => {
    const withDefaults = PluginConfigSchema.safeParse({ backgroundJobs: {} });
    expect(withDefaults.success).toBe(true);
    if (withDefaults.success) {
      expect(withDefaults.data.backgroundJobs?.sameProviderPolicy).toEqual({});
    }

    const absent = PluginConfigSchema.safeParse({});
    expect(absent.success).toBe(true);
    if (absent.success) {
      expect(absent.data.backgroundJobs).toBeUndefined();
    }
  });

  it('rejects invalid sameProviderPolicy values', () => {
    for (const sameProviderPolicy of [
      { foo: 'background' },
      { foo: 1 },
      'foreground',
    ]) {
      expect(
        PluginConfigSchema.safeParse({
          backgroundJobs: { sameProviderPolicy },
        }).success,
      ).toBe(false);
    }
  });
});
