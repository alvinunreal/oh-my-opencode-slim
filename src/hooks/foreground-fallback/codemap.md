# src/hooks/foreground-fallback/

## Responsibility

Provides reactive model fallback for foreground (interactive) sessions when
a rate-limit or other retryable failure is observed in event streams.

## Design

- `index.ts` exports:
  - `ForegroundFallbackManager`
  - `isRateLimitError(error)` — checks rate-limit/quota patterns only
  - `isRetryableError(error)` — checks **all** retryable failures: rate limits,
    timeouts, connection errors, credential cool-downs, 5xx errors, empty
    responses, context-length overflows
- Error detection is layered:
  - `RATE_LIMIT_PATTERNS` — regexes for rate-limit/quota errors (429, "rate
    limit", "quota exceeded", etc.)
  - `OTHER_RETRYABLE_PATTERNS` — regexes for non-rate-limit retryable failures
    (timeout, ECONNREFUSED, "cooling down", 5xx, "empty response", "context
    length exceeded", etc.)
  - `ALL_RETRYABLE_PATTERNS` — combined set used by `isRetryableError`
  - `isRetryableStatusMessage(msg)` — string-matching for `session.status`
    retry messages (lowercased), covering rate limits, timeouts, connection
    issues, cool-downs, and context overflow
- Manager state is per-session maps for:
  - active model (`sessionModel`)
  - mapped agent (`sessionAgent`)
  - attempted models (`sessionTried`)
  - dedupe timestamp (`lastTrigger`)
  - in-flight fallback lock (`inProgress`)
- Fallback trigger conditions (broadened beyond rate limits):
  - `message.updated` with `info.error` → `isRetryableError()` check
  - `session.error` → `isRetryableError()` check
  - `session.status` with `type: 'retry'` → `isRetryableStatusMessage()` check
- Fallback selection uses `resolveChain(agentName, currentModel)` with ordered
  priority:
  1. exact agent chain (if configured)
  2. no-chain if agent is known but unconfigured
  3. infer from current model
  4. flattened fallback across all chains
- Re-submission uses `client.session.promptAsync` with last-user message parts and
  parsed `{ providerID, modelID }` target.

## Flow

1. `handleEvent` receives each plugin event.
2. On `message.updated`, `session.error`, and retry `session.status`, it checks
   for retryable failure markers (not just rate limits) and calls
   `tryFallback(sessionID)` when matched.
3. `subagent.session.created` updates session-to-agent mappings for better chain
   resolution.
4. `tryFallback(sessionID)` enforces:
   - feature enablement flag,
   - one-at-a-time lock,
   - dedupe window (`DEDUP_WINDOW_MS = 5000`).
5. It marks current model attempted, chooses next untried model from the chain,
   fetches latest user message via `session.messages`, aborts the active prompt via
   `session.abort()`, waits 500ms, and re-prompts with `promptAsync`.
6. Success updates session model memory; failures log structured diagnostics.
7. `session.deleted` cleanup removes all per-session bookkeeping to avoid memory
   growth.

## Integration

- Wired through plugin-level `event` hook in `src/index.ts`.
- Uses `ctx.client.session` APIs (`messages`, `abort`, `promptAsync`) and
  depends on runtime fallback chains provided from configuration.
- Designed as an interactive-session safety net when delegated/caller-side retry
  logic is unavailable or too late.