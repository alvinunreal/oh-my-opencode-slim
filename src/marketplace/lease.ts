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
  heartbeatMs: number;
  retryMs: number;
}

export interface MarketplaceLease {
  generation: string;
  token: string;
  assertCurrent(): void;
  commit<T>(operation: () => T): T;
  release(): void;
}

export interface LeaseIdentity {
  generation: string;
  token: string;
}

export interface LeaseMetadata extends LeaseIdentity {
  pid: number;
}

export interface LeaseState {
  metadata: LeaseMetadata;
  heartbeatMtimeMs: number;
}

const DEFAULT_LOCK_OPTIONS: MarketplaceLockOptions = {
  staleMs: 60_000,
  timeoutMs: 300_000,
  heartbeatMs: 20_000,
  retryMs: 20,
};

function lockNow(now?: () => number): number {
  return now?.() ?? Date.now();
}

const OWNERSHIP_MESSAGE =
  'Marketplace lease generation is no longer fresh and current';

const CREATING_PREFIX = '.creating.';

interface BreakerLease {
  release(): void;
}

function errnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
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
      // A failed cleanup cannot make the published file invalid.
    }
  }
}

function sleepSync(milliseconds: number): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleeper, 0, 0, milliseconds);
}

function testBarrier(point: string): void {
  const dir = process.env.MARKETPLACE_LEASE_BARRIER_DIR;
  if (!dir) return;
  const waitPath = path.join(dir, `${point}.wait`);
  try {
    fs.statSync(waitPath);
  } catch {
    return;
  }
  writeAtomic(path.join(dir, `${point}.reached`), `${process.pid}\n`);
  const goPath = path.join(dir, `${point}.go`);
  while (true) {
    try {
      fs.statSync(goPath);
      return;
    } catch {
      sleepSync(10);
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
    !Number.isFinite(options.heartbeatMs) ||
    !Number.isFinite(options.retryMs) ||
    options.staleMs <= 0 ||
    options.timeoutMs < 0 ||
    options.heartbeatMs <= 0 ||
    options.retryMs <= 0 ||
    options.heartbeatMs >= options.staleMs
  ) {
    throw new MarketplaceValidationError(
      'Marketplace lock timing requires finite positive stale, heartbeat, and retry intervals; timeout must be non-negative and heartbeat must be shorter than stale timeout',
    );
  }
  return {
    staleMs: options.staleMs,
    timeoutMs: options.timeoutMs,
    heartbeatMs: options.heartbeatMs,
    retryMs: options.retryMs,
  };
}

export function generationsRoot(directory: string): string {
  return path.join(directory, 'gen');
}

export function generationPath(directory: string, generation: string): string {
  return path.join(directory, 'gen', generation);
}

export function heartbeatPath(directory: string, generation: string): string {
  return path.join(generationPath(directory, generation), 'heartbeat');
}

function readLeaseMetadata(directory: string): LeaseMetadata | undefined {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(directory, 'meta.json'), 'utf8'),
    ) as Partial<LeaseMetadata>;
    if (
      !Number.isInteger(value.pid) ||
      typeof value.generation !== 'string' ||
      value.generation.length === 0 ||
      typeof value.token !== 'string' ||
      value.token.length === 0
    ) {
      return undefined;
    }
    return value as LeaseMetadata;
  } catch {
    return undefined;
  }
}

export function readGenerationState(
  generationDirectory: string,
): LeaseState | undefined {
  const metadata = readLeaseMetadata(generationDirectory);
  if (!metadata) return undefined;
  try {
    const heartbeat = fs.statSync(path.join(generationDirectory, 'heartbeat'));
    if (!heartbeat.isFile()) return undefined;
    if (path.basename(generationDirectory) !== metadata.generation) {
      return undefined;
    }
    return { metadata, heartbeatMtimeMs: heartbeat.mtimeMs };
  } catch {
    return undefined;
  }
}

export function listValidGenerations(directory: string): LeaseState[] {
  const root = generationsRoot(directory);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  }
  const states: LeaseState[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const state = readGenerationState(path.join(root, entry.name));
    if (state) states.push(state);
  }
  return states;
}

