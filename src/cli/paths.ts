import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function getDefaultOpenCodeConfigDir(): string {
  const userConfigDir = process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), '.config');

  return join(userConfigDir, 'opencode');
}

function getCustomOpenCodeConfigPath(): string | undefined {
  const configPath = process.env.OPENCODE_CONFIG?.trim();
  return configPath && configPath.length > 0 ? configPath : undefined;
}

function getCustomOpenCodeConfigDir(): string | undefined {
  const configDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  return configDir && configDir.length > 0 ? configDir : undefined;
}

function getPathsForCustomConfigFile(configPath: string): string[] {
  if (configPath.endsWith('.jsonc')) {
    return [configPath.replace(/\.jsonc$/, '.json'), configPath];
  }

  if (configPath.endsWith('.json')) {
    return [configPath, configPath.replace(/\.json$/, '.jsonc')];
  }

  return [configPath, `${configPath}.jsonc`];
}

/**
 * Get the OpenCode plugin config directory.
 *
 * Resolution order:
 * 1. OPENCODE_CONFIG_DIR (custom OpenCode directory)
 * 2. OPENCODE_CONFIG parent dir (custom OpenCode config path)
 * 3. XDG_CONFIG_HOME/opencode
 * 4. ~/.config/opencode
 */
export function getConfigDir(): string {
  const customConfigDir = getCustomOpenCodeConfigDir();
  if (customConfigDir) {
    return customConfigDir;
  }

  // If OPENCODE_CONFIG is set, it points to a custom config file
  // (e.g. /custom/path/opencode.json). The config directory is its parent.
  const customConfigPath = getCustomOpenCodeConfigPath();
  if (customConfigPath) {
    return dirname(customConfigPath);
  }

  return getDefaultOpenCodeConfigDir();
}

export function getOpenCodeConfigPaths(): string[] {
  const customConfigPath = getCustomOpenCodeConfigPath();
  if (customConfigPath) {
    return getPathsForCustomConfigFile(customConfigPath);
  }

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
