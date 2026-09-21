import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../config';
import {
  buildPresetSummary,
  deletePreset,
  findPresetDependents,
  getEditablePreset,
  getPresetSource,
  removeAgentFromPreset,
  setAgentOverride,
  switchPresetOnDisk,
  wouldCreatePresetCycle,
  writePreset,
} from './preset-switch';

let previousXdgDataHome: string | undefined;
let previousXdgConfigHome: string | undefined;
let previousOpenCodeConfigDir: string | undefined;
let previousPresetEnv: string | undefined;
let tempDir: string;

beforeEach(() => {
  previousXdgDataHome = process.env.XDG_DATA_HOME;
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  previousOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  previousPresetEnv = process.env.OH_MY_OPENCODE_SLIM_PRESET;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-preset-switch-'));
  process.env.XDG_DATA_HOME = tempDir;
  process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-config');
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.OH_MY_OPENCODE_SLIM_PRESET;

  const userConfigDir = path.join(tempDir, 'xdg-config', 'opencode');
  fs.mkdirSync(userConfigDir, { recursive: true });
  fs.writeFileSync(path.join(userConfigDir, 'oh-my-opencode-slim.json'), '{}');
});

afterEach(() => {
  if (previousXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = previousXdgDataHome;
  }

  if (previousXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }

  if (previousOpenCodeConfigDir === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR;
  } else {
    process.env.OPENCODE_CONFIG_DIR = previousOpenCodeConfigDir;
  }

  if (previousPresetEnv === undefined) {
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  } else {
    process.env.OH_MY_OPENCODE_SLIM_PRESET = previousPresetEnv;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('switchPresetOnDisk', () => {
  test('returns a not-found result for an unknown preset', () => {
    const config: PluginConfig = {
      presets: {
        cheap: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'nonexistent', config);

    expect(result.ok).toBe(false);
    expect(result.presetName).toBe('nonexistent');
    expect(result.message).toContain('not found');
    expect(result.message).toContain('cheap');
    expect(result.summary).toEqual([]);
  });

  test('not-found result lists no-presets hint when none configured', () => {
    const config: PluginConfig = {};

    const result = switchPresetOnDisk(tempDir, 'cheap', config);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('not found');
    expect(result.message).toContain('No presets configured');
  });

  test('returns an empty result when the preset has no valid overrides', () => {
    const config: PluginConfig = {
      presets: {
        empty: { orchestrator: {} },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'empty', config);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('empty');
    expect(result.message).toContain('no agent overrides');
  });

  test('switches preset and reports a reload-to-apply message', () => {
    const config: PluginConfig = {
      presets: {
        cheap: {
          orchestrator: { model: 'anthropic/claude-3.5-haiku' },
          explorer: { model: 'openai/gpt-5.6-luna' },
        },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'cheap', config);

    expect(result.ok).toBe(true);
    expect(result.presetName).toBe('cheap');
    expect(result.message).toContain('Saved preset "cheap"');
    expect(result.message).toContain('Reload OpenCode');
    expect(result.message).toContain(
      'current session keeps its existing agent models',
    );
    expect(result.summary).toContain(
      'orchestrator → model: anthropic/claude-3.5-haiku',
    );
    expect(result.summary).toContain('explorer → model: openai/gpt-5.6-luna');
  });

  test('persists preset name to a JSONC user config file', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;

    const configPath = path.join(configDir, 'oh-my-opencode-slim.jsonc');
    fs.writeFileSync(
      configPath,
      `{
        // User-selected preset should be updated even in JSONC files.
        "preset": "old",
        "agents": {
          "orchestrator": { "model": "old-model" },
        },
      }`,
    );

    const config: PluginConfig = {
      presets: {
        cheap: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
      },
    };

    switchPresetOnDisk(tempDir, 'cheap', config);

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      preset?: string;
      agents?: Record<string, unknown>;
    };
    expect(persisted.preset).toBe('cheap');
    expect(persisted.agents).toEqual({
      orchestrator: { model: 'old-model' },
    });
  });

  test('persists preset name when the user config has a UTF-8 BOM', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;

    const configPath = path.join(configDir, 'oh-my-opencode-slim.json');
    fs.writeFileSync(
      configPath,
      `\uFEFF${JSON.stringify({
        preset: 'old',
        agents: { oracle: { model: 'old-model' } },
      })}`,
    );

    const config: PluginConfig = {
      presets: {
        cheap: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'cheap', config);
    expect(result.ok).toBe(true);

    // The BOM is stripped on read, so the preset name is persisted; the
    // rewritten file is plain JSON that parses cleanly.
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      preset?: string;
      agents?: Record<string, unknown>;
    };
    expect(persisted.preset).toBe('cheap');
    expect(persisted.agents).toEqual({ oracle: { model: 'old-model' } });
  });

  test('resolves legacy alias keys (explore → explorer)', () => {
    const config: PluginConfig = {
      presets: {
        scout: { explore: { model: 'openai/gpt-5.6-luna' } },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'scout', config);

    expect(result.ok).toBe(true);
    expect(result.summary.some((l) => l.startsWith('explorer →'))).toBe(true);
  });

  test('skips agents with empty overrides in a mixed preset', () => {
    const config: PluginConfig = {
      presets: {
        mixed: {
          orchestrator: { model: 'anthropic/claude-3.5-haiku' },
          explorer: {},
          oracle: { temperature: 0.3 },
        },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'mixed', config);

    expect(result.ok).toBe(true);
    expect(result.summary.some((l) => l.startsWith('orchestrator →'))).toBe(
      true,
    );
    expect(result.summary.some((l) => l.startsWith('oracle →'))).toBe(true);
    // explorer has no usable override and must not appear in the summary
    expect(result.summary.some((l) => l.startsWith('explorer →'))).toBe(false);
  });

  test('resolves array-form model to the first string entry', () => {
    const config: PluginConfig = {
      presets: {
        fallback: {
          orchestrator: {
            model: ['anthropic/claude-3.5-haiku', 'openai/gpt-5.6'],
          },
        },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'fallback', config);

    expect(result.ok).toBe(true);
    expect(result.summary).toContain(
      'orchestrator → model: anthropic/claude-3.5-haiku',
    );
  });

  test('resolves array-form model with object entries and inline variant', () => {
    const config: PluginConfig = {
      presets: {
        thinker: {
          oracle: {
            model: [
              { id: 'anthropic/claude-sonnet-4-6', variant: 'thinking' },
              { id: 'openai/o3' },
            ],
          },
        },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'thinker', config);

    expect(result.ok).toBe(true);
    expect(result.summary).toContain(
      'oracle → model: anthropic/claude-sonnet-4-6 → variant: thinking',
    );
  });

  test('includes temperature and options in the summary', () => {
    const config: PluginConfig = {
      presets: {
        precise: {
          orchestrator: {
            model: 'openai/o3',
            temperature: 0.1,
            options: { thinking: { type: 'enabled', budgetTokens: 10000 } },
          },
        },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'precise', config);

    expect(result.ok).toBe(true);
    expect(result.summary).toContain(
      'orchestrator → model: openai/o3 → temp: 0.1 → options: yes',
    );
  });

  test('applies an inheritance-only child preset and returns base agent summary', () => {
    const config: PluginConfig = {
      presets: {
        base: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        child: { extends: 'base', agents: {} },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'child', config);

    expect(result.ok).toBe(true);
    expect(result.presetName).toBe('child');
    expect(result.summary).toContain(
      'orchestrator → model: anthropic/claude-3.5-haiku',
    );
  });

  test('applies child preset with overrides and returns merged effective summary', () => {
    const config: PluginConfig = {
      presets: {
        base: {
          orchestrator: { model: 'anthropic/claude-3.5-haiku' },
          oracle: { model: 'openai/gpt-5.6-luna' },
        },
        child: {
          extends: 'base',
          agents: {
            orchestrator: { model: 'openai/o3' },
          },
        },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'child', config);

    expect(result.ok).toBe(true);
    expect(result.presetName).toBe('child');
    expect(result.summary).toContain('orchestrator → model: openai/o3');
    expect(result.summary).toContain('oracle → model: openai/gpt-5.6-luna');
  });

  test('fails cleanly when preset extends a missing parent', () => {
    const config: PluginConfig = {
      presets: {
        child: { extends: 'missing_parent', agents: {} },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'child', config);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('missing preset "missing_parent"');
  });

  test('fails cleanly when preset inheritance contains a cycle', () => {
    const config: PluginConfig = {
      presets: {
        a: { extends: 'b', agents: {} },
        b: { extends: 'a', agents: {} },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'a', config);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('inheritance cycle detected');
  });

  test('fails when the user config file is missing', () => {
    fs.rmSync(path.join(tempDir, 'xdg-config', 'opencode'), {
      recursive: true,
      force: true,
    });

    const config: PluginConfig = {
      presets: {
        cheap: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'cheap', config);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('No user config file was found');
    expect(result.message).not.toContain('Saved preset');
  });

  test('fails when the user config file is malformed', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      '{ invalid json',
    );

    const config: PluginConfig = {
      presets: {
        cheap: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'cheap', config);

    expect(result.ok).toBe(false);
    expect(result.message).toContain(
      'Could not read or parse the user config file',
    );
    expect(result.message).not.toContain('Saved preset');
  });

  test('fails when writing the user config file fails', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      '{"preset":"old"}',
    );

    const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('permission denied');
    });
    try {
      const result = switchPresetOnDisk(tempDir, 'cheap', {
        presets: {
          cheap: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        },
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain('Could not write the user config file');
      expect(result.message).toContain('permission denied');
      expect(result.message).not.toContain('Saved preset');
    } finally {
      writeSpy.mockRestore();
    }
  });

  test('applies preset with only non-model fields (inheritModelFrom, skills, permission)', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      '{"preset":"initial"}',
    );

    const config: PluginConfig = {
      presets: {
        skillsOnly: {
          orchestrator: {
            inheritModelFrom: 'oracle',
            skills: ['code-review'],
            permission: 'read',
          },
        },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'skillsOnly', config);

    expect(result.ok).toBe(true);
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.summary[0]).toContain('inherit: oracle');
    expect(result.summary[0]).toContain('skills: code-review');
    expect(result.summary[0]).toContain('permissions: yes');

    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        'utf-8',
      ),
    ) as { preset?: string };
    expect(persisted.preset).toBe('skillsOnly');
  });

  test('rejects switching when project config explicitly sets a different preset', () => {
    const projectDir = path.join(tempDir, '.opencode');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'oh-my-opencode-slim.jsonc'),
      JSON.stringify({
        preset: 'project-preset',
      }),
    );

    const config: PluginConfig = {
      presets: {
        'user-choice': {
          orchestrator: { model: 'anthropic/claude-3.5-haiku' },
        },
        'project-preset': {
          orchestrator: { model: 'openai/gpt-5' },
        },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'user-choice', config);

    expect(result.ok).toBe(false);
    expect(result.message).toContain(
      'project config (.opencode) explicitly sets preset "project-preset"',
    );
    expect(result.message).toContain('takes precedence on reload');
  });

  test('allows switching when project config explicitly sets the same preset', () => {
    const projectDir = path.join(tempDir, '.opencode');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'oh-my-opencode-slim.jsonc'),
      JSON.stringify({
        preset: 'shared-preset',
      }),
    );

    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(path.join(configDir, 'oh-my-opencode-slim.json'), '{}');

    const config: PluginConfig = {
      presets: {
        'shared-preset': {
          orchestrator: { model: 'anthropic/claude-3.5-haiku' },
        },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'shared-preset', config);

    expect(result.ok).toBe(true);
  });

  test('allows switching when project preset resolves from an environment variable', () => {
    const projectPresetEnv = 'OMOS_PROJECT_PRESET';
    const previousProjectPreset = process.env[projectPresetEnv];
    process.env[projectPresetEnv] = 'shared-preset';
    try {
      const projectDir = path.join(tempDir, '.opencode');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'oh-my-opencode-slim.jsonc'),
        JSON.stringify({ preset: `{env:${projectPresetEnv}}` }),
      );

      const result = switchPresetOnDisk(tempDir, 'shared-preset', {
        presets: {
          'shared-preset': {
            orchestrator: { model: 'anthropic/claude-3.5-haiku' },
          },
        },
      });

      expect(result.ok).toBe(true);
    } finally {
      if (previousProjectPreset === undefined) {
        delete process.env[projectPresetEnv];
      } else {
        process.env[projectPresetEnv] = previousProjectPreset;
      }
    }
  });

  test('blocks switching when the expanded project preset differs', () => {
    const projectPresetEnv = 'OMOS_PROJECT_PRESET';
    const previousProjectPreset = process.env[projectPresetEnv];
    process.env[projectPresetEnv] = 'project-preset';
    try {
      const projectDir = path.join(tempDir, '.opencode');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'oh-my-opencode-slim.jsonc'),
        JSON.stringify({ preset: `{env:${projectPresetEnv}}` }),
      );

      const result = switchPresetOnDisk(tempDir, 'user-choice', {
        presets: {
          'user-choice': {
            orchestrator: { model: 'anthropic/claude-3.5-haiku' },
          },
        },
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain(
        'project config (.opencode) explicitly sets preset "project-preset"',
      );
    } finally {
      if (previousProjectPreset === undefined) {
        delete process.env[projectPresetEnv];
      } else {
        process.env[projectPresetEnv] = previousProjectPreset;
      }
    }
  });

  test('allows switching when the project preset environment variable is missing', () => {
    const projectPresetEnv = 'OMOS_MISSING_PROJECT_PRESET';
    const previousProjectPreset = process.env[projectPresetEnv];
    delete process.env[projectPresetEnv];
    try {
      const projectDir = path.join(tempDir, '.opencode');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'oh-my-opencode-slim.jsonc'),
        JSON.stringify({ preset: `{env:${projectPresetEnv}}` }),
      );

      const result = switchPresetOnDisk(tempDir, 'user-choice', {
        presets: {
          'user-choice': {
            orchestrator: { model: 'anthropic/claude-3.5-haiku' },
          },
        },
      });

      expect(result.ok).toBe(true);
    } finally {
      if (previousProjectPreset === undefined) {
        delete process.env[projectPresetEnv];
      } else {
        process.env[projectPresetEnv] = previousProjectPreset;
      }
    }
  });

  test('rejects switching when the environment selects a different preset', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    const configPath = path.join(configDir, 'oh-my-opencode-slim.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ preset: 'old', presets: { old: {}, selected: {} } }),
    );
    process.env.OH_MY_OPENCODE_SLIM_PRESET = 'env-selected';

    const config: PluginConfig = {
      presets: {
        selected: {
          orchestrator: { model: 'anthropic/claude-3.5-haiku' },
        },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'selected', config);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('OH_MY_OPENCODE_SLIM_PRESET');
    expect(result.message).toContain('"env-selected"');
    expect(result.message).toContain('takes precedence on reload');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({
      preset: 'old',
      presets: { old: {}, selected: {} },
    });
  });
});

