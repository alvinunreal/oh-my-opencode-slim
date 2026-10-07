import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigLoadWarning } from './loader';
import {
  findPluginConfigPaths,
  getPluginConfigCandidates,
  loadAgentPrompt,
  loadPluginConfig,
} from './loader';

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
    delete process.env.OPENCODE_CONFIG_DIR;
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

  function writeProjectConfig(directory: string, config: unknown): string {
    const configDir = path.join(directory, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    const filename = path.join(configDir, 'oh-my-opencode-slim.json');
    fs.writeFileSync(filename, JSON.stringify(config));
    return filename;
  }

  test('inherits custom agents when loading from a nested Git worktree', () => {
    const workspace = path.join(tempDir, 'workspace');
    const repo = path.join(workspace, 'repo');
    const worktree = path.join(repo, '.slim', 'worktrees', 'feature');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ../../../.git');
    const configPath = writeProjectConfig(workspace, {
      preset: 'shared',
      presets: { shared: { fixer: { model: 'test/fixer' } } },
      agents: {
        'backend-fixer': {
          model: 'test/backend',
          prompt: 'Implement backend changes.',
          skills: [],
          mcps: [],
        },
      },
    });

    expect(loadPluginConfig(worktree, { hostFlavor: 'v2' })).toEqual(
      loadPluginConfig(workspace, { hostFlavor: 'v2' }),
    );
    expect(
      loadPluginConfig(worktree, { hostFlavor: 'v2' }).agents?.['backend-fixer']
        ?.prompt,
    ).toBe('Implement backend changes.');
    const paths = findPluginConfigPaths(worktree, 'v2');
    expect(paths.projectConfigPaths).toEqual([configPath]);
    // Discovery for reads must not redirect project-scoped writes to parents.
    expect(paths.projectConfigPath).toBeNull();
  });

  test('merges global and all ancestor configs from farthest to closest', () => {
    const workspace = path.join(tempDir, 'workspace');
    const repo = path.join(workspace, 'repo');
    const nested = path.join(repo, 'packages', 'backend');
    const globalDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: { fixer: { model: 'test/global', mcps: ['context7'] } },
        disabled_tools: ['global-tool'],
      }),
    );
    const outerPath = writeProjectConfig(workspace, {
      preset: 'shared',
      presets: { shared: { oracle: { model: 'test/oracle' } } },
      agents: { fixer: { model: 'test/workspace', variant: 'high' } },
      disabled_tools: ['workspace-tool'],
    });
    const repoPath = writeProjectConfig(repo, {
      presets: { shared: { oracle: { temperature: 0.4 } } },
      agents: { fixer: { model: 'test/repo', skills: ['simplify'] } },
    });
    const nestedPath = writeProjectConfig(nested, {
      agents: { fixer: { model: 'test/nested', mcps: [] } },
      disabled_tools: [],
    });

    const config = loadPluginConfig(nested);
    expect(config.agents?.fixer).toMatchObject({
      model: 'test/nested',
      variant: 'high',
      skills: ['simplify'],
      mcps: [],
    });
    expect(config.agents?.oracle).toMatchObject({
      model: 'test/oracle',
      temperature: 0.4,
    });
    expect(config.disabled_tools).toEqual([]);
    expect(findPluginConfigPaths(nested).projectConfigPaths).toEqual([
      outerPath,
      repoPath,
      nestedPath,
    ]);
    expect(findPluginConfigPaths(nested).projectConfigPath).toBe(nestedPath);
  });

  test('prefers JSONC independently at each ancestor level', () => {
    const workspace = path.join(tempDir, 'workspace');
    const nested = path.join(workspace, 'nested');
    const outerJson = writeProjectConfig(workspace, {
      agents: { fixer: { model: 'test/ignored-outer-json' } },
    });
    const nestedJson = writeProjectConfig(nested, {
      agents: { fixer: { model: 'test/ignored-nested-json' } },
    });
    fs.writeFileSync(
      `${outerJson}c`,
      '{ "agents": { "fixer": { "model": "test/outer-jsonc", } } }',
    );
    fs.writeFileSync(
      `${nestedJson}c`,
      '{ "agents": { "fixer": { "variant": "high", } } }',
    );

    expect(loadPluginConfig(nested).agents?.fixer).toMatchObject({
      model: 'test/outer-jsonc',
      variant: 'high',
    });
    expect(findPluginConfigPaths(nested).projectConfigPaths).toEqual([
      `${outerJson}c`,
      `${nestedJson}c`,
    ]);
  });

  test('reports an invalid ancestor without discarding valid layers', () => {
    const workspace = path.join(tempDir, 'workspace');
    const repo = path.join(workspace, 'repo');
    const nested = path.join(repo, 'nested');
    writeProjectConfig(workspace, {
      agents: { fixer: { model: 'test/inherited' } },
    });
    const invalidPath = writeProjectConfig(repo, {});
    fs.writeFileSync(invalidPath, '{ invalid');
    writeProjectConfig(nested, { agents: { fixer: { variant: 'high' } } });
    const warnings: ConfigLoadWarning[] = [];

    const config = loadPluginConfig(nested, {
      silent: true,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(config.agents?.fixer).toMatchObject({
      model: 'test/inherited',
      variant: 'high',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      path: invalidPath,
      kind: 'invalid-json',
    });
  });

  test('attributes inherited preset errors to the layer defining the broken parent', () => {
    const workspace = path.join(tempDir, 'workspace');
    const nested = path.join(workspace, 'repo', 'worktree');
    const ancestorPath = writeProjectConfig(workspace, {
      presets: {
        broken: { extends: 'missing', fixer: { model: 'test/model' } },
      },
    });
    writeProjectConfig(nested, {
      presets: {
        broken: { fixer: { variant: 'high' } },
        child: { extends: 'broken', fixer: { temperature: 0.3 } },
      },
    });
    const warnings: ConfigLoadWarning[] = [];
    loadPluginConfig(nested, {
      silent: true,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(warnings).toHaveLength(2);
    expect(warnings.every((warning) => warning.path === ancestorPath)).toBe(
      true,
    );
    expect(
      warnings.every((warning) =>
        warning.message.includes('extends missing preset'),
      ),
    ).toBe(true);
  });

  test('attributes missing selected presets to the ancestor pin rather than a closer file', () => {
    const workspace = path.join(tempDir, 'workspace');
    const nested = path.join(workspace, 'repo', 'worktree');
    const ancestorPath = writeProjectConfig(workspace, { preset: 'missing' });
    writeProjectConfig(nested, { agents: { fixer: { model: 'test/model' } } });
    const warnings: ConfigLoadWarning[] = [];
    loadPluginConfig(nested, {
      silent: true,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      path: ancestorPath,
      kind: 'missing-preset',
    });
  });

  test('does not inherit sibling configs and resolves relative locations', () => {
    const workspace = path.join(tempDir, 'workspace');
    const repo = path.join(workspace, 'repo');
    const sibling = path.join(workspace, 'sibling');
    fs.mkdirSync(repo, { recursive: true });
    writeProjectConfig(workspace, {
      agents: { fixer: { model: 'test/base' } },
    });
    writeProjectConfig(sibling, {
      agents: { fixer: { model: 'test/sibling' } },
    });

    expect(loadPluginConfig(repo).agents?.fixer?.model).toBe('test/base');
    const relative = path.relative(process.cwd(), repo);
    expect(loadPluginConfig(relative)).toEqual(loadPluginConfig(repo));
  });

  test('enumerates absent ancestor candidates through the filesystem root', () => {
    const nested = path.join(tempDir, 'workspace', 'repo', 'nested');
    const { project } = getPluginConfigCandidates(nested);
    const directories: string[] = [];
    let current = path.resolve(nested);
    for (;;) {
      directories.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    expect(project).toEqual(
      directories.flatMap((directory) => [
        path.join(directory, '.opencode', 'oh-my-opencode-slim.jsonc'),
        path.join(directory, '.opencode', 'oh-my-opencode-slim.json'),
      ]),
    );
    expect(new Set(project).size).toBe(project.length);
  });

  test('loads autoUpdate flag when configured', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        autoUpdate: false,
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.autoUpdate).toBe(false);
  });

  test('loads config with a UTF-8 BOM prefix (same result as no BOM)', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      `\uFEFF${JSON.stringify({
        preset: 'fast',
        presets: { fast: { oracle: { model: 'fast-model' } } },
        agents: { oracle: { temperature: 0.9 } },
        autoUpdate: false,
      })}`,
    );

    const config = loadPluginConfig(projectDir);

    // The BOM is stripped silently (RFC 8259 permits one); every setting
    // survives, including preset resolution.
    expect(config.autoUpdate).toBe(false);
    expect(config.agents?.oracle?.model).toBe('fast-model');
    expect(config.agents?.oracle?.temperature).toBe(0.9);
  });

  test('deep-merges webfetch settings across user and project configs', () => {
    const userConfigPath = path.join(userConfigDir, 'opencode');
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(userConfigPath, { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigPath, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        webfetch: { model: 'user/provider-model' },
      }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        webfetch: { enabled: true },
      }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    expect(config.webfetch).toEqual({
      enabled: true,
      model: 'user/provider-model',
    });
  });

  test('retains user interview settings when project partially overrides them', () => {
    const userConfigPath = path.join(userConfigDir, 'opencode');
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(userConfigPath, { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigPath, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        interview: {
          maxQuestions: 7,
          outputFolder: 'user-interviews',
          autoOpenBrowser: false,
          port: 1234,
          dashboard: true,
          printState: true,
        },
      }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ interview: { outputFolder: 'project-interviews' } }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    expect(config.interview).toEqual({
      maxQuestions: 7,
      outputFolder: 'project-interviews',
      autoOpenBrowser: false,
      port: 1234,
      dashboard: true,
      printState: true,
    });
  });

  test('lets a project layer override the user printState interview flag', () => {
    const userConfigPath = path.join(userConfigDir, 'opencode');
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(userConfigPath, { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigPath, 'oh-my-opencode-slim.json'),
      JSON.stringify({ interview: { printState: true } }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ interview: { printState: false } }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    expect(config.interview?.printState).toBe(false);
  });

  test('does not let a defaulted project webfetch enabled override user false', () => {
    const userConfigPath = path.join(userConfigDir, 'opencode');
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(userConfigPath, { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigPath, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        webfetch: { enabled: false },
      }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        webfetch: { model: 'project/provider-model' },
      }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    expect(config.webfetch).toEqual({
      enabled: false,
      model: 'project/provider-model',
    });
  });

  test('a project-layer backgroundJobs bad key sanitizes away without overriding a valid user value (#1291)', () => {
    const userConfigPath = path.join(userConfigDir, 'opencode');
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(userConfigPath, { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigPath, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        backgroundJobs: {
          maxSessionsPerAgent: 8,
          orchestratorWake: { intervalMs: 120_000 },
        },
      }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        backgroundJobs: {
          // Above the schema max: dropped, and must not be resurrected as an
          // explicit default that overrides the valid user value.
          maxSessionsPerAgent: 16,
          strategy: 'checkpoint-compatible',
          // A bad nested key drops only itself; valid wake siblings still
          // override the user layer.
          orchestratorWake: { intervalMs: 1_000, enabled: false },
        },
      }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    expect(config.backgroundJobs?.maxSessionsPerAgent).toBe(8);
    expect(config.backgroundJobs?.strategy).toBe('checkpoint-compatible');
    expect(config.backgroundJobs?.orchestratorWake?.intervalMs).toBe(120_000);
    expect(config.backgroundJobs?.orchestratorWake?.enabled).toBe(false);
  });

  test('validates auto image routing after project enables Observer', () => {
    const userConfigPath = path.join(userConfigDir, 'opencode');
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(userConfigPath, { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigPath, 'oh-my-opencode-slim.json'),
      JSON.stringify({ image_routing: 'auto' }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ disabled_agents: [] }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });
    expect(config.image_routing).toBe('auto');
    expect(config.disabled_agents).toEqual([]);
  });

  test('validates auto image routing after project enables it', () => {
    const userConfigPath = path.join(userConfigDir, 'opencode');
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(userConfigPath, { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigPath, 'oh-my-opencode-slim.json'),
      JSON.stringify({ disabled_agents: [] }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ image_routing: 'auto' }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });
    expect(config.image_routing).toBe('auto');
    expect(config.disabled_agents).toEqual([]);
  });

  test('warns but preserves config when final auto routing disables Observer', () => {
    const userConfigPath = path.join(userConfigDir, 'opencode');
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(userConfigPath, { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigPath, 'oh-my-opencode-slim.json'),
      JSON.stringify({ image_routing: 'auto' }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        autoUpdate: false,
        disabled_agents: ['observer'],
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      silent: true,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(config.image_routing).toBe('auto');
    expect(config.autoUpdate).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(
      'image_routing "auto" requires observer to be enabled',
    );
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

  test('accepts prompt on built-in agents and rejects orchestratorPrompt on orchestrator in config files', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });

    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          oracle: {
            model: 'openai/gpt-6',
            prompt: 'This is now allowed for built-in agents.',
          },
        },
      }),
    );

    const loaded = loadPluginConfig(projectDir);
    expect(loaded.agents?.oracle?.prompt).toBe(
      'This is now allowed for built-in agents.',
    );

    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          orchestrator: {
            model: 'openai/gpt-6',
            orchestratorPrompt: 'This must be rejected.',
          },
        },
      }),
    );
    expect(loadPluginConfig(projectDir)).toEqual({});
  });

  test('respects OPENCODE_CONFIG_DIR for user config location', () => {
    const customDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omc-opencode-config-'),
    );
    process.env.OPENCODE_CONFIG_DIR = customDir;

    // Write plugin config in the custom directory
    fs.writeFileSync(
      path.join(customDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: { oracle: { model: 'custom/model-from-opencode-config-dir' } },
      }),
    );

    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe(
      'custom/model-from-opencode-config-dir',
    );

    fs.rmSync(customDir, { recursive: true, force: true });
  });

  test('falls back to default user config dir when OPENCODE_CONFIG_DIR has no config', () => {
    const customDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omc-opencode-config-empty-'),
    );
    process.env.OPENCODE_CONFIG_DIR = customDir;

    const defaultConfigDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(defaultConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(defaultConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: { oracle: { model: 'fallback/default-config' } },
      }),
    );

    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('fallback/default-config');

    fs.rmSync(customDir, { recursive: true, force: true });
  });

  test('project multiplexer keys still override the user layer when explicitly set', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(path.join(userConfigDir, 'opencode'), {
      recursive: true,
    });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigDir, 'opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({
        multiplexer: { type: 'tmux', viewer: 'mini' },
      }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        multiplexer: { type: 'herdr', viewer: 'tui' },
      }),
    );

    const config = loadPluginConfig(projectDir);

    expect(config.multiplexer).toEqual({
      type: 'herdr',
      layout: 'main-vertical',
      main_pane_size: 60,
      viewer: 'tui',
    });
  });

  test('invalid project viewer disables panes without overriding the user viewer', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(path.join(userConfigDir, 'opencode'), { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigDir, 'opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({ multiplexer: { type: 'tmux', viewer: 'tui' } }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ multiplexer: { viewer: 'nano' } }),
    );
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(loadPluginConfig(projectDir).multiplexer).toEqual({
        type: 'none',
        layout: 'main-vertical',
        main_pane_size: 60,
        viewer: 'tui',
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('project main_pane_size does not reset the user multiplexer type', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(path.join(userConfigDir, 'opencode'), {
      recursive: true,
    });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigDir, 'opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({
        multiplexer: { type: 'tmux', layout: 'tiled', viewer: 'mini' },
      }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        multiplexer: { main_pane_size: 40 },
      }),
    );

    const config = loadPluginConfig(projectDir);

    expect(config.multiplexer).toEqual({
      type: 'tmux',
      layout: 'tiled',
      main_pane_size: 40,
      viewer: 'mini',
    });
  });
});

