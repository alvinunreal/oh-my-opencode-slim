import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let shouldFailRename = false;

mock.module('node:fs', () => {
  const actualFs = require('node:fs');
  return {
    ...actualFs,
    renameSync: (src: string, dest: string) => {
      if (shouldFailRename && src.includes('recovery-failure-test-skill')) {
        throw new Error('Mocked rename failure');
      }
      return actualFs.renameSync(src, dest);
    },
  };
});

let importCounter = 0;

async function syncBundledSkillsFromPackage(
  packageRoot: string,
  options: { force?: boolean } = {},
) {
  const module = await import(`./skill-sync?test=${importCounter++}`);
  return module.syncBundledSkillsFromPackage(packageRoot, {
    skills: getFakeManagedSkills(packageRoot),
    ...options,
  });
}

function getFakeManagedSkills(packageRoot: string) {
  const sourceSkillsDir = path.join(packageRoot, 'src', 'skills');
  if (!fs.existsSync(sourceSkillsDir)) return [];
  return fs
    .readdirSync(sourceSkillsDir)
    .filter((entry) => !entry.startsWith('.'))
    .map((entry) => ({
      name: entry,
      sourcePath: path.relative(packageRoot, path.join(sourceSkillsDir, entry)),
    }));
}

describe('syncBundledSkillsFromPackage', () => {
  let tempDir: string;
  let fakePackageRoot: string;
  let fakeDestConfigDir: string;
  let origEnvConfigDir: string | undefined;

  beforeEach(() => {
    shouldFailRename = false;
    origEnvConfigDir = process.env.OPENCODE_CONFIG_DIR;
    // Create a unique temporary directory for this test run
    const randomId = Math.random().toString(36).substring(2, 10);
    tempDir = path.join(os.tmpdir(), `omo-test-${randomId}`);
    fs.mkdirSync(tempDir, { recursive: true });

    fakePackageRoot = path.join(tempDir, 'fake-package');
    fakeDestConfigDir = path.join(tempDir, 'fake-config');

    fs.mkdirSync(path.join(fakePackageRoot, 'src', 'skills'), {
      recursive: true,
    });
    fs.mkdirSync(fakeDestConfigDir, { recursive: true });

    process.env.OPENCODE_CONFIG_DIR = fakeDestConfigDir;
  });

  afterEach(() => {
    process.env.OPENCODE_CONFIG_DIR = origEnvConfigDir;
    // Clean up temporary directories
    try {
      // Restore permissions of any potentially locked files first
      const restorePermissions = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          const entryPath = path.join(dir, entry);
          try {
            fs.chmodSync(entryPath, 0o777);
          } catch {
            // ignore
          }
          if (fs.statSync(entryPath).isDirectory()) {
            restorePermissions(entryPath);
          }
        }
      };
      restorePermissions(tempDir);
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  test('installs missing bundled skill directories from a fake package root', async () => {
    const skillName = 'test-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Test Skill');
    fs.writeFileSync(path.join(skillSrcDir, 'some-file.txt'), 'hello world');

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.installed).toContain(skillName);
    expect(result.skippedExisting).toHaveLength(0);
    expect(result.failed).toHaveLength(0);

    const destSkillDir = path.join(fakeDestConfigDir, 'skills', skillName);
    expect(fs.existsSync(destSkillDir)).toBe(true);
    expect(fs.readFileSync(path.join(destSkillDir, 'SKILL.md'), 'utf-8')).toBe(
      '# Test Skill',
    );
    expect(
      fs.readFileSync(path.join(destSkillDir, 'some-file.txt'), 'utf-8'),
    ).toBe('hello world');
  });

  test('skips existing destination skill folders without overwriting', async () => {
    const skillName = 'existing-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Updated Skill');

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const destSkillDir = path.join(destSkillsDir, skillName);
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.writeFileSync(path.join(destSkillDir, 'SKILL.md'), '# Original Skill');

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.installed).toHaveLength(0);
    expect(result.skippedExisting).toContain(skillName);
    expect(result.failed).toHaveLength(0);

    // Should not have overwritten
    expect(fs.readFileSync(path.join(destSkillDir, 'SKILL.md'), 'utf-8')).toBe(
      '# Original Skill',
    );
  });

  test('force overwrites customized managed skill directories', async () => {
    const skillName = 'force-customized-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Bundled Skill');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    const stagedDir = path.join(
      manifestDir,
      'skill-updates',
      '1.0.0',
      skillName,
    );
    fs.mkdirSync(stagedDir, { recursive: true });
    fs.writeFileSync(path.join(stagedDir, 'SKILL.md'), '# Staged Skill');
    fs.writeFileSync(
      path.join(manifestDir, 'skills-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        skills: {
          [skillName]: {
            status: 'customized',
            packageVersion: '1.0.0',
            sourceHash: 'old-source-hash',
            lastManagedHash: 'old-managed-hash',
            lastSeenHash: 'customized-hash',
            stagedPath: stagedDir,
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    );

    const destSkillDir = path.join(fakeDestConfigDir, 'skills', skillName);
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.writeFileSync(path.join(destSkillDir, 'SKILL.md'), '# Customized Skill');

    const result = await syncBundledSkillsFromPackage(fakePackageRoot, {
      force: true,
    });

    expect(result.installed).toContain(skillName);
    expect(result.staged).not.toContain(skillName);
    expect(result.customized).not.toContain(skillName);
    expect(fs.readFileSync(path.join(destSkillDir, 'SKILL.md'), 'utf-8')).toBe(
      '# Bundled Skill',
    );
    expect(fs.existsSync(stagedDir)).toBe(false);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(manifestDir, 'skills-manifest.json'), 'utf-8'),
    );
    expect(manifest.skills[skillName].status).toBe('managed');
    expect(manifest.skills[skillName].stagedPath).toBeUndefined();
  });

  test('force skips destination files and symlinks without overwriting', async () => {
    const fileSkill = 'force-file-skill';
    const symlinkSkill = 'force-symlink-skill';
    for (const skillName of [fileSkill, symlinkSkill]) {
      const skillSrcDir = path.join(
        fakePackageRoot,
        'src',
        'skills',
        skillName,
      );
      fs.mkdirSync(skillSrcDir, { recursive: true });
      fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Bundled Skill');
    }

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const filePath = path.join(destSkillsDir, fileSkill);
    fs.writeFileSync(filePath, '# User File');
    const symlinkTarget = path.join(fakeDestConfigDir, 'symlink-target');
    fs.mkdirSync(symlinkTarget, { recursive: true });
    fs.writeFileSync(path.join(symlinkTarget, 'SKILL.md'), '# User Symlink');
    const symlinkPath = path.join(destSkillsDir, symlinkSkill);
    fs.symlinkSync(symlinkTarget, symlinkPath, 'dir');

    const result = await syncBundledSkillsFromPackage(fakePackageRoot, {
      force: true,
    });

    expect(result.installed).toHaveLength(0);
    expect(result.skippedExisting).toEqual(
      expect.arrayContaining([fileSkill, symlinkSkill]),
    );
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('# User File');
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(symlinkTarget, 'SKILL.md'), 'utf-8')).toBe(
      '# User Symlink',
    );
  });

  test('ignores non-skill directories without SKILL.md', async () => {
    const skillName = 'no-skill-md';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'other-file.txt'), 'hello');

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.installed).toHaveLength(0);
    expect(result.skippedExisting).toHaveLength(0);
    expect(result.failed).toHaveLength(0);

    const destSkillDir = path.join(fakeDestConfigDir, 'skills', skillName);
    expect(fs.existsSync(destSkillDir)).toBe(false);
  });

  test('records failures and continues on errors', async () => {
    // We create one good skill and one bad/locked skill to cause failure.
    // The good skill should still install.
    const goodSkill = 'good-skill';
    const goodSrcDir = path.join(fakePackageRoot, 'src', 'skills', goodSkill);
    fs.mkdirSync(goodSrcDir, { recursive: true });
    fs.writeFileSync(path.join(goodSrcDir, 'SKILL.md'), '# Good');

    const badSkill = 'bad-skill';
    const badSrcDir = path.join(fakePackageRoot, 'src', 'skills', badSkill);
    fs.mkdirSync(badSrcDir, { recursive: true });
    fs.writeFileSync(path.join(badSrcDir, 'SKILL.md'), '# Bad');

    // We lock a nested file/dir or create a file inside staging with chmod 000
    // Actually, making a nested directory unreadable inside badSrcDir will cause copyDirRecursive to fail
    const unreadableDir = path.join(badSrcDir, 'locked-subdir');
    fs.mkdirSync(unreadableDir, { recursive: true });
    fs.writeFileSync(path.join(unreadableDir, 'secret.txt'), 'top secret');
    fs.chmodSync(unreadableDir, 0o000);

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.installed).toContain(goodSkill);
    expect(result.failed).toContain(badSkill);

    // Staging and final bad-skill dir helper cleanup checks
    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    const badDestDir = path.join(destSkillsDir, badSkill);
    expect(fs.existsSync(badDestDir)).toBe(false);

    // Verify no staging directories are left behind in destSkillsDir
    const destEntries = fs.readdirSync(destSkillsDir);
    const stagingDirs = destEntries.filter(
      (entry) => entry.startsWith('.staging-') || entry.startsWith('.backup-'),
    );
    expect(stagingDirs).toHaveLength(0);
  });

  test('missing source skills directory returns empty results and does not throw', async () => {
    // Delete the source skills directory entirely
    const sourceSkillsDir = path.join(fakePackageRoot, 'src', 'skills');
    fs.rmSync(sourceSkillsDir, { recursive: true, force: true });

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);
    expect(result.installed).toHaveLength(0);
    expect(result.skippedExisting).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  test('creates destination skills parent directory when absent', async () => {
    // Delete the fake-config directory completely so even the parent is missing
    fs.rmSync(fakeDestConfigDir, { recursive: true, force: true });

    const skillName = 'auto-create-parent';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Parent Created');

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.installed).toContain(skillName);
    const destSkillDir = path.join(fakeDestConfigDir, 'skills', skillName);
    expect(fs.existsSync(destSkillDir)).toBe(true);
  });

  test('existing destination file/symlink is skipped and not overwritten', async () => {
    const skillName = 'file-blocking-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Target');

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const destSkillPath = path.join(destSkillsDir, skillName);

    // Create a regular file in place of the skill directory
    fs.writeFileSync(destSkillPath, 'I am a blocking file');

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.installed).toHaveLength(0);
    expect(result.skippedExisting).toContain(skillName);
    expect(result.failed).toHaveLength(0);

    // Should still be the file, not a directory
    expect(fs.lstatSync(destSkillPath).isFile()).toBe(true);
    expect(fs.readFileSync(destSkillPath, 'utf-8')).toBe(
      'I am a blocking file',
    );
  });

  test('existing destination symlink is skipped and not overwritten', async () => {
    const skillName = 'symlink-blocking-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Target');

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const symlinkTarget = path.join(fakeDestConfigDir, 'custom-skill-target');
    fs.mkdirSync(symlinkTarget, { recursive: true });
    fs.writeFileSync(path.join(symlinkTarget, 'SKILL.md'), '# Custom');
    const destSkillPath = path.join(destSkillsDir, skillName);
    fs.symlinkSync(symlinkTarget, destSkillPath, 'dir');

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.installed).toHaveLength(0);
    expect(result.skippedExisting).toContain(skillName);
    expect(result.failed).toHaveLength(0);
    expect(fs.lstatSync(destSkillPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(symlinkTarget, 'SKILL.md'), 'utf-8')).toBe(
      '# Custom',
    );
  });

  test('source symlink directories are ignored', async () => {
    const realSkill = 'real-skill';
    const realSrcDir = path.join(fakePackageRoot, 'src', 'skills', realSkill);
    fs.mkdirSync(realSrcDir, { recursive: true });
    fs.writeFileSync(path.join(realSrcDir, 'SKILL.md'), '# Real');

    const symlinkSkill = 'symlink-skill';
    const symlinkSrcDir = path.join(
      fakePackageRoot,
      'src',
      'skills',
      symlinkSkill,
    );

    // Create a symlink in source pointing to real-skill directory
    fs.symlinkSync(realSrcDir, symlinkSrcDir, 'dir');

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.installed).toContain(realSkill);
    expect(result.installed).not.toContain(symlinkSkill);
    expect(result.skippedExisting).toHaveLength(0);
    expect(result.failed).toHaveLength(0);

    const destSkillDir = path.join(fakeDestConfigDir, 'skills', symlinkSkill);
    expect(fs.existsSync(destSkillDir)).toBe(false);
  });

  test('adopts and updates existing destination skill if it matches legacy official hashes (no manifest)', async () => {
    const skillName = 'legacy-skill';
    const legacyContent = 'old legacy skill content';

    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillSrcDir, 'SKILL.md'),
      '# Updated Legacy Skill',
    );

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const destSkillDir = path.join(destSkillsDir, skillName);
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.writeFileSync(path.join(destSkillDir, 'SKILL.md'), legacyContent);

    const testIndex = importCounter++;
    const {
      computeDirectoryHash,
      LEGACY_MANAGED_SKILL_HASHES: legHashes,
      syncBundledSkillsFromPackage: syncFn,
    } = await import(`./skill-sync?test=${testIndex}`);
    const legacyHash = computeDirectoryHash(destSkillDir);

    legHashes[skillName] = [legacyHash];

    const result = syncFn(fakePackageRoot, {
      skills: getFakeManagedSkills(fakePackageRoot),
    });

    expect(result.installed).toContain(skillName);
    expect(fs.readFileSync(path.join(destSkillDir, 'SKILL.md'), 'utf-8')).toBe(
      '# Updated Legacy Skill',
    );

    const manifestPath = path.join(
      fakeDestConfigDir,
      '.oh-my-opencode-slim',
      'skills-manifest.json',
    );
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.skills[skillName].status).toBe('managed');

    delete legHashes[skillName];
  });

  test('stages update and marks customized if managed skill was modified by user', async () => {
    const skillName = 'custom-skill-test';

    fs.writeFileSync(
      path.join(fakePackageRoot, 'package.json'),
      JSON.stringify({ version: '1.1.0' }),
    );

    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillSrcDir, 'SKILL.md'),
      '# Current Bundled Skill',
    );

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');

    const initialManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        [skillName]: {
          status: 'managed',
          packageVersion: '1.0.0',
          sourceHash: 'old-source-hash',
          lastManagedHash: 'old-managed-hash',
          lastSeenHash: 'old-managed-hash',
          updatedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2));

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const destSkillDir = path.join(destSkillsDir, skillName);
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(destSkillDir, 'SKILL.md'),
      '# User Modified Skill',
    );

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.skippedExisting).toContain(skillName);
    expect(fs.readFileSync(path.join(destSkillDir, 'SKILL.md'), 'utf-8')).toBe(
      '# User Modified Skill',
    );

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const stagedPath = manifest.skills[skillName].stagedPath as string;
    expect(stagedPath).toBeDefined();
    expect(fs.existsSync(stagedPath)).toBe(true);
    expect(fs.readFileSync(path.join(stagedPath, 'SKILL.md'), 'utf-8')).toBe(
      '# Current Bundled Skill',
    );

    expect(manifest.skills[skillName].status).toBe('customized');
    expect(result.stagedThisSync).toEqual([skillName]);

    const unchangedResult = await syncBundledSkillsFromPackage(fakePackageRoot);
    expect(unchangedResult.customized).toEqual([skillName]);
    expect(unchangedResult.stagedThisSync).toEqual([]);
  });

  test('fails closed (only installs missing) when manifest is corrupt', async () => {
    const missingSkill = 'missing-skill';
    const existingSkill = 'existing-skill';

    const missingSrcDir = path.join(
      fakePackageRoot,
      'src',
      'skills',
      missingSkill,
    );
    fs.mkdirSync(missingSrcDir, { recursive: true });
    fs.writeFileSync(path.join(missingSrcDir, 'SKILL.md'), '# Missing');

    const existingSrcDir = path.join(
      fakePackageRoot,
      'src',
      'skills',
      existingSkill,
    );
    fs.mkdirSync(existingSrcDir, { recursive: true });
    fs.writeFileSync(
      path.join(existingSrcDir, 'SKILL.md'),
      '# Existing Source',
    );

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const destExistingDir = path.join(destSkillsDir, existingSkill);
    fs.mkdirSync(destExistingDir, { recursive: true });
    fs.writeFileSync(
      path.join(destExistingDir, 'SKILL.md'),
      '# Existing Dest Original',
    );

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');
    fs.writeFileSync(manifestPath, '{ corrupt json here');

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.installed).toContain(missingSkill);
    expect(fs.existsSync(path.join(destSkillsDir, missingSkill))).toBe(true);

    expect(result.skippedExisting).toContain(existingSkill);
    expect(
      fs.readFileSync(path.join(destExistingDir, 'SKILL.md'), 'utf-8'),
    ).toBe('# Existing Dest Original');

    const manifestParsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifestParsed.schemaVersion).toBe(1);
    expect(manifestParsed.skills[missingSkill].status).toBe('managed');
    expect(manifestParsed.skills[existingSkill].status).toBe('customized');
  });

  test('prevents reinstall when manifest indicates skill was deleted by user', async () => {
    const skillName = 'deleted-skill-test';

    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Current');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');

    const initialManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        [skillName]: {
          status: 'deleted',
          packageVersion: '1.0.0',
          sourceHash: 'some-hash',
          lastManagedHash: 'some-hash',
          lastSeenHash: 'some-hash',
          updatedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2));

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.installed).not.toContain(skillName);
    expect(
      fs.existsSync(path.join(fakeDestConfigDir, 'skills', skillName)),
    ).toBe(false);
  });

  test('recovers conflict status when destination is now a directory', async () => {
    const skillName = 'conflict-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Bundled Content');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');

    const initialManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        [skillName]: {
          status: 'conflict',
          packageVersion: '1.0.0',
          sourceHash: 'old-source-hash',
          lastManagedHash: 'old-managed-hash',
          lastSeenHash: 'old-seen-hash',
          updatedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2));

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const destSkillDir = path.join(destSkillsDir, skillName);
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(destSkillDir, 'SKILL.md'),
      '# Customized Content',
    );

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.customized).toContain(skillName);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.skills[skillName].status).toBe('customized');
    const stagedPath = manifest.skills[skillName].stagedPath as string;
    expect(stagedPath).toBeDefined();
    expect(fs.readFileSync(path.join(stagedPath, 'SKILL.md'), 'utf-8')).toBe(
      '# Bundled Content',
    );
  });

  test('conflict recovery deletes staged directory when adopted back as managed', async () => {
    const skillName = 'conflict-adopt-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Bundle Content');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');

    const stagedDir = path.join(
      manifestDir,
      'skill-updates',
      '1.0.0',
      skillName,
    );
    fs.mkdirSync(stagedDir, { recursive: true });
    fs.writeFileSync(path.join(stagedDir, 'SKILL.md'), '# Staged');

    const initialManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        [skillName]: {
          status: 'conflict',
          packageVersion: '1.0.0',
          sourceHash: 'old-source-hash',
          lastManagedHash: 'old-managed-hash',
          lastSeenHash: 'old-seen-hash',
          stagedPath: stagedDir,
          updatedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2));

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    // Destination matches the incoming source content exactly
    const destSkillDir = path.join(destSkillsDir, skillName);
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.writeFileSync(path.join(destSkillDir, 'SKILL.md'), '# Bundle Content');

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.adopted).toContain(skillName);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.skills[skillName].status).toBe('managed');
    expect(manifest.skills[skillName].stagedPath).toBeUndefined();
    expect(fs.existsSync(stagedDir)).toBe(false);
  });

  test('conflict overwrite deletes staged directory when destination becomes a non-directory file/symlink', async () => {
    const skillName = 'conflict-file-overwrite-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Bundle Content');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');

    const stagedDir = path.join(
      manifestDir,
      'skill-updates',
      '1.0.0',
      skillName,
    );
    fs.mkdirSync(stagedDir, { recursive: true });
    fs.writeFileSync(path.join(stagedDir, 'SKILL.md'), '# Staged');

    const initialManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        [skillName]: {
          status: 'customized',
          packageVersion: '1.0.0',
          sourceHash: 'old-source-hash',
          lastManagedHash: 'old-managed-hash',
          lastSeenHash: 'old-seen-hash',
          stagedPath: stagedDir,
          updatedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2));

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    // Destination is a file (conflict)
    const destSkillPath = path.join(destSkillsDir, skillName);
    fs.writeFileSync(destSkillPath, 'some conflict file');

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.skippedExisting).toContain(skillName);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.skills[skillName].status).toBe('conflict');
    expect(manifest.skills[skillName].stagedPath).toBeUndefined();
    expect(fs.existsSync(stagedDir)).toBe(false);
  });

  test('fails closed (only installs missing) when manifest validation fails (schemaVersion mismatch)', async () => {
    const missingSkill = 'missing-skill';
    const existingSkill = 'existing-skill';

    const missingSrcDir = path.join(
      fakePackageRoot,
      'src',
      'skills',
      missingSkill,
    );
    fs.mkdirSync(missingSrcDir, { recursive: true });
    fs.writeFileSync(path.join(missingSrcDir, 'SKILL.md'), '# Missing');

    const existingSrcDir = path.join(
      fakePackageRoot,
      'src',
      'skills',
      existingSkill,
    );
    fs.mkdirSync(existingSrcDir, { recursive: true });
    fs.writeFileSync(
      path.join(existingSrcDir, 'SKILL.md'),
      '# Existing Source',
    );

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const destExistingDir = path.join(destSkillsDir, existingSkill);
    fs.mkdirSync(destExistingDir, { recursive: true });
    fs.writeFileSync(
      path.join(destExistingDir, 'SKILL.md'),
      '# Existing Dest Original',
    );

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');

    const invalidManifest = {
      schemaVersion: 2,
      updatedAt: new Date().toISOString(),
      skills: {
        [existingSkill]: {
          status: 'managed',
          packageVersion: '1.0.0',
          sourceHash: 'some-hash',
          lastManagedHash: 'some-hash',
          lastSeenHash: 'some-hash',
          updatedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(invalidManifest, null, 2));

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.installed).toContain(missingSkill);
    expect(fs.existsSync(path.join(destSkillsDir, missingSkill))).toBe(true);

    expect(result.skippedExisting).toContain(existingSkill);
    expect(
      fs.readFileSync(path.join(destExistingDir, 'SKILL.md'), 'utf-8'),
    ).toBe('# Existing Dest Original');
  });

  test('customized convergence: customized adopts back to managed when destHash equals current sourceHash', async () => {
    const skillName = 'convergence-skill';

    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Identical Content');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');

    const stagedDir = path.join(
      manifestDir,
      'skill-updates',
      '1.0.0',
      skillName,
    );
    fs.mkdirSync(stagedDir, { recursive: true });
    fs.writeFileSync(path.join(stagedDir, 'SKILL.md'), '# Staged');

    const initialManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        [skillName]: {
          status: 'customized',
          packageVersion: '1.0.0',
          sourceHash: 'old-source-hash',
          lastManagedHash: 'old-managed-hash',
          lastSeenHash: 'user-custom-hash',
          stagedPath: stagedDir,
          updatedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2));

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const destSkillDir = path.join(destSkillsDir, skillName);
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(destSkillDir, 'SKILL.md'),
      '# Identical Content',
    );

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.adopted).toContain(skillName);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.skills[skillName].status).toBe('managed');
    expect(manifest.skills[skillName].stagedPath).toBeUndefined();
    expect(fs.existsSync(stagedDir)).toBe(false);
  });

  test('lock recovery: steals lock when owner host matches and owner process is dead', async () => {
    const skillName = 'lock-recovery-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Content');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const lockDir = path.join(manifestDir, 'skills.lock');
    fs.mkdirSync(lockDir, { recursive: true });

    const deadOwner = {
      pid: 999999,
      host: require('node:os').hostname(),
      time: Date.now() - 5000,
    };
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify(deadOwner),
      'utf-8',
    );

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.installed).toContain(skillName);
    expect(result.failed).not.toContain('__lock__');
  });

  test('returns failed: ["__lock__"] when lock acquisition fails', async () => {
    const skillName = 'lock-fail-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Content');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const lockDir = path.join(manifestDir, 'skills.lock');
    fs.mkdirSync(lockDir, { recursive: true });

    const activeOwner = {
      pid: process.pid,
      host: require('node:os').hostname(),
      time: Date.now(),
    };
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify(activeOwner),
      'utf-8',
    );

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.failed).toContain('__lock__');
    expect(result.installed).not.toContain(skillName);
  });

  test('cross-host lock: fails closed for fresh locks from another host', async () => {
    const skillName = 'cross-host-lock-fresh';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Content');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const lockDir = path.join(manifestDir, 'skills.lock');
    fs.mkdirSync(lockDir, { recursive: true });

    const activeOwner = {
      pid: 1234,
      host: 'another-host',
      time: Date.now() - 30 * 1000, // 30 seconds ago
    };
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify(activeOwner),
      'utf-8',
    );

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.failed).toContain('__lock__');
    expect(result.installed).not.toContain(skillName);
  });

  test('cross-host lock: reclaims lock for stale locks from another host', async () => {
    const skillName = 'cross-host-lock-stale';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Content');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const lockDir = path.join(manifestDir, 'skills.lock');
    fs.mkdirSync(lockDir, { recursive: true });

    const staleOwner = {
      pid: 1234,
      host: 'another-host',
      time: Date.now() - 6 * 60 * 1000, // 6 minutes ago
    };
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify(staleOwner),
      'utf-8',
    );

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.failed).not.toContain('__lock__');
    expect(result.installed).toContain(skillName);
  });

  test('managed skill: updates packageVersion and updatedAt metadata even if content is unchanged', async () => {
    const skillName = 'version-update-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Managed Content');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');

    const originalTime = new Date(
      Date.now() - 24 * 60 * 60 * 1000,
    ).toISOString();
    const initialManifest = {
      schemaVersion: 1,
      updatedAt: originalTime,
      skills: {
        [skillName]: {
          status: 'managed',
          packageVersion: '1.0.0',
          sourceHash: '', // Will be calculated and match below
          lastManagedHash: '',
          lastSeenHash: '',
          updatedAt: originalTime,
        },
      },
    };

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const destSkillDir = path.join(destSkillsDir, skillName);
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.writeFileSync(path.join(destSkillDir, 'SKILL.md'), '# Managed Content');

    const { computeDirectoryHash } = await import(
      `./skill-sync?test=${importCounter++}`
    );
    const hashVal = computeDirectoryHash(destSkillDir);
    initialManifest.skills[skillName].sourceHash = 'stale-source-hash';
    initialManifest.skills[skillName].lastManagedHash = hashVal;
    initialManifest.skills[skillName].lastSeenHash = 'stale-seen-hash';

    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2));

    // Write a mock version to package.json
    fs.writeFileSync(
      path.join(fakePackageRoot, 'package.json'),
      JSON.stringify({ version: '1.2.3' }),
    );

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.skippedExisting).toContain(skillName);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.skills[skillName].packageVersion).toBe('1.2.3');
    expect(manifest.skills[skillName].sourceHash).toBe(hashVal);
    expect(manifest.skills[skillName].lastManagedHash).toBe(hashVal);
    expect(manifest.skills[skillName].lastSeenHash).toBe(hashVal);
    expect(manifest.skills[skillName].updatedAt).not.toBe(originalTime);
  });

  test('directory hashing symlink consistency: ignores symlinks when hashing, matching copy semantics', async () => {
    const skillName = 'symlink-hash-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Bundle Content');

    // Create a symlink in the source directory
    const linkTarget = path.join(tempDir, 'outside-target.txt');
    fs.writeFileSync(linkTarget, 'target content');
    fs.symlinkSync(linkTarget, path.join(skillSrcDir, 'a-link.txt'));

    const { computeDirectoryHash } = await import(
      `./skill-sync?test=${importCounter++}`
    );

    const sourceHashWithSymlink = computeDirectoryHash(skillSrcDir);

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);
    expect(result.installed).toContain(skillName);

    const destSkillDir = path.join(fakeDestConfigDir, 'skills', skillName);
    expect(fs.existsSync(destSkillDir)).toBe(true);

    // The destination directory should have the symlink omitted due to copyDirRecursive
    expect(fs.existsSync(path.join(destSkillDir, 'a-link.txt'))).toBe(false);

    // The computed hash of destination should match the source hash
    const destHash = computeDirectoryHash(destSkillDir);
    expect(destHash).toBe(sourceHashWithSymlink);
  });

  test('deleted to customized: stages and marks customized', async () => {
    const skillName = 'recreated-custom-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillSrcDir, 'SKILL.md'),
      '# Current Bundled Content',
    );

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');

    const initialManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        [skillName]: {
          status: 'deleted',
          packageVersion: '1.0.0',
          sourceHash: 'old-source-hash',
          lastManagedHash: 'old-managed-hash',
          lastSeenHash: '',
          updatedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2));

    // Create the destination but with customized content (doesn't match current source)
    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const destSkillDir = path.join(destSkillsDir, skillName);
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(destSkillDir, 'SKILL.md'),
      '# Customized Content',
    );

    // Mock version in package.json
    fs.writeFileSync(
      path.join(fakePackageRoot, 'package.json'),
      JSON.stringify({ version: '1.2.3' }),
    );

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.skippedExisting).toContain(skillName);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.skills[skillName].status).toBe('customized');
    expect(manifest.skills[skillName].packageVersion).toBe('1.2.3');
    const { computeDirectoryHash } = await import(
      `./skill-sync?test=${importCounter++}`
    );
    expect(manifest.skills[skillName].sourceHash).toBe(
      computeDirectoryHash(skillSrcDir),
    );
    const stagedPath = manifest.skills[skillName].stagedPath as string;
    expect(stagedPath).toBeDefined();
    expect(fs.existsSync(stagedPath)).toBe(true);
    expect(fs.readFileSync(path.join(stagedPath, 'SKILL.md'), 'utf-8')).toBe(
      '# Current Bundled Content',
    );
  });

  test('orphan artifact matching: avoids prefix collisions', async () => {
    const skillName = 'foo';
    const otherSkill = 'foo-bar';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Foo Content');

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });

    // Staging and backup folders for foo-bar
    const otherBackup = path.join(
      destSkillsDir,
      `.backup-${otherSkill}-1700000000000-asdfasd`,
    );
    fs.mkdirSync(otherBackup, { recursive: true });
    fs.writeFileSync(path.join(otherBackup, 'SKILL.md'), '# Foo Bar Backup');

    // Run sync for foo. Because foo is missing at dest, it would normally trigger orphan recovery.
    // If it is prefix-collision matching, it would match foo-bar backup and restore it!
    // But with our delimiter-safe matching, it should ignore foreign backups of foo-bar and install foo fresh.
    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.installed).toContain(skillName);
    expect(fs.existsSync(path.join(destSkillsDir, skillName))).toBe(true);
    expect(
      fs.readFileSync(path.join(destSkillsDir, skillName, 'SKILL.md'), 'utf-8'),
    ).toBe('# Foo Content');
    // foo-bar's backup folder must STILL exist and NOT be deleted or recovered
    expect(fs.existsSync(otherBackup)).toBe(true);
  });

  test('corrupt manifest recovery: conservative reconciliation and writing fresh manifest', async () => {
    const skillName = 'reconciliation-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Bundled Content');

    const customizedSkillName = 'reconciliation-customized-skill';
    const customizedSkillSrcDir = path.join(
      fakePackageRoot,
      'src',
      'skills',
      customizedSkillName,
    );
    fs.mkdirSync(customizedSkillSrcDir, { recursive: true });
    fs.writeFileSync(
      path.join(customizedSkillSrcDir, 'SKILL.md'),
      '# Clean Source',
    );

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });

    // Customized skill exists at destination but with customized content
    const destCustomizedSkillDir = path.join(
      destSkillsDir,
      customizedSkillName,
    );
    fs.mkdirSync(destCustomizedSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(destCustomizedSkillDir, 'SKILL.md'),
      '# Customized Content',
    );

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');
    // Write corrupt manifest content
    fs.writeFileSync(manifestPath, '{ corrupt json...', 'utf-8');

    // Write mock package.json version
    fs.writeFileSync(
      path.join(fakePackageRoot, 'package.json'),
      JSON.stringify({ version: '1.2.3' }),
    );

    // Call sync. It should notice it is corrupt, do conservative reconciliation, and replace the corrupt manifest.
    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    // Since destination didn't exist, it should install it
    expect(result.installed).toContain(skillName);
    expect(result.skippedExisting).toContain(customizedSkillName);
    expect(result.customized).toContain(customizedSkillName);

    // The manifest should be successfully reconciled and written as valid JSON
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
    expect(manifestContent).not.toContain('corrupt json');
    const parsed = JSON.parse(manifestContent);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.skills[skillName].status).toBe('managed');
    expect(parsed.skills[skillName].packageVersion).toBe('1.2.3');

    // Customized skill should be marked customized with correct stagedPath
    const custEntry = parsed.skills[customizedSkillName];
    expect(custEntry.status).toBe('customized');
    expect(custEntry.stagedPath).toBeDefined();
    expect(fs.existsSync(custEntry.stagedPath)).toBe(true);
    expect(
      fs.readFileSync(path.join(custEntry.stagedPath, 'SKILL.md'), 'utf-8'),
    ).toBe('# Clean Source');
  });

  test('lock owner-safety: releaseLock cleans up its own lock even if owner.json is missing', async () => {
    const { acquireLock, releaseLock } = await import(
      `./skill-sync?test=${importCounter++}`
    );
    const lockDir = path.join(
      fakeDestConfigDir,
      'test-missing-owner-json.lock',
    );

    // Acquire the lock first
    const acquired = acquireLock(lockDir);
    expect(acquired).toBe(true);

    // Delete owner.json to simulate missing metadata
    const metadataPath = path.join(lockDir, 'owner.json');
    if (fs.existsSync(metadataPath)) {
      fs.unlinkSync(metadataPath);
    }

    // Now call releaseLock
    releaseLock(lockDir);

    // The lock directory should be deleted successfully!
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test('staged path safety: does not delete staging directories outside managed root', async () => {
    const skillName = 'safety-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Identical Content');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');

    // Create an outside directory that shouldn't be deleted!
    const outsideStagedDir = path.join(tempDir, 'outside-staged-path');
    fs.mkdirSync(outsideStagedDir, { recursive: true });
    fs.writeFileSync(
      path.join(outsideStagedDir, 'SKILL.md'),
      '# Outside Content',
    );

    const initialManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        [skillName]: {
          status: 'customized',
          packageVersion: '1.0.0',
          sourceHash: 'old-source-hash',
          lastManagedHash: 'old-managed-hash',
          lastSeenHash: 'user-custom-hash',
          stagedPath: outsideStagedDir,
          updatedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2));

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const destSkillDir = path.join(destSkillsDir, skillName);
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(destSkillDir, 'SKILL.md'),
      '# Identical Content',
    );

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.adopted).toContain(skillName);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.skills[skillName].status).toBe('managed');
    expect(manifest.skills[skillName].stagedPath).toBeUndefined();

    // The outside staged directory must NOT have been deleted!
    expect(fs.existsSync(outsideStagedDir)).toBe(true);
  });

  test('lock owner-safety: releaseLock does not delete a lock owned by another host/process/token', async () => {
    const { releaseLock } = await import(
      `./skill-sync?test=${importCounter++}`
    );
    const lockDir = path.join(fakeDestConfigDir, 'test-owner-safety-fail.lock');
    fs.mkdirSync(lockDir, { recursive: true });

    // Lock is owned by someone else
    const foreignOwner = {
      pid: 99999,
      host: 'foreign-host',
      time: Date.now(),
      token: 'foreign-token',
    };
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify(foreignOwner),
      'utf-8',
    );

    releaseLock(lockDir);

    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.existsSync(path.join(lockDir, 'owner.json'))).toBe(true);
  });

  test('lock owner-safety: releaseLock deletes a lock owned by this process/token', async () => {
    const { releaseLock } = await import(
      `./skill-sync?test=${importCounter++}`
    );
    const lockDir = path.join(
      fakeDestConfigDir,
      'test-owner-safety-valid.lock',
    );
    fs.mkdirSync(lockDir, { recursive: true });

    // Lock is owned by us
    const ourOwner = {
      pid: process.pid,
      host: require('node:os').hostname(),
      time: Date.now(),
      // We retrieve process token from globalThis or module
      token: (globalThis as any).OMO_SKILL_SYNC_PROCESS_TOKEN,
    };
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify(ourOwner),
      'utf-8',
    );

    releaseLock(lockDir);

    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test('lock owner-safety: releaseLock does not delete lock if metadata is overwritten by a foreign owner', async () => {
    const { acquireLock, releaseLock } = await import(
      `./skill-sync?test=${importCounter++}`
    );
    const lockDir = path.join(
      fakeDestConfigDir,
      'test-overwritten-metadata.lock',
    );

    // Acquire and track the path in memory
    const acquired = acquireLock(lockDir);
    expect(acquired).toBe(true);

    // Overwrite owner.json with a foreign owner
    const foreignOwner = {
      pid: 99999,
      host: 'foreign-host',
      time: Date.now(),
      token: 'foreign-token',
    };
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify(foreignOwner),
      'utf-8',
    );

    // releaseLock should NOT delete the lock directory because metadata is authoritative and foreign
    releaseLock(lockDir);

    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.existsSync(path.join(lockDir, 'owner.json'))).toBe(true);
  });

  test('customized to deleted transition: removes staged directory and metadata', async () => {
    const skillName = 'customized-deleted-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Source');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');

    // Create a mock staged directory for this customized skill
    const stagedDir = path.join(
      manifestDir,
      'skill-updates',
      '1.0.0',
      skillName,
    );
    fs.mkdirSync(stagedDir, { recursive: true });
    fs.writeFileSync(path.join(stagedDir, 'SKILL.md'), '# Staged Update');

    const initialManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        [skillName]: {
          status: 'customized',
          packageVersion: '1.0.0',
          sourceHash: 'old-source-hash',
          lastManagedHash: 'old-managed-hash',
          lastSeenHash: 'user-custom-hash',
          stagedPath: stagedDir,
          updatedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2));

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.skippedExisting).toContain(skillName);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const entry = manifest.skills[skillName];
    expect(entry.status).toBe('deleted');
    expect(entry.stagedPath).toBeUndefined();
    expect((entry as any).stagedVersion).toBeUndefined();
    expect((entry as any).stagedHash).toBeUndefined();

    // The staged directory on-disk must be deleted successfully!
    expect(fs.existsSync(stagedDir)).toBe(false);
  });

  test('crash safe recovery: recovers backup directory when destination directory is missing', async () => {
    const skillName = 'recovery-test-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Bundled Content');

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const destSkillDir = path.join(destSkillsDir, skillName);

    const backupDir = path.join(destSkillsDir, `.backup-${skillName}-12345`);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'SKILL.md'), '# Backup Content');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');
    const initialManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        [skillName]: {
          status: 'managed',
          packageVersion: '1.0.0',
          sourceHash: 'some-hash',
          lastManagedHash: 'some-hash',
          lastSeenHash: 'some-hash',
          updatedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2));

    await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(fs.existsSync(destSkillDir)).toBe(true);
    expect(fs.readFileSync(path.join(destSkillDir, 'SKILL.md'), 'utf-8')).toBe(
      '# Backup Content',
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.skills[skillName].status).not.toBe('deleted');
  });

  test('preserves managed skill when user only adds nested symlink', async () => {
    const skillName = 'symlink-customization-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Original');

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const destSkillDir = path.join(destSkillsDir, skillName);
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.writeFileSync(path.join(destSkillDir, 'SKILL.md'), '# Original');

    const { computeDirectoryHash } = await import(
      `./skill-sync?test=${importCounter++}`
    );
    const managedHash = computeDirectoryHash(destSkillDir);

    const symlinkTarget = path.join(fakeDestConfigDir, 'user-target.txt');
    fs.writeFileSync(symlinkTarget, 'user data');
    fs.symlinkSync(symlinkTarget, path.join(destSkillDir, 'user-link'));

    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Updated');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        skills: {
          [skillName]: {
            status: 'managed',
            packageVersion: '1.0.0',
            sourceHash: managedHash,
            lastManagedHash: managedHash,
            lastSeenHash: managedHash,
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    );

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.installed).toContain(skillName);
    expect(fs.existsSync(path.join(destSkillDir, 'user-link'))).toBe(false);
    expect(fs.readFileSync(path.join(destSkillDir, 'SKILL.md'), 'utf-8')).toBe(
      '# Updated',
    );
  });

  test('preserves managed skill when user only adds empty directory', async () => {
    const skillName = 'empty-dir-customization-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Original');

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const destSkillDir = path.join(destSkillsDir, skillName);
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.writeFileSync(path.join(destSkillDir, 'SKILL.md'), '# Original');

    const { computeDirectoryHash } = await import(
      `./skill-sync?test=${importCounter++}`
    );
    const managedHash = computeDirectoryHash(destSkillDir);
    fs.mkdirSync(path.join(destSkillDir, 'user-empty-dir'));
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Updated');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'skills-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        skills: {
          [skillName]: {
            status: 'managed',
            packageVersion: '1.0.0',
            sourceHash: managedHash,
            lastManagedHash: managedHash,
            lastSeenHash: managedHash,
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    );

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.customized).toContain(skillName);
    expect(fs.existsSync(path.join(destSkillDir, 'user-empty-dir'))).toBe(true);
    expect(fs.readFileSync(path.join(destSkillDir, 'SKILL.md'), 'utf-8')).toBe(
      '# Original',
    );
  });

  test('preserves managed skill when user only changes file mode', async () => {
    const skillName = 'mode-customization-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Original');

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    const destSkillDir = path.join(destSkillsDir, skillName);
    fs.mkdirSync(destSkillDir, { recursive: true });
    const destSkillFile = path.join(destSkillDir, 'SKILL.md');
    fs.writeFileSync(destSkillFile, '# Original');

    const { computeDirectoryHash } = await import(
      `./skill-sync?test=${importCounter++}`
    );
    const managedHash = computeDirectoryHash(destSkillDir);
    fs.chmodSync(destSkillFile, 0o600);
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Updated');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'skills-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        skills: {
          [skillName]: {
            status: 'managed',
            packageVersion: '1.0.0',
            sourceHash: managedHash,
            lastManagedHash: managedHash,
            lastSeenHash: managedHash,
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    );

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.customized).toContain(skillName);
    expect((fs.statSync(destSkillFile).mode & 0o777).toString(8)).toBe('600');
    expect(fs.readFileSync(destSkillFile, 'utf-8')).toBe('# Original');
  });

  test('crash safe recovery: preserves most recent backup when renameSync fails', async () => {
    const skillName = 'recovery-failure-test-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Bundled Content');

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });

    const backupDir = path.join(destSkillsDir, `.backup-${skillName}-12345`);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'SKILL.md'), '# Backup Content');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');
    const initialManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        [skillName]: {
          status: 'managed',
          packageVersion: '1.0.0',
          sourceHash: 'some-hash',
          lastManagedHash: 'some-hash',
          lastSeenHash: 'some-hash',
          updatedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2));

    shouldFailRename = true;

    await syncBundledSkillsFromPackage(fakePackageRoot);

    // The destination directory should not exist (since rename failed)
    const destSkillDir = path.join(destSkillsDir, skillName);
    expect(fs.existsSync(destSkillDir)).toBe(false);

    // The most recent backup directory should still exist and not be cleaned up
    expect(fs.existsSync(backupDir)).toBe(true);
    expect(fs.readFileSync(path.join(backupDir, 'SKILL.md'), 'utf-8')).toBe(
      '# Backup Content',
    );
  });

  test('LEGACY_MANAGED_SKILL_HASHES: is exported as a record mapping string keys to string arrays', async () => {
    const { LEGACY_MANAGED_SKILL_HASHES } = await import(
      `./skill-sync?test=${importCounter++}`
    );
    expect(typeof LEGACY_MANAGED_SKILL_HASHES).toBe('object');
    expect(LEGACY_MANAGED_SKILL_HASHES).not.toBeNull();
    for (const key of Object.keys(LEGACY_MANAGED_SKILL_HASHES)) {
      expect(typeof key).toBe('string');
      expect(Array.isArray(LEGACY_MANAGED_SKILL_HASHES[key])).toBe(true);
    }
  });

  test('conflict staging failure: failed skills are not double-counted as skippedExisting', async () => {
    const skillName = 'test-double-counting-skill';
    const skillSrcDir = path.join(fakePackageRoot, 'src', 'skills', skillName);
    fs.mkdirSync(skillSrcDir, { recursive: true });
    fs.writeFileSync(path.join(skillSrcDir, 'SKILL.md'), '# Bundle Content');

    const manifestDir = path.join(fakeDestConfigDir, '.oh-my-opencode-slim');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');

    const initialManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        [skillName]: {
          status: 'conflict',
          packageVersion: '1.0.0',
          sourceHash: 'old-source-hash',
          lastManagedHash: 'old-managed-hash',
          lastSeenHash: 'old-seen-hash',
          updatedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2));

    const destSkillsDir = path.join(fakeDestConfigDir, 'skills');
    fs.mkdirSync(destSkillsDir, { recursive: true });
    // Destination is different (so we fall to destHash !== sourceHash, which attempts staging)
    const destSkillDir = path.join(destSkillsDir, skillName);
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(destSkillDir, 'SKILL.md'),
      '# Different Content',
    );

    // Force staging copy recursive to fail by making dest directory nested path locked
    const stagedSkillDir = path.join(
      manifestDir,
      'skill-updates',
      '1.2.3',
      skillName,
    );
    // Write package.json mock version
    fs.writeFileSync(
      path.join(fakePackageRoot, 'package.json'),
      JSON.stringify({ version: '1.2.3' }),
    );

    // Make fs mkdirSync throw on stagedSkillDir or hijack mkdirSync via mock module if possible and cleaner, OR lock it!
    // Locking stagedParent updates directory
    const stagedParent = path.dirname(stagedSkillDir);
    fs.mkdirSync(stagedParent, { recursive: true });
    fs.chmodSync(stagedParent, 0o000);

    const result = await syncBundledSkillsFromPackage(fakePackageRoot);

    expect(result.failed).toContain(skillName);
    expect(result.skippedExisting).not.toContain(skillName);

    // Reset permissions so afterEach cleanup succeeds
    fs.chmodSync(stagedParent, 0o777);
  });
});
