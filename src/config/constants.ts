// Polling configuration
export const POLL_INTERVAL_MS = 500;
export const POLL_INTERVAL_SLOW_MS = 1000;
export const POLL_INTERVAL_BACKGROUND_MS = 2000;
export const POLL_INTERVAL_TMUX_MS = 2000;

// Timeouts
export const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
export const MAX_POLL_TIME_MS = 5 * 60 * 1000; // 5 minutes
export const TMUX_SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Polling stability
export const STABLE_POLLS_THRESHOLD = 3;

// Agent Names
export const AGENT_ORCHESTRATOR = "orchestrator";

// Prompts & Reminders
export const PHASE_REMINDER_TEXT = `<reminder>⚠️ MANDATORY: Understand→DELEGATE(!)→Split-and-Parallelize(?)→Plan→Execute→Verify
Available Specialist: @oracle @librarian @explorer @designer @fixer
</reminder>`;

export const POST_READ_NUDGE_TEXT = "\n\n---\nConsider: splitting the task to parallelize, delegate to specialist(s). (if so, reference file paths/lines—don't copy file contents)";

export const READ_TOOLS = ["Read", "read"];

// TMUX Defaults
export const DEFAULT_TMUX_SERVER_URL = "http://localhost:4096";
export const DEFAULT_SUBAGENT_TITLE = "Subagent";

// Background Manager
export const BG_TASK_CANCEL_MSG = "Cancelled by user";
export const BG_TASK_ID_PREFIX = "bg_";
export const BG_SESSION_TITLE_PREFIX = "Background: ";
