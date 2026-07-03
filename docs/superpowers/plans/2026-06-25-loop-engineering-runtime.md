# Loop Engineering — Implementation Plan (Corrected)

## Overview

Runtime-first design: the loop engine is orchestration wiring that composes existing agents (fixer, oracle, council, explorer). The skill is a thin front-end (Grill interview) that feeds into the runtime.

**Guiding principle:**
> **The runtime owns control flow. The LLM owns strategy.**

The runtime decides: what state comes next, when verification occurs, whether success criteria passed, whether another iteration is allowed, when escalation policies apply. The LLM decides: how to solve the problem, how to adapt after feedback, what implementation strategy to try next.

**Core design principle:**
> **Verification is the center of loop engineering — not execution.**

Retries, failures, warnings, error counts, timeouts are **escalation signals**, not the loop itself. The loop is `Goal → Execute → Verify → Goal satisfied?` Everything else hangs off that.

**Mechanism vs Policy:**
The engine implements `verify()`. It should NOT implement `retry twice then escalate`. Instead, policy (maxAttempts, escalation targets, human gates) is externalized. This keeps the runtime generic and extensible.

**Architectural corrections applied:**
- Task 2 removed — `BackgroundJobState` stays clean (no loop phases pollute job primitives)
- Event-driven model, not procedural `for` loop
- Runtime is the constraint — no "signals not constraints" in Layer 1
- Context compaction — engine synthesizes history before dispatching
- Verification parsing fixed — JSON schema, not regex
- BackgroundJobBoard event plumbing — callback array for multiple listeners (multiplexer + LoopEngine)
- Binary oscillation `executing` ↔ `verifying` — no planning/improving phase
- Dispatch failure handling — `try/catch` → `escalated` + system error
- Context injection via `.loop-history-{loopID}.md` file, not job description
- Fleet mapping — executeAgent/verifyAgent expanded for all specialist roles
- Oracle retry-wrapper — `oracleRetryCount` persisted in session
- Council restricted to Layer 0 escalation only
- Cancellation lifecycle — `cancelled` is quiet terminal state, no `onEscalated`
- Session cleanup — engine manages `.loop-history-{loopID}.md` only, orchestrator owns artifact lifecycle
- Convergence signal scope — signals apply to `error` and `timeout` only, NOT `cancelled`
- `totalErrors` (not `errorCount`) consistently used
- `SuccessCriterion` as first-class type — engine routes by `success.type`
- Deferred worktree/memory/trigger from core interfaces — Future Extensions section
- Artifact lifecycle — engine signals `onArtifactWrite`, orchestrator owns filesystem
- **Dispatch callback** — engine receives `dispatch(agent, prompt, contextFiles)` from orchestrator, no direct SDK access
- **Manual verification** — no BackgroundJob created, engine manages waiting state in LoopSession
- **Automated verification** — test/build/lint/command/fileExists dispatched to test-runner agent, not spawnSync
- **LoopEngine location** — `src/loop/loop-engine.ts` (not src/council/)

**Phased roadmap:**
- Phase 1: Runtime loop engine (this PR)
- Phase 2: Loop skill (Grill + Monitor)
- Phase 3: Routine integration
- Phase 4: Triggers (cron, webhooks)
- Phase 5: Persistent memory (cross-loop)

---

## Tasks

### Task 1: Extend BackgroundJobRecord with Convergence Signals

**File:** `src/utils/background-job-board.ts`

Add three fields to `BackgroundJobRecord`:
- `totalErrors: number` — accumulated errors across all attempts (not incremented on `cancelled`)
- `timeoutCount: number` — consecutive timeouts, resets to 0 on `completed`
- `lastErrorAt?: number` — timestamp of last error

**Convergence signal scope:** Signals (`totalErrors`, `timeoutCount`) apply to `error` and `timeout` states only. The `cancelled` state is a quiet terminal state — it does NOT increment error counters. This prevents noisy escalation when users intentionally cancel.

**Signal computation:** Convergence signals are computed from `BackgroundJobRecord` state transitions in `updateStatus()`, not explicit flags:
- When `input.state === 'error'` → increment `totalErrors`, set `lastErrorAt = Date.now()`
- When `input.timedOut === true` → increment `timeoutCount`
- When `input.state === 'completed'` → reset `timeoutCount = 0`
- `cancelled` state → no increments

