// Agent names
export const AGENT_ALIASES: Record<string, string> = {
  explore: 'explorer',
  // librarian merged into explorer; legacy config keys/prompts keep working.
  librarian: 'explorer',
  'frontend-ui-ux-engineer': 'designer',
};

/** Package/plugin id shared by the server entry and the TUI entries. */
export const PLUGIN_ID = 'oh-my-opencode-slim';

/** OpenCode built-in subagents slim replaces; disabled at runtime (#1582). */
export const BUILTIN_OPENCODE_SUBAGENTS_TO_DISABLE = [
  'general',
  'explore',
] as const;

export const SUBAGENT_NAMES = [
  'explorer',
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
  explorer: undefined,
  designer: undefined,
  fixer: undefined,
  observer: undefined,
  council: undefined,
  councillor: undefined,
};

// Workflow reminders
export const PHASE_REMINDER_TEXT = `!IMPORTANT! Scheduler workflow: pick the lightest workflow that fits. Direct work: execute and verify proportionately. Otherwise: plan lanes → dispatch background specialists → track task IDs → await hook-driven completion → reconcile terminal results → verify. !END!`;

export function formatSystemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

export const PHASE_REMINDER = formatSystemReminder(PHASE_REMINDER_TEXT);

export const WRITABLE_FILE_OPERATIONS_RULES = `**File Operations Rules**:
- Before destructive or broad shell operations, verify the target set and quote paths; dry-run first when practical.`;

export const READONLY_FILE_OPERATIONS_RULES = `**File Operations Rules**:
- READ-ONLY: inspect and report; do not modify files.`;

export const NO_SHELL_READONLY_FILE_OPERATIONS_RULES = `**File Operations Rules**:
- READ-ONLY: inspect and report; do not modify files.
- Do not use bash or shell commands.`;

// Toast duration (ms) used by all OMOS toasts
export const TOAST_DURATION_MS = 10_000;

/** Agents that are disabled by default. Users must explicitly enable them
 *  by removing from disabled_agents and configuring an appropriate model. */
export const DEFAULT_DISABLED_AGENTS: string[] = ['observer'];

// Background job defaults
export const DEFAULT_MAX_SESSIONS_PER_AGENT = 2;
/** Internal display cap for the per-session read-context path list. */
export const DEFAULT_CONTEXT_FILE_CAP = 8;

/** Shipped child-input wake kinds (#1504): permission off, question on. */
export const DEFAULT_CHILD_INPUT_WAKE_KINDS = {
  permission: false,
  question: true,
} as const;

/**
 * Maximum session metadata entries retained per plugin instance.
 * Prevents unbounded growth when session.deleted events are missed.
 * Oldest entries are evicted first when this threshold is reached.
 */
export const DEFAULT_MAX_SESSION_METADATA_ENTRIES = 1000;

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
