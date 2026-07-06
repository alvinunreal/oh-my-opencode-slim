# HookRegistry + SessionLifecycle Coordinator

**Category:** enhancement
**Author:** mhenke
**Date:** 2026-07-06
**Issue:** #675
**Status:** approved

## Problem

Four verified problems in the hooks architecture of `oh-my-opencode-slim`:

1. **Manual wiring friction.** Adding a new hook requires touching 6-10 locations: export from `src/hooks/index.ts`, import in `src/index.ts`, variable declaration, factory call, and a dispatch call for each hook point. Verified at `src/index.ts:6-34` (imports), `138-153` (declarations), `271-322` (factory calls), `820-1186` (dispatch sites). 13 hooks currently exist; this friction scales linearly.

2. **Scattered session.deleted cleanup.** Three hooks each implement their own cleanup:
   - `task-session-manager`: 6 ops at `src/hooks/task-session-manager/index.ts:715-720`
   - `foreground-fallback`: 7 ops at `src/hooks/foreground-fallback/index.ts:238-244`
   - `post-file-tool-nudge`: 2 ops at `src/hooks/post-file-tool-nudge/index.ts:79-80`
   A new stateful hook that forgets `session.deleted` leaks memory silently.

3. **Reversed-priority session ID bug.** `info?.id ?? sessionID` is duplicated 8 times across 4 files. One location (`src/hooks/post-file-tool-nudge/index.ts:77`) uses the reversed priority `sessionID ?? info?.id`. During session transitions when both fields differ, this picks the wrong session ID, causing missed cleanup or stale pending state.

4. **Module-scoped Sets with no TTL.** `post-file-tool-nudge` owns `pendingSessionIds` and `everPendingSessionIds` at module scope. `phase-reminder` imports `hasPendingSession` from `post-file-tool-nudge` (`src/hooks/phase-reminder/index.ts:10`). Consumption is a side effect of `.delete()`. If the handler throws or is skipped, the session stays pending forever.

## Solution

Three modules:

### 1. `src/utils/extract-session-id.ts`

Single function that replaces all 8 manual extractions:

```typescript
export function extractSessionId(
  info: { id?: string } | undefined | null,
  sessionID: string | undefined | null,
): string | undefined {
  return info?.id ?? sessionID;
}
```

- Priority: `info?.id` wins over `sessionID` (matches the 7 correct locations).
- Located in `src/utils/` because `src/multiplexer/session-manager.ts:610` also uses it.
- Fixes the reversed-priority bug at `post-file-tool-nudge/index.ts:77`.
- Also deduplicates the two adjacent `session.deleted` blocks in `src/index.ts:885-905`.

### 2. `src/hooks/session-lifecycle.ts` — SessionLifecycle coordinator

Two responsibilities:

**Cleanup callback registry.** Stateful hooks register a callback instead of implementing their own `session.deleted` handler. The coordinator runs all registered callbacks when `dispatchSessionDeleted(sessionId)` is called. If a callback throws, the error is logged and the remaining callbacks still run — one failure does not block others.

```typescript
class SessionLifecycle {
  #cleanupCallbacks: Array<(sessionId: string) => void> = [];
  #pendingSessionIds = new Set<string>();
  #everPendingSessionIds = new Set<string>();
  #pendingTimestamps = new Map<string, number>();

  static readonly PENDING_TTL_MS = 5 * 60 * 1000;

  // -- Cleanup API --
  onSessionDeleted(callback: (sessionId: string) => void): void;
  dispatchSessionDeleted(sessionId: string): void;

  // -- Signaling API --
  /** Mark sessionId as having pending file-tool state. */
  markPending(sessionId: string): void;
  /**
   * Atomically consume pending state for sessionId.
   * Returns true if this call consumed the pending state,
   * false if it was already consumed or never pending.
   * Only one caller will get true per markPending call.
   */
  consumePending(sessionId: string): boolean;
  /** True if sessionId had pending state that was consumed (checked with TTL). */
  hasPendingSession(sessionId: string): boolean;
  /** Remove all state for sessionId (called on session.deleted). */
  clearSession(sessionId: string): void;
}
```

