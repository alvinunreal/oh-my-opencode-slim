import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TuiSnapshot {
  version: 1;
  updatedAt: number;
  agentModels: Record<string, string>;
  agentVariants: Record<string, string>;
}

const STATE_DIR = 'oh-my-opencode-slim';
const STATE_FILE = 'tui-state.json';

function dataDir(): string {
  return (
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share')
  );
}

// ponytail: per-project scope prevents /model overrides from leaking across projects
function projectScope(projectDir: string): string {
  return crypto
    .createHash('sha256')
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
    fs.writeFileSync(filePath, `${JSON.stringify(snapshot)}\n`);
  } catch {
    // TUI state is best-effort only.
  }
}

function updateSnapshot(
  projectDir: string,
  mutator: (snapshot: TuiSnapshot) => void,
): void {
  const snapshot = readTuiSnapshot(projectDir);
  mutator(snapshot);
  snapshot.updatedAt = Date.now();
  writeTuiSnapshot(snapshot, projectDir);
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
