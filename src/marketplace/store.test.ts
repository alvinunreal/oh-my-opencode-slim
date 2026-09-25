import { describe, expect, spyOn, test } from 'bun:test';
import * as fsModule from 'node:fs';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireMarketplaceLeaseForPaths,
  MarketplaceBusyError,
  MarketplaceConflictError,
  MarketplaceIntegrityError,
  MarketplaceLockfileError,
  type MarketplacePackageBundle,
  MarketplaceService,
  MarketplaceStore,
} from './index';
import type { MarketplacePaths } from './paths';

function bundle(
  version = '1.0.0',
  overrides: Partial<MarketplacePackageBundle['manifest']> = {},
): MarketplacePackageBundle {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'community/example',
      version,
      displayName: 'Example',
      description: 'An example package',
      agentName: 'example',
      prompt: 'Use the example role carefully.',
      author: { name: 'Example Community' },
      tags: ['example'],
      license: 'MIT',
      compatibility: {
        plugin: '>=3.0.0-beta.3 <4.0.0',
      },
      routing: {
        description: 'Explore example code.',
        keywords: ['example'],
        when: 'When repository exploration is needed.',
      },
      skills: [],
      mcps: [],
      tools: [],
      model: { source: 'explicit', candidates: ['provider/model'] },
      ...overrides,
    } as MarketplacePackageBundle['manifest'],
  };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marketplace-store-'));
}

function markStaleLease(directory: string, pid: number, uuid: string): void {
  mkdirSync(directory, { recursive: true });
  const target = join(directory, `${pid}.${uuid}.lease`);
  const fd = fsModule.openSync(target, 'wx', 0o600);
  fsModule.closeSync(fd);
  const old = new Date(Date.now() - 2_000);
  fsModule.utimesSync(target, old, old);
}

