import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../../config/paths';
import { writeAtomic } from '../../marketplace/lease';
import { log } from '../../utils/logger';
import { acquirePidFileLockWithRetryAsync } from '../../utils/pid-file-lock';

const FILE_NAME = 'omos-quota-cooldowns.json';
const STORE_VERSION = 1;
const MAX_ENTRIES = 256;
const MAX_STORE_BYTES = 64 * 1024;
const MAX_DATE_MS = 8_640_000_000_000_000;
const LOCK_TIMEOUT_MS = 250;

type QuotaCooldownStore = {
  version: 1;
  entries: Record<string, number>;
};

export type QuotaCooldownWriteOptions = {
  /** Test seam; production callers use the configured OpenCode directory. */
  filePath?: string;
  /** Test seam for the shared lock helper's bounded-contention path. */
  lockTimeoutMs?: number;
};

export function quotaModelKey(
  providerID: string,
  modelID: string,
): string | undefined {
  if (
    !providerID ||
    providerID.trim() !== providerID ||
    !modelID ||
    modelID.trim() !== modelID
  ) {
    return undefined;
  }
  return JSON.stringify([providerID, modelID]);
}

function defaultFilePath(): string {
  return join(getConfigDir(), FILE_NAME);
}

function errnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return;
  return typeof error.code === 'string' ? error.code : undefined;
}

function validDeadline(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_DATE_MS
  );
}

function readEntries(filePath: string): Map<string, number> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return new Map();
    throw error;
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_STORE_BYTES)
    throw new Error('quota cooldown store exceeds its size bound');

  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).version !== STORE_VERSION
  ) {
    throw new Error('quota cooldown store has an unsupported shape');
  }
  const source = (parsed as Record<string, unknown>).entries;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('quota cooldown store entries are malformed');
  }
  const items = Object.entries(source as Record<string, unknown>);
  if (items.length > MAX_ENTRIES)
    throw new Error('quota cooldown store exceeds its entry bound');

  const entries = new Map<string, number>();
  for (const [key, expiresAt] of items) {
    if (!key || !validDeadline(expiresAt)) {
      throw new Error('quota cooldown store contains an invalid entry');
    }
    entries.set(key, expiresAt);
  }
  return entries;
}

function logStoreFailure(operation: string, filePath: string, error: unknown) {
  log(`[quota-cooldown] ${operation} failed; preserving host behavior`, {
    filePath,
    error: String(error),
  });
}

/** Fresh disk read on every lookup; no process cache can mask an explicit clear. */
export function getCoolingQuotaModelKeys(
  now = Date.now(),
  filePath = defaultFilePath(),
): ReadonlySet<string> {
  if (!Number.isFinite(now)) return new Set();
  try {
    const cooled = new Set<string>();
    for (const [key, expiresAt] of readEntries(filePath)) {
      if (expiresAt > now) cooled.add(key);
    }
    return cooled;
  } catch (error) {
    logStoreFailure('read', filePath, error);
    return new Set();
  }
}

export function isQuotaModelCooling(
  providerID: string,
  modelID: string,
  now = Date.now(),
  filePath = defaultFilePath(),
): boolean {
  const key = quotaModelKey(providerID, modelID);
  return key !== undefined && getCoolingQuotaModelKeys(now, filePath).has(key);
}

/**
 * Merge a single confirmed reset into the versioned file. The deadline is
 * calculated once before lock acquisition and is never extended by reads.
 */
export async function recordQuotaCooldown(
  providerID: string,
  modelID: string,
  resetAfterMs: number,
  now = Date.now(),
  options: QuotaCooldownWriteOptions = {},
): Promise<boolean> {
  const key = quotaModelKey(providerID, modelID);
  if (
    key === undefined ||
    !Number.isFinite(now) ||
    !Number.isFinite(resetAfterMs) ||
    resetAfterMs <= 0
  ) {
    return false;
  }
  const expiresAt = now + resetAfterMs;
  if (!validDeadline(expiresAt) || expiresAt <= now) return false;

  const filePath = options.filePath ?? defaultFilePath();
  let release: Awaited<ReturnType<typeof acquirePidFileLockWithRetryAsync>>;
  try {
    release = await acquirePidFileLockWithRetryAsync(
      filePath,
      options.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
    );
  } catch (error) {
    logStoreFailure('lock', filePath, error);
    return false;
  }
  if (!release) {
    log('[quota-cooldown] bounded lock contention; preserving host behavior', {
      filePath,
    });
    return false;
  }

  try {
    if (!release.isOwned()) {
      log('[quota-cooldown] lock ownership lost; preserving host behavior', {
        filePath,
      });
      return false;
    }
    const entries = readEntries(filePath);
    for (const [existingKey, existingExpiry] of entries) {
      if (existingExpiry <= now) entries.delete(existingKey);
    }
    if (!entries.has(key) && entries.size >= MAX_ENTRIES) {
      log('[quota-cooldown] entry bound reached; preserving host behavior', {
        filePath,
      });
      return false;
    }
    entries.set(key, expiresAt);
    if (!release.isOwned()) {
      log('[quota-cooldown] lock ownership lost; preserving host behavior', {
        filePath,
      });
      return false;
    }
    const store: QuotaCooldownStore = {
      version: STORE_VERSION,
      entries: Object.fromEntries(entries),
    };
    const serialized = `${JSON.stringify(store, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) {
      log('[quota-cooldown] serialized store exceeds its size bound', {
        filePath,
      });
      return false;
    }
    writeAtomic(filePath, serialized);
    return true;
  } catch (error) {
    logStoreFailure('write', filePath, error);
    return false;
  } finally {
    try {
      release();
    } catch (error) {
      logStoreFailure('lock release', filePath, error);
    }
  }
}