This avoids redundant `isError`/`isTimeout` fields on `BackgroundJobStatusInput` — the state machine already conveys this information.

Update:
- `registerLaunch()` — initialize `totalErrors = 0`, `timeoutCount = 0`
- `updateStatus()` — compute signals from state transitions as above

### Task 2: Add Convergence Helper Methods to BackgroundJobBoard

**File:** `src/utils/background-job-board.ts`

Add to `BackgroundJobBoard`:
```typescript
hasConvergenceSignals(taskID: string, threshold?: number): boolean
```

This enables the loop engine to detect stuck patterns and escalate. The engine reads `totalErrors` and `timeoutCount` fields directly for detailed checks.

### Task 3: BackgroundJobBoard Event Plumbing

**File:** `src/utils/background-job-board.ts`

The current `setTerminalStateListener()` supports only a single listener. The multiplexer session manager already uses it at `src/index.ts:264`:
```typescript
backgroundJobBoard.setTerminalStateListener((taskID) => {
  void multiplexerSessionManager.retryDeferredIdleClose(taskID);
});
```

LoopEngine needs to be a second listener. Replace with callback array:

```typescript
addTerminalStateListener(listener: (taskID: string) => void): void;
removeTerminalStateListener(listener: (taskID: string) => void): void;
private notifyTerminalStateListeners(taskID: string): void;
```

Update existing callers to use `addTerminalStateListener()`. The multiplexer registration at `src/index.ts` must be updated.

**If already used by other components:**
Replace `setTerminalStateListener()` with `addTerminalStateListener()` that maintains an array:
```typescript
private terminalStateListeners: Array<(taskID: string) => void> = [];

addTerminalStateListener(listener: (taskID: string) => void): void;
removeTerminalStateListener(listener: (taskID: string) => void): void;
private notifyTerminalStateListeners(taskID: string): void;
```

Update existing callers to use `addTerminalStateListener()`.

**If not yet used:**
Keep `setTerminalStateListener()` as-is. LoopEngine becomes the single subscriber.

### Task 4: Create LoopSession State Machine

**File:** `src/loop/loop-session.ts` (new file)

```typescript
export type LoopPhase =
  | 'executing'
  | 'verifying'
  | 'done'
  | 'escalated'
  | 'cancelled';

// Fleet mapping: executeAgent is dynamically selected based on task domain
export type ExecuteAgent = 'fixer' | 'designer' | 'explorer' | 'librarian';
// Fleet mapping: verifyAgent is dynamically selected based on task domain
// Note: 'council' is NOT a verifyAgent inside the loop — it is Layer 0 escalation only
export type VerifyAgent = 'oracle' | 'observer' | 'test';

// Success criteria — first-class runtime type
// The runtime evaluates these directly where possible. Only subjective criteria go to Oracle.
export type SuccessCriterion =
  | { type: 'test'; command: string }                         // exit code 0 = pass
  | { type: 'build'; command: string }                        // exit code 0 = pass
  | { type: 'lint'; command: string }                         // exit code 0 = pass
  | { type: 'fileExists'; path: string }                      // file exists = pass
  | { type: 'command'; command: string; expectExitCode?: number }  // customizable
  | { type: 'oracle' }                                        // Oracle returns structured JSON (subjective)
  | { type: 'observer' };                                     // Observer reads visual artifacts (subjective)
  | { type: 'manual' };                                       // human reviews and decides

// MVP only implements: 'test', 'oracle', 'observer', 'manual'
// Others deferred.

export interface LoopDefinition {
  goal: string;
  successCriteria: string;         // human-readable description (used by oracle/observer)
  success: SuccessCriterion;       // machine-evaluable success criterion
  maxAttempts: number;
  executeAgent: ExecuteAgent;
  verifyAgent: VerifyAgent;
  contextFiles?: string[];
}

// Deferred interfaces (NOT in LoopDefinition — added later via extension)
// See "Future Extensions" section below for: LoopTrigger, LoopWorktreeConfig, LoopMemoryConfig

export interface AttemptRecord {
  attemptNumber: number;
  executionResult: string;
  verificationResult: VerificationResult;
  artifactPaths?: string[];  // visual artifacts from executing phase (for UI loops)
}

export type VerificationResult =
  | { passed: true; reason: string }
  | { passed: false; reason: string; suggestedFix?: string };

export interface LoopSession {
  loopID: string;
  definition: LoopDefinition;
  currentPhase: LoopPhase;
  attempts: number;
  activeJobID?: string;
  history: AttemptRecord[];
  historyFilePath: string;         // path to .loop-history-{loopID}.md in project root
  oracleRetryCount: number;        // reset to 0 on each executing transition
  // worktreeName: added when worktree integration is implemented (deferred)
  // memoryLoaded: added when cross-loop memory is implemented (deferred)
}
```

