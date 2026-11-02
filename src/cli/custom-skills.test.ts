import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildBundledSkillInfos,
  removeLegacySkillSyncState,
} from './custom-skills';

const EMPTY_MANAGED_HASH =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function tmpDir(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'omos-skills-')),
  );
}

function writeSkill(root: string, name: string, skillMd: string): void {
  const dir = path.join(root, 'src', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd);
}

describe('buildBundledSkillInfos', () => {
  afterEach(() => mock.restore());

  test('builds in-process entries from package sources, filtering disabled', () => {
    const root = tmpDir();
    writeSkill(
      root,
      'deepwork',
      '---\nname: deepwork\ndescription: Heavy workflow\n---\n\n# Deepwork\nbody',
    );
    writeSkill(
      root,
      'reflect',
      '---\nname: reflect\ndescription: Reflect workflow\n---\nbody',
    );

    const infos = buildBundledSkillInfos(root, ['reflect']);
    expect(infos).toHaveLength(1);
    expect(infos[0].id).toBe('deepwork');
    expect(infos[0].name).toBe('deepwork');
    expect(infos[0].description).toBe('Heavy workflow');
    expect(infos[0].content).toBe('# Deepwork\nbody');
    expect(
      infos[0].path.endsWith(
        path.join('src', 'skills', 'deepwork', 'SKILL.md'),
      ),
    ).toBe(true);
  });

  test('falls back to registry metadata when frontmatter is missing', () => {
    const root = tmpDir();
    writeSkill(root, 'simplify', '# Simplify\nno frontmatter here');

    const infos = buildBundledSkillInfos(root, []);
    expect(infos).toHaveLength(1);
    expect(infos[0].id).toBe('simplify');
    expect(infos[0].description).toBe(
      'Code simplification and readability-focused refactoring',
    );
  });

  test('folded frontmatter values fall back to registry metadata', () => {
    const root = tmpDir();
    writeSkill(
      root,
      'simplify',
      '---\nname: simplify\ndescription: >-\n---\nbody',
    );

    const infos = buildBundledSkillInfos(root, []);
    expect(infos).toHaveLength(1);
    expect(infos[0].description).toBe(
      'Code simplification and readability-focused refactoring',
    );
  });

  test('missing skill sources are skipped, disabled list wins', () => {
    const root = tmpDir();
    writeSkill(root, 'deepwork', '---\nname: deepwork\n---\nbody');
    // 'reflect' listed in the registry but absent on disk

    expect(buildBundledSkillInfos(root, ['deepwork'])).toEqual([]);
    const infos = buildBundledSkillInfos(root, ['reflect']);
    expect(infos).toHaveLength(1);
    expect(infos[0].id).toBe('deepwork');
  });
});

