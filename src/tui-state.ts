import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Per-session metadata projection for the clickable sidebar. Entries only
 * exist for sessions present in `activeSessions`; they never activate a
 * session by themselves. The key is always the full sessionID — never an
 * alias — and the parent link lives exclusively in `sessionParents`.
 */
export interface TuiSessionDetails {
  alias?: string;
  /** providerID/modelID observed for this specific session. */
  model?: string;
  status?: 'busy' | 'retry';
}

export interface TuiSnapshot {
  version: 1;
  updatedAt: number;
  agentModels: Record<string, string>;
  agentVariants: Record<string, string>;
  activeSessions: Record<string, string>;
  /**
   * Recording process per activity; used to sweep crash residue.
   */
  activityPids: Record<string, number>;
  /**
   * Persistent child→parent index for the project, independent of live
   * activities. The single authority for scoping: both the visible route
   * session and every active session resolve their conversation root
   * against this same index at render time (#1147), so a late-learned
   * link re-roots everything consistently. Shared v2 daemons record
   * activities for every window from one process, so process identity
   * cannot scope the sidebar; the session tree can.
   */
  sessionParents: Record<string, string>;
  /** Per-active-session details (alias/model/status) for the sidebar. */
  sessionDetails: Record<string, TuiSessionDetails>;
}

const STATE_DIR = 'oh-my-opencode-slim';
const STATE_FILE = 'tui-state.json';
const STATE_LOCK_RETRY_MS = 5;
const STATE_LOCK_TIMEOUT_MS = 1_000;
const STATE_LOCK_STALE_MS = 30_000;
const STATE_LOCK_SLEEPER = new Int32Array(new SharedArrayBuffer(4));

interface TuiStateLock {
  path: string;
  token: string;
}

function dataDir(): string {
  return (
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share')
  );
}

// ponytail: per-project scope prevents /model overrides from leaking across projects
function projectScope(projectDir: string): string {
  return createHash('sha256')
    .update(path.resolve(projectDir))
    .digest('hex')
    .slice(0, 12);
}

export function getTuiStatePath(projectDir: string): string {
  return path.join(
    dataDir(),
    'opencode',
    'storage',
    STATE_DIR,
    projectScope(projectDir),
    STATE_FILE,
  );
}

function emptySnapshot(): TuiSnapshot {
  return {
    version: 1,
    updatedAt: Date.now(),
    agentModels: {},
    agentVariants: {},
    activeSessions: {},
    activityPids: {},
    sessionParents: {},
    sessionDetails: {},
  };
}

function parseStringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function parsePidRecord(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && entry > 0) out[key] = entry;
  }
  return out;
}

function parseSessionDetails(
  value: unknown,
): Record<string, TuiSessionDetails> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, TuiSessionDetails> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object') continue;
    const rec = entry as { alias?: unknown; model?: unknown; status?: unknown };
    const details: TuiSessionDetails = {};
    if (typeof rec.alias === 'string') details.alias = rec.alias;
    if (typeof rec.model === 'string') details.model = rec.model;
    if (rec.status === 'busy' || rec.status === 'retry') {
      details.status = rec.status;
    }
    if (Object.keys(details).length > 0) out[key] = details;
  }
  return out;
}

function parseSnapshot(value: string): TuiSnapshot {
  const parsed = JSON.parse(value) as Partial<TuiSnapshot> | undefined;
  if (parsed?.version !== 1) return emptySnapshot();

  return {
    version: 1,
    updatedAt:
      typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    agentModels: parsed.agentModels ?? {},
    agentVariants: parsed.agentVariants ?? {},
    activeSessions: parsed.activeSessions ?? {},
    activityPids: parsePidRecord(parsed.activityPids),
    sessionParents: parseStringRecord(parsed.sessionParents),
    sessionDetails: parseSessionDetails(parsed.sessionDetails),
  };
}

export function readTuiSnapshot(projectDir: string): TuiSnapshot {
  try {
    return parseSnapshot(fs.readFileSync(getTuiStatePath(projectDir), 'utf8'));
  } catch {
    return emptySnapshot();
  }
}

// Locked-path reader: ENOENT is a first write; any other error must not
// seed the memo (a fallback empty snapshot would swallow later retries).
function readTuiSnapshotStrict(statePath: string): TuiSnapshot | null {
  try {
    return parseSnapshot(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptySnapshot();
    }
    return null;
  }
}

