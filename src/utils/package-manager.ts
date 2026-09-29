import { existsSync, statSync } from 'node:fs';
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

function isRegularFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Probes PATH for a bare command. On Windows this reuses the cmd.exe-aware
 * resolver from `./compat`; elsewhere it walks PATH and looks for a regular
 * file. Only a boolean is reported — callers spawn the bare name and let the
 * platform resolve it through PATH.
 */
function isOnPath(command: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  if (process.platform === 'win32') {
    return resolveWindowsCommand(command, pathEnv) !== undefined;
  }
  if (!pathEnv) return false;

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    if (isRegularFile(path.join(dir, command))) return true;
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

  if (isOnPath('bun')) return { packageManager: 'bun', command: 'bun' };
  if (isOnPath('npm')) return { packageManager: 'npm', command: 'npm' };
  return null;
}
