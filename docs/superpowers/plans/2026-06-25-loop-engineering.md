# Loop Engineering: Convergence Detection & Error Tracking

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add runtime convergence signals (consecutive error tracking, timeout tracking, error budget warnings) to the BackgroundJobBoard so the orchestrator can detect stuck delegation loops and escalate before burning usage limits.

**Architecture:** Extend BackgroundJobBoard with per-job error and timeout counting, and agent-level consecutive error detection across job history. Surface these signals via `formatForPrompt()` into the orchestrator's context through the existing `experimental.chat.messages.transform` hook chain. Add configuration for error thresholds. Update the deepwork skill with stopping guidance. No new hooks, no persistence changes, no phase state machine — pure signal injection into existing infrastructure.

**Tech Stack:** TypeScript, Zod (config validation), Bun (tests)

## Global Constraints

- TypeScript strict mode enabled
- Biome formatter/linter (line width 80, single quotes, trailing commas)
- All changes must pass `bun run check:ci`, `bun run typecheck`, `bun test`
- Follow existing patterns: BackgroundJobBoard, Zod config schemas, hook chain in `src/index.ts`
- Always-on: error tracking runs by default, configurable threshold
- No persistence changes (BackgroundJobBoard stays in-memory)

## Error State Semantics

Explicit definition of which `TaskOutputState` values trigger increment vs reset:

| State | Effect on errorCount | Rationale |
|-------|---------------------|-----------|
| `error` | **Increment** | Agent failed — this is the primary signal |
| `completed` | **Reset to 0** | Success — consecutive error streak broken |
| `cancelled` | **Increment** | Orchestrator-initiated cancellation = failed attempt |
| `running` | No change | Job still in progress |
| `reconciled` | No change | Post-terminal state, not a new error |

Additionally, track `timeoutCount` separately — timeouts are a distinct failure mode from errors.

## Council Review Issues Addressed

