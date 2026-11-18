import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ID } from '../../config/constants';
import { log } from '../../utils/logger';
import { findOwnedPackageJson } from '../../utils/package-root';

/**
 * Recursively searches upwards for a package.json belonging to this plugin.
 * Shared with the TUI update notice (`src/utils/package-root.ts`) — no
 * caller-side traversal logic duplicates here.
 */
function findPackageJsonUp(startPath: string): string | null {
  return findOwnedPackageJson(startPath, PLUGIN_ID)?.path ?? null;
}

/**
 * Resolves the package.json for the currently running plugin bundle.
 */
export function getCurrentRuntimePackageJsonPath(
  currentModuleUrl: string = import.meta.url,
): string | null {
  try {
    const currentDir = path.dirname(fileURLToPath(currentModuleUrl));
    return findPackageJsonUp(currentDir);
  } catch (err) {
    log('[auto-update-checker] Failed to resolve runtime package path:', err);
    return null;
  }
}
