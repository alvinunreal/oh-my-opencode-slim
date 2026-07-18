import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getOpenCodeConfigPaths,
  stripJsonComments,
} from '../../cli/config-manager';
import { getTuiConfig, getTuiConfigJsonc } from '../../cli/paths';
import { INSTALLER_MANAGED_PLUGIN_OPTION } from '../../plugin-entry';
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

function getPluginEntries(config: OpencodeConfig): unknown[] {
  return Array.isArray(config.plugin) ? config.plugin : [];
}

function getPluginSpec(entry: unknown): string | null {
  if (isString(entry)) return entry;
  return Array.isArray(entry) && isString(entry[0]) ? entry[0] : null;
}

function isInstallerManagedEntry(entry: unknown): boolean {
  return (
    Array.isArray(entry) &&
    entry.length >= 2 &&
    entry[1] !== null &&
    typeof entry[1] === 'object' &&
    !Array.isArray(entry[1]) &&
    (entry[1] as Record<string, unknown>)[INSTALLER_MANAGED_PLUGIN_OPTION] ===
      true
  );
}

type JsoncToken = {
  kind: 'string' | 'literal' | 'punctuation';
  value: string;
  start: number;
  end: number;
};

function tokenizeJsonc(content: string): JsoncToken[] {
  const tokens: JsoncToken[] = [];
  for (let index = 0; index < content.length; ) {
    const char = content[index];
    if (/\s/.test(char)) index++;
    else if (content.startsWith('//', index)) {
      index = content.indexOf('\n', index);
      if (index === -1) break;
    } else if (content.startsWith('/*', index)) {
      index = content.indexOf('*/', index + 2);
      if (index === -1) break;
      index += 2;
    } else if ('[]{}:,'.includes(char)) {
      tokens.push({
        kind: 'punctuation',
        value: char,
        start: index,
        end: ++index,
      });
    } else if (char === '"') {
      const start = index++;
      while (index < content.length) {
        if (content[index] === '\\') index += 2;
        else if (content[index++] === '"') break;
      }
      const raw = content.slice(start, index);
      try {
        tokens.push({
          kind: 'string',
          value: JSON.parse(raw) as string,
          start,
          end: index,
        });
      } catch {
        return [];
      }
    } else {
      const start = index;
      while (index < content.length && !/\s|[[\]{}:,]/.test(content[index]))
        index++;
      tokens.push({
        kind: 'literal',
        value: content.slice(start, index),
        start,
        end: index,
      });
    }
  }
  return tokens;
}

function matchingToken(
  tokens: JsoncToken[],
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].kind === 'punctuation' && tokens[index].value === open)
      depth++;
    if (
      tokens[index].kind === 'punctuation' &&
      tokens[index].value === close &&
      --depth === 0
    )
      return index;
  }
  return -1;
}

function hasDirectInstallerMarker(
  tokens: JsoncToken[],
  objectStart: number,
): boolean {
  const objectEnd = matchingToken(tokens, objectStart, '{', '}');
  if (objectEnd === -1) return false;
  let depth = 1;
  let markerValue = false;
  for (let index = objectStart + 1; index < objectEnd; index++) {
    const value = tokens[index].value;
    if (tokens[index].kind === 'punctuation' && value === '{') depth++;
    else if (tokens[index].kind === 'punctuation' && value === '}') depth--;
    else if (
      depth === 1 &&
      tokens[index].kind === 'string' &&
      value === INSTALLER_MANAGED_PLUGIN_OPTION &&
      tokens[index + 1]?.kind === 'punctuation' &&
      tokens[index + 1]?.value === ':' &&
      tokens[index + 2]
    ) {
      markerValue =
        tokens[index + 2].kind === 'literal' &&
        tokens[index + 2].value === 'true';
    }
  }
  return markerValue;
}