**Phase transition rules (enforced):**
```
executing  → verifying    (on job completed)
verifying  → done         (on verification passed)
verifying  → executing    (on verification failed, attempts < maxAttempts)
verifying  → escalated    (on verification failed, attempts >= maxAttempts)
*          → cancelled    (on manual cancel, job.cancelled state, or user abort)
done       → (terminal)
escalated  → (terminal)
cancelled  → (terminal)
```

**No `planning` or `improving` phase** — binary oscillation between `executing` and `verifying`. `@oracle` only verifies, `@fixer` self-corrects using `.loop-history-{loopID}.md`. Loop starts in `executing`.

**`oracleRetryCount` lifecycle:** Reset to `0` on every `executing` transition. Increment on each Oracle retry. If `oracleRetryCount >= 2` and parsing still fails → fail closed (verification = failed).

**History file:** Each session writes `compactHistory()` to a virtual file (`.loop-history-{loopID}.md` in the project root). This file is appended to `contextFiles` for each `executing` dispatch. Models read file context reliably.

**Worktree integration:** If `definition.worktree?.enabled = true`, orchestrator creates a dedicated worktree before dispatching. Engine tracks `session.worktreeName`. On `done` → orchestrator merges worktree to main. On `escalated`/`cancelled` → orchestrator abandons worktree. Prevents parallel loops from colliding on the same files. Uses existing `using-git-worktrees` skill via orchestrator.

### Task 5: Worktree Integration (Deferred — MVP uses in-process execution)

**Files:** `src/loop/loop-engine.ts` (update), `src/loop/worktree-manager.ts` (new)

**Purpose:** Isolated execution environment per loop. Prevents parallel loops from modifying the same files.

**Interface:**
```typescript
export interface LoopWorktreeConfig {
  enabled: boolean;
  branchName?: string;  // defaults to "loop-{loopID}"
  mergeOnSuccess: boolean;  // merge to main on 'done', abandon on 'escalated'/'cancelled'
}
```

**Handshake timing (critical for isolation):**

```
startLoop(definition) with worktree.enabled = true
  → engine creates session, sets session.worktreeName = "loop-{loopID}"
  → engine sets session.worktreeReady = false
  → engine fires onWorktreeCreate(loopID, "loop-{loopID}") callback
  → engine returns loopID immediately (non-blocking)
  ↓
Orchestrator receives callback → creates worktree via using-git-worktrees skill
  ↓
Orchestrator calls engine.setWorktreeReady(loopID)
  → session.worktreeReady = true
  ↓
Engine dispatches first job (checks session.worktreeReady before dispatching)
```

**If worktree creation fails:** Orchestrator calls `engine.cancel(loopID)` with a reason. Engine transitions to `escalated` with system error, no merge/abandon attempted.

**On terminal states:**
- `done` → engine fires `onWorktreeMerge(loopID, branchName)`. Orchestrator merges to main via skill.
- `escalated`/`cancelled` → engine fires `onWorktreeAbandon(loopID, branchName)`. Orchestrator abandons via skill.

**Engine does not call git directly** — it delegates to orchestrator via callbacks (`onWorktreeCreate`, `onWorktreeMerge`, `onWorktreeAbandon`).

**Validation:** `startLoop()` validates that `executeAgent !== verifyAgent`. If equal, throws `Error('executeAgent and verifyAgent must be different')`.

**Note:** In MVP, `worktree.enabled = false` by default. Worktree isolation is opt-in per `LoopDefinition`.

### Task 6: Cross-Loop Memory (Deferred — MVP uses per-session history only)

