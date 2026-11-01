import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mutateJsonFile, writeJsonAtomic } from '../config/json-file';
import { parseJsonConfigText } from '../config/jsonc';
import {
  ensureConfigDir,
  ensureOpenCodeConfigDir,
  ensureTuiConfigDir,
  getExistingConfigPath,
  getExistingTuiConfigPath,
  getLiteConfig,
} from '../config/paths';
import {
  getPluginSpec,
  getPlugins,
  INSTALLER_MANAGED_PLUGIN_OPTION,
  type PluginEntry,
} from '../plugin-entry';
import { crossSpawn } from '../utils/compat';
import { resolvePackageInstallCommand } from '../utils/package-manager';
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
      return [
        `${PACKAGE_NAME}@${version}`,
        { [INSTALLER_MANAGED_PLUGIN_OPTION]: true },
      ];
    }

    return packageRoot;
  } catch {
    return PACKAGE_NAME;
  }
}

/**
 * Reads the OpenCode config to find the pinned version for this plugin.
 * Returns the version string (e.g. "1.2.3") if pinned, or undefined
 * if the plugin is unpinned (bare name or @latest).
 */
function getConfiguredExactVersion(): string | undefined {
  try {
    const { config } = parseConfig(getExistingConfigPath());
    if (!config) return undefined;
    let version: string | undefined;
    for (const entry of getPlugins(config)) {
      const spec = getPluginSpec(entry);
      if (!spec) continue;
      if (spec === PACKAGE_NAME) {
        version = undefined;
      } else if (spec.startsWith(`${PACKAGE_NAME}@`)) {
        const candidate = spec.slice(PACKAGE_NAME.length + 1);
        version = candidate && candidate !== 'latest' ? candidate : undefined;
      }
    }
    return version;
  } catch {}
  return undefined;
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

function getOpenCodePluginCacheDir(version?: string): string {
  const cacheDir =
    process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache');
  const suffix = version
    ? `${PACKAGE_NAME}@${version}`
    : `${PACKAGE_NAME}@latest`;
  return join(cacheDir, 'opencode', 'packages', suffix);
}

function writeOpenCodePluginCacheManifest(
  cacheDir: string,
  version: string = 'latest',
): ConfigMergeResult | null {
  try {
    writeFileSync(
      join(cacheDir, 'package.json'),
      JSON.stringify(
        {
          name: `${PACKAGE_NAME}-cache`,
          private: true,
          dependencies: {
            [PACKAGE_NAME]: version,
          },
        },
        null,
        2,
      ),
    );
    return null;
  } catch (err) {
    return {
      success: false,
      configPath: cacheDir,
      error: `Failed to write cache package.json: ${err}`,
    };
  }
}

function removeOpenCodePluginCacheArtifacts(cacheDir: string): void {
  rmSync(join(cacheDir, 'node_modules', PACKAGE_NAME), {
    recursive: true,
    force: true,
  });
  rmSync(join(cacheDir, 'bun.lock'), { force: true });
  rmSync(join(cacheDir, 'bun.lockb'), { force: true });
  rmSync(join(cacheDir, 'package-lock.json'), { force: true });
  rmSync(join(cacheDir, 'node_modules', '.package-lock.json'), { force: true });
}

function verifyOpenCodePluginCache(cacheDir: string): ConfigMergeResult | null {
  const pluginPackageJsonPath = join(
    cacheDir,
    'node_modules',
    PACKAGE_NAME,
    'package.json',
  );

  if (!existsSync(pluginPackageJsonPath)) {
    return {
      success: false,
      configPath: cacheDir,
      error: `Cached plugin package not found at ${pluginPackageJsonPath}`,
    };
  }

  try {
    const packageJson = JSON.parse(
      readFileSync(pluginPackageJsonPath, 'utf-8'),
    ) as {
      name?: string;
    };

    if (packageJson.name !== PACKAGE_NAME) {
      return {
        success: false,
        configPath: cacheDir,
        error: `Cached plugin package has unexpected name: ${packageJson.name}`,
      };
    }
  } catch (err) {
    return {
      success: false,
      configPath: cacheDir,
      error: `Failed to verify cached plugin package: ${err}`,
    };
  }

  return null;
}

export async function warmOpenCodePluginCache(): Promise<ConfigMergeResult | null> {
  const cliEntryPath = getCliEntryPath();
  if (!cliEntryPath) {
    return null;
  }

  const packageRoot = findPackageRoot(cliEntryPath);
  if (!packageRoot || !isPackageManagerInstall(packageRoot)) {
    return null;
  }

  // Warm the directory OpenCode v1 reads for the configured entry: an exact
  // pin maps to <name>@<version>, a bare entry to <name>@latest.
  const cacheVersion = getConfiguredExactVersion() ?? 'latest';
  const cacheDir = getOpenCodePluginCacheDir(cacheVersion);

  // Resolve before touching the cache so a missing package manager never
  // removes the plugin OpenCode currently loads.
  const install = resolvePackageInstallCommand();
  if (!install) {
    return {
      success: false,
      configPath: cacheDir,
      error:
        'No bun or npm found on PATH; install either to warm the OpenCode plugin cache.',
    };
  }

  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch (err) {
    return {
      success: false,
      configPath: cacheDir,
      error: `Failed to create OpenCode cache directory: ${err}`,
    };
  }

  const manifestError = writeOpenCodePluginCacheManifest(
    cacheDir,
    cacheVersion,
  );
  if (manifestError) return manifestError;

  removeOpenCodePluginCacheArtifacts(cacheDir);

  try {
    const proc = crossSpawn(install.command, {
      cwd: cacheDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: install.env,
    });
    await proc.exited;

    if (proc.exitCode !== 0) {
      const stderr = (await proc.stderr()).trim();
      return {
        success: false,
        configPath: cacheDir,
        error:
          stderr ||
          `${install.command.join(' ')} exited with code ${proc.exitCode}`,
      };
    }

    const verificationError = verifyOpenCodePluginCache(cacheDir);
    if (verificationError) return verificationError;

    return { success: true, configPath: cacheDir };
  } catch (err) {
    return {
      success: false,
      configPath: cacheDir,
      error: `Failed to warm OpenCode cache: ${err}`,
    };
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
    mutateJsonFile(configPath, (current) => {
      const config = removePluginEntries(current as OpenCodeConfig);
      config.plugin = [...(config.plugin ?? []), pluginEntry];
      if (config.lsp === undefined) config.lsp = true;
      return config;
    });
    const otherPath = configPath.endsWith('.jsonc')
      ? configPath.slice(0, -1)
      : `${configPath}c`;
    const otherConfig = parseConfigFile(otherPath).config;
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

export async function addPluginToOpenCodeTuiConfig(): Promise<ConfigMergeResult> {
  const configPath = getExistingTuiConfigPath();

  try {
    ensureTuiConfigDir();
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to create config directory: ${err}`,
    };
  }

  try {
    const pluginEntry = getPluginEntry();
    mutateJsonFile(configPath, (current) => {
      const config = current as OpenCodeConfig;
      const filteredPlugins = getPlugins(config).filter(
        (plugin) => !isMatchingPluginEntry(plugin),
      );
      filteredPlugins.push(pluginEntry);
      config.plugin = filteredPlugins;
      return config;
    });
    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to update opencode TUI config: ${err}`,
    };
  }
}

// Removed: addAuthPlugins - no longer needed with cliproxy
// Removed: addProviderConfig - default opencode now has kimi provider config

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
