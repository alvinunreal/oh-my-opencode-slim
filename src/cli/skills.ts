import { AGENT_ALIASES } from '../config/constants';
import { CUSTOM_SKILLS } from './custom-skills';

/**
 * Names of the skills an agent is granted by default when no explicit
 * `skills` list is configured: bundled skills whose `allowedAgents`
 * includes `'*'` or the canonical agent name, in CUSTOM_SKILLS order.
 * Skills the plugin does not bundle get no named default grant, since
 * nothing guarantees they are installed.
 */
export function getDefaultGrantedSkillNames(agentName: string): string[] {
  const canonicalAgentName = AGENT_ALIASES[agentName] ?? agentName;
  const names: string[] = [];
  for (const skill of CUSTOM_SKILLS) {
    if (
      skill.allowedAgents.includes('*') ||
      skill.allowedAgents.includes(canonicalAgentName)
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

  // Apply permissions for the bundled skills the agent is granted by default
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
 * Short, model-facing summary of an agent's final skill rules (the record
 * the host enforces): `''` (none), `'all'`, `'all except a, b'`, or
 * `'a, b'`. The host applies the last matching rule in key order, so a
 * named rule placed before `'*'` is shadowed and not listed.
 */
export function summarizeSkillGrants(
  rules: Readonly<Record<string, 'allow' | 'ask' | 'deny'>>,
): string {
  const entries = Object.entries(rules);
  const named = entries.slice(entries.findIndex(([name]) => name === '*') + 1);
  if (rules['*'] === 'allow') {
    const denied = named
      .filter(([, rule]) => rule !== 'allow')
      .map(([name]) => name);
    return denied.length > 0 ? `all except ${denied.join(', ')}` : 'all';
  }
  return named
    .filter(([, rule]) => rule === 'allow')
    .map(([name]) => name)
    .join(', ');
}

/**
 * Fold per-agent skill directives into an effective skills list.
 *
 * 1. Without a base `skills` list the working base is the agent's default
 *    grants (orchestrator defaults to allow-all, so its working base is
 *    `['*']`), so `skills_add` alone keeps the defaults and appends, and
 *    `skills_remove` alone prunes from the defaults.
 * 2. Explicit token removals are applied to the working base first. This
 *    lets `skills_remove: ['!name']` lift an inherited exclusion before
 *    additions are evaluated.
 * 3. Remaining exclusion (`'!name'`) tokens prevent `skills_add` from
 *    re-granting the excluded skill. Plain-name removals also suppress an
 *    addition of the same name, so removal wins over addition.
 * 4. If the result contains `'*'`, a plain-name removal is granted
 *    implicitly by the wildcard, so it is made explicit by appending the
 *    existing `'!name'` exclusion token - unless already present.
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
  defaultSkills?: readonly string[],
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
    defaultSkills ??
    (agentName === 'orchestrator'
      ? ['*']
      : getDefaultGrantedSkillNames(agentName));

  // Apply explicit token removals before deriving active exclusions. This
  // is what makes removing '!foo' genuinely lift that inherited exclusion.
  const removeSet = new Set(removeList);
  const baseAfterRemoval = workingBase.filter((token) => !removeSet.has(token));

  // Additions must not override exclusions that remain after removals.
  const excluded = new Set(
    baseAfterRemoval
      .filter((token) => token.startsWith('!'))
      .map((token) => token.slice(1)),
  );

  const list = [
    ...new Set([
      ...baseAfterRemoval,
      ...addList.filter((name) => !excluded.has(name) && !removeSet.has(name)),
    ]),
  ];

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
