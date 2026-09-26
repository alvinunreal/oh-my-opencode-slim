import { describe, expect, spyOn, test } from 'bun:test';
import * as fsModule from 'node:fs';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeMarketplaceValue } from './canonical';
import {
  MarketplaceBusyError,
  MarketplaceCompatibilityError,
  MarketplaceConflictError,
  MarketplaceIntegrityError,
  MarketplaceLockfileError,
  MarketplaceValidationError,
} from './errors';
import { acquireMarketplaceLease } from './lease';
import type { MarketplacePaths } from './paths';
import type { MarketplacePackageBundle } from './schemas';
import type { MarketplaceStoreOptions } from './store';
import { MarketplaceStore } from './store';

function createStore(
  options: Omit<MarketplaceStoreOptions, 'pluginVersion'> & {
    pluginVersion?: string;
  } = {},
): MarketplaceStore {
  return new MarketplaceStore({
    ...options,
    pluginVersion: options.pluginVersion ?? '3.2.0',
  });
}

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

function v3Bundle(version = '1.0.0'): MarketplacePackageBundle {
  const manifest = bundle(version).manifest;
  return {
    manifest: {
      ...manifest,
      schemaVersion: 3,
      routing: {
        lane: 'Focused codebase work.',
        stats: ['Fast execution'],
        delegateWhen: ['The request has a bounded scope.'],
        avoid: ['Unrelated changes'],
      },
    } as MarketplacePackageBundle['manifest'],
  };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marketplace-store-'));
}

function createStoreWithInterruptedUpdate(
  damage: 'corrupt' | 'missing' | 'unreadable',
): {
  root: string;
  store: MarketplaceStore;
  olderVersionPath: string;
  oldPackageBytes: Buffer;
  oldSidecarBytes: Buffer;
} {
  const root = tempRoot();
  const store = createStore({ rootDir: root });
  const v1 = store.install(bundle('1.0.0'));
  const oldPackageBytes = readFileSync(join(v1.path, 'package.json'));
  const oldSidecarBytes = readFileSync(join(v1.path, 'sha256'));
  const v2 = store.update(bundle('2.0.0'));
  store.install(bundle('1.0.0', { id: 'community/other', agentName: 'other' }));

  mkdirSync(v1.path, { recursive: true });
  writeFileSync(join(v1.path, 'package.json'), oldPackageBytes);
  writeFileSync(join(v1.path, 'sha256'), oldSidecarBytes);

  if (damage === 'corrupt') {
    writeFileSync(join(v2.path, 'package.json'), '{corrupt selected');
  } else if (damage === 'missing') {
    rmSync(v2.path, { recursive: true, force: true });
  } else {
    const selectedManifest = join(v2.path, 'package.json');
    rmSync(selectedManifest);
    mkdirSync(selectedManifest);
  }

  return {
    root,
    store,
    olderVersionPath: v1.path,
    oldPackageBytes,
    oldSidecarBytes,
  };
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
      `import { acquireMarketplaceLease } from './src/marketplace/lease.ts';
${body}`,
      JSON.stringify({ paths, logPath }),
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  );
}

