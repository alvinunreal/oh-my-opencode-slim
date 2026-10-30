---
name: deepwork
description: High-cost orchestrator workflow for large, high-risk, multi-phase coding efforts with meaningful dependencies and review gates. Do not activate for routine multi-file changes.
---

# Deepwork

Deepwork is an orchestrator workflow for heavy coding sessions: a whole
product or subsystem, cross-cutting architectural change, unsafe-to-partially-
ship migration, or sustained coordination across specialist lanes. Never infer
it merely because a task touches multiple files; skip it for trivial edits,
quick docs changes, simple bug fixes, or routine bounded features.

## Work Like a Painter

A painter does not finish one finger before sketching the hand. Build the
whole picture in passes, each at a higher fidelity, keeping it easy to adjust:

1. **Sketch** — every major flow works end to end, thinly. Rough is fine;
   faked or hidden is not.
2. **Structure** — real data model, real module boundaries, the main failure
   paths.
3. **Detail** — hardening, crash recovery, edge cases, polish. Repeat as
   needed.

Every pass ends with a committed, usable product and a ranked known-issues
list. Work is never finished: there will always be more to harden and more
bugs to fix. Stop when the task's goal is met at a fidelity that serves it,
and hand the remaining known issues over — leftovers are expected, not
failure.

Two things are never deferred to a later pass: security and money/data
correctness. Everything else is judged against the current pass.

## Autonomy

Run autonomously to the end by default. Make reasonable decisions yourself,
record them in the progress file, and keep moving. Ask the user only when
truly blocked: credentials, paid commitments, irreversible or public external
actions, or a decision with no safe default. If the task asks for check-ins
(for example, after each pass), honor that.

## Role

Act as scheduler and integrator, not the default implementation worker. Make
small integration and remediation edits yourself when you already hold the
context. Value productivity: a working whole picture beats a perfect corner.

## Planning a Pass

- Define the pass goal in one or two lines: what the whole product does at
  this fidelity.
- Split the pass into a few coherent lanes (about four or fewer) with
  disjoint write scopes. Agree the interfaces between lanes before dispatching
  them — only as firmly as this pass needs; expect them to move later.
- Plan @designer and @fixer as separate lanes from the start: @designer owns
  visuals; @fixer owns wiring, types, and tests.
- If the pass has lanes that touch persistent state, money, concurrency,
  crash recovery, or destructive operations, get one short @oracle design
  review of the pass plan covering all of them before dispatch. Design flaws
  are cheap to fix before implementation.
- Record the pass plan in the progress file; give the user a compact version.

## Running a Pass

- Every delegation states scope, interfaces it relies on, and acceptance
  evidence. Every lane report must list changed files, the exact commands run
  with their exit codes, and what remains unverified.
- Accept a lane after checking one decisive artifact — source for interfaces,
  real output for runtime, opened screenshots for UI. A build passing proves
  neither behavior nor visual quality.
- After two misses from a lane, change the boundary or the specialist instead
  of sending a longer version of the same prompt.
- Lanes run focused checks for their own scope. Run the broad suite once per
  pass, after reconciling all writers; reuse evidence while it stays valid.
- If the pass runs about twice its expected effort, step back and re-plan
  instead of pushing on.

## Gate and Step Back

At the end of each pass:

1. Run the broad validation once on the reconciled state.
2. Request one @oracle gate scoped to this pass: is the whole picture right at
   this fidelity? Findings that belong to a later pass go to the known-issues
   list, not into a fix loop. Fix blockers in one bounded pass; at most two
   re-reviews, each only for materially changed risks. State the attempt in
   every gate prompt, e.g. `Pass 2 gate — attempt 2 of 3`.
3. Commit the pass.
4. Step back: run the product as a whole, look at it, and re-plan the next
   pass from what you see rather than from the original plan. Review the code
   organization too — if files grew huge or module boundaries blurred, make
   reorganization part of the next pass before it becomes unmaintainable.
   Likewise, if slow tests or builds noticeably dragged this pass, make
   speeding them up part of the next pass — without dropping essential
   state, security, or real-service evidence.

## State

`.slim/deepwork/` is the resume index for Deepwork-owned state, not a second
workspace for process documents. Keep it small and current; it exists to
resume after compaction, not to log activity.

- **Router head** `.slim/deepwork/<session-id>.md`, pinned by the activation
  prompt and reused on re-run: `status: active` (or `status: completed`) and
  `slug:` — nothing else. Never modify another session's head.
- **Progress file** `.slim/deepwork/<task-slug>/progress.md`, rewritten in
  place, at most about 40 lines of plain prose: status, pass and its goal,
  next step, constraints and decisions, running lanes (one line each), a concise
  References list of project files (with an optional `sha`), and the ranked
  known-issues list. No activity log; durable decisions live at referenced
  project paths.
- Other Deepwork process files do not belong under `.slim/deepwork`. Durable
  verdicts, research, and decisions go to the project's existing tracked
  documentation paths. Generated assets stay where their producing script or
  path contract requires them.
- Update state at pass transitions, decisions, and blockers — not after every
  lane.

Setup: before creating any deepwork file, ensure `.gitignore` contains
`.slim/deepwork/` and `.ignore` contains `!.slim/deepwork/` plus
`!.slim/deepwork/**`, adding only missing entries. Claim a new task with
`mkdir -p .slim/deepwork` then a plain `mkdir .slim/deepwork/<task-slug>`;
if it already exists and another session's `status: active` head names that
slug, pick another slug, otherwise adopt it. Write the `slug:` into your head
before working.

Resume: read your head, then its progress file, then only the References it
points to. Nothing else.

## Completion

Rewrite the progress file as a tombstone of at most 15 lines: first line
`status: completed`, then the final outcome, pointers to key deliverables,
the remaining known issues, and the date. Flip the head to
`status: completed`. Then delete only the Deepwork-owned head and progress
state when no longer needed, or follow the project's own tombstone convention.
Do not delete producer-owned asset directories. Finish with final validation
and a concise summary.
