import { v1PermKeyToV2 } from './adapters';
import type { V2PermissionRule } from './types';

export type PermissionEffect = V2PermissionRule['effect'];

export interface MarketplacePermissionCeilings {
  /** Exact native v2 action names and their maximum admitted effect. */
  readonly actions: Readonly<Record<string, PermissionEffect>>;
  /** Exact skill names admitted to the package. */
  readonly skills: readonly string[];
  /** Owner-resolved ceiling for each admitted skill (absent means allow). */
  readonly skillEffects?: Readonly<Record<string, PermissionEffect>>;
  /** Native MCP action patterns (e.g. `context7_*`). */
  readonly mcpNamespaces: readonly string[];
  /** Owner-resolved ceiling for each admitted MCP namespace. */
  readonly mcpEffects?: Readonly<Record<string, PermissionEffect>>;
}

export interface PermissionPolicyInput {
  /** Explicit adapter baseline (including any intentional wildcard rules). */
  readonly baselineRules: readonly V2PermissionRule[];
  /** Native, ordered host rules; later matches take precedence. */
  readonly hostRules: readonly V2PermissionRule[];
  /** Present for marketplace agents; absent for ordinary plugin agents. */
  readonly marketplace?: MarketplacePermissionCeilings;
  /** Immutable plugin actions for ordinary subagents, applied after host rules. */
  readonly finalDenials?: readonly string[];
}

export interface PermissionPolicy {
  readonly rules: readonly V2PermissionRule[];
  decide(action: string, resource: string): PermissionEffect;
  decideSkill(skill: string): PermissionEffect;
}

const EFFECT_RANK: Record<PermissionEffect, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/** Compile ordered adapter + host rules with immutable marketplace gates. */
export function compilePermissionPolicy(
  input: PermissionPolicyInput,
): PermissionPolicy {
  const marketplace = input.marketplace
    ? Object.freeze({
        actions: Object.freeze({ ...input.marketplace.actions }),
        skills: Object.freeze([...input.marketplace.skills]),
        skillEffects: Object.freeze({ ...input.marketplace.skillEffects }),
        mcpNamespaces: Object.freeze([...input.marketplace.mcpNamespaces]),
        mcpEffects: Object.freeze({ ...input.marketplace.mcpEffects }),
      })
    : undefined;
  const rules = marketplace
    ? compileMarketplaceRules(input.baselineRules, input.hostRules, marketplace)
    : [
        ...input.baselineRules,
        ...input.hostRules,
        ...(input.finalDenials ?? []).map((action) => ({
          action,
          resource: '*',
          effect: 'deny' as const,
        })),
      ].map(cloneRule);
  const frozenRules = Object.freeze(rules.map((rule) => Object.freeze(rule)));

  const decide = (action: string, resource: string): PermissionEffect => {
    const evaluated = evaluateRules(frozenRules, action, resource);
    if (!marketplace) return evaluated;
    if (action === 'skill' && !marketplace.skills.includes(resource)) {
      return 'deny';
    }
    const namespaces = marketplace.mcpNamespaces.filter((namespace) =>
      wildcardMatch(action, namespace),
    );
    const ceiling = actionCeiling(action, marketplace);
    if (!ceiling) return 'deny';
    const scopedCeiling =
      action === 'skill'
        ? (marketplace.skillEffects[resource] ?? 'allow')
        : namespaces.reduce<PermissionEffect>(
            (effect, namespace) =>
              moreRestrictive(
                effect,
                marketplace.mcpEffects[namespace] ?? 'allow',
              ),
            'allow',
          );
    return moreRestrictive(moreRestrictive(evaluated, ceiling), scopedCeiling);
  };

  return Object.freeze({
    rules: frozenRules,
    decide,
    decideSkill: (skill: string) => {
      return decide('skill', skill);
    },
  });
}

/** Convert v1 tool permission keys to host v2 action aliases. */
export function v1PermissionTargets(key: string): Array<{
  action: string;
  resource: string;
}> {
  return v1PermKeyToV2(key);
}

