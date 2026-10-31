import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeConfig } from '../config/runtime';
import {
  discoverOnDiskSkillNames,
  discoverPreflightSkills,
  loadMergedOpenCodeConfig,
} from './preflight';

const ENV_KEYS = [
  'XDG_CONFIG_HOME',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_TEST_HOME',
  'OPENCODE_DISABLE_PROJECT_CONFIG',
  'OPENCODE_DISABLE_EXTERNAL_SKILLS',
  'OPENCODE_DISABLE_CLAUDE_CODE',
  'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS',
] as const;
const previousEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setConfigHome(path: string): void {
  process.env.XDG_CONFIG_HOME = join(path, 'xdg');
  process.env.OPENCODE_TEST_HOME = join(path, 'home');
}

function writeSkill(path: string, name: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    `---\nname: |-${'\n'}  ${name}\ndescription: Test skill.\n---\n\n# body\n`,
  );
}

describe('marketplace host preflight', () => {
  test('merges user and project config with JSONC precedence within each layer', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-preflight-'));
    const project = join(root, 'project');
    const userDir = join(root, 'xdg', 'opencode');
    try {
      setConfigHome(root);
      mkdirSync(join(project, '.opencode'), { recursive: true });
      mkdirSync(userDir, { recursive: true });
      writeFileSync(
        join(userDir, 'opencode.json'),
        JSON.stringify({
          mcp: { user: { type: 'remote', url: 'https://user' } },
        }),
      );
      writeFileSync(
        join(project, '.opencode', 'opencode.json'),
        JSON.stringify({
          mcp: {
            inherited: { type: 'remote', url: 'https://json' },
            winner: { type: 'remote', url: 'https://json' },
          },
        }),
      );
      writeFileSync(
        join(project, '.opencode', 'opencode.jsonc'),
        '{ // JSONC is the later override\n "mcp": { "winner": { "type": "remote", "url": "https://jsonc" } } }',
      );
      const config = loadMergedOpenCodeConfig(project);
      const mcp = config.mcp as Record<string, { url?: string }>;
      expect(mcp.user).toBeDefined();
      expect(mcp.inherited).toBeDefined();
      expect(mcp.winner.url).toBe('https://jsonc');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('current project MCP settings override ancestor settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-preflight-'));
    const project = join(root, 'project');
    try {
      setConfigHome(root);
      mkdirSync(join(root, '.git'), { recursive: true });
      mkdirSync(join(root, '.opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(
        join(root, '.opencode', 'opencode.json'),
        JSON.stringify({
          mcp: {
            projectDisables: {
              type: 'remote',
              url: 'https://ancestor',
              enabled: true,
            },
            projectEnables: {
              type: 'remote',
              url: 'https://ancestor',
              enabled: false,
            },
          },
        }),
      );
      writeFileSync(
        join(project, '.opencode', 'opencode.json'),
        JSON.stringify({
          mcp: {
            projectDisables: {
              type: 'remote',
              url: 'https://project',
              enabled: false,
            },
            projectEnables: {
              type: 'remote',
              url: 'https://project',
              enabled: true,
            },
          },
        }),
      );

      const config = loadMergedOpenCodeConfig(project);
      const mcps = config.mcp as Record<string, { enabled?: boolean }>;
      expect(mcps.projectDisables.enabled).toBe(false);
      expect(mcps.projectEnables.enabled).toBe(true);
    } finally {
      RuntimeConfig.reset(project);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('parses JSONC environment content and ignores malformed content', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-preflight-'));
    try {
      setConfigHome(root);
      process.env.OPENCODE_CONFIG_CONTENT =
        '{ /* env overlay */ "mcp": { "from_env": { "type": "remote", "url": "https://env", }, }, }';
      expect(loadMergedOpenCodeConfig(root).mcp).toHaveProperty('from_env');
      process.env.OPENCODE_CONFIG_CONTENT = '{ "mcp": ';
      expect(loadMergedOpenCodeConfig(root).mcp).toBeUndefined();
    } finally {
      RuntimeConfig.reset(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('discovers block-scalar skills and confines symlinks to each root', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-preflight-'));
    const skillRoot = join(root, 'skills');
    const outside = join(root, 'outside');
    try {
      setConfigHome(root);
      writeSkill(join(skillRoot, 'good', 'SKILL.md'), 'block-skill');
      writeSkill(join(outside, 'SKILL.md'), 'outside-skill');
      symlinkSync(outside, join(skillRoot, 'escape'), 'dir');
      expect(discoverOnDiskSkillNames(root, [skillRoot])).toEqual([
        'block-skill',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('filters disabled runtime skills', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-preflight-'));
    const skills = join(root, 'skills');
    try {
      setConfigHome(root);
      writeSkill(join(skills, 'one', 'SKILL.md'), 'one');
      writeSkill(join(skills, 'two', 'SKILL.md'), 'two');
      const runtime = RuntimeConfig.init(root, {
        disabled_skills: ['one'],
      });
      expect(discoverPreflightSkills(runtime, root, [skills])).toEqual(['two']);
    } finally {
      RuntimeConfig.reset(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
