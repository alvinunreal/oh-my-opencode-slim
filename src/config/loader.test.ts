import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAgentPrompt, loadPluginConfig } from './loader';

// Test deepMerge indirectly through loadPluginConfig behavior
// since deepMerge is not exported

describe('loadPluginConfig', () => {
  let tempDir: string;
  let userConfigDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-test-'));
    userConfigDir = path.join(tempDir, 'user-config');
    originalEnv = { ...process.env };
    // Isolate from real user config
    process.env.XDG_CONFIG_HOME = userConfigDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('returns empty config when no config files exist', () => {
    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const config = loadPluginConfig(projectDir);
    expect(config).toEqual({});
  });

  test('loads project config from .opencode directory', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          oracle: { model: 'test/model' },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('test/model');
  });

  test('ignores invalid config (schema violation or malformed JSON)', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });

    // Test 1: Invalid temperature (out of range)
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ agents: { oracle: { temperature: 5 } } }),
    );
    expect(loadPluginConfig(projectDir)).toEqual({});

    // Test 2: Malformed JSON
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      '{ invalid json }',
    );
    expect(loadPluginConfig(projectDir)).toEqual({});
  });
});

describe('deepMerge behavior', () => {
  let tempDir: string;
  let userConfigDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-test-'));
    userConfigDir = path.join(tempDir, 'user-config');
    originalEnv = { ...process.env };

    // Set XDG_CONFIG_HOME to control user config location
    process.env.XDG_CONFIG_HOME = userConfigDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('merges nested agent configs from user and project', () => {
    // Create user config
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          oracle: { model: 'user/oracle-model', temperature: 0.5 },
          explorer: { model: 'user/explorer-model' },
        },
      }),
    );

    // Create project config (should override/merge with user)
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          oracle: { temperature: 0.8 }, // Override temperature only
          designer: { model: 'project/designer-model' }, // Add new agent
        },
      }),
    );

    const config = loadPluginConfig(projectDir);

    // oracle: model from user, temperature from project
    expect(config.agents?.oracle?.model).toBe('user/oracle-model');
    expect(config.agents?.oracle?.temperature).toBe(0.8);

    // explorer: from user only
    expect(config.agents?.explorer?.model).toBe('user/explorer-model');

    // designer: from project only
    expect(config.agents?.designer?.model).toBe('project/designer-model');
  });

  test('merges nested tmux configs', () => {
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        tmux: {
          enabled: true,
          layout: 'main-vertical',
          main_pane_size: 60,
        },
      }),
    );

    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        tmux: {
          enabled: false, // Override enabled
          layout: 'tiled', // Override layout
        },
      }),
    );

    const config = loadPluginConfig(projectDir);

    expect(config.tmux?.enabled).toBe(false); // From project (override)
    expect(config.tmux?.layout).toBe('tiled'); // From project
    expect(config.tmux?.main_pane_size).toBe(60); // From user (preserved)
  });

  test("preserves user tmux.enabled when project doesn't specify", () => {
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        tmux: {
          enabled: true,
          layout: 'main-vertical',
        },
      }),
    );

    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: { oracle: { model: 'test' } }, // No tmux override
      }),
    );

    const config = loadPluginConfig(projectDir);

    expect(config.tmux?.enabled).toBe(true); // Preserved from user
    expect(config.tmux?.layout).toBe('main-vertical'); // Preserved from user
  });

  test('project config overrides top-level arrays', () => {
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_mcps: ['websearch'],
      }),
    );

    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_mcps: ['context7'],
      }),
    );

    const config = loadPluginConfig(projectDir);

    // disabled_mcps should be from project (overwrites, not merges)
    expect(config.disabled_mcps).toEqual(['context7']);
  });

  test('handles missing user config gracefully', () => {
    // Don't create user config, only project
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          oracle: { model: 'project/model' },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('project/model');
  });

  test('handles missing project config gracefully', () => {
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          oracle: { model: 'user/model' },
        },
      }),
    );

    // No project config
    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('user/model');
  });

  test('merges fallback timeout and chains from user and project', () => {
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        fallback: {
          timeoutMs: 15000,
          chains: {
            oracle: ['openai/gpt-5.2-codex', 'opencode/glm-4.7-free'],
          },
        },
      }),
    );

    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        fallback: {
          chains: {
            explorer: ['google/antigravity-gemini-3-flash'],
          },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.fallback?.timeoutMs).toBe(15000);
    expect(config.fallback?.chains.oracle).toEqual([
      'openai/gpt-5.2-codex',
      'opencode/glm-4.7-free',
    ]);
    expect(config.fallback?.chains.explorer).toEqual([
      'google/antigravity-gemini-3-flash',
    ]);
  });

  test('rejects fallback chains with unsupported agent keys', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        fallback: {
          chains: {
            writing: ['openai/gpt-5.2-codex'],
          },
        },
      }),
    );

    expect(loadPluginConfig(projectDir)).toEqual({});
  });
});

