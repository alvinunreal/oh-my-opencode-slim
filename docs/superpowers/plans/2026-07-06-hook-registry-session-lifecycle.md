# HookRegistry + SessionLifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate manual hook wiring, scattered session.deleted cleanup, and the reversed-priority session ID bug.

**Architecture:** Three-phase build: (1) `extractSessionId` utility replacing 8 duplicated sites, (2) `SessionLifecycle` coordinator owning cleanup callbacks + signaling channel with timestamp TTL, (3) `HookRegistry` for all async hook dispatch.

**Tech Stack:** TypeScript, Bun, Biome

## Global Constraints

- Line width: 80 chars, 2-space indent, trailing commas
- No explicit `any` (linter warning)
- Biome organizes imports, run `bun run check:ci` before commit
- Commit after every green test run, wait for user "proceed" at each task boundary

---
## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `src/utils/extract-session-id.ts` | `extractSessionId(info, sessionID)` — priority `info?.id ?? sessionID` |
| `src/utils/extract-session-id.test.ts` | Tests for priority, null/undefined, edge cases |
| `src/hooks/session-lifecycle.ts` | `SessionLifecycle` class — cleanup callback registry + signaling channel with timestamp TTL |
| `src/hooks/session-lifecycle.test.ts` | Tests for cleanup registration/dispatch, signaling, TTL expiry |
| `src/hooks/hook-registry.ts` | `HookRegistry` class — ordered dispatcher with late-registration warning |
| `src/hooks/hook-registry.test.ts` | Tests for registration order, late-registration, no-op dispatch |

### Modified files
| File | Changes |
|------|---------|
| `src/index.ts` | Delete `let` hook declarations, use `const` inside try, register with HookRegistry, replace manual dispatch with `registry.dispatch()`, wire SessionLifecycle for session.deleted |
| `src/hooks/post-file-tool-nudge/index.ts` | Accept `SessionLifecycle`, delegate Sets to coordinator, use `extractSessionId`, remove `event()` method, remove `hasPendingSession` export |
| `src/hooks/phase-reminder/index.ts` | Accept `SessionLifecycle` param, import `hasPendingSession` from `session-lifecycle` |
| `src/hooks/task-session-manager/index.ts` | Use `extractSessionId`, register cleanup callback with coordinator |
| `src/hooks/foreground-fallback/index.ts` | Accept `SessionLifecycle`, register cleanup callback, use `extractSessionId` |
| `src/hooks/post-file-tool-nudge/index.test.ts` | Pass coordinator to factory |
| `src/hooks/phase-reminder/index.test.ts` | Pass coordinator to factory, update `hasPendingSession` import |
| `src/hooks/task-session-manager/index.test.ts` | Verify cleanup through coordinator |
| `src/multiplexer/session-manager.ts` | Use `extractSessionId` (line 610) |

---
### Task 0: Baseline test run

- [ ] **Step 1: Run baseline tests**

Run: `bun test`
Expected: 1367 pass, 0 fail

- [ ] **Step 2: Record output reference**

---
### Task 1: `src/utils/extract-session-id.ts`

**Files:**
- Create: `src/utils/extract-session-id.ts`
- Create: `src/utils/extract-session-id.test.ts`
- Modify: `src/index.ts` (lines 889, 897)
- Modify: `src/multiplexer/session-manager.ts` (line 610)
- Modify: `src/hooks/task-session-manager/index.ts` (lines 582, 635, 659, 693)
- Modify: `src/hooks/foreground-fallback/index.ts` (line 236)
- Modify: `src/hooks/post-file-tool-nudge/index.ts` (line 77 — reversed priority)

**Interfaces:**
- Produces: `export function extractSessionId(info: { id?: string } | undefined | null, sessionID: string | undefined | null): string | undefined`

- [ ] **Step 1: Create the utility**

```typescript
export function extractSessionId(
  info: { id?: string } | undefined | null,
  sessionID: string | undefined | null,
): string | undefined {
  return info?.id ?? sessionID;
}
```

- [ ] **Step 2: Create tests**

