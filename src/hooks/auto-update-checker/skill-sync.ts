import * as crypto from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CUSTOM_SKILLS } from '../../cli/custom-skills-registry';
import { getConfigDir } from '../../cli/paths';
import { log } from '../../utils/logger';

let localProcessToken = (
  globalThis as { OMO_SKILL_SYNC_PROCESS_TOKEN?: string }
).OMO_SKILL_SYNC_PROCESS_TOKEN;
if (!localProcessToken) {
  localProcessToken = crypto.randomUUID();
  (
    globalThis as { OMO_SKILL_SYNC_PROCESS_TOKEN?: string }
  ).OMO_SKILL_SYNC_PROCESS_TOKEN = localProcessToken;
}
const PROCESS_TOKEN = localProcessToken;

const ACQUIRED_LOCKS = new Set<string>();

export interface SkillSyncResult {
  installed: string[];
  skippedExisting: string[];
  failed: string[];
  staged: string[];
  adopted: string[];
  customized: string[];
}

export interface SkillManifestEntry {
  status: 'managed' | 'customized' | 'deleted' | 'conflict';
  packageVersion: string;
  sourceHash: string;
  lastManagedHash: string;
  lastSeenHash: string;
  stagedPath?: string;
  updatedAt: string;
}

export interface SkillsManifest {
  schemaVersion: number;
  updatedAt: string;
  skills: Record<string, SkillManifestEntry>;
}

interface ManagedSkillSource {
  name: string;
  sourcePath: string;
}

interface SkillSyncOptions {
  skills?: ManagedSkillSource[];
}

/**
 * Hashes of historically managed versions of skills.
 * When a release changes skill content, this table must be populated
 * from the published npm package tarballs to allow upgrading existing users.
 *
 * How to populate:
 * 1. Download previous releases of the npm package: `npm pack oh-my-opencode-slim@<version>`
 * 2. Compute directory hash for each legacy skill directory inside the unpacked tarball:
 *    `import { computeDirectoryHash } from './skill-sync';`
 *    `const hash = computeDirectoryHash('path/to/extracted/package/src/skills/<skill-name>');`
 * 3. Append the hash to the skill's string array below:
 *    ```typescript
 *    export const LEGACY_MANAGED_SKILL_HASHES: Record<string, string[]> = {
 *      'simplify': ['hash1', 'hash2'],
 *      'codemap': ['hash3']
 *    };
 *    ```
 */
export const LEGACY_MANAGED_SKILL_HASHES: Record<string, string[]> = {};

/**
 * Full manifest validation: schemaVersion must be supported (1),
 * skills object record, status in managed/customized/deleted/conflict.
 */
function validateManifest(data: unknown): data is SkillsManifest {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as { schemaVersion?: unknown; skills?: unknown };
  if (d.schemaVersion !== 1) return false;
  if (typeof d.skills !== 'object' || d.skills === null) return false;

  const allowedStatuses = new Set([
    'managed',
    'customized',
    'deleted',
    'conflict',
  ]);
  const skillsObj = d.skills as Record<string, unknown>;
  for (const key of Object.keys(skillsObj)) {
    const entry = skillsObj[key] as Record<string, unknown>;
    if (typeof entry !== 'object' || entry === null) return false;
    if (typeof entry.status !== 'string' || !allowedStatuses.has(entry.status))
      return false;
    if (typeof entry.packageVersion !== 'string') return false;
    if (typeof entry.sourceHash !== 'string') return false;
    if (typeof entry.lastManagedHash !== 'string') return false;
    if (typeof entry.lastSeenHash !== 'string') return false;
    if (entry.stagedPath !== undefined && typeof entry.stagedPath !== 'string')
      return false;
    if (typeof entry.updatedAt !== 'string') return false;
  }
  return true;
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
 * Computes a deterministic SHA-256 hash of a directory's files.
 */
export function computeDirectoryHash(dirPath: string): string {
  const hash = crypto.createHash('sha256');
  const entriesToHash: {
    relativePath: string;
    absolutePath: string;
    kind: 'directory' | 'file';
    mode: number;
  }[] = [];

  function traverse(currentDir: string) {
    const entries = readdirSync(currentDir);
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry);
      const stat = lstatSync(absolutePath);
      const relativePath = path.relative(dirPath, absolutePath);
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        entriesToHash.push({
          relativePath,
          absolutePath,
          kind: 'directory',
          mode: stat.mode,
        });
        traverse(absolutePath);
      } else if (stat.isFile()) {
        entriesToHash.push({
          relativePath,
          absolutePath,
          kind: 'file',
          mode: stat.mode,
        });
      }
    }
  }

  traverse(dirPath);

  entriesToHash.sort((a, b) => {
    if (a.relativePath < b.relativePath) return -1;
    if (a.relativePath > b.relativePath) return 1;
    return 0;
  });

  for (const entry of entriesToHash) {
    hash.update(entry.kind);
    hash.update('\0');
    hash.update(entry.relativePath);
    hash.update('\0');
    hash.update(String(entry.mode & 0o7777));
    hash.update('\0');
    if (entry.kind === 'file') {
      const content = readFileSync(entry.absolutePath);
      hash.update(content);
    }
  }

  return hash.digest('hex');
}