**Pending-session signaling channel.** The module-scoped Sets from `post-file-tool-nudge` move here. TTL uses timestamp + lazy expiry on read (no `setTimeout`, no timer lifecycle bugs):

```typescript
hasPendingSession(sessionId: string): boolean {
  const ts = this.#pendingTimestamps.get(sessionId);
  if (ts && Date.now() - ts > SessionLifecycle.PENDING_TTL_MS) {
    this.#pendingTimestamps.delete(sessionId);
    this.#pendingSessionIds.delete(sessionId);
    return false;
  }
  return this.#everPendingSessionIds.has(sessionId)
    && !this.#pendingSessionIds.has(sessionId);
}

dispatchSessionDeleted(sessionId: string): void {
  for (const callback of this.#cleanupCallbacks) {
    try {
      callback(sessionId);
    } catch (error) {
      log.error(`cleanup callback failed for session ${sessionId}`, error);
    }
  }
}
```

Hooks that use it:
- `task-session-manager`: registers 6 cleanup ops as one callback
- `foreground-fallback`: registers 7 cleanup ops as one callback
- `post-file-tool-nudge`: registers cleanup of pending state; imports `markPending`, `consumePending` from coordinator
- `phase-reminder`: imports `hasPendingSession` from coordinator instead of `../post-file-tool-nudge` — and nothing else. No need for `markPending` or `consumePending`.

The coordinator is instantiated in `src/index.ts` before hook factories that need it, passed as a parameter.

### 3. `src/hooks/hook-registry.ts` — HookRegistry

Simple ordered handler registry:

```typescript
class HookRegistry {
  #handlers = new Map<string, Array<(input: unknown, output: unknown) => Promise<void>>>();
  #firedHookPoints = new Set<string>();

  register(
    hookPoint: string,
    handler: (input: unknown, output: unknown) => Promise<void>,
  ): void {
    if (this.#firedHookPoints.has(hookPoint)) {
      log.warn(`hook "${hookPoint}" already dispatched; late registration may miss events`);
    }
    // ...
  }

  dispatch(hookPoint: string, input: unknown, output: unknown): Promise<void>;
  getHandlers(hookPoint: string): ReadonlyArray<...>;
}
```

Loose typing (`(input: unknown, output: unknown)`) is intentional — typed wrappers per hook point would add ceremony without proportional value for a codebase where call sites are already close to the cast. If typing becomes painful, add typed wrapper methods.

- Registration order = dispatch order.
- All async hook points dispatch through the registry.
- `chat.headers` at `src/index.ts:980` stays manual (sync property, not async). A comment at the dispatch site explains why.
- Non-hook event handling (multiplexer, companion, interview, preset, depthTracker) stays manual.

Touch-point reduction for adding a new hook:
- Export from `src/hooks/index.ts`: still required
- Import in `src/index.ts`: still required
- Variable declaration: **removed**
- Factory call: still required
- Registration: **added** (`registry.register(hookPoint, handler)`)
- Dispatch-site wiring: **removed**

Net: ~3 touch points eliminated. Dispatch code shrinks from ~121 lines to a few `registry.dispatch()` calls.

## Changes by file

### Phase 0: Baseline

Run `bun test` and record the output. This ensures regressions in Phase 3 can be bisected.

### Phase 1: `src/utils/extract-session-id.ts` (new)

- Create file with `extractSessionId` function.
- Tests in `src/utils/extract-session-id.test.ts`.

### Phase 2: `src/hooks/session-lifecycle.ts` (new)

- Create file with `SessionLifecycle` class.
- Tests in `src/hooks/session-lifecycle.test.ts`.

### Phase 2: Update hooks

