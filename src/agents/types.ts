import type { AgentConfig } from "@opencode-ai/sdk";

export interface AgentDefinition {
  name: string;
  description?: string;
  config: AgentConfig;
}

export type PermissionValue = "ask" | "allow" | "deny";

export const PRIMARY_AGENT_NAMES = ["orchestrator"] as const;
export type PrimaryAgentName = (typeof PRIMARY_AGENT_NAMES)[number];

export const SUBAGENT_NAMES = ["explorer", "librarian", "oracle", "designer", "fixer"] as const;
export type SubagentName = (typeof SUBAGENT_NAMES)[number];

export type AgentName = PrimaryAgentName | SubagentName;

export function isSubagent(name: string): name is SubagentName {
  return (SUBAGENT_NAMES as readonly string[]).includes(name);
}

export function getSubagentNames(): SubagentName[] {
  return [...SUBAGENT_NAMES];
}
