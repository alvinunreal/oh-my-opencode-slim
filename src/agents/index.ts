import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk/v2';
import { getSkillPermissionsForAgent } from '../cli/skills';
import {
  type AgentOverrideConfig,
  getAgentOverride,
  loadAgentPrompt,
  type PluginConfig,
  SUBAGENT_NAMES,
} from '../config';
import { getAgentMcpList } from '../config/agent-mcps';
import {
  type AgentRole,
  DEFAULT_MODEL_ASSIGNMENTS,
} from '../token-discipline/config';
import { AGENT_TO_ROLE } from '../token-discipline/model-config';
import { getModelForAgent } from '../token-discipline/model-config-loader';

import { createDesignerAgent } from './designer';
import { createExplorerAgent } from './explorer';
import { createFixerAgent } from './fixer';
import { createLibrarianAgent } from './librarian';
import { createOracleAgent } from './oracle';
import { type AgentDefinition, createOrchestratorAgent } from './orchestrator';
import { createSummarizerAgent } from './summarizer';

export type { AgentDefinition } from './orchestrator';

type AgentFactory = (
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
) => AgentDefinition;

// Agent Configuration Helpers

/**
 * Apply user-provided overrides to an agent's configuration.
 * Supports overriding model, variant, and temperature.
 */
function applyOverrides(
  agent: AgentDefinition,
  override: AgentOverrideConfig,
): void {
  if (override.model) agent.config.model = override.model;
  if (override.variant) agent.config.variant = override.variant;
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
  summarizer: createSummarizerAgent,
};

// Public API

/**
 * Create all agent definitions with optional configuration overrides.
 * Instantiates the orchestrator and all subagents, applying user config and defaults.
 *
 * Priority for model selection (highest to lowest):
 * 1. Explicit model in PluginConfig.agents[name].model
 * 2. omoslim.json model_assignments (pre-resolved via modelAssignments param)
 * 3. DEFAULT_MODEL_ASSIGNMENTS from token-discipline/config (single source of truth)
 *
 * @internal Prefer {@link createAgentsWithModelConfig} at call sites.
 * @param config - Optional plugin configuration with agent overrides
 * @param modelAssignments - Pre-resolved model assignments from omoslim.json
 * @returns Array of agent definitions (orchestrator first, then subagents)
 */
export function createAgents(
  config?: PluginConfig,
  modelAssignments?: Record<string, string>,
): AgentDefinition[] {
  const resolveModel = (name: SubagentName | 'orchestrator'): string => {
    // 1. Explicit config override wins
    const overrideModel = getAgentOverride(config, name)?.model;
    if (overrideModel) return overrideModel;

    // 2. omoslim.json model assignment
    if (modelAssignments?.[name]) return modelAssignments[name];

    // 3. Token-discipline defaults keyed by role (single source of truth)
    const role = AGENT_TO_ROLE[name] as AgentRole | undefined;
    return DEFAULT_MODEL_ASSIGNMENTS[role ?? 'IMPLEMENTER'];
  };

  // 1. Gather all sub-agent definitions with custom prompts
  const protoSubAgents = (
    Object.entries(SUBAGENT_FACTORIES) as [SubagentName, AgentFactory][]
  ).map(([name, factory]) => {
    const customPrompts = loadAgentPrompt(name);
    return factory(
      resolveModel(name),
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
  const orchestratorModel = resolveModel('orchestrator');
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
 * Async variant: loads model assignments from omoslim.json before creating agents.
 * Use this at plugin init time to ensure omoslim.json is honoured.
 *
 * @param config - Optional plugin configuration with agent overrides
 * @returns Promise of array of agent definitions
 */
export async function createAgentsWithModelConfig(
  config?: PluginConfig,
): Promise<AgentDefinition[]> {
  // Resolve all agent models from omoslim.json concurrently
  const agentNames: Array<SubagentName | 'orchestrator'> = [
    'orchestrator',
    'explorer',
    'librarian',
    'oracle',
    'designer',
    'fixer',
    'summarizer',
  ];

  const modelEntries = await Promise.all(
    agentNames.map(async (name) => {
      try {
        const model = await getModelForAgent(name);
        return [name, model] as [string, string];
      } catch {
        return null;
      }
    }),
  );

  const modelAssignments = Object.fromEntries(
    modelEntries.filter((e): e is [string, string] => e !== null),
  );

  return createAgents(config, modelAssignments);
}

/**
 * Convert an array of agent definitions into the SDK config format.
 * Applies classification metadata (mode, mcps) to each agent.
 */
function agentDefinitionsToSdkConfigs(
  agents: AgentDefinition[],
  config?: PluginConfig,
): Record<string, SDKAgentConfig> {
  return Object.fromEntries(
    agents.map((a) => {
      const sdkConfig: SDKAgentConfig & { mcps?: string[] } = {
        ...a.config,
        description: a.description,
        mcps: getAgentMcpList(a.name, config),
      };

      if (isSubagent(a.name)) {
        sdkConfig.mode = 'subagent';
      } else if (a.name === 'orchestrator') {
        sdkConfig.mode = 'primary';
      }

      return [a.name, sdkConfig];
    }),
  );
}

/**
 * Get agent configurations formatted for the OpenCode SDK.
 * Converts agent definitions to SDK config format and applies classification metadata.
 *
 * @internal Prefer {@link getAgentConfigsWithModelConfig} at call sites.
 * @param config - Optional plugin configuration with agent overrides
 * @param modelAssignments - Pre-resolved model assignments from omoslim.json
 * @returns Record mapping agent names to their SDK configurations
 */
export function getAgentConfigs(
  config?: PluginConfig,
  modelAssignments?: Record<string, string>,
): Record<string, SDKAgentConfig> {
  const agents = createAgents(config, modelAssignments);
  return agentDefinitionsToSdkConfigs(agents, config);
}

/**
 * Async variant: loads model assignments from omoslim.json, then returns SDK configs.
 * Use at plugin init time to ensure omoslim.json model assignments are applied.
 *
 * @param config - Optional plugin configuration with agent overrides
 * @returns Promise of SDK agent config record
 */
export async function getAgentConfigsWithModelConfig(
  config?: PluginConfig,
): Promise<Record<string, SDKAgentConfig>> {
  const agents = await createAgentsWithModelConfig(config);
  return agentDefinitionsToSdkConfigs(agents, config);
}
