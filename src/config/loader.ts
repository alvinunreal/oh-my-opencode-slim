import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripJsonComments } from '../cli/config-io';
import { getConfigSearchDirs } from '../cli/paths';
import { DEFAULT_DISABLED_AGENTS } from './constants';
import { type PluginConfig, PluginConfigSchema } from './schema';

/**
 * Warning kinds produced during config loading.
 */
export type ConfigLoadWarningKind =
  | 'invalid-json'
  | 'invalid-schema'
  | 'read-error'
  | 'missing-preset';

/**
 * A warning emitted while loading plugin configuration.
 */
export interface ConfigLoadWarning {
  path: string;
  kind: ConfigLoadWarningKind;
  message: string;
  formatted?: unknown;
}

/**
 * Options for loadPluginConfig.
 */
export interface LoadPluginConfigOptions {
  /**
   * Called with a warning whenever config loading produces a non-fatal issue.
   * The loader still falls back to defaults and continues normally.
   */
  onWarning?: (warning: ConfigLoadWarning) => void;

  /**
   * Suppress console warnings while still invoking onWarning.
   */
  silent?: boolean;
}

const PROMPTS_DIR_NAME = 'oh-my-opencode-slim';

/**
 * Load and validate plugin configuration from a specific file path.
 * Supports both .json and .jsonc formats (JSON with comments).
 * Returns null if the file doesn't exist, is invalid, or cannot be read.
 * Logs warnings for validation errors and unexpected read errors.
 *
 * @param configPath - Absolute path to the config file
 * @param onWarning - Optional callback for warnings
 * @returns Validated config object, or null if loading failed
 */
function loadConfigFromPath(
  configPath: string,
  options?: LoadPluginConfigOptions,
): PluginConfig | null {
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    // Use stripJsonComments to support JSONC format (comments and trailing commas)
    let rawConfig: unknown;
    try {
      const stripped = stripJsonComments(content);
      const interpolated = stripped.replace(
        /\{env:([^}]+)\}/g,
        (_, varName) => process.env[varName] ?? '',
      );
      rawConfig = JSON.parse(interpolated);
    } catch (error) {
      // Empty file or JSON parse error is treated as invalid-json
      const message = error instanceof Error ? error.message : String(error);
      options?.onWarning?.({
        path: configPath,
        kind: 'invalid-json',
        message,
      });
      if (!options?.silent) {
        console.warn(
          `[oh-my-opencode-slim] Invalid JSON in ${configPath}:`,
          message,
        );
      }
      return null;
    }
    // Warn about deprecated tmux key
    if (
      typeof rawConfig === 'object' &&
      rawConfig !== null &&
      'tmux' in (rawConfig as Record<string, unknown>)
    ) {
      const tmuxMsg =
        'Deprecated tmux config key found and ignored. Use multiplexer config instead.';
      options?.onWarning?.({
        path: configPath,
        kind: 'invalid-schema' as ConfigLoadWarningKind,
        message: tmuxMsg,
      });
      if (!options?.silent) {
        console.warn(`[oh-my-opencode-slim] ${tmuxMsg}`);
      }
    }

    // Warn about deprecated council.master key
    if (
      typeof rawConfig === 'object' &&
      rawConfig !== null &&
      typeof (rawConfig as Record<string, unknown>).council === 'object' &&
      (rawConfig as Record<string, unknown>).council !== null &&
      'master' in
        ((rawConfig as Record<string, unknown>).council as Record<
          string,
          unknown
        >)
    ) {
      const masterMsg =
        'Deprecated council.master config key found and ignored. Configure council agents via presets instead.';
      options?.onWarning?.({
        path: configPath,
        kind: 'invalid-schema' as ConfigLoadWarningKind,
        message: masterMsg,
      });
      if (!options?.silent) {
        console.warn(`[oh-my-opencode-slim] ${masterMsg}`);
      }
    }

    const result = PluginConfigSchema.safeParse(rawConfig);

    if (!result.success) {
      options?.onWarning?.({
        path: configPath,
        kind: 'invalid-schema',
        message: 'Config does not match schema',
        formatted: result.error.format(),
      });
      if (!options?.silent) {
        console.warn(`[oh-my-opencode-slim] Invalid config at ${configPath}:`);
        console.warn(result.error.format());
      }
      return null;
    }

    return result.data;
  } catch (error) {
    // File doesn't exist or isn't readable - this is expected and fine
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      options?.onWarning?.({
        path: configPath,
        kind: 'read-error',
        message: error.message,
      });
      if (!options?.silent) {
        console.warn(
          `[oh-my-opencode-slim] Error reading config from ${configPath}:`,
          error.message,
        );
      }
    }
    return null;
  }
}

/**
 * Find existing config file path, preferring .jsonc over .json.
 * Checks for .jsonc first, then falls back to .json.
 *
 * @param basePath - Base path without extension (e.g., /path/to/oh-my-opencode-slim)
 * @returns Path to existing config file, or null if neither exists
 */