describe('writePreset', () => {
  test('creates a new preset in the user config file', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      '{"preset":"old"}',
    );

    const ok = writePreset(tempDir, 'scout', {
      explorer: { model: 'openai/gpt-5.6-luna' },
    });

    expect(ok).toBe(true);
    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        'utf-8',
      ),
    ) as { presets?: Record<string, unknown> };
    expect(persisted.presets?.scout).toEqual({
      explorer: { model: 'openai/gpt-5.6-luna' },
    });
    // existing fields preserved
    expect(persisted.preset).toBe('old');
  });

  test('reads a user config with a UTF-8 BOM before writing', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    const configPath = path.join(configDir, 'oh-my-opencode-slim.json');
    fs.writeFileSync(
      configPath,
      `\uFEFF${JSON.stringify({
        preset: 'old',
        presets: { existing: { oracle: { model: 'a' } } },
      })}`,
    );

    const ok = writePreset(tempDir, 'scout', {
      explorer: { model: 'openai/gpt-5.6-luna' },
    });

    expect(ok).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      preset?: string;
      presets?: Record<string, unknown>;
    };
    // Existing fields survived, proving the BOM-prefixed file was parsed
    expect(persisted.preset).toBe('old');
    expect(persisted.presets?.existing).toEqual({ oracle: { model: 'a' } });
    expect(persisted.presets?.scout).toEqual({
      explorer: { model: 'openai/gpt-5.6-luna' },
    });
  });

  test('overwrites an existing preset of the same name', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: { scout: { orchestrator: { model: 'old' } } },
      }),
    );

    writePreset(tempDir, 'scout', {
      oracle: { model: 'new' },
    });

    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        'utf-8',
      ),
    ) as { presets?: Record<string, unknown> };
    expect(persisted.presets?.scout).toEqual({ oracle: { model: 'new' } });
  });

  test('writes into a freshly empty user config', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(path.join(configDir, 'oh-my-opencode-slim.json'), '{}');

    const ok = writePreset(tempDir, 'solo', {
      orchestrator: { model: 'x' },
    });

    expect(ok).toBe(true);
    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        'utf-8',
      ),
    ) as { presets?: Record<string, unknown> };
    expect(persisted.presets?.solo).toEqual({ orchestrator: { model: 'x' } });
  });

  test('preserves local extends and only local agents when writing preset definition', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: {
          base: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        },
      }),
    );

    const ok = writePreset(tempDir, 'child', {
      extends: 'base',
      agents: { explorer: { model: 'openai/gpt-5.6-luna' } },
    });

    expect(ok).toBe(true);
    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        'utf-8',
      ),
    ) as { presets?: Record<string, unknown> };

    // Does NOT materialize orchestrator from base; keeps extends and local agents only
    expect(persisted.presets?.child).toEqual({
      extends: 'base',
      agents: { explorer: { model: 'openai/gpt-5.6-luna' } },
    });
  });

  test('writes inheritance-only child preset with extends and empty agents', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(path.join(configDir, 'oh-my-opencode-slim.json'), '{}');

    const ok = writePreset(tempDir, 'child', {
      extends: 'base',
      agents: {},
    });

    expect(ok).toBe(true);
    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        'utf-8',
      ),
    ) as { presets?: Record<string, unknown> };

    expect(persisted.presets?.child).toEqual({
      extends: 'base',
      agents: {},
    });
  });
});

