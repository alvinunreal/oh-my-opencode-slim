import { AGENT_ALIASES } from './constants';
import type {
  AgentOverrideConfig,
  MarketplaceActivation,
  Preset,
  PresetDefinition,
  PresetInput,
} from './schema';
import { PresetAgentsSchema } from './schema';

/** Recursively merge JSON objects; arrays and scalar values are replaced. */
export function deepMerge<T extends Record<string, unknown>>(
  base?: T,
  override?: T,
): T | undefined {
  if (!base) return override;
  if (!override) return base;

  const result = { ...base } as T;
  for (const key of Object.keys(override) as (keyof T)[]) {
    const baseVal = base[key];
    const overrideVal = override[key];

    if (
      typeof baseVal === 'object' &&
      baseVal !== null &&
      typeof overrideVal === 'object' &&
      overrideVal !== null &&
      !Array.isArray(baseVal) &&
      !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      ) as T[keyof T];
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}

/**
 * Merge agent layers while preserving the explicit model inheritance policy.
 * A missing model normally keeps the lower layer's model, while
 * `inheritModelFrom` intentionally clears it for later model resolution.
 */
export function mergeAgentOverrides(
  base: Record<string, AgentOverrideConfig>,
  override: Record<string, AgentOverrideConfig>,
): Record<string, AgentOverrideConfig> {
  const canonicalBase = canonicalizeAgentAliases(base);
  const canonicalOverride = canonicalizeAgentAliases(override);
  const merged = deepMerge(canonicalBase, canonicalOverride) ?? canonicalBase;
  // Alias fields are merged first, so an alias model can temporarily appear
  // beside a canonical inheritModelFrom directive. Remember that directive
  // from the original layer before clearing the inherited model below.
  const canonicalInheritanceDirectives = new Set(
    Object.entries(override)
      .filter(([name]) => {
        const canonicalName = AGENT_ALIASES[name] ?? name;
        const canonicalValue = override[canonicalName];
        return (
          canonicalName !== name &&
          canonicalValue?.model === undefined &&
          canonicalValue?.inheritModelFrom !== undefined
        );
      })
      .map(([name]) => AGENT_ALIASES[name] ?? name),
  );
  for (const [name, agentOverride] of Object.entries(canonicalOverride)) {
    if (
      !canonicalInheritanceDirectives.has(name) &&
      (agentOverride.model !== undefined ||
        agentOverride.inheritModelFrom === undefined)
    ) {
      continue;
    }
    const entry = merged[name];
    if (entry) {
      const updatedEntry = { ...entry };
      delete updatedEntry.model;
      merged[name] = updatedEntry;
    }
  }
  return merged;
}

/**
 * Collapse legacy agent aliases before merging fields. The canonical record is
 * applied second, so it wins field-by-field while fields that only exist on
 * the alias remain available. This also prevents alias keys from being
 * mistaken for custom agents by downstream consumers.
 */
function canonicalizeAgentAliases(
  agents: Record<string, AgentOverrideConfig>,
): Record<string, AgentOverrideConfig> {
  const result: Record<string, AgentOverrideConfig> = {};

  for (const [name, override] of Object.entries(agents)) {
    const canonicalName = AGENT_ALIASES[name] ?? name;
    if (canonicalName === name) {
      result[name] = deepMerge(result[name], override) as AgentOverrideConfig;
      continue;
    }

    result[canonicalName] = deepMerge(
      result[canonicalName],
      override,
    ) as AgentOverrideConfig;
  }

  // Canonical keys are authoritative when both forms are present. Process
  // them after aliases regardless of their insertion order.
  for (const name of Object.keys(agents)) {
    if (AGENT_ALIASES[name] === undefined) continue;
    const canonicalName = AGENT_ALIASES[name];
    if (!Object.hasOwn(agents, canonicalName)) continue;
    result[canonicalName] = deepMerge(
      result[canonicalName],
      agents[canonicalName],
    ) as AgentOverrideConfig;
  }

  return result;
}

/** Error raised when a selected preset cannot be resolved completely. */
export class PresetResolutionError extends Error {
  readonly kind: 'missing-parent' | 'cycle';
  readonly chain: readonly string[];

  constructor(kind: 'missing-parent' | 'cycle', chain: readonly string[]) {
    const message =
      kind === 'missing-parent'
        ? chain.length > 1
          ? `Preset "${chain[chain.length - 2]}" extends missing preset "${chain[chain.length - 1]}" (chain: ${chain.join(' -> ')})`
          : `Preset "${chain[0]}" was not found`
        : `Preset inheritance cycle detected: ${chain.join(' -> ')}`;
    super(message);
    this.name = 'PresetResolutionError';
    this.kind = kind;
    this.chain = chain;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Convert every accepted external syntax to one canonical representation. */
export function normalizePreset(input: PresetInput): PresetDefinition {
  if (isRecord(input) && isRecord(input.agents)) {
    const isPresetAgentMap = PresetAgentsSchema.safeParse(input.agents);
    if (isPresetAgentMap.success) {
      const { agents, extends: parent, marketplace, ...inlineEntries } = input;
      const normalized: PresetDefinition = {
        agents: deepMerge(inlineEntries as Preset, agents as Preset) as Preset,
      };
      if (typeof parent === 'string') {
        normalized.extends = parent;
      }
      if (marketplace !== undefined) normalized.marketplace = marketplace;
      return normalized;
    }
  }

  const record = input as Record<string, unknown>;
  const hasParent = typeof record.extends === 'string';
  const { marketplace, ...flatEntries } = record;
  const agentEntries = hasParent
    ? Object.fromEntries(
        Object.entries(flatEntries).filter(([name]) => name !== 'extends'),
      )
    : flatEntries;
  const normalized: PresetDefinition = {
    agents: agentEntries as Preset,
  };
  if (hasParent) {
    normalized.extends = record.extends as string;
  }
  if (marketplace !== undefined) {
    normalized.marketplace = marketplace as MarketplaceActivation;
  }
  return normalized;
}

export type PresetMap = Record<string, PresetInput>;
export type ResolvedPresetMap = Record<string, Preset>;

/**
 * Merge preset declarations from layered config files.
 *
 * Presets need agent-aware merging rather than a generic object merge:
 * `inheritModelFrom` is an explicit instruction to remove a lower-layer
 * model. Preserve legacy flat output when both inputs use that syntax, while
 * using the canonical wrapper whenever either layer uses it.
 */
export function mergePresetMaps(
  base?: PresetMap,
  override?: PresetMap,
): PresetMap | undefined {
  if (!base) return override;
  if (!override) return base;

  const result: PresetMap = { ...base };
  for (const [name, overrideInput] of Object.entries(override)) {
    const baseInput = base[name];
    if (!baseInput) {
      result[name] = overrideInput;
      continue;
    }

    const normalizedBase = normalizePreset(baseInput);
    const normalizedOverride = normalizePreset(overrideInput);
    const mergedDefinition: PresetDefinition = {
      agents: mergeAgentOverrides(
        normalizedBase.agents,
        normalizedOverride.agents,
      ),
      marketplace: mergeMarketplaceActivation(
        normalizedBase.marketplace,
        normalizedOverride.marketplace,
      ),
    };
    if (mergedDefinition.marketplace === undefined) {
      delete mergedDefinition.marketplace;
    }
    const parent = normalizedOverride.extends ?? normalizedBase.extends;
    if (parent !== undefined) {
      mergedDefinition.extends = parent;
    }

    if (
      usesStructuredPresetSyntax(baseInput) ||
      usesStructuredPresetSyntax(overrideInput)
    ) {
      result[name] = mergedDefinition;
    } else {
      const legacy = { ...mergedDefinition.agents } as Record<string, unknown>;
      if (mergedDefinition.extends !== undefined) {
        legacy.extends = mergedDefinition.extends;
      }
      if (mergedDefinition.marketplace !== undefined) {
        legacy.marketplace = mergedDefinition.marketplace;
      }
      result[name] = legacy as PresetInput;
    }
  }
  return result;
}

function mergeMarketplaceActivation(
  base?: MarketplaceActivation,
  override?: MarketplaceActivation,
): MarketplaceActivation | undefined {
  if (!base) return override;
  if (!override) return base;
  // Replacement starts a fresh directive layer and discards inherited adds
  // and removals; only directives declared alongside it remain effective.
  if (override.agents !== undefined) return override;

  const mergeDirectives = (
    previous?: string[],
    next?: string[],
    oppositeNext?: string[],
  ): string[] | undefined =>
    next === undefined
      ? previous?.filter((id) => !oppositeNext?.includes(id))
      : next.length === 0
        ? []
        : [
            ...new Set([
              ...(previous ?? []).filter((id) => !oppositeNext?.includes(id)),
              ...next,
            ]),
          ];

  return {
    agents: override.agents ?? base.agents,
    agents_add: mergeDirectives(
      base.agents_add,
      override.agents_add,
      override.agents_remove,
    ),
    agents_remove: mergeDirectives(
      base.agents_remove,
      override.agents_remove,
      override.agents_add,
    ),
  };
}

function resolveMarketplaceActivation(
  parent?: MarketplaceActivation,
  declaration?: MarketplaceActivation,
): MarketplaceActivation | undefined {
  if (!parent && !declaration) return undefined;
  const ids = declaration?.agents ?? parent?.agents ?? [];
  const removed = new Set(declaration?.agents_remove ?? []);
  return {
    agents: [...new Set([...ids, ...(declaration?.agents_add ?? [])])].filter(
      (id) => !removed.has(id),
    ),
  };
}

function usesStructuredPresetSyntax(input: PresetInput): boolean {
  if (!isRecord(input) || !isRecord(input.agents)) {
    return false;
  }
  return PresetAgentsSchema.safeParse(input.agents).success;
}

/**
 * Resolve one named preset with depth-first traversal.
 *
 * The cache is populated only after a complete ancestor chain is resolved, so
 * callers never receive a partially selected preset after an error.
 */
export function resolvePreset(name: string, presets: PresetMap): Preset {
  return resolvePresetDefinition(name, presets).agents;
}

/** Resolve agent and marketplace activation data through preset inheritance. */
export function resolvePresetDefinition(
  name: string,
  presets: PresetMap,
): PresetDefinition {
  const cache = new Map<string, PresetDefinition>();
  const visiting = new Set<string>();
  const stack: string[] = [];

  const visit = (current: string): PresetDefinition => {
    const cached = cache.get(current);
    if (cached) return cached;

    const definition = presets[current];
    if (!definition) {
      throw new PresetResolutionError('missing-parent', [...stack, current]);
    }
    if (visiting.has(current)) {
      const cycleStart = stack.indexOf(current);
      throw new PresetResolutionError('cycle', [
        ...stack.slice(cycleStart),
        current,
      ]);
    }

    visiting.add(current);
    stack.push(current);
    const normalized = normalizePreset(definition);
    const parent = normalized.extends
      ? visit(normalized.extends)
      : { agents: {} as Preset };
    const resolved: PresetDefinition = {
      agents: mergeAgentOverrides(parent.agents, normalized.agents),
    };
    if (normalized.extends !== undefined) {
      resolved.extends = normalized.extends;
    }
    const marketplace = resolveMarketplaceActivation(
      parent.marketplace,
      normalized.marketplace,
    );
    if (marketplace !== undefined) resolved.marketplace = marketplace;
    stack.pop();
    visiting.delete(current);
    cache.set(current, resolved);
    return resolved;
  };

  return visit(name);
}

/** Resolve all named presets atomically. */
export function resolvePresets(presets: PresetMap): ResolvedPresetMap {
  const resolved: ResolvedPresetMap = {};
  for (const name of Object.keys(presets)) {
    resolved[name] = resolvePreset(name, presets);
  }
  return resolved;
}
