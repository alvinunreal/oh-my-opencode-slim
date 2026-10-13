import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgents } from '../agents';
import { discoverProjectLocalSkillNames } from './project-skills';
import { RuntimeConfig } from './runtime';
import { PluginConfigSchema } from './schema';

const tempDirs: string[] = [];

function makeProject(): string {
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'omo-local-skills-'),
  );
  tempDirs.push(projectDir);
  return projectDir;
}

function writeSkill(
  projectDir: string,
  relativeDir: string,
  name: string,
  root: '.opencode' | '.agents' = '.opencode',
): void {
  const skillDir = path.join(projectDir, root, 'skills', relativeDir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} project skill\n---\n\n# ${name}\n`,
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    RuntimeConfig.reset(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('discoverProjectLocalSkillNames', () => {
  test('includes ancestor skills above Git boundaries without siblings or duplicates', () => {
    const workspace = makeProject();
    const repository = path.join(workspace, 'repository');
    const worktree = path.join(repository, '.slim', 'worktrees', 'feature');
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ignored-fixture');
    writeSkill(workspace, 'shared', 'shared');
    writeSkill(repository, 'repository', 'repository');
    writeSkill(worktree, 'shared', 'shared');
    writeSkill(worktree, 'local', 'local');
    writeSkill(path.join(workspace, 'sibling'), 'sibling', 'sibling');

    expect(discoverProjectLocalSkillNames(worktree, 'v2')).toEqual([
      'local',
      'repository',
      'shared',
    ]);
  });

  test('discovers both skill roots across ancestors without sibling leakage', () => {
    const workspace = makeProject();
    const repository = path.join(workspace, 'repository');
    const worktree = path.join(repository, 'nested');
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    writeSkill(workspace, 'outside', 'outside', '.agents');
    writeSkill(repository, 'portable', 'portable', '.agents');
    writeSkill(repository, 'legacy', 'shared');
    writeSkill(worktree, 'nested', 'nested', '.agents');
    writeSkill(worktree, 'duplicate', 'shared', '.agents');
    writeSkill(
      path.join(workspace, 'sibling'),
      'sibling',
      'sibling',
      '.agents',
    );

    expect(discoverProjectLocalSkillNames(worktree)).toEqual([
      'nested',
      'portable',
      'shared',
    ]);
    expect(discoverProjectLocalSkillNames(worktree, 'v2')).toEqual([
      'nested',
      'outside',
      'portable',
      'shared',
    ]);
  });

  test('finds .agents skills without an .opencode skills directory', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'portable', 'portable', '.agents');
    const invalid = path.join(projectDir, '.agents', 'skills', 'invalid');
    fs.mkdirSync(invalid, { recursive: true });
    fs.writeFileSync(path.join(invalid, 'SKILL.md'), 'no frontmatter name');

    expect(discoverProjectLocalSkillNames(projectDir)).toEqual(['portable']);
  });

  test('ignores external .agents symlink roots while retaining local skills', () => {
    const projectDir = makeProject();
    const externalDir = makeProject();
    writeSkill(externalDir, 'external', 'external', '.agents');
    writeSkill(projectDir, 'allowed', 'allowed');
    fs.mkdirSync(path.join(projectDir, '.agents'), { recursive: true });
    fs.symlinkSync(
      path.join(externalDir, '.agents', 'skills'),
      path.join(projectDir, '.agents', 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(discoverProjectLocalSkillNames(projectDir)).toEqual(['allowed']);
  });

  test('does not follow symlinked .agents skill entries', () => {
    const projectDir = makeProject();
    const externalDir = makeProject();
    writeSkill(projectDir, 'allowed', 'allowed', '.agents');
    writeSkill(externalDir, 'external', 'external', '.agents');
    fs.symlinkSync(
      path.join(externalDir, '.agents', 'skills', 'external'),
      path.join(projectDir, '.agents', 'skills', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(discoverProjectLocalSkillNames(projectDir)).toEqual(['allowed']);
  });

  test('skips symlinked ancestor roots without discarding valid local skills', () => {
    const workspace = makeProject();
    const external = makeProject();
    const worktree = path.join(workspace, 'worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });
    writeSkill(external, 'external', 'external');
    fs.mkdirSync(path.join(workspace, '.opencode'), { recursive: true });
    fs.symlinkSync(
      path.join(external, '.opencode', 'skills'),
      path.join(workspace, '.opencode', 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    writeSkill(worktree, 'local', 'local');
    expect(discoverProjectLocalSkillNames(worktree)).toEqual(['local']);
  });

  test('does not follow symlinked skill entries in ancestor roots', () => {
    const workspace = makeProject();
    const external = makeProject();
    const worktree = path.join(workspace, 'worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });
    writeSkill(workspace, 'shared', 'shared');
    writeSkill(external, 'external', 'external');
    fs.symlinkSync(
      path.join(external, '.opencode', 'skills', 'external'),
      path.join(workspace, '.opencode', 'skills', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(discoverProjectLocalSkillNames(worktree)).toEqual(['shared']);
  });

  test('discovers nested skills by frontmatter name and ignores invalid files', () => {
    const projectDir = makeProject();
    writeSkill(
      projectDir,
      'folder-name-does-not-matter',
      'project-architecture',
    );
    writeSkill(projectDir, 'nested/testing', 'project-testing');
    const invalidDir = path.join(projectDir, '.opencode', 'skills', 'invalid');
    fs.mkdirSync(invalidDir, { recursive: true });
    fs.writeFileSync(
      path.join(invalidDir, 'SKILL.md'),
      '# missing frontmatter name',
    );

    expect(discoverProjectLocalSkillNames(projectDir)).toEqual([
      'project-architecture',
      'project-testing',
    ]);
  });

  test('returns an empty list when the project has no local skills directory', () => {
    expect(discoverProjectLocalSkillNames(makeProject())).toEqual([]);
  });

  test('does not follow a project skills root that resolves outside the project', () => {
    const projectDir = makeProject();
    const externalDir = makeProject();
    const externalSkillsRoot = path.join(externalDir, 'shared-skills');
    const externalSkillDir = path.join(externalSkillsRoot, 'external-skill');
    fs.mkdirSync(externalSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(externalSkillDir, 'SKILL.md'),
      '---\nname: external-skill\ndescription: external\n---\n',
    );

    const opencodeDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.symlinkSync(
      externalSkillsRoot,
      path.join(opencodeDir, 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(discoverProjectLocalSkillNames(projectDir)).toEqual([]);
  });
});

describe('skills_include_local', () => {
  test('grants ancestor skills in worktrees while skills_remove still wins', () => {
    const workspace = makeProject();
    const worktree = path.join(workspace, 'worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });
    writeSkill(workspace, 'shared', 'shared');
    writeSkill(workspace, 'excluded', 'excluded');
    writeSkill(worktree, 'local', 'local');
    const config = PluginConfigSchema.parse({
      agents: {
        oracle: {
          skills_include_local: true,
          skills_remove: ['excluded'],
        },
      },
    });
    const runtime = RuntimeConfig.createDetached(worktree, config);
    const oracle = createAgents(runtime, { projectDirectory: worktree }).find(
      (agent) => agent.name === 'oracle',
    );
    const permissions = oracle?.config.permission?.skill as
      | Record<string, string>
      | undefined;
    expect(permissions?.shared).toBe('allow');
    expect(permissions?.local).toBe('allow');
    expect(permissions?.excluded).not.toBe('allow');
  });

  test('adds skills from both project roots to an agent effective skills', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'project-architecture', 'project-architecture');
    writeSkill(projectDir, 'nested/project-testing', 'project-testing');
    writeSkill(projectDir, 'portable', 'portable', '.agents');

    const config = PluginConfigSchema.parse({
      agents: {
        oracle: {
          skills: ['codemap'],
          skills_include_local: true,
        },
      },
    });

    RuntimeConfig.init(projectDir, config);
    const runtime = RuntimeConfig.get(projectDir);
    const oracle = createAgents(runtime, { projectDirectory: projectDir }).find(
      (agent) => agent.name === 'oracle',
    );
    const skillPermissions = oracle?.config.permission?.skill as
      | Record<string, string>
      | undefined;

    expect(skillPermissions?.codemap).toBe('allow');
    expect(skillPermissions?.['project-architecture']).toBe('allow');
    expect(skillPermissions?.['project-testing']).toBe('allow');
    expect(skillPermissions?.portable).toBe('allow');
  });

  test('skills_remove still wins over an automatically included local skill', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'project-architecture', 'project-architecture');
    writeSkill(projectDir, 'project-testing', 'project-testing', '.agents');

    const config = PluginConfigSchema.parse({
      agents: {
        oracle: {
          skills_include_local: true,
          skills_remove: ['project-testing'],
        },
      },
    });

    RuntimeConfig.init(projectDir, config);
    const effective = RuntimeConfig.get(projectDir).agents().oracle?.skills;

    expect(effective).toContain('project-architecture');
    expect(effective).not.toContain('project-testing');
  });

  test('combines .agents discovery with skills_add and skills_remove', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'legacy', 'legacy');
    writeSkill(projectDir, 'portable', 'portable', '.agents');
    writeSkill(projectDir, 'excluded', 'excluded', '.agents');

    const config = PluginConfigSchema.parse({
      agents: {
        oracle: {
          skills: ['codemap'],
          skills_add: ['extra'],
          skills_include_local: true,
          skills_remove: ['excluded'],
        },
      },
    });
    const runtime = RuntimeConfig.createDetached(projectDir, config);
    const effective = runtime.agents().oracle?.skills;

    expect(effective).toContain('codemap');
    expect(effective).toContain('extra');
    expect(effective).toContain('legacy');
    expect(effective).toContain('portable');
    expect(effective).not.toContain('excluded');
  });

  test('preserves local-skill grants from a legacy alias across canonical config layers', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'project-testing', 'project-testing', '.agents');

    const config = PluginConfigSchema.parse({
      preset: 'local-project',
      presets: {
        'local-project': {
          explore: {
            skills_include_local: true,
          },
        },
      },
      agents: {
        explorer: {
          skills: ['codemap'],
        },
      },
    });

    RuntimeConfig.init(projectDir, config);
    const effective = RuntimeConfig.get(projectDir).agent('explorer')?.skills;

    expect(effective).toContain('codemap');
    expect(effective).toContain('project-testing');
  });
});
