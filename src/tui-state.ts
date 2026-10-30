import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ReusableSessionSelection } from './utils/background-job-board';

/**
 * Per-session alias/status projection for the clickable sidebar. Entries only
 * exist for sessions present in `activeSessions`; they never activate a
 * session by themselves. The key is always the full sessionID — never an
 * alias — and the parent link lives exclusively in `sessionParents`.
 */
export interface TuiSessionDetails {
  alias?: string;
  status?: 'busy' | 'retry';
}

/** Host-board sidebar sessions. Running entries carry only stable identity;
 * terminal and stopped entries retain their destination metadata. */
export type TuiReusableSession =
  | (ReusableSessionSelection & { running?: never })
  | {
      taskID: string;
      alias: string;
      running: true;
      terminalState?: never;
      completedAt?: never;
      lastUsedAt?: never;
    };

export interface TuiSnapshot {
  version: 1;
  updatedAt: number;
  agentModels: Record<string, string>;
  agentVariants: Record<string, string>;
  /**
   * Canonical agent ID → visible display name, for the sidebar label only.
   * Keyed by the same canonical ID as `agentModels`/`activeSessions` so model
   * lookup, row expansion and click handling keep using the canonical name;
   * a missing or identical entry falls back to the ID.
   */
  agentDisplayNames: Record<string, string>;
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
  /** Per-active-session details (alias/status) for the sidebar. */
  sessionDetails: Record<string, TuiSessionDetails>;
  /**
   * Accessible terminal, stopped and running sessions per agent, keyed by parent
   * sessionID. The board owns this process-local projection.
   */
  reusableByAgent: Record<string, Record<string, TuiReusableSession[]>>;
  /** Host PID owning each parent projection, independent of activityPids. */
  reusableOwners: Record<string, number>;
}

export const TUI_SESSION_PARENTS_MAX = 256;
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
    agentDisplayNames: {},
    activeSessions: {},
    activityPids: {},
    sessionParents: {},
    sessionDetails: {},
    reusableByAgent: {},
    reusableOwners: {},
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
    const rec = entry as { alias?: unknown; status?: unknown };
    const details: TuiSessionDetails = {};
    if (typeof rec.alias === 'string') details.alias = rec.alias;
    if (rec.status === 'busy' || rec.status === 'retry') {
      details.status = rec.status;
    }
    if (Object.keys(details).length > 0) out[key] = details;
  }
  return out;
}

function parseReusableByAgent(
  value: unknown,
): Record<string, Record<string, TuiReusableSession[]>> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, Record<string, TuiReusableSession[]>> = {};
  for (const [parentID, byAgent] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (byAgent === null || typeof byAgent !== 'object') continue;
    const agents: Record<string, TuiReusableSession[]> = {};
    for (const [agentName, entry] of Object.entries(
      byAgent as Record<string, unknown>,
    )) {
      if (!Array.isArray(entry)) continue;
      const sessions: TuiReusableSession[] = [];
      for (const item of entry) {
        if (item === null || typeof item !== 'object') continue;
        const rec = item as {
          taskID?: unknown;
          alias?: unknown;
          running?: unknown;
          terminalState?: unknown;
          completedAt?: unknown;
          lastUsedAt?: unknown;
        };
        if (typeof rec.taskID !== 'string' || typeof rec.alias !== 'string') {
          continue;
        }
        if (rec.running === true) {
          sessions.push({
            taskID: rec.taskID,
            alias: rec.alias,
            running: true,
          });
          continue;
        }
        if (
          (rec.terminalState !== 'completed' &&
            rec.terminalState !== 'error' &&
            rec.terminalState !== 'cancelled' &&
            rec.terminalState !== 'stopped') ||
          typeof rec.lastUsedAt !== 'number'
        ) {
          continue;
        }
        sessions.push({
          taskID: rec.taskID,
          alias: rec.alias,
          terminalState: rec.terminalState,
          ...(typeof rec.completedAt === 'number'
            ? { completedAt: rec.completedAt }
            : {}),
          lastUsedAt: rec.lastUsedAt,
        });
      }
      if (sessions.length > 0) agents[agentName] = sessions;
    }
    if (Object.keys(agents).length > 0) out[parentID] = agents;
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
    agentDisplayNames: parseStringRecord(parsed.agentDisplayNames),
    activeSessions: parsed.activeSessions ?? {},
    activityPids: parsePidRecord(parsed.activityPids),
    sessionParents: parseStringRecord(parsed.sessionParents),
    sessionDetails: parseSessionDetails(parsed.sessionDetails),
    // The host-board projection is absent until its first write. Present
    // values parse as arrays for the TUI's reusable-session navigation.
    reusableByAgent: parseReusableByAgent(parsed.reusableByAgent),
    reusableOwners: parsePidRecord(parsed.reusableOwners),
  };
}

