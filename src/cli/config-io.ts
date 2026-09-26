import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import { MarketplaceLockOwnershipError } from '../marketplace/errors';
import { acquireMarketplaceLease, writeAtomic } from '../marketplace/lease';
import { getMarketplacePaths } from '../marketplace/paths';
import {
  INSTALLER_MANAGED_PLUGIN_OPTION,
  type PluginEntry,
} from '../plugin-entry';
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

/** opencode2 hosts read `plugins` natively and migrate the legacy
 * singular `plugin` key (packages/core/src/config/normalize.ts merges
 * both), so user files carry either key. Read plural-first; writers
 * keep whichever key the file already uses. */
function getPlugins(config: OpenCodeConfig): unknown[] {
  return Array.isArray(config.plugins)
    ? config.plugins
    : Array.isArray(config.plugin)
      ? config.plugin
      : [];
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

function getPluginEntry(): PluginEntry {
  const cliEntryPath = process.argv[1];

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

  const configuredVersion = getConfiguredExactVersion();
  const runningVersion = getVersionFromPackageRoot(packageRoot);
  const requestedTag = getRequestedPackageTag(packageRoot);
  const cacheVersion = configuredVersion ?? requestedTag ?? runningVersion;
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
    // Strip a UTF-8 BOM (RFC 8259 permits one) so JSON.parse does not choke.
    const content = readFileSync(path, 'utf-8').replace(/^\uFEFF/, '');
    if (content.trim().length === 0) return { config: null };
    const errors: Parameters<typeof parseJsonc>[1] = [];
    const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
    if (errors.length > 0) throw new Error('Invalid JSONC config');
    return { config: parsed as OpenCodeConfig };
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
  writeJsonAtomic(configPath, config);
}

type JsonConfig = Record<string, unknown>;

const pendingConfigLeaseCleanup = new Map<
  string,
  ReturnType<typeof acquireMarketplaceLease>
>();

function configWriteLockPaths(configPath: string) {
  const absolutePath = resolve(configPath);
  const lockRoot = join(
    dirname(absolutePath),
    `.${basename(absolutePath)}.write-lock`,
  );
  return getMarketplacePaths(lockRoot);
}

function retryPendingConfigLeaseCleanup(lockDir: string): void {
  const cleanupKey = resolve(lockDir);
  const pending = pendingConfigLeaseCleanup.get(cleanupKey);
  if (!pending) return;

  try {
    pending.release();
  } catch (error) {
    if (!(error instanceof MarketplaceLockOwnershipError)) throw error;
  }
  if (pendingConfigLeaseCleanup.get(cleanupKey) === pending) {
    pendingConfigLeaseCleanup.delete(cleanupKey);
  }
}

function withConfigWriteLease<T>(configPath: string, operation: () => T): T {
  const paths = configWriteLockPaths(configPath);
  retryPendingConfigLeaseCleanup(paths.lockDir);
  const lease = acquireMarketplaceLease(paths);
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = lease.commit(operation);
  } catch (error) {
    operationError = error;
    operationFailed = true;
  }

  try {
    lease.release();
  } catch (releaseError) {
    pendingConfigLeaseCleanup.set(resolve(paths.lockDir), lease);
    if (!operationFailed) throw releaseError;
  }
  if (operationFailed) throw operationError;
  return result as T;
}

/** Run a config operation under the same cross-process lease as its writer. */
export function withSerializedConfigWrites<T>(
  configPaths: string[],
  operation: () => T,
): T {
  const orderedPaths = [
    ...new Set(configPaths.map((path) => resolve(path))),
  ].sort();
  const acquire = (index: number): T => {
    if (index === orderedPaths.length) return operation();
    return withConfigWriteLease(orderedPaths[index], () => acquire(index + 1));
  };
  return acquire(0);
}

function parseJsonConfigText(source: string): JsonConfig {
  const errors: Parameters<typeof parseJsonc>[1] = [];
  const parsed: unknown = parseJsonc(source.replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true,
  });
  if (errors.length > 0) throw new Error('Invalid JSONC config');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Config file must contain a JSON object');
  }
  return parsed as JsonConfig;
}

function publishConfig(
  configPath: string,
  config: OpenCodeConfig,
  currentText?: string,
): void {
  const bakPath = `${configPath}.bak`;
  if (currentText !== undefined) copyFileSync(configPath, bakPath);

  const bom = currentText?.startsWith('\uFEFF') ? '\uFEFF' : '';
  const content =
    configPath.endsWith('.jsonc') && currentText
      ? `${bom}${jsoncDiff(
          currentText.replace(/^\uFEFF/, ''),
          parseJsonConfigText(currentText),
          config,
        )}`
      : `${bom}${JSON.stringify(config, null, 2)}\n`;
  writeAtomic(configPath, content);
}

