# Loop Engineering - Runtime-First Design

## Core Insight

The loop engine is **orchestration wiring**, not prompt engineering.

**Guiding principle:**
> **The runtime owns control flow. The LLM owns strategy.**

The runtime decides: what state comes next, when verification occurs, whether success criteria passed, whether another iteration is allowed, when escalation policies apply. The LLM decides: how to solve the problem, how to adapt after feedback, what implementation strategy to try next.

**Core design principle:**
> **Verification is the center of loop engineering - not execution.**

Retries, failures, warnings, error counts, timeouts are **escalation signals**, not the loop itself. The loop is `Goal → Execute → Verify → Goal satisfied?` Everything else hangs off that.

**Mechanism vs Policy:**
The engine implements `verify()`. Policy (maxAttempts, escalation targets, human gates) is externalized. This keeps the runtime generic and extensible across domains (code, docs, research, planning).

```
Layer 0 (Orchestrator): Trigger, Grill, escalation handling
Layer 1 (LoopEngine):   Execute dispatch, Verify parsing, State transitions, Circuit breaker
Layer 2 (Agents/Skill): Execute work, Verify output, Skill instructions
```

The orchestrator delegates to the engine. The engine dispatches agents. The skill instructs the orchestrator - it never acts directly.

## Architecture

### Three-Layer Design

```
Layer 0: Orchestrator - runtime that runs everything
  - Loads and follows skill instructions
  - Delegates to LoopEngine
  - Collects LoopDefinition via Grill interview
  - Listens to engine callbacks (onLoopComplete, onEscalated)
  - Handles human-facing parts (Grill, escalation UI)
  - Dispatches @council ONLY on Layer 0 escalation (never inside the loop)
  - Never dispatches specialist agents during a loop - engine dispatches via BackgroundJobBoard
  - Provides `dispatch(agent, prompt, contextFiles)` callback to engine for agent spawning

Layer 1: LoopEngine - orchestration logic, framework-owned
  - Location: `src/loop/loop-engine.ts` (not src/council/)
  - Event-driven state machine
  - Dispatches agents via orchestrator-provided callback (not direct SDK access)
  - Owns phase transitions and verification parsing
  - Manages context compaction via .loop-history-{loopID}.md
  - Manages session artifact directory for visual artifact transfer
  - Enforces hard circuit breaker (escalated state)
  - Handles dispatch failures with try/catch → escalated
  - Wraps Oracle verification with retry on JSON parse failure

Layer 2: Specialist agents - do the work
  - @fixer, @designer - execute implementation tasks
  - @explorer, @librarian - execute research/gather loops
  - @oracle - strict verification only (returns JSON, not strategy)
  - @observer - visual verification (reads artifacts from session directory)
  - test - automated verification (exit code parsing)
  - @council - Layer 0 escalation ONLY (not inside the loop)
  - Skill - instructs orchestrator, never "does" anything itself
```

---

## Runtime Loop Engine

### LoopSession State Machine

**Binary oscillation** - no planning or improving phase:

```
States: executing | verifying | done | escalated | cancelled

Transitions:
  executing  → verifying    (on job completed)
  executing  → escalated    (on dispatch/execution error - API down, token limit, etc.)
  verifying  → done         (on verification passed)
  verifying  → executing    (on verification failed, attempts < maxAttempts)
  verifying  → escalated    (on verification failed, attempts >= maxAttempts)
  *          → cancelled    (on manual cancel or job.cancelled state)
  done       → (terminal)
  escalated  → (terminal)
  cancelled  → (terminal)
```

**`oracleRetryCount` lifecycle:** Reset to `0` on every `executing` transition. Increment on Oracle retry. Max 1 retry (retry if count == 0, i.e. first failure). If second parse fails → fail closed.