describe('preset resolution', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-test-'));
    originalEnv = { ...process.env };
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user-config');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('backward compatibility: config with only agents works unchanged', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: { oracle: { model: 'direct-model' } },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('direct-model');
    expect(config.preset).toBeUndefined();
  });

  test("preset applied: preset + presets returns preset's agents", () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'fast',
        presets: {
          fast: { oracle: { model: 'fast-model' } },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('fast-model');
  });

  test('root agents override preset agents', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'fast',
        presets: {
          fast: {
            oracle: { model: 'fast-model', temperature: 0.1 },
            explorer: { model: 'explorer-model' },
          },
        },
        agents: {
          oracle: { temperature: 0.9 }, // Should override preset temperature
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('fast-model');
    expect(config.agents?.oracle?.temperature).toBe(0.9);
    expect(config.agents?.explorer?.model).toBe('explorer-model');
  });

  test('missing preset: preset set but not in presets -> returns empty/root agents', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'nonexistent',
        presets: {
          other: { oracle: { model: 'other' } },
        },
        agents: { oracle: { model: 'root' } },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('root');
  });

  test('preset only: no root agents, just preset works', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'dev',
        presets: {
          dev: { oracle: { model: 'dev-model' } },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('dev-model');
  });

  test('invalid preset shape: bad agent config in preset fails schema validation', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });

    // preset agents with invalid temperature
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'invalid',
        presets: {
          invalid: { oracle: { temperature: 5 } },
        },
      }),
    );

    // Should return empty config due to validation failure
    expect(loadPluginConfig(projectDir)).toEqual({});
  });

  test('nonexistent preset from config warns and falls back to root agents', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'nonexistent',
        presets: {
          other: { oracle: { model: 'other' } },
        },
        agents: { oracle: { model: 'root' } },
      }),
    );

    const consoleWarnSpy = spyOn(console, 'warn');
    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('root');
    expect(consoleWarnSpy).toHaveBeenCalled();
    const warningMessage = consoleWarnSpy.mock.calls[0][0] as string;
    expect(warningMessage).toContain('Preset "nonexistent" not found');
    expect(warningMessage).toContain('Available presets: other');
  });

  test('nonexistent preset with no root agents returns empty agents', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'nonexistent',
        presets: {
          other: { oracle: { model: 'other' } },
        },
      }),
    );

    const consoleWarnSpy = spyOn(console, 'warn');
    const config = loadPluginConfig(projectDir);
    expect(config.agents).toBeUndefined();
    expect(consoleWarnSpy).toHaveBeenCalled();
    const warningMessage = consoleWarnSpy.mock.calls[0][0] as string;
    expect(warningMessage).toContain('Preset "nonexistent" not found');
  });
});