describe('MarketplaceStore', () => {
  test('updates only to a strictly newer semantic version', () => {
    const root = tempRoot();
    try {
      const store = createStore({ rootDir: root });
      store.install(bundle('1.0.0'));
      const lockedBytes = readFileSync(store.paths.lockfilePath);
      expect(() => store.update(bundle('1.0.0'))).toThrow(
        MarketplaceConflictError,
      );
      expect(() => store.update(bundle('0.9.0'))).toThrow(
        MarketplaceConflictError,
      );
      expect(readFileSync(store.paths.lockfilePath)).toEqual(lockedBytes);
      expect(store.update(bundle('1.1.0-beta.1')).manifest.version).toBe(
        '1.1.0-beta.1',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects absent updates, different-version installs, and metadata-only updates', () => {
    const root = tempRoot();
    try {
      const store = createStore({ rootDir: root });
      expect(() => store.update(bundle('1.0.0'))).toThrow(
        MarketplaceConflictError,
      );
      store.install(bundle('1.0.0'));
      expect(() => store.install(bundle('2.0.0'))).toThrow(
        MarketplaceConflictError,
      );
      expect(() => store.update(bundle('1.0.0+build.2'))).toThrow(
        MarketplaceConflictError,
      );
      expect(store.install(bundle('1.0.0')).manifest.version).toBe('1.0.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('repairs only exact locked V2 and V3 bundles and verifies reopened disk bytes', () => {
    for (const createBundle of [bundle, v3Bundle]) {
      const root = tempRoot();
      try {
        const store = createStore({ rootDir: root });
        const input = createBundle();
        const originalSource = {
          kind: 'in-memory',
          label: 'original-source',
        } as const;
        const installed = store.install(input, originalSource);
        const packageFile = join(installed.path, 'package.json');
        const expectedPackageBytes = `${canonicalizeMarketplaceValue(input)}\n`;
        expect(readFileSync(packageFile, 'utf8')).toBe(expectedPackageBytes);
        writeFileSync(packageFile, '{damaged selected package');
        const differentBundle = {
          manifest: {
            ...input.manifest,
            prompt: 'different immutable prompt',
          },
        } as MarketplacePackageBundle;

        expect(() => store.install(differentBundle)).toThrow(
          MarketplaceConflictError,
        );
        const repaired = store.install(input, {
          kind: 'in-memory',
          label: 'replacement-source-must-not-win',
        });
        expect(repaired.digest).toBe(installed.digest);
        expect(repaired.source).toEqual(originalSource);
        expect(readFileSync(packageFile, 'utf8')).toBe(expectedPackageBytes);

        const reopened = createStore({ rootDir: root });
        expect(reopened.show('community/example').digest).toBe(
          installed.digest,
        );
        expect(reopened.verify('community/example').valid).toBe(true);
        expect(reopened.show('community/example').source).toEqual(
          originalSource,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('validates and captures plugin version before filesystem side effects', () => {
    const root = tempRoot();
    rmSync(root, { recursive: true, force: true });
    try {
      expect(
        () =>
          new MarketplaceStore({
            pluginVersion: 'not-a-version',
            rootDir: root,
          }),
      ).toThrow(MarketplaceValidationError);
      expect(existsSync(root)).toBe(false);

      const store = createStore({ rootDir: root });
      expect(store.install(bundle()).manifest.version).toBe('1.0.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects incompatible installs before creating the store root', () => {
    const root = tempRoot();
    rmSync(root, { recursive: true, force: true });
    try {
      const store = createStore({ rootDir: root, pluginVersion: '2.0.0' });
      expect(() => store.install(bundle())).toThrow(
        MarketplaceCompatibilityError,
      );
      expect(existsSync(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('allows reads and committed removal after a plugin downgrade', () => {
    const root = tempRoot();
    try {
      createStore({ rootDir: root }).install(bundle());
      const downgraded = createStore({ rootDir: root, pluginVersion: '2.0.0' });
      expect(downgraded.show('community/example').manifest.version).toBe(
        '1.0.0',
      );
      expect(downgraded.verify('community/example').valid).toBe(true);
      expect(() => downgraded.update(bundle('2.0.0'))).toThrow(
        MarketplaceCompatibilityError,
      );
      expect(() => downgraded.remove('community/example')).not.toThrow();
      expect(downgraded.getLockfile().packages).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('installs, verifies, and lists an immutable exact version', () => {
    const root = tempRoot();
    try {
      const store = createStore({ rootDir: root });
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
      const store = createStore({ rootDir: root });
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
      const store = createStore({ rootDir: root });
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
      const store = createStore({ rootDir: root });
      store.install(bundle());
      rmSync(store.paths.lockfilePath);
      mkdirSync(store.paths.lockfilePath);
      let readError: unknown;
      try {
        store.getLockfile();
      } catch (error) {
        readError = error;
      }
      expect(readError).not.toBeInstanceOf(MarketplaceLockfileError);
      expect((readError as NodeJS.ErrnoException).code).toBe('EISDIR');
      const inspection = store.inspectAll();
      expect(inspection.lockfileError).toBeUndefined();
      expect(inspection.operationalError).toMatch(/EISDIR|directory/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('inspectAll classifies invalid lockfiles as lockfile errors', () => {
    const root = tempRoot();
    try {
      const store = createStore({ rootDir: root });
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
      const store = createStore({ rootDir: root });
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
      const store = createStore({ rootDir: root });
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
      const store = createStore({ rootDir: root });
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

  test.each(['identity', 'schema', 'digest', 'sidecar'])(
    'detects %s tampering through the lock-authoritative integrity check',
    (tampering) => {
      const root = tempRoot();
      try {
        const store = createStore({ rootDir: root });
        const installed = store.install(bundle());
        const packageFile = join(installed.path, 'package.json');
        if (tampering === 'identity' || tampering === 'schema') {
          const storedBundle = JSON.parse(
            readFileSync(packageFile, 'utf8'),
          ) as MarketplacePackageBundle;
          if (tampering === 'identity') {
            storedBundle.manifest.id = 'community/other';
          } else {
            storedBundle.manifest.schemaVersion = 3;
          }
          writeFileSync(packageFile, JSON.stringify(storedBundle));
        } else if (tampering === 'sidecar') {
          writeFileSync(join(installed.path, 'sha256'), `${'0'.repeat(64)}\n`);
        } else {
          const lockfile = JSON.parse(
            readFileSync(store.paths.lockfilePath, 'utf8'),
          ) as {
            packages: Record<string, { digest: { value: string } }>;
          };
          lockfile.packages['community/example'].digest.value = '0'.repeat(64);
          writeFileSync(store.paths.lockfilePath, JSON.stringify(lockfile));
        }

        const reopened = createStore({ rootDir: root });
        expect(reopened.verify('community/example').valid).toBe(false);
        expect(() => reopened.show('community/example')).toThrow(
          MarketplaceIntegrityError,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('removes packages with corrupt or missing selected payloads', () => {
    for (const damagedPayload of ['corrupt', 'missing'] as const) {
      const root = tempRoot();
      try {
        const store = createStore({ rootDir: root });
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
      const store = createStore({ rootDir: root });
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

  test('restores a selected version moved to repair staging before publication', () => {
    const root = tempRoot();
    try {
      const store = createStore({ rootDir: root });
      const installed = store.install(bundle());
      const backup = join(
        store.paths.stagingDir,
        'repair',
        'community',
        'example',
        '1.0.0',
        'interrupted-repair',
      );
      mkdirSync(join(backup, '..'), { recursive: true });
      renameSync(installed.path, backup);
      expect(store.show('community/example').digest).toBe(installed.digest);
      expect(existsSync(installed.path)).toBe(true);
      expect(existsSync(backup)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps restored damaged bytes available for exact locked repair', () => {
    const root = tempRoot();
    try {
      const store = createStore({ rootDir: root });
      const original = bundle();
      const installed = store.install(original);
      const backup = join(
        store.paths.stagingDir,
        'repair',
        'community',
        'example',
        '1.0.0',
        'interrupted-repair',
      );
      writeFileSync(join(installed.path, 'package.json'), '{broken');
      mkdirSync(join(backup, '..'), { recursive: true });
      renameSync(installed.path, backup);
      expect(() => store.show('community/example')).toThrow(
        MarketplaceIntegrityError,
      );
      expect(existsSync(installed.path)).toBe(true);
      expect(store.install(original).digest).toBe(installed.digest);
      expect(store.verify('community/example').valid).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cleans obsolete repair backups only after verifying the selected path', () => {
    for (const committedUpdate of [false, true]) {
      const root = tempRoot();
      try {
        const store = createStore({ rootDir: root });
        const installed = store.install(bundle());
        const backup = join(
          store.paths.stagingDir,
          'repair',
          'community',
          'example',
          '1.0.0',
          'interrupted-repair',
        );
        if (committedUpdate) store.update(bundle('2.0.0'));
        else {
          mkdirSync(join(backup, '..'), { recursive: true });
          renameSync(installed.path, backup);
          cpSync(backup, installed.path, { recursive: true });
        }
        if (committedUpdate) {
          mkdirSync(backup, { recursive: true });
          writeFileSync(join(backup, 'package.json'), '{old damaged bytes');
        }
        expect(store.show('community/example').manifest.version).toBe(
          committedUpdate ? '2.0.0' : '1.0.0',
        );
        expect(existsSync(backup)).toBe(false);
        expect(existsSync(installed.path)).toBe(!committedUpdate);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test.each(['corrupt', 'missing', 'unreadable'] as const)(
    'keeps unrelated loads and exact repair available when selected version is %s',
    (damage) => {
      const {
        root,
        store,
        olderVersionPath,
        oldPackageBytes,
        oldSidecarBytes,
      } = createStoreWithInterruptedUpdate(damage);
      try {
        let loadError: unknown;
        try {
          store.show('community/example');
        } catch (error) {
          loadError = error;
        }
        expect(loadError).toBeDefined();
        if (damage === 'unreadable') {
          expect((loadError as NodeJS.ErrnoException).code).toBe('EISDIR');
        } else {
          expect(loadError).toBeInstanceOf(MarketplaceIntegrityError);
        }
        const unrelated = store.loadSelected(['community/other']);
        expect(unrelated.errors.size).toBe(0);
        expect(unrelated.packages.get('community/other')?.manifest.id).toBe(
          'community/other',
        );
        expect(existsSync(olderVersionPath)).toBe(true);
        expect(readFileSync(join(olderVersionPath, 'package.json'))).toEqual(
          oldPackageBytes,
        );
        expect(readFileSync(join(olderVersionPath, 'sha256'))).toEqual(
          oldSidecarBytes,
        );

        const repaired = store.install(bundle('2.0.0'));
        expect(repaired.manifest.version).toBe('2.0.0');
        expect(store.show('community/example').digest).toBe(repaired.digest);
        expect(existsSync(olderVersionPath)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.each(['corrupt', 'missing', 'unreadable'] as const)(
    'allows removal when selected version is %s and preserves old bytes until removal',
    (damage) => {
      const {
        root,
        store,
        olderVersionPath,
        oldPackageBytes,
        oldSidecarBytes,
      } = createStoreWithInterruptedUpdate(damage);
      try {
        expect(() => store.show('community/example')).toThrow();
        expect(existsSync(olderVersionPath)).toBe(true);
        expect(readFileSync(join(olderVersionPath, 'package.json'))).toEqual(
          oldPackageBytes,
        );
        expect(readFileSync(join(olderVersionPath, 'sha256'))).toEqual(
          oldSidecarBytes,
        );

        store.remove('community/example');
        expect(
          store.getLockfile().packages['community/example'],
        ).toBeUndefined();
        expect(existsSync(olderVersionPath)).toBe(false);
        expect(store.show('community/other').manifest.id).toBe(
          'community/other',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('cleans an older committed version after verifying the selected package', () => {
    const root = tempRoot();
    try {
      const store = createStore({ rootDir: root });
      const v1 = store.install(bundle('1.0.0'));
      const oldPackageBytes = readFileSync(join(v1.path, 'package.json'));
      const oldSidecarBytes = readFileSync(join(v1.path, 'sha256'));
      const v2 = store.update(bundle('2.0.0'));
      mkdirSync(v1.path, { recursive: true });
      writeFileSync(join(v1.path, 'package.json'), oldPackageBytes);
      writeFileSync(join(v1.path, 'sha256'), oldSidecarBytes);

      expect(store.show('community/example').path).toBe(v2.path);
      expect(existsSync(v1.path)).toBe(false);
      expect(store.verify('community/example').valid).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(['corrupt', 'unreadable'])(
    'preserves older repair backup when newer selected payload is %s',
    (damage) => {
      const root = tempRoot();
      try {
        const store = createStore({ rootDir: root });
        store.install(bundle());
        store.update(bundle('2.0.0'));
        const backup = join(
          store.paths.stagingDir,
          'repair',
          'community',
          'example',
          '1.0.0',
          'interrupted-repair',
        );
        mkdirSync(backup, { recursive: true });
        writeFileSync(join(backup, 'package.json'), '{prior locked bytes');
        const selectedManifest = join(
          store.paths.packagesDir,
          'community',
          'example',
          '2.0.0',
          'package.json',
        );
        if (damage === 'corrupt') {
          writeFileSync(selectedManifest, '{corrupt selected version');
        } else {
          rmSync(selectedManifest);
          mkdirSync(selectedManifest);
        }

        expect(() => store.show('community/example')).toThrow();
        expect(existsSync(backup)).toBe(true);
        expect(readFileSync(join(backup, 'package.json'), 'utf8')).toBe(
          '{prior locked bytes',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.each(['older-repair', 'selected-repair', 'removal'] as const)(
    'keeps %s recovery data while selected package is unreadable and permits recovery',
    (quarantineKind) => {
      const root = tempRoot();
      const recoveryBytes = Buffer.from('preserved recovery package bytes');
      try {
        const store = createStore({ rootDir: root });
        store.install(bundle('1.0.0'));
        store.update(bundle('2.0.0'));
        store.install(
          bundle('1.0.0', {
            id: 'community/other',
            agentName: 'other',
          }),
        );
        const selectedManifest = join(
          store.paths.packagesDir,
          'community',
          'example',
          '2.0.0',
          'package.json',
        );
        rmSync(selectedManifest);
        mkdirSync(selectedManifest);

        let recoveryPath: string;
        if (quarantineKind === 'removal') {
          recoveryPath = join(
            store.paths.stagingDir,
            'removed',
            'community',
            'example',
            'interrupted-remove',
            'package-copy',
          );
        } else {
          recoveryPath = join(
            store.paths.stagingDir,
            'repair',
            'community',
            'example',
            quarantineKind === 'older-repair' ? '1.0.0' : '2.0.0',
            'interrupted-repair',
          );
        }
        mkdirSync(recoveryPath, { recursive: true });
        writeFileSync(join(recoveryPath, 'package.json'), recoveryBytes);

        expect(() => store.show('community/example')).toThrow(
          expect.objectContaining({ code: 'EISDIR' }),
        );
        const unrelated = store.loadSelected(['community/other']);
        expect(unrelated.errors.size).toBe(0);
        expect(unrelated.packages.get('community/other')?.manifest.id).toBe(
          'community/other',
        );
        expect(readFileSync(join(recoveryPath, 'package.json'))).toEqual(
          recoveryBytes,
        );

        if (quarantineKind === 'removal') {
          store.remove('community/example');
          expect(
            store.getLockfile().packages['community/example'],
          ).toBeUndefined();
          store.show('community/other');
        } else {
          store.install(bundle('2.0.0'));
          expect(store.show('community/example').manifest.version).toBe(
            '2.0.0',
          );
        }
        expect(existsSync(recoveryPath)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('preserves both copies when a published repair fails lockfile verification', () => {
    const root = tempRoot();
    try {
      const store = createStore({ rootDir: root });
      const installed = store.install(bundle());
      const backup = join(
        store.paths.stagingDir,
        'repair',
        'community',
        'example',
        '1.0.0',
        'interrupted-repair',
      );
      mkdirSync(join(backup, '..'), { recursive: true });
      renameSync(installed.path, backup);
      mkdirSync(installed.path, { recursive: true });
      writeFileSync(
        join(installed.path, 'package.json'),
        '{invalid replacement',
      );
      expect(() => store.list()).toThrow(MarketplaceIntegrityError);
      expect(existsSync(backup)).toBe(true);
      expect(readFileSync(join(installed.path, 'package.json'), 'utf8')).toBe(
        '{invalid replacement',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(['update', 'repair'])(
    'does not roll back committed %s when quarantine cleanup fails',
    (operation) => {
      const root = tempRoot();
      try {
        const store = createStore({ rootDir: root });
        const initial = store.install(bundle());
        const oldVersionPath = initial.path;
        if (operation === 'repair') {
          writeFileSync(join(initial.path, 'package.json'), '{damaged');
        }
        const originalRm = fsModule.rmSync;
        const remove = spyOn(fsModule, 'rmSync').mockImplementation(
          (target, options) => {
            if (String(target).includes('/.staging/repair/')) {
              throw new Error('injected repair cleanup failure');
            }
            if (operation === 'update' && String(target) === oldVersionPath) {
              throw new Error('injected update cleanup failure');
            }
            return originalRm(target, options);
          },
        );
        let installed: ReturnType<typeof store.install>;
        try {
          installed =
            operation === 'update'
              ? store.update(bundle('2.0.0'))
              : store.install(bundle());
        } finally {
          remove.mockRestore();
        }

        const reopened = createStore({ rootDir: root });
        expect(reopened.show('community/example').digest).toBe(
          installed.digest,
        );
        expect(existsSync(installed.path)).toBe(true);
        if (operation === 'update') {
          expect(
            reopened.getLockfile().packages['community/example']
              ?.manifestVersion,
          ).toBe('2.0.0');
          expect(existsSync(oldVersionPath)).toBe(false);
        } else {
          expect(
            existsSync(
              join(
                store.paths.stagingDir,
                'repair',
                'community',
                'example',
                '1.0.0',
              ),
            ),
          ).toBe(false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.each(['publication', 'lockfile'])(
    'rolls back a damaged selected version on %s failure',
    (failure) => {
      const root = tempRoot();
      try {
        const store = createStore({ rootDir: root });
        const original = bundle();
        const installed = store.install(original);
        writeFileSync(join(installed.path, 'package.json'), '{original damage');
        const originalRename = fsModule.renameSync;
        let failed = false;
        const rename = spyOn(fsModule, 'renameSync').mockImplementation(
          (source, destination) => {
            if (
              !failed &&
              destination ===
                (failure === 'publication'
                  ? installed.path
                  : store.paths.lockfilePath)
            ) {
              failed = true;
              throw new Error(`injected ${failure} failure`);
            }
            return originalRename(source, destination);
          },
        );
        try {
          expect(() => store.install(original)).toThrow(
            `injected ${failure} failure`,
          );
        } finally {
          rename.mockRestore();
        }
        expect(readFileSync(join(installed.path, 'package.json'), 'utf8')).toBe(
          '{original damage',
        );
        expect(
          store.getLockfile().packages['community/example']?.digest.value,
        ).toBe(installed.digest);
        expect(store.install(original).digest).toBe(installed.digest);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.each(['install', 'update'])(
    'restores prior on-disk %s state after package or lockfile publication fails',
    (mode) => {
      for (const failure of ['package', 'lockfile'] as const) {
        const root = tempRoot();
        try {
          const store = createStore({ rootDir: root });
          const original =
            mode === 'update' ? store.install(bundle()) : undefined;
          const lockfileBefore = existsSync(store.paths.lockfilePath)
            ? readFileSync(store.paths.lockfilePath)
            : undefined;
          const packageBefore = original
            ? readFileSync(join(original.path, 'package.json'))
            : undefined;
          const nextBundle = bundle(mode === 'update' ? '2.0.0' : '1.0.0');
          const nextPath = join(
            store.paths.packagesDir,
            'community',
            'example',
            nextBundle.manifest.version,
          );
          const originalRename = fsModule.renameSync;
          let injected = false;
          const rename = spyOn(fsModule, 'renameSync').mockImplementation(
            (source, destination) => {
              const shouldFail =
                failure === 'package'
                  ? destination === nextPath
                  : destination === store.paths.lockfilePath;
              if (!injected && shouldFail) {
                injected = true;
                throw new Error(
                  `injected ${mode} ${failure} publication failure`,
                );
              }
              return originalRename(source, destination);
            },
          );
          try {
            expect(() =>
              mode === 'update'
                ? store.update(nextBundle)
                : store.install(nextBundle),
            ).toThrow(`injected ${mode} ${failure} publication failure`);
          } finally {
            rename.mockRestore();
          }

          const reopened = createStore({ rootDir: root });
          expect(existsSync(store.paths.lockfilePath)).toBe(
            lockfileBefore !== undefined,
          );
          if (lockfileBefore) {
            expect(readFileSync(store.paths.lockfilePath)).toEqual(
              lockfileBefore,
            );
          }
          expect(
            reopened.getLockfile().packages['community/example']
              ?.manifestVersion,
          ).toBe(mode === 'update' ? '1.0.0' : undefined);
          expect(existsSync(nextPath)).toBe(false);
          if (original && packageBefore) {
            expect(readFileSync(join(original.path, 'package.json'))).toEqual(
              packageBefore,
            );
            expect(reopened.show('community/example').digest).toBe(
              original.digest,
            );
          } else {
            expect(reopened.getLockfile().packages).toEqual({});
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );

  test('does not overwrite a corrupt lockfile', () => {
    const root = tempRoot();
    try {
      const store = createStore({ rootDir: root });
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
      const store = createStore({
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
      const store = createStore({
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
    const store = createStore({
      rootDir: root,
      lock: { staleMs: 500, timeoutMs: 30, retryMs: 1 },
    });
    const worker = Bun.spawn(
      [
        'bun',
        '-e',
        `import { writeFileSync } from 'node:fs';
import { acquireMarketplaceLease } from './src/marketplace/lease.ts';
const { paths, readyPath } = JSON.parse(process.argv[1]);
acquireMarketplaceLease(paths, { staleMs: 500, timeoutMs: 5000 });
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
      expect(() => store.install(bundle())).toThrow(MarketplaceBusyError);
      worker.kill();
      await worker.exited;
      await Bun.sleep(700);
      expect(store.list()).toEqual([]);
      expect(store.install(bundle()).manifest.id).toBe('community/example');
    } finally {
      worker.kill();
      await worker.exited.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retains both lock entries for concurrent installs of different IDs', async () => {
    const root = tempRoot();
    const store = createStore({ rootDir: root });
    const inputs = [
      bundle('1.0.0', { id: 'community/first', agentName: 'first' }),
      bundle('1.0.0', { id: 'community/second', agentName: 'second' }),
    ];
    const workers = inputs.map((input) =>
      Bun.spawn(
        [
          'bun',
          '-e',
          `import { MarketplaceStore } from './src/marketplace/store.ts';
const { rootDir, input } = JSON.parse(process.argv[1]);
new MarketplaceStore({ rootDir, pluginVersion: '3.2.0' }).install(input);`,
          JSON.stringify({ rootDir: root, input }),
        ],
        { stdout: 'ignore', stderr: 'pipe' },
      ),
    );
    try {
      const results = await Promise.all(
        workers.map(async (worker) => ({
          exitCode: await worker.exited,
          stderr: await new Response(worker.stderr).text(),
        })),
      );
      expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
      expect(results.map((result) => result.stderr).join('')).toBe('');
      expect(Object.keys(store.getLockfile().packages).sort()).toEqual([
        'community/first',
        'community/second',
      ]);
    } finally {
      for (const worker of workers) worker.kill();
      await Promise.all(workers.map((worker) => worker.exited.catch(() => -1)));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('serializes simultaneous stale reclaimers across generations', async () => {
    const root = tempRoot();
    const store = createStore({
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
const lease = acquireMarketplaceLease(paths, { staleMs: 1000, timeoutMs: 2000, retryMs: 5 });
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
    const store = createStore({
      rootDir: root,
      lock: { staleMs: 1_000, timeoutMs: 1000, retryMs: 10 },
    });
    let owner: ReturnType<typeof acquireMarketplaceLease> | undefined;
    try {
      owner = acquireMarketplaceLease(store.paths, {
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
        acquireMarketplaceLease(store.paths, {
          staleMs: 1_000,
          timeoutMs: 120,
          retryMs: 10,
        }),
      ).toThrow(MarketplaceBusyError);
      expect(() => owner.assertCurrent()).not.toThrow();
    } finally {
      owner?.release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(['install', 'update', 'remove'])(
    'retains and retries lease cleanup after committed %s',
    (operation) => {
      const root = tempRoot();
      try {
        const store = createStore({ rootDir: root });
        if (operation !== 'install') store.install(bundle());
        const originalUnlink = fsModule.unlinkSync;
        let failFirstUnlink = true;
        const unlink = spyOn(fsModule, 'unlinkSync').mockImplementation(
          (target) => {
            if (failFirstUnlink) {
              failFirstUnlink = false;
              throw new Error('injected lease unlink failure');
            }
            return originalUnlink(target);
          },
        );
        try {
          expect(() => {
            if (operation === 'install') store.install(bundle());
            else if (operation === 'update') store.update(bundle('2.0.0'));
            else store.remove('community/example');
          }).toThrow('injected lease unlink failure');
        } finally {
          unlink.mockRestore();
        }

        expect(() =>
          store.install(
            bundle('1.0.0', {
              id: 'community/recovered',
              agentName: 'recovered',
            }),
          ),
        ).not.toThrow();
        expect(store.show('community/recovered').manifest.id).toBe(
          'community/recovered',
        );

        const reopened = createStore({ rootDir: root });
        if (operation === 'remove') {
          expect(reopened.getLockfile().packages).toEqual({
            'community/recovered': expect.any(Object),
          });
          expect(
            reopened.getLockfile().packages['community/example'],
          ).toBeUndefined();
        } else {
          expect(reopened.show('community/example').manifest.version).toBe(
            operation === 'update' ? '2.0.0' : '1.0.0',
          );
          expect(reopened.show('community/recovered').manifest.id).toBe(
            'community/recovered',
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('preserves the precommit operation error if lease release also fails', () => {
    const root = tempRoot();
    try {
      const store = createStore({ rootDir: root });
      const originalRename = fsModule.renameSync;
      const originalUnlink = fsModule.unlinkSync;
      let failUnlink = true;
      let failedLeaseUnlink = false;
      const rename = spyOn(fsModule, 'renameSync').mockImplementation(
        (source, destination) => {
          if (destination === store.paths.lockfilePath) {
            throw new Error('primary lock publication failure');
          }
          return originalRename(source, destination);
        },
      );
      const unlink = spyOn(fsModule, 'unlinkSync').mockImplementation(
        (target) => {
          if (failUnlink && String(target).endsWith('.lease')) {
            failUnlink = false;
            failedLeaseUnlink = true;
            throw new Error('secondary lease unlink failure');
          }
          return originalUnlink(target);
        },
      );
      try {
        expect(() => store.install(bundle())).toThrow(
          'primary lock publication failure',
        );
      } finally {
        rename.mockRestore();
        unlink.mockRestore();
      }
      expect(failedLeaseUnlink).toBe(true);
      expect(store.getLockfile().packages).toEqual({});
      expect(store.install(bundle()).manifest.version).toBe('1.0.0');
      expect(
        createStore({ rootDir: root }).show('community/example').manifest
          .version,
      ).toBe('1.0.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retains uncertain lease ownership when unlink and lstat temporarily fail', () => {
    const root = tempRoot();
    try {
      const store = createStore({
        rootDir: root,
        lock: { timeoutMs: 30, retryMs: 1 },
      });
      const originalUnlink = fsModule.unlinkSync;
      const originalLstat = fsModule.lstatSync;
      let blockedLeasePath: string | undefined;
      let unlinkFailed = false;
      let lstatFailed = false;
      const unlink = spyOn(fsModule, 'unlinkSync').mockImplementation(
        (target) => {
          if (String(target).endsWith('.lease')) {
            blockedLeasePath = String(target);
            unlinkFailed = true;
            throw Object.assign(new Error('temporary lease unlink failure'), {
              code: 'EACCES',
            });
          }
          return originalUnlink(target);
        },
      );
      const lstat = spyOn(fsModule, 'lstatSync').mockImplementation(
        (target, options) => {
          if (target === blockedLeasePath) {
            lstatFailed = true;
            throw Object.assign(new Error('temporary lease stat failure'), {
              code: 'EIO',
            });
          }
          return originalLstat(target, options);
        },
      );
      try {
        expect(() => store.install(bundle())).toThrow();
      } finally {
        lstat.mockRestore();
        unlink.mockRestore();
      }
      expect(unlinkFailed).toBe(true);
      expect(lstatFailed).toBe(true);

      expect(store.list().map((pkg) => pkg.manifest.id)).toEqual([
        'community/example',
      ]);
      expect(
        createStore({ rootDir: root }).show('community/example').manifest.id,
      ).toBe('community/example');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps the previous lifecycle state when lockfile publication fails', () => {
    const root = tempRoot();
    try {
      const store = createStore({ rootDir: root });
      const originalRename = fsModule.renameSync;
      const rename = spyOn(fsModule, 'renameSync').mockImplementation(
        (source, destination) => {
          if (destination === store.paths.lockfilePath) {
            throw new Error('injected lockfile rename failure');
          }
          return originalRename(source, destination);
        },
      );
      try {
        expect(() => store.install(bundle())).toThrow(
          'injected lockfile rename failure',
        );
      } finally {
        rename.mockRestore();
      }
      expect(store.getLockfile().packages).toEqual({});
      expect(store.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('restores an abandoned removal staging directory', () => {
    const root = tempRoot();
    try {
      const store = createStore({ rootDir: root });
      store.install(bundle());
      const packagePath = join(root, 'packages', 'community', 'example');
      const quarantinePath = join(
        root,
        '.staging',
        'removed',
        'community',
        'example',
        'interrupted-remove',
      );
      mkdirSync(join(root, '.staging', 'removed', 'community', 'example'), {
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
      const store = createStore({ rootDir: root });
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
      try {
        expect(() => store.remove('community/example')).toThrow(
          'injected removal lock failure',
        );
      } finally {
        rename.mockRestore();
      }
      expect(store.show('community/example').manifest.id).toBe(
        'community/example',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(['quarantine', 'lockfile'])(
    'restores exact package and lock bytes when removal %s publication fails',
    (failure) => {
      const root = tempRoot();
      try {
        const store = createStore({ rootDir: root });
        const installed = store.install(bundle());
        const packageBefore = readFileSync(
          join(installed.path, 'package.json'),
        );
        const lockfileBefore = readFileSync(store.paths.lockfilePath);
        const originalRename = fsModule.renameSync;
        const rename = spyOn(fsModule, 'renameSync').mockImplementation(
          (source, destination) => {
            const shouldFail =
              failure === 'quarantine'
                ? String(destination).startsWith(`${root}/.staging/removed/`)
                : destination === store.paths.lockfilePath;
            if (shouldFail) {
              throw new Error(
                `injected removal ${failure} publication failure`,
              );
            }
            return originalRename(source, destination);
          },
        );
        try {
          expect(() => store.remove('community/example')).toThrow(
            `injected removal ${failure} publication failure`,
          );
        } finally {
          rename.mockRestore();
        }

        const reopened = createStore({ rootDir: root });
        expect(readFileSync(store.paths.lockfilePath)).toEqual(lockfileBefore);
        expect(readFileSync(join(installed.path, 'package.json'))).toEqual(
          packageBefore,
        );
        expect(reopened.show('community/example').digest).toBe(
          installed.digest,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('reconciles a committed removal quarantine orphan', () => {
    const root = tempRoot();
    try {
      const store = createStore({ rootDir: root });
      store.install(bundle());
      const originalRemove = fsModule.rmSync;
      const remove = spyOn(fsModule, 'rmSync').mockImplementation(
        (target, options) => {
          if (String(target).startsWith(`${root}/.staging/removed/`)) {
            throw new Error('injected garbage collection failure');
          }
          return originalRemove(target, options);
        },
      );
      try {
        store.remove('community/example');
      } finally {
        remove.mockRestore();
      }
      const reopened = createStore({ rootDir: root });
      expect(reopened.getLockfile().packages).toEqual({});
      expect(reopened.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