**Design decisions:**
- `planning` removed - `LoopDefinition` is fully formed from Grill. Loop starts in `executing` immediately dispatching executeAgent.
- `improving` removed - `@oracle` strictly verifies. `@fixer` self-corrects using `.loop-history.md` + failure reason.
- Binary oscillation between `executing` and `verifying` is the complete state machine.
- `cancelled` is a distinct terminal state, not an error - no `onEscalated` callback, quiet cleanup.
- **Same-agent constraint:** `executeAgent` and `verifyAgent` MUST be different. Validation at `startLoop()` throws if equal. This prevents the "student marking their own exam" problem across all loop types (not just code loops).

**God object risk:** Every responsibility in `LoopEngine` must be expressible as **state transition**, **event**, or **policy**. If a responsibility cannot be expressed this way, it belongs elsewhere (orchestrator, external policy store, dedicated service). This keeps the engine testable and maintainable.

### Key Primitives

**1. LoopDefinition** (input from Grill)
```typescript
// Success criteria - first-class runtime type
// The runtime evaluates these directly where possible. Only subjective criteria go to Oracle.
type SuccessCriterion =
  | { type: 'test'; command: string }                         // exit code 0 = pass
  | { type: 'build'; command: string }                        // exit code 0 = pass
  | { type: 'lint'; command: string }                         // exit code 0 = pass
  | { type: 'fileExists'; path: string }                      // file exists = pass
  | { type: 'command'; command: string; expectExitCode?: number }  // customizable
  | { type: 'oracle' }                                        // Oracle returns structured JSON (subjective)
  | { type: 'observer' };                                     // Observer reads visual artifacts (subjective)
  | { type: 'manual' };                                       // human reviews and decides

// MVP implements: 'test', 'oracle', 'observer', 'manual'. Others deferred.

interface LoopDefinition {
  goal: string;
  successCriteria: string;         // human-readable description (used by oracle/observer)
  success: SuccessCriterion;       // machine-evaluable success criterion
  maxAttempts: number;              // default 3
  // executeAgent is dynamically selected based on task domain
  executeAgent: 'fixer' | 'designer' | 'explorer' | 'librarian';
  // verifyAgent is dynamically selected based on task domain
  // Note: 'council' is NOT a verifyAgent inside the loop - Layer 0 escalation only
  verifyAgent: 'oracle' | 'observer' | 'test';
  // CONSTRAINT: executeAgent and verifyAgent MUST be different agents
  // Validation: startLoop() throws if executeAgent === verifyAgent
  // ROUTING: When success.type is test/build/lint/command/fileExists, engine runs command directly (no agent dispatch).
  //          verifyAgent is only used when success.type is oracle or observer.
  contextFiles?: string[];
  // trigger, worktree, memory: deferred to Future Extensions (see below)
}
```

**2. AttemptRecord** (per attempt)
```typescript
interface AttemptRecord {
  attemptNumber: number;
  executionResult: string;
  verificationResult: VerificationResult;
  artifactPaths?: string[];  // visual artifacts from executing phase (for UI loops)
}
```

**3. VerificationResult** (framework-owned, not LLM opinion)
```typescript
type VerificationResult =
  | { passed: true; reason: string }
  | { passed: false; reason: string; suggestedFix?: string };
```

### Convergence Signals (from #611)

Escalation primitives inside the loop, not the foundation of loop engineering:

- `totalErrors` - accumulated errors across attempts (NOT incremented on `cancelled`)
- `timeoutCount` - consecutive timeouts, resets to 0 on `completed`
- `lastErrorAt` - timestamp of last error

**Place in architecture:**
```
LoopEngine
├── Goal
├── Execution
├── Verification  ← verification is the center
├── State
└── Escalation
      └── Convergence Signals (#611)
```

Error tracking is an **implementation detail of escalation**, not the foundation. Verification is the center of loop engineering.

**Convergence signal scope:** Signals apply to `error` and `timeout` states only. The `cancelled` state is a quiet terminal state - it does NOT increment error counters. This prevents noisy escalation when users intentionally cancel.

**Signal computation:** Convergence signals are computed from `BackgroundJobRecord` state transitions, not explicit flags:
- `totalErrors` - incremented when job state transitions to `error`
- `timeoutCount` - incremented when `timedOut === true` on status update; reset to 0 on `completed`
- `lastErrorAt` - timestamp of last `error` state transition

