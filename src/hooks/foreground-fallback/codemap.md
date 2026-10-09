# src/hooks/foreground-fallback/

## Responsibility
Runtime model fallback system for foreground (interactive) agent sessions. When OpenCode emits rate-limit signals via `message.updated`, `session.error`, or `session.status` events, this manager:
- Detects retryable conditions using pattern matching against error messages and status codes (rate limits, 429, 403/Forbidden, 401/410 failover errors)
- On v1, withholds `session.abort(X)` while the background job board reports running children of X: held retry events do not seal dedup, exhausted chains still stop intervening, and busy replay errors withdraw any armed handoff when the abort is withheld (explicit refusal admits nothing), and settle it only after a failed abort with unknown outcome. v2 and v1 sessions without running children retain their abort behavior. `session.error` and `message.updated` can re-prompt directly without abort.
- Retrieves the last user message from the session history
- Re-prompts the session with the next available model from the agent's configured fallback chain
- Operates reactively through the event system (cannot wrap `prompt()` directly for interactive sessions)
- Defers terminal job-board bookkeeping for recoverable child failover errors (cooperates with task-session-manager's `willAttemptFallback`). The deferral fences every terminal gate path before replay preparation starts; idle always uses the bounded backstop.

## Design

### Core Abstraction
- **ForegroundFallbackManager**: Class instantiated at plugin initialization; process-local fallback progress is shared across replacement instances
- Maintains per-session state tracking:
  - `sessionModel`: Maps sessionID → current model string ("providerID/modelID")
  - `activeFallback`: Maps sessionID → `{ model, downProviders }` from a
    confirmed switch. `commitSwitch` copies the previous set, adds the failed
    source provider only for provider-scoped failures and removes the target
    provider, including same-provider and sticky switches. Synthetic admissions
    cannot overwrite it implicitly. Continuations and external turns retain it
    when their model is unknown or matches: v1 normally returns to the primary, while
    v2's persistent switch keeps the record live across turns.
    OpenCode v1 internal continuation and lifecycle selection consults
    `fallback.continuationPolicy`: retry the primary by default or retain this
    confirmed fallback for an internal continuation.
  - `sessionAgent`: Maps sessionID → agent name
  - `sessionTried`: Maps sessionID → Set of models already attempted
  - `sessionRetries`: Maps sessionID → absorbed host retry count for the entire descent (not per model)
  - `chainExhaustion`: Maps sessionID → exhaustion stage; stage 2 prevents further aborts without a fresh descent
  - `inProgress`: Process-global Set of sessions with active fallback in flight, shared via `globalThis` + `Symbol.for`
  - `lastTrigger` + turn/model/incident identity: coalesces repeated
    observations of the same failure while allowing distinct failures on the
    same turn and model to advance the chain; a bounded one-shot exact
    error-payload, model, and turn match correlates an id-less `session.error`
    with its adjacent errored `message.updated` in either event order
  - `turnEpoch`: fences fallback work suspended across promotion, abort,
    backoff, transcript reads, and busy-session retry from acting on a newer
    external user turn; each replay reserves and registers its host-valid
    `msg...` ID in the v1 prompt body before submission, so info-only
    notifications remain identifiable when parts arrive later
  - `userEventSequence`: orders asynchronous user-message identity probes so
    an older transcript lookup cannot overwrite newer turn state; known
    internal replay IDs do not advance the sequence; duplicate/stale external
    user-message updates cannot rewind the current model after a fallback
  - `replayMessageIds`: retain exact IDs of internal replay messages; synthetic
    marker checks remain a fallback for delayed part notifications

### Fallback Chain Resolution
- **Agent-specific chains**: Each agent defines an ordered list of fallback models via `modelArrays`, preserving per-entry variants
- **Chain lookup**: Resolves the correct chain using:
  1. Agent name (primary) → exact match
  2. Current model (fallback) → search all chains for containing model
  3. Merged list (last resort) → preserve insertion order across all agents
- **No cross-agent bleed**: When agent is identified, only that agent's chain is used (prevents re-prompting with wrong agent's models)

