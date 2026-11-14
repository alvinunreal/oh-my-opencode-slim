import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { PANE_VIEWER_ENV } from '../multiplexer/shared';
import { log } from '../utils/logger';
import { normalizeCompanionDirectory, stateFilePath } from './runtime';

export interface TuiAttachment {
  pid: number;
  startTime: string | null;
  cwd: string;
}

function attachmentDirectory(): string {
  return path.join(path.dirname(stateFilePath()), 'tui-attach');
}

function processStartTime(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    return fields[19] ? `linux:${fields[19]}` : null;
  } catch {
    return null;
  }
}

export function attachTuiProcess(cwd: string): () => void {
  if (process.env[PANE_VIEWER_ENV] === '1') return () => {};
  const startTime = processStartTime(process.pid);
  if (process.platform === 'linux' && startTime === null) {
    log('[companion] TUI attachment skipped: process identity unavailable', {
      pid: process.pid,
      dir: cwd,
    });
    return () => {};
  }

  const directory = attachmentDirectory();
  const file = path.join(directory, `${process.pid}.json`);
  const temporary = `${file}.${Date.now()}.tmp`;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      temporary,
      JSON.stringify({
        pid: process.pid,
        startTime,
        cwd: path.resolve(cwd),
      } satisfies TuiAttachment),
    );
    renameSync(temporary, file);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup after a failed attachment write.
    }
    log('[companion] TUI attachment write failed', String(error));
  }

  return () => {
    try {
      rmSync(file, { force: true });
    } catch (error) {
      log('[companion] TUI attachment removal failed', String(error));
    }
  };
}

function parseAttachment(file: string): TuiAttachment | null {
  try {
    const record = JSON.parse(
      readFileSync(file, 'utf8'),
    ) as Partial<TuiAttachment>;
    if (
      !Number.isInteger(record.pid) ||
      (record.pid as number) <= 0 ||
      (record.startTime !== null && typeof record.startTime !== 'string') ||
      typeof record.cwd !== 'string' ||
      !path.isAbsolute(record.cwd)
    ) {
      return null;
    }
    return record as TuiAttachment;
  } catch {
    return null;
  }
}

function processLiveness(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function removeStaleAttachment(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // A definite stale record is ignored even if it cannot be removed.
  }
}

export function liveTuiAttachments(): TuiAttachment[] | null {
  const directory = attachmentDirectory();
  let files: string[];
  try {
    files = readdirSync(directory).filter((file) => file.endsWith('.json'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }

  const live: TuiAttachment[] = [];
  for (const name of files) {
    const file = path.join(directory, name);
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) return null;
    const filePid = Number(match[1]);
    if (!Number.isSafeInteger(filePid) || filePid <= 0) return null;

    const record = parseAttachment(file);
    const liveness = processLiveness(filePid);
    if (liveness === 'dead') {
      removeStaleAttachment(file);
      continue;
    }
    if (liveness === 'unknown' || !record || record.pid !== filePid)
      return null;
    if (process.platform === 'linux') {
      const started = processStartTime(filePid);
      if (started === null) return null;
      if (started !== record.startTime) {
        removeStaleAttachment(file);
        continue;
      }
    }
    live.push(record);
  }
  return live;
}

export function isDirectoryAttached(
  attachments: readonly TuiAttachment[],
  cwd: string,
): boolean {
  const identity = normalizeCompanionDirectory(cwd);
  return attachments.some(
    (attachment) => normalizeCompanionDirectory(attachment.cwd) === identity,
  );
}