This avoids redundant `isError`/`isTimeout` fields on status input - the state machine already conveys this information.

When convergence signals exceed threshold:
→ transition to `escalated` state
→ circuit closed, human handoff required

**Signals vs constraints distinction:**
- `BackgroundJobRecord` convergence signals → "signals not constraints" - warn LLM via `formatForPrompt()`, LLM decides
- `LoopEngine` circuit breaker (`escalated` state) → hard constraints - enforced, not signaled

### Session Cleanup

To prevent `/tmp/` memory leaks across multiple loops:

- **Terminal states trigger cleanup:** When state transitions to `done`, `escalated`, or `cancelled`, the engine synchronously deletes:
  - `.loop-history-{loopID}.md` (includes loopID to prevent collision across concurrent loops)

- **Artifact cleanup is orchestrator-owned:** The engine does NOT manage artifact directories. Orchestrator tracks artifact paths via `onArtifactWrite` callbacks and handles cleanup independently.

- **Cancellation also triggers cleanup:** If user triggers `cancel(loopID)`, the engine transitions to `cancelled`, cleans up, fires `onLoopComplete(false)` (not `onEscalated`). Quiet shutdown - no error escalation.

- **"Modify definition and retry" during `escalated`:** Human decides to modify and retry → engine does NOT reuse the session. Instead:
  1. Call `cancel(loopID)` → triggers `cancelled` cleanup
  2. Call `startLoop(newDefinition)` → fresh `loopID`
  This ensures no stale state from the failed loop leaks into the retry.

### Context Compaction via .loop-history.md and Session Artifact Directory

Text history and visual artifacts are handled separately:

**`.loop-history-{loopID}.md`** - text compaction for all loop types:

Written to the project root before each retry. Appended to `contextFiles` so agents read it as file context, not job description noise. Includes loopID in filename to prevent collision across concurrent loops.

```typescript
function compactHistory(history: AttemptRecord[]): string {
  const lines = history.map((a, i) => {
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

**Session artifact directory** - for Observer visual artifact transfer (Designer → Observer):

```
/tmp/loop-{loopID}/
  history.md           # compactHistory output
  artifact-1.png       # screenshot from Designer
  artifact-2.png       # another screenshot
```

Designer writes visual artifacts to `session.artifactDir` during `executing`. Artifact paths included in `resultSummary` or a dedicated `artifacts` field on `BackgroundJobRecord`.

Engine reads artifact paths from completed job, includes them in Observer's `contextFiles` for `verifying`. Observer reads artifacts from session directory as file context - same mechanism as text files, works reliably for multimodal models.

**Why file context, not job description:**
- Models are optimized to read file context
- `.loop-history.md` persists across jobs, reliably available
- Session artifact directory is isolated per loop, no collision risk
- Prepending to job description risks being ignored as noise

### Trigger Architecture

**MVP scope:** Only `manual` (`/loop` command) is implemented. Trigger types (`schedule`, `webhook`, `event`) will be defined in Phase 4 when automation is implemented.

**Worktree isolation and cross-loop memory** are deferred to Future Extensions. See "Future Extensions" section below for interface definitions and implementation notes.

### Dispatch Failure Handling

If `dispatchPhase()` throws (agent API down, token limit exceeded, etc.):

```typescript
try {
  // registerLaunch() + dispatch
} catch (error) {
  session.currentPhase = 'escalated';
  callbacks.onEscalated?.(loopID, `Dispatch failed: ${error}`);
  return;
}
```

No orphaned sessions. Dispatch failure → `escalated` + `onEscalated` with system error immediately.

### Orchestration Flow (Event-Driven)

```
user invokes /loop
  ↓
Orchestrator loads Loop Engineering skill
  ↓
Orchestrator follows skill's Grill instructions → collects LoopDefinition via conversation
  ↓