function compileMarketplaceRules(
  baseline: readonly V2PermissionRule[],
  host: readonly V2PermissionRule[],
  ceilings: MarketplacePermissionCeilings,
): V2PermissionRule[] {
  const admittedActions = Object.keys(ceilings.actions).filter(
    (action) => action !== 'skill',
  );
  const compiled = [...baseline, ...host].flatMap((rule) => {
    const standard = admittedActions
      .filter((action) => wildcardMatch(action, rule.action))
      .map((action) => ({
        action,
        resource: rule.resource,
        effect: moreRestrictive(rule.effect, ceilings.actions[action]),
      }));
    const mcp = ceilings.mcpNamespaces.flatMap((namespace) =>
      intersectNamespacePattern(rule.action, namespace).map((action) => ({
        action,
        resource: rule.resource,
        effect: moreRestrictive(
          rule.effect,
          ceilings.mcpEffects?.[namespace] ?? 'allow',
        ),
      })),
    );
    return [...standard, ...mcp];
  });

  const fallbacks: V2PermissionRule[] = [
    ...admittedActions.map((action) => ({
      action,
      resource: '*',
      effect: moreRestrictive('ask', ceilings.actions[action]),
    })),
    ...ceilings.mcpNamespaces.map((namespace) => ({
      action: namespace,
      resource: '*',
      effect: moreRestrictive(
        'ask',
        ceilings.mcpEffects?.[namespace] ?? 'allow',
      ),
    })),
    ...ceilings.skills.map((skill) => ({
      action: 'skill',
      resource: skill,
      effect: moreRestrictive(
        moreRestrictive('ask', ceilings.actions.skill ?? 'allow'),
        ceilings.skillEffects?.[skill] ?? 'allow',
      ),
    })),
  ];

  const skillRules = ceilings.skills.flatMap((skill) =>
    [...baseline, ...host]
      .filter((rule) => wildcardMatch('skill', rule.action))
      .filter((rule) => wildcardMatch(skill, rule.resource))
      .map((rule) => ({
        action: 'skill',
        resource: skill,
        effect: moreRestrictive(
          moreRestrictive(rule.effect, ceilings.actions.skill ?? 'allow'),
          ceilings.skillEffects?.[skill] ?? 'allow',
        ),
      })),
  );

  // Unknown actions/resources deny, while each admitted scope starts at ask
  // (clamped by its ceiling) before ordered adapter and host rules apply.
  return [
    { action: '*', resource: '*', effect: 'deny' },
    ...fallbacks,
    ...compiled,
    ...skillRules,
  ];
}

function actionCeiling(
  action: string,
  ceilings: MarketplacePermissionCeilings,
): PermissionEffect | undefined {
  if (action === 'skill') {
    return ceilings.skills.length
      ? (ceilings.actions.skill ?? 'allow')
      : 'deny';
  }
  if (ceilings.actions[action]) return ceilings.actions[action];
  return ceilings.mcpNamespaces.some((namespace) =>
    wildcardMatch(action, namespace),
  )
    ? 'allow'
    : undefined;
}

function evaluateRules(
  rules: readonly V2PermissionRule[],
  action: string,
  resource: string,
): PermissionEffect {
  const match = rules.findLast(
    (rule) =>
      wildcardMatch(action, rule.action) &&
      wildcardMatch(resource, rule.resource),
  );
  return match?.effect ?? 'ask';
}

function moreRestrictive(
  left: PermissionEffect,
  right: PermissionEffect,
): PermissionEffect {
  return EFFECT_RANK[left] >= EFFECT_RANK[right] ? left : right;
}

function cloneRule(rule: V2PermissionRule): V2PermissionRule {
  return { action: rule.action, resource: rule.resource, effect: rule.effect };
}

/** Mirrors OpenCode's anchored Wildcard.match grammar and path normalization. */
function wildcardMatch(value: string, pattern: string): boolean {
  const normalizedValue = value.replaceAll('\\', '/');
  const normalizedPattern = pattern.replaceAll('\\', '/');
  const expression = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${expression}$`, 's').test(normalizedValue);
}

/** Intersect a host glob with an admitted literal-prefix action namespace.
 * NFA states are positions in the host glob. `*` has a self-loop for any
 * character and an epsilon edge to the next position; `?` consumes one.
 * After consuming the namespace prefix, every reachable state supplies one
 * residual glob. Their union is exactly the intersection, with at most
 * hostPattern.length + 1 emitted patterns. */
function intersectNamespacePattern(
  hostPattern: string,
  ceilingPattern: string,
): string[] {
  const host = hostPattern.replaceAll('\\', '/');
  const ceiling = ceilingPattern.replaceAll('\\', '/');
  if (!ceiling.includes('*') && !ceiling.includes('?')) {
    return wildcardMatch(ceiling, host) ? [ceiling] : [];
  }
  if (!ceiling.endsWith('*') || /[?*]/.test(ceiling.slice(0, -1))) {
    throw new Error(
      `Unrepresentable MCP permission pattern intersection: ${hostPattern} & ${ceilingPattern}`,
    );
  }
  const closure = (positions: ReadonlySet<number>): Set<number> => {
    const result = new Set(positions);
    for (let index = 0; index < host.length; index++) {
      if (result.has(index) && host[index] === '*') result.add(index + 1);
    }
    return result;
  };
  let states = closure(new Set([0]));
  const prefix = ceiling.slice(0, -1);
  for (const char of prefix) {
    const next = new Set<number>();
    for (const index of states) {
      const token = host[index];
      if (token === '*') next.add(index);
      else if (token === '?' || token === char) next.add(index + 1);
    }
    states = closure(next);
    if (states.size === 0) return [];
  }
  return [...states]
    .sort((left, right) => left - right)
    .map((index) => prefix + host.slice(index));
}