- `src/hooks/post-file-tool-nudge/index.ts`: delete module-scoped Sets, delete `hasPendingSession` export, delete reversed-priority `sessionID ?? info?.id`, use `extractSessionId`, add `coordinator: SessionLifecycle` param to factory, register cleanup callback.
- `src/hooks/phase-reminder/index.ts`: import `hasPendingSession` from `session-lifecycle` instead of `../post-file-tool-nudge`.
- `src/hooks/task-session-manager/index.ts`: replace 4 `info?.id ?? sessionID` with `extractSessionId`. Replace inline cleanup with coordinator callback registration.
- `src/hooks/foreground-fallback/index.ts`: replace `info?.id ?? sessionID` with `extractSessionId`. Replace inline cleanup with coordinator callback registration.

### Phase 3: `src/hooks/hook-registry.ts` (new)

- Create file with `HookRegistry` class.
- Tests in `src/hooks/hook-registry.test.ts`.

### Phase 3: Update `src/index.ts`

- Delete variable declarations for hooks (lines 138-153).
- Delete imports for hook types/types that become unused.
- Instantiate `SessionLifecycle` before hook factories.
- Pass `SessionLifecycle` to hooks that need it.
- Instantiate `HookRegistry` after all factories.
- Register each hook's handlers with the registry.
- Replace manual dispatch in `event` handler, `tool.execute.before`, `command.execute.before`, `tool.execute.after`, `experimental.chat.system.transform`, `experimental.chat.messages.transform` with `registry.dispatch()`.
- Keep `chat.headers` manual (sync). Add comment explaining why so maintainers don't try to "fix" it.
- Keep non-hook dispatch manual (multiplexer, companion, interview, preset, depthTracker).
- Deduplicate the two `session.deleted` blocks using `extractSessionId`.

### Tests to update

- `src/hooks/post-file-tool-nudge/index.test.ts`: pass coordinator to factory.
- `src/hooks/phase-reminder/index.test.ts`: update import path for `hasPendingSession`.
- `src/hooks/task-session-manager/index.test.ts`: verify cleanup through coordinator.
- `src/index.ts` integration tests: nothing should break — the Plugin function returns the same shape.

## Acceptance criteria

- [ ] `extractSessionId` replaces all 8 instances, priority is always `info?.id ?? sessionID`
- [ ] `extractSessionId` does not append redundant `?? undefined`
- [ ] `post-file-tool-nudge` uses the same priority as all other locations
- [ ] `SessionLifecycle.dispatchSessionDeleted` runs all registered cleanup callbacks
- [ ] Cleanup callback errors are caught and logged, remaining callbacks still run
- [ ] `consumePending` is atomic — only one caller gets `true` per `markPending` call
- [ ] `SessionLifecycle.hasPendingSession` respects TTL and doesn't return stale entries
- [ ] `SessionLifecycle.clearSession` cleans up pending state and timers
- [ ] `HookRegistry` warns when a handler is registered after its hook point has dispatched
- [ ] `HookRegistry.dispatch` runs handlers in registration order
- [ ] Adding a new hook requires registering with the registry — no manual dispatch-site wiring
- [ ] `chat.headers` still works (manual sync dispatch unchanged, with explanatory comment)
- [ ] All 1367 existing tests pass
- [ ] `bun run check:ci` passes
- [ ] `bun run typecheck` passes

## Out of scope

- Changing the hook factory pattern (factories still return handler maps)
- Adding new hooks to the codebase
- Changing handler signatures (e.g., `experimental.chat.messages.transform`)
- Non-hook event handling (multiplexer, companion, interview, preset, depthTracker)
- Sync hook points like `chat.headers`
- Configurable TTL (keep as static constant, YAGNI)
- Dynamic hook registration after dispatch (runtime guard logs a warning, not an error)
- Typed dispatch wrappers per hook point (YAGNI; add if casts become painful)
