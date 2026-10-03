/**
 * Per-location event scope for the server-side event hook.
 *
 * `opencode` loads this plugin once per location (directory) inside a single
 * server process and broadcasts every event to every instance. Without a
 * scope each instance processes the whole process's stream: N times the hook
 * work, N times the log lines, and other locations' sessions written into
 * per-instance stores. This scope drops an event only when it provably
 * belongs to another directory that still has a live instance; anything
 * unresolved is processed (fail-open), so the filter can only remove work,
 * never events that would otherwise be handled.
 *
 * On v2 hosts the same directory is claimed twice (once in the v1 factory and
 * once in the v2 setup) and both claims are released on teardown, so the
 * refcount stays balanced.
 */
import { getGlobalStore } from './global-store';

const LIVE_DIRECTORIES_KEY = 'oh-my-opencode-slim.live-directories';
const MAX_TRACKED_SESSIONS = 512;

/** Trim trailing separators so `/a/b` and `/a/b/` compare equal. */
export function normalizeScopeDirectory(directory: string): string {
  return directory.replace(/[\\/]+$/, '') || directory;
}

/** How many plugin instances (any generation) currently serve each directory. */
function liveDirectories(): Map<string, number> {
  return getGlobalStore<Map<string, number>>(
    LIVE_DIRECTORIES_KEY,
    () => new Map<string, number>(),
  );
}

function hasLiveInstance(directory: string): boolean {
  return (liveDirectories().get(directory) ?? 0) > 0;
}

/** True while at least one plugin instance (any location) is live. */
export function hasLiveInstances(): boolean {
  return liveDirectories().size > 0;
}

/** Test seam: forget every live-directory claim. */
export function resetLiveDirectoriesForTests(): void {
  liveDirectories().clear();
}

export interface EventDirectoryScope {
  /** Record the session→directory signal an event carries. */
  note(event: unknown): void;
  /** True when the event provably belongs to another live directory. */
  isForeign(event: unknown): boolean;
  /** Release this instance's live-directory claim (call from dispose). */
  release(): void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Directory carried by an event: v1 `properties.info.directory` (session
 * creation) or the v2 envelope `location.directory`. */
function readDirectory(event: unknown): string | undefined {
  const record = asRecord(event);
  const properties = asRecord(record?.properties);
  const fromV1 = asString(asRecord(properties?.info)?.directory);
  if (fromV1) return fromV1;
  const fromEnvelope = asString(asRecord(record?.location)?.directory);
  if (fromEnvelope) return fromEnvelope;
  const fromData = asString(
    asRecord(asRecord(record?.data)?.location)?.directory,
  );
  return fromData;
}

function readSessionID(event: unknown): string | undefined {
  const record = asRecord(event);
  const properties = asRecord(record?.properties);
  const info = asRecord(properties?.info);
  const fromV1 =
    asString(info?.sessionID) ??
    asString(info?.id) ??
    asString(properties?.sessionID);
  if (fromV1) return fromV1;
  const data = asRecord(record?.data);
  return asString(data?.sessionID) ?? asString(record?.sessionID);
}

export function createEventDirectoryScope(
  ownDirectory: string,
): EventDirectoryScope {
  const own = normalizeScopeDirectory(ownDirectory);
  const sessionDirectories = new Map<string, string>();
  const order: string[] = [];

  const live = liveDirectories();
  live.set(own, (live.get(own) ?? 0) + 1);
  let released = false;

  const remember = (sessionID: string, directory: string): void => {
    const existing = order.indexOf(sessionID);
    if (existing >= 0) order.splice(existing, 1);
    sessionDirectories.set(sessionID, directory);
    order.push(sessionID);
    while (order.length > MAX_TRACKED_SESSIONS) {
      const oldest = order.shift();
      if (oldest) sessionDirectories.delete(oldest);
    }
  };

  return {
    note(event) {
      const directory = readDirectory(event);
      if (!directory) return;
      const sessionID = readSessionID(event);
      if (sessionID) remember(sessionID, normalizeScopeDirectory(directory));
    },
    isForeign(event) {
      const sessionID = readSessionID(event);
      const directory =
        readDirectory(event) ??
        (sessionID ? sessionDirectories.get(sessionID) : undefined);
      if (!directory) return false;
      const key = normalizeScopeDirectory(directory);
      if (key === own) return false;
      return hasLiveInstance(key);
    },
    release() {
      if (released) return;
      released = true;
      const count = (live.get(own) ?? 1) - 1;
      if (count <= 0) live.delete(own);
      else live.set(own, count);
    },
  };
}