describe('deletePreset', () => {
  test('removes a preset and returns true', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: {
          scout: { orchestrator: { model: 'a' } },
          keep: { oracle: { model: 'b' } },
        },
      }),
    );

    const ok = deletePreset(tempDir, 'scout');

    expect(ok).toBe(true);
    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        'utf-8',
      ),
    ) as { presets?: Record<string, unknown> };
    expect(persisted.presets).toEqual({ keep: { oracle: { model: 'b' } } });
  });

  test('clears the active preset field when deleting the active preset', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'scout',
        presets: { scout: { orchestrator: { model: 'a' } } },
      }),
    );

    deletePreset(tempDir, 'scout');

    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        'utf-8',
      ),
    ) as { preset?: string; presets?: Record<string, unknown> };
    expect(persisted.preset).toBeUndefined();
    expect(persisted.presets).toEqual({});
  });

  test('returns false when the preset does not exist', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ presets: { keep: { orchestrator: { model: 'a' } } } }),
    );

    expect(deletePreset(tempDir, 'missing')).toBe(false);
  });

  test('returns false when no config file exists', () => {
    expect(deletePreset(tempDir, 'anything')).toBe(false);
  });

  test('rejects deleting a base preset that has dependents in editable user config', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: {
          base: { orchestrator: { model: 'a' } },
          child: { extends: 'base', agents: {} },
        },
      }),
    );

    const ok = deletePreset(tempDir, 'base');

    expect(ok).toBe(false);
    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        'utf-8',
      ),
    ) as { presets?: Record<string, unknown> };
    // base was NOT deleted
    expect(persisted.presets?.base).toBeDefined();
    expect(persisted.presets?.child).toBeDefined();
  });

  test('successfully deletes a base preset once its dependents are removed', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: {
          base: { orchestrator: { model: 'a' } },
          child: { extends: 'base', agents: {} },
        },
      }),
    );

    // Delete dependent first
    const deletedChild = deletePreset(tempDir, 'child');
    expect(deletedChild).toBe(true);

    // Now deleting base succeeds
    const deletedBase = deletePreset(tempDir, 'base');
    expect(deletedBase).toBe(true);

    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        'utf-8',
      ),
    ) as { presets?: Record<string, unknown> };
    expect(persisted.presets?.base).toBeUndefined();
  });

  test('rejects deleting a base preset that has dependents in project config', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: {
          baseInUser: { orchestrator: { model: 'a' } },
        },
      }),
    );

    const projectDir = path.join(tempDir, '.opencode');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'oh-my-opencode-slim.jsonc'),
      JSON.stringify({
        presets: {
          childInProject: { extends: 'baseInUser', agents: {} },
        },
      }),
    );

    const ok = deletePreset(tempDir, 'baseInUser');

    expect(ok).toBe(false);
    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        'utf-8',
      ),
    ) as { presets?: Record<string, unknown> };
    expect(persisted.presets?.baseInUser).toBeDefined();
  });
});

