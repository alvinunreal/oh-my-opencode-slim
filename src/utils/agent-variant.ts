import {
  AGENT_ALIASES,
  type AgentOverrideConfig,
  ALL_AGENT_NAMES,
} from '../config';
import type { RuntimeConfig } from '../config/runtime';

export const SAFE_AGENT_ALIAS_RE = /^[a-z][a-z0-9_-]*$/i;

export function isSafeAgentAlias(name: string): boolean {
  return SAFE_AGENT_ALIAS_RE.test(name);
}

export interface AgentAliasRegistry {
  readonly canonicalIdByRuntimeName: Readonly<Record<string, string>>;
  readonly runtimeNameByCanonicalId: Readonly<Record<string, string>>;
}

function isAliasRegistry(
  source: RuntimeConfig | AgentAliasRegistry,
): source is AgentAliasRegistry {
  return 'canonicalIdByRuntimeName' in source;
}

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

function getRuntimeAgentNames(runtime: RuntimeConfig): string[] {
  const unique = new Set<string>([
    ...ALL_AGENT_NAMES,
    ...runtime.customAgentNames,
  ]);
  return [...unique];
}

/** Plugin-layer override for a name, alias-aware (no host merge). */
function getPluginOverride(
  runtime: RuntimeConfig,
  name: string,
): AgentOverrideConfig | undefined {
  const agents = runtime.agents();
  return (
    agents[name] ??
    agents[
      Object.keys(AGENT_ALIASES).find((key) => AGENT_ALIASES[key] === name) ??
        ''
    ]
  );
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
  source: RuntimeConfig | AgentAliasRegistry,
  agentName: string,
): string {
  const normalized = normalizeAgentName(agentName);
  if (!normalized) {
    return normalized;
  }

  if (isAliasRegistry(source)) {
    return source.canonicalIdByRuntimeName[normalized] ?? normalized;
  }

  if ((ALL_AGENT_NAMES as readonly string[]).includes(normalized)) {
    return normalized;
  }

  for (const internalName of getRuntimeAgentNames(source)) {
    const displayName = getPluginOverride(source, internalName)?.displayName;
    if (!displayName) {
      continue;
    }

    if (normalizeAgentName(displayName) === normalized) {
      return internalName;
    }
  }

  return AGENT_ALIASES[normalized] ?? normalized;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type DisplayNameMentionRewriter = (text: string) => string;

export function createDisplayNameMentionRewriter(
  source: RuntimeConfig | AgentAliasRegistry,
): DisplayNameMentionRewriter {
  const replacements: Array<{ regex: RegExp; internalName: string }> = [];

  if (isAliasRegistry(source)) {
    for (const [canonical, runtimeName] of Object.entries(
      source.runtimeNameByCanonicalId,
    )) {
      if (!runtimeName || runtimeName === canonical) continue;
      replacements.push({
        regex: new RegExp(`(^|[^\\w.])@${escapeRegExp(runtimeName)}\\b`, 'g'),
        internalName: canonical,
      });
    }
  } else {
    for (const internalName of getRuntimeAgentNames(source)) {
      const displayName = getPluginOverride(source, internalName)?.displayName;
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
