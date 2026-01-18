import { websearch } from "./websearch";
import { context7 } from "./context7";
import { grep_app } from "./grep-app";
import type { McpConfig } from "./types";
import type { McpName } from "../config";

export type { RemoteMcpConfig, LocalMcpConfig, McpConfig } from "./types";

const allBuiltinMcps: Record<McpName, McpConfig> = {
  websearch,
  context7,
  grep_app,
};

/**
 * Creates MCP configurations, excluding disabled ones
 */
export function createBuiltinMcps(
  disabledMcps: readonly string[] = []
): Record<string, McpConfig> {
  return Object.fromEntries(
    Object.entries(allBuiltinMcps).filter(([name]) => !disabledMcps.includes(name))
  );
}