describe('findPresetDependents', () => {
  test('returns names of presets directly extending the base', () => {
    const presets = {
      base: { orchestrator: { model: 'a' } },
      child1: { extends: 'base', agents: {} },
      child2: { extends: 'base', orchestrator: { model: 'b' } },
      other: { extends: 'something_else', agents: {} },
      standalone: { orchestrator: { model: 'c' } },
    };

    const dependents = findPresetDependents('base', presets);

    expect(dependents.sort()).toEqual(['child1', 'child2']);
  });

  test('returns empty array when no dependents exist', () => {
    const presets = {
      base: { orchestrator: { model: 'a' } },
      standalone: { orchestrator: { model: 'c' } },
    };

    expect(findPresetDependents('base', presets)).toEqual([]);
  });
});

describe('wouldCreatePresetCycle', () => {
  test('prevents self-inheritance', () => {
    const presets = {
      alpha: { orchestrator: { model: 'a' } },
    };

    expect(wouldCreatePresetCycle('alpha', 'alpha', presets)).toBe(true);
  });

  test('detects 2-element cycle (A -> B -> A)', () => {
    const presets = {
      alpha: { orchestrator: { model: 'a' } },
      beta: { extends: 'alpha', agents: {} },
    };

    // If alpha extends beta, cycle: alpha -> beta -> alpha
    expect(wouldCreatePresetCycle('alpha', 'beta', presets)).toBe(true);
    // Beta extending another standalone preset is fine
    expect(wouldCreatePresetCycle('beta', 'other', presets)).toBe(false);
  });

  test('detects multi-element cycle (A -> B -> C -> A)', () => {
    const presets = {
      a: { orchestrator: { model: 'a' } },
      b: { extends: 'a', agents: {} },
      c: { extends: 'b', agents: {} },
    };

    // If a extends c: a -> c -> b -> a
    expect(wouldCreatePresetCycle('a', 'c', presets)).toBe(true);
    // If a extends b: a -> b -> a
    expect(wouldCreatePresetCycle('a', 'b', presets)).toBe(true);
    // If c extends a: already in hierarchy, extending a creates c -> a -> c
    expect(wouldCreatePresetCycle('c', 'a', presets)).toBe(false); // c extending a simply points higher up (c -> a is a tree without cycle)
  });

  test('allows valid inheritance without cycles', () => {
    const presets = {
      base: { orchestrator: { model: 'a' } },
      child: { orchestrator: { model: 'b' } },
    };

    expect(wouldCreatePresetCycle('child', 'base', presets)).toBe(false);
  });
});

