# Delegate Task 429 Retry + Fallback

## Problem

When the orchestrator delegates to a subagent via the `task` tool, the spawned
session can receive `429 Too Many Requests`. OpenCode internally retries
(because `ApiError.isRetryable` is `true` for 429), emitting `session.status`
events with `type: "retry"`. With no limit on internal retries and no model
swap, the session freezes indefinitely.

The existing `ForegroundFallbackManager` already handles events from ALL
sessions (foreground + subagent), but:

1. It was **disabled** when `runtimeChains` was empty (no model arrays
   configured) — even though it could still abort sessions on exhaustion.
2. It immediately aborted on the first 429 — no backoff letting OpenCode's
   internal retry handle transient spikes.
3. When chain was empty, it returned silently instead of aborting — leaving
   the session to freeze.

## Strategy

**Retry with backoff, then intervene.** When a session hits 429:

1. If OpenCode is retrying internally (`status.type === "retry"`), let it —
   track the retry count from the `attempt` field in the `session.status`
   event.
2. After `maxRetries` consecutive 429s, intervene: abort the current prompt
   and swap to the next model in the fallback chain (via `promptAsync`).
3. If no fallback chain is configured, just abort — stops the freeze, surfaces
   error to the orchestrator.

This works for both foreground and subagent sessions because:

- `promptAsync` is a real SDK endpoint (`POST /session/{id}/prompt_async`,
  verified in `@opencode-ai/sdk` types) and works on any session.
- The ForegroundFallbackManager already processes events from all sessions.
- Subagent and foreground both emit the same `session.status` events.

## Implementation

### Files Changed

| File | Change |
|------|--------|
| `src/config/schema.ts` | Add `maxRetries` to `FailoverConfigSchema` (default: 3) |
| `src/hooks/foreground-fallback/index.ts` | Add `maxRetries` constructor param, `sessionRetries` tracking map, retry tracking in `session.status` handler, abort-on-chain-exhaustion in `tryFallback` |
| `src/index.ts` | Enable manager without `runtimeChains`, pass `config.fallback?.maxRetries` |

### Config Schema

```typescript
// In FailoverConfigSchema (src/config/schema.ts)
export const FailoverConfigSchema = z.object({
  enabled: z.boolean().default(true),
  timeoutMs: z.number().min(0).default(15000),
  retryDelayMs: z.number().min(0).default(500),
  maxRetries: z.number().int().min(0).default(3).describe(
    'Number of consecutive 429/rate-limit responses tolerated on the ' +
    'same model before aborting (or swapping to the next fallback ' +
    'model when a chain is configured).',
  ),
  retry_on_empty: z.boolean().default(true),
}).strict();
```

### ForegroundFallbackManager Changes

1. **`sessionRetries` map** — tracks consecutive 429s per session, reset on
   model swap or session deletion.

2. **`session.status` handler** — when `status.type === "retry"` and the
   message matches rate-limit keywords, increments the retry counter instead
   of immediately falling back. Only intervenes after `maxRetries - 1`
   internal retries.

3. **`tryFallback` chain-exhaustion path** — when `resolveChain` returns empty
   (no fallback models configured), calls `abortSessionWithTimeout` instead of
   returning silently. This stops OpenCode's infinite retry loop.

4. **`session.deleted` handler** — cleans up `sessionRetries` entry.

### Usage

```jsonc
// ~/.config/opencode/oh-my-opencode-slim.jsonc
{
  "fallback": {
    "enabled": true,        // default: true
    "maxRetries": 3,         // default: 3 — let 3 internal retries, then intervene
    "retryDelayMs": 500      // base delay for OpenCode's internal backoff
  },
  "agents": {
    "explorer": {
      "model": ["openai/gpt-4o", "anthropic/claude-sonnet-4"] // fallback chain
    }
  }
}
```

## Verification

All 1350 existing tests pass. No new files added — only 3 existing files
modified.