```typescript
import { describe, expect, test } from 'bun:test';
import { extractSessionId } from './extract-session-id';

describe('extractSessionId', () => {
  test('prefers info.id over sessionID', () => {
    expect(extractSessionId({ id: 'i' }, 's')).toBe('i');
  });

  test('falls back to sessionID when info.id missing', () => {
    expect(extractSessionId({}, 's')).toBe('s');
    expect(extractSessionId({ id: undefined }, 's')).toBe('s');
  });

  test('returns undefined when both missing', () => {
    expect(extractSessionId(undefined, undefined)).toBeUndefined();
    expect(extractSessionId(null, null)).toBeUndefined();
    expect(extractSessionId({}, undefined)).toBeUndefined();
  });

  test('handles null info', () => {
    expect(extractSessionId(null, 's')).toBe('s');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/utils/extract-session-id.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 4: Replace all 8 manual extraction sites**

Each `props?.info?.id ?? props?.sessionID` → `extractSessionId(props?.info, props?.sessionID)`.

Fix the reversed-priority site at `src/hooks/post-file-tool-nudge/index.ts:77`:
```typescript
input.event.properties?.sessionID ?? input.event.properties?.info?.id
```
→
```typescript
extractSessionId(
  input.event.properties?.info,
  input.event.properties?.sessionID,
)
```

Deduplicate the two adjacent `session.deleted` blocks in `src/index.ts:885-905` into one block using `extractSessionId`.

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: Same count as baseline, all pass

- [ ] **Step 6: Commit**

```bash
git add src/utils/extract-session-id.ts src/utils/extract-session-id.test.ts src/index.ts src/multiplexer/session-manager.ts src/hooks/task-session-manager/index.ts src/hooks/foreground-fallback/index.ts src/hooks/post-file-tool-nudge/index.ts
bun run check:ci
git commit -m "feat: add extractSessionId utility, fix reversed-priority session ID bug"
```

---
### Task 2: SessionLifecycle coordinator class + tests

**Files:**
- Create: `src/hooks/session-lifecycle.ts`
- Create: `src/hooks/session-lifecycle.test.ts`

**Interfaces:**
- Produces:
```typescript
export class SessionLifecycle {
  static readonly PENDING_TTL_MS: number;
  constructor(log: (msg: string, meta?: Record<string, unknown>) => void);
  onSessionDeleted(callback: (sessionId: string) => void): void;
  dispatchSessionDeleted(sessionId: string): void;
  markPending(sessionId: string): void;
  /** Returns true only once per markPending call. */
  consumePending(sessionId: string): boolean;
  hasPendingSession(sessionId: string): boolean;
  clearSession(sessionId: string): void;
}
```

- [ ] **Step 1: Create the class**

```typescript
// src/hooks/session-lifecycle.ts
export class SessionLifecycle {
  static readonly PENDING_TTL_MS = 5 * 60 * 1000;

  #cleanupCallbacks: Array<(sessionId: string) => void> = [];
  #pendingSessionIds = new Set<string>();
  #everPendingSessionIds = new Set<string>();
  #pendingTimestamps = new Map<string, number>();
  #log: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(
    log: (msg: string, meta?: Record<string, unknown>) => void,
  ) {
    this.#log = log;
  }

  onSessionDeleted(callback: (sessionId: string) => void): void {
    this.#cleanupCallbacks.push(callback);
  }

  dispatchSessionDeleted(sessionId: string): void {
    for (const cb of this.#cleanupCallbacks) {
      try {
        cb(sessionId);
      } catch (error) {
        this.#log(
          `[session-lifecycle] cleanup callback failed for session ${sessionId}`,
          { error },
        );
      }
    }
  }

  markPending(sessionId: string): void {
    this.#pendingSessionIds.add(sessionId);
    this.#everPendingSessionIds.add(sessionId);
    this.#pendingTimestamps.set(sessionId, Date.now());
  }

  /** Atomic — only one caller gets true per markPending call. */
  consumePending(sessionId: string): boolean {
    const had = this.#pendingSessionIds.has(sessionId);
    this.#pendingSessionIds.delete(sessionId);
    this.#pendingTimestamps.delete(sessionId);
    return had;
  }

  hasPendingSession(sessionId: string): boolean {
    const ts = this.#pendingTimestamps.get(sessionId);
    if (ts && Date.now() - ts > SessionLifecycle.PENDING_TTL_MS) {
      this.#pendingTimestamps.delete(sessionId);
      this.#pendingSessionIds.delete(sessionId);
      return false;
    }
    return (
      this.#everPendingSessionIds.has(sessionId)
      && !this.#pendingSessionIds.has(sessionId)
    );
  }

  clearSession(sessionId: string): void {
    this.#pendingSessionIds.delete(sessionId);
    this.#everPendingSessionIds.delete(sessionId);
    this.#pendingTimestamps.delete(sessionId);
  }
}
```

- [ ] **Step 2: Create tests**

```typescript
import { describe, expect, test } from 'bun:test';
import { SessionLifecycle } from './session-lifecycle';

