# src/hooks/foreground-fallback/

## Responsibility

Provides reactive model fallback for foreground (interactive) sessions when
runtime rate-limit indicators are observed.

## Design

- `index.ts` exports:
  - `ForegroundFallbackManager`
  - `isRateLimitError(error)`
- Manager state is session-scoped maps for:
  - active model (`sessionModel`)
  - mapped agent (`sessionAgent`)
  - attempted models (`sessionTried`)
  - dedupe timestamp (`lastTrigger`)
  - in-flight fallback lock (`inProgress`)
- Rate-limit detection uses fixed regexes over message/error text and response
  metadata (`statusCode`, `message`, `responseBody`).
- Fallback selection is deterministic via `resolveChain(agentName, currentModel)`:
  1. exact agent chain (if known)
  2. no fallback if agent known but unconfigured
  3. infer chain from current model
  4. deduplicated flattening of all chains as fallback.

## Flow

1. `handleEvent` receives each OpenCode event from the plugin’s global event
   surface.
2. On `message.updated`, `session.error`, or retry `session.status`, the
   manager checks for rate-limit signatures.
3. When matched, `tryFallback(sessionID)` runs with guards:
   - disabled feature toggle,
   - in-progress lock,
   - dedupe window (`DEDUP_WINDOW_MS = 5000`).
4. It resolves the chain, marks the current model as tried, and selects the next
   untried model.
5. It fetches messages, finds the last user turn, aborts the current session,
   waits briefly (500ms), then reissues that user parts using `session.promptAsync`
   with a parsed `{ providerID, modelID }`.
6. On success it updates `sessionModel`; on failures, logs structured fallback
   errors.
7. On `session.deleted`, all per-session maps are removed to prevent memory
   growth.

## Integration

- Wired via plugin-level `event` hook in `src/index.ts`.
- Uses `ctx.client.session` APIs (`messages`, `abort`, `promptAsync`) and is
  independent of delegation/council logic.
- Intended as a runtime safety net when startup-time model selection cannot avoid
  transient provider limits.