Orchestrator calls loopEngine.startLoop(definition)
  → engine validates: executeAgent !== verifyAgent (throws if equal)
  → engine creates LoopSession (phase: executing, attempts: 1)
  → engine writes empty .loop-history.md
  → engine dispatches executeAgent (execution job)
  → returns loopID immediately to orchestrator (non-blocking)
  ↓
BackgroundJobBoard.runJob(executing)
  ↓
job completes → LoopEngine.handleTerminalJob()
  → routing: findSessionForJob(taskID)
  → currentPhase = 'verifying' → dispatch based on definition.success.type:
      → 'test'/'build'/'lint'/'command'/'fileExists': run command directly, evaluate exit code
      → 'oracle': dispatch to Oracle, parse JSON verification
      → 'observer': dispatch to Observer, parse JSON verification
  ↓
job completes → LoopEngine.handleTerminalJob()
  → engine evaluates result (JSON parse + retry if parse fails for oracle/observer)
  → passed? → phase = 'done'
  → !passed && canRetry:
      → attempts++
      → writeHistoryFile() → .loop-history.md with compactHistory()
      → phase = 'executing' → dispatch executeAgent (retry with history context)
  → !passed && !canRetry → phase = 'escalated' (circuit closed)
      → engine fires onEscalated
  ↓
... continues event-driven until done/escalated/cancelled ...
  ↓
