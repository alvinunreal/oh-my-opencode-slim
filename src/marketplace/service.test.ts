import { describe, expect, spyOn, test } from 'bun:test';
import * as fsModule from 'node:fs';
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
import {
  MarketplaceCompatibilityError,
  MarketplaceConflictError,
  MarketplaceRegistryIntegrityError,
  MarketplaceRegistryNotFoundError,
  MarketplaceRegistryProtocolError,
  MarketplaceRegistryUnavailableError,
} from './errors.js';
import type { MarketplaceRegistryDownload } from './registry-client.js';
import type { MarketplacePackageBundle } from './schemas.js';
import { MarketplaceService } from './service.js';

function bundle(
  version = '1.0.0',
  id = 'community/example',
  prompt = 'Use the example role carefully.',
  pluginRange = '>=3.0.0',
): MarketplacePackageBundle {
  return {
    manifest: {
      schemaVersion: 2,
      id,
      version,
      displayName: 'Example',
      description: 'An example package',
      agentName: 'example',
      prompt,
      author: { name: 'Example Community' },
      tags: ['example'],
      license: 'MIT',
      compatibility: { plugin: pluginRange },
      routing: {
        description: 'Explore example code.',
        keywords: ['example'],
        when: 'When repository exploration is needed.',
      },
      skills: [],
      mcps: [],
      tools: [],
      model: { source: 'explicit', candidates: ['provider/model'] },
    },
  };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marketplace-service-'));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('MarketplaceService', () => {
  test('requires explicit updates and only accepts strictly newer versions', () => {
    const root = tempRoot();
    try {
      const service = new MarketplaceService({
        rootDir: root,
        pluginVersion: '3.5.0',
      });
      service.install(bundle());
      expect(() => service.install(bundle('2.0.0'))).toThrow(
        MarketplaceConflictError,
      );
      expect(() => service.update(bundle('1.0.0'))).toThrow(
        MarketplaceConflictError,
      );
      service.update(bundle('2.0.0'));
      expect(service.show('community/example').manifest.version).toBe('2.0.0');
      expect(service.verify(' COMMUNITY/EXAMPLE ')[0]?.valid).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('imports local packages with canonical provenance', () => {
    const root = tempRoot();
    const packageFile = join(root, 'package.json');
    try {
      writeFileSync(packageFile, JSON.stringify(bundle().manifest));
      const service = new MarketplaceService({
        rootDir: join(root, 'store'),
        pluginVersion: '3.5.0',
      });
      const imported = service.importFile(packageFile);
      expect(imported.source).toEqual({
        kind: 'local',
        path: fsModule.realpathSync(packageFile),
      });
      expect(service.list()).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('downloads before mutation and uses explicit registry source/version', async () => {
    const root = tempRoot();
    const downloads: Array<[string, string | undefined]> = [];
    const source = {
      bundle: bundle(),
      entry: {} as never,
      indexUrl: 'https://registry.test/v3/index.json',
      packageUrl: 'https://registry.test/v3/package.json',
      registry: 'https://registry.test/v3/',
    };
    try {
      const service = new MarketplaceService({
        rootDir: root,
        pluginVersion: '3.5.0',
        registryClient: {
          downloadV3: async (selector, minimumVersion) => {
            downloads.push([selector, minimumVersion]);
            return source;
          },
          download: async () => {
            throw new Error('v2 should not be requested');
          },
        },
      });
      const installed = await service.installRemote('community/example');
      expect(installed.source).toEqual({
        kind: 'registry',
        registry: source.registry,
        indexUrl: source.indexUrl,
        packageUrl: source.packageUrl,
      });
      const newer = { ...source, bundle: bundle('2.0.0') };
      service.registryClient.downloadV3 = async (selector, minimumVersion) => {
        downloads.push([selector, minimumVersion]);
        return newer;
      };
      const updated = await service.updateRemote('community/example');
      expect(updated.manifest.version).toBe('2.0.0');
      expect(downloads).toEqual([
        ['community/example', undefined],
        ['community/example', '1.0.0'],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses the build version by default and honors an explicit plugin version', () => {
    const root = tempRoot();
    try {
      const defaults = new MarketplaceService({
        rootDir: join(root, 'default'),
      });
      expect(() =>
        defaults.install(
          bundle('1.0.0', 'community/default', undefined, '>=2.0.0'),
        ),
      ).not.toThrow();

      const explicit = new MarketplaceService({
        rootDir: join(root, 'explicit'),
        pluginVersion: '4.2.0',
      });
      expect(() =>
        explicit.install(
          bundle('1.0.0', 'community/explicit', 'Prompt', '>=4.0.0'),
        ),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cancellation after remote install download prevents local mutation', async () => {
    const root = tempRoot();
    const controller = new AbortController();
    const releaseDownload = deferred<MarketplaceRegistryDownload>();
    try {
      const service = new MarketplaceService({
        rootDir: root,
        pluginVersion: '3.5.0',
        registryClient: {
          downloadV3: async () => releaseDownload.promise,
          download: async () => {
            throw new Error('v2 should not be requested');
          },
        },
      });
      const operation = service.installRemote(
        'community/example',
        controller.signal,
      );
      controller.abort();
      releaseDownload.resolve({
        bundle: bundle(),
        entry: {} as never,
        indexUrl: 'https://registry.test/v3/index.json',
        packageUrl: 'https://registry.test/v3/package.json',
      });
      await expect(operation).rejects.toBeInstanceOf(
        MarketplaceRegistryUnavailableError,
      );
      expect(service.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cancellation after remote update download preserves the current package', async () => {
    const root = tempRoot();
    const controller = new AbortController();
    const releaseDownload = deferred<MarketplaceRegistryDownload>();
    try {
      const service = new MarketplaceService({
        rootDir: root,
        pluginVersion: '3.5.0',
        registryClient: {
          downloadV3: async () => releaseDownload.promise,
          download: async () => {
            throw new Error('v2 should not be requested');
          },
        },
      });
      service.install(bundle());
      const operation = service.updateRemote(
        'community/example',
        controller.signal,
      );
      controller.abort();
      releaseDownload.resolve({
        bundle: bundle('2.0.0'),
        entry: {} as never,
        indexUrl: 'https://registry.test/v3/index.json',
        packageUrl: 'https://registry.test/v3/package.json',
      });
      await expect(operation).rejects.toBeInstanceOf(
        MarketplaceRegistryUnavailableError,
      );
      expect(service.show('community/example').manifest.version).toBe('1.0.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: 'cancellation',
      error: new MarketplaceRegistryUnavailableError('cancelled'),
      cancel: true,
    },
    {
      name: 'protocol failure',
      error: new MarketplaceRegistryProtocolError('invalid index'),
      cancel: false,
    },
    {
      name: 'integrity failure',
      error: new MarketplaceRegistryIntegrityError('bad digest'),
      cancel: false,
    },
  ])('does not fall back to v2 after v3 $name', async ({ error, cancel }) => {
    const root = tempRoot();
    let v2Calls = 0;
    const controller = new AbortController();
    try {
      const service = new MarketplaceService({
        rootDir: root,
        pluginVersion: '3.5.0',
        registryClient: {
          downloadV3: async () => {
            if (cancel) controller.abort();
            throw error;
          },
          download: async () => {
            v2Calls += 1;
            throw new Error('v2 fallback must not run');
          },
        },
      });
      await expect(
        service.installRemote('community/example', controller.signal),
      ).rejects.toBe(error);
      expect(v2Calls).toBe(0);
      expect(service.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(['removed', 'advanced'])(
    'revalidates current state after an async remote update while package is %s',
    async (race) => {
      const root = tempRoot();
      const downloadStarted = deferred<void>();
      const finishDownload = deferred<MarketplaceRegistryDownload>();
      try {
        const service = new MarketplaceService({
          rootDir: root,
          pluginVersion: '3.5.0',
          registryClient: {
            downloadV3: async () => {
              downloadStarted.resolve();
              return finishDownload.promise;
            },
            download: async () => {
              throw new Error('v2 should not be requested');
            },
          },
        });
        service.install(bundle());
        const operation = service.updateRemote('community/example');
        await downloadStarted.promise;

        if (race === 'removed') {
          service.remove('community/example');
        } else {
          service.update(bundle('3.0.0'));
        }

        finishDownload.resolve({
          bundle: bundle('2.0.0'),
          entry: {} as never,
          indexUrl: 'https://registry.test/v3/index.json',
          packageUrl: 'https://registry.test/v3/package.json',
        });
        await expect(operation).rejects.toBeInstanceOf(
          MarketplaceConflictError,
        );
        if (race === 'removed') {
          expect(service.list()).toEqual([]);
        } else {
          expect(service.show('community/example').manifest.version).toBe(
            '3.0.0',
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('falls back from a missing v3 package to v2', async () => {
    const root = tempRoot();
    const calls: string[] = [];
    try {
      const service = new MarketplaceService({
        rootDir: root,
        pluginVersion: '3.5.0',
        registryClient: {
          downloadV3: async () => {
            calls.push('v3');
            throw new MarketplaceRegistryNotFoundError('not published on v3');
          },
          download: async () => {
            calls.push('v2');
            return {
              bundle: bundle(),
              entry: {} as never,
              indexUrl: 'https://registry.test/v2/index.json',
              packageUrl: 'https://registry.test/v2/package.json',
            };
          },
        },
      });
      expect(
        (await service.installRemote('community/example')).manifest.version,
      ).toBe('1.0.0');
      expect(calls).toEqual(['v3', 'v2']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('falls back to v2 when v3 has no compatible release', async () => {
    const root = tempRoot();
    const calls: string[] = [];
    try {
      const service = new MarketplaceService({
        rootDir: root,
        pluginVersion: '3.5.0',
        registryClient: {
          downloadV3: async () => {
            calls.push('v3');
            throw new MarketplaceCompatibilityError('no compatible v3 release');
          },
          download: async () => {
            calls.push('v2');
            return {
              bundle: bundle(),
              entry: {} as never,
              indexUrl: 'https://registry.test/v2/index.json',
              packageUrl: 'https://registry.test/v2/package.json',
            };
          },
        },
      });
      expect(
        (await service.installRemote('community/example')).manifest.version,
      ).toBe('1.0.0');
      expect(calls).toEqual(['v3', 'v2']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('restores config and package when lockfile publication fails', () => {
    const root = tempRoot();
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const project = join(root, 'project');
    const configPath = join(project, '.opencode', 'oh-my-opencode-slim.json');
    const config = JSON.stringify({
      presets: { work: { marketplace: { agents: ['community/example'] } } },
    });
    try {
      process.env.XDG_CONFIG_HOME = join(root, 'config');
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(configPath, config);
      const service = new MarketplaceService({
        rootDir: join(root, 'store'),
        projectDir: project,
        pluginVersion: '3.5.0',
      });
      service.install(bundle());
      const lockfile = readFileSync(service.store.paths.lockfilePath, 'utf8');
      const originalRename = fsModule.renameSync;
      const rename = spyOn(fsModule, 'renameSync').mockImplementation(
        (source, destination) => {
          if (destination === service.store.paths.lockfilePath) {
            throw new Error('injected lockfile publication failure');
          }
          return originalRename(source, destination);
        },
      );
      try {
        expect(() => service.remove('community/example')).toThrow(
          'injected lockfile publication failure',
        );
      } finally {
        rename.mockRestore();
      }
      expect(readFileSync(configPath, 'utf8')).toBe(config);
      expect(readFileSync(service.store.paths.lockfilePath, 'utf8')).toBe(
        lockfile,
      );
      expect(service.show('community/example').manifest.id).toBe(
        'community/example',
      );
      service.remove('community/example');
      expect(readFileSync(configPath, 'utf8')).not.toContain(
        'community/example',
      );
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not restore references after committed store finalization failure', () => {
    const root = tempRoot();
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const project = join(root, 'project');
    const configPath = join(project, '.opencode', 'oh-my-opencode-slim.json');
    try {
      process.env.XDG_CONFIG_HOME = join(root, 'config');
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          presets: {
            work: { marketplace: { agents: ['community/example'] } },
          },
        }),
      );
      const service = new MarketplaceService({
        rootDir: join(root, 'store'),
        projectDir: project,
        pluginVersion: '3.5.0',
      });
      service.install(bundle());
      const originalUnlink = fsModule.unlinkSync;
      const unlink = spyOn(fsModule, 'unlinkSync').mockImplementation(
        (path) => {
          if (
            typeof path === 'string' &&
            path.startsWith(`${service.store.paths.lockDir}/`) &&
            path.endsWith('.lease')
          ) {
            throw new Error('injected lease release failure');
          }
          return originalUnlink(path);
        },
      );
      try {
        expect(() => service.remove('community/example')).toThrow(
          'finalization failed; config references remain removed',
        );
      } finally {
        unlink.mockRestore();
      }
      expect(service.store.getLockfile().packages['community/example']).toBe(
        undefined,
      );
      expect(
        existsSync(
          join(service.store.paths.packagesDir, 'community', 'example'),
        ),
      ).toBe(false);
      expect(readFileSync(configPath, 'utf8')).not.toContain(
        'community/example',
      );
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps stale references removed when retry cleanup fails after commit', () => {
    const root = tempRoot();
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const project = join(root, 'project');
    const configPath = join(project, '.opencode', 'oh-my-opencode-slim.json');
    const staleConfig = JSON.stringify({
      presets: { work: { marketplace: { agents: ['community/example'] } } },
    });
    try {
      process.env.XDG_CONFIG_HOME = join(root, 'config');
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(configPath, staleConfig);
      const service = new MarketplaceService({
        rootDir: join(root, 'store'),
        projectDir: project,
        pluginVersion: '3.5.0',
      });
      service.install(bundle());

      const quarantineRoot = join(
        service.store.paths.stagingDir,
        'removed',
        'community',
        'example',
      );
      const originalRm = fsModule.rmSync;
      const remove = spyOn(fsModule, 'rmSync').mockImplementation(
        (path, options) => {
          if (typeof path === 'string' && path.startsWith(quarantineRoot)) {
            throw new Error('injected removal quarantine cleanup failure');
          }
          return originalRm(path, options);
        },
      );
      try {
        // The first request commits removal, but cleanup remains pending.
        service.remove('community/example');
        expect(existsSync(quarantineRoot)).toBe(true);
        expect(readFileSync(configPath, 'utf8')).not.toContain(
          'community/example',
        );

        // Simulate stale config left by another writer before a retry.
        writeFileSync(configPath, staleConfig);
        expect(() => service.remove('community/example')).toThrow(
          'finalization failed; config references remain removed',
        );
        expect(readFileSync(configPath, 'utf8')).not.toContain(
          'community/example',
        );
        expect(
          service.store.getLockfile().packages['community/example'],
        ).toBeUndefined();
        expect(
          existsSync(
            join(service.store.paths.packagesDir, 'community', 'example'),
          ),
        ).toBe(false);
        expect(existsSync(quarantineRoot)).toBe(true);
      } finally {
        remove.mockRestore();
      }

      service.remove('community/example');
      expect(existsSync(quarantineRoot)).toBe(false);
      expect(readFileSync(configPath, 'utf8')).not.toContain(
        'community/example',
      );
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cleans references for a package that is already absent', () => {
    const root = tempRoot();
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const project = join(root, 'project');
    const configPath = join(project, '.opencode', 'oh-my-opencode-slim.json');
    try {
      process.env.XDG_CONFIG_HOME = join(root, 'config');
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          presets: {
            work: { marketplace: { agents: ['community/example'] } },
          },
        }),
      );
      const service = new MarketplaceService({
        rootDir: join(root, 'store'),
        projectDir: project,
      });
      service.remove('community/example');
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
        presets: { work: { marketplace: { agents: [] } } },
      });
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
