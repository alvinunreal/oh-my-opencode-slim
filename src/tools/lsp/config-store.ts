// LSP Config Store - Holds OpenCode's lsp config for runtime access
// This allows the config hook to set the lsp config once,
// and the LSP tools to read it at execution time.

/**
 * User-provided LSP server config (from opencode.json lsp section).
 * Fields are optional because user config may not include all properties.
 */
export interface UserLspConfig {
  id: string;
  command?: string[];
  extensions?: string[];
  disabled?: boolean;
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
}

/**
 * Module-level store for OpenCode's lsp configuration.
 * Set during plugin initialization via the config hook.
 */
const userConfig = new Map<string, UserLspConfig>();

/**
 * Set the user's lsp config from opencode.json.
 * Called during plugin initialization.
 */
export function setUserLspConfig(
  config: Record<string, unknown> | undefined,
): void {
  userConfig.clear();
  if (config) {
    for (const [id, server] of Object.entries(config)) {
      if (server && typeof server === 'object') {
        const s = server as Record<string, unknown>;
        userConfig.set(id, {
          id,
          command: s.command as string[] | undefined,
          extensions: s.extensions as string[] | undefined,
          disabled: s.disabled as boolean | undefined,
          env: s.env as Record<string, string> | undefined,
          initialization: s.initialization as
            | Record<string, unknown>
            | undefined,
        });
      }
    }
  }
}

/**
 * Get the user's lsp config for a specific server ID.
 */
export function getUserLspConfig(serverId: string): UserLspConfig | undefined {
  return userConfig.get(serverId);
}

/**
 * Get all user-configured lsp servers.
 */
export function getAllUserLspConfigs(): Map<string, UserLspConfig> {
  return new Map(userConfig);
}

/**
 * Check if user has configured any lsp servers.
 */
export function hasUserLspConfig(): boolean {
  return userConfig.size > 0;
}
