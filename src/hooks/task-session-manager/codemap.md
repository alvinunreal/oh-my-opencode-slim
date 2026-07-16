# src/hooks/task-session-manager/

## Responsibility

Manages V2 background job-board state for task execution and injected completion messages, enabling the orchestrator to track active jobs and reuse only completed, reconciled child sessions by short aliases (e.g., `exp-1`, `ora-2`). This module was recently split into three focused submodules to improve separation of concerns and maintainability.

## Design

The directory follows a **Facade + Strategy** pattern where `index.ts` acts as the facade that composes and orchestrates behavior across three specialized strategy modules:

- **index.ts**: Main facade that wires hooks into OpenCode's lifecycle and coordinates between the job board, pending calls, and task context tracking. Implements the plugin hook interface (`tool.execute.before`, `tool.execute.after`, `experimental.chat.messages.transform`, `event`). Accepts `wasFallbackRecent`, `isFallbackInProgress`, and `onJobTerminal` callbacks for coordination with `foreground-fallback`.
- **pending-call-tracker.ts**: Tracks in-flight task calls using a capped ordered map (`MAX_PENDING_TASK_CALLS`) to correlate launch output safely. Provides call ID generation, storage, `findByParent`, `peekByParent` (used for early `session.created` registration, issue #765), and cleanup.
- **task-context-tracker.ts**: Manages read context from child sessions with line-count and file caps. Stores context per task ID and provides pruning to prevent unbounded growth.

All modules depend on `BackgroundJobBoard` from `src/utils/background-job-board.ts` as the single source of truth for active jobs, terminal unreconciled jobs, reusable completed sessions, aliases, read context, and LRU caps.

### Key Abstractions

- **BackgroundJobBoard**: Central state store for task sessions (active, reusable, terminal unreconciled).
- **PendingTaskCall**: Tracks in-flight task invocations with call ID, parent session ID, agent type, label, and optional resumed task ID.
- **ContextFile**: Represents read context from child sessions with path, line numbers, and last-read timestamp.

## Flow

### Task Execution Lifecycle

1. **Before Execution (`tool.execute.before`)**
   - Intercepts `task` tool calls on managed sessions
   - Generates a task label from `description`/`prompt` via `deriveTaskSessionLabel`
   - Creates a `PendingTaskCall` record with call ID, parent session ID, agent type, and label
   - Resolves reusable task IDs from the job board; completed/reconciled jobs
     are reusable by alias, while timed-out running jobs become recoverable
     only after a live busy signal confirms they are safe to resume
   - If no reusable task exists, allows fresh task creation

2. **Task Launch (`tool.execute.after`)**
   - Registers task launches in the job board with task ID, parent session ID, agent type, and description
   - Parses task output to extract task ID, status, or launch information
   - Suppresses spurious cancelled/error status within the fallback grace window (issue #765)
   - Adds read context to the job board for completed or terminal unreconciled tasks
   - Handles late-cancelled tasks by normalizing output and updating state accordingly
   - Fires `onJobTerminal` when a task reaches a terminal state

3. **Context Tracking**
   - Extracts read files from `read` tool outputs using `extractReadFiles`
   - Stores context per task ID in the task context tracker
   - Prunes stale context during lifecycle events and status transitions

4. **Message Injection (`experimental.chat.messages.transform`)**
   - Injects a `<system-reminder>` part containing the `### Background Job Board` section into user messages for managed sessions
   - Updates existing board parts in-place (replaces text on existing synthetic parts rather than creating duplicates)
   - Lists active, unreconciled, and reusable sessions
   - Remembers injected terminal jobs to reconcile them on parent idle events
   - Fires `onJobTerminal` when an injected completion makes a job terminal

5. **Lifecycle Events (`event`)**
   - `session.created`: Adds new task IDs to pending managed set; performs early board registration via `peekByParent` when a `parentID` is present (issue #765)
   - `session.idle` / `session.status` (idle): Reconciles injected terminal jobs for the parent session; skips idle reconciliation when `isFallbackInProgress`; fires `onJobTerminal` for terminal jobs
   - `session.status` (busy): Marks sessions as running from live session state
   - `session.status` (injected completion): Suppresses cancelled/error status within the fallback grace window; fires `onJobTerminal` for terminal state transitions
   - `session.deleted`: Clears job state, child jobs, pending call records, and `terminalJobNotified` entries
   - Phantom job cleanup: When `isFallbackInProgress`, drops the single phantom running job (exactly one other running job for the parent) during `session.created` nets

### Data & Control Flow

```
User task call → tool.execute.before → PendingTaskCall created → task ID resolved/reused
→ session.created → early board registration via peekByParent (issue #765)
→ tool.execute.after → BackgroundJobBoard.registerLaunch() → context extracted/added
    │  (suppress cancelled/error within fallback grace window)
    └─ onJobTerminal(parentSessionID) if terminal
→ Message transform → BackgroundJobBoard.formatForPrompt() injected as a system-reminder message part
    │  (update existing board parts in-place; fire onJobTerminal for new terminals)
→ session.idle → reconcileInjectedTerminalJobs() → BackgroundJobBoard.markReconciled()
    │  (skip if isFallbackInProgress; fire onJobTerminal)
→ session.deleted → cleanup all per-session state
```

### Fallback Coordination (issue #765)
The hook coordinates with `foreground-fallback` via three callbacks:
1. **`isFallbackInProgress(sessionID)`**: When true, idle events for the parent and children are skipped, and phantom jobs are cleaned up during `session.created` nets
2. **`wasFallbackRecent(sessionID)`**: When true (within 5s of `markFallbackDone`), cancelled/error status updates from the abort are suppressed in both injected-completion and `tool.execute.after` paths — the job stays running so the genuine fallback-response idle can reconcile it
3. **`onJobTerminal(parentSessionID)`**: Fires when a background job reaches terminal state via injected completion, `tool.execute.after`, or `session.idle` reconciliation — prompts the parent orchestrator with `(Background job completed.)` so it re-evaluates even when no child idle fires

## Integration

### Consumers

- **Main Plugin (`src/index.ts`)**: Wires the task session manager hook into OpenCode's lifecycle via `createTaskSessionManagerHook()`.

### Dependencies

- **BackgroundJobBoard** (`src/utils/background-job-board.ts`): Central state store for task sessions and context.
- **Task Output Parsing Utilities** (`src/utils/index.ts`): `parseTaskIdFromTaskOutput`, `parseTaskLaunchOutput`, `parseTaskStatusOutput`, `deriveTaskSessionLabel`.
- **Guards & Logger**: `isRecord` utility and `log` for diagnostics.

### Configuration & Caps

- `maxSessionsPerAgent`: Limits reusable sessions per agent type
- `readContextMinLines`: Minimum lines to include in read context
- `readContextMaxFiles`: Maximum files to include in read context
- `shouldManageSession`: Predicate to determine which sessions are managed by this hook
- `wasFallbackRecent?`: Callback to check if a fallback re-prompt was accepted within the grace window (5s). When true, cancelled/error status updates are suppressed (issue #765)
- `isFallbackInProgress?`: Callback to check if a session is mid-fallback. When true, idle events are skipped and phantom jobs are cleaned up
- `onJobTerminal?`: Callback fired when a background job reaches a terminal state; nudges the parent orchestrator via `promptAsync` to re-evaluate

### Events & Hooks

- `tool.execute.before` / `tool.execute.after`: Intercept task tool calls and register launches/status
- `experimental.chat.messages.transform`: Inject background job board status into user messages
- `event`: Handle session lifecycle events (created, idle, busy, error, deleted)

## Module Decomposition Rationale

The original monolithic module was split to improve:
- **Separation of Concerns**: Pending calls, task context, and job board state are now distinct responsibilities.
- **Testability**: Each module can be tested in isolation with focused contracts.
- **Maintainability**: Changes to one concern (e.g., context tracking) do not affect unrelated logic.
- **Scalability**: Capped data structures prevent unbounded memory growth.

Each submodule adheres to the **Single Responsibility Principle** while collaborating through the facade to provide a cohesive user experience.
