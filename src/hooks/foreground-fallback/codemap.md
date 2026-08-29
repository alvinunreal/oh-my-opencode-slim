# src/hooks/foreground-fallback/

## Responsibility
Runtime model fallback system for foreground (interactive) agent sessions. When OpenCode emits rate-limit signals via `message.updated`, `session.error`, or `session.status` events, this manager:
- Sub-classifies errors into four action types (surface, absorb, retry_same_model, fallback) using pattern matching, status codes, and transport codes
- Aborts the rate-limited prompt via `client.session.abort()` on the `session.status` retry path; `session.error` and `message.updated` paths re-prompt directly without abort
- Retrieves the last user message from the session history
- Re-prompts the session with the next available model (fallback chain) or same model (transient error retry)
- Operates reactively through the event system (cannot wrap `prompt()` directly for interactive sessions)
- Defers terminal job-board bookkeeping for inline 401/410 errors while recovery is still possible (cooperates with task-session-manager's `willAttemptFallback`)

## Design

### Core Abstraction
- **ForegroundFallbackManager**: Class instantiated at plugin initialization; process-local fallback progress is shared across replacement instances
- Maintains per-session state tracking:
  - `sessionModel`: Maps sessionID → current model string ("providerID/modelID")
  - `sessionAgent`: Maps sessionID → agent name
  - `sessionTried`: Maps sessionID → Set of models already attempted
  - `inProgress`: Process-global Set of sessions with active fallback in flight, shared via `globalThis` + `Symbol.for`
  - `lastTrigger`: Maps sessionID → timestamp for deduplication

### Fallback Chain Resolution
- **Agent-specific chains**: Each agent defines an ordered list of fallback models via `_modelArray` entries
- **Chain lookup**: Resolves the correct chain using:
  1. Agent name (primary) → exact match
  2. Current model (fallback) → search all chains for containing model
  3. Merged list (last resort) → preserve insertion order across all agents
- **No cross-agent bleed**: When agent is identified, only that agent's chain is used (prevents re-prompting with wrong agent's models)

### Error Classification
- **`classifyError()`**: Sub-classifies every error into one of four actions:
  - `surface`: Deterministic errors (context overflow, 413 payload rejection) — retrying or chain-advancing is useless
  - `absorb`: Transient interval caps (per-minute rate limits, concurrent caps) — let OpenCode's own retry handle it
  - `retry_same_model`: Server/transport transients (5xx, HTTP/2 reset, premature stream close, upstream errors) — exponential backoff, same model
  - `fallback`: Persistent failures (quota exhaustion, 401/410, 403, model outages, generic rate-limit patterns) — advance chain
- **Patterns from omp**: Context overflow, 413 rejection, concurrent limit, subscription/plan quota, account-scoped 403, Chinese quota/transient/throttle, HTTP/2 stream reset, premature stream close
- **Quota exhaustion guard**: Permanently prevents chain-exhaustion reset loop — `isQuotaExhaustedError()` marks `chainExhaustion=2` and aborts, never resets the tried set

### Same-Model Retry
- **`retrySameModel()`**: Exponential backoff (500ms × 2^n, capped at 8s) for transient server errors
- **`execSameModelReprompt()`**: Re-prompts with the current model (no chain advance) after abort
- **Budget**: Up to `maxRetries` attempts before escalating to fallback chain or surfacing error
- Fixes #947: agents without a fallback chain (councillors, explorer) now retry instead of failing silently

### Retryable Error Detection
- **Pattern matching**: Comprehensive regex patterns for rate-limit error messages (429, "rate limit", "too many requests", "quota exceeded", etc.) plus `isFailoverError` / `isInlineFailoverError` classification for persistent 401/410 provider-model errors
- **Event coverage**: Handles three OpenCode event types:
  - `message.updated`: Error in message metadata
  - `session.error`: Session-level error event
  - `session.status`: Status message containing rate-limit indicators

