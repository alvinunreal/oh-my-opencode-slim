import type { AgentConfig as SDKAgentConfig } from "@opencode-ai/sdk";
import { DEFAULT_MODELS, type AgentName, type PluginConfig, type AgentOverrideConfig } from "../config";
import { createOrchestratorAgent, type AgentDefinition } from "./orchestrator";
import { createOracleAgent } from "./oracle";
import { createLibrarianAgent } from "./librarian";
import { createExploreAgent } from "./explore";
import { createFrontendAgent } from "./frontend";
import { createDocumentWriterAgent } from "./document-writer";
import { createMultimodalAgent } from "./multimodal";
import { createSimplicityReviewerAgent } from "./simplicity-reviewer";

export type { AgentDefinition } from "./orchestrator";

type AgentFactory = (model: string) => AgentDefinition;

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

type SubagentName = Exclude<AgentName, "orchestrator">;

/** Agent factories indexed by name */
const SUBAGENT_FACTORIES: Record<SubagentName, AgentFactory> = {
  explore: createExploreAgent,
  librarian: createLibrarianAgent,
  oracle: createOracleAgent,
  "frontend-ui-ux-engineer": createFrontendAgent,
  "document-writer": createDocumentWriterAgent,
  "multimodal-looker": createMultimodalAgent,
  "code-simplicity-reviewer": createSimplicityReviewerAgent,
};

/** Get list of agent names */
export function getAgentNames(): SubagentName[] {
  return Object.keys(SUBAGENT_FACTORIES) as SubagentName[];
}

export function createAgents(config?: PluginConfig): AgentDefinition[] {
  const disabledAgents = new Set(config?.disabled_agents ?? []);
  const agentOverrides = config?.agents ?? {};

  // 1. Gather all sub-agent proto-definitions
  const protoSubAgents = (Object.entries(SUBAGENT_FACTORIES) as [SubagentName, AgentFactory][]).map(
    ([name, factory]) => factory(DEFAULT_MODELS[name])
  );

  // 2. Apply common filtering and overrides
  const allSubAgents = protoSubAgents
    .filter((a) => !disabledAgents.has(a.name))
    .map((agent) => {
      const override = agentOverrides[agent.name];
      if (override) {
        applyOverrides(agent, override);
      }
      return agent;
    });

  // 3. Create Orchestrator (with its own overrides)
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
  return Object.fromEntries(agents.map((a) => [a.name, { ...a.config, description: a.description }]));
}
