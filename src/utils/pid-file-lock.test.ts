import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquirePidFileLock,
  acquirePidFileLockWithRetryAsync,
  parsePidFile,
  readPidFileOwner,
} from './pid-file-lock';

const roots: string[] = [];

// Real fs handles captured before any mock.module('node:fs') below: after a
// mock is registered, lazy `fs.*` lookups resolve to the mock, so the rename
// wrapper and its swap simulation must call these directly to avoid
// recursing into the mock.
const realRenameSync = fs.renameSync;
const realWriteFileSync = fs.writeFileSync;
const realUtimesSync = fs.utimesSync;

/**
 * Registers a `node:fs` mock that simulates a peer replacing `lockDir`
 * between the lock's snapshot and its rename: the first time the lock tries
 * to rename `lockDir`, the mock writes `ownerBytes` plus a fresh dir mtime
 * (as a real mkdir + write would produce) before performing the rename.
 * Returns a ref that flips to true once the swap fired. The mock spreads the
 * real `fs` module so the surrounding test keeps full filesystem access;
 * only `renameSync` is wrapped.
 */
function mockPeerLockSwap(
  lockDir: string,
  ownerBytes: string,
): { swapped: boolean } {
  const state = { swapped: false };
  mock.module('node:fs', () => ({
    ...fs,
    renameSync: ((from: string, to: string) => {
      if (!state.swapped && from === lockDir) {
        state.swapped = true;
        realWriteFileSync(join(lockDir, 'owner'), ownerBytes);
        const now = new Date();
        realUtimesSync(lockDir, now, now);
      }
      return realRenameSync(from, to);
    }) as typeof fs.renameSync,
  }));
  return state;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('pid-file-lock', () => {
  test('acquire, release, and re-acquire', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'omo-pidlock-'));
    roots.push(root);
    const lockFile = join(root, 'resource');

    const release = acquirePidFileLock(lockFile);
    expect(release).not.toBeNull();
    expect(fs.existsSync(`${lockFile}.lock`)).toBe(true);

    release?.();
    expect(fs.existsSync(`${lockFile}.lock`)).toBe(false);

    const reAcquired = acquirePidFileLock(lockFile);
    expect(reAcquired).not.toBeNull();
    reAcquired?.();
  });

  test('takes over a lock whose owner PID is dead', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'omo-pidlock-'));
    roots.push(root);
    const lockFile = join(root, 'resource');
    const lockDir = `${lockFile}.lock`;

    // A dead owner: an integer PID far above typical pid_max that no test
    // process should hold. If such a PID somehow exists, skip rather than
    // flake.
    const deadPid = 2 ** 22;
    try {
      process.kill(deadPid, 0);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
    }

    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(join(lockDir, 'owner'), String(deadPid));

    const release = acquirePidFileLock(lockFile);
    expect(release).not.toBeNull();
    expect(parsePidFile(fs.readFileSync(join(lockDir, 'owner'), 'utf8'))).toBe(
      process.pid,
    );
    release?.();
  });

  test('release does not remove a lock whose owner token was replaced', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'omo-pidlock-'));
    roots.push(root);
    const lockFile = join(root, 'resource');
    const lockDir = `${lockFile}.lock`;

    const release = acquirePidFileLock(lockFile);
    expect(release).not.toBeNull();

    // Simulate a takeover: another process rewrote the owner file with its
    // own token. Our release must not delete the successor's live lock.
    fs.writeFileSync(join(lockDir, 'owner'), `${process.pid}\nother-token`);
    release?.();

    expect(fs.existsSync(lockDir)).toBe(true);
    expect(readPidFileOwner(lockDir)).toEqual({
      pid: process.pid,
      token: 'other-token',
    });
  });

  test('ownership fence detects a replaced owner token', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'omo-pidlock-'));
    roots.push(root);
    const lockFile = join(root, 'resource');
    const lockDir = `${lockFile}.lock`;

    const release = acquirePidFileLock(lockFile);
    expect(release?.isOwned()).toBe(true);

    fs.writeFileSync(join(lockDir, 'owner'), `${process.pid}\nother-token`);
    expect(release?.isOwned()).toBe(false);

    release?.();
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  test('release removes the lock when the owner token still matches', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'omo-pidlock-'));
    roots.push(root);
    const lockFile = join(root, 'resource');
    const lockDir = `${lockFile}.lock`;

    const release = acquirePidFileLock(lockFile);
    const owner = readPidFileOwner(lockDir);
    expect(owner?.pid).toBe(process.pid);
    expect(owner?.token).toBeTruthy();

    release?.();
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test('age cap takes over a live-owned lock older than maxAgeMs', async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'omo-pidlock-'));
    roots.push(root);
    const lockFile = join(root, 'resource');
    const lockDir = `${lockFile}.lock`;

    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(join(lockDir, 'owner'), String(process.pid));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, old, old);

    const release = await acquirePidFileLockWithRetryAsync(
      lockFile,
      500,
      30_000,
    );
    expect(release).not.toBeNull();
    expect(parsePidFile(fs.readFileSync(join(lockDir, 'owner'), 'utf8'))).toBe(
      process.pid,
    );
    release?.();
  });

  test('owner-less young lock counts as live', async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'omo-pidlock-'));
    roots.push(root);
    const lockFile = join(root, 'resource');

    // Crash between mkdirSync and writeFileSync leaves a lock dir with no
    // owner file; the young-lock fallback must treat it as live so the next
    // waiter does not steal a lock the crashed process briefly held.
    fs.mkdirSync(`${lockFile}.lock`, { recursive: true });

    const release = await acquirePidFileLockWithRetryAsync(lockFile, 50);
    expect(release).toBeNull();
  });

  test('stale takeover restores a lock replaced mid-claim', async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'omo-pidlock-'));
    roots.push(root);
    const lockFile = join(root, 'resource');
    const lockDir = `${lockFile}.lock`;

    const deadPid = 2 ** 22;
    try {
      process.kill(deadPid, 0);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
    }

    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(join(lockDir, 'owner'), String(deadPid));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, old, old);

    // Deterministic peer: between our staleness snapshot and our rename, a
    // peer re-acquires the lock (fresh owner bytes + fresh dir mtime).
    const freshOwner = `${process.pid}\nfresh-token`;
    const swap = mockPeerLockSwap(lockDir, freshOwner);

    const mod = await import('./pid-file-lock?test=takeover-race');
    const release = mod.acquirePidFileLock(lockFile);

    expect(swap.swapped).toBe(true);
    expect(release).toBeNull();
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.readFileSync(join(lockDir, 'owner'), 'utf8')).toBe(freshOwner);
  });

  test('release restores a successor lock that replaced ours', async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'omo-pidlock-'));
    roots.push(root);
    const lockFile = join(root, 'resource');
    const lockDir = `${lockFile}.lock`;

    const successorOwner = `${process.pid}\nsuccessor-token`;
    const swap = mockPeerLockSwap(lockDir, successorOwner);

    const mod = await import('./pid-file-lock?test=release-race');
    const release = mod.acquirePidFileLock(lockFile);
    expect(release).not.toBeNull();
    release?.();

    expect(swap.swapped).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.readFileSync(join(lockDir, 'owner'), 'utf8')).toBe(
      successorOwner,
    );
  });
});