### State Management
- **Deduplication window**: 5-second cooldown (`DEDUP_WINDOW_MS`) to prevent multiple triggers for same rate-limit event
- **Session cleanup**: `session.deleted` event handler removes all per-session state to prevent memory leaks
- **In-progress tracking**: Prevents concurrent fallback attempts on the same session across plugin-manager recreation

## Flow

### Event Processing Pipeline
```
OpenCode Event (message.updated/session.error/session.status)
    ↓
ForegroundFallbackManager.handleEvent()
    ↓
classifyError() → surface | absorb | retry_same_model | fallback
    ↓
surface → return (no action)
absorb → return (let OpenCode retry)
retry_same_model → retrySameModel() (backoff, same model)
fallback → tryFallback() / tryFallbackWithAbort()
    ↓
Resolve fallback chain for session
    ↓
Abort current rate-limited prompt (session.status retry path only, with timeout)
    ↓
Retrieve last user message from session history (replayed via isReplayableUserMessage/partsFromReplayMessage)
    ↓
Re-prompt session with next model via promptAsync()
    ↓
Update session state with new model
    ↓
Log fallback event
```

### Key Operations
1. **Abort with timeout**: `abortSessionWithTimeout()` sends Ctrl+C to pane then kills it after 250ms delay
2. **Message retrieval**: Queries session messages via `client.session.messages()` and finds last user message
3. **Model switching**: Uses `parseModelReference()` to extract providerID/modelID from chain entry
4. **Re-prompting**: Calls `promptAsync()` which queues prompt and returns immediately (non-blocking); appends trusted internal-initiator provenance so the replay is not mistaken for new external user input
5. **Failover deferral**: 401/410 errors (`isFailoverError`) leave terminal job-board bookkeeping to the task-session-manager event router, which defers it while `willAttemptFallback` holds

## Integration

### Consumers
- **Primary**: Main plugin initialization (`src/index.ts`) creates ForegroundFallbackManager instance
- **Event source**: OpenCode plugin event system provides `message.updated`, `session.error`, `session.status`, `session.deleted` events

### Dependencies
- **OpenCode SDK**: `PluginInput['client']` for session management and event handling (accessed via `getClient()` from `src/utils/opencode-client.ts`)
- **Utilities**:
  - `abortSessionWithTimeout()`: Graceful session termination
  - `parseModelReference()`: Model string parsing ("providerID/modelID")
  - `createInternalAgentTextPart()`: Internal-initiator provenance for replays
  - `log()`: Structured logging for observability
- **SessionLifecycle** (`src/hooks/session-lifecycle.ts`): registers `session.deleted` cleanup
- **Message types** (`src/hooks/types.ts`): `isReplayableUserMessage` / `partsFromReplayMessage` for safe replay
- **Configuration**: Fallback chains provided at construction from agent configurations

### Configuration Schema
Fallback chains are provided as `Record<string, string[]>` where:
- Key: Agent name (e.g., "orchestrator", "explorer")
- Value: Ordered list of model strings (e.g., `["anthropic/claude-opus-4-5", "openai/gpt-4o"]`)

### Memory Management
- **Per-session state**: All maps cleared on `session.deleted` event
- **Deduplication**: Prevents unbounded growth in long-running instances with many subagent sessions

### Observability
- **Logging**: Structured logs at key points:
  - Error classification
  - Rate-limit detection
  - Fallback initiation
  - Model switching
  - Same-model retry backoff
  - Chain exhaustion
  - Quota exhaustion abort
  - Abort failures
  - PromptAsync unavailability

## Error Handling
- **Graceful degradation**: Best-effort approach; abort may be slow or incomplete
- **Validation**: Checks for `promptAsync` availability before attempting re-prompt
- **Fallback exhaustion**: Logs when entire chain has been attempted without success; quota exhaustion aborts permanently
- **Quota exhaustion guard**: Permanently prevents chain-exhaustion reset loop (fixes #966)
- **Same-model retry**: Transient server errors retry with backoff before advancing chain (fixes #947)
- **Invalid model format**: Skips malformed model references
- **Missing user message**: Aborts fallback attempt if no user message found in history