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

it('validates the opt-in question timeout boundaries', () => {
  // Mutation: remove the zero exception, integer constraint, or bounds.
  expect(PluginConfigSchema.safeParse({ questionTimeoutMs: 0 }).success).toBe(
    true,
  );
  expect(
    PluginConfigSchema.safeParse({ questionTimeoutMs: 60_000 }).success,
  ).toBe(true);
  expect(
    PluginConfigSchema.safeParse({ questionTimeoutMs: 1_200_000 }).success,
  ).toBe(true);
  expect(
    PluginConfigSchema.safeParse({ questionTimeoutMs: 2_147_483_647 }).success,
  ).toBe(true);
  expect(
    PluginConfigSchema.safeParse({ questionTimeoutMs: 59_999 }).success,
  ).toBe(false);
  expect(PluginConfigSchema.safeParse({ questionTimeoutMs: 1.5 }).success).toBe(
    false,
  );
  expect(PluginConfigSchema.safeParse({ questionTimeoutMs: -1 }).success).toBe(
    false,
  );
  expect(
    PluginConfigSchema.safeParse({ questionTimeoutMs: 2_147_483_648 }).success,
  ).toBe(false);
});

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

describe('PluginConfigSchema fallback settings', () => {
  it('keeps only effective native fallback settings', () => {
    expect(PluginConfigSchema.parse({ fallback: {} }).fallback).toEqual({
      enabled: true,
      maxRetries: 3,
      retryDelayMs: 500,
    });
    expect(
      PluginConfigSchema.parse({
        fallback: { enabled: false, maxRetries: 7, retryDelayMs: 125 },
      }).fallback,
    ).toEqual({ enabled: false, maxRetries: 7, retryDelayMs: 125 });
  });

  it('rejects removed fallback keys instead of pretending they work', () => {
    for (const fallback of [
      { continuationPolicy: 'retry-primary' },
      { initialRetryDelayMs: 0 },
      { continuationPolicy: 'stick-to-fallback', initialRetryDelayMs: 100 },
    ]) {
      expect(PluginConfigSchema.safeParse({ fallback }).success).toBe(false);
    }
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
      'tool-loop-guard',
      'search-path-guard',
      'absolute-path-rescue',
      'apply-patch',
      'council-inject',
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
        disabled_hooks: ['council-inject', 'phase-reminder'],
      }).success,
    ).toBe(true);
    expect(
      PluginConfigSchema.safeParse({ disabled_hooks: ['auto-update-checker'] })
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

  it('accepts autoUpdate as the only update switch', () => {
    for (const autoUpdate of [false, true]) {
      const result = PluginConfigSchema.safeParse({ autoUpdate });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.autoUpdate).toBe(autoUpdate);
      }
    }
  });
});

