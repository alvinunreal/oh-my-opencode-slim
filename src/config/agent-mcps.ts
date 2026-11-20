import type { AgentName } from './constants';
import { matchesListFilter, splitListFilter } from './list-filter';
import type { RuntimeConfig } from './runtime';
import type { AgentOverrideConfig } from './schema';
import { lookupWithAliases } from './utils';

/** Default MCPs per agent - "*" means all MCPs, "!item" excludes specific MCPs */

export const DEFAULT_AGENT_MCPS: Record<AgentName, string[]> = {
  orchestrator: ['*', '!context7'],
  designer: [],
  oracle: [],
  explorer: ['context7', 'gh_grep'],
  fixer: [],
  observer: [],
  council: [],
  councillor: [],
};

/**
 * Parse a list with wildcard and exclusion syntax against the available names.
 * The wildcard/exclusion decision lives in `matchesListFilter`, shared with the
 * multiplexer pane filter; the result keeps the source order (the allow list's
 * order, or the available set's order when `"*"` is present).
 */
export function parseList(
  items: readonly string[],
  allAvailable: readonly string[],
): string[] {
  if (!items || items.length === 0) {
    return [];
  }

  const filter = splitListFilter(items);
  const { allow } = filter;
  if (allow.includes('*')) {
    return allAvailable.filter((item) => matchesListFilter(item, filter));
  }
  return allow.filter(
    (item) => allAvailable.includes(item) && matchesListFilter(item, filter),
  );
}

/**
 * Get the MCP list for an agent (from config or defaults).
 * Reads the merged (preset-aware) plugin-layer agents via RuntimeConfig.
 * A caller that already derived the merged record for this pass may pass it
 * as `derivedAgents` to avoid re-deriving per agent.
 */
export function getAgentMcpList(
  agentName: string,
  runtime: RuntimeConfig,
  derivedAgents?: Record<string, AgentOverrideConfig>,
): string[] {
  const agents = derivedAgents ?? runtime.agents();
  const agentConfig = lookupWithAliases(agents, agentName);
  if (agentConfig?.mcps !== undefined) {
    return agentConfig.mcps;
  }

  if (agentName.startsWith('councillor-')) {
    return agents.councillor?.mcps ?? DEFAULT_AGENT_MCPS.councillor;
  }

  const defaultMcps = DEFAULT_AGENT_MCPS[agentName as AgentName];
  return defaultMcps ?? [];
}
