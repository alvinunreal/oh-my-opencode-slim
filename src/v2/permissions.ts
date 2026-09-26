import type { V2PermissionRule } from './types';

export type PermissionEffect = V2PermissionRule['effect'];

export interface PermissionCeilings {
  /** Exact native action names and their maximum admitted effect. */
  readonly actions: Readonly<Record<string, PermissionEffect>>;
  /** Resource ceilings keyed by exact native action. */
  readonly resources?: Readonly<
    Record<string, Readonly<Record<string, PermissionEffect>>>
  >;
  /** Admitted native action namespaces, using literal-prefix `*` patterns. */
  readonly namespaces: readonly string[];
  /** Maximum effect for each admitted namespace; absent means allow. */
  readonly namespaceEffects?: Readonly<Record<string, PermissionEffect>>;
}

export interface PermissionPolicyInput {
  readonly baselineRules: readonly V2PermissionRule[];
  readonly hostRules: readonly V2PermissionRule[];
  readonly ceilings?: PermissionCeilings;
  readonly finalDenials?: readonly string[];
}

export interface PermissionPolicy {
  readonly rules: readonly V2PermissionRule[];
  decide(action: string, resource: string): PermissionEffect;
}

const EFFECT_RANK: Record<PermissionEffect, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/** Compile ordered native rules with optional immutable admission ceilings. */
export function compilePermissionPolicy(
  input: PermissionPolicyInput,
): PermissionPolicy {
  const rules = input.ceilings
    ? compileCeilingRules(
        input.baselineRules,
        input.hostRules,
        cloneCeilings(input.ceilings),
      )
    : [...input.baselineRules, ...input.hostRules].map(cloneRule);
  rules.push(
    ...(input.finalDenials ?? []).map((action) => ({
      action,
      resource: '*',
      effect: 'deny' as const,
    })),
  );
  const frozenRules = Object.freeze(rules.map((rule) => Object.freeze(rule)));
  return Object.freeze({
    rules: frozenRules,
    decide: (action: string, resource: string) =>
      evaluateRules(frozenRules, action, resource),
  });
}

function compileCeilingRules(
  baseline: readonly V2PermissionRule[],
  host: readonly V2PermissionRule[],
  ceilings: PermissionCeilings,
): V2PermissionRule[] {
  const actions = Object.keys(ceilings.actions).map(normalizePattern);
  const namespaces = ceilings.namespaces.map((pattern) =>
    normalizeCeilingPattern(pattern, 'namespace'),
  );
  const resources = Object.fromEntries(
    Object.entries(ceilings.resources ?? {}).map(([action, patterns]) => [
      normalizePattern(action),
      Object.entries(patterns).map(
        ([pattern, effect]) =>
          [normalizeCeilingPattern(pattern, 'resource'), effect] as const,
      ),
    ]),
  );
  for (const action of actions) {
    if (!isLiteral(action)) {
      throw new Error(
        `Permission action ceiling must be an exact action: ${action}`,
      );
    }
  }
  for (const action of Object.keys(resources)) {
    if (!isLiteral(action)) {
      throw new Error(
        `Permission resource ceiling action must be exact: ${action}`,
      );
    }
  }
  const allRules = [...baseline, ...host];
  const output: V2PermissionRule[] = [
    {
      action: '*',
      resource: '*',
      effect: 'deny',
    },
  ];

  // Admission defaults are ask. Specific source rules follow in their original
  // order, with each rule's ceilings emitted before the next source rule.
  const defaults: V2PermissionRule[] = [
    ...actions.map((action) => ({
      action,
      resource: '*',
      effect: moreRestrictive(
        'ask',
        moreRestrictive(
          ceilings.actions[action] ?? 'allow',
          namespaces
            .filter((namespace) => patternMatches(namespace, action))
            .reduce<PermissionEffect>(
              (effect, namespace) =>
                moreRestrictive(
                  effect,
                  ceilings.namespaceEffects?.[namespace] ?? 'allow',
                ),
              'allow',
            ),
        ),
      ),
    })),
    ...namespaces.map((action) => ({
      action,
      resource: '*',
      effect: moreRestrictive(
        'ask',
        ceilings.namespaceEffects?.[action] ?? 'allow',
      ),
    })),
  ];
  for (const [action, resourceCeilings] of Object.entries(resources)) {
    for (const [resource, effect] of resourceCeilings) {
      defaults.push({
        action,
        resource,
        effect: moreRestrictive(
          moreRestrictive(
            'ask',
            actions.includes(action) ||
              namespaces.some((namespace) => patternMatches(namespace, action))
              ? (ceilings.actions[action] ?? 'allow')
              : 'deny',
          ),
          effect,
        ),
      });
    }
  }
  defaults.sort(
    (left, right) => EFFECT_RANK[left.effect] - EFFECT_RANK[right.effect],
  );
  output.push(...defaults);

  for (const source of allRules) {
    const actionPatterns = [...actions, ...namespaces]
      .flatMap((ceiling) => intersectPattern(source.action, ceiling))
      .filter((pattern, index, all) => all.indexOf(pattern) === index);
    const block: V2PermissionRule[] = [];
    for (const action of actionPatterns) {
      const actionEffect = moreRestrictive(
        moreRestrictive(source.effect, ceilings.actions[action] ?? 'allow'),
        namespaces
          .filter((namespace) => patternContains(namespace, action))
          .reduce<PermissionEffect>(
            (effect, namespace) =>
              moreRestrictive(
                effect,
                ceilings.namespaceEffects?.[namespace] ?? 'allow',
              ),
            'allow',
          ),
      );
      for (const resource of intersectPattern(source.resource, '*')) {
        block.push({ action, resource, effect: actionEffect });
      }
      for (const [resourceAction, ceilingsForResource] of Object.entries(
        resources,
      )) {
        if (!patternMatches(action, resourceAction)) continue;
        const exactAction = intersectPattern(source.action, resourceAction)[0];
        if (!exactAction) continue;
        for (const [ceiling, effect] of ceilingsForResource) {
          const overlap = intersectPattern(source.resource, ceiling);
          for (const resource of overlap) {
            block.push({
              action: exactAction,
              resource,
              effect: moreRestrictive(actionEffect, effect),
            });
          }
        }
      }
    }
    block.sort(
      (left, right) => EFFECT_RANK[left.effect] - EFFECT_RANK[right.effect],
    );
    output.push(...block);
  }
  return output;
}

