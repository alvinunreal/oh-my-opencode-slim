# Share closePane graceful-shutdown across multiplexer backends

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the duplicated Ctrl+C → 250ms → kill/close pane lifecycle from tmux/zellij/herdr `closePane` into one `gracefulClosePane` helper in `shared.ts`, and force the hidden exit-code/guard inconsistencies into the open via an `options` param.

**Architecture:** One shared helper takes the binary, paneId, and the two backend-specific command arrays (`ctrlC`, `close`) plus an `options` object for the divergent bits (accept exit code 1, empty-paneId returns true). Each backend's `closePane` shrinks to: guard → `getBinary()` → `return gracefulClosePane(...)`. No base class, no interface change. `session-manager.ts` is untouched (it already uses the `Multiplexer` interface).

**Tech Stack:** TypeScript, Bun test, existing `crossSpawn` from `../utils/compat`, existing `log` from `../utils/logger`.

---

### Task 1: Add `gracefulClosePane` helper + tests

**Files:**
- Modify: `src/multiplexer/shared.ts`
- Create: `src/multiplexer/shared.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { gracefulClosePane } from './shared';
import { crossSpawn } from '../utils/compat';

const DELAY_MS = 250;

function fakeProc(exitCode: number, stderr = '') {
  return {
    exited: Promise.resolve(exitCode),
    stdout: () => Promise.resolve(''),
    stderr: () => Promise.resolve(stderr),
  } as unknown as ReturnType<typeof crossSpawn>;
}

describe('gracefulClosePane', () => {
  beforeEach(() => mock.module('../utils/compat', () => ({ crossSpawn: mock() })));
  afterEach(() => mock.restore());

  it('sends Ctrl+C, waits 250ms, then closes, returning true on exit 0', async () => {
    const calls: string[][] = [];
    let ctrlCTime = 0;
    let closeTime = 0;
    (crossSpawn as unknown as ReturnType<typeof mock>).mockImplementation((args: string[]) => {
      if (args.includes('C-c') || args.includes('\u0003') || args.includes('ctrl+c')) {
        ctrlCTime = Date.now();
      } else {
        closeTime = Date.now();
      }
      calls.push(args);
      return fakeProc(0);
    });

    const ok = await gracefulClosePane('tmux', '%1', {
      ctrlC: ['send-keys', '-t', '%1', 'C-c'],
      close: ['kill-pane', '-t', '%1'],
    });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(closeTime - ctrlCTime).toBeGreaterThanOrEqual(DELAY_MS - 20);
  });

  it('returns true when acceptExitCode1 and exit code is 1', async () => {
    (crossSpawn as unknown as ReturnType<typeof mock>).mockImplementation(() => fakeProc(1));
    const ok = await gracefulClosePane('zellij', 'terminal_1', {
      ctrlC: ['action', 'write', '--pane-id', 'terminal_1', '\u0003'],
      close: ['action', 'close-pane', '--pane-id', 'terminal_1'],
      acceptExitCode1: true,
    });
    expect(ok).toBe(true);
  });

  it('returns false on exit 1 when acceptExitCode1 is false', async () => {
    (crossSpawn as unknown as ReturnType<typeof mock>).mockImplementation(() => fakeProc(1));
    const ok = await gracefulClosePane('tmux', '%1', {
      ctrlC: ['send-keys', '-t', '%1', 'C-c'],
      close: ['kill-pane', '-t', '%1'],
    });
    expect(ok).toBe(false);
  });

  it('returns emptyPaneReturnsTrue when paneId is empty', async () => {
    (crossSpawn as unknown as ReturnType<typeof mock>).mockImplementation(() => fakeProc(0));
    const ok = await gracefulClosePane('zellij', '', {
      ctrlC: ['action', 'write', '--pane-id', '', '\u0003'],
      close: ['action', 'close-pane', '--pane-id', ''],
      emptyPaneReturnsTrue: true,
    });
    expect(ok).toBe(true);
    expect((crossSpawn as unknown as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  it('returns false when binary is null', async () => {
    const ok = await gracefulClosePane(null, '%1', {
      ctrlC: ['x'],
      close: ['y'],
    });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/multiplexer/shared.test.ts`