/**
 * Checks if a PID is alive on the current host.
 */
function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

const CROSS_HOST_LOCK_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Acquires a simple lock under .oh-my-opencode-slim.
 * Avoids stealing active locks purely by time; writes owner metadata
 * and only steals dead same-host pid if detectable.
 */
export function acquireLock(lockDir: string): boolean {
  const metadataPath = path.join(lockDir, 'owner.json');
  const currentHost = os.hostname();
  const currentPid = process.pid;

  const writeMetadata = () => {
    try {
      const metadata = {
        pid: currentPid,
        host: currentHost,
        time: Date.now(),
        token: PROCESS_TOKEN,
      };
      writeFileSync(metadataPath, JSON.stringify(metadata), 'utf-8');
    } catch {
      // Ignored
    }
  };

  try {
    mkdirSync(lockDir);
    writeMetadata();
    ACQUIRED_LOCKS.add(path.resolve(lockDir));
    return true;
  } catch (err) {
    if ((err as { code?: string }).code !== 'EEXIST') {
      throw err;
    }
  }

  try {
    let shouldSteal = false;
    let ageMs = 0;

    if (existsSync(metadataPath)) {
      try {
        const content = readFileSync(metadataPath, 'utf-8');
        const metadata = JSON.parse(content);
        ageMs = Date.now() - metadata.time;

        if (metadata.host === currentHost) {
          if (!isPidRunning(metadata.pid)) {
            log(
              `[skill-sync] Lock owner process ${metadata.pid} is not running on this host. Recovery path.`,
            );
            shouldSteal = true;
          }
        } else {
          if (ageMs > CROSS_HOST_LOCK_EXPIRY_MS) {
            log(
              `[skill-sync] Lock owned by different host ${metadata.host} has expired (${Math.round(ageMs / 1000)}s old). Reclaiming lock.`,
            );
            shouldSteal = true;
          } else {
            log(
              `[skill-sync] Lock is owned by different host ${metadata.host}; failing closed.`,
            );
          }
        }
      } catch {
        shouldSteal = true;
      }
    } else {
      const stat = lstatSync(lockDir);
      ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > 30000) {
        shouldSteal = true;
      }
    }

    if (!shouldSteal) return false;

    log(`[skill-sync] Stealing/recovering lock directory.`);
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
    writeMetadata();
    ACQUIRED_LOCKS.add(path.resolve(lockDir));
    return true;
  } catch (err) {
    log(`[skill-sync] Failed to check/recover lock at ${lockDir}:`, err);
    return false;
  }
}

/**
 * Releases the lock.
 */
export function releaseLock(lockDir: string): void {
  const resolvedPath = path.resolve(lockDir);
  try {
    let isOurLock = false;
    const metadataPath = path.join(lockDir, 'owner.json');

    if (existsSync(metadataPath)) {
      try {
        const content = readFileSync(metadataPath, 'utf-8');
        const metadata = JSON.parse(content);
        if (
          metadata.host === os.hostname() &&
          metadata.pid === process.pid &&
          metadata.token === PROCESS_TOKEN
        ) {
          isOurLock = true;
        } else {
          isOurLock = false;
        }
      } catch (err) {
        log(`[skill-sync] Lock owner.json is unreadable/corrupt:`, err);
        isOurLock = false;
      }
    } else if (ACQUIRED_LOCKS.has(resolvedPath)) {
      isOurLock = true;
    }

    if (isOurLock) {
      if (existsSync(lockDir)) {
        rmSync(lockDir, { recursive: true, force: true });
      }
    } else if (existsSync(lockDir)) {
      log(
        `[skill-sync] Skipping lock directory removal: lock is not owned by this process/token or owner.json check failed.`,
      );
    }
  } catch (err) {
    log(`[skill-sync] Failed to release lock at ${lockDir}:`, err);
  } finally {
    ACQUIRED_LOCKS.delete(resolvedPath);
  }
}