describe('onWarning callback', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onwarning-test-'));
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('invalid schema calls onWarning with invalid-schema', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ agents: { oracle: { temperature: 5 } } }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('invalid-schema');
    expect(warnings[0]?.path).toBe(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
    );
    expect(warnings[0]?.message).toBe('Config does not match schema');
    expect(config).toEqual({});
  });

  test('invalid JSON calls onWarning with invalid-json', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      '{ invalid json }',
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('invalid-json');
    expect(warnings[0]?.path).toBe(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
    );
    expect(config).toEqual({});
  });

  test('silent option suppresses console warnings', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      '{ invalid json }',
    );

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const warnings: ConfigLoadWarning[] = [];
      const config = loadPluginConfig(projectDir, {
        silent: true,
        onWarning: (warning) => warnings.push(warning),
      });

      expect(warnings).toHaveLength(1);
      expect(config).toEqual({});
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('read error calls onWarning with read-error', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    const configPath = path.join(projectConfigDir, 'oh-my-opencode-slim.json');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({}));

    const originalReadFileSync = fs.readFileSync;
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      const [filePath] = args;
      if (filePath === configPath) {
        const error = new Error('Permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }

      return originalReadFileSync(...args);
    }) as typeof fs.readFileSync);

    try {
      const warnings: ConfigLoadWarning[] = [];
      const config = loadPluginConfig(projectDir, {
        onWarning: (warning) => warnings.push(warning),
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.kind).toBe('read-error');
      expect(warnings[0]?.path).toBe(configPath);
      expect(warnings[0]?.message).toBe('Permission denied');
      expect(config).toEqual({});
    } finally {
      readSpy.mockRestore();
    }
  });

  test('missing preset calls onWarning with missing-preset', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'nonexistent',
        presets: { other: { oracle: { model: 'other' } } },
        agents: { oracle: { model: 'root' } },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('missing-preset');
    expect(warnings[0]?.message).toContain('Preset "nonexistent" not found');
    expect(config.agents?.oracle?.model).toBe('root');
  });

  test('silent: true on missing preset still calls onWarning but not console.warn', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'nonexistent',
        presets: { other: { oracle: { model: 'other' } } },
        agents: { oracle: { model: 'root' } },
      }),
    );

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const warnings: ConfigLoadWarning[] = [];
      const config = loadPluginConfig(projectDir, {
        silent: true,
        onWarning: (warning) => warnings.push(warning),
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.kind).toBe('missing-preset');
      expect(config.agents?.oracle?.model).toBe('root');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('valid config does not call onWarning', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ agents: { oracle: { model: 'valid/model' } } }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(warnings).toHaveLength(0);
    expect(config.agents?.oracle?.model).toBe('valid/model');
  });

  test('loads a council with spaced model IDs without an invalid-schema warning', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: { oracle: { model: 'openai/gpt-6-luna' } },
        council: {
          default_preset: 'spaced',
          presets: {
            spaced: {
              scalar: { model: 'of/MiniMax M3' },
              fallback: {
                model: [
                  'of/Kimi K2.6',
                  {
                    id: 'opencode-omniroute-live/of/Qwen3.8 27b',
                    variant: 'high',
                  },
                ],
              },
            },
          },
        },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(warnings).toEqual([]);
    expect(config.agents?.oracle?.model).toBe('openai/gpt-6-luna');
    expect(config.council?.presets.spaced?.scalar?.model).toBe('of/MiniMax M3');
    expect(config.council?.presets.spaced?.fallback?.models).toEqual([
      { id: 'of/Kimi K2.6', variant: undefined },
      {
        id: 'opencode-omniroute-live/of/Qwen3.8 27b',
        variant: 'high',
      },
    ]);
  });

  test('deprecated tmux key calls onWarning with deprecated-key and still loads', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        tmux: { enabled: true, layout: 'main-vertical' },
        agents: { oracle: { model: 'valid/model' } },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('deprecated-key');
    expect(warnings[0]?.message).toContain('Deprecated tmux config key');
    expect(config.agents?.oracle?.model).toBe('valid/model');
  });

  test('deprecated council.master key calls onWarning with deprecated-key and still loads', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        council: {
          master: { model: 'openai/gpt-6' },
          presets: {
            default: {
              alpha: { model: 'openai/gpt-6-luna' },
            },
          },
        },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('deprecated-key');
    expect(warnings[0]?.message).toContain(
      'Deprecated council.master config key',
    );
    expect(config.council?.presets?.default?.alpha?.model).toBe(
      'openai/gpt-6-luna',
    );
  });

  test('migrates deprecated backgroundJobs.continueOnIdle and warns', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        autoUpdate: false,
        backgroundJobs: {
          continueOnIdle: false,
          orchestratorWake: { intervalMs: 120_000 },
        },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      silent: true,
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.backgroundJobs?.orchestratorWake).toEqual({
      enabled: false,
      intervalMs: 120_000,
      mode: 'auto',
      periodicWakeEnabled: true,
      wakeOnTerminalPublication: true,
      publicationWakeMinIntervalMs: 30_000,
    });
    expect(config.backgroundJobs).not.toHaveProperty('continueOnIdle');
    expect(config.autoUpdate).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('deprecated-key');
    expect(warnings[0]?.message).toContain(
      'Deprecated backgroundJobs.continueOnIdle',
    );
  });

  test('passes explicit terminal-publication wake and stop-confirmation knobs through', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        backgroundJobs: {
          orchestratorWake: {
            wakeOnTerminalPublication: false,
            publicationWakeMinIntervalMs: 120_000,
          },
          stopConfirmationMs: 15_000,
        },
      }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    expect(config.backgroundJobs?.orchestratorWake).toEqual({
      enabled: true,
      intervalMs: 300_000,
      mode: 'auto',
      periodicWakeEnabled: true,
      wakeOnTerminalPublication: false,
      publicationWakeMinIntervalMs: 120_000,
    });
    expect(config.backgroundJobs?.stopConfirmationMs).toBe(15_000);
  });

  test('v2 host flavor derives lean board/wake defaults when no layer configures them', () => {
    const projectDir = path.join(tempDir, 'project');
    const config = loadPluginConfig(projectDir, {
      silent: true,
      hostFlavor: 'v2',
    });

    expect(config.backgroundJobs?.boardInjection).toBe(false);
    expect(config.backgroundJobs?.orchestratorWake.periodicWakeEnabled).toBe(
      false,
    );
    // Event-driven wakes and every other channel keep their schema defaults.
    expect(config.backgroundJobs?.orchestratorWake.enabled).toBe(true);
    expect(
      config.backgroundJobs?.orchestratorWake.wakeOnTerminalPublication,
    ).toBe(true);
    expect(config.backgroundJobs?.childInputWake).toBe(true);
  });

  test('v2 host flavor never overrides explicitly configured board/wake keys', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        backgroundJobs: {
          boardInjection: true,
          orchestratorWake: { periodicWakeEnabled: true },
        },
      }),
    );

    const config = loadPluginConfig(projectDir, {
      silent: true,
      hostFlavor: 'v2',
    });

    expect(config.backgroundJobs?.boardInjection).toBe(true);
    expect(config.backgroundJobs?.orchestratorWake.periodicWakeEnabled).toBe(
      true,
    );
  });

  test('explicit v2 opt-out still holds and v1 hosts keep board/wake defaults', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        backgroundJobs: {
          boardInjection: false,
          orchestratorWake: { periodicWakeEnabled: false },
        },
      }),
    );

    const v2Config = loadPluginConfig(projectDir, {
      silent: true,
      hostFlavor: 'v2',
    });
    expect(v2Config.backgroundJobs?.boardInjection).toBe(false);
    expect(v2Config.backgroundJobs?.orchestratorWake.periodicWakeEnabled).toBe(
      false,
    );

    const v1Config = loadPluginConfig(projectDir, { silent: true });
    expect(v1Config.backgroundJobs?.boardInjection).toBe(false);
    expect(v1Config.backgroundJobs?.orchestratorWake.periodicWakeEnabled).toBe(
      false,
    );
  });

  test('prefers explicit orchestratorWake.enabled over deprecated continueOnIdle', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        backgroundJobs: {
          continueOnIdle: false,
          orchestratorWake: { enabled: true },
        },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      silent: true,
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.backgroundJobs?.orchestratorWake.enabled).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('deprecated-key');
  });

  test('preserves migrated continueOnIdle across a partial project override', () => {
    const userConfigPath = path.join(tempDir, 'opencode');
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(userConfigPath, { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigPath, 'oh-my-opencode-slim.json'),
      JSON.stringify({ backgroundJobs: { continueOnIdle: false } }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        backgroundJobs: { strategy: 'checkpoint-compatible' },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      silent: true,
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.backgroundJobs?.orchestratorWake.enabled).toBe(false);
    expect(config.backgroundJobs?.strategy).toBe('checkpoint-compatible');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('deprecated-key');
  });

  test('both deprecated keys fire two warnings', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        tmux: { enabled: true },
        council: {
          master: { model: 'openai/gpt-6' },
          presets: {
            default: {
              alpha: { model: 'openai/gpt-6-luna' },
            },
          },
        },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(warnings).toHaveLength(2);
    const messages = warnings.map((w) => w.message);
    expect(messages.some((m) => m.includes('Deprecated tmux'))).toBe(true);
    expect(messages.some((m) => m.includes('Deprecated council.master'))).toBe(
      true,
    );
  });

  test('no options object does not break loadPluginConfig', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ agents: { oracle: { model: 'model' } } }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('model');
  });

  test('normalizes string disabled_tools instead of rejecting the config', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_tools: 'not-an-array',
        agents: { oracle: { model: 'test/model' } },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    // String is normalized to a single-element array, rest of config loads
    expect(config.disabled_tools).toEqual(['not-an-array']);
    expect(config.agents?.oracle?.model).toBe('test/model');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('normalized');
    expect(warnings[0]?.message).toContain('should be an array; normalized');
  });

  test('drops object disabled_agents instead of rejecting the config', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_agents: { invalid: 'object' },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    // Non-array, non-string value is dropped; the config still loads
    expect(config.disabled_agents).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('normalized');
    expect(warnings[0]?.message).toContain(
      'must be an array; ignoring invalid value',
    );
  });

  test('drops number disabled_mcps instead of rejecting the config', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_mcps: 123,
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.disabled_mcps).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('normalized');
    expect(warnings[0]?.message).toContain(
      'must be an array; ignoring invalid value',
    );
  });

  test('drops boolean disabled_skills instead of rejecting the config', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_skills: true,
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.disabled_skills).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('normalized');
    expect(warnings[0]?.message).toContain(
      'must be an array; ignoring invalid value',
    );
  });

  test('normalizes string disabled_commands instead of rejecting the config', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_commands: 'reflect',
        agents: { oracle: { model: 'test/model' } },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    // String is normalized to a single-element array, rest of config loads
    expect(config.disabled_commands).toEqual(['reflect']);
    expect(config.agents?.oracle?.model).toBe('test/model');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('normalized');
    expect(warnings[0]?.message).toContain('should be an array; normalized');
  });

  test('drops boolean disabled_hooks instead of rejecting the config', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_hooks: false,
        agents: { oracle: { model: 'test/model' } },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    // Non-array, non-string value is dropped; the config still loads
    expect(config.disabled_hooks).toBeUndefined();
    expect(config.agents?.oracle?.model).toBe('test/model');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('normalized');
    expect(warnings[0]?.message).toContain(
      'must be an array; ignoring invalid value',
    );
  });

  test('strips invalid string disabled_hooks values instead of rejecting the config', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_hooks: 'auto-update-checker',
        disabled_tools: ['webfetch'],
        agents: { oracle: { model: 'test/model' } },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    // String is normalized to an array; every entry is unknown, so the key
    // is dropped entirely (siblings and the rest of the config still load)
    expect(config.disabled_hooks).toBeUndefined();
    expect(config.disabled_tools).toEqual(['webfetch']);
    expect(config.agents?.oracle?.model).toBe('test/model');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.kind).toBe('normalized');
    expect(warnings[0]?.message).toContain('should be an array; normalized');
    expect(warnings[1]?.kind).toBe('normalized');
    expect(warnings[1]?.message).toContain(
      'contains only unknown values (["auto-update-checker"])',
    );
    expect(warnings[1]?.message).toContain('Valid values');
  });

  test('strips invalid string disabled_commands values instead of rejecting the config', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_commands: 'council',
        agents: { oracle: { model: 'test/model' } },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.disabled_commands).toBeUndefined();
    expect(config.agents?.oracle?.model).toBe('test/model');
    expect(warnings).toHaveLength(2);
    expect(warnings[1]?.message).toContain(
      'contains only unknown values (["council"])',
    );
  });

  test.each([
    [
      'disabled_hooks',
      ['phase-reminder'],
      ['auto-update-checker'],
      ['phase-reminder'],
    ],
    ['disabled_commands', ['reflect'], ['council'], ['reflect']],
  ])(
    'keeps the user-level %s list when the project-level value has only unknown names',
    (key, userValue, projectValue, expected) => {
      const userConfigPath = path.join(tempDir, 'opencode');
      const projectDir = path.join(tempDir, `project-${key}`);
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(userConfigPath, { recursive: true });
      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(userConfigPath, 'oh-my-opencode-slim.json'),
        JSON.stringify({ [key]: userValue }),
      );
      fs.writeFileSync(
        path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({ [key]: projectValue }),
      );

      const config = loadPluginConfig(projectDir, { silent: true });

      // The all-unknown project value is treated as unset, so the user
      // layer's opt-out survives the layer merge.
      expect(config[key as 'disabled_hooks' | 'disabled_commands']).toEqual(
        expected,
      );
    },
  );

  test('an explicit empty project disabled list overrides the user list', () => {
    const userConfigPath = path.join(tempDir, 'opencode');
    const projectDir = path.join(tempDir, 'project-empty-disabled-hooks');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(userConfigPath, { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigPath, 'oh-my-opencode-slim.json'),
      JSON.stringify({ disabled_hooks: ['phase-reminder'] }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ disabled_hooks: [] }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    expect(config.disabled_hooks).toEqual([]);
  });

  test('strips unknown disabled_hooks entries instead of rejecting the config', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_hooks: ['auto-update-checker', 'phase-reminder'],
        disabled_tools: ['webfetch'],
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    // Unknown enum entries are stripped one by one; valid entries and the
    // rest of the config layer survive the typo.
    expect(config.disabled_hooks).toEqual(['phase-reminder']);
    expect(config.disabled_tools).toEqual(['webfetch']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('normalized');
    expect(warnings[0]?.message).toContain('auto-update-checker');
    expect(warnings[0]?.message).toContain('Valid values');
  });

  test('accepts every whitelist value without stripping', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_hooks: [
          'chat-headers',
          'cache-monitor',
          'json-error-recovery',
          'tool-loop-guard',
          'search-path-guard',
          'absolute-path-rescue',
          'apply-patch',
        ],
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.disabled_hooks).toEqual([
      'chat-headers',
      'cache-monitor',
      'json-error-recovery',
      'tool-loop-guard',
      'search-path-guard',
      'absolute-path-rescue',
      'apply-patch',
    ]);
    expect(warnings).toHaveLength(0);
  });

  test('strips unknown disabled_commands entries instead of rejecting the config', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_commands: ['council', 'reflect'],
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.disabled_commands).toEqual(['reflect']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('normalized');
    expect(warnings[0]?.message).toContain('council');
    expect(warnings[0]?.message).toContain('Valid values');
  });
});

