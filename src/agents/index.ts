import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk/v2';
import { getSkillPermissionsForAgent } from '../cli/skills';
import {
  AGENT_ALIASES,
  type AgentOverrideConfig,
  ALL_AGENT_NAMES,
  DEFAULT_DISABLED_AGENTS,
  DEFAULT_MODELS,
  loadAgentPrompt,
  loadPluginConfig,
  type PluginConfig,
  PROTECTED_AGENTS,
  SUBAGENT_NAMES,
} from '../config';
import { getAgentMcpList } from '../config/agent-mcps';
import { type HostConfigSnapshot, RuntimeConfig } from '../config/runtime';
import { applyOrchestratorModelConfig } from '../config/strip-orchestrator-model';
import {
  type ActivatedMarketplaceAgent,
  composePackagePrompt,
  type MarketplaceActivationPlan,
  type MarketplaceDiagnostic,
  reservedRuntimeNames,
  resolveMarketplaceActivation,
} from '../marketplace/activation';
import { renderMarketplaceAutoDelegationBlock } from '../marketplace/routing';
import { MARKETPLACE_TOOL_NAMES } from '../marketplace/schemas';
import type {
  MarketplaceLivePackage,
  MarketplaceLiveSnapshot,
} from '../marketplace/status';
import type { MarketplaceStore } from '../marketplace/store';
import {
  escapeRegExp,
  isSafeAgentAlias,
  normalizeAgentName,
} from '../utils/agent-variant';

import { COUNCIL_SYNTHESIS_REINFORCEMENT, createCouncilAgent } from './council';
import { buildCouncillorAgents, getCouncillorSeatName } from './council-agents';
import { createCouncillorAgent } from './councillor';
import type { RoutingEntry } from './orchestrator';
import {
  type AgentDefinition,
  createOrchestratorAgent,
  renderCouncilRoutingBlock,
  resolvePrompt,
} from './orchestrator';
import {
  ROLE_DEFINITIONS,
  renderRoleRoutingBlock,
  SUPPORTED_SPECIALIST_ROLES,
} from './role-definitions';
import {
  appendTaskRejectionInstruction,
  TASK_REJECTION_INSTRUCTION,
} from './task-rejection';

export type { AgentDefinition } from './orchestrator';
export type { RoleDefinition, SpecialistRole } from './role-definitions';
export {
  ROLE_DEFINITIONS,
  SUPPORTED_SPECIALIST_ROLES,
} from './role-definitions';

type AgentFactory = (
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
) => AgentDefinition;

interface CreateAgentsOptions {
  projectDirectory?: string;
  marketplace?: MarketplaceActivationPlan;
  marketplaceStore?: MarketplaceStore;
  availableMcpNames?: readonly string[];
}

const TASK_CONTROL_DEFAULTS = [
  'task_cancel',
  'task_message',
  'task_revive',
  'task_status',
  'task_result',
] as const;

export interface ResolvedAgentRegistry {
  readonly agents: readonly AgentDefinition[];
  readonly sdkConfigs: Readonly<Record<string, SDKAgentConfig>>;
  readonly modelArrays: Readonly<
    Record<string, readonly { id: string; variant?: string }[]>
  >;
  readonly modelChains: Readonly<Record<string, readonly string[]>>;
  readonly mcpLists: Readonly<Record<string, readonly string[]>>;
  readonly skillPermissions: Readonly<
    Record<string, Readonly<Record<string, 'allow' | 'ask' | 'deny'>>>
  >;
  readonly routing: readonly RoutingEntry[];
  readonly provenance: Readonly<Record<string, string>>;
  readonly runtimeNameByCanonicalId: Readonly<Record<string, string>>;
  readonly canonicalIdByRuntimeName: Readonly<Record<string, string>>;
  readonly packageIdByRuntimeName: Readonly<Record<string, string>>;
  readonly runtimeNameByPackageId: Readonly<Record<string, string>>;
  readonly marketplaceLive: readonly MarketplaceLivePackage[];
  readonly diagnostics: readonly MarketplaceDiagnostic[];
}

type PermissionAction = 'allow' | 'ask' | 'deny';
type PermissionRecord = Record<string, unknown>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

/** Clone JSON-shaped data before handing it to a host-owned configuration. */
export function cloneOwned<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneOwned(entry)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      clone[key] = cloneOwned(entry);
    }
    return clone as T;
  }
  return value;
}

export function normalizePermission(permission: unknown): PermissionRecord {
  if (typeof permission === 'string') {
    return { '*': permission as PermissionAction };
  }
  if (permission && typeof permission === 'object') {
    return cloneOwned(permission as PermissionRecord);
  }
  return {};
}

/** A wildcard deny must remain authoritative under v2's last-match-wins rules. */
function hasWildcardDeny(permission: PermissionRecord): boolean {
  return permission['*'] === 'deny';
}

function mergePermissionRules(
  base: PermissionRecord,
  override: PermissionRecord,
): PermissionRecord {
  const result = cloneOwned(base);
  for (const [key, value] of Object.entries(override)) {
    const previous = result[key];
    if (
      previous !== null &&
      typeof previous === 'object' &&
      !Array.isArray(previous) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      result[key] = mergePermissionRules(
        previous as PermissionRecord,
        value as PermissionRecord,
      );
    } else {
      result[key] = cloneOwned(value);
    }
  }
  return result;
}

function applyTaskControlDefaults(
  agentName: string,
  permission: PermissionRecord,
): void {
  const isOrchestrator = agentName === 'orchestrator';
  for (const toolName of TASK_CONTROL_DEFAULTS) {
    permission[toolName] ??= isOrchestrator ? 'allow' : 'deny';
  }
  permission.wait_for_user ??= isOrchestrator ? 'allow' : 'deny';
  permission.marketplace ??= isOrchestrator ? 'allow' : 'deny';
}

function isDeniedPermissionValue(value: unknown): boolean {
  if (value === 'deny') return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const map = value as PermissionRecord;
  if (map['*'] === 'deny') return true;
  const actions = Object.values(map);
  return actions.length > 0 && actions.every((entry) => entry === 'deny');
}

/** True when marketplace is denied by a string action or nested pattern map. */
export function isMarketplacePermissionDenied(permission: unknown): boolean {
  const record = normalizePermission(permission);
  if (isDeniedPermissionValue(record.marketplace)) return true;
  return (
    record.marketplace === undefined && isDeniedPermissionValue(record['*'])
  );
}

/** True when the marketplace tool is registered and not denied for orchestrator. */
export function isMarketplaceToolAvailable(runtime: RuntimeConfig): boolean {
  if (runtime.disabledTools.includes('marketplace')) return false;
  return !isMarketplacePermissionDenied(
    runtime.agent('orchestrator')?.permission,
  );
}

/** Resolve marketplace live identities from on-disk config without touching
 * the session RuntimeConfig singleton. */