### Retryable Error Detection
- **Pattern matching**: rate-limit/quota/outage/401/403/410/421/451 wording, content-policy moderation and OpenCode v1's content-filter finish error, transport codes (`ECONNRESET`, …) and transport messages
- **Scope** (`failoverScope`): provider availability, transport, auth and quota failures have provider scope; policy/content-filter rejections and missing/retired models have request scope. Request wording takes precedence over HTTP status, including a policy rejection wrapped in 403. `isFailoverError` accepts either scope.
- **Status-code probe** (`extractStatusCode`): priority order `statusCode` → `data.statusCode` → `cause.statusCode` → `status` → `response.status` → `response.statusCode` → `data.status` → `data.response.status` → `cause.status` → `cause.response.status`. `asHttpStatus` accepts only finite `100–599` codes (number or 3-digit numeric string), so arbitrary numeric fields are never mistaken for a status.
- **Event coverage**: `message.updated` (message metadata error, or `finish: 'content-filter'` before its error is attached), `session.error` (session-level error), `session.status` (`retry` status). The content-filter finish and its later error share message-ID deduplication. On v1, completed error-free `finish: 'unknown'` messages with confirmed tool-free parts preserve retries and chain state while a per-session streak counts distinct IDs, triggering request-scoped abort and replay at three; unreadable parts neither count nor break the streak. A reply read across a confirmed fallback switch belongs to the previous model and does not count against the backup.
- **Retry budget**: Only a failover-worthy host `session.status` retry (or a v2 retry hook with `decision.retry === true`) charges `fallback.maxRetries`. Each genuine external user turn resets the host retry count, including before any model switch. Terminal `session.error` and errored `message.updated` advance immediately. Exhausting the retry budget keeps it charged across the model chain; successful assistant completion, observed fresh descent from the configured primary, or deletion re-arms it. Stage-2 exhaustion blocks abort on subsequent retry statuses until a fresh descent.
- A retry arriving while a fallback is in progress is not admitted and does not
  consume retry budget; delayed fallback retains the triggering error for
  consistent inline-error toast suppression.
- Confirmed permanent quota/billing failures bypass the initial fallback delay.
  The delay is consumed once per descent; later links use only consecutive
  fallback backoff, and a confirmed new external turn clears that backoff.

### State Management
- **Deduplication**: the short duplicate-observation window is scoped by the
  confirmed user-turn identity, model episode, and incident ID, so distinct
  failures on the same model are not merged. The window also rejects stale
  retry events from the previous model. Repeated retry attempt numbers are ignored before
  the chain-global retry budget is charged. Retry attempts withheld by the live-
  child guard remain eligible when the same attempt is observed after the guard
  clears.
- **Session cleanup**: `session.deleted` event handler removes all per-session state to prevent memory leaks
- **In-progress tracking**: Prevents concurrent fallback attempts on the same session across plugin-manager recreation
- Host calls within `inProgress` have bounded timeouts because the terminal gate's fallback fence depends on that window ending; a replay send timeout retains unresolved ownership without aborting or resending.

