import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MarketplaceActivationReferenceError,
  MarketplaceService,
  readMarketplaceConfigReferences,
} from './index';
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

describe('marketplace activation references', () => {
  test('reads user/project preset references instead of CLI claims', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(project, '.opencode'), { recursive: true });
      const configPath = join(project, '.opencode', 'oh-my-opencode-slim.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          preset: 'work',
          presets: {
            work: {
              agents: {},
              marketplace: { agents: ['community/referenced'] },
            },
          },
        }),
      );
      expect(readMarketplaceConfigReferences(project)).toEqual([
        {
          packageId: 'community/referenced',
          configPath,
          presetName: 'work',
          target: 'agent',
        },
      ]);

      const service = new MarketplaceService({
        rootDir: join(root, 'store'),
        projectDir: project,
      });
      service.install(bundle);
      expect(() => service.remove('community/referenced')).toThrow(
        MarketplaceActivationReferenceError,
      );
      expect(() =>
        service.remove('community/referenced', { force: true }),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves a project-selected preset defined in user config', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-config-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    const userConfigPath = join(configHome, 'opencode');
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(userConfigPath, { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(
        join(userConfigPath, 'oh-my-opencode-slim.json'),
        JSON.stringify({
          presets: {
            shared: {
              agents: {},
              marketplace: { agents: ['community/referenced'] },
            },
          },
        }),
      );
      writeFileSync(
        join(project, '.opencode', 'oh-my-opencode-slim.json'),
        JSON.stringify({ preset: 'shared' }),
      );

      expect(readMarketplaceConfigReferences(project)).toEqual([
        {
          packageId: 'community/referenced',
          configPath: join(project, '.opencode', 'oh-my-opencode-slim.json'),
          presetName: 'shared',
          target: 'agent',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
