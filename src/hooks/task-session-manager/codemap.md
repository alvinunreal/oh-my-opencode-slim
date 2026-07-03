# src/hooks/task-session-manager/

## Responsibility

Manages V2 background job-board state for task execution and injected completion messages, enabling the orchestrator to track active jobs and reuse only completed, reconciled child sessions by short aliases (e.g., `exp-1`, `ora-2`). This module was recently split into three focused submodules to improve separation of concerns and maintainability.

## Design

The directory follows a **Facade + Strategy** pattern where `index.ts` acts as the facade that composes and orchestrates behavior across three specialized strategy modules:

- **index.ts**: Main facade that wires hooks into OpenCode's lifecycle and coordinates between the job board, pending calls, and task context tracking. Implements the plugin hook interface (`tool.execute.before`, `tool.execute.after`, `experimental.chat.messages.transform`, `event`).
- **pending-call-tracker.ts**: Tracks in-flight task calls using a capped ordered map (`MAX_PENDING_TASK_CALLS`) to correlate launch output safely. Provides call ID generation, storage, retrieval, and cleanup for pending task invocations.
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
   - Resolves reusable task IDs from the job board; if found, updates the task ID and marks it as used
   - If no reusable task exists, allows fresh task creation

2. **Task Launch (`tool.execute.after`)**
   - Registers task launches in the job board with task ID, parent session ID, agent type, and description
   - Parses task output to extract task ID, status, or launch information
   - Adds read context to the job board for completed or terminal unreconciled tasks
   - Handles late-cancelled tasks by normalizing output and updating state accordingly

3. **Context Tracking**
   - Extracts read files from `read` tool outputs using `extractReadFiles`
   - Stores context per task ID in the task context tracker
   - Prunes stale context during lifecycle events and status transitions

4. **Message Injection (`experimental.chat.messages.transform`)**
   - Injects a `### Background Job Board` section into user messages for managed sessions
   - Lists active, unreconciled, and reusable sessions
   - Remembers injected terminal jobs to reconcile them on parent idle events

5. **Lifecycle Events (`event`)**
   - `session.created`: Adds new task IDs to pending managed set
   - `session.idle` / `session.status` (idle): Reconciles injected terminal jobs for the parent session
   - `session.status` (busy): Marks sessions as running from live session state
   - `session.deleted`: Clears job state, child jobs, and pending call records for the session

### Data & Control Flow

```
User task call → tool.execute.before → PendingTaskCall created → task ID resolved/reused
→ tool.execute.after → BackgroundJobBoard.registerLaunch() → context extracted/added
→ Message transform → BackgroundJobBoard.formatForPrompt() injected into user message
→ session.idle → reconcileInjectedTerminalJobs() → BackgroundJobBoard.markReconciled()
```

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