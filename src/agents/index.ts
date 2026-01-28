import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk';
import { getSkillPermissionsForAgent } from '../cli/skills';
import {
  type AgentOverrideConfig,
  DEFAULT_MODELS,
  getAgentOverride,
  loadAgentPrompt,
  type PluginConfig,
  SUBAGENT_NAMES,
} from '../config';
import { getAgentMcpList } from '../config/agent-mcps';

import { createDesignerAgent } from './designer';
import { createExplorerAgent } from './explorer';
import { createFixerAgent } from './fixer';
import { createLibrarianAgent } from './librarian';
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
 * Supports overriding model and temperature.
 */
function applyOverrides(
  agent: AgentDefinition,
  override: AgentOverrideConfig,
): void {
  if (override.model) agent.config.model = override.model;
  if (override.temperature !== undefined)
    agent.config.temperature = override.temperature;
}

/**
 * Apply default permissions to an agent.
 * Sets 'question' permission to 'allow' and includes skill permission presets.
 * If configuredSkills is provided, it honors that list instead of defaults.
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

  agent.config.permission = {
    ...existing,
    question: 'allow',
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
  // TEMP: If fixer has no config, inherit from librarian's model to avoid breaking
  // existing users who don't have fixer in their config yet
  const getModelForAgent = (name: SubagentName): string => {
    if (name === 'fixer' && !getAgentOverride(config, 'fixer')?.model) {
      return (
        getAgentOverride(config, 'librarian')?.model ?? DEFAULT_MODELS.librarian
      );
    }
    return DEFAULT_MODELS[name];
  };

  // 1. Gather all sub-agent definitions with custom prompts
  const protoSubAgents = (
    Object.entries(SUBAGENT_FACTORIES) as [SubagentName, AgentFactory][]
  ).map(([name, factory]) => {
    const customPrompts = loadAgentPrompt(name);
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
  const orchestratorModel =
    getAgentOverride(config, 'orchestrator')?.model ??
    DEFAULT_MODELS.orchestrator;
  const orchestratorPrompts = loadAgentPrompt('orchestrator');
  const orchestrator = createOrchestratorAgent(
    orchestratorModel,
    orchestratorPrompts.prompt,
    orchestratorPrompts.appendPrompt,
  );
  const oOverride = getAgentOverride(config, 'orchestrator');
  applyDefaultPermissions(orchestrator, oOverride?.skills);
  if (oOverride) {
    applyOverrides(orchestrator, oOverride);
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
      if (isSubagent(a.name)) {
        sdkConfig.mode = 'subagent';
      } else if (a.name === 'orchestrator') {
        sdkConfig.mode = 'primary';
      }

      return [a.name, sdkConfig];
    }),
  );
}
