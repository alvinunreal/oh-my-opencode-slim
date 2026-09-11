import { describe, expect, spyOn, test } from 'bun:test';
import * as fsModule from 'node:fs';
import {
  chmodSync,
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
  acquireMarketplaceLeaseForPaths,
  MarketplaceBusyError,
  MarketplaceConflictError,
  MarketplaceIntegrityError,
  MarketplaceLockfileError,
  MarketplaceLockOwnershipError,
  type MarketplacePackageBundle,
  MarketplaceService,
  MarketplaceStore,
} from './index';
import { heartbeatPath, publishGeneration, readLeaseState } from './lease';
import type { MarketplacePaths } from './paths';

function bundle(
  version = '1.0.0',
  overrides: Partial<MarketplacePackageBundle['manifest']> = {},
): MarketplacePackageBundle {
  return {
    manifest: {
      schemaVersion: 1,
      id: 'community/example',
      version,
      kind: 'agent',
      displayName: 'Example',
      description: 'An example package',
      instructions: 'Use the example role carefully.',
      author: { name: 'Example Community' },
      tags: ['example'],
      license: 'MIT',
      compatibility: {
        plugin: '>=2.2.0 <3.0.0 || >=3.0.0-beta.0 <4.0.0',
        roleContract: '^1.0.0',
      },
      routing: {
        description: 'Explore example code.',
        keywords: ['example'],
        delegation: {
          when: 'When repository exploration is needed.',
          preferredRoles: [],
        },
      },
      baseRole: 'explorer',
      agentName: 'example',
      overrides: {},
      requirements: {
        skills: { required: [], optional: [] },
        mcps: { required: [], optional: [] },
      },
      capabilities: { tools: [], permissions: [] },
      ...overrides,
    } as MarketplacePackageBundle['manifest'],
  };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marketplace-store-'));
}

function markStaleGeneration(directory: string, generation: string): void {
  const target = join(directory, 'gen', generation);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, 'meta.json'),
    JSON.stringify({ generation, token: 'stale-token', pid: -1 }),
  );
  writeFileSync(join(target, 'heartbeat'), '');
  const old = new Date(Date.now() - 2_000);
  fsModule.utimesSync(target, old, old);
  fsModule.utimesSync(join(target, 'meta.json'), old, old);
  fsModule.utimesSync(join(target, 'heartbeat'), old, old);
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
    { stdout: 'ignore', stderr: 'ignore' },
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
        manifestSchemaVersion: 1,
        manifestVersion: '1.0.0',
        source: { kind: 'in-memory', label: 'programmatic' },
        digest: {
          algorithm: 'sha256',
          domain: 'marketplace-bundle-v1',
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

  test('inspectAll classifies missing package files as operational errors', () => {
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
      expect(inspection.packages).toEqual([]);
      expect(inspection.verifications).toEqual([]);
      expect(inspection.lockfileError).toBeUndefined();
      expect(inspection.operationalError).toMatch(/ENOENT|no such file/i);
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
        store.install(
          bundle('1.0.0', { instructions: 'Changed instructions.' }),
        ),
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
      expect(
        publishGeneration(store.paths.lockDir, {
          generation: 'blocking-generation',
          token: 'blocking-token',
        }),
      ).toBe(true);
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
        lock: { staleMs: 200, heartbeatMs: 50, retryMs: 1 },
      });
      mkdirSync(root, { recursive: true });
      markStaleGeneration(store.paths.lockDir, 'dead-lock-generation');
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
      lock: { staleMs: 100, heartbeatMs: 10, timeoutMs: 30, retryMs: 1 },
    });
    const worker = Bun.spawn(
      [
        'bun',
        '-e',
        `import { writeFileSync } from 'node:fs';
import { acquireMarketplaceLeaseForPaths } from './src/marketplace/store.ts';
const { paths, readyPath } = JSON.parse(process.argv[1]);
acquireMarketplaceLeaseForPaths(paths, { staleMs: 100, timeoutMs: 5000, heartbeatMs: 10 });
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
      await Bun.sleep(250);
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
      lock: { staleMs: 1000, heartbeatMs: 100, timeoutMs: 2000, retryMs: 5 },
    });
    const logPath = join(root, 'reclaim.log');
    try {
      markStaleGeneration(store.paths.lockDir, 'stale-lock-generation');
      markStaleGeneration(store.paths.breakerDir, 'stale-breaker-generation');
      const body = `import { appendFileSync, closeSync, openSync, rmSync } from 'node:fs';
const { paths, logPath } = JSON.parse(process.argv[1]);
const lease = acquireMarketplaceLeaseForPaths(paths, { staleMs: 1000, heartbeatMs: 100, timeoutMs: 2000, retryMs: 5 });
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
      expect(exitCodes).toEqual([0, 0]);
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual([
        'acquired',
        'released',
        'acquired',
        'released',
      ]);
      expect(readLeaseState(store.paths.breakerDir)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fences an expired owner when a replacement generation takes over', () => {
    const root = tempRoot();
    const store = new MarketplaceStore({
      rootDir: root,
      lock: { staleMs: 200, heartbeatMs: 50, timeoutMs: 1000, retryMs: 10 },
    });
    try {
      const owner = acquireMarketplaceLeaseForPaths(store.paths, {
        staleMs: 200,
        heartbeatMs: 50,
        timeoutMs: 1000,
        retryMs: 10,
      });
      const old = new Date(Date.now() - 2_000);
      fsModule.utimesSync(
        heartbeatPath(store.paths.lockDir, owner.generation),
        old,
        old,
      );
      const replacement = acquireMarketplaceLeaseForPaths(store.paths, {
        staleMs: 200,
        heartbeatMs: 50,
        timeoutMs: 1000,
        retryMs: 10,
      });
      expect(() => owner.release()).toThrow(MarketplaceLockOwnershipError);
      expect(() => owner.commit(() => undefined)).toThrow(
        MarketplaceLockOwnershipError,
      );
      expect(() => replacement.assertCurrent()).not.toThrow();
      expect(() => replacement.commit(() => undefined)).not.toThrow();
      replacement.release();
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
          bundle('1.0.0', { instructions: 'A different package body.' }),
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
        path: packageFile,
      });
    } finally {
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
