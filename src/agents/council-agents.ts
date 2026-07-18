import type { PluginConfig } from '../config';
import { createCouncillorAgent } from './councillor';
import type { AgentDefinition } from './orchestrator';

const COUNCILLOR_AGENT_PREFIX = 'councillor-';

/**
 * Build dynamic councillor agents from council config presets.
 * Each councillor gets its own agent (name + model) so the orchestrator
 * can task() them with native panes at depth 1 using per-councillor models.
 * Agent names are prefixed with `councillor-` because raw councillor names
 * (e.g. "alpha") can collide with OpenCode-reserved agent type names.
 */
export function buildCouncillorAgents(
  config: PluginConfig | undefined,
  disabled: Set<string>,
): AgentDefinition[] {
  const council = config?.council;
  if (!council) return [];

  const presetName = council.default_preset ?? 'default';
  const preset = council.presets[presetName];
  if (!preset) return [];

  const agents: AgentDefinition[] = [];
  for (const [name, cfg] of Object.entries(preset)) {
    if (name === 'master') continue;

    const agentName = `${COUNCILLOR_AGENT_PREFIX}${name}`;
    if (disabled.has(agentName)) continue;
    const base = createCouncillorAgent(
      cfg.model,
      undefined,
      cfg.prompt,
      cfg.variant,
    );

    // If a fallback chain is configured, attach _modelArray for runtime
    // resolution and clear the primary model so the single-model field
    // doesn't override the chain (mirrors orchestrator.ts pattern).
    if (cfg.models.length > 1) {
      base._modelArray = cfg.models;
      base.config.model = undefined;
    }

    agents.push({ ...base, name: agentName });
  }

  return agents;
}

/**
 * Return the user-facing councillor seat name for a prefixed agent name.
 * Inverse of the prefix applied in `buildCouncillorAgents`.
 */
export function getCouncillorSeatName(agentName: string): string {
  return agentName.startsWith(COUNCILLOR_AGENT_PREFIX)
    ? agentName.slice(COUNCILLOR_AGENT_PREFIX.length)
    : agentName;
}
