// Simplified LSP config - uses OpenCode's lsp config from opencode.json
// Falls back to BUILTIN_SERVERS if no user config exists

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import whichSync from 'which';
import { log } from '../../utils';
import { getAllUserLspConfigs, hasUserLspConfig } from './config-store';
import {
  BUILTIN_SERVERS,
  LANGUAGE_EXTENSIONS,
  LSP_INSTALL_HINTS,
} from './constants';
import type { ResolvedServer, ServerLookupResult } from './types';

/**
 * Merged server config that combines built-in and user config.
 */
interface MergedServerConfig {
  id: string;
  command: string[];
  extensions: string[];
  root?: (file: string) => string | undefined;
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
}

/**
 * Build the merged server list by combining built-in servers with user config.
 * This mirrors OpenCode core's pattern: start with built-in, then merge user config.
 */
function buildMergedServers(): Map<string, MergedServerConfig> {
  const servers = new Map<string, MergedServerConfig>();

  // Start with built-in servers
  for (const [id, config] of Object.entries(BUILTIN_SERVERS)) {
    servers.set(id, {
      id,
      command: config.command,
      extensions: config.extensions,
      root: config.root,
      env: config.env,
      initialization: config.initialization,
    });
  }

  // Apply user config (merge with existing or add new)
  if (hasUserLspConfig()) {
    for (const [id, userConfig] of getAllUserLspConfigs()) {
      // Handle disabled: remove built-in from consideration
      if (userConfig.disabled === true) {
        servers.delete(id);
        continue;
      }

      const existing = servers.get(id);

      if (existing) {
        // Merge user config with built-in, preserving root function from built-in
        servers.set(id, {
          ...existing,
          id,
          // User config overrides command if provided
          command: userConfig.command ?? existing.command,
          // User config overrides extensions if provided
          extensions: userConfig.extensions ?? existing.extensions,
          // Preserve root function from built-in (not overrideable)
          root: existing.root,
          // User config overrides env/initialization
          env: userConfig.env ?? existing.env,
          initialization: userConfig.initialization ?? existing.initialization,
        });
      } else {
        // New server defined by user config
        servers.set(id, {
          id,
          command: userConfig.command ?? [],
          extensions: userConfig.extensions ?? [],
          root: undefined,
          env: userConfig.env,
          initialization: userConfig.initialization,
        });
      }
    }
  }

  return servers;
}

function getServerWorkspace(
  config: MergedServerConfig,
  filePath?: string,
): string | undefined {
  if (!filePath) {
    return undefined;
  }

  if (!config.root) {
    return dirname(resolve(filePath));
  }

  return config.root(filePath);
}

function shouldSkipServer(
  config: MergedServerConfig,
  filePath?: string,
): boolean {
  if (!filePath) {
    return false;
  }

  return (
    config.id === 'deno' && getServerWorkspace(config, filePath) === undefined
  );
}

function toResolvedServer(
  config: MergedServerConfig,
  command?: string[],
): ResolvedServer {
  return {
    id: config.id,
    command: command ?? config.command,
    extensions: config.extensions,
    root: config.root,
    env: config.env,
    initialization: config.initialization,
  };
}

function findInstalledServer(
  configs: MergedServerConfig[],
  filePath?: string,
): ServerLookupResult | undefined {
  let firstNotInstalled: Extract<
    ServerLookupResult,
    { status: 'not_installed' }
  > | null = null;

  for (const config of configs) {
    const workspace = getServerWorkspace(config, filePath);
    const resolvedCommand = resolveServerCommand(
      config.command,
      workspace ?? (filePath ? dirname(resolve(filePath)) : undefined),
    );
    const server = toResolvedServer(config, resolvedCommand ?? undefined);

    log(
      `[LSP] Considering server for ${config.extensions.join(', ')}: ${config.id} with command ${config.command.join(' ')}`,
    );

    if (resolvedCommand) {
      return { status: 'found', server };
    }

    if (!firstNotInstalled) {
      log(`[LSP] Server ${config.id} not found in PATH or local node_modules`);
      firstNotInstalled = {
        status: 'not_installed',
        server,
        installHint:
          LSP_INSTALL_HINTS[config.id] ||
          `Install '${config.command[0]}' and add to PATH`,
      };
    }
  }

  return firstNotInstalled ?? undefined;
}

export function findServerForExtension(
  ext: string,
  filePath?: string,
): ServerLookupResult {
  const servers = [...buildMergedServers().values()].filter((config) =>
    config.extensions.includes(ext),
  );

  if (servers.length === 0) {
    log(`[LSP] No server config found for ${ext}`);
    return { status: 'not_configured', extension: ext };
  }

  const candidateServers = servers.filter(
    (config) => !shouldSkipServer(config, filePath),
  );

  if (candidateServers.length === 0) {
    log(`[LSP] No applicable server config found for ${ext} at ${filePath}`);
    return { status: 'not_configured', extension: ext };
  }

  const result = findInstalledServer(candidateServers, filePath);

  if (result) {
    return result;
  }

  log(`[LSP] No applicable server config found for ${ext}`);
  return { status: 'not_configured', extension: ext };
}

export function getLanguageId(ext: string): string {
  return LANGUAGE_EXTENSIONS[ext] || 'plaintext';
}

export function resolveServerCommand(
  command: string[],
  cwd?: string,
): string[] | null {
  if (command.length === 0) return null;

  const [cmd, ...args] = command;

  if (cmd.includes('/') || cmd.includes('\\')) {
    return existsSync(cmd) ? command : null;
  }

  const isWindows = process.platform === 'win32';
  const ext = isWindows ? '.exe' : '';

  const opencodeBin = join(homedir(), '.config', 'opencode', 'bin');
  const searchPath =
    (process.env.PATH ?? '') + (isWindows ? ';' : ':') + opencodeBin;

  const result = whichSync.sync(cmd, {
    path: searchPath,
    pathExt: isWindows ? process.env.PATHEXT : undefined,
    nothrow: true,
  });

  if (result !== null) {
    return [result, ...args];
  }

  const localBinRoot = cwd ?? process.cwd();
  const localBin = join(localBinRoot, 'node_modules', '.bin', cmd);
  if (existsSync(localBin)) {
    return [localBin, ...args];
  }
  if (existsSync(localBin + ext)) {
    return [localBin + ext, ...args];
  }

  return null;
}

export function isServerInstalled(command: string[]): boolean {
  return resolveServerCommand(command) !== null;
}
