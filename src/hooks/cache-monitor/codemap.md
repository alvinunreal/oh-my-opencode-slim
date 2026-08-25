# src/hooks/cache-monitor/

## Responsibility

Runtime watchdog for provider prompt-cache busts. Offline tests prove the
plugin projects a byte-stable payload, but only the provider knows whether a
cache prefix was actually reused. OpenCode surfaces per-request cache
telemetry on assistant messages (`tokens.cache.read` / `tokens.cache.write`);
this hook watches those numbers and logs a loud warning when a session that
previously enjoyed cache hits suddenly reports zero cached tokens on a
sizeable request — the field signature of a mid-session prompt-prefix change.

Observation only: it never mutates messages or state, and it fails open on any
unexpected event shape. See `docs/cache-verification.md` for the full story.

## Design

- **Factory** (`index.ts`): `createCacheMonitorHook(options)` returns a single
  `event` hook. Created at plugin start before config loads so it sees every
  event; sits outside the init try-block.
- **Per-session state**: `Map<sessionID, SessionCacheState>` tracking completed
  request count, `everReportedCache`, last `cache.read`, warned-since-last-hit
  flag, never-cached streak/input totals, and plateau streak/input totals.
  Deduplicated by processed message IDs; bounded at `MAX_TRACKED_SESSIONS`
  (256) and `MAX_TRACKED_MESSAGES_PER_SESSION` (512).
- **Three detection modes**:
  1. **Mid-session bust** — a session that previously hit the cache reports
     `cacheRead === 0` on a request ≥ 2048 input tokens (the classic
     prompt-prefix-change signature).
  2. **Never-cached streak** — ≥ 3 consecutive sizeable zero-cache requests
     and ≥ 100k cumulative uncached input tokens with no cache write ever
     (busted from turn one; the first-mode warning never arms).
  3. **Cache-read plateau** (issue #874 signature) — `cache.read` frozen at
     the same nonzero value across ≥ 4 sizeable requests while ≥ 50k uncached
     input accumulates (the reusable prefix has stopped growing).
- Small requests (< 2048 input tokens) are ignored: they sit under provider
  minimum-cacheable-prefix thresholds and legitimately report zero.
- Warnings are hedged and reference `docs/cache-verification.md`.

## Flow

```
message.updated (completed assistant, role=assistant, time.completed set)
    ↓
parseCompletedAssistantMessage() → { sessionID, messageID, inputTokens, cacheRead, cacheWrite }
    ↓
observe() (dedup by messageID)
    ├─ busted? (everReportedCache && cacheRead === 0 && inputTokens ≥ 2048) → warn (once per hit)
    ├─ never cached? (cacheRead === 0 && cacheWrite === 0 && sizeable)
    │     → extend streak; warn at thresholds
    ├─ plateau? (cacheRead > 0 && cacheRead === lastCacheRead)
    │     → extend streak; warn at thresholds (any change resets)
    └─ cacheRead > 0 → re-arm warnedSinceLastHit; update everReportedCache/lastCacheRead

session.deleted → drop per-session state
```

## Integration

- **Consumer**: `src/index.ts` creates the hook at plugin factory start and
  routes every event through it.
- **Dependencies**: `isRecord` (`src/utils/guards.ts`) for safe event shape
  parsing, `log` (`src/utils/logger.ts`) for warnings (injectable via
  `CacheMonitorOptions.logger` for tests).
- **Relationships**: complements the offline cache-safety tests
  (`src/hooks/cache-safety.property.test.ts`, `cache-payload.snapshot.test.ts`,
  `src/cache-safety-tripwire.test.ts`) — this is the online half that only the
  provider can confirm.

## Error Handling

- Every event is wrapped in try/catch: telemetry must never break event
  handling (fails open).
- Non-numeric/missing token fields are treated as unobservable; events without
  a completed timestamp are skipped (streaming updates carry no final counts).

## Performance Considerations

- Observation only — no timers, no I/O, no message mutation.
- Bounded state per session and capped session count; message-ID sets are
  cleared when they hit the cap.
