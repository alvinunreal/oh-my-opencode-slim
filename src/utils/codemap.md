# src/utils/

## Responsibility

Centralized utilities and shared abstractions used across the oh-my-opencode-slim plugin. This folder provides:

- **Background Job Lifecycle Management**: Singleton registry, lifecycle management, persistence, and supervision for background tasks spawned by sub-agents
- **Session Management**: Session status tracking, metadata, selection, and timeout/abort utilities
- **Background Task Concurrency**: Process-local admission scheduler for native background task launches
- **Evidence & Transcript Handling**: Child session transcript evidence extraction, terminal evidence verification, and session info reads
- **Projection & State Management**: TUI projection for sidebar state from board records
- **Infrastructure Utilities**: Logging with rotation, environment parsing, configuration, type guards, validation, and global store patterns
- **Platform Compatibility**: Cross-platform spawn, zip extraction, and native runtime probes
- **Data Processing & Security**: Secret redaction, XML/HTML escaping, frontmatter parsing, and task output parsing

## Design

### Core Abstractions

- **BackgroundJobBoard** (`background-job-board.ts`): Singleton registry and lifecycle manager for background tasks with reusable session pool patterns, automatic cleanup, and reconciliation hooks. Also owns the terminal-outcome subscription fan-out, launch-identity projection, and the process-local lifecycle ledger (tombstones, deletion epochs, suppression write-through). The board is never rendered: records retain run/activity/publication fences and observed status, not render-age or generic update timestamps.
- **BackgroundJobSupervisor** (`background-job-supervisor.ts`): One-shot wall-clock watchdog with timer/generation/abort mechanics; on expiry it aborts the child through the same lease-guarded host primitive `task_cancel` uses and never publishes a terminal itself
- **BackgroundTaskConcurrency** (`background-task-concurrency.ts`): Process-local admission scheduler for native background task launches with model/provider capacity tracking
- **Runtime Session Status** (`session-runtime-status.ts`): Reads and validates the in-process OpenCode session-status map with absent/unknown distinction; reduces the `session.get` outcome/idleAt projection to terminal/pending/unknown verdicts for v2 recovery triage (`hostRoundStateOf`), and classifies one live session for a probe (`classifyLiveSession`: `running`/`idle`/an attributable host terminal outcome read through a bounded, timer-injectable shared host read on hosts without the map).
- **Session Info Read** (`session-info-read.ts`): Single-flight raw `session.get` per client session domain and task id, shared by the probe, the ownership gate, and the gate's rehydration observer; a consumer deadline releases only its waiter, never the underlying read, and a differing identity is refused while the read is open (`raceEvidenceDeadline` bounds waits deterministically).
- **Session Metadata** (`session-metadata.ts`): Bounded session → agent/directory map with LRU eviction and active orchestrator protection
- **Session Selection** (`session-selection.ts`): Session selection resolution with provenance tracking (host-persisted, observed-external, unknown)
- **Child Transcript** (`child-transcript.ts`): Child session transcript evidence extraction and terminal evidence classification; the startup-only historical idle classifier complements on-demand host-outcome attribution. Shared latest-input/text helpers reject malformed history rather than skipping it.
- **Host Transcript Attribution** (`child-transcript.ts`, `attributeHostRoundToTranscript`): Validates parsed host terminal evidence against assistant creation/completion after the latest delivered input; newer activity stays pending and unreadable timestamps stay unknown. Recovery and untracked reads retain the shared host-round parser/composer.
- **BackgroundJobTerminalGate** (`background-job-terminal-gate.ts`): Terminal evidence verification with host outcome attribution, evidence deadlines, and reading leases
- **BackgroundJobPersistence** (`background-job-persistence.ts`): Persistence layer for lifecycle state with tombstone and epoch tracking across host restarts
- **BackgroundJobFixture** (`background-job-fixture.ts`): Test-only board fixtures for adapter/state-machine tests (not for production)
- **TestTimers** (`test-timers.ts`): Test-only deterministic timer harness (manual clock, injected `setTimeout`/`clearTimeout` seams, zero-duration `tick` drain); wire into timer-seam components, see AGENTS.md "Test Time"
- **TUI Reusable Projection** (`tui-reusable-projection.ts`): Board → tui-state projection for sidebar reusable dot display
- **JSDOM Probe** (`jsdom.ts`): JSDOM runtime detection without making it a prerequisite
- **Redact** (`redact.ts`): Shape-based secret redaction for logging and task output structure masking

