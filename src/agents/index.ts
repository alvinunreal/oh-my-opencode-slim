import type { AgentConfig as SDKAgentConfig } from "@opencode-ai/sdk";
import { DEFAULT_MODELS, type AgentName, type PluginConfig, type AgentOverrideConfig } from "../config";
import { createOrchestratorAgent, type AgentDefinition } from "./orchestrator";
import { createOracleAgent } from "./oracle";
import { createLibrarianAgent } from "./librarian";
import { createExploreAgent } from "./explore";
import { createFrontendAgent } from "./frontend";
import { createScribeAgent } from "./scribe";
import { createMultimodalAgent } from "./multimodal";
import { createSimplicityReviewerAgent } from "./simplicity-reviewer";

export type { AgentDefinition } from "./orchestrator";

type AgentFactory = (model: string) => AgentDefinition;

function applyOverrides(agent: AgentDefinition, override: AgentOverrideConfig): void {
  if (override.model) agent.config.model = override.model;
  if (override.temperature !== undefined) agent.config.temperature = override.temperature;
  if (override.prompt) agent.config.system = override.prompt;
  if (override.prompt_append) {
    agent.config.system = `${agent.config.system}\n\n${override.prompt_append}`;
  }
}

type SubagentName = Exclude<AgentName, "orchestrator">;
type SubagentInfo = { factory: AgentFactory; shortDesc: string };

/** Short descriptions for each subagent (used in tool descriptions) */
export const SUBAGENT_INFO = {
  explore: { factory: createExploreAgent, shortDesc: "codebase grep" },
  librarian: { factory: createLibrarianAgent, shortDesc: "docs/GitHub" },
  oracle: { factory: createOracleAgent, shortDesc: "strategy" },
  "frontend-ui-ux-engineer": { factory: createFrontendAgent, shortDesc: "UI/UX" },
  scribe: { factory: createScribeAgent, shortDesc: "writes code/docs/tests" },
  "multimodal-looker": { factory: createMultimodalAgent, shortDesc: "image/visual analysis" },
  "code-simplicity-reviewer": { factory: createSimplicityReviewerAgent, shortDesc: "code review" },
} as const satisfies Record<SubagentName, SubagentInfo>;

/** Generate agent list string for tool descriptions */
export function getAgentListDescription(): string {
  return (Object.entries(SUBAGENT_INFO) as [SubagentName, SubagentInfo][])
    .map(([name, { shortDesc }]) => `${name} (${shortDesc})`)
    .join(", ");
}

/** Get list of agent names */
export function getAgentNames(): SubagentName[] {
  return Object.keys(SUBAGENT_INFO) as SubagentName[];
}

export function createAgents(config?: PluginConfig): AgentDefinition[] {
  const disabledAgents = new Set(config?.disabled_agents ?? []);
  const agentOverrides = config?.agents ?? {};

  // 1. Gather all sub-agent proto-definitions
  const protoSubAgents = (Object.entries(SUBAGENT_INFO) as [SubagentName, SubagentInfo][]).map(
    ([name, { factory }]) => factory(DEFAULT_MODELS[name])
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
  const orchestrator = createOrchestratorAgent(orchestratorModel, allSubAgents);
  const oOverride = agentOverrides["orchestrator"];
  if (oOverride) {
    applyOverrides(orchestrator, oOverride);
  }

  return [orchestrator, ...allSubAgents];
}

export function getAgentConfigs(config?: PluginConfig): Record<string, SDKAgentConfig> {
  const agents = createAgents(config);
  return Object.fromEntries(agents.map((a) => [a.name, a.config]));
}
