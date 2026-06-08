import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsonComments } from '../../cli/config-manager';
import { log } from '../../utils/logger';
import {
  INSTALLED_PACKAGE_JSON,
  NPM_FETCH_TIMEOUT,
  NPM_PACKAGE_URL,
  NPM_REGISTRY_URL,
  PACKAGE_NAME,
  USER_OPENCODE_CONFIG,
  USER_OPENCODE_CONFIG_JSONC,
} from './constants';
import type {
  CompatibleVersionResult,
  NpmDistTags,
  NpmPackageMetadata,
  OpencodeConfig,
  PackageJson,
  PluginEntryInfo,
} from './types';

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function getPluginEntries(config: OpencodeConfig): string[] {
  return Array.isArray(config.plugin) ? config.plugin.filter(isString) : [];
}

/**
 * Checks if a version string indicates a prerelease (contains a hyphen).
 */
function isPrereleaseVersion(version: string): boolean {
  return version.includes('-');
}

/**
 * Checks if a version string is an NPM dist-tag (does not start with a digit).
 */
function isDistTag(version: string): boolean {
  return !/^\d/.test(version);
}

function parseVersion(version: string): ParsedVersion | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);
  if (!parsedA || !parsedB) return a.localeCompare(b);

  const parts: Array<keyof Pick<ParsedVersion, 'major' | 'minor' | 'patch'>> = [
    'major',
    'minor',
    'patch',
  ];
  for (const part of parts) {
    if (parsedA[part] !== parsedB[part]) {
      return parsedA[part] - parsedB[part];
    }
  }

  if (parsedA.prerelease === parsedB.prerelease) return 0;
  if (!parsedA.prerelease) return 1;
  if (!parsedB.prerelease) return -1;
  return parsedA.prerelease.localeCompare(parsedB.prerelease);
}

function getPrereleaseChannel(version: ParsedVersion): string | null {
  if (!version.prerelease) return null;

  return version.prerelease.match(/^(alpha|beta|rc|canary|next)/)?.[1] ?? null;
}

function isVersionInChannel(version: string, channel: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  if (channel === 'latest') return parsed.prerelease === null;
  return getPrereleaseChannel(parsed) === channel;
}

/**
 * Extracts the update channel (latest, alpha, beta, etc.) from a version string.
 * @param version The version or tag to analyze.
 * @returns The channel name.
 */
export function extractChannel(version: string | null): string {
  if (!version) return 'latest';

  if (isDistTag(version)) return version;

  if (isPrereleaseVersion(version)) {
    const prereleasePart = version.split('-')[1];
    if (prereleasePart) {
      const channelMatch = prereleasePart.match(/^(alpha|beta|rc|canary|next)/);
      if (channelMatch) return channelMatch[1];
    }
  }

  return 'latest';
}

/**
 * Generates a list of potential OpenCode configuration file paths.
 * @param directory The current plugin directory to check for local .opencode folders.
 */
function getConfigPaths(directory: string): string[] {
  return [
    path.join(directory, '.opencode', 'opencode.json'),
    path.join(directory, '.opencode', 'opencode.jsonc'),
    USER_OPENCODE_CONFIG,
    USER_OPENCODE_CONFIG_JSONC,
  ];
}

/**
 * Attempts to find a local development path (file://) for the plugin in configs.
 */
function getLocalDevPath(directory: string): string | null {
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(stripJsonComments(content)) as OpencodeConfig;
      const plugins = getPluginEntries(config);

      for (const entry of plugins) {
        if (entry.startsWith('file://') && entry.includes(PACKAGE_NAME)) {
          try {
            return fileURLToPath(entry);
          } catch {
            return entry.replace('file://', '');
          }
        }
      }
    } catch {}
  }
  return null;
}

/**
 * Recursively searches upwards for a package.json belonging to this plugin.
 */
function findPackageJsonUp(startPath: string): string | null {
  try {
    const stat = fs.statSync(startPath);
    let dir = stat.isDirectory() ? startPath : path.dirname(startPath);

    for (let i = 0; i < 10; i++) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const content = fs.readFileSync(pkgPath, 'utf-8');
          const pkg = JSON.parse(content) as PackageJson;
          if (pkg.name === PACKAGE_NAME) return pkgPath;
        } catch {
          /* empty */
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* empty */
  }
  return null;
}

/**
 * Resolves the version of the plugin when running in local development mode.
 */
export function getLocalDevVersion(directory: string): string | null {
  const localPath = getLocalDevPath(directory);
  if (!localPath) return null;

  try {
    const pkgPath = findPackageJsonUp(localPath);
    if (!pkgPath) return null;
    const content = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(content) as PackageJson;
    return pkg.version ?? null;
  } catch {
    return null;
  }
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

/**
 * Searches across all config locations to find the current installation entry for this plugin.
 */
export function findPluginEntry(directory: string): PluginEntryInfo | null {
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(stripJsonComments(content)) as OpencodeConfig;
      const plugins = getPluginEntries(config);

      for (const entry of plugins) {
        if (entry === PACKAGE_NAME) {
          return { entry, isPinned: false, pinnedVersion: null, configPath };
        }
        if (entry.startsWith(`${PACKAGE_NAME}@`)) {
          const pinnedVersion = entry.slice(PACKAGE_NAME.length + 1);
          const isPinned = pinnedVersion !== 'latest';
          return {
            entry,
            isPinned,
            pinnedVersion: isPinned ? pinnedVersion : null,
            configPath,
          };
        }
      }
    } catch {}
  }
  return null;
}

