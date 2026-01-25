import { AGENT_ALIASES } from './constants';
import type { AgentOverrideConfig, PluginConfig } from './schema';

/**
 * Get agent override config by name, supporting backward-compatible aliases.
 * Checks both the current name and any legacy alias names.
 *
 * @param config - The plugin configuration
 * @param name - The current agent name
 * @returns The agent-specific override configuration if found
 */
export function getAgentOverride(
  config: PluginConfig | undefined,
  name: string,
): AgentOverrideConfig | undefined {
  const overrides = config?.agents ?? {};
  return (
    overrides[name] ??
    overrides[
      Object.keys(AGENT_ALIASES).find((k) => AGENT_ALIASES[k] === name) ?? ''
    ]
  );
}