function jsoncFormattingOptions(source: string) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const indentation = source.match(/(?:^|\r?\n)([ \t]+)"/);
  const indent = indentation?.[1] ?? '  ';
  return {
    insertSpaces: !indent.includes('\t'),
    tabSize: indent.length,
    eol,
  };
}

function jsoncDiff(
  source: string,
  original: unknown,
  updated: unknown,
  path: (string | number)[] = [],
): string {
  if (JSON.stringify(original) === JSON.stringify(updated)) return source;

  if (
    Array.isArray(original) &&
    Array.isArray(updated) &&
    original.length === updated.length
  ) {
    return updated.reduce(
      (latest, value, index) =>
        jsoncDiff(latest, original[index], value, [...path, index]),
      source,
    );
  }

  if (
    original &&
    updated &&
    typeof original === 'object' &&
    typeof updated === 'object' &&
    !Array.isArray(original) &&
    !Array.isArray(updated)
  ) {
    const before = original as Record<string, unknown>;
    const after = updated as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    let latest = source;
    for (const key of keys) {
      const beforeHas = Object.hasOwn(before, key);
      const afterHas = Object.hasOwn(after, key);
      if (beforeHas && afterHas) {
        latest = jsoncDiff(latest, before[key], after[key], [...path, key]);
      } else {
        const edits = modify(
          latest,
          [...path, key],
          afterHas ? after[key] : undefined,
          { formattingOptions: jsoncFormattingOptions(latest) },
        );
        latest = applyEdits(latest, edits);
      }
    }
    return latest;
  }

  const edits = modify(source, path, updated, {
    formattingOptions: jsoncFormattingOptions(source),
  });
  return applyEdits(source, edits);
}

/** Atomically publish a JSON value with a backup of the previous file. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  withConfigWriteLease(filePath, () => {
    const previous = existsSync(filePath)
      ? readFileSync(filePath, 'utf-8')
      : undefined;
    publishConfig(filePath, value as OpenCodeConfig, previous);
  });
}

/** Read, mutate, and atomically publish a JSON/JSONC config under one lease. */
export function mutateJsonFile(
  configPath: string,
  mutate: (current: JsonConfig) => JsonConfig,
): void {
  withConfigWriteLease(configPath, () => {
    const currentText = existsSync(configPath)
      ? readFileSync(configPath, 'utf-8')
      : undefined;
    const current = currentText ? parseJsonConfigText(currentText) : {};
    const originalSnapshot = JSON.parse(JSON.stringify(current)) as JsonConfig;
    const updated = mutate(current);
    if (JSON.stringify(updated) === JSON.stringify(originalSnapshot)) return;
    if (currentText && configPath.endsWith('.jsonc')) {
      publishConfig(configPath, updated as OpenCodeConfig, currentText);
      return;
    }
    publishConfig(configPath, updated as OpenCodeConfig, currentText);
  });
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
      const config = current as OpenCodeConfig;
      const plugins = getPlugins(config);
      const filteredPlugins = plugins.filter(
        (plugin) => !isMatchingPluginEntry(plugin),
      );
      filteredPlugins.push(pluginEntry);
      if (Array.isArray(config.plugins)) config.plugins = filteredPlugins;
      else config.plugin = filteredPlugins;
      return config;
    });
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
    writeConfig(configPath, config as OpenCodeConfig);

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
    mutateJsonFile(configPath, (current) => {
      const config = current as OpenCodeConfig;
      const agent = (config.agent ?? {}) as Record<string, unknown>;
      for (const agentName of DEFAULT_OPENCODE_AGENTS_TO_DISABLE) {
        const existing = agent[agentName];
        agent[agentName] = {
          ...(existing &&
          typeof existing === 'object' &&
          !Array.isArray(existing)
            ? existing
            : {}),
          disable: true,
        };
      }
      config.agent = agent;
      return config;
    });
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
    mutateJsonFile(configPath, (current) => {
      const config = current as OpenCodeConfig;
      if (config.lsp !== undefined) return current;
      config.lsp = true;
      return config;
    });

    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to enable LSP: ${err}`,
    };
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

  const plugins = getPlugins(config);
  result.isInstalled = plugins.some((p) => isMatchingPluginEntry(p));
  result.hasAntigravity = plugins.some((p) => {
    const spec = getPluginSpec(p);
    return spec?.startsWith('opencode-antigravity-auth') ?? false;
  });

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
