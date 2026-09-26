import { describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MarketplaceBusyError,
  MarketplaceLockfileError,
  MarketplaceLockOwnershipError,
  MarketplaceValidationError,
} from './errors';
import {
  acquireMarketplaceLease,
  type MarketplaceLockOptions,
  writeAtomic,
} from './lease';
import { getMarketplacePaths, type MarketplacePaths } from './paths';

const LOCK: MarketplaceLockOptions = {
  staleMs: 80,
  timeoutMs: 400,
  retryMs: 10,
};

const UUIDS = {
  first: '00000000-0000-4000-8000-000000000001',
  second: '00000000-0000-4000-8000-000000000002',
  third: '00000000-0000-4000-8000-000000000003',
};

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marketplace-lease-'));
}

function entryPath(
  lockDir: string,
  pid: number,
  uuid: string,
  kind: 'candidate' | 'lease',
): string {
  return join(lockDir, `${pid}.${uuid}.${kind}`);
}

function createEntry(
  lockDir: string,
  pid: number,
  uuid: string,
  kind: 'candidate' | 'lease',
): string {
  mkdirSync(lockDir, { recursive: true });
  const filePath = entryPath(lockDir, pid, uuid, kind);
  const fd = openSync(filePath, 'wx', 0o600);
  closeSync(fd);
  return filePath;
}

function age(filePath: string, milliseconds = 2_000): void {
  const old = new Date(Date.now() - milliseconds);
  utimesSync(filePath, old, old);
}

function lockEntries(lockDir: string): string[] {
  try {
    return readdirSync(lockDir);
  } catch {
    return [];
  }
}

function spawnWorker(
  paths: MarketplacePaths,
  body: string,
  extra: Record<string, string> = {},
): Bun.Subprocess {
  return Bun.spawn(
    [
      'bun',
      '-e',
      `import { acquireMarketplaceLease } from './src/marketplace/lease.ts';
${body}`,
      JSON.stringify({ paths, ...extra }),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
}

async function workerResult(worker: Bun.Subprocess): Promise<{
  code: number;
  stderr: string;
}> {
  const [stderr, code] = await Promise.all([
    new Response(worker.stderr).text(),
    worker.exited,
  ]);
  return { code, stderr };
}

function withKillError<T>(pid: number, code: string, operation: () => T): T {
  const originalKill = process.kill;
  const kill = spyOn(process, 'kill').mockImplementation(((target, signal) => {
    if (target === pid && signal === 0) {
      throw Object.assign(new Error(`injected ${code}`), { code });
    }
    return originalKill(target, signal);
  }) as typeof process.kill);
  try {
    return operation();
  } finally {
    kill.mockRestore();
  }
}

function exitedPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore',
  });
  if (child.error) throw child.error;
  if (child.status !== 0 || child.pid === undefined) {
    throw new Error('Could not start and reap dead-owner test process');
  }
  return child.pid;
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (existsSync(filePath)) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForAcquiredWorker(
  barrierDir: string,
  workerIDs: readonly string[],
  completed: ReadonlySet<string>,
): Promise<string> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    for (const id of workerIDs) {
      if (completed.has(id)) continue;
      const failurePath = join(barrierDir, `failed-${id}`);
      if (existsSync(failurePath)) {
        throw new Error(readFileSync(failurePath, 'utf8'));
      }
      if (existsSync(join(barrierDir, `acquired-${id}`))) return id;
    }
    await Bun.sleep(5);
  }
  throw new Error('Timed out waiting for a reclaimer to acquire the lease');
}

describe('marketplace synchronous lease lifecycle', () => {
  test('derives the marketplace layout below the configured root', () => {
    const paths = getMarketplacePaths('/tmp/marketplace-layout');
    expect(paths).toEqual({
      rootDir: '/tmp/marketplace-layout',
      packagesDir: '/tmp/marketplace-layout/packages',
      lockfilePath: '/tmp/marketplace-layout/lock.json',
      lockDir: '/tmp/marketplace-layout/marketplace.lock',
      stagingDir: '/tmp/marketplace-layout/.staging',
    });
  });

  test('uses only a trimmed absolute XDG data home and restores environment', () => {
    const originalXdgDataHome = process.env.XDG_DATA_HOME;
    const fallback = join(homedir(), '.local', 'share');
    const absoluteXdg = join(tmpdir(), 'marketplace-xdg');
    const marketplaceSuffix = join(
      'opencode',
      'storage',
      'oh-my-opencode-slim',
      'marketplace',
    );
    try {
      process.env.XDG_DATA_HOME = `  ${absoluteXdg}  `;
      expect(getMarketplacePaths().rootDir).toBe(
        join(absoluteXdg, marketplaceSuffix),
      );

      process.env.XDG_DATA_HOME = '   ';
      expect(getMarketplacePaths().rootDir).toBe(
        join(fallback, marketplaceSuffix),
      );

      process.env.XDG_DATA_HOME = 'relative/xdg';
      expect(getMarketplacePaths().rootDir).toBe(
        join(fallback, marketplaceSuffix),
      );

      const absoluteXdgWithoutWhitespace = join(tmpdir(), 'absolute-xdg');
      process.env.XDG_DATA_HOME = absoluteXdgWithoutWhitespace;
      expect(getMarketplacePaths().rootDir).toBe(
        join(absoluteXdgWithoutWhitespace, marketplaceSuffix),
      );
      expect(getMarketplacePaths('explicit/root').rootDir).toBe(
        'explicit/root',
      );
    } finally {
      if (originalXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = originalXdgDataHome;
      }
    }
  });

  test('atomically replaces files and removes temporary files after failures', () => {
    const root = tempRoot();
    const target = join(root, 'nested', 'state.json');
    try {
      writeAtomic(target, '{"value":1}');
      expect(readFileSync(target, 'utf8')).toBe('{"value":1}');
      expect(readdirSync(join(root, 'nested'))).toEqual(['state.json']);

      const rename = spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('injected rename failure');
      });
      try {
        expect(() => writeAtomic(target, '{"value":2}')).toThrow(
          'injected rename failure',
        );
      } finally {
        rename.mockRestore();
      }
      expect(readFileSync(target, 'utf8')).toBe('{"value":1}');
      expect(readdirSync(join(root, 'nested'))).toEqual(['state.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('validates lock timing options before touching storage', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const owner = acquireMarketplaceLease(paths, {
        staleMs: 10,
        timeoutMs: 50,
        retryMs: 1,
      });
      owner.release();

      for (const options of [
        { staleMs: 0 },
        { staleMs: Number.NaN },
        { staleMs: Number.POSITIVE_INFINITY },
        { timeoutMs: -1 },
        { timeoutMs: Number.NaN },
        { retryMs: 0 },
        { retryMs: Number.POSITIVE_INFINITY },
      ]) {
        expect(() => acquireMarketplaceLease(paths, options)).toThrow(
          MarketplaceValidationError,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('acquires, commits, and releases one empty regular lease file', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const lease = acquireMarketplaceLease(paths, LOCK);
      const entries = lockEntries(paths.lockDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(/^[1-9][0-9]*\.[0-9a-f-]+\.lease$/);
      const stat = lstatSync(join(paths.lockDir, entries[0]));
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBe(0);
      expect(() => lease.assertCurrent()).not.toThrow();
      expect(lease.commit(() => 'done')).toBe('done');
      lease.release();
      expect(lockEntries(paths.lockDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('operation failure preserves ownership for release', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const lease = acquireMarketplaceLease(paths, LOCK);
      expect(() =>
        lease.commit(() => {
          throw new Error('operation failed');
        }),
      ).toThrow('operation failed');
      expect(() => lease.assertCurrent()).not.toThrow();
      expect(() => lease.release()).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('released leases cannot be used again', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const lease = acquireMarketplaceLease(paths, LOCK);
      lease.release();
      expect(() => lease.assertCurrent()).toThrow(
        MarketplaceLockOwnershipError,
      );
      expect(() => lease.commit(() => undefined)).toThrow(
        MarketplaceLockOwnershipError,
      );
      expect(() => lease.release()).toThrow(MarketplaceLockOwnershipError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a live stale owner blocks acquisition indefinitely until release', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const owner = acquireMarketplaceLease(paths, LOCK);
      const leasePath = join(paths.lockDir, lockEntries(paths.lockDir)[0]);
      age(leasePath);
      expect(() =>
        acquireMarketplaceLease(paths, { ...LOCK, timeoutMs: 120 }),
      ).toThrow(MarketplaceBusyError);
      expect(() => owner.assertCurrent()).not.toThrow();
      owner.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reclaims an aged lease after its known owner has exited', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const deadPid = exitedPid();
      const stale = createEntry(paths.lockDir, deadPid, UUIDS.first, 'lease');
      age(stale);

      const owner = acquireMarketplaceLease(paths, LOCK);
      expect(existsSync(stale)).toBe(false);
      owner.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('EPERM while probing a stale owner never permits takeover', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const stale = createEntry(
        paths.lockDir,
        process.pid,
        UUIDS.first,
        'lease',
      );
      age(stale);
      expect(() =>
        withKillError(process.pid, 'EPERM', () =>
          acquireMarketplaceLease(paths, { ...LOCK, timeoutMs: 80 }),
        ),
      ).toThrow(MarketplaceBusyError);
      expect(existsSync(stale)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('aged candidates are reclaimed regardless of PID', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const candidate = createEntry(
        paths.lockDir,
        process.pid,
        UUIDS.first,
        'candidate',
      );
      age(candidate);
      const owner = acquireMarketplaceLease(paths, LOCK);
      expect(existsSync(candidate)).toBe(false);
      owner.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('concurrent cross-process reclaimers serialize their critical sections', async () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    const barrierDir = join(root, 'barrier');
    const goPath = join(barrierDir, 'go');
    const active = join(root, 'active');
    mkdirSync(barrierDir);
    const deadPid = exitedPid();
    const stale = createEntry(paths.lockDir, deadPid, UUIDS.first, 'lease');
    age(stale);
    const workerIDs = ['one', 'two', 'three', 'four'];
    const workers = workerIDs.map((id) => ({
      id,
      process: spawnWorker(
        paths,
        `const { paths, barrierDir, goPath, active, id } = JSON.parse(process.argv[1]);
const fs = await import('node:fs');
const marker = (name) => barrierDir + '/' + name + '-' + id;
fs.writeFileSync(marker('ready'), 'ready');
while (!fs.existsSync(goPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
fs.writeFileSync(marker('attempting'), 'attempting');
let lease;
let ownsActive = false;
try {
  lease = acquireMarketplaceLease(paths, { staleMs: 500, timeoutMs: 5000, retryMs: 5 });
  const fd = fs.openSync(active, 'wx');
  fs.closeSync(fd);
  ownsActive = true;
  fs.writeFileSync(marker('acquired'), 'acquired');
  while (!fs.existsSync(marker('release'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  fs.unlinkSync(active);
  ownsActive = false;
  lease.release();
  fs.writeFileSync(marker('done'), 'done');
} catch (error) {
  if (ownsActive && fs.existsSync(active)) fs.unlinkSync(active);
  lease?.release();
  fs.writeFileSync(marker('failed'), error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}`,
        { barrierDir, goPath, active, id },
      ),
    }));
    try {
      await Promise.all(
        workerIDs.map((id) => waitForFile(join(barrierDir, `ready-${id}`))),
      );
      writeFileSync(goPath, 'go');

      await Promise.all(
        workerIDs.map((id) =>
          waitForFile(join(barrierDir, `attempting-${id}`)),
        ),
      );

      const completed = new Set<string>();
      while (completed.size < workerIDs.length) {
        const acquiredID = await waitForAcquiredWorker(
          barrierDir,
          workerIDs,
          completed,
        );
        const failurePaths = workerIDs.map((id) =>
          join(barrierDir, `failed-${id}`),
        );
        expect(failurePaths.some(existsSync)).toBe(false);
        expect(existsSync(active)).toBe(true);
        writeFileSync(join(barrierDir, `release-${acquiredID}`), 'release');
        await waitForFile(join(barrierDir, `done-${acquiredID}`));
        completed.add(acquiredID);
      }

      const results = await Promise.all(
        workers.map(({ process: child }) => workerResult(child)),
      );
      expect(results.every((result) => result.code === 0)).toBe(true);
      expect(results.map((result) => result.stderr)).toEqual(['', '', '', '']);
      expect(existsSync(active)).toBe(false);
      expect(lockEntries(paths.lockDir)).toEqual([]);
    } finally {
      writeFileSync(goPath, 'go');
      for (const id of workerIDs) {
        writeFileSync(join(barrierDir, `release-${id}`), 'release');
      }
      for (const { process: child } of workers) child.kill();
      await Promise.all(
        workers.map(({ process: child }) => child.exited.catch(() => -1)),
      );
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('removes its published lease when the final lock scan fails', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    let publishedPath: string | undefined;
    let injected = false;
    const originalRename = fs.renameSync;
    const rename = spyOn(fs, 'renameSync').mockImplementation(
      (source, destination) => {
        originalRename(source, destination);
        publishedPath = String(destination);
      },
    );
    const originalLstat = fs.lstatSync;
    const lstat = spyOn(fs, 'lstatSync').mockImplementation((target) => {
      if (!injected && target === publishedPath) {
        injected = true;
        throw Object.assign(new Error('injected final scan failure'), {
          code: 'EIO',
        });
      }
      return originalLstat(target);
    });

    try {
      expect(() => acquireMarketplaceLease(paths, LOCK)).toThrow(
        MarketplaceLockfileError,
      );
    } finally {
      lstat.mockRestore();
      rename.mockRestore();
    }

    try {
      expect(injected).toBe(true);
      expect(lockEntries(paths.lockDir)).toEqual([]);
      const nextOwner = acquireMarketplaceLease(paths, LOCK);
      nextOwner.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves the scan error when cleanup of its published lease fails', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    const otherRoot = tempRoot();
    const otherPaths = getMarketplacePaths(otherRoot);
    let publishedPath: string | undefined;
    let injectedScanFailure = false;
    const originalRename = fs.renameSync;
    const rename = spyOn(fs, 'renameSync').mockImplementation(
      (source, destination) => {
        originalRename(source, destination);
        publishedPath = String(destination);
      },
    );
    const originalLstat = fs.lstatSync;
    const lstat = spyOn(fs, 'lstatSync').mockImplementation((target) => {
      if (!injectedScanFailure && target === publishedPath) {
        injectedScanFailure = true;
        throw Object.assign(new Error('injected final scan failure'), {
          code: 'EIO',
        });
      }
      return originalLstat(target);
    });
    const originalUnlink = fs.unlinkSync;
    const unlink = spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (target === publishedPath) {
        throw Object.assign(new Error('injected lease cleanup failure'), {
          code: 'EACCES',
        });
      }
      return originalUnlink(target);
    });

    let acquisitionError: unknown;
    try {
      acquireMarketplaceLease(paths, LOCK);
    } catch (error) {
      acquisitionError = error;
    } finally {
      unlink.mockRestore();
      lstat.mockRestore();
      rename.mockRestore();
    }

    try {
      if (!publishedPath) throw new Error('Lease publication was not observed');
      expect(acquisitionError).toBeInstanceOf(MarketplaceLockfileError);
      expect(acquisitionError).toHaveProperty(
        'message',
        expect.stringContaining('injected final scan failure'),
      );
      expect(injectedScanFailure).toBe(true);
      expect(existsSync(publishedPath)).toBe(true);

      const otherRootOwner = acquireMarketplaceLease(otherPaths, LOCK);
      otherRootOwner.release();
      expect(lockEntries(otherPaths.lockDir)).toEqual([]);

      const nextOwner = acquireMarketplaceLease(paths, LOCK);
      expect(lockEntries(paths.lockDir)).toHaveLength(1);
      expect(lockEntries(paths.lockDir)[0]).not.toBe(
        publishedPath.split('/').pop(),
      );
      nextOwner.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  test('released and lost leases cannot remove a successor lease', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const released = acquireMarketplaceLease(paths, LOCK);
      released.release();
      const afterRelease = acquireMarketplaceLease(paths, LOCK);
      const afterReleasePath = join(
        paths.lockDir,
        lockEntries(paths.lockDir)[0],
      );
      expect(() => released.release()).toThrow(MarketplaceLockOwnershipError);
      expect(existsSync(afterReleasePath)).toBe(true);
      afterRelease.assertCurrent();
      afterRelease.release();

      const lost = acquireMarketplaceLease(paths, LOCK);
      const lostPath = join(paths.lockDir, lockEntries(paths.lockDir)[0]);
      unlinkForTest(lostPath);
      const successor = acquireMarketplaceLease(paths, LOCK);
      const successorPath = join(paths.lockDir, lockEntries(paths.lockDir)[0]);
      expect(() => lost.release()).toThrow(MarketplaceLockOwnershipError);
      expect(existsSync(successorPath)).toBe(true);
      successor.assertCurrent();
      successor.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unlink failure leaves ownership retryable while the exact file remains', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const owner = acquireMarketplaceLease(paths, LOCK);
      const leasePath = join(paths.lockDir, lockEntries(paths.lockDir)[0]);
      const originalUnlink = fs.unlinkSync;
      let failed = false;
      const unlink = spyOn(fs, 'unlinkSync').mockImplementation((target) => {
        if (!failed && target === leasePath) {
          failed = true;
          const error = new Error('injected unlink failure') as Error & {
            code: string;
          };
          error.code = 'EACCES';
          throw error;
        }
        return originalUnlink(target);
      });
      try {
        expect(() => owner.release()).toThrow('injected unlink failure');
        expect(existsSync(leasePath)).toBe(true);
        expect(() => owner.assertCurrent()).not.toThrow();
      } finally {
        unlink.mockRestore();
      }
      owner.release();
      expect(existsSync(leasePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('inspection failures after unlink denial preserve retryable ownership', () => {
    for (const inspectionCode of ['EACCES', 'EIO']) {
      const root = tempRoot();
      const paths = getMarketplacePaths(root);
      try {
        const owner = acquireMarketplaceLease(paths, LOCK);
        const leasePath = join(paths.lockDir, lockEntries(paths.lockDir)[0]);
        const originalUnlink = fs.unlinkSync;
        const unlink = spyOn(fs, 'unlinkSync').mockImplementation((target) => {
          if (target === leasePath) {
            throw Object.assign(new Error('injected unlink denial'), {
              code: 'EACCES',
            });
          }
          return originalUnlink(target);
        });
        const originalLstat = fs.lstatSync;
        let leasePathInspections = 0;
        const lstat = spyOn(fs, 'lstatSync').mockImplementation((target) => {
          if (target === leasePath) {
            leasePathInspections += 1;
            if (leasePathInspections === 2) {
              throw Object.assign(
                new Error(`injected ${inspectionCode} inspection failure`),
                { code: inspectionCode },
              );
            }
          }
          return originalLstat(target);
        });

        try {
          expect(() => owner.release()).toThrow('injected unlink denial');
          expect(leasePathInspections).toBe(2);
        } finally {
          lstat.mockRestore();
          unlink.mockRestore();
        }

        expect(() => owner.assertCurrent()).not.toThrow();
        owner.release();
        expect(lockEntries(paths.lockDir)).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('malformed, unknown, directory, and symlink state fails closed', () => {
    const cases = [
      (lockDir: string) => writeFileSync(join(lockDir, 'unknown'), ''),
      (lockDir: string) => mkdirSync(join(lockDir, `1.${UUIDS.first}.lease`)),
      (lockDir: string) =>
        writeFileSync(
          createEntry(lockDir, process.pid, UUIDS.third, 'lease'),
          'not empty',
        ),
      (lockDir: string) => {
        const target = createEntry(lockDir, process.pid, UUIDS.second, 'lease');
        rmSync(target);
        symlinkSync('/tmp', target);
      },
    ];
    for (const setup of cases) {
      const root = tempRoot();
      const paths = getMarketplacePaths(root);
      try {
        mkdirSync(paths.lockDir, { recursive: true });
        setup(paths.lockDir);
        expect(() => acquireMarketplaceLease(paths, LOCK)).toThrow(
          MarketplaceLockfileError,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('restarts a directory snapshot when a listed entry disappears', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    let injected = false;
    try {
      acquireMarketplaceLease(paths, LOCK);
      const originalLstat = fs.lstatSync;
      const leasePath = join(paths.lockDir, lockEntries(paths.lockDir)[0]);
      const replacementPath = entryPath(
        paths.lockDir,
        process.pid,
        UUIDS.third,
        'lease',
      );
      const lstat = spyOn(fs, 'lstatSync').mockImplementation((target) => {
        if (!injected && target === leasePath) {
          injected = true;
          fs.unlinkSync(leasePath);
          createEntry(paths.lockDir, process.pid, UUIDS.third, 'lease');
          throw Object.assign(new Error('entry disappeared'), {
            code: 'ENOENT',
          });
        }
        return originalLstat(target);
      });
      try {
        expect(() =>
          acquireMarketplaceLease(paths, {
            ...LOCK,
            timeoutMs: 80,
          }),
        ).toThrow(MarketplaceBusyError);
        expect(injected).toBe(true);
        expect(existsSync(replacementPath)).toBe(true);
      } finally {
        lstat.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('propagates non-ENOENT snapshot errors fail closed', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const entry = createEntry(
        paths.lockDir,
        process.pid,
        UUIDS.first,
        'lease',
      );
      const originalLstat = fs.lstatSync;
      const lstat = spyOn(fs, 'lstatSync').mockImplementation((target) => {
        if (target === entry) {
          throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
        }
        return originalLstat(target);
      });
      try {
        expect(() => acquireMarketplaceLease(paths, LOCK)).toThrow(
          MarketplaceLockfileError,
        );
      } finally {
        lstat.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('times out without mutating a live owner', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const owner = acquireMarketplaceLease(paths, LOCK);
      expect(() =>
        acquireMarketplaceLease(paths, { ...LOCK, timeoutMs: 60 }),
      ).toThrow(MarketplaceBusyError);
      expect(lockEntries(paths.lockDir)).toHaveLength(1);
      owner.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function unlinkForTest(filePath: string): void {
  fs.unlinkSync(filePath);
}