| Issue | Resolution |
|-------|-----------|
| SubagentDepthTracker is wrong pattern | Use BackgroundJobBoard extension (existing per-session state) |
| Deepwork hook lacks messages.transform | Extend task-session-manager's messages.transform (already wired) |
| Same error signature ≠ same problem | Track per-job error count, not signature matching |
| Only covers orchestrator loops | Agent-agnostic via BackgroundJobBoard (works for @fixer, @oracle, etc.) |
| Persistence inconsistency | Keep everything in-memory (consistent with BackgroundJobBoard) |
| Hook execution order | No new hook — extends existing formatForPrompt call chain |
| Convergence detection is the real problem | Surface error/timeout counts + automated validation signals |
| "LLM is branching logic" vs constraints | Provide signals, not constraints — LLM decides based on warnings |
| Concurrent deepwork sessions | BackgroundJobBoard already filters by parentSessionID |
| Orchestrator can ignore termination | Signals + skill guidance, not hard blocks (same as phase-reminder) |
| registerLaunch resets errorCount | **FIXED:** errorCount does NOT reset on re-launch — persists across attempts |
| getConsecutiveErrors doesn't check consecutive | **FIXED:** Scans job history for consecutive error streak |
| No error state definition | **FIXED:** Explicit table above defining increment/reset per state |
| "Hard stops" vs "signals not constraints" | **FIXED:** Renamed to "soft stops" (guidance, not enforcement) |
| errorCount misses timeouts | **FIXED:** Added timeoutCount tracking |
| Config is always-on not opt-in | **FIXED:** Updated language to "always-on, configurable" |
| formatForPrompt token inflation | **FIXED:** Cap warnings at top 3 agents |
| markCancelled bypasses errorCount | **FIXED:** Added errorCount increment to markCancelled() |
| "consecutive" label on per-job count | **FIXED:** Removed "consecutive" from per-job formatJob display |
| Missing errorCount preservation test | **FIXED:** Added dedicated test for re-launch preservation |
| timeoutCount increments on non-terminal | **FIXED:** Tightened to terminal timeout states only |
| Active-only warnings undocumented | **FIXED:** Added comment explaining intentional behavior |

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/utils/background-job-board.ts` | Add `errorCount` + `timeoutCount` fields, `getConsecutiveErrors()` method, extend `formatForPrompt()` with warnings |
| `src/utils/background-job-board.test.ts` | Tests for error counting, consecutive error detection, timeout tracking, formatForPrompt warnings |
| `src/config/schema.ts` | Add `loopEngineering` config block to `PluginConfigSchema` |
| `src/config/constants.ts` | Add default constants for error thresholds |
| `src/index.ts` | Wire loop engineering config into BackgroundJobBoard construction |
| `src/skills/deepwork/SKILL.md` | Add stopping guidance and escalation ladder |

---

### Task 1: Add error and timeout counting to BackgroundJobRecord

**Files:**
- Modify: `src/utils/background-job-board.ts:12-34`

**Interfaces:**
- Consumes: existing `BackgroundJobRecord` type
- Produces: extended `BackgroundJobRecord` with `errorCount` and `timeoutCount` fields

- [ ] **Step 1: Add `errorCount` and `timeoutCount` fields to `BackgroundJobRecord`**

```typescript
export interface BackgroundJobRecord {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description: string;
  objective?: string;
  state: BackgroundJobState;
  timedOut: boolean;
  statusUncertain: boolean;
  cancellationRequested: boolean;
  terminalUnreconciled: boolean;
  launchedAt: number;
  lastLaunchedAt: number;
  updatedAt: number;
  lastLiveBusyAt?: number;
  completedAt?: number;
  resultSummary?: string;
  lastStatusError?: string;
  alias: string;
  lastUsedAt: number;
  terminalState?: TaskOutputState;
  contextFiles: ContextFile[];
  errorCount: number;    // NEW: consecutive errors (increment on error/cancel, reset on completed)
  timeoutCount: number;  // NEW: consecutive timeouts (increment on timeout, reset on completed)
}
```

- [ ] **Step 2: Initialize fields in `registerLaunch` — DO NOT reset on re-launch**

In `src/utils/background-job-board.ts`, the `registerLaunch` method creates new records (line 126-147) and updates existing records (line 103-123).

**Critical:** `errorCount` and `timeoutCount` must NOT be reset when re-launching an existing task. The whole point is detecting repeated failures across attempts. If the orchestrator re-launches `fix-1` after it failed, the error count should persist.

For new records (around line 126):
```typescript
const record: BackgroundJobRecord = {
  // ... existing fields ...
  contextFiles: [],
  errorCount: 0,    // NEW: starts at 0 for new tasks
  timeoutCount: 0,  // NEW: starts at 0 for new tasks
};
```

For existing record updates (around line 103) — **add errorCount and timeoutCount from existing record** (NOT reset to 0):
```typescript
const updated = {
  ...existing,
  // ... existing reset fields (state, timedOut, etc.) ...
  // errorCount and timeoutCount are NOT reset — they persist across re-launches
  // This is intentional: repeated failures should accumulate
};
```

- [ ] **Step 3: Increment/reset counts in `updateStatus` based on state semantics**

In `src/utils/background-job-board.ts`, the `updateStatus` method (line 150-187) builds the updated record. Add error/timeout count logic:

```typescript
// After the existing state update logic, before building `updated`:
const errorCount =
  input.state === 'error' || input.state === 'cancelled'
    ? existing.errorCount + 1
    : input.state === 'completed'
      ? 0  // reset on success
      : existing.errorCount;

// Only increment timeoutCount on terminal timeout (not non-terminal timedOut flag).
// Assumption: timeouts arrive as { state: 'error', timedOut: true } in a single update.
// If a running+timedOut job later errors without timedOut, the timeout is not counted.
// This is acceptable — the primary signal is errorCount, timeoutCount is supplementary.
const isTerminal = TERMINAL_STATES.has(input.state);
const timeoutCount =
  input.timedOut && isTerminal
    ? existing.timeoutCount + 1
    : input.state === 'completed'
      ? 0  // reset on success
      : existing.timeoutCount;

