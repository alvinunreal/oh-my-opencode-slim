import { AGENT_ALIASES, ALL_AGENT_NAMES } from './constants';
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

/**
 * Get the names of custom agents defined in config.
 * Custom agents are entries in config.agents whose name is NOT
 * a built-in agent name and NOT a legacy alias.
 *
 * @param config - The plugin configuration
 * @returns Array of custom agent names (may be empty)
 */
export function getCustomAgentNames(
  config: PluginConfig | undefined,
): string[] {
  if (!config?.agents) return [];
  const builtIn = new Set<string>(ALL_AGENT_NAMES as readonly string[]);
  const aliases = new Set(Object.keys(AGENT_ALIASES));
  return Object.keys(config.agents).filter(
    (name) => !builtIn.has(name) && !aliases.has(name),
  );
}