### Retry Budget and Exhaustion
- The v2 in-place retry hook (`handleV2Retry`) is gated by the separate `v2RetryEnabled` constructor flag — the replay path's `enabled` stays false on v2 hosts, so only steering runs there. It shares the chain-global budget and quota policy. Absorbed retries, recoverable failures, missing chains and unsuccessful model switches leave the host decision unchanged. Once `selectFallbackModel` returns `exhausted` the hook returns without touching the decision: the host's own retry verdict stands, so a spent chain never forces a retry. A first ordinary exhaustion still takes the sticky re-fallback (only the second lands here).
- `handleV2Retry` performs no turn-epoch fencing (removed with the retry state machine in 858c5bb4): the hook runs synchronously inside the host's retry decision for the currently failing turn, so no newer-turn write-back can race it. The only asynchronous window is the `switchModel` await; a timed-out switch that settles late is reconciled fail-closed — the callback bails unless `sessionModel` still equals the failed `from` model, so a newer turn's model is never overwritten.
- Observability + initial delay: the first retry-hook event per session and failing model logs a deterministic `[foreground-fallback] v2 retry hook observed` line (failover classification + steering state) before any guard returns, so a disabled or never-invoked hook is distinguishable in postmortems. The notice set clears on a completed successful assistant response and on a confirmed new user turn, so a later failure episode is visible again. `fallback.initialRetryDelayMs` has no steering form (no replay to delay; the host's own retry backoff is the window) — noted once per session instead of silently disabling steering.
- v2 bookkeeping split: `handleEvent` runs its bookkeeping (turn detection, agent/model tracking, descent-state resets) whenever either path is enabled, while the replay interventions (`session.error`, `message.updated` error, `session.status` retry) stay gated behind `enabled`. Without the split, a v2 session's later turns would inherit the previous descent's tried/retry/exhaustion state and skip fallbacks that are available again.
- `maxRetries = N` absorbs failures `1..N` on the current model; failure `N+1` (and every later failure) advances the chain. `maxRetries = 0` switches immediately.
- The budget is **chain-global** and is not cleared on a model switch.
- Cleared only on: a completed successful assistant response, `session.deleted`, or a confirmed new user turn. A completed assistant `message.updated` with `finish: 'content-filter'` is not a successful response: OpenCode v1 publishes it before attaching the `ContentFilterError`, so it never clears the budget.
- **Permanent quota/billing failures** (`isPermanentQuotaBillingError`: 402, explicit spending / personal-team-blocked limits, credits exhausted, expired coding plans, weekly/monthly exhaustion, Zhipu billing codes) bypass the initial replay delay through `bypassInitialFallbackDelay` and skip the host retry budget, switching immediately regardless of `maxRetries`. The sticky re-fallback still applies.
- `chainExhaustion` stage 2 stops `tryFallbackWithAbort` and `selectFallbackModel`, so a spent chain does not keep aborting host retries.
- `noteExternalTurn` cancels the initial-delay trigger, clears retry/dedup/backoff state and increments `turnEpoch`, retaining `replayMessageIds`. `isKnownInternalReplayUserMessage` checks retained IDs and event parts; `isInternalReplayUserMessage` probes the transcript when parts are missing. Duplicate user-message updates are inert. `userEventSequence` fences out-of-order probes, and `isCurrentTurn` prevents superseded replay work from claiming a switch. `rearmIfFreshDescent` clears tried/exhaustion state only after an observed return to the configured primary.

### Deduplication (identity-based)
- No error-text-only time-window heuristic: identical text can be the next real failure. The one-shot cross-event bridge requires an exact payload, current model, current turn, and short time-window match.
- `message.updated` dedupes by message id; `session.status` dedupes by `retryEpisode` (model + episode id + `seen` attempts, so repeated/out-of-order attempts dedupe but an incremented attempt is processed). An id-less terminal event is otherwise unique; only an exact one-shot match to its paired error event reuses that incident.
- Dedup and the `inProgress` guard run **before** budget consumption, so a duplicate or concurrently-dropped event cannot burn a budget slot.

## Flow

### Event Processing Pipeline
```
OpenCode Event (message.updated/session.error/session.status)
    ↓
ForegroundFallbackManager.handleEvent()
    ↓
Failover error detection via isFailoverError()
    ↓
tryFallback(sessionID) [deduplicated, in-progress guarded]
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
5. **Failover deferral**: Recoverable child errors (`isFailoverError`) leave terminal bookkeeping to the task-session-manager. Its backstop waits for replay preparation, renewing at most five times, and clears the deferral before publishing an unrecovered error. `fallbackFailureReason()` adds the disabled, missing-chain, exhausted-chain (with tried models), or failed-model explanation. Non-failover errors retain their original text.
6. **Fallback ownership**: Admitted and unresolved-promoted replays retain a tracker flag until external registration replaces the run. Plugin wiring makes v1 `task_revive` refuse pending or running fallback work; `task_cancel` remains available. v2 steering creates no replay flag or refusal.
7. **Continuation notice**: A confirmed replay after a terminal failover error queues one internal `state="running"` notice with the failed model, provider error and model now running. The tracker uses the same parent transport as terminal delivery and waits for the notice attempt to settle before sending the result. Retry-path replays, superseded or unresolved admissions, promoted owners and v2 steering send no notice.

## Integration

### Consumers
- **Primary**: Main plugin initialization (`src/index.ts`) creates ForegroundFallbackManager instance
- **Delegation routing**: Main plugin reads `getActiveFallback`. Independent
  children move only if their primary provider is in `downProviders`, taking
  their first chain entry outside that set. Inherited children follow the
  record's live model even after request-scoped failures. Manual model choices
  do not create a fallback record.
- **Event source**: OpenCode plugin event system provides `message.updated`, `session.error`, `session.status`, `session.deleted` events

### Dependencies
- **OpenCode SDK**: `PluginInput['client']` for session management and event handling (accessed via `getClient()` from `src/utils/opencode-client.ts`)
- **Utilities**:
  - `abortSessionWithTimeout()`: Graceful session termination
  - `parseModelReference()`: Model string parsing ("providerID/modelID")
  - `createInternalAgentTextPart()`: Internal-initiator provenance for replays
  - `log()`: Structured logging for observability
- **SessionLifecycle** (`src/hooks/session-lifecycle.ts`): registers `session.deleted` cleanup
- **Background job board** (`src/index.ts`): supplies a synchronous `hasRunning(sessionID)` child check for the optional v1 abort guard; the failing background job itself is not counted as its own child
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
  - Rate-limit detection
  - Fallback initiation
  - Model switching
  - Chain exhaustion
  - Abort failures
  - PromptAsync unavailability

## Error Handling
- **Graceful degradation**: Best-effort approach; abort may be slow or incomplete
- **Unverified v2 host detail**: It is not established whether OpenCode 2.0.18 emits `session.usage.updated` or `session.step.ended` on failed attempts. The existing adapter maps these events to successful completed-assistant messages; if they occur on failure, they can re-arm the budget prematurely. No v2 usage filter is applied without host evidence.
- **Validation**: Checks for `promptAsync` availability before attempting re-prompt
- **Fallback exhaustion**: Logs when entire chain has been attempted without success
- **Invalid model format**: Skips malformed model references
- **Missing user message**: Aborts fallback attempt if no user message found in history
