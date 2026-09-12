import { describe, expect, spyOn, test } from 'bun:test';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MarketplaceBusyError,
  MarketplaceLockfileError,
  MarketplaceLockOwnershipError,
} from './errors';
import { acquireMarketplaceLease, type MarketplaceLockOptions } from './lease';
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

describe('marketplace synchronous lease lifecycle', () => {
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

  test('synchronous blocking work remains owned beyond the stale interval', async () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    const resultPath = join(root, 'challenger-result');
    const startedPath = join(root, 'challenger-started');
    let challenger: Bun.Subprocess | undefined;
    try {
      const owner = acquireMarketplaceLease(paths, LOCK);
      challenger = spawnWorker(
        paths,
        `const { paths, resultPath, startedPath } = JSON.parse(process.argv[1]);
await import('node:fs').then(({ writeFileSync }) => writeFileSync(startedPath, 'started'));
try {
  const lease = acquireMarketplaceLease(paths, { staleMs: 80, timeoutMs: 120, retryMs: 10 });
  lease.release();
  await import('node:fs').then(({ writeFileSync }) => writeFileSync(resultPath, 'acquired'));
} catch (error) {
  await import('node:fs').then(({ writeFileSync }) => writeFileSync(resultPath, error instanceof Error ? error.constructor.name : 'unknown'));
}`,
        { resultPath, startedPath },
      );
      for (
        let attempt = 0;
        attempt < 200 && !existsSync(startedPath);
        attempt++
      ) {
        await Bun.sleep(5);
      }
      expect(existsSync(startedPath)).toBe(true);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      expect(() => owner.assertCurrent()).not.toThrow();
      owner.commit(() => undefined);
      owner.release();
      await challenger.exited;
      expect(readFileSync(resultPath, 'utf8')).toBe('MarketplaceBusyError');
    } finally {
      challenger?.kill();
      if (challenger) await challenger.exited.catch(() => -1);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses the default process liveness mapping for stale leases', () => {
    for (const [code, reclaimable] of [
      ['ESRCH', true],
      ['EPERM', false],
      ['EUNKNOWN', false],
    ] as const) {
      const root = tempRoot();
      const paths = getMarketplacePaths(root);
      try {
        const stale = createEntry(paths.lockDir, 4242, UUIDS.first, 'lease');
        age(stale);
        if (reclaimable) {
          const owner = withKillError(4242, code, () =>
            acquireMarketplaceLease(paths, LOCK),
          );
          expect(existsSync(stale)).toBe(false);
          owner.release();
        } else {
          expect(() =>
            withKillError(4242, code, () =>
              acquireMarketplaceLease(paths, { ...LOCK, timeoutMs: 120 }),
            ),
          ).toThrow(MarketplaceBusyError);
          expect(existsSync(stale)).toBe(true);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
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

  test('candidate election leaves exactly one lease under concurrent acquisition', async () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    const barrierDir = join(root, 'barrier');
    const goPath = join(barrierDir, 'go');
    mkdirSync(barrierDir);
    const workers = Array.from({ length: 2 }, () =>
      spawnWorker(
        paths,
        `const { paths, barrierDir, goPath } = JSON.parse(process.argv[1]);
const fs = await import('node:fs');
const lease = acquireMarketplaceLease(paths, { staleMs: 500, timeoutMs: 3000, retryMs: 5 }, {
  afterCandidateCreated(candidatePath) {
    const readyPath = barrierDir + '/' + candidatePath.split('/').pop() + '.ready';
    fs.writeFileSync(readyPath, 'ready');
    while (!fs.existsSync(goPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  },
});
lease.release();`,
        { barrierDir, goPath },
      ),
    );
    try {
      for (
        let attempt = 0;
        attempt < 300 && readdirSync(barrierDir).length < 2;
        attempt++
      ) {
        await Bun.sleep(10);
      }
      expect(readdirSync(barrierDir)).toHaveLength(2);
      writeFileSync(goPath, 'go');
      const results = await Promise.all(workers.map(workerResult));
      expect(results.every((result) => result.code === 0)).toBe(true);
      expect(results.map((result) => result.stderr)).toEqual(['', '']);
      expect(lockEntries(paths.lockDir)).toEqual([]);
    } finally {
      for (const worker of workers) worker.kill();
      await Promise.all(workers.map((worker) => worker.exited.catch(() => -1)));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('multiple reclaimers exclude one another', async () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    const barrierDir = join(root, 'reclaimer-barrier');
    const goPath = join(barrierDir, 'go');
    const active = join(root, 'active');
    mkdirSync(barrierDir);
    const stale = createEntry(paths.lockDir, 4242, UUIDS.first, 'lease');
    age(stale);
    const workers = Array.from({ length: 4 }, () =>
      spawnWorker(
        paths,
        `const { paths, barrierDir, goPath } = JSON.parse(process.argv[1]);
const fs = await import('node:fs');
const lease = acquireMarketplaceLease(paths, { staleMs: 500, timeoutMs: 5000, retryMs: 5 }, {
  afterCandidateCreated(candidatePath) {
    const readyPath = barrierDir + '/' + candidatePath.split('/').pop() + '.ready';
    fs.writeFileSync(readyPath, 'ready');
    while (!fs.existsSync(goPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  },
});
const fd = fs.openSync(${JSON.stringify(active)}, 'wx');
fs.closeSync(fd);
await new Promise((resolve) => setTimeout(resolve, 25));
fs.unlinkSync(${JSON.stringify(active)});
lease.release();`,
        { barrierDir, goPath },
      ),
    );
    try {
      for (
        let attempt = 0;
        attempt < 300 && readdirSync(barrierDir).length < 4;
        attempt++
      ) {
        await Bun.sleep(10);
      }
      expect(readdirSync(barrierDir)).toHaveLength(4);
      writeFileSync(goPath, 'go');
      const results = await Promise.all(workers.map(workerResult));
      expect(results.every((result) => result.code === 0)).toBe(true);
      expect(results.map((result) => result.stderr)).toEqual(['', '', '', '']);
      expect(existsSync(active)).toBe(false);
    } finally {
      for (const worker of workers) worker.kill();
      await Promise.all(workers.map((worker) => worker.exited.catch(() => -1)));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('replacement fencing unlinks only the exact unique lease path', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const owner = acquireMarketplaceLease(paths, LOCK);
      const oldPath = join(paths.lockDir, lockEntries(paths.lockDir)[0]);
      unlinkForTest(oldPath);
      const replacement = createEntry(
        paths.lockDir,
        process.pid,
        UUIDS.second,
        'lease',
      );
      expect(() => owner.release()).toThrow(MarketplaceLockOwnershipError);
      expect(existsSync(replacement)).toBe(true);
      unlinkForTest(replacement);
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

  test('malformed, unknown, directory, and symlink state fails closed', () => {
    const cases = [
      (lockDir: string) => writeFileSync(join(lockDir, 'unknown'), ''),
      (lockDir: string) => mkdirSync(join(lockDir, `1.${UUIDS.first}.lease`)),
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
      const entry = createEntry(paths.lockDir, 4242, UUIDS.first, 'lease');
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