// Stat-based read cache for the polling TUI refresh (1/s per window).
// Writers publish via tmp+rename, so a changed write normally has a new
// dev/ino. Include ctimeMs as well because an external in-place rewrite can
// preserve the inode, size, and mtime while still changing the contents.
// Cache misses fall through to a normal read; any stat/read failure bypasses
// the cache entirely.
// Bounded LRU: a long-lived daemon polling many projects must not
// retain a snapshot per visited path.
const ASYNC_SNAPSHOT_CACHE_MAX = 8;
const asyncSnapshotCache = new Map<
  string,
  { stat: string; snapshot: TuiSnapshot }
>();

function snapshotStatKey(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
}

function rememberAsyncSnapshot(
  statePath: string,
  statKey: string,
  snapshot: TuiSnapshot,
): void {
  // Map insertion order doubles as the LRU order: re-insert to refresh.
  asyncSnapshotCache.delete(statePath);
  asyncSnapshotCache.set(statePath, { stat: statKey, snapshot });
  while (asyncSnapshotCache.size > ASYNC_SNAPSHOT_CACHE_MAX) {
    const oldest = asyncSnapshotCache.keys().next().value;
    if (oldest === undefined) break;
    asyncSnapshotCache.delete(oldest);
  }
}

export async function readTuiSnapshotAsync(
  projectDir: string,
): Promise<TuiSnapshot> {
  const statePath = getTuiStatePath(projectDir);
  try {
    const stat = await fs.promises.stat(statePath);
    const statKey = snapshotStatKey(stat);
    const cached = asyncSnapshotCache.get(statePath);
    if (cached && cached.stat === statKey) {
      // Refresh LRU position on hit.
      asyncSnapshotCache.delete(statePath);
      asyncSnapshotCache.set(statePath, cached);
      return cached.snapshot;
    }
    const snapshot = parseSnapshot(
      await fs.promises.readFile(statePath, 'utf8'),
    );
    rememberAsyncSnapshot(statePath, statKey, snapshot);
    return snapshot;
  } catch {
    asyncSnapshotCache.delete(statePath);
    return emptySnapshot();
  }
}

function writeTuiSnapshot(snapshot: TuiSnapshot, projectDir: string): boolean {
  try {
    const filePath = getTuiStatePath(projectDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, `${JSON.stringify(snapshot)}\n`);
      fs.renameSync(tmpPath, filePath);
    } finally {
      // Remove temp residue on the failure path; hard crashes are out of
      // reach, and readers only ever open the final file.
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // best-effort
      }
    }
    return true;
  } catch {
    // TUI state is best-effort only.
    return false;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStateLockStale(lockPath: string): boolean {
  try {
    const metadata = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
      pid?: unknown;
    };
    if (typeof metadata.pid === 'number' && metadata.pid > 0) {
      return !isProcessRunning(metadata.pid);
    }
  } catch {
    // A creator may still be writing metadata; use age as fallback.
  }

  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > STATE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function acquireStateLock(statePath: string): TuiStateLock | undefined {
  const lockPath = `${statePath}.lock`;
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const token = randomUUID();
    let created = false;
    try {
      const handle = fs.openSync(lockPath, 'wx');
      created = true;
      try {
        fs.writeFileSync(
          handle,
          JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
        );
      } finally {
        fs.closeSync(handle);
      }
      return { path: lockPath, token };
    } catch (error) {
      if (created) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Best-effort cleanup after lock metadata creation fails.
        }
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return;
      if (isStateLockStale(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Another process may have recovered or released it first.
        }
        continue;
      }
      Atomics.wait(STATE_LOCK_SLEEPER, 0, 0, STATE_LOCK_RETRY_MS);
    }
  }
}

function releaseStateLock(lock: TuiStateLock): void {
  try {
    const metadata = JSON.parse(fs.readFileSync(lock.path, 'utf8')) as {
      token?: unknown;
    };
    if (metadata.token === lock.token) fs.unlinkSync(lock.path);
  } catch {
    // Best-effort state must not crash the plugin during lock cleanup.
  }
}

// Last confirmed on-disk snapshot per project, keyed by identity
// (ino,mtime,size). No-ops return before the lock; failed writes do not
// seed the memo. An identity mismatch (external rename) invalidates it.
const lastKnownSnapshots = new Map<
  string,
  {
    snapshot: TuiSnapshot;
    ino: number;
    mtimeMs: number;
    ctimeMs: number;
    size: number;
  }
>();
const LAST_KNOWN_SNAPSHOTS_MAX = 32;

