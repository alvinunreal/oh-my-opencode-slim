import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MarketplaceBusyError,
  MarketplaceLockfileError,
  MarketplaceLockOwnershipError,
  MarketplaceValidationError,
} from './errors';
import type { MarketplacePaths } from './paths';

export interface MarketplaceLockOptions {
  staleMs: number;
  timeoutMs: number;
  retryMs: number;
}

export interface MarketplaceLease {
  assertCurrent(): void;
  commit<T>(operation: () => T): T;
  release(): void;
}

const DEFAULT_LOCK_OPTIONS: MarketplaceLockOptions = {
  staleMs: 60_000,
  timeoutMs: 300_000,
  retryMs: 20,
};

const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ENTRY_PATTERN = new RegExp(
  `^([1-9][0-9]*)\\.(${UUID_PATTERN})\\.(candidate|lease)$`,
);
const MAX_SCAN_RETRIES = 8;

interface MarketplaceLeaseTestHooks {
  afterCandidateCreated?: (candidatePath: string) => void;
}

class RestartDirectoryScan extends Error {}

interface LockEntry {
  kind: 'candidate' | 'lease';
  name: string;
  path: string;
  pid: number;
  uuid: string;
  mtimeMs: number;
}

interface LockState {
  candidates: LockEntry[];
  leases: LockEntry[];
}

function errnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function sleepSync(milliseconds: number): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleeper, 0, 0, milliseconds);
}

function pidIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // ESRCH is the only conclusive dead result. EPERM and every unknown
    // failure are treated as alive so a live owner is never reclaimed.
    return errnoCode(error) === 'ESRCH';
  }
}

export function syncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is unavailable on some supported filesystems.
  }
}

export function writeAtomic(filePath: string, content: string): void {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporaryPath, 'wx');
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporaryPath, filePath);
    syncDirectory(parent);
  } finally {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // A failed temporary-file cleanup cannot invalidate the target.
    }
  }
}

export function normalizeLockOptions(
  partialOptions: Partial<MarketplaceLockOptions>,
): MarketplaceLockOptions {
  const options = { ...DEFAULT_LOCK_OPTIONS, ...partialOptions };
  if (
    !Number.isFinite(options.staleMs) ||
    !Number.isFinite(options.timeoutMs) ||
    !Number.isFinite(options.retryMs) ||
    options.staleMs <= 0 ||
    options.timeoutMs < 0 ||
    options.retryMs <= 0
  ) {
    throw new MarketplaceValidationError(
      'Marketplace lock timing requires finite positive stale and retry intervals; timeout must be non-negative',
    );
  }
  return {
    staleMs: options.staleMs,
    timeoutMs: options.timeoutMs,
    retryMs: options.retryMs,
  };
}

function lockEntryName(
  pid: number,
  uuid: string,
  kind: LockEntry['kind'],
): string {
  return `${pid}.${uuid}.${kind}`;
}

function parseEntryName(
  name: string,
): Pick<LockEntry, 'kind' | 'pid' | 'uuid'> | undefined {
  const match = ENTRY_PATTERN.exec(name);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid)) return undefined;
  return {
    pid,
    uuid: match[2],
    kind: match[3] as LockEntry['kind'],
  };
}

function scanLockDirectory(lockDir: string): LockState {
  let names: string[];
  try {
    names = fs.readdirSync(lockDir);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return { candidates: [], leases: [] };
    }
    throw new MarketplaceLockfileError(
      `Unable to read marketplace lock directory: ${String(error)}`,
    );
  }

  const state: LockState = { candidates: [], leases: [] };
  for (const name of names) {
    const parsed = parseEntryName(name);
    if (!parsed) {
      throw new MarketplaceLockfileError(
        `Malformed marketplace lock entry: ${name}`,
      );
    }
    const entryPath = path.join(lockDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entryPath);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        throw new RestartDirectoryScan();
      }
      throw new MarketplaceLockfileError(
        `Unable to inspect marketplace lock entry ${name}: ${String(error)}`,
      );
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0) {
      throw new MarketplaceLockfileError(
        `Marketplace lock entry is not an empty regular file: ${name}`,
      );
    }
    const entry: LockEntry = {
      ...parsed,
      name,
      path: entryPath,
      mtimeMs: stat.mtimeMs,
    };
    state[entry.kind === 'candidate' ? 'candidates' : 'leases'].push(entry);
  }
  return state;
}

function readLockDirectory(lockDir: string): LockState {
  for (let attempt = 0; attempt < MAX_SCAN_RETRIES; attempt++) {
    try {
      return scanLockDirectory(lockDir);
    } catch (error) {
      if (!(error instanceof RestartDirectoryScan)) throw error;
    }
  }
  throw new MarketplaceLockfileError(
    'Marketplace lock directory changed during every scan attempt',
  );
}

function unlinkExact(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
    syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return;
    throw error;
  }
}

function cleanupAgedEntries(lockDir: string, staleMs: number): LockState {
  const state = readLockDirectory(lockDir);
  const now = Date.now();
  for (const candidate of state.candidates) {
    if (now - candidate.mtimeMs > staleMs) unlinkExact(candidate.path);
  }
  for (const lease of state.leases) {
    if (now - lease.mtimeMs > staleMs && pidIsDead(lease.pid)) {
      unlinkExact(lease.path);
    }
  }
  return readLockDirectory(lockDir);
}