### Session & Task Utilities

- **Session** (`session.ts`): Timeout handling, session abort coordination, and model reference parsing
- **Prompt Agent** (`prompt-agent.ts`): Resolves explicit v1 prompt identity from safe hints, session records, or a bounded user-message tail; rejects internal system agents and suppresses unresolved targets. `withAgent` never constructs an agent-less body; the adjacent test scans v1 prompt call sites.
- **Task** (`task.ts`): XML-inspired task output parsing for extracting task IDs, states, and results from tool output strings
- **Agent Variant** (`agent-variant.ts`): Agent name normalization (trim/@ prefix) and display name rewriting utilities

### Infrastructure & Security Utilities

- **Logger** (`logger.ts`): Process-wide file logging (one pid-suffixed file per process) with 7-day retention, directory creation, and write queuing
- **Environment** (`env.ts`): Environment variable parsing and plugin disable flag checking
- **Global Store** (`global-store.ts`): Process-local lazy singleton on globalThis with Symbol.for keyed registry
- **Event Directory Scope** (`event-directory-scope.ts`): Per-location event scope for multi-instance hosts — process-local live-directory registry plus a session→directory map, fail-open on unresolved events
- **Internal Initiator** (`internal-initiator.ts`): Marker and strict native-background-notification recognition for internally-initiated agent messages
- **System Collapse** (`system-collapse.ts`): System message collapsing by joining with double-newlines
- **Compat** (`compat.ts`): Cross-platform spawn with output collection and Windows command resolution
- **PID File Lock** (`pid-file-lock.ts`): Cross-process PID-guarded directory lock with owner-token-guarded release (compare-then-delete), atomic stale-owner takeover (rename), young-lock fallback, live-owner age cap, and sync (`Atomics.wait`, off-main-thread only) plus async (`setTimeout`) retry wrappers
- **Zip Extractor** (`zip-extractor.ts`): Cross-platform zip extraction with Windows-aware fallbacks
- **Escape HTML** (`escape-html.ts`): HTML escaping helper for interview UI
- **Frontmatter** (`frontmatter.ts`): Frontmatter parsing for interview documents
- **Guards** (`guards.ts`): Type checking utilities (isRecord) for runtime validation

### Design Patterns

- **Singleton**: BackgroundJobBoard is a singleton registry with global state
- **Strategy**: Task parsing adapts to multiple output formats (XML tags, plain text headers)
- **Observer**: Logger uses write queuing to avoid blocking
- **Projection**: Board changes trigger TUI state projections
- **Utility**: Each utility module provides focused, composable functions

## Flow

### Background Job Lifecycle
1. Agent launches a background task via BackgroundJobBoard.registerLaunch() (watchdog arms wall-clock deadline)
2. Task runs and updates status via BackgroundJobBoard.updateStatus()
3. On completion/error/cancellation, task is marked terminal and added to reusable pool; watchdog timers cleared
4. Subsequent tasks reuse completed sessions via aliases
5. Unused reusable sessions are automatically trimmed based on maxReusablePerAgent
6. Deadline exceeded during execution → watchdog aborts the child via the host; the host's real terminal evidence publishes the run

### Session Selection Flow
1. resolveCurrentSelection() reads session.get() with bounded timeout
2. Falls back to metadata store if host read hangs or fails
3. Resolves model selection with provenance tracking

### Child Transcript Flow
1. fetchChildTranscript() retrieves child session messages via SDK
2. classifyAssistantTurnEvidence() evaluates each turn for completion
3. verdictFromEvidence() produces terminal evidence verdict

### Logging Flow
1. The first plugin instance in a process calls initLogger() — the sink is
   process-global, and re-initializing in the same log directory is a no-op
