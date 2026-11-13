/**
 * Runtime package.json resolution for the v2 host surface.
 *
 * `getCurrentRuntimePackageJsonPath` is imported unconditionally by
 * `src/v2/setup.ts` (bundled-skill registration), so it must NOT live in
 * `./checker.ts`: that module drags the whole updater graph (config paths,
 * plugin entries, version comparison). This leaf keeps the dependency set
 * to node primitives, the logger, and the shared package-root walk.
 *
 * `./checker.ts` imports and re-exports `getCurrentRuntimePackageJsonPath`
 * from here so internal callers/tests keep their existing import path.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../../utils/logger';
import { findOwnedPackageJson } from '../../utils/package-root';
import { PACKAGE_NAME } from './constants';

/**
 * Recursively searches upwards for a package.json belonging to this plugin.
 * Shared with the TUI update notice (`src/utils/package-root.ts`) — no
 * caller-side traversal logic duplicates here.
 */
export function findPackageJsonUp(startPath: string): string | null {
  return findOwnedPackageJson(startPath, PACKAGE_NAME)?.path ?? null;
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