function createCandidate(
  lockDir: string,
  afterCandidateCreated?: (candidatePath: string) => void,
): LockEntry {
  const uuid = randomUUID();
  const pid = process.pid;
  const name = lockEntryName(pid, uuid, 'candidate');
  const candidate: LockEntry = {
    kind: 'candidate',
    name,
    path: path.join(lockDir, name),
    pid,
    uuid,
    mtimeMs: Date.now(),
  };
  const fd = fs.openSync(candidate.path, 'wx', 0o600);
  fs.closeSync(fd);
  syncDirectory(lockDir);
  afterCandidateCreated?.(candidate.path);
  return candidate;
}

function candidateToLease(candidate: LockEntry): LockEntry {
  const name = lockEntryName(candidate.pid, candidate.uuid, 'lease');
  return {
    ...candidate,
    kind: 'lease',
    name,
    path: path.join(path.dirname(candidate.path), name),
  };
}

function acquireOnce(
  lockDir: string,
  options: MarketplaceLockOptions,
  hooks: MarketplaceLeaseTestHooks,
): LockEntry | undefined {
  const candidate = createCandidate(lockDir, hooks.afterCandidateCreated);
  const ownLease = candidateToLease(candidate);
  try {
    const electedState = cleanupAgedEntries(lockDir, options.staleMs);
    const elected = electedState.candidates;
    elected.sort((left, right) => left.name.localeCompare(right.name));
    if (
      electedState.leases.length !== 0 ||
      elected.length !== 1 ||
      elected[0]?.path !== candidate.path
    ) {
      unlinkExact(candidate.path);
      return undefined;
    }

    try {
      fs.renameSync(candidate.path, ownLease.path);
      syncDirectory(lockDir);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return undefined;
      throw new MarketplaceLockfileError(
        `Unable to publish marketplace lease: ${String(error)}`,
      );
    }

    const finalState = readLockDirectory(lockDir);
    if (
      finalState.leases.length !== 1 ||
      finalState.leases[0]?.path !== ownLease.path
    ) {
      unlinkExact(ownLease.path);
      throw new MarketplaceLockfileError(
        'Ambiguous marketplace lock state after lease publication',
      );
    }
    return finalState.leases[0];
  } catch (error) {
    try {
      if (fs.existsSync(candidate.path)) unlinkExact(candidate.path);
    } catch {
      // The original acquisition error is authoritative.
    }
    throw error;
  }
}

function exactLeaseExists(lease: LockEntry): boolean {
  try {
    const stat = fs.lstatSync(lease.path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === 0;
  } catch {
    return false;
  }
}

function createLease(lockDir: string, leaseEntry: LockEntry): MarketplaceLease {
  let status: 'owned' | 'released' | 'lost' = 'owned';

  const lost = (): MarketplaceLockOwnershipError => {
    status = 'lost';
    return new MarketplaceLockOwnershipError(
      'Marketplace lease ownership is no longer current',
    );
  };

  const assertCurrent = (): void => {
    if (status !== 'owned') throw lost();
    const state = readLockDirectory(lockDir);
    if (
      state.leases.length !== 1 ||
      state.leases[0]?.path !== leaseEntry.path ||
      !exactLeaseExists(leaseEntry)
    ) {
      throw lost();
    }
  };

  const release = (): void => {
    if (status !== 'owned') throw lost();
    try {
      fs.unlinkSync(leaseEntry.path);
      syncDirectory(lockDir);
      status = 'released';
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') throw lost();
      if (exactLeaseExists(leaseEntry)) throw error;
      throw lost();
    }
  };

  return {
    assertCurrent,
    commit<T>(operation: () => T): T {
      assertCurrent();
      return operation();
    },
    release,
  };
}

function acquireMarketplaceLeaseInternal(
  paths: MarketplacePaths,
  partialOptions: Partial<MarketplaceLockOptions> = {},
  hooks: MarketplaceLeaseTestHooks = {},
): MarketplaceLease {
  const options = normalizeLockOptions(partialOptions);
  fs.mkdirSync(paths.rootDir, { recursive: true });
  fs.mkdirSync(paths.lockDir, { recursive: true });
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() <= deadline) {
    const lease = acquireOnce(paths.lockDir, options, hooks);
    if (lease) return createLease(paths.lockDir, lease);
    if (Date.now() + options.retryMs > deadline) break;
    sleepSync(options.retryMs);
  }
  throw new MarketplaceBusyError('Timed out waiting for marketplace lock');
}

export function acquireMarketplaceLease(
  paths: MarketplacePaths,
  partialOptions: Partial<MarketplaceLockOptions> = {},
  hooks: MarketplaceLeaseTestHooks = {},
): MarketplaceLease {
  return acquireMarketplaceLeaseInternal(paths, partialOptions, hooks);
}

export function withMarketplaceLease<T>(
  paths: MarketplacePaths,
  operation: (lease: MarketplaceLease) => T,
  options: Partial<MarketplaceLockOptions>,
): T {
  const lock = acquireMarketplaceLease(paths, options);
  try {
    return operation(lock);
  } finally {
    lock.release();
  }
}
