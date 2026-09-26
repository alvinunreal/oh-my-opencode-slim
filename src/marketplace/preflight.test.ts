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
  discoverDesiredV2Mcps,
  discoverOnDiskOpenCodeMcps,
  discoverOnDiskSkillNames,
  discoverPreflightMcps,
  discoverPreflightSkills,
  evaluateMarketplaceRequirements,
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

      const names = discoverPreflightMcps(
        RuntimeConfig.init(project, {}),
        project,
      );
      expect(names).not.toContain('projectDisables');
      expect(names).toContain('projectEnables');
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
      expect(
        discoverPreflightMcps(RuntimeConfig.init(root, {}), root),
      ).toContain('from_env');
      process.env.OPENCODE_CONFIG_CONTENT = '{ "mcp": ';
      expect(loadMergedOpenCodeConfig(root).mcp).toBeUndefined();
    } finally {
      RuntimeConfig.reset(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects malformed host MCP definitions and disabled entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-preflight-'));
    try {
      setConfigHome(root);
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        mcp: {
          valid: { type: 'remote', url: 'https://valid' },
          malformed: { type: 'remote' },
          disabled: { type: 'remote', url: 'https://disabled', enabled: false },
        },
      });
      const names = discoverPreflightMcps(RuntimeConfig.init(root, {}), root);
      expect(names).toContain('valid');
      expect(names).not.toContain('malformed');
      expect(names).not.toContain('disabled');
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

  test('filters disabled runtime skills and MCPs', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-preflight-'));
    const skills = join(root, 'skills');
    try {
      setConfigHome(root);
      writeSkill(join(skills, 'one', 'SKILL.md'), 'one');
      writeSkill(join(skills, 'two', 'SKILL.md'), 'two');
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        mcp: { custom: { type: 'remote', url: 'https://custom' } },
      });
      const runtime = RuntimeConfig.init(root, {
        disabled_skills: ['one'],
        disabled_mcps: ['custom'],
      });
      expect(discoverPreflightSkills(runtime, root, [skills])).toEqual(['two']);
      expect(discoverPreflightMcps(runtime, root)).not.toContain('custom');
    } finally {
      RuntimeConfig.reset(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('extracts enabled v2 desired servers and classifies manifest requirements', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-preflight-'));
    try {
      setConfigHome(root);
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        mcp: {
          servers: {
            desired: { type: 'remote', url: 'https://desired' },
            disabled: {
              type: 'remote',
              url: 'https://disabled',
              disabled: true,
            },
            malformed: { type: 'remote' },
          },
        },
      });
      const runtime = RuntimeConfig.init(root, {});
      expect(Object.keys(discoverOnDiskOpenCodeMcps(root, 'v2'))).toEqual([
        'desired',
      ]);
      expect(discoverDesiredV2Mcps(runtime, root, ['context7'])).toEqual([
        'context7',
        'desired',
      ]);
      expect(
        evaluateMarketplaceRequirements(
          { skills: ['skill-a', 'skill-b'], mcps: ['desired', 'missing'] },
          ['skill-a'],
          ['desired'],
        ),
      ).toEqual({
        skills: {
          required: ['skill-a', 'skill-b'],
          available: ['skill-a'],
          missing: ['skill-b'],
        },
        mcps: {
          required: ['desired', 'missing'],
          available: ['desired'],
          missing: ['missing'],
        },
      });
    } finally {
      RuntimeConfig.reset(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
