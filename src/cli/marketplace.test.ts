import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketplaceStore } from '../marketplace/store';
import {
  createMarketplaceRegistryEntry,
  type MarketplacePackageBundle,
} from '../marketplace-contract';
import { marketplaceCommand, parseMarketplaceArgs } from './marketplace';

function bundle(): MarketplacePackageBundle {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'community/example',
      version: '1.2.3',
      displayName: 'Example agent',
      description: 'A CLI test package.',
      agentName: 'exampleagent',
      prompt: 'Use the explorer role.',
      author: { name: 'Community' },
      tags: ['test'],
      license: 'MIT',
      compatibility: { plugin: '>=3.0.0' },
      routing: {
        description: 'Handle CLI test requests.',
        keywords: ['test'],
        when: 'When running CLI tests.',
      },
      skills: [],
      mcps: [],
      tools: [],
      model: { source: 'explicit', candidates: ['provider/model'] },
    },
  };
}

describe('marketplace CLI parsing', () => {
  test('keeps local import distinct from registry install/update', () => {
    expect(parseMarketplaceArgs(['import', './package.json'])).toEqual({
      command: 'import',
      value: './package.json',
      force: false,
      json: false,
    });
    expect(
      parseMarketplaceArgs(['import', './package-v2.json', '--update']),
    ).toEqual({
      command: 'import',
      value: './package-v2.json',
      force: false,
      json: false,
      update: true,
    });
    expect(
      parseMarketplaceArgs(['install', 'community/example@1.2.3']),
    ).toEqual({
      command: 'install',
      value: 'community/example@1.2.3',
      force: false,
      json: false,
    });
  });

  test('requires package input for install and update', () => {
    expect(() => parseMarketplaceArgs(['install'])).toThrow();
    expect(() => parseMarketplaceArgs(['update'])).toThrow();
    expect(parseMarketplaceArgs(['list'])).toEqual({
      command: 'list',
      value: undefined,
      force: false,
      json: false,
    });
    expect(parseMarketplaceArgs(['update', 'community/example']).command).toBe(
      'update',
    );
    expect(() =>
      parseMarketplaceArgs(['remove', 'community/example', '--json']),
    ).toThrow();
  });

  test('parses enable, disable, and status commands', () => {
    expect(parseMarketplaceArgs(['enable', 'community/example'])).toEqual({
      command: 'enable',
      value: 'community/example',
      force: false,
      json: false,
    });
    expect(parseMarketplaceArgs(['status', '--json'])).toEqual({
      command: 'status',
      value: undefined,
      force: false,
      json: true,
    });
  });

  test('installs and enables a registry package in one command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-cli-'));
    const configDir = join(root, 'config');
    const projectDir = join(root, 'project');
    const storeRoot = join(root, 'store');
    const configPath = join(configDir, 'oh-my-opencode-slim.json');
    const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
    const output: string[] = [];
    const originalLog = console.log;
    const selectors: string[] = [];
    try {
      process.env.OPENCODE_CONFIG_DIR = configDir;
      mkdirSync(configDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          preset: 'work',
          presets: { work: { agents: {} } },
        }),
      );
      console.log = (...args: unknown[]) => {
        output.push(args.map(String).join(' '));
      };

      const packageBundle = bundle();
      const exitCode = await marketplaceCommand(
        ['install', 'community/example'],
        {
          projectDir,
          rootDir: storeRoot,
          pluginVersion: '3.1.0',
          registryClient: {
            download: async (selector) => {
              selectors.push(selector);
              return {
                bundle: packageBundle,
                entry: createMarketplaceRegistryEntry(packageBundle),
                indexUrl: 'https://registry.example/index.json',
                packageUrl: 'https://registry.example/artifact.json',
              };
            },
          },
        },
      );

      expect(exitCode).toBe(0);
      expect(selectors).toEqual(['community/example']);
      expect(
        JSON.parse(readFileSync(configPath, 'utf8')).presets.work.marketplace,
      ).toEqual({ agents: ['community/example'] });
      expect(output[0]).toContain(
        'Installed and enabled community/example@1.2.3 in the active preset',
      );
    } finally {
      console.log = originalLog;
      if (originalConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
      } else {
        process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preflights activation before one-shot install mutates the store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-cli-preflight-'));
    const configDir = join(root, 'config');
    const projectDir = join(root, 'project');
    const storeRoot = join(root, 'store');
    const configPath = join(configDir, 'oh-my-opencode-slim.json');
    const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
    const originalError = console.error;
    let downloads = 0;
    try {
      process.env.OPENCODE_CONFIG_DIR = configDir;
      mkdirSync(configDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          preset: 'missing',
          presets: { work: { agents: {} } },
        }),
      );
      console.error = () => {};

      const exitCode = await marketplaceCommand(
        ['install', 'community/example'],
        {
          projectDir,
          rootDir: storeRoot,
          pluginVersion: '3.0.0-beta.6',
          registryClient: {
            download: async () => {
              downloads += 1;
              return {
                bundle: bundle(),
                entry: createMarketplaceRegistryEntry(bundle()),
                indexUrl: 'https://registry.example/index.json',
                packageUrl: 'https://registry.example/artifact.json',
              };
            },
          },
        },
      );

      expect(exitCode).toBe(1);
      expect(downloads).toBe(0);
      const store = new MarketplaceStore({ rootDir: storeRoot });
      expect(store.list()).toEqual([]);
      expect(existsSync(store.paths.lockfilePath)).toBe(false);
    } finally {
      console.error = originalError;
      if (originalConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
      } else {
        process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
