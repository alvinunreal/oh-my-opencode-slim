import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function getDefaultOpenCodeConfigDir(): string {
  const userConfigDir = process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), '.config');

  return join(userConfigDir, 'opencode');
}

function getCustomOpenCodeConfigDir(): string | undefined {
  const configDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  return configDir || undefined;
}

/**
 * Get the OpenCode plugin config directory.
 *
 * Resolution order:
 * 1. OPENCODE_CONFIG_DIR (custom OpenCode directory)
 * 2. XDG_CONFIG_HOME/opencode
 * 3. ~/.config/opencode
 */
export function getConfigDir(): string {
  const customConfigDir = getCustomOpenCodeConfigDir();
  if (customConfigDir) {
    return customConfigDir;
  }

  return getDefaultOpenCodeConfigDir();
}

/**
 * Get OpenCode config directories in read/search order.
 *
 * Resolution order:
 * 1. OPENCODE_CONFIG_DIR (if set)
 * 2. XDG_CONFIG_HOME/opencode or ~/.config/opencode
 *
 * Duplicate entries are removed.
 */
export function getConfigSearchDirs(): string[] {
  const dirs = [getCustomOpenCodeConfigDir(), getDefaultOpenCodeConfigDir()];

  return dirs.filter((dir, index): dir is string => {
    return Boolean(dir) && dirs.indexOf(dir) === index;
  });
}

export function getOpenCodeConfigPaths(): string[] {
  const configDir = getDefaultOpenCodeConfigDir();
  return [join(configDir, 'opencode.json'), join(configDir, 'opencode.jsonc')];
}

export function getConfigJson(): string {
  return getOpenCodeConfigPaths()[0];
}

export function getConfigJsonc(): string {
  return getOpenCodeConfigPaths()[1];
}

export function getLiteConfig(): string {
  return join(getConfigDir(), 'oh-my-opencode-slim.json');
}

export function getLiteConfigJsonc(): string {
  return join(getConfigDir(), 'oh-my-opencode-slim.jsonc');
}

export function getExistingLiteConfigPath(): string {
  const jsonPath = getLiteConfig();
  if (existsSync(jsonPath)) return jsonPath;

  const jsoncPath = getLiteConfigJsonc();
  if (existsSync(jsoncPath)) return jsoncPath;

  return jsonPath;
}

export function getExistingConfigPath(): string {
  const jsonPath = getConfigJson();
  if (existsSync(jsonPath)) return jsonPath;

  const jsoncPath = getConfigJsonc();
  if (existsSync(jsoncPath)) return jsoncPath;

  return jsonPath;
}

export function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
}

/**
 * Ensure the directory for OpenCode's main config file exists.
 */
export function ensureOpenCodeConfigDir(): void {
  const configDir = dirname(getConfigJson());
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
}
