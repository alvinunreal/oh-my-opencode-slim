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
 * Get custom agent names declared in config.agents.
 *
 * Custom agents are unknown keys that are neither built-in agent names nor
 * legacy aliases.
 */
export function getCustomAgentNames(
  config: Pick<PluginConfig, 'agents'> | undefined,
): string[] {
  const overrides = config?.agents ?? {};
  return Object.keys(overrides).filter((name) => {
    if (AGENT_ALIASES[name] !== undefined) {
      return false;
    }

    return !(ALL_AGENT_NAMES as readonly string[]).includes(name);
  });
}

export function getAcpAgentNames(config: PluginConfig | undefined): string[] {
  return Object.keys(config?.acpAgents ?? {});
}
