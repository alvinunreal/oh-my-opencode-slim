import { getOrchestratorPrompt } from "./prompts";
import type { AgentDefinition } from "./types";

export function createOrchestratorAgent(model: string): AgentDefinition {
  return {
    name: "orchestrator",
    config: {
      model,
      temperature: 0.1,
      prompt: getOrchestratorPrompt(),
    },
  };
}