On escalated → Orchestrator dispatches @council (Layer 0 escalation) → human reviews → decides next action
On cancelled → cleanup → onLoopComplete(false)
```

---

## Skill Layer

### Loop Engineering Skill

Location: `src/skills/loop-engineering/SKILL.md`

The skill instructs the orchestrator - it never "does" anything itself.

**Orchestrator follows skill's Grill instructions:**
- Conduct conversation to define `LoopDefinition` fields
- Questions: goal, success criteria, constraints, preferred agents, max attempts
- Output structured JSON passed to `loopEngine.startLoop()`

**Orchestrator follows skill's Loop Monitor instructions:**
- Listen to engine callbacks (`onLoopComplete`, `onEscalated`)
- Display current state, attempt count, verification result to human
- On `onEscalated` - surface resolution options to human, await instruction
- On human intervention (cancel, force pass, modify definition) - call appropriate engine method

**Skill does NOT:**
- Call `loopEngine` directly - orchestrator does that
- Dispatch agents - engine does that
- Evaluate verification - engine does that (via JSON parsing)
- Manage state - engine does that

---

## Interaction with BackgroundJobBoard

- Each attempt's phases (`executing`, `verifying`) run as individual `BackgroundJob` records
- `BackgroundJobRecord` extended with convergence signals:
  - `totalErrors` - incremented on `error` state only (NOT on `cancelled`)
  - `timeoutCount` - incremented on `timeout`, resets to 0 on `completed`
  - `lastErrorAt` - timestamp of last error

- **Note:** `cancelled` is a quiet terminal state - it does NOT increment `totalErrors` or fire `onEscalated`. This prevents noisy escalation on intentional user cancellations.

- `BackgroundJobBoard` event plumbing updated to support multiple terminal state listeners (callback array instead of single listener)

- `LoopSession` owns phase transitions. Jobs only know `running`, `completed`, `error`, `cancelled`. No loop states pollute the job primitive.

- `.loop-history.md` written by engine, included in `contextFiles` for `executing` dispatches

---

## Verification Implementation

Verification is driven by `SuccessCriterion.type`. The engine routes to the appropriate evaluator:

### Automated Verification (runtime-evaluated, no LLM)

**`{ type: 'test' | 'build' | 'lint' | 'command' | 'fileExists' }`:**
1. Engine dispatches to a test-runner agent (or `@fixer` with a focused prompt) via BackgroundJobBoard
2. Agent runs the command, evaluates exit code or file existence
3. Agent returns structured result: `{ passed: boolean, reason: string }`
4. Engine evaluates result - no LLM involved. Deterministic. Fast.

This uses the same dispatch mechanism as oracle/observer. The engine does not execute commands directly - it delegates to an agent that has shell access.

### Subjective Verification (LLM-based)

**`{ type: 'oracle' }`:**
1. Engine dispatches to Oracle with `verifyTool` (structured JSON output)
2. Oracle returns `{ passed: boolean, reason: string, suggestedFix?: string }`
3. Engine parses JSON - if parse fails and `oracleRetryCount < 1`, re-dispatch once
4. If second parse fails → fail closed (verification = failed)

**`oracleRetryCount` lifecycle:** Persisted in `LoopSession`. Reset to `0` on every `executing` transition. Max 1 retry prevents infinite loops when Oracle consistently returns malformed JSON.

**Oracle is strictly a verifier, not a strategist.** Oracle returns `passed: false, reason: "X"`. The engine takes the failure reason + `compactHistory()` and dispatches `@fixer` to self-correct. No intermediate agent between verification failure and retry.

**`{ type: 'observer' }`:**
1. Engine signals `onArtifactWrite(loopID, path)` so orchestrator can track artifact locations
2. Engine includes artifact paths in Observer's `contextFiles` for `verifying`
3. Observer returns structured JSON via `verifyTool` (same as oracle)
4. Engine parses result, applies retry logic same as oracle

**Observer artifact transfer:** Orchestrator owns the filesystem artifact lifecycle. Engine only signals when artifacts are written (`onArtifactWrite`). This prevents artifact management from bloating the engine's responsibilities.

**`{ type: 'manual' }`:**
1. Engine transitions to `verifying` phase
2. Engine fires `onManualReview(loopID, reason)` callback
3. Engine stops dispatching - session enters a waiting state (phase stays `verifying`, no active job, **no BackgroundJob created**)
4. Orchestrator surfaces the review request to the human
5. Human responds with pass/fail via orchestrator → orchestrator calls `engine.resolveManualReview(loopID, passed, reason)`
6. Engine resumes: `passed` → `done`, `!passed` → retry or escalate based on attempt count

**Manual verification is the simplest on-ramp.** No LLM involved. Human decides. Proven by autoresearch - Karpathy's entire loop is manual inspection. Use when automated verification isn't worth the setup cost, or when you want to eyeball results before committing to a verification criteria.

**No BackgroundJob for manual verification.** The BackgroundJobBoard tracks running jobs only. Manual review is an engine-level waiting state, not a job.

### Council - Layer 0 Escalation Only

**Council is NOT a verifyAgent inside the loop.** Council with 360s+ latency would stall the rapid `executing ↔ verifying` oscillation.

Council is reserved for Layer 0 escalation: when `escalated` fires, Orchestrator dispatches Council to synthesize all prior failures and devise a macro-strategy. Human reviews Council's output and decides next action (new loop with modified definition, abandon, or manual intervention).

**On `escalated`:**
1. Engine fires `onEscalated(loopID, reason)`
2. Orchestrator surfaces options to human:
   - "Modify definition and retry" → start fresh loop (cancel current, call `startLoop(newDefinition)`)
   - "Escalate to Council" → Orchestrator dispatches @council for macro-strategy
   - "Abandon" → Orchestrator calls `cancel(loopID)`, cleanup fires, loop ends

---

## What Exists vs What Needs Building

### Already Exists (Layer 0)
- Orchestrator - already runs skills, delegates to components
- `/loop` command slot - available for registration
- @council - available for Layer 0 escalation

### Already Exists (Layer 1)
- `BackgroundJobBoard` - state tracking, event listener hook
- `setTerminalStateListener` - single listener interface (may need upgrade to callback array)

### Already Exists (Layer 2)
- `@fixer`, `@oracle`, `@council`, `@explorer` agents
- `@designer`, `@observer` - available for UI loops
- `@librarian` - available for research loops
- Skill infrastructure

### Needs Building (PR 1 - Convergence Signals)
1. `BackgroundJobRecord` extended with `totalErrors`, `timeoutCount`, `lastErrorAt`
2. Convergence helper methods on `BackgroundJobBoard`
3. BackgroundJobBoard callback array (if needed for multi-listener)

### Needs Building (PR 2 - Loop Engine)
4. `LoopSession` state machine class (binary oscillation, oracleRetryCount, cleanup)
5. `LoopEngine` event-driven orchestration (cancellation lifecycle, cleanup routine)
6. `writeHistoryFile()` and `compactHistory()` for `.loop-history.md`
7. `SuccessCriterion` routing - test/build/lint/command/fileExists evaluated directly; oracle/observer dispatched
8. Structured verification tool for Oracle (with retry-wrapper)
9. `onArtifactWrite` callback for orchestrator-owned artifact lifecycle
10. `src/skills/loop-engineering/SKILL.md` (Grill interview + loop monitor)
11. `/loop` command registration
12. Tests: state transitions, retry logic, cancellation lifecycle, cleanup, SuccessCriterion routing

---

## Out of Scope (for MVP)
- **Worktree isolation** - deferred to Future Extensions. MVP uses in-process execution.
- **Cross-loop memory** - deferred to Future Extensions. MVP uses per-session history only.
- **Trigger automation** - deferred to Future Extensions. Only 'manual' (`/loop` command) in MVP.
- **Fuzzy verification** - SuccessCriterion only supports binary outcomes. No engagement metrics or content quality scoring.
- **Token budget / cost controls** - `maxAttempts` limits iterations but not token spend per iteration. Deferred to post-MVP.
- **MCP connectors** - no GitHub Issues, Slack, Sentry integration
- Persistence layer (in-memory only for session; file-based for `.loop-history.md`)
- New hooks or infrastructure beyond orchestration wiring
- Visualization/monitoring beyond skill prompts
- Layer 1 always enforces constraints - no "signals not constraints" philosophy in the engine layer

**Full theory compliance** would require all 6 building blocks:
1. Trigger (cron, webhooks, events) - deferred
2. Worktree isolation - deferred
3. Execution (covered) - done
4. Verification (fuzzy path) - deferred
5. Memory (cross-loop) - deferred
6. Connectors (MCPs) - deferred

MVP = items 3 + 4 (binary verification) + skill harness + orchestration wiring.

---

## Real-World Validation

### autoresearch (Karpathy, March 2026)

A minimal autonomous research loop that validates our architecture:

| autoresearch | Our Spec |
|---|---|
| `program.md` (skill/instructions) | `src/skills/loop-engineering/SKILL.md` |
| `train.py` (while True loop) | `LoopEngine` (event-driven state machine) |
| `prepare.py` (fixed, never edited) | Infrastructure (BackgroundJobBoard, agents) |
| git history | `.loop-history.md` context compaction |
| manual inspection | `@oracle` / `@observer` verification |
| 5-min experiments | `maxAttempts` with circuit breaker |

**Key takeaway:** Karpathy's loop is the simplest possible: skill + executor + git history + manual verification. No cross-loop memory, no triggers, no MCP connectors. Our MVP (execute + binary verification + skill harness + orchestration wiring) matches this proven pattern.

**Divergence:** autoresearch has no verification agent - Karpathy manually inspects results. Our spec adds `@oracle`/`@observer` as automated verifiers, which is the right next step beyond manual inspection but still within the "binary oscillation" pattern.

### Comparison with Claude Code and Codex

| Feature | Claude Code | Codex (OpenAI) | OpenCode (our target) |
|---|---|---|---|
| Loop mechanism | `while True` in CLAUDE.md | Agent loop (background tasks) | Background Job Board + LoopEngine |
| Verification | Manual / `claude-mem` | Task completion signal | `@oracle`/`@observer` structured JSON |
| Context persistence | `CLAUDE.md` edits | Cloud session state | `.loop-history.md` + future `.loop-memory.md` |
| Worktree isolation | Manual (`git worktrees`) | N/A (cloud) | Planned (using-git-worktrees skill) |
| Trigger automation | None | Scheduled background agents | Planned (cron/webhook/event) |

Our architecture is ahead of both on the verification and trigger fronts, but behind Claude Code on real-world adoption. The spec is sound.

---

## PR Scope

**Phased roadmap:**
- **Phase 1**: Runtime loop engine (this PR)
- **Phase 2**: Loop skill (Grill + Monitor)
- **Phase 3**: Routine integration - loop engine plugs into existing oh-my-opencode-slim workflow routines
- **Phase 4**: Triggers (cron, webhooks)
- **Phase 5**: Persistent memory (cross-loop)

This progression mirrors how users adopt loop engineering and reduces implementation risk.

### PR 1 - Convergence Signals (BackgroundJobBoard extension)
- Extends `BackgroundJobRecord` with `totalErrors`, `timeoutCount`, `lastErrorAt`
- Adds convergence helper methods to `BackgroundJobBoard`
- Upgrades event plumbing to callback array
- **Ready to open now**

### PR 2 - Loop Engine (full runtime orchestration)
- `LoopSession` + `LoopEngine` event-driven state machine
- `SuccessCriterion` routing (test/build/lint/command/fileExists + oracle/observer)
- Skill + `/loop` command
- Tests
- **Depends on PR 1 merging first**

### Deferred (Architected in Future Extensions)
- Worktree isolation
- Cross-loop memory
- Trigger automation (schedule, webhook, event)

### Deferred (Not yet architected)
- Fuzzy verification
- MCP connectors

---

## Future Extensions (Deferred - Not in MVP)

These features are deferred. Interfaces will be defined when implementation begins.

- **Worktree isolation** - opt-in per LoopDefinition, uses `using-git-worktrees` skill. Prevents parallel loop file collisions.
- **Cross-loop memory** - `.loop-memory.md` file store. Learns from prior loops: successful strategies, failure patterns, tuned convergence thresholds.
- **Trigger automation** - cron, webhook, event-driven invocation. `LoopTrigger` interface defined in Phase 4.

---

## Example Usage

### Implementation Loop (Fixer → Oracle)

```
User: /loop

