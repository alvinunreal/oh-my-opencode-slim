import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk/v2';
import { getSkillPermissionsForAgent } from '../cli/skills';
import {
  type AgentOverrideConfig,
  ALL_AGENT_NAMES,
  DEFAULT_DISABLED_AGENTS,
  DEFAULT_MODELS,
  getAgentOverride,
  getCustomAgentNames,
  loadAgentPrompt,
  type PluginConfig,
  PROTECTED_AGENTS,
  SUBAGENT_NAMES,
} from '../config';
import { getAgentMcpList } from '../config/agent-mcps';

import { createCouncilAgent } from './council';
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

export type { AgentDefinition } from './orchestrator';

type AgentFactory = (
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
) => AgentDefinition;

const COUNCIL_TOOL_ALLOWED_AGENTS = new Set(['council']);
const SAFE_AGENT_ALIAS_RE = /^[a-z][a-z0-9_-]*$/i;

function normalizeDisplayName(displayName: string): string {
  const trimmed = displayName.trim();
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
}

function isSafeDisplayName(displayName: string): boolean {
  return SAFE_AGENT_ALIAS_RE.test(displayName);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Agent Configuration Helpers

/**
 * Apply user-provided overrides to an agent's configuration.
 * Supports overriding model (string or priority array), variant, and temperature.
 * When model is an array, stores it as _modelArray for runtime fallback resolution
 * and clears config.model so OpenCode does not pre-resolve a stale value.
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
      agent.config.model = undefined; // cleared; runtime hook resolves from _modelArray
    } else {
      agent.config.model = override.model;
    }
  }
  if (override.variant) agent.config.variant = override.variant;
  if (override.temperature !== undefined)
    agent.config.temperature = override.temperature;
  if (override.options) {
    agent.config.options = {
      ...agent.config.options,
      ...override.options,
    };
  }
  if (override.displayName) {
    agent.displayName = override.displayName;
  }
}

function isKnownAgentName(name: string): boolean {
  return (ALL_AGENT_NAMES as readonly string[]).includes(name);
}

function normalizeCustomAgentName(name: string): string {
  return name.trim();
}

function isSafeCustomAgentName(name: string): boolean {
  return SAFE_AGENT_ALIAS_RE.test(name) && !isKnownAgentName(name);
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
): AgentDefinition {
  const basePrompt = override.prompt ?? `You are the ${name} specialist.`;

  return {
    name,
    config: {
      model:
        typeof override.model === 'string'
          ? override.model
          : (DEFAULT_MODELS.orchestrator ?? DEFAULT_MODELS.oracle),
      temperature: 0.2,
      prompt: resolvePrompt(basePrompt, filePrompt, fileAppendPrompt),
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
      `@${normalizeDisplayName(displayName)}`,
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
  configuredSkills?: string[],
): void {
  const existing = (agent.config.permission ?? {}) as Record<
    string,
    'ask' | 'allow' | 'deny' | Record<string, 'ask' | 'allow' | 'deny'>
  >;

  // Get skill-specific permissions for this agent
  const skillPermissions = getSkillPermissionsForAgent(
    agent.name,
    configuredSkills,
  );

  // Respect explicit deny on question (councillor)
  const questionPerm = existing.question === 'deny' ? 'deny' : 'allow';
  const councilSessionPerm = COUNCIL_TOOL_ALLOWED_AGENTS.has(agent.name)
    ? (existing.council_session ?? 'allow')
    : 'deny';

  agent.config.permission = {
    ...existing,
    question: questionPerm,
    council_session: councilSessionPerm,
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
 * @param config - Optional plugin configuration with agent overrides
 * @returns Array of agent definitions (orchestrator first, then subagents)
 */
export function createAgents(config?: PluginConfig): AgentDefinition[] {
  const disabled = getDisabledAgents(config);
  if (!config?.council) {
    disabled.add('council');
  }

  // TEMP: If fixer has no config, inherit from librarian's model to avoid breaking
  // existing users who don't have fixer in their config yet
  const getModelForAgent = (name: SubagentName): string => {
    if (name === 'fixer' && !getAgentOverride(config, 'fixer')?.model) {
      const librarianOverride = getAgentOverride(config, 'librarian')?.model;
      let librarianModel: string | undefined;
      if (Array.isArray(librarianOverride)) {
        const first = librarianOverride[0];
        librarianModel = typeof first === 'string' ? first : first?.id;
      } else {
        librarianModel = librarianOverride;
      }
      return librarianModel ?? (DEFAULT_MODELS.librarian as string);
    }
    // Subagents always have a defined default model; cast is safe here
    return DEFAULT_MODELS[name] as string;
  };

  // 1. Gather all sub-agent definitions with custom prompts
  const protoSubAgents = (
    Object.entries(SUBAGENT_FACTORIES) as [SubagentName, AgentFactory][]
  )
    .filter(([name]) => !disabled.has(name))
    .map(([name, factory]) => {
      const customPrompts = loadAgentPrompt(name, config?.preset);
      return factory(
        getModelForAgent(name),
        customPrompts.prompt,
        customPrompts.appendPrompt,
      );
    });

  // 1b. Discover unknown keys in config.agents as custom subagents.
  const customAgentNames = getCustomAgentNames(config)
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
    const override = getAgentOverride(config, name);
    if (!hasCustomAgentModel(override)) {
      console.warn(
        `[oh-my-opencode] Custom agent '${name}' skipped: 'model' is required`,
      );
      return [];
    }

    const customPrompts = loadAgentPrompt(name, config?.preset);

    return [
      buildCustomAgentDefinition(
        name,
        override,
        customPrompts.prompt,
        customPrompts.appendPrompt,
      ),
    ];
  });

  // 2. Apply overrides and default permissions to built-in subagents
  const builtInSubAgents = protoSubAgents.map((agent) => {
    const override = getAgentOverride(config, agent.name);
    if (override) {
      applyOverrides(agent, override);
    }
    applyDefaultPermissions(agent, override?.skills);
    return agent;
  });

  // 2b. Backward compat: if council has no preset override and still uses the
  // hardcoded default model, fall back to the deprecated council.master.model.
  // See https://github.com/alvinunreal/oh-my-opencode-slim/issues/369
  const legacyMasterModel = config?.council?._legacyMasterModel;
  if (legacyMasterModel) {
    const councilAgent = builtInSubAgents.find((a) => a.name === 'council');
    if (
      councilAgent &&
      !getAgentOverride(config, 'council')?.model &&
      councilAgent.config.model === DEFAULT_MODELS.council
    ) {
      councilAgent.config.model = legacyMasterModel;
    }
  }

  const customSubAgents = protoCustomAgents.map((agent) => {
    const override = getAgentOverride(config, agent.name);
    if (override) {
      applyOverrides(agent, override);
    }
    applyDefaultPermissions(agent, override?.skills);
    return agent;
  });

  const allSubAgents = [...builtInSubAgents, ...customSubAgents];

  // 3. Create Orchestrator (with its own overrides and custom prompts)
  // DEFAULT_MODELS.orchestrator is undefined; model is resolved via override or
  // left unset so the runtime chat.message hook can pick it from _modelArray.
  const orchestratorOverride = getAgentOverride(config, 'orchestrator');
  const orchestratorModel =
    orchestratorOverride?.model ?? DEFAULT_MODELS.orchestrator;
  const orchestratorPrompts = loadAgentPrompt('orchestrator', config?.preset);
  const orchestrator = createOrchestratorAgent(
    orchestratorModel,
    orchestratorPrompts.prompt,
    orchestratorPrompts.appendPrompt,
    disabled,
  );
  applyDefaultPermissions(orchestrator, orchestratorOverride?.skills);
  if (orchestratorOverride) {
    applyOverrides(orchestrator, orchestratorOverride);
  }

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

  // 3b. Append custom orchestrator hints from custom agent overrides.
  const customOrchestratorPrompts = customSubAgents
    .map((agent) => {
      const override = getAgentOverride(config, agent.name);
      return override?.orchestratorPrompt;
    })
    .filter((prompt): prompt is string => Boolean(prompt));

  // Validate display names
  const usedDisplayNames = new Set<string>();
  for (const [, displayName] of displayNameMap) {
    const normalizedDisplayName = normalizeDisplayName(displayName);
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
      customAgentNames.includes(displayName)
    ) {
      throw new Error(
        `displayName '${displayName}' conflicts with an agent name`,
      );
    }
  }

  // Inject display names into orchestrator prompt (complete map)
  injectDisplayNames(orchestrator, displayNameMap);

  if (customOrchestratorPrompts.length > 0) {
    const rewrittenPrompts = customOrchestratorPrompts.map((promptText) => {
      let text = promptText;
      for (const [internalName, displayName] of displayNameMap) {
        text = text.replace(
          new RegExp(`@${escapeRegExp(internalName)}\\b`, 'g'),
          `@${normalizeDisplayName(displayName)}`,
        );
      }
      return text;
    });

    orchestrator.config.prompt = `${orchestrator.config.prompt}\n\n${rewrittenPrompts.join(
      '\n\n',
    )}`;
  }

  return [orchestrator, ...allSubAgents];
}

