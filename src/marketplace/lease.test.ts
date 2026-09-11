import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketplaceBusyError, MarketplaceLockOwnershipError } from './errors';
import {
  acquireMarketplaceLease,
  acquireMarketplaceLeaseForTests,
  generationPath,
  heartbeatPath,
  isHeartbeatStale,
  type LeaseIdentity,
  listValidGenerations,
  publishGeneration,
  readGenerationState,
  readLeaseState,
} from './lease';
import { getMarketplacePaths } from './paths';

const SHORT_LOCK = {
  staleMs: 80,
  heartbeatMs: 20,
  timeoutMs: 400,
  retryMs: 10,
} as const;

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marketplace-lease-'));
}

function expireHeartbeat(directory: string, generation: string): void {
  const old = new Date(Date.now() - 2_000);
  const file = heartbeatPath(directory, generation);
  utimesSync(generationPath(directory, generation), old, old);
  utimesSync(file, old, old);
}

function writeIncompleteGeneration(
  directory: string,
  generation: string,
): void {
  const target = generationPath(directory, generation);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, 'meta.json'),
    `${JSON.stringify({ generation })}\n`,
  );
}

function creatingDirs(directory: string): string[] {
  try {
    return readdirSync(directory).filter((name) =>
      name.startsWith('.creating.'),
    );
  } catch {
    return [];
  }
}

