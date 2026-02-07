import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripJsonComments } from '../cli/config-io';
import { type PluginConfig, PluginConfigSchema } from './schema';

const PROMPTS_DIR_NAME = 'oh-my-opencode-slim';

/**
 * Get the user's configuration directory following XDG Base Directory specification.
 * Falls back to ~/.config if XDG_CONFIG_HOME is not set.
 *
 * @returns The absolute path to the user's config directory
 */
function getUserConfigDir(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/**
 * Load and validate plugin configuration from a specific file path.
 * Supports both .json and .jsonc formats (JSON with comments).
 * Returns null if the file doesn't exist, is invalid, or cannot be read.
 * Logs warnings for validation errors and unexpected read errors.
 *
 * @param configPath - Absolute path to the config file
 * @returns Validated config object, or null if loading failed
 */
function loadConfigFromPath(configPath: string): PluginConfig | null {
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    // Use stripJsonComments to support JSONC format (comments and trailing commas)
    const rawConfig = JSON.parse(stripJsonComments(content));
    const result = PluginConfigSchema.safeParse(rawConfig);

    if (!result.success) {
      console.warn(`[oh-my-opencode-slim] Invalid config at ${configPath}:`);
      console.warn(result.error.format());
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
      console.warn(
        `[oh-my-opencode-slim] Error reading config from ${configPath}:`,
        error.message,
      );
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

/**
 * Recursively merge two objects, with override values taking precedence.
 * For nested objects, merges recursively. For arrays and primitives, override replaces base.
 *
 * @param base - Base object to merge into
 * @param override - Override object whose values take precedence
 * @returns Merged object, or undefined if both inputs are undefined
 */
function deepMerge<T extends Record<string, unknown>>(
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
 * 1. User config: ~/.config/opencode/oh-my-opencode-slim.jsonc or .json (or $XDG_CONFIG_HOME)
 * 2. Project config: <directory>/.opencode/oh-my-opencode-slim.jsonc or .json
 *
 * JSONC format is preferred over JSON (allows comments and trailing commas).
 * Project config takes precedence over user config. Nested objects (agents, tmux) are
 * deep-merged, while top-level arrays are replaced entirely by project config.
 *
 * @param directory - Project directory to search for .opencode config
 * @returns Merged plugin configuration (empty object if no configs found)
 */
export function loadPluginConfig(directory: string): PluginConfig {
  const userConfigBasePath = path.join(
    getUserConfigDir(),
    'opencode',
    'oh-my-opencode-slim',
  );

  const projectConfigBasePath = path.join(
    directory,
    '.opencode',
    'oh-my-opencode-slim',
  );

  // Find existing config files (preferring .jsonc over .json)
  const userConfigPath = findConfigPath(userConfigBasePath);
  const projectConfigPath = findConfigPath(projectConfigBasePath);

  let config: PluginConfig = userConfigPath
    ? (loadConfigFromPath(userConfigPath) ?? {})
    : {};

  const projectConfig = projectConfigPath
    ? loadConfigFromPath(projectConfigPath)
    : null;
  if (projectConfig) {
    config = {
      ...config,
      ...projectConfig,
      agents: deepMerge(config.agents, projectConfig.agents),
      tmux: deepMerge(config.tmux, projectConfig.tmux),
      fallback: deepMerge(config.fallback, projectConfig.fallback),
    };
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
      console.warn(
        `[oh-my-opencode-slim] Preset "${config.preset}" not found (from ${presetSource}). Available presets: ${availablePresets}`,
      );
    }
  }

  return config;
}

/**
 * Load custom prompt for an agent from the prompts directory.
 * Checks for {agent}.md (replaces default) and {agent}_append.md (appends to default).
 *
 * @param agentName - Name of the agent (e.g., "orchestrator", "explorer")
 * @returns Object with prompt and/or appendPrompt if files exist
 */
export function loadAgentPrompt(agentName: string): {
  prompt?: string;
  appendPrompt?: string;
} {
  const promptsDir = path.join(
    getUserConfigDir(),
    'opencode',
    PROMPTS_DIR_NAME,
  );
  const result: { prompt?: string; appendPrompt?: string } = {};

  // Check for replacement prompt
  const promptPath = path.join(promptsDir, `${agentName}.md`);
  if (fs.existsSync(promptPath)) {
    try {
      result.prompt = fs.readFileSync(promptPath, 'utf-8');
    } catch (error) {
      console.warn(
        `[oh-my-opencode-slim] Error reading prompt file ${promptPath}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Check for append prompt
  const appendPromptPath = path.join(promptsDir, `${agentName}_append.md`);
  if (fs.existsSync(appendPromptPath)) {
    try {
      result.appendPrompt = fs.readFileSync(appendPromptPath, 'utf-8');
    } catch (error) {
      console.warn(
        `[oh-my-opencode-slim] Error reading append prompt file ${appendPromptPath}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return result;
}