/**
 * Get agent configurations formatted for the OpenCode SDK.
 * Converts agent definitions to SDK config format and applies classification metadata.
 *
 * @param config - Optional plugin configuration with agent overrides
 * @returns Record mapping agent names to their SDK configurations
 */
export function getAgentConfigs(
  config?: PluginConfig,
): Record<string, SDKAgentConfig> {
  const agents = createAgents(config);

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
    } else if (name === 'councillor') {
      // Internal agent — subagent mode, hidden from @ autocomplete
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

  const isInternalOnly = (name: string): boolean => name === 'councillor';

  const entries: Array<[string, SDKAgentConfig]> = [];

  for (const a of agents) {
    const sdkConfig: SDKAgentConfig & {
      mcps?: string[];
      displayName?: string;
      hidden?: boolean;
    } = {
      ...a.config,
      description: a.description,
      mcps: getAgentMcpList(a.name, config),
    };

    if (a.displayName) {
      sdkConfig.displayName = a.displayName;
    }

    applyClassification(a.name, sdkConfig);

    const normalizedDisplayName = a.displayName
      ? normalizeDisplayName(a.displayName)
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

/**
 * Get the set of disabled agent names from config, applying protection rules.
 */
export function getDisabledAgents(config?: PluginConfig): Set<string> {
  const userDisabled = config?.disabled_agents;
  const disabledSource =
    userDisabled !== undefined ? userDisabled : DEFAULT_DISABLED_AGENTS;
  const disabled = new Set<string>();
  for (const name of disabledSource) {
    if (!PROTECTED_AGENTS.has(name)) {
      disabled.add(name);
    }
  }
  return disabled;
}

/**
 * Get the list of enabled (non-disabled) agent names.
 */
export function getEnabledAgentNames(config?: PluginConfig): string[] {
  const disabled = getDisabledAgents(config);
  if (!config?.council) {
    disabled.add('council');
  }
  const customAgentNames = getCustomAgentNames(config).filter(
    (name) => !disabled.has(name),
  );
  return [
    ...ALL_AGENT_NAMES.filter((name) => !disabled.has(name)),
    ...customAgentNames,
  ];
}