export function readTuiSnapshot(projectDir: string): TuiSnapshot {
  try {
    return parseSnapshot(fs.readFileSync(getTuiStatePath(projectDir), 'utf8'));
  } catch {
    return emptySnapshot();
  }
}

export function readTuiSessionParents(
  projectDir: string,
): Record<string, string> {
  const memo = memoFor(getTuiStatePath(projectDir));
  return memo
    ? parseStringRecord(memo.sessionParents)
    : readTuiSnapshot(projectDir).sessionParents;
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

// One bounded stat-keyed snapshot cache shared by the locked writer and
// the async TUI reader. Writers publish via tmp+rename, so a changed write
// always has a new dev/ino; ctime rules out same-mtime in-place rewrites
// and dev rules out cross-device inode coincidence. A hit must match every
// field; any stat/read failure bypasses the cache entirely. Bounded LRU:
// a long-lived process touching many projects must not retain a snapshot
// per visited path.
const SNAPSHOT_CACHE_MAX = 8;

interface SnapshotStat {
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
}

interface SnapshotCacheEntry {
  stat: SnapshotStat;
  /** Canonical snapshot: the writer's memo. Never handed to async readers. */
  snapshot: TuiSnapshot;
  /**
   * Isolated copy served to async readers. A reader may mutate it freely;
   * the writer memo stays untouched. The copy survives cache hits, so
   * reader-side mutations stay visible across polls of one entry (the
   * pre-merge reader behavior).
   */
  readerSnapshot?: TuiSnapshot;
}

const snapshotCache = new Map<string, SnapshotCacheEntry>();

function snapshotStatOf(stat: fs.Stats): SnapshotStat {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    size: stat.size,
  };
}

function sameSnapshotStat(a: SnapshotStat, b: SnapshotStat): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.size === b.size
  );
}

function cacheSnapshot(
  statePath: string,
  snapshot: TuiSnapshot,
  stat: SnapshotStat,
): SnapshotCacheEntry {
  // Map insertion order doubles as the LRU order: re-insert to refresh.
  const entry: SnapshotCacheEntry = {
    stat,
    snapshot,
  };
  snapshotCache.delete(statePath);
  snapshotCache.set(statePath, entry);
  while (snapshotCache.size > SNAPSHOT_CACHE_MAX) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest === undefined) break;
    snapshotCache.delete(oldest);
  }
  return entry;
}

/** Refresh the LRU position without replacing the entry: reader-side
 * mutations of the served copy must survive the refresh. */
function touchSnapshot(statePath: string, entry: SnapshotCacheEntry): void {
  snapshotCache.delete(statePath);
  snapshotCache.set(statePath, entry);
}

