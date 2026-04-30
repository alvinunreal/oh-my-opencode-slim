import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TuiSnapshot {
  version: 1;
  updatedAt: number;
  agentModels: Record<string, string>;
}

const STATE_DIR = 'oh-my-opencode-slim';
const STATE_FILE = 'tui-state.json';

function dataDir(): string {
  return (
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share')
  );
}

export function getTuiStatePath(): string {
  return path.join(dataDir(), 'opencode', 'storage', STATE_DIR, STATE_FILE);
}

function emptySnapshot(): TuiSnapshot {
  return {
    version: 1,
    updatedAt: Date.now(),
    agentModels: {},
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
  };
}

export function readTuiSnapshot(): TuiSnapshot {
  try {
    return parseSnapshot(fs.readFileSync(getTuiStatePath(), 'utf8'));
  } catch {
    return emptySnapshot();
  }
}

export async function readTuiSnapshotAsync(): Promise<TuiSnapshot> {
  try {
    return parseSnapshot(await fs.promises.readFile(getTuiStatePath(), 'utf8'));
  } catch {
    return emptySnapshot();
  }
}

function writeTuiSnapshot(snapshot: TuiSnapshot): void {
  try {
    const filePath = getTuiStatePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(snapshot)}\n`);
  } catch {
    // TUI state is best-effort only.
  }
}

function updateSnapshot(mutator: (snapshot: TuiSnapshot) => void): void {
  const snapshot = readTuiSnapshot();
  mutator(snapshot);
  snapshot.updatedAt = Date.now();
  writeTuiSnapshot(snapshot);
}

export function recordTuiAgentModels(input: {
  agentModels: Record<string, string>;
}): void {
  updateSnapshot((snapshot) => {
    snapshot.agentModels = { ...input.agentModels };
  });
}

export function recordTuiAgentModel(input: {
  agentName: string;
  model: string;
}): void {
  updateSnapshot((snapshot) => {
    snapshot.agentModels[input.agentName] = input.model;
  });
}