const updated: BackgroundJobRecord = {
  ...existing,
  // ... existing fields ...
  errorCount,
  timeoutCount,
};
```

- [ ] **Step 4: Increment `errorCount` in `markCancelled`**

**Critical:** `markCancelled()` (line 257-290) sets `state: 'cancelled'` directly without calling `updateStatus()`. The errorCount increment logic in Step 3 won't fire. Add errorCount increment to `markCancelled`. Note: errorCount also increments in updateStatus() for 'error' and 'cancelled' states. This path handles direct cancellations that bypass updateStatus(). Each state transition = one failure event.

```typescript
markCancelled(
  taskID: string,
  reason?: string,
  now = Date.now(),
  options: { force?: boolean } = {},
): BackgroundJobRecord | undefined {
  const existing = this.jobs.get(taskID);
  if (!existing) return undefined;
  if (!options.force) {
    if (existing.state === 'reconciled') return existing;
    if (TERMINAL_STATES.has(existing.state)) return existing;
  }

  const notifyTerminal =
    !TERMINAL_STATES.has(existing.state) && existing.state !== 'reconciled';
  const summary = normalizeCancelReason(reason);
  const updated: BackgroundJobRecord = {
    ...existing,
    state: 'cancelled',
    timedOut: false,
    statusUncertain: false,
    cancellationRequested: true,
    terminalUnreconciled: true,
    updatedAt: now,
    completedAt: existing.completedAt ?? now,
    terminalState: 'cancelled',
    resultSummary: summary,
    lastStatusError: undefined,
    // Don't penalize already-completed jobs with force-cancel cleanup
    errorCount:
      existing.state === 'completed'
        ? existing.errorCount
        : existing.errorCount + 1,
  };

  this.jobs.set(taskID, updated);
  if (notifyTerminal) this.terminalStateListener?.(taskID);
  return updated;
}
```

- [ ] **Step 5: Add test for errorCount preservation across re-launch**

Add to `src/utils/background-job-board.test.ts`:

```typescript
describe('errorCount persistence', () => {
  it('preserves errorCount across re-launch of same taskID', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-1', state: 'error' });
    expect(board.get('fix-1')?.errorCount).toBe(1);

    // Re-launch same taskID — errorCount should persist
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    expect(board.get('fix-1')?.errorCount).toBe(1); // preserved, not reset

    // Another error increments further
    board.updateStatus({ taskID: 'fix-1', state: 'error' });
    expect(board.get('fix-1')?.errorCount).toBe(2);
  });

  it('preserves timeoutCount across re-launch', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-1', state: 'error', timedOut: true });
    expect(board.get('fix-1')?.timeoutCount).toBe(1);

    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    expect(board.get('fix-1')?.timeoutCount).toBe(1); // preserved
  });

  it('does not increment timeoutCount for non-terminal timedOut', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    // Running with timedOut flag — should NOT count (not terminal)
    board.updateStatus({ taskID: 'fix-1', state: 'running', timedOut: true });
    expect(board.get('fix-1')?.timeoutCount).toBe(0);
  });

  it('increments errorCount in markCancelled', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.markCancelled('fix-1', 'user cancelled');
    expect(board.get('fix-1')?.errorCount).toBe(1);
  });

  it('resets counts on completed state', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-1', state: 'error' });
    board.updateStatus({ taskID: 'fix-1', state: 'error' });
    expect(board.get('fix-1')?.errorCount).toBe(2);

    board.updateStatus({ taskID: 'fix-1', state: 'completed' });
    expect(board.get('fix-1')?.errorCount).toBe(0);
  });

  it('does not inflate errorCount when force-cancelling a completed job', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-1', state: 'completed' });
    expect(board.get('fix-1')?.errorCount).toBe(0);

    // Force-cancel a completed job — should not penalize it
    board.markCancelled('fix-1', 'cleanup', Date.now(), { force: true });
    expect(board.get('fix-1')?.errorCount).toBe(0);
  });
});
```

- [ ] **Step 6: Run existing tests to verify no regressions**

Run: `bun test src/utils/background-job-board.test.ts`
Expected: All existing tests pass (errorCount/timeoutCount default to 0, no behavior change)

- [ ] **Step 7: Commit**

```bash
git add src/utils/background-job-board.ts src/utils/background-job-board.test.ts
git commit -m "feat: add errorCount and timeoutCount to BackgroundJobRecord"
```

---

### Task 2: Add consecutive error detection method

**Files:**
- Modify: `src/utils/background-job-board.ts` (add method to `BackgroundJobBoard` class)

**Interfaces:**
- Consumes: `BackgroundJobRecord` with `errorCount` field
- Produces: `getConsecutiveErrors(parentSessionID, agent)` method returning number

- [ ] **Step 1: Add `getConsecutiveErrors` method**

Add this method to the `BackgroundJobBoard` class (after `hasTerminalUnreconciled` around line 368):

```typescript
/**
 * Count consecutive errors for a specific agent under a parent session.
 *
 * Scans the job history for this agent in reverse chronological order.
 * Counts consecutive error/cancelled states from the most recent job backward.
 * Stops counting when it hits a completed state.
 *
 * This is different from per-job errorCount: a single job can have errorCount > 1
 * if updateStatus was called multiple times, but consecutiveErrors counts distinct
 * jobs that ended in error.
 */
