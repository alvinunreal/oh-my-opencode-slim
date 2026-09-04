# src/utils/

## Responsibility

Centralized utilities and shared abstractions used across the oh-my-opencode-slim plugin. This folder provides:
- Background job lifecycle management (board + store + coordinator + supervisor)
- Live session-status reads and session metadata tracking
- In-process opencode client access and client call-shape contracts
- Environment and configuration utilities
- Type guards and validation helpers
- Session and timeout utilities for council dispatch
- Logging infrastructure with automatic rotation
- Task output parsing utilities
- System message utilities, agent-variant/model helpers, and platform compat

## Design

### Core Abstractions

- **BackgroundJobBoard** (`background-job-board.ts`): Singleton registry and lifecycle manager for background tasks spawned by sub-agents. Implements a reusable session pool pattern with automatic cleanup and reconciliation hooks. Tracks task state (running, stopped, completed, error, cancelled), maintains context files, and provides prompt-ready summaries for agent coordination. `stopped` records an ended runtime session without fabricated task success and is never reusable. Idle/absent observations start a 5s stop-confirmation grace (`stopConfirmationStartedAt`); live busy resets it. After a confirmed stop has been acknowledged, stale busy cannot reopen the job.

- **BackgroundJobStore** (`background-job-store.ts`): Atomic state-store contract (terminal transitions, leases, wall-clock deadline claims) implemented by the board; the single terminal-publication boundary.

- **BackgroundJobCoordinator** (`background-job-coordinator.ts`): Lifecycle policy layer between the board and its consumers — terminal-state subscriptions (replaces fire-and-forget), deferred-close policy, and prompt-metadata shaping.

- **BackgroundJobSupervisor** (`background-job-supervisor.ts`): One-shot wall-clock deadline supervision for background task runs: deadline timer → abort → grace timer → terminal finalization. Owns only timer/generation/abort mechanics.

- **BackgroundTaskConcurrency** (`background-task-concurrency.ts`): Process-local admission scheduler for native background tasks. Tracks queued tickets and active provider/model capacity without owning Job Board lifecycle state.

- **Runtime Session Status** (`session-runtime-status.ts`): Reads and validates the in-process OpenCode session-status map once per observation (5s bounded timeout). It distinguishes a valid absent session (`idle`) from malformed data or lookup failure (`unknown`) so lifecycle policy never treats schema drift as completion.

- **Session Metadata** (`session-metadata.ts`): `SessionMetadataStore` — bounded session → agent/directory map with LRU eviction that never evicts active orchestrator sessions.

- **Opencode Client** (`opencode-client.ts`): `getClient(input)` returns the in-process host client (no loopback HTTP, no caching).

- **Session Calls Contract** (`session-calls.contract.ts`): Type-only compile-time contract pinning the nested `{ path, query, body }` client call shapes and asserting the v2-flat shapes are rejected; compiled by `bun run typecheck`.

- **Prompt Agent** (`prompt-agent.ts`): Single source of truth for the `agent` field on plugin-initiated prompts. `resolveSessionAgent()` resolves the agent a session is running under (recorded hint → `session.get` → newest **user** message → fallback, only for a session confirmed/declared parentless) and `withAgent()` attaches it to a prompt body. An agent-less `session.prompt`/`promptAsync` body makes the runtime resolve its default primary and **permanently rewrite the session's agent** (`docs/agents/build-agent-empty-input-diagnosis.md`, probe A2), so `SYSTEM_AGENTS` (`compaction`/`summary`/`title`) are never derived, assistant messages are never trusted as hints, and plugin-created helper sessions use `FALLBACK_HELPER_SESSION_AGENT` (`build`) instead of `FALLBACK_TOP_LEVEL_AGENT` (`orchestrator`) so they are not adopted as managed orchestrator sessions. `prompt-agent.test.ts` scans all of `src/` and fails the build on any prompt call site that omits the field — with **no receiver-name filter**, since a `/session/i` heuristic previously hid `src/v2/client-shim.ts`'s own `s.prompt(` site (narrow, documented allowlists for the `promptWithTimeout` pass-through wrapper, the two v2 flat-host prompt files, and the type-only call contract). Probe reads accept an optional `directory` forwarded as `query.directory`, matching every other `session.get`/`session.messages` call site.