**File:** `src/loop/loop-memory.ts` (new file)

**Purpose:** Learn from prior loops. Store successful strategies, failure patterns, and convergence thresholds across sessions. File-based (`.loop-memory.md`) for MVP. Future: GitHub Issues, database. Enables learned strategies and tuned convergence thresholds.

**Read timing (before first dispatch):**

```
startLoop(definition) with memory.enabled = true
  → engine creates session, sets session.memoryLoaded = false
  → engine reads storePath (defaults to .loop-memory.md)
  → if file exists and valid: parses LoopMemoryStore
  → engine fires onMemoryRead(loopID, memory) callback
  → orchestrator calls engine.setMemoryLoaded(loopID, memory)
  → session.memoryLoaded = true
  ↓
Engine dispatches first job (checks session.memoryLoaded before dispatching)
```

If memory file doesn't exist or is corrupt: engine fires `onMemoryRead(loopID, null)`. Orchestrator calls `setMemoryLoaded` with empty store. Loop proceeds with no prior patterns.

**Write timing (on terminal state):**

```
on 'done':
  → engine writes new LoopPattern to store (goal type, strategy, attemptsRequired, timestamp)
  → engine fires onMemoryWrite(loopID, storePath) callback
  → orchestrator writes file via fs

on 'escalated':
  → engine writes new FailureRecord to store (goal type, failureReason, what was attempted, occurrences++)
  → engine fires onMemoryWrite(loopID, storePath) callback
  → orchestrator writes file via fs
```

**Orchestrator does the actual file I/O** — engine delegates via callback, same pattern as worktree. This keeps the engine purely orchestration logic.

**Future:** Memory store could be GitHub Issues (label-based), a database, or a dedicated file. File-based (`.loop-memory.md`) is MVP.

**Note:** In MVP, `memory.enabled = false` by default. Cross-loop memory is opt-in per `LoopDefinition`.

### Task 7: Create LoopEngine (Event-Driven)

**File:** `src/loop/loop-engine.ts` (new file)

The engine is **not** a procedural `for` loop. It is an event-driven state machine that reacts to `BackgroundJobBoard` terminal state events.

```typescript
import { LoopSession, type LoopPhase, type LoopDefinition, type AttemptRecord } from './loop-session';
import { BackgroundJobBoard, type BackgroundJobRecord } from '../utils/background-job-board';

export interface LoopEngineCallbacks {
  onLoopComplete?: (loopID: string, success: boolean) => void;
  onEscalated?: (loopID: string, reason: string) => void;
  // Manual verification — orchestrator surfaces review to human, calls resolveManualReview
  onManualReview?: (loopID: string, reason: string) => void;
  // Artifact management — orchestrator owns filesystem, engine only signals
  onArtifactWrite?: (loopID: string, artifactPath: string) => void;
  // Deferred: onWorktreeCreate, onWorktreeMerge, onWorktreeAbandon
  // Deferred: onMemoryRead, onMemoryWrite
}

export class LoopEngine {
  private sessions: Map<string, LoopSession> = new Map();
  private jobBoard: BackgroundJobBoard;
  private callbacks: LoopEngineCallbacks;
  // Dispatch callback provided by orchestrator — engine does not access SDK directly
  private dispatch: (agent: string, prompt: string, contextFiles: string[]) => string;

  constructor(jobBoard: BackgroundJobBoard, callbacks: LoopEngineCallbacks, dispatch: (agent: string, prompt: string, contextFiles: string[]) => string);

  startLoop(definition: LoopDefinition): string;
  cancel(loopID: string): void;
  resolveManualReview(loopID: string, passed: boolean, reason?: string): void;
  getSession(loopID: string): LoopSession | undefined;
  listSessions(): LoopSession[];

  private handleTerminalJob(job: BackgroundJobRecord): void;
  private findSessionForJob(taskID: string): LoopSession | undefined;
  private dispatchPhase(session: LoopSession): void;
  private evaluateVerification(session: LoopSession, job: BackgroundJobRecord): void;

  // Context compaction
  private writeHistoryFile(session: LoopSession): void;
  private compactHistory(session: LoopSession): string;
}
```

**Layered architecture:**