export async function readTuiSnapshotAsync(
  projectDir: string,
): Promise<TuiSnapshot> {
  const statePath = getTuiStatePath(projectDir);
  try {
    const stat = await fs.promises.stat(statePath);
    const cached = snapshotCache.get(statePath);
    if (cached && sameSnapshotStat(cached.stat, snapshotStatOf(stat))) {
      touchSnapshot(statePath, cached); // LRU refresh
      cached.readerSnapshot ??= cloneSnapshot(cached.snapshot);
      return cached.readerSnapshot;
    }
    const snapshot = parseSnapshot(
      await fs.promises.readFile(statePath, 'utf8'),
    );
    // Race-safe publication: publish only when the stat is stable across
    // the read window. A concurrent tmp+rename makes the read return
    // pre-rename content that must not be stamped with the post-rename
    // identity — such a memoized fallback would then serve stale data
    // until the next stat change. A vanished file skips publication but
    // still returns what was read.
    try {
      const after = await fs.promises.stat(statePath);
      if (sameSnapshotStat(snapshotStatOf(stat), snapshotStatOf(after))) {
        const entry = cacheSnapshot(statePath, snapshot, snapshotStatOf(after));
        entry.readerSnapshot = cloneSnapshot(entry.snapshot);
        return entry.readerSnapshot;
      }
    } catch {
      // Publication only; the read itself succeeded.
    }
    return snapshot;
  } catch {
    // A failed read is never memoized: the fallback must not swallow a
    // later retry of the real file.
    snapshotCache.delete(statePath);
    return emptySnapshot();
  }
}

function writeTuiSnapshot(snapshot: TuiSnapshot, projectDir: string): boolean {
  try {
    const filePath = getTuiStatePath(projectDir);
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

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStateLockStale(lockPath: string): boolean {
  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs > STATE_LOCK_STALE_MS)
      return true;
    const { pid } = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
      pid?: unknown;
    };
    return typeof pid === 'number' && pid > 0 && !isProcessRunning(pid);
  } catch {
    return false; // Lock released, or metadata still being written.
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

// The shared snapshot cache doubles as the locked writer's last-known
// on-disk snapshot per project. No-ops return before the lock; failed
// writes do not seed the memo. An identity mismatch (external rename or
// in-place rewrite) invalidates it.

function statSnapshotFile(statePath: string): SnapshotStat | null {
  try {
    return snapshotStatOf(fs.statSync(statePath));
  } catch {
    return null;
  }
}

function cloneSnapshot(snapshot: TuiSnapshot): TuiSnapshot {
  // Plain JSON throughout (records of strings/numbers and reusable-session
  // records), so the structural clone also copies the reusableByAgent entry
  // arrays the field-wise shallow copy used to share.
  return structuredClone(snapshot);
}

export function snapshotSectionsEqual(a: TuiSnapshot, b: TuiSnapshot): boolean {
  if (
    !isDeepStrictEqual(
      {
        agentModels: a.agentModels,
        agentVariants: a.agentVariants,
        agentDisplayNames: a.agentDisplayNames,
        activeSessions: a.activeSessions,
        activityPids: a.activityPids,
        sessionParents: a.sessionParents,
        sessionDetails: a.sessionDetails,
        reusableByAgent: a.reusableByAgent,
        reusableOwners: a.reusableOwners,
      },
      {
        agentModels: b.agentModels,
        agentVariants: b.agentVariants,
        agentDisplayNames: b.agentDisplayNames,
        activeSessions: b.activeSessions,
        activityPids: b.activityPids,
        sessionParents: b.sessionParents,
        sessionDetails: b.sessionDetails,
        reusableByAgent: b.reusableByAgent,
        reusableOwners: b.reusableOwners,
      },
    )
  ) {
    return false;
  }
  // sessionParents key insertion order is load-bearing even though the
  // entries are deep-equal: the parent cap prunes the oldest-inserted
  // links and a re-registered link moves to the end, so a pure reorder
  // must still count as a change.
  return sameSessionParentOrder(a.sessionParents, b.sessionParents);
}

function sameSessionParentOrder(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false;
  }
  return true;
}

function rememberSnapshot(statePath: string, snapshot: TuiSnapshot): void {
  const stat = statSnapshotFile(statePath);
  if (!stat) {
    snapshotCache.delete(statePath);
    return;
  }
  cacheSnapshot(statePath, snapshot, stat);
}

