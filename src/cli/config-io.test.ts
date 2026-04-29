/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addPluginToOpenCodeConfig,
  addPluginToOpenCodeTuiConfig,
  detectCurrentConfig,
  disableDefaultAgents,
  enableLspByDefault,
  parseConfig,
  parseConfigFile,
  stripJsonComments,
  writeConfig,
  writeLiteConfig,
} from './config-io';
import * as paths from './paths';

describe('config-io', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'opencode-io-test-'));
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_TUI_CONFIG;
    process.env.XDG_CONFIG_HOME = tmpDir;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    mock.restore();
  });

  function writePackageJson(dir: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-slim' }),
    );
  }

  test('stripJsonComments strips comments and trailing commas', () => {
    const jsonc = `{
      // comment
      "a": 1, /* multi
      line */
      "b": [2,],
    }`;
    const stripped = stripJsonComments(jsonc);
    expect(JSON.parse(stripped)).toEqual({ a: 1, b: [2] });
  });

  test('parseConfigFile parses valid JSON', () => {
    const path = join(tmpDir, 'test.json');
    writeFileSync(path, '{"a": 1}');
    const result = parseConfigFile(path);
    expect(result.config).toEqual({ a: 1 } as any);
    expect(result.error).toBeUndefined();
  });

  test('parseConfigFile returns null for non-existent file', () => {
    const result = parseConfigFile(join(tmpDir, 'nonexistent.json'));
    expect(result.config).toBeNull();
  });

  test('parseConfigFile returns null for empty or whitespace-only file', () => {
    const emptyPath = join(tmpDir, 'empty.json');
    writeFileSync(emptyPath, '');
    expect(parseConfigFile(emptyPath).config).toBeNull();

    const whitespacePath = join(tmpDir, 'whitespace.json');
    writeFileSync(whitespacePath, '   \n  ');
    expect(parseConfigFile(whitespacePath).config).toBeNull();
  });

  test('parseConfigFile returns error for invalid JSON', () => {
    const path = join(tmpDir, 'invalid.json');
    writeFileSync(path, '{"a": 1');
    const result = parseConfigFile(path);
    expect(result.config).toBeNull();
    expect(result.error).toBeDefined();
  });

  test('parseConfig tries .jsonc if .json is missing', () => {
    const jsoncPath = join(tmpDir, 'test.jsonc');
    writeFileSync(jsoncPath, '{"a": 1}');

    // We pass .json path, it should try .jsonc
    const result = parseConfig(join(tmpDir, 'test.json'));
    expect(result.config).toEqual({ a: 1 } as any);
  });

  test('writeConfig writes JSON and creates backup', () => {
    const path = join(tmpDir, 'test.json');
    writeFileSync(path, '{"old": true}');

    writeConfig(path, { new: true } as any);

    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ new: true });
    expect(JSON.parse(readFileSync(`${path}.bak`, 'utf-8'))).toEqual({
      old: true,
    });
  });

  test('addPluginToOpenCodeConfig adds plugin and removes duplicates', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    paths.ensureConfigDir();
    writeFileSync(
      configPath,
      JSON.stringify({ plugin: ['other', 'oh-my-opencode-slim@1.0.0'] }),
    );
    process.argv[1] = '';

    const result = await addPluginToOpenCodeConfig();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toContain('oh-my-opencode-slim');
    expect(saved.plugin).not.toContain('oh-my-opencode-slim@1.0.0');
    expect(saved.plugin.length).toBe(2);
  });

  test('addPluginToOpenCodeConfig stores package name for bunx temp paths', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@latest',
      'node_modules',
      'oh-my-opencode-slim',
    );
    paths.ensureConfigDir();
    writeFileSync(configPath, JSON.stringify({ plugin: [] }));
    writePackageJson(packageRoot);
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const result = await addPluginToOpenCodeConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toEqual(['oh-my-opencode-slim']);
  });

  test('addPluginToOpenCodeConfig stores local repo path for local dev paths', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    const packageRoot = join(tmpDir, 'repo');
    const localCliPath = join(packageRoot, 'dist', 'cli', 'index.js');
    paths.ensureConfigDir();
    writeFileSync(configPath, JSON.stringify({ plugin: [] }));
    writePackageJson(packageRoot);
    process.argv[1] = localCliPath;

    const result = await addPluginToOpenCodeConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toEqual([packageRoot]);
  });

  test('addPluginToOpenCodeConfig stores local repo path for local paths containing bunx-', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    const packageRoot = join(tmpDir, 'repo', 'bunx-tools');
    const localCliPath = join(packageRoot, 'dist', 'cli', 'index.js');
    paths.ensureConfigDir();
    writeFileSync(configPath, JSON.stringify({ plugin: [] }));
    writePackageJson(packageRoot);
    process.argv[1] = localCliPath;

    const result = await addPluginToOpenCodeConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toEqual([packageRoot]);
  });

  test('addPluginToOpenCodeConfig deduplicates existing local repo path entries', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    const packageRoot = join(tmpDir, 'repo');
    const localCliPath = join(packageRoot, 'dist', 'cli', 'index.js');
    paths.ensureConfigDir();
    writePackageJson(packageRoot);
    writeFileSync(
      configPath,
      JSON.stringify({ plugin: ['other', packageRoot] }),
    );
    process.argv[1] = localCliPath;

    const result = await addPluginToOpenCodeConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toEqual(['other', packageRoot]);
  });

  test('addPluginToOpenCodeConfig preserves non-string plugin entries when refreshing', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    paths.ensureConfigDir();
    process.argv[1] = '';

    const objectPlugin = { name: 'some-config-plugin', enabled: true };
    writeFileSync(
      configPath,
      JSON.stringify({
        plugin: ['other-plugin', objectPlugin, 'oh-my-opencode-slim@1.0.0'],
      }),
    );

    const result = await addPluginToOpenCodeConfig();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toContain('oh-my-opencode-slim');
    expect(saved.plugin).toContain('other-plugin');
    expect(saved.plugin).not.toContain('oh-my-opencode-slim@1.0.0');
    // Non-string entries (objects) must survive the plugin refresh
    expect(saved.plugin).toContainEqual(objectPlugin);
    expect(saved.plugin.length).toBe(3);
  });

  test('addPluginToOpenCodeConfig removes tuple plugin entries', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    paths.ensureConfigDir();
    writeFileSync(
      configPath,
      JSON.stringify({
        plugin: ['other', ['oh-my-opencode-slim', { enabled: true }]],
      }),
    );
    process.argv[1] = '';

    const result = await addPluginToOpenCodeConfig();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toEqual(['other', 'oh-my-opencode-slim']);
  });

  test('addPluginToOpenCodeTuiConfig adds plugin to tui.json and removes duplicates', async () => {
    const tuiPath = join(tmpDir, 'opencode', 'tui.json');
    paths.ensureConfigDir();
    writeFileSync(
      tuiPath,
      JSON.stringify({ plugin: ['other', 'oh-my-opencode-slim@1.0.0'] }),
    );
    process.argv[1] = '';

    const result = await addPluginToOpenCodeTuiConfig();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(tuiPath, 'utf-8'));
    expect(saved.plugin).toContain('oh-my-opencode-slim');
    expect(saved.plugin).not.toContain('oh-my-opencode-slim@1.0.0');
    expect(saved.plugin.length).toBe(2);
  });

  test('addPluginToOpenCodeTuiConfig stores package name for bunx temp paths', async () => {
    const tuiPath = join(tmpDir, 'opencode', 'tui.json');
    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@latest',
      'node_modules',
      'oh-my-opencode-slim',
    );
    paths.ensureConfigDir();
    writeFileSync(tuiPath, JSON.stringify({ plugin: [] }));
    writePackageJson(packageRoot);
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const result = await addPluginToOpenCodeTuiConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(tuiPath, 'utf-8'));
    expect(saved.plugin).toEqual(['oh-my-opencode-slim']);
  });

  test('addPluginToOpenCodeTuiConfig removes tuple plugin entries', async () => {
    const tuiPath = join(tmpDir, 'opencode', 'tui.json');
    paths.ensureConfigDir();
    writeFileSync(
      tuiPath,
      JSON.stringify({
        plugin: ['other', ['oh-my-opencode-slim', { enabled: true }]],
      }),
    );
    process.argv[1] = '';

    const result = await addPluginToOpenCodeTuiConfig();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(tuiPath, 'utf-8'));
    expect(saved.plugin).toEqual(['other', 'oh-my-opencode-slim']);
  });

  test('addPluginToOpenCodeTuiConfig honors OPENCODE_TUI_CONFIG', async () => {
    const tuiPath = join(tmpDir, 'custom', 'tui.custom.json');
    process.env.OPENCODE_TUI_CONFIG = tuiPath;
    process.argv[1] = '';

    const result = await addPluginToOpenCodeTuiConfig();
    expect(result.success).toBe(true);
    expect(result.configPath).toBe(tuiPath);

    const saved = JSON.parse(readFileSync(tuiPath, 'utf-8'));
    expect(saved.plugin).toEqual(['oh-my-opencode-slim']);
  });

  test('addPluginToOpenCodeTuiConfig does not bypass OPENCODE_TUI_CONFIG for existing default config', async () => {
    const defaultTuiPath = join(tmpDir, 'opencode', 'tui.jsonc');
    const customTuiPath = join(tmpDir, 'custom', 'tui.json');
    paths.ensureConfigDir();
    writeFileSync(defaultTuiPath, JSON.stringify({ plugin: ['default'] }));
    process.env.OPENCODE_TUI_CONFIG = customTuiPath;
    process.argv[1] = '';

    const result = await addPluginToOpenCodeTuiConfig();
    expect(result.success).toBe(true);
    expect(result.configPath).toBe(customTuiPath);

    const custom = JSON.parse(readFileSync(customTuiPath, 'utf-8'));
    const original = JSON.parse(readFileSync(defaultTuiPath, 'utf-8'));
    expect(custom.plugin).toEqual(['oh-my-opencode-slim']);
    expect(original.plugin).toEqual(['default']);
  });

  test('addPluginToOpenCodeTuiConfig stores local repo path for local dev paths', async () => {
    const tuiPath = join(tmpDir, 'opencode', 'tui.json');
    const packageRoot = join(tmpDir, 'repo');
    const localCliPath = join(packageRoot, 'dist', 'cli', 'index.js');
    paths.ensureConfigDir();
    writeFileSync(tuiPath, JSON.stringify({ plugin: [] }));
    writePackageJson(packageRoot);
    process.argv[1] = localCliPath;

    const result = await addPluginToOpenCodeTuiConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(tuiPath, 'utf-8'));
    expect(saved.plugin).toEqual([packageRoot]);
  });

  test('addPluginToOpenCodeTuiConfig deduplicates existing local repo path entries', async () => {
    const tuiPath = join(tmpDir, 'opencode', 'tui.json');
    const packageRoot = join(tmpDir, 'repo');
    const localCliPath = join(packageRoot, 'dist', 'cli', 'index.js');
    paths.ensureConfigDir();
    writePackageJson(packageRoot);
    writeFileSync(tuiPath, JSON.stringify({ plugin: ['other', packageRoot] }));
    process.argv[1] = localCliPath;

    const result = await addPluginToOpenCodeTuiConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(tuiPath, 'utf-8'));
    expect(saved.plugin).toEqual(['other', packageRoot]);
  });

  test('addPluginToOpenCodeTuiConfig preserves non-string plugin entries when refreshing', async () => {
    const tuiPath = join(tmpDir, 'opencode', 'tui.json');
    paths.ensureConfigDir();
    process.argv[1] = '';

    const objectPlugin = { name: 'some-tui-plugin', enabled: true };
    writeFileSync(
      tuiPath,
      JSON.stringify({
        plugin: ['other-plugin', objectPlugin, 'oh-my-opencode-slim@1.0.0'],
      }),
    );

    const result = await addPluginToOpenCodeTuiConfig();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(tuiPath, 'utf-8'));
    expect(saved.plugin).toContain('oh-my-opencode-slim');
    expect(saved.plugin).toContain('other-plugin');
    expect(saved.plugin).not.toContain('oh-my-opencode-slim@1.0.0');
    // Non-string entries (objects) must survive the plugin refresh
    expect(saved.plugin).toContainEqual(objectPlugin);
    expect(saved.plugin.length).toBe(3);
  });

  test('writeLiteConfig writes lite config with OpenAI preset', () => {
    const litePath = join(tmpDir, 'opencode', 'oh-my-opencode-slim.json');
    paths.ensureConfigDir();

    const result = writeLiteConfig({
      hasTmux: true,
      installSkills: false,
      installCustomSkills: false,
      reset: false,
    });
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(litePath, 'utf-8'));
    expect(saved.$schema).toBe(
      'https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json',
    );
    expect(saved.preset).toBe('openai');
    expect(saved.presets.openai).toBeDefined();
    expect(saved.presets['opencode-go']).toBeDefined();
    expect(saved.tmux.enabled).toBe(true);
  });

  test('writeLiteConfig writes selected preset', () => {
    const litePath = join(tmpDir, 'opencode', 'oh-my-opencode-slim.json');
    paths.ensureConfigDir();

    const result = writeLiteConfig({
      hasTmux: false,
      installSkills: false,
      installCustomSkills: false,
      preset: 'opencode-go',
      reset: false,
    });
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(litePath, 'utf-8'));
    expect(saved.preset).toBe('opencode-go');
    expect(saved.presets.openai).toBeDefined();
    expect(saved.presets['opencode-go'].orchestrator.model).toBe(
      'opencode-go/glm-5.1',
    );
  });

  test('disableDefaultAgents disables explore and general agents', () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    paths.ensureConfigDir();
    writeFileSync(configPath, JSON.stringify({}));

    const result = disableDefaultAgents();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.agent.explore.disable).toBe(true);
    expect(saved.agent.general.disable).toBe(true);
  });

  test('enableLspByDefault sets lsp true when missing', () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    paths.ensureConfigDir();
    writeFileSync(configPath, JSON.stringify({ plugin: ['other'] }));

    const result = enableLspByDefault();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.lsp).toBe(true);
    expect(saved.plugin).toEqual(['other']);
  });

  test('enableLspByDefault preserves explicit lsp config', () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    paths.ensureConfigDir();
    writeFileSync(configPath, JSON.stringify({ lsp: false }));

    const result = enableLspByDefault();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.lsp).toBe(false);
  });

  test('enableLspByDefault does not write when lsp exists', () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    paths.ensureConfigDir();
    writeFileSync(configPath, JSON.stringify({ lsp: false }));

    const result = enableLspByDefault();
    expect(result.success).toBe(true);

    expect(existsSync(`${configPath}.bak`)).toBe(false);
  });

  test('detectCurrentConfig detects installed status', () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    const litePath = join(tmpDir, 'opencode', 'oh-my-opencode-slim.json');
    paths.ensureConfigDir();

    writeFileSync(
      configPath,
      JSON.stringify({
        plugin: ['oh-my-opencode-slim'],
        provider: {
          kimi: {
            npm: '@ai-sdk/openai-compatible',
          },
        },
      }),
    );
    writeFileSync(
      litePath,
      JSON.stringify({
        preset: 'openai',
        presets: {
          openai: {
            orchestrator: { model: 'openai/gpt-4' },
            oracle: { model: 'anthropic/claude-opus-4-6' },
            explorer: { model: 'github-copilot/grok-code-fast-1' },
            librarian: { model: 'zai-coding-plan/glm-4.7' },
          },
        },
        tmux: { enabled: true },
      }),
    );

    const detected = detectCurrentConfig();
    expect(detected.isInstalled).toBe(true);
    expect(detected.hasKimi).toBe(true);
    expect(detected.hasOpenAI).toBe(true);
    expect(detected.hasAnthropic).toBe(true);
    expect(detected.hasCopilot).toBe(true);
    expect(detected.hasZaiPlan).toBe(true);
    expect(detected.hasTmux).toBe(true);
  });

  test('detectCurrentConfig treats local repo path entries as installed', () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    const packageRoot = join(tmpDir, 'repo');
    paths.ensureConfigDir();
    writePackageJson(packageRoot);
    writeFileSync(configPath, JSON.stringify({ plugin: [packageRoot] }));

    const detected = detectCurrentConfig();

    expect(detected.isInstalled).toBe(true);
  });
});
