import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripJsonComments } from '../cli/config-io';
import { getConfigSearchDirs } from '../cli/paths';
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
      rawConfig = JSON.parse(stripJsonComments(content));
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
    tmux: deepMerge(base.tmux, override.tmux),
    multiplexer: deepMerge(base.multiplexer, override.multiplexer),
    interview: deepMerge(base.interview, override.interview),
    sessionManager: deepMerge(base.sessionManager, override.sessionManager),
    divoom: deepMerge(base.divoom, override.divoom),
    fallback: deepMerge(base.fallback, override.fallback),
    council: deepMerge(base.council, override.council),
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
 * Project config takes precedence over user config. Nested objects (agents, tmux) are
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

  // Migrate legacy tmux config to multiplexer config for backward compatibility
  config = migrateTmuxToMultiplexer(config);

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

  return config;
}

/**
 * Load custom prompt for an agent from the prompts directory.
 * Checks for {agent}.md (replaces default) and {agent}_append.md (appends to default).
 * If preset is provided and safe for paths, it first checks {preset}/ subdirectory,
 * then falls back to the root prompts directory.
 *
 * @param agentName - Name of the agent (e.g., "orchestrator", "explorer")
 * @param preset - Optional preset name for preset-scoped prompt lookup
 * @returns Object with prompt and/or appendPrompt if files exist
 */
export function loadAgentPrompt(
  agentName: string,
  preset?: string,
): {
  prompt?: string;
  appendPrompt?: string;
} {
  const presetDirName =
    preset && /^[a-zA-Z0-9_-]+$/.test(preset) ? preset : undefined;
  const promptSearchDirs = getConfigSearchDirs().flatMap((configDir) => {
    const promptsDir = path.join(configDir, PROMPTS_DIR_NAME);
    return presetDirName
      ? [path.join(promptsDir, presetDirName), promptsDir]
      : [promptsDir];
  });
  const result: { prompt?: string; appendPrompt?: string } = {};

  const readFirstPrompt = (
    fileName: string,
    errorPrefix: string,
  ): string | undefined => {
    for (const dir of promptSearchDirs) {
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

/**
 * Migrate legacy tmux config to multiplexer config for backward compatibility.
 * If tmux.enabled is true and no multiplexer config is set, creates a multiplexer
 * config from the tmux settings.
 *
 * @param config - Plugin config to migrate
 * @returns Config with multiplexer settings applied
 */
function migrateTmuxToMultiplexer(config: PluginConfig): PluginConfig {
  // If multiplexer is already configured, use it as-is
  if (config.multiplexer?.type && config.multiplexer.type !== 'none') {
    return config;
  }

  // If tmux is enabled, migrate to multiplexer
  if (config.tmux?.enabled) {
    return {
      ...config,
      multiplexer: {
        type: 'tmux',
        layout: config.tmux.layout ?? 'main-vertical',
        main_pane_size: config.tmux.main_pane_size ?? 60,
      },
    };
  }

  return config;
}
