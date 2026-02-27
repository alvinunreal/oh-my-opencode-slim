import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function getConfigDir(): string {
  // Keep this aligned with OpenCode itself and the plugin config loader:
  // base dir is $XDG_CONFIG_HOME (if set) else ~/.config, and OpenCode config lives under /opencode.
  const userConfigDir = process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), '.config');

  return join(userConfigDir, 'opencode');
}

export function getDataDir(): string {
  const userDataDir = process.env.XDG_DATA_HOME
    ? process.env.XDG_DATA_HOME
    : join(homedir(), '.local', 'share');

  return join(userDataDir, 'opencode');
}

export function getOpenCodeConfigPaths(): string[] {
  const configDir = getConfigDir();
  return [join(configDir, 'opencode.json'), join(configDir, 'opencode.jsonc')];
}

export function getOpenCodeAuthPaths(): string[] {
  const configDir = getConfigDir();
  const dataDir = getDataDir();

  return [
    join(dataDir, 'auth.json'),
    join(dataDir, 'auth.jsonc'),
    join(configDir, 'auth.json'),
    join(configDir, 'auth.jsonc'),
  ];
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
