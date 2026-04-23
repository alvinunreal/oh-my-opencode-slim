import { DEFAULT_AGENT_MCPS } from "../config/agent-mcps";
import { CUSTOM_SKILLS } from "./custom-skills";
import { RECOMMENDED_SKILLS } from "./skills";
import type { InstallConfig } from "./types";

const SCHEMA_URL =
  "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json";

// Model mappings by provider - only 4 supported providers
export const MODEL_MAPPINGS = {
  openai: {
    orchestrator: { model: "openai/gpt-5.5" },
    oracle: { model: "openai/gpt-5.5", variant: "high" },
    librarian: { model: "openai/gpt-5.4-mini", variant: "low" },
    explorer: { model: "openai/gpt-5.4-mini", variant: "low" },
    designer: { model: "openai/gpt-5.4-mini", variant: "medium" },
    fixer: { model: "openai/gpt-5.4-mini", variant: "low" },
  },
  kimi: {
    orchestrator: { model: "kimi-for-coding/k2p5" },
    oracle: { model: "kimi-for-coding/k2p5", variant: "high" },
    librarian: { model: "kimi-for-coding/k2p5", variant: "low" },
    explorer: { model: "kimi-for-coding/k2p5", variant: "low" },
    designer: { model: "kimi-for-coding/k2p5", variant: "medium" },
    fixer: { model: "kimi-for-coding/k2p5", variant: "low" },
  },
  copilot: {
    orchestrator: { model: "github-copilot/claude-opus-4.6" },
    oracle: { model: "github-copilot/claude-opus-4.6", variant: "high" },
    librarian: { model: "github-copilot/grok-code-fast-1", variant: "low" },
    explorer: { model: "github-copilot/grok-code-fast-1", variant: "low" },
    designer: {
      model: "github-copilot/gemini-3.1-pro-preview",
      variant: "medium",
    },
    fixer: { model: "github-copilot/claude-sonnet-4.6", variant: "low" },
  },
  "zai-plan": {
    orchestrator: { model: "zai-coding-plan/glm-5" },
    oracle: { model: "zai-coding-plan/glm-5", variant: "high" },
    librarian: { model: "zai-coding-plan/glm-5", variant: "low" },
    explorer: { model: "zai-coding-plan/glm-5", variant: "low" },
    designer: { model: "zai-coding-plan/glm-5", variant: "medium" },
    fixer: { model: "zai-coding-plan/glm-5", variant: "low" },
  },
} as const;

export function generateLiteConfig(
  installConfig: InstallConfig
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: SCHEMA_URL,
    preset: "openai",
    presets: {},
  };

  const createAgentConfig = (
    agentName: string,
    modelInfo: { model: string; variant?: string }
  ) => {
    const isOrchestrator = agentName === "orchestrator";

    const skills = isOrchestrator
      ? ["*"]
      : [
          ...RECOMMENDED_SKILLS.filter(
            (s) =>
              s.allowedAgents.includes("*") ||
              s.allowedAgents.includes(agentName)
          ).map((s) => s.skillName),
          ...CUSTOM_SKILLS.filter(
            (s) =>
              s.allowedAgents.includes("*") ||
              s.allowedAgents.includes(agentName)
          ).map((s) => s.name),
        ];

    if (agentName === "designer" && !skills.includes("agent-browser")) {
      skills.push("agent-browser");
    }

    return {
      model: modelInfo.model,
      variant: modelInfo.variant,
      skills,
      mcps:
        DEFAULT_AGENT_MCPS[agentName as keyof typeof DEFAULT_AGENT_MCPS] ?? [],
    };
  };

  const buildPreset = (mappingName: keyof typeof MODEL_MAPPINGS) => {
    const mapping = MODEL_MAPPINGS[mappingName];
    return Object.fromEntries(
      Object.entries(mapping).map(([agentName, modelInfo]) => [
        agentName,
        createAgentConfig(agentName, modelInfo),
      ])
    );
  };

  // Always use OpenAI as default
  (config.presets as Record<string, unknown>).openai = buildPreset("openai");

  if (installConfig.hasTmux) {
    config.tmux = {
      enabled: true,
      layout: "main-vertical",
      main_pane_size: 60,
    };
  }

  return config;
}
