import { z } from "zod";

// Agent override configuration (distinct from SDK's AgentConfig)
export const AgentOverrideConfigSchema = z.object({
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  prompt: z.string().optional(),
  prompt_append: z.string().optional(),
  disable: z.boolean().optional(),
});

// Tmux layout options
export const TmuxLayoutSchema = z.enum([
  "main-horizontal", // Main pane on top, agents stacked below
  "main-vertical",   // Main pane on left, agents stacked on right
  "tiled",           // All panes equal size grid
  "even-horizontal", // All panes side by side
  "even-vertical",   // All panes stacked vertically
]);

export type TmuxLayout = z.infer<typeof TmuxLayoutSchema>;

// Tmux integration configuration
export const TmuxConfigSchema = z.object({
  enabled: z.boolean().default(false),
  layout: TmuxLayoutSchema.default("main-vertical"),
  main_pane_size: z.number().min(20).max(80).default(60), // percentage for main pane
});

export type TmuxConfig = z.infer<typeof TmuxConfigSchema>;

export type AgentOverrideConfig = z.infer<typeof AgentOverrideConfigSchema>;

// MCP names
export const McpNameSchema = z.enum(["websearch", "context7", "grep_app"]);
export type McpName = z.infer<typeof McpNameSchema>;

// Main plugin config
export const PluginConfigSchema = z.object({
  agents: z.record(z.string(), AgentOverrideConfigSchema).optional(),
  disabled_agents: z.array(z.string()).optional(),
  disabled_mcps: z.array(z.string()).optional(),
  tmux: TmuxConfigSchema.optional(),
});

export type PluginConfig = z.infer<typeof PluginConfigSchema>;

// Agent names
export type AgentName =
  | "orchestrator"
  | "oracle"
  | "librarian"
  | "explore"
  | "frontend-ui-ux-engineer"
  | "scribe"
  | "multimodal-looker"
  | "code-simplicity-reviewer";

export const DEFAULT_MODELS: Record<AgentName, string> = {
  orchestrator: "google/claude-opus-4-5-thinking",
  oracle: "openai/gpt-5.2-codex",
  librarian: "google/gemini-3-flash",
  explore: "cerebras/zai-glm-4.6",
  "frontend-ui-ux-engineer": "google/gemini-3-flash",
  scribe: "cerebras/zai-glm-4.7",
  "multimodal-looker": "google/gemini-3-flash",
  "code-simplicity-reviewer": "google/claude-opus-4-5-thinking",
};
