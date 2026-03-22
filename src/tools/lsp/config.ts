// Simplified LSP config - uses OpenCode's lsp config from opencode.json
// Falls back to BUILTIN_SERVERS if no user config exists

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import whichSync from 'which';
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

export function findServerForExtension(ext: string): ServerLookupResult {
  const servers = buildMergedServers();

  for (const [, config] of servers) {
    if (config.extensions.includes(ext)) {
      const server: ResolvedServer = {
        id: config.id,
        command: config.command,
        extensions: config.extensions,
        root: config.root,
        env: config.env,
        initialization: config.initialization,
      };

      if (isServerInstalled(config.command)) {
        return { status: 'found', server };
      }

      return {
        status: 'not_installed',
        server,
        installHint:
          LSP_INSTALL_HINTS[config.id] ||
          `Install '${config.command[0]}' and add to PATH`,
      };
    }
  }

  return { status: 'not_configured', extension: ext };
}

export function getLanguageId(ext: string): string {
  return LANGUAGE_EXTENSIONS[ext] || 'plaintext';
}

export function isServerInstalled(command: string[]): boolean {
  if (command.length === 0) return false;

  const cmd = command[0];

  // Absolute paths
  if (cmd.includes('/') || cmd.includes('\\')) {
    return existsSync(cmd);
  }

  const isWindows = process.platform === 'win32';
  const ext = isWindows ? '.exe' : '';

  // Check PATH using which (mirrors core's approach)
  // Include ~/.config/opencode/bin in the search path
  const opencodeBin = join(homedir(), '.config', 'opencode', 'bin');
  const searchPath =
    (process.env.PATH ?? '') + (isWindows ? ';' : ':') + opencodeBin;

  const result = whichSync.sync(cmd, {
    path: searchPath,
    pathExt: isWindows ? process.env.PATHEXT : undefined,
    nothrow: true,
  });

  if (result !== null) {
    return true;
  }

  // Check local node_modules (where npm/yarn/pnpm install binaries)
  const cwd = process.cwd();
  const localBin = join(cwd, 'node_modules', '.bin', cmd);
  if (existsSync(localBin) || existsSync(localBin + ext)) {
    return true;
  }

  return false;
}