export function readLeaseState(directory: string): LeaseState | undefined {
  const gens = listValidGenerations(directory);
  if (gens.length !== 1) return undefined;
  return gens[0];
}

function sameLease(
  left: LeaseIdentity | undefined,
  right: LeaseIdentity,
): boolean {
  return Boolean(
    left && left.generation === right.generation && left.token === right.token,
  );
}

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isHeartbeatStale(
  state: LeaseState,
  staleMs: number,
  nowMs = Date.now(),
): boolean {
  return nowMs - state.heartbeatMtimeMs > staleMs;
}

function breakerIsAbandoned(
  state: LeaseState,
  staleMs: number,
  nowMs: number,
): boolean {
  return (
    isHeartbeatStale(state, staleMs, nowMs) &&
    !processIsAlive(state.metadata.pid)
  );
}

function creatingPid(name: string): number | undefined {
  if (!name.startsWith(CREATING_PREFIX)) return undefined;
  const pid = Number(name.slice(CREATING_PREFIX.length).split('.')[0]);
  return Number.isInteger(pid) ? pid : undefined;
}

function isAbandonedCreating(
  fullPath: string,
  name: string,
  staleMs: number,
  nowMs: number,
): boolean {
  const pid = creatingPid(name);
  if (pid === undefined) return false;
  if (!processIsAlive(pid)) return true;
  try {
    return nowMs - fs.statSync(fullPath).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function cleanAbandonedCreating(
  directory: string,
  staleMs: number,
  nowMs: number,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(directory, entry.name);
    if (isAbandonedCreating(fullPath, entry.name, staleMs, nowMs)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }
}

function cleanAbandonedArtifacts(
  directory: string,
  staleMs: number,
  nowMs: number,
): void {
  fs.mkdirSync(directory, { recursive: true });
  cleanAbandonedCreating(directory, staleMs, nowMs);
  cleanAbandonedCreating(generationsRoot(directory), staleMs, nowMs);
}

/**
 * Delete only `gen/<expected.generation>` after an in-place identity check.
 * A replacement lives at a different path and cannot be targeted.
 */
function deleteExpectedGeneration(
  directory: string,
  expected: LeaseIdentity,
): boolean {
  const target = generationPath(directory, expected.generation);
  if (!sameLease(readGenerationState(target)?.metadata, expected)) {
    return false;
  }
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

function deleteStaleGeneration(
  directory: string,
  expected: LeaseIdentity,
  staleMs: number,
  requireDeadPid: boolean,
  nowMs: number,
): boolean {
  const target = generationPath(directory, expected.generation);
  const state = readGenerationState(target);
  if (!sameLease(state?.metadata, expected) || !state) return false;
  if (!isHeartbeatStale(state, staleMs, nowMs)) return false;
  if (requireDeadPid && processIsAlive(state.metadata.pid)) return false;
  const again = readGenerationState(target);
  if (!sameLease(again?.metadata, expected) || !again) return false;
  if (!isHeartbeatStale(again, staleMs, nowMs)) return false;
  if (requireDeadPid && processIsAlive(again.metadata.pid)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

function prepareGeneration(directory: string, identity: LeaseIdentity): string {
  fs.mkdirSync(generationsRoot(directory), { recursive: true });
  const privateDirectory = path.join(
    directory,
    `${CREATING_PREFIX}${process.pid}.${randomUUID()}`,
  );
  fs.mkdirSync(privateDirectory, { recursive: false, mode: 0o700 });
  testBarrier('prepare-generation');
  try {
    writeAtomic(
      path.join(privateDirectory, 'meta.json'),
      `${JSON.stringify({ ...identity, pid: process.pid })}\n`,
    );
    writeAtomic(path.join(privateDirectory, 'heartbeat'), '');
    syncDirectory(privateDirectory);
    return privateDirectory;
  } catch {
    fs.rmSync(privateDirectory, { recursive: true, force: true });
    throw new MarketplaceLockfileError(
      'Failed to initialize a private marketplace lease generation',
    );
  }
}

function publishPreparedGeneration(
  privateDirectory: string,
  directory: string,
  generation: string,
): boolean {
  const dest = generationPath(directory, generation);
  try {
    fs.renameSync(privateDirectory, dest);
    syncDirectory(generationsRoot(directory));
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EISDIR') {
      return false;
    }
    throw error;
  } finally {
    try {
      if (fs.existsSync(privateDirectory)) {
        fs.rmSync(privateDirectory, { recursive: true, force: true });
      }
    } catch {
      // An unpublished private generation is never an active lease.
    }
  }
}

export function publishGeneration(
  directory: string,
  identity: LeaseIdentity,
): boolean {
  const privateDirectory = prepareGeneration(directory, identity);
  return publishPreparedGeneration(
    privateDirectory,
    directory,
    identity.generation,
  );
}

function assertFreshAndCurrent(
  directory: string,
  identity: LeaseIdentity,
  staleMs: number,
  nowMs: number,
): void {
  const state = readGenerationState(
    generationPath(directory, identity.generation),
  );
  if (
    !sameLease(state?.metadata, identity) ||
    !state ||
    isHeartbeatStale(state, staleMs, nowMs)
  ) {
    throw new MarketplaceLockOwnershipError(OWNERSHIP_MESSAGE);
  }
}

function assertCurrentIdentity(
  directory: string,
  identity: LeaseIdentity,
): void {
  if (
    !sameLease(
      readGenerationState(generationPath(directory, identity.generation))
        ?.metadata,
      identity,
    )
  ) {
    throw new MarketplaceLockOwnershipError(OWNERSHIP_MESSAGE);
  }
}

function touchHeartbeat(directory: string, identity: LeaseIdentity): void {
  try {
    const now = new Date();
    fs.utimesSync(heartbeatPath(directory, identity.generation), now, now);
  } catch {
    throw new MarketplaceLockOwnershipError(OWNERSHIP_MESSAGE);
  }
}

function startHeartbeat(
  directory: string,
  identity: LeaseIdentity,
  heartbeatMs: number,
): ReturnType<typeof setInterval> {
  const beat = () => {
    try {
      const now = new Date();
      fs.utimesSync(heartbeatPath(directory, identity.generation), now, now);
    } catch {
      // Release and commit perform authoritative ownership checks.
    }
  };
  beat();
  const timer = setInterval(beat, heartbeatMs);
  timer.unref?.();
  return timer;
}

function newIdentity(): LeaseIdentity {
  return {
    generation: randomUUID(),
    token: `${process.pid}:${randomUUID()}`,
  };
}

function acquireBreakerLease(
  paths: MarketplacePaths,
  options: MarketplaceLockOptions,
  now?: () => number,
): BreakerLease {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() <= deadline) {
    const nowMs = lockNow(now);
    cleanAbandonedArtifacts(paths.breakerDir, options.staleMs, nowMs);
    for (const state of listValidGenerations(paths.breakerDir)) {
      if (breakerIsAbandoned(state, options.staleMs, nowMs)) {
        deleteStaleGeneration(
          paths.breakerDir,
          state.metadata,
          options.staleMs,
          true,
          nowMs,
        );
      }
    }
    const live = listValidGenerations(paths.breakerDir).filter(
      (state) => !breakerIsAbandoned(state, options.staleMs, nowMs),
    );
    if (live.length > 0) {
      sleepSync(options.retryMs);
      continue;
    }
    const identity = newIdentity();
    if (!publishGeneration(paths.breakerDir, identity)) {
      sleepSync(options.retryMs);
      continue;
    }
    testBarrier('breaker-critical');
    const others = listValidGenerations(paths.breakerDir).filter(
      (state) => state.metadata.generation !== identity.generation,
    );
    if (others.length > 0) {
      deleteExpectedGeneration(paths.breakerDir, identity);
      sleepSync(options.retryMs);
      continue;
    }
    const heartbeatTimer = startHeartbeat(
      paths.breakerDir,
      identity,
      options.heartbeatMs,
    );
    return {
      release: () => {
        clearInterval(heartbeatTimer);
        if (!deleteExpectedGeneration(paths.breakerDir, identity)) {
          throw new MarketplaceLockOwnershipError(
            'Refusing to release a compromised marketplace breaker',
          );
        }
      },
    };
  }
  throw new MarketplaceBusyError('Timed out waiting for marketplace breaker');
}

function createMarketplaceLease(
  paths: MarketplacePaths,
  identity: LeaseIdentity,
  options: MarketplaceLockOptions,
  now?: () => number,
): MarketplaceLease {
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const assertCurrent = () => {
    assertFreshAndCurrent(
      paths.lockDir,
      identity,
      options.staleMs,
      lockNow(now),
    );
  };
  const release = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const breaker = acquireBreakerLease(paths, options, now);
    try {
      if (!deleteExpectedGeneration(paths.lockDir, identity)) {
        throw new MarketplaceLockOwnershipError(
          'Refusing to release a compromised marketplace lock',
        );
      }
    } finally {
      breaker.release();
    }
  };
  heartbeatTimer = startHeartbeat(paths.lockDir, identity, options.heartbeatMs);
  return {
    ...identity,
    assertCurrent,
    commit: <T>(operation: () => T): T => {
      const breaker = acquireBreakerLease(paths, options, now);
      try {
        assertCurrent();
        touchHeartbeat(paths.lockDir, identity);
        const result = operation();
        assertCurrentIdentity(paths.lockDir, identity);
        touchHeartbeat(paths.lockDir, identity);
        return result;
      } finally {
        breaker.release();
      }
    },
    release,
  };
}

function acquireMarketplaceLeaseInternal(
  paths: MarketplacePaths,
  partialOptions: Partial<MarketplaceLockOptions> = {},
  now?: () => number,
): MarketplaceLease {
  const options = normalizeLockOptions(partialOptions);
  fs.mkdirSync(paths.rootDir, { recursive: true });
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() <= deadline) {
    let breaker: BreakerLease | undefined;
    try {
      breaker = acquireBreakerLease(
        paths,
        {
          ...options,
          timeoutMs: Math.max(0, deadline - Date.now()),
        },
        now,
      );
      const nowMs = lockNow(now);
      cleanAbandonedArtifacts(paths.lockDir, options.staleMs, nowMs);
      for (const state of listValidGenerations(paths.lockDir)) {
        if (isHeartbeatStale(state, options.staleMs, nowMs)) {
          deleteStaleGeneration(
            paths.lockDir,
            state.metadata,
            options.staleMs,
            false,
            nowMs,
          );
        }
      }
      const live = listValidGenerations(paths.lockDir).filter(
        (state) => !isHeartbeatStale(state, options.staleMs, nowMs),
      );
      if (live.length === 0) {
        const identity = newIdentity();
        if (publishGeneration(paths.lockDir, identity)) {
          const lease = createMarketplaceLease(paths, identity, options, now);
          breaker.release();
          breaker = undefined;
          return lease;
        }
      }
    } catch (error) {
      if (!(error instanceof MarketplaceBusyError)) throw error;
    } finally {
      breaker?.release();
    }
    if (Date.now() + options.retryMs > deadline) break;
    sleepSync(options.retryMs);
  }
  throw new MarketplaceBusyError('Timed out waiting for marketplace lock');
}

export function acquireMarketplaceLease(
  paths: MarketplacePaths,
  partialOptions: Partial<MarketplaceLockOptions> = {},
): MarketplaceLease {
  return acquireMarketplaceLeaseInternal(paths, partialOptions);
}

/** Test-only clock seam. Production store/lock options cannot pass `now`. */
export function acquireMarketplaceLeaseForTests(
  paths: MarketplacePaths,
  partialOptions: Partial<MarketplaceLockOptions>,
  now: () => number,
): MarketplaceLease {
  return acquireMarketplaceLeaseInternal(paths, partialOptions, now);
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
