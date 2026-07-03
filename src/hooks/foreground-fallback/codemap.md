# src/hooks/foreground-fallback/

## Responsibility
Runtime model fallback system for foreground (interactive) agent sessions. When OpenCode emits rate-limit signals via `message.updated`, `session.error`, or `session.status` events, this manager:
- Detects rate-limit conditions using pattern matching against error messages and status codes
- Aborts the rate-limited prompt via `client.session.abort()`
- Retrieves the last user message from the session history
- Re-prompts the session with the next available model from the agent's configured fallback chain
- Operates reactively through the event system (cannot wrap `prompt()` directly for interactive sessions)

## Design

### Core Abstraction
- **ForegroundFallbackManager**: Singleton class instantiated at plugin initialization
- Maintains per-session state tracking:
  - `sessionModel`: Maps sessionID → current model string ("providerID/modelID")
  - `sessionAgent`: Maps sessionID → agent name
  - `sessionTried`: Maps sessionID → Set of models already attempted
  - `inProgress`: Set of sessions with active fallback in flight
  - `lastTrigger`: Maps sessionID → timestamp for deduplication

### Fallback Chain Resolution
- **Agent-specific chains**: Each agent defines an ordered list of fallback models via `_modelArray` entries
- **Chain lookup**: Resolves the correct chain using:
  1. Agent name (primary) → exact match
  2. Current model (fallback) → search all chains for containing model
  3. Merged list (last resort) → preserve insertion order across all agents
- **No cross-agent bleed**: When agent is identified, only that agent's chain is used (prevents re-prompting with wrong agent's models)

### Rate-Limit Detection
- **Pattern matching**: Comprehensive regex patterns for rate-limit error messages (429, "rate limit", "too many requests", "quota exceeded", etc.)
- **Event coverage**: Handles three OpenCode event types:
  - `message.updated`: Error in message metadata
  - `session.error`: Session-level error event
  - `session.status`: Status message containing rate-limit indicators

### State Management
- **Deduplication window**: 5-second cooldown (`DEDUP_WINDOW_MS`) to prevent multiple triggers for same rate-limit event
- **Session cleanup**: `session.deleted` event handler removes all per-session state to prevent memory leaks
- **In-progress tracking**: Prevents concurrent fallback attempts on same session

## Flow

### Event Processing Pipeline
```
OpenCode Event (message.updated/session.error/session.status)
    ↓
ForegroundFallbackManager.handleEvent()
    ↓
Rate-limit detection via isRateLimitError()
    ↓
tryFallback(sessionID) [deduplicated, in-progress guarded]
    ↓
Resolve fallback chain for session
    ↓
Abort current rate-limited prompt (with timeout)
    ↓
Retrieve last user message from session history
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
4. **Re-prompting**: Calls `promptAsync()` which queues prompt and returns immediately (non-blocking)

## Integration

### Consumers
- **Primary**: Main plugin initialization (`src/index.ts`) creates ForegroundFallbackManager instance
- **Event source**: OpenCode plugin event system provides `message.updated`, `session.error`, `session.status`, `session.deleted` events

### Dependencies
- **OpenCode SDK**: `PluginInput['client']` for session management and event handling
- **Utilities**:
  - `abortSessionWithTimeout()`: Graceful session termination
  - `parseModelReference()`: Model string parsing ("providerID/modelID")
  - `log()`: Structured logging for observability
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
  - Rate-limit detection
  - Fallback initiation
  - Model switching
  - Chain exhaustion
  - Abort failures
  - PromptAsync unavailability

## Error Handling
- **Graceful degradation**: Best-effort approach; abort may be slow or incomplete
- **Validation**: Checks for `promptAsync` availability before attempting re-prompt
- **Fallback exhaustion**: Logs when entire chain has been attempted without success
- **Invalid model format**: Skips malformed model references
- **Missing user message**: Aborts fallback attempt if no user message found in history