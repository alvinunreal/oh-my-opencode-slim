import * as fs from 'node:fs';
import { appendFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { redactSecretsForLog } from './redact';

const LOG_PREFIX = 'oh-my-opencode-slim.';
const LOG_SUFFIX = '.log';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type LogSink =
  | { kind: 'uninitialized' }
  | { kind: 'file'; filePath: string }
  | { kind: 'stderr' };

const FALLBACK_WARNING =
  '[oh-my-opencode-slim] file logging unavailable, falling back to stderr';

let loggerGeneration = 0;
let currentSink: LogSink = { kind: 'uninitialized' };
let writeChain: Promise<void> = Promise.resolve();

function getLogDir(): string {
  return (
    process.env.OPENCODE_LOG_DIR ??
    path.join(os.homedir(), '.local/share/opencode/log')
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
    // Directory may not exist yet - that's fine
  }

  // Apply the same 7-day retention to persisted background task files
  try {
    const bgTaskDir = path.join(logDir, 'bg-tasks');
    const taskFiles = fs.readdirSync(bgTaskDir);
    const now = Date.now();
    for (const entry of taskFiles) {
      if (!entry.endsWith('.json')) continue;
      const filePath = path.join(bgTaskDir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > RETENTION_MS) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Skip individual file errors
      }
    }
  } catch {
    // bg-tasks dir may not exist yet - that's fine
  }
}

function safeStderr(message: string): void {
  try {
    console.error(message);
  } catch {
    // Logging must remain best-effort.
  }
}

function enterStderrFallback(expectedGeneration: number): void {
  if (expectedGeneration !== loggerGeneration) return;
  if (currentSink.kind === 'stderr') return;

  currentSink = { kind: 'stderr' };
  safeStderr(FALLBACK_WARNING);
}

function handleAppendFailure(failedGeneration: number, logEntry: string): void {
  enterStderrFallback(failedGeneration);
  safeStderr(logEntry.trimEnd());
}

export function initLogger(sessionId: string): void {
  const attemptGeneration = ++loggerGeneration;

  try {
    const dir = getLogDir();
    fs.mkdirSync(dir, { recursive: true });

    const nextLogFile = path.join(
      dir,
      `${LOG_PREFIX}${sessionId}${LOG_SUFFIX}`,
    );
    fs.closeSync(fs.openSync(nextLogFile, 'a'));

    if (attemptGeneration !== loggerGeneration) return;

    currentSink = {
      kind: 'file',
      filePath: nextLogFile,
    };
    cleanupOldLogs(dir);
  } catch {
    enterStderrFallback(attemptGeneration);
  }
}

/** @internal Reset logger state for testing */
export function resetLogger(): void {
  loggerGeneration += 1;
  currentSink = { kind: 'uninitialized' };
  writeChain = Promise.resolve();
}

/** @internal Wait for queued log writes in tests. */
export async function flushLoggerForTesting(): Promise<void> {
  await writeChain;
}

export function log(message: string, data?: unknown): void {
  try {
    const sink = currentSink;
    const entryGeneration = loggerGeneration;

    if (sink.kind === 'uninitialized') return;

    const timestamp = new Date().toISOString();
    let dataStr = '';
    if (data !== undefined) {
      try {
        dataStr = JSON.stringify(data);
      } catch {
        dataStr = '[unserializable]';
      }
    }

    // Redaction choke point: every sink below (file append, stderr, and
    // the append-failure stderr fallback) receives this one composed,
    // already-redacted entry, so no call site can bypass the masking.
    // Best-effort shape-based barrier against accidental credential
    // leaks — see src/utils/redact.ts for the documented limits.
    const logEntry = redactSecretsForLog(
      `[${timestamp}] ${message} ${dataStr}\n`,
    );

    if (sink.kind === 'stderr') {
      safeStderr(logEntry.trimEnd());
      return;
    }

    const filePath = sink.filePath;
    writeChain = writeChain
      .catch(() => undefined)
      .then(async () => {
        if (
          entryGeneration === loggerGeneration &&
          currentSink.kind === 'stderr'
        ) {
          safeStderr(logEntry.trimEnd());
          return;
        }

        try {
          await appendFile(filePath, logEntry);
        } catch {
          handleAppendFailure(entryGeneration, logEntry);
        }
      })
      .catch(() => undefined);
  } catch {
    // Logging must remain best-effort.
  }
}