/**
 * Atomic directory replacement: copy to staging, backup dest, rename staging to dest, remove backup.
 * Rolls back on failure.
 */
function atomicReplaceDir(sourceDir: string, destDir: string): void {
  const parentDir = path.dirname(destDir);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const stagingDir = path.join(
    parentDir,
    `.staging-${path.basename(destDir)}-${uniqueSuffix}`,
  );
  const backupDir = path.join(
    parentDir,
    `.backup-${path.basename(destDir)}-${uniqueSuffix}`,
  );

  let backupCreated = false;

  try {
    copyDirRecursive(sourceDir, stagingDir);

    if (existsSync(destDir)) {
      renameSync(destDir, backupDir);
      backupCreated = true;
    }

    renameSync(stagingDir, destDir);

    if (backupCreated) {
      rmSync(backupDir, { recursive: true, force: true });
    }
  } catch (err) {
    log(
      `[skill-sync] Error during atomic replace for ${destDir}. Rolling back:`,
      err,
    );

    if (backupCreated) {
      try {
        if (existsSync(destDir)) {
          rmSync(destDir, { recursive: true, force: true });
        }
        renameSync(backupDir, destDir);
      } catch (rollbackErr) {
        log(
          `[skill-sync] Critical error during rollback for ${destDir}:`,
          rollbackErr,
        );
      }
    }

    try {
      if (existsSync(stagingDir)) {
        rmSync(stagingDir, { recursive: true, force: true });
      }
    } catch {}

    throw err;
  }
}

/**
 * Verifies if an entry matches .backup-${skillName}-${uniqueSuffix} or .staging-${skillName}-${uniqueSuffix}.
 */
function matchesArtifactPattern(
  entry: string,
  prefix: string,
  skillName: string,
): boolean {
  if (!entry.startsWith(prefix)) return false;
  const rest = entry.slice(prefix.length);
  if (!rest.startsWith(`${skillName}-`)) return false;

  const suffix = rest.slice(skillName.length + 1);
  const firstPart = suffix.split('-')[0];
  const timestamp = Number(firstPart);
  if (Number.isNaN(timestamp) || timestamp <= 0) return false;

  return true;
}

/**
 * Recovers orphan .backup-* and .staging-* directories.
 * Returns true if any were found.
 */
function recoverOrphanArtifacts(
  destSkillsDir: string,
  skillName: string,
): boolean {
  if (!existsSync(destSkillsDir)) return false;

  let hadArtifacts = false;
  let entries: string[] = [];
  try {
    entries = readdirSync(destSkillsDir);
  } catch {
    return false;
  }

  const backups: string[] = [];
  const stagings: string[] = [];

  for (const entry of entries) {
    if (matchesArtifactPattern(entry, '.backup-', skillName)) {
      backups.push(path.join(destSkillsDir, entry));
      hadArtifacts = true;
    } else if (matchesArtifactPattern(entry, '.staging-', skillName)) {
      stagings.push(path.join(destSkillsDir, entry));
      hadArtifacts = true;
    }
  }

  const destPath = path.join(destSkillsDir, skillName);

  if (backups.length > 0) {
    backups.sort();
    const mostRecentBackup = backups[backups.length - 1];

    if (!existsSync(destPath)) {
      backups.pop();
      try {
        renameSync(mostRecentBackup, destPath);
        log(
          `[skill-sync] Recovered backup for ${skillName} back to destination.`,
        );
      } catch (err) {
        log(`[skill-sync] Failed to restore backup for ${skillName}:`, err);
      }
    }

    for (const backup of backups) {
      try {
        rmSync(backup, { recursive: true, force: true });
      } catch (err) {
        log(`[skill-sync] Failed to clean up backup folder ${backup}:`, err);
      }
    }
  }

  for (const staging of stagings) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch (err) {
      log(`[skill-sync] Failed to clean up staging folder ${staging}:`, err);
    }
  }

  return hadArtifacts;
}

/**
 * Safely removes a directory only if it resides within the plugin staged updates directory.
 */