function memoFor(statePath: string): TuiSnapshot | undefined {
  const entry = snapshotCache.get(statePath);
  if (!entry) return undefined;
  const stat = statSnapshotFile(statePath);
  if (!stat || !sameSnapshotStat(entry.stat, stat)) {
    snapshotCache.delete(statePath);
    return undefined;
  }
  return entry.snapshot;
}

export function updateSnapshot(
  projectDir: string,
  mutator: (snapshot: TuiSnapshot) => void,
  isCurrent?: (snapshot: TuiSnapshot) => boolean,
): boolean {
  const statePath = getTuiStatePath(projectDir);

  const memo = memoFor(statePath);
  if (memo) {
    if (isCurrent?.(memo)) return true;
    const candidate = cloneSnapshot(memo);
    mutator(candidate);
    if (snapshotSectionsEqual(candidate, memo)) return true; // no-op update
  }

  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
  } catch {
    return false;
  }
  const lock = acquireStateLock(statePath);
  if (!lock) return false;

  try {
    const snapshot = readTuiSnapshotStrict(statePath);
    if (!snapshot) return false;
    const before = cloneSnapshot(snapshot);
    mutator(snapshot);
    if (snapshotSectionsEqual(snapshot, before)) {
      rememberSnapshot(statePath, snapshot);
      return true;
    }
    snapshot.updatedAt = Date.now();
    // Any write drops the oldest links past the cap but keeps active chains.
    const { sessionParents: parents, activeSessions } = snapshot;
    const keep = new Set<string>();
    for (let id of Object.keys(activeSessions))
      for (; parents[id] && !keep.has(id); id = parents[id]) keep.add(id);
    for (const key of Object.keys(parents).slice(0, -TUI_SESSION_PARENTS_MAX))
      if (!keep.has(key)) delete parents[key];
    if (writeTuiSnapshot(snapshot, projectDir)) {
      rememberSnapshot(statePath, snapshot);
      return true;
    }
    return false;
  } finally {
    releaseStateLock(lock);
  }
}

/**
 * One native event's fan-out scope. Every recorder call and every
 * projection publish made inside the scope stages its work; the scope
 * commits once, in its finally, with one locked update per project.
 *
 * The scope is a VALUE carried by AsyncLocalStorage, never a global flag:
 * overlapping fan-outs each run their own value and can never merge.
 * A nested `withTuiSnapshotBatch` reuses the open value.
 */
interface TuiSnapshotBatch {
  /** False once the scope closed: late continuations record immediately. */
  open: boolean;
  /** Staged mutators per project directory, in stage order. */
  mutations: Map<
    string,
    Array<{
      mutator: (snapshot: TuiSnapshot) => void;
      onCommit?: (applied: boolean) => void;
      isCurrent?: (snapshot: TuiSnapshot) => boolean;
    }>
  >;
  /** Deferred projections keyed by their coalescing key (one per key). */
  projections: Map<object, () => void>;
}

const tuiSnapshotBatch = new AsyncLocalStorage<TuiSnapshotBatch>();

/**
 * Run a native event's fan-out as one batch: staged recorder writes and
 * deferred projections commit together in the finally, even when the
 * operation rejects. A nested call joins the open scope.
 */
export async function withTuiSnapshotBatch<T>(
  operation: () => Promise<T> | T,
): Promise<T> {
  const active = tuiSnapshotBatch.getStore();
  if (active?.open) return await operation();
  const batch: TuiSnapshotBatch = {
    open: true,
    mutations: new Map(),
    projections: new Map(),
  };
  return tuiSnapshotBatch.run(batch, async () => {
    try {
      return await operation();
    } finally {
      drainTuiSnapshotBatch(batch);
    }
  });
}

/**
 * Commit everything the open scope staged so far, keeping the scope open.
 * Call before awaiting work that can emit another native event (a
 * fallback re-prompt's busy status): that event commits in its own scope,
 * and an older staged write must not land after it and overwrite it.
 */
