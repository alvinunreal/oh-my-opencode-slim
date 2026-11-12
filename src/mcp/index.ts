import type { McpName } from '../config';
import { context7 } from './context7';
import { gh_grep } from './grep-app';
import type { McpConfig } from './types';

export type { McpConfig, RemoteMcpConfig } from './types';

const allBuiltinMcps: Record<McpName, McpConfig> = {
  context7,
  gh_grep,
};

/**
 * Creates MCP configurations, excluding disabled ones.
 */
export function createBuiltinMcps(
  disabledMcps: readonly string[] = [],
): Record<string, McpConfig> {
  // Never trust the declared type of user-config-derived values at
  // runtime; fall back to "nothing disabled" instead of throwing.
  const safeDisabledMcps = Array.isArray(disabledMcps) ? disabledMcps : [];
  return Object.fromEntries(
    Object.entries(allBuiltinMcps).filter(
      ([name]) => !safeDisabledMcps.includes(name),
    ),
  );
}

/**
 * Returns the built-in MCP names that the user has already defined in
 * their own config. A user-defined entry owns its key: the plugin must
 * never inject a built-in over it (issue #1290).
 */
export function getOverriddenBuiltinMcpKeys(
  builtin: Record<string, unknown>,
  user: Record<string, unknown>,
): string[] {
  return Object.keys(builtin).filter((name) => Object.hasOwn(user, name));
}