getConsecutiveErrors(
  parentSessionID: string,
  agent: string,
): number {
  const jobs = this.list(parentSessionID);
  const agentJobs = jobs.filter((job) => job.agent === agent);
  if (agentJobs.length === 0) return 0;

  // Scan from most recent backward, count consecutive error/cancelled states
  let consecutive = 0;
  for (let i = agentJobs.length - 1; i >= 0; i--) {
    const job = agentJobs[i];
    const terminal = job.terminalState ?? terminalStateOf(job.state);
    if (terminal === 'error' || terminal === 'cancelled') {
      consecutive++;
    } else if (terminal === 'completed') {
      break; // success breaks the streak
    }
    // running/reconciled jobs don't break or extend the streak
  }
  return consecutive;
}
```

- [ ] **Step 2: Add tests for `getConsecutiveErrors`**

Add to `src/utils/background-job-board.test.ts`:

```typescript
describe('getConsecutiveErrors', () => {
  it('returns 0 when no jobs exist', () => {
    const board = new BackgroundJobBoard();
    expect(board.getConsecutiveErrors('session-1', 'fixer')).toBe(0);
  });

  it('counts consecutive error jobs (not just one job errorCount)', () => {
    const board = new BackgroundJobBoard();
    // Job 1: 1 error
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-1', state: 'error', lastStatusError: 'fail 1' });

    // Job 2: 1 error
    board.registerLaunch({
      taskID: 'fix-2',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-2', state: 'error', lastStatusError: 'fail 2' });

    // Two distinct error jobs = consecutive errors of 2
    expect(board.getConsecutiveErrors('session-1', 'fixer')).toBe(2);
  });

  it('resets streak on completed state', () => {
    const board = new BackgroundJobBoard();
    // Job 1: error
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-1', state: 'error' });

    // Job 2: success (breaks streak)
    board.registerLaunch({
      taskID: 'fix-2',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-2', state: 'completed' });

    // Job 3: error (new streak)
    board.registerLaunch({
      taskID: 'fix-3',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-3', state: 'error' });

    expect(board.getConsecutiveErrors('session-1', 'fixer')).toBe(1);
  });

  it('counts cancelled as error for consecutive purposes', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.markCancelled('fix-1', 'user cancelled');

    board.registerLaunch({
      taskID: 'fix-2',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-2', state: 'error' });

    // Both cancelled and error count as consecutive failures
    expect(board.getConsecutiveErrors('session-1', 'fixer')).toBe(2);
  });

  it('does not count running jobs as part of streak', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    // Still running, no terminal state yet
    expect(board.getConsecutiveErrors('session-1', 'fixer')).toBe(0);
  });

  it('only counts jobs for the specified agent', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-1', state: 'error' });

    board.registerLaunch({
      taskID: 'exp-1',
      parentSessionID: 'session-1',
      agent: 'explorer',
    });
    board.updateStatus({ taskID: 'exp-1', state: 'completed' });

    // Explorer success doesn't affect fixer's streak
    expect(board.getConsecutiveErrors('session-1', 'fixer')).toBe(1);
    expect(board.getConsecutiveErrors('session-1', 'explorer')).toBe(0);
  });

  it('counts reconciled error jobs in the streak', () => {
    const board = new BackgroundJobBoard();
    // Job 1: error, then reconciled
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-1', state: 'error' });
    board.reconcile('fix-1');

    // Job 2: error (new error after reconciled one)
    board.registerLaunch({
      taskID: 'fix-2',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-2', state: 'error' });

    // Reconciled error still counts — the streak is 2
    expect(board.getConsecutiveErrors('session-1', 'fixer')).toBe(2);
  });

  it('does not count running job as breaking or extending streak', () => {
    const board = new BackgroundJobBoard();
    // Job 1: error
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-1', state: 'error' });

    // Job 2: re-launched, still running
    board.registerLaunch({
      taskID: 'fix-2',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    // Still running — streak should be 1 (from the past error)
    expect(board.getConsecutiveErrors('session-1', 'fixer')).toBe(1);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test src/utils/background-job-board.test.ts`
Expected: All tests pass including new `getConsecutiveErrors` tests

- [ ] **Step 4: Commit**

```bash
git add src/utils/background-job-board.ts src/utils/background-job-board.test.ts
git commit -m "feat: add getConsecutiveErrors method to BackgroundJobBoard"
```

---

### Task 3: Extend formatForPrompt with error and timeout warnings

**Files:**
- Modify: `src/utils/background-job-board.ts` (modify `formatForPrompt` and `formatJob`)

**Interfaces:**
- Consumes: `getConsecutiveErrors()`, new config thresholds
- Produces: extended `formatForPrompt()` output with error and timeout warnings

- [ ] **Step 1: Add error/timeout info to `formatJob`**

Modify the `formatJob` function (line 491-517) to include error count and timeout count information:

```typescript
function formatJob(job: BackgroundJobRecord, now = Date.now()): string {
  const ageMs = now - job.lastLaunchedAt;
  const isResume = job.lastLaunchedAt !== job.launchedAt;
  const ageLabel =
    job.state === 'running' && ageMs < 30_000
      ? ` [${isResume ? 'resumed' : 'just launched'}, ${Math.floor(ageMs / 1000)}s ago]`
      : '';
  const status = job.terminalUnreconciled
    ? `${job.state}, unreconciled`
    : job.statusUncertain
      ? `${job.state}, status uncertain`
      : job.timedOut
        ? `${job.state}, timed out`
        : `${job.state}${ageLabel}`;
  const lines = [
    `- ${job.alias} / ${job.taskID} / ${job.agent} / ${status}`,
    `  Objective: ${job.objective || job.description}`,
  ];

  if (job.resultSummary && job.terminalUnreconciled) {
    lines.push(`  Result: ${singleLine(job.resultSummary)}`);
  } else if (job.lastStatusError && job.statusUncertain) {
    lines.push(`  Status: ${singleLine(job.lastStatusError)}`);
  }

  // NEW: Show error/timeout counts for failed jobs
  // Note: per-job errorCount is cumulative for that job, not a streak.
  // Agent-level consecutive streak is computed by getConsecutiveErrors().
  // Show errors for any job with errorCount > 0 (not just state='error'),
  // so cancelled jobs that errored before cancellation also display their count.
  if (job.errorCount > 0) {
    lines.push(`  Errors: ${job.errorCount}`);
  }
  // Show timeout count whenever it's > 0, regardless of current timedOut flag,
  // so re-launched jobs that timed out in a prior attempt still show the history.
  if (job.timeoutCount > 0) {
    lines.push(`  Timeouts: ${job.timeoutCount}`);
  }

  return lines.join('\n');
}
```

- [ ] **Step 2: Add agent-level consecutive error warning to `formatForPrompt`**

Modify `formatForPrompt` (line 370-396) to add agent-level warnings. Cap at top 3 agents to prevent token inflation:

```typescript
formatForPrompt(
  parentSessionID: string,
  now = Date.now(),
): string | undefined {
  const active = this.list(parentSessionID).filter(
    (job) => job.state === 'running' || job.terminalUnreconciled,
  );
  const reusable = this.list(parentSessionID).filter(isReusable);

  if (active.length === 0 && reusable.length === 0) return undefined;

  // NEW: Collect agent-level consecutive error warnings (cap at 3)
  // Note: Warnings only appear for active/unreconciled jobs — once reconciled,
  // the orchestrator has already consumed the signal. This is intentional:
  // we don't re-warn about errors the orchestrator has already acknowledged.
  const agentWarnings: string[] = [];
  // Sort agents by consecutive error count descending so worst offenders appear first
  const agentsWithErrors = [...new Set(active.map((j) => j.agent))]
    .map((agent) => ({
      agent,
      consecutiveErrors: this.getConsecutiveErrors(parentSessionID, agent),
    }))
    .filter((a) => a.consecutiveErrors >= this.errorWarningThreshold)
    .sort((a, b) => b.consecutiveErrors - a.consecutiveErrors)
    .slice(0, 3);

  for (const { agent, consecutiveErrors } of agentsWithErrors) {
    // Search all jobs for the agent (not just active) to find the most recent error snippet
    const agentJobs = this.list(parentSessionID).filter(
      (j) => j.agent === agent,
    );
    const lastError = [...agentJobs]
      .reverse()
      .find((j) => j.lastStatusError);
    // Extract first 80 chars of error message for context
    const errorSnippet = lastError?.lastStatusError
      ? `: "${singleLine(lastError.lastStatusError).slice(0, 80)}"`
      : '';
    // Include active count separately so the LLM understands the visible vs total picture
    const activeCount = active.filter((j) => j.agent === agent).length;
    const totalNote =
      activeCount < consecutiveErrors
        ? ` (${activeCount} active, ${consecutiveErrors - activeCount} reconciled)`
        : '';
    agentWarnings.push(
      `⚠ @${agent} has ${consecutiveErrors} consecutive failures${totalNote}${errorSnippet}. Consider: different approach, @oracle review, or escalate to human.`,
    );
  }

  return [
    '### Background Job Board',
    'SENTINEL: background-job-board-v2',
    'Do not poll running jobs. Wait for hook-driven completion, or use cancel_task only for explicit cancellation. Reconcile terminal jobs before final response. Reuse only completed sessions for the same specialist/context; never reuse cancelled or errored sessions.',
    '',
    '#### Active / Unreconciled',
    ...(active.length > 0
      ? active.map((job) => formatJob(job, now))
      : ['- none']),
    '',
    ...(agentWarnings.length > 0
      ? ['#### Warnings', ...agentWarnings, '']
      : []),
    '',
    '#### Reusable Sessions',
    ...(reusable.length > 0
      ? reusable.map((job) => this.formatReusableJob(job))
      : ['- none']),
  ].join('\n');
}
```

- [ ] **Step 3: Add tests for error warnings in formatForPrompt**

Add to `src/utils/background-job-board.test.ts`:

```typescript
describe('formatForPrompt warnings', () => {
  it('shows warning when agent has consecutive errors above threshold', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-1', state: 'error', lastStatusError: 'TypeError: Cannot read property' });

    board.registerLaunch({
      taskID: 'fix-2',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-2', state: 'error', lastStatusError: 'TypeError: Cannot read property' });

    const prompt = board.formatForPrompt('session-1');
    expect(prompt).toContain('⚠ @fixer has 2 consecutive failures');
    expect(prompt).toContain('Consider: different approach');
  });

  it('does not show warning when error count is below threshold', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-1', state: 'error', lastStatusError: 'fail' });

    const prompt = board.formatForPrompt('session-1');
    expect(prompt).not.toContain('⚠ @fixer');
  });

  it('respects custom threshold', () => {
    const board = new BackgroundJobBoard({ errorWarningThreshold: 3 });
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-1', state: 'error', lastStatusError: 'fail' });

    // Threshold is 3, so 1 error should not warn
    expect(board.formatForPrompt('session-1')).not.toContain('⚠ @fixer');

    // Add 2 more errors to reach threshold
    board.registerLaunch({
      taskID: 'fix-2',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-2', state: 'error' });

    board.registerLaunch({
      taskID: 'fix-3',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-3', state: 'error' });

    expect(board.formatForPrompt('session-1')).toContain('⚠ @fixer has 3 consecutive failures');
  });

  it('caps warnings at top 3 agents', () => {
    const board = new BackgroundJobBoard({ errorWarningThreshold: 1 });
    // Create errors for 5 agents
    for (const agent of ['fixer', 'explorer', 'librarian', 'oracle', 'designer']) {
      board.registerLaunch({
        taskID: `${agent.slice(0, 3)}-1`,
        parentSessionID: 'session-1',
        agent,
      });
      board.updateStatus({ taskID: `${agent.slice(0, 3)}-1`, state: 'error' });
    }

    const prompt = board.formatForPrompt('session-1');
    // Should contain at most 3 warnings
    const warningCount = (prompt?.match(/⚠ @/g) ?? []).length;
    expect(warningCount).toBeLessThanOrEqual(3);
  });

  it('shows active vs reconciled breakdown when some errors are reconciled', () => {
    const board = new BackgroundJobBoard({ errorWarningThreshold: 1 });
    // Job 1: error, then reconciled
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-1', state: 'error' });
    board.reconcile('fix-1');

    // Job 2: error (active)
    board.registerLaunch({
      taskID: 'fix-2',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-2', state: 'error' });

    const prompt = board.formatForPrompt('session-1');
    // Should show breakdown since activeCount (1) < consecutiveErrors (2)
    expect(prompt).toContain('1 active, 1 reconciled');
  });

  it('shows timeout count in formatJob', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-1', state: 'error', timedOut: true });

    const prompt = board.formatForPrompt('session-1');
    expect(prompt).toContain('Timeouts: 1');
  });

  it('hides warnings after all error jobs are reconciled', () => {
    const board = new BackgroundJobBoard();
    // Create 2 errors for fixer
    board.registerLaunch({
      taskID: 'fix-1',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-1', state: 'error' });

    board.registerLaunch({
      taskID: 'fix-2',
      parentSessionID: 'session-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'fix-2', state: 'error' });

    // Warning visible while errors are active/unreconciled
    expect(board.formatForPrompt('session-1')).toContain('⚠ @fixer');

    // Reconcile both errors
    board.reconcile('fix-1');
    board.reconcile('fix-2');

    // Warning disappears — no active/unreconciled jobs
    expect(board.formatForPrompt('session-1')).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run tests**

Run: `bun test src/utils/background-job-board.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/utils/background-job-board.ts src/utils/background-job-board.test.ts
git commit -m "feat: add consecutive error and timeout warnings to formatForPrompt"
```

---

### Task 4: Add loop engineering config schema

**Files:**
- Modify: `src/config/schema.ts:292-344` (add to `PluginConfigSchema`)
- Modify: `src/config/constants.ts` (add defaults)

**Interfaces:**
- Consumes: existing `PluginConfigSchema`
- Produces: `LoopEngineeringConfigSchema` with `errorWarningThreshold`

- [ ] **Step 1: Add constants for defaults**

Add to `src/config/constants.ts` (after `DEFAULT_MAX_SUBAGENT_DEPTH` around line 51):

```typescript
// Loop engineering defaults
export const DEFAULT_ERROR_WARNING_THRESHOLD = 2;
```

- [ ] **Step 2: Add config schema**

Add to `src/config/schema.ts` (before `PluginConfigSchema` around line 292):

```typescript
export const LoopEngineeringConfigSchema = z.object({
  errorWarningThreshold: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(DEFAULT_ERROR_WARNING_THRESHOLD)
    .describe(
      'Number of consecutive failures before the orchestrator receives a warning prompt. ' +
        'Set higher to tolerate more retries, lower to escalate faster. Default 2.',
    ),
});

export type LoopEngineeringConfig = z.infer<typeof LoopEngineeringConfigSchema>;
```

- [ ] **Step 3: Add to PluginConfigSchema**

Add `loopEngineering` field to `PluginConfigSchema` (around line 342, before the closing `.superRefine`):

```typescript
export const PluginConfigSchema = z
  .object({
    // ... existing fields ...
    loopEngineering: LoopEngineeringConfigSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // ... existing refinement ...
  });
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts src/config/constants.ts
git commit -m "feat: add loopEngineering config schema"
```

---

### Task 5: Wire config into BackgroundJobBoard and hook chain

**Files:**
- Modify: `src/index.ts` (pass config to BackgroundJobBoard construction)
- Modify: `src/utils/background-job-board.ts` (add `errorWarningThreshold` to options)

**Interfaces:**
- Consumes: `LoopEngineeringConfig`, `BackgroundJobBoardOptions`
- Produces: BackgroundJobBoard constructed with config, formatForPrompt uses stored threshold

- [ ] **Step 1: Add `errorWarningThreshold` to `BackgroundJobBoardOptions`**

Modify `BackgroundJobBoardOptions` in `src/utils/background-job-board.ts`:

```typescript
export interface BackgroundJobBoardOptions {
  maxReusablePerAgent?: number;
  readContextMinLines?: number;
  readContextMaxFiles?: number;
  errorWarningThreshold?: number;  // NEW
}
```

- [ ] **Step 2: Store threshold on BackgroundJobBoard instance**

Add private field and update constructor:

```typescript
export class BackgroundJobBoard {
  private readonly jobs = new Map<string, BackgroundJobRecord>();
  private readonly counters = new Map<string, number>();
  private terminalStateListener?: TerminalStateListener;

  private readonly maxReusablePerAgent: number;
  private readonly readContextMinLines: number;
  private readonly readContextMaxFiles: number;
  private readonly errorWarningThreshold: number;  // NEW

  constructor(options: BackgroundJobBoardOptions = {}) {
    this.maxReusablePerAgent = options.maxReusablePerAgent ?? 2;
    this.readContextMinLines = options.readContextMinLines ?? 10;
    this.readContextMaxFiles = options.readContextMaxFiles ?? 8;
    this.errorWarningThreshold = options.errorWarningThreshold ?? 2;  // NEW
  }
  // ...
}
```

- [ ] **Step 3: Update `formatForPrompt` to use stored threshold**

Remove the `errorWarningThreshold` parameter from `formatForPrompt` — it now uses `this.errorWarningThreshold`:

```typescript
formatForPrompt(
  parentSessionID: string,
  now = Date.now(),
): string | undefined {
  // ... uses this.errorWarningThreshold instead of parameter
}
```

- [ ] **Step 4: Wire config in `src/index.ts`**

Find where `BackgroundJobBoard` is constructed in `src/index.ts` and add the config:

```typescript
import { DEFAULT_ERROR_WARNING_THRESHOLD } from './config/constants';

// ... in the plugin init, where BackgroundJobBoard is created:
const backgroundJobBoard = new BackgroundJobBoard({
  maxReusablePerAgent: config.backgroundJobs?.maxSessionsPerAgent,
  readContextMinLines: config.backgroundJobs?.readContextMinLines,
  readContextMaxFiles: config.backgroundJobs?.readContextMaxFiles,
  errorWarningThreshold:
    config.loopEngineering?.errorWarningThreshold ??
    DEFAULT_ERROR_WARNING_THRESHOLD,
});
```

- [ ] **Step 5: Run typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: No type errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/utils/background-job-board.ts
git commit -m "feat: wire loopEngineering config into BackgroundJobBoard"
```

---

### Task 6: Update deepwork skill with stopping guidance

**Files:**
- Modify: `src/skills/deepwork/SKILL.md`

**Interfaces:**
- Consumes: BackgroundJobBoard error warnings
- Produces: Updated skill with stopping guidance and escalation ladder

**Note:** These are guidance for the LLM, not programmatic enforcement. The real enforcement is the signal injection from Tasks 1-5. The skill teaches the LLM how to interpret and act on those signals.

- [ ] **Step 1: Add stopping guidance section to deepwork skill**

Add after the existing workflow section in `src/skills/deepwork/SKILL.md`:

```markdown
## Stopping Guidance

Every loop must have a stopping condition. The Background Job Board provides
convergence signals — use them to decide when to stop, escalate, or change approach.

### Signals to Watch

- **⚠ Consecutive failures warning:** If the board shows
  `⚠ @agent has N consecutive failures`, the current approach is not working.
  Do not retry a third time with the same approach.
- **Timeout count:** If a job shows `Timeouts: N`, the task is too
  large or the model is too slow. Break it into smaller pieces or switch models.
- **No progress after 2 iterations:** If 2 iterations produce no meaningful
  progress, summarize what's done and what's blocked, then stop.

### Suggested Stops (use judgment)

- **All tests pass + @oracle approves:** Phase is complete. Move to next or finish.
- **Diminishing returns:** If 2 iterations produce no meaningful progress,
  summarize what's done and what's blocked, then stop.
- **Time budget:** For maintenance loops, stop when the daily/weekly budget
  is exhausted, even if issues remain.

### Escalation Ladder

```
@fixer (bounded implementation)
  → @oracle (review/verify)
    → @council (multi-model consensus, only for high-stakes)
      → Human (hard stop)
```

Escalate when:
- Consecutive failures ≥ 2 (same approach failing repeatedly)
- @oracle review rejects with high-severity issues
- Requirements conflict or architectural risk is high
- You're unsure and the cost of wrong choice is significant

### Context Compaction

After 2 failed iterations on the same subtask:
1. Summarize what was tried and why it failed
2. Ask @oracle for a different approach
3. Start fresh with new context, not accumulated error state
```

- [ ] **Step 2: Verify skill renders correctly**

Read the updated SKILL.md to confirm formatting is correct and no placeholders remain.

- [ ] **Step 3: Commit**

```bash
git add src/skills/deepwork/SKILL.md
git commit -m "docs: add stopping guidance and escalation ladder to deepwork skill"
```

---

### Task 7: Run full verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run all checks**

```bash
bun run check:ci && bun run typecheck && bun test
```

Expected: All pass

- [ ] **Step 2: Review the diff**

```bash
git diff --stat
git diff
```

Verify:
- No unintended changes
- All new code has tests
- errorCount does NOT reset on re-launch (critical)
- getConsecutiveErrors scans job history, not just most recent job
- Error state semantics are explicit (error/cancelled increment, completed resets)
- markCancelled increments errorCount
- formatForPrompt warnings are capped at 3 agents
- Per-job formatJob shows "Errors: N" (not "consecutive")
- timeoutCount only increments on terminal timeout
- Config is always-on with configurable threshold
- Deepwork skill uses "suggested stops" not "hard stops"

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address review feedback for loop engineering"
```

---

## Summary

**What ships:**
- `errorCount` + `timeoutCount` fields on `BackgroundJobRecord` — tracks consecutive failures per job, persists across re-launches
- `getConsecutiveErrors()` method — scans job history for consecutive error/cancelled streaks, breaks on completed
- `formatForPrompt()` warnings — `⚠ @fixer has 2 consecutive failures: "TypeError..."` injected into orchestrator context (capped at 3 agents)
- `loopEngineering` config — always-on with configurable `errorWarningThreshold` (default 2)
- Deepwork skill updates — stopping guidance, escalation ladder, context compaction guidance

**What stays as skill guidance:**
- Formal loop construct (LLM turn loop is the loop)
- Conditional branching (LLM is the branching logic)
- Workflow composition/DAGs (config DAGs invert control)
- Pre/post-condition checking (task-specific, LLM evaluates)
- General retry-until-condition (conditions are task-specific)

**Total estimated lines:** ~300 new/modified (code) + ~60 lines (skill docs)

**Files touched:** 6 files modified, 0 files created

**Error state semantics:** Explicit — `error`/`cancelled` increment, `completed` resets, `running`/`reconciled` no change