export function flushTuiSnapshotBatch(): void {
  const batch = tuiSnapshotBatch.getStore();
  if (batch?.open) commitTuiSnapshotBatch(batch);
}

function commitTuiSnapshotBatch(batch: TuiSnapshotBatch): void {
  // Run the deferred projections while the scope is still open: each
  // publishes by staging, so every section lands in the same per-project
  // update below — one physical write including the recorder updates.
  const projections = [...batch.projections.values()];
  batch.projections.clear();
  for (const project of projections) {
    try {
      project();
    } catch {
      // Best-effort: one projection must not prevent other commits.
    }
  }
  const mutations = [...batch.mutations];
  batch.mutations.clear();
  for (const [projectDir, pending] of mutations) {
    let applied = false;
    try {
      applied = updateSnapshot(
        projectDir,
        (snapshot) => {
          for (const { mutator } of pending) mutator(snapshot);
        },
        pending.every((entry) => entry.isCurrent)
          ? (snapshot) => pending.every((entry) => entry.isCurrent?.(snapshot))
          : undefined,
      );
    } catch {
      // A failed projection is not a committed ownership update.
    }
    for (const { onCommit } of pending) {
      try {
        onCommit?.(applied);
      } catch {
        // Isolate each best-effort observer from the remaining commits.
      }
    }
  }
}

function drainTuiSnapshotBatch(batch: TuiSnapshotBatch): void {
  try {
    commitTuiSnapshotBatch(batch);
  } finally {
    batch.open = false;
    batch.projections.clear();
    batch.mutations.clear();
  }
}

/**
 * Stage one mutator into the open scope, or write it immediately when no
 * scope is open. Mutators must be replay-safe: the commit applies them
 * against a candidate clone first and again against the locked snapshot.
 */
function recordSnapshotUpdate(
  projectDir: string,
  mutator: (snapshot: TuiSnapshot) => void,
  onCommit?: (applied: boolean) => void,
  isCurrent?: (snapshot: TuiSnapshot) => boolean,
): void {
  const batch = tuiSnapshotBatch.getStore();
  if (batch?.open) {
    const pending = batch.mutations.get(projectDir);
    if (pending) pending.push({ mutator, onCommit, isCurrent });
    else batch.mutations.set(projectDir, [{ mutator, onCommit, isCurrent }]);
    return;
  }
  const applied = updateSnapshot(projectDir, mutator, isCurrent);
  onCommit?.(applied);
}

/**
 * Publish a projection section. Inside an open scope the write is staged
 * and `onCommit` reports the real commit result; outside one it is an
 * immediate locked write.
 */
export function publishTuiProjection(
  projectDir: string,
  mutator: (snapshot: TuiSnapshot) => void,
  onCommit?: (applied: boolean) => void,
): void {
  recordSnapshotUpdate(projectDir, mutator, onCommit);
}

/**
 * Defer a projection until the open scope commits. Repeated calls with
 * the same key coalesce into one run; without an open scope the
 * projection runs synchronously.
 */
export function deferTuiProjection(key: object, project: () => void): void {
  const batch = tuiSnapshotBatch.getStore();
  if (batch?.open) {
    if (!batch.projections.has(key)) batch.projections.set(key, project);
    return;
  }
  project();
}

/** Run a deferred projection now (disposal path). */
export function flushTuiProjection(key: object): void {
  const batch = tuiSnapshotBatch.getStore();
  const pending = batch?.projections.get(key);
  if (!pending) return;
  batch?.projections.delete(key);
  pending();
}

/**
 * Project the registry's canonical→display identity table into the sidebar
 * map. Only labels whose display differs from the canonical ID are stored;
 * routing, model lookup, activity, expansion, and history keep canonical keys.
 */
export function collectAgentDisplayNames(
  identities: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const displayNames: Record<string, string> = {};
  for (const [name, display] of Object.entries(identities ?? {})) {
    if (display && display !== name) displayNames[name] = display;
  }
  return displayNames;
}

