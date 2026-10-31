import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk/v2';
import { getSkillPermissionsForAgent } from '../cli/skills';
import {
  AGENT_ALIASES,
  type AgentOverrideConfig,
  loadAgentPrompt,
} from '../config';
import { parseList } from '../config/agent-mcps';
import { resolvePreset } from '../config/presets';
import type { HostConfigSnapshot, RuntimeConfig } from '../config/runtime';
import { hostLegacyAgent } from '../config/runtime';
import { applyOrchestratorModelConfig } from '../config/strip-orchestrator-model';
import { lookupWithAliases } from '../config/utils';
import type { MarketplaceActivationStore } from '../marketplace/activation';
import { MARKETPLACE_TOOL_NAMES } from '../marketplace/capabilities';
import { marketplaceConfigFingerprint } from '../marketplace/config-identity';
import { ambiguousMcpNamespaces } from '../marketplace/mcp-namespaces';
import type {
  MarketplaceAgentMetadata,
  MarketplaceRegistryImplementation,
} from '../marketplace/registry-runtime';
import type { MarketplaceSkillRequirements } from '../marketplace/skills';
import { normalizeAgentName } from '../utils/agent-variant';
import { adaptPermissions, v1PermKeyToV2 } from '../v2/adapters';
import {
  compilePermissionPolicy,
  type PermissionCeilings,
} from '../v2/permissions';
import type { V2PermissionRule } from '../v2/types';
import {
  ensureCouncilCompactionException,
  ensureCouncilSynthesisReinforcement,
} from './council';
import {
  applyModelInheritanceToConfig,
  createAgents,
  getAgentConfigsFromDefinitions,
} from './index';
import { type AgentDefinition, resolvePrompt } from './orchestrator';
import { mergeTaskStance } from './permissions';

export interface ResolvedAgentRegistry {
  readonly hostFlavor: string | undefined;
  readonly agentNames: readonly string[];
  readonly marketplaceAgentNames: readonly string[];
  readonly marketplacePackages: readonly MarketplaceLivePackage[];
  readonly marketplaceRequiredSkills: readonly MarketplaceSkillRequirements[];
  readonly identities: Readonly<Record<string, string>>;
  readonly modelCandidates: Readonly<
    Record<string, readonly { id: string; variant?: string }[]>
  >;
  /** Marketplace agents' pre-override manifest chains. Owner overrides
   *  rewrite `definition._modelArray`, so these are the only copy of the
   *  package's own chain — a refresh needs them when an override is
   *  removed while the package stays selected. */
  readonly marketplaceManifestChains: Readonly<
    Record<string, readonly { id: string; variant?: string }[]>
  >;
  /** Pure pre-owner inference only; never a resource/activation projection. */
  readonly marketplaceInferenceBase: Readonly<
    Record<
      string,
      {
        model?: string;
        variant?: string;
        temperature?: number;
        options?: Record<string, unknown>;
        inheritModelFrom?: 'session';
        modelFrom?: string;
      }
    >
  >;
  readonly effectiveStartupModels: Readonly<
    Record<string, { model?: string; variant?: string }>
  >;
  readonly tuiAgentModels: Readonly<Record<string, string>>;
  readonly tuiAgentVariants: Readonly<Record<string, string>>;
  readonly nativePolicies: Readonly<
    Record<string, ReturnType<typeof compilePermissionPolicy>>
  >;
  /** Reapply owned ceilings to authoritative host-expanded rules, without
   * replaying the pre-host-finalization permission baseline. The agent's
   * registered delegation stance (v1 `task` → v2 `subagent` rules) is
   * re-appended as the final rules so a host-side trailing global allow
   * cannot defeat it under last-match-wins evaluation. */
  compileChildPermissions(
    agent: string,
    rules: readonly V2PermissionRule[],
  ): readonly V2PermissionRule[];
  readonly mcpConfig: Readonly<Record<string, unknown>>;
  readonly managedMcpConfig: Readonly<Record<string, unknown>>;
  readonly finalAgentConfig: Readonly<Record<string, unknown>>;
  readonly managedAgentConfig: Readonly<Record<string, unknown>>;
  getSdkAgentProjection(): Record<string, SDKAgentConfig>;
}

export interface MarketplaceLivePackage {
  readonly id: string;
  readonly runtimeName: string;
  readonly version: string;
  readonly digest: string;
  readonly configFingerprint: string;
}

export interface RegistryHostSnapshot extends HostConfigSnapshot {
  agent?: Record<string, Record<string, unknown>>;
  mcp?: Record<string, unknown>;
}

export interface RegistryBuildOptions {
  readonly hostSnapshot: RegistryHostSnapshot;
  readonly projectDirectory?: string;
  readonly hostFlavor?: string;
  readonly definitions?: readonly AgentDefinition[];
  readonly pluginMcps?: Readonly<Record<string, unknown>>;
  readonly nativePermissionsByAgent?: Readonly<
    Record<string, readonly V2PermissionRule[]>
  >;
  readonly onHostModelSelected?: (agentName: string) => void;
  readonly marketplace?: {
    /** Loaded only after the existing marketplace activation gate. */
    readonly implementation: MarketplaceRegistryImplementation;
    readonly selectedPackageIds: readonly string[];
    readonly store: MarketplaceActivationStore;
    readonly pluginVersion: string;
    readonly availableSkillNames?: readonly string[];
  };
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)]),
    ) as T;
  }
  return value;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function isMcpEnabled(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const config = value as { enabled?: unknown; disabled?: unknown };
  return config.enabled !== false && config.disabled !== true;
}

function applyMarketplaceOwnerOverride(
  definition: AgentDefinition,
  override: ReturnType<RuntimeConfig['agents']>[string] | undefined,
): void {
  if (!override) return;
  if (typeof override.prompt === 'string') {
    definition.config.prompt = override.prompt;
  }
  if (typeof override.description === 'string') {
    definition.description = override.description;
  }
  if (typeof override.model === 'string') {
    definition.config.model = override.model;
  } else if (Array.isArray(override.model) && override.model.length > 0) {
    const models = override.model.map((model) =>
      typeof model === 'string' ? { id: model } : { ...model },
    );
    definition._modelArray = models;
    // Declared primaries (agents.<name>.primary) are not projected yet
    // (issue #1591).
    if (definition.name !== 'orchestrator') {
      definition.config.model = models[0]?.id;
      if (models[0]?.variant) definition.config.variant = models[0].variant;
    }
  }
  if (override.inheritModelFrom === 'session') {
    delete definition.config.model;
    if (override.variant === undefined) delete definition.config.variant;
  }
  if (typeof override.variant === 'string') {
    definition.config.variant = override.variant;
  }
  if (typeof override.temperature === 'number') {
    definition.config.temperature = override.temperature;
  }
  if (override.color) definition.config.color = override.color;
  if (override.options) {
    definition.config.options = {
      ...definition.config.options,
      ...clone(override.options),
    };
  }
  if (override.permission) {
    definition.config.permission = mergeTaskStance(
      clone(override.permission),
      definition.config.permission,
    );
  }
}

function narrowCapabilities(
  ceiling: readonly string[],
  requested: readonly string[] | undefined,
): string[] {
  if (requested === undefined) return [...ceiling];
  const allowed = new Set(parseList([...requested], [...ceiling]));
  return ceiling.filter((name) => allowed.has(name));
}

function permissionEffect(
  permission: Record<string, unknown> | string,
  key: string,
): 'allow' | 'ask' | 'deny' {
  if (typeof permission === 'string') {
    return permission === 'allow' || permission === 'ask' ? permission : 'deny';
  }
  const direct = permission[key];
  const wildcard = permission['*'];
  if (direct === 'deny' || direct === 'ask' || direct === 'allow') {
    return direct;
  }
  if (wildcard === 'deny' || wildcard === 'ask' || wildcard === 'allow') {
    return wildcard;
  }
  return 'allow';
}

function normalizePermission(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return { '*': value };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return clone(value as Record<string, unknown>);
  }
  return {};
}

function nativeEditPermission(
  existing: Record<string, unknown>,
  tools: readonly string[],
): unknown {
  const rules = [
    existing.edit,
    ...tools
      .filter((tool) => tool === 'write' || tool === 'apply_patch')
      .map((tool) => existing[tool]),
  ].filter((rule) => rule !== undefined);
  if (rules.length === 0) return permissionEffect(existing, 'edit');
  if (rules.some((rule) => rule === 'deny')) return 'deny';
  const maps = rules.filter(
    (rule): rule is Record<string, unknown> =>
      !!rule && typeof rule === 'object' && !Array.isArray(rule),
  );
  // Distinct path maps cannot be safely intersected as one native edit rule.
  if (
    rules.some(
      (rule) =>
        rule !== 'allow' &&
        rule !== 'ask' &&
        !maps.includes(rule as Record<string, unknown>),
    ) ||
    maps.some((rule) => JSON.stringify(rule) !== JSON.stringify(maps[0]))
  ) {
    return 'deny';
  }
  if (maps.length > 0) {
    return Object.fromEntries(
      Object.entries(maps[0]).map(([pattern, effect]) => [
        pattern,
        rules.includes('ask') && effect === 'allow' ? 'ask' : effect,
      ]),
    );
  }
  return rules.includes('ask') ? 'ask' : 'allow';
}

