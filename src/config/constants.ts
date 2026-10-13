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

// Workflow reminders
export const PHASE_REMINDER_TEXT = `!IMPORTANT! Scheduler workflow: pick the lightest workflow that fits. Delegate implementation to specialists; the orchestrator coordinates, verifies, and integrates. For delegated work: plan lanes → dispatch background specialists → track task IDs → await hook-driven completion → reconcile terminal results → verify. !END!`;

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

export const ORCHESTRATOR_FILE_OPERATIONS_RULES = `**File Operations Rules**:
- File-mutation tools (edit, write, apply_patch, ast_grep_replace) are denied to you by configuration; inspect and report, do not modify files.
- Prefer dedicated file tools for codebase inspection: glob/grep/ast_grep_search for discovery and read for file contents.
- Use bash for orchestration and verification only: git, package managers, tests, builds, diagnostics. Do not use bash to modify files (prompt-level rule, not SDK-enforced): no sed -i, no redirection into source files, no shell-native edits.
- Delegate every file change to @fixer (or @designer for UI work).`;

export const ORCHESTRATOR_FILE_OPERATIONS_RULES_MUTATORS_ALLOWED = `**File Operations Rules**:
- The file-mutation tools (edit, write, apply_patch, ast_grep_replace) have been explicitly re-allowed in configuration; delegation is still preferred for non-trivial implementation.
- Prefer dedicated file tools for codebase inspection: glob/grep/ast_grep_search for discovery and read for file contents.
- Use bash for orchestration and verification only: git, package managers, tests, builds, diagnostics. Do not use bash to modify files (prompt-level preference, not SDK-enforced): no sed -i, no redirection into source files, no shell-native edits.
- Prefer delegating file changes to @fixer (or @designer for UI work).`;

export const ORCHESTRATOR_DELEGATION_STATEMENT_DENIED = `Never implement directly: the file-mutation tools (edit, write, apply_patch, ast_grep_replace) are denied to you by configuration. Your direct work is orchestration only — planning, dispatch, reconciliation, verification, and integration (git, package managers, tests, builds, diagnostics via bash).`;

export const ORCHESTRATOR_DELEGATION_STATEMENT_ALLOWED = `The file-mutation tools (edit, write, apply_patch, ast_grep_replace) have been explicitly re-allowed in configuration. Prefer delegation for non-trivial implementation; direct edits are for one isolated, clear, low-risk action.`;

export const ORCHESTRATOR_ROUTING_THRESHOLD_DENIED = `Delegate all implementation work to specialists. You do not edit files yourself; file-mutation tools are denied by configuration.`;

export const ORCHESTRATOR_ROUTING_THRESHOLD_ALLOWED = `Prefer delegating implementation work to specialists; keep direct edits to one isolated, clear, low-risk action.`;

export const READONLY_FILE_OPERATIONS_RULES = `**File Operations Rules**:
- READ-ONLY: inspect and report; do not modify files.
- Prefer dedicated file tools for codebase inspection: glob/grep/ast_grep_search for discovery and read for file contents.
- Bash is allowed for non-mutating diagnostics and shell-native inspection when it is the clearest tool, but not for modifying files.
- Do not use cat/head/tail/sed/awk only to read code into context; use read/grep unless a shell pipeline is genuinely the better diagnostic.`;

export const NO_SHELL_READONLY_FILE_OPERATIONS_RULES = `**File Operations Rules**:
- READ-ONLY: inspect and report; do not modify files.
- Use glob/grep/ast_grep_search for discovery and read for file contents.
- Do not use bash or shell commands.`;

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

/** Title of smartfetch's temporary secondary-model sessions (v1 hosts). */
export const SMARTFETCH_SECONDARY_SESSION_TITLE = 'smartfetch-secondary';

export type ImageRouting = 'auto' | 'direct';

/** Permission keys that accept only a scalar action — never a pattern map.
 * Mirrors opencode's v1 permission config typing; enforced by the config
 * schema's refinement. */
export const STRING_ONLY_PERMISSION_KEYS = [
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'codesearch',
  'doom_loop',
] as const;

export function resolveImageRouting(
  imageRouting: ImageRouting | undefined,
  observerEnabled: boolean,
): ImageRouting {
  // Explicit value: use it
  if (imageRouting !== undefined) return imageRouting;
  // Legacy conditional: intercept only when observer is enabled
  return observerEnabled ? 'auto' : 'direct';
}
