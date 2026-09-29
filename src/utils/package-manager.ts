import { statSync } from 'node:fs';
import * as path from 'node:path';
import { resolveWindowsCommand } from './compat';

/**
 * Package manager resolution for install/cache-warm-up flows.
 *
 * Prefers the running bun runtime (always spawnable, even when bun is not on
 * PATH — covers standalone opencode binaries), then probes PATH for bun, then
 * npm. Returns null when neither is available so callers can report a clear
 * actionable error instead of crashing on ENOENT from a bare `spawn('bun')`.
 */
export type ResolvedPackageManager =
  | { packageManager: 'bun'; command: string }
  | { packageManager: 'npm'; command: 'npm' }
  | null;

/**
 * Returns the running bun runtime as a bun package manager when the current
 * executable is bun. Exported for unit testing: process.execPath cannot be
 * changed at runtime.
 */
export function resolveRuntimeBun(execPath: string): ResolvedPackageManager {
  if (
    typeof Bun !== 'undefined' &&
    /^bun(\.exe)?$/i.test(path.basename(execPath))
  ) {
    return { packageManager: 'bun', command: execPath };
  }
  return null;
}

/**
 * True for a regular file the current user may execute. `statSync` follows
 * symlinks, matching how the shell resolves PATH entries (e.g. a symlink to
 * a real binary counts, while a bare non-executable shim does not).
 */
function isExecutableFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    return stat.isFile() && (stat.mode & 0o100) !== 0;
  } catch {
    return false;
  }
}

/**
 * Windows half of the PATH probe, extracted so the cmd.exe/PATHEXT
 * semantics can be exercised on any OS. Delegates to the cmd.exe-aware
 * resolver from `./compat`; a command is "on PATH" when any PATHEXT
 * candidate exists in a PATH directory.
 */
export function isOnPathWindows(
  command: string,
  pathEnv: string,
  pathExtEnv?: string,
): boolean {
  return resolveWindowsCommand(command, pathEnv, pathExtEnv) !== undefined;
}

/**
 * Probes PATH for a bare command. On Windows this reuses the cmd.exe-aware
 * resolver from `./compat`; elsewhere it walks PATH and looks for a regular
 * file with the user-execute bit set (matching execvp, which rejects
 * non-executable PATH entries). Only a boolean is reported — callers spawn
 * the bare name and let the platform resolve it through PATH.
 */
function isOnPath(
  command: string,
  pathEnv: string = process.env.PATH ?? '',
): boolean {
  if (process.platform === 'win32') {
    return isOnPathWindows(command, pathEnv);
  }
  if (!pathEnv) return false;

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    if (isExecutableFile(path.join(dir, command))) return true;
  }
  return false;
}

/**
 * Resolves the package manager used for plugin installs and cache warm-up.
 *
 * Resolution order: running bun runtime → bun on PATH → npm on PATH → null.
 * `execPath` is injectable for tests; production callers use the default.
 */
export function resolvePackageManager(
  execPath: string = process.execPath,
): ResolvedPackageManager {
  const runtimeBun = resolveRuntimeBun(execPath);
  if (runtimeBun) return runtimeBun;

  if (isOnPath('bun', process.env.PATH ?? ''))
    return { packageManager: 'bun', command: 'bun' };
  if (isOnPath('npm', process.env.PATH ?? ''))
    return { packageManager: 'npm', command: 'npm' };
  return null;
}
