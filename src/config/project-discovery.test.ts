import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { preflightMarketplaceAgentActivation } from '../marketplace/activation-config';
import {
  clearProjectPresetOnDisk,
  getAllConfiguredPresets,
  getPresetSelectionState,
  switchPresetOnDisk,
} from '../tools/preset-switch';
import { getPluginConfigCandidates as getV2WatchCandidates } from '../v2/config-watch';
import {
  type ConfigLoadWarning,
  findPluginConfigPaths,
  getPluginConfigCandidates,
  getProjectConfigDirectories,
  loadAgentPrompt,
  loadPluginConfig,
} from './loader';
import { discoverProjectLocalSkillNames } from './project-skills';
import { RuntimeConfig } from './runtime';

describe('host-aware project discovery', () => {
  let root: string;
  let home: string;
  let repository: string;
  let worktree: string;
  let globalDirectory: string;
  let originalEnv: typeof process.env;

  function write(
    directory: string,
    relativePath: string,
    content: string,
  ): string {
    const filename = path.join(directory, relativePath);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
    return filename;
  }

  beforeEach(() => {
    originalEnv = { ...process.env };
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-host-discovery-'));
    home = path.join(root, 'home');
    repository = path.join(home, 'repository');
    worktree = path.join(repository, '.slim', 'worktrees', 'feature');
    globalDirectory = path.join(root, 'user-config', 'opencode');
    delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
    delete process.env.OPENCODE_CONFIG_PROJECT_DISABLE;
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    process.env.XDG_CONFIG_HOME = path.dirname(globalDirectory);
    process.env.HOME = home;
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    write(worktree, '.git', 'gitdir: fixture');
    write(
      globalDirectory,
      'oh-my-opencode-slim.json',
      JSON.stringify({
        agents: { oracle: { model: 'test/global' } },
      }),
    );
    write(globalDirectory, 'oh-my-opencode-slim/oracle.md', 'global prompt');
    write(
      home,
      '.opencode/oh-my-opencode-slim.json',
      JSON.stringify({
        agents: { oracle: { model: 'test/home' } },
        presets: { shared: { fixer: { model: 'test/shared' } } },
      }),
    );
    write(home, '.opencode/oh-my-opencode-slim/oracle.md', 'home prompt');
    write(home, '.opencode/skills/shared/SKILL.md', '---\nname: shared\n---\n');
    write(
      worktree,
      '.opencode/oh-my-opencode-slim.json',
      JSON.stringify({
        agents: { oracle: { variant: 'high', skills_include_local: true } },
      }),
    );
    write(
      worktree,
      '.opencode/skills/local/SKILL.md',
      '---\nname: local\n---\n',
    );
  });

  afterEach(() => {
    RuntimeConfig.reset(worktree);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('v1 includes its Git worktree boundary but ignores layers above it', () => {
    expect(getProjectConfigDirectories(worktree)).toEqual([
      path.join(worktree, '.opencode'),
    ]);
    expect(loadPluginConfig(worktree).agents?.oracle).toMatchObject({
      model: 'test/global',
      variant: 'high',
    });
    expect(
      loadAgentPrompt('oracle', { projectDirectory: worktree }).prompt,
    ).toBe('global prompt');
    expect(discoverProjectLocalSkillNames(worktree)).toEqual(['local']);
    expect(getAllConfiguredPresets(worktree).shared).toBeUndefined();
    expect(getPluginConfigCandidates(worktree).project).toHaveLength(2);
    const runtime = RuntimeConfig.createDetached(
      worktree,
      loadPluginConfig(worktree),
    );
    expect(runtime.agents().oracle?.skills).not.toContain('shared');
  });

  test('v1 stops at a Git directory as well as a linked-worktree file', () => {
    const nested = path.join(repository, 'packages', 'backend');
    fs.mkdirSync(nested, { recursive: true });
    const directories = getProjectConfigDirectories(nested, 'v1');
    expect(directories[0]).toBe(path.join(repository, '.opencode'));
    expect(directories.at(-1)).toBe(path.join(nested, '.opencode'));
    expect(directories).not.toContain(path.join(home, '.opencode'));
  });

  test('v2 searches through root and inherits home project layers over user config', () => {
    const directories = getProjectConfigDirectories(worktree, 'v2');
    expect(directories[0]).toBe(
      path.join(path.parse(worktree).root, '.opencode'),
    );
    expect(directories).toContain(path.join(home, '.opencode'));
    const config = loadPluginConfig(worktree, { hostFlavor: 'v2' });
    expect(config.agents?.oracle).toMatchObject({
      model: 'test/home',
      variant: 'high',
    });
    expect(
      loadAgentPrompt('oracle', {
        projectDirectory: worktree,
        hostFlavor: 'v2',
      }).prompt,
    ).toBe('home prompt');
    expect(discoverProjectLocalSkillNames(worktree, 'v2')).toEqual([
      'local',
      'shared',
    ]);
    expect(getAllConfiguredPresets(worktree, 'v2').shared).toBeDefined();
    expect(getV2WatchCandidates(worktree)).toContain(
      path.join(home, '.opencode', 'oh-my-opencode-slim.json'),
    );
    const runtime = RuntimeConfig.createDetached(worktree, config, 'v2');
    expect(runtime.agents().oracle?.skills).toContain('shared');
    RuntimeConfig.get(worktree);
    RuntimeConfig.init(worktree, config, 'v2');
    expect(RuntimeConfig.get(worktree).agents().oracle?.skills).toContain(
      'shared',
    );
  });

  test('v2 project-disable flag controls discovery and writes with host precedence', () => {
    process.env.OPENCODE_CONFIG_PROJECT_DISABLE = 'true';
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = 'false';
    const config = loadPluginConfig(worktree, { hostFlavor: 'v2' });
    expect(config.agents?.oracle?.model).toBe('test/global');
    expect(
      loadAgentPrompt('oracle', {
        projectDirectory: worktree,
        hostFlavor: 'v2',
      }).prompt,
    ).toBe('global prompt');
    expect(discoverProjectLocalSkillNames(worktree, 'v2')).toEqual([]);
    expect(
      switchPresetOnDisk(worktree, 'shared', config, {
        scope: 'project',
        hostFlavor: 'v2',
      }).ok,
    ).toBe(false);
    expect(clearProjectPresetOnDisk(worktree, 'v2').ok).toBe(false);
    expect(
      loadPluginConfig(worktree, { hostFlavor: 'v1' }).agents?.oracle,
    ).toMatchObject({ variant: 'high' });

    process.env.OPENCODE_CONFIG_PROJECT_DISABLE = 'false';
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true';
    expect(
      loadPluginConfig(worktree, { hostFlavor: 'v2' }).agents?.oracle,
    ).toMatchObject({ model: 'test/home', variant: 'high' });
    expect(getProjectConfigDirectories(worktree, 'v1')).toEqual([]);
  });

  for (const flag of ['true', 'TRUE', '1']) {
    test(`disabling project config (${flag}) suppresses every project discovery surface`, () => {
      process.env.OPENCODE_DISABLE_PROJECT_CONFIG = flag;
      for (const hostFlavor of ['v1', 'v2']) {
        expect(getProjectConfigDirectories(worktree, hostFlavor)).toEqual([]);
        expect(findPluginConfigPaths(worktree, hostFlavor)).toMatchObject({
          projectConfigPath: null,
          projectConfigPaths: [],
        });
        expect(getPluginConfigCandidates(worktree, hostFlavor).project).toEqual(
          [],
        );
        expect(
          loadPluginConfig(worktree, { hostFlavor }).agents?.oracle?.model,
        ).toBe('test/global');
        expect(
          loadAgentPrompt('oracle', { projectDirectory: worktree, hostFlavor })
            .prompt,
        ).toBe('global prompt');
        expect(discoverProjectLocalSkillNames(worktree, hostFlavor)).toEqual(
          [],
        );
        expect(
          getAllConfiguredPresets(worktree, hostFlavor).shared,
        ).toBeUndefined();
      }
      expect(getV2WatchCandidates(worktree)).not.toContain(
        path.join(worktree, '.opencode', 'oh-my-opencode-slim.json'),
      );
    });
  }

  test('image routing warnings identify the layer providing the route', () => {
    const source = write(
      home,
      '.opencode/oh-my-opencode-slim.json',
      JSON.stringify({ image_routing: 'auto' }),
    );
    write(
      worktree,
      '.opencode/oh-my-opencode-slim.json',
      JSON.stringify({ disabled_agents: ['observer'] }),
    );
    const warnings: ConfigLoadWarning[] = [];
    loadPluginConfig(worktree, {
      hostFlavor: 'v2',
      silent: true,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ path: source, kind: 'invalid-schema' });
  });

  test('marketplace preflight follows the supplied host boundary', () => {
    expect(() =>
      preflightMarketplaceAgentActivation(worktree, 'project', 'shared'),
    ).toThrow();
    expect(() =>
      preflightMarketplaceAgentActivation(worktree, 'project', 'shared', 'v2'),
    ).not.toThrow();
  });

  test('project preset writes create a current-location file, never an ancestor file', () => {
    fs.unlinkSync(path.join(worktree, '.opencode', 'oh-my-opencode-slim.json'));
    const ancestorPath = path.join(
      home,
      '.opencode',
      'oh-my-opencode-slim.json',
    );
    const original = fs.readFileSync(ancestorPath, 'utf-8');
    const result = switchPresetOnDisk(
      worktree,
      'shared',
      loadPluginConfig(worktree, { hostFlavor: 'v2' }),
      { scope: 'project', hostFlavor: 'v2' },
    );
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(ancestorPath, 'utf-8')).toBe(original);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(worktree, '.opencode', 'oh-my-opencode-slim.jsonc'),
          'utf-8',
        ),
      ).preset,
    ).toBe('shared');
  });

  test('disabled project actions refuse writes and clears while Global remains usable', () => {
    const userPath = write(
      globalDirectory,
      'oh-my-opencode-slim.json',
      JSON.stringify({
        preset: 'global-a',
        presets: {
          'global-a': { fixer: { model: 'test/a' } },
          'global-b': { fixer: { model: 'test/b' } },
        },
      }),
    );
    const localPath = path.join(
      worktree,
      '.opencode',
      'oh-my-opencode-slim.json',
    );
    const original = fs.readFileSync(localPath, 'utf-8');
    const nested = path.join(worktree, 'nested');
    fs.mkdirSync(nested);
    for (const flag of ['true', 'TRUE', '1']) {
      process.env.OPENCODE_DISABLE_PROJECT_CONFIG = flag;
      for (const hostFlavor of ['v1', 'v2']) {
        const config = loadPluginConfig(worktree, { hostFlavor });
        for (const directory of [worktree, nested]) {
          const result = switchPresetOnDisk(directory, 'global-b', config, {
            scope: 'project',
            hostFlavor,
          });
          expect(result.ok).toBe(false);
          expect(result.message).toContain('OPENCODE_DISABLE_PROJECT_CONFIG');
          expect(clearProjectPresetOnDisk(directory, hostFlavor).ok).toBe(
            false,
          );
        }
        expect(fs.readFileSync(localPath, 'utf-8')).toBe(original);
        expect(fs.existsSync(path.join(nested, '.opencode'))).toBe(false);
        expect(
          switchPresetOnDisk(worktree, 'global-b', config, {
            scope: 'global',
            hostFlavor,
          }).ok,
        ).toBe(true);
        expect(JSON.parse(fs.readFileSync(userPath, 'utf-8')).preset).toBe(
          'global-b',
        );
      }
    }
  });

  for (const localPin of [true, false]) {
    test(`Inherit reports an ancestor selection with local pin ${localPin}`, () => {
      const ancestorPath = write(
        home,
        '.opencode/oh-my-opencode-slim.json',
        JSON.stringify({
          preset: 'shared',
          presets: { shared: { fixer: { model: 'test/shared' } } },
        }),
      );
      const userPath = write(
        globalDirectory,
        'oh-my-opencode-slim.json',
        JSON.stringify({
          preset: 'global',
          presets: { global: { fixer: { model: 'test/global' } } },
        }),
      );
      const localPath = path.join(
        worktree,
        '.opencode',
        'oh-my-opencode-slim.json',
      );
      if (localPin)
        fs.writeFileSync(
          localPath,
          JSON.stringify({
            preset: 'local',
            agents: { oracle: { variant: 'high' } },
          }),
        );
      else fs.unlinkSync(localPath);
      const ancestorBefore = fs.readFileSync(ancestorPath, 'utf-8');
      const userBefore = fs.readFileSync(userPath, 'utf-8');
      const result = clearProjectPresetOnDisk(worktree, 'v2');
      expect(result.ok).toBe(true);
      expect(result.presetName).toBe('shared');
      expect(result.message).toContain('preset "shared"');
      expect(result.message).toContain('ancestor');
      expect(getPresetSelectionState(worktree, 'v2').effective).toBe('shared');
      expect(loadPluginConfig(worktree, { hostFlavor: 'v2' }).preset).toBe(
        'shared',
      );
      expect(fs.readFileSync(ancestorPath, 'utf-8')).toBe(ancestorBefore);
      expect(fs.readFileSync(userPath, 'utf-8')).toBe(userBefore);
      if (localPin)
        expect(JSON.parse(fs.readFileSync(localPath, 'utf-8'))).toEqual({
          agents: { oracle: { variant: 'high' } },
        });
      else expect(fs.existsSync(localPath)).toBe(false);
      expect(clearProjectPresetOnDisk(worktree).message).toContain(
        'global configuration',
      );
    });
  }
});