- **Session Error** (`session-error.ts`): Narrow classifiers for child-session errors — `isTransportError` (wire faults only: the 5 transport codes mirrored from `src/hooks/foreground-fallback/index.ts` plus a widened set of socket/undici codes, and the bare message phrasings copied verbatim from that file's `TRANSPORT_MESSAGE_PATTERNS`, with a drift test pinning the copy and asserting the extras stay disjoint from the mirror), `transportSessionErrorReason` (text that reports the outcome as UNKNOWN rather than failed, since a lost wire does not mean a dead child), `isAbortedSessionError` (`MessageAbortedError`), and `sessionErrorMessage`. Deliberately narrower than `isFailoverError`: rate limits and provider outages must stay real errors. The patterns are copied rather than imported because `src/utils` must not depend on `src/hooks`.

- **Logger** (`logger.ts`): File-based logging with 7-day retention, automatic directory creation, and write queuing. Logs are written to `~/.local/share/opencode/log/oh-my-opencode-slim.<sessionId>.log` and cleaned up on initialization.

- **Session Utilities** (`session.ts`): Timeout handling, session abort coordination, model reference parsing, and session content extraction. Provides `promptWithTimeout` and `extractSessionResult` for safe session operations.

- **Task Utilities** (`task.ts`): XML-inspired task output parsing for extracting task IDs, states, and results from tool output strings. Used for resumption and status tracking.

- **Type Guards** (`guards.ts`): Simple type checking utilities (`isRecord`) for runtime validation.

- **Environment Utilities** (`env.ts`): Environment variable parsing and plugin disable flag checking.

- **Internal Initiator** (`internal-initiator.ts`): Marker system for identifying internally-initiated agent messages to prevent infinite loops.

- **System Collapse** (`system-collapse.ts`): Utility for collapsing multiple system messages into a single entry by joining with double-newlines.

- **Agent Variant** (`agent-variant.ts`): `normalizeAgentName` (`@`-strip/trim) and `escapeRegExp` for display-name rewriting.

- **Councillor Models** (`councillor-models.ts`): Pure helpers resolving councillor model fallback chains without pulling zod/schema into runtime consumers.

- **Polling** (`polling.ts`): Generic `poll()` helper with interval/max-time/stable-threshold/abort options.

- **Compat & Zip** (`compat.ts`, `zip-extractor.ts`): `crossSpawn` (cross-platform spawn with stdout/stderr collection) and `extractZip` (Windows-aware tar/pwsh fallbacks).

- **Misc** (`escape-html.ts`, `frontmatter.ts`): HTML escaping (interview UI) and frontmatter parsing (interview documents).

### Design Patterns

- **Singleton**: BackgroundJobBoard is a singleton registry with global state for all background tasks
- **Strategy**: Task parsing adapts to multiple output formats (XML tags, plain text headers)
- **Observer**: Logger uses write queuing to avoid blocking the main thread
- **Utility**: Each utility module provides focused, composable functions

## Flow

### Background Job Lifecycle
1. Agent launches a background task via BackgroundJobBoard.registerLaunch() (supervisor arms the wall-clock deadline)
2. Task runs and updates status via BackgroundJobBoard.updateStatus()
3. On completion/error/cancellation, task is marked terminal and added to reusable pool; supervisor timers are cleared
4. Subsequent tasks from same agent/session can reuse completed sessions via aliases
5. Unused reusable sessions are automatically trimmed based on maxReusablePerAgent
6. A deadline exceeded while running → coordinator claims it, supervisor aborts the session, and a grace timer finalizes the terminal state

### Logging Flow
1. Plugin initializes logger with session ID via initLogger(sessionId)
2. Logs are appended to `~/.local/share/opencode/log/oh-my-opencode-slim.<sessionId>.log`
3. Old logs (>7 days) are automatically cleaned up on initialization
4. Log writes are queued to avoid blocking. File logging falls back to stderr after initialization failure or a write failure in the active generation; stale queued writes cannot replace a newer sink

### Session Operations
1. Council dispatch uses `promptWithTimeout()` to send prompts with configurable timeout
2. On timeout, session is aborted and OperationTimeoutError is thrown
3. Results are extracted via `extractSessionResult()` which collects all assistant message text

## Integration

### Consumers

- **Council Agents** (`src/agents/council.ts`, `src/agents/council-agents.ts`):
  - Uses BackgroundJobBoard for background task management
  - Uses session utilities for prompt timeout and session extraction
  - Uses logger for debug and audit logging

- **Multiplexer** (`src/multiplexer/`):
  - Uses session utilities for session operations
  - Uses logger for session lifecycle events

- **Agents** (`src/agents/`):
  - BackgroundJobBoard for launching and tracking background tasks
  - Logger for agent-specific logging

- **Main Plugin** (`src/index.ts`):
  - Exports all utilities via `src/utils/index.ts`
  - Uses logger for plugin lifecycle events

### Dependencies

- **Node.js built-ins**: `fs`, `fs/promises`, `os`, `path` for logging and file operations
- **@opencode-ai/sdk**: PluginInput type for session utilities

### Export Chain

`src/utils/index.ts` re-exports all utilities, providing a single entry point:
```typescript
export * from './agent-variant';
export * from './background-job-board';
export * from './background-job-coordinator';
export * from './background-job-store';
export * from './background-job-supervisor';
export * from './internal-initiator';
export { initLogger, log } from './logger';
export * from './polling';
export * from './session';
export * from './session-runtime-status';
export * from './task';
export { extractZip } from './zip-extractor';
```

This allows consumers to import from `src/utils` rather than individual files.
Session metadata, the opencode client accessor, the prompt-agent and
session-error helpers, and the type-only call-shape contract are intentionally
imported directly from their modules (not re-exported): prompt call sites
should name `src/utils/prompt-agent` explicitly so the regression scan and its
allowlist stay easy to audit.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Public API re-exporting most utilities |
| `agent-variant.ts` | Agent name normalization and regex escaping |
| `background-job-board.ts` | Background task registry and lifecycle manager |
| `background-job-coordinator.ts` | Lifecycle policy and terminal-state subscriptions |
| `background-job-store.ts` | Atomic store contract and terminal transitions |
| `background-job-supervisor.ts` | Wall-clock deadline supervision and abort grace |
| `compat.ts` | Cross-platform spawn with output collection |
| `councillor-models.ts` | Councillor model fallback chain helpers |
| `env.ts` | Environment variable utilities |
| `escape-html.ts` | HTML escaping helper |
| `frontmatter.ts` | Frontmatter parsing for interview documents |
| `guards.ts` | Type guard utilities |
| `internal-initiator.ts` | Internal agent message marker system |
| `logger.ts` | File-based logging with rotation |
| `opencode-client.ts` | In-process host client accessor |
| `polling.ts` | Generic poll helper |
| `prompt-agent.ts` | Resolves a session's current agent and attaches it to prompt bodies (prevents the default-`build` session rewrite); guarded by a repo-wide scan test |
| `session-calls.contract.ts` | Compile-time client call-shape contract (type-only) |
| `session-error.ts` | Transport-fault / abort / message classifiers for session errors |
| `session-metadata.ts` | Bounded session → agent/directory store |
| `session-runtime-status.ts` | Bounded live session-status map reads |
| `session.ts` | Session timeout, abort, and extraction utilities |
| `system-collapse.ts` | System message collapsing utility |
| `task.ts` | Task output parsing utilities |
| `zip-extractor.ts` | Cross-platform zip extraction |
