import { CUSTOM_SKILLS } from './custom-skills';

/**
 * A skill that is managed externally (e.g. user-installed) and needs
 * permission grants but is NOT installed by this plugin's CLI.
 */
export interface PermissionOnlySkill {
  /** Skill name - must match the name OpenCode uses for permission checks */
  name: string;
  /** List of agents that should auto-allow this skill */
  allowedAgents: string[];
  /** Human-readable description (for documentation only) */
  description: string;
}

/**
 * Skills managed externally (not installed by this plugin's CLI).
 * Entries here only affect agent permission grants - nothing is installed.
 */
export const PERMISSION_ONLY_SKILLS: PermissionOnlySkill[] = [
  {
    name: 'requesting-code-review',
    allowedAgents: ['oracle'],
    description:
      'Code review template for reviewer subagents in multi-step workflows',
  },
];

/**
 * Names of the skills an agent is granted by default when no explicit
 * `skills` list is configured: bundled custom skills plus
 * externally-managed skills whose `allowedAgents` includes `'*'` or the
 * agent name. Order follows the registries: CUSTOM_SKILLS first, then
 * PERMISSION_ONLY_SKILLS.
 */
export function getDefaultGrantedSkillNames(agentName: string): string[] {
  const names: string[] = [];
  for (const skill of [...CUSTOM_SKILLS, ...PERMISSION_ONLY_SKILLS]) {
    if (
      skill.allowedAgents.includes('*') ||
      skill.allowedAgents.includes(agentName)
    ) {
      names.push(skill.name);
    }
  }
  return names;
}

/**
 * Get permission presets for a specific agent based on bundled skills.
 * @param agentName - The name of the agent
 * @param skillList - Optional explicit list of skills to allow (overrides defaults)
 * @returns Permission rules for the skill permission type
 */
export function getSkillPermissionsForAgent(
  agentName: string,
  skillList?: readonly string[],
  disabledSkillNames?: readonly string[],
): Record<string, 'allow' | 'ask' | 'deny'> {
  const disabledSkills = new Set(
    Array.isArray(disabledSkillNames) ? disabledSkillNames : [],
  );

  // Orchestrator gets all skills by default, others are restricted
  const permissions: Record<string, 'allow' | 'ask' | 'deny'> = {
    '*': agentName === 'orchestrator' ? 'allow' : 'deny',
  };

  // If the user provided an explicit skill list (even empty), honor it
  if (skillList) {
    permissions['*'] = 'deny';
    for (const name of skillList) {
      if (name === '*') {
        permissions['*'] = 'allow';
      } else if (name.startsWith('!')) {
        permissions[name.slice(1)] = 'deny';
      } else if (!disabledSkills.has(name)) {
        permissions[name] = 'allow';
      }
    }
    for (const name of disabledSkills) {
      permissions[name] = 'deny';
    }
    return permissions;
  }

  // Apply permissions for the skills the agent is granted by default
  // (bundled custom skills + externally-managed skills)
  for (const name of getDefaultGrantedSkillNames(agentName)) {
    if (!disabledSkills.has(name)) {
      permissions[name] = 'allow';
    }
  }

  for (const name of disabledSkills) {
    permissions[name] = 'deny';
  }

  return permissions;
}

/**
 * Fold per-agent skill directives into an effective skills list.
 *
 * 1. Without a base `skills` list the working base is the agent's default
 *    grants (orchestrator defaults to allow-all, so its working base is
 *    `['*']`), so `skills_add` alone keeps the defaults and appends, and
 *    `skills_remove` alone prunes from the defaults.
 * 2. The working base and `add` are concatenated, deduped (first
 *    occurrence wins), then removal entries are filtered out.
 * 3. Removals operate on final skill tokens, never expanding `'*'`: a
 *    plain name removes that name token, and a `'!name'` entry removes
 *    the exclusion token itself (lifting an existing exclusion). If the
 *    result contains `'*'`, a plain-name removal is granted implicitly by
 *    the wildcard, so it is made explicit by appending the existing
 *    `'!name'` exclusion token - unless that exclusion is already present.
 *
 * The returned token list is consumed by the existing skill permission
 * resolver (`getSkillPermissionsForAgent`), which continues to interpret
 * `'*'` and `'!name'` as before.
 *
 * Returns `undefined` when nothing is configured to resolve (no base, no
 * additions, no removals) so the agent keeps its default skill behavior.
 */
export function resolveEffectiveSkills(
  agentName: string,
  base: readonly string[] | undefined,
  add: readonly string[] | undefined,
  remove: readonly string[] | undefined,
): string[] | undefined {
  const addList = Array.isArray(add) ? add : [];
  const removeList = Array.isArray(remove) ? remove : [];
  if (base === undefined && addList.length === 0 && removeList.length === 0) {
    return undefined;
  }

  // Without a base list the working base is the agent's default grants
  // (orchestrator defaults to allow-all), so additions build on top of
  // what the agent already gets and removals prune from it.
  const workingBase =
    base ??
    (agentName === 'orchestrator'
      ? ['*']
      : getDefaultGrantedSkillNames(agentName));

  // Removals operate on final skill tokens: a plain name removes that
  // name, and a '!name' entry removes the exclusion token itself (lifting
  // an existing exclusion). The wildcard is never expanded here.
  const removeSet = new Set(removeList);
  let list = [...new Set([...workingBase, ...addList])];
  list = list.filter((skill) => !removeSet.has(skill));

  // A plain-name removal that the list grants implicitly via '*' must be
  // made explicit with the existing '!name' exclusion token, unless the
  // exclusion is already present.
  if (list.includes('*')) {
    for (const name of new Set(removeList)) {
      if (name.startsWith('!')) {
        continue;
      }
      const exclusion = `!${name}`;
      if (!list.includes(exclusion)) {
        list.push(exclusion);
      }
    }
  }

  return list;
}