describe('removeLegacySkillSyncState', () => {
  afterEach(() => mock.restore());

  test('removes manifest-tracked skill copies and the legacy state dir', () => {
    const configDir = tmpDir();
    fs.mkdirSync(path.join(configDir, '.oh-my-opencode-slim'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(configDir, '.oh-my-opencode-slim', 'skills-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        skills: {
          deepwork: { status: 'managed', lastManagedHash: EMPTY_MANAGED_HASH },
          reflect: { status: 'managed', lastManagedHash: EMPTY_MANAGED_HASH },
        },
      }),
    );
    for (const name of ['deepwork', 'reflect', 'user-own-skill']) {
      fs.mkdirSync(path.join(configDir, 'skills', name), { recursive: true });
    }

    const result = removeLegacySkillSyncState(configDir);

    expect(result).toEqual({
      kept: [],
      backedUp: [],
      manifestUnreadable: false,
    });
    expect(fs.existsSync(path.join(configDir, 'skills', 'deepwork'))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(configDir, 'skills', 'reflect'))).toBe(
      false,
    );
    expect(
      fs.existsSync(path.join(configDir, 'skills', 'user-own-skill')),
    ).toBe(true);
    expect(fs.existsSync(path.join(configDir, '.oh-my-opencode-slim'))).toBe(
      false,
    );
  });

  test('rejects empty and directory-alias manifest names without deleting parents', () => {
    const configDir = tmpDir();
    const legacyDir = path.join(configDir, '.oh-my-opencode-slim');
    const skillsDir = path.join(configDir, 'skills');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'normal'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'keep.txt'), 'keep');
    fs.writeFileSync(path.join(configDir, 'keep.txt'), 'keep');
    fs.writeFileSync(
      path.join(legacyDir, 'skills-manifest.json'),
      JSON.stringify({
        skills: {
          '': { status: 'managed' },
          '.': { status: 'managed' },
          '..': { status: 'managed' },
          normal: { status: 'managed', lastManagedHash: EMPTY_MANAGED_HASH },
        },
      }),
    );

    removeLegacySkillSyncState(configDir);

    expect(fs.existsSync(skillsDir)).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'normal'))).toBe(false);
  });

  test('keeps customized copies (user edits) and still clears sync state', () => {
    const configDir = tmpDir();
    fs.mkdirSync(path.join(configDir, '.oh-my-opencode-slim'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(configDir, '.oh-my-opencode-slim', 'skills-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        skills: {
          deepwork: { status: 'managed', lastManagedHash: EMPTY_MANAGED_HASH },
          reflect: { status: 'customized' },
        },
      }),
    );
    for (const name of ['deepwork', 'reflect']) {
      fs.mkdirSync(path.join(configDir, 'skills', name), { recursive: true });
    }

    const result = removeLegacySkillSyncState(configDir);

    expect(result.kept).toEqual(['reflect']);
    expect(fs.existsSync(path.join(configDir, 'skills', 'deepwork'))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(configDir, 'skills', 'reflect'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, '.oh-my-opencode-slim'))).toBe(
      false,
    );
  });

  test('keeps managed skills edited after their last sync', () => {
    const configDir = tmpDir();
    const legacyDir = path.join(configDir, '.oh-my-opencode-slim');
    const skillDir = path.join(configDir, 'skills', 'deepwork');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'user edits');
    fs.writeFileSync(
      path.join(legacyDir, 'skills-manifest.json'),
      JSON.stringify({
        skills: {
          deepwork: { status: 'managed', lastManagedHash: EMPTY_MANAGED_HASH },
        },
      }),
    );

    const result = removeLegacySkillSyncState(configDir);
    expect(result.kept).toEqual(['deepwork']);
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe(
      'user edits',
    );
  });

  test('backs up disabled customized copies aside instead of keeping them', () => {
    const configDir = tmpDir();
    fs.mkdirSync(path.join(configDir, '.oh-my-opencode-slim'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(configDir, '.oh-my-opencode-slim', 'skills-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        skills: { reflect: { status: 'customized' } },
      }),
    );
    fs.mkdirSync(path.join(configDir, 'skills', 'reflect'), {
      recursive: true,
    });

    const result = removeLegacySkillSyncState(configDir, ['reflect']);

    expect(result.backedUp).toEqual(['reflect']);
    expect(result.kept).toEqual([]);
    expect(fs.existsSync(path.join(configDir, 'skills', 'reflect'))).toBe(
      false,
    );
    expect(
      fs.existsSync(
        path.join(configDir, '.oh-my-opencode-slim-skill-backups', 'reflect'),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(configDir, '.oh-my-opencode-slim'))).toBe(
      false,
    );
  });

  test('reports an unreadable manifest without touching skills', () => {
    const configDir = tmpDir();
    fs.mkdirSync(path.join(configDir, '.oh-my-opencode-slim'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(configDir, '.oh-my-opencode-slim', 'skills-manifest.json'),
      '{ corrupt json here',
    );
    fs.mkdirSync(path.join(configDir, 'skills', 'deepwork'), {
      recursive: true,
    });

    const result = removeLegacySkillSyncState(configDir);

    expect(result.manifestUnreadable).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'skills', 'deepwork'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(configDir, '.oh-my-opencode-slim'))).toBe(
      true,
    );
  });

  test('no-ops when no manifest exists', () => {
    const configDir = tmpDir();
    fs.mkdirSync(path.join(configDir, 'skills', 'keep'), { recursive: true });

    const result = removeLegacySkillSyncState(configDir);

    expect(result).toEqual({
      kept: [],
      backedUp: [],
      manifestUnreadable: false,
    });
    expect(fs.existsSync(path.join(configDir, 'skills', 'keep'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, '.oh-my-opencode-slim'))).toBe(
      false,
    );
  });
});
