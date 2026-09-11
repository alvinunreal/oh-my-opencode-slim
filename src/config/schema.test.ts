import { describe, expect, it } from 'bun:test';
import {
  InterviewConfigSchema,
  PluginConfigSchema,
  PresetSchema,
  ProviderModelIdSchema,
} from './schema';

describe('structured preset schema', () => {
  it('keeps agent overrides separate from reserved marketplace activation', () => {
    const result = PresetSchema.safeParse({
      agents: { explorer: { model: 'provider/explorer' } },
      marketplace: {
        agents: ['community/example'],
        profiles: { librarian: null },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents.explorer.model).toBe('provider/explorer');
      expect(result.data.marketplace?.agents).toEqual(['community/example']);
    }
  });

  it('normalizes the legacy flat preset agent map', () => {
    const result = PresetSchema.safeParse({
      explorer: { model: 'provider/explorer' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        agents: { explorer: { model: 'provider/explorer' } },
      });
    }
  });

  it('gives structured agent overrides precedence in mixed presets', () => {
    const result = PresetSchema.safeParse({
      explorer: { model: 'legacy/explorer' },
      agents: { explorer: { model: 'structured/explorer' } },
      marketplace: { agents: ['community/example'] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents.explorer.model).toBe('structured/explorer');
      expect(result.data.marketplace?.agents).toEqual(['community/example']);
    }
  });

  it('normalizes package IDs and validates profile targets', () => {
    const result = PresetSchema.safeParse({
      marketplace: {
        agents: ['  community/one  '],
        profiles: { oracle: '  community/oracle  ' },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.marketplace?.agents).toEqual(['community/one']);
      expect(result.data.marketplace?.profiles).toEqual({
        oracle: 'community/oracle',
      });
    }
  });

  it('rejects duplicate package IDs and unsupported profile targets', () => {
    const result = PresetSchema.safeParse({
      marketplace: {
        agents: ['community/one', ' community/one '],
        profiles: { orchestrator: 'community/one' },
      },
    });
    expect(result.success).toBe(false);
  });
});

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
      });
    }
  });

  it('accepts explicit orchestratorWake overrides', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        orchestratorWake: { enabled: false, intervalMs: 120_000 },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.orchestratorWake).toEqual({
        enabled: false,
        intervalMs: 120_000,
        mode: 'auto',
      });
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
});
