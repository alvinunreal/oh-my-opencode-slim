import {
  ALL_AGENT_NAMES,
  getAgentOverride,
  type PluginConfig,
} from '../config';
import { log } from './logger';

/**
 * Normalizes an agent name by trimming whitespace and removing the optional @ prefix.
 *
 * @param agentName - The agent name to normalize (e.g., "@oracle" or "oracle")
 * @returns The normalized agent name without @ prefix and trimmed of whitespace
 *
 * @example
 * normalizeAgentName("@oracle") // returns "oracle"
 * normalizeAgentName("  explore  ") // returns "explore"
 */
export function normalizeAgentName(agentName: string): string {
  const trimmed = agentName.trim();
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
}

/**
 * Resolves the variant configuration for a specific agent.
 *
 * Looks up the agent's variant in the plugin configuration. Returns undefined if:
 * - No config is provided
 * - The agent has no variant configured
 * - The variant is not a string
 * - The variant is empty or whitespace-only
 *
 * @param config - The plugin configuration object
 * @param agentName - The name of the agent (with or without @ prefix)
 * @returns The trimmed variant string, or undefined if no valid variant is found
 *
 * @example
 * resolveAgentVariant(config, "@oracle") // returns "high" if configured
 */
export function resolveAgentVariant(
  config: PluginConfig | undefined,
  agentName: string,
): string | undefined {
  const normalized = resolveRuntimeAgentName(config, agentName);
  const rawVariant = getAgentOverride(config, normalized)?.variant;

  if (typeof rawVariant !== 'string') {
    return undefined;
  }

  const trimmed = rawVariant.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  log(`[variant] resolved variant="${trimmed}" for agent "${normalized}"`);
  return trimmed;
}

/**
 * Resolve a runtime-provided agent name to an internal agent name.
 *
 * Supports:
 * - internal names (e.g. "oracle")
 * - @-prefixed names (e.g. "@oracle")
 * - displayName aliases (e.g. "advisor" -> "oracle")
 */
export function resolveRuntimeAgentName(
  config: PluginConfig | undefined,
  agentName: string,
): string {
  const normalized = normalizeAgentName(agentName);
  if (!normalized) {
    return normalized;
  }

  if ((ALL_AGENT_NAMES as readonly string[]).includes(normalized)) {
    return normalized;
  }

  for (const internalName of ALL_AGENT_NAMES) {
    const displayName = getAgentOverride(config, internalName)?.displayName;
    if (!displayName) {
      continue;
    }

    if (normalizeAgentName(displayName) === normalized) {
      return internalName;
    }
  }

  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrites user-facing display-name mentions (e.g. @advisor) into internal
 * agent mentions (e.g. @oracle) for runtime routing.
 */
export function rewriteDisplayNameMentions(
  config: PluginConfig | undefined,
  text: string,
): string {
  if (!text.includes('@')) {
    return text;
  }

  let rewritten = text;

  for (const internalName of ALL_AGENT_NAMES) {
    const displayName = getAgentOverride(config, internalName)?.displayName;
    if (!displayName) {
      continue;
    }

    const normalizedDisplayName = normalizeAgentName(displayName);
    if (!normalizedDisplayName || normalizedDisplayName === internalName) {
      continue;
    }

    rewritten = rewritten.replace(
      new RegExp(`(^|[^\\w.])@${escapeRegExp(normalizedDisplayName)}\\b`, 'g'),
      `$1@${internalName}`,
    );
  }

  return rewritten;
}

/**
 * Applies a variant to a request body if the body doesn't already have one.
 *
 * This function will NOT override an existing variant in the body. If no variant
 * is provided or the body already has a variant, the original body is returned.
 *
 * @template T - The type of the body object, must have an optional variant property
 * @param variant - The variant string to apply (or undefined)
 * @param body - The request body object
 * @returns The body with the variant applied (new object) or the original body unchanged
 *
 * @example
 * applyAgentVariant("high", { agent: "oracle" }) // returns { agent: "oracle", variant: "high" }
 * applyAgentVariant("high", { agent: "oracle", variant: "low" }) // returns original body with variant: "low"
 */
export function applyAgentVariant<T extends { variant?: string }>(
  variant: string | undefined,
  body: T,
): T {
  if (!variant) {
    return body;
  }
  if (body.variant) {
    return body;
  }
  return { ...body, variant };
}
