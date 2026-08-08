import { AGENT_ALIASES, type AgentName } from './constants';
import type { RuntimeConfig } from './runtime';

/** Default MCPs per agent - "*" means all MCPs, "!item" excludes specific MCPs */

export const DEFAULT_AGENT_MCPS: Record<AgentName, string[]> = {
  orchestrator: ['*', '!context7'],
  designer: [],
  oracle: [],
  librarian: ['context7', 'gh_grep'],
  explorer: [],
  fixer: [],
  observer: [],
  council: [],
  councillor: [],
};

/**
 * Parse a list with wildcard and exclusion syntax.
 */
export function parseList(items: string[], allAvailable: string[]): string[] {
  if (!items || items.length === 0) {
    return [];
  }

  const allow = items.filter((i) => !i.startsWith('!'));
  const deny = items.filter((i) => i.startsWith('!')).map((i) => i.slice(1));

  if (deny.includes('*')) {
    return [];
  }

  if (allow.includes('*')) {
    return allAvailable.filter((item) => !deny.includes(item));
  }

  return allow.filter(
    (item) => !deny.includes(item) && allAvailable.includes(item),
  );
}

/**
 * Get the MCP list for an agent (from config or defaults).
 * Reads the merged (preset-aware) plugin-layer agents via RuntimeConfig.
 */
export function getAgentMcpList(
  agentName: string,
  runtime: RuntimeConfig,
): string[] {
  const agents = runtime.agents();
  const agentConfig =
    agents[agentName] ??
    agents[
      Object.keys(AGENT_ALIASES).find(
        (key) => AGENT_ALIASES[key] === agentName,
      ) ?? ''
    ];
  if (agentConfig?.mcps !== undefined) {
    return agentConfig.mcps;
  }

  const defaultMcps = DEFAULT_AGENT_MCPS[agentName as AgentName];
  return defaultMcps ?? [];
}
