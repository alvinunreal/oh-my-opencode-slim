import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { log } from './logger';

const RETRY_INTERVAL_MS = 25;
const YOUNG_LOCK_MS = 5_000;

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function parsePidFile(raw: string): number | null {
  const pid = Number(raw.split('\n')[0].trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

/**
 * Reads a lock dir's `owner` file. The current format is the PID on line 1
 * and a per-acquisition owner token on line 2; legacy locks written by older
 * plugin versions contain only the PID, so `token` is then null.
 * Returns null when the file is missing or unparsable.
 */
export function readPidFileOwner(
  lock: string,
): { pid: number; token: string | null } | null {
  let raw: string;
  try {
    raw = readFileSync(path.join(lock, 'owner'), 'utf8');
  } catch {
    return null;
  }
  const pid = parsePidFile(raw);
  if (pid === null) return null;
  const token = raw.split('\n')[1]?.trim();
  return { pid, token: token ? token : null };
}

/**
 * Byte-level snapshot of a lock dir, taken before any liveness judgment or
 * rename. `raw` is the full bytes of `<lock>/owner` (null when unreadable);
 * `dirMtimeMs` is the lock dir's mtime (null when unstattable). A rename
 * preserves the dir mtime, so the claimed copy can be compared against the
 * snapshot to detect a peer's takeover in between.
 */
interface LockSnapshot {
  raw: string | null;
  dirMtimeMs: number | null;
}

function readLockSnapshot(lock: string): LockSnapshot {
  let raw: string | null = null;
  try {
    raw = readFileSync(path.join(lock, 'owner'), 'utf8');
  } catch {
    raw = null;
  }
  let dirMtimeMs: number | null = null;
  try {
    dirMtimeMs = statSync(lock).mtimeMs;
  } catch {
    dirMtimeMs = null;
  }
  return { raw, dirMtimeMs };
}

/**
 * Judges liveness from a snapshot (same rules as
 * {@link pidFileLockHasLiveOwner}): an unreadable owner with a young dir is
 * live; an unstattable dir with no owner bytes is stale.
 */
function snapshotHasLiveOwner(
  snapshot: LockSnapshot,
  maxAgeMs?: number,
): boolean {
  if (snapshot.raw !== null) {
    const pid = parsePidFile(snapshot.raw);
    if (pid === null) return false;
    if (!isProcessAlive(pid)) return false;
    if (maxAgeMs !== undefined && snapshot.dirMtimeMs !== null) {
      if (Date.now() - snapshot.dirMtimeMs >= maxAgeMs) {
        log('[pid-file-lock] lock age exceeds max age; treating as stale');
        return false;
      }
    }
    // Unstattable dir: treat the live owner as authoritative.
    return true;
  }
  log('[pid-file-lock] lock owner check failed: owner unreadable');
  if (snapshot.dirMtimeMs === null) {
    log('[pid-file-lock] lock owner check failed: lock dir unstattable');
    return false;
  }
  return Date.now() - snapshot.dirMtimeMs < YOUNG_LOCK_MS;
}

/**
 * Renames `lock` aside to a unique sibling path and deletes the claim only
 * when its owner bytes and dir mtime still match `expected`. A peer that
 * re-acquired the lock after our snapshot changed at least one of them, so
 * its lock is renamed back instead of deleted. Returns 'removed' when the
 * claim was deleted, 'restored' when a changed lock was put back (or the
 * claim could not be taken safely), and 'gone' when the lock vanished.
 */
function removeLockDirIfMatches(
  lock: string,
  expected: LockSnapshot,
): 'removed' | 'restored' | 'gone' {
  const claimPath =
    `${lock}.claim-${process.pid}-${Date.now().toString(36)}` +
    `${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lock, claimPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    log('[pid-file-lock] lock claim rename failed', String(err));
    return 'restored';
  }
  const claimed = readLockSnapshot(claimPath);
  if (
    claimed.raw !== expected.raw ||
    claimed.dirMtimeMs !== expected.dirMtimeMs
  ) {
    // A successor replaced the lock between our snapshot and the rename;
    // put its lock back. Rename-back only ever touches our claim path.
    try {
      renameSync(claimPath, lock);
    } catch (err) {
      log('[pid-file-lock] lock restore failed', String(err));
      try {
        rmSync(claimPath, { recursive: true, force: true });
      } catch (rmErr) {
        log('[pid-file-lock] stale lock cleanup failed', String(rmErr));
      }
    }
    return 'restored';
  }
  try {
    rmSync(claimPath, { recursive: true, force: true });
  } catch (err) {
    // Cleanup of the renamed-away dir is best-effort (EACCES/EBUSY on
    // win32); the lock path itself is already clear, so never abort.
    log('[pid-file-lock] stale lock cleanup failed', String(err));
  }
  return 'removed';
}

/**
 * Attempts to take an exclusive lock by creating the `<file>.lock` directory
 * and writing this process's PID plus a unique owner token into it. Locks
 * left behind by dead processes are detected via the owner PID file and
 * taken over via claim-verify-restore: the stale dir is snapshotted (owner
 * bytes + dir mtime), renamed aside, and only deleted when the claimed copy
 * still matches the snapshot — a lock a peer re-acquired in between is
 * renamed back instead, so two waiters can never both become owners. With
 * `maxAgeMs` set, a lock older than that is treated as stale even when its
 * owner PID is alive (PID reuse or a wedged holder must not wedge peers
 * forever). Returns a release function, or null when a live process holds
 * the lock. Release applies the same claim-verify-restore to the owner
 * bytes it just read, so a holder that lost the lock to a takeover
 * restores (never deletes) its successor's lock.
 */
export type PidFileLockRelease = (() => void) & {
  isOwned: () => boolean;
};

export function acquirePidFileLock(
  file: string,
  maxAgeMs?: number,
): PidFileLockRelease | null {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      // Token is only compared against itself on release, never reaches the
      // prompt, so Date.now/Math.random are safe here (src/utils is outside
      // the cache-safety tripwire's SCAN_DIRS).
      const token = `${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2)}`;
      writeFileSync(path.join(lock, 'owner'), `${process.pid}\n${token}`);

      const isOwned = (): boolean => {
        let raw: string;
        try {
          raw = readFileSync(path.join(lock, 'owner'), 'utf8');
        } catch {
          return false;
        }
        const seen = raw.split('\n')[1]?.trim();
        return (
          parsePidFile(raw) === process.pid && (seen ? seen : null) === token
        );
      };

      const release = (() => {
        // Single raw read: the token check and the snapshot below must see
        // the same bytes, otherwise a successor slipping between two reads
        // could be deleted.
        let raw: string;
        try {
          raw = readFileSync(path.join(lock, 'owner'), 'utf8');
        } catch {
          log('[pid-file-lock] lock owner changed; skipping release');
          return;
        }
        const seen = raw.split('\n')[1]?.trim();
        if (
          parsePidFile(raw) !== process.pid ||
          (seen ? seen : null) !== token
        ) {
          log('[pid-file-lock] lock owner changed; skipping release');
          return;
        }
        let dirMtimeMs: number | null = null;
        try {
          dirMtimeMs = statSync(lock).mtimeMs;
        } catch {
          dirMtimeMs = null;
        }
        const outcome = removeLockDirIfMatches(lock, { raw, dirMtimeMs });
        if (outcome === 'restored') {
          log('[pid-file-lock] lock owner changed; skipping release');
        }
        // 'removed' means our lock is gone; 'gone' means someone else
        // removed it first — both need no further action.
      }) as PidFileLockRelease;
      release.isOwned = isOwned;
      return release;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      const snapshot = readLockSnapshot(lock);
      if (snapshotHasLiveOwner(snapshot, maxAgeMs)) return null;
      log('[pid-file-lock] removing stale PID file lock for dead process');
      // Only one waiter wins the rename, and verify-before-delete puts a
      // freshly re-acquired lock back. The suffix is random so a leftover
      // claim dir from a crashed same-PID predecessor can never make this
      // rename fail with EEXIST.
      if (removeLockDirIfMatches(lock, snapshot) !== 'removed') {
        // A successor replaced the lock ('restored') or it vanished
        // ('gone'): never acquire on top of either.
        return null;
      }
    }
  }
  return null;
}

/**
 * Retries {@link acquirePidFileLock} up to `attempts` times, blocking
 * `RETRY_INTERVAL_MS` between attempts. Synchronous (Atomics.wait parks the
 * JS thread); prefer {@link acquirePidFileLockWithRetryAsync} on a main
 * thread. Returns a release function, or null when the lock stayed held for
 * every attempt (roughly `attempts * RETRY_INTERVAL_MS`).
 */
export function acquirePidFileLockWithRetry(
  file: string,
  attempts: number,
  maxAgeMs?: number,
): PidFileLockRelease | null {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const release = acquirePidFileLock(file, maxAgeMs);
    if (release) return release;
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      RETRY_INTERVAL_MS,
    );
  }
  return null;
}

/**
 * Async variant of {@link acquirePidFileLockWithRetry}: waits via setTimeout
 * so the JS thread is never blocked (safe on the main thread). Retries until
 * `timeoutMs` has elapsed. Returns a release function, or null when the lock
 * stayed held for the whole budget.
 */
export async function acquirePidFileLockWithRetryAsync(
  file: string,
  timeoutMs: number,
  maxAgeMs?: number,
): Promise<PidFileLockRelease | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = acquirePidFileLock(file, maxAgeMs);
    if (release) return release;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }
}

/**
 * A lock counts as live when its owner PID is running. Two guards keep a
 * dead or wedged holder from blocking peers forever:
 *
 * - If the owner file is unreadable (holder crashed between mkdirSync and
 *   writeFileSync), a lock dir younger than {@link YOUNG_LOCK_MS} counts as
 *   live; older ones are stale.
 * - With `maxAgeMs` set, a lock dir older than that is stale even when the
 *   owner PID answers: the PID was recycled by an unrelated process, or the
 *   holder wedged past its own install timeout.
 */
export function pidFileLockHasLiveOwner(
  lock: string,
  maxAgeMs?: number,
): boolean {
  return snapshotHasLiveOwner(readLockSnapshot(lock), maxAgeMs);
}