const noop = () => {};

describe('SessionLifecycle', () => {
  test('dispatchSessionDeleted runs callbacks in order', () => {
    const lc = new SessionLifecycle(noop);
    const ran: string[] = [];
    lc.onSessionDeleted((id) => ran.push(`a:${id}`));
    lc.onSessionDeleted((id) => ran.push(`b:${id}`));
    lc.dispatchSessionDeleted('s1');
    expect(ran).toEqual(['a:s1', 'b:s1']);
  });

  test('dispatchSessionDeleted continues after callback error', () => {
    const lc = new SessionLifecycle(() => {});
    const ran: string[] = [];
    lc.onSessionDeleted(() => { throw new Error('fail'); });
    lc.onSessionDeleted((id) => ran.push(id));
    lc.dispatchSessionDeleted('s1');
    expect(ran).toEqual(['s1']);
  });

  test('consumePending is atomic', () => {
    const lc = new SessionLifecycle(noop);
    lc.markPending('s1');
    expect(lc.consumePending('s1')).toBe(true);
    expect(lc.consumePending('s1')).toBe(false);
  });

  test('hasPendingSession after consume', () => {
    const lc = new SessionLifecycle(noop);
    lc.markPending('s1');
    lc.consumePending('s1');
    expect(lc.hasPendingSession('s1')).toBe(true);
  });

  test('hasPendingSession false for unknown session', () => {
    const lc = new SessionLifecycle(noop);
    expect(lc.hasPendingSession('s1')).toBe(false);
  });

  test('clearSession removes all state', () => {
    const lc = new SessionLifecycle(noop);
    lc.markPending('s1');
    lc.consumePending('s1');
    lc.clearSession('s1');
    expect(lc.hasPendingSession('s1')).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test src/hooks/session-lifecycle.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/hooks/session-lifecycle.ts src/hooks/session-lifecycle.test.ts
bun run check:ci
git commit -m "feat: add SessionLifecycle coordinator"
```

---
### Task 3: Update hooks to use SessionLifecycle + extractSessionId

**Files:**
- Modify: `src/hooks/post-file-tool-nudge/index.ts`
- Modify: `src/hooks/post-file-tool-nudge/index.test.ts`
- Modify: `src/hooks/phase-reminder/index.ts`
- Modify: `src/hooks/phase-reminder/index.test.ts`
- Modify: `src/hooks/task-session-manager/index.ts`
- Modify: `src/hooks/task-session-manager/index.test.ts`
- Modify: `src/hooks/foreground-fallback/index.ts`

**Interfaces:**
- Consumes: `SessionLifecycle` from `../session-lifecycle`, `extractSessionId` from `../../utils/extract-session-id`

- [ ] **Step 1: Update post-file-tool-nudge/index.ts**

Remove module-scoped Sets, `hasPendingSession` export, and `event()` method (only handled session.deleted). Accept `coordinator?: SessionLifecycle` in factory options. Cleanup is handled via coordinator callback. Use `coordinator.markPending()` and `coordinator.consumePending()` instead of module-scoped Sets.

```typescript
import { PHASE_REMINDER } from '../../config/constants';
import type { SessionLifecycle } from '../session-lifecycle';

const FILE_TOOLS = new Set(['Read', 'read', 'Write', 'write']);

interface PostFileToolNudgeOptions {
  shouldInject?: (sessionID: string) => boolean;
  coordinator?: SessionLifecycle;
}

export function createPostFileToolNudgeHook(
  options: PostFileToolNudgeOptions = {},
) {
  const { coordinator } = options;

  if (coordinator) {
    coordinator.onSessionDeleted(
      (sid) => coordinator.clearSession(sid),
    );
  }

  return {
    'tool.execute.after': async (
      input: { tool: string; sessionID?: string; callID?: string },
    ): Promise<void> => {
      if (!FILE_TOOLS.has(input.tool) || !input.sessionID) return;
      coordinator?.markPending(input.sessionID);
    },
    'experimental.chat.system.transform': async (
      input: { sessionID?: string },
      output: { system: string[] },
    ): Promise<void> => {
      if (!input.sessionID || !coordinator?.consumePending(input.sessionID)) {
        return;
      }
      if (options.shouldInject && !options.shouldInject(input.sessionID)) {
        return;
      }
      output.system.push(PHASE_REMINDER);
    },
  };
}
```

Note `_output` param removed from `tool.execute.after` since it was unused (was `_output: unknown`).

- [ ] **Step 2: Update phase-reminder/index.ts**

Accept `coordinator?: SessionLifecycle` parameter. Import `hasPendingSession` from the coordinator instead of `../post-file-tool-nudge`. Remove the `import { hasPendingSession }` line.

```typescript
import type { SessionLifecycle } from '../session-lifecycle';

export function createPhaseReminderHook(
  coordinator?: SessionLifecycle,
) {
  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
    ): Promise<void> => {
      // ... existing logic ...
      if (sessionId && coordinator?.hasPendingSession(sessionId)) {
        return;
      }
      // ... rest unchanged ...
    },
  };
}
```

- [ ] **Step 3: Update task-session-manager/index.ts**

All 4 `info?.id ?? sessionID` sites are already replaced with `extractSessionId` (Task 1). The `session.deleted` case in `.event()` (lines 691-721) is replaced by registering a cleanup callback with the coordinator. Add `coordinator?: SessionLifecycle` to factory options.

```typescript
interface TaskSessionManagerOptions {
  // ... existing options ...
  coordinator?: SessionLifecycle;
}
```

Register cleanup in the factory:
```typescript
if (options.coordinator) {
  options.coordinator.onSessionDeleted((sessionId) => {
    backgroundJobBoard.drop(sessionId);
    backgroundJobBoard.clearParent(sessionId);
    terminalJobsInjectedByParent.delete(sessionId);
    taskContextTracker.clearSession(sessionId);
    taskContextTracker.prune(backgroundJobBoard);
    pendingCallTracker.clearSession(sessionId);
  });
}
```

The `session.deleted` case in `.event()` is reduced to just logging (no cleanup ops):
```typescript
if (input.event.type !== 'session.deleted') return;
const sessionId = extractSessionId(
  input.event.properties?.info,
  input.event.properties?.sessionID,
);
if (!sessionId) return;
log('[task-session-manager] session.deleted observed', { sessionID: sessionId });
return;
```

- [ ] **Step 4: Update foreground-fallback/index.ts**

Accept `coordinator?: SessionLifecycle` in the constructor. Register cleanup callbacks. Use `extractSessionId` (already done in Task 1).

```typescript
constructor(
  // ... existing params ...
  private coordinator?: SessionLifecycle,
) {
  if (coordinator) {
    coordinator.onSessionDeleted((id) => {
      this.sessionModel.delete(id);
      this.sessionAgent.delete(id);
      this.sessionTried.delete(id);
      this.inProgress.delete(id);
      this.lastTrigger.delete(id);
      this.lastTriggerModel.delete(id);
      this.sessionRetries.delete(id);
    });
  }
  // ... rest of constructor ...
}
```

The `session.deleted` case in `handleEvent` (lines 226-247) is reduced to logging:
```typescript
case 'session.deleted': {
  const props = event.properties as
    | { sessionID?: string; info?: { id?: string } }
    | undefined;
  const id = extractSessionId(props?.info, props?.sessionID);
  if (id) {
    log('[foreground-fallback] session.deleted observed', { sessionID: id });
  }
  break;
}
```

- [ ] **Step 5: Update post-file-tool-nudge tests**

Each test that creates hooks with `createPostFileToolNudgeHook()` now needs a shared coordinator:

```typescript
import { SessionLifecycle } from '../session-lifecycle';

test('records pending session on Read tool', async () => {
  const coordinator = new SessionLifecycle(() => {});
  const hook = createPostFileToolNudgeHook({ coordinator });
  // ... rest same ...
});
```

The "composed" test (line 153) needs a coordinator shared between both hooks:

```typescript
test('composed: phase-reminder skips when post-file-tool-nudge handles system', async () => {
  const coordinator = new SessionLifecycle(() => {});
  const nudgeHook = createPostFileToolNudgeHook({ coordinator });
  const phaseHook = createPhaseReminderHook(coordinator);
  // ... rest same ...
});
```

- [ ] **Step 6: Update phase-reminder tests**

Tests that call `createPhaseReminderHook()` now pass the coordinator:
```typescript
const coordinator = new SessionLifecycle(() => {});
const phaseHook = createPhaseReminderHook(coordinator);
```

Import changes: `hasPendingSession` no longer needs to be imported from `../post-file-tool-nudge` — it's on the coordinator instance.

- [ ] **Step 7: Update task-session-manager tests**

If any test verifies cleanup via `.event()` with `session.deleted`, it now needs to verify cleanup through the coordinator callback instead. The `event()` method no longer performs cleanup ops.

- [ ] **Step 8: Run all tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 9: Commit**

```bash
git add src/hooks/post-file-tool-nudge/ src/hooks/phase-reminder/ src/hooks/task-session-manager/ src/hooks/foreground-fallback/
bun run check:ci
git commit -m "refactor: migrate hooks to SessionLifecycle coordinator"
```

---
### Task 4: Wire SessionLifecycle into src/index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Instantiate SessionLifecycle before hook factories**

Inside the `try` block, before any hook factory calls:
```typescript
const sessionLifecycle = new SessionLifecycle(log);
```

- [ ] **Step 2: Pass coordinator to hook factories**

`postFileToolNudgeHook = createPostFileToolNudgeHook({
  shouldInject: (sessionID) => sessionAgentMap.get(sessionID) === 'orchestrator',
  coordinator: sessionLifecycle,
});`

`taskSessionManagerHook = createTaskSessionManagerHook(ctx, { /* ...existing... */, coordinator: sessionLifecycle });`

`phaseReminderHook = createPhaseReminderHook(sessionLifecycle);`

`ForegroundFallbackManager` constructor: add `sessionLifecycle` as a parameter.

- [ ] **Step 3: Add session.deleted dispatch via coordinator**

In the `event` handler, add a dispatch block for `session.deleted`:
```typescript
if (input.event.type === 'session.deleted') {
  const props = input.event.properties as ...;
  const sessionID = extractSessionId(props?.info, props?.sessionID);
  if (sessionID) {
    sessionLifecycle.dispatchSessionDeleted(sessionID);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
bun run check:ci
git commit -m "feat: wire SessionLifecycle coordinator into plugin"
```

---
### Task 5: HookRegistry class + tests

**Files:**
- Create: `src/hooks/hook-registry.ts`
- Create: `src/hooks/hook-registry.test.ts`

**Interfaces:**
- Produces:
```typescript
export class HookRegistry {
  register(hookPoint: string, handler: (i: unknown, o: unknown) => Promise<void>): void;
  dispatch(hookPoint: string, input: unknown, output: unknown): Promise<void>;
  handlers(hookPoint: string): ReadonlyArray<(i: unknown, o: unknown) => Promise<void>>;
}
```

- [ ] **Step 1: Create the class**

```typescript
export class HookRegistry {
  #handlers = new Map<
    string,
    Array<(input: unknown, output: unknown) => Promise<void>>
  >();
  #firedHookPoints = new Set<string>();

  register(
    hookPoint: string,
    handler: (input: unknown, output: unknown) => Promise<void>,
  ): void {
    if (this.#firedHookPoints.has(hookPoint)) {
      console.warn(
        `[hook-registry] "${hookPoint}" already dispatched; late registration may miss events`,
      );
    }
    const group = this.#handlers.get(hookPoint);
    if (group) {
      group.push(handler);
    } else {
      this.#handlers.set(hookPoint, [handler]);
    }
  }

  async dispatch(
    hookPoint: string,
    input: unknown,
    output: unknown,
  ): Promise<void> {
    this.#firedHookPoints.add(hookPoint);
    const group = this.#handlers.get(hookPoint);
    if (!group) return;
    for (const handler of group) {
      await handler(input, output);
    }
  }

  handlers(
    hookPoint: string,
  ): ReadonlyArray<(input: unknown, output: unknown) => Promise<void>> {
    return this.#handlers.get(hookPoint) ?? [];
  }
}
```

- [ ] **Step 2: Create tests**

```typescript
import { describe, expect, test } from 'bun:test';
import { HookRegistry } from './hook-registry';

describe('HookRegistry', () => {
  test('dispatch runs handlers in registration order', async () => {
    const r = new HookRegistry();
    const order: number[] = [];
    r.register('test', async () => { order.push(1); });
    r.register('test', async () => { order.push(2); });
    await r.dispatch('test', {}, {});
    expect(order).toEqual([1, 2]);
  });

  test('unregistered hook point is no-op', async () => {
    const r = new HookRegistry();
    await r.dispatch('none', {}, {});
  });

  test('handlers returns empty for unregistered point', () => {
    const r = new HookRegistry();
    expect(r.handlers('x')).toEqual([]);
  });

  test('dispatch passes input and output to handlers', async () => {
    const r = new HookRegistry();
    const captured: unknown[] = [];
    r.register('test', async (i, o) => { captured.push(i, o); });
    await r.dispatch('test', { a: 1 }, { b: 2 });
    expect(captured).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test src/hooks/hook-registry.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/hooks/hook-registry.ts src/hooks/hook-registry.test.ts
bun run check:ci
git commit -m "feat: add HookRegistry for ordered handler dispatch"
```

---
### Task 6: Wire HookRegistry into src/index.ts (biggest task)

**Files:**
- Modify: `src/index.ts`

Goal: Replace manual `let` declarations + per-hook dispatch with `registry.dispatch()` calls.

- [ ] **Step 1: Understand the current pattern**

Currently the plugin function has:
1. ~15 `let xHook: ReturnType<...>` declarations outside try (lines 138-153)
2. Factory calls inside try (lines 271-322) that assign to those variables
3. 5 dispatch blocks in the return object (lines 910-1186) that call hook methods individually

- [ ] **Step 2: Convert pattern**

Replace:
```typescript
let phaseReminderHook: ReturnType<typeof createPhaseReminderHook>;
// ... in try block ...
phaseReminderHook = createPhaseReminderHook(sessionLifecycle);
// ... in return block ...
await phaseReminderHook['experimental.chat.messages.transform'](input, typedOutput);
```

With:
```typescript
// In try block:
const phaseReminder = createPhaseReminderHook(sessionLifecycle);
hookRegistry.register(
  'experimental.chat.messages.transform',
  (i, o) => phaseReminder['experimental.chat.messages.transform'](i, o as any),
);
// ... repeat for other hooks ...
```

Note: The `hookRegistry` is instantiated inside the try block. The return block only needs closure on `hookRegistry`, not on individual hook instances.

- [ ] **Step 3: Map each hook point to its dispatches**

| Hook point | Hooks that implement it |
|---|---|
| `experimental.chat.messages.transform` | taskSessionManager, phaseReminder, filterAvailableSkills |
| `experimental.chat.system.transform` | postFileToolNudge |
| `tool.execute.before` | applyPatch, taskSessionManager |
| `tool.execute.after` | delegateTaskRetry, jsonErrorRecovery, postFileToolNudge, taskSessionManager |
| `command.execute.before` | deepworkCommand, reflectCommand, loopCommand |
| `event` | foregroundFallback, taskSessionManager (session.idle/status/error only — no longer session.deleted) |
| `chat.headers` | chatHeaders (sync, stays manual) |

- [ ] **Step 4: Replace each dispatch block in the return object**

Each becomes:
```typescript
'experimental.chat.messages.transform':
  (input, output) => hookRegistry.dispatch('experimental.chat.messages.transform', input, output),
```

Note: `event` handler is special — it still dispatches to non-hook consumers (multiplexer, companion, autoUpdateChecker, interview). Only the hook portions go through the registry.

- [ ] **Step 5: Delete unused `let` declarations**

Remove the hook variable `let` declarations from the outer scope (lines 138-153). Keep non-hook `let` declarations (managers, boards, tools).

- [ ] **Step 6: Delete unused imports**

Remove any `ReturnType<typeof createXHook>` from imports that are no longer used as types.

- [ ] **Step 7: Run tests**

Run: `bun test`
Expected: All 1367+ pass

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
bun run check:ci
git commit -m "refactor: wire HookRegistry, delete manual hook dispatching"
```

---
### Task 7: Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All pass, same count as baseline

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 3: Run linter**

Run: `bun run check:ci`
Expected: No errors

- [ ] **Step 4: Update codemap if needed**

Check if `src/hooks/codemap.md` needs updating to reflect the new registry + coordinator architecture.

- [ ] **Step 5: Final commit**

```bash
git add -A
bun run check:ci
git commit -m "chore: final cleanup after HookRegistry+SessionLifecycle migration"
```
