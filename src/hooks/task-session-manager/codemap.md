# src/hooks/task-session-manager/

## Responsibility

Manages V2 background job-board state for task execution and injected completion messages, enabling the orchestrator to track active jobs and reuse only completed, reconciled child sessions by short aliases (e.g., `exp-1`, `ora-2`). The implementation is split into focused submodules to improve separation of concerns and maintainability.

## Design

The directory follows a **Facade + Strategy** pattern where `index.ts` acts as the facade that composes and orchestrates behavior across specialized strategy modules:

- **index.ts**: Main facade that wires hooks into OpenCode's lifecycle and coordinates between the job board, pending calls, task context tracking, and explicit user waits. Implements the plugin hook interface (`tool.execute.before`, `tool.execute.after`, `experimental.chat.messages.transform`, `event`) and exposes `beginUserWait()` to the `wait_for_user` tool. The board is machine-side only: this module never renders it.
  Historical-task recovery and injected completions admit already-managed parents
  regardless of agent name; stale Orchestrator mapping repair stays specific to
  Orchestrator turns and does not promote unmanaged Build/custom parents.
- **session-recovery.ts**: On-demand recovery of untracked host children: verifies parent/agent, triages v2 rounds by the `session.get` outcome/idleAt projection (successful rounds require readable answer text per incident 1115; textless failures and interruptions retain their host-proven terminal state, rounds without a terminal outcome are refused unless an explicit queued continuation adopts identity, partial or unverifiable evidence fails closed, and no round is imported as stopped on a guess), and imports terminal rows into the board.
- **Startup recovery** (`session-recovery.ts`): Restores persisted owned children independently of parent activity, with trusted delivery markers, run-fenced terminal correction, and explicit admission-slot release. Persisted idles pass the shared host parser/assistant attribution; assistant completion cannot extend the idle boundary. Delivery markers require a correlated terminal latest round, never just a later notification timestamp. Listing, shared single-flight session-info reads, and parent/child transcript waits have per-read deadlines (5s by default), so stalled candidates cannot block the rest or become terminal on timeout.
- **revived-run-tracker.ts**: Logs terminal notification transport acceptance and failure with the captured transport-attempt number (including late acceptance after a timeout), lease deferral, and once-only ownership release to the fallback publication wake.
- **Host transcript attribution**: Recovery and untracked status/result reads share `attributeHostRoundToTranscript` from `../../utils/child-transcript.ts`; newer assistant creation/completion invalidates an older host idle outcome, missing assistant timestamps fail closed, and explicit queued continuation can adopt a newer incomplete round without importing a terminal row. `hostRoundStateOf` and `composeHostRound` remain the parser/composer.
- **../../utils/background-job-terminal-gate.ts**: Shared execution/observation gate for every terminal publication. Runtime quiescence and attributable result evidence authorize one board commit; busy withdraws terminal publications. Grace, bounded retries and single-open reads are shared across adapters.
- **runtime-status-reconciliation.ts**: Observes retained rows for busy reopen, but inspects transcripts only for running rows or queued replies.
- **../../utils/background-job-board.ts**: The machine-side board. It is never rendered: it holds dedupe keys, aliases, stall state, generations, and terminal runs for the tools and observers to read.
- **input-wait-tracker.ts**: Provides the single `hasInputWait()` seam used by idle reconciliation and continuation evaluation. It combines local question/permission waits with the process-global explicit user-wait latch.
- **child-input-wait.ts**: Tracks pending child requests and formats their details/guidance for both wakes and `task_status`. V2 forms carry summaries and host-UI/wait/cancel guidance; v1 questions retain answer options.
- **continuation-model-selection.ts**: Normalizes current-session and chat-hook model shapes before forwarding runtime model and variant choices to idle continuation prompts.
- **pending-call-tracker.ts**: Capped `(parentSessionID, callID)` map shared by the v2 wrapper and after-hook. Records first input ids for fresh-run anchors; resumed calls bind their own observed input. Conflicting ids or multiple matching calls permanently invalidate every matching binding. V1 feeds `chat.message`; v2 captures in the awaited prompt hook before agent deferral. Amendment commits use the board's generation/revision fence only after host acceptance. See [diagnostic attribution](../../../docs/tools.md#diagnostic-attribution).
- **fallback-observation-transfer.ts**: Terminal-observation handoff
  (`createBackgroundFallbackHandoff`) for background children re-prompted by
  the foreground fallback — `prepare`/`admit`/`reject`/`settleUnresolved`
  brackets the re-prompt admission so the stop-evidence gate defers terminal
  publication until a delivery owner exists; unresolved outcomes convert the
  preparation into the owning run. V1 foreground children also use this handoff
  after a terminal failover error that is replayed.