function findManagedSpecifierRanges(content: string): Array<[number, number]> {
  const tokens = tokenizeJsonc(content);
  const rootStart = tokens.findIndex(
    (token) => token.kind === 'punctuation' && token.value === '{',
  );
  if (rootStart === -1) return [];
  const rootEnd = matchingToken(tokens, rootStart, '{', '}');
  if (rootEnd === -1) return [];
  let objectDepth = 1;
  let plugin = -1;
  for (let index = rootStart + 1; index < rootEnd; index++) {
    const value = tokens[index].value;
    if (tokens[index].kind === 'punctuation' && value === '{') objectDepth++;
    else if (tokens[index].kind === 'punctuation' && value === '}')
      objectDepth--;
    else if (
      objectDepth === 1 &&
      value === 'plugin' &&
      tokens[index + 1]?.kind === 'punctuation' &&
      tokens[index + 1]?.value === ':' &&
      tokens[index + 2]?.kind === 'punctuation' &&
      tokens[index + 2]?.value === '['
    ) {
      plugin = index;
    }
  }
  if (plugin === -1) return [];
  const arrayStart = plugin + 2;
  const arrayEnd = matchingToken(tokens, arrayStart, '[', ']');
  if (arrayEnd === -1) return [];
  const ranges: Array<[number, number]> = [];
  for (let index = arrayStart + 1; index < arrayEnd; index++) {
    if (tokens[index].kind !== 'punctuation' || tokens[index].value !== '[')
      continue;
    const tupleEnd = matchingToken(tokens, index, '[', ']');
    if (tupleEnd === -1) break;
    const specifier = tokens[index + 1];
    if (
      specifier?.value.startsWith(`${PACKAGE_NAME}@`) &&
      tokens[index + 2]?.kind === 'punctuation' &&
      tokens[index + 2]?.value === ',' &&
      tokens[index + 3]?.kind === 'punctuation' &&
      tokens[index + 3]?.value === '{' &&
      hasDirectInstallerMarker(tokens, index + 3)
    )
      ranges.push([specifier.start + 1, specifier.end - 1]);
    index = tupleEnd;
  }
  return ranges;
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
  const normalized = version.trim().replace(/^[~^=<>\s]+/, '');
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/);
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
  return comparePrerelease(parsedA.prerelease, parsedB.prerelease);
}

function comparePrerelease(a: string, b: string): number {
  const segmentsA = a.split('.');
  const segmentsB = b.split('.');
  const length = Math.max(segmentsA.length, segmentsB.length);

  for (let i = 0; i < length; i++) {
    const segmentA = segmentsA[i];
    const segmentB = segmentsB[i];
    if (segmentA === segmentB) continue;
    if (segmentA === undefined) return -1;
    if (segmentB === undefined) return 1;

    const numberA = Number(segmentA);
    const numberB = Number(segmentB);
    const numericA = Number.isInteger(numberA);
    const numericB = Number.isInteger(numberB);

    if (numericA && numericB) return numberA - numberB;
    if (numericA) return -1;
    if (numericB) return 1;

    const comparison = segmentA.localeCompare(segmentB);
    if (comparison !== 0) return comparison;
  }

  return 0;
}

