import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverProjectLocalSkillNames } from './project-skills';

const tempDirs: string[] = [];

function makeProject(): string {
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'omo-project-skills-'),
  );
  tempDirs.push(projectDir);
  return projectDir;
}

function writeSkillFile(
  projectDir: string,
  relativeDir: string,
  content: string,
): string {
  const skillDir = path.join(projectDir, '.opencode', 'skills', relativeDir);
  fs.mkdirSync(skillDir, { recursive: true });
  const filePath = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('discoverProjectLocalSkillNames', () => {
  test('ignores non-SKILL.md files even when they carry frontmatter', () => {
    const projectDir = makeProject();
    writeSkillFile(projectDir, 'folder', '---\nname: real\n---\n');
    fs.writeFileSync(
      path.join(projectDir, '.opencode', 'skills', 'folder', 'README.md'),
      '---\nname: decoy\n---\n',
    );

    const names = discoverProjectLocalSkillNames(projectDir);
    expect(names).toHaveLength(1);
    expect(names).toEqual(['real']);
  });

  test('discovers a BOM-prefixed SKILL.md by its frontmatter name', () => {
    const projectDir = makeProject();
    writeSkillFile(projectDir, 'bom', '\uFEFF---\nname: bom-skill\n---\n');

    expect(discoverProjectLocalSkillNames(projectDir)).toEqual(['bom-skill']);
  });

  // BOM stripping is anchored to file start; interior BOM bytes are content.
  test('keeps an interior BOM inside the frontmatter name', () => {
    const projectDir = makeProject();
    writeSkillFile(projectDir, 'mid', '---\nname: mid\uFEFFbom\n---\n');

    expect(discoverProjectLocalSkillNames(projectDir)).toEqual([
      'mid\uFEFFbom',
    ]);
  });

  // Quoted values are the observable case: quote stripping leaves the
  // inner whitespace that trim() must remove.
  test('trims whitespace from a quoted frontmatter name', () => {
    const projectDir = makeProject();
    writeSkillFile(projectDir, 'padded', '---\nname: "  padded-name  "\n---\n');

    expect(discoverProjectLocalSkillNames(projectDir)).toEqual(['padded-name']);
  });

  test('ignores name-less frontmatter without adding a phantom entry', () => {
    const projectDir = makeProject();
    writeSkillFile(projectDir, 'valid', '---\nname: valid\n---\n');
    writeSkillFile(projectDir, 'anon', '---\ndescription: no name key\n---\n');
    writeSkillFile(projectDir, 'broken', 'no frontmatter at all');

    const names = discoverProjectLocalSkillNames(projectDir);
    // Bun's toEqual masks trailing undefined array elements.
    expect(names).toHaveLength(1);
    expect(names).toEqual(['valid']);
  });

  test.skipIf(process.platform === 'win32' || (process.getuid?.() ?? 0) === 0)(
    'returns no names when a skills directory is unreadable',
    () => {
      const projectDir = makeProject();
      writeSkillFile(projectDir, 'hidden', '---\nname: hidden\n---\n');
      const skillsRoot = path.join(projectDir, '.opencode', 'skills');
      fs.chmodSync(skillsRoot, 0o000);
      try {
        expect(discoverProjectLocalSkillNames(projectDir)).toEqual([]);
      } finally {
        fs.chmodSync(skillsRoot, 0o755);
      }
    },
  );
});
