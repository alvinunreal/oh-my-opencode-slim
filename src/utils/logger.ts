import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LOG_PREFIX = 'oh-my-opencode-slim.';
const LOG_SUFFIX = '.log';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let logFile: string | null = null;

function getLogDir(): string {
  return (
    process.env.OPENCODE_LOG_DIR ??
    path.join(os.homedir(), '.local/share/opencode')
  );
}

function cleanupOldLogs(logDir: string): void {
  try {
    const entries = fs.readdirSync(logDir);
    const now = Date.now();
    for (const entry of entries) {
      if (entry.startsWith(LOG_PREFIX) && entry.endsWith(LOG_SUFFIX)) {
        const filePath = path.join(logDir, entry);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > RETENTION_MS) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // Skip individual file errors
        }
      }
    }
  } catch {
    // Directory may not exist yet — that's fine
  }
}

export function initLogger(sessionId: string): void {
  const dir = getLogDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Directory creation failed — logging will silently fail
  }
  logFile = path.join(dir, `${LOG_PREFIX}${sessionId}${LOG_SUFFIX}`);
  cleanupOldLogs(dir);
}

/** @internal Reset logger state for testing */
export function resetLogger(): void {
  logFile = null;
}

export { getLogDir };

export function log(message: string, data?: unknown): void {
  if (!logFile) return; // Uninitialized — silently no-op
  try {
    const timestamp = new Date().toISOString();
    let dataStr = '';
    if (data !== undefined) {
      try {
        dataStr = JSON.stringify(data);
      } catch {
        dataStr = '[unserializable]';
      }
    }
    const logEntry = `[${timestamp}] ${message} ${dataStr}\n`;
    fs.appendFileSync(logFile, logEntry);
  } catch {
    // Silently ignore logging errors
  }
}