```
Layer 0: Orchestrator — loads skill, delegates to LoopEngine, listens to callbacks, handles Grill + escalation
Layer 1: LoopEngine — event-driven state machine, dispatches agents, manages artifacts, enforces circuit breaker
Layer 2: Specialist agents — do the work
  - @fixer, @designer, @explorer, @librarian — execute based on task domain
  - @oracle, @observer, test — verify based on task domain
  - @council — Layer 0 escalation ONLY, never inside the loop
Skill — instructs orchestrator, never "does" anything itself
```

**Key design:**

1. `startLoop(definition)` is **non-blocking** — creates session, validates inputs, writes history file, dispatches first job, returns `loopID` immediately. Orchestrator never hangs.

   **Validation:**
   ```typescript
   if (definition.executeAgent === definition.verifyAgent) {
     throw new Error('executeAgent and verifyAgent must be different agents');
   }
   ```
   Prevents a single agent from verifying its own output (e.g., fixer checking fixer). The "student marking their own exam" problem is solved by design for code loops, but must be enforced for all loop types.

**SuccessCriterion routing:** The engine routes based on `definition.success.type`:
    - `'test'`, `'build'`, `'lint'`, `'command'`, `'fileExists'` → dispatch to test-runner agent (or `@fixer` with focused prompt) via BackgroundJobBoard. Agent runs command, evaluates exit code or file existence. Engine evaluates result — no LLM involved.
    - `'oracle'` → dispatch to Oracle, parse JSON verification result
    - `'observer'` → dispatch to Observer, parse JSON verification result
    - `'manual'` → engine fires `onManualReview`, waits for `resolveManualReview`
    This makes the engine extensible — new success criterion types can be added without changing the engine's core logic.

2. Engine registers as the single terminal state listener on `BackgroundJobBoard`. All job completions route through `handleTerminalJob()`.

3. Session lookup: `findSessionForJob(taskID)` — sessions track `activeJobID`, routes job events to the right session.

4. Phase transitions driven by job terminal states, not by explicit loop control:

```
job completed (executing) → currentPhase = 'verifying' → dispatch verifyAgent
job completed (verifying) → evaluateVerification()
                              → passed? → 'done' → cleanup → onLoopComplete
                              → !passed && canRetry → 'executing'
                                → oracleRetryCount = 0
                                → writeHistoryFile() → dispatch executeAgent (retry)
                              → !passed && !canRetry → 'escalated' → cleanup → onEscalated
job completed (cancelled) → 'cancelled' → cleanup → onLoopComplete(false)
job completed (error)     → handleFailure() → may escalate
```

5. **No `improving` phase** — `@oracle` strictly verifies (returns `passed: false, reason: "X"`). `@fixer` self-corrects using `compactHistory()` from `.loop-history-{loopID}.md` + failure reason as input. No intermediate strategist.

