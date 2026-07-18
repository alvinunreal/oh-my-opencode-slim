import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { crossSpawn } from '../utils/compat';
import {
  ensureConfigDir,
  ensureOpenCodeConfigDir,
  ensureTuiConfigDir,
  getExistingConfigPath,
  getExistingTuiConfigPath,
  getLiteConfig,
} from './paths';
import { generateLiteConfig } from './providers';
import type {
  ConfigMergeResult,
  DetectedConfig,
  InstallConfig,
  OpenCodeConfig,
} from './types';

const PACKAGE_NAME = 'oh-my-opencode-slim';
const DEFAULT_OPENCODE_AGENTS_TO_DISABLE = ['explore', 'general'] as const;

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function getModelIds(model: unknown): string[] {
  if (isString(model)) return [model];
  if (!Array.isArray(model)) return [];

  return model.flatMap((entry) => {
    if (isString(entry)) return [entry];
    if (entry && typeof entry === 'object' && isString(entry.id)) {
      return [entry.id];
    }
    return [];
  });
}

function getPlugins(config: OpenCodeConfig): unknown[] {
  return Array.isArray(config.plugin) ? config.plugin : [];
}

function getPluginEntries(config: OpenCodeConfig): string[] {
  return getPlugins(config).filter(isString);
}

function getPluginSpec(entry: unknown): string | undefined {
  if (isString(entry)) return entry;
  if (!Array.isArray(entry)) return undefined;

  const spec = entry[0];
  return isString(spec) ? spec : undefined;
}

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