function intersectPattern(source: string, ceiling: string): string[] {
  const normalizedSource = normalizePattern(source);
  const normalizedCeiling = normalizePattern(ceiling);
  if (normalizedCeiling === '*') return [normalizedSource];
  return sourceVariants(normalizedSource)
    .flatMap((sourceVariant) =>
      sourceVariants(normalizedCeiling).flatMap((ceilingVariant) => {
        if (!ceilingVariant.includes('*')) {
          return patternMatches(sourceVariant, ceilingVariant)
            ? [ceilingVariant]
            : [];
        }
        const prefix = ceilingVariant.slice(0, -1);
        if (!prefix) return [sourceVariant];
        let states = globClosure(sourceVariant, new Set([0]));
        for (const character of prefix) {
          const next = new Set<number>();
          for (const state of states) {
            const token = sourceVariant[state];
            if (token === '*') next.add(state);
            else if (token === '?' || token === character) next.add(state + 1);
          }
          states = globClosure(sourceVariant, next);
          if (states.size === 0) return [];
        }
        return [...states].flatMap((state) =>
          safeNativePatterns(`${prefix}${sourceVariant.slice(state)}`),
        );
      }),
    )
    .filter((pattern, index, all) => all.indexOf(pattern) === index);
}

function normalizeCeilingPattern(pattern: string, kind: string): string {
  const normalized = normalizePattern(pattern).replace(/\*+/g, '*');
  if (
    normalized !== '*' &&
    !isLiteral(normalized) &&
    !isPrefixPattern(normalized)
  ) {
    throw new Error(
      `Unsupported permission ${kind} ceiling pattern: ${JSON.stringify(pattern)}; expected a literal, *, or literal-prefix *`,
    );
  }
  return normalized;
}

function normalizePattern(pattern: string): string {
  return pattern.replaceAll('\\', '/');
}

function isLiteral(pattern: string): boolean {
  return !/[?*]/.test(pattern);
}

function isPrefixPattern(pattern: string): boolean {
  return pattern.endsWith('*') && !/[?*]/.test(pattern.slice(0, -1));
}

function patternContains(container: string, value: string): boolean {
  if (container === '*') return true;
  if (isLiteral(container)) return container === value;
  return value.startsWith(container.slice(0, -1));
}

function sourceVariants(pattern: string): string[] {
  if (!pattern.endsWith(' *') || pattern.endsWith(' **')) return [pattern];
  return [pattern.slice(0, -2), pattern];
}

function safeNativePatterns(pattern: string): string[] {
  if (!pattern.endsWith(' *') || pattern.endsWith(' **')) return [pattern];
  const prefix = pattern.slice(0, -1);
  return [prefix, `${prefix}?*`];
}

function globClosure(pattern: string, states: Set<number>): Set<number> {
  for (let state = 0; state < pattern.length; state++) {
    if (states.has(state) && pattern[state] === '*') states.add(state + 1);
  }
  return states;
}

function evaluateRules(
  rules: readonly V2PermissionRule[],
  action: string,
  resource: string,
): PermissionEffect {
  const match = rules.findLast(
    (rule) =>
      patternMatches(rule.action, action) &&
      patternMatches(rule.resource, resource),
  );
  return match?.effect ?? 'ask';
}

function moreRestrictive(
  left: PermissionEffect,
  right: PermissionEffect,
): PermissionEffect {
  return EFFECT_RANK[left] >= EFFECT_RANK[right] ? left : right;
}

function cloneCeilings(ceilings: PermissionCeilings): PermissionCeilings {
  const namespaceEffects = Object.fromEntries(
    Object.entries(ceilings.namespaceEffects ?? {}).map(([pattern, effect]) => [
      normalizeCeilingPattern(pattern, 'namespace'),
      effect,
    ]),
  );
  return {
    actions: Object.freeze(
      Object.fromEntries(
        Object.entries(ceilings.actions).map(([action, effect]) => [
          normalizePattern(action),
          effect,
        ]),
      ),
    ),
    resources: Object.freeze(
      Object.fromEntries(
        Object.entries(ceilings.resources ?? {}).map(([action, patterns]) => [
          action,
          Object.freeze({ ...patterns }),
        ]),
      ),
    ),
    namespaces: Object.freeze(
      ceilings.namespaces.map((pattern) =>
        normalizeCeilingPattern(pattern, 'namespace'),
      ),
    ),
    namespaceEffects: Object.freeze(namespaceEffects),
  };
}

function cloneRule(rule: V2PermissionRule): V2PermissionRule {
  return { action: rule.action, resource: rule.resource, effect: rule.effect };
}

/** Mirrors the host matcher: slash normalization, `?`, `*`, and `git *`. */
function patternMatches(pattern: string, value: string): boolean {
  const normalizedPattern = normalizePattern(pattern);
  const normalizedValue = value.replaceAll('\\', '/');
  return sourceVariants(normalizedPattern).some((variant) => {
    const expression = variant
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${expression}$`, 's').test(normalizedValue);
  });
}
