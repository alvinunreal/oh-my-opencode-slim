import type { CouncilConfig } from '../config/council-schema';
import type { RuntimeConfig } from '../config/runtime';
import { createCouncillorAgent } from './councillor';
import type { AgentDefinition } from './orchestrator';

const COUNCILLOR_AGENT_PREFIX = 'councillor-';

type CouncillorSeat = [string, CouncilConfig['presets'][string][string]];

function activeSeats(
  runtime: RuntimeConfig,
  disabled: ReadonlySet<string>,
): CouncillorSeat[] {
  const council = runtime.council;
  if (!council) return [];
  // Explicitly disabling the council agent disables the whole chain: the
  // injected procedure dispatches seats and then delegates synthesis to
  // the council agent, so seats without it would dangle.
  if (disabled.has('council')) return [];
  const presetName = council.default_preset ?? 'default';
  const preset = council.presets[presetName];
  return preset ? Object.entries(preset) : [];
}

/** Dispatchable seat agent names for the active council preset; the same
 * derivation `buildCouncillorAgents` uses, for scope validation. */
export function councillorSeatNames(
  runtime: RuntimeConfig,
  disabled: ReadonlySet<string>,
): string[] {
  return activeSeats(runtime, disabled).map(
    ([seat]) => `${COUNCILLOR_AGENT_PREFIX}${seat}`,
  );
}

/**
 * Build dynamic councillor agents from council config presets.
 * Each councillor gets its own agent (name + model) so the orchestrator
 * can dispatch them with native panes (via `task()` on v1, `subagent()` on v2)
 * at depth 1 using per-councillor models.
 * Agent names are prefixed with `councillor-` because raw councillor names
 * (e.g. "alpha") can collide with OpenCode-reserved agent type names.
 */
export function buildCouncillorAgents(
  runtime: RuntimeConfig,
  disabled: Set<string>,
  observerDispatchEnabled = false,
): AgentDefinition[] {
  const agents: AgentDefinition[] = [];
  for (const [name, cfg] of activeSeats(runtime, disabled)) {
    const agentName = `${COUNCILLOR_AGENT_PREFIX}${name}`;
    if (disabled.has(agentName)) continue;
    const base = createCouncillorAgent(
      cfg.model,
      undefined,
      cfg.prompt,
      cfg.variant,
      observerDispatchEnabled,
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
