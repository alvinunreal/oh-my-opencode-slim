import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PluginConfigSchema, type PluginConfig } from "./schema";

const CONFIG_FILENAME = "oh-my-opencode-slim.json";

/**
 * Get the user's configuration directory following XDG Base Directory specification.
 * Falls back to ~/.config if XDG_CONFIG_HOME is not set.
 * 
 * @returns The absolute path to the user's config directory
 */
function getUserConfigDir(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

/**
 * Load and validate plugin configuration from a specific file path.
 * Returns null if the file doesn't exist, is invalid, or cannot be read.
 * Logs warnings for validation errors and unexpected read errors.
 * 
 * @param configPath - Absolute path to the config file
 * @returns Validated config object, or null if loading failed
 */
function loadConfigFromPath(configPath: string): PluginConfig | null {
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const rawConfig = JSON.parse(content);
    const result = PluginConfigSchema.safeParse(rawConfig);

    if (!result.success) {
      console.warn(`[oh-my-opencode-slim] Invalid config at ${configPath}:`);
      console.warn(result.error.format());
      return null;
    }

    return result.data;
  } catch (error) {
    // File doesn't exist or isn't readable - this is expected and fine
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[oh-my-opencode-slim] Error reading config from ${configPath}:`, error.message);
    }
    return null;
  }
}

/**
 * Recursively merge two objects, with override values taking precedence.
 * For nested objects, merges recursively. For arrays and primitives, override replaces base.
 * 
 * @param base - Base object to merge into
 * @param override - Override object whose values take precedence
 * @returns Merged object, or undefined if both inputs are undefined
 */
function deepMerge<T extends Record<string, unknown>>(base?: T, override?: T): T | undefined {
  if (!base) return override;
  if (!override) return base;

  const result = { ...base } as T;
  for (const key of Object.keys(override) as (keyof T)[]) {
    const baseVal = base[key];
    const overrideVal = override[key];

    if (
      typeof baseVal === "object" && baseVal !== null &&
      typeof overrideVal === "object" && overrideVal !== null &&
      !Array.isArray(baseVal) && !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>
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
 * 1. User config: ~/.config/opencode/oh-my-opencode-slim.json (or $XDG_CONFIG_HOME)
 * 2. Project config: <directory>/.opencode/oh-my-opencode-slim.json
 * 
 * Project config takes precedence over user config. Nested objects (agents, tmux) are
 * deep-merged, while top-level arrays are replaced entirely by project config.
 * 
 * @param directory - Project directory to search for .opencode config
 * @returns Merged plugin configuration (empty object if no configs found)
 */
export function loadPluginConfig(directory: string): PluginConfig {
  const userConfigPath = path.join(
    getUserConfigDir(),
    "opencode",
    CONFIG_FILENAME
  );

  const projectConfigPath = path.join(directory, ".opencode", CONFIG_FILENAME);

  let config: PluginConfig = loadConfigFromPath(userConfigPath) ?? {};

  const projectConfig = loadConfigFromPath(projectConfigPath);
  if (projectConfig) {
    config = {
      ...config,
      ...projectConfig,
      agents: deepMerge(config.agents, projectConfig.agents),
      tmux: deepMerge(config.tmux, projectConfig.tmux),
    };
  }

  return config;
}
