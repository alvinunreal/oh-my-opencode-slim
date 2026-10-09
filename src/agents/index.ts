import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk/v2';
import { getSkillPermissionsForAgent } from '../cli/skills';
import {
  AGENT_ALIASES,
  type AgentOverrideConfig,
  ALL_AGENT_NAMES,
  DEFAULT_MODELS,
  loadAgentPrompt,
  type PluginConfig,
  type Preset,
  SUBAGENT_NAMES,
} from '../config';
import { getAgentMcpList } from '../config/agent-mcps';
import type { HostAgentConfig, RuntimeConfig } from '../config/runtime';
import { applyOrchestratorModelConfig } from '../config/strip-orchestrator-model';
import { escapeRegExp, normalizeAgentName } from '../utils/agent-variant';
import { delegationVocabulary, parseModelRef } from '../v2/adapters';

import {
  createCouncilAgent,
  ensureCouncilCompactionException,
  ensureCouncilSynthesisReinforcement,
} from './council';
import { buildCouncillorAgents } from './council-agents';
import { createCouncillorAgent } from './councillor';
import { createDesignerAgent } from './designer';
import { createExplorerAgent } from './explorer';
import { createFixerAgent } from './fixer';
import { createLibrarianAgent } from './librarian';
import { createObserverAgent } from './observer';
import { createOracleAgent } from './oracle';
import {
  type AgentDefinition,
  createOrchestratorAgent,
  resolvePrompt,
} from './orchestrator';
import { mergeTaskStance, TASK_NO_NESTED_DISPATCH } from './permissions';
import {
  appendObserverDispatchInstruction,
  appendTaskRejectionInstruction,
  OBSERVER_DISPATCH_ROLES,
} from './task-rejection';

export { ensureCouncilCompactionException } from './council';
export type { AgentDefinition } from './orchestrator';

type AgentFactory = (
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
) => AgentDefinition;

const ORCHESTRATOR_DEFAULT_TOOL_NAMES = [
  'task_cancel',
  'task_message',
  'task_reply',
  'task_revive',
  'task_status',
  'task_result',
  'acp_run',
] as const;
const MARKETPLACE_TOOL_NAMES = [
  'marketplace_inspect',
  'marketplace_manage',
] as const;
const SAFE_AGENT_ALIAS_RE = /^[a-z][a-z0-9_-]*$/i;

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
  return SAFE_AGENT_ALIAS_RE.test(displayName);
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
  if (override.model) {
    if (Array.isArray(override.model)) {
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
      agent.config.model = override.model;
    }
  }
  if (override.variant) agent.config.variant = override.variant;
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
    // Keep the factory's nested-dispatch stance when the override doesn't
    // address `task` (shared with the host-entry and marketplace sites).
    agent.config.permission = mergeTaskStance(
      override.permission,
      agent.config.permission,
    );
  }
}

/**
 * Apply an explicit model inheritance policy after the agent factory has
 * supplied its built-in fallback model. OpenCode uses the parent session model
 * when an agent config does not specify `model`.
 *
 * A combined array-chain policy (`model: [...]` + `inheritModelFrom`) keeps
 * the SDK-level inheritance: the agent follows the live session/orchestrator
 * model and `_modelArray` remains the runtime fallback chain. A scalar `model`
 * still wins outright (explicit model precedence, see getModelForAgent).
 */
function applyModelInheritance(
  agent: AgentDefinition,
  override: AgentOverrideConfig | undefined,
): void {
  // Scalar models are explicit and always win. An array may be combined with
  // inheritance: keep it as the fallback chain while the live parent model
  // supplies the current primary.
  if (override?.model !== undefined && !Array.isArray(override.model)) return;

  if (
    override?.inheritModelFrom === 'session' ||
    override?.inheritModelFrom === 'orchestrator'
  ) {
    delete agent.config.model;
    // The chain head's inline variant belongs to the chain head model, not
    // to the inherited session model; drop it unless explicitly configured.
    if (override?.variant === undefined) {
      delete agent.config.variant;
    }
  }
}

/**
 * Apply model inheritance to the final host agent config after the host layer
 * has been merged. This clears stale host models for `session` and
 * `orchestrator` inheritance so delegated agents follow the live parent model.
 *
 * Combined array-chain policies (`model: [...]` + `inheritModelFrom`) are
 * honored here too: inheritance clears the host model so the SDK keeps
 * following the live parent model. A chain head's inline variant stamped by
 * the earlier passes is cleared alongside the rewritten model. Scalar models
 * keep explicit precedence and skip
 * inheritance entirely.
 */
