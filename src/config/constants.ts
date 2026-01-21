// Agent names
export const SUBAGENT_NAMES = [
    "explorer",
    "librarian",
    "oracle",
    "designer",
    "fixer",
] as const;

export const ORCHESTRATOR_NAME = "orchestrator" as const;

export const ALL_AGENT_NAMES = [ORCHESTRATOR_NAME, ...SUBAGENT_NAMES] as const;

// Agent name type (for use in DEFAULT_MODELS)
export type AgentName = typeof ALL_AGENT_NAMES[number];

// Default models for each agent
export const DEFAULT_MODELS: Record<AgentName, string> = {
    orchestrator: "google/claude-opus-4-5-thinking",
    oracle: "openai/gpt-5.2-codex",
    librarian: "google/gemini-3-flash",
    explorer: "google/gemini-3-flash",
    designer: "google/gemini-3-flash",
    fixer: "google/gemini-3-flash",
};

// Polling configuration
export const POLL_INTERVAL_MS = 500;
export const POLL_INTERVAL_SLOW_MS = 1000;
export const POLL_INTERVAL_BACKGROUND_MS = 2000;

// Timeouts
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
export const MAX_POLL_TIME_MS = 5 * 60 * 1000; // 5 minutes

// Polling stability
export const STABLE_POLLS_THRESHOLD = 3;