Orchestrator follows skill's Grill instructions:
  "What are you trying to accomplish?"
User: "Fix the auth bug in src/auth/"
  "What does success look like?"
User: "All tests pass and no regressions"
  "Max attempts?"
User: "3"
  "Execute agent?"
User: "fixer"
  "Verify agent?"
User: "oracle"

Orchestrator calls loopEngine.startLoop(definition)

Loop Engine (event-driven):
  Attempt 1:
    executing  → @fixer executes plan → job completes
    verifying  → @oracle returns JSON verification → FAIL (reason: "token mismatch in auth handler")
      → parse failed → retry once → parse failed again → fail closed
  Attempt 2:
    writeHistoryFile() → .loop-history.md
    executing  → @fixer reads .loop-history.md + failure reason → self-corrects → job completes
    verifying  → @oracle returns JSON verification → PASS
  → done

Orchestrator receives onLoopComplete → reports to human
```

### UI Loop (Designer → Observer)

```
User: /loop

Orchestrator collects definition:
  goal: "Improve the dashboard header"
  successCriteria: "Header is responsive, centered, no overflow on mobile"
  executeAgent: "designer"
  verifyAgent: "observer"
  maxAttempts: 2

Loop Engine:
  Attempt 1:
    executing  → @designer implements changes → writes screenshot to /tmp/loop-xyz/artifact-1.png
    verifying  → @observer reads artifact-1.png → JSON: passed: false, reason: "overflow on 375px viewport"
  Attempt 2:
    writeHistoryFile() → .loop-history.md
    executing  → @designer reads .loop-history.md + reason → self-corrects → writes artifact-2.png
    verifying  → @observer reads artifact-2.png → JSON: passed: true
  → done
```

### Escalation to Council

```
Loop Engine:
  Attempt 1..3: all FAIL (verification failed each time)
  → attempts >= maxAttempts → phase = 'escalated' → fires onEscalated

Orchestrator receives onEscalated:
  "Loop reached max attempts. Dispatching @council to analyze failures..."
  → calls council for macro-strategy synthesis
  → human reviews Council output, decides next action
```