export function resolveDesiredMarketplaceLiveFromDisk(
  projectDirectory: string,
  store: MarketplaceStore,
  host?: HostConfigSnapshot,
): MarketplaceLiveSnapshot {
  const config = loadPluginConfig(projectDirectory, { silent: true });
  const directory = `${projectDirectory}\0marketplace-desired`;
  RuntimeConfig.reset(directory);
  const runtime = RuntimeConfig.init(directory, config);
  if (host) runtime.captureHostConfig(host);
  try {
    const registry = buildResolvedAgentRegistry(runtime, {
      marketplaceStore: store,
      projectDirectory,
    });
    return {
      packages: [...registry.marketplaceLive],
      diagnostics: [...registry.diagnostics],
    };
  } catch (error) {
    return {
      packages: [],
      diagnostics: [
        {
          packageId: '(store)',
          code: 'operational',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  } finally {
    RuntimeConfig.reset(directory);
  }
}

function buildMarketplaceLive(
  marketplace: MarketplaceActivationPlan,
  runtimeNameByPackageId: Readonly<Record<string, string>>,
): MarketplaceLivePackage[] {
  const registered = new Map<string, { version: string; digest: string }>();
  for (const activated of marketplace.agents) {
    registered.set(activated.packageId, {
      version: activated.version,
      digest: activated.digest,
    });
  }
  const live: MarketplaceLivePackage[] = [];
  for (const [packageId, runtimeName] of Object.entries(
    runtimeNameByPackageId,
  )) {
    const meta = registered.get(packageId);
    if (!meta) continue;
    live.push({
      packageId,
      version: meta.version,
      digest: meta.digest,
      runtimeName,
    });
  }
  return live;
}

/** Project registry defaults into a host-owned config object without mutating
 * registry data. Task controls are defaults; wait_for_user and marketplace
 * are immutable plugin gates for non-orchestrator agents. */
export function projectAgentPermission(
  agentName: string,
  hostEntry: Record<string, unknown>,
  registry: ResolvedAgentRegistry,
): void {
  const canonicalName =
    registry.canonicalIdByRuntimeName[agentName] ?? agentName;
  const registryEntry =
    registry.sdkConfigs[canonicalName] ?? registry.sdkConfigs[agentName];
  const permission = normalizePermission(registryEntry?.permission);
  const hostPermission = normalizePermission(hostEntry.permission);
  const projected = mergePermissionRules(permission, hostPermission);
  if (!hasWildcardDeny(projected)) {
    applyTaskControlDefaults(canonicalName, projected);
  }
  if (canonicalName !== 'orchestrator') {
    projected.wait_for_user = 'deny';
    projected.marketplace = 'deny';
  }
  hostEntry.permission = cloneOwned(projected);
}

function projectPermissionValues(
  canonicalName: string,
  registryPermission: unknown,
  hostPermission: unknown,
): PermissionRecord {
  const permission = normalizePermission(registryPermission);
  const projected = mergePermissionRules(
    permission,
    normalizePermission(hostPermission),
  );
  if (!hasWildcardDeny(projected)) {
    applyTaskControlDefaults(canonicalName, projected);
  }
  if (canonicalName !== 'orchestrator') {
    projected.wait_for_user = 'deny';
    projected.marketplace = 'deny';
  }
  return projected;
}

export function cloneAgentConfigs(
  configs: Readonly<Record<string, SDKAgentConfig>>,
): Record<string, SDKAgentConfig> {
  return cloneOwned(configs);
}

export function resolvePrimaryModelValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value[0];
  return typeof first === 'string'
    ? first
    : first && typeof first === 'object' && 'id' in first
      ? typeof first.id === 'string'
        ? first.id
        : undefined
      : undefined;
}

function getPrimaryModelFromOverride(
  override: AgentOverrideConfig | undefined,
): string | undefined {
  return resolvePrimaryModelValue(override?.model);
}

function hasExplicitVariantOverride(
  override: AgentOverrideConfig | undefined,
): boolean {
  if (override?.variant !== undefined) return true;
  if (!Array.isArray(override?.model) || override.model.length === 0) {
    return false;
  }
  const primary = override.model[0];
  return typeof primary !== 'string' && primary.variant !== undefined;
}

function stringVariant(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const isInternalOnly = (name: string): boolean =>
  name === 'councillor' || name.startsWith('councillor-');

/**
 * Alias-aware override lookup inside a merged (preset-aware) agents record.
 * Mirrors getAgentOverride semantics without the host layer, which the
 * config hook applies separately at merge time.
 */
function getOverrideFromAgents(
  agents: Record<string, AgentOverrideConfig>,
  name: string,
): AgentOverrideConfig | undefined {
  return (
    agents[name] ??
    agents[
      Object.keys(AGENT_ALIASES).find((key) => AGENT_ALIASES[key] === name) ??
        ''
    ]
  );
}

function buildAcpAgentDefinition(
  name: string,
  config: NonNullable<PluginConfig['acpAgents']>[string],
  fallbackModel?: string,
): AgentDefinition {
  const description =
    config.description ?? `External ACP agent '${name}' via ${config.command}`;
  const prompt =
    config.prompt ??
    [
      `You are the ${name} ACP wrapper agent.`,
      '',
      'Your only job is to send the user task to the configured external ACP agent using the acp_run tool, then return the ACP agent result.',
      `Always call acp_run with agent: ${JSON.stringify(
        name,
      )} and pass the full user task as prompt.`,
      'Do not edit files yourself unless the ACP result explicitly asks you to report a local follow-up to the orchestrator.',
    ].join('\n');

  return {
    name,
    description,
    config: {
      model: config.wrapperModel ?? fallbackModel ?? DEFAULT_MODELS.oracle,
      prompt,
      permission: {
        read: 'deny',
        edit: 'deny',
        bash: 'deny',
        task: 'deny',
        glob: 'deny',
        grep: 'deny',
        list: 'deny',
        webfetch: 'deny',
        question: 'deny',
        skill: 'deny',
        acp_run: 'allow',
      },
    },
  } as AgentDefinition;
}

function isSafeDisplayName(displayName: string): boolean {
  return isSafeAgentAlias(displayName);
}

// Agent Configuration Helpers

/**
 * Apply user-provided overrides to an agent's configuration.
 * Supports overriding model (string or priority array), variant, and temperature.
 * When model is an array, stores it as _modelArray for runtime fallback resolution
 * and selects its primary entry for ephemeral subagents. The orchestrator leaves
 * config.model unset so its live runtime selection is not overwritten.
 */
function applyOverrides(
  agent: AgentDefinition,
  override: AgentOverrideConfig,
): void {
  if (override.model !== undefined) {
    if (Array.isArray(override.model)) {
      // A model override replaces a marketplace candidate chain, including
      // its package-level primary variant. Re-apply only the owner-provided
      // variant below.
      delete agent.config.variant;
      agent._modelArray = override.model.map((m) =>
        typeof m === 'string' ? { id: m } : m,
      );
      const primaryModel = agent._modelArray[0];
      // Subagents are ephemeral, freshly-created sessions with no prior
      // runtime state to preserve, so giving them a concrete config.model
      // at launch time (the array's primary entry) is safe — see #9100e59.
      // ForegroundFallbackManager handles runtime failover to the
      // remaining entries in _modelArray.
      //
      // The orchestrator is different: it's a long-lived, foreground
      // session where a user's runtime `/model` selection must survive
      // across plugin re-inits (triggered by client.config.update() ->
      // Instance.dispose(), e.g. on every subagent dispatch). Setting
      // config.model here unconditionally would stomp that live
      // selection every time this function re-runs, because it runs
      // BEFORE the config() hook's merge with the live
      // opencodeConfig.agent.orchestrator.model (see src/index.ts:524-528,
      // added by #639). Leaving it undefined for the orchestrator lets
      // that later, precedence-aware guard be the sole source of truth.
      agent.config.model =
        agent.name === 'orchestrator' ? undefined : primaryModel.id;
      // Subagents launch with the primary model, so carry its inline variant
      // into the OpenCode config too. An explicit agent-level variant below
      // intentionally takes precedence.
      if (
        agent.name !== 'orchestrator' &&
        override.variant === undefined &&
        primaryModel.variant !== undefined
      ) {
        agent.config.variant = primaryModel.variant;
      }
    } else {
      // Marketplace agents may have installed an explicit package fallback
      // chain before owner overrides are applied. A scalar owner model is a
      // replacement, not an additional candidate, so discard that chain and
      // its package-level primary variant.
      delete agent._modelArray;
      delete agent.config.variant;
      agent.config.model = override.model;
    }
  }
  if (override.variant !== undefined) agent.config.variant = override.variant;
  if (override.temperature !== undefined)
    agent.config.temperature = override.temperature;
  if (override.color) agent.config.color = override.color;
  if (override.options) {
    agent.config.options = {
      ...agent.config.options,
      ...override.options,
    };
  }
  if (override.displayName) {
    agent.displayName = override.displayName;
  }
  if (override.description) {
    agent.description = override.description;
  }
  if (override.permission) {
    agent.config.permission = override.permission;
  }
}

/**
 * Apply an explicit model inheritance policy after the agent factory has
 * supplied its built-in fallback model. OpenCode uses the parent session model
 * when an agent config does not specify `model`.
 */
function applyModelInheritance(
  agent: AgentDefinition,
  override: AgentOverrideConfig | undefined,
  orchestratorModel: string | undefined,
): void {
  if (override?.model !== undefined) return;

  if (override?.inheritModelFrom === 'session') {
    delete agent._modelArray;
    delete agent.config.model;
    if (!hasExplicitVariantOverride(override)) {
      delete agent.config.variant;
    }
    return;
  }

  if (override?.inheritModelFrom === 'orchestrator') {
    delete agent._modelArray;
    if (orchestratorModel === undefined) {
      delete agent.config.model;
    } else {
      agent.config.model = orchestratorModel;
    }
    if (!hasExplicitVariantOverride(override)) {
      delete agent.config.variant;
    }
  }
}

/**
 * Resolve the model an agent's final config carries, mirroring the combined
 * effect of `createAgents` fallbacks, `applyOverrides`, and the inheritance
 * passes. Returns `undefined` exactly when the agent config ends up with NO
 * model key — i.e. `inheritModelFrom: 'session'` (or `'orchestrator'` with no
 * configured orchestrator model) — in which case OpenCode serves the agent
 * with the parent session's current model.
 *
 * This is the single resolution source for both agent definition building and
 * background-task admission, so provider/model concurrency accounting keys off
 * the model the spawned subagent actually uses. Explicit `model` wins; then
 * `inheritModelFrom`; then the historical fixer → librarian fallback; then
 * the preset primary model; then the per-agent default.
 */
export function resolveAgentConfigModel(
  runtime: RuntimeConfig,
  name: string,
): string | undefined {
  const mergedAgents = runtime.agents();
  const override = getOverrideFromAgents(mergedAgents, name);
  if (override?.model !== undefined) {
    return getPrimaryModelFromOverride(override);
  }
  if (override?.inheritModelFrom === 'session') {
    return undefined;
  }
  if (override?.inheritModelFrom === 'orchestrator') {
    return getPrimaryModelFromOverride(
      getOverrideFromAgents(mergedAgents, 'orchestrator'),
    );
  }
  // Dynamic councillors are defined outside `agents()` under the selected
  // council preset. Their generated agent config carries the preset model.
  if (name.startsWith('councillor-')) {
    const seat = name.slice('councillor-'.length);
    const preset =
      runtime.council?.presets?.[runtime.council.default_preset ?? 'default'];
    return preset?.[seat]?.models?.[0]?.id;
  }
  // ACP agents are generated from `acpAgents`; admission is for the wrapper
  // session, so account for its configured wrapper model when present.
  if (runtime.acpAgents[name]?.wrapperModel) {
    return runtime.acpAgents[name].wrapperModel;
  }
  if (name === 'fixer') {
    const librarianModel = getPrimaryModelFromOverride(
      getOverrideFromAgents(mergedAgents, 'librarian'),
    );
    return (
      librarianModel ??
      runtime.primaryModel ??
      ROLE_DEFINITIONS.librarian.defaultModel
    );
  }
  const roleName = runtime.agent(name)?.baseRole ?? name;
  const role = ROLE_DEFINITIONS[roleName as keyof typeof ROLE_DEFINITIONS];
  return (
    runtime.primaryModel ??
    role?.defaultModel ??
    (DEFAULT_MODELS as Record<string, string | undefined>)[name]
  );
}

/**
 * Apply model inheritance to the final host agent config after the host layer
 * has been merged. This clears stale host models for `session` inheritance,
 * which cannot be handled by the agent definition alone.
 */
export function applyModelInheritanceToConfig(
  configAgent: Record<string, unknown>,
  runtime: RuntimeConfig,
): void {
  const mergedAgents = runtime.agents();
  const orchestratorModel = getPrimaryModelFromOverride(
    runtime.agent('orchestrator'),
  );

  for (const agentName of Object.keys(configAgent)) {
    const override = getOverrideFromAgents(mergedAgents, agentName);
    if (!override) continue;
    if (
      override.model !== undefined ||
      override.inheritModelFrom === undefined
    ) {
      continue;
    }

    const resolvedName = AGENT_ALIASES[agentName] ?? agentName;
    const entry = configAgent[resolvedName];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const agentConfig = entry as Record<string, unknown>;
    const hostAgent =
      runtime.hostAgent(agentName) ?? runtime.hostAgent(resolvedName);
    const hasHostVariant = hostAgent?.variant !== undefined;
    const preserveVariant =
      hasExplicitVariantOverride(override) || hasHostVariant;
    if (override.inheritModelFrom === 'session') {
      delete agentConfig.model;
    } else if (orchestratorModel === undefined) {
      delete agentConfig.model;
    } else {
      agentConfig.model = orchestratorModel;
    }
    if (!preserveVariant) {
      delete agentConfig.variant;
    }
  }
}

function isKnownAgentName(name: string): boolean {
  return (ALL_AGENT_NAMES as readonly string[]).includes(name);
}

function normalizeCustomAgentName(name: string): string {
  return name.trim();
}

function isSafeCustomAgentName(name: string): boolean {
  return isSafeAgentAlias(name) && !isKnownAgentName(name);
}

function hasCustomAgentModel(
  override: AgentOverrideConfig | undefined,
): override is AgentOverrideConfig & {
  model: NonNullable<AgentOverrideConfig['model']>;
} {
  if (!override?.model) {
    return false;
  }

  return !Array.isArray(override.model) || override.model.length > 0;
}

function buildCustomAgentDefinition(
  name: string,
  override: AgentOverrideConfig,
  filePrompt?: string,
  fileAppendPrompt?: string,
  fallbackModel?: string,
): AgentDefinition {
  const role = override.baseRole
    ? ROLE_DEFINITIONS[override.baseRole]
    : undefined;
  const defaultPrompt = role?.basePrompt ?? `You are the ${name} specialist.`;
  const primaryModel = getPrimaryModelFromOverride(override);
  const description =
    override.description ?? role?.description ?? `Custom subagent '${name}'`;

  return {
    name,
    ...(role ? { baseRole: role.id } : {}),
    description,
    config: {
      model:
        primaryModel ??
        fallbackModel ??
        role?.defaultModel ??
        DEFAULT_MODELS.oracle,
      prompt: resolvePrompt(
        name,
        override.prompt,
        filePrompt,
        defaultPrompt,
        fileAppendPrompt,
        [TASK_REJECTION_INSTRUCTION],
      ),
    },
  } as AgentDefinition;
}

function rewriteRoutingPrompt(
  prompt: string,
  nameMap: ReadonlyMap<string, string>,
): string {
  let rewritten = prompt;
  for (const [internalName, displayName] of nameMap) {
    rewritten = rewritten.replace(
      new RegExp(`@${escapeRegExp(internalName)}\\b`, 'g'),
      `@${normalizeAgentName(displayName)}`,
    );
  }
  return rewritten;
}

/**
 * Apply default permissions to an agent.
 * Sets 'question' permission to 'allow' and includes skill permission presets.
 * If configuredSkills is provided, it honors that list instead of defaults.
 *
 * Note: If the agent already explicitly sets question to 'deny', that is
 * respected (e.g. councillor should not ask questions).
 */
function applyDefaultPermissionPolicy(
  agent: AgentDefinition,
  configuredSkills?: readonly string[],
  disabledSkills?: readonly string[],
): void {
  const existing = normalizePermission(agent.config.permission);
  // A user/package deny-all intentionally disables every capability. Adding
  // role, question, or skill allows after it reopens those tools on v2.
  if (hasWildcardDeny(existing)) {
    agent.config.permission = existing as SDKAgentConfig['permission'];
    return;
  }
  const role = agent.baseRole ? ROLE_DEFINITIONS[agent.baseRole] : undefined;

  // Get skill-specific permissions for this agent
  const skillPermissions = getSkillPermissionsForAgent(
    configuredSkills ? agent.name : (agent.baseRole ?? agent.name),
    configuredSkills ?? role?.defaultSkills,
    disabledSkills,
  );
  const filePermissions = role
    ? {
        read: existing.read ?? 'allow',
        edit:
          existing.edit ??
          (role.permissionPolicy === 'read-write' ? 'allow' : 'deny'),
        write:
          existing.write ??
          (role.permissionPolicy === 'read-write' ? 'allow' : 'deny'),
        apply_patch:
          existing.apply_patch ??
          (role.permissionPolicy === 'read-write' ? 'allow' : 'deny'),
        ast_grep_replace:
          existing.ast_grep_replace ??
          (role.permissionPolicy === 'read-write' ? 'allow' : 'deny'),
      }
    : {};

  // Respect explicit deny on question (councillor)
  const questionPerm = existing.question === 'deny' ? 'deny' : 'allow';
  agent.config.permission = {
    ...existing,
    ...filePermissions,
    question: questionPerm,
    // Apply skill permissions as nested object under 'skill' key
    skill: {
      ...(typeof existing.skill === 'object' ? existing.skill : {}),
      ...skillPermissions,
    },
  } as unknown as SDKAgentConfig['permission'];
}

/** Task controls are editable defaults, not immutable gates. */
function applyDefaultTaskControls(agent: AgentDefinition): void {
  const permission = normalizePermission(agent.config.permission);
  if (hasWildcardDeny(permission)) {
    agent.config.permission = permission as SDKAgentConfig['permission'];
    return;
  }
  const canonicalName = agent.baseRole ?? agent.name;
  applyTaskControlDefaults(canonicalName, permission);
  agent.config.permission = {
    ...permission,
  } as unknown as SDKAgentConfig['permission'];
}

/** Apply immutable plugin gates after host projection. */
function applyFinalImmutableGates(agent: AgentDefinition): void {
  const permission = normalizePermission(agent.config.permission);
  const canonicalName = agent.baseRole ?? agent.name;
  const orchestratorOnly =
    canonicalName === 'orchestrator'
      ? {
          wait_for_user: permission.wait_for_user,
          marketplace: permission.marketplace,
        }
      : { wait_for_user: 'deny', marketplace: 'deny' };
  agent.config.permission = {
    ...permission,
    ...orchestratorOnly,
  } as unknown as SDKAgentConfig['permission'];
}

function applyFinalPermissions(
  agent: AgentDefinition,
  configuredSkills: readonly string[] | undefined,
  disabledSkills: readonly string[] | undefined,
): void {
  applyDefaultPermissionPolicy(agent, configuredSkills, disabledSkills);
  applyDefaultTaskControls(agent);
  applyFinalImmutableGates(agent);
}

function uniqueNames(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function marketplaceSkillList(
  agent: AgentDefinition,
  override: AgentOverrideConfig | undefined,
  extraSkills: readonly string[] | undefined,
): readonly string[] | undefined {
  if (override?.skills) return override.skills;
  if (!extraSkills || extraSkills.length === 0) return undefined;
  const roleSkills = agent.baseRole
    ? ROLE_DEFINITIONS[agent.baseRole].defaultSkills
    : [];
  return uniqueNames([...roleSkills, ...extraSkills]);
}

const READONLY_MARKETPLACE_TOOLS = [
  'read',
  'glob',
  'grep',
  'ast_grep_search',
  'webfetch',
  'websearch',
] as const;

const NON_MARKETPLACE_TOOL_NAMES = [
  'task',
  'acp_run',
  'lsp',
  'list',
  'codesearch',
] as const;

function restrictMarketplaceNames(
  ceiling: readonly string[],
  ownerValues: readonly string[] | undefined,
): string[] {
  if (ownerValues === undefined) return [...ceiling];
  const denied = new Set(
    ownerValues
      .filter((value) => value.startsWith('!'))
      .map((value) => value.slice(1)),
  );
  const explicit = new Set(
    ownerValues.filter((value) => value !== '*' && !value.startsWith('!')),
  );
  const allowsAll = ownerValues.includes('*');
  return ceiling.filter(
    (name) => !denied.has(name) && (allowsAll || explicit.has(name)),
  );
}

function marketplaceCapabilityCeilings(
  agent: AgentDefinition,
  activated: ActivatedMarketplaceAgent,
  override: AgentOverrideConfig | undefined,
): {
  tools: readonly string[];
  skills: readonly string[];
  mcps: readonly string[];
} {
  const role = agent.baseRole ? ROLE_DEFINITIONS[agent.baseRole] : undefined;
  const baselineTools = role
    ? role.permissionPolicy === 'read-only'
      ? [...READONLY_MARKETPLACE_TOOLS]
      : [...MARKETPLACE_TOOL_NAMES]
    : [];
  const tools = role
    ? uniqueNames([...baselineTools, ...activated.manifest.tools])
    : [...activated.manifest.tools];
  const skills = restrictMarketplaceNames(
    role
      ? uniqueNames([...role.defaultSkills, ...activated.requiredSkills])
      : activated.requiredSkills,
    override?.skills,
  );
  const mcps = restrictMarketplaceNames(
    role
      ? uniqueNames([...role.defaultMcps, ...activated.requiredMcps])
      : activated.requiredMcps,
    override?.mcps,
  );
  return { tools, skills, mcps };
}

function applyRestrictiveMarketplacePermission(
  target: PermissionRecord,
  source: unknown,
  tools: ReadonlySet<string>,
  skills: ReadonlySet<string>,
  mcps: ReadonlySet<string>,
  applyWildcard = true,
): void {
  const record = normalizePermission(source);
  const wildcard = applyWildcard ? record['*'] : undefined;
  const applyRestriction = (key: string, value: unknown): void => {
    if (value !== 'deny' && value !== 'ask') return;
    if (target[key] !== 'deny' || value === 'deny') {
      target[key] = value;
    }
  };
  const skillIsGloballyDenied = (): boolean => {
    if (target.skill === 'deny') return true;
    if (
      target.skill &&
      typeof target.skill === 'object' &&
      !Array.isArray(target.skill)
    ) {
      return (target.skill as PermissionRecord)['*'] === 'deny';
    }
    return false;
  };
  const applySkillRestriction = (
    skillNames: ReadonlySet<string>,
    value: unknown,
  ): void => {
    if (value === 'deny') {
      target.skill = 'deny';
      return;
    }
    if (value !== 'ask' || skillIsGloballyDenied()) return;
    const targetSkills = normalizePermission(target.skill);
    for (const skill of skillNames) {
      if (targetSkills[skill] !== 'deny') targetSkills[skill] = 'ask';
    }
    target.skill = targetSkills;
  };

  // The package projection always has a default-deny wildcard. A restrictive
  // owner/host wildcard must therefore be projected onto every package
  // surface explicitly; changing only `*` would leave per-tool allows in
  // place and v2's last-match-wins evaluator would widen the package again.
  for (const tool of tools) applyRestriction(tool, wildcard);
  for (const mcp of mcps) applyRestriction(mcp, wildcard);
  applySkillRestriction(skills, wildcard);

  for (const tool of tools) {
    applyRestriction(tool, record[tool]);
  }
  const skillPermission = record.skill;
  applySkillRestriction(skills, skillPermission);
  if (
    skillPermission &&
    typeof skillPermission === 'object' &&
    !Array.isArray(skillPermission)
  ) {
    applySkillRestriction(skills, (skillPermission as PermissionRecord)['*']);
    if (!skillIsGloballyDenied()) {
      const effectiveTargetSkills = normalizePermission(target.skill);
      for (const skill of skills) {
        const value = (skillPermission as PermissionRecord)[skill];
        if (value === 'deny') effectiveTargetSkills[skill] = 'deny';
        else if (
          value === 'ask' &&
          !skillIsGloballyDenied() &&
          effectiveTargetSkills[skill] !== 'deny'
        )
          effectiveTargetSkills[skill] = 'ask';
      }
      target.skill = effectiveTargetSkills;
    }
  }
  for (const mcp of mcps) {
    applyRestriction(mcp, record[mcp]);
  }
}

function projectMarketplacePermission(
  packagePermission: unknown,
  hostPermission: unknown,
  tools: readonly string[],
  skills: readonly string[],
  mcps: readonly string[],
  availableMcpNames: readonly string[],
  hostTools: unknown,
): PermissionRecord {
  const result: PermissionRecord = { '*': 'deny' };
  const allowedTools = new Set(tools);
  for (const tool of MARKETPLACE_TOOL_NAMES) {
    result[tool] = allowedTools.has(tool) ? 'allow' : 'deny';
  }
  for (const tool of NON_MARKETPLACE_TOOL_NAMES) result[tool] = 'deny';
  result.skill = Object.fromEntries(skills.map((skill) => [skill, 'allow']));
  const allowedMcps = new Set(mcps);
  for (const mcp of availableMcpNames) {
    const key = `${mcp.replace(/[^a-zA-Z0-9_-]/g, '_')}_*`;
    result[key] = allowedMcps.has(mcp) ? 'allow' : 'deny';
  }

  const toolSet = new Set(tools);
  const skillSet = new Set(skills);
  const mcpSet = new Set(
    mcps.map((mcp) => `${mcp.replace(/[^a-zA-Z0-9_-]/g, '_')}_*`),
  );
  applyRestrictiveMarketplacePermission(
    result,
    packagePermission,
    toolSet,
    skillSet,
    mcpSet,
    false,
  );
  applyRestrictiveMarketplacePermission(
    result,
    hostPermission,
    toolSet,
    skillSet,
    mcpSet,
  );

  if (hostTools && typeof hostTools === 'object' && !Array.isArray(hostTools)) {
    for (const [tool, value] of Object.entries(
      hostTools as Record<string, unknown>,
    )) {
      if (toolSet.has(tool) && value === false) result[tool] = 'deny';
    }
  }
  return result;
}

function applyMarketplaceCapabilities(
  agent: AgentDefinition,
  ceilings: ReturnType<typeof marketplaceCapabilityCeilings>,
): void {
  const permission: PermissionRecord = { '*': 'deny' };
  const allowedTools = new Set(ceilings.tools);
  for (const tool of MARKETPLACE_TOOL_NAMES) {
    permission[tool] = allowedTools.has(tool) ? 'allow' : 'deny';
  }
  for (const tool of NON_MARKETPLACE_TOOL_NAMES) permission[tool] = 'deny';
  permission.skill = Object.fromEntries(
    ceilings.skills.map((skill) => [skill, 'allow']),
  );
  for (const mcp of ceilings.mcps) {
    permission[`${mcp.replace(/[^a-zA-Z0-9_-]/g, '_')}_*`] = 'allow';
  }
  applyRestrictiveMarketplacePermission(
    permission,
    agent.config.permission,
    new Set(ceilings.tools),
    new Set(ceilings.skills),
    new Set(
      ceilings.mcps.map((mcp) => `${mcp.replace(/[^a-zA-Z0-9_-]/g, '_')}_*`),
    ),
  );
  agent.config.permission =
    permission as unknown as SDKAgentConfig['permission'];
}

function marketplacePackage(
  plan: MarketplaceActivationPlan | undefined,
  agentName: string,
): ActivatedMarketplaceAgent | undefined {
  return plan?.agents.find((entry) => entry.manifest.agentName === agentName);
}

// Agent Classification

export type SubagentName = (typeof SUBAGENT_NAMES)[number];

export function isSubagent(name: string): name is SubagentName {
  return (SUBAGENT_NAMES as readonly string[]).includes(name);
}

function buildRoutingEntriesFromAgents(
  agents: readonly AgentDefinition[],
  guidanceByAgent: ReadonlyMap<string, string>,
  marketplace?: MarketplaceActivationPlan,
): RoutingEntry[] {
  const entries = agents.flatMap((agent): RoutingEntry[] => {
    if (agent.name === 'council') {
      const runtimeName = agent.displayName
        ? normalizeAgentName(agent.displayName)
        : agent.name;
      return [
        {
          agentName: runtimeName,
          routingBlock: renderCouncilRoutingBlock(runtimeName),
        },
      ];
    }
    if (agent.name === 'councillor' || agent.name.startsWith('councillor-')) {
      return [];
    }
    const marketplaceManifest = marketplace?.agents.find(
      (entry) => entry.manifest.agentName === agent.name,
    )?.manifest;
    const runtimeName = agent.displayName
      ? normalizeAgentName(agent.displayName)
      : agent.name;
    if (agent.baseRole) {
      const roleRoutingBlock = renderRoleRoutingBlock(
        ROLE_DEFINITIONS[agent.baseRole],
        runtimeName,
      );
      const routingBlock = marketplaceManifest
        ? renderMarketplaceAutoDelegationBlock(marketplaceManifest, runtimeName)
        : roleRoutingBlock;
      return [
        {
          agentName: runtimeName,
          routingBlock: guidanceByAgent.has(agent.name)
            ? appendRoutingGuidance(
                marketplaceManifest ? roleRoutingBlock : routingBlock,
                guidanceByAgent.get(agent.name),
              )
            : routingBlock,
        },
      ];
    }
    const genericRoutingBlock = [
      `@${runtimeName}`,
      `- Lane: ${agent.description ?? `Configured agent ${agent.name}`}`,
    ].join('\n');
    const routingBlock = marketplaceManifest
      ? renderMarketplaceAutoDelegationBlock(
          marketplaceManifest,
          runtimeName,
          marketplaceManifest.schemaVersion === 3
            ? undefined
            : agent.description,
        )
      : genericRoutingBlock;
    return [
      {
        agentName: runtimeName,
        routingBlock: guidanceByAgent.has(agent.name)
          ? appendRoutingGuidance(
              marketplaceManifest ? genericRoutingBlock : routingBlock,
              guidanceByAgent.get(agent.name),
            )
          : routingBlock,
      },
    ];
  });
  return entries.sort((left, right) =>
    left.agentName < right.agentName
      ? -1
      : left.agentName > right.agentName
        ? 1
        : 0,
  );
}

function appendRoutingGuidance(
  routingBlock: string,
  guidance: string | undefined,
): string {
  return guidance ? `${routingBlock}\n\n${guidance}` : routingBlock;
}

function buildRoutingGuidance(
  runtime: RuntimeConfig,
  agents: readonly AgentDefinition[],
): ReadonlyMap<string, string> {
  const displayNameMap = new Map<string, string>();
  for (const agent of agents) {
    if (agent.displayName) {
      displayNameMap.set(agent.name, agent.displayName);
    }
  }

  const guidance = new Map<string, string>();
  const mergedAgents = runtime.agents();
  for (const agent of agents) {
    const acp = runtime.acpAgents[agent.name];
    const customPrompt = getOverrideFromAgents(
      mergedAgents,
      agent.name,
    )?.orchestratorPrompt;
    const prompt = acp
      ? (acp.orchestratorPrompt ??
        [
          `@${agent.displayName ? normalizeAgentName(agent.displayName) : agent.name}`,
          `- Lane: External ACP-connected agent (${acp.command})`,
          `- Role: ${agent.description ?? `External ACP agent ${agent.name}`}`,
          '- **Delegate when:** The user explicitly asks for this ACP-backed agent, or the task matches its role and benefits from software/subscription-specific capabilities outside OpenCode.',
          '- **Do not delegate when:** The built-in specialists can handle the task more directly or local file ownership would conflict with another writer lane.',
          '- **Result handling:** Treat returned output as external-agent work. Reconcile any reported file changes before continuing.',
        ].join('\n'))
      : customPrompt;
    if (prompt) {
      guidance.set(agent.name, rewriteRoutingPrompt(prompt, displayNameMap));
    }
  }
  return guidance;
}

function buildRoutingEntriesForResolvedAgents(
  runtime: RuntimeConfig,
  agents: readonly AgentDefinition[],
  marketplace?: MarketplaceActivationPlan,
): RoutingEntry[] {
  return buildRoutingEntriesFromAgents(
    agents,
    buildRoutingGuidance(runtime, agents),
    marketplace,
  );
}

// Agent Factories

const SUBAGENT_FACTORIES: Record<SubagentName, AgentFactory> = {
  ...Object.fromEntries(
    SUPPORTED_SPECIALIST_ROLES.map((name) => [
      name,
      (model: string) => ROLE_DEFINITIONS[name].createBaseline(model),
    ]),
  ),
  council: createCouncilAgent,
  councillor: createCouncillorAgent,
} as Record<SubagentName, AgentFactory>;

// Public API

/**
 * Create all agent definitions with optional configuration overrides.
 * Instantiates the orchestrator and all subagents, applying user config and defaults.
 *
 * @param runtime - Runtime configuration interface (plugin layer, preset-aware)
 * @returns Array of agent definitions (orchestrator first, then subagents)
 */
export function createAgents(
  runtime: RuntimeConfig,
  options?: CreateAgentsOptions,
): AgentDefinition[] {
  const mergedAgents = runtime.agents();
  const marketplace = options?.marketplace;
  const disabled = new Set(runtime.disabledAgents);
  if (!runtime.council) {
    disabled.add('council');
    // The bare councillor is only meaningful as part of configured Council Mode.
    disabled.add('councillor');
  }

  const primaryModel = runtime.primaryModel;
  const orchestratorOverride = getOverrideFromAgents(
    mergedAgents,
    'orchestrator',
  );
  const configuredOrchestratorModel =
    getPrimaryModelFromOverride(orchestratorOverride);

  // Preserve the historical fixer → librarian fallback unless an explicit
  // inheritance policy opts the fixer into a different source.
  const getModelForAgent = (name: SubagentName): string => {
    const role = ROLE_DEFINITIONS[name as keyof typeof ROLE_DEFINITIONS];
    const override = getOverrideFromAgents(mergedAgents, name);
    if (override?.model === undefined) {
      if (override?.inheritModelFrom === 'orchestrator') {
        return configuredOrchestratorModel ?? (role?.defaultModel as string);
      }
      if (override?.inheritModelFrom === 'session') {
        return primaryModel ?? (role?.defaultModel as string);
      }
    }

    if (name === 'fixer' && override?.model === undefined) {
      const librarianOverride = getOverrideFromAgents(
        mergedAgents,
        'librarian',
      )?.model;
      let librarianModel: string | undefined;
      if (Array.isArray(librarianOverride)) {
        const first = librarianOverride[0];
        librarianModel = typeof first === 'string' ? first : first?.id;
      } else {
        librarianModel = librarianOverride;
      }
      return (
        librarianModel ??
        primaryModel ??
        (ROLE_DEFINITIONS.librarian.defaultModel as string)
      );
    }
    return (
      primaryModel ?? role?.defaultModel ?? (DEFAULT_MODELS[name] as string)
    );
  };

  // 1. Gather all sub-agent definitions with custom prompts
  const protoSubAgents = (
    Object.entries(SUBAGENT_FACTORIES) as [SubagentName, AgentFactory][]
  )
    .filter(([name]) => !disabled.has(name))
    .map(([name, factory]) => {
      // Get base agent definition using the subagent factory with undefined prompts
      const agent = factory(getModelForAgent(name), undefined, undefined);
      if (name in ROLE_DEFINITIONS) {
        agent.description =
          ROLE_DEFINITIONS[name as keyof typeof ROLE_DEFINITIONS].description;
      }

      const customPrompts = loadAgentPrompt(name, {
        preset: runtime.preset,
        projectDirectory: options?.projectDirectory,
      });

      const override = getOverrideFromAgents(mergedAgents, name);
      const inlinePrompt = override?.prompt;
      const defaultPrompt = agent.config.prompt ?? '';

      agent.config.prompt = resolvePrompt(
        name,
        inlinePrompt,
        customPrompts.prompt,
        defaultPrompt,
        customPrompts.appendPrompt,
        [
          TASK_REJECTION_INSTRUCTION,
          ...(name === 'council' ? [COUNCIL_SYNTHESIS_REINFORCEMENT] : []),
        ],
      );

      return agent;
    });

  const marketplaceAgentNames = new Set(
    (marketplace?.agents ?? []).map((entry) => entry.manifest.agentName),
  );

  // 1b. Discover unknown keys in config.agents as custom subagents.
  const customAgentNames = runtime.customAgentNames
    .map(normalizeCustomAgentName)
    .filter((name) => name.length > 0)
    .filter((name) => {
      if (marketplaceAgentNames.has(name)) {
        return false;
      }
      if (!isSafeCustomAgentName(name)) {
        throw new Error(`Unsafe custom agent name '${name}'`);
      }
      if (disabled.has(name)) {
        return false;
      }
      return true;
    });

  const protoCustomAgents = customAgentNames.flatMap((name) => {
    const override = getOverrideFromAgents(mergedAgents, name);
    if (
      !hasCustomAgentModel(override) &&
      override?.inheritModelFrom === undefined
    ) {
      console.warn(
        `[oh-my-opencode] Custom agent '${name}' skipped: 'model' is required`,
      );
      return [];
    }

    const customPrompts = loadAgentPrompt(name, {
      preset: runtime.preset,
      projectDirectory: options?.projectDirectory,
    });

    return [
      buildCustomAgentDefinition(
        name,
        override,
        customPrompts.prompt,
        customPrompts.appendPrompt,
        override.inheritModelFrom === 'orchestrator'
          ? configuredOrchestratorModel
          : primaryModel,
      ),
    ];
  });

  const protoMarketplaceAgents = (marketplace?.agents ?? []).flatMap(
    (activated) => {
      const name = activated.manifest.agentName;
      if (disabled.has(name)) return [];
      const role = activated.manifest.extends
        ? ROLE_DEFINITIONS[activated.manifest.extends.builtin]
        : undefined;
      const override = getOverrideFromAgents(mergedAgents, name);
      const customPrompts = loadAgentPrompt(name, {
        preset: runtime.preset,
        projectDirectory: options?.projectDirectory,
      });
      const policy = activated.manifest.model;
      const model =
        policy.source === 'explicit'
          ? typeof policy.candidates[0] === 'string'
            ? policy.candidates[0]
            : policy.candidates[0]?.id
          : policy.source === 'builtin'
            ? role?.defaultModel
            : policy.source === 'orchestrator'
              ? (configuredOrchestratorModel ?? primaryModel)
              : undefined;
      const agent: AgentDefinition = role
        ? role.createBaseline(
            (model ?? role.defaultModel ?? DEFAULT_MODELS.oracle) as string,
          )
        : {
            name,
            description: activated.manifest.description,
            config: { prompt: activated.manifest.prompt },
          };
      agent.name = name;
      if (role) agent.baseRole = role.id;
      agent.description = activated.manifest.description;
      if (policy.source === 'session') delete agent.config.model;
      if (policy.source === 'explicit') {
        agent._modelArray = policy.candidates.map((candidate) => ({
          ...(typeof candidate === 'string' ? { id: candidate } : candidate),
        }));
        agent.config.model = model;
        if (
          typeof policy.candidates[0] !== 'string' &&
          policy.candidates[0]?.variant
        ) {
          agent.config.variant = policy.candidates[0].variant;
        }
      }
      if (activated.manifest.temperature !== undefined) {
        agent.config.temperature = activated.manifest.temperature;
      }
      if (activated.manifest.color !== undefined) {
        agent.config.color = activated.manifest.color;
      }
      agent.config.prompt = resolvePrompt(
        name,
        override?.prompt,
        customPrompts.prompt,
        role
          ? composePackagePrompt(
              role.basePrompt,
              activated.manifest.prompt,
              activated.manifest.extends?.promptMode ?? 'append',
            )
          : activated.manifest.prompt,
        customPrompts.appendPrompt,
        [TASK_REJECTION_INSTRUCTION],
      );
      return [agent];
    },
  );

  const acpAgentNames = Object.keys(runtime.acpAgents)
    .map(normalizeCustomAgentName)
    .filter((name) => name.length > 0)
    .filter((name) => {
      if (!isSafeAgentAlias(name)) {
        throw new Error(
          `ACP agent name '${name}' must match /^[a-z][a-z0-9_-]*$/i`,
        );
      }
      if (isKnownAgentName(name) || AGENT_ALIASES[name] !== undefined) {
        throw new Error(
          `ACP agent '${name}' conflicts with a built-in agent name or alias`,
        );
      }
      if (customAgentNames.includes(name)) {
        throw new Error(
          `ACP agent '${name}' conflicts with a custom agent of the same name`,
        );
      }
      if (protoMarketplaceAgents.some((agent) => agent.name === name)) {
        throw new Error(
          `ACP agent '${name}' conflicts with a marketplace agent of the same name`,
        );
      }
      return !disabled.has(name);
    });

  const protoAcpAgents = acpAgentNames.map((name) => {
    const acp = runtime.acpAgents[name];
    if (!acp) throw new Error(`ACP agent '${name}' is missing config`);
    return buildAcpAgentDefinition(name, acp, primaryModel);
  });

  // 2. Apply overrides and default permissions to built-in subagents
  const builtInSubAgents = protoSubAgents.map((agent) => {
    const override = getOverrideFromAgents(mergedAgents, agent.name);
    if (override) {
      applyOverrides(agent, override);
    }
    applyModelInheritance(agent, override, configuredOrchestratorModel);
    applyFinalPermissions(
      agent,
      marketplaceSkillList(agent, override, undefined),
      runtime.disabledSkills,
    );
    return agent;
  });

  const customSubAgents = protoCustomAgents.map((agent) => {
    const override = getOverrideFromAgents(mergedAgents, agent.name);
    if (override) {
      applyOverrides(agent, override);
    }
    applyModelInheritance(agent, override, configuredOrchestratorModel);
    applyFinalPermissions(agent, override?.skills, runtime.disabledSkills);
    return agent;
  });

  const marketplaceSubAgents = protoMarketplaceAgents.flatMap((agent) => {
    const override = getOverrideFromAgents(mergedAgents, agent.name);
    if (override) {
      applyOverrides(agent, override);
    }
    if (agent.displayName) {
      const displayName = normalizeAgentName(agent.displayName);
      if (displayName === agent.name) {
        agent.displayName = undefined;
      } else if (!isSafeDisplayName(displayName)) {
        marketplace?.diagnostics.push({
          packageId:
            marketplace.agents.find(
              (entry) => entry.manifest.agentName === agent.name,
            )?.packageId ?? agent.name,
          code: 'invalid-alias',
          message: `display alias '${agent.displayName}' is not a valid agent alias`,
        });
        return [];
      } else if (reservedRuntimeNames(runtime, agent.name).has(displayName)) {
        marketplace?.diagnostics.push({
          packageId:
            marketplace.agents.find(
              (entry) => entry.manifest.agentName === agent.name,
            )?.packageId ?? agent.name,
          code: 'collision',
          message: `display alias '${displayName}' collides with an existing agent name`,
        });
        return [];
      }
    }
    applyModelInheritance(agent, override, configuredOrchestratorModel);
    const marketplaceEntry = marketplacePackage(marketplace, agent.name);
    const marketplaceCeilings = marketplaceEntry
      ? marketplaceCapabilityCeilings(agent, marketplaceEntry, override)
      : undefined;
    if (marketplaceCeilings) {
      applyMarketplaceCapabilities(agent, marketplaceCeilings);
    }
    applyFinalPermissions(
      agent,
      marketplaceCeilings?.skills,
      runtime.disabledSkills,
    );
    return [agent];
  });

  const acpSubAgents = protoAcpAgents.map((agent) => {
    applyFinalPermissions(agent, undefined, runtime.disabledSkills);
    return agent;
  });

  // Build dynamic councillor agents from council config (flatten mode).
  // Each councillor becomes a dispatchable subagent with its own model,
  // so the orchestrator can task() them with native panes at depth 1.
  // Only a *configured* color is inherited: councillor override first, then
  // council override. No default fallback — unconfigured councillors stay
  // colorless so the host TUI palette keeps assigning distinct colors.
  const councillorColor =
    getOverrideFromAgents(mergedAgents, 'councillor')?.color ??
    getOverrideFromAgents(mergedAgents, 'council')?.color;
  const councillorAgents = buildCouncillorAgents(runtime, disabled).map(
    (agent) => {
      if (councillorColor) agent.config.color ??= councillorColor;
      applyFinalPermissions(agent, undefined, runtime.disabledSkills);
      return agent;
    },
  );

  const allSubAgents = [
    ...builtInSubAgents,
    ...customSubAgents,
    ...marketplaceSubAgents,
    ...acpSubAgents,
    ...councillorAgents,
  ];

  for (const agent of [...acpSubAgents, ...councillorAgents]) {
    agent.config.prompt = appendTaskRejectionInstruction(
      agent.config.prompt ?? '',
    );
  }

  const runtimeNameByCanonicalId = Object.fromEntries(
    allSubAgents.map((agent) => [
      agent.name,
      agent.displayName ? normalizeAgentName(agent.displayName) : agent.name,
    ]),
  );

  // 3. Create Orchestrator (with its own overrides and custom prompts)
  // DEFAULT_MODELS.orchestrator is undefined; model is resolved via override or
  // left unset so the runtime chat.message hook can pick it from _modelArray.
  const orchestratorModel =
    orchestratorOverride?.model ?? DEFAULT_MODELS.orchestrator;
  const orchestratorPrompts = loadAgentPrompt('orchestrator', {
    preset: runtime.preset,
    projectDirectory: options?.projectDirectory,
  });
  const orchestrator = createOrchestratorAgent(
    orchestratorModel,
    undefined,
    undefined,
    disabled,
    councillorAgents.length > 0 ? ['council'] : undefined,
    !runtime.disabledTools.includes('wait_for_user'),
    runtime.backgroundJobs.orchestratorWake.enabled,
    buildRoutingEntriesForResolvedAgents(runtime, allSubAgents, marketplace),
    runtimeNameByCanonicalId,
    isMarketplaceToolAvailable(runtime),
  );

  const inlineOrchestratorPrompt = orchestratorOverride?.prompt;
  const defaultOrchestratorPrompt = orchestrator.config.prompt ?? '';

  orchestrator.config.prompt = resolvePrompt(
    'orchestrator',
    inlineOrchestratorPrompt,
    orchestratorPrompts.prompt,
    defaultOrchestratorPrompt,
    orchestratorPrompts.appendPrompt,
  );

  if (orchestratorOverride) {
    applyOverrides(orchestrator, orchestratorOverride);
  }
  applyModelInheritance(
    orchestrator,
    orchestratorOverride,
    configuredOrchestratorModel,
  );
  applyFinalPermissions(
    orchestrator,
    orchestratorOverride?.skills,
    runtime.disabledSkills,
  );

  // Collect all display names from orchestrator and all subagents
  const displayNameMap = new Map<string, string>();
  if (orchestrator.displayName) {
    displayNameMap.set('orchestrator', orchestrator.displayName);
  }
  for (const agent of allSubAgents) {
    if (agent.displayName) {
      displayNameMap.set(agent.name, agent.displayName);
    }
  }

  // Validate display names
  const usedDisplayNames = new Set<string>();
  for (const [, displayName] of displayNameMap) {
    const normalizedDisplayName = normalizeAgentName(displayName);
    if (!isSafeDisplayName(normalizedDisplayName)) {
      throw new Error(
        `displayName '${normalizedDisplayName}' must match /^[a-z][a-z0-9_-]*$/i`,
      );
    }
    if (usedDisplayNames.has(normalizedDisplayName)) {
      throw new Error(
        `Duplicate displayName '${normalizedDisplayName}' assigned to multiple agents`,
      );
    }
    usedDisplayNames.add(normalizedDisplayName);
  }
  for (const displayName of usedDisplayNames) {
    if (
      (ALL_AGENT_NAMES as readonly string[]).includes(displayName) ||
      customAgentNames.includes(displayName) ||
      marketplaceSubAgents.some((agent) => agent.name === displayName) ||
      acpAgentNames.includes(displayName)
    ) {
      throw new Error(
        `displayName '${displayName}' conflicts with an agent name`,
      );
    }
  }

  let updatedPrompt = orchestrator.config.prompt ?? '';

  // Inject council-dispatch block if dynamic councillors exist (flatten mode)
  if (councillorAgents.length > 0) {
    const dispatchList = councillorAgents
      .map(
        (a: AgentDefinition) =>
          `   - task(subagent_type='${a.name}', description='Councillor ${getCouncillorSeatName(a.name)} on <brief topic>', prompt=<user's question>)`,
      )
      .join('\n');
    updatedPrompt = `${updatedPrompt}\n\n## Council Mode\n\nWhen you need to run a council or the user asks for consensus/multiple opinions, use this procedure INSTEAD of delegating to @council:\n\n1. If the question references an external resource (PR, URL, issue, doc), fetch its content FIRST using your own tools (webfetch/bash/gh), then embed a concise summary in the prompt you send to each councillor — councillors have read-only codebase access only and cannot fetch external content themselves.\n2. Dispatch the user's question (with any fetched context) to each councillor in PARALLEL via task():\n${dispatchList}\n3. Collect ALL councillor responses. If any councillor returns empty or does not respond within 3 minutes, proceed without it — do not wait indefinitely. If a councillor's response is empty, retry that councillor once before continuing.\n4. Call task(subagent_type='council', description='Synthesize council report') with a prompt that includes the original user question AND all councillor responses. For each councillor, label its response with its seat name AND its model (e.g. "alpha (gpt-5.6-luna)"). Format each councillor's seat name and response clearly separated. If a councillor failed or timed out, include that status explicitly (e.g. "beta (gemini-3-pro): FAILED/TIMED OUT") instead of omitting it. Skip only councillors that returned empty after one retry.\n5. Present the council's synthesized report.\n\nThis ensures each councillor runs with its own model and the council agent synthesizes the full multi-model consensus.`;
  }

  orchestrator.config.prompt = updatedPrompt;

  return [orchestrator, ...allSubAgents];
}

/**
 * Get agent configurations formatted for the OpenCode SDK.
 * Converts agent definitions to SDK config format and applies classification metadata.
 *
 * @param runtime - Runtime configuration interface (plugin layer, preset-aware)
 * @param options - Optional options including projectDirectory
 * @returns Record mapping agent names to their SDK configurations
 */
function buildCanonicalAgentConfigs(
  runtime: RuntimeConfig,
  options?: CreateAgentsOptions,
  agents = createAgents(runtime, options),
): Record<string, SDKAgentConfig> {
  const applyClassification = (
    name: string,
    sdkConfig: SDKAgentConfig & {
      mcps?: string[];
      displayName?: string;
      hidden?: boolean;
    },
  ): void => {
    if (name === 'council') {
      // Council is callable both as a primary agent (user-facing)
      // and as a subagent (orchestrator can delegate to it)
      sdkConfig.mode = 'all';
    } else if (name === 'councillor' || name.startsWith('councillor-')) {
      // Internal agent - subagent mode, hidden from @ autocomplete.
      // Dynamic councillors are named councillor-<seat> (see council-agents.ts).
      sdkConfig.mode = 'subagent';
      sdkConfig.hidden = true;
    } else if (isSubagent(name)) {
      sdkConfig.mode = 'subagent';
    } else if (name === 'orchestrator') {
      sdkConfig.mode = 'primary';
    } else {
      sdkConfig.mode = 'subagent';
    }
  };

  const resolveAgentMcps = (agent: AgentDefinition): string[] => {
    const marketplaceEntry = marketplacePackage(
      options?.marketplace,
      agent.name,
    );
    if (marketplaceEntry) {
      return [
        ...marketplaceCapabilityCeilings(
          agent,
          marketplaceEntry,
          getOverrideFromAgents(runtime.agents(), agent.name),
        ).mcps,
      ];
    }
    const configured = runtime.agent(agent.name)?.mcps;
    if (configured !== undefined) {
      return getAgentMcpList(agent.name, runtime);
    }
    if (agent.baseRole)
      return [...ROLE_DEFINITIONS[agent.baseRole].defaultMcps];
    return getAgentMcpList(agent.name, runtime);
  };

  const entries: Array<[string, SDKAgentConfig]> = [];

  for (const a of agents) {
    const sdkConfig: SDKAgentConfig & {
      mcps?: string[];
      displayName?: string;
      hidden?: boolean;
    } = {
      ...a.config,
      description: a.description,
      mcps: resolveAgentMcps(a),
    };

    if (a.displayName) {
      sdkConfig.displayName = a.displayName;
    }

    applyClassification(a.name, sdkConfig);

    entries.push([a.name, sdkConfig]);
  }

  return Object.fromEntries(entries);
}

function applyMcpPermissionRules(
  permission: unknown,
  agentMcps: readonly string[],
  availableMcpNames: readonly string[],
): PermissionRecord {
  const result = normalizePermission(permission);
  if (hasWildcardDeny(result)) return result;
  const denied = new Set(
    agentMcps
      .filter((name) => name.startsWith('!'))
      .map((name) => name.slice(1)),
  );
  const allowsAll = agentMcps.includes('*');
  const allowed = new Set(
    agentMcps.filter((name) => !name.startsWith('!') && name !== '*'),
  );

  for (const mcpName of availableMcpNames) {
    const sanitized = mcpName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const key = `${sanitized}_*`;
    if (!(key in result)) {
      result[key] =
        !denied.has(mcpName) && (allowsAll || allowed.has(mcpName))
          ? 'allow'
          : 'deny';
    }
  }
  return result;
}

function hostAgentFor(
  runtime: RuntimeConfig,
  name: string,
  canonicalName: string,
): Record<string, unknown> | undefined {
  const entry = runtime.hostAgent(name) ?? runtime.hostAgent(canonicalName);
  return entry ? (entry as Record<string, unknown>) : undefined;
}

const SUPPORTED_HOST_AGENT_FIELDS = [
  'model',
  'variant',
  'temperature',
  'topP',
  'options',
  'tools',
  'steps',
  'color',
  'description',
  'permission',
] as const;

function mergeSupportedHostAgentFields(
  target: Record<string, unknown>,
  host: Record<string, unknown> | undefined,
): void {
  if (!host) return;
  for (const field of SUPPORTED_HOST_AGENT_FIELDS) {
    if (field in host) {
      target[field] = cloneOwned(host[field]);
    }
  }
}

/** Build every runtime agent surface once. Consumers must use this immutable
 * snapshot rather than reconstructing policy from raw config. Host capture is
 * optional only for the initial catalogue; the plugin replaces that catalogue
 * with the host-finalized snapshot before runtime consumers execute. */
export function buildResolvedAgentRegistry(
  runtime: RuntimeConfig,
  options?: {
    projectDirectory?: string;
    availableMcpNames?: readonly string[];
    marketplaceStore?: MarketplaceStore;
    preflightSkillNames?: readonly string[];
    preflightMcpNames?: readonly string[];
    extraSkillDirectories?: readonly string[];
  },
): ResolvedAgentRegistry {
  const marketplace = resolveMarketplaceActivation({
    runtime,
    store: options?.marketplaceStore,
    projectDirectory: options?.projectDirectory,
    availableSkillNames: options?.preflightSkillNames,
    availableMcpNames: options?.preflightMcpNames,
    extraSkillDirectories: options?.extraSkillDirectories,
  });
  const agents = createAgents(runtime, { ...options, marketplace });
  const routing = buildRoutingEntriesForResolvedAgents(
    runtime,
    agents.slice(1),
    marketplace,
  );
  const rawSdkConfigs = buildCanonicalAgentConfigs(
    runtime,
    { ...options, marketplace },
    agents,
  );
  const sdkConfigs: Record<string, SDKAgentConfig> = {};

  const modelArrays = cloneOwned(runtime.modelArrays);
  for (const activated of marketplace.agents) {
    const name = activated.manifest.agentName;
    const agent = agents.find((entry) => entry.name === name);
    if (agent?._modelArray && agent._modelArray.length > 0) {
      modelArrays[name] = cloneOwned(agent._modelArray);
      continue;
    }
    if (modelArrays[name]) continue;
    const model =
      typeof agent?.config.model === 'string' ? agent.config.model : undefined;
    if (model) {
      modelArrays[name] = [
        {
          id: model,
          ...(typeof agent?.config.variant === 'string'
            ? { variant: agent.config.variant }
            : {}),
        },
      ];
    }
  }
  for (const agent of agents) {
    const name = agent.name;
    const rawConfig = rawSdkConfigs[name];
    if (!rawConfig) continue;
    const runtimeName = agent.displayName
      ? normalizeAgentName(agent.displayName)
      : name;
    const hostConfig = hostAgentFor(runtime, runtimeName, name);
    const hostModel = resolvePrimaryModelValue(hostConfig?.model);
    const configuredModels = modelArrays[name];
    const hostVariant = stringVariant(hostConfig?.variant);
    const hostReplacesModel = Boolean(
      hostModel &&
        configuredModels?.[0]?.id &&
        configuredModels[0].id !== hostModel,
    );
    if (hostReplacesModel && hostModel) {
      const override = getOverrideFromAgents(runtime.agents(), name);
      const ownerVariant = hasExplicitVariantOverride(override)
        ? stringVariant((rawConfig as Record<string, unknown>).variant)
        : undefined;
      modelArrays[name] = [
        {
          id: hostModel,
          ...(hostVariant !== undefined
            ? { variant: hostVariant }
            : ownerVariant !== undefined
              ? { variant: ownerVariant }
              : {}),
        },
      ];
    } else if (
      hostModel &&
      hostVariant !== undefined &&
      configuredModels?.[0]?.id === hostModel
    ) {
      modelArrays[name] = configuredModels.map((entry, index) =>
        index === 0 ? { ...entry, variant: hostVariant } : entry,
      );
    }
    const ownedConfig = cloneOwned(rawConfig) as SDKAgentConfig &
      Record<string, unknown>;
    mergeSupportedHostAgentFields(ownedConfig, hostConfig);
    if (hostReplacesModel && hostVariant === undefined) {
      const override = getOverrideFromAgents(runtime.agents(), name);
      if (!hasExplicitVariantOverride(override)) {
        delete ownedConfig.variant;
      }
    }
    const marketplaceEntry = marketplacePackage(marketplace, name);
    if (marketplaceEntry) {
      const ceilings = marketplaceCapabilityCeilings(
        agent,
        marketplaceEntry,
        getOverrideFromAgents(runtime.agents(), name),
      );
      ownedConfig.permission = projectMarketplacePermission(
        rawConfig.permission,
        hostConfig?.permission,
        ceilings.tools,
        ceilings.skills,
        ceilings.mcps,
        options?.availableMcpNames ?? [],
        hostConfig?.tools,
      ) as SDKAgentConfig['permission'];
      if (
        hostConfig?.tools &&
        typeof hostConfig.tools === 'object' &&
        !Array.isArray(hostConfig.tools)
      ) {
        ownedConfig.tools = Object.fromEntries(
          Object.entries(hostConfig.tools as Record<string, unknown>).filter(
            ([tool, value]) =>
              ceilings.tools.includes(tool) && typeof value === 'boolean',
          ),
        ) as Record<string, boolean>;
      }
    } else {
      ownedConfig.permission = projectPermissionValues(
        name,
        rawConfig.permission,
        hostConfig?.permission,
      ) as SDKAgentConfig['permission'];
    }
    sdkConfigs[name] = ownedConfig;
  }

  // Apply inheritance only while constructing the immutable registry. The
  // config hook must not repeat this resolution against its host projection.
  applyModelInheritanceToConfig(sdkConfigs as Record<string, unknown>, runtime);

  // Inheritance replaces any lower-layer candidate chain. Rebuild the
  // orchestrator-inherited single candidate from the finalized SDK config so
  // the fallback surface cannot retain a package model or variant.
  for (const agent of agents) {
    const override = getOverrideFromAgents(runtime.agents(), agent.name);
    if (override?.inheritModelFrom === 'session') {
      delete modelArrays[agent.name];
      continue;
    }
    if (override?.inheritModelFrom !== 'orchestrator') continue;
    const config = sdkConfigs[agent.name];
    const model = resolvePrimaryModelValue(config?.model);
    if (model === undefined) {
      delete modelArrays[agent.name];
      continue;
    }
    const variant = stringVariant(config?.variant);
    modelArrays[agent.name] = [
      {
        id: model,
        ...(variant !== undefined ? { variant } : {}),
      },
    ];
  }

  const mcpLists: Record<string, readonly string[]> = {};
  const skillPermissions: Record<
    string,
    Readonly<Record<string, 'allow' | 'ask' | 'deny'>>
  > = {};
  const provenance: Record<string, string> = {};
  const runtimeNameByCanonicalId: Record<string, string> = {};
  const canonicalIdByRuntimeName: Record<string, string> = {};
  const packageIdByRuntimeName: Record<string, string> = {};
  const runtimeNameByPackageId: Record<string, string> = {};
  const modelChains = Object.fromEntries(
    Object.entries(modelArrays).map(([name, models]) => [
      name,
      models.map((model) => model.id),
    ]),
  );

  for (const [name, models] of Object.entries(modelArrays)) {
    const entry = sdkConfigs[name] as Record<string, unknown> | undefined;
    if (entry && entry.model === undefined && models.length > 0) {
      entry.model = models[0]?.id;
      if (models[0]?.variant !== undefined) {
        entry.variant = models[0].variant;
      }
    }
  }

  applyOrchestratorModelConfig({
    agents: sdkConfigs as Record<string, unknown>,
    enabled: runtime.stripOrchestratorModel,
    presets: runtime.plugin?.presets,
    configPreset: runtime.preset,
    runtimePreset: runtime.getRuntimePreset(),
  });

  const availableMcpNames = options?.availableMcpNames ?? [];
  for (const agent of agents) {
    const sdkConfig = sdkConfigs[agent.name] as SDKAgentConfig & {
      mcps?: string[];
    };
    mcpLists[agent.name] = sdkConfig.mcps ?? [];
    sdkConfig.permission = applyMcpPermissionRules(
      sdkConfig.permission,
      sdkConfig.mcps ?? [],
      availableMcpNames,
    ) as SDKAgentConfig['permission'];
    const permission = sdkConfig.permission;
    const marketplaceAgent = marketplace.agents.find(
      (entry) => entry.manifest.agentName === agent.name,
    );
    skillPermissions[agent.name] =
      typeof permission === 'object' &&
      permission !== null &&
      typeof permission.skill === 'object' &&
      permission.skill !== null
        ? cloneOwned(
            permission.skill as Record<string, 'allow' | 'ask' | 'deny'>,
          )
        : marketplaceAgent
          ? {}
          : getSkillPermissionsForAgent(
              agent.name,
              runtime.agent(agent.name)?.skills,
              runtime.disabledSkills,
            );
    provenance[agent.name] = marketplaceAgent
      ? `marketplace-agent:${marketplaceAgent.packageId}@${marketplaceAgent.version}`
      : agent.name === 'orchestrator'
        ? 'orchestrator-special'
        : isSubagent(agent.name)
          ? `builtin:${agent.name}`
          : 'configured-agent';
    runtimeNameByCanonicalId[agent.name] = agent.name;
    canonicalIdByRuntimeName[agent.name] = agent.name;
    if (marketplaceAgent) {
      packageIdByRuntimeName[agent.name] = marketplaceAgent.packageId;
      runtimeNameByPackageId[marketplaceAgent.packageId] = agent.name;
    }
    if (agent.displayName) {
      const displayName = normalizeAgentName(agent.displayName);
      if (modelArrays[agent.name]) {
        modelArrays[displayName] = modelArrays[agent.name];
        modelChains[displayName] = modelChains[agent.name];
      }
      mcpLists[displayName] = mcpLists[agent.name];
      skillPermissions[displayName] = skillPermissions[agent.name];
      provenance[displayName] = `alias:${agent.name}`;
      runtimeNameByCanonicalId[agent.name] = displayName;
      canonicalIdByRuntimeName[displayName] = agent.name;
      const packageId = packageIdByRuntimeName[agent.name];
      if (packageId) {
        packageIdByRuntimeName[displayName] = packageId;
        runtimeNameByPackageId[packageId] = displayName;
      }
    }
  }

  for (const [alias, canonical] of Object.entries(AGENT_ALIASES)) {
    if (canonicalIdByRuntimeName[canonical]) {
      canonicalIdByRuntimeName[alias] = canonical;
    }
  }

  for (const agent of agents) {
    if (!agent.displayName || isInternalOnly(agent.name)) continue;
    const displayName = normalizeAgentName(agent.displayName);
    const canonical = sdkConfigs[agent.name];
    if (!canonical) continue;
    const visible = cloneOwned(canonical) as SDKAgentConfig &
      Record<string, unknown>;
    delete visible.hidden;
    sdkConfigs[displayName] = visible;
    sdkConfigs[agent.name] = {
      ...cloneOwned(canonical),
      hidden: true,
    };
  }

  return deepFreeze({
    agents: Object.freeze(agents),
    sdkConfigs: Object.freeze(sdkConfigs),
    modelArrays: Object.freeze(
      Object.fromEntries(
        Object.entries(modelArrays).map(([name, models]) => [
          name,
          Object.freeze(models.map((model) => Object.freeze({ ...model }))),
        ]),
      ),
    ),
    modelChains: Object.freeze(
      Object.fromEntries(
        Object.entries(modelChains).map(([name, chain]) => [
          name,
          Object.freeze(chain),
        ]),
      ),
    ),
    mcpLists: Object.freeze(
      Object.fromEntries(
        Object.entries(mcpLists).map(([name, list]) => [
          name,
          Object.freeze([...list]),
        ]),
      ),
    ),
    skillPermissions: Object.freeze(
      Object.fromEntries(
        Object.entries(skillPermissions).map(([name, permissions]) => [
          name,
          Object.freeze({ ...permissions }),
        ]),
      ),
    ),
    marketplaceLive: Object.freeze(
      buildMarketplaceLive(marketplace, runtimeNameByPackageId).map((entry) =>
        Object.freeze({ ...entry }),
      ),
    ),
    routing: Object.freeze(routing),
    provenance: Object.freeze(provenance),
    runtimeNameByCanonicalId: Object.freeze(runtimeNameByCanonicalId),
    canonicalIdByRuntimeName: Object.freeze(canonicalIdByRuntimeName),
    packageIdByRuntimeName: Object.freeze(packageIdByRuntimeName),
    runtimeNameByPackageId: Object.freeze(runtimeNameByPackageId),
    diagnostics: Object.freeze(
      marketplace.diagnostics.map((entry) => Object.freeze({ ...entry })),
    ),
  });
}

export function getAgentConfigs(
  runtime: RuntimeConfig,
  options?: { projectDirectory?: string },
): Record<string, SDKAgentConfig> {
  return buildResolvedAgentRegistry(runtime, options).sdkConfigs as Record<
    string,
    SDKAgentConfig
  >;
}

/**
 * Get the set of disabled agent names from config, applying protection rules.
 */
export function getDisabledAgents(config?: PluginConfig): Set<string> {
  const userDisabled = config?.disabled_agents;
  const disabledSource = Array.isArray(userDisabled)
    ? userDisabled
    : DEFAULT_DISABLED_AGENTS;
  const disabled = new Set<string>();
  for (const name of disabledSource) {
    if (!PROTECTED_AGENTS.has(name)) {
      disabled.add(name);
    }
  }
  return disabled;
}