function statSnapshotFile(statePath: string): {
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
} | null {
  try {
    const stat = fs.statSync(statePath);
    return {
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

function cloneSnapshot(snapshot: TuiSnapshot): TuiSnapshot {
  return {
    version: snapshot.version,
    updatedAt: snapshot.updatedAt,
    agentModels: { ...snapshot.agentModels },
    agentVariants: { ...snapshot.agentVariants },
    activeSessions: { ...snapshot.activeSessions },
    activityPids: { ...snapshot.activityPids },
    sessionParents: { ...snapshot.sessionParents },
    sessionDetails: Object.fromEntries(
      Object.entries(snapshot.sessionDetails).map(([key, details]) => [
        key,
        { ...details },
      ]),
    ),
  };
}

export function snapshotSectionsEqual(a: TuiSnapshot, b: TuiSnapshot): boolean {
  return (
    JSON.stringify(a.agentModels) === JSON.stringify(b.agentModels) &&
    JSON.stringify(a.agentVariants) === JSON.stringify(b.agentVariants) &&
    JSON.stringify(a.activeSessions) === JSON.stringify(b.activeSessions) &&
    JSON.stringify(a.activityPids) === JSON.stringify(b.activityPids) &&
    JSON.stringify(a.sessionParents) === JSON.stringify(b.sessionParents) &&
    JSON.stringify(a.sessionDetails) === JSON.stringify(b.sessionDetails)
  );
}

function rememberSnapshot(statePath: string, snapshot: TuiSnapshot): void {
  const stat = statSnapshotFile(statePath);
  if (!stat) {
    lastKnownSnapshots.delete(statePath);
    return;
  }
  if (
    !lastKnownSnapshots.has(statePath) &&
    lastKnownSnapshots.size >= LAST_KNOWN_SNAPSHOTS_MAX
  ) {
    const oldest = lastKnownSnapshots.keys().next().value;
    if (oldest !== undefined) lastKnownSnapshots.delete(oldest);
  }
  lastKnownSnapshots.set(statePath, { snapshot, ...stat });
}

function memoFor(statePath: string): TuiSnapshot | undefined {
  const entry = lastKnownSnapshots.get(statePath);
  if (!entry) return undefined;
  const stat = statSnapshotFile(statePath);
  if (
    !stat ||
    stat.ino !== entry.ino ||
    stat.mtimeMs !== entry.mtimeMs ||
    stat.ctimeMs !== entry.ctimeMs ||
    stat.size !== entry.size
  ) {
    lastKnownSnapshots.delete(statePath);
    return undefined;
  }
  return entry.snapshot;
}

function updateSnapshot(
  projectDir: string,
  mutator: (snapshot: TuiSnapshot) => void,
): void {
  const statePath = getTuiStatePath(projectDir);

  const memo = memoFor(statePath);
  if (memo) {
    const candidate = cloneSnapshot(memo);
    mutator(candidate);
    if (snapshotSectionsEqual(candidate, memo)) return; // no-op update
  }

  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
  } catch {
    return;
  }
  const lock = acquireStateLock(statePath);
  if (!lock) return;

  try {
    const snapshot = readTuiSnapshotStrict(statePath);
    if (!snapshot) return;
    const before = cloneSnapshot(snapshot);
    mutator(snapshot);
    if (snapshotSectionsEqual(snapshot, before)) {
      rememberSnapshot(statePath, snapshot);
      return;
    }
    snapshot.updatedAt = Date.now();
    if (writeTuiSnapshot(snapshot, projectDir)) {
      rememberSnapshot(statePath, snapshot);
    }
  } finally {
    releaseStateLock(lock);
  }
}

export function recordTuiAgentModels(
  input: {
    agentModels: Record<string, string>;
    agentVariants?: Record<string, string>;
  },
  projectDir: string,
): void {
  updateSnapshot(projectDir, (snapshot) => {
    snapshot.agentModels = { ...input.agentModels };
    snapshot.agentVariants = { ...(input.agentVariants ?? {}) };
  });
}

export function recordTuiAgentModel(
  input: {
    agentName: string;
    model: string;
    variant?: string | null;
  },
  projectDir: string,
): void {
  updateSnapshot(projectDir, (snapshot) => {
    snapshot.agentModels[input.agentName] = input.model;
    if (input.variant !== undefined) {
      if (input.variant === null) {
        delete snapshot.agentVariants[input.agentName];
      } else {
        snapshot.agentVariants[input.agentName] = input.variant;
      }
    }
  });
}

export function recordTuiAgentActivity(
  input:
    | {
        sessionID: string;
        agentName: string;
        active: true;
        details?: TuiSessionDetails;
      }
    | { sessionID: string; active: false },
  projectDir: string,
): void {
  updateSnapshot(projectDir, (snapshot) => {
    if (input.active) {
      snapshot.activeSessions[input.sessionID] = input.agentName;
      snapshot.activityPids[input.sessionID] = process.pid;
      if (input.details && Object.keys(input.details).length > 0) {
        const current = snapshot.sessionDetails[input.sessionID] ?? {};
        snapshot.sessionDetails[input.sessionID] = {
          ...current,
          ...input.details,
        };
      }
    } else {
      delete snapshot.activeSessions[input.sessionID];
      delete snapshot.activityPids[input.sessionID];
      delete snapshot.sessionDetails[input.sessionID];
    }
  });
}

/**
 * Update per-session sidebar details (alias/model/status) for an ACTIVE
 * session only. A late detail update after idle must never resurrect an
 * activity entry — the whole update is dropped when the session is gone
 * from `activeSessions` at commit time (under the same lock).
 */
export function updateTuiSessionDetails(
  sessionID: string,
  details: TuiSessionDetails,
  projectDir: string,
): void {
  updateSnapshot(projectDir, (snapshot) => {
    if (snapshot.activeSessions[sessionID] === undefined) return;
    const current = snapshot.sessionDetails[sessionID] ?? {};
    snapshot.sessionDetails[sessionID] = { ...current, ...details };
  });
}

/**
 * Retract only the alias of an active session (e.g. its board record was
 * dropped). Model/status survive; the session stays visible in the
 * sidebar under its abbreviated sessionID until it goes idle.
 */
export function clearTuiSessionAlias(
  sessionID: string,
  projectDir: string,
): void {
  updateSnapshot(projectDir, (snapshot) => {
    if (snapshot.activeSessions[sessionID] === undefined) return;
    const current = snapshot.sessionDetails[sessionID];
    if (current === undefined || current.alias === undefined) return;
    const next: TuiSessionDetails = { ...current };
    delete next.alias;
    if (Object.keys(next).length === 0) {
      delete snapshot.sessionDetails[sessionID];
    } else {
      snapshot.sessionDetails[sessionID] = next;
    }
  });
}

// Startup cleanup: drop crash residue (dead recorder pid) and legacy
// entries written before ownership existed. Keep live activities even
// when they belong to this PID — a second plugin init in the same
// process must not wipe the first instance's in-flight sessions.
// Per-instance cleanup is `recordTuiAgentActivity(active: false)` on
// dispose, not this sweep. Sidebar visibility is still scoped by
// session tree at render time (#1147).
export function clearTuiAgentActivities(projectDir: string): void {
  updateSnapshot(projectDir, (snapshot) => {
    for (const sessionID of Object.keys(snapshot.activeSessions)) {
      const pid = snapshot.activityPids[sessionID];
      if (pid === undefined || !isProcessRunning(pid)) {
        delete snapshot.activeSessions[sessionID];
        delete snapshot.activityPids[sessionID];
        delete snapshot.sessionDetails[sessionID];
      }
    }
    // Consistency sweep: details never outlive their activity entry.
    for (const sessionID of Object.keys(snapshot.sessionDetails)) {
      if (snapshot.activeSessions[sessionID] === undefined) {
        delete snapshot.sessionDetails[sessionID];
      }
    }
  });
}

/**
 * Record a child→parent link so any process (recorder or TUI) can resolve
 * a session to its conversation root, surviving restarts and revives
 * (#1147). Roots are never stored per-activity: render resolves the
 * visible session and every active session against this same index, so a
 * late-learned link re-roots everything consistently.
 */
export function recordTuiSessionParent(
  sessionID: string,
  parentID: string,
  projectDir: string,
): void {
  updateSnapshot(projectDir, (snapshot) => {
    snapshot.sessionParents[sessionID] = parentID;
  });
}

/** Resolve a session to its conversation root via the persistent index. */
export function resolveTuiSessionRoot(
  sessionID: string,
  projectDir: string,
): string {
  return resolveSnapshotRoot(readTuiSnapshot(projectDir), sessionID);
}

/**
 * Root of a session according to an already-loaded snapshot. Used by the
 * render side: the visible route session (possibly a child) must be
 * compared against activity roots, not against itself (#1147).
 */
export function resolveTuiSnapshotRoot(
  snapshot: TuiSnapshot,
  sessionID: string,
): string {
  return resolveSnapshotRoot(snapshot, sessionID);
}

function resolveSnapshotRoot(snapshot: TuiSnapshot, sessionID: string): string {
  let current = sessionID;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const parent = snapshot.sessionParents[current];
    if (!parent || parent === current) break;
    current = parent;
  }
  return current;
}
