// Agent names
export const AGENT_ALIASES: Record<string, string> = {
  explore: 'explorer',
  'frontend-ui-ux-engineer': 'designer',
};

export const SUBAGENT_NAMES = [
  'explorer',
  'librarian',
  'oracle',
  'designer',
  'fixer',
  'observer',
  'council',
  'councillor',
] as const;

export const ALL_AGENT_NAMES = ['orchestrator', ...SUBAGENT_NAMES] as const;

// Agent name type (for use in DEFAULT_MODELS)
export type AgentName = (typeof ALL_AGENT_NAMES)[number];

/** Agents that cannot be disabled even if listed in disabled_agents config. */
export const PROTECTED_AGENTS = new Set(['orchestrator', 'councillor']);

/**
 * Default models for each agent.
 * All set to undefined so agents follow the global/session model.
 * Users can override per-agent via oh-my-opencode-ultraslim.json agents.<name>.model.
 */
export const DEFAULT_MODELS: Record<AgentName, string | undefined> = {
  orchestrator: undefined,
  oracle: undefined,
  librarian: undefined,
  explorer: undefined,
  designer: undefined,
  fixer: undefined,
  observer: undefined,
  council: undefined,
  councillor: undefined,
};

// Polling configuration
export const POLL_INTERVAL_MS = 500;
export const POLL_INTERVAL_BACKGROUND_MS = 2000;

// Timeouts
export const MAX_POLL_TIME_MS = 5 * 60 * 1000; // 5 minutes

// Subagent depth limits
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3;

// Workflow reminders
export const PHASE_REMINDER_TEXT = `!IMPORTANT! Dispatcher workflow: Parse → Plan (delegate to @oracle) → Dispatch → Verify (run tests yourself) → Reconcile. You are a pure dispatcher — never write code, never plan architecture, never research. Delegate all thinking to specialists. After 3 fixer failures on the same issue, escalate to @oracle. !END!`;

export function formatSystemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

export const PHASE_REMINDER = formatSystemReminder(PHASE_REMINDER_TEXT);

export const WRITABLE_FILE_OPERATIONS_RULES = `**File Operations Rules**:
- Prefer dedicated file tools for normal code work: glob/grep/ast_grep_search for discovery, read for file contents, and edit/write/apply_patch for targeted source changes.
- Use bash for execution and automation: git, package managers, tests, builds, scripts, diagnostics, and shell-native filesystem operations.
- Shell is acceptable for bulk or mechanical filesystem changes when it is clearer or safer than many individual edits (for example: truncate generated logs, remove build artifacts, batch rename/move files), especially when the user explicitly asks for that shell operation.
- Before destructive or broad shell operations, verify the target set and quote paths. Prefer a dry-run/listing first when practical.
- Do not use cat/head/tail/sed/awk only to read code into context; use read/grep unless a shell pipeline is genuinely the better diagnostic.`;

export const READONLY_FILE_OPERATIONS_RULES = `**File Operations Rules**:
- READ-ONLY: inspect and report; do not modify files.
- Prefer dedicated file tools for codebase inspection: glob/grep/ast_grep_search for discovery and read for file contents.
- Bash is allowed for non-mutating diagnostics and shell-native inspection when it is the clearest tool, but not for modifying files.
- Do not use cat/head/tail/sed/awk only to read code into context; use read/grep unless a shell pipeline is genuinely the better diagnostic.`;

export const NO_SHELL_READONLY_FILE_OPERATIONS_RULES = `**File Operations Rules**:
- READ-ONLY: inspect and report; do not modify files.
- Use glob/grep/ast_grep_search for discovery and read for file contents.
- Do not use bash or shell commands.`;

export const VERIFICATION_FILE_OPERATIONS_RULES = `**File Operations Rules**:
- You are a dispatcher, not an implementer. Do NOT use edit/write/apply_patch to modify source files.
- Use bash for verification only: running tests, builds, linters, and diagnostics.
- Use glob/grep/ast_grep_search for codebase discovery and read for file contents.
- Shell is allowed for: git operations, package managers (bun/npm), test runners, build commands, and diagnostic scripts.
- Do NOT use cat/head/tail/sed/awk only to read code into context; use read/grep unless a shell pipeline is genuinely the better diagnostic.`;

// Tmux pane spawn delay (ms) - gives TmuxSessionManager time to create pane
export const TMUX_SPAWN_DELAY_MS = 500;

// Stagger delay (ms) between parallel councillor launches to avoid tmux collisions
export const COUNCILLOR_STAGGER_MS = 250;

// Polling stability
export const STABLE_POLLS_THRESHOLD = 3;

/** Agents that are disabled by default. Users must explicitly enable them
 *  by removing from disabled_agents and configuring an appropriate model. */
export const DEFAULT_DISABLED_AGENTS: string[] = ['observer'];
