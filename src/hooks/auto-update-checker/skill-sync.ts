import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import * as path from 'node:path';
import { getConfigDir } from '../../cli/paths';
import { log } from '../../utils/logger';

export interface SkillSyncResult {
  installed: string[];
  skippedExisting: string[];
  failed: string[];
}

/**
 * Recursively copies src to dest. Does not follow/copy symbolic links.
 */
function copyDirRecursive(src: string, dest: string): void {
  const stat = lstatSync(src);
  if (stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    const entries = readdirSync(src);
    for (const entry of entries) {
      copyDirRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else if (stat.isFile()) {
    const destDir = path.dirname(dest);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    copyFileSync(src, dest);
  }
}

/**
 * Synchronizes bundled skills from the newly installed package root to OpenCode config skills directory.
 */
export function syncBundledSkillsFromPackage(
  packageRoot: string,
): SkillSyncResult {
  const installed: string[] = [];
  const skippedExisting: string[] = [];
  const failed: string[] = [];

  const sourceSkillsDir = path.join(packageRoot, 'src', 'skills');

  try {
    const stat = lstatSync(sourceSkillsDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      log(
        `[skill-sync] Source skills directory is not a valid directory: ${sourceSkillsDir}`,
      );
      return { installed, skippedExisting, failed };
    }
  } catch {
    log(
      `[skill-sync] Source skills directory does not exist or is unreadable: ${sourceSkillsDir}`,
    );
    return { installed, skippedExisting, failed };
  }

  const destSkillsDir = path.join(getConfigDir(), 'skills');

  try {
    if (!existsSync(destSkillsDir)) {
      mkdirSync(destSkillsDir, { recursive: true });
    }
  } catch (err) {
    log(
      `[skill-sync] Failed to create destination skills directory: ${destSkillsDir}`,
      err,
    );
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(sourceSkillsDir);
  } catch (err) {
    log(
      `[skill-sync] Failed to read source skills directory: ${sourceSkillsDir}`,
      err,
    );
    return { installed, skippedExisting, failed };
  }

  for (const entry of entries) {
    const entryPath = path.join(sourceSkillsDir, entry);
    try {
      if (entry.startsWith('.')) {
        continue;
      }

      const entryStat = lstatSync(entryPath);
      if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
        continue;
      }

      const skillMdPath = path.join(entryPath, 'SKILL.md');
      try {
        const skillMdStat = lstatSync(skillMdPath);
        if (skillMdStat.isSymbolicLink() || !skillMdStat.isFile()) {
          continue;
        }
      } catch {
        continue;
      }

      const destPath = path.join(destSkillsDir, entry);

      let destExists = false;
      try {
        lstatSync(destPath);
        destExists = true;
      } catch {
        // Does not exist
      }

      if (destExists) {
        log(`[skill-sync] Skill already exists in destination: ${entry}`);
        skippedExisting.push(entry);
        continue;
      }

      const stagingDir = mkdtempSync(
        path.join(destSkillsDir, `.sync-staging-${entry}-`),
      );

      try {
        copyDirRecursive(entryPath, stagingDir);

        let destExistsLate = false;
        try {
          lstatSync(destPath);
          destExistsLate = true;
        } catch {}

        if (destExistsLate) {
          log(
            `[skill-sync] Destination path was created during staging for ${entry}, skipping promotion.`,
          );
          skippedExisting.push(entry);
        } else {
          renameSync(stagingDir, destPath);
          installed.push(entry);
          log(`[skill-sync] Successfully synced skill: ${entry}`);
        }
      } catch (err) {
        log(`[skill-sync] Failed to sync skill ${entry}:`, err);
        failed.push(entry);
      } finally {
        try {
          if (existsSync(stagingDir)) {
            rmSync(stagingDir, { recursive: true, force: true });
          }
        } catch (err) {
          log(
            `[skill-sync] Failed to clean up staging directory ${stagingDir}:`,
            err,
          );
        }
      }
    } catch (err) {
      log(`[skill-sync] Error processing source entry ${entry}:`, err);
      failed.push(entry);
    }
  }

  return { installed, skippedExisting, failed };
}
