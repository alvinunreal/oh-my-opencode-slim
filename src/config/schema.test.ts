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
  DISABLED_COMMANDS_VALUES,
  DISABLED_HOOKS_VALUES,
  InterviewConfigSchema,
  MarketplaceActivationSchema,
  MarketplaceConfigSchema,
  MULTIPLEXER_INVALID_VALUE_MESSAGE,
  MultiplexerConfigSchema,
  MultiplexerConfigStrictSchema,
  PermissionConfigSchema,
  PluginConfigSchema,
  PresetSchema,
  ProviderModelIdSchema,
  resetBackgroundJobsDiagnostics,
  resetMultiplexerDiagnostics,
} from './schema';

describe('ProviderModelIdSchema', () => {
  it('accepts and preserves model remainders with spaces and nested segments', () => {
    const ids = [
      'of/MiniMax M3',
      'of/Kimi K2.6',
      'opencode-omniroute-live/of/Qwen3.8 27b',
      'openai/gpt-6-luna',
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

describe('PermissionConfigSchema', () => {
  it('preserves the author key order — order is precedence', () => {
    // opencode compiles the entries into rules and evaluates them
    // last-match-wins, so the wildcard base must stay first. A shaped
    // z.object() parse used to emit declared keys first and catchall keys
    // after, inverting the order.
    const parsed = PermissionConfigSchema.parse({
      '*': 'deny',
      read: 'allow',
      glob: 'allow',
      edit: 'deny',
    });
    expect(Object.keys(parsed)).toEqual(['*', 'read', 'glob', 'edit']);
  });

  it('keeps string-only keys string-only', () => {
    expect(PermissionConfigSchema.safeParse({ question: 'deny' }).success).toBe(
      true,
    );
    expect(
      PermissionConfigSchema.safeParse({ webfetch: { 'https://*': 'allow' } })
        .success,
    ).toBe(false);
    // Rule keys still accept pattern maps.
    expect(
      PermissionConfigSchema.safeParse({
        bash: { 'git status*': 'allow', '*': 'ask' },
      }).success,
    ).toBe(true);
  });

  it('preserves nested pattern-map order — order is precedence there too', () => {
    // A pattern map's entry order is also precedence: opencode compiles
    // each pair into a {action, resource, effect} rule and evaluates
    // last-match-wins, so the broad pattern must precede the narrow one.
    const parsed = PermissionConfigSchema.parse({
      bash: { '*': 'ask', 'git status*': 'allow' },
    }) as { bash: Record<string, string> };
    expect(Object.keys(parsed.bash)).toEqual(['*', 'git status*']);
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

describe('PluginConfigSchema fallback continuation policy', () => {
  it('defaults to retrying the primary and accepts sticky fallback mode', () => {
    expect(PluginConfigSchema.parse({ fallback: {} }).fallback).toMatchObject({
      continuationPolicy: 'retry-primary',
    });
    expect(
      PluginConfigSchema.parse({
        fallback: { continuationPolicy: 'stick-to-fallback' },
      }).fallback,
    ).toMatchObject({ continuationPolicy: 'stick-to-fallback' });
  });

  it('rejects unknown continuation policies', () => {
    expect(
      PluginConfigSchema.safeParse({
        fallback: { continuationPolicy: 'sometimes' },
      }).success,
    ).toBe(false);
  });
});

describe('PluginConfigSchema preset syntax', () => {
  it('validates marketplace activation replacements and directives', () => {
    expect(
      MarketplaceActivationSchema.parse({
        agents: [' owner/one '],
        agents_add: ['owner/two'],
        agents_remove: ['owner/three'],
      }),
    ).toEqual({
      agents: ['owner/one'],
      agents_add: ['owner/two'],
      agents_remove: ['owner/three'],
    });
    expect(
      PluginConfigSchema.safeParse({
        presets: {
          invalid: {
            marketplace: { agents_add: ['owner/one', 'owner/one'] },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('accepts marketplace activation IDs only in canonical owner/package form', () => {
    expect(
      MarketplaceActivationSchema.parse({ agents: [' owner/package '] }),
    ).toEqual({ agents: ['owner/package'] });

    for (const id of [
      'owner',
      'owner/package/extra',
      'Owner/package',
      'owner/name with spaces',
    ]) {
      expect(
        MarketplaceActivationSchema.safeParse({ agents: [id] }).success,
      ).toBe(false);
    }

    expect(
      MarketplaceActivationSchema.safeParse({
        agents: ['owner/package', ' owner/package '],
      }).success,
    ).toBe(false);
  });

  it('does not accept mixed marketplace activation and agent override fields', () => {
    for (const preset of [
      {
        marketplace: { agents_add: ['owner/package'], model: 'provider/model' },
      },
      {
        extends: 'base',
        marketplace: {
          agents_remove: ['owner/package'],
          temperature: 0.5,
        },
      },
    ]) {
      expect(PresetSchema.safeParse(preset).success).toBe(false);
    }
  });

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

describe('PluginConfigSchema disabled_hooks and disabled_commands', () => {
  it('accepts the whitelisted hook and command names', () => {
    const result = PluginConfigSchema.safeParse({
      disabled_hooks: ['phase-reminder', 'foreground-fallback'],
      disabled_commands: [
        'interview',
        'implement',
        'deepwork',
        'reflect',
        'preset',
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.disabled_hooks).toEqual([
        'phase-reminder',
        'foreground-fallback',
      ]);
      expect(result.data.disabled_commands).toEqual([
        'interview',
        'implement',
        'deepwork',
        'reflect',
        'preset',
      ]);
    }
  });

  it('leaves both keys undefined when omitted', () => {
    const result = PluginConfigSchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.disabled_hooks).toBeUndefined();
      expect(result.data.disabled_commands).toBeUndefined();
    }
  });

  it('exports the valid value lists as the enum source of truth', () => {
    expect(DISABLED_HOOKS_VALUES).toEqual([
      'phase-reminder',
      'foreground-fallback',
      'deepwork-goal',
      'chat-headers',
      'cache-monitor',
      'json-error-recovery',
      'tool-loop-guard',
      'search-path-guard',
      'absolute-path-rescue',
      'apply-patch',
      'council-inject',
      'auto-update-checker',
    ]);
    expect(DISABLED_COMMANDS_VALUES).toEqual([
      'implement',
      'interview',
      'deepwork',
      'reflect',
      'preset',
      'killall',
      'subagent',
    ]);
  });

  it('keeps the strict enum for direct schema consumers (loader strips first)', () => {
    // Config loading strips unknown entries before validation and warns
    // (see loader.test.ts). The enum remains as defense in depth and for
    // editor completion.
    expect(
      PluginConfigSchema.safeParse({
        disabled_hooks: ['auto-update-checker', 'phase-reminder'],
      }).success,
    ).toBe(true);
    expect(
      PluginConfigSchema.safeParse({ disabled_hooks: ['update-checker'] })
        .success,
    ).toBe(false);
    expect(
      PluginConfigSchema.safeParse({ disabled_commands: ['council'] }).success,
    ).toBe(false);
    expect(
      PluginConfigSchema.safeParse({
        disabled_commands: ['deepwork', 'review'],
      }).success,
    ).toBe(false);
  });

  it('auto-update-checker gates update checking and installation together', () => {
    const result = PluginConfigSchema.safeParse({
      disabled_hooks: ['auto-update-checker'],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.disabled_hooks).toEqual(['auto-update-checker']);
    }
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

  it('rejects the removed dedicated model key (strict schema)', () => {
    const result = PluginConfigSchema.safeParse({
      webfetch: {
        model: 'openai/gpt-4o-mini',
      },
    });

    expect(result.success).toBe(false);
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
      equalize_panes: true,
    });
  });

  it('defaults equalize_panes to true and preserves an explicit false', () => {
    expect(MultiplexerConfigSchema.parse({}).equalize_panes).toBe(true);
    expect(
      MultiplexerConfigSchema.parse({ equalize_panes: false }).equalize_panes,
    ).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('disables pane management for a non-boolean equalize_panes', () => {
    const result = PluginConfigSchema.safeParse({
      multiplexer: { type: 'herdr', equalize_panes: 'yes' },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.multiplexer?.type).toBe('none');
      // The invalid key is dropped, so the documented default applies.
      expect(result.data.multiplexer?.equalize_panes).toBe(true);
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('Invalid multiplexer config value');
    expect(message).toContain('equalize_panes');
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
      'wezterm',
      'orca',
      'cmux-tui',
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

  it('disables pane management for an invalid viewer value', () => {
    const result = PluginConfigSchema.safeParse({
      multiplexer: { type: 'herdr', viewer: 'nano' },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.multiplexer?.type).toBe('none');
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('Invalid multiplexer config value');
    expect(message).toContain('viewer');
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

describe('InterviewConfigSchema printState', () => {
  it('defaults to false', () => {
    const interviewResult = InterviewConfigSchema.safeParse({});
    const pluginResult = PluginConfigSchema.safeParse({ interview: {} });

    expect(interviewResult.success).toBe(true);
    expect(pluginResult.success).toBe(true);
    if (interviewResult.success) {
      expect(interviewResult.data.printState).toBe(false);
    }
    if (pluginResult.success) {
      expect(pluginResult.data.interview?.printState).toBe(false);
    }
  });

  it('accepts an explicit true', () => {
    const interviewResult = InterviewConfigSchema.safeParse({
      printState: true,
    });
    expect(interviewResult.success).toBe(true);
    if (interviewResult.success) {
      expect(interviewResult.data.printState).toBe(true);
    }
  });
});

describe('InterviewConfigSchema enabled', () => {
  it('defaults to true', () => {
    const interviewResult = InterviewConfigSchema.safeParse({});
    const pluginResult = PluginConfigSchema.safeParse({ interview: {} });

    expect(interviewResult.success).toBe(true);
    expect(pluginResult.success).toBe(true);
    if (interviewResult.success) {
      expect(interviewResult.data.enabled).toBe(true);
    }
    if (pluginResult.success) {
      expect(pluginResult.data.interview?.enabled).toBe(true);
    }
  });

  it('accepts an explicit false', () => {
    const result = PluginConfigSchema.safeParse({
      interview: { enabled: false, maxQuestions: 5 },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.interview?.enabled).toBe(false);
      expect(result.data.interview?.maxQuestions).toBe(5);
    }
  });
});

describe('PluginConfigSchema sidebar', () => {
  it('defaults to true and stays optional', () => {
    const result = PluginConfigSchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sidebar).toBeUndefined();
    }
  });

  it('accepts an explicit false', () => {
    const result = PluginConfigSchema.safeParse({ sidebar: false });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sidebar).toBe(false);
    }
  });

  it('keeps liveConfigRefresh optional and defaults to enabled', () => {
    const omitted = PluginConfigSchema.safeParse({});
    const explicit = PluginConfigSchema.safeParse({ liveConfigRefresh: false });

    expect(omitted.success).toBe(true);
    expect(explicit.success).toBe(true);
    if (omitted.success) {
      // Effective default is true: the key stays optional (unset = enabled),
      // matching the other top-level boolean switches; the RuntimeConfig
      // getter derives true rather than carrying a parsed default.
      expect(omitted.data.liveConfigRefresh).toBeUndefined();
    }
    if (explicit.success) {
      expect(explicit.data.liveConfigRefresh).toBe(false);
    }
  });
});

describe('PluginConfigSchema marketplace (root kill switch)', () => {
  it('reads a boolean root marketplace as the enabled switch', () => {
    for (const enabled of [false, true]) {
      const result = PluginConfigSchema.safeParse({ marketplace: enabled });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.marketplace).toEqual({ enabled });
      }
    }
  });

  it('defaults the root marketplace subsystem to enabled', () => {
    const blockResult = MarketplaceConfigSchema.safeParse({});
    const result = PluginConfigSchema.safeParse({ marketplace: {} });

    expect(blockResult.success).toBe(true);
    expect(result.success).toBe(true);
    if (blockResult.success) {
      expect(blockResult.data.enabled).toBeUndefined();
    }
    if (result.success) {
      expect(result.data.marketplace?.enabled).toBeUndefined();
    }
  });

  it('accepts an explicit enabled: false kill switch', () => {
    const result = PluginConfigSchema.safeParse({
      marketplace: { enabled: false },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.marketplace?.enabled).toBe(false);
    }
  });

  it('treats a misplaced activation-shaped root block as an inert no-op', () => {
    // Package selection only ever took effect at presets.<name>.marketplace.
    // The baseline schema silently ignored a root-level activation list;
    // preserve that leniency instead of rejecting the whole config layer.
    const result = PluginConfigSchema.safeParse({
      marketplace: { agents: ['author/pkg'] },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.marketplace?.enabled).toBeUndefined();
    }
  });

  it('leaves per-preset marketplace activation parsing untouched', () => {
    const result = PluginConfigSchema.safeParse({
      preset: 'fast',
      presets: {
        fast: {
          marketplace: { agents: ['author/pkg'] },
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.presets?.fast?.marketplace).toEqual({
        agents: ['author/pkg'],
      });
    }
  });

  it('leaves the root block undefined when omitted', () => {
    const result = PluginConfigSchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.marketplace).toBeUndefined();
    }
  });
});

describe('PluginConfigSchema backgroundJobs', () => {
  let warnSpy: Mock<typeof console.warn>;

  beforeEach(() => {
    resetBackgroundJobsDiagnostics();
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    warnSpy.mockClear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('defaults backgroundJobs.enabled to true', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.enabled).toBe(true);
    }
  });

  it('accepts enabled: false and keeps the otherwise-inert lifecycle keys', () => {
    // false only turns the managed lifecycle off; the sibling keys stay
    // accepted (validated as usual, then inert at runtime).
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        enabled: false,
        maxSessionsPerAgent: 4,
        orchestratorWake: { enabled: false, intervalMs: 120_000 },
        wallClockTimeoutMs: 60_000,
        stopConfirmationMs: 2_000,
        concurrency: { defaultConcurrency: 2 },
        sameProviderPolicy: { provider: 'foreground' },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.enabled).toBe(false);
      expect(result.data.backgroundJobs?.maxSessionsPerAgent).toBe(4);
      expect(result.data.backgroundJobs?.wallClockTimeoutMs).toBe(60_000);
      expect(result.data.backgroundJobs?.concurrency?.defaultConcurrency).toBe(
        2,
      );
      expect(result.data.backgroundJobs?.sameProviderPolicy).toEqual({
        provider: 'foreground',
      });
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('drops one invalid key and keeps the rest of the config layer (#1291)', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: { maxSessionsPerAgent: 16 },
      presets: { review: { explorer: { model: 'valid/model' } } },
      agents: { oracle: { model: 'valid/model' } },
      disabled_agents: ['designer'],
      disabled_tools: ['ast_grep_search'],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.maxSessionsPerAgent).toBe(2);
      expect(result.data.presets?.review?.explorer?.model).toBe('valid/model');
      expect(result.data.agents?.oracle?.model).toBe('valid/model');
      expect(result.data.disabled_agents).toEqual(['designer']);
      expect(result.data.disabled_tools).toEqual(['ast_grep_search']);
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('Invalid backgroundJobs config value');
    expect(message).toContain('maxSessionsPerAgent');
  });

  it('drops a non-object backgroundJobs value and keeps the layer', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: 'invalid',
      agents: { oracle: { model: 'valid/model' } },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.maxSessionsPerAgent).toBe(2);
      expect(result.data.agents?.oracle?.model).toBe('valid/model');
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves valid nested siblings when one nested value is invalid', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        orchestratorWake: { enabled: false, intervalMs: 1_000 },
        concurrency: {
          defaultConcurrency: 4,
          providerConcurrency: { openai: -1 },
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.orchestratorWake?.enabled).toBe(false);
      expect(result.data.backgroundJobs?.orchestratorWake?.intervalMs).toBe(
        300_000,
      );
      expect(result.data.backgroundJobs?.concurrency?.defaultConcurrency).toBe(
        4,
      );
      expect(
        result.data.backgroundJobs?.concurrency?.providerConcurrency,
      ).toEqual({});
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('orchestratorWake.intervalMs');
    expect(message).toContain('concurrency.providerConcurrency');
  });

  it('ignores keys that collide with inherited object members', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        constructor: 'nope',
        toString: 1,
        maxSessionsPerAgent: 4,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.maxSessionsPerAgent).toBe(4);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('ignores a JSON-parsed __proto__ own property without polluting prototypes', () => {
    const raw = JSON.parse(
      '{"backgroundJobs":{"__proto__":{"polluted":true},"maxSessionsPerAgent":4}}',
    );
    const result = PluginConfigSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.maxSessionsPerAgent).toBe(4);
    }
    expect(warnSpy).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('drops a strict-nested concurrency block wholesale when it carries an unknown key', () => {
    // Known residual (follow-up): inside the strict concurrency object an
    // unknown key is not stripped, so the parent safeParse fails and the
    // whole block is dropped — the diagnostic names the parent key only.
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        maxSessionsPerAgent: 4,
        concurrency: { defaultConcurrency: 4, notAKey: 1 },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.maxSessionsPerAgent).toBe(4);
      expect(result.data.backgroundJobs?.concurrency?.defaultConcurrency).toBe(
        0,
      );
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('concurrency');
    expect(message).not.toContain('notAKey');
  });

  it('does not mutate the raw config while sanitizing', () => {
    const raw = {
      backgroundJobs: {
        maxSessionsPerAgent: 16,
        orchestratorWake: { enabled: false, intervalMs: 1_000 },
      },
    };
    const before = JSON.stringify(raw);
    PluginConfigSchema.safeParse(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('boards render structurally with no board keys on the schema', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.maxSessionsPerAgent).toBe(2);
      expect('strategy' in (result.data.backgroundJobs ?? {})).toBe(false);
    }
  });

  it('rejects every removed board key', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        strategy: 'latest',
        maxRetainedSnapshots: 20,
        boardInjection: true,
        maxContextLines: 10,
        readContextMinLines: 1,
        readContextMaxFiles: 2,
        abortGraceMs: 10_000,
      },
    });

    expect(result.success).toBe(false);
  });

  it.each(['boardInjection', 'abortGraceMs'] as const)(
    'rejects removed backgroundJobs.%s independently',
    (key) => {
      const result = PluginConfigSchema.safeParse({
        backgroundJobs: { [key]: key === 'boardInjection' ? true : 10_000 },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['backgroundJobs', key],
            message: expect.stringContaining(`${key} was removed`),
          }),
        );
      }
    },
  );

  it('defaults orchestratorWake to enabled with a 5-minute interval and auto mode', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.orchestratorWake).toEqual({
        enabled: true,
        intervalMs: 300_000,
        mode: 'auto',
        periodicWakeEnabled: true,
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
        periodicWakeEnabled: true,
        wakeOnTerminalPublication: false,
        publicationWakeMinIntervalMs: 120_000,
      });
    }
  });

  it('drops out-of-bounds publicationWakeMinIntervalMs back to the wake defaults', () => {
    for (const publicationWakeMinIntervalMs of [0, 999, -1, 2_147_483_648]) {
      const result = PluginConfigSchema.safeParse({
        backgroundJobs: {
          maxSessionsPerAgent: 4,
          orchestratorWake: { publicationWakeMinIntervalMs },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Sibling key must survive — direct evidence that only the bad key
        // is dropped.
        expect(result.data.backgroundJobs?.maxSessionsPerAgent).toBe(4);
        expect(
          result.data.backgroundJobs?.orchestratorWake
            ?.publicationWakeMinIntervalMs,
        ).toBe(30_000);
      }
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('defaults backgroundJobs.stopConfirmationMs to 5 seconds', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.stopConfirmationMs).toBe(5_000);
    }
  });

  it('accepts explicit stopConfirmationMs within bounds and drops out-of-bounds values', () => {
    for (const stopConfirmationMs of [1_000, 5_000, 60_000]) {
      expect(
        PluginConfigSchema.safeParse({
          backgroundJobs: { stopConfirmationMs },
        }).success,
      ).toBe(true);
    }
    for (const stopConfirmationMs of [999, 60_001, 0, -1]) {
      const result = PluginConfigSchema.safeParse({
        backgroundJobs: { stopConfirmationMs },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.backgroundJobs?.stopConfirmationMs).toBe(5_000);
      }
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

  it('drops invalid nested orchestratorWake values back to the wake defaults', () => {
    for (const orchestratorWake of [
      { intervalMs: 0 },
      { intervalMs: 1 },
      { intervalMs: 59_999 },
      { intervalMs: 60_000.5 },
      { intervalMs: -1 },
      { mode: 'child' },
      { mode: '' },
      { mode: null },
    ]) {
      const result = PluginConfigSchema.safeParse({
        backgroundJobs: { orchestratorWake },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.backgroundJobs?.orchestratorWake).toEqual({
          enabled: true,
          intervalMs: 300_000,
          mode: 'auto',
          periodicWakeEnabled: true,
          wakeOnTerminalPublication: true,
          publicationWakeMinIntervalMs: 30_000,
        });
      }
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

  it('defaults the wall-clock supervisor to disabled', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.wallClockTimeoutMs).toBe(0);
    }
  });

  it('defaults pruneEvictedSessions to disabled and accepts an explicit on', () => {
    const defaults = PluginConfigSchema.safeParse({ backgroundJobs: {} });
    expect(defaults.success).toBe(true);
    if (defaults.success) {
      expect(defaults.data.backgroundJobs?.pruneEvictedSessions).toBe(false);
    }

    const on = PluginConfigSchema.safeParse({
      backgroundJobs: { pruneEvictedSessions: true },
    });
    expect(on.success).toBe(true);
    if (on.success) {
      expect(on.data.backgroundJobs?.pruneEvictedSessions).toBe(true);
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
          modelConcurrency: { 'openai/gpt-6-luna': 1 },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('drops invalid background task concurrency limits back to the defaults', () => {
    for (const concurrency of [
      { defaultConcurrency: -1 },
      { defaultConcurrency: 1001 },
      { defaultConcurrency: 1.5 },
      { providerConcurrency: { openai: -1 } },
      { providerConcurrency: { openai: 1.5 } },
      { modelConcurrency: { 'openai/gpt-6-luna': -1 } },
      { modelConcurrency: { 'openai/gpt-6-luna': 1.5 } },
    ]) {
      const result = PluginConfigSchema.safeParse({
        backgroundJobs: { concurrency },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(
          result.data.backgroundJobs?.concurrency?.defaultConcurrency,
        ).toBe(0);
      }
    }
  });

  it('accepts zero as unlimited for provider and model caps', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        concurrency: {
          defaultConcurrency: 2,
          providerConcurrency: { openai: 0 },
          modelConcurrency: { 'openai/gpt-6-luna': 0 },
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        result.data.backgroundJobs?.concurrency?.providerConcurrency,
      ).toEqual({ openai: 0 });
      expect(result.data.backgroundJobs?.concurrency?.modelConcurrency).toEqual(
        { 'openai/gpt-6-luna': 0 },
      );
    }
  });

  it('accepts the documented wall-clock supervisor bounds', () => {
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: {
          wallClockTimeoutMs: 0,
        },
      }).success,
    ).toBe(true);
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: {
          wallClockTimeoutMs: 60_000,
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

  it('drops wall-clock supervisor values outside the safe integer bounds', () => {
    const invalid = [
      { wallClockTimeoutMs: -1 },
      { wallClockTimeoutMs: 1 },
      { wallClockTimeoutMs: 59_999 },
      { wallClockTimeoutMs: 2_147_483_648 },
      { wallClockTimeoutMs: 60_000.5 },
    ];

    for (const backgroundJobs of invalid) {
      const result = PluginConfigSchema.safeParse({ backgroundJobs });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.backgroundJobs?.wallClockTimeoutMs).toBe(0);
      }
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

  it('drops invalid sameProviderPolicy values back to the empty default', () => {
    for (const sameProviderPolicy of [
      { foo: 'background' },
      { foo: 1 },
      'foreground',
    ]) {
      const result = PluginConfigSchema.safeParse({
        backgroundJobs: { sameProviderPolicy },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.backgroundJobs?.sameProviderPolicy).toEqual({});
      }
    }
  });

  it('defaults childInputWake to enabled', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.childInputWake).toBe(true);
    }
  });

  it('accepts an explicit childInputWake override', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: { childInputWake: false },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.childInputWake).toBe(false);
    }
  });

  it('defaults childInputWakeKinds to permission-off, question-on', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.childInputWakeKinds).toEqual({
        permission: false,
        question: true,
      });
    }
  });

  it('defaults a missing childInputWakeKinds field', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: { childInputWakeKinds: { question: false } },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.childInputWakeKinds).toEqual({
        permission: false,
        question: false,
      });
    }
  });

  // Unlike sibling keys, .catch() swallows invalid input without the
  // backgroundJobs diagnostic — accepted per review.
  it('falls back to defaults for invalid childInputWakeKinds', () => {
    for (const childInputWakeKinds of [{ permission: 'yes' }, 'question']) {
      const result = PluginConfigSchema.safeParse({
        backgroundJobs: { childInputWakeKinds },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.backgroundJobs?.childInputWakeKinds).toEqual({
          permission: false,
          question: true,
        });
      }
    }
  });
});

describe('PluginConfigSchema removed legacy keys', () => {
  it('rejects the removed top-level tmux key', () => {
    expect(
      PluginConfigSchema.safeParse({ tmux: { enabled: true } }).success,
    ).toBe(false);
  });

  it('rejects the removed multiplexer.zellij_pane_mode key', () => {
    expect(
      PluginConfigSchema.safeParse({
        multiplexer: { type: 'zellij', zellij_pane_mode: 'tab' },
      }).success,
    ).toBe(false);
  });

  it('rejects the removed fallback.timeoutMs / retry_on_empty / runtimeOverride keys', () => {
    for (const key of ['timeoutMs', 'retry_on_empty', 'runtimeOverride']) {
      expect(
        PluginConfigSchema.safeParse({ fallback: { [key]: 1 } }).success,
      ).toBe(false);
    }
  });

  it('rejects the removed backgroundJobs.continueOnIdle key', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: { continueOnIdle: false },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.map((issue) => issue.message).join('\n'),
      ).toContain('was removed');
    }
  });

  it('accepts orca as a multiplexer type with sibling keys', () => {
    const parsed = MultiplexerConfigSchema.parse({
      type: 'orca',
      layout: 'main-horizontal',
      main_pane_size: 40,
    });
    expect(parsed.type).toBe('orca');
    expect(parsed.layout).toBe('main-horizontal');
    expect(parsed.main_pane_size).toBe(40);
  });

  it('lists orca in the invalid multiplexer value message', () => {
    expect(MULTIPLEXER_INVALID_VALUE_MESSAGE).toContain('orca');
    const result = MultiplexerConfigSchema.safeParse({ type: 'bogus' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('none');
    }
  });
});