function projectMarketplacePermission(
  existing: Record<string, unknown>,
  tools: readonly string[],
  skills: readonly string[],
  mcps: readonly string[],
  availableMcps: readonly string[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = { '*': 'deny' };
  for (const tool of MARKETPLACE_TOOL_NAMES) projected[tool] = 'deny';
  for (const tool of tools) {
    const existingRule = existing[tool];
    projected[tool] = permissionEffect(existing, tool);
    if (existingRule && typeof existingRule === 'object') {
      projected[tool] = clone(existingRule);
    }
  }
  if (tools.some((tool) => tool === 'write' || tool === 'apply_patch')) {
    projected.edit = nativeEditPermission(existing, tools);
  }
  // `external_directory` is a native safety guard, not a manifest tool
  // capability: it is never in `tools`, never inferred from a tool grant or
  // the wildcard fallback, and never synthesized. Only an explicit owner
  // declaration — a whole-tool effect or a resource map — carries through,
  // verbatim. The `'*': 'deny'` base keeps an absent declaration denied.
  const declaredExternal = existing.external_directory;
  if (typeof declaredExternal === 'string') {
    projected.external_directory =
      declaredExternal === 'allow' || declaredExternal === 'ask'
        ? declaredExternal
        : 'deny';
  } else if (
    declaredExternal &&
    typeof declaredExternal === 'object' &&
    !Array.isArray(declaredExternal)
  ) {
    projected.external_directory = clone(
      declaredExternal as Record<string, unknown>,
    );
  }
  const existingSkills = existing.skill;
  const grants = getSkillPermissionsForAgent('__marketplace__', skills);
  const wildcard = grants['*'] === 'allow';
  const skillPermissions: Record<string, unknown> = {
    '*': wildcard
      ? existingSkills === undefined
        ? permissionEffect(existing, 'skill')
        : permissionEffect(
            existingSkills as Record<string, unknown> | string,
            '*',
          )
      : 'deny',
    ...(wildcard && existingSkills && typeof existingSkills === 'object'
      ? clone(existingSkills as Record<string, unknown>)
      : {}),
  };
  for (const [skill, effect] of Object.entries(grants)) {
    if (skill === '*') continue;
    skillPermissions[skill] =
      effect === 'deny'
        ? 'deny'
        : existingSkills === undefined
          ? permissionEffect(existing, 'skill')
          : permissionEffect(
              existingSkills as Record<string, unknown> | string,
              skill,
            );
  }
  projected.skill = skillPermissions;
  const allowedMcps = new Set(mcps);
  for (const name of availableMcps) {
    const key = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}_*`;
    projected[key] = allowedMcps.has(name)
      ? permissionEffect(existing, key)
      : 'deny';
  }
  return projected;
}

/**
 * Conservative deny floor for the `external_directory` native safety guard.
 * Emitted as the FIRST baseline rule of every Marketplace policy — ahead of
 * the source and host rules but after the compiler's admission defaults — so
 * the ceiling's `defaultEffect: 'allow'` can never synthesize a grant for an
 * empty policy. Explicit owner declarations and finalized host rules follow
 * in their original order, so last-match-wins still lets a declared allow or
 * a resource map open (and re-restrict) the guard; nothing is ever granted
 * when nothing was declared. It is a policy default, not a declared denial:
 * it never enters the registered `baselineRules` and so never replays in the
 * child-payload deny ceiling behind authoritative host rules.
 */
const EXTERNAL_DIRECTORY_GUARD_FLOOR: readonly V2PermissionRule[] = [
  { action: 'external_directory', resource: '*', effect: 'deny' },
];

function marketplacePermissionCeilings(
  tools: readonly string[],
  skills: readonly string[],
  mcps: readonly string[],
): PermissionCeilings {
  const actions: Record<string, 'allow' | 'deny'> = {
    // The native safety guard is admitted so explicit owner declarations and
    // finalized host rules can reach the policy; the conservative guard floor
    // in `finalizeAgentPolicy` / `compileChildPermissions` keeps it denied
    // until something declares it. It is deliberately not a manifest tool:
    // a package's `tools` list can never open it.
    external_directory: 'allow',
  };
  for (const tool of tools) {
    if (tool === 'write' || tool === 'apply_patch') actions.edit = 'allow';
    if (tool === 'bash') {
      for (const { action } of v1PermKeyToV2(tool)) actions[action] = 'allow';
    } else if ((MARKETPLACE_TOOL_NAMES as readonly string[]).includes(tool)) {
      actions[tool] = 'allow';
    }
  }
  const grants = getSkillPermissionsForAgent('__marketplace__', skills);
  const permitted = Object.values(grants).includes('allow');
  actions.skill = permitted ? 'allow' : 'deny';
  const namespaces = mcps.map(
    (name) => `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}_*`,
  );
  return {
    defaultEffect: 'allow',
    actions,
    namespaces,
    ...(permitted
      ? {
          resources: {
            skill: { ...grants },
          },
        }
      : {}),
  };
}

function marketplaceReadSafeguards(
  tools: readonly string[],
): V2PermissionRule[] {
  if (!tools.includes('read')) return [];
  return [
    { action: 'read', resource: '*.env', effect: 'ask' },
    { action: 'read', resource: '*.env.*', effect: 'ask' },
    { action: 'read', resource: '*.env.example', effect: 'allow' },
  ];
}

/**
 * The plugin-authored declarative deny ceiling for one agent: the specific
 * denials of its registered permission map, each riding with its declared
 * allow exceptions. Only the agent's own rules replay. Empty for agents
 * without declarations (the orchestrator); an ask is never appended: it
 * would park a background child on input nothing can answer, so a deny
 * gated by a later declared ask is not replayed at all. Denies only
 * move earlier with their exceptions; a baseline-final deny stays final in
 * the tail, so the replay can only flip allow→deny, never deny→allow.
 */
function denyCeilingTail(
  baselineRules: readonly V2PermissionRule[],
): V2PermissionRule[] {
  const tail: V2PermissionRule[] = [];
  for (const [index, rule] of baselineRules.entries()) {
    // Specific-action denies only: a wildcard-action deny is the default
    // floor, and replaying it last erases the declared allow exceptions
    // behind it (the factory read-only matrix and the marketplace
    // projection open with `'*': 'deny'`).
    if (rule.effect !== 'deny' || rule.action === '*') continue;
    // Exceptions ride with the deny in baseline order. A same-action
    // or exact-action allow inside a denied namespace is the exception of
    // the LAST same-action deny with the same resource target
    // whose resource does not strictly swallow it (an equal-target re-allow
    // rides too, so the factory task stances keep their deny→exception
    // adjacency). An ask-only shadow means the exception is a consent gate,
    // so the deny stays home too.
    const exceptions: V2PermissionRule[] = [];
    const seen = new Set<number>();
    for (
      let laterIndex = index + 1;
      laterIndex < baselineRules.length;
      laterIndex += 1
    ) {
      const later = baselineRules[laterIndex];
      if (
        later.effect !== 'allow' ||
        (later.action !== rule.action &&
          (/[*?]/.test(later.action) ||
            !resourcePatternCovers(rule.action, later.action)))
      )
        continue;
      for (let denyIndex = laterIndex - 1; denyIndex >= index; denyIndex -= 1) {
        const peer = baselineRules[denyIndex];
        // Keep ownership within this action's chain. A namespace denial must
        // not steal an exact action's exception and cause its broader deny
        // to be dropped by the shadow check below.
        if (peer.action !== rule.action || peer.effect !== 'deny') continue;
        if (
          peer.resource === rule.resource ||
          (later.resource === rule.resource &&
            rule.resource !== '*' &&
            resourcePatternCovers(peer.resource, later.resource))
        ) {
          if (peer === rule && !seen.has(laterIndex)) {
            seen.add(laterIndex);
            // Cross-action replay must respect the FINAL declared policy,
            // not revive an allow superseded by a later resource denial.
            // Keep partial grants with their narrower restrictions too.
            exceptions.push(
              ...(later.action === rule.action
                ? [later]
                : boundGrantByHost(baselineRules, later)),
            );
          }
          break;
        }
        if (
          peer.resource !== '*' &&
          later.resource !== '*' &&
          resourcePatternCovers(peer.resource, later.resource)
        ) {
          break;
        }
      }
    }
    // Any later same-target or strictly narrower same-action allow/ask
    // decision (a consent gate or a narrowed re-allow) shadows a deny left
    // without a riding allow; replaying no exception must not kill it. A
    // broader later decision is the deny's own floor, not a shadow.
    const shadowed = baselineRules
      .slice(index + 1)
      .some(
        (later) =>
          later.action === rule.action &&
          (later.effect === 'allow' || later.effect === 'ask') &&
          (later.resource === rule.resource ||
            (rule.resource !== '*' &&
              later.resource !== '*' &&
              resourcePatternCovers(rule.resource, later.resource))),
      );
    if (exceptions.length === 0 && shadowed) continue;
    // A later same-action ask that can reach any resource of this deny is a
    // declared consent gate. Asks never ride (an appended ask parks a
    // background child), so replaying the deny would turn the gated
    // resources from ask into deny — the deny stays home instead.
    const askGated = baselineRules
      .slice(index + 1)
      .some(
        (later) =>
          later.effect === 'ask' &&
          resourcePatternsOverlap(later.action, rule.action) &&
          resourcePatternsOverlap(later.resource, rule.resource),
      );
    if (askGated) continue;
    tail.push(
      { ...rule },
      ...exceptions.map((exception) => ({ ...exception })),
    );
  }
  return tail;
}

/**
 * Whether a permission resource pattern covers a same-action declared
 * target (literal or pattern). Mirrors the host matcher for the shapes the
 * plugin emits: slash normalization, `?`, `*`, and trailing ` <space>*`.
 * Used only to place declared exceptions behind their deny, never to
 * evaluate access. A misjudged cover only misplaces an exception earlier —
 * fail-closed by the tail's monotonicity.
 */
function resourcePatternCovers(cover: string, target: string): boolean {
  const normalizedCover = cover.replaceAll('\\', '/');
  const normalizedTarget = target.replaceAll('\\', '/');
  const variants = (pattern: string): string[] => {
    if (!pattern.endsWith(' *') || pattern.endsWith(' **')) return [pattern];
    return [pattern.slice(0, -2), pattern];
  };
  return variants(normalizedTarget).some((targetVariant) =>
    variants(normalizedCover).some((coverVariant) =>
      globContains(coverVariant, targetVariant),
    ),
  );
}

/**
 * Whether every value matched by glob `target` is matched by glob `cover`
 * (`*` and `?` wildcards). A cover `?` absorbs one target literal or `?`,
 * never a target `*` (which may span zero or many characters). Sound but
 * conservative: an unprovable containment reports false.
 */
function globContains(cover: string, target: string): boolean {
  const memo = new Map<number, boolean>();
  const covers = (i: number, j: number): boolean => {
    const key = i * (target.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (i === cover.length) result = j === target.length;
    else if (cover[i] === '*')
      result = covers(i + 1, j) || (j < target.length && covers(i, j + 1));
    else if (j === target.length) result = false;
    else if (cover[i] === '?')
      result = target[j] !== '*' && covers(i + 1, j + 1);
    else result = target[j] === cover[i] && covers(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return covers(0, 0);
}

/**
 * Whether two permission patterns may match a common value. Exact when
 * either side is literal; for two patterns it checks only that the literal
 * heads and tails are compatible, which over-approximates overlap. Callers
 * use it only to keep restrictions, so an over-approximation can only make
 * the result stricter, never looser.
 */
function resourcePatternsOverlap(left: string, right: string): boolean {
  const variants = (pattern: string): string[] => {
    const normalized = pattern.replaceAll('\\', '/');
    if (!normalized.endsWith(' *') || normalized.endsWith(' **'))
      return [normalized];
    return [normalized.slice(0, -2), normalized];
  };
  const isPattern = (pattern: string) => /[*?]/.test(pattern);
  return variants(left).some((leftVariant) =>
    variants(right).some((rightVariant) => {
      if (!isPattern(leftVariant))
        return resourcePatternCovers(rightVariant, leftVariant);
      if (!isPattern(rightVariant))
        return resourcePatternCovers(leftVariant, rightVariant);
      const head = (pattern: string) =>
        pattern.slice(0, pattern.search(/[*?]/));
      const tail = (pattern: string) =>
        pattern.slice(
          Math.max(pattern.lastIndexOf('*'), pattern.lastIndexOf('?')) + 1,
        );
      const leftHead = head(leftVariant);
      const rightHead = head(rightVariant);
      const leftTail = tail(leftVariant);
      const rightTail = tail(rightVariant);
      return (
        (leftHead.startsWith(rightHead) || rightHead.startsWith(leftHead)) &&
        (leftTail.endsWith(rightTail) || rightTail.endsWith(leftTail))
      );
    }),
  );
}

const EFFECT_STRICTNESS = { allow: 0, ask: 1, deny: 2 } as const;

function stricterEffect(
  left: V2PermissionRule['effect'],
  right: V2PermissionRule['effect'],
): V2PermissionRule['effect'] {
  return EFFECT_STRICTNESS[left] >= EFFECT_STRICTNESS[right] ? left : right;
}

/**
 * Bound one replayed grant (a declared allow exception) by the host rules
 * across EVERY resource its pattern matches, not just the pattern string.
 *
 * Let `cover` be the last host rule whose action and resource patterns
 * cover the whole grant. For any resource the grant matches, the host's
 * findLast verdict is `cover` or a rule after it (default `ask` when there
 * is no cover). The grant is emitted at meet(grant, cover), followed, in
 * host order and narrowed to the grant's action, by every host rule after
 * `cover` that is a deny for the action, an ask clipped to the grant (kept
 * if within it, narrowed to the grant's pattern if it only overlaps), or an
 * allow whose pattern lies within the grant's pattern (the host's own
 * exceptions to its restrictions inside the grant).
 *
 * Never looser than the host: if the grant is a resource's final match, no
 * host deny/ask after `cover` matches it, so the host verdict is `cover` or
 * an allow. If a re-appended host rule is the final match, any later host
 * deny/ask matching the resource would itself have been re-appended after
 * it, so the host's own last match is that rule or an allow. Never looser
 * than the declared ceiling: a re-appended allow only matches resources
 * inside the grant's pattern, which the declared ceiling already allows.
 *
 * A grant whose action is itself a pattern cannot be narrowed safely, so it
 * folds every overlapping host deny/ask into its own effect instead.
 */
function boundGrantByHost(
  hostRules: readonly V2PermissionRule[],
  grant: V2PermissionRule,
): V2PermissionRule[] {
  let coverIndex = -1;
  for (let index = hostRules.length - 1; index >= 0; index -= 1) {
    const rule = hostRules[index];
    if (
      resourcePatternCovers(rule.action, grant.action) &&
      resourcePatternCovers(rule.resource, grant.resource)
    ) {
      coverIndex = index;
      break;
    }
  }
  let effect = stricterEffect(
    grant.effect,
    coverIndex >= 0 ? hostRules[coverIndex].effect : 'ask',
  );
  const later = hostRules
    .slice(coverIndex + 1)
    .filter((rule) => resourcePatternsOverlap(rule.action, grant.action));
  if (/[*?]/.test(grant.action)) {
    for (const rule of later) {
      if (rule.effect === 'allow') continue;
      if (resourcePatternsOverlap(rule.resource, grant.resource))
        effect = stricterEffect(effect, rule.effect);
    }
    return effect === 'deny' ? [] : [{ ...grant, effect }];
  }
  // Within, not merely overlapping: an allow reaching outside the grant
  // would loosen the declared ceiling. The string match below implies set
  // inclusion only when the grant's pattern uses `*` alone as a wildcard.
  const resourceWithinGrant = (resource: string) =>
    !grant.resource.includes('?') &&
    // Every matcher variant of the rule (a trailing ` *` also matches the
    // bare prefix) must fall inside the grant.
    (resource.endsWith(' *') && !resource.endsWith(' **')
      ? [resource.slice(0, -2), resource]
      : [resource]
    ).every((variant) => resourcePatternCovers(grant.resource, variant));
  // Host denies replay as written: they only tighten. Host allows must lie
  // within the grant. Host asks must not reach outside the grant either,
  // where they would override a declared deny: an ask that only overlaps
  // the grant is widened to the grant's own pattern with earlier denies
  // re-asserted (stricter inside the grant, unchanged outside it); one that
  // misses the grant is dropped.
  const tail: V2PermissionRule[] = [];
  const hostDenies: string[] = [];
  for (const rule of later) {
    if (rule.effect === 'deny') {
      if (!hostDenies.includes(rule.resource)) hostDenies.push(rule.resource);
      tail.push({
        action: grant.action,
        resource: rule.resource,
        effect: rule.effect,
      });
    } else if (rule.effect === 'allow') {
      if (
        resourcePatternCovers(rule.action, grant.action) &&
        resourceWithinGrant(rule.resource)
      )
        tail.push({
          action: grant.action,
          resource: rule.resource,
          effect: rule.effect,
        });
    } else if (resourceWithinGrant(rule.resource)) {
      tail.push({
        action: grant.action,
        resource: rule.resource,
        effect: rule.effect,
      });
    } else if (resourcePatternsOverlap(rule.resource, grant.resource)) {
      // The overlap is not always expressible as one pattern, so the whole
      // grant drops to ask (deny under a deny cover), and each earlier host
      // deny is re-asserted once so the widened ask cannot reopen a
      // host-denied path. A deny lying wholly inside the ask needs no
      // re-assertion: the host asks for all of it too. Paths in both a
      // re-asserted deny and the ask resolve to deny — stricter than the
      // host's ask, never looser.
      tail.push(
        {
          action: grant.action,
          resource: grant.resource,
          effect: stricterEffect('ask', effect),
        },
        ...hostDenies
          .filter((resource) => !globContains(rule.resource, resource))
          .map((resource) => ({
            action: grant.action,
            resource,
            effect: 'deny' as const,
          })),
      );
    }
  }
  // A denied grant only matters for the host's allow exceptions inside it.
  if (effect === 'deny' && !tail.some((rule) => rule.effect === 'allow'))
    return [];
  return [{ ...grant, effect }, ...tail];
}

/**
 * The deny-ceiling tail for one compiled child payload: denies replay
 * verbatim, grants are bounded by the host rules (boundGrantByHost).
 */
function buildChildTail(
  hostRules: readonly V2PermissionRule[],
  denyCeiling: readonly V2PermissionRule[],
): V2PermissionRule[] {
  return denyCeiling.flatMap((rule) =>
    rule.effect === 'deny' ? [{ ...rule }] : boundGrantByHost(hostRules, rule),
  );
}

/**
 * Whether `rules` already end with exactly `tail` (the deny-ceiling tail is
 * the literal suffix, so nothing follows it that a host could evaluate after
 * the ceiling). Used to keep the child-payload tail idempotent.
 */
function rulesEndWithTail(
  rules: readonly V2PermissionRule[],
  tail: readonly V2PermissionRule[],
): boolean {
  if (rules.length < tail.length) return false;
  const offset = rules.length - tail.length;
  return tail.every((rule, index) => {
    const existing = rules[offset + index];
    return (
      existing.action === rule.action &&
      existing.resource === rule.resource &&
      existing.effect === rule.effect
    );
  });
}

/**
 * Shared permission-finalization tail for one agent: adapts the finalized
 * permission map into the v2 baseline, adds the marketplace read safeguards
 * and the owner-read override, and compiles the native policy against the
 * package ceilings.
 *
 * Write-free and projection-free by design. The caller keeps the policy and
 * child-constraint map writes (keyed by canonical name vs display name), the
 * MCP expansion / marketplace projection that produces `permission`, and the
 * host-rule resolution. `sourcePermission` must be the PRISTINE permission the
 * package ceiling was authored against, never the projected map: the
 * projection carries a `'*': 'deny'` base that would silently rewrite the
 * owner-read effect. Non-marketplace callers pass empty capabilities, which
 * yields no ceilings, no read safeguards, and an unwrapped host rule set.
 */
function finalizeAgentPolicy(input: {
  readonly permission: Record<string, unknown>;
  readonly sourcePermission: Record<string, unknown>;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly mcps: readonly string[];
  readonly hostRules: readonly V2PermissionRule[];
  readonly packageMetadata: MarketplaceAgentMetadata | undefined;
}): {
  baselineRules: V2PermissionRule[];
  ceilings: PermissionCeilings | undefined;
  policy: ReturnType<typeof compilePermissionPolicy>;
} {
  const {
    permission,
    sourcePermission,
    tools,
    skills,
    mcps,
    hostRules,
    packageMetadata,
  } = input;
  const baselineRules = adaptPermissions(permission).filter(
    (rule): rule is V2PermissionRule =>
      rule.effect === 'allow' ||
      rule.effect === 'ask' ||
      rule.effect === 'deny',
  );
  const ownerReadRule: V2PermissionRule[] =
    packageMetadata &&
    Object.hasOwn(sourcePermission, 'read') &&
    permissionEffect(sourcePermission, 'read') !== 'allow'
      ? [
          {
            action: 'read',
            resource: '*',
            effect: permissionEffect(sourcePermission, 'read'),
          },
        ]
      : [];
  const baselineBeforeReadSafeguards = ownerReadRule.length
    ? baselineRules.filter((rule) => rule.action !== 'read')
    : baselineRules;
  const ceilings = packageMetadata
    ? marketplacePermissionCeilings(tools, skills, mcps)
    : undefined;
  return {
    baselineRules,
    ceilings,
    policy: compilePermissionPolicy({
      baselineRules: [
        // Marketplace policies open with the conservative external_directory
        // guard floor; the returned `baselineRules` (deny-ceiling source)
        // deliberately omits it.
        ...(ceilings ? EXTERNAL_DIRECTORY_GUARD_FLOOR : []),
        ...baselineBeforeReadSafeguards,
        ...marketplaceReadSafeguards(tools),
        ...ownerReadRule,
      ],
      // Keep host exceptions intact; the native policy compiler intersects
      // both axes with the package ceiling before applying them.
      hostRules,
      ...(ceilings ? { ceilings } : {}),
    }),
  };
}

function appendMarketplaceRouting(
  config: Record<string, unknown>,
  definitions: readonly AgentDefinition[],
  metadata: ReadonlyMap<string, MarketplaceAgentMetadata>,
  agentName = 'orchestrator',
): void {
  const routes = [...metadata.values()]
    .sort((left, right) => compareText(left.packageId, right.packageId))
    .map((entry) => {
      const definition = definitions.find(
        (candidate) => candidate.name === entry.runtimeName,
      );
      const runtimeName = definition?.displayName
        ? normalizeAgentName(definition.displayName)
        : entry.runtimeName;
      return `- @${runtimeName}`;
    });
  if (routes.length === 0) return;
  const target = config[agentName];
  if (!target || typeof target !== 'object') return;
  const promptConfig = target as Record<string, unknown>;
  if (typeof promptConfig.prompt !== 'string') return;
  const block = `<Marketplace agents>\n\n${routes.join('\n\n')}\n\n</Marketplace agents>`;
  if (promptConfig.prompt.includes(block)) return;
  promptConfig.prompt = `${promptConfig.prompt}\n\n${block}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resolvedPreset(runtime: RuntimeConfig) {
  // File presets already participate in RuntimeConfig.agents() and the
  // definitions. Only an explicit runtime selection is reapplied after host
  // merging, matching the historic config-hook precedence.
  const name = runtime.getRuntimePreset();
  if (!name || !runtime.plugin?.presets) return undefined;
  try {
    return resolvePreset(name, runtime.plugin.presets);
  } catch {
    return undefined;
  }
}

function presetForAgent(
  preset: ReturnType<typeof resolvePreset> | undefined,
  name: string,
) {
  if (!preset) return undefined;
  return lookupWithAliases(preset, name);
}

/**
 * Pass-local mirror of `RuntimeConfig.combinedModelInheritanceSource` over a
 * hoisted merged-override record: the `inheritModelFrom` source of an agent
 * whose configured model is a non-empty array chain, or undefined when its
 * model is fully static. The runtime getter stays authoritative everywhere
 * else; the registry's per-definition projection reads the pass-hoisted
 * record so `agents()` is not re-derived once per agent.
 */
function combinedModelInheritanceSource(
  overrides: Record<string, AgentOverrideConfig>,
  name: string,
): 'session' | 'orchestrator' | undefined {
  const override = lookupWithAliases(overrides, name);
  if (
    !Array.isArray(override?.model) ||
    override.model.length === 0 ||
    override.inheritModelFrom === undefined
  ) {
    return undefined;
  }
  return override.inheritModelFrom;
}

/** Finalize existing agents from the actual, pre-mutation host config. */
export function buildResolvedAgentRegistry(
  runtime: RuntimeConfig,
  options: RegistryBuildOptions,
): ResolvedAgentRegistry {
  const host = clone(options.hostSnapshot);
  const nativeRules = clone(options.nativePermissionsByAgent ?? {});
  // Populated when marketplace agents are constructed (before line-order
  // declarations below); owner overrides rewrite `_modelArray` on the
  // admitted definitions afterwards, so this pre-override snapshot is the
  // only copy of each package's own chain.
  const marketplaceManifestChains: Record<
    string,
    readonly { id: string; variant?: string }[]
  > = {};
  const marketplaceInferenceBase: Record<
    string,
    ResolvedAgentRegistry['marketplaceInferenceBase'][string]
  > = {};
  const hostFlavor = options.hostFlavor;
  const pluginMcps = clone(options.pluginMcps ?? {});
  // Pass-local derived inputs: the merged plugin-layer overrides and the
  // configured model arrays are pure derivations of the frozen plugin config
  // that cannot change during a single build, so every projection below
  // reads these hoisted copies instead of re-deriving per agent. The
  // marketplace-defaults flavor (`agents(marketplaceSkillDefaults)`) stays a
  // separate derivation for package capability folds.
  const runtimeAgentOverrides = runtime.agents();
  const modelArrays = runtime.modelArrays;
  let definitions = options.definitions
    ? clone(options.definitions)
    : createAgents(runtime, {
        projectDirectory: options.projectDirectory,
        hostFlavor: options.hostFlavor,
      });
  for (const definition of definitions) {
    const hostDisplayName = host.agent?.[definition.name]?.displayName;
    if (typeof hostDisplayName === 'string') {
      definition.displayName = hostDisplayName;
    }
  }
  const marketplaceMetadata = new Map<string, MarketplaceAgentMetadata>();
  let marketplaceSkillDefaults: Record<string, readonly string[]> = {};
  let marketplacePackages: MarketplaceLivePackage[] = [];
  let marketplaceRequiredSkills: MarketplaceSkillRequirements[] = [];
  if (options.marketplace?.selectedPackageIds.length) {
    const customOwnerNames = new Set(runtime.customAgentNames);
    const reservedAgentNames = new Set<string>([
      ...Object.keys(AGENT_ALIASES),
      ...Object.values(AGENT_ALIASES),
      ...definitions.flatMap((definition) => [
        ...(customOwnerNames.has(definition.name)
          ? []
          : [
              definition.name,
              ...(definition.displayName ? [definition.displayName] : []),
            ]),
      ]),
      ...Object.keys(runtime.acpAgents),
    ]);
    const mcpNames = new Set([
      ...Object.entries(host.mcp ?? {})
        .filter(([, config]) => isMcpEnabled(config))
        .map(([name]) => name),
      ...Object.keys(pluginMcps),
    ]);
    for (const disabled of runtime.disabledMcps) mcpNames.delete(disabled);
    const plan =
      options.marketplace.implementation.resolveMarketplaceActivation({
        selectedPackageIds: options.marketplace.selectedPackageIds,
        store: options.marketplace.store,
        pluginVersion: options.marketplace.pluginVersion,
        availableSkillNames: options.marketplace.availableSkillNames,
        availableMcpNames: [...mcpNames],
        disabledSkillNames: runtime.disabledSkills,
        disabledMcpNames: runtime.disabledMcps,
        reservedAgentNames,
      });
    marketplaceRequiredSkills = plan.agents.map((admission) => ({
      packageId: admission.packageId,
      skills: [...admission.requiredSkills],
    }));
    marketplacePackages = plan.agents.map((admission) => ({
      id: admission.packageId,
      runtimeName: admission.agentName,
      version: admission.version,
      digest: admission.digest,
      configFingerprint: '',
    }));
    const constructed =
      options.marketplace.implementation.createMarketplaceAgentDefinitions(
        plan,
      );
    marketplaceSkillDefaults = Object.fromEntries(
      constructed.metadata.map((metadata) => [
        metadata.runtimeName,
        metadata.capabilities.skills,
      ]),
    );
    const admittedNames = new Set(
      constructed.agents.map((agent) => agent.name),
    );
    // A config key matching an admitted marketplace agent is an owner
    // override; the package definition replaces the custom one, so
    // `primary` cannot apply (marketplace agents are never primary, #1591).
    const ownerAgents = runtime.agents();
    for (const name of admittedNames) {
      if (
        customOwnerNames.has(name) &&
        ownerAgents[name]?.primary !== undefined
      ) {
        console.warn(
          `[oh-my-opencode-slim] agents.${name}.primary is ignored: '${name}' is a marketplace agent and marketplace agents cannot be primary.`,
        );
      }
    }
    // Snapshot the manifest chains BEFORE owner overrides rewrite
    // `_modelArray` on the admitted definitions (see
    // applyMarketplaceOwnerOverride) — the merged modelCandidates cannot
    // serve a refresh that removes an override.
    const sessionInherited = new Set(
      plan.agents
        .filter(({ manifest }) => manifest.model.source === 'session')
        .map(({ agentName }) => agentName),
    );
    const modelSources = new Map(
      plan.agents.flatMap(({ agentName, manifest }) => {
        const source =
          manifest.model.source === 'orchestrator'
            ? 'orchestrator'
            : manifest.model.source === 'builtin'
              ? manifest.extends?.builtin
              : undefined;
        return source ? [[agentName, source] as const] : [];
      }),
    );
    for (const sourceAgent of constructed.agents) {
      const config = sourceAgent.config;
      marketplaceInferenceBase[sourceAgent.name] = {
        ...(modelSources.has(sourceAgent.name)
          ? { modelFrom: modelSources.get(sourceAgent.name) }
          : {}),
        ...(typeof config.model === 'string' ? { model: config.model } : {}),
        ...(typeof config.variant === 'string'
          ? { variant: config.variant }
          : {}),
        ...(typeof config.temperature === 'number'
          ? { temperature: config.temperature }
          : {}),
        ...(config.options ? { options: clone(config.options) } : {}),
        ...(sessionInherited.has(sourceAgent.name)
          ? { inheritModelFrom: 'session' as const }
          : {}),
      };
      const manifest = sourceAgent._modelArray;
      marketplaceManifestChains[sourceAgent.name] = (manifest ?? []).map(
        (entry) => (typeof entry === 'string' ? { id: entry } : { ...entry }),
      );
    }
    const marketplaceAgents = constructed.agents.map((sourceAgent) => {
      const agent = clone(sourceAgent);
      const owner = runtimeAgentOverrides[agent.name];
      const hostOwner = host.agent?.[agent.name];
      const displayName =
        (typeof hostOwner?.displayName === 'string'
          ? hostOwner.displayName
          : undefined) ??
        (typeof owner?.displayName === 'string'
          ? owner.displayName
          : undefined);
      applyMarketplaceOwnerOverride(agent, owner);
      const prompts = loadAgentPrompt(agent.name, {
        preset: runtime.preset,
        projectDirectory: options.projectDirectory,
        hostFlavor: options.hostFlavor,
      });
      agent.config.prompt = resolvePrompt(
        agent.name,
        owner?.prompt,
        prompts.prompt,
        sourceAgent.config.prompt ?? '',
        prompts.appendPrompt,
      );
      if (displayName) agent.displayName = displayName;
      return agent;
    });
    const reservedIdentityEntries: Array<{ name: string; owner?: string }> = [
      ...[...Object.keys(AGENT_ALIASES), ...Object.values(AGENT_ALIASES)].map(
        (name) => ({ name }),
      ),
      ...definitions.flatMap((definition) => [
        {
          name: definition.name,
          owner: customOwnerNames.has(definition.name)
            ? definition.name
            : undefined,
        },
        ...(definition.displayName
          ? [
              {
                name: definition.displayName,
                owner: definition.name,
              },
            ]
          : []),
      ]),
      ...Object.keys(runtime.acpAgents).map((name) => ({ name })),
      ...Object.entries(host.agent ?? {}).flatMap(([name, config]) => {
        // Only the actual configured custom-agent key establishes package
        // ownership. A displayName collision never transfers ownership to a
        // different host key (e.g. host key `PackageAlias`).
        const owner = customOwnerNames.has(name) ? name : undefined;
        return [
          { name, owner },
          ...(typeof config.displayName === 'string'
            ? [{ name: config.displayName, owner }]
            : []),
        ];
      }),
    ];
    const reservedIdentities = reservedIdentityEntries.map(
      ({ name, owner }) => ({
        name: normalizeAgentName(name).toLowerCase(),
        owner,
      }),
    );
    const packageIdentities = new Set<string>();
    for (const agent of marketplaceAgents) {
      const identities = [agent.name, agent.displayName]
        .filter((name): name is string => Boolean(name))
        .map((name) => normalizeAgentName(name).toLowerCase());
      for (const identity of identities) {
        if (
          reservedIdentities.some(
            (reserved) =>
              reserved.name === identity && reserved.owner !== agent.name,
          ) ||
          packageIdentities.has(identity)
        ) {
          throw new Error(
            `Marketplace agent identity '${identity}' collides with a reserved agent identity`,
          );
        }
      }
      identities.forEach((identity) => {
        packageIdentities.add(identity);
      });
    }
    constructed.metadata.forEach((metadata) => {
      marketplaceMetadata.set(metadata.runtimeName, {
        ...metadata,
        capabilities: {
          ...metadata.capabilities,
          mcps: metadata.capabilities.mcps.filter((name) => mcpNames.has(name)),
        },
      });
    });
    definitions = [
      ...definitions.filter(
        (definition) =>
          !(
            customOwnerNames.has(definition.name) &&
            admittedNames.has(definition.name)
          ),
      ),
      ...marketplaceAgents,
    ];
  }
  const baseline = getAgentConfigsFromDefinitions(runtime, definitions);
  const sdk = clone(baseline) as Record<
    string,
    SDKAgentConfig & Record<string, unknown>
  >;
  const candidateMap: Record<string, { id: string; variant?: string }[]> = {};
  const effective: Record<string, { model?: string; variant?: string }> = {};
  const tuiModels: Record<string, string> = {};
  const tuiVariants: Record<string, string> = {};
  const identities: Record<string, string> = {};
  const policyMap: Record<
    string,
    ReturnType<typeof compilePermissionPolicy>
  > = {};
  const childPolicyConstraints: Record<string, PermissionCeilings | undefined> =
    {};
  const childDenyCeilings: Record<string, V2PermissionRule[]> = {};

  // User/host entries win over plugin-injected built-ins on a key
  // collision (issue #1290).
  const mcpConfig = { ...pluginMcps, ...(host.mcp ?? {}) };
  const availableMcpNames = Object.keys(mcpConfig);
  const selectableMcpNames = availableMcpNames.filter(
    (name) =>
      isMcpEnabled(mcpConfig[name]) && !runtime.disabledMcps.includes(name),
  );
  const configuredAgents = runtime.agents(marketplaceSkillDefaults);
  const preset = resolvedPreset(runtime);
  const overrideFor = (name: string) =>
    lookupWithAliases(runtimeAgentOverrides, name);
  const hostEntries = host.agent ?? {};
  const finalAgentConfig: Record<string, unknown> = clone(hostEntries);

  for (const definition of definitions) {
    const name = definition.name;
    const displayName = definition.displayName
      ? normalizeAgentName(definition.displayName)
      : name;
    // Host-config boundary: resolve host overrides by canonical name,
    // explicit displayName, then pre-rename plugin names (e.g. host
    // `agent.librarian` feeds the merged `explorer`). Host-native alias
    // namespaces (e.g. host `explore`) belong to the host's native agent
    // namespace and must never map onto the plugin agent. Plugin-own alias
    // support (runtime overrides, presets, identity mirroring) is handled
    // separately.
    const hostEntry =
      hostEntries[name] ??
      hostEntries[displayName] ??
      hostLegacyAgent(hostEntries, name);
    const entry = sdk[name] as
      | (SDKAgentConfig & Record<string, unknown>)
      | undefined;
    if (!entry) throw new Error(`Missing SDK projection for agent '${name}'`);
    const configuredScalarModel =
      typeof entry.model === 'string' ? entry.model : undefined;
    const configuredScalarVariant =
      typeof entry.variant === 'string' ? entry.variant : undefined;
    if (hostEntry) {
      // Capture the factory stance first: Object.assign replaces
      // `permission` wholesale, and a user map without a `task` key would
      // otherwise silently drop the agent's nested-dispatch stance.
      const factoryTask = (
        entry.permission as Record<string, unknown> | undefined
      )?.task;
      Object.assign(entry, clone(hostEntry));
      entry.permission = mergeTaskStance(entry.permission, {
        task: factoryTask,
      });
    }

    const configured = modelArrays[name] ?? definition._modelArray ?? [];
    if (configured.length === 0 && configuredScalarModel) {
      candidateMap[name] = [
        {
          id: configuredScalarModel,
          ...(configuredScalarVariant
            ? { variant: configuredScalarVariant }
            : {}),
        },
      ];
    } else candidateMap[name] = clone(configured);
    const hostModel =
      typeof hostEntry?.model === 'string' ? hostEntry.model : undefined;
    if (
      hostModel &&
      configured[0]?.id &&
      hostModel !== configured[0].id &&
      combinedModelInheritanceSource(runtimeAgentOverrides, name) === undefined
    ) {
      options.onHostModelSelected?.(name);
    }
    if (configured.length > 0 && entry.model === undefined) {
      entry.model = configured[0].id;
      if (configured[0].variant) entry.variant = configured[0].variant;
    }

    const override = presetForAgent(preset, name);
    if (override) {
      if (typeof override.model === 'string') entry.model = override.model;
      else if (Array.isArray(override.model) && override.model.length > 0) {
        const first = override.model[0];
        entry.model = typeof first === 'string' ? first : first.id;
        if (typeof first !== 'string' && first.variant)
          entry.variant = first.variant;
      }
      if (typeof override.variant === 'string')
        entry.variant = override.variant;
      else if ('variant' in override) delete entry.variant;
      if (typeof override.temperature === 'number')
        entry.temperature = override.temperature;
      else if ('temperature' in override) delete entry.temperature;
      if (
        override.options &&
        typeof override.options === 'object' &&
        !Array.isArray(override.options)
      )
        entry.options = clone(override.options);
      else if ('options' in override) delete entry.options;
    }
    const packageMetadata = marketplaceMetadata.get(name);
    if (packageMetadata?.modelPolicy.source === 'orchestrator') {
      const orchestratorDefinition = definitions.find(
        (candidate) => candidate.name === 'orchestrator',
      );
      const visibleName = orchestratorDefinition?.displayName
        ? normalizeAgentName(orchestratorDefinition.displayName)
        : 'orchestrator';
      const orchestratorConfig =
        (hostEntries[visibleName] as Record<string, unknown> | undefined) ??
        (finalAgentConfig.orchestrator as Record<string, unknown> | undefined);
      const canonicalOrchestrator = finalAgentConfig.orchestrator as
        | Record<string, unknown>
        | undefined;
      if (typeof entry.model !== 'string') {
        if (typeof orchestratorConfig?.model === 'string') {
          entry.model = orchestratorConfig.model;
        } else if (typeof canonicalOrchestrator?.model === 'string') {
          entry.model = canonicalOrchestrator.model;
        } else if (candidateMap.orchestrator?.[0]) {
          entry.model = candidateMap.orchestrator[0].id;
        }
      }
      if (
        typeof entry.variant !== 'string' &&
        typeof orchestratorConfig?.variant === 'string'
      ) {
        entry.variant = orchestratorConfig.variant;
      } else if (
        typeof entry.variant !== 'string' &&
        typeof canonicalOrchestrator?.variant === 'string'
      ) {
        entry.variant = canonicalOrchestrator.variant;
      } else if (
        typeof entry.variant !== 'string' &&
        candidateMap.orchestrator?.[0]?.variant
      ) {
        entry.variant = candidateMap.orchestrator[0].variant;
      }
      if (typeof entry.model !== 'string') {
        delete entry.model;
        delete entry.variant;
      }
    } else if (packageMetadata?.modelPolicy.source === 'builtin') {
      if (!packageMetadata.extension) {
        throw new Error(
          `Marketplace agent '${name}' declares builtin model policy without a builtin role`,
        );
      }
      const roleName = packageMetadata.extension.builtin;
      const roleConfig = finalAgentConfig[roleName] as
        | Record<string, unknown>
        | undefined;
      const roleDefinition = definitions.find(
        (candidate) => candidate.name === roleName,
      );
      const roleVisibleName = roleDefinition?.displayName
        ? normalizeAgentName(roleDefinition.displayName)
        : roleName;
      const visibleRoleConfig = hostEntries[roleVisibleName] as
        | Record<string, unknown>
        | undefined;
      if (typeof entry.model !== 'string') {
        if (typeof visibleRoleConfig?.model === 'string') {
          entry.model = visibleRoleConfig.model;
        } else if (typeof roleConfig?.model === 'string')
          entry.model = roleConfig.model;
        else if (candidateMap[roleName]?.[0]) {
          entry.model = candidateMap[roleName][0].id;
        }
      }
      const roleVariant =
        typeof visibleRoleConfig?.variant === 'string'
          ? visibleRoleConfig.variant
          : typeof roleConfig?.variant === 'string'
            ? roleConfig.variant
            : candidateMap[roleName]?.[0]?.variant;
      if (
        typeof entry.variant !== 'string' &&
        typeof roleVariant === 'string'
      ) {
        entry.variant = roleVariant;
      }
      if (typeof entry.model !== 'string') {
        delete entry.model;
        delete entry.variant;
      }
    }
    finalAgentConfig[name] = entry;
  }

  appendMarketplaceRouting(finalAgentConfig, definitions, marketplaceMetadata);

  applyModelInheritanceToConfig(
    finalAgentConfig,
    runtime,
    runtimeAgentOverrides,
  );

  for (const definition of definitions) {
    const name = definition.name;
    const displayName = definition.displayName
      ? normalizeAgentName(definition.displayName)
      : name;
    const entry = finalAgentConfig[name] as Record<string, unknown>;
    const modelOverride = overrideFor(name);
    const followsSessionWithoutScalar =
      modelOverride?.inheritModelFrom === 'session' &&
      (modelOverride.model === undefined || Array.isArray(modelOverride.model));
    if (followsSessionWithoutScalar) {
      if (modelOverride.variant === undefined) delete entry.variant;
    }
    if (typeof entry.prompt === 'string') {
      // Host council prompt replaces the generated content; retain the
      // required exception and report structure via the idempotent
      // fallback reinforcement.
      if (name === 'council')
        entry.prompt = ensureCouncilCompactionException(
          ensureCouncilSynthesisReinforcement(entry.prompt),
        );
    }
    const effectiveModel =
      typeof entry.model === 'string' ? entry.model : undefined;
    const effectiveVariant =
      typeof entry.variant === 'string' ? entry.variant : undefined;
    effective[name] = {
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(effectiveVariant ? { variant: effectiveVariant } : {}),
    };
    const followsSession =
      modelOverride?.inheritModelFrom === 'session' &&
      (modelOverride.model === undefined || Array.isArray(modelOverride.model));
    const displayModel = followsSession
      ? undefined
      : (effectiveModel ??
        candidateMap[name]?.[0]?.id ??
        (typeof definition.config.model === 'string'
          ? definition.config.model
          : undefined));
    tuiModels[name] = displayModel ?? 'default';
    if (effectiveVariant) tuiVariants[name] = effectiveVariant;
    identities[name] = displayName;
  }

  applyOrchestratorModelConfig({
    agents: finalAgentConfig,
    enabled: runtime.stripOrchestratorModel,
    presets: runtime.plugin?.presets,
    configPreset: runtime.preset,
    runtimePreset: runtime.getRuntimePreset(),
  });
  for (const definition of definitions) {
    const finalized = finalAgentConfig[definition.name];
    if (finalized) {
      sdk[definition.name] = clone(finalized) as SDKAgentConfig &
        Record<string, unknown>;
    }
  }

  for (const definition of definitions) {
    const name = definition.name;
    const finalEntry = finalAgentConfig[name] as Record<string, unknown>;
    const packageMetadata = marketplaceMetadata.get(name);
    let permission = normalizePermission(finalEntry.permission);
    const sourcePermission = clone(permission);
    const agentMcps = (sdk[name] as { mcps?: string[] }).mcps ?? [];
    if (!packageMetadata) {
      for (const mcpName of availableMcpNames) {
        const permissionKey = `${mcpName.replace(/[^a-zA-Z0-9_-]/g, '_')}_*`;
        if (!(permissionKey in permission)) {
          permission[permissionKey] = parseList(
            agentMcps,
            availableMcpNames,
          ).includes(mcpName)
            ? 'allow'
            : 'deny';
        }
      }
    }
    // Finalized package capabilities (empty for non-marketplace agents); they
    // feed the marketplace metadata, the projected permission map, and the
    // policy ceilings below.
    let packageTools: readonly string[] = [];
    let packageSkills: readonly string[] = [];
    let packageMcps: readonly string[] = [];
    if (packageMetadata) {
      const requestedTools = finalEntry.tools as
        | Record<string, boolean>
        | undefined;
      packageTools = packageMetadata.capabilities.tools.filter(
        (tool) => requestedTools?.[tool] !== false,
      );
      packageSkills = [
        ...(configuredAgents[name]?.skills ??
          packageMetadata.capabilities.skills),
        ...runtime.disabledSkills.map((skill) => `!${skill}`),
      ];
      const requestedMcps =
        configuredAgents[name]?.mcps ?? packageMetadata.capabilities.mcps;
      const selectableMcpSet = new Set(selectableMcpNames);
      packageMcps = parseList(requestedMcps, selectableMcpNames).filter(
        // A `*` expansion must not brick the registry over an MCP the user
        // never named: drop wildcard-only picks with ambiguous namespaces
        // (fail closed). Explicitly named ones still throw below.
        (mcp) =>
          requestedMcps.includes(mcp) ||
          ambiguousMcpNamespaces([mcp], selectableMcpSet).length === 0,
      );
      const displayHostName = definition.displayName
        ? normalizeAgentName(definition.displayName)
        : name;
      const hostMcps =
        hostEntries[name]?.mcps ?? hostEntries[displayHostName]?.mcps;
      if (Array.isArray(hostMcps)) {
        packageMcps = narrowCapabilities(packageMcps, hostMcps as string[]);
      }
      const ambiguous = ambiguousMcpNamespaces(packageMcps, selectableMcpSet);
      if (ambiguous.length > 0) {
        throw new Error(
          `Marketplace agent '${name}' has ambiguous MCP namespaces: ` +
            ambiguous.join(', '),
        );
      }
      marketplaceMetadata.set(name, {
        ...packageMetadata,
        capabilities: {
          ...packageMetadata.capabilities,
          tools: packageTools,
          skills: packageSkills,
          mcps: packageMcps,
        },
      });
      finalEntry.tools = Object.fromEntries(
        packageTools.map((tool) => [tool, true]),
      );
      finalEntry.mcps = packageMcps;
      permission = projectMarketplacePermission(
        sourcePermission,
        packageTools,
        packageSkills,
        packageMcps,
        availableMcpNames,
      );
    }
    finalEntry.permission = permission;
    const visibleNativeRules = definition.displayName
      ? Object.entries(nativeRules).find(
          ([agentName]) =>
            normalizeAgentName(agentName).toLowerCase() ===
            normalizeAgentName(definition.displayName as string).toLowerCase(),
        )?.[1]
      : undefined;
    // Same host-config boundary as above: host native rules keyed by a
    // legacy alias (e.g. `explore`) must not apply to the plugin agent.
    const hostRuleSet = nativeRules[name] ?? visibleNativeRules ?? [];
    const { baselineRules, ceilings, policy } = finalizeAgentPolicy({
      permission,
      sourcePermission,
      tools: packageTools,
      skills: packageSkills,
      mcps: packageMcps,
      hostRules: hostRuleSet,
      packageMetadata,
    });
    childPolicyConstraints[name] = ceilings;
    policyMap[name] = policy;
    childDenyCeilings[name] = denyCeilingTail(baselineRules);
    finalAgentConfig[name] = clone(finalEntry);
    sdk[name] = clone(finalEntry) as SDKAgentConfig & Record<string, unknown>;
  }

  for (const [alias, canonical] of Object.entries(AGENT_ALIASES)) {
    if (!finalAgentConfig[canonical]) continue;
    identities[alias] = identities[canonical] ?? canonical;
    candidateMap[alias] = clone(candidateMap[canonical] ?? []);
    effective[alias] = clone(effective[canonical] ?? {});
    if (policyMap[canonical]) policyMap[alias] = policyMap[canonical];
    if (Object.hasOwn(childPolicyConstraints, canonical))
      childPolicyConstraints[alias] = childPolicyConstraints[canonical];
    if (childDenyCeilings[canonical])
      childDenyCeilings[alias] = childDenyCeilings[canonical];
  }
  for (const definition of definitions) {
    const display = identities[definition.name];
    if (display && display !== definition.name) {
      const canonicalConfig = finalAgentConfig[definition.name] as Record<
        string,
        unknown
      >;
      const aliasHost = hostEntries[display];
      identities[display] = display;
      const visibleConfig: Record<string, unknown> = {
        ...clone(canonicalConfig),
        ...(aliasHost ? clone(aliasHost) : {}),
        permission: {
          ...normalizePermission(canonicalConfig.permission),
          ...normalizePermission(aliasHost?.permission),
        },
      };
      const modelOverride = overrideFor(definition.name);
      const visibleFollowsSessionWithoutScalar =
        modelOverride?.inheritModelFrom === 'session' &&
        (modelOverride.model === undefined ||
          Array.isArray(modelOverride.model));
      if (visibleFollowsSessionWithoutScalar) {
        delete visibleConfig.model;
        if (modelOverride.variant === undefined) delete visibleConfig.variant;
      }
      if (!aliasHost || !('hidden' in aliasHost)) delete visibleConfig.hidden;
      if (
        definition.name === 'council' &&
        typeof visibleConfig.prompt === 'string'
      ) {
        visibleConfig.prompt = ensureCouncilCompactionException(
          ensureCouncilSynthesisReinforcement(visibleConfig.prompt),
        );
      }
      let visiblePermission = normalizePermission(visibleConfig.permission);
      const visibleMcps = (visibleConfig.mcps as string[] | undefined) ?? [];
      for (const mcpName of availableMcpNames) {
        const permissionKey = `${mcpName.replace(/[^a-zA-Z0-9_-]/g, '_')}_*`;
        if (!(permissionKey in visiblePermission)) {
          visiblePermission[permissionKey] = parseList(
            visibleMcps,
            availableMcpNames,
          ).includes(mcpName)
            ? 'allow'
            : 'deny';
        }
      }
      const packageMetadata = marketplaceMetadata.get(definition.name);
      const sourceVisiblePermission = {
        ...normalizePermission(
          hostEntries[definition.name]?.permission ??
            hostEntries[identities[definition.name] ?? definition.name]
              ?.permission ??
            definition.config.permission,
        ),
        ...normalizePermission(aliasHost?.permission),
      };
      const visibleTools = packageMetadata
        ? packageMetadata.capabilities.tools.filter(
            (tool) =>
              (visibleConfig.tools as Record<string, boolean> | undefined)?.[
                tool
              ] !== false,
          )
        : [];
      const visibleSkills = packageMetadata
        ? packageMetadata.capabilities.skills
        : [];
      let cappedMcps = packageMetadata
        ? packageMetadata.capabilities.mcps
        : visibleMcps;
      if (packageMetadata && Array.isArray(aliasHost?.mcps)) {
        cappedMcps = narrowCapabilities(cappedMcps, aliasHost.mcps as string[]);
      }
      if (packageMetadata) {
        marketplaceMetadata.set(definition.name, {
          ...packageMetadata,
          capabilities: {
            ...packageMetadata.capabilities,
            tools: visibleTools,
            skills: visibleSkills,
            mcps: cappedMcps,
          },
        });
        visibleConfig.tools = Object.fromEntries(
          visibleTools.map((tool) => [tool, true]),
        );
        visibleConfig.mcps = cappedMcps;
        visiblePermission = projectMarketplacePermission(
          visiblePermission,
          visibleTools,
          visibleSkills,
          cappedMcps,
          availableMcpNames,
        );
      }
      visibleConfig.permission = visiblePermission;
      finalAgentConfig[display] = visibleConfig;
      sdk[display] = clone(visibleConfig) as SDKAgentConfig &
        Record<string, unknown>;
      if (!aliasHost || !('hidden' in aliasHost)) {
        delete (sdk[display] as Record<string, unknown>).hidden;
      }
      candidateMap[display] = clone(candidateMap[definition.name] ?? []);
      const visibleModel =
        typeof visibleConfig.model === 'string'
          ? visibleConfig.model
          : undefined;
      const visibleVariant =
        typeof visibleConfig.variant === 'string'
          ? visibleConfig.variant
          : undefined;
      effective[display] = {
        ...(visibleModel ? { model: visibleModel } : {}),
        ...(visibleVariant ? { variant: visibleVariant } : {}),
      };
      const visibleRules =
        nativeRules[display] ?? nativeRules[definition.name] ?? [];
      const { baselineRules, ceilings, policy } = finalizeAgentPolicy({
        permission: visiblePermission,
        sourcePermission: sourceVisiblePermission,
        tools: visibleTools,
        skills: visibleSkills,
        mcps: cappedMcps,
        hostRules: visibleRules,
        packageMetadata,
      });
      childPolicyConstraints[display] = ceilings;
      policyMap[display] = policy;
      childDenyCeilings[display] = denyCeilingTail(baselineRules);
      if (definition.name === 'orchestrator') {
        appendMarketplaceRouting(
          { orchestrator: visibleConfig },
          definitions,
          marketplaceMetadata,
        );
      }
    }
  }

  const ownedSdk = freeze(clone(sdk));
  const frozenFinal = freeze(clone(finalAgentConfig));
  const frozenCandidates = freeze(clone(candidateMap));
  const frozenEffective = freeze(clone(effective));
  const frozenTuiModels = freeze(clone(tuiModels));
  const frozenTuiVariants = freeze(clone(tuiVariants));
  const frozenIdentities = freeze(clone(identities));
  const frozenPolicies = Object.freeze({ ...policyMap });
  const frozenChildConstraints = freeze(clone(childPolicyConstraints));
  const frozenDenyCeilings = freeze(clone(childDenyCeilings));
  const frozenMcps = freeze(clone(mcpConfig));
  const frozenPluginMcps = freeze(clone(pluginMcps));
  const managedAgentConfig: Record<string, unknown> = {};
  for (const definition of definitions) {
    const display = identities[definition.name] ?? definition.name;
    for (const key of new Set([definition.name, display])) {
      if (finalAgentConfig[key] !== undefined) {
        managedAgentConfig[key] = clone(finalAgentConfig[key]);
      }
    }
  }
  const frozenManagedAgents = freeze(managedAgentConfig);
  const frozenMarketplacePackages = marketplacePackages.map((item) => {
    const visibleName = identities[item.runtimeName];
    return {
      ...item,
      configFingerprint: marketplaceConfigFingerprint({
        id: item.id,
        runtimeName: item.runtimeName,
        identity: visibleName,
        canonicalConfig: finalAgentConfig[item.runtimeName],
        visibleConfig:
          visibleName && visibleName !== item.runtimeName
            ? finalAgentConfig[visibleName]
            : undefined,
        canonicalPolicy: policyMap[item.runtimeName],
        visiblePolicy:
          visibleName && visibleName !== item.runtimeName
            ? policyMap[visibleName]
            : undefined,
        canonicalModelCandidates: candidateMap[item.runtimeName],
        visibleModelCandidates:
          visibleName && visibleName !== item.runtimeName
            ? candidateMap[visibleName]
            : undefined,
      }),
    };
  });
  return Object.freeze({
    hostFlavor,
    agentNames: Object.freeze(definitions.map((definition) => definition.name)),
    marketplaceAgentNames: Object.freeze([...marketplaceMetadata.keys()]),
    marketplacePackages: freeze(clone(frozenMarketplacePackages)),
    marketplaceRequiredSkills: freeze(clone(marketplaceRequiredSkills)),
    identities: frozenIdentities,
    modelCandidates: frozenCandidates,
    marketplaceManifestChains: freeze(marketplaceManifestChains),
    marketplaceInferenceBase: freeze(marketplaceInferenceBase),
    effectiveStartupModels: frozenEffective,
    tuiAgentModels: frozenTuiModels,
    tuiAgentVariants: frozenTuiVariants,
    nativePolicies: frozenPolicies,
    compileChildPermissions: (
      agent: string,
      rules: readonly V2PermissionRule[],
    ) => {
      const constraints = frozenChildConstraints[agent];
      // Presence, not truthiness: a plain (non-marketplace) agent is stored as
      // an explicit `undefined` ceiling — it has no package ceiling, but its
      // child payload still compiles from the host rules alone.
      if (!Object.hasOwn(frozenChildConstraints, agent)) {
        throw new Error(
          `child permission constraints unavailable for '${agent}'`,
        );
      }
      const policy = compilePermissionPolicy({
        // Marketplace child payloads open with the same conservative
        // external_directory guard floor as the registered policy, so the
        // ceiling's default-effect allow can never synthesize a grant for a
        // child payload that never declared the guard. Non-marketplace agents
        // have no ceilings and keep the untouched host-rule pass-through.
        baselineRules: constraints ? EXTERNAL_DIRECTORY_GUARD_FLOOR : [],
        hostRules: rules,
        ...(constraints ? { ceilings: constraints } : {}),
      });
      const compiled = policy.rules;
      // The host appends the user's global (and per-agent) config rules AFTER
      // the plugin's agent permissions (#1374), and v2 evaluates with
      // findLast (last matching rule wins). A trailing `{'*','*',allow}` from
      // the user's global config therefore defeats the plugin's declared
      // denies stored earlier in the payload. One mechanism, two verified
      // production incidents: stance-carrying children (explorer→explorer,
      // observer→observer, oracle→explorer) spawned nested subagents despite
      // an explicit `subagent/*:deny`, and a read-only child (explorer)
      // completed edit/write despite the factory read-only matrix. Re-append
      // the agent's DECLARATIVE DENY CEILING as the FINAL rules of every
      // compiled plugin child payload so findLast always terminates on it.
      // Derived from the same registered permission map the static policy was
      // compiled from — never hardcoded per agent; empty for agents without
      // declarations (the orchestrator), whose payloads pass through
      // untouched. Idempotent: a payload that already ends with the tail is
      // not duplicated.
      //
      // A deny tail is a monotone ceiling — appending it can only narrow what
      // the host granted, so it is always safe; wildcard-action denies stay
      // out because replaying the default floor last would erase the declared
      // allow exceptions behind it, and each replayed deny rides with those
      // declared exceptions (including exact actions under namespace denies).
      // Ask rules never enter either: an appended
      // ask parks a background child on input no one can answer. An ALLOW tail
      // is a capability grant: appended last it would silently outrank a
      // stricter host decision (deny/ask) for the same target — the guest
      // plugin resurrecting a capability the user explicitly withheld. So each
      // grant is emitted at meet(grant, host-effective): allow stays allow,
      // ask is preserved, and deny is dropped (the deny ceiling already covers
      // it). The meet runs over every resource the grant's pattern matches,
      // not the pattern string alone: narrower host denies/asks inside the
      // grant are re-appended after it (boundGrantByHost), so a broad replayed
      // allow can never reopen a host-protected subpath.
      // Marketplace directory guards follow finalized host order, including
      // overrides of explicit owner denies. Replaying those denies here would
      // make child policies disagree with the registered policy. Keep the
      // declarative ceilings for tool, Skill, and MCP capabilities unchanged.
      const denyCeiling = constraints
        ? frozenDenyCeilings[agent]?.filter(
            (rule) => rule.action !== 'external_directory',
          )
        : frozenDenyCeilings[agent];
      if (!denyCeiling || denyCeiling.length === 0) return compiled;
      // Idempotent: a payload that already ends with the tail built from its
      // own prefix is returned unchanged. Every tail opens with the
      // ceiling's first deny verbatim, so only those positions can start it.
      const first = denyCeiling[0];
      for (let start = compiled.length - 1; start >= 0; start -= 1) {
        const rule = compiled[start];
        if (
          rule.action !== first.action ||
          rule.resource !== first.resource ||
          rule.effect !== first.effect
        )
          continue;
        const prefixTail = buildChildTail(
          compiled.slice(0, start),
          denyCeiling,
        );
        if (
          prefixTail.length === compiled.length - start &&
          rulesEndWithTail(compiled, prefixTail)
        )
          return compiled;
      }
      return [...compiled, ...buildChildTail(compiled, denyCeiling)];
    },
    mcpConfig: frozenMcps,
    managedMcpConfig: frozenPluginMcps,
    finalAgentConfig: frozenFinal,
    managedAgentConfig: frozenManagedAgents,
    getSdkAgentProjection: () => clone(ownedSdk),
  });
}