export function recordTuiAgentDisplayNames(
  displayNames: Record<string, string>,
  projectDir: string,
): void {
  recordSnapshotUpdate(projectDir, (snapshot) => {
    snapshot.agentDisplayNames = { ...displayNames };
  });
}

export function recordTuiAgentModels(
  input: {
    agentModels: Record<string, string>;
    agentVariants?: Record<string, string>;
    /** Canonical ID → display name; omitted callers keep the last-known map. */
    agentDisplayNames?: Record<string, string>;
  },
  projectDir: string,
): void {
  recordSnapshotUpdate(projectDir, (snapshot) => {
    snapshot.agentModels = { ...input.agentModels };
    snapshot.agentVariants = { ...(input.agentVariants ?? {}) };
    if (input.agentDisplayNames !== undefined) {
      snapshot.agentDisplayNames = { ...input.agentDisplayNames };
    }
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
  recordSnapshotUpdate(
    projectDir,
    (snapshot) => {
      snapshot.agentModels[input.agentName] = input.model;
      if (input.variant !== undefined) {
        if (input.variant === null) {
          delete snapshot.agentVariants[input.agentName];
        } else {
          snapshot.agentVariants[input.agentName] = input.variant;
        }
      }
    },
    undefined,
    (snapshot) =>
      snapshot.agentModels[input.agentName] === input.model &&
      (input.variant === undefined ||
        (input.variant === null
          ? !Object.hasOwn(snapshot.agentVariants, input.agentName)
          : snapshot.agentVariants[input.agentName] === input.variant)),
  );
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
  recordSnapshotUpdate(
    projectDir,
    (snapshot) => {
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
    },
    undefined,
    (snapshot) => {
      if (!input.active)
        return (
          !Object.hasOwn(snapshot.activeSessions, input.sessionID) &&
          !Object.hasOwn(snapshot.activityPids, input.sessionID) &&
          !Object.hasOwn(snapshot.sessionDetails, input.sessionID)
        );
      const current = snapshot.sessionDetails[input.sessionID];
      return (
        snapshot.activeSessions[input.sessionID] === input.agentName &&
        snapshot.activityPids[input.sessionID] === process.pid &&
        (!input.details ||
          Object.keys(input.details).length === 0 ||
          isDeepStrictEqual(current, { ...current, ...input.details }))
      );
    },
  );
}

/**
 * Update per-session sidebar details (alias/status) for an ACTIVE
 * session only. A late detail update after idle must never resurrect an
 * activity entry — the whole update is dropped when the session is gone
 * from `activeSessions` at commit time (under the same lock).
 */
export function updateTuiSessionDetails(
  sessionID: string,
  details: TuiSessionDetails,
  projectDir: string,
): void {
  recordSnapshotUpdate(projectDir, (snapshot) => {
    if (snapshot.activeSessions[sessionID] === undefined) return;
    const current = snapshot.sessionDetails[sessionID] ?? {};
    snapshot.sessionDetails[sessionID] = { ...current, ...details };
  });
}

/**
 * Retract only the alias of an active session (e.g. its board record was
 * dropped). Status survives; the session stays visible in the
 * sidebar under its abbreviated sessionID until it goes idle.
 */
export function clearTuiSessionAlias(
  sessionID: string,
  projectDir: string,
): void {
  recordSnapshotUpdate(projectDir, (snapshot) => {
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
  recordSnapshotUpdate(projectDir, (snapshot) => {
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
  recordSnapshotUpdate(
    projectDir,
    (snapshot) => {
      delete snapshot.sessionParents[sessionID]; // Re-registered link is newest.
      snapshot.sessionParents[sessionID] = parentID;
    },
    undefined,
    (snapshot) =>
      snapshot.sessionParents[sessionID] === parentID &&
      Object.keys(snapshot.sessionParents).at(-1) === sessionID,
  );
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
