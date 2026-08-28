import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TuiSnapshot {
  version: 1;
  updatedAt: number;
  agentModels: Record<string, string>;
  agentVariants: Record<string, string>;
  activeSessions: Record<string, string>;
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
  };
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
  };
}

export function readTuiSnapshot(projectDir: string): TuiSnapshot {
  try {
    return parseSnapshot(fs.readFileSync(getTuiStatePath(projectDir), 'utf8'));
  } catch {
    return emptySnapshot();
  }
}

export async function readTuiSnapshotAsync(
  projectDir: string,
): Promise<TuiSnapshot> {
  try {
    return parseSnapshot(
      await fs.promises.readFile(getTuiStatePath(projectDir), 'utf8'),
    );
  } catch {
    return emptySnapshot();
  }
}

function writeTuiSnapshot(snapshot: TuiSnapshot, projectDir: string): void {
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
  } catch {
    // TUI state is best-effort only.
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

function updateSnapshot(
  projectDir: string,
  mutator: (snapshot: TuiSnapshot) => void,
): void {
  const statePath = getTuiStatePath(projectDir);
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
  } catch {
    return;
  }
  const lock = acquireStateLock(statePath);
  if (!lock) return;

  try {
    const snapshot = readTuiSnapshot(projectDir);
    const beforeModels = JSON.stringify(snapshot.agentModels);
    const beforeVariants = JSON.stringify(snapshot.agentVariants);
    const beforeActiveSessions = JSON.stringify(snapshot.activeSessions);
    mutator(snapshot);
    if (
      JSON.stringify(snapshot.agentModels) === beforeModels &&
      JSON.stringify(snapshot.agentVariants) === beforeVariants &&
      JSON.stringify(snapshot.activeSessions) === beforeActiveSessions
    ) {
      return; // state unchanged — skip the disk write
    }
    snapshot.updatedAt = Date.now();
    writeTuiSnapshot(snapshot, projectDir);
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
    | { sessionID: string; agentName: string; active: true }
    | { sessionID: string; active: false },
  projectDir: string,
): void {
  updateSnapshot(projectDir, (snapshot) => {
    if (input.active) {
      snapshot.activeSessions[input.sessionID] = input.agentName;
    } else {
      delete snapshot.activeSessions[input.sessionID];
    }
  });
}

export function clearTuiAgentActivities(projectDir: string): void {
  updateSnapshot(projectDir, (snapshot) => {
    snapshot.activeSessions = {};
  });
}