const _cachedLocalVersion: string | null = null;
let cachedPackageVersion: string | null = null;

/**
 * Resolves the installed version from node_modules, with memoization.
 */
export function getCachedVersion(): string | null {
  if (cachedPackageVersion) return cachedPackageVersion;

  try {
    const runtimePackageJsonPath = getCurrentRuntimePackageJsonPath();
    if (runtimePackageJsonPath && fs.existsSync(runtimePackageJsonPath)) {
      const content = fs.readFileSync(runtimePackageJsonPath, 'utf-8');
      const pkg = JSON.parse(content) as PackageJson;
      if (pkg.version) {
        cachedPackageVersion = pkg.version;
        return pkg.version;
      }
    }
  } catch {
    /* empty */
  }

  try {
    if (fs.existsSync(INSTALLED_PACKAGE_JSON)) {
      const content = fs.readFileSync(INSTALLED_PACKAGE_JSON, 'utf-8');
      const pkg = JSON.parse(content) as PackageJson;
      if (pkg.version) {
        cachedPackageVersion = pkg.version;
        return pkg.version;
      }
    }
  } catch (err) {
    log(
      '[auto-update-checker] Failed to resolve version from current directory:',
      err,
    );
  }

  return null;
}

/**
 * Safely updates a pinned version in the configuration file.
 * It attempts to replace the exact plugin string to preserve comments and formatting.
 */
export function updatePinnedVersion(
  configPath: string,
  oldEntry: string,
  newVersion: string,
): boolean {
  try {
    if (!fs.existsSync(configPath)) return false;

    const content = fs.readFileSync(configPath, 'utf-8');
    const newEntry = `${PACKAGE_NAME}@${newVersion}`;

    // Check if the old entry actually exists as a quoted string
    const escapedOldEntry = oldEntry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const entryRegex = new RegExp(`(["'])${escapedOldEntry}\\1`, 'g');

    if (!entryRegex.test(content)) {
      log(
        `[auto-update-checker] Entry "${oldEntry}" not found in ${configPath}`,
      );
      return false;
    }

    // Perform the replacement
    const updatedContent = content.replace(entryRegex, `$1${newEntry}$1`);

    if (updatedContent === content) {
      return false;
    }

    fs.writeFileSync(configPath, updatedContent, 'utf-8');
    log(
      `[auto-update-checker] Updated ${configPath}: ${oldEntry} → ${newEntry}`,
    );
    return true;
  } catch (err) {
    log(
      `[auto-update-checker] Failed to update config file ${configPath}:`,
      err,
    );
    return false;
  }
}

/**
 * Fetches the latest version for a specific channel from the NPM registry.
 */
export async function getLatestVersion(
  channel: string = 'latest',
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NPM_FETCH_TIMEOUT);

  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as NpmDistTags;
    return data[channel] ?? data.latest ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Resolves the newest version that is safe for the current install to use.
 * Auto-update never crosses major versions; newer majors are surfaced as a
 * manual migration notification instead.
 */
export async function getLatestCompatibleVersion(
  currentVersion: string,
  channel: string = 'latest',
): Promise<CompatibleVersionResult> {
  const current = parseVersion(currentVersion);
  if (!current) {
    const latestVersion = await getLatestVersion(channel);
    return {
      latestVersion,
      latestMajorVersion: latestVersion,
      blockedByMajor: false,
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NPM_FETCH_TIMEOUT);

  try {
    const response = await fetch(NPM_PACKAGE_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) return await getCompatibleFromDistTags(current, channel);

    const data = (await response.json()) as NpmPackageMetadata;
    const distTags = data['dist-tags'] ?? { latest: '' };
    const latestMajorVersion = distTags.latest || null;
    const taggedVersion = distTags[channel] ?? distTags.latest ?? null;
    const tagged = taggedVersion ? parseVersion(taggedVersion) : null;
    const blockedByMajor = Boolean(tagged && tagged.major > current.major);

    const versions = Object.keys(data.versions ?? {})
      .filter((version) => {
        const parsed = parseVersion(version);
        return (
          parsed?.major === current.major &&
          isVersionInChannel(version, channel)
        );
      })
      .sort(compareVersions);
    const latestVersion = versions.at(-1) ?? null;

    return { latestVersion, latestMajorVersion, blockedByMajor };
  } catch {
    return await getCompatibleFromDistTags(current, channel);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getCompatibleFromDistTags(
  current: ParsedVersion,
  channel: string,
): Promise<CompatibleVersionResult> {
  const latestVersion = await getLatestVersion(channel);
  const latest = latestVersion ? parseVersion(latestVersion) : null;
  const blockedByMajor = Boolean(latest && latest.major > current.major);

  return {
    latestVersion: blockedByMajor ? null : latestVersion,
    latestMajorVersion: latestVersion,
    blockedByMajor,
  };
}
