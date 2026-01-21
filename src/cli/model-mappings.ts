// Model mappings by provider priority
export const MODEL_MAPPINGS = {
  antigravity: {
    orchestrator: "google/claude-opus-4-5-thinking",
    oracle: "google/claude-opus-4-5-thinking",
    librarian: "google/gemini-3-flash",
    explorer: "google/gemini-3-flash",
    designer: "google/gemini-3-flash",
    fixer: "google/gemini-3-flash",
  },
  openai: {
    orchestrator: "openai/gpt-5.2-codex",
    oracle: "openai/gpt-5.2-codex",
    librarian: "openai/gpt-5.1-codex-mini",
    explorer: "openai/gpt-5.1-codex-mini",
    designer: "openai/gpt-5.1-codex-mini",
    fixer: "openai/gpt-5.1-codex-mini",
  },
  opencode: {
    orchestrator: "opencode/glm-4.7-free",
    oracle: "opencode/glm-4.7-free",
    librarian: "opencode/glm-4.7-free",
    explorer: "opencode/glm-4.7-free",
    designer: "opencode/glm-4.7-free",
  },
} as const;
