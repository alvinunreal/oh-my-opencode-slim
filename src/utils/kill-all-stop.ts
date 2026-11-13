import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getTuiStatePath } from '../tui-state';
import { isRecord } from './guards';

export const KILL_ALL_STOP_NOTICE =
  "User stopped all running subagents (emergency stop). Don't relaunch or retry them; ask how to proceed.";

function stopPath(projectDir: string): string {
  return path.join(
    path.dirname(getTuiStatePath(projectDir)),
    'kill-all-stop.json',
  );
}

export function writeKillAllStop(projectDir: string, parents: string[]): void {
  const file = stopPath(projectDir);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), parents }));
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

export function createKillAllStopReader(projectDir: string) {
  const startedAt = Date.now();
  const acknowledged = new Map<string, number>();
  const file = stopPath(projectDir);
  let mtime: number | undefined;
  let record: { at: number; parents: string[] } | undefined;
  return {
    isActive(sessionID: string): boolean {
      try {
        const nextMtime = fs.statSync(file).mtimeMs;
        if (nextMtime !== mtime) {
          const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
          record =
            isRecord(parsed) &&
            typeof parsed.at === 'number' &&
            Number.isFinite(parsed.at) &&
            Array.isArray(parsed.parents)
              ? { at: parsed.at, parents: parsed.parents }
              : undefined;
          mtime = nextMtime;
        }
      } catch {
        mtime = undefined;
        record = undefined;
      }
      return (
        record !== undefined &&
        record.at > startedAt &&
        record.at > (acknowledged.get(sessionID) ?? 0) &&
        record.parents.includes(sessionID)
      );
    },
    noteExternalPrompt(sessionID: string): void {
      acknowledged.set(sessionID, Date.now());
    },
  };
}
