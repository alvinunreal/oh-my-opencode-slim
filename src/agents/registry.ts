import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk/v2';
import { AGENT_ALIASES } from '../config';
import { parseList } from '../config/agent-mcps';
import { resolvePreset } from '../config/presets';
import type { HostConfigSnapshot, RuntimeConfig } from '../config/runtime';
import { applyOrchestratorModelConfig } from '../config/strip-orchestrator-model';
import { normalizeAgentName } from '../utils/agent-variant';
import { adaptPermissions } from '../v2/adapters';
import { compilePermissionPolicy } from '../v2/permissions';
import type { V2PermissionRule } from '../v2/types';
import { ensureCouncilCompactionException } from './council';
import {
  applyModelInheritanceToConfig,
  createAgents,
  getAgentConfigsFromDefinitions,
} from './index';
import type { AgentDefinition } from './orchestrator';

export interface ResolvedAgentRegistry {
  readonly hostFlavor: string | undefined;
  readonly agentNames: readonly string[];
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
  readonly mcpConfig: Readonly<Record<string, unknown>>;
  readonly managedMcpConfig: Readonly<Record<string, unknown>>;
  readonly finalAgentConfig: Readonly<Record<string, unknown>>;
  readonly managedAgentConfig: Readonly<Record<string, unknown>>;
  getSdkAgentProjection(): Record<string, SDKAgentConfig>;
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
  const definitions = options.definitions
    ? clone(options.definitions)
    : createAgents(runtime, {
        projectDirectory: options.projectDirectory,
        hostFlavor: options.hostFlavor,
      });
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

  const mcpConfig = { ...(host.mcp ?? {}), ...pluginMcps };
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
    const legacyAlias = Object.keys(AGENT_ALIASES).find(
      (key) => AGENT_ALIASES[key] === name,
    );
    const hostEntry =
      hostEntries[name] ??
      hostEntries[displayName] ??
      (legacyAlias ? hostEntries[legacyAlias] : undefined);
    const entry = sdk[name] as
      | (SDKAgentConfig & Record<string, unknown>)
      | undefined;
    if (!entry) throw new Error(`Missing SDK projection for agent '${name}'`);
    const configuredScalarModel =
      typeof entry.model === 'string' ? entry.model : undefined;
    const configuredScalarVariant =
      typeof entry.variant === 'string' ? entry.variant : undefined;
    if (hostEntry) Object.assign(entry, clone(hostEntry));

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
    finalAgentConfig[name] = entry;
  }

  const orchestratorEntry = finalAgentConfig.orchestrator as
    | Record<string, unknown>
    | undefined;
  const orchestratorDefinition = definitions.find(
    (definition) => definition.name === 'orchestrator',
  );
  const visibleOrchestratorName = orchestratorDefinition?.displayName
    ? normalizeAgentName(orchestratorDefinition.displayName)
    : 'orchestrator';
  const visibleOrchestratorHost =
    visibleOrchestratorName === 'orchestrator'
      ? undefined
      : hostEntries[visibleOrchestratorName];
  const visibleOrchestratorModel =
    typeof visibleOrchestratorHost?.model === 'string'
      ? visibleOrchestratorHost.model
      : typeof orchestratorEntry?.model === 'string'
        ? orchestratorEntry.model
        : null;
  applyModelInheritanceToConfig(
    finalAgentConfig,
    runtime,
    visibleOrchestratorModel,
  );

  for (const definition of definitions) {
    const name = definition.name;
    const displayName = definition.displayName
      ? normalizeAgentName(definition.displayName)
      : name;
    const entry = finalAgentConfig[name] as Record<string, unknown>;
    if (typeof entry.prompt === 'string') {
      // Host council prompt replaces the generated content; retain the required exception.
      if (name === 'council')
        entry.prompt = ensureCouncilCompactionException(entry.prompt);
    }
    const effectiveModel =
      typeof entry.model === 'string' ? entry.model : undefined;
    const effectiveVariant =
      typeof entry.variant === 'string' ? entry.variant : undefined;
    effective[name] = {
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(effectiveVariant ? { variant: effectiveVariant } : {}),
    };
    const modelOverride = overrideFor(name);
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
    const permission = (finalEntry.permission ?? {}) as Record<string, unknown>;
    const agentMcps = (sdk[name] as { mcps?: string[] }).mcps ?? [];
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
    finalEntry.permission = permission;
    (sdk[name] as Record<string, unknown>).permission = clone(permission);
    const legacyAlias = Object.keys(AGENT_ALIASES).find(
      (key) => AGENT_ALIASES[key] === name,
    );
    const visibleNativeRules = definition.displayName
      ? Object.entries(nativeRules).find(
          ([agentName]) =>
            normalizeAgentName(agentName).toLowerCase() ===
            normalizeAgentName(definition.displayName as string).toLowerCase(),
        )?.[1]
      : undefined;
    const hostRuleSet =
      nativeRules[name] ??
      visibleNativeRules ??
      (legacyAlias ? nativeRules[legacyAlias] : undefined) ??
      [];
    policyMap[name] = compilePermissionPolicy({
      baselineRules: adaptPermissions(permission).filter(
        (rule): rule is V2PermissionRule =>
          rule.effect === 'allow' ||
          rule.effect === 'ask' ||
          rule.effect === 'deny',
      ),
      hostRules: hostRuleSet,
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
  }
  for (const definition of definitions) {
    const display = identities[definition.name];
    if (display && display !== definition.name) {
      const legacyAlias = Object.keys(AGENT_ALIASES).find(
        (key) => AGENT_ALIASES[key] === definition.name,
      );
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
          ...((canonicalConfig.permission ?? {}) as Record<string, unknown>),
          ...((aliasHost?.permission ?? {}) as Record<string, unknown>),
        },
      };
      if (!aliasHost || !('hidden' in aliasHost)) delete visibleConfig.hidden;
      if (
        definition.name === 'council' &&
        typeof visibleConfig.prompt === 'string'
      ) {
        visibleConfig.prompt = ensureCouncilCompactionException(
          visibleConfig.prompt,
        );
      }
      const visiblePermission = visibleConfig.permission as Record<
        string,
        unknown
      >;
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
        nativeRules[display] ??
        nativeRules[definition.name] ??
        (legacyAlias ? nativeRules[legacyAlias] : undefined) ??
        [];
      policyMap[display] = compilePermissionPolicy({
        baselineRules: adaptPermissions(visiblePermission).filter(
          (rule): rule is V2PermissionRule =>
            rule.effect === 'allow' ||
            rule.effect === 'ask' ||
            rule.effect === 'deny',
        ),
        hostRules: visibleRules,
      });
      if (definition.name === 'orchestrator') {
        tuiModels[display] = visibleModel ?? 'default';
        if (visibleVariant) tuiVariants[display] = visibleVariant;
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
  return Object.freeze({
    hostFlavor,
    agentNames: Object.freeze(definitions.map((definition) => definition.name)),
    identities: frozenIdentities,
    modelCandidates: frozenCandidates,
    effectiveStartupModels: frozenEffective,
    tuiAgentModels: frozenTuiModels,
    tuiAgentVariants: frozenTuiVariants,
    nativePolicies: frozenPolicies,
    mcpConfig: frozenMcps,
    managedMcpConfig: frozenPluginMcps,
    finalAgentConfig: frozenFinal,
    managedAgentConfig: frozenManagedAgents,
    getSdkAgentProjection: () => clone(ownedSdk),
  });
}