describe('getEditablePreset', () => {
  test('returns local extends and local agents only, without materializing inherited agents', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: {
          base: {
            orchestrator: { model: 'anthropic/claude-3.5-haiku' },
            oracle: { model: 'openai/o3' },
          },
          child: {
            extends: 'base',
            agents: {
              explorer: { model: 'openai/gpt-5.6-luna' },
            },
          },
        },
      }),
    );

    const editable = getEditablePreset(tempDir, 'child');

    expect(editable.extends).toBe('base');
    // ONLY explorer is returned as local agent; orchestrator and oracle are NOT materialized
    expect(editable.agents).toEqual({
      explorer: { model: 'openai/gpt-5.6-luna' },
    });
  });

  test('returns empty preset definition for nonexistent preset', () => {
    const editable = getEditablePreset(tempDir, 'nonexistent');

    expect(editable.extends).toBeUndefined();
    expect(editable.agents).toEqual({});
  });
});

describe('setAgentOverride / removeAgentFromPreset', () => {
  test('setAgentOverride adds a new agent immutably', () => {
    const preset = { orchestrator: { model: 'a' } };
    const next = setAgentOverride(preset, 'oracle', { model: 'b' });
    expect(next).toEqual({
      orchestrator: { model: 'a' },
      oracle: { model: 'b' },
    });
    expect(preset).toEqual({ orchestrator: { model: 'a' } });
  });

  test('setAgentOverride replaces an existing agent', () => {
    const preset = { orchestrator: { model: 'a' } };
    const next = setAgentOverride(preset, 'orchestrator', {
      model: 'b',
      variant: 'thinking',
    });
    expect(next).toEqual({
      orchestrator: { model: 'b', variant: 'thinking' },
    });
  });

  test('removeAgentFromPreset removes an agent immutably', () => {
    const preset = {
      orchestrator: { model: 'a' },
      oracle: { model: 'b' },
    };
    const next = removeAgentFromPreset(preset, 'oracle');
    expect(next).toEqual({ orchestrator: { model: 'a' } });
    expect(preset).toEqual({
      orchestrator: { model: 'a' },
      oracle: { model: 'b' },
    });
  });

  test('removeAgentFromPreset is a no-op for absent agents', () => {
    const preset = { orchestrator: { model: 'a' } };
    expect(removeAgentFromPreset(preset, 'oracle')).toBe(preset);
  });
});