describe('disabled_* key normalization', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disabled-normalize-'));
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user-config');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('normalizes string disabled_agents while preserving the rest of the config', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_agents: 'explorer',
        autoUpdate: false,
        agents: { oracle: { model: 'test/model' } },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.disabled_agents).toEqual(['explorer']);
    expect(config.autoUpdate).toBe(false);
    expect(config.agents?.oracle?.model).toBe('test/model');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('normalized');
    expect(warnings[0]?.message).toContain('should be an array; normalized');
  });

  test('leaves array disabled_agents unchanged', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_agents: ['explorer'],
        agents: { oracle: { model: 'test/model' } },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.disabled_agents).toEqual(['explorer']);
    expect(config.agents?.oracle?.model).toBe('test/model');
    expect(warnings).toHaveLength(0);
  });

  test('normalizes string disabled_tools while preserving presets and agents', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_tools: 'webfetch',
        preset: 'fast',
        presets: { fast: { oracle: { model: 'fast-model' } } },
        agents: { oracle: { temperature: 0.9 } },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.disabled_tools).toEqual(['webfetch']);
    // Preset resolution still runs and merges with root agents
    expect(config.agents?.oracle?.model).toBe('fast-model');
    expect(config.agents?.oracle?.temperature).toBe(0.9);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('normalized');
    expect(warnings[0]?.message).toContain('should be an array; normalized');
  });

  test('drops garbage disabled_* values while preserving the rest of the config', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_mcps: 123,
        disabled_agents: { invalid: 'object' },
        autoUpdate: false,
        agents: { oracle: { model: 'test/model' } },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.disabled_mcps).toBeUndefined();
    expect(config.disabled_agents).toBeUndefined();
    expect(config.autoUpdate).toBe(false);
    expect(config.agents?.oracle?.model).toBe('test/model');
    expect(warnings).toHaveLength(2);
    for (const warning of warnings) {
      expect(warning.kind).toBe('normalized');
      expect(warning.message).toContain(
        'must be an array; ignoring invalid value',
      );
    }
  });

  test('config without disabled_* keys is completely unaffected', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        autoUpdate: false,
        agents: { oracle: { model: 'test/model' } },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.autoUpdate).toBe(false);
    expect(config.agents?.oracle?.model).toBe('test/model');
    expect(warnings).toHaveLength(0);
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
    delete process.env.OPENCODE_CONFIG_DIR;
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

  test('project config overrides top-level arrays', () => {
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_mcps: ['gh_grep'],
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

  test('merges fallback timeout from user and project', () => {
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        fallback: {
          enabled: true,
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
          enabled: false,
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    // Fallback deepMerge: project value wins over user value
    expect(config.fallback?.enabled).toBe(false);
  });

  test('deprecated fallback.* keys warn and still load', () => {
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        fallback: {
          enabled: true,
          timeoutMs: 15000,
          retry_on_empty: false,
          runtimeOverride: true,
        },
        agents: { oracle: { model: 'valid/model' } },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(userConfigDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('deprecated-key');
    expect(warnings[0]?.message).toContain('Deprecated fallback config keys');
    expect(warnings[0]?.message).toContain('timeoutMs');
    expect(config.fallback?.enabled).toBe(true);
    // Removed fields must not survive into the parsed config
    expect(config.fallback).not.toHaveProperty('timeoutMs');
    expect(config.fallback).not.toHaveProperty('retry_on_empty');
    expect(config.fallback).not.toHaveProperty('runtimeOverride');
    expect(config.agents?.oracle?.model).toBe('valid/model');
  });

  test('fallback delay keys are live and preserved alongside legacy keys', () => {
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        fallback: {
          enabled: true,
          maxRetries: 5,
          initialRetryDelayMs: 250,
          retryDelayMs: 750,
          timeoutMs: 15000,
          retry_on_empty: false,
        },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(userConfigDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    // Only the legacy keys warn; the live delay keys are untouched.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('timeoutMs');
    expect(warnings[0]?.message).toContain('retry_on_empty');
    expect(config.fallback?.enabled).toBe(true);
    expect(config.fallback?.maxRetries).toBe(5);
    expect(config.fallback?.initialRetryDelayMs).toBe(250);
    expect(config.fallback?.retryDelayMs).toBe(750);
    expect(config.fallback).not.toHaveProperty('timeoutMs');
    expect(config.fallback).not.toHaveProperty('retry_on_empty');
  });

  test('fallback delay keys alone produce no deprecation warning', () => {
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        fallback: {
          enabled: true,
          initialRetryDelayMs: 100,
          retryDelayMs: 400,
        },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(userConfigDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(warnings).toHaveLength(0);
    expect(config.fallback?.initialRetryDelayMs).toBe(100);
    expect(config.fallback?.retryDelayMs).toBe(400);
  });
});

describe('preset resolution', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-test-'));
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
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

  test('normalizes legacy user and structured project preset layers independently', () => {
    const userConfigDir = path.join(tempDir, 'user-config', 'opencode');
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(userConfigDir, { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: {
          mixed: {
            oracle: { model: 'user/oracle' },
            explore: { model: 'user/explorer' },
            options: { model: 'user/options' },
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'mixed',
        presets: {
          mixed: {
            agents: {
              oracle: { temperature: 0.7 },
              explorer: { inheritModelFrom: 'session' },
            },
          },
        },
      }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    expect(config.agents).toEqual({
      oracle: { model: 'user/oracle', temperature: 0.7 },
      explorer: { inheritModelFrom: 'session' },
      options: { model: 'user/options' },
    });
  });

  test('normalizes structured user and legacy project preset layers independently', () => {
    const userConfigDir = path.join(tempDir, 'user-config', 'opencode');
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(userConfigDir, { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: {
          base: {
            oracle: { model: 'base/oracle' },
            librarian: { model: 'base/librarian' },
          },
          mixed: {
            extends: 'base',
            agents: { oracle: { model: 'user/oracle' } },
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'mixed',
        presets: {
          mixed: {
            oracle: { temperature: 0.8 },
            options: { model: 'project/options' },
          },
        },
      }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    expect(config.agents).toEqual({
      oracle: { model: 'user/oracle', temperature: 0.8 },
      librarian: { model: 'base/librarian' },
      options: { model: 'project/options' },
    });
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

  test('an invalid unused inheritance chain does not block a valid preset', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'valid',
        presets: {
          broken: { extends: 'missing', agents: { oracle: { model: 'bad' } } },
          valid: { oracle: { model: 'good' } },
        },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      silent: true,
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.agents?.oracle?.model).toBe('good');
    expect(config.presets?.valid).toEqual({ oracle: { model: 'good' } });
    expect(config.presets?.broken).toBeUndefined();
    expect(warnings.some((warning) => warning.message.includes('broken'))).toBe(
      true,
    );
  });

  test('a selected malformed chain warns without applying a partial ancestor', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'child',
        presets: {
          base: { oracle: { model: 'ancestor-only' } },
          child: {
            extends: 'missing',
            agents: { explorer: { model: 'partial' } },
          },
        },
        agents: { fixer: { model: 'root' } },
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      silent: true,
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.agents).toEqual({ fixer: { model: 'root' } });
    expect(
      warnings.some(
        (warning) =>
          warning.message.includes('child') &&
          warning.message.includes('missing'),
      ),
    ).toBe(true);
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

  test('options from preset are deep-merged with root agents', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'openai',
        presets: {
          openai: {
            oracle: {
              model: 'openai/gpt-6',
              options: { textVerbosity: 'low' },
            },
          },
        },
        agents: {
          oracle: {
            options: { reasoningEffort: 'medium' },
          },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('openai/gpt-6');
    // deepMerge should combine both option keys
    expect(config.agents?.oracle?.options).toEqual({
      textVerbosity: 'low',
      reasoningEffort: 'medium',
    });
  });

  test('options from preset only work without root agents', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'anthropic-thinking',
        presets: {
          'anthropic-thinking': {
            oracle: {
              model: 'anthropic/claude-sonnet-4-6',
              options: {
                thinking: { type: 'enabled', budgetTokens: 16000 },
              },
            },
          },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('anthropic/claude-sonnet-4-6');
    expect(config.agents?.oracle?.options).toEqual({
      thinking: { type: 'enabled', budgetTokens: 16000 },
    });
  });

  test('root options override preset options for same key', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'concise',
        presets: {
          concise: {
            oracle: {
              model: 'openai/gpt-6',
              options: { textVerbosity: 'low' },
            },
          },
        },
        agents: {
          oracle: {
            options: { textVerbosity: 'high' },
          },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('openai/gpt-6');
    // root wins over preset for same key
    expect(config.agents?.oracle?.options).toEqual({
      textVerbosity: 'high',
    });
  });
});

describe('environment variable preset override', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-preset-test-'));
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
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
    delete process.env.OPENCODE_CONFIG_DIR;
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
      }`,
    );

    const config = loadPluginConfig(projectDir);
    expect(config.preset).toBe('dev');
    expect(config.agents?.oracle?.model).toBe('dev-oracle');
    expect(config.agents?.explorer?.model).toBe('dev-explorer');
  });
});

describe('loadAgentPrompt', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-test-'));
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
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
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      const [p] = args;
      if (typeof p === 'string' && p.includes('error-agent.md')) {
        throw new Error('Read error');
      }
      return originalReadFileSync(...args);
    }) as typeof fs.readFileSync);

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

  test('prefers preset prompt files over root prompts', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    const presetDir = path.join(promptsDir, 'test');
    fs.mkdirSync(presetDir, { recursive: true });

    fs.writeFileSync(path.join(promptsDir, 'oracle.md'), 'root replacement');
    fs.writeFileSync(path.join(presetDir, 'oracle.md'), 'preset replacement');
    fs.writeFileSync(
      path.join(promptsDir, 'oracle_append.md'),
      'root append prompt',
    );
    fs.writeFileSync(
      path.join(presetDir, 'oracle_append.md'),
      'preset append prompt',
    );

    const result = loadAgentPrompt('oracle', 'test');
    expect(result.prompt).toBe('preset replacement');
    expect(result.appendPrompt).toBe('preset append prompt');
  });

  test('falls back to root prompt files when preset files are missing', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    const presetDir = path.join(promptsDir, 'test');
    fs.mkdirSync(presetDir, { recursive: true });

    fs.writeFileSync(path.join(promptsDir, 'oracle.md'), 'root replacement');
    fs.writeFileSync(
      path.join(promptsDir, 'oracle_append.md'),
      'root append prompt',
    );

    const result = loadAgentPrompt('oracle', 'test');
    expect(result.prompt).toBe('root replacement');
    expect(result.appendPrompt).toBe('root append prompt');
  });

  test('falls back independently between preset and root files', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    const presetDir = path.join(promptsDir, 'test');
    fs.mkdirSync(presetDir, { recursive: true });

    fs.writeFileSync(path.join(presetDir, 'oracle.md'), 'preset replacement');
    fs.writeFileSync(
      path.join(promptsDir, 'oracle_append.md'),
      'root append prompt',
    );

    const result = loadAgentPrompt('oracle', 'test');
    expect(result.prompt).toBe('preset replacement');
    expect(result.appendPrompt).toBe('root append prompt');
  });

  test('ignores unsafe preset names for prompt lookup', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'oracle.md'), 'root replacement');

    const result = loadAgentPrompt('oracle', '../test');
    expect(result.prompt).toBe('root replacement');
    expect(result.appendPrompt).toBeUndefined();
  });

  test('falls back to root when preset prompt file read fails', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    const presetDir = path.join(promptsDir, 'test');
    fs.mkdirSync(presetDir, { recursive: true });
    const presetPromptPath = path.join(presetDir, 'oracle.md');
    fs.writeFileSync(presetPromptPath, 'preset replacement');
    fs.writeFileSync(path.join(promptsDir, 'oracle.md'), 'root replacement');

    const consoleWarnSpy = spyOn(console, 'warn');
    const originalReadFileSync = fs.readFileSync;
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      const [p] = args;
      if (typeof p === 'string' && p === presetPromptPath) {
        throw new Error('Preset read error');
      }
      return originalReadFileSync(...args);
    }) as typeof fs.readFileSync);

    try {
      const result = loadAgentPrompt('oracle', 'test');
      expect(result.prompt).toBe('root replacement');
      expect(consoleWarnSpy).toHaveBeenCalled();
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

  test('respects OPENCODE_CONFIG_DIR for prompt location', () => {
    const customDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omc-prompt-config-'),
    );
    process.env.OPENCODE_CONFIG_DIR = customDir;

    const promptsDir = path.join(customDir, 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'oracle.md'),
      'prompt from OPENCODE_CONFIG_DIR dir',
    );

    const result = loadAgentPrompt('oracle');
    expect(result.prompt).toBe('prompt from OPENCODE_CONFIG_DIR dir');

    fs.rmSync(customDir, { recursive: true, force: true });
  });

  test('falls back to default prompt dir when OPENCODE_CONFIG_DIR has no prompt', () => {
    const customDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omc-prompt-config-empty-'),
    );
    process.env.OPENCODE_CONFIG_DIR = customDir;

    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'oracle.md'), 'fallback prompt');

    const result = loadAgentPrompt('oracle');
    expect(result.prompt).toBe('fallback prompt');

    fs.rmSync(customDir, { recursive: true, force: true });
  });
});

describe('env variable interpolation', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-interp-test-'));
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user-config');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('basic substitution: {env:FOO} resolves to the value of FOO', () => {
    process.env.FOO = 'foo-model';
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: { oracle: { model: '{env:FOO}' } },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('foo-model');
  });

  test('multiple variables: multiple {env:...} tokens resolve', () => {
    process.env.FOO = 'foo-model';
    process.env.BAR = 'bar-model';
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          oracle: { model: '{env:FOO}' },
          explorer: { model: '{env:BAR}' },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('foo-model');
    expect(config.agents?.explorer?.model).toBe('bar-model');
  });

  test('undefined variable: {env:NONEXISTENT} resolves to empty string', () => {
    delete process.env.NONEXISTENT;
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: { oracle: { model: '{env:NONEXISTENT}' } },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('');
  });

  test('no interpolation needed: config without {env:...} works unchanged', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: { oracle: { model: 'foo-model' } },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('foo-model');
  });

  test('partial string: "prefix-{env:FOO}-suffix" resolves correctly', () => {
    process.env.FOO = 'foo';
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: { oracle: { model: 'prefix-{env:FOO}-suffix' } },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('prefix-foo-suffix');
  });

  test('works in JSONC files with comments', () => {
    process.env.FOO = 'foo-model';
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
      `{
        // Use env variable for model
        "agents": { "oracle": { "model": "{env:FOO}" } }
      }`,
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('foo-model');
  });

  test('multiple env vars in a single value', () => {
    process.env.FOO = 'foo';
    process.env.BAR = 'bar';
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          oracle: { model: '{env:FOO}/{env:BAR}' },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('foo/bar');
  });
});
