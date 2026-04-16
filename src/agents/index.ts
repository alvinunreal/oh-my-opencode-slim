import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk/v2';
import { getSkillPermissionsForAgent } from '../cli/skills';
import {
  type AgentOverrideConfig,
  ALL_AGENT_NAMES,
  DEFAULT_DISABLED_AGENTS,
  DEFAULT_MODELS,
  getAgentOverride,
  loadAgentPrompt,
  type PluginConfig,
  PROTECTED_AGENTS,
  SUBAGENT_NAMES,
} from '../config';
import { getAgentMcpList } from '../config/agent-mcps';

import { createCouncilAgent } from './council';
import { createCouncilMasterAgent } from './council-master';
import { createCouncillorAgent } from './councillor';
import { createDesignerAgent } from './designer';
import { createExplorerAgent } from './explorer';
import { createFixerAgent } from './fixer';
import { createLibrarianAgent } from './librarian';
import { createObserverAgent } from './observer';
import { createOracleAgent } from './oracle';
import { type AgentDefinition, createOrchestratorAgent } from './orchestrator';

export type { AgentDefinition } from './orchestrator';

type AgentFactory = (
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
) => AgentDefinition;

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
}

/**
 * Apply default permissions to an agent.
 * Sets 'question' permission to 'allow' and includes skill permission presets.
 * If configuredSkills is provided, it honors that list instead of defaults.
 *
 * Note: If the agent already explicitly sets question to 'deny', that is
 * respected (e.g. councillor and council-master should not ask questions).
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

  // Respect explicit deny on question (councillor, council-master)
  const questionPerm = existing.question === 'deny' ? 'deny' : 'allow';

  agent.config.permission = {
    ...existing,
    question: questionPerm,
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
  'council-master': createCouncilMasterAgent,
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
    // Council and council-master agents' model comes from
    // config.council.master.model so the TUI validates the user's
    // actual model, not the hardcoded default
    if (
      (name === 'council' ||
        name === 'council-master' ||
        name === 'councillor') &&
      config?.council?.master?.model
    ) {
      return config.council.master.model;
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

  // 2. Apply overrides and default permissions to each agent
  const allSubAgents = protoSubAgents.map((agent) => {
    const override = getAgentOverride(config, agent.name);
    if (override) {
      applyOverrides(agent, override);
    }
    applyDefaultPermissions(agent, override?.skills);
    return agent;
  });

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
  return Object.fromEntries(
    agents.map((a) => {
      const sdkConfig: SDKAgentConfig & { mcps?: string[] } = {
        ...a.config,
        description: a.description,
        mcps: getAgentMcpList(a.name, config),
      };

      // Apply classification-based visibility and mode
      if (a.name === 'council') {
        // Council is callable both as a primary agent (user-facing)
        // and as a subagent (orchestrator can delegate to it)
        sdkConfig.mode = 'all';
      } else if (a.name === 'councillor' || a.name === 'council-master') {
        // Internal agents — subagent mode, hidden from @ autocomplete
        sdkConfig.mode = 'subagent';
        sdkConfig.hidden = true;
      } else if (isSubagent(a.name)) {
        sdkConfig.mode = 'subagent';
      } else if (a.name === 'orchestrator') {
        sdkConfig.mode = 'primary';
      }

      return [a.name, sdkConfig];
    }),
  );
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
  return ALL_AGENT_NAMES.filter((name) => !disabled.has(name));
}