export function applyModelInheritanceToConfig(
  configAgent: Record<string, unknown>,
  runtime: RuntimeConfig,
): void {
  const mergedAgents = runtime.agents();
  for (const agentName of Object.keys(configAgent)) {
    const override = getOverrideFromAgents(mergedAgents, agentName);
    if (!override) continue;
    if (
      (override.model !== undefined && !Array.isArray(override.model)) ||
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
    delete agentConfig.model;
    // The array-primary and runtime preset passes stamp the chain head's
    // inline variant into this entry next to its model. A combined policy
    // rewrites or clears that model, so the stale variant — which belongs
    // to the chain head model, not the inherited one — must go with it.
    // Explicit agent-level variants win and are left alone; scalar-model
    // agents never reach this point. Mirrors the agent-layer cleanup in
    // applyModelInheritance.
    if (Array.isArray(override.model) && override.variant === undefined) {
      delete agentConfig.variant;
    }
  }
}

function isKnownAgentName(name: string): boolean {
  return (ALL_AGENT_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Runtime state projection
//
// The config hook and the v2 hot-profile refresh both need the exact same
// final model resolution: host-layer merge, array-primary pass, runtime
// preset pass, model inheritance, sidebar projection, and orchestrator-model
// stripping. These helpers are the single source of truth for that pipeline;
// the config hook owns only the host-container side effects (model-switch
// tracking, container assignment).
// ---------------------------------------------------------------------------

/** Sidebar model/variant projection for one agent set. */
export interface AgentModelProjection {
  agentModels: Record<string, string>;
  agentVariants: Record<string, string>;
}

/**
 * Inference/runtime fields of one agent that may hot-apply to NEW child
 * sessions plus the sidebar. Everything else (prompt, tools, permissions,
 * skills, MCPs, description) stays frozen for a session's lifetime.
 */
export interface AgentRuntimeProfile {
  model?: { providerID: string; id: string; variant?: string };
  temperature?: number;
  providerOptions?: Record<string, unknown>;
  sidebarModel: string;
  sidebarVariant?: string;
}

export type AgentRuntimeProfiles = Record<string, AgentRuntimeProfile>;

/**
 * Merge the host opencode `agent` layer over the plugin's agent configs with
 * the plugin's shallow-merge precedence (host fields win per agent). The
 * optional `onUserModelSwitch` observes host-persisted models only — the
 * config hook uses it for the fallback-chain disable bookkeeping; the
 * read-only profile refresh passes none.
 */
export function mergeHostAgentConfigs(
  agents: Record<string, Record<string, unknown>>,
  hostAgents: Record<string, HostAgentConfig> | undefined,
  onUserModelSwitch?: (agentName: string, hostModel: string) => void,
): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const [name, pluginAgent] of Object.entries(agents)) {
    const existing = hostAgents?.[name];
    if (existing && typeof existing.model === 'string') {
      onUserModelSwitch?.(name, existing.model);
    }
    merged[name] = existing
      ? { ...pluginAgent, ...existing }
      : { ...pluginAgent };
  }

  // Display names are host-facing keys. Mirror their inference overrides to
  // the canonical entry used by runtime-profile lookup unless the host also
  // supplied a canonical override. Other host config stays independent.
  for (const [name, pluginAgent] of Object.entries(agents)) {
    const displayName = pluginAgent.displayName;
    if (typeof displayName !== 'string') continue;
    const visibleName = normalizeAgentName(displayName);
    const displayOverride = hostAgents?.[visibleName];
    const displayConfig = merged[visibleName];
    const canonicalOverride = hostAgents?.[name];
    const canonical = merged[name];
    if (!displayOverride || !displayConfig || !canonical) continue;
    // A canonical host entry is authoritative as a whole; falling back to
    // display-name fields individually can mix incompatible model settings.
    if (canonicalOverride !== undefined) continue;
    for (const key of ['model', 'variant', 'temperature', 'options'] as const) {
      if (displayConfig[key] !== undefined) canonical[key] = displayConfig[key];
    }
    if (typeof displayOverride.model === 'string') {
      onUserModelSwitch?.(name, displayOverride.model);
    }
  }
  return merged;
}

/** Model value for one entry (string model only; arrays resolved upstream). */
function entryModelString(
  entry: Record<string, unknown> | undefined,
): string | undefined {
  return typeof entry?.model === 'string' ? entry.model : undefined;
}

/**
 * Project the runtime state for a set of resolved agent definitions:
 *
 * 1. array-primary pass (`runtime.modelArrays` → first model unless the
 *    entry already pinned one);
 * 2. runtime-preset override pass (in-session preset switch wins);
 * 3. model-inheritance policy (`inheritModelFrom`);
 * 4. sidebar projection (`recordTuiAgentModels` payload);
 * 5. per-agent runtime profiles for model/variant/temperature/options.
 *
 * `agentConfigs` is mutated in place (entries only, matching the config
 * hook's historical behavior) and orchestrator-model stripping is applied
 * AFTER the projection so the sidebar/profile keep the configured model.
 */
export function projectAgentRuntimeState(input: {
  runtime: RuntimeConfig;
  agentDefs: readonly AgentDefinition[];
  agentConfigs: Record<string, Record<string, unknown>>;
  /** Resolved runtime-preset agent map (in-session switch), when active. */
  runtimePreset?: Preset;
}): { profiles: AgentRuntimeProfiles; projection: AgentModelProjection } {
  const { runtime, agentDefs, agentConfigs, runtimePreset } = input;

  // 1. Array-primary pass.
  if (Object.keys(runtime.modelArrays).length > 0) {
    for (const [agentName, models] of Object.entries(runtime.modelArrays)) {
      if (models.length === 0) continue;
      const chosen = models[0];
      const entry = agentConfigs[agentName];
      if (entry) {
        // A user-selected model (host layer) takes precedence over the
        // config's fallback chain.
        if (entry.model === undefined) {
          entry.model = chosen.id;
          if (chosen.variant) {
            entry.variant = chosen.variant;
          }
        }
      } else {
        agentConfigs[agentName] = {
          model: chosen.id,
          ...(chosen.variant ? { variant: chosen.variant } : {}),
        };
      }
    }
  }

  // 2. Runtime-preset override pass.
  if (runtimePreset) {
    for (const [agentName, override] of Object.entries(runtimePreset)) {
      const resolvedName = AGENT_ALIASES[agentName] ?? agentName;
      const entry = agentConfigs[resolvedName];
      if (!entry) continue;

      if (typeof override.model === 'string') {
        entry.model = override.model;
      } else if (Array.isArray(override.model) && override.model.length > 0) {
        const first = override.model[0];
        entry.model = typeof first === 'string' ? first : first.id;
        if (typeof first !== 'string' && first.variant) {
          entry.variant = first.variant;
        }
      }
      // Explicitly set or clear scalar fields so switching from Preset A
      // (which sets a field) to Preset B (which doesn't) leaves no stale
      // values behind.
      if (typeof override.variant === 'string') {
        entry.variant = override.variant;
      } else if ('variant' in override) {
        delete entry.variant;
      }
      if (typeof override.temperature === 'number') {
        entry.temperature = override.temperature;
      } else if ('temperature' in override) {
        delete entry.temperature;
      }
      if (
        override.options &&
        typeof override.options === 'object' &&
        !Array.isArray(override.options)
      ) {
        entry.options = override.options;
      } else if ('options' in override) {
        delete entry.options;
      }
    }
  }

  // 3. Model-inheritance policy (authoritative for inheritModelFrom agents).
  applyModelInheritanceToConfig(agentConfigs, runtime);

  // 4. Sidebar projection (pre-strip; mirrors the historical capture).
  const projection: AgentModelProjection = {
    agentModels: {},
    agentVariants: {},
  };
  for (const agentDef of agentDefs) {
    if (
      agentDef.name === 'council' ||
      agentDef.name === 'councillor' ||
      agentDef.name.startsWith('councillor-')
    ) {
      continue;
    }
    const entry = agentConfigs[agentDef.name];
    // Session-following combined agents have no launch model of their own:
    // entry.model is cleared, the chain head is only a fallback tail, and
    // agentDef.config.model is deleted by inheritance. Skip the chain-head
    // probe so they display 'default'.
    const followsSessionModel =
      runtime.combinedModelInheritanceSource(agentDef.name) === 'session';
    const resolvedModel =
      entryModelString(entry) ??
      (followsSessionModel
        ? undefined
        : runtime.runtimeChains[agentDef.name]?.[0]
          ? runtime.runtimeChains[agentDef.name][0]
          : typeof agentDef.config.model === 'string'
            ? agentDef.config.model
            : undefined);
    const resolvedVariant =
      typeof entry?.variant === 'string'
        ? entry.variant
        : typeof agentDef.config.variant === 'string'
          ? agentDef.config.variant
          : undefined;

    projection.agentModels[agentDef.name] = resolvedModel ?? 'default';
    if (resolvedVariant) {
      projection.agentVariants[agentDef.name] = resolvedVariant;
    }
  }

  // 5. Runtime profiles for NEW child dispatches. Keyed by every resolved
  // config entry (includes display-name aliases) so a child whose session
  // agent is either spelling resolves the same profile.
  const profiles: AgentRuntimeProfiles = {};
  for (const [name, entry] of Object.entries(agentConfigs)) {
    const modelString = entryModelString(entry);
    const ref = parseModelRef(modelString);
    const variant =
      typeof entry.variant === 'string' ? entry.variant : undefined;
    const temperature =
      typeof entry.temperature === 'number' ? entry.temperature : undefined;
    const providerOptions =
      entry.options &&
      typeof entry.options === 'object' &&
      !Array.isArray(entry.options)
        ? {
            ...(entry.options as Record<string, unknown>),
          }
        : undefined;
    const sidebarModel = projection.agentModels[name];
    const sidebarVariant = projection.agentVariants[name] ?? variant;
    profiles[name] = {
      ...(ref ? { model: { ...ref, ...(variant ? { variant } : {}) } } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      sidebarModel: sidebarModel ?? modelString ?? 'default',
      ...(sidebarVariant !== undefined ? { sidebarVariant } : {}),
    };
  }

  // 6. Orchestrator-model stripping runs AFTER the projection capture, exactly
  // as the config hook has always ordered it.
  applyOrchestratorModelConfig({
    agents: agentConfigs,
    enabled: runtime.stripOrchestratorModel,
    presets: runtime.plugin?.presets,
    configPreset: runtime.plugin?.preset,
    runtimePreset: runtime.getRuntimePreset(),
  });

  return { profiles, projection };
}

function normalizeCustomAgentName(name: string): string {
  return name.trim();
}

function isSafeCustomAgentName(name: string): boolean {
  // The councillor- prefix is reserved for dynamic council seats; a custom
  // agent taking it would become a phantom seat in the council-inject hook's
  // seat list (agents/index.ts filters agentDefs by the same prefix).
  return (
    SAFE_AGENT_ALIAS_RE.test(name) &&
    !isKnownAgentName(name) &&
    !name.startsWith('councillor-')
  );
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
  const defaultPrompt = appendTaskRejectionInstruction(
    `You are the ${name} specialist.`,
  );
  const primaryModel = getPrimaryModelFromOverride(override);
  const description = override.description ?? `Custom subagent '${name}'`;

  return {
    name,
    description,
    config: {
      model: primaryModel ?? fallbackModel ?? DEFAULT_MODELS.oracle,
      prompt: resolvePrompt(
        name,
        override.prompt,
        filePrompt,
        defaultPrompt,
        fileAppendPrompt,
      ),
    },
  } as AgentDefinition;
}

function injectDisplayNames(
  orchestrator: AgentDefinition,
  nameMap: Map<string, string>,
): void {
  if (nameMap.size === 0) return;
  let prompt = orchestrator.config.prompt;
  if (!prompt) return;

  for (const [internalName, displayName] of nameMap) {
    prompt = prompt.replace(
      new RegExp(`@${escapeRegExp(internalName)}\\b`, 'g'),
      `@${normalizeAgentName(displayName)}`,
    );
  }

  orchestrator.config.prompt = prompt;
}

/**
 * Apply default permissions to an agent.
 * Sets 'question' permission to 'allow' and includes skill permission presets.
 * If configuredSkills is provided, it honors that list instead of defaults.
 *
 * Note: If the agent already explicitly sets question to 'deny', that is
 * respected (e.g. councillor should not ask questions).
 */
function applyDefaultPermissions(
  agent: AgentDefinition,
  configuredSkills?: readonly string[],
  disabledSkills?: readonly string[],
  nestedDispatchEnabled = false,
  isPrimaryAgent = false,
): void {
  // A shorthand string is a user-level rule for every tool. Keep its original
  // form; marketplace tools independently fail closed through their caller
  // identity guard for every non-orchestrator agent.
  if (typeof agent.config.permission === 'string') {
    return;
  }

  const existing = (agent.config.permission ?? {}) as Record<
    string,
    'ask' | 'allow' | 'deny' | Record<string, 'ask' | 'allow' | 'deny'>
  >;

  // Get skill-specific permissions for this agent
  const skillPermissions = getSkillPermissionsForAgent(
    agent.name,
    configuredSkills,
    disabledSkills,
  );

  // Respect explicit deny on question (councillor)
  const questionPerm = existing.question === 'deny' ? 'deny' : 'allow';
  const orchestratorDefaultPermissions = Object.fromEntries(
    ORCHESTRATOR_DEFAULT_TOOL_NAMES.map((toolName) => [
      toolName,
      existing[toolName] ?? (agent.name === 'orchestrator' ? 'allow' : 'deny'),
    ]),
  );
  // Primary agents get allow because quiet interview prompts forbid printing
  // the state block; subagents never run interviews.
  const interviewSubmitPermission =
    existing.interview_submit_state ?? (isPrimaryAgent ? 'allow' : 'deny');
  const waitForUserPerm =
    agent.name === 'orchestrator'
      ? (existing.wait_for_user ?? 'allow')
      : 'deny';
  const marketplacePermissions = Object.fromEntries(
    MARKETPLACE_TOOL_NAMES.map((toolName) => {
      const configured = existing[toolName];
      const orchestratorPermission =
        configured === 'allow' || configured === 'ask' || configured === 'deny'
          ? configured
          : 'allow';
      return [
        toolName,
        agent.name === 'orchestrator' ? orchestratorPermission : 'deny',
      ];
    }),
  );

  agent.config.permission = {
    ...existing,
    // Nested-dispatch default: non-orchestrator agents without an explicit
    // `task` stance (custom, ACP, write-capable marketplace) deny spawning.
    // The compiled v2 permission base allows every unmatched action, so an
    // absent entry would let any child spawn once the host depth limit is
    // raised; the orchestrator keeps unrestricted delegation. Gated on the
    // same v2 + observer condition as the stances (v1 stays untouched).
    ...(nestedDispatchEnabled &&
    existing.task === undefined &&
    agent.name !== 'orchestrator'
      ? { task: { ...TASK_NO_NESTED_DISPATCH } }
      : {}),
    question: questionPerm,
    ...orchestratorDefaultPermissions,
    interview_submit_state: interviewSubmitPermission,
    wait_for_user: waitForUserPerm,
    ...marketplacePermissions,
    // Apply skill permissions as nested object under 'skill' key
    skill: {
      ...(typeof existing.skill === 'object' ? existing.skill : {}),
      ...skillPermissions,
    },
  } as SDKAgentConfig['permission'];
}

// Agent Classification

export type SubagentName = (typeof SUBAGENT_NAMES)[number];

export function isSubagent(name: string): name is SubagentName {
  return (SUBAGENT_NAMES as readonly string[]).includes(name);
}

// Agent Factories

const SUBAGENT_FACTORIES: Record<SubagentName, AgentFactory> = {
  explorer: createExplorerAgent,
  librarian: createLibrarianAgent,
  oracle: createOracleAgent,
  designer: createDesignerAgent,
  fixer: createFixerAgent,
  observer: createObserverAgent,
  council: createCouncilAgent,
  councillor: createCouncillorAgent,
};

// Public API

/**
 * Create all agent definitions with optional configuration overrides.
 * Instantiates the orchestrator and all subagents, applying user config and defaults.
 *
 * @param runtime - Runtime configuration interface (plugin layer, preset-aware)
 * @param options - Optional options including projectDirectory and hostFlavor
 * @returns Array of agent definitions (orchestrator first, then subagents)
 */
export function createAgents(
  runtime: RuntimeConfig,
  options?: { projectDirectory?: string; hostFlavor?: string },
): AgentDefinition[] {
  // Native delegation vocabulary for the host flavor ('v2' → subagent/agent,
  // v1/default → task/subagent_type). Construction-time constant — cache-safe.
  const vocab = delegationVocabulary(options?.hostFlavor);
  const mergedAgents = runtime.agents();
  const disabled = new Set(runtime.disabledAgents);
  if (!runtime.council) {
    disabled.add('council');
    // The bare councillor is only meaningful as part of configured Council Mode.
    disabled.add('councillor');
  }
  // Nested dispatch ships only where it is live: v2 hosts (the only flavor
  // with a depth limit) and an enabled observer. The v1 host enables a
  // child's task tool whenever its permission carries ANY task rule — with
  // no depth limit — so emitting stances there would change every advisor's
  // toolset for nothing.
  const nestedDispatchEnabled =
    options?.hostFlavor === 'v2' && !disabled.has('observer');
  // Explicitly disabling the council agent disables the whole chain: the
  // injected procedure dispatches seats and then delegates synthesis to
  // the council agent, so seats/pointer/hook without it would dangle.
  if (disabled.has('council')) {
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
    const override = getOverrideFromAgents(mergedAgents, name);
    if (override?.model === undefined) {
      if (override?.inheritModelFrom === 'orchestrator') {
        return configuredOrchestratorModel ?? (DEFAULT_MODELS[name] as string);
      }
      if (override?.inheritModelFrom === 'session') {
        return primaryModel ?? (DEFAULT_MODELS[name] as string);
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
        librarianModel ?? primaryModel ?? (DEFAULT_MODELS.librarian as string)
      );
    }
    return primaryModel ?? (DEFAULT_MODELS[name] as string);
  };

  // 1. Gather all sub-agent definitions with custom prompts
  const protoSubAgents = (
    Object.entries(SUBAGENT_FACTORIES) as [SubagentName, AgentFactory][]
  )
    .filter(([name]) => !disabled.has(name))
    .map(([name, factory]) => {
      // Get base agent definition using the subagent factory with undefined prompts
      const agent = factory(getModelForAgent(name), undefined, undefined);
      if (!nestedDispatchEnabled) {
        // Drop only the pattern stances this branch adds (object-shaped
        // task entries); pre-existing blanket-deny strings stay untouched.
        const permission = agent.config.permission as
          | Record<string, unknown>
          | undefined;
        if (
          permission &&
          typeof permission === 'object' &&
          typeof permission.task === 'object'
        ) {
          const rest = { ...permission };
          delete rest.task;
          agent.config.permission = rest as typeof agent.config.permission;
        }
      }

      const customPrompts = loadAgentPrompt(name, {
        preset: runtime.preset,
        projectDirectory: options?.projectDirectory,
        hostFlavor: options?.hostFlavor,
      });

      const override = getOverrideFromAgents(mergedAgents, name);
      const inlinePrompt = override?.prompt;
      const defaultPrompt = appendTaskRejectionInstruction(
        appendObserverDispatchInstruction(
          agent.config.prompt ?? '',
          nestedDispatchEnabled && OBSERVER_DISPATCH_ROLES.has(name),
        ),
      );

      agent.config.prompt = resolvePrompt(
        name,
        inlinePrompt,
        customPrompts.prompt,
        defaultPrompt,
        customPrompts.appendPrompt,
      );
      if (name === 'council') {
        // resolvePrompt above may have replaced the generated prompt with
        // an inline or council.md override; re-apply the idempotent
        // dual-track reinforcement so the required report structure and
        // the compaction exception survive the override.
        agent.config.prompt = ensureCouncilCompactionException(
          ensureCouncilSynthesisReinforcement(agent.config.prompt ?? ''),
        );
      }

      return agent;
    });

  // 1b. Discover unknown keys in config.agents as custom subagents.
  const customAgentNames = runtime.customAgentNames
    .map(normalizeCustomAgentName)
    .filter((name) => name.length > 0)
    .filter((name) => {
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
      hostFlavor: options?.hostFlavor,
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

  const acpAgentNames = Object.keys(runtime.acpAgents)
    .map(normalizeCustomAgentName)
    .filter((name) => name.length > 0)
    .filter((name) => {
      if (!SAFE_AGENT_ALIAS_RE.test(name)) {
        throw new Error(
          `ACP agent name '${name}' must match /^[a-z][a-z0-9_-]*$/i`,
        );
      }
      if (
        isKnownAgentName(name) ||
        AGENT_ALIASES[name] !== undefined ||
        name.startsWith('councillor-')
      ) {
        throw new Error(
          `ACP agent '${name}' conflicts with a built-in agent name or alias`,
        );
      }
      if (customAgentNames.includes(name)) {
        throw new Error(
          `ACP agent '${name}' conflicts with a custom agent of the same name`,
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
    applyModelInheritance(agent, override);
    applyDefaultPermissions(
      agent,
      override?.skills,
      runtime.disabledSkills,
      nestedDispatchEnabled,
    );
    return agent;
  });

  const customSubAgents = protoCustomAgents.map((agent) => {
    const override = getOverrideFromAgents(mergedAgents, agent.name);
    if (override) {
      applyOverrides(agent, override);
    }
    applyModelInheritance(agent, override);
    applyDefaultPermissions(
      agent,
      override?.skills,
      runtime.disabledSkills,
      nestedDispatchEnabled,
    );
    return agent;
  });

  const acpSubAgents = protoAcpAgents.map((agent) => {
    applyDefaultPermissions(
      agent,
      undefined,
      runtime.disabledSkills,
      nestedDispatchEnabled,
    );
    return agent;
  });

  // Build dynamic councillor agents from council config (flatten mode).
  // Each councillor becomes a dispatchable subagent with its own model,
  // so the orchestrator can delegate to them with the host delegation tool
  // (`task()` on v1, `subagent()` on v2) with native panes at depth 1.
  // Only a *configured* color is inherited: councillor override first, then
  // council override. No default fallback — unconfigured councillors stay
  // colorless so the host TUI palette keeps assigning distinct colors.
  const councillorColor =
    getOverrideFromAgents(mergedAgents, 'councillor')?.color ??
    getOverrideFromAgents(mergedAgents, 'council')?.color;
  const councillorAgents = buildCouncillorAgents(
    runtime,
    disabled,
    nestedDispatchEnabled,
  ).map((agent) => {
    if (councillorColor) agent.config.color ??= councillorColor;
    applyDefaultPermissions(
      agent,
      undefined,
      runtime.disabledSkills,
      nestedDispatchEnabled,
    );
    return agent;
  });

  const allSubAgents = [
    ...builtInSubAgents,
    ...customSubAgents,
    ...acpSubAgents,
    ...councillorAgents,
  ];

  for (const agent of [...acpSubAgents, ...councillorAgents]) {
    agent.config.prompt = appendTaskRejectionInstruction(
      appendObserverDispatchInstruction(
        agent.config.prompt ?? '',
        nestedDispatchEnabled && agent.name.startsWith('councillor-'),
      ),
    );
  }

  // 3. Create Orchestrator (with its own overrides and custom prompts)
  // DEFAULT_MODELS.orchestrator is undefined; model is resolved via override or
  // left unset so the runtime chat.message hook can pick it from _modelArray.
  const orchestratorModel =
    orchestratorOverride?.model ?? DEFAULT_MODELS.orchestrator;
  const orchestratorPrompts = loadAgentPrompt('orchestrator', {
    preset: runtime.preset,
    projectDirectory: options?.projectDirectory,
    hostFlavor: options?.hostFlavor,
  });
  const orchestrator = createOrchestratorAgent(
    orchestratorModel,
    undefined,
    undefined,
    disabled,
    councillorAgents.length > 0 ? ['council'] : undefined,
    !runtime.disabledTools.includes('wait_for_user'),
    runtime.backgroundJobs.orchestratorWake.enabled,
    options?.hostFlavor,
    runtime.backgroundJobs.boardInjection,
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
  applyModelInheritance(orchestrator, orchestratorOverride);
  applyDefaultPermissions(
    orchestrator,
    orchestratorOverride?.skills,
    runtime.disabledSkills,
    nestedDispatchEnabled,
    true,
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

  // 3b. Append custom orchestrator hints from built-in and custom agent overrides.
  const extraOrchestratorPromptsList = [...builtInSubAgents, ...customSubAgents]
    .map((agent) => {
      const override = getOverrideFromAgents(mergedAgents, agent.name);
      return override?.orchestratorPrompt;
    })
    .filter((prompt): prompt is string => Boolean(prompt));

  const acpOrchestratorPrompts = acpSubAgents.map((agent) => {
    const acp = runtime.acpAgents[agent.name];
    if (acp?.orchestratorPrompt) return acp.orchestratorPrompt;
    return [
      `@${agent.name}`,
      `- Lane: External ACP-connected agent (${
        acp?.command ?? 'unknown command'
      })`,
      `- Role: ${agent.description ?? `External ACP agent ${agent.name}`}`,
      '- **Delegate when:** The user explicitly asks for this ACP-backed agent, or the task matches its role and benefits from software/subscription-specific capabilities outside OpenCode.',
      '- **Do not delegate when:** The built-in specialists can handle the task more directly or local file ownership would conflict with another writer lane.',
      '- **Result handling:** Treat returned output as external-agent work. Reconcile any reported file changes before continuing.',
    ].join('\n');
  });

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
      acpAgentNames.includes(displayName)
    ) {
      throw new Error(
        `displayName '${displayName}' conflicts with an agent name`,
      );
    }
  }

  // Inject display names into orchestrator prompt (complete map)
  injectDisplayNames(orchestrator, displayNameMap);

  const rewritePrompt = (promptText: string) => {
    let text = promptText;
    for (const [internalName, displayName] of displayNameMap) {
      text = text.replace(
        new RegExp(`@${escapeRegExp(internalName)}\\b`, 'g'),
        `@${normalizeAgentName(displayName)}`,
      );
    }
    return text;
  };

  const rewrittenOverrides = extraOrchestratorPromptsList.map(rewritePrompt);
  const rewrittenAcps = acpOrchestratorPrompts.map(rewritePrompt);

  let updatedPrompt = orchestrator.config.prompt ?? '';

  if (rewrittenOverrides.length > 0) {
    updatedPrompt = `${updatedPrompt}\n\n# Project-specific routing guidance\n\n${rewrittenOverrides.join(
      '\n\n',
    )}`;
  }

  if (rewrittenAcps.length > 0) {
    updatedPrompt = `${updatedPrompt}\n\n${rewrittenAcps.join('\n\n')}`;
  }

  // Static pointer, not the full procedure: the Council Mode dispatch block
  // is injected by the council-inject hook on the FIRST council keyword and
  // then stays in history as a standing procedure (later triggers do not
  // re-inject). The seat list lives here because hidden councillors appear
  // in no host catalog — this line is the orchestrator's only always-present
  // source of seat IDs. Wording tracks the hook state: no auto-inject
  // promise when the hook is disabled.
  if (councillorAgents.length > 0) {
    const seatList = councillorAgents
      .map((a: AgentDefinition) => a.name)
      .join(', ');
    const injectNote = runtime.disabledHooks.has('council-inject')
      ? `dispatch via ${vocab.tool}() when the user asks for consensus (keyword injection disabled; dispatch seats and synthesize manually).`
      : `dispatch via ${vocab.tool}() when the user asks for consensus; the full procedure is injected once by the council-inject hook, at the first council keyword, and stays in effect.`;
    updatedPrompt = `${updatedPrompt}\n\n## Council\nSeats: ${seatList} — ${injectNote}`;
  }

  orchestrator.config.prompt = updatedPrompt;

  return [orchestrator, ...allSubAgents];
}

/**
 * Get agent configurations formatted for the OpenCode SDK.
 * Converts agent definitions to SDK config format and applies classification metadata.
 *
 * @param runtime - Runtime configuration interface (plugin layer, preset-aware)
 * @param options - Optional options including projectDirectory and hostFlavor
 * @returns Record mapping agent names to their SDK configurations
 */
export function getAgentConfigs(
  runtime: RuntimeConfig,
  options?: { projectDirectory?: string; hostFlavor?: string },
): Record<string, SDKAgentConfig> {
  const agents = createAgents(runtime, options);

  return getAgentConfigsFromDefinitions(runtime, agents);
}

/** Project a previously constructed agent set without rebuilding definitions. */
export function getAgentConfigsFromDefinitions(
  runtime: RuntimeConfig,
  agents: readonly AgentDefinition[],
): Record<string, SDKAgentConfig> {
  const applyClassification = (
    name: string,
    sdkConfig: SDKAgentConfig & {
      mcps?: string[];
      displayName?: string;
      hidden?: boolean;
    },
  ): void => {
    if (name === 'councillor' || name.startsWith('councillor-')) {
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

  const isInternalOnly = (name: string): boolean =>
    name === 'councillor' || name.startsWith('councillor-');

  const entries: Array<[string, SDKAgentConfig]> = [];

  for (const a of agents) {
    const sdkConfig: SDKAgentConfig & {
      mcps?: string[];
      displayName?: string;
      hidden?: boolean;
    } = {
      ...a.config,
      description: a.description,
      mcps: getAgentMcpList(a.name, runtime),
    };

    if (a.displayName) {
      sdkConfig.displayName = a.displayName;
    }

    applyClassification(a.name, sdkConfig);

    const normalizedDisplayName = a.displayName
      ? normalizeAgentName(a.displayName)
      : undefined;

    if (normalizedDisplayName && !isInternalOnly(a.name)) {
      entries.push([normalizedDisplayName, sdkConfig]);
      entries.push([a.name, { ...sdkConfig, hidden: true }]);
      continue;
    }

    entries.push([a.name, sdkConfig]);
  }

  return Object.fromEntries(entries);
}
