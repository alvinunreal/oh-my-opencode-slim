/**
 * Shared multiplexer infrastructure
 *
 * Functions used across tmux, zellij, and herdr backend adapters.
 * Extracted to eliminate copy-paste duplication and prevent drift.
 */

import { crossSpawn } from '../utils/compat';
import { log } from '../utils/logger';

export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Normalize Windows backslashes to / so sh -lc (MSYS2/Git Bash) doesn't treat them as escape chars. */
export function normalizePathForShell(directory: string): string {
  return process.platform === 'win32'
    ? directory.replace(/\\/g, '/')
    : directory;
}

export function buildOpencodeAttachCommand(
  sessionId: string,
  serverUrl: string,
  directory: string,
): string {
  const attachDir = normalizePathForShell(directory);
  return [
    'opencode',
    'attach',
    quoteShellArg(serverUrl),
    '--session',
    quoteShellArg(sessionId),
    '--dir',
    quoteShellArg(attachDir),
  ].join(' ');
}

export async function findBinary(
  binaryName: string,
  options: { verify?: boolean } = {},
): Promise<string | null> {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'where' : 'which';
  const logPrefix = `[${binaryName}]`;

  try {
    const proc = crossSpawn([cmd, binaryName], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      log(`${logPrefix} findBinary: '${cmd} ${binaryName}' failed`, {
        exitCode,
      });
      return null;
    }

    const stdout = await proc.stdout();
    const path = stdout.trim().split('\n')[0];
    if (!path) {
      log(`${logPrefix} findBinary: no path in output`);
      return null;
    }

    log(`${logPrefix} findBinary: found`, { path });

    // Verify the binary works if requested
    if (options.verify) {
      try {
        const verifyProc = crossSpawn([path, '-V'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const verifyExitCode = await verifyProc.exited;
        if (verifyExitCode !== 0) {
          log(`${logPrefix} findBinary: verification failed for ${path}`);
          return null;
        }
        const verifyStdout = await verifyProc.stdout();
        log(`${logPrefix} findBinary: verified`, {
          version: verifyStdout.trim(),
        });
      } catch (verifyErr) {
        log(`${logPrefix} findBinary: verification exception`, {
          error: String(verifyErr),
        });
        return null;
      }
    }

    return path;
  } catch (err) {
    log(`${logPrefix} findBinary: exception`, { error: String(err) });
    return null;
  }
}

const GRACEFUL_SHUTDOWN_DELAY_MS = 250;

export interface GracefulClosePaneOptions {
  /** Backend-specific Ctrl+C command args (binary prepended by caller). */
  ctrlC: string[];
  /** Backend-specific close/kill command args (binary prepended by caller). */
  close: string[];
  /** Accept exit code 1 as success (zellij/herdr treat "already closed" as 1). */
  acceptExitCode1?: boolean;
  /** Return true for empty/unknown paneId instead of false (zellij/herdr behavior). */
  emptyPaneReturnsTrue?: boolean;
}

export async function gracefulClosePane(
  binary: string | null,
  paneId: string,
  options: GracefulClosePaneOptions,
): Promise<boolean> {
  if (!binary) return false;

  const isEmpty = !paneId || paneId === 'unknown';
  if (isEmpty) return options.emptyPaneReturnsTrue ?? false;

  try {
    const ctrlCProc = crossSpawn([binary, ...options.ctrlC], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await ctrlCProc.exited;

    await new Promise((r) => setTimeout(r, GRACEFUL_SHUTDOWN_DELAY_MS));

    const proc = crossSpawn([binary, ...options.close], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const exitCode = await proc.exited;

    if (exitCode === 0) return true;
    if (options.acceptExitCode1 && exitCode === 1) return true;
    return false;
  } catch {
    return false;
  }
}