async function waitForFile(filePath: string, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!existsSync(filePath)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${filePath}`);
    }
    await Bun.sleep(10);
  }
}

function spawnLeaseWorker(
  body: string,
  payload: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): Bun.Subprocess {
  return Bun.spawn(
    [
      'bun',
      '-e',
      `import { existsSync, writeFileSync } from 'node:fs';
import { acquireMarketplaceLease } from './src/marketplace/lease.ts';
${body}`,
      JSON.stringify(payload),
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...env },
    },
  );
}

async function workerOutput(
  worker: Bun.Subprocess,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const [stdout, stderr, code] = await Promise.all([
    new Response(worker.stdout).text(),
    new Response(worker.stderr).text(),
    worker.exited,
  ]);
  return { code, stdout, stderr };
}

describe('marketplace lease generations', () => {
  test('stale cleanup does not claim a replacement generation', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      mkdirSync(paths.rootDir, { recursive: true });
      const replacement: LeaseIdentity = {
        generation: 'replacement-generation',
        token: 'replacement-token',
      };
      expect(publishGeneration(paths.lockDir, replacement)).toBe(true);
      writeIncompleteGeneration(paths.lockDir, 'stale-generation');
      expect(() =>
        acquireMarketplaceLease(paths, {
          staleMs: 2_000,
          heartbeatMs: 100,
          timeoutMs: 120,
          retryMs: 10,
        }),
      ).toThrow(MarketplaceBusyError);
      expect(readLeaseState(paths.lockDir)?.metadata).toEqual({
        ...replacement,
        pid: process.pid,
      });
      expect(
        existsSync(generationPath(paths.lockDir, 'stale-generation')),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing metadata is not ownership and is never deleted', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      writeIncompleteGeneration(paths.lockDir, 'partial-generation');
      const owner = acquireMarketplaceLease(paths, SHORT_LOCK);
      expect(
        existsSync(
          join(
            generationPath(paths.lockDir, 'partial-generation'),
            'meta.json',
          ),
        ),
      ).toBe(true);
      expect(
        JSON.parse(
          readFileSync(
            join(
              generationPath(paths.lockDir, 'partial-generation'),
              'meta.json',
            ),
            'utf8',
          ),
        ),
      ).toEqual({ generation: 'partial-generation' });
      expect(owner.generation).not.toBe('partial-generation');
      owner.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('heartbeat equal to the stale interval is still fresh', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const identity: LeaseIdentity = {
        generation: 'boundary-generation',
        token: 'boundary-token',
      };
      expect(publishGeneration(paths.lockDir, identity)).toBe(true);
      const staleMs = 200;
      const state = readGenerationState(
        generationPath(paths.lockDir, identity.generation),
      );
      if (!state) throw new Error('expected published generation state');
      expect(
        isHeartbeatStale(state, staleMs, state.heartbeatMtimeMs + staleMs),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('heartbeat older than the stale interval is stale', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const identity: LeaseIdentity = {
        generation: 'stale-boundary-generation',
        token: 'stale-boundary-token',
      };
      expect(publishGeneration(paths.lockDir, identity)).toBe(true);
      const staleMs = 200;
      const state = readGenerationState(
        generationPath(paths.lockDir, identity.generation),
      );
      if (!state) throw new Error('expected published generation state');
      expect(
        isHeartbeatStale(state, staleMs, state.heartbeatMtimeMs + staleMs + 1),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('synchronous commit remains owned after the stale interval', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    let nowMs = Date.now();
    try {
      const owner = acquireMarketplaceLeaseForTests(
        paths,
        {
          staleMs: 40,
          heartbeatMs: 10,
          timeoutMs: 500,
          retryMs: 5,
        },
        () => nowMs,
      );
      const acquired = readGenerationState(
        generationPath(paths.lockDir, owner.generation),
      );
      if (!acquired) throw new Error('expected owned generation');
      nowMs = acquired.heartbeatMtimeMs;
      const result = owner.commit(() => {
        const during = readGenerationState(
          generationPath(paths.lockDir, owner.generation),
        );
        if (!during) {
          throw new Error('expected owned generation during commit');
        }
        nowMs = during.heartbeatMtimeMs + 80;
        return 'published';
      });
      expect(result).toBe('published');
      expect(readLeaseState(paths.lockDir)?.metadata.generation).toBe(
        owner.generation,
      );
      owner.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('expired owner cannot commit before a replacement exists', () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    try {
      const owner = acquireMarketplaceLease(paths, SHORT_LOCK);
      expireHeartbeat(paths.lockDir, owner.generation);
      let published = false;
      expect(() =>
        owner.commit(() => {
          published = true;
        }),
      ).toThrow(MarketplaceLockOwnershipError);
      expect(published).toBe(false);
      expect(readLeaseState(paths.lockDir)?.metadata.generation).toBe(
        owner.generation,
      );
      expect(() => owner.release()).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('marketplace lease subprocess barriers', () => {
  test('active breaker blocks main lock acquire', async () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    const readyPath = join(root, 'ready');
    const holdingPath = join(root, 'holding');
    const goPath = join(root, 'go');
    const worker = spawnLeaseWorker(
      `const { paths, readyPath, holdingPath, goPath, lock } = JSON.parse(process.argv[1]);
const lease = acquireMarketplaceLease(paths, lock);
writeFileSync(readyPath, lease.generation);
lease.commit(() => {
  writeFileSync(holdingPath, 'holding');
  while (!existsSync(goPath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
});
lease.release();`,
      { paths, readyPath, holdingPath, goPath, lock: SHORT_LOCK },
    );
    try {
      await waitForFile(holdingPath);
      const generation = readFileSync(readyPath, 'utf8');
      expireHeartbeat(paths.lockDir, generation);
      expect(() =>
        acquireMarketplaceLease(paths, { ...SHORT_LOCK, timeoutMs: 120 }),
      ).toThrow(MarketplaceBusyError);
      expect(readLeaseState(paths.lockDir)?.metadata.generation).toBe(
        generation,
      );
      expect(listValidGenerations(paths.breakerDir).length).toBeGreaterThan(0);
      writeFileSync(goPath, 'go');
      const result = await workerOutput(worker);
      expect(result.code).toBe(0);
    } finally {
      worker.kill();
      await worker.exited.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('kills a worker during private generation initialization', async () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    const barrierDir = join(root, 'barriers');
    mkdirSync(barrierDir, { recursive: true });
    writeFileSync(join(barrierDir, 'prepare-generation.wait'), 'wait');
    const worker = spawnLeaseWorker(
      `const { paths, lock } = JSON.parse(process.argv[1]);
acquireMarketplaceLease(paths, lock);`,
      { paths, lock: SHORT_LOCK },
      { MARKETPLACE_LEASE_BARRIER_DIR: barrierDir },
    );
    try {
      await waitForFile(join(barrierDir, 'prepare-generation.reached'));
      expect(creatingDirs(paths.breakerDir).length).toBeGreaterThan(0);
      worker.kill('SIGKILL');
      await worker.exited;
      rmSync(join(barrierDir, 'prepare-generation.wait'), { force: true });
      const owner = acquireMarketplaceLease(paths, SHORT_LOCK);
      expect(creatingDirs(paths.breakerDir)).toEqual([]);
      expect(creatingDirs(paths.lockDir)).toEqual([]);
      expect(readLeaseState(paths.lockDir)?.metadata.generation).toBe(
        owner.generation,
      );
      owner.release();
    } finally {
      worker.kill();
      await worker.exited.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('expired owner commit fails before replacement', async () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    const readyPath = join(root, 'ready');
    const expirePath = join(root, 'expire');
    const logPath = join(root, 'commit.log');
    const publishedPath = join(root, 'published');
    const worker = spawnLeaseWorker(
      `const { paths, readyPath, expirePath, logPath, publishedPath, lock } = JSON.parse(process.argv[1]);
const lease = acquireMarketplaceLease(paths, lock);
writeFileSync(readyPath, lease.generation);
while (!existsSync(expirePath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
try {
  lease.commit(() => writeFileSync(publishedPath, 'published'));
  writeFileSync(logPath, 'committed');
} catch (error) {
  writeFileSync(logPath, error instanceof Error ? error.constructor.name : 'error');
}`,
      {
        paths,
        readyPath,
        expirePath,
        logPath,
        publishedPath,
        lock: SHORT_LOCK,
      },
    );
    try {
      await waitForFile(readyPath);
      const generation = readFileSync(readyPath, 'utf8');
      expireHeartbeat(paths.lockDir, generation);
      writeFileSync(expirePath, 'expired');
      const result = await workerOutput(worker);
      expect(result.code).toBe(0);
      expect(readFileSync(logPath, 'utf8')).toBe(
        'MarketplaceLockOwnershipError',
      );
      expect(existsSync(publishedPath)).toBe(false);
      expect(readLeaseState(paths.lockDir)?.metadata.generation).toBe(
        generation,
      );
    } finally {
      worker.kill();
      await worker.exited.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('owner release during takeover leaves the replacement', async () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    const readyPath = join(root, 'ready');
    const takeoverPath = join(root, 'takeover');
    const logPath = join(root, 'release.log');
    const worker = spawnLeaseWorker(
      `const { paths, readyPath, takeoverPath, logPath, lock } = JSON.parse(process.argv[1]);
const lease = acquireMarketplaceLease(paths, lock);
writeFileSync(readyPath, JSON.stringify({ generation: lease.generation, token: lease.token }));
while (!existsSync(takeoverPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
try {
  lease.release();
  writeFileSync(logPath, 'released');
} catch (error) {
  writeFileSync(logPath, error instanceof Error ? error.constructor.name : 'error');
}`,
      { paths, readyPath, takeoverPath, logPath, lock: SHORT_LOCK },
    );
    try {
      await waitForFile(readyPath);
      const owner = JSON.parse(
        readFileSync(readyPath, 'utf8'),
      ) as LeaseIdentity;
      expireHeartbeat(paths.lockDir, owner.generation);
      const replacement = acquireMarketplaceLease(paths, SHORT_LOCK);
      expect(replacement.generation).not.toBe(owner.generation);
      writeFileSync(takeoverPath, 'taken');
      const result = await workerOutput(worker);
      expect(result.code).toBe(0);
      expect(readFileSync(logPath, 'utf8')).toBe(
        'MarketplaceLockOwnershipError',
      );
      expect(readLeaseState(paths.lockDir)?.metadata.generation).toBe(
        replacement.generation,
      );
      expect(() => replacement.assertCurrent()).not.toThrow();
      replacement.release();
    } finally {
      worker.kill();
      await worker.exited.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('three parties cannot overlap critical sections or displace a generation', async () => {
    const root = tempRoot();
    const paths = getMarketplacePaths(root);
    const barrierDir = join(root, 'barriers');
    mkdirSync(barrierDir, { recursive: true });
    writeFileSync(join(barrierDir, 'breaker-critical.wait'), 'wait');
    const ownerReady = join(root, 'owner-ready');
    const ownerGo = join(root, 'owner-go');
    const staleReady = join(root, 'stale-ready');
    const owner = spawnLeaseWorker(
      `const { paths, ownerReady, ownerGo, lock } = JSON.parse(process.argv[1]);
const lease = acquireMarketplaceLease(paths, lock);
writeFileSync(ownerReady, lease.generation);
while (!existsSync(ownerGo)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
lease.release();`,
      {
        paths,
        ownerReady,
        ownerGo,
        lock: {
          staleMs: 2_000,
          heartbeatMs: 100,
          timeoutMs: 3_000,
          retryMs: 20,
        },
      },
    );
    let staleClaim: Bun.Subprocess | undefined;
    try {
      await waitForFile(ownerReady);
    } catch (error) {
      owner.kill();
      await owner.exited.catch(() => undefined);
      throw error;
    }
    staleClaim = spawnLeaseWorker(
      `const { paths, staleReady, lock } = JSON.parse(process.argv[1]);
writeFileSync(staleReady, 'started');
try {
  acquireMarketplaceLease(paths, lock);
  writeFileSync(staleReady + '.won', 'won');
} catch (error) {
  writeFileSync(staleReady + '.busy', error instanceof Error ? error.constructor.name : 'error');
}`,
      {
        paths,
        staleReady,
        lock: {
          staleMs: 2_000,
          heartbeatMs: 100,
          timeoutMs: 2_000,
          retryMs: 20,
        },
      },
      { MARKETPLACE_LEASE_BARRIER_DIR: barrierDir },
    );
    try {
      const ownerGeneration = readFileSync(ownerReady, 'utf8');
      await waitForFile(staleReady);
      await waitForFile(join(barrierDir, 'breaker-critical.reached'));
      expect(readLeaseState(paths.lockDir)?.metadata.generation).toBe(
        ownerGeneration,
      );
      expect(() =>
        acquireMarketplaceLease(paths, {
          staleMs: 2_000,
          heartbeatMs: 100,
          timeoutMs: 120,
          retryMs: 10,
        }),
      ).toThrow(MarketplaceBusyError);
      expect(readLeaseState(paths.lockDir)?.metadata.generation).toBe(
        ownerGeneration,
      );
      expect(existsSync(`${staleReady}.won`)).toBe(false);
      writeFileSync(join(barrierDir, 'breaker-critical.go'), 'go');
      writeFileSync(ownerGo, 'go');
      const [ownerResult, staleResult] = await Promise.all([
        workerOutput(owner),
        workerOutput(staleClaim),
      ]);
      expect(ownerResult.code).toBe(0);
      expect(staleResult.code).toBe(0);
    } finally {
      owner.kill();
      staleClaim?.kill();
      await Promise.all([
        owner.exited.catch(() => undefined),
        staleClaim?.exited.catch(() => undefined),
      ]);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
