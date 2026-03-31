import type { McpName, WebsearchConfig } from '../config';
import { context7 } from './context7';
import { grep_app } from './grep-app';
import type { McpConfig } from './types';
import { createWebsearchConfig, websearch } from './websearch';

export type { LocalMcpConfig, McpConfig, RemoteMcpConfig } from './types';

const allBuiltinMcps: Record<McpName, McpConfig> = {
  websearch,
  context7,
  grep_app,
};

/**
 * Creates MCP configurations, excluding disabled ones.
 * Accepts an optional websearchConfig to override the default Exa provider.
 */
export function createBuiltinMcps(
  disabledMcps: readonly string[] = [],
  websearchConfig?: WebsearchConfig,
): Record<string, McpConfig> {
  const mcps = Object.fromEntries(
    Object.entries(allBuiltinMcps).filter(
      ([name]) => !disabledMcps.includes(name),
    ),
  );

  // Override websearch with user-configured provider (default: Exa)
  if (!disabledMcps.includes('websearch')) {
    mcps.websearch = createWebsearchConfig(websearchConfig);
  }

  return mcps;
}