Expected: FAIL — `gracefulClosePane` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/multiplexer/shared.ts`:

```typescript
const GRACEFUL_SHUTDOWN_DELAY_MS = 250;

export interface GracefulClosePaneOptions {
  /** Backend-specific Ctrl+C command args (binary prepended by caller). */
  ctrlC: string[];
  /** Backend-specific close/kill command args (binary prepended by caller). */
  close: string[];
  /** Accept exit code 1 as success (zellij/herdr treat "already closed" as 1). */
  acceptExitCode1?: boolean;
  /** Return true for empty/unknown paneId instead of false (zellij/herdr behavior). */
  emptyPaneReturnsTrue?: boolean;
}

export async function gracefulClosePane(
  binary: string | null,
  paneId: string,
  options: GracefulClosePaneOptions,
): Promise<boolean> {
  if (!binary) return false;

  const isEmpty = !paneId || paneId === 'unknown';
  if (isEmpty) return options.emptyPaneReturnsTrue ?? false;

  try {
    const ctrlCProc = crossSpawn([binary, ...options.ctrlC], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await ctrlCProc.exited;

    await new Promise((r) => setTimeout(r, GRACEFUL_SHUTDOWN_DELAY_MS));

    const proc = crossSpawn([binary, ...options.close], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;

    if (exitCode === 0) return true;
    if (options.acceptExitCode1 && exitCode === 1) return true;
    return false;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/multiplexer/shared.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/multiplexer/shared.ts src/multiplexer/shared.test.ts
git commit -m "feat(multiplexer): add gracefulClosePane helper with tests"
```

---

### Task 2: Rewrite tmux `closePane` to use the helper

**Files:**
- Modify: `src/multiplexer/tmux/index.ts:115-164`

- [ ] **Step 1: Replace the closePane body**

Replace lines 115-164 with:

```typescript
  async closePane(paneId: string): Promise<boolean> {
    const tmux = await this.getBinary();
    return gracefulClosePane(tmux, paneId, {
      ctrlC: ['send-keys', '-t', paneId, 'C-c'],
      close: ['kill-pane', '-t', paneId],
      // tmux: empty paneId is a real error, exit 0 only.
      emptyPaneReturnsTrue: false,
    });
  }
```

Note: tmux used to call `this.scheduleLayout()` on success. That rebalance is a tmux-specific concern, not part of the shared shutdown. Preserve it by wrapping:

```typescript
  async closePane(paneId: string): Promise<boolean> {
    const tmux = await this.getBinary();
    const closed = await gracefulClosePane(tmux, paneId, {
      ctrlC: ['send-keys', '-t', paneId, 'C-c'],
      close: ['kill-pane', '-t', paneId],
    });
    if (closed) this.scheduleLayout();
    return closed;
  }
```

- [ ] **Step 2: Add the import**

At top of `src/multiplexer/tmux/index.ts`, add to the shared import (or new line):

```typescript
import { gracefulClosePane } from '../shared';
```

- [ ] **Step 3: Verify typecheck + existing tmux tests**

Run: `bun run typecheck && bun test src/multiplexer/`
Expected: typecheck clean, all multiplexer tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/multiplexer/tmux/index.ts
git commit -m "refactor(multiplexer): use gracefulClosePane in tmux"
```

---

### Task 3: Rewrite zellij `closePane` to use the helper

**Files:**
- Modify: `src/multiplexer/zellij/index.ts:496-525`

- [ ] **Step 1: Replace the closePane body**

Replace lines 496-525 with:

```typescript
  async closePane(paneId: string): Promise<boolean> {
    const zellij = await this.getBinary();
    return gracefulClosePane(zellij, paneId, {
      ctrlC: ['action', 'write', '--pane-id', paneId, '\u0003'],
      close: ['action', 'close-pane', '--pane-id', paneId],
      acceptExitCode1: true,
      emptyPaneReturnsTrue: true,
    });
  }
```

- [ ] **Step 2: Add the import**

At top of `src/multiplexer/zellij/index.ts`:

```typescript
import { gracefulClosePane } from '../shared';
```

- [ ] **Step 3: Verify typecheck + tests**

Run: `bun run typecheck && bun test src/multiplexer/`
Expected: clean + pass.

- [ ] **Step 4: Commit**

```bash
git add src/multiplexer/zellij/index.ts
git commit -m "refactor(multiplexer): use gracefulClosePane in zellij"
```

---

### Task 4: Rewrite herdr `closePane` to use the helper

**Files:**
- Modify: `src/multiplexer/herdr/index.ts:155-200`

- [ ] **Step 1: Replace the closePane body**

Replace lines 155-200 with:

```typescript
  async closePane(paneId: string): Promise<boolean> {
    const herdr = await this.getBinary();
    return gracefulClosePane(herdr, paneId, {
      ctrlC: ['pane', 'send-keys', paneId, 'ctrl+c'],
      close: ['pane', 'close', paneId],
      acceptExitCode1: true,
      emptyPaneReturnsTrue: true,
    });
  }
```

- [ ] **Step 2: Add the import**

At top of `src/multiplexer/herdr/index.ts`:

```typescript
import { gracefulClosePane } from '../shared';
```

- [ ] **Step 3: Verify typecheck + tests**

Run: `bun run typecheck && bun test src/multiplexer/`
Expected: clean + pass.

- [ ] **Step 4: Commit**

```bash
git add src/multiplexer/herdr/index.ts
git commit -m "refactor(multiplexer): use gracefulClosePane in herdr"
```

---

### Task 5: Final verification + lint

**Files:**
- None new

- [ ] **Step 1: Run full check + test suite**

Run: `bun run check:ci && bun run typecheck && bun test`
Expected: Biome clean, types clean, all tests pass.

- [ ] **Step 2: Confirm no orphaned duplicate logic**

Run: `grep -rn "setTimeout(r, 250)" src/multiplexer/`
Expected: only the `GRACEFUL_SHUTDOWN_DELAY_MS` usage inside `shared.ts`. No per-backend 250ms copies remain.

- [ ] **Step 3: Commit (if any lint auto-fix applied) and push branch**

```bash
git add -A
git commit -m "chore(multiplexer): lint fixes for closePane refactor" || echo "nothing to commit"
git push -u origin fix/703-share-closepane-shutdown
```

---

## Self-Review

**1. Spec coverage:** Issue #703 asks for one `gracefulClosePane(binary, paneId, { ctrlC, close }, options?)` helper in `shared.ts`. Task 1 delivers exactly that signature + tests. Tasks 2-4 wire all three backends. Task 5 verifies. The "inconsistencies forced into the open" (exit 0 vs 0||1, empty guard false vs true) are handled by `acceptExitCode1` / `emptyPaneReturnsTrue` options, preserving each backend's real behavior rather than silently unifying it. Covered.

**2. Placeholder scan:** No TBD/TODO. Every step has code or exact command. The tmux `scheduleLayout` nuance is explicitly handled, not deferred.

**3. Type consistency:** `gracefulClosePane(binary: string | null, paneId: string, options: GracefulClosePaneOptions)` is defined in Task 1 and called identically in Tasks 2-4. `ctrlC`/`close` are `string[]`. `acceptExitCode1`/`emptyPaneReturnsTrue` are optional booleans. Consistent.

**Ponytail note:** Deliberately NOT extracting `spawnPane` (diverges too much per @oracle) and NOT building a `MultiplexerBase` class (over-engineering for this scope). The single helper is the smallest change that removes the 3-place shutdown hazard. `session-manager.ts` is correctly left alone.