describe('environment variable preset override', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-preset-test-'));
    originalEnv = { ...process.env };
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user-config');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('Env var overrides preset from config file', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'config-preset',
        presets: {
          'config-preset': { oracle: { model: 'config-model' } },
          'env-preset': { oracle: { model: 'env-model' } },
        },
      }),
    );

    process.env.OH_MY_OPENCODE_SLIM_PRESET = 'env-preset';
    const config = loadPluginConfig(projectDir);
    expect(config.preset).toBe('env-preset');
    expect(config.agents?.oracle?.model).toBe('env-model');
  });

  test('Env var works when config has no preset', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: {
          'env-preset': { oracle: { model: 'env-model' } },
        },
      }),
    );

    process.env.OH_MY_OPENCODE_SLIM_PRESET = 'env-preset';
    const config = loadPluginConfig(projectDir);
    expect(config.preset).toBe('env-preset');
    expect(config.agents?.oracle?.model).toBe('env-model');
  });

  test('Env var is ignored if empty string', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'config-preset',
        presets: {
          'config-preset': { oracle: { model: 'config-model' } },
        },
      }),
    );

    process.env.OH_MY_OPENCODE_SLIM_PRESET = '';
    const config = loadPluginConfig(projectDir);
    expect(config.preset).toBe('config-preset');
    expect(config.agents?.oracle?.model).toBe('config-model');
  });

  test('Env var is ignored if undefined', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'config-preset',
        presets: {
          'config-preset': { oracle: { model: 'config-model' } },
        },
      }),
    );

    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    const config = loadPluginConfig(projectDir);
    expect(config.preset).toBe('config-preset');
    expect(config.agents?.oracle?.model).toBe('config-model');
  });

  test('Env var with nonexistent preset warns and falls back', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'config-preset',
        presets: {
          'config-preset': { oracle: { model: 'config-model' } },
        },
        agents: { oracle: { model: 'fallback' } },
      }),
    );

    process.env.OH_MY_OPENCODE_SLIM_PRESET = 'typo-preset';
    const consoleWarnSpy = spyOn(console, 'warn');
    const config = loadPluginConfig(projectDir);
    expect(config.preset).toBe('typo-preset');
    expect(config.agents?.oracle?.model).toBe('fallback');
    expect(consoleWarnSpy).toHaveBeenCalled();
    const calls = consoleWarnSpy.mock.calls as string[][];
    const warningMessage =
      calls.find((call) => call[0]?.includes('typo-preset'))?.[0] || '';
    expect(warningMessage).toContain('Preset "typo-preset" not found');
    expect(warningMessage).toContain('environment variable');
    expect(warningMessage).toContain('config-preset');
  });
});