function removeManagedStagedPath(
  stagedPath: string,
  manifestDir: string,
  skillName: string,
): void {
  try {
    const absoluteStagedPath = path.resolve(stagedPath);
    const absoluteAllowedRoot = path.resolve(
      path.join(manifestDir, 'skill-updates'),
    );

    const relative = path.relative(absoluteAllowedRoot, absoluteStagedPath);
    const isUnderRoot =
      relative && !relative.startsWith('..') && !path.isAbsolute(relative);

    if (isUnderRoot) {
      if (existsSync(absoluteStagedPath)) {
        rmSync(absoluteStagedPath, { recursive: true, force: true });
        log(
          `[skill-sync] Safely cleaned up staged path for ${skillName}: ${absoluteStagedPath}`,
        );
      }
    } else {
      log(
        `[skill-sync] Refusing to delete staged path for ${skillName}: path ${absoluteStagedPath} is not under managed root ${absoluteAllowedRoot}`,
      );
    }
  } catch (err) {
    log(
      `[skill-sync] Error while trying to verify and remove staged path for ${skillName} (${stagedPath}):`,
      err,
    );
  }
}

/**
 * Synchronizes bundled skills from the newly installed package root to OpenCode config skills directory.
 */
export function syncBundledSkillsFromPackage(
  packageRoot: string,
  options: SkillSyncOptions = {},
): SkillSyncResult {
  const installed: string[] = [];
  const skippedExisting: string[] = [];
  const failed: string[] = [];
  const staged: string[] = [];
  const adopted: string[] = [];
  const customized: string[] = [];

  const sourceSkillsDir = path.join(packageRoot, 'src', 'skills');

  try {
    const stat = lstatSync(sourceSkillsDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      log(
        `[skill-sync] Source skills directory is not a valid directory: ${sourceSkillsDir}`,
      );
      return {
        installed,
        skippedExisting,
        failed,
        staged,
        adopted,
        customized,
      };
    }
  } catch {
    log(
      `[skill-sync] Source skills directory does not exist or is unreadable: ${sourceSkillsDir}`,
    );
    return {
      installed,
      skippedExisting,
      failed,
      staged,
      adopted,
      customized,
    };
  }

  let packageVersion = 'unknown';
  try {
    const pkgJsonPath = path.join(packageRoot, 'package.json');
    if (existsSync(pkgJsonPath)) {
      const content = readFileSync(pkgJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      if (pkg.version) {
        packageVersion = pkg.version;
      }
    }
  } catch (err) {
    log(
      `[skill-sync] Failed to read package version from ${packageRoot}:`,
      err,
    );
  }

  const manifestDir = path.join(getConfigDir(), '.oh-my-opencode-slim');
  const lockDir = path.join(manifestDir, 'skills.lock');

  try {
    mkdirSync(manifestDir, { recursive: true });
  } catch (err) {
    log(
      `[skill-sync] Failed to create manifest directory: ${manifestDir}`,
      err,
    );
  }

  if (!acquireLock(lockDir)) {
    log(
      '[skill-sync] Failed to acquire lock for skill synchronization. Skipping.',
    );
    return {
      installed,
      skippedExisting,
      failed: ['__lock__'],
      staged,
      adopted,
      customized,
    };
  }

  try {
    const manifestPath = path.join(manifestDir, 'skills-manifest.json');
    let manifest: SkillsManifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      skills: {},
    };
    let isManifestCorrupt = false;

    if (existsSync(manifestPath)) {
      try {
        const content = readFileSync(manifestPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (validateManifest(parsed)) {
          manifest = parsed;
        } else {
          throw new Error('Manifest validation failed');
        }
      } catch (err) {
        log(
          '[skill-sync] Manifest is corrupt/unreadable. Failing closed.',
          err,
        );
        isManifestCorrupt = true;
      }
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

    const skillsToProcess = (options.skills ?? CUSTOM_SKILLS).map((s) => ({
      name: s.name,
      sourcePath: s.sourcePath,
    }));

    for (const skill of skillsToProcess) {
      try {
        const sourcePath = path.join(packageRoot, skill.sourcePath);

        try {
          const stat = lstatSync(sourcePath);
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            continue;
          }
          const skillMdPath = path.join(sourcePath, 'SKILL.md');
          const skillMdStat = lstatSync(skillMdPath);
          if (skillMdStat.isSymbolicLink() || !skillMdStat.isFile()) {
            continue;
          }
        } catch {
          continue;
        }

        const destPath = path.join(destSkillsDir, skill.name);

        // Crash-safe recovery
        const hadArtifacts = recoverOrphanArtifacts(destSkillsDir, skill.name);

        let destExists = false;
        let destIsDir = false;
        try {
          const destStat = lstatSync(destPath);
          destExists = true;
          destIsDir = destStat.isDirectory() && !destStat.isSymbolicLink();
        } catch {
          // Does not exist
        }

        if (destExists && !destIsDir) {
          log(
            `[skill-sync] Skill ${skill.name} destination is a file or symlink (conflict). Skipping.`,
          );
          skippedExisting.push(skill.name);
          const sourceHash = computeDirectoryHash(sourcePath);
          const entry = manifest.skills[skill.name];
          if (entry?.stagedPath) {
            removeManagedStagedPath(entry.stagedPath, manifestDir, skill.name);
          }
          manifest.skills[skill.name] = {
            status: 'conflict',
            packageVersion,
            sourceHash,
            lastManagedHash: '',
            lastSeenHash: '',
            updatedAt: new Date().toISOString(),
          };
          continue;
        }

        const sourceHash = computeDirectoryHash(sourcePath);

        if (isManifestCorrupt) {
          if (!destExists) {
            try {
              atomicReplaceDir(sourcePath, destPath);
              installed.push(skill.name);
              manifest.skills[skill.name] = {
                status: 'managed',
                packageVersion,
                sourceHash,
                lastManagedHash: sourceHash,
                lastSeenHash: sourceHash,
                updatedAt: new Date().toISOString(),
              };
            } catch (err) {
              log(
                `[skill-sync] Failed to install missing skill ${skill.name} (corrupt manifest mode):`,
                err,
              );
              failed.push(skill.name);
            }
          } else {
            log(
              `[skill-sync] Skipping existing skill ${skill.name} because manifest is corrupt.`,
            );
            skippedExisting.push(skill.name);
            const destHash = computeDirectoryHash(destPath);
            if (destHash === sourceHash) {
              manifest.skills[skill.name] = {
                status: 'managed',
                packageVersion,
                sourceHash,
                lastManagedHash: sourceHash,
                lastSeenHash: sourceHash,
                updatedAt: new Date().toISOString(),
              };
            } else {
              try {
                const stagedSkillDir = path.join(
                  manifestDir,
                  'skill-updates',
                  packageVersion,
                  skill.name,
                );
                if (existsSync(stagedSkillDir)) {
                  rmSync(stagedSkillDir, { recursive: true, force: true });
                }
                mkdirSync(stagedSkillDir, { recursive: true });
                copyDirRecursive(sourcePath, stagedSkillDir);

                manifest.skills[skill.name] = {
                  status: 'customized',
                  packageVersion,
                  sourceHash,
                  lastManagedHash: '',
                  lastSeenHash: destHash,
                  stagedPath: stagedSkillDir,
                  updatedAt: new Date().toISOString(),
                };
                staged.push(skill.name);
                customized.push(skill.name);
              } catch (err) {
                log(
                  `[skill-sync] Failed to stage update for customized skill ${skill.name} during recovery:`,
                  err,
                );
                manifest.skills[skill.name] = {
                  status: 'customized',
                  packageVersion: 'unknown',
                  sourceHash: '',
                  lastManagedHash: '',
                  lastSeenHash: destHash,
                  updatedAt: new Date().toISOString(),
                };
              }
            }
          }
          continue;
        }

        const entry = manifest.skills[skill.name];

        if (!destExists) {
          if (entry && entry.status === 'deleted') {
            log(
              `[skill-sync] Skill ${skill.name} was deleted by user. Skipping.`,
            );
            skippedExisting.push(skill.name);
            continue;
          }
          if (entry && entry.status !== 'deleted') {
            if (hadArtifacts) {
              log(
                `[skill-sync] Managed skill ${skill.name} has backup/staging artifacts. Skipping delete, re-installing.`,
              );
              try {
                atomicReplaceDir(sourcePath, destPath);
                installed.push(skill.name);
                manifest.skills[skill.name] = {
                  status: 'managed',
                  packageVersion,
                  sourceHash,
                  lastManagedHash: sourceHash,
                  lastSeenHash: sourceHash,
                  updatedAt: new Date().toISOString(),
                };
              } catch (err) {
                log(
                  `[skill-sync] Failed to re-install skill ${skill.name}:`,
                  err,
                );
                failed.push(skill.name);
              }
              continue;
            } else {
              if (entry.stagedPath) {
                removeManagedStagedPath(
                  entry.stagedPath,
                  manifestDir,
                  skill.name,
                );
                delete entry.stagedPath;
              }
              const rawEntry = entry as unknown as Record<string, unknown>;
              delete rawEntry.stagedVersion;
              delete rawEntry.stagedHash;
              entry.status = 'deleted';
              entry.updatedAt = new Date().toISOString();
              log(
                `[skill-sync] Skill ${skill.name} was deleted by user (detected now). Skipping.`,
              );
              skippedExisting.push(skill.name);
              continue;
            }
          }

          try {
            atomicReplaceDir(sourcePath, destPath);
            installed.push(skill.name);
            manifest.skills[skill.name] = {
              status: 'managed',
              packageVersion,
              sourceHash,
              lastManagedHash: sourceHash,
              lastSeenHash: sourceHash,
              updatedAt: new Date().toISOString(),
            };
            log(
              `[skill-sync] Successfully installed missing skill: ${skill.name}`,
            );
          } catch (err) {
            log(`[skill-sync] Failed to install skill ${skill.name}:`, err);
            failed.push(skill.name);
          }
          continue;
        }

        const destHash = computeDirectoryHash(destPath);

        if (entry) {
          if (entry.status === 'managed') {
            if (destHash === entry.lastManagedHash) {
              if (destHash === sourceHash) {
                entry.packageVersion = packageVersion;
                entry.sourceHash = sourceHash;
                entry.lastManagedHash = sourceHash;
                entry.lastSeenHash = sourceHash;
                entry.updatedAt = new Date().toISOString();
                skippedExisting.push(skill.name);
              } else {
                try {
                  atomicReplaceDir(sourcePath, destPath);
                  installed.push(skill.name);
                  manifest.skills[skill.name] = {
                    status: 'managed',
                    packageVersion,
                    sourceHash,
                    lastManagedHash: sourceHash,
                    lastSeenHash: sourceHash,
                    updatedAt: new Date().toISOString(),
                  };
                  log(`[skill-sync] Updated managed skill: ${skill.name}`);
                } catch (err) {
                  log(
                    `[skill-sync] Failed to update managed skill ${skill.name}:`,
                    err,
                  );
                  failed.push(skill.name);
                }
              }
            } else {
              if (destHash === sourceHash) {
                manifest.skills[skill.name] = {
                  status: 'managed',
                  packageVersion,
                  sourceHash,
                  lastManagedHash: sourceHash,
                  lastSeenHash: sourceHash,
                  updatedAt: new Date().toISOString(),
                };
                skippedExisting.push(skill.name);
              } else {
                try {
                  const stagedSkillDir = path.join(
                    manifestDir,
                    'skill-updates',
                    packageVersion,
                    skill.name,
                  );
                  if (entry.stagedPath && entry.stagedPath !== stagedSkillDir) {
                    removeManagedStagedPath(
                      entry.stagedPath,
                      manifestDir,
                      skill.name,
                    );
                  }
                  if (existsSync(stagedSkillDir)) {
                    rmSync(stagedSkillDir, { recursive: true, force: true });
                  }
                  mkdirSync(stagedSkillDir, { recursive: true });
                  copyDirRecursive(sourcePath, stagedSkillDir);

                  entry.status = 'customized';
                  entry.lastSeenHash = destHash;
                  entry.stagedPath = stagedSkillDir;
                  entry.sourceHash = sourceHash;
                  entry.packageVersion = packageVersion;
                  entry.updatedAt = new Date().toISOString();

                  staged.push(skill.name);
                  customized.push(skill.name);
                  skippedExisting.push(skill.name);
                  log(
                    `[skill-sync] Skill ${skill.name} is customized. Staged update at ${stagedSkillDir}`,
                  );
                } catch (err) {
                  log(
                    `[skill-sync] Failed to stage update for customized skill ${skill.name}:`,
                    err,
                  );
                  failed.push(skill.name);
                }
              }
            }
          } else if (entry.status === 'customized') {
            if (destHash === sourceHash) {
              if (entry.stagedPath) {
                removeManagedStagedPath(
                  entry.stagedPath,
                  manifestDir,
                  skill.name,
                );
              }
              entry.status = 'managed';
              entry.lastManagedHash = sourceHash;
              entry.lastSeenHash = sourceHash;
              entry.sourceHash = sourceHash;
              entry.packageVersion = packageVersion;
              delete entry.stagedPath;
              entry.updatedAt = new Date().toISOString();
              adopted.push(skill.name);
              skippedExisting.push(skill.name);
              log(
                `[skill-sync] Customized skill ${skill.name} converged with current version. Adopted back to managed.`,
              );
            } else {
              entry.lastSeenHash = destHash;
              entry.updatedAt = new Date().toISOString();

              if (destHash !== sourceHash && entry.sourceHash !== sourceHash) {
                try {
                  const stagedSkillDir = path.join(
                    manifestDir,
                    'skill-updates',
                    packageVersion,
                    skill.name,
                  );
                  if (entry.stagedPath && entry.stagedPath !== stagedSkillDir) {
                    removeManagedStagedPath(
                      entry.stagedPath,
                      manifestDir,
                      skill.name,
                    );
                  }
                  if (existsSync(stagedSkillDir)) {
                    rmSync(stagedSkillDir, { recursive: true, force: true });
                  }
                  mkdirSync(stagedSkillDir, { recursive: true });
                  copyDirRecursive(sourcePath, stagedSkillDir);

                  entry.stagedPath = stagedSkillDir;
                  entry.sourceHash = sourceHash;
                  entry.packageVersion = packageVersion;

                  staged.push(skill.name);
                  customized.push(skill.name);
                  skippedExisting.push(skill.name);
                  log(
                    `[skill-sync] Staged new update for customized skill ${skill.name} at ${stagedSkillDir}`,
                  );
                } catch (err) {
                  log(
                    `[skill-sync] Failed to stage update for customized skill ${skill.name}:`,
                    err,
                  );
                  failed.push(skill.name);
                }
              } else {
                customized.push(skill.name);
                skippedExisting.push(skill.name);
              }
            }
          } else if (entry.status === 'deleted') {
            if (destHash === sourceHash) {
              entry.status = 'managed';
              entry.packageVersion = packageVersion;
              entry.sourceHash = sourceHash;
              entry.lastManagedHash = sourceHash;
              entry.lastSeenHash = sourceHash;
              entry.updatedAt = new Date().toISOString();
              skippedExisting.push(skill.name);
              adopted.push(skill.name);
              log(
                `[skill-sync] Skill ${skill.name} re-created by user (matching current). Adopted as managed.`,
              );
            } else {
              try {
                const stagedSkillDir = path.join(
                  manifestDir,
                  'skill-updates',
                  packageVersion,
                  skill.name,
                );
                if (entry.stagedPath && entry.stagedPath !== stagedSkillDir) {
                  removeManagedStagedPath(
                    entry.stagedPath,
                    manifestDir,
                    skill.name,
                  );
                }
                if (existsSync(stagedSkillDir)) {
                  rmSync(stagedSkillDir, { recursive: true, force: true });
                }
                mkdirSync(stagedSkillDir, { recursive: true });
                copyDirRecursive(sourcePath, stagedSkillDir);

                entry.status = 'customized';
                entry.packageVersion = packageVersion;
                entry.sourceHash = sourceHash;
                entry.lastManagedHash = sourceHash;
                entry.lastSeenHash = destHash;
                entry.stagedPath = stagedSkillDir;
                entry.updatedAt = new Date().toISOString();

                staged.push(skill.name);
                customized.push(skill.name);
                skippedExisting.push(skill.name);
                log(
                  `[skill-sync] Skill ${skill.name} re-created by user (custom). Marked customized and staged.`,
                );
              } catch (err) {
                log(
                  `[skill-sync] Failed to stage update for deleted/recreated skill ${skill.name}:`,
                  err,
                );
                failed.push(skill.name);
              }
            }
          } else if (entry.status === 'conflict') {
            if (destHash === sourceHash) {
              if (entry.stagedPath) {
                removeManagedStagedPath(
                  entry.stagedPath,
                  manifestDir,
                  skill.name,
                );
              }
              entry.status = 'managed';
              entry.packageVersion = packageVersion;
              entry.sourceHash = sourceHash;
              entry.lastManagedHash = sourceHash;
              entry.lastSeenHash = sourceHash;
              delete entry.stagedPath;
              entry.updatedAt = new Date().toISOString();
              adopted.push(skill.name);
            } else {
              try {
                const stagedSkillDir = path.join(
                  manifestDir,
                  'skill-updates',
                  packageVersion,
                  skill.name,
                );
                if (entry.stagedPath && entry.stagedPath !== stagedSkillDir) {
                  removeManagedStagedPath(
                    entry.stagedPath,
                    manifestDir,
                    skill.name,
                  );
                }
                if (existsSync(stagedSkillDir)) {
                  rmSync(stagedSkillDir, { recursive: true, force: true });
                }
                mkdirSync(stagedSkillDir, { recursive: true });
                copyDirRecursive(sourcePath, stagedSkillDir);

                entry.status = 'customized';
                entry.packageVersion = packageVersion;
                entry.sourceHash = sourceHash;
                entry.lastManagedHash = sourceHash;
                entry.lastSeenHash = destHash;
                entry.stagedPath = stagedSkillDir;
                entry.updatedAt = new Date().toISOString();

                staged.push(skill.name);
                customized.push(skill.name);
                skippedExisting.push(skill.name);
                log(
                  `[skill-sync] Conflicted skill ${skill.name} recovered as customized and staged at ${stagedSkillDir}`,
                );
              } catch (err) {
                log(
                  `[skill-sync] Failed to stage update for conflicted skill ${skill.name}:`,
                  err,
                );
                failed.push(skill.name);
              }
            }
          }
        } else {
          if (destHash === sourceHash) {
            manifest.skills[skill.name] = {
              status: 'managed',
              packageVersion,
              sourceHash,
              lastManagedHash: sourceHash,
              lastSeenHash: sourceHash,
              updatedAt: new Date().toISOString(),
            };
            skippedExisting.push(skill.name);
            adopted.push(skill.name);
            log(`[skill-sync] Adopted existing matching skill: ${skill.name}`);
          } else if (
            LEGACY_MANAGED_SKILL_HASHES[skill.name]?.includes(destHash)
          ) {
            try {
              atomicReplaceDir(sourcePath, destPath);
              installed.push(skill.name);
              manifest.skills[skill.name] = {
                status: 'managed',
                packageVersion,
                sourceHash,
                lastManagedHash: sourceHash,
                lastSeenHash: sourceHash,
                updatedAt: new Date().toISOString(),
              };
              log(
                `[skill-sync] Adopted and updated legacy skill: ${skill.name}`,
              );
            } catch (err) {
              log(
                `[skill-sync] Failed to update legacy skill ${skill.name}:`,
                err,
              );
              failed.push(skill.name);
            }
          } else {
            try {
              const stagedSkillDir = path.join(
                manifestDir,
                'skill-updates',
                packageVersion,
                skill.name,
              );
              if (existsSync(stagedSkillDir)) {
                rmSync(stagedSkillDir, { recursive: true, force: true });
              }
              mkdirSync(stagedSkillDir, { recursive: true });
              copyDirRecursive(sourcePath, stagedSkillDir);

              manifest.skills[skill.name] = {
                status: 'customized',
                packageVersion,
                sourceHash,
                lastManagedHash: '',
                lastSeenHash: destHash,
                stagedPath: stagedSkillDir,
                updatedAt: new Date().toISOString(),
              };
              staged.push(skill.name);
              customized.push(skill.name);
              skippedExisting.push(skill.name);
              log(
                `[skill-sync] Skill ${skill.name} is customized (no manifest entry). Staged update at ${stagedSkillDir}`,
              );
            } catch (err) {
              log(
                `[skill-sync] Failed to stage update for customized skill ${skill.name}:`,
                err,
              );
              failed.push(skill.name);
            }
          }
        }
      } catch (err) {
        log(`[skill-sync] Failed processing skill ${skill.name}:`, err);
        failed.push(skill.name);
      }
    }

    let manifestWriteFailed = false;
    manifest.updatedAt = new Date().toISOString();
    const tempManifestPath = `${manifestPath}.${Math.random().toString(36).slice(2, 9)}.tmp`;
    try {
      writeFileSync(
        tempManifestPath,
        JSON.stringify(manifest, null, 2),
        'utf-8',
      );
      renameSync(tempManifestPath, manifestPath);
    } catch (err) {
      log('[skill-sync] Failed to write skills manifest atomically:', err);
      manifestWriteFailed = true;
      try {
        if (existsSync(tempManifestPath)) {
          unlinkSync(tempManifestPath);
        }
      } catch {}
    }

    if (manifestWriteFailed) {
      failed.push('__manifest__');
    }
  } finally {
    releaseLock(lockDir);
  }

  return {
    installed,
    skippedExisting,
    failed,
    staged,
    adopted,
    customized,
  };
}