function findConfigPath(basePath: string): string | null {
  const jsoncPath = `${basePath}.jsonc`;
  const jsonPath = `${basePath}.json`;

  // Prefer .jsonc over .json
  if (fs.existsSync(jsoncPath)) {
    return jsoncPath;
  }
  if (fs.existsSync(jsonPath)) {
    return jsonPath;
  }
  return null;
}

function findConfigPathInDirs(
  configDirs: string[],
  baseName: string,
): string | null {
  for (const configDir of configDirs) {
    const configPath = findConfigPath(path.join(configDir, baseName));
    if (configPath) {
      return configPath;
    }
  }

  return null;
}

function validateFinalImageRouting(
  config: PluginConfig,
  configPath: string,
  options?: LoadPluginConfigOptions,
): boolean {
  if (config.image_routing !== 'auto') return true;

  const disabledAgents = config.disabled_agents ?? DEFAULT_DISABLED_AGENTS;
  if (!disabledAgents.includes('observer')) return true;

  const message =
    'image_routing "auto" requires observer to be enabled. ' +
    'Remove "observer" from disabled_agents.';
  options?.onWarning?.({
    path: configPath,
    kind: 'invalid-schema',
    message,
  });
  if (!options?.silent) {
    console.warn(`[oh-my-opencode-slim] Invalid config: ${message}`);
  }
  return false;
}

/**
 * Find plugin config paths (user and project) for a given directory.
 * User config uses getConfigSearchDirs() for lookup.
 * Project config uses <directory>/.opencode/oh-my-opencode-slim.
 *
 * @param directory - Project directory to search for .opencode config
 * @returns Object with userConfigPath and projectConfigPath (null if not found)
 */
export function findPluginConfigPaths(directory: string): {
  userConfigPath: string | null;
  projectConfigPath: string | null;
} {
  const userConfigPath = findConfigPathInDirs(
    getConfigSearchDirs(),
    'oh-my-opencode-slim',
  );

  const projectConfigBasePath = path.join(
    directory,
    '.opencode',
    'oh-my-opencode-slim',
  );

  const projectConfigPath = findConfigPath(projectConfigBasePath);

  return { userConfigPath, projectConfigPath };
}

/**
 * Merge two plugin configs using the loader's merge rules.
 * Project/override takes precedence over base.
 */
export function mergePluginConfigs(
  base: PluginConfig,
  override: PluginConfig,
): PluginConfig {
  return {
    ...base,
    ...override,
    agents: deepMerge(base.agents, override.agents),
    presets: deepMerge(base.presets, override.presets),
    multiplexer: deepMerge(base.multiplexer, override.multiplexer),
    interview: deepMerge(base.interview, override.interview),
    backgroundJobs: deepMerge(base.backgroundJobs, override.backgroundJobs),
    fallback: deepMerge(base.fallback, override.fallback),
    council: deepMerge(base.council, override.council),
    acpAgents: deepMerge(base.acpAgents, override.acpAgents),
    companion: deepMerge(
      base.companion as Record<string, unknown> | undefined,
      override.companion as Record<string, unknown> | undefined,
    ) as PluginConfig['companion'],
  };
}

/**
 * Recursively merge two objects, with override values taking precedence.
 * For nested objects, merges recursively. For arrays and primitives, override replaces base.
 *
 * @param base - Base object to merge into
 * @param override - Override object whose values take precedence
 * @returns Merged object, or undefined if both inputs are undefined
 */
