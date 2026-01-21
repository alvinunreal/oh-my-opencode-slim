import type { AgentConfig as SDKAgentConfig } from "@opencode-ai/sdk";
import { DEFAULT_MODELS, type PluginConfig, type AgentOverrideConfig } from "../config";
import { createOrchestratorAgent } from "./orchestrator";
import { 
  AgentDefinition, 
  SubagentName, 
  SUBAGENT_NAMES, 
  isSubagent,
  getSubagentNames
} from "./types";
export { 
  AgentDefinition, 
  SubagentName, 
  SUBAGENT_NAMES, 
  isSubagent,
  getSubagentNames
} from "./types";
import * as prompts from "./prompts";

function applyOverrides(agent: AgentDefinition, override: AgentOverrideConfig): void {
  if (override.model) agent.config.model = override.model;
  if (override.temperature !== undefined) agent.config.temperature = override.temperature;
  if (override.prompt) agent.config.prompt = override.prompt;
  if (override.prompt_append) {
    agent.config.prompt = `${agent.config.prompt}\n\n${override.prompt_append}`;
  }
}

type PermissionValue = "ask" | "allow" | "deny";

function applyDefaultPermissions(agent: AgentDefinition): void {
  const existing = (agent.config.permission ?? {}) as Record<string, PermissionValue>;
  agent.config.permission = { ...existing, question: "allow" } as SDKAgentConfig["permission"];
}

/** Get list of agent names */
export function getAgentNames(): SubagentName[] {
  return [...SUBAGENT_NAMES];
}

/** generic factory for subagents */
function createSubagent(name: SubagentName, model: string): AgentDefinition {
  const promptKey = `${name.toUpperCase()}_PROMPT` as keyof typeof prompts;
  const descriptionKey = `${name.toUpperCase()}_DESCRIPTION` as keyof typeof prompts;
  
  return {
    name,
    description: prompts[descriptionKey] as string,
    config: {
      model,
      temperature: name === "designer" ? 0.7 : 0.1,
      prompt: prompts[promptKey] as string,
    },
  };
}

export function createAgents(config?: PluginConfig): AgentDefinition[] {
  const disabledAgents = new Set(config?.disabled_agents ?? []);
  const agentOverrides = config?.agents ?? {};

  // 1. Gather all sub-agent proto-definitions
  const allSubAgents = SUBAGENT_NAMES
    .filter(name => !disabledAgents.has(name))
    .map(name => {
      const override = agentOverrides[name];
      const model = override?.model ?? DEFAULT_MODELS[name];
      const agent = createSubagent(name, model);
      if (override) {
        applyOverrides(agent, override);
      }
      return agent;
    });

  // 2. Create Orchestrator (with its own overrides)
  const orchestratorModel =
    agentOverrides["orchestrator"]?.model ?? DEFAULT_MODELS["orchestrator"];
  const orchestrator = createOrchestratorAgent(orchestratorModel);
  applyDefaultPermissions(orchestrator);
  const oOverride = agentOverrides["orchestrator"];
  if (oOverride) {
    applyOverrides(orchestrator, oOverride);
  }

  return [orchestrator, ...allSubAgents];
}

export function getAgentConfigs(config?: PluginConfig): Record<string, SDKAgentConfig> {
  const agents = createAgents(config);
  return Object.fromEntries(
    agents.map((a) => {
      const sdkConfig: SDKAgentConfig = { ...a.config, description: a.description };

      // Apply classification-based visibility and mode
      if (isSubagent(a.name)) {
        sdkConfig.mode = "subagent";
        sdkConfig.hidden = true;
      } else if (a.name === "orchestrator") {
        sdkConfig.mode = "primary";
      }

      return [a.name, sdkConfig];
    })
  );
}
