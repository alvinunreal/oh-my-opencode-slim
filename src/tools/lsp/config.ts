// Simplified LSP config - uses OpenCode's lsp config from opencode.json
// Falls back to BUILTIN_SERVERS if no user config exists

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAllUserLspConfigs, hasUserLspConfig } from './config-store';
import { BUILTIN_SERVERS, EXT_TO_LANG, LSP_INSTALL_HINTS } from './constants';
import type { ResolvedServer, ServerLookupResult } from './types';

export function findServerForExtension(ext: string): ServerLookupResult {
  // First, try user config from opencode.json
  if (hasUserLspConfig()) {
    for (const [, config] of getAllUserLspConfigs()) {
      // Skip disabled servers
      if (config.disabled === true) {
        continue;
      }
      if (config.extensions?.includes(ext)) {
        const server: ResolvedServer = {
          id: config.id,
          command: config.command ?? [],
          extensions: config.extensions ?? [],
          env: config.env,
          initialization: config.initialization,
        };

        if (config.command && isServerInstalled(config.command)) {
          return { status: 'found', server };
        }

        return {
          status: 'not_installed',
          server,
          installHint: config.command
            ? `Install '${config.command[0]}' and add to PATH`
            : 'No command configured for this LSP server',
        };
      }
    }
  }

  // Fall back to built-in servers
  for (const [id, config] of Object.entries(BUILTIN_SERVERS)) {
    if (config.extensions.includes(ext)) {
      const server: ResolvedServer = {
        id,
        command: config.command,
        extensions: config.extensions,
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
          LSP_INSTALL_HINTS[id] ||
          `Install '${config.command[0]}' and add to PATH`,
      };
    }
  }

  return { status: 'not_configured', extension: ext };
}

export function getLanguageId(ext: string): string {
  return EXT_TO_LANG[ext] || 'plaintext';
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

  // Check PATH
  const pathEnv = process.env.PATH || '';
  const pathSeparator = isWindows ? ';' : ':';
  const paths = pathEnv.split(pathSeparator);

  for (const p of paths) {
    if (existsSync(join(p, cmd)) || existsSync(join(p, cmd + ext))) {
      return true;
    }
  }

  // Check local node_modules
  const cwd = process.cwd();
  const localBin = join(cwd, 'node_modules', '.bin', cmd);
  if (existsSync(localBin) || existsSync(localBin + ext)) {
    return true;
  }

  // Check global opencode bin
  const globalBin = join(homedir(), '.config', 'opencode', 'bin', cmd);
  if (existsSync(globalBin) || existsSync(globalBin + ext)) {
    return true;
  }

  return false;
}
