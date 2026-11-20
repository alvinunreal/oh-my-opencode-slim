import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Process-wide cleanup seam installed once by `manager.ts` at module load.
 * Undefined until the manager loads, which is the fresh disabled-startup case.
 */
type CompanionCleanup = (sessionId: string) => void;

let companionCleanup: CompanionCleanup | undefined;

export function registerCompanionCleanup(cleanup: CompanionCleanup): void {
  companionCleanup = cleanup;
}

export function stateFilePath(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base =
    xdg && path.isAbsolute(xdg)
      ? xdg
      : path.join(os.homedir(), '.local', 'share');
  return path.join(
    base,
    'opencode',
    'storage',
    'oh-my-opencode-slim',
    'companion-state.json',
  );
}

export function normalizeCompanionDirectory(directory: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(directory);
  } catch {
    resolved = path.resolve(directory);
  }
  const normalized =
    resolved.replace(/[\\/]+$/, '') || path.parse(resolved).root;
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function companionSessionIdForDirectory(directory: string): string {
  const digest = createHash('sha256')
    .update(normalizeCompanionDirectory(directory))
    .digest('hex')
    .slice(0, 12);
  return `proc_${process.pid}_${digest}`;
}

/**
 * Disabled-startup cleanup that stays light when there is nothing to prune.
 *
 * Missing state file: nothing persisted to remove, so only the registered
 * manager seam runs — synchronously, before any await, with no dynamic import.
 * State present: load the manager (or reuse it) and run the original prune,
 * which owns dispose-before-prune ordering and state locking.
 */
export async function pruneDisabledCompanionRuntime(
  sessionId: string,
): Promise<void> {
  if (!existsSync(stateFilePath())) {
    companionCleanup?.(sessionId);
    return;
  }
  const { pruneDisabledCompanionSession } = await import('./manager');
  pruneDisabledCompanionSession(sessionId);
}
