import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function getConfigDir(): string {
  // If OPENCODE_CONFIG is set, it points to a custom config file
  // (e.g. /custom/path/opencode.json). The config directory is its parent.
  if (process.env.OPENCODE_CONFIG) {
    return dirname(process.env.OPENCODE_CONFIG);
  }

  // Otherwise, follow XDG Base Directory specification:
  // base dir is $XDG_CONFIG_HOME (if set) else ~/.config, and OpenCode config lives under /opencode.
  const userConfigDir = process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), '.config');

  return join(userConfigDir, 'opencode');
}

export function getOpenCodeConfigPaths(): string[] {
  const configDir = getConfigDir();
  return [join(configDir, 'opencode.json'), join(configDir, 'opencode.jsonc')];
}

export function getConfigJson(): string {
  return join(getConfigDir(), 'opencode.json');
}

export function getConfigJsonc(): string {
  return join(getConfigDir(), 'opencode.jsonc');
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