- **same-provider-policy.ts**: Opt-in per-provider rewrite
  (`backgroundJobs.sameProviderPolicy: { <provider>: "foreground" }`)
  converting same-provider `background: true` task requests (including v2
  omitted-`background` calls, defaulted to true before this check) to the foreground
  path for shared single-runtime backends; fail-open on unknown model/provider.
- **task-context-tracker.ts**: Manages read context from child sessions with line-count and file caps. Stores context per task ID, provides pruning to prevent unbounded growth, and exposes `filterStaleContextFiles(directory, files)` for a bounded sync disk re-check (drops missing/unreadable/oversized/truncated, logs; per-file size cap + per-commit byte budget so validation cannot stall the session).

All modules depend on `BackgroundJobBoard` from `src/utils/background-job-board.ts` as the single source of truth for active jobs, terminal unreconciled jobs, reusable completed sessions, aliases, read context, and LRU caps. None of that state is rendered into a prompt.

### Key Abstractions

- **BackgroundJobBoard**: Central state store for task sessions (active, reusable, terminal unreconciled). Never rendered into a prompt.
- **PendingTaskCall**: Tracks in-flight task invocations with call ID, parent session ID, agent type, label, and optional resumed task ID.
- **ContextFile**: Represents read context from child sessions with path, line numbers, and last-read timestamp.
- **User wait**: Explicit text-only HITL latch armed by `wait_for_user` and released by a distinct real external user message.

## Flow

### Task Execution Lifecycle