function spawnLockWorker(
  paths: MarketplacePaths,
  logPath: string,
  body: string,
): Bun.Subprocess {
  return Bun.spawn(
    [
      'bun',
      '-e',
      `import { acquireMarketplaceLeaseForPaths } from './src/marketplace/store.ts';
${body}`,
      JSON.stringify({ paths, logPath }),
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  );
}

describe('MarketplaceStore', () => {
  test('installs, verifies, and lists an immutable exact version', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({ rootDir: root });
      const installed = store.install(bundle());
      expect(installed.manifest.version).toBe('1.0.0');
      expect(store.verify('community/example').valid).toBe(true);
      expect(store.list().map((pkg) => pkg.manifest.id)).toEqual([
        'community/example',
      ]);
      expect(store.getLockfile().packages['community/example']).toEqual({
        manifestSchemaVersion: 2,
        manifestVersion: '1.0.0',
        source: { kind: 'in-memory', label: 'programmatic' },
        digest: {
          algorithm: 'sha256',
          domain: 'marketplace-agent-bundle-v2',
          value: installed.digest,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('inspectAll reports corrupt packages without failing the snapshot', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({ rootDir: root });
      const first = store.install(bundle());
      store.install(
        bundle('1.0.0', {
          id: 'community/other',
          agentName: 'other',
          displayName: 'Other',
        }),
      );
      writeFileSync(join(first.path, 'package.json'), '{not-valid-json');
      const firstInspect = store.inspectAll();
      const secondInspect = store.inspectAll();
      expect(firstInspect.lockfileError).toBeUndefined();
      expect(firstInspect.packages.map((pkg) => pkg.manifest.id)).toEqual([
        'community/other',
      ]);
      expect(
        firstInspect.verifications.find(
          (entry) => entry.id === 'community/example',
        )?.valid,
      ).toBe(false);
      expect(
        firstInspect.verifications.find(
          (entry) => entry.id === 'community/other',
        )?.valid,
      ).toBe(true);
      expect(secondInspect).toEqual(firstInspect);
      expect(() => store.list()).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('inspectAll classifies missing package files as integrity errors', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({ rootDir: root });
      const first = store.install(bundle());
      store.install(
        bundle('1.0.0', {
          id: 'community/other',
          agentName: 'other',
          displayName: 'Other',
        }),
      );
      rmSync(join(first.path, 'package.json'));
      const inspection = store.inspectAll();
      expect(inspection.packages.map((pkg) => pkg.manifest.id)).toEqual([
        'community/other',
      ]);
      expect(
        inspection.verifications.find(
          (entry) => entry.id === 'community/example',
        ),
      ).toMatchObject({
        valid: false,
        message: expect.stringMatching(/ENOENT|no such file/i),
      });
      expect(
        inspection.verifications.find((entry) => entry.id === 'community/other')
          ?.valid,
      ).toBe(true);
      expect(inspection.lockfileError).toBeUndefined();
      expect(inspection.operationalError).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('lockfile read failures stay operational instead of lockfile corruption', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(bundle());
      chmodSync(store.paths.lockfilePath, 0);
      try {
        try {
          store.getLockfile();
          throw new Error('expected lockfile read to fail');
        } catch (error) {
          expect(error).not.toBeInstanceOf(MarketplaceLockfileError);
          expect((error as NodeJS.ErrnoException).code).toBe('EACCES');
        }
        const inspection = store.inspectAll();
        expect(inspection.lockfileError).toBeUndefined();
        expect(inspection.operationalError).toMatch(/EACCES|permission/i);
      } finally {
        chmodSync(store.paths.lockfilePath, 0o644);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('inspectAll classifies invalid lockfiles as lockfile errors', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({ rootDir: root });
      mkdirSync(root, { recursive: true });
      writeFileSync(store.paths.lockfilePath, '{not-a-lockfile');
      const inspection = store.inspectAll();
      expect(inspection.packages).toEqual([]);
      expect(inspection.lockfileError).toContain('Marketplace lockfile');
      expect(inspection.operationalError).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects replacing an immutable package version with different data', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(bundle());
      expect(() =>
        store.install(bundle('1.0.0', { prompt: 'Changed instructions.' })),
      ).toThrow(MarketplaceConflictError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('loads a selected package when another installed package is corrupt', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(bundle());
      store.install(
        bundle('1.0.0', {
          id: 'community/other',
          agentName: 'other',
        }),
      );
      writeFileSync(
        join(root, 'packages', 'community', 'other', '1.0.0', 'package.json'),
        '{"not":"a package"}',
      );
      const selected = store.loadSelected([
        'community/example',
        'community/other',
      ]);
      expect(selected.packages.get('community/example')?.manifest.id).toBe(
        'community/example',
      );
      expect(selected.errors.get('community/other')).toBeInstanceOf(
        MarketplaceIntegrityError,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects tampering without loading corrupted package data', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(bundle());
      writeFileSync(
        join(root, 'packages', 'community', 'example', '1.0.0', 'package.json'),
        '{"not":"a package"}',
      );
      expect(() => store.list()).toThrow(MarketplaceIntegrityError);
      expect(store.verify('community/example').valid).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('removes packages with corrupt or missing selected payloads', () => {
    for (const damagedPayload of ['corrupt', 'missing'] as const) {
      const root = tempRoot();
      try {
        const store = new MarketplaceStore({ rootDir: root });
        const installed = store.install(bundle());
        if (damagedPayload === 'corrupt') {
          writeFileSync(join(installed.path, 'package.json'), '{broken');
        } else {
          rmSync(join(root, 'packages', 'community', 'example'), {
            recursive: true,
            force: true,
          });
        }

        expect(() => store.remove('community/example')).not.toThrow();
        expect(store.getLockfile().packages).toEqual({});
        expect(store.list()).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('repairs a damaged package only from the exact locked bundle', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({ rootDir: root });
      const original = bundle();
      const installed = store.install(original);
      writeFileSync(join(installed.path, 'package.json'), '{broken');

      expect(() =>
        store.install(bundle('1.0.0', { prompt: 'A replacement body.' })),
      ).toThrow(MarketplaceConflictError);
      expect(store.install(original).digest).toBe(installed.digest);
      expect(store.verify('community/example').valid).toBe(true);

      writeFileSync(join(installed.path, 'package.json'), '{broken');
      expect(store.update(bundle('2.0.0')).manifest.version).toBe('2.0.0');
      expect(store.verify('community/example').valid).toBe(true);
      expect(() => store.update(original)).toThrow(MarketplaceConflictError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not overwrite a corrupt lockfile', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({ rootDir: root });
      mkdirSync(root, { recursive: true });
      writeFileSync(store.paths.lockfilePath, '{bad json');
      expect(() => store.getLockfile()).toThrow(MarketplaceLockfileError);
      expect(() => store.install(bundle())).toThrow(MarketplaceLockfileError);
      expect(existsSync(store.paths.lockfilePath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails rather than racing another lifecycle operation', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({
        rootDir: root,
        lock: { timeoutMs: 10, retryMs: 1 },
      });
      mkdirSync(root, { recursive: true });
      markStaleLease(
        store.paths.lockDir,
        process.pid,
        '00000000-0000-4000-8000-000000000001',
      );
      expect(() => store.install(bundle())).toThrow(MarketplaceBusyError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('recovers a lock left by a dead process', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({
        rootDir: root,
        lock: { staleMs: 200, retryMs: 1 },
      });
      mkdirSync(root, { recursive: true });
      markStaleLease(
        store.paths.lockDir,
        999_999_999,
        '00000000-0000-4000-8000-000000000001',
      );
      expect(store.install(bundle()).manifest.id).toBe('community/example');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('blocks a concurrent worker and recovers after the worker exits', async () => {
    const root = tempRoot();
    const readyPath = join(root, 'worker-ready');
    const store = new MarketplaceStore({
      rootDir: root,
      lock: { staleMs: 500, timeoutMs: 30, retryMs: 1 },
    });
    const worker = Bun.spawn(
      [
        'bun',
        '-e',
        `import { writeFileSync } from 'node:fs';
import { acquireMarketplaceLeaseForPaths } from './src/marketplace/store.ts';
const { paths, readyPath } = JSON.parse(process.argv[1]);
acquireMarketplaceLeaseForPaths(paths, { staleMs: 500, timeoutMs: 5000 });
writeFileSync(readyPath, 'ready');
await new Promise(() => {});`,
        JSON.stringify({ paths: store.paths, readyPath }),
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    try {
      for (
        let attempt = 0;
        attempt < 200 && !existsSync(readyPath);
        attempt++
      ) {
        await Bun.sleep(10);
      }
      expect(existsSync(readyPath)).toBe(true);
      expect(() => store.list()).toThrow(MarketplaceBusyError);
      worker.kill();
      await worker.exited;
      await Bun.sleep(700);
      expect(store.list()).toEqual([]);
    } finally {
      worker.kill();
      await worker.exited.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('serializes simultaneous stale reclaimers across generations', async () => {
    const root = tempRoot();
    const store = new MarketplaceStore({
      rootDir: root,
      lock: { staleMs: 1000, timeoutMs: 2000, retryMs: 5 },
    });
    const logPath = join(root, 'reclaim.log');
    try {
      markStaleLease(
        store.paths.lockDir,
        999_999_999,
        '00000000-0000-4000-8000-000000000001',
      );
      const body = `import { appendFileSync, closeSync, openSync, rmSync } from 'node:fs';
const { paths, logPath } = JSON.parse(process.argv[1]);
const lease = acquireMarketplaceLeaseForPaths(paths, { staleMs: 1000, timeoutMs: 2000, retryMs: 5 });
const activePath = logPath + '.active';
try {
  lease.commit(() => {
    const fd = openSync(activePath, 'wx');
    closeSync(fd);
    appendFileSync(logPath, 'acquired\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    rmSync(activePath, { force: true });
    appendFileSync(logPath, 'released\\n');
  });
} finally {
  lease.release();
}`;
      const workers = [
        spawnLockWorker(store.paths, logPath, body),
        spawnLockWorker(store.paths, logPath, body),
      ];
      const exitCodes = await Promise.all(
        workers.map((worker) => worker.exited),
      );
      const errors = await Promise.all(
        workers.map((worker) => new Response(worker.stderr).text()),
      );
      if (exitCodes.some((code) => code !== 0)) {
        throw new Error(errors.join('\n'));
      }
      expect(exitCodes).toEqual([0, 0]);
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual([
        'acquired',
        'released',
        'acquired',
        'released',
      ]);
      expect(existsSync(store.paths.lockDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps a live owner authoritative after its lease becomes old', () => {
    const root = tempRoot();
    const store = new MarketplaceStore({
      rootDir: root,
      lock: { staleMs: 1_000, timeoutMs: 1000, retryMs: 10 },
    });
    try {
      const owner = acquireMarketplaceLeaseForPaths(store.paths, {
        staleMs: 1_000,
        timeoutMs: 1000,
        retryMs: 10,
      });
      const old = new Date(Date.now() - 2_000);
      const leasePath = join(
        store.paths.lockDir,
        readdirSync(store.paths.lockDir)[0],
      );
      fsModule.utimesSync(leasePath, old, old);
      expect(() =>
        acquireMarketplaceLeaseForPaths(store.paths, {
          staleMs: 1_000,
          timeoutMs: 120,
          retryMs: 10,
        }),
      ).toThrow(MarketplaceBusyError);
      expect(() => owner.assertCurrent()).not.toThrow();
      owner.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps the previous lifecycle state when lockfile publication fails', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({ rootDir: root });
      const originalRename = fsModule.renameSync;
      const rename = spyOn(fsModule, 'renameSync').mockImplementation(
        (source, destination) => {
          if (destination === store.paths.lockfilePath) {
            throw new Error('injected lockfile rename failure');
          }
          return originalRename(source, destination);
        },
      );
      expect(() => store.install(bundle())).toThrow(
        'injected lockfile rename failure',
      );
      rename.mockRestore();
      expect(store.getLockfile().packages).toEqual({});
      expect(store.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('restores an abandoned removal staging directory', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(bundle());
      const packagePath = join(root, 'packages', 'community', 'example');
      const quarantinePath = join(
        root,
        '.staging',
        'removed',
        'community',
        'example',
      );
      mkdirSync(join(root, '.staging', 'removed', 'community'), {
        recursive: true,
      });
      fsModule.renameSync(packagePath, quarantinePath);
      expect(store.list()[0]?.manifest.id).toBe('community/example');
      expect(existsSync(packagePath)).toBe(true);
      expect(existsSync(quarantinePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('restores package data when removal lock publication fails', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(bundle());
      const originalRename = fsModule.renameSync;
      const rename = spyOn(fsModule, 'renameSync').mockImplementation(
        (source, destination) => {
          if (destination === store.paths.lockfilePath) {
            throw new Error('injected removal lock failure');
          }
          return originalRename(source, destination);
        },
      );
      expect(() => store.remove('community/example')).toThrow(
        'injected removal lock failure',
      );
      rename.mockRestore();
      expect(store.show('community/example').manifest.id).toBe(
        'community/example',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reconciles a committed removal quarantine orphan', () => {
    const root = tempRoot();
    try {
      const store = new MarketplaceStore({ rootDir: root });
      store.install(bundle());
      const originalRemove = fsModule.rmSync;
      const remove = spyOn(fsModule, 'rmSync').mockImplementation(
        (target, options) => {
          if (String(target).includes(`${pathSeparator()}removed`)) {
            throw new Error('injected garbage collection failure');
          }
          return originalRemove(target, options);
        },
      );
      store.remove('community/example');
      remove.mockRestore();
      expect(store.getLockfile().packages).toEqual({});
      expect(store.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function pathSeparator(): string {
  return '/removed/';
}

describe('MarketplaceService', () => {
  test('requires explicit updates', () => {
    const root = tempRoot();
    try {
      const service = new MarketplaceService({ rootDir: root });
      service.install(bundle());
      expect(() => service.install(bundle('2.0.0'))).toThrow(
        MarketplaceConflictError,
      );
      service.update(bundle('2.0.0'));
      expect(service.verify('community/example')[0]?.version).toBe('2.0.0');
      service.remove('community/example');
      expect(service.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('updates only to a strictly newer version and preserve state on rejection', () => {
    const root = tempRoot();
    try {
      const service = new MarketplaceService({ rootDir: root });
      expect(() => service.update(bundle('1.0.0'))).toThrow(
        MarketplaceConflictError,
      );
      service.install(bundle('2.0.0'));
      expect(() => service.update(bundle('2.0.0'))).toThrow(
        MarketplaceConflictError,
      );
      expect(() => service.update(bundle('1.0.0'))).toThrow(
        MarketplaceConflictError,
      );
      expect(service.show('community/example').manifest.version).toBe('2.0.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves locked bytes when same-version install has a different digest', () => {
    const root = tempRoot();
    try {
      const service = new MarketplaceService({ rootDir: root });
      const installed = service.install(bundle());
      const lockBefore = readFileSync(service.store.paths.lockfilePath);
      const packageBefore = readFileSync(join(installed.path, 'package.json'));
      const digestBefore = readFileSync(join(installed.path, 'sha256'));

      expect(() =>
        service.install(
          bundle('1.0.0', { prompt: 'A different package body.' }),
        ),
      ).toThrow(MarketplaceConflictError);

      expect(readFileSync(service.store.paths.lockfilePath)).toEqual(
        lockBefore,
      );
      expect(readFileSync(join(installed.path, 'package.json'))).toEqual(
        packageBefore,
      );
      expect(readFileSync(join(installed.path, 'sha256'))).toEqual(
        digestBefore,
      );
      expect(service.show('community/example').digest).toBe(
        digestBefore.toString().trim(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves the canonical local import source and exposes show', () => {
    const root = tempRoot();
    const packageFile = join(root, 'package.json');
    try {
      writeFileSync(packageFile, JSON.stringify(bundle().manifest));
      const service = new MarketplaceService({ rootDir: join(root, 'store') });
      service.installFile(packageFile);
      expect(service.show('community/example').source).toEqual({
        kind: 'local',
        path: realpathSync(packageFile),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not remove config references when package removal fails', () => {
    const root = tempRoot();
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    const configPath = join(project, '.opencode', 'oh-my-opencode-slim.json');
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          presets: {
            work: {
              marketplace: { agents: ['community/example'] },
            },
          },
        }),
      );
      const service = new MarketplaceService({
        rootDir: join(root, 'store'),
        projectDir: project,
      });
      service.install(bundle());
      const remove = spyOn(service.store, 'remove').mockImplementation(() => {
        throw new Error('injected store removal failure');
      });
      expect(() => service.remove('community/example')).toThrow(
        'injected store removal failure',
      );
      remove.mockRestore();
      expect(readFileSync(configPath, 'utf8')).toBe(
        JSON.stringify({
          presets: {
            work: {
              marketplace: { agents: ['community/example'] },
            },
          },
        }),
      );
      expect(service.store.show('community/example').manifest.id).toBe(
        'community/example',
      );
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(['malformed project config', 'config publication failure'])(
    'keeps package and both config references on %s',
    (failure) => {
      const root = tempRoot();
      const previousConfigHome = process.env.XDG_CONFIG_HOME;
      const configHome = join(root, 'config');
      const project = join(root, 'project');
      const configPath = join(project, '.opencode', 'oh-my-opencode-slim.json');
      const userPath = join(configHome, 'opencode', 'oh-my-opencode-slim.json');
      const configContent = JSON.stringify({
        presets: {
          work: {
            marketplace: { agents: ['community/example'] },
          },
        },
      });
      try {
        process.env.XDG_CONFIG_HOME = configHome;
        mkdirSync(join(project, '.opencode'), { recursive: true });
        mkdirSync(join(configHome, 'opencode'), { recursive: true });
        writeFileSync(configPath, configContent);
        writeFileSync(userPath, configContent);
        const service = new MarketplaceService({
          rootDir: join(root, 'store'),
          projectDir: project,
        });
        service.install(bundle());

        if (failure === 'malformed project config') {
          writeFileSync(configPath, '{ invalid');
        }
        const originalRename = fsModule.renameSync;
        let publicationFailed = false;
        const rename =
          failure === 'config publication failure'
            ? spyOn(fsModule, 'renameSync').mockImplementation(
                (source, destination) => {
                  if (destination === configPath && !publicationFailed) {
                    publicationFailed = true;
                    throw new Error('injected config cleanup failure');
                  }
                  return originalRename(source, destination);
                },
              )
            : undefined;
        const projectBefore = readFileSync(configPath, 'utf8');
        try {
          expect(() => service.remove('community/example')).toThrow(
            failure === 'malformed project config'
              ? `Failed to parse config ${configPath}`
              : 'injected config cleanup failure',
          );
        } finally {
          rename?.mockRestore();
        }
        expect(service.store.show('community/example').manifest.id).toBe(
          'community/example',
        );
        expect(
          readFileSync(service.store.paths.lockfilePath, 'utf8'),
        ).toContain('community/example');
        expect(readFileSync(configPath, 'utf8')).toBe(projectBefore);
        expect(readFileSync(userPath, 'utf8')).toBe(configContent);
      } finally {
        if (previousConfigHome === undefined)
          delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousConfigHome;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('restores both published configs when store removal fails', () => {
    const root = tempRoot();
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    const userPath = join(configHome, 'opencode', 'oh-my-opencode-slim.json');
    const projectPath = join(project, '.opencode', 'oh-my-opencode-slim.json');
    const content = JSON.stringify({
      presets: { work: { marketplace: { agents: ['community/example'] } } },
    });
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(userPath, content);
      writeFileSync(projectPath, content);
      const service = new MarketplaceService({
        rootDir: join(root, 'store'),
        projectDir: project,
      });
      service.install(bundle());
      const lockBefore = readFileSync(service.store.paths.lockfilePath, 'utf8');
      const originalRename = fsModule.renameSync;
      const rename = spyOn(fsModule, 'renameSync').mockImplementation(
        (source, destination) => {
          if (destination === service.store.paths.lockfilePath) {
            expect(JSON.parse(readFileSync(userPath, 'utf8'))).toEqual({
              presets: { work: { marketplace: { agents: [] } } },
            });
            expect(JSON.parse(readFileSync(projectPath, 'utf8'))).toEqual({
              presets: { work: { marketplace: { agents: [] } } },
            });
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
      expect(readFileSync(userPath, 'utf8')).toBe(content);
      expect(readFileSync(projectPath, 'utf8')).toBe(content);
      expect(readFileSync(service.store.paths.lockfilePath, 'utf8')).toBe(
        lockBefore,
      );
      expect(service.store.show('community/example').manifest.id).toBe(
        'community/example',
      );
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retains cleaned references after a committed removal lease release fails', () => {
    const root = tempRoot();
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    const userPath = join(configHome, 'opencode', 'oh-my-opencode-slim.json');
    const projectPath = join(project, '.opencode', 'oh-my-opencode-slim.json');
    const content = JSON.stringify({
      presets: { work: { marketplace: { agents: ['community/example'] } } },
    });
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(userPath, content);
      writeFileSync(projectPath, content);
      const service = new MarketplaceService({
        rootDir: join(root, 'store'),
        projectDir: project,
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
            throw new Error('injected store lease release failure');
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
      expect(
        JSON.parse(readFileSync(service.store.paths.lockfilePath, 'utf8'))
          .packages['community/example'],
      ).toBeUndefined();
      expect(
        existsSync(
          join(service.store.paths.packagesDir, 'community', 'example'),
        ),
      ).toBe(false);
      for (const configPath of [userPath, projectPath]) {
        expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
          presets: { work: { marketplace: { agents: [] } } },
        });
      }
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cleans references for an already absent package', () => {
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
          presets: { work: { marketplace: { agents: ['community/example'] } } },
        }),
      );
      const service = new MarketplaceService({
        rootDir: join(root, 'store'),
        projectDir: project,
      });
      expect(() => service.remove('community/example')).not.toThrow();
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
        presets: { work: { marketplace: { agents: [] } } },
      });
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('normalizes package IDs for management commands', () => {
    const root = tempRoot();
    try {
      const service = new MarketplaceService({ rootDir: root });
      service.install(bundle());
      expect(service.verify(' COMMUNITY/EXAMPLE ')[0]?.valid).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