2. Logs appended to ~/.local/share/opencode/log/oh-my-opencode-slim.<stamp>-<pid>.log
   (client processes use the `tui-` tag)
3. Old logs (>7 days) cleaned up once per process initialization
4. Write queuing prevents blocking; fallback to stderr on failure

### Redaction Flow
1. redactSecretsForLog() applies token masking and structure-preserving value hiding
2. Pattern-based token redaction keeps 4 leading + 2 trailing characters
3. XML/HTML/structured format masking fully hides values behind [masked] placeholder

## Integration

### Consumers

- **Council Agents** (`src/agents/council.ts`, `src/agents/council-agents.ts`):
  - Uses BackgroundJobBoard for background task management
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
export * from './background-job-persistence';
export * from './background-job-supervisor';
export * from './background-task-concurrency';
export * from './internal-initiator';
export { initLogger, log } from './logger';
export * from './polling';
export * from './redact';
export * from './session';
export * from './session-runtime-status';
export * from './task';
export { extractZip } from './zip-extractor';
```

This allows consumers to import from `src/utils` rather than individual files.
Session metadata, the opencode client accessor, and the type-only call-shape contract are intentionally imported directly from their modules (not re-exported).

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Public API re-exporting most utilities |
| `agent-variant.ts` | Agent name normalization and regex escaping |
| `background-job-board.ts` | Background task registry, lifecycle manager, terminal-outcome subscriptions, launch-identity projection, and lifecycle ledger |
| `background-job-supervisor.ts` | Wall-clock watchdog: one timer per run, host abort on expiry |
| `background-task-concurrency.ts` | Process-local admission scheduler for background tasks |
| `background-job-persistence.ts` | Persistence for lifecycle state (tombstones, deletion) |
| `background-job-terminal-gate.ts` | Terminal evidence verification and attribution |
| `background-job-fixture.ts` | Test-only board fixtures for adapter/state-machine tests |
| `test-timers.ts` | Test-only deterministic timer harness for seam-wired timer code |
| `tui-reusable-projection.ts` | Board → tui-state projection for sidebar reusable dots |
| `session.ts` | Session timeout, abort, and model-reference utilities |
| `session-metadata.ts` | Bounded session → agent/directory store |
| `session-runtime-status.ts` | Bounded live session-status map reads; on-demand host round-state verdicts from the session info projection, with transcript text bound to the host idle |
| `session-selection.ts` | Session selection resolution with provenance |
| `child-transcript.ts` | Child session transcript evidence extraction; v1/startup idle classification, on-demand v2 binding of latest input and assistant text to the host idle (malformed entries fail closed) |
| `jsdom.ts` | JSDOM runtime detection without prerequisite |
| `redact.ts` | Shape-based secret redaction for logging |
| `logger.ts` | Process-wide file logging (pid-suffixed) |
| `event-directory-scope.ts` | Per-location event scope for multi-instance hosts |
| `env.ts` | Environment variable parsing and plugin disable checking |
| `global-store.ts` | Process-local lazy singleton store on globalThis |
| `internal-initiator.ts` | Internal agent message marker system |
| `system-collapse.ts` | System message collapsing utility |
| `compat.ts` | Cross-platform spawn and Windows command resolution |
| `pid-file-lock.ts` | Cross-process PID-guarded directory lock with owner-token-guarded release, stale-owner recovery and age cap |
| `zip-extractor.ts` | Cross-platform zip extraction |
| `escape-html.ts` | HTML escaping helper |
| `frontmatter.ts` | Frontmatter parsing for interview documents |
| `guards.ts` | Type checking utilities |
| `task.ts` | Task output parsing utilities |
| `polling.ts` | Delay helper |
| `councillor-models.ts` | Pure zod-free helpers normalizing councillor model fallback chains (single model or ordered `id`/`variant` entries) |
| `opencode-client.ts` | In-process opencode client accessor (imported directly, not re-exported) |
| `session-calls.contract.ts` | Type-only client call-shape contract (imported directly, not re-exported) |
