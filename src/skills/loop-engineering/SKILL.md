---
name: loop-engineering
description: Loop engineering runtime Grill + Monitor
---

# Loop Engineering Skill

## Grill (orchestrator interview)

1. Goal: "What are you trying to accomplish?"
2. Success criteria: "Describe how we know the loop succeeded."
3. Success type: choose from `test`, `build`, `lint`, `command`, `fileExists`, `oracle`, `observer`, `manual`. For CLI steps provide `successCommand`; for file detection provide `successPath`.
4. Execute agent: fixer / designer / explorer / librarian
5. Verify agent: oracle / observer / test
6. Max attempts (default 3)
7. Optional context files: which files or directories should be read before execution?

## Loop Monitor

- Listen to callbacks:
  - `onLoopComplete(loopID, success)` → report final outcome
  - `onEscalated(loopID, reason)` → escalate to human
  - `onManualReview(loopID, reason)` → prompt human to approve/fail and call `resolveManualReview(loopID, passed, reason)`
- Show current state and attempt count on each callback
- For manual verification, present the failure reason before asking for pass/fail
- If human forces cancellation, call `cancel(loopID)` through the orchestrator

## Notes
- Manual verification is the minimal on-ramp (autoresearch pattern). It pauses the loop until `resolveManualReview` is called. Do not auto-resolve.
- BackgroundJobBoard signals (totalErrors, timeoutCount) are already baked into the runtime.