describe('PluginConfigSchema webfetch', () => {
  it('accepts the canonical disabled_tools switch on and off', () => {
    for (const disabled_tools of [[], ['ast_grep_search'], ['webfetch']]) {
      const result = PluginConfigSchema.safeParse({ disabled_tools });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.disabled_tools).toEqual(disabled_tools);
        expect('webfetch' in result.data).toBe(false);
      }
    }
  });

  it('rejects the removed webfetch config block in a direct parse', () => {
    for (const webfetch of [
      {},
      { enabled: false },
      { model: 'openai/gpt-4o-mini' },
    ]) {
      expect(PluginConfigSchema.safeParse({ webfetch }).success).toBe(false);
    }
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
      agents: ['*'],
    });
  });

  it('defaults agents to ["*"] and keeps the three documented shapes', () => {
    expect(MultiplexerConfigSchema.parse({}).agents).toEqual(['*']);
    expect(
      MultiplexerConfigSchema.parse({ agents: ['*', '!explorer'] }).agents,
    ).toEqual(['*', '!explorer']);
    expect(
      MultiplexerConfigSchema.parse({ agents: ['oracle', 'fixer'] }).agents,
    ).toEqual(['oracle', 'fixer']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('disables pane management for a non-array agents value', () => {
    const result = PluginConfigSchema.safeParse({
      multiplexer: { type: 'tmux', agents: 'explorer' },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.multiplexer?.type).toBe('none');
      // The invalid key is dropped, so the documented default applies.
      expect(result.data.multiplexer?.agents).toEqual(['*']);
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('Invalid multiplexer config value');
    expect(message).toContain('agents');
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
      'rex',
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

  it('keeps sidebarShowHiddenAgents optional and accepts both values', () => {
    const omitted = PluginConfigSchema.safeParse({});
    const shown = PluginConfigSchema.safeParse({
      sidebarShowHiddenAgents: true,
    });
    const hidden = PluginConfigSchema.safeParse({
      sidebarShowHiddenAgents: false,
    });

    expect(omitted.success).toBe(true);
    expect(shown.success).toBe(true);
    expect(hidden.success).toBe(true);
    if (omitted.success) {
      expect(omitted.data.sidebarShowHiddenAgents).toBeUndefined();
    }
    if (shown.success) {
      expect(shown.data.sidebarShowHiddenAgents).toBe(true);
    }
    if (hidden.success) {
      expect(hidden.data.sidebarShowHiddenAgents).toBe(false);
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
  });

  afterEach(() => warnSpy.mockRestore());

  it('keeps mode absent by default and accepts native and off', () => {
    expect(
      PluginConfigSchema.parse({ backgroundJobs: {} }).backgroundJobs?.mode,
    ).toBeUndefined();
    for (const mode of ['native', 'off'] as const) {
      expect(
        PluginConfigSchema.parse({ backgroundJobs: { mode } }).backgroundJobs
          ?.mode,
      ).toBe(mode);
    }
  });

  it('drops invalid mode without discarding the rest of the layer (#1291)', () => {
    const raw = {
      backgroundJobs: { mode: 'bogus' },
      agents: { oracle: { model: 'valid/model' } },
    };
    const before = JSON.stringify(raw);
    const result = PluginConfigSchema.parse(raw);
    expect(result.backgroundJobs?.mode).toBeUndefined();
    expect(result.agents?.oracle?.model).toBe('valid/model');
    expect(JSON.stringify(raw)).toBe(before);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('mode');
  });

  it('drops a non-object backgroundJobs value without discarding the layer', () => {
    const result = PluginConfigSchema.parse({
      backgroundJobs: 'invalid',
      agents: { oracle: { model: 'valid/model' } },
    });
    expect(result.backgroundJobs).toEqual({});
    expect(result.agents?.oracle?.model).toBe('valid/model');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores inherited names and JSON __proto__ without polluting prototypes', () => {
    const raw = JSON.parse(
      '{"backgroundJobs":{"__proto__":{"polluted":true},"constructor":"nope","toString":1,"mode":"off"}}',
    );
    expect(PluginConfigSchema.parse(raw).backgroundJobs?.mode).toBe('off');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    'maxSessionsPerAgent',
    'stopConfirmationMs',
    'wallClockTimeoutMs',
    'concurrency',
    'sameProviderPolicy',
    'waitForUserGuard',
    'childInputWake',
    'childInputWakeKinds',
    'pruneEvictedSessions',
  ] as const)(
    'rejects retired backgroundJobs.%s at the schema boundary',
    (key) => {
      const result = PluginConfigSchema.safeParse({
        backgroundJobs: { [key]: 0 },
      });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['backgroundJobs', key],
            message: expect.stringContaining(
              'removed with the managed lifecycle',
            ),
          }),
        );
    },
  );

  it('rejects every removed board key', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        strategy: 'latest',
        maxRetainedSnapshots: 20,
        boardInjection: true,
        maxContextLines: 10,
        readContextMinLines: 1,
        readContextMaxFiles: 2,
        abortGraceMs: 10000,
      },
    });
    expect(result.success).toBe(false);
  });

  it.each(['boardInjection', 'abortGraceMs'] as const)(
    'rejects removed backgroundJobs.%s independently',
    (key) => {
      const result = PluginConfigSchema.safeParse({
        backgroundJobs: { [key]: key === 'boardInjection' ? true : 10000 },
      });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['backgroundJobs', key],
            message: expect.stringContaining(`${key} was removed`),
          }),
        );
    },
  );

  it('rejects the removed enabled alias and names backgroundJobs.mode', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: { enabled: false },
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['backgroundJobs', 'enabled'],
          message: expect.stringContaining('use backgroundJobs.mode'),
        }),
      );
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

  it('rejects the removed backgroundJobs.enabled alias with the mode hint', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: { enabled: true },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.map((issue) => issue.message).join('\n'),
      ).toContain(
        'backgroundJobs.enabled was removed; use backgroundJobs.mode',
      );
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

  it('accepts rex and lists it in the invalid multiplexer value message', () => {
    expect(MultiplexerConfigSchema.parse({ type: 'rex' }).type).toBe('rex');
    expect(MULTIPLEXER_INVALID_VALUE_MESSAGE).toContain('rex');
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

describe('retired config keys', () => {
  it('does not advertise routingBlock or agent subagents', () => {
    const schema = z.toJSONSchema(PluginConfigSchema, { io: 'input' });
    expect(schema.properties).not.toHaveProperty('routingBlock');
    expect(PluginConfigSchema.parse({ routingBlock: false })).toEqual({});
    expect(
      PluginConfigSchema.safeParse({
        agents: { orchestrator: { model: 'x/y', subagents: ['fixer'] } },
      }).success,
    ).toBe(false);
  });
});
