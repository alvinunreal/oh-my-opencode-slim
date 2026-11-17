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

- **Runtime Session Status** (`session-runtime-status.ts`): Reads and validates the OpenCode session-status map with absent/unknown distinction and reduces the `session.get` outcome/idleAt projection to terminal/pending/unknown verdicts for v2 recovery triage (`hostRoundStateOf`).
- **Session Info Read** (`session-info-read.ts`): `raceEvidenceDeadline` bounds a host read for its waiter without cancelling the underlying read; tests can inject its timer seam.
- **Session Metadata** (`session-metadata.ts`): Bounded session → agent/directory map with LRU eviction and active orchestrator protection
- **Child Transcript** (`child-transcript.ts`): Extracts transcripts and classifies rounds through `classifyAssistantTurnEvidence`, `classifyCurrentDeliveredRound`, and `classifyMigratedV1Round`. A marker-free migrated v1 history retains its v1 closure for untracked reads; v2 lifecycle markers keep the idle boundary mandatory. Shared latest-input/text helpers reject malformed history rather than skipping it. Diagnostic tails enforce UTF-8 budgets in one pass.
- **Host Transcript Attribution** (`child-transcript.ts`, `attributeHostRoundToTranscript`): Validates parsed host terminal evidence against assistant creation/completion after the latest delivered input; newer activity stays pending and unreadable timestamps stay unknown. Recovery and untracked reads retain the shared host-round parser/composer.
- **TestTimers** (`test-timers.ts`): Test-only deterministic timer harness (manual clock, injected `setTimeout`/`clearTimeout` seams, zero-duration `tick` drain); wire into timer-seam components, see AGENTS.md "Test Time"
- **JSDOM Probe** (`jsdom.ts`): JSDOM runtime detection without making it a prerequisite
- **Redact** (`redact.ts`): Shape-based secret redaction for logging

### Session & Task Utilities

- **Session** (`session.ts`): Timeout handling, session abort coordination, and model reference parsing
- **Prompt Agent** (`prompt-agent.ts`): Resolves explicit v1 prompt identity from safe hints, session records, or a bounded user-message tail; rejects internal system agents and suppresses unresolved targets. `withAgent` never constructs an agent-less body; the adjacent test scans v1 prompt call sites.
- **Task** (`task.ts`): XML-inspired task output parsing for extracting task IDs, states, and results; header-only parsing avoids reading result bodies when only identity and state are needed
- **Question Reply** (`question-reply.ts`): Host-result validation and v2 form answer conversion used by the v2 question timeout (`v2/question-timeout-tui.ts`).
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

- **Strategy**: Task parsing adapts to multiple output formats (XML tags, plain text headers)
- **Observer**: Logger uses write queuing to avoid blocking
- **Utility**: Each utility module provides focused, composable functions

## Flow

### Child Transcript Flow
1. fetchChildTranscript() retrieves child session messages via SDK
2. classifyAssistantTurnEvidence() evaluates each turn for completion
3. Host outcome and transcript attribution compose the current-round verdict; migrated v1 history uses classifyMigratedV1Round()

### Logging Flow
1. The first plugin instance in a process calls initLogger() — the sink is
   process-global, and re-initializing in the same log directory is a no-op
2. Logs appended to ~/.local/share/opencode/log/oh-my-opencode-slim.<stamp>-<pid>.log
   (client processes use the `tui-` tag)
3. Old logs (>7 days) cleaned up once per process initialization
4. Write queuing prevents blocking; fallback to stderr on failure

### Redaction Flow
1. redactSecretsForLog() applies shape-based token masking to log entries
2. Rules identify vendor prefixes, authorization credentials, URL passwords and long opaque runs
3. Masks retain 4 leading and 2 trailing characters, or an ellipsis for very short tokens

## Integration

### Consumers

- **Council Agents** (`src/agents/council.ts`, `src/agents/council-agents.ts`):
  - Uses logger for debug and audit logging

- **Multiplexer** (`src/multiplexer/`):
  - Uses session utilities for session operations
  - Uses logger for session lifecycle events

- **Agents** (`src/agents/`):
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
export * from './internal-initiator';
export { log } from './logger';
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
| `test-timers.ts` | Test-only deterministic timer harness for seam-wired timer code |
| `timer-seam.ts` | Single timer-seam contract (`TimerHandle`, `TimerSeam`, `TimerSeamOptions`) shared by every scheduling seam |
| `session.ts` | Session timeout, abort, and model-reference utilities |
| `session-metadata.ts` | Bounded session → agent/directory store |
| `session-runtime-status.ts` | Bounded live session-status map reads; on-demand host round-state verdicts from the session info projection, with transcript text bound to the host idle |
| `child-transcript.ts` | Child session transcript evidence extraction; migrated v1 history classification and on-demand v2 binding of latest input and assistant text to the host idle (malformed entries fail closed) |
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
