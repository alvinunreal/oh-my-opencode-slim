import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseJsonConfigText } from './jsonc';

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

function getCustomTuiConfigPath(): string | undefined {
  const configPath = process.env.OPENCODE_TUI_CONFIG?.trim();
  return configPath || undefined;
}

export function getOpenCodeConfigPaths(): string[] {
  const configDir = getConfigDir();
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

export function getTuiConfig(): string {
  const customConfigPath = getCustomTuiConfigPath();
  if (customConfigPath) return customConfigPath;
  return join(getConfigDir(), 'tui.json');
}

export function getTuiConfigJsonc(): string {
  return join(getConfigDir(), 'tui.jsonc');
}

function existsOrSymlink(filePath: string): boolean {
  if (existsSync(filePath)) return true;
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function getExistingLiteConfigPath(): string {
  const jsonPath = getLiteConfig();
  const jsoncPath = getLiteConfigJsonc();
  if (existsOrSymlink(jsoncPath)) return jsoncPath;
  return jsonPath;
}

export function getExistingTuiConfigPath(): string {
  const customConfigPath = getCustomTuiConfigPath();
  if (customConfigPath) return customConfigPath;
  const jsonPath = join(getConfigDir(), 'tui.json');
  const jsoncPath = getTuiConfigJsonc();
  if (existsOrSymlink(jsoncPath)) return jsoncPath;
  return jsonPath;
}

export function getExistingConfigPath(): string {
  const jsonPath = getConfigJson();
  const jsoncPath = getConfigJsonc();
  for (const path of [jsoncPath, jsonPath]) {
    if (!existsOrSymlink(path)) continue;
    try {
      if (
        Object.hasOwn(parseJsonConfigText(readFileSync(path, 'utf8')), 'plugin')
      )
        return path;
    } catch {
      return path;
    }
  }
  if (existsOrSymlink(jsoncPath)) return jsoncPath;
  return jsonPath;
}

export function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
}

export function ensureTuiConfigDir(): void {
  const configDir = dirname(getTuiConfig());
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
}

export function ensureOpenCodeConfigDir(): void {
  const configDir = dirname(getConfigJson());
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
}
