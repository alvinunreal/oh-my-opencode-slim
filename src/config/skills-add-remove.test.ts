import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgents } from '../agents';
import {
  getDefaultGrantedSkillNames,
  resolveEffectiveSkills,
} from '../cli/skills';
import { loadPluginConfig } from './loader';
import { RuntimeConfig } from './runtime';
import {
  type AgentOverrideConfig,
  type PluginConfig,
  PluginConfigSchema,
} from './schema';

const RUNTIME_TEST_DIRECTORY = 'skills-add-remove-runtime';

function runtimeFor(config: PluginConfig | undefined = {}) {
  RuntimeConfig.reset(RUNTIME_TEST_DIRECTORY);
  RuntimeConfig.init(RUNTIME_TEST_DIRECTORY, config ?? {});
  return RuntimeConfig.get(RUNTIME_TEST_DIRECTORY);
}

describe('skills_add / skills_remove directives', () => {
  let tempDir: string;
  let projectDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-add-remove-test-'));
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    process.env.XDG_CONFIG_HOME = tempDir;
    projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
    RuntimeConfig.reset(RUNTIME_TEST_DIRECTORY);
  });

  function writeUserConfig(config: unknown): void {
    const userDir = path.join(tempDir, 'opencode');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, 'oh-my-opencode-slim.jsonc'),
      JSON.stringify(config, null, 2),
    );
  }

  function writeProjectConfig(config: unknown): void {
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.jsonc'),
      JSON.stringify(config, null, 2),
    );
  }

  function expectNoDirectiveKeys(entry: AgentOverrideConfig | undefined): void {
    expect(entry).toBeDefined();
    expect('skills_add' in (entry ?? {})).toBe(false);
    expect('skills_remove' in (entry ?? {})).toBe(false);
  }

  // Resolver unit tests -----------------------------------------------------

  test('resolveEffectiveSkills: base + add with remove winning over add', () => {
    expect(
      resolveEffectiveSkills('oracle', ['a', 'b'], ['b', 'c', 'd'], ['b', 'd']),
    ).toEqual(['a', 'c']);
  });

  test('resolveEffectiveSkills: dedupes within base and across add', () => {
    expect(
      resolveEffectiveSkills('oracle', ['a', 'a', 'b'], ['b', 'c'], undefined),
    ).toEqual(['a', 'b', 'c']);
  });

  test('resolveEffectiveSkills: wildcard base with removal', () => {
    expect(resolveEffectiveSkills('oracle', ['*'], undefined, ['foo'])).toEqual(
      ['*', '!foo'],
    );
  });

  test('resolveEffectiveSkills: additions without a base', () => {
    expect(
      resolveEffectiveSkills('oracle', undefined, ['x', 'y'], undefined),
    ).toEqual(['x', 'y']);
  });

  test('resolveEffectiveSkills: removal only, orchestrator defaults to allow-all', () => {
    expect(
      resolveEffectiveSkills('orchestrator', undefined, undefined, ['foo']),
    ).toEqual(['*', '!foo']);
  });

  test('resolveEffectiveSkills: removal only, other agents start from default grants', () => {
    expect(
      resolveEffectiveSkills('explorer', undefined, undefined, ['codemap']),
    ).toEqual(
      getDefaultGrantedSkillNames('explorer').filter((n) => n !== 'codemap'),
    );
  });

  test('resolveEffectiveSkills: removing an ungranted name without wildcard is a no-op', () => {
    expect(resolveEffectiveSkills('oracle', ['a'], undefined, ['b'])).toEqual([
      'a',
    ]);
  });

  test('resolveEffectiveSkills: empty skills_add, no base, no remove', () => {
    expect(
      resolveEffectiveSkills('oracle', undefined, [], undefined),
    ).toBeUndefined();
  });

  test('resolveEffectiveSkills: nothing configured returns undefined', () => {
    expect(
      resolveEffectiveSkills('oracle', undefined, undefined, undefined),
    ).toBeUndefined();
  });

  test('resolveEffectiveSkills: duplicate remove entries yield one exclusion', () => {
    expect(
      resolveEffectiveSkills('oracle', ['*'], undefined, ['foo', 'foo']),
    ).toEqual(['*', '!foo']);
  });

  test('resolveEffectiveSkills: removed base entry still excluded under wildcard', () => {
    expect(
      resolveEffectiveSkills('oracle', ['*', 'foo'], undefined, ['foo']),
    ).toEqual(['*', '!foo']);
  });

  test('getDefaultGrantedSkillNames: oracle grants in registry order', () => {
    const grants = getDefaultGrantedSkillNames('oracle');
    expect(grants[0]).toBe('simplify');
    expect(grants).toContain('requesting-code-review');
    expect(grants).not.toContain('codemap');
  });

  // Loader E2E ---------------------------------------------------------------

  test('loader: global skills + project skills_add', () => {
    writeUserConfig({
      agents: { oracle: { skills: ['codemap', 'deepwork'] } },
    });
    writeProjectConfig({
      agents: {
        oracle: { skills_add: ['nexus-backend', 'nexus-frontend'] },
      },
    });

    const loaded = loadPluginConfig(projectDir, { silent: true });
    expect(loaded.agents?.oracle?.skills).toEqual([
      'codemap',
      'deepwork',
      'nexus-backend',
      'nexus-frontend',
    ]);
    expectNoDirectiveKeys(loaded.agents?.oracle);
  });

  test('loader: global skills + project skills_remove', () => {
    writeUserConfig({
      agents: { oracle: { skills: ['codemap', 'deepwork'] } },
    });
    writeProjectConfig({
      agents: { oracle: { skills_remove: ['deepwork'] } },
    });

    const loaded = loadPluginConfig(projectDir, { silent: true });
    expect(loaded.agents?.oracle?.skills).toEqual(['codemap']);
    expectNoDirectiveKeys(loaded.agents?.oracle);
  });

  test('loader: simultaneous add + remove with duplicates in one layer', () => {
    writeUserConfig({
      agents: {
        oracle: {
          skills: ['a', 'b'],
          skills_add: ['b', 'c', 'd'],
          skills_remove: ['b', 'd'],
        },
      },
    });

    const loaded = loadPluginConfig(projectDir, { silent: true });
    expect(loaded.agents?.oracle?.skills).toEqual(['a', 'c']);
    expectNoDirectiveKeys(loaded.agents?.oracle);
  });

  test('loader: agent without existing skills gains skills via skills_add', () => {
    writeProjectConfig({
      agents: { oracle: { skills_add: ['x', 'y'] } },
    });

    const loaded = loadPluginConfig(projectDir, { silent: true });
    expect(loaded.agents?.oracle?.skills).toEqual(['x', 'y']);
    expectNoDirectiveKeys(loaded.agents?.oracle);
  });

  test('loader: removal only, no base list', () => {
    writeProjectConfig({
      agents: {
        orchestrator: { skills_remove: ['foo'] },
        oracle: { skills_remove: ['codemap'] },
      },
    });

    const loaded = loadPluginConfig(projectDir, { silent: true });
    expect(loaded.agents?.orchestrator?.skills).toEqual(['*', '!foo']);
    expectNoDirectiveKeys(loaded.agents?.orchestrator);
    expect(loaded.agents?.oracle?.skills).toEqual(
      getDefaultGrantedSkillNames('oracle').filter((n) => n !== 'codemap'),
    );
    expectNoDirectiveKeys(loaded.agents?.oracle);
  });

  test('loader: custom agent inherits project skills_add', () => {
    writeUserConfig({
      agents: { 'my-agent': { model: 'openai/gpt-4o' } },
    });
    writeProjectConfig({
      agents: { 'my-agent': { skills_add: ['proj-skill'] } },
    });

    const loaded = loadPluginConfig(projectDir, { silent: true });
    expect(loaded.agents?.['my-agent']?.skills).toEqual(['proj-skill']);
    expectNoDirectiveKeys(loaded.agents?.['my-agent']);
  });

  test('loader: preset skills + project skills_add', () => {
    writeUserConfig({
      preset: 'p1',
      presets: { p1: { oracle: { skills: ['a', 'b'] } } },
    });
    writeProjectConfig({
      agents: { oracle: { skills_add: ['c'] } },
    });

    const loaded = loadPluginConfig(projectDir, { silent: true });
    expect(loaded.agents?.oracle?.skills).toEqual(['a', 'b', 'c']);
    expectNoDirectiveKeys(loaded.agents?.oracle);
  });

  test('loader: preset skills + project skills_remove', () => {
    writeUserConfig({
      preset: 'p1',
      presets: { p1: { oracle: { skills: ['a', 'b'] } } },
    });
    writeProjectConfig({
      agents: { oracle: { skills_remove: ['b'] } },
    });

    const loaded = loadPluginConfig(projectDir, { silent: true });
    expect(loaded.agents?.oracle?.skills).toEqual(['a']);
    expectNoDirectiveKeys(loaded.agents?.oracle);
  });

  test('loader: root skills replace preset skills, directive still applies', () => {
    writeUserConfig({
      preset: 'p1',
      presets: { p1: { oracle: { skills: ['a', 'b'] } } },
      agents: { oracle: { skills: ['x'] } },
    });
    writeProjectConfig({
      agents: { oracle: { skills_add: ['c'] } },
    });

    const loaded = loadPluginConfig(projectDir, { silent: true });
    expect(loaded.agents?.oracle?.skills).toEqual(['x', 'c']);
    expectNoDirectiveKeys(loaded.agents?.oracle);
  });

  test('loader: preset-layer removal survives field-level merge', () => {
    writeUserConfig({
      preset: 'p1',
      presets: {
        p1: {
          oracle: { skills: ['a', 'b'], skills_remove: ['a'] },
        },
      },
      agents: { oracle: { skills: ['x'] } },
    });

    const loaded = loadPluginConfig(projectDir, { silent: true });
    expect(loaded.agents?.oracle?.skills).toEqual(['x']);
    expectNoDirectiveKeys(loaded.agents?.oracle);
  });

  test('loader: wildcard base + project removal', () => {
    writeUserConfig({
      agents: { oracle: { skills: ['*'] } },
    });
    writeProjectConfig({
      agents: { oracle: { skills_remove: ['foo'] } },
    });

    const loaded = loadPluginConfig(projectDir, { silent: true });
    expect(loaded.agents?.oracle?.skills).toEqual(['*', '!foo']);
    expectNoDirectiveKeys(loaded.agents?.oracle);
  });

  test('loader: plain skills entry without directives is unchanged', () => {
    writeUserConfig({
      agents: { oracle: { skills: ['*'] } },
    });

    const loaded = loadPluginConfig(projectDir, { silent: true });
    expect(loaded.agents?.oracle).toEqual({ skills: ['*'] });
    expectNoDirectiveKeys(loaded.agents?.oracle);
  });

  // Schema validation --------------------------------------------------------

  test('schema: rejects invalid skills_add / skills_remove values', () => {
    for (const invalid of [
      { agents: { oracle: { skills_add: 'foo' } } },
      { agents: { oracle: { skills_add: [1, 2] } } },
      { agents: { oracle: { skills_remove: 'foo' } } },
      { agents: { oracle: { skills_remove: [1, 2] } } },
      { presets: { p1: { oracle: { skills_add: 'foo' } } } },
    ]) {
      expect(
        PluginConfigSchema.safeParse(invalid).success,
        JSON.stringify(invalid),
      ).toBe(false);
    }
  });

  test('schema: accepts string arrays in root agents and presets', () => {
    const valid = PluginConfigSchema.safeParse({
      agents: {
        oracle: { skills_add: ['a'], skills_remove: ['b'] },
      },
      presets: {
        p1: { oracle: { skills_add: ['a'], skills_remove: ['b'] } },
      },
    });
    expect(valid.success).toBe(true);
  });

  // RuntimeConfig -------------------------------------------------------------

  test('runtime: agents() folds preset and runtime-preset directives', () => {
    const config: PluginConfig = {
      preset: 'p1',
      agents: { oracle: { skills: ['a'] } },
      presets: {
        p1: { oracle: { skills_add: ['b'] } },
        p2: { oracle: { skills_remove: ['a'] } },
      },
    };
    const runtime = runtimeFor(config);

    const initial = runtime.agents().oracle;
    expect(initial.skills).toEqual(['a', 'b']);
    expectNoDirectiveKeys(initial);

    runtime.setRuntimePreset('p2');
    const switched = runtime.agents().oracle;
    expect(switched.skills).toEqual(['b']);
    expectNoDirectiveKeys(switched);
  });

  // createAgents integration ----------------------------------------------------

  test('createAgents: folded skills become permission grants', () => {
    const config: PluginConfig = {
      agents: {
        oracle: { skills: ['simplify'], skills_add: ['my-skill'] },
      },
    };
    const agents = createAgents(runtimeFor(config));
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle).toBeDefined();
    const skillPermissions = (
      oracle?.config.permission as Record<string, unknown>
    )?.skill as Record<string, unknown> | undefined;
    expect(skillPermissions?.['my-skill']).toBe('allow');
    expect(skillPermissions?.simplify).toBe('allow');
  });
});