describe('JSONC config support', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonc-test-'));
    originalEnv = { ...process.env };
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user-config');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('loads .jsonc file with single-line comments', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
      `{
        // This is a comment
        "agents": {
          "oracle": { "model": "test/model" } // inline comment
        }
      }`,
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('test/model');
  });

  test('loads .jsonc file with multi-line comments', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
      `{
        /* Multi-line
           comment block */
        "agents": {
          "explorer": { "model": "explorer-model" }
        }
      }`,
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.explorer?.model).toBe('explorer-model');
  });

  test('loads .jsonc file with trailing commas', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
      `{
        "agents": {
          "oracle": { "model": "test-model", },
        },
      }`,
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('test-model');
  });

  test('prefers .jsonc over .json when both exist', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });

    // Create both files
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ agents: { oracle: { model: 'json-model' } } }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
      `{
        // JSONC version
        "agents": { "oracle": { "model": "jsonc-model" } }
      }`,
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('jsonc-model');
  });

  test('falls back to .json when .jsonc does not exist', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });

    // Only create .json file
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ agents: { oracle: { model: 'json-model' } } }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('json-model');
  });

  test('loads user config from .jsonc', () => {
    const userOpencodeDir = path.join(tempDir, 'user-config', 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.jsonc'),
      `{
        // User config with comments
        "agents": { "librarian": { "model": "user-librarian" } }
      }`,
    );

    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.librarian?.model).toBe('user-librarian');
  });

  test('merges user .jsonc with project .jsonc', () => {
    const userOpencodeDir = path.join(tempDir, 'user-config', 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.jsonc'),
      `{
        // User config
        "agents": {
          "oracle": { "model": "user-oracle", "temperature": 0.5 }
        }
      }`,
    );

    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
      `{
        // Project config
        "agents": { "oracle": { "temperature": 0.8 } }
      }`,
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('user-oracle');
    expect(config.agents?.oracle?.temperature).toBe(0.8);
  });

  test('handles complex JSONC with mixed comments and trailing commas', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
      `{
        // Main configuration
        "preset": "dev",
        /* Presets definition */
        "presets": {
          "dev": {
            // Development agents
            "oracle": { "model": "dev-oracle", },
            "explorer": { "model": "dev-explorer", },
          },
        },
        "tmux": {
          "enabled": true, // Enable tmux
          "layout": "main-vertical",
        },
      }`,
    );

    const config = loadPluginConfig(projectDir);
    expect(config.preset).toBe('dev');
    expect(config.agents?.oracle?.model).toBe('dev-oracle');
    expect(config.agents?.explorer?.model).toBe('dev-explorer');
    expect(config.tmux?.enabled).toBe(true);
    expect(config.tmux?.layout).toBe('main-vertical');
  });
});

describe('loadAgentPrompt', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-test-'));
    originalEnv = { ...process.env };
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('returns empty object when no prompt files exist', () => {
    const result = loadAgentPrompt('oracle');
    expect(result).toEqual({});
  });

  test('loads replacement prompt from {agent}.md', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'oracle.md'), 'replacement prompt');

    const result = loadAgentPrompt('oracle');
    expect(result.prompt).toBe('replacement prompt');
    expect(result.appendPrompt).toBeUndefined();
  });

  test('loads append prompt from {agent}_append.md', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'oracle_append.md'),
      'append prompt',
    );

    const result = loadAgentPrompt('oracle');
    expect(result.prompt).toBeUndefined();
    expect(result.appendPrompt).toBe('append prompt');
  });

  test('loads both replacement and append prompts', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'oracle.md'), 'replacement prompt');
    fs.writeFileSync(
      path.join(promptsDir, 'oracle_append.md'),
      'append prompt',
    );

    const result = loadAgentPrompt('oracle');
    expect(result.prompt).toBe('replacement prompt');
    expect(result.appendPrompt).toBe('append prompt');
  });

  test('handles file read errors gracefully', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    const promptPath = path.join(promptsDir, 'error-agent.md');
    fs.writeFileSync(promptPath, 'content');

    const consoleWarnSpy = spyOn(console, 'warn');

    // Use a unique agent name and check for it specifically
    const originalReadFileSync = fs.readFileSync;
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(
      (p: any, o: any) => {
        if (typeof p === 'string' && p.includes('error-agent.md')) {
          throw new Error('Read error');
        }
        return originalReadFileSync(p, o);
      },
    );

    try {
      const result = loadAgentPrompt('error-agent');
      expect(result.prompt).toBeUndefined();

      const warningFound = consoleWarnSpy.mock.calls.some((call) =>
        (call[0] as string).includes('Error reading prompt file'),
      );
      expect(warningFound).toBe(true);
    } finally {
      readSpy.mockRestore();
    }
  });

  test('works with XDG_CONFIG_HOME environment variable', () => {
    const customConfigHome = path.join(tempDir, 'custom-xdg');
    process.env.XDG_CONFIG_HOME = customConfigHome;

    const promptsDir = path.join(
      customConfigHome,
      'opencode',
      'oh-my-opencode-slim',
    );
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'xdg-agent.md'), 'xdg prompt');

    const result = loadAgentPrompt('xdg-agent');
    expect(result.prompt).toBe('xdg prompt');
  });
});
