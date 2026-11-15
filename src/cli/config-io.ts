import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mutateJsonFile, writeJsonAtomic } from '../config/json-file';
import { parseJsonConfigText } from '../config/jsonc';
import {
  ensureConfigDir,
  ensureOpenCodeConfigDir,
  getExistingConfigPath,
  getLiteConfig,
} from '../config/paths';
import {
  getPluginSpec,
  getPlugins,
  INSTALLER_MANAGED_PLUGIN_OPTION,
  type PluginEntry,
} from '../plugin-entry';
import { generateLiteConfig } from './providers';
import type { ConfigMergeResult, InstallConfig, OpenCodeConfig } from './types';

const PACKAGE_NAME = 'oh-my-opencode-slim';

function normalizePathForMatch(path: string): string {
  return path.replaceAll('\\', '/');
}

function findPackageRoot(startPath: string): string | null {
  let currentPath = dirname(startPath);

  while (true) {
    const packageJsonPath = join(currentPath, 'package.json');

    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(
          readFileSync(packageJsonPath, 'utf-8'),
        ) as {
          name?: string;
        };

        if (packageJson.name === PACKAGE_NAME) {
          return currentPath;
        }
      } catch {
        // Ignore invalid package.json while walking upward.
      }
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
    currentPath = parentPath;
  }
}

function isLocalPackageRootEntry(entry: string): boolean {
  if (!entry || entry.startsWith('file://')) {
    return false;
  }

  const packageJsonPath = join(entry, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      name?: string;
    };
    return packageJson.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

function isPackageManagerInstall(path: string): boolean {
  const normalizedPath = normalizePathForMatch(path);
  return normalizedPath.includes(`/node_modules/${PACKAGE_NAME}`);
}

function isPluginEntry(entry: string): boolean {
  return (
    entry === PACKAGE_NAME ||
    entry.startsWith(`${PACKAGE_NAME}@`) ||
    (entry.startsWith('file://') && entry.includes(PACKAGE_NAME)) ||
    isLocalPackageRootEntry(entry)
  );
}

function isMatchingPluginEntry(entry: unknown): boolean {
  const spec = getPluginSpec(entry);
  return spec ? isPluginEntry(spec) : false;
}

function removePluginEntries(config: OpenCodeConfig): OpenCodeConfig {
  for (const key of ['plugin', 'plugins'] as const) {
    if (Array.isArray(config[key])) {
      config[key] = config[key].filter(
        (entry) => !isMatchingPluginEntry(entry),
      );
    }
  }
  return config;
}

function getCliEntryPath(): string | undefined {
  const entry = process.argv[1];
  if (!entry) return undefined;
  try {
    return realpathSync(entry);
  } catch {
    return entry;
  }
}

function getPluginEntry(): PluginEntry {
  const cliEntryPath = getCliEntryPath();

  if (!cliEntryPath) {
    return PACKAGE_NAME;
  }

  try {
    const packageRoot = findPackageRoot(cliEntryPath);

    if (!packageRoot) {
      return PACKAGE_NAME;
    }

    if (isPackageManagerInstall(packageRoot)) {
      const version = getVersionFromPackageRoot(packageRoot);
      const requestedTag = getRequestedPackageTag(packageRoot);
      if (!version || !requestedTag || requestedTag === 'latest') {
        return PACKAGE_NAME;
      }
      return {
        package: `${PACKAGE_NAME}@${version}`,
        options: { [INSTALLER_MANAGED_PLUGIN_OPTION]: true },
      };
    }

    return packageRoot;
  } catch {
    return PACKAGE_NAME;
  }
}

function getRequestedPackageTag(packageRoot: string): string | undefined {
  const normalizedPath = normalizePathForMatch(packageRoot);
  const marker = `/bunx-`;
  const markerIndex = normalizedPath.lastIndexOf(marker);
  if (markerIndex === -1) return undefined;

  const bunxSegment = normalizedPath
    .slice(markerIndex + marker.length)
    .split('/')[0];
  const packagePrefix = `${PACKAGE_NAME}@`;
  const packageIndex = bunxSegment.lastIndexOf(packagePrefix);
  if (packageIndex === -1) return undefined;

  const tag = bunxSegment.slice(packageIndex + packagePrefix.length);
  return tag || undefined;
}

/**
 * Reads the version from the package.json at the given package root.
 * Used as a fallback when the config entry is unpinned (e.g. bunx @beta install).
 */
function getVersionFromPackageRoot(packageRoot: string): string | undefined {
  try {
    const packageJsonPath = join(packageRoot, 'package.json');
    if (!existsSync(packageJsonPath)) return undefined;
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

export function parseConfigFile(path: string): {
  config: OpenCodeConfig | null;
  error?: string;
} {
  try {
    if (!existsSync(path)) return { config: null };
    const stat = statSync(path);
    if (stat.size === 0) return { config: null };
    // Strip a UTF-8 BOM (RFC 8259 permits one) so JSON.parse does not choke.
    const content = readFileSync(path, 'utf-8').replace(/^\uFEFF/, '');
    if (content.trim().length === 0) return { config: null };
    return { config: parseJsonConfigText(content) as OpenCodeConfig };
  } catch (err) {
    return { config: null, error: String(err) };
  }
}

export function parseConfig(path: string): {
  config: OpenCodeConfig | null;
  error?: string;
} {
  const result = parseConfigFile(path);
  if (result.config || result.error) return result;

  if (path.endsWith('.json')) {
    const jsoncPath = path.replace(/\.json$/, '.jsonc');
    return parseConfigFile(jsoncPath);
  }
  return { config: null };
}

export async function addPluginToOpenCodeConfig(): Promise<ConfigMergeResult> {
  const configPath = getExistingConfigPath();

  try {
    ensureOpenCodeConfigDir();
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to create config directory: ${err}`,
    };
  }

  try {
    const pluginEntry = getPluginEntry();
    const otherPath = configPath.endsWith('.jsonc')
      ? configPath.slice(0, -1)
      : `${configPath}c`;
    const otherConfig = parseConfigFile(otherPath).config;
    mutateJsonFile(configPath, (current) => {
      const config = removePluginEntries(current as OpenCodeConfig);
      config.plugins = [...(config.plugins ?? []), pluginEntry];
      if (config.lsp === undefined && otherConfig?.lsp === undefined)
        config.lsp = true;
      return config;
    });
    if (
      otherConfig &&
      getPlugins(otherConfig).some(isMatchingPluginEntry) &&
      realpathSync(otherPath) !== realpathSync(configPath)
    ) {
      mutateJsonFile(otherPath, (current) =>
        removePluginEntries(current as OpenCodeConfig),
      );
    }
    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to update opencode config: ${err}`,
    };
  }
}

export function writeLiteConfig(
  installConfig: InstallConfig,
  targetPath?: string,
): ConfigMergeResult {
  const configPath = targetPath ?? getLiteConfig();

  try {
    ensureConfigDir();
    const config = generateLiteConfig(installConfig);
    writeJsonAtomic(configPath, config);

    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to write lite config: ${err}`,
    };
  }
}

// Antigravity, Google provider, and Chutes provider functions removed in simplification refactor.

export function isPluginConfigured(): boolean {
  const { config } = parseConfig(getExistingConfigPath());
  return !!config && getPlugins(config).some(isMatchingPluginEntry);
}