function getPrereleaseChannel(version: ParsedVersion): string | null {
  if (!version.prerelease) return null;

  return version.prerelease.split('.')[0] ?? null;
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
    USER_OPENCODE_CONFIG,
    USER_OPENCODE_CONFIG_JSONC,
    path.join(directory, '.opencode', 'opencode.json'),
    path.join(directory, '.opencode', 'opencode.jsonc'),
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
        const spec = getPluginSpec(entry);
        if (!spec) continue;
        if (spec.startsWith('file://') && spec.includes(PACKAGE_NAME)) {
          try {
            return fileURLToPath(spec);
          } catch {
            return spec.replace('file://', '');
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
  let selected: PluginEntryInfo | null = null;
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(stripJsonComments(content)) as OpencodeConfig;
      const plugins = getPluginEntries(config);

      for (const rawEntry of plugins) {
        const entry = getPluginSpec(rawEntry);
        if (!entry) continue;
        if (entry === PACKAGE_NAME) {
          selected = {
            entry,
            isPinned: false,
            isInstallerManaged: false,
            pinnedVersion: null,
            configPath,
          };
          continue;
        }
        if (entry.startsWith(`${PACKAGE_NAME}@`)) {
          const pinnedVersion = entry.slice(PACKAGE_NAME.length + 1);
          const isInstallerManaged = isInstallerManagedEntry(rawEntry);
          const isPinned = pinnedVersion !== 'latest' && !isInstallerManaged;
          selected = {
            entry,
            isPinned,
            isInstallerManaged,
            pinnedVersion: isPinned ? pinnedVersion : null,
            configPath,
          };
        }
      }
    } catch {}
  }
  return selected;
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
export function updateInstallerManagedVersions(
  directory: string,
  newVersion: string,
): boolean {
  try {
    const paths = [
      ...getConfigPaths(directory),
      ...getOpenCodeConfigPaths(),
      getTuiConfig(),
      getTuiConfigJsonc(),
    ]
      .filter((value, index, values) => values.indexOf(value) === index)
      .filter((configPath) => fs.existsSync(configPath));
    const newEntry = `${PACKAGE_NAME}@${newVersion}`;
    const updates = paths.flatMap((configPath) => {
      const content = fs.readFileSync(configPath, 'utf-8');
      const updated = findManagedSpecifierRanges(content)
        .toReversed()
        .reduce(
          (result, [start, end]) =>
            `${result.slice(0, start)}${newEntry}${result.slice(end)}`,
          content,
        );
      const changed = updated !== content;
      return changed
        ? [
            {
              configPath,
              content,
              updated,
            },
          ]
        : [];
    });
    if (updates.length === 0) return false;
    const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    for (const update of updates)
      fs.writeFileSync(`${update.configPath}.${token}.tmp`, update.updated);
    const committed: typeof updates = [];
    try {
      for (const update of updates) {
        fs.renameSync(`${update.configPath}.${token}.tmp`, update.configPath);
        committed.push(update);
      }
    } catch (err) {
      for (const update of committed) {
        const restorePath = `${update.configPath}.${token}.restore`;
        fs.writeFileSync(restorePath, update.content);
        fs.renameSync(restorePath, update.configPath);
      }
      throw err;
    }
    return true;
  } catch (err) {
    log(
      '[auto-update-checker] Failed to update installer-managed configs:',
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
  const distTags = await fetchDistTags();
  return distTags?.[channel] ?? distTags?.latest ?? null;
}

async function fetchDistTags(): Promise<NpmDistTags | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NPM_FETCH_TIMEOUT);

  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as NpmDistTags;
    return data;
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
      latestVersion: null,
      latestMajorVersion: latestVersion,
      blockedByMajor: latestVersion !== null,
      unsafeReason: latestVersion ? 'unparseable-current-version' : undefined,
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
    const taggedVersion = distTags[channel] ?? distTags.latest ?? null;
    const latestMajorVersion = getBlockingMajorVersion(current, [
      taggedVersion,
      distTags.latest,
    ]);
    const blockedByMajor = latestMajorVersion !== null;

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
  const distTags = await fetchDistTags();
  if (!distTags) {
    return {
      latestVersion: null,
      latestMajorVersion: null,
      blockedByMajor: false,
    };
  }

  const latestVersion = distTags[channel] ?? distTags.latest ?? null;
  const latestMajorVersion = getBlockingMajorVersion(current, [
    latestVersion,
    distTags.latest,
  ]);
  const blockedByMajor = latestMajorVersion !== null;
  const parsedLatest = latestVersion ? parseVersion(latestVersion) : null;
  const compatibleLatestVersion =
    parsedLatest?.major === current.major &&
    latestVersion &&
    isVersionInChannel(latestVersion, channel)
      ? latestVersion
      : null;

  return {
    latestVersion: compatibleLatestVersion,
    latestMajorVersion,
    blockedByMajor,
  };
}

function getBlockingMajorVersion(
  current: ParsedVersion,
  candidates: Array<string | null | undefined>,
): string | null {
  for (const candidate of candidates) {
    const parsed = candidate ? parseVersion(candidate) : null;
    if (parsed && parsed.major > current.major) return candidate ?? null;
  }

  return null;
}
