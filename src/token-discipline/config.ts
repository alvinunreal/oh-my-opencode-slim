export const TOOL_CAPS = {
  bash: { maxLines: 250 },
  git_diff: { maxLines: 400 },
  git_log: { maxLines: 100 },
  file_read: { maxBytes: 12_288 },
  web_fetch: { maxBytes: 8_192 },
  context7: { maxBytes: 16_384 },
  grep_app: { maxResults: 200 },
} as const;

export const PACKET_CONSTRAINTS = {
  maxChars: 2_500,
  maxCodeLines: 20,
  maxTldrBullets: 3,
  maxEvidenceBullets: 5,
  maxActions: 5,
} as const;

export const MERGE_CONSTRAINTS = {
  maxPackets: 6,
  maxTldrBullets: 15,
  maxEvidence: 20,
  maxActions: 8,
} as const;

export const POINTER_CONSTRAINTS = {
  maxResolutionsPerTask: 3,
  resolutionMaxChars: 500,
} as const;

export const THREAD_CONSTRAINTS = {
  archiveHours: 24,
  cleanupIntervalHours: 6,
} as const;

export type AgentRole =
  | 'ORCHESTRATOR'
  | 'RESEARCHER'
  | 'REPO_SCOUT'
  | 'IMPLEMENTER'
  | 'VALIDATOR'
  | 'DESIGNER'
  | 'SUMMARIZER';

export const DEFAULT_MODEL_ASSIGNMENTS: Record<AgentRole, string> = {
  ORCHESTRATOR: 'kimi-for-coding/k2p5',
  RESEARCHER: 'openai/gpt-5.1-codex-mini',
  REPO_SCOUT: 'openai/gpt-5.1-codex-mini',
  IMPLEMENTER: 'openai/gpt-5.2-codex',
  VALIDATOR: 'openai/gpt-5.2-codex',
  DESIGNER: 'kimi-for-coding/k2p5',
  SUMMARIZER: 'openai/gpt-5.1-codex-mini',
};

export const ROLE_PRIORITY: Record<AgentRole, number> = {
  ORCHESTRATOR: 100,
  VALIDATOR: 80,
  IMPLEMENTER: 70,
  DESIGNER: 60,
  REPO_SCOUT: 50,
  RESEARCHER: 40,
  SUMMARIZER: 10,
};

/**
 * Get model for a role. Now just returns the default since config is handled elsewhere.
 * @deprecated Use getModelForAgent from config/model-helpers instead
 */
export async function getModelForRole(role: AgentRole): Promise<string> {
  return DEFAULT_MODEL_ASSIGNMENTS[role];
}