1. **Before Execution (`tool.execute.before`)**
   - Intercepts `task` tool calls on managed sessions
   - Generates a task label from `description`/`prompt` via `deriveTaskSessionLabel`
   - Council seat-result assembly no longer lives here: it moved to
     `../council-seats/` (the `Seats:` line is rewritten by that seam's own
     hook before the task manager sees the prompt), so this hook is
     purely delegation bookkeeping
   - Creates a `PendingTaskCall` record with call ID, parent session ID, agent type, and label
   - Resolves reusable task IDs from the job board; completed/reconciled jobs
     are reusable by alias, while timed-out running jobs become recoverable
     only after a live busy signal confirms they are safe to resume
   - If no reusable task exists, allows fresh task creation
   - Refuses a brand-new spawn whose objective exactly matches an
     unreconciled terminal job from the same parent and agent (dispatch
     loop guard, #1070); a result-mode read after that job's
     completion (`lastUsedAt > completedAt`) authorizes the retry

2. **Task Launch (`tool.execute.after`)**
   - Registers task launches in the job board with task ID, parent session ID, agent type, and description
   - Parses task output to extract task ID, status, or launch information
   - Adds validated read context to the job board for completed or terminal unreconciled tasks
   - Handles late-cancelled tasks by normalizing output and updating state accordingly

3. **Context Tracking**
   - Extracts read files from `read` tool outputs using `extractReadFiles`
   - Stores context per task ID in the task context tracker
   - Prunes stale context during lifecycle events and status transitions
   - Both tool-execute-hooks commit sites validate the stored board contextFiles plus fresh tracker context via `filterStaleContextFiles` before `board.addContext`, so stale entries leave the board on the next commit (revived/index paths still unvalidated)

4. **Delivery Observation (`experimental.chat.messages.transform`)**
    - The job board is NEVER rendered into a prompt (issue #1647): there is no board part, no change-only digest, and no retained-board replay
    - Observes terminal deliveries already present in the parent's history and retires exactly the run they reported: the host's native `<subagent>` delivery (v2; exact metadata-free context header is parent, time and terminal-state fenced), the native synthetic `<task>` delivery (v1 and migrated history), the plugin's tagged `<completed-job>` push part (generation + terminal revision fenced), and the revived-run `<task>` notification. Processed synthetic occurrences skip result parsing only after unambiguous provenance matching; malformed-status diagnostics are deduplicated with a bounded set.
    - A text fallback recognizes the plugin's own delta bodies in wake parts (internal-initiator tagged), so model-authored text can never retire a record
    - A stale-terminal fallback retires a completed, error, or cancelled record once the parent demonstrably moved past the terminal report (a later parent turn); `stopped` records are excluded (recovery-wake ownership)
    - Reopen corrections (a reconciled job that reopened) are appended as one trailing volatile message pointing at `task_status`
    - On v1, a task failover error admitted for replay is shown as running in the request without changing stored parts; Slim's internal terminal deliveries are not rewritten.

5. **Lifecycle Events (`event`)**
    - `session.created`: Adds new task IDs to pending managed set. Early board registration claims a pending call only when it can be identified unambiguously: a unique child-session `title` match (the v2 host stamps `title = description` argument, additionally constrained to the child's agent) or a unique agent-type match among unmarked pendings **with no already-consumed same-agent call** — a no-title child arriving after a same-agent call's after-hook consumed its pending is treated as stale and never claims. Ambiguous, stale, or unattributable children get a placeholder `unattributed <agent> task` registration so task_status always resolves them; the owning `tool.execute.after` corrects the description. An already-registered child never fences a pending, and a pending's flags never cause `tool.execute.after` to drop the task ID parsed from its own output. On hosts that do not supply tool call IDs, `tool.execute.after` resolves identity via `takeByTaskID` — matching the task ID parsed from its own output against the pending the early registration claimed for that child — instead of guessing by insertion order among parallel calls; `take()` without a call ID only proceeds when exactly one pending exists for the parent. When neither identity source resolves but the call's own output carries a task ID, a guarded first-match drain fallback (`takeUnresolvedFirstMatch`) consumes the oldest eligible unmarked pending with a warning, so a parallel no-ID burst cannot strand unmarked pendings and poison the parent's future takes (a pending set consisting solely of marked pendings still refuses the fallback; each marked pending keeps its own owner-resolution path). Residual risk is bounded: unresolved-identity registrations (drain fallback and window-shifted sole takes, both flagged `identityUnresolved`) keep a generic description/objective — labels are never guessed; `resultSummary`/`taskID` always come from the call's own output. Admission tickets still bind to the registered task (fungible per agent/model bucket, totals correct; per-ticket attribution is unknowable in that window), and an evicted pending's ticket is released at eviction (pre-existing): capacity may under-count a still-running evicted task on no-ID hosts. Unattributed placeholder registrations whose owning after-hook never arrives may eventually be marked stopped by idle reconciliation and trigger the parent's stopped-job recovery wake, bounded by the two-wake no-progress cap.
    - `session.idle` / `session.status` (idle): Can run the opt-in continuation evaluator in the same idle cycle under its existing guards. Child idle is a stop candidate: the first observation stays provisional, and only a confirmed idle/absent after the 5s grace marks `stopped`
    - `session.status` (busy): Marks sessions as running from live session state and resets pending stop confirmation
    - `session.deleted`: Clears job state, child jobs, and pending call records for the session
    - `server.instance.disposed`: Clears generation-local state but leaves the
      shared pending calls and admission queue for the next generation

6. **Human-in-the-loop Waits**
   - `wait_for_user` calls the facade's `beginUserWait()` only after tool validation
   - The shared latch cancels pending continuation timers/reservations
   - Foreground-fallback replay provenance and shared fallback teardown state preserve the latch across plugin-manager recreation
   - Idle continuation remains suppressed until a distinct real user message arrives

### Fallback deferral

- A recoverable child `session.error` records a deferral before foreground fallback arms its delay. Both terminal-gate wiring sites include `hasDeferredError()` alongside pending handoffs; the production gate also checks the fallback manager's pending delay and in-flight work, so runtime polling, result retrieval, and delivery observation cannot publish the failed attempt while fallback remains pending.
- Child idle always schedules the deferred-error backstop, including for managed children; parent idle reconciliation cannot occupy that timer. It waits `idleReconcileDelayMs`, renews at most five times while fallback is in progress, then consumes the deferral before reconciliation. Pending fallback retries keep their timer without marking status uncertain.
- Live busy clears the deferral and timer. A final error or genuine deletion clears it before publication. Fallback deletion cleanup preserves or re-arms the backstop; parent invalidation cannot cancel it. Genuine session/parent cleanup and plugin disposal remove deferrals with their timers.
- The tracker flags admitted and unresolved-promoted fallback runs; external `register()` clears the flag. Plugin wiring uses pending/running fallback activity for v1 revive refusal. Verified cancellation remains allowed. v2 has no replay refusal and publishes unrecovered errors through the same backstop.
- Normal confirmed admission after a terminal failover error sends one queued internal `state="running"` notice per hop. It shares the terminal parent transport but takes no terminal lease and has no retry ladder. The result waits for its notice attempt to settle. `chat.message` treats the part as internal, and the delivery observer ignores its non-terminal state.

### Data & Control Flow

```
User task call → tool.execute.before → PendingTaskCall created → task ID resolved/reused
→ tool.execute.after → BackgroundJobBoard.registerLaunch() → context validated/added
→ terminal publication → one-shot push (rev>1 on v1: a <completed-job> delta;
  rev-1: the host's native notifier)
→ Message transform → observed delivery (native / tagged push / revived notice)
  → BackgroundJobBoard.markReconciled()
→ opt-in continuation evaluator (same idle cycle, existing guards)
```

## Integration

### Consumers

- **Main Plugin (`src/index.ts`)**: Wires the task session manager hook into OpenCode's lifecycle via `createTaskSessionManagerHook()`.

### Dependencies

- **BackgroundJobBoard** (`src/utils/background-job-board.ts`): Central state store for task sessions and context.
- **Task Output Parsing Utilities** (`src/utils/index.ts`): `parseTaskIdFromTaskOutput`, `parseTaskLaunchOutput`, `parseTaskStatusOutput`, `deriveTaskSessionLabel`.
- **Guards & Logger**: `isRecord` utility and `log` for diagnostics.

### Configuration & Caps

- `maxSessionsPerAgent`: Limits reusable sessions per agent type (LRU eviction)
- Read-context list: path-only, deduped per path, internal display cap (8) with a `(+N more)` tail; informational only
- `shouldManageSession`: Predicate to determine which sessions are managed by this hook

### Events & Hooks

- `tool.execute.before` / `tool.execute.after`: Intercept task tool calls and register launches/status
- `experimental.chat.messages.transform`: Observe terminal deliveries in the parent history (no board render)
- `event`: Handle session lifecycle events (created, idle, busy, error, deleted)

## Module Decomposition Rationale

The original monolithic module was split to improve:
- **Separation of Concerns**: Pending calls, task context, and job board state are now distinct responsibilities.
- **Testability**: Each module can be tested in isolation with focused contracts.
- **Maintainability**: Changes to one concern (e.g., context tracking) do not affect unrelated logic.
- **Scalability**: Capped data structures prevent unbounded memory growth.

Each submodule adheres to the **Single Responsibility Principle** while collaborating through the facade to provide a cohesive user experience.
