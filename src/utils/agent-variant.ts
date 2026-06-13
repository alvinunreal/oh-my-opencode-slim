import {
  ALL_AGENT_NAMES,
  getAgentOverride,
  getCustomAgentNames,
  type PluginConfig,
} from '../config';

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

function getRuntimeAgentNames(config?: PluginConfig): string[] {
  const unique = new Set<string>([
    ...ALL_AGENT_NAMES,
    ...getCustomAgentNames(config),
  ]);
  return [...unique];
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

  for (const internalName of getRuntimeAgentNames(config)) {
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

export type DisplayNameMentionRewriter = (text: string) => string;

export function createDisplayNameMentionRewriter(
  config: PluginConfig | undefined,
): DisplayNameMentionRewriter {
  const replacements: Array<{ regex: RegExp; internalName: string }> = [];

  for (const internalName of getRuntimeAgentNames(config)) {
    const displayName = getAgentOverride(config, internalName)?.displayName;
    if (!displayName) {
      continue;
    }

    const normalizedDisplayName = normalizeAgentName(displayName);
    if (!normalizedDisplayName || normalizedDisplayName === internalName) {
      continue;
    }

    replacements.push({
      regex: new RegExp(
        `(^|[^\\w.])@${escapeRegExp(normalizedDisplayName)}\\b`,
        'g',
      ),
      internalName,
    });
  }

  if (replacements.length === 0) {
    return (text) => text;
  }

  return (text) => {
    if (!text.includes('@')) {
      return text;
    }

    let rewritten = text;
    for (const replacement of replacements) {
      rewritten = rewritten.replace(
        replacement.regex,
        `$1@${replacement.internalName}`,
      );
    }

    return rewritten;
  };
}