6. **Context injection** — text history and visual artifacts handled separately:

   **`.loop-history-{loopID}.md`** — text compaction for all loop types:
   ```typescript
   private writeHistoryFile(session: LoopSession): void {
     const content = this.compactHistory(session);
      // Write to session.historyFilePath (.loop-history-{loopID}.md in project root)
   }

    private compactHistory(session: LoopSession): string {
      if (session.history.length === 0) return '';
      const lines = session.history.map((a, i) => {
        const outcome = a.verificationResult.passed
          ? 'PASS'
          : `FAIL: ${a.verificationResult.reason}`;
        const artifacts = a.artifactPaths?.length
          ? ` → artifacts: ${a.artifactPaths.join(', ')}`
          : '';
        return `[Attempt ${i + 1}] ${outcome}${artifacts}`;
      });
      return `# Loop Attempt History\n\n${lines.join('\n')}\n`;
    }
   ```

**Observer artifact transfer:** For UI loops, `verifyAgent = 'observer'`, the executing agent writes visual artifacts to paths. The engine signals `onArtifactWrite(loopID, artifactPath)` so orchestrator can manage artifact lifecycle. Engine does not own filesystem artifacts — only signals when they are written.

**Manual verification:** When `success.type = 'manual'`, engine transitions to `verifying` but does NOT dispatch a verifyAgent. Instead, fires `onManualReview(loopID, reason)` and stops. Session waits. Orchestrator surfaces review to human. Human responds → orchestrator calls `engine.resolveManualReview(loopID, passed, reason)`. Engine resumes: `passed` → `done`, `!passed` → retry or escalate.

    **No Council inside the loop** — Council with 360s+ latency stalls the rapid `executing ↔ verifying` oscillation. Council is reserved for Layer 0 escalation only.

7. Hard circuit breaker: when `attempts >= maxAttempts` && verification fails → `escalated`. Loop stops dispatching. `onEscalated` callback fires.

8. Convergence signals: before dispatching retry, engine checks `jobBoard.hasConvergenceSignals()`. If exceeded → `escalated` regardless of attempt count.

9. **Dispatch failure handling** — `try/catch` around `dispatchPhase()`:
   ```typescript
   private dispatchPhase(session: LoopSession): void {
     try {
       // registerLaunch() and job dispatch
     } catch (error) {
       session.currentPhase = 'escalated';
       this.callbacks.onEscalated?.(session.loopID, `Dispatch failed: ${error}`);
       return;
     }
   }
   ```
   If dispatch throws (agent API down, token limit exceeded, etc.) → immediately `escalated` + `onEscalated` with system error. No orphaned session.

10. **Cancellation lifecycle** — `cancelled` is a distinct terminal state, not an error:
    ```typescript
    private handleTerminalJob(job: BackgroundJobRecord): void {
      const session = this.findSessionForJob(job.taskID);
      if (!session) return;

      if (job.state === 'cancelled') {
        // Quiet shutdown — no escalation, no error increment
        session.currentPhase = 'cancelled';
        session.activeJobID = undefined;
        this.cleanupSession(session);  // delete artifactDir and historyFile
        this.callbacks.onLoopComplete?.(session.loopID, false);
        return;
      }

      if (job.state === 'error') {
        // Treat as verification failure — increment errors, potentially escalate
        this.handleFailure(session, job);
        return;
      }

      // job.state === 'completed' → normal phase transitions
      this.handleTerminalJobCompleted(session, job);
    }
    ```
    `cancel(loopID)` sets `cancellationRequested` on the job, which emits `cancelled` state. Engine catches it, transitions to `cancelled` terminal state, cleans up, fires `onLoopComplete(false)` (not `onEscalated`).

11. **Oracle retry-wrapper for JSON parsing failures** — `oracleRetryCount` persisted in session:
    ```typescript
    private evaluateVerification(session: LoopSession, job: BackgroundJobRecord): void {
      const result = this.tryParseVerification(job.resultSummary);
      if (result !== null) {
        this.transitionToNextPhase(session, result);
        return;
      }

      // Parse failed
      if (session.oracleRetryCount < 1) {
        session.oracleRetryCount++;
        this.dispatchPhase(session);  // re-send to Oracle
        return;
      }

      // Retry exhausted → fail closed
      session.oracleRetryCount = 0;
      this.transitionToNextPhase(session, { passed: false, reason: 'Verification output unparseable after retry' });
    }
    ```
    `oracleRetryCount` is reset to `0` on every `executing` transition (not on parse success). Max 1 retry (retry if count == 0, i.e. first failure). Handles the 12.5% Oracle error rate without infinite loops.

12. **Session cleanup** — prevents memory leaks:
    ```typescript
    private cleanupSession(session: LoopSession): void {
       // Delete .loop-history-{loopID}.md
      fs.unlinkSync(session.historyFilePath);
      // Orchestrator handles artifact cleanup via onArtifactWrite tracking
    }
    ```
    Called on terminal states: `done`, `escalated`, `cancelled`. Also called on `cancel(loopID)`. Engine only manages `.loop-history-{loopID}.md` — orchestrator owns artifact filesystem lifecycle.

    **"Modify definition and retry"** during `escalated`: Human decides to modify and retry → engine does NOT reuse the session. Instead:
    1. Call `cancel(loopID)` → triggers `cancelled` cleanup
    2. Call `startLoop(newDefinition)` → fresh `loopID`
    This ensures no stale state from the failed loop leaks into the retry.

**Structured verification parsing** (replaces brittle regex):

Oracle must use a tool that returns JSON. The tool schema:
```typescript
const verifyTool = {
  name: 'verify',
  description: 'Structured verification result',
  inputSchema: {
    type: 'object',
    properties: {
      passed: { type: 'boolean' },
      reason: { type: 'string' },
      suggestedFix: { type: 'string' }
    },
    required: ['passed', 'reason']
  }
};
```

Engine reads `job.resultSummary` as JSON:
```typescript
private tryParseVerification(raw: string | undefined): VerificationResult | null {
  try {
    const parsed = JSON.parse(raw ?? '{}');
    return {
      passed: Boolean(parsed.passed),
      reason: String(parsed.reason ?? ''),
      suggestedFix: parsed.suggestedFix ? String(parsed.suggestedFix) : undefined
    };
  } catch {
    return null;  // parsing failed, retry-wrapper handles
  }
}
```

**No regex matching** — if Oracle returns valid JSON, parsing succeeds. If not, retry once. If still fails, fail closed (not open).

### Task 8: Create Loop Engineering Skill

**File:** `src/skills/loop-engineering/SKILL.md` (new file)

The skill instructs the orchestrator — it never "does" anything itself. Orchestrator follows the skill's guidance.

Two parts:

**Grill (human interview) — orchestrator follows these instructions:**
- Conduct conversation to define `LoopDefinition` fields
- Questions: goal, success criteria, max attempts, preferred agents, context files
- Output structured JSON passed to `loopEngine.startLoop()`

**Loop Monitor — orchestrator follows these instructions:**
- Listen to engine callbacks (`onLoopComplete`, `onEscalated`)
- Display current state, attempt count, verification result to human
- On `onEscalated` — surface resolution options to human, await instruction
- On human intervention (cancel, force pass, modify definition) — call appropriate engine method

**Skill does NOT:**
- Call `loopEngine` directly — orchestrator does that
- Dispatch agents — engine does that
- Evaluate verification — engine does that (via JSON parsing)
- Manage state — engine does that

### Task 9: Register /loop Command

**Step A:** Research `/deepwork` registration pattern:
```bash
grep -r "deepwork" src/ --include="*.ts"
```

**Step B:** Create `src/tools/loop-command.ts` following the same pattern.

**Step C:** Register in `src/index.ts` where other commands are wired.

### Task 10: Add Tests

**Files:** (new test files alongside implementation)

- `src/loop/loop-session.test.ts` — state machine transitions, transition enforcement, attempt recording
- `src/loop/loop-engine.test.ts` — event-driven flow, job completion handling, convergence escalation, context compaction, dispatch failure handling

---

## PR Strategy

**Two-PR approach:**

**PR 1 — Convergence Signals (BackgroundJobBoard extension)**
- Tasks 1, 2, 3 only
- Extends `BackgroundJobRecord` with `totalErrors`, `timeoutCount`, `lastErrorAt`
- Adds convergence helper methods to `BackgroundJobBoard`
- Upgrades event plumbing to callback array
- **Naming:** Use `totalErrors` (not `errorCount`) — aligns with LoopEngine spec
- **Scope rule:** `cancelled` does NOT increment `totalErrors` — quiet terminal state, not an error
- Ready to open now

**PR 2 — Loop Engine (full runtime orchestration)**
- Tasks 4, 7, 8, 9, 10
- `LoopSession` + `LoopEngine` event-driven state machine
- `SuccessCriterion` routing (test/build/lint evaluated directly, oracle/observer dispatched, manual waits for human)
- Skill + `/loop` command
- Tests
- Depends on PR 1 merging first

**Not in MVP PRs (deferred but architected):**
- **Worktree isolation** — architected in Task 5, deferred to post-MVP. Orchestrator uses `using-git-worktrees` skill. Engine delegates worktree lifecycle via callbacks. Prevents parallel loop file collisions.
- **Cross-loop memory** — architected in Task 6, deferred to post-MVP. `.loop-memory.md` file store (MVP). Future: GitHub Issues, database. Enables learned strategies and tuned convergence thresholds.

**Not architected yet (deferred):**
- Trigger automation (cron, webhooks) — `LoopTrigger` interface defined but only 'manual' implemented in MVP
- Fuzzy verification — Oracle returns boolean only; no engagement metrics or content quality scoring
- MCP connectors (GitHub Issues, Slack, Sentry) — no external integrations

These are the remaining delta between MVP loop engineering and full theory compliance (6 building blocks).

---

## Future Extensions (Deferred — Not in MVP)

These features are deferred. Interfaces will be defined when implementation begins.

- **Worktree isolation** — opt-in per LoopDefinition, uses `using-git-worktrees` skill. Prevents parallel loop file collisions.
- **Cross-loop memory** — `.loop-memory.md` file store. Learns from prior loops: successful strategies, failure patterns, tuned convergence thresholds.
- **Trigger automation** — cron, webhook, event-driven invocation. `LoopTrigger` interface defined in Phase 4.

### LoopMemoryConfig
```typescript
// Cross-loop memory store
export interface LoopMemoryConfig {
  enabled: boolean;
  storePath: string;  // defaults to .loop-memory.md in project root
}
```
When implemented: Add `memory: LoopMemoryConfig` to `LoopDefinition`, `memoryLoaded` to `LoopSession`, and `onMemoryRead/Write` callbacks to `LoopEngineCallbacks`.

---

## File Summary

| File | Action |
|------|--------|
| `src/utils/background-job-board.ts` | Modify — convergence signals, helpers, event plumbing |
| `src/loop/loop-session.ts` | Create — state machine class (binary oscillation, worktreeName, oracleRetryCount) |
| `src/loop/loop-engine.ts` | Create — event-driven orchestration |
| `src/loop/worktree-manager.ts` | Create — worktree lifecycle (create/merge/abandon, deferred) |
| `src/loop/loop-memory.ts` | Create — cross-loop memory store (read/write patterns, deferred) |
| `src/skills/loop-engineering/SKILL.md` | Create — Grill + Monitor prompts |
| `src/tools/loop-command.ts` | Create — command definition |
| `src/index.ts` | Modify — wire /loop command |
| `src/loop/loop-session.test.ts` | Create — tests |
| `src/loop/loop-engine.test.ts` | Create — tests |

---

## Verification Commands

After implementation:
```bash
bun run typecheck
bun run check:ci
bun test
```

---

## Dependencies

- `BackgroundJobBoard` — already exists, extended with convergence signals and event plumbing
- Agent dispatch — existing patterns in council/
- Skill infrastructure — existing patterns in src/skills/
- Oracle structured output tool — new tool definition in `src/tools/` (or reuse existing)

---

## Out of Scope

- **Worktree isolation** — deferred (would prevent parallel loop file collisions)
- **Cross-loop persistent memory** — deferred (history dies with session)
- **Trigger automation** — only manual `/loop` invocation in MVP (no cron/webhooks)
- **Fuzzy verification** — Oracle returns boolean only (no engagement metrics)
- **MCP connectors** — no GitHub Issues, Slack, Sentry integration
- **Persistence** — in-memory only for MVP
- **New hooks or infrastructure** — beyond orchestration wiring
- **Visualization** — beyond skill prompts
- Layer 1 (runtime) always enforces constraints — no "signals not constraints" in the engine layer

**Signals vs constraints distinction:**
- `BackgroundJobRecord` convergence signals (`totalErrors`, `timeoutCount`) → "signals not constraints" — warn LLM via `formatForPrompt()`, LLM decides
- `LoopEngine` circuit breaker → hard constraints — `escalated` state is enforced, not signaled

---

## Research Validation (June 2026)

The loop engineering spec and plan were validated against real-world implementations:

- **autoresearch** (Karpathy): Confirms MVP scope — skill + executor + git history is the proven minimum. Our LoopEngine + skill + `.loop-history-{loopID}.md` directly mirrors this pattern.
- **Claude Code community**: `while True` loops in CLAUDE.md are the most common adoption pattern. Our `/loop` command formalizes what users already do manually.
- **Ralph (Simon Willison)**: Simplest on-ramp — agent loop in a markdown file. Validates that skill-first approach (not infrastructure-first) is the right entry point.

**Impact on plan:** No changes needed. The 5-phase roadmap (runtime engine → loop skill → routine integration → triggers → persistent memory) matches the proven adoption curve. Phase 1-2 (MVP) is where the value is.

**Risk identified:** autoresearch shows that manual verification (human in the loop) is often "good enough" for autonomous loops. Our spec's automated verification (@oracle/@observer) is a differentiator but should not be a blocker — MVP could ship with manual verification as a fallback SuccessCriterion type.