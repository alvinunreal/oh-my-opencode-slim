import type { PluginConfig } from "../config";
import { log } from "../shared/logger";

/**
 * Normalizes an agent name by trimming whitespace and removing leading '@'.
 * @param agentName - The agent name to normalize.
 * @returns The normalized agent name.
 */
export function normalizeAgentName(agentName: string): string {
  const trimmed = agentName.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

/**
 * Resolves the configured variant for a given agent.
 * @param config - The plugin configuration.
 * @param agentName - The name of the agent.
 * @returns The resolved variant name, or undefined if not found/invalid.
 */
export function resolveAgentVariant(
  config: PluginConfig | undefined,
  agentName: string
): string | undefined {
  const normalized = normalizeAgentName(agentName);
  const rawVariant = config?.agents?.[normalized]?.variant;

  if (typeof rawVariant !== "string") {
    log(`[variant] no variant configured for agent "${normalized}"`);
    return undefined;
  }

  const trimmed = rawVariant.trim();
  if (trimmed.length === 0) {
    log(`[variant] empty variant for agent "${normalized}" (ignored)`);
    return undefined;
  }

  log(`[variant] resolved variant="${trimmed}" for agent "${normalized}"`);
  return trimmed;
}

/**
 * Applies a variant to a prompt body if one is provided and not already present.
 * @param variant - The variant to apply.
 * @param body - The prompt body to modify.
 * @returns The updated prompt body with the variant applied.
 */
export function applyAgentVariant<T extends { variant?: string }>(
  variant: string | undefined,
  body: T
): T {
  if (!variant) {
    log("[variant] no variant to apply (skipped)");
    return body;
  }
  if (body.variant) {
    log(`[variant] body already has variant="${body.variant}" (not overriding)`);
    return body;
  }
  log(`[variant] applied variant="${variant}" to prompt body`);
  return { ...body, variant };
}
