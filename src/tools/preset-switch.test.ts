import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../config';
import {
  buildPresetSummary,
  deletePreset,
  removeAgentFromPreset,
  setAgentOverride,
  switchPresetOnDisk,
  writePreset,
} from './preset-switch';

let previousXdgDataHome: string | undefined;
let previousXdgConfigHome: string | undefined;
let previousOpenCodeConfigDir: string | undefined;
let tempDir: string;

beforeEach(() => {
  previousXdgDataHome = process.env.XDG_DATA_HOME;
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  previousOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-preset-switch-'));
  process.env.XDG_DATA_HOME = tempDir;
  process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-config');
  delete process.env.OPENCODE_CONFIG_DIR;
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

  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('switchPresetOnDisk', () => {
  test('returns a not-found result for an unknown preset', () => {
    const config: PluginConfig = {
      presets: {
        cheap: {
          agents: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        },
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
        empty: { agents: { orchestrator: {} } },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'empty', config);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('empty');
    expect(result.message).toContain('no agent overrides');
  });

  test('allows marketplace-only preset activation', () => {
    const config: PluginConfig = {
      presets: {
        profiles: {
          agents: {},
          marketplace: {
            agents: ['community/oracle-profile'],
          },
        },
      },
    };

    const result = switchPresetOnDisk(tempDir, 'profiles', config);

    expect(result.ok).toBe(true);
    expect(result.presetName).toBe('profiles');
  });

  test('switches preset and reports a reload-to-apply message', () => {
    const config: PluginConfig = {
      presets: {
        cheap: {
          agents: {
            orchestrator: { model: 'anthropic/claude-3.5-haiku' },
            explorer: { model: 'openai/gpt-5.6-luna' },
          },
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
        cheap: {
          agents: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        },
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
        cheap: {
          agents: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        },
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
        scout: { agents: { explore: { model: 'openai/gpt-5.6-luna' } } },
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
          agents: {
            orchestrator: { model: 'anthropic/claude-3.5-haiku' },
            explorer: {},
            oracle: { temperature: 0.3 },
          },
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
          agents: {
            orchestrator: {
              model: ['anthropic/claude-3.5-haiku', 'openai/gpt-5.6'],
            },
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
          agents: {
            oracle: {
              model: [
                { id: 'anthropic/claude-sonnet-4-6', variant: 'thinking' },
                { id: 'openai/o3' },
              ],
            },
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
          agents: {
            orchestrator: {
              model: 'openai/o3',
              temperature: 0.1,
              options: { thinking: { type: 'enabled', budgetTokens: 10000 } },
            },
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

  test('does not throw when the user config file is missing', () => {
    // No config file on disk; persistPresetName is best-effort.
    const config: PluginConfig = {
      presets: {
        cheap: {
          agents: { orchestrator: { model: 'anthropic/claude-3.5-haiku' } },
        },
      },
    };

    expect(() => switchPresetOnDisk(tempDir, 'cheap', config)).not.toThrow();
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
      agents: { explorer: { model: 'openai/gpt-5.6-luna' } },
    });

    expect(ok).toBe(true);
    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        'utf-8',
      ),
    ) as { presets?: Record<string, unknown> };
    expect(persisted.presets?.scout).toEqual({
      agents: { explorer: { model: 'openai/gpt-5.6-luna' } },
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
        presets: { existing: { agents: { oracle: { model: 'a' } } } },
      })}`,
    );

    const ok = writePreset(tempDir, 'scout', {
      agents: { explorer: { model: 'openai/gpt-5.6-luna' } },
    });

    expect(ok).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      preset?: string;
      presets?: Record<string, unknown>;
    };
    // Existing fields survived, proving the BOM-prefixed file was parsed
    expect(persisted.preset).toBe('old');
    expect(persisted.presets?.existing).toEqual({
      agents: { oracle: { model: 'a' } },
    });
    expect(persisted.presets?.scout).toEqual({
      agents: { explorer: { model: 'openai/gpt-5.6-luna' } },
    });
  });

  test('overwrites an existing preset of the same name', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: { scout: { agents: { orchestrator: { model: 'old' } } } },
      }),
    );

    writePreset(tempDir, 'scout', {
      agents: { oracle: { model: 'new' } },
    });

    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        'utf-8',
      ),
    ) as { presets?: Record<string, unknown> };
    expect(persisted.presets?.scout).toEqual({
      agents: { oracle: { model: 'new' } },
    });
  });

  test('writes into a freshly empty user config', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(path.join(configDir, 'oh-my-opencode-slim.json'), '{}');

    const ok = writePreset(tempDir, 'solo', {
      agents: { orchestrator: { model: 'x' } },
    });

    expect(ok).toBe(true);
    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        'utf-8',
      ),
    ) as { presets?: Record<string, unknown> };
    expect(persisted.presets?.solo).toEqual({
      agents: { orchestrator: { model: 'x' } },
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
          scout: { agents: { orchestrator: { model: 'a' } } },
          keep: { agents: { oracle: { model: 'b' } } },
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
    expect(persisted.presets).toEqual({
      keep: { agents: { oracle: { model: 'b' } } },
    });
  });

  test('clears the active preset field when deleting the active preset', () => {
    const configDir = path.join(tempDir, 'opencode-config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'scout',
        presets: { scout: { agents: { orchestrator: { model: 'a' } } } },
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
      JSON.stringify({
        presets: { keep: { agents: { orchestrator: { model: 'a' } } } },
      }),
    );

    expect(deletePreset(tempDir, 'missing')).toBe(false);
  });

  test('returns false when no config file exists', () => {
    expect(deletePreset(tempDir, 'anything')).toBe(false);
  });
});

describe('setAgentOverride / removeAgentFromPreset', () => {
  test('setAgentOverride adds a new agent immutably', () => {
    const preset = { agents: { orchestrator: { model: 'a' } } };
    const next = setAgentOverride(preset, 'oracle', { model: 'b' });
    expect(next).toEqual({
      agents: {
        orchestrator: { model: 'a' },
        oracle: { model: 'b' },
      },
    });
    expect(preset).toEqual({ agents: { orchestrator: { model: 'a' } } });
  });

  test('setAgentOverride replaces an existing agent', () => {
    const preset = { agents: { orchestrator: { model: 'a' } } };
    const next = setAgentOverride(preset, 'orchestrator', {
      model: 'b',
      variant: 'thinking',
    });
    expect(next).toEqual({
      agents: { orchestrator: { model: 'b', variant: 'thinking' } },
    });
  });

  test('removeAgentFromPreset removes an agent immutably', () => {
    const preset = {
      agents: {
        orchestrator: { model: 'a' },
        oracle: { model: 'b' },
      },
    };
    const next = removeAgentFromPreset(preset, 'oracle');
    expect(next).toEqual({ agents: { orchestrator: { model: 'a' } } });
    expect(preset).toEqual({
      agents: {
        orchestrator: { model: 'a' },
        oracle: { model: 'b' },
      },
    });
  });

  test('removeAgentFromPreset is a no-op for absent agents', () => {
    const preset = { agents: { orchestrator: { model: 'a' } } };
    expect(removeAgentFromPreset(preset, 'oracle')).toBe(preset);
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
});