function getPluginEntry(): string {
  const cliEntryPath = process.argv[1];

  if (!cliEntryPath) {
    return PACKAGE_NAME;
  }

  try {
    const packageRoot = findPackageRoot(cliEntryPath);

    if (!packageRoot || isPackageManagerInstall(packageRoot)) {
      return PACKAGE_NAME;
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
function getPinnedVersionFromConfig(): string | undefined {
  try {
    const { config } = parseConfig(getExistingConfigPath());
    if (!config) return undefined;
    for (const entry of getPlugins(config)) {
      const spec = getPluginSpec(entry);
      if (!spec) continue;
      if (spec === PACKAGE_NAME) return undefined;
      if (spec.startsWith(`${PACKAGE_NAME}@`)) {
        const version = spec.slice(PACKAGE_NAME.length + 1);
        if (version && version !== 'latest') return version;
      }
    }
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
  const cliEntryPath = process.argv[1];
  if (!cliEntryPath) {
    return null;
  }

  const packageRoot = findPackageRoot(cliEntryPath);
  if (!packageRoot || !isPackageManagerInstall(packageRoot)) {
    return null;
  }

  const pinnedVersion = getPinnedVersionFromConfig();
  const runningVersion = getVersionFromPackageRoot(packageRoot);
  const requestedTag = getRequestedPackageTag(packageRoot);
  const cacheVersion = pinnedVersion ?? requestedTag ?? runningVersion;
  const cacheDir = getOpenCodePluginCacheDir(cacheVersion);

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
    const proc = crossSpawn(['bun', 'install', '--ignore-scripts'], {
      cwd: cacheDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;

    if (proc.exitCode !== 0) {
      const stderr = (await proc.stderr()).trim();
      return {
        success: false,
        configPath: cacheDir,
        error: stderr || `bun install exited with code ${proc.exitCode}`,
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

/**
 * Strip JSON comments (single-line // and multi-line) and trailing commas for JSONC support.
 */
export function stripJsonComments(json: string): string {
  const commentPattern = /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g;
  const trailingCommaPattern = /\\"|"(?:\\"|[^"])*"|(,)(\s*[}\]])/g;

  return json
    .replace(commentPattern, (match, commentGroup) =>
      commentGroup ? '' : match,
    )
    .replace(trailingCommaPattern, (match, comma, closing) =>
      comma ? closing : match,
    );
}

export function parseConfigFile(path: string): {
  config: OpenCodeConfig | null;
  error?: string;
} {
  try {
    if (!existsSync(path)) return { config: null };
    const stat = statSync(path);
    if (stat.size === 0) return { config: null };
    const content = readFileSync(path, 'utf-8');
    if (content.trim().length === 0) return { config: null };
    return { config: JSON.parse(stripJsonComments(content)) as OpenCodeConfig };
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

/**
 * Write config to file atomically.
 */
export function writeConfig(configPath: string, config: OpenCodeConfig): void {
  if (configPath.endsWith('.jsonc')) {
    console.warn(
      '[config-manager] Writing to .jsonc file - comments will not be preserved',
    );
  }

  const tmpPath = `${configPath}.tmp`;
  const bakPath = `${configPath}.bak`;
  const content = `${JSON.stringify(config, null, 2)}\n`;

  // Backup existing config if it exists
  if (existsSync(configPath)) {
    copyFileSync(configPath, bakPath);
  }

  // Atomic write pattern: write to tmp, then rename
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, configPath);
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
    const { config: parsedConfig, error } = parseConfig(configPath);
    if (error) {
      return {
        success: false,
        configPath,
        error: `Failed to parse config: ${error}`,
      };
    }
    const config = parsedConfig ?? {};
    const plugins = getPlugins(config);

    const pluginEntry = getPluginEntry();

    // Remove existing oh-my-opencode-slim entries
    const filteredPlugins = plugins.filter(
      (plugin) => !isMatchingPluginEntry(plugin),
    );

    // Add fresh entry
    filteredPlugins.push(pluginEntry);
    config.plugin = filteredPlugins;

    writeConfig(configPath, config);
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
    const { config: parsedConfig, error } = parseConfig(configPath);
    if (error) {
      return {
        success: false,
        configPath,
        error: `Failed to parse TUI config: ${error}`,
      };
    }
    const config = parsedConfig ?? {};
    const plugins = getPlugins(config);
    const pluginEntry = getPluginEntry();
    const filteredPlugins = plugins.filter(
      (plugin) => !isMatchingPluginEntry(plugin),
    );

    filteredPlugins.push(pluginEntry);
    config.plugin = filteredPlugins;

    writeConfig(configPath, config);
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

    // Atomic write for lite config too
    const tmpPath = `${configPath}.tmp`;
    const bakPath = `${configPath}.bak`;
    const content = `${JSON.stringify(config, null, 2)}\n`;

    // Backup existing config if it exists
    if (existsSync(configPath)) {
      copyFileSync(configPath, bakPath);
    }

    writeFileSync(tmpPath, content);
    renameSync(tmpPath, configPath);

    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to write lite config: ${err}`,
    };
  }
}

export function disableDefaultAgents(): ConfigMergeResult {
  const configPath = getExistingConfigPath();

  try {
    ensureOpenCodeConfigDir();
    const { config: parsedConfig, error } = parseConfig(configPath);
    if (error) {
      return {
        success: false,
        configPath,
        error: `Failed to parse config: ${error}`,
      };
    }
    const config = parsedConfig ?? {};

    const agent = (config.agent ?? {}) as Record<string, unknown>;
    for (const agentName of DEFAULT_OPENCODE_AGENTS_TO_DISABLE) {
      const existing = agent[agentName];
      agent[agentName] = {
        ...(existing && typeof existing === 'object' && !Array.isArray(existing)
          ? existing
          : {}),
        disable: true,
      };
    }
    config.agent = agent;

    writeConfig(configPath, config);
    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to disable default agents: ${err}`,
    };
  }
}

export function enableLspByDefault(): ConfigMergeResult {
  const configPath = getExistingConfigPath();

  try {
    ensureOpenCodeConfigDir();
    const { config: parsedConfig, error } = parseConfig(configPath);
    if (error) {
      return {
        success: false,
        configPath,
        error: `Failed to parse config: ${error}`,
      };
    }
    const config = parsedConfig ?? {};

    if (config.lsp === undefined) {
      config.lsp = true;
      writeConfig(configPath, config);
    }

    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to enable LSP: ${err}`,
    };
  }
}

export function canModifyOpenCodeConfig(): boolean {
  try {
    const configPath = getExistingConfigPath();
    if (!existsSync(configPath)) return true; // Will be created
    const stat = statSync(configPath);
    // Check if writable - simple check for now
    return !!(stat.mode & 0o200);
  } catch {
    return false;
  }
}

// Antigravity, Google provider, and Chutes provider functions removed in simplification refactor.

export function detectCurrentConfig(): DetectedConfig {
  const result: DetectedConfig = {
    isInstalled: false,
    hasKimi: false,
    hasOpenAI: false,
    hasAnthropic: false,
    hasCopilot: false,
    hasZaiPlan: false,
    hasAntigravity: false,
    hasChutes: false,
    hasOpencodeZen: false,
  };

  const { config } = parseConfig(getExistingConfigPath());
  if (!config) return result;

  const plugins = getPluginEntries(config);
  result.isInstalled = plugins.some((p) => isPluginEntry(p));
  result.hasAntigravity = plugins.some((p) =>
    p.startsWith('opencode-antigravity-auth'),
  );

  // Check for providers
  const providers = config.provider as Record<string, unknown> | undefined;
  result.hasKimi = !!providers?.kimi;
  result.hasAnthropic = !!providers?.anthropic;
  result.hasCopilot = !!providers?.['github-copilot'];
  result.hasZaiPlan = !!providers?.['zai-coding-plan'];
  result.hasChutes = !!providers?.chutes;
  if (providers?.google) result.hasAntigravity = true;

  // Try to detect from lite config
  const { config: liteConfig } = parseConfig(getLiteConfig());
  if (liteConfig && typeof liteConfig === 'object') {
    const configObj = liteConfig as Record<string, unknown>;
    const presetName = configObj.preset as string;
    const presets = configObj.presets as Record<string, unknown>;
    const agents = presets?.[presetName] as
      | Record<string, { model?: unknown }>
      | undefined;

    if (agents && typeof agents === 'object') {
      const models = Object.values(agents)
        .filter((a) => a && typeof a === 'object')
        .flatMap((a) => getModelIds(a.model));
      result.hasOpenAI ||= models.some((m) => m.startsWith('openai/'));
      result.hasAnthropic ||= models.some((m) => m.startsWith('anthropic/'));
      result.hasCopilot ||= models.some((m) => m.startsWith('github-copilot/'));
      result.hasZaiPlan ||= models.some((m) =>
        m.startsWith('zai-coding-plan/'),
      );
      result.hasOpencodeZen ||= models.some((m) => m.startsWith('opencode/'));
      if (models.some((m) => m.startsWith('google/'))) {
        result.hasAntigravity = true;
      }
      if (models.some((m) => m.startsWith('chutes/'))) {
        result.hasChutes = true;
      }
    }
  }

  return result;
}
