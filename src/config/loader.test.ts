import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAgentMcpList } from './agent-mcps';
import {
  resolveFeatureGates,
  UnsupportedHostConfigError,
} from './feature-gates';
import type { ConfigLoadWarning } from './loader';
import {
  findPluginConfigPaths,
  getPluginConfigCandidates,
  loadAgentPrompt,
  loadPluginConfig,
} from './loader';
import { RuntimeConfig } from './runtime';

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
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test('returns empty config when no config files exist', () => {
    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const config = loadPluginConfig(projectDir);
    expect(config).toEqual({});
  });

  describe('host-aware background jobs retirement matrix', () => {
    test('v2 rejects explicit managed mode with clear error before construction', () => {
      const projectDir = path.join(tempDir, 'project');
      writeProjectConfig(projectDir, {
        backgroundJobs: { mode: 'managed' },
      });

      expect(() => loadPluginConfig(projectDir, { hostFlavor: 'v2' })).toThrow(
        UnsupportedHostConfigError,
      );
      expect(() => loadPluginConfig(projectDir, { hostFlavor: 'v2' })).toThrow(
        /Unsupported backgroundJobs\.mode "managed" on OpenCode v2/,
      );

      // v1 loads managed normally
      const v1Config = loadPluginConfig(projectDir, { hostFlavor: 'v1' });
      expect(v1Config.backgroundJobs?.mode).toBe('managed');
    });

    test('v2 rejects explicit retired keys before defaults or sanitization', () => {
      const projectDir = path.join(tempDir, 'project');
      const forbiddenCases = [
        { concurrency: { defaultConcurrency: 0 } },
        {
          concurrency: {
            defaultConcurrency: 0,
            providerConcurrency: { provider: 0 },
            modelConcurrency: { 'provider/model': 0 },
          },
        },
        { concurrency: {} },
        { wallClockTimeoutMs: 0 },
        { maxSessionsPerAgent: 2 },
        { stopConfirmationMs: 5_000 },
      ];

      for (const backgroundJobs of forbiddenCases) {
        writeProjectConfig(projectDir, { backgroundJobs });
        expect(() =>
          loadPluginConfig(projectDir, { hostFlavor: 'v2', silent: true }),
        ).toThrow(UnsupportedHostConfigError);
        for (const hostFlavor of [undefined, 'v1']) {
          const v1 = loadPluginConfig(projectDir, { hostFlavor });
          expect(v1.backgroundJobs).toMatchObject(backgroundJobs);
        }
      }

      // Invalid retired values must not disappear through the sanitizer.
      for (const backgroundJobs of [
        { concurrency: null },
        { wallClockTimeoutMs: -1 },
        { maxSessionsPerAgent: 100 },
        { stopConfirmationMs: 'invalid' },
      ]) {
        writeProjectConfig(projectDir, { backgroundJobs });
        expect(() =>
          loadPluginConfig(projectDir, { hostFlavor: 'v2', silent: true }),
        ).toThrow(UnsupportedHostConfigError);
      }
    });

    test('v2 allows absence of backgroundJobs and allows sameProviderPolicy', () => {
      const projectDir = path.join(tempDir, 'project');
      writeProjectConfig(projectDir, {
        backgroundJobs: {
          sameProviderPolicy: { anthropic: 'foreground' },
        },
      });

      const v2Config = loadPluginConfig(projectDir, { hostFlavor: 'v2' });
      expect(v2Config.backgroundJobs?.sameProviderPolicy).toEqual({
        anthropic: 'foreground',
      });
      // Mode was not explicit, so it is undefined in raw loaded config and
      // resolveFeatureGates defaults to native
      expect(v2Config.backgroundJobs?.mode).toBeUndefined();
      const gates = resolveFeatureGates(v2Config, 'v2');
      expect(gates.backgroundJobsMode).toBe('native');
      expect(gates.managedJobs).toBe(false);
      expect(gates.presetRouting).toBe(true);
    });

    test('v2 detects explicit forbidden keys across user and project layers', () => {
      const projectDir = path.join(tempDir, 'project');
      const globalDir = path.join(userConfigDir, 'opencode');
      fs.mkdirSync(globalDir, { recursive: true });

      // User config sets wallClockTimeoutMs
      fs.writeFileSync(
        path.join(globalDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({ backgroundJobs: { wallClockTimeoutMs: 60_000 } }),
      );
      // Project config sets only harmless agent
      writeProjectConfig(projectDir, { agents: { oracle: { model: 'm1' } } });

      expect(() => loadPluginConfig(projectDir, { hostFlavor: 'v2' })).toThrow(
        UnsupportedHostConfigError,
      );

      // Clean up global config
      fs.unlinkSync(path.join(globalDir, 'oh-my-opencode-slim.json'));
    });

    test('a project native mode does not hide an unsupported user-layer managed mode', () => {
      const projectDir = path.join(tempDir, 'project');
      const globalDir = path.join(userConfigDir, 'opencode');
      fs.mkdirSync(globalDir, { recursive: true });
      const userPath = path.join(globalDir, 'oh-my-opencode-slim.json');
      fs.writeFileSync(
        userPath,
        JSON.stringify({ backgroundJobs: { mode: 'managed' } }),
      );
      writeProjectConfig(projectDir, { backgroundJobs: { mode: 'native' } });

      expect(() =>
        loadPluginConfig(projectDir, { hostFlavor: 'v2', silent: true }),
      ).toThrow(userPath);
    });

    test('retains existing disable switches and layered precedence on both hosts', () => {
      const projectDir = path.join(tempDir, 'project');
      const globalDir = path.join(userConfigDir, 'opencode');
      fs.mkdirSync(globalDir, { recursive: true });
      fs.writeFileSync(
        path.join(globalDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({
          autoUpdate: false,
          webfetch: { enabled: false },
          backgroundJobs: { childInputWake: false },
        }),
      );
      writeProjectConfig(projectDir, {
        webfetch: {},
        backgroundJobs: { childInputWakeKinds: { question: true } },
      });

      for (const hostFlavor of ['v1', 'v2']) {
        const config = loadPluginConfig(projectDir, {
          hostFlavor,
          silent: true,
        });
        expect(resolveFeatureGates(config, hostFlavor)).toMatchObject({
          updateChecker: false,
          webfetch: false,
        });
        expect(config.backgroundJobs?.childInputWake).toBe(false);
      }

      writeProjectConfig(projectDir, {
        autoUpdate: true,
        webfetch: { enabled: true },
        backgroundJobs: { childInputWake: true },
      });
      for (const hostFlavor of ['v1', 'v2']) {
        const config = loadPluginConfig(projectDir, {
          hostFlavor,
          silent: true,
        });
        expect(resolveFeatureGates(config, hostFlavor)).toMatchObject({
          updateChecker: true,
          webfetch: true,
        });
        expect(config.backgroundJobs?.childInputWake).toBe(true);
      }
    });

    test('v2 emits unsupported warnings for v1-only wake and pruning knobs without throwing', () => {
      const projectDir = path.join(tempDir, 'project');
      writeProjectConfig(projectDir, {
        backgroundJobs: {
          childInputWake: false,
          childInputWakeKinds: { question: false },
          waitForUserGuard: false,
          pruneEvictedSessions: true,
          sameProviderPolicy: { openai: 'foreground' },
        },
      });

      const warnings: ConfigLoadWarning[] = [];
      const config = loadPluginConfig(projectDir, {
        hostFlavor: 'v2',
        silent: true,
        onWarning: (w) => warnings.push(w),
      });

      expect(config).toBeDefined();
      const unsupported = warnings.filter((w) => w.kind === 'unsupported-host');
      expect(unsupported).toHaveLength(5);
      expect(
        unsupported.some((w) => w.message.includes('childInputWake is')),
      ).toBe(true);
      expect(
        unsupported.some((w) => w.message.includes('childInputWakeKinds')),
      ).toBe(true);
      expect(
        unsupported.some((w) => w.message.includes('waitForUserGuard')),
      ).toBe(true);
      expect(
        unsupported.some((w) => w.message.includes('pruneEvictedSessions')),
      ).toBe(true);
      expect(
        unsupported.some((w) => w.message.includes('sameProviderPolicy')),
      ).toBe(true);
    });

    test('v1 emits no unsupported-host warnings for sameProviderPolicy', () => {
      const projectDir = path.join(tempDir, 'project');
      writeProjectConfig(projectDir, {
        backgroundJobs: {
          sameProviderPolicy: { openai: 'foreground' },
          childInputWake: false,
        },
      });

      const warnings: ConfigLoadWarning[] = [];
      const config = loadPluginConfig(projectDir, {
        hostFlavor: 'v1',
        silent: true,
        onWarning: (w) => warnings.push(w),
      });

      expect(config).toBeDefined();
      const unsupported = warnings.filter((w) => w.kind === 'unsupported-host');
      expect(unsupported).toHaveLength(0);
    });
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

  test('reports an unknown council key without discarding the config', () => {
    const projectDir = path.join(tempDir, 'project');
    writeProjectConfig(projectDir, {
      council: {
        presets: { review: { a: { model: 'test/model' } } },
        defaultPreset: 'review',
      },
    });
    const warnings: ConfigLoadWarning[] = [];

    const config = loadPluginConfig(projectDir, {
      silent: true,
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.council?.presets?.review).toBeDefined();
    expect(config.council?.default_preset).toBe('default');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: 'unknown-key' });
    expect(warnings[0]?.message).toContain('council.defaultPreset');
  });

  test('stays quiet on a silent read with an unknown council key', () => {
    const projectDir = path.join(tempDir, 'project');
    writeProjectConfig(projectDir, {
      council: {
        presets: { review: { a: { model: 'test/model' } } },
        defaultPreset: 'review',
      },
    });
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = loadPluginConfig(projectDir, { silent: true });
      expect(config.council?.presets?.review).toBeDefined();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('prints the unknown council key when the read is not silent', () => {
    const projectDir = path.join(tempDir, 'project');
    writeProjectConfig(projectDir, {
      council: {
        presets: { review: { a: { model: 'test/model' } } },
        defaultPreset: 'review',
      },
    });
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      loadPluginConfig(projectDir);
      const printed = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .join('\n');
      expect(printed).toContain('council.defaultPreset');
    } finally {
      warnSpy.mockRestore();
    }
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
    expect(warnings.map((warning) => warning.presetName)).toEqual([
      'broken',
      'child',
    ]);
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
        webfetch: { enabled: false },
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
      enabled: true,
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

  test('an empty project marketplace layer keeps the user false switch', () => {
    const userConfigPath = path.join(userConfigDir, 'opencode');
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(userConfigPath, { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigPath, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        marketplace: { enabled: false },
      }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        marketplace: {},
      }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    expect(config.marketplace).toEqual({ enabled: false });
  });

  test('lets a project layer disable the marketplace over an enabled user layer', () => {
    const userConfigPath = path.join(userConfigDir, 'opencode');
    const projectDir = path.join(tempDir, 'project-marketplace-off');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(userConfigPath, { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigPath, 'oh-my-opencode-slim.json'),
      JSON.stringify({}),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ marketplace: { enabled: false } }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    expect(config.marketplace).toEqual({ enabled: false });
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
        webfetch: {},
      }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    expect(config.webfetch).toEqual({
      enabled: false,
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
          // A removed key sanitizes away like any other bad key.
          strategy: 'checkpoint-compatible',
          // A bad nested key drops only itself; valid wake siblings still
          // override the user layer.
          orchestratorWake: { intervalMs: 1_000, enabled: false },
        },
      }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    expect(config.backgroundJobs?.maxSessionsPerAgent).toBe(8);
    expect('strategy' in (config.backgroundJobs ?? {})).toBe(false);
  });

  test('a project backgroundJobs layer without mode keeps the user mode off', () => {
    const userConfigPath = path.join(userConfigDir, 'opencode');
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(userConfigPath, { recursive: true });
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigPath, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        backgroundJobs: { mode: 'off', maxSessionsPerAgent: 8 },
      }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        backgroundJobs: { concurrency: { defaultConcurrency: 2 } },
      }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    // The project layer configures only concurrency: its absent mode must
    // not reset the user's explicit lifecycle switch.
    expect(config.backgroundJobs?.mode).toBe('off');
    expect(config.backgroundJobs?.maxSessionsPerAgent).toBe(8);
    expect(config.backgroundJobs?.concurrency?.defaultConcurrency).toBe(2);
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
    const customDir = path.join(tempDir, 'custom-opencode-config');
    fs.mkdirSync(customDir, { recursive: true });
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
  });

  test('falls back to default user config dir when OPENCODE_CONFIG_DIR has no config', () => {
    const customDir = path.join(tempDir, 'custom-opencode-config-empty');
    fs.mkdirSync(customDir, { recursive: true });
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
      equalize_panes: true,
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
        equalize_panes: true,
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
      equalize_panes: true,
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
    expect(warnings[0]).not.toHaveProperty('presetName');
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
    expect(warnings[0]).not.toHaveProperty('presetName');
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

  test('routingBlock never derives a v2 default (no boardInjection-style flip)', () => {
    const projectDir = path.join(tempDir, 'project');
    // Unset on v2 stays unset: the native subagent roster carries agent
    // identity only, and the block's Delegate/Don't routing criteria have
    // no native equivalent — a derived false would be a silent routing
    // downgrade dressed up as deduplication.
    const v2Config = loadPluginConfig(projectDir, {
      silent: true,
      hostFlavor: 'v2',
    });
    expect(v2Config.routingBlock).toBeUndefined();

    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ routingBlock: false }),
    );
    const explicitOff = loadPluginConfig(projectDir, {
      silent: true,
      hostFlavor: 'v2',
    });
    expect(explicitOff.routingBlock).toBe(false);
  });

  test('deleted board tuning keys load with one removed warning each, unmigrated', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        backgroundJobs: {
          maxContextLines: 1000,
          readContextMinLines: 3,
          readContextMaxFiles: 2,
          strategy: 'checkpoint-compatible',
          maxRetainedSnapshots: 5,
          boardInjection: false,
          maxSessionsPerAgent: 4,
          orchestratorWake: { periodicWakeEnabled: true },
        },
      }),
    );

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      const config = loadPluginConfig(projectDir, { hostFlavor: 'v1' });
      for (const key of [
        'backgroundJobs.maxContextLines',
        'backgroundJobs.readContextMinLines',
        'backgroundJobs.readContextMaxFiles',
        'backgroundJobs.strategy',
        'backgroundJobs.maxRetainedSnapshots',
        'backgroundJobs.boardInjection',
        'backgroundJobs.orchestratorWake',
      ]) {
        const matching = warnings.filter((message) =>
          message.includes(`"${key}"`),
        );
        expect(matching).toHaveLength(1);
      }
      // Removed keys are dropped, not migrated: no alias, no carried value.
      const bj = config.backgroundJobs as Record<string, unknown>;
      for (const key of [
        'maxContextLines',
        'readContextMinLines',
        'readContextMaxFiles',
        'strategy',
        'maxRetainedSnapshots',
        'boardInjection',
        'orchestratorWake',
      ]) {
        expect(key in bj).toBe(false);
      }
      // boardInjection is removed with the board render: it warns once and
      // is dropped like the other deleted board tuning keys.
      expect(
        warnings.filter((message) =>
          message.includes('"backgroundJobs.boardInjection"'),
        ),
      ).toHaveLength(1);
      expect('boardInjection' in bj).toBe(false);
      // Valid siblings still load.
      expect(config.backgroundJobs?.maxSessionsPerAgent).toBe(4);
    } finally {
      console.warn = originalWarn;
    }
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
        disabled_hooks: 'nonexistent-hook',
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
      'contains only unknown values (["nonexistent-hook"])',
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
      ['nonexistent-hook'],
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
        disabled_hooks: ['nonexistent-hook', 'phase-reminder'],
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
    expect(warnings[0]?.message).toContain('nonexistent-hook');
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

  test('accepts the auto-update-checker hook value without stripping', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_hooks: ['auto-update-checker'],
      }),
    );

    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(projectDir, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(config.disabled_hooks).toEqual(['auto-update-checker']);
    expect(warnings).toHaveLength(0);
  });

  test('retains an explicit interview.enabled across the layer pass', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        interview: { enabled: false, maxQuestions: 3 },
      }),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    // retainExplicitInterviewFields keeps only raw-layer keys, so an
    // explicit master switch must survive instead of being silently
    // replaced by the default true during the layer merge.
    expect(config.interview).toEqual({
      enabled: false,
      maxQuestions: 3,
      outputFolder: 'interview',
      autoOpenBrowser: true,
      port: 0,
      dashboard: false,
      printState: false,
    });
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

  test('preserves inherited fallback, council and ACP values across config layers', () => {
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        fallback: { enabled: false, maxRetries: 7 },
        council: {
          default_preset: 'review',
          presets: { review: { alpha: { model: 'openai/gpt-6' } } },
        },
        acpAgents: {
          reviewer: {
            command: 'old-acp',
            args: ['--acp'],
            timeoutMs: 1200,
            permissionMode: 'allow',
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
        fallback: { retryDelayMs: 200 },
        council: {
          presets: { extra: { beta: { model: 'google/gemini-3-pro' } } },
        },
        acpAgents: { reviewer: { command: 'new-acp' } },
      }),
    );

    for (const hostFlavor of ['v1', 'v2']) {
      const config = loadPluginConfig(projectDir, { hostFlavor });
      expect(config.fallback).toMatchObject({
        enabled: false,
        maxRetries: 7,
        retryDelayMs: 200,
        initialRetryDelayMs: 0,
      });
      expect(config.council?.default_preset).toBe('review');
      expect(config.council?.presets.review.alpha.models).toEqual([
        { id: 'openai/gpt-6' },
      ]);
      expect(config.acpAgents?.reviewer).toMatchObject({
        command: 'new-acp',
        args: ['--acp'],
        env: {},
        timeoutMs: 1200,
        permissionMode: 'allow',
      });
    }
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
            designer: { model: 'base/designer' },
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
      designer: { model: 'base/designer' },
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

  test('loads JSONC comments after a string ending in an escaped backslash', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
      '{"companion":{"binaryPath":"C:\\\\tools\\\\"}, // comment\n"agents":{"oracle":{"model":"test/model"}}}',
    );
    expect(loadPluginConfig(projectDir).agents?.oracle?.model).toBe(
      'test/model',
    );
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
        "agents": { "designer": { "model": "user-designer" } }
      }`,
    );

    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.designer?.model).toBe('user-designer');
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
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
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
    const customDir = path.join(tempDir, 'custom-prompt-config');
    fs.mkdirSync(customDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = customDir;

    const promptsDir = path.join(customDir, 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'oracle.md'),
      'prompt from OPENCODE_CONFIG_DIR dir',
    );

    const result = loadAgentPrompt('oracle');
    expect(result.prompt).toBe('prompt from OPENCODE_CONFIG_DIR dir');
  });

  test('falls back to default prompt dir when OPENCODE_CONFIG_DIR has no prompt', () => {
    const customDir = path.join(tempDir, 'custom-prompt-config-empty');
    fs.mkdirSync(customDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = customDir;

    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'oracle.md'), 'fallback prompt');

    const result = loadAgentPrompt('oracle');
    expect(result.prompt).toBe('fallback prompt');
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

  test('interpolates special characters literally without discarding the layer', () => {
    process.env.ACP_COMMAND = 'C:\\tools\\"agent"\nlauncher';
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
      JSON.stringify({
        acpAgents: { reviewer: { command: '{env:ACP_COMMAND}' } },
        agents: { oracle: { prompt: 'Run {env:ACP_COMMAND} safely' } },
        setDefaultAgent: false,
      }),
    );
    for (const hostFlavor of ['v1', 'v2']) {
      const config = loadPluginConfig(projectDir, { hostFlavor });
      expect(config.acpAgents?.reviewer.command).toBe(process.env.ACP_COMMAND);
      expect(config.agents?.oracle?.prompt).toBe(
        `Run ${process.env.ACP_COMMAND} safely`,
      );
      expect(config.setDefaultAgent).toBe(false);
    }
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

describe('removed config keys', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-removed-'));
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user-config');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  function load(extra: Record<string, unknown>) {
    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'mine',
        presets: { mine: { oracle: { model: 'test/preset-oracle' } } },
        ...extra,
      }),
    );
    const warnings: ConfigLoadWarning[] = [];
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = loadPluginConfig(projectDir, {
        onWarning: (warning) => warnings.push(warning),
      });
      return { config, warnings };
    } finally {
      warn.mockRestore();
    }
  }

  const councillor = { model: 'test/councillor' };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['tmux', { tmux: { enabled: true } }],
    [
      'council.master',
      { council: { presets: { p: { a: councillor } }, master: {} } },
    ],
    [
      'council.master_timeout',
      { council: { presets: { p: { a: councillor } }, master_timeout: 1 } },
    ],
    [
      'council.master_fallback',
      {
        council: { presets: { p: { a: councillor } }, master_fallback: [] },
      },
    ],
    [
      'council.presets.p.master',
      { council: { presets: { p: { a: councillor, master: councillor } } } },
    ],
    [
      'council.presets.p.councillors',
      {
        council: {
          presets: { p: { a: councillor, councillors: { b: councillor } } },
        },
      },
    ],
    [
      'backgroundJobs.continueOnIdle',
      { backgroundJobs: { continueOnIdle: true } },
    ],
    [
      'backgroundJobs.boardInjection',
      { backgroundJobs: { boardInjection: true } },
    ],
    [
      'backgroundJobs.abortGraceMs',
      { backgroundJobs: { abortGraceMs: 10_000 } },
    ],
    ['fallback.timeoutMs', { fallback: { timeoutMs: 15000 } }],
    ['fallback.retry_on_empty', { fallback: { retry_on_empty: true } }],
    ['fallback.runtimeOverride', { fallback: { runtimeOverride: true } }],
    [
      'multiplexer.zellij_pane_mode',
      { multiplexer: { type: 'zellij', zellij_pane_mode: 'agent-tab' } },
    ],
  ];

  for (const [key, extra] of cases) {
    test(`"${key}" is dropped with a warning; other settings still load`, () => {
      const { config, warnings } = load(extra);

      expect(config.agents?.oracle?.model).toBe('test/preset-oracle');
      expect(warnings.map((w) => w.kind)).toEqual(['removed-key']);
      expect(warnings[0]?.message).toBe(
        `Config key "${key}" was removed in this version and is ignored; see docs/configuration.md`,
      );
      if (key.startsWith('council.')) {
        expect(config.council?.presets.p?.a?.model).toBe('test/councillor');
        expect(Object.keys(config.council?.presets.p ?? {})).toEqual(['a']);
      }
      if (key === 'multiplexer.zellij_pane_mode') {
        expect(config.multiplexer?.type).toBe('zellij');
      }
    });
  }

  test('removed backgroundJobs.enabled: false warns and keeps the opt-out as mode off', () => {
    const { config, warnings } = load({
      backgroundJobs: {
        enabled: false,
        maxSessionsPerAgent: 4,
        concurrency: { defaultConcurrency: 2 },
      },
    });

    expect(config.agents?.oracle?.model).toBe('test/preset-oracle');
    // A stale opt-out must not silently re-enable the managed lifecycle.
    expect(config.backgroundJobs?.mode).toBe('off');
    // Only the alias is dropped; every sibling keeps its configured value.
    expect(config.backgroundJobs?.maxSessionsPerAgent).toBe(4);
    expect(config.backgroundJobs?.concurrency?.defaultConcurrency).toBe(2);
    expect(Object.hasOwn(config.backgroundJobs ?? {}, 'enabled')).toBe(false);
    expect(warnings.map((w) => w.kind)).toEqual(['removed-key']);
    expect(warnings[0]?.message).toContain('"backgroundJobs.enabled"');
    expect(warnings[0]?.message).toContain('backgroundJobs.mode');
    expect(resolveFeatureGates(config).backgroundJobsMode).toBe('off');
  });

  test('removed backgroundJobs.enabled: false never overrides an explicit mode', () => {
    const { config } = load({
      backgroundJobs: { enabled: false, mode: 'native' },
    });
    expect(config.backgroundJobs?.mode).toBe('native');
  });

  test('SF-01: drops webfetch.model without losing the other file settings', () => {
    const { config, warnings } = load({
      webfetch: { model: 'test/retired-model', enabled: false },
      sidebar: false,
    });

    expect(config.agents?.oracle?.model).toBe('test/preset-oracle');
    expect(config.webfetch).toEqual({ enabled: false });
    expect(config.sidebar).toBe(false);
    expect(warnings.map((warning) => warning.kind)).toEqual(['removed-key']);
    expect(warnings[0]?.message).toContain('"webfetch.model" was removed');
  });

  test('reports every removed key in one file', () => {
    const { config, warnings } = load({
      tmux: {},
      fallback: { timeoutMs: 1, runtimeOverride: true, maxRetries: 2 },
    });

    expect(config.agents?.oracle?.model).toBe('test/preset-oracle');
    expect(config.fallback?.maxRetries).toBe(2);
    expect(warnings.map((w) => w.message)).toEqual([
      'Config key "tmux" was removed in this version and is ignored; see docs/configuration.md',
      'Config key "fallback.timeoutMs" was removed in this version and is ignored; see docs/configuration.md',
      'Config key "fallback.runtimeOverride" was removed in this version and is ignored; see docs/configuration.md',
    ]);
  });

  test('removed disabled_hooks members warn once, drop before enum validation, and preserve valid members', () => {
    const { config, warnings } = load({
      disabled_hooks: [
        'council-assembly',
        'council-assembly',
        'council-inject',
      ],
    });

    expect(config.agents?.oracle?.model).toBe('test/preset-oracle');
    expect(config.disabled_hooks).toEqual(['council-inject']);
    expect(warnings.map((w) => w.kind)).toEqual(['removed-key']);
    expect(warnings[0]?.message).toBe(
      'council-assembly is no longer a hook: council seat assembly is unconditional and fail-open — remove this entry.',
    );
  });

  test('a disabled_hooks list holding only a removed member is treated as unset', () => {
    const { config, warnings } = load({
      disabled_hooks: ['council-assembly'],
    });

    expect(config.agents?.oracle?.model).toBe('test/preset-oracle');
    expect(config.disabled_hooks).toBeUndefined();
    expect(warnings.map((w) => w.kind)).toEqual(['removed-key']);
  });

  test('unknown invalid keys still reject the file', () => {
    const { config, warnings } = load({ fallback: { bogus: true } });

    expect(config.agents?.oracle?.model).toBeUndefined();
    expect(warnings.map((w) => w.kind)).toEqual(['invalid-schema']);
  });
});

describe('legacy generated preset explorer.mcps repair', () => {
  const G = ['context7', 'gh_grep'];
  const RUNTIME = 'loader-legacy-preset-mcps';
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-legacy-mcps-'));
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user-config');
    RuntimeConfig.reset(RUNTIME);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    RuntimeConfig.reset(RUNTIME);
  });

  function write(dir: string, raw: unknown): void {
    const configDir = path.join(dir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify(raw),
    );
  }

  function load(dir: string) {
    const warnings: ConfigLoadWarning[] = [];
    const config = loadPluginConfig(dir, {
      silent: true,
      onWarning: (warning) => warnings.push(warning),
    });
    RuntimeConfig.reset(RUNTIME);
    const mcps = getAgentMcpList(
      'explorer',
      RuntimeConfig.init(RUNTIME, config),
    );
    return { config, warnings, mcps };
  }

  function loadOne(raw: Record<string, unknown>, name = 'project') {
    const dir = path.join(tempDir, name);
    write(dir, raw);
    return load(dir);
  }

  const project = (name: string, preset: Record<string, unknown>) => ({
    preset: name,
    presets: { [name]: preset },
  });
  const pair = (
    librarian: string[] | undefined,
    explorer: string[] | undefined,
    extra: Record<string, unknown> = {},
  ) => ({
    ...(librarian && { librarian: { mcps: librarian } }),
    ...(explorer && { explorer: { mcps: explorer } }),
    ...extra,
  });

  test('repairs the generated pair under an arbitrary preset name', () => {
    const name = 'team-legacy-2025';
    const { config, warnings, mcps } = loadOne(project(name, pair(G, [])));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: 'normalized' });
    expect(warnings[0]?.message).toContain(`presets.${name}.explorer.mcps`);
    expect(config.presets?.[name]?.explorer?.mcps).toEqual(G);
    expect(config.agents?.explorer?.mcps).toEqual(G);
    expect(mcps).toEqual(G);
  });

  test('repairs only mcps; other fields follow the existing alias merge', () => {
    const canonical = {
      mcps: [] as string[],
      model: 'test/canonical',
      variant: 'high',
      skills: [] as string[],
      prompt: 'canonical prompt',
      options: { reasoning: { effort: 'high' } },
      permission: { webfetch: 'deny' },
    };
    const { config, warnings } = loadOne(
      project('fields', {
        librarian: {
          mcps: G,
          model: 'test/legacy',
          skills: ['research-skill'],
          temperature: 0.4,
          description: 'legacy description',
        },
        explorer: canonical,
      }),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('presets.fields.explorer.mcps');
    expect(config.presets?.fields?.explorer?.skills).toEqual([]);
    expect(config.presets?.fields?.explorer).toEqual({
      ...canonical,
      mcps: G,
      temperature: 0.4,
      description: 'legacy description',
    });
  });

  // [label, preset name, raw config, expected MCPs, repair warning path,
  //  extra assertion on the resolved preset]
  const cases: Array<
    [
      string,
      string,
      Record<string, unknown>,
      string[],
      string?,
      Record<string, unknown>?,
    ]
  > = [
    [
      'reversed librarian MCP order',
      'order',
      project('order', pair(['gh_grep', 'context7'], [])),
      ['gh_grep', 'context7'],
      'presets.order.explorer.mcps',
    ],
    [
      'canonical entry written first',
      'keys',
      project('keys', { explorer: { mcps: [] }, librarian: { mcps: G } }),
      G,
      'presets.keys.explorer.mcps',
    ],
    [
      'structured {agents} wrapper',
      'struct',
      project('struct', { agents: pair(G, []) }),
      G,
      'presets.struct.agents.explorer.mcps',
    ],
    [
      'inline extends syntax',
      'child',
      {
        preset: 'child',
        presets: {
          base: { oracle: { model: 'test/oracle' } },
          child: { extends: 'base', ...pair(G, []) },
        },
      },
      G,
      'presets.child.explorer.mcps',
    ],
    [
      'flat custom agent named agents',
      'flat',
      project('flat', pair(G, [], { agents: { model: 'test/custom' } })),
      G,
      'presets.flat.explorer.mcps',
      { agents: { model: 'test/custom' } },
    ],
    [
      'explorer-only empty list',
      'mine',
      project('mine', pair(undefined, [])),
      [],
    ],
    [
      'non-empty canonical list',
      'mine',
      project('mine', pair(G, ['custom-mcp'])),
      ['custom-mcp'],
    ],
    [
      'duplicate legacy name',
      'mine',
      project('mine', pair(['context7', 'context7'], [])),
      [],
    ],
    [
      'extra legacy MCP',
      'mine',
      project('mine', pair([...G, 'extra-mcp'], [])),
      [],
    ],
    ['wildcard legacy list', 'mine', project('mine', pair(['*'], [])), []],
    [
      'exclusion in the legacy list',
      'mine',
      project('mine', pair(['!context7', 'gh_grep'], [])),
      [],
    ],
    ['custom legacy list', 'mine', project('mine', pair(['my-mcp'], [])), []],
    [
      'explicit deny on the canonical entry',
      'mine',
      project('mine', pair(G, ['!*'])),
      ['!*'],
    ],
  ];

  for (const [label, name, raw, expected, warningPath, extra] of cases) {
    test(`${warningPath ? 'repairs' : 'leaves explicit'} ${label}`, () => {
      const { config, warnings, mcps } = loadOne(raw);
      expect(warnings.map((warning) => warning.kind)).toEqual(
        warningPath ? ['normalized'] : [],
      );
      if (warningPath) {
        expect(warnings[0]?.message).toContain(warningPath);
      }
      expect(config.presets?.[name]?.explorer?.mcps).toEqual(expected);
      expect(mcps).toEqual(expected);
      if (extra) expect(config.presets?.[name]).toMatchObject(extra);
    });
  }

  test('never repairs root agents or an explicit root deny', () => {
    const rootCases: Array<[string, string[]]> = [
      ['project-root', []],
      ['project-deny', ['!*']],
    ];
    for (const [dir, expected] of rootCases) {
      const { config, warnings, mcps } = loadOne(
        { agents: { librarian: { mcps: G }, explorer: { mcps: expected } } },
        dir,
      );
      expect(warnings).toEqual([]);
      expect(config.agents?.explorer?.mcps).toEqual(expected);
      expect(mcps).toEqual(expected);
    }
  });

  test('does not assemble the fingerprint across layers', () => {
    const base = path.join(tempDir, 'workspace-cross');
    const child = path.join(base, 'project');
    write(base, project('mine', { librarian: { mcps: G } }));
    write(child, { presets: { mine: { explorer: { mcps: [] } } } });

    const { config, warnings, mcps } = load(child);
    expect(warnings).toEqual([]);
    expect(config.presets?.mine?.explorer?.mcps).toEqual([]);
    expect(mcps).toEqual([]);
  });

  test('does not assemble the fingerprint across an inherited preset chain', () => {
    const { config, warnings, mcps } = loadOne({
      preset: 'child',
      presets: {
        base: { librarian: { mcps: G } },
        child: { extends: 'base', explorer: { mcps: [] } },
      },
    });

    expect(warnings).toEqual([]);
    expect(config.presets?.child?.explorer?.mcps).toEqual([]);
    expect(mcps).toEqual([]);
  });

  const closerOverrides: Array<[string, Record<string, unknown>]> = [
    ['root agents override', { agents: { explorer: { mcps: [] } } }],
    [
      'closer preset override',
      { presets: { mine: { explorer: { mcps: [] } } } },
    ],
  ];

  for (const [label, layer] of closerOverrides) {
    test(`keeps a ${label} after repairing the lower layer`, () => {
      const base = path.join(tempDir, 'workspace-precedence');
      const child = path.join(base, 'project');
      write(base, project('mine', pair(G, [])));
      write(child, layer);

      const { config, warnings, mcps } = load(child);
      expect(warnings.map((warning) => warning.kind)).toEqual(['normalized']);
      expect(warnings[0]?.message).toContain('presets.mine.explorer.mcps');
      expect(config.agents?.explorer?.mcps).toEqual([]);
      expect(mcps).toEqual([]);
    });
  }
});