export function deepMerge<T extends Record<string, unknown>>(
  base?: T,
  override?: T,
): T | undefined {
  if (!base) return override;
  if (!override) return base;

  const result = { ...base } as T;
  for (const key of Object.keys(override) as (keyof T)[]) {
    const baseVal = base[key];
    const overrideVal = override[key];

    if (
      typeof baseVal === 'object' &&
      baseVal !== null &&
      typeof overrideVal === 'object' &&
      overrideVal !== null &&
      !Array.isArray(baseVal) &&
      !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      ) as T[keyof T];
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}

/**
 * Load plugin configuration from user and project config files, merging them appropriately.
 *
 * Configuration is loaded from two locations:
 * 1. User config: $OPENCODE_CONFIG_DIR/oh-my-opencode-slim.jsonc or .json,
 *    or ~/.config/opencode/oh-my-opencode-slim.jsonc or .json (or $XDG_CONFIG_HOME)
 * 2. Project config: <directory>/.opencode/oh-my-opencode-slim.jsonc or .json
 *
 * JSONC format is preferred over JSON (allows comments and trailing commas).
 * Project config takes precedence over user config. Nested objects (agents, multiplexer) are
 * deep-merged, while top-level arrays are replaced entirely by project config.
 *
 * @param directory - Project directory to search for .opencode config
 * @param options - Optional load options including onWarning callback
 * @returns Merged plugin configuration (empty object if no configs found)
 */
export function loadPluginConfig(
  directory: string,
  options?: LoadPluginConfigOptions,
): PluginConfig {
  const { userConfigPath, projectConfigPath } =
    findPluginConfigPaths(directory);

  let config: PluginConfig = userConfigPath
    ? (loadConfigFromPath(userConfigPath, options) ?? {})
    : {};

  const projectConfig = projectConfigPath
    ? loadConfigFromPath(projectConfigPath, options)
    : null;
  if (projectConfig) {
    config = mergePluginConfigs(config, projectConfig);
  }

  // Override preset from environment variable if set
  const envPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;
  if (envPreset) {
    config.preset = envPreset;
  }

  // Resolve preset and merge with root agents
  if (config.preset) {
    const preset = config.presets?.[config.preset];
    if (preset) {
      // Merge preset agents with root agents (root overrides)
      config.agents = deepMerge(preset, config.agents);
    } else {
      // Preset name specified but doesn't exist - warn user
      const presetSource =
        envPreset === config.preset ? 'environment variable' : 'config file';
      const availablePresets = config.presets
        ? Object.keys(config.presets).join(', ')
        : 'none';
      const message = `Preset "${config.preset}" not found (from ${presetSource}). Available presets: ${availablePresets}`;
      options?.onWarning?.({
        path: projectConfigPath ?? userConfigPath ?? '',
        kind: 'missing-preset',
        message,
      });
      if (!options?.silent) {
        console.warn(`[oh-my-opencode-slim] ${message}`);
      }
    }
  }

  // Normalize companion config defaults
  if (config.companion) {
    config.companion = {
      enabled: config.companion.enabled ?? false,
      binaryPath: config.companion.binaryPath,
      position: config.companion.position ?? 'bottom-right',
      size: config.companion.size ?? 'medium',
      gifPack: config.companion.gifPack ?? 'default',
      loopStyle: config.companion.loopStyle ?? 'classic',
      speed: config.companion.speed ?? 1,
      debug: config.companion.debug ?? false,
    };
  }

  validateFinalImageRouting(
    config,
    projectConfigPath ?? userConfigPath ?? '',
    options,
  );

  return config;
}

/**
 * Load custom prompt for an agent from the prompts directory.
 * Checks for {agent}.md (replaces default) and {agent}_append.md (appends to default).
 * If preset is provided and safe for paths, it first checks {preset}/ subdirectory,
 * then falls back to the root prompts directory.
 *
 * @param agentName - Name of the agent (e.g., "orchestrator", "explorer")
 * @param optionsOrPreset - Optional preset name or options configuration
 * @returns Object with prompt and/or appendPrompt if files exist
 */
export function loadAgentPrompt(
  agentName: string,
  optionsOrPreset?: string | { preset?: string; projectDirectory?: string },
): {
  prompt?: string;
  appendPrompt?: string;
} {
  let preset: string | undefined;
  let projectDirectory: string | undefined;

  if (typeof optionsOrPreset === 'string') {
    preset = optionsOrPreset;
  } else if (optionsOrPreset && typeof optionsOrPreset === 'object') {
    preset = optionsOrPreset.preset;
    projectDirectory = optionsOrPreset.projectDirectory;
  }

  const presetDirName =
    preset && /^[a-zA-Z0-9_-]+$/.test(preset) ? preset : undefined;

  const searchDirs: string[] = [];

  // Lookup order preference:
  // 1. Project preset dir
  if (projectDirectory && presetDirName) {
    searchDirs.push(
      path.join(projectDirectory, '.opencode', PROMPTS_DIR_NAME, presetDirName),
    );
  }
  // 2. Project root dir
  if (projectDirectory) {
    searchDirs.push(path.join(projectDirectory, '.opencode', PROMPTS_DIR_NAME));
  }
  // 3. User preset dirs
  if (presetDirName) {
    for (const userDir of getConfigSearchDirs()) {
      searchDirs.push(path.join(userDir, PROMPTS_DIR_NAME, presetDirName));
    }
  }
  // 4. User root dirs
  for (const userDir of getConfigSearchDirs()) {
    searchDirs.push(path.join(userDir, PROMPTS_DIR_NAME));
  }

  const readFirstPrompt = (
    fileName: string,
    errorPrefix: string,
  ): string | undefined => {
    for (const dir of searchDirs) {
      const promptPath = path.join(dir, fileName);
      if (!fs.existsSync(promptPath)) {
        continue;
      }

      try {
        return fs.readFileSync(promptPath, 'utf-8');
      } catch (error) {
        console.warn(
          `[oh-my-opencode-slim] ${errorPrefix} ${promptPath}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return undefined;
  };

  const result: { prompt?: string; appendPrompt?: string } = {};

  // Check for replacement prompt
  result.prompt = readFirstPrompt(
    `${agentName}.md`,
    'Error reading prompt file',
  );

  // Check for append prompt
  result.appendPrompt = readFirstPrompt(
    `${agentName}_append.md`,
    'Error reading append prompt file',
  );

  return result;
}
