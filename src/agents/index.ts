import type { AgentConfig as SDKAgentConfig } from "@opencode-ai/sdk";
import { DEFAULT_MODELS, SUBAGENT_NAMES, type PluginConfig, type AgentOverrideConfig } from "../config";
import { createOrchestratorAgent, type AgentDefinition } from "./orchestrator";
import { createOracleAgent } from "./oracle";
import { createLibrarianAgent } from "./librarian";
import { createExplorerAgent } from "./explorer";
import { createDesignerAgent } from "./designer";
import { createFixerAgent } from "./fixer";

export type { AgentDefinition } from "./orchestrator";

type AgentFactory = (model: string) => AgentDefinition;

// Backward Compatibility

/** Map old agent names to new names for backward compatibility */
const AGENT_ALIASES: Record<string, string> = {
  "explore": "explorer",
  "frontend-ui-ux-engineer": "designer",
};

/**
 * Get agent override config by name, supporting backward-compatible aliases.
 * Checks both the current name and any legacy alias names.
 */
function getOverride(overrides: Record<string, AgentOverrideConfig>, name: string): AgentOverrideConfig | undefined {
  return overrides[name] ?? overrides[Object.keys(AGENT_ALIASES).find(k => AGENT_ALIASES[k] === name) ?? ""];
}

// Agent Configuration Helpers

/**
 * Apply user-provided overrides to an agent's configuration.
 * Supports overriding model and temperature.
 */
function applyOverrides(agent: AgentDefinition, override: AgentOverrideConfig): void {
  if (override.model) agent.config.model = override.model;
  if (override.temperature !== undefined) agent.config.temperature = override.temperature;
}

/**
 * Apply default permissions to an agent.
 * Currently sets 'question' permission to 'allow' for all agents.
 */
function applyDefaultPermissions(agent: AgentDefinition): void {
  const existing = (agent.config.permission ?? {}) as Record<string, "ask" | "allow" | "deny">;
  agent.config.permission = { ...existing, question: "allow" } as SDKAgentConfig["permission"];
}

// Agent Classification

export type SubagentName = typeof SUBAGENT_NAMES[number];

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
  const agentOverrides = config?.agents ?? {};

  // TEMP: If fixer has no config, inherit from librarian's model to avoid breaking
  // existing users who don't have fixer in their config yet
  const getModelForAgent = (name: SubagentName): string => {
    if (name === "fixer" && !getOverride(agentOverrides, "fixer")?.model) {
      return getOverride(agentOverrides, "librarian")?.model ?? DEFAULT_MODELS["librarian"];
    }
    return DEFAULT_MODELS[name];
  };

  // 1. Gather all sub-agent definitions
  const protoSubAgents = (Object.entries(SUBAGENT_FACTORIES) as [SubagentName, AgentFactory][]).map(
    ([name, factory]) => factory(getModelForAgent(name))
  );

  // 2. Apply overrides to each agent
  const allSubAgents = protoSubAgents.map((agent) => {
    const override = getOverride(agentOverrides, agent.name);
    if (override) {
      applyOverrides(agent, override);
    }
    return agent;
  });

  // 3. Create Orchestrator (with its own overrides)
  const orchestratorModel =
    getOverride(agentOverrides, "orchestrator")?.model ?? DEFAULT_MODELS["orchestrator"];
  const orchestrator = createOrchestratorAgent(orchestratorModel);
  applyDefaultPermissions(orchestrator);
  const oOverride = getOverride(agentOverrides, "orchestrator");
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
export function getAgentConfigs(config?: PluginConfig): Record<string, SDKAgentConfig> {
  const agents = createAgents(config);
  return Object.fromEntries(
    agents.map((a) => {
      const sdkConfig: SDKAgentConfig = { ...a.config, description: a.description };

      // Apply classification-based visibility and mode
      if (isSubagent(a.name)) {
        sdkConfig.mode = "subagent";
      } else if (a.name === "orchestrator") {
        sdkConfig.mode = "primary";
      }

      return [a.name, sdkConfig];
    })
  );
}
