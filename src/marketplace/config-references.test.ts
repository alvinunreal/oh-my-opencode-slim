import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
              },
            },
            unused: {
              agents: {},
              marketplace: { agents: ['community/referenced'] },
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
              },
            },
            unused: {
              agents: {},
              marketplace: { agents: ['community/referenced'] },
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
      expect(userConfig.presets.unused.marketplace.agents).toEqual([]);
      expect(projectConfig.presets.work.marketplace.agents).toEqual([
        'community/project-keep',
      ]);
      expect(projectConfig.presets.unused.marketplace.agents).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
