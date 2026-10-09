import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk/v2';
import { AGENT_ALIASES } from '../config';
import { parseList } from '../config/agent-mcps';
import { resolvePreset } from '../config/presets';
import type { HostConfigSnapshot, RuntimeConfig } from '../config/runtime';
import { applyOrchestratorModelConfig } from '../config/strip-orchestrator-model';
import type { MarketplaceActivationStore } from '../marketplace/activation';
import { resolveMarketplaceActivation } from '../marketplace/activation';
import {
  createMarketplaceAgentDefinitions,
  type MarketplaceAgentMetadata,
} from '../marketplace/agent-definitions';
import { marketplaceConfigFingerprint } from '../marketplace/config-identity';
import { MARKETPLACE_TOOL_NAMES } from '../marketplace/schemas';
import { normalizeAgentName } from '../utils/agent-variant';
import { adaptPermissions } from '../v2/adapters';
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
import type { AgentDefinition } from './orchestrator';
import { mergeTaskStance } from './permissions';

export interface ResolvedAgentRegistry {
  readonly hostFlavor: string | undefined;
  readonly agentNames: readonly string[];
  readonly marketplaceAgentNames: readonly string[];
  readonly marketplacePackages: readonly MarketplaceLivePackage[];
  readonly identities: Readonly<Record<string, string>>;
  readonly modelCandidates: Readonly<
    Record<string, readonly { id: string; variant?: string }[]>
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
   * replaying the pre-host-finalization permission baseline. */
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
    readonly selectedPackageIds: readonly string[];
    readonly store: MarketplaceActivationStore;
    readonly pluginVersion: string;
    readonly availableSkillNames: readonly string[];
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
    const merged = clone(override.permission);
    // A permission override replaces the whole map; keep the agent's
    // nested-dispatch stance when the override doesn't address `task`,
    // otherwise the override would silently strip it. String shorthands
    // stay untouched — they are an explicit take-over of every tool.
    if (
      merged !== null &&
      typeof merged === 'object' &&
      !Array.isArray(merged) &&
      (merged as Record<string, unknown>).task === undefined
    ) {
      const stance = (
        definition.config.permission as Record<string, unknown> | undefined
      )?.task;
      if (stance !== undefined) {
        (merged as Record<string, unknown>).task = clone(stance);
      }
    }
    definition.config.permission = merged;
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
  const existingSkills = existing.skill;
  const skillPermissions: Record<string, unknown> = { '*': 'deny' };
  for (const skill of skills) {
    skillPermissions[skill] =
      existingSkills === undefined
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

function marketplacePermissionCeilings(
  tools: readonly string[],
  skills: readonly string[],
  mcps: readonly string[],
): PermissionCeilings {
  const actions: Record<string, 'allow' | 'deny'> = {};
  for (const tool of tools) {
    if (tool === 'bash') {
      actions.execute = 'allow';
      actions.bash = 'allow';
    } else if ((MARKETPLACE_TOOL_NAMES as readonly string[]).includes(tool)) {
      actions[tool] = 'allow';
    }
  }
  actions.skill = skills.length > 0 ? 'allow' : 'deny';
  const namespaces = mcps.map(
    (name) => `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}_*`,
  );
  return {
    defaultEffect: 'allow',
    actions,
    namespaces,
    namespaceEffects: Object.fromEntries(
      namespaces.map((namespace) => [namespace, 'allow']),
    ),
    ...(skills.length
      ? {
          resources: {
            skill: {
              '*': 'deny',
              ...Object.fromEntries(skills.map((skill) => [skill, 'allow'])),
            },
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

function marketplaceHostRules(
  rules: readonly V2PermissionRule[],
): V2PermissionRule[] {
  // Keep host exceptions intact; the native policy compiler intersects both
  // axes with the package ceiling before applying them.
  return [...rules];
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
  const alias = Object.keys(AGENT_ALIASES).find(
    (key) => AGENT_ALIASES[key] === name,
  );
  return preset[name] ?? (alias ? preset[alias] : undefined);
}

/** Finalize existing agents from the actual, pre-mutation host config. */
export function buildResolvedAgentRegistry(
  runtime: RuntimeConfig,
  options: RegistryBuildOptions,
): ResolvedAgentRegistry {
  const host = clone(options.hostSnapshot);
  const nativeRules = clone(options.nativePermissionsByAgent ?? {});
  const hostFlavor = options.hostFlavor;
  const pluginMcps = clone(options.pluginMcps ?? {});
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
  let marketplacePackages: MarketplaceLivePackage[] = [];
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
    const plan = resolveMarketplaceActivation({
      selectedPackageIds: options.marketplace.selectedPackageIds,
      store: options.marketplace.store,
      pluginVersion: options.marketplace.pluginVersion,
      availableSkillNames: options.marketplace.availableSkillNames,
      availableMcpNames: [...mcpNames],
      disabledSkillNames: runtime.disabledSkills,
      disabledMcpNames: runtime.disabledMcps,
      reservedAgentNames,
    });
    marketplacePackages = plan.agents.map((admission) => ({
      id: admission.packageId,
      runtimeName: admission.agentName,
      version: admission.version,
      digest: admission.digest,
      configFingerprint: '',
    }));
    const constructed = createMarketplaceAgentDefinitions(plan);
    const admittedNames = new Set(
      constructed.agents.map((agent) => agent.name),
    );
    const marketplaceAgents = constructed.agents.map((sourceAgent) => {
      const agent = clone(sourceAgent);
      const owner = runtime.agents()[agent.name];
      const hostOwner = host.agent?.[agent.name];
      const displayName =
        (typeof hostOwner?.displayName === 'string'
          ? hostOwner.displayName
          : undefined) ??
        (typeof owner?.displayName === 'string'
          ? owner.displayName
          : undefined);
      applyMarketplaceOwnerOverride(agent, owner);
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
  const childPolicyConstraints: Record<
    string,
    { ceilings?: PermissionCeilings }
  > = {};

  // User/host entries win over plugin-injected built-ins on a key
  // collision (issue #1290).
  const mcpConfig = { ...pluginMcps, ...(host.mcp ?? {}) };
  const availableMcpNames = Object.keys(mcpConfig);
  const preset = resolvedPreset(runtime);
  const runtimeAgentOverrides = runtime.agents();
  const overrideFor = (name: string) => {
    const legacy = Object.keys(AGENT_ALIASES).find(
      (alias) => AGENT_ALIASES[alias] === name,
    );
    return (
      runtimeAgentOverrides[name] ??
      (legacy ? runtimeAgentOverrides[legacy] : undefined)
    );
  };
  const hostEntries = host.agent ?? {};
  const finalAgentConfig: Record<string, unknown> = clone(hostEntries);

  for (const definition of definitions) {
    const name = definition.name;
    const displayName = definition.displayName
      ? normalizeAgentName(definition.displayName)
      : name;
    // Host-config boundary: resolve host overrides by canonical name and
    // explicit displayName only. Legacy aliases (e.g. host `explore`) belong
    // to the host's native agent namespace and must never map onto the
    // plugin agent (e.g. `explorer`). Plugin-own alias support (runtime
    // overrides, presets, identity mirroring) is handled separately.
    const hostEntry = hostEntries[name] ?? hostEntries[displayName];
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

    const configured =
      runtime.modelArrays[name] ?? definition._modelArray ?? [];
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
      runtime.combinedModelInheritanceSource(name) === undefined
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

  applyModelInheritanceToConfig(finalAgentConfig, runtime);

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
      // dual-track reinforcement.
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
    if (packageMetadata) {
      const requestedTools = finalEntry.tools as
        | Record<string, boolean>
        | undefined;
      const packageTools = packageMetadata.capabilities.tools.filter(
        (tool) => requestedTools?.[tool] !== false,
      );
      const packageSkills = narrowCapabilities(
        packageMetadata.capabilities.skills,
        runtime.agents()[name]?.skills,
      );
      let packageMcps = narrowCapabilities(
        packageMetadata.capabilities.mcps,
        runtime.agents()[name]?.mcps,
      );
      const displayHostName = definition.displayName
        ? normalizeAgentName(definition.displayName)
        : name;
      const hostMcps =
        hostEntries[name]?.mcps ?? hostEntries[displayHostName]?.mcps;
      if (Array.isArray(hostMcps)) {
        packageMcps = narrowCapabilities(packageMcps, hostMcps as string[]);
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
      (sdk[name] as Record<string, unknown>).mcps = packageMcps;
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
    (sdk[name] as Record<string, unknown>).permission = clone(permission);
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
    const baselineRules = adaptPermissions(permission).filter(
      (rule): rule is V2PermissionRule =>
        rule.effect === 'allow' ||
        rule.effect === 'ask' ||
        rule.effect === 'deny',
    );
    const finalizedPackageMetadata = packageMetadata
      ? (marketplaceMetadata.get(name) ?? packageMetadata)
      : undefined;
    const marketplaceReadRules = marketplaceReadSafeguards(
      finalizedPackageMetadata?.capabilities.tools ?? [],
    );
    const ownerReadRule: V2PermissionRule[] =
      finalizedPackageMetadata &&
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
    childPolicyConstraints[name] = finalizedPackageMetadata
      ? {
          ceilings: marketplacePermissionCeilings(
            finalizedPackageMetadata.capabilities.tools,
            finalizedPackageMetadata.capabilities.skills,
            finalizedPackageMetadata.capabilities.mcps,
          ),
        }
      : {};
    policyMap[name] = compilePermissionPolicy({
      baselineRules: [
        ...baselineBeforeReadSafeguards,
        ...marketplaceReadRules,
        ...ownerReadRule,
      ],
      hostRules: finalizedPackageMetadata
        ? marketplaceHostRules(hostRuleSet)
        : hostRuleSet,
      ...childPolicyConstraints[name],
    });
    finalAgentConfig[name] = clone(finalEntry);
    sdk[name] = clone(finalEntry) as SDKAgentConfig & Record<string, unknown>;
  }

  for (const [alias, canonical] of Object.entries(AGENT_ALIASES)) {
    if (!finalAgentConfig[canonical]) continue;
    identities[alias] = identities[canonical] ?? canonical;
    candidateMap[alias] = clone(candidateMap[canonical] ?? []);
    effective[alias] = clone(effective[canonical] ?? {});
    if (policyMap[canonical]) policyMap[alias] = policyMap[canonical];
    if (childPolicyConstraints[canonical])
      childPolicyConstraints[alias] = childPolicyConstraints[canonical];
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
        ? narrowCapabilities(
            packageMetadata.capabilities.skills,
            runtime.agents()[definition.name]?.skills,
          )
        : [];
      let cappedMcps = packageMetadata
        ? narrowCapabilities(
            packageMetadata.capabilities.mcps,
            runtime.agents()[definition.name]?.mcps,
          )
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
      const visibleOwnerReadRule: V2PermissionRule[] =
        packageMetadata &&
        Object.hasOwn(sourceVisiblePermission, 'read') &&
        permissionEffect(sourceVisiblePermission, 'read') !== 'allow'
          ? [
              {
                action: 'read',
                resource: '*',
                effect: permissionEffect(sourceVisiblePermission, 'read'),
              },
            ]
          : [];
      const visibleBaselineRules = adaptPermissions(visiblePermission).filter(
        (rule): rule is V2PermissionRule =>
          rule.effect === 'allow' ||
          rule.effect === 'ask' ||
          rule.effect === 'deny',
      );
      const visibleBaselineBeforeReadSafeguards = visibleOwnerReadRule.length
        ? visibleBaselineRules.filter((rule) => rule.action !== 'read')
        : visibleBaselineRules;
      childPolicyConstraints[display] = packageMetadata
        ? {
            ceilings: marketplacePermissionCeilings(
              visibleTools,
              visibleSkills,
              cappedMcps,
            ),
          }
        : {};
      policyMap[display] = compilePermissionPolicy({
        baselineRules: [
          ...visibleBaselineBeforeReadSafeguards,
          ...marketplaceReadSafeguards(visibleTools),
          ...visibleOwnerReadRule,
        ],
        hostRules: packageMetadata
          ? marketplaceHostRules(visibleRules)
          : visibleRules,
        ...childPolicyConstraints[display],
      });
      if (definition.name === 'orchestrator') {
        appendMarketplaceRouting(
          { orchestrator: visibleConfig },
          definitions,
          marketplaceMetadata,
        );
        const trackedModel = effective[definition.name]?.model;
        const trackedVariant = effective[definition.name]?.variant;
        tuiModels[display] = visibleModel ?? trackedModel ?? 'default';
        const tuiVariant = visibleVariant ?? trackedVariant;
        if (tuiVariant) tuiVariants[display] = tuiVariant;
        else delete tuiVariants[display];
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
    identities: frozenIdentities,
    modelCandidates: frozenCandidates,
    effectiveStartupModels: frozenEffective,
    tuiAgentModels: frozenTuiModels,
    tuiAgentVariants: frozenTuiVariants,
    nativePolicies: frozenPolicies,
    compileChildPermissions: (
      agent: string,
      rules: readonly V2PermissionRule[],
    ) => {
      const constraints = frozenChildConstraints[agent];
      if (!constraints) {
        throw new Error(
          `child permission constraints unavailable for '${agent}'`,
        );
      }
      return compilePermissionPolicy({
        baselineRules: [],
        hostRules: rules,
        ...constraints,
      }).rules;
    },
    mcpConfig: frozenMcps,
    managedMcpConfig: frozenPluginMcps,
    finalAgentConfig: frozenFinal,
    managedAgentConfig: frozenManagedAgents,
    getSdkAgentProjection: () => clone(ownedSdk),
  });
}
