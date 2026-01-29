import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const logFile = path.join(os.tmpdir(), 'oh-my-opencode-slim.log');

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

let currentLogLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function log(
  message: string,
  data?: unknown,
  level: LogLevel = LogLevel.INFO,
): void {
  if (level > currentLogLevel) return;

  try {
    const timestamp = new Date().toISOString();
    const levelStr = LogLevel[level];
    const logEntry = `[${timestamp}] [${levelStr}] ${message} ${data ? JSON.stringify(data) : ''}\n`;
    fs.appendFileSync(logFile, logEntry);
  } catch {
    // Silently ignore logging errors
  }
}

export function logDebug(message: string, data?: unknown): void {
  log(message, data, LogLevel.DEBUG);
}

export function logError(message: string, data?: unknown): void {
  log(message, data, LogLevel.ERROR);
}

export function logWarn(message: string, data?: unknown): void {
  log(message, data, LogLevel.WARN);
}
