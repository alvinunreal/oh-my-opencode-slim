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

export const AGENT_THEME_COLORS = [
  'primary',
  'secondary',
  'accent',
  'success',
  'warning',
  'error',
  'info',
] as const;

export type AgentThemeColor = (typeof AGENT_THEME_COLORS)[number];

/** Theme-aware colors used for built-in agents unless users override them. */
export const DEFAULT_AGENT_COLORS: Record<AgentName, AgentThemeColor> = {
  orchestrator: 'primary',
  explorer: 'info',
  librarian: 'secondary',
  oracle: 'accent',
  designer: 'success',
  fixer: 'warning',
  observer: 'info',
  council: 'accent',
  councillor: 'accent',
};

/** Agents that cannot be disabled even if listed in disabled_agents config. */
export const PROTECTED_AGENTS = new Set(['orchestrator', 'councillor']);

/**
 * Default models for each agent.
 * All set to undefined so agents follow the global/session model.
 * Users can override per-agent via oh-my-opencode-slim.json agents.<name>.model.
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

// Workflow reminders
export const PHASE_REMINDER_TEXT = `!IMPORTANT! Scheduler workflow: First choose the lightest workflow that fits the work. If direct execution is justified, complete it and verify proportionately. Otherwise: plan lanes/dependencies → dispatch background specialists → track task IDs → wait for hook-driven completion → reconcile terminal results → verify. !END!`;

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

// Polling stability
export const STABLE_POLLS_THRESHOLD = 3;

// Toast duration (ms) used by all OMOS toasts
export const TOAST_DURATION_MS = 10_000;

/** Agents that are disabled by default. Users must explicitly enable them
 *  by removing from disabled_agents and configuring an appropriate model. */
export const DEFAULT_DISABLED_AGENTS: string[] = ['observer'];

// Background job defaults
export const DEFAULT_MAX_SESSIONS_PER_AGENT = 2;
export const DEFAULT_MAX_CONTEXT_LINES = 50_000;
export const DEFAULT_READ_CONTEXT_MIN_LINES = 10;
export const DEFAULT_READ_CONTEXT_MAX_FILES = 8;
export const DEFAULT_MAX_RETAINED_SNAPSHOTS = 20;

/**
 * Maximum session metadata entries retained per plugin instance.
 * Prevents unbounded growth when session.deleted events are missed.
 * Oldest entries are evicted first when this threshold is reached.
 */
export const DEFAULT_MAX_SESSION_METADATA_ENTRIES = 1000;

export type ImageRouting = 'auto' | 'direct';

export function resolveImageRouting(
  imageRouting: ImageRouting | undefined,
  observerEnabled: boolean,
): ImageRouting {
  // Explicit value: use it
  if (imageRouting !== undefined) return imageRouting;
  // Legacy conditional: intercept only when observer is enabled
  return observerEnabled ? 'auto' : 'direct';
}