describe('getPresetSource', () => {
  test('classifies presets as project, user, or none', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: {
          userOnly: { orchestrator: { model: 'a' } },
          both: { orchestrator: { model: 'from-user' } },
        },
      }),
    );

    const projectDir = path.join(tempDir, '.opencode');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'oh-my-opencode-slim.jsonc'),
      JSON.stringify({
        presets: {
          projectOnly: { orchestrator: { model: 'b' } },
          both: { orchestrator: { model: 'from-project' } },
        },
      }),
    );

    expect(getPresetSource(tempDir, 'projectOnly')).toBe('project');
    expect(getPresetSource(tempDir, 'both')).toBe('project');
    expect(getPresetSource(tempDir, 'userOnly')).toBe('user');
    expect(getPresetSource(tempDir, 'missing')).toBe('none');
  });
});

describe('buildPresetSummary', () => {
  test('orders fields as model, variant, temp, options', () => {
    const summary = buildPresetSummary({
      oracle: {
        model: 'anthropic/claude-sonnet-4-6',
        variant: 'thinking',
        temperature: 0.2,
        options: { thinking: { type: 'enabled' } },
      },
    });

    expect(summary).toEqual([
      'oracle → model: anthropic/claude-sonnet-4-6 → variant: thinking → temp: 0.2 → options: yes',
    ]);
  });

  test('formats non-model fields including inherit, skills, mcps, and permissions', () => {
    const summary = buildPresetSummary({
      orchestrator: {
        inheritModelFrom: 'oracle',
        skills: ['code-review', 'ast-grep'],
        skills_add: ['extra-skill'],
        skills_remove: ['removed-skill'],
        skills_include_local: true,
        mcps: ['github', 'fetch'],
        prompt: 'system instructions',
        permission: { edit: 'allow' },
      },
    });

    expect(summary).toEqual([
      'orchestrator → inherit: oracle → skills: code-review,ast-grep → skills_add: extra-skill → skills_remove: removed-skill → skills_include_local: true → mcps: github,fetch → prompt: yes → permissions: yes',
    ]);
  });
});
