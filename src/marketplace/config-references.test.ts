import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  removeMarketplaceConfigReferences,
  withMarketplaceConfigReferencesRemoved,
} from './config-references';
import { MarketplaceService } from './index';
import type { MarketplacePackageBundle } from './schemas';

const previousConfigHome = process.env.XDG_CONFIG_HOME;

const bundle: MarketplacePackageBundle = {
  manifest: {
    schemaVersion: 2,
    id: 'community/referenced',
    version: '1.0.0',
    displayName: 'Referenced agent',
    description: 'An agent used by a preset.',
    agentName: 'referenced',
    prompt: 'Follow the role instructions.',
    author: { name: 'Community' },
    tags: ['test'],
    license: 'MIT',
    compatibility: {
      plugin: '>=3.0.0-beta.3 <4.0.0',
    },
    routing: {
      description: 'Route referenced work here.',
      keywords: ['reference'],
      when: 'When referenced.',
    },
    skills: [],
    mcps: [],
    tools: [],
    model: { source: 'explicit', candidates: ['provider/model'] },
  },
};

afterEach(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
});

describe('marketplace activation cleanup', () => {
  function createConfigs() {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const project = join(root, 'project');
    const userPath = join(
      root,
      'config',
      'opencode',
      'oh-my-opencode-slim.json',
    );
    const projectPath = join(project, '.opencode', 'oh-my-opencode-slim.json');
    process.env.XDG_CONFIG_HOME = join(root, 'config');
    mkdirSync(join(root, 'config', 'opencode'), { recursive: true });
    mkdirSync(join(project, '.opencode'), { recursive: true });
    const content = JSON.stringify({
      presets: {
        work: { marketplace: { agents: ['community/referenced'] } },
      },
    });
    writeFileSync(userPath, content);
    writeFileSync(projectPath, content);
    return { root, project, userPath, projectPath, content };
  }

  test.each(['user', 'project'])(
    'parse failure in %s config does not publish either config',
    (which) => {
      const fixture = createConfigs();
      try {
        const brokenPath =
          which === 'user' ? fixture.userPath : fixture.projectPath;
        writeFileSync(brokenPath, '{ invalid');
        const userBefore = readFileSync(fixture.userPath, 'utf8');
        const projectBefore = readFileSync(fixture.projectPath, 'utf8');
        const commit = () => {
          throw new Error('must not commit');
        };
        expect(() =>
          withMarketplaceConfigReferencesRemoved(
            fixture.project,
            'community/referenced',
            commit,
          ),
        ).toThrow(`Failed to parse config ${brokenPath}`);
        expect(readFileSync(fixture.userPath, 'utf8')).toBe(userBefore);
        expect(readFileSync(fixture.projectPath, 'utf8')).toBe(projectBefore);
        expect(existsSync(`${fixture.userPath}.bak`)).toBe(false);
        expect(existsSync(`${fixture.projectPath}.bak`)).toBe(false);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  test('failed second publication restores first config before commit', () => {
    const fixture = createConfigs();
    try {
      // The existing atomic publisher backs up a config before rename.
      // Blocking the second backup produces a deterministic filesystem fault.
      mkdirSync(`${fixture.projectPath}.bak`);
      let committed = false;
      let failure: unknown;
      try {
        withMarketplaceConfigReferencesRemoved(
          fixture.project,
          'community/referenced',
          () => {
            committed = true;
          },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).message).toContain('in doubt');
      expect((failure as AggregateError).errors).toHaveLength(2);
      expect(committed).toBe(false);
      expect(readFileSync(fixture.userPath, 'utf8')).toBe(fixture.content);
      expect(readFileSync(fixture.projectPath, 'utf8')).toBe(fixture.content);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('failed commit restores both original config byte strings', () => {
    const fixture = createConfigs();
    try {
      expect(() =>
        withMarketplaceConfigReferencesRemoved(
          fixture.project,
          'community/referenced',
          () => {
            throw new Error('store commit failed');
          },
        ),
      ).toThrow('store commit failed');
      expect(readFileSync(fixture.userPath, 'utf8')).toBe(fixture.content);
      expect(readFileSync(fixture.projectPath, 'utf8')).toBe(fixture.content);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('removes every package activation across user and project presets', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    const userConfigPath = join(
      configHome,
      'opencode',
      'oh-my-opencode-slim.json',
    );
    const projectConfigPath = join(
      project,
      '.opencode',
      'oh-my-opencode-slim.json',
    );
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(
        userConfigPath,
        JSON.stringify({
          preset: 'work',
          unrelated: { keep: true },
          presets: {
            work: {
              agents: {},
              marketplace: {
                agents: ['community/referenced', 'community/user-keep'],
                agents_add: [' COMMUNITY/REFERENCED ', 'community/user-add'],
                agents_remove: [
                  'community/referenced',
                  'community/user-remove',
                ],
              },
            },
            unused: {
              agents: {},
              marketplace: {
                agents: ['community/referenced'],
                agents_add: ['community/referenced'],
                agents_remove: ['community/referenced'],
              },
            },
          },
        }),
      );
      writeFileSync(
        projectConfigPath,
        JSON.stringify({
          preset: 'work',
          presets: {
            work: {
              agents: {},
              marketplace: {
                agents: ['community/referenced', 'community/project-keep'],
                agents_add: ['community/referenced', 'community/project-add'],
                agents_remove: [
                  'community/referenced',
                  'community/project-remove',
                ],
              },
            },
            unused: {
              agents: {},
              marketplace: {
                agents_add: ['community/referenced'],
                agents_remove: ['community/referenced'],
              },
            },
          },
        }),
      );

      const service = new MarketplaceService({
        rootDir: join(root, 'store'),
        projectDir: project,
      });
      service.install(bundle);
      service.remove('community/referenced');

      expect(service.list()).toEqual([]);
      const userConfig = JSON.parse(readFileSync(userConfigPath, 'utf8'));
      const projectConfig = JSON.parse(readFileSync(projectConfigPath, 'utf8'));
      expect(userConfig.unrelated).toEqual({ keep: true });
      expect(userConfig.presets.work.marketplace.agents).toEqual([
        'community/user-keep',
      ]);
      expect(userConfig.presets.work.marketplace.agents_add).toEqual([
        'community/user-add',
      ]);
      expect(userConfig.presets.work.marketplace.agents_remove).toEqual([
        'community/user-remove',
      ]);
      expect(userConfig.presets.unused.marketplace.agents).toEqual([]);
      expect(userConfig.presets.unused.marketplace.agents_add).toEqual([]);
      expect(userConfig.presets.unused.marketplace.agents_remove).toEqual([]);
      expect(projectConfig.presets.work.marketplace.agents).toEqual([
        'community/project-keep',
      ]);
      expect(projectConfig.presets.work.marketplace.agents_add).toEqual([
        'community/project-add',
      ]);
      expect(projectConfig.presets.work.marketplace.agents_remove).toEqual([
        'community/project-remove',
      ]);
      expect(projectConfig.presets.unused.marketplace.agents_add).toEqual([]);
      expect(projectConfig.presets.unused.marketplace.agents_remove).toEqual(
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([true, false])(
    'leaves unrelated JSONC unchanged when another config has references: %s',
    (projectHasReference) => {
      const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
      const configHome = join(root, 'config');
      const project = join(root, 'project');
      const userConfigPath = join(
        configHome,
        'opencode',
        'oh-my-opencode-slim.jsonc',
      );
      const projectConfigPath = join(
        project,
        '.opencode',
        'oh-my-opencode-slim.json',
      );
      const userContent = `{
  // Preserve this comment and spacing
  "presets": {
    "work": { "marketplace": { "agents": ["community/other",], "agents_add": ["community/other"], "agents_remove": ["community/other"], }, },
    "malformed": { "marketplace": { "agents_add": "community/referenced", "agents_remove": null, }, },
  },
}\n`;
      const projectContent = JSON.stringify({
        presets: {
          work: {
            marketplace: {
              agents: projectHasReference
                ? ['community/referenced', 'community/other']
                : ['community/other'],
              agents_add: projectHasReference
                ? ['community/referenced', 'community/other']
                : ['community/other'],
              agents_remove: projectHasReference
                ? ['community/referenced', 'community/other']
                : ['community/other'],
            },
          },
        },
      });
      try {
        process.env.XDG_CONFIG_HOME = configHome;
        mkdirSync(join(configHome, 'opencode'), { recursive: true });
        mkdirSync(join(project, '.opencode'), { recursive: true });
        writeFileSync(userConfigPath, userContent);
        writeFileSync(projectConfigPath, projectContent);
        const oldTime = new Date('2020-01-01T00:00:00.000Z');
        utimesSync(userConfigPath, oldTime, oldTime);
        utimesSync(projectConfigPath, oldTime, oldTime);
        const userMtime = statSync(userConfigPath).mtimeMs;
        const projectMtime = statSync(projectConfigPath).mtimeMs;

        removeMarketplaceConfigReferences(project, 'community/referenced');

        expect(readFileSync(userConfigPath, 'utf8')).toBe(userContent);
        expect(statSync(userConfigPath).mtimeMs).toBe(userMtime);
        if (projectHasReference) {
          const marketplace = JSON.parse(
            readFileSync(projectConfigPath, 'utf8'),
          ).presets.work.marketplace;
          expect(marketplace.agents).toEqual(['community/other']);
          expect(marketplace.agents_add).toEqual(['community/other']);
          expect(marketplace.agents_remove).toEqual(['community/other']);
        } else {
          expect(readFileSync(projectConfigPath, 'utf8')).toBe(projectContent);
          expect(statSync(projectConfigPath).mtimeMs).toBe(projectMtime);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
