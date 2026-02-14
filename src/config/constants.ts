// Agent names
export const AGENT_ALIASES: Record<string, string> = {
  explore: 'explorer',
  'frontend-ui-ux-engineer': 'designer',
};

export const SUBAGENT_NAMES = [
  'explorer',
  'librarian',
  'oracle',
  'designer',
  'fixer',
  'long-fixer',
  'quick-fixer',
] as const;

export const ORCHESTRATOR_NAME = 'orchestrator' as const;

export const ALL_AGENT_NAMES = [ORCHESTRATOR_NAME, ...SUBAGENT_NAMES] as const;

// Agent name types
export type AgentName = (typeof ALL_AGENT_NAMES)[number];
export type SubagentName = (typeof SUBAGENT_NAMES)[number];

// Granular fixer names (long-fixer and quick-fixer)
export const GRANULAR_FIXER_NAMES = ['long-fixer', 'quick-fixer'] as const;

/**
 * Check if an agent name is a granular fixer (long-fixer or quick-fixer).
 */
export function isGranularFixer(name: string): boolean {
  return (GRANULAR_FIXER_NAMES as readonly string[]).includes(name);
}

/**
 * Get the list of active subagent names based on configuration.
 * Filters out granular fixers when the experimental flag is disabled.
 */
export function getActiveSubagentNames(config?: {
  experimental?: { granularFixers?: boolean };
}): SubagentName[] {
  const granularFixersEnabled = config?.experimental?.granularFixers ?? false;
  return SUBAGENT_NAMES.filter(
    (name) => !isGranularFixer(name) || granularFixersEnabled,
  );
}

// Subagent delegation rules: which agents can spawn which subagents
// orchestrator: can spawn all subagents (full delegation)
// fixer: can spawn explorer (for research during implementation)
// designer: can spawn explorer (for research during design)
// explorer/librarian/oracle: cannot spawn any subagents (leaf nodes)
// Unknown agent types not listed here default to explorer-only access
export const SUBAGENT_DELEGATION_RULES: Record<AgentName, readonly string[]> = {
  orchestrator: SUBAGENT_NAMES,
  fixer: ['explorer'],
  'long-fixer': ['explorer'],
  'quick-fixer': ['explorer'],
  designer: ['explorer'],
  explorer: [],
  librarian: [],
  oracle: [],
};

// Default models for each agent
export const DEFAULT_MODELS: Record<AgentName, string> = {
  orchestrator: 'kimi-for-coding/k2p5',
  oracle: 'openai/gpt-5.2-codex',
  librarian: 'openai/gpt-5.1-codex-mini',
  explorer: 'openai/gpt-5.1-codex-mini',
  designer: 'kimi-for-coding/k2p5',
  fixer: 'openai/gpt-5.1-codex-mini',
  'long-fixer': 'openai/gpt-5.1-codex-mini',
  'quick-fixer': 'openai/gpt-5-nano',
};

// Polling configuration
export const POLL_INTERVAL_MS = 500;
export const POLL_INTERVAL_SLOW_MS = 1000;
export const POLL_INTERVAL_BACKGROUND_MS = 2000;

// Timeouts
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
export const MAX_POLL_TIME_MS = 5 * 60 * 1000; // 5 minutes
export const FALLBACK_FAILOVER_TIMEOUT_MS = 15_000;

// Polling stability
export const STABLE_POLLS_THRESHOLD = 3;
