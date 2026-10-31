import { resolveEffectiveSkills } from '../cli/skills';
import { AGENT_ALIASES, ALL_AGENT_NAMES } from './constants';
import { mergeAgentOverrides } from './presets';
import type { AgentOverrideConfig, PluginConfig } from './schema';

/**
 * All legacy alias keys that map onto `name` (rename continuity), in table
 * order. Empty for names that were never renamed.
 */
export function legacyAliasesFor(name: string): string[] {
  const legacyNames: string[] = [];
  for (const [legacy, canonical] of Object.entries(AGENT_ALIASES)) {
    if (canonical === name) {
      legacyNames.push(legacy);
    }
  }
  return legacyNames;
}

/**
 * Record lookup with rename continuity: the canonical entry first, then the
 * first legacy alias entry that has a value (AGENT_ALIASES order). Field-level
 * merging lives in `mergeWithAliases`; this is a plain fallback read.
 */
export function lookupWithAliases<T>(
  record: Record<string, T>,
  name: string,
): T | undefined {
  const value = record[name];
  if (value !== undefined) return value;
  for (const legacyName of legacyAliasesFor(name)) {
    const legacy = record[legacyName];
    if (legacy !== undefined) return legacy;
  }
  return undefined;
}

/**
 * Field-level merge of every legacy alias record into the canonical one.
 * The canonical record wins field-by-field; legacy-only fields survive
 * (rename continuity, e.g. `agents.librarian` → `explorer`).
 */
export function mergeWithAliases(
  record: Record<string, AgentOverrideConfig>,
  name: string,
): AgentOverrideConfig | undefined {
  const canonical = record[name];
  let merged = canonical;
  for (const legacyName of legacyAliasesFor(name)) {
    const legacy = record[legacyName];
    if (!legacy) continue;
    merged = merged
      ? mergeAgentOverrides({ [name]: legacy }, { [name]: merged })[name]
      : legacy;
  }
  return merged;
}

/**
 * Get agent override config by name, supporting backward-compatible aliases.
 *
 * @param config - The plugin configuration
 * @param name - The current agent name
 * @returns The agent-specific override configuration if found
 */
export function getAgentOverride(
  config: PluginConfig | undefined,
  name: string,
): AgentOverrideConfig | undefined {
  return mergeWithAliases(config?.agents ?? {}, name);
}

/**
 * Get custom agent names declared in config.agents.
 *
 * Custom agents are unknown keys that are neither built-in agent names nor
 * legacy aliases.
 */
export function getCustomAgentNames(
  config: PluginConfig | undefined,
): string[] {
  const overrides = config?.agents ?? {};
  return Object.keys(overrides).filter((name) => {
    if (AGENT_ALIASES[name] !== undefined) {
      return false;
    }

    return !(ALL_AGENT_NAMES as readonly string[]).includes(name);
  });
}

function getAcpAgentNames(config: PluginConfig | undefined): string[] {
  return Object.keys(config?.acpAgents ?? {});
}

const SKILL_DIRECTIVE_KEYS = [
  'skills',
  'skills_add',
  'skills_remove',
  'skills_include_local',
] as const satisfies readonly (keyof AgentOverrideConfig)[];

/**
 * Preserve skill directives carried by a legacy alias when a merged config
 * also contains the canonical agent key. Canonical values remain
 * authoritative when both records explicitly provide the same field.
 *
 * Layered runtime config can legitimately produce both records (for example,
 * a preset using `explore` over root config using `explorer`). Downstream
 * lookup is canonical-first, so without this reconciliation the alias's skill
 * directives would otherwise be silently dropped.
 */
function reconcileAliasSkillDirectives(
  agents: Record<string, AgentOverrideConfig>,
): Record<string, AgentOverrideConfig> {
  let result = agents;

  for (const [alias, canonical] of Object.entries(AGENT_ALIASES)) {
    const aliasOverride = agents[alias];
    const canonicalOverride = result[canonical];
    if (!aliasOverride || !canonicalOverride) {
      continue;
    }

    let mergedCanonical = canonicalOverride;
    for (const key of SKILL_DIRECTIVE_KEYS) {
      if (
        mergedCanonical[key] === undefined &&
        aliasOverride[key] !== undefined
      ) {
        if (mergedCanonical === canonicalOverride) {
          mergedCanonical = { ...canonicalOverride };
        }
        Object.assign(mergedCanonical, { [key]: aliasOverride[key] });
      }
    }

    if (mergedCanonical !== canonicalOverride) {
      if (result === agents) {
        result = { ...agents };
      }
      result[canonical] = mergedCanonical;
    }
  }

  return result;
}

/**
 * Fold per-agent skill directives (`skills_add` / `skills_remove` /
 * `skills_include_local`) into the effective `skills` list so downstream
 * consumers (agent factories, hooks) only ever see a plain `skills` array.
 * Entries without directives keep their original reference; the input record
 * is returned unchanged when no entry needs folding.
 */
export function normalizeAgentSkillDirectives(
  agents: Record<string, AgentOverrideConfig>,
  localSkillNames: readonly string[] = [],
  defaultSkills: Readonly<Record<string, readonly string[]>> = {},
): Record<string, AgentOverrideConfig> {
  const reconciled = reconcileAliasSkillDirectives(agents);
  let changed = reconciled !== agents;
  const result: Record<string, AgentOverrideConfig> = {};
  for (const [name, override] of Object.entries(reconciled)) {
    if (
      override.skills_add === undefined &&
      override.skills_remove === undefined &&
      override.skills_include_local === undefined
    ) {
      result[name] = override;
      continue;
    }

    changed = true;
    const additions =
      override.skills_include_local === true
        ? [...(override.skills_add ?? []), ...localSkillNames]
        : override.skills_add;
    const effective = resolveEffectiveSkills(
      name,
      override.skills,
      additions,
      override.skills_remove,
      defaultSkills[name],
    );
    const {
      skills: _skills,
      skills_add: _skillsAdd,
      skills_remove: _skillsRemove,
      skills_include_local: _skillsIncludeLocal,
      ...rest
    } = override;
    const entry: AgentOverrideConfig = { ...rest };
    if (effective !== undefined) {
      entry.skills = effective;
    }
    result[name] = entry;
  }
  return changed ? result : agents;
}
