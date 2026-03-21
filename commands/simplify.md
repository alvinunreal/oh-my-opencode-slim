---
description: "Parallel 3-agent code review and targeted cleanup on recent changes."
agent: build
---

Review and simplify recently changed code without altering behavior.

Optional focus: $ARGUMENTS

Workflow:

1. Collect the target diff using this fallback chain:
   a. `git diff` (unstaged) and `git diff --cached` (staged) — use whichever has content, or combine both.
   b. If both are empty, try `git diff HEAD` (all uncommitted changes vs last commit).
   c. If still empty, inspect recently modified files via `git status --short` and read any with recent timestamps.
   d. If nothing meaningful is found, explain that and stop.
   Capture the full unified diff — reviewers need the actual patch, not just filenames.

2. Spawn three parallel reviewer subtasks (Task with subagent_type="reviewer"), each receiving the same diff context.
   - Reviewer A — **Code reuse**: duplicated logic, hand-rolled helpers that duplicate existing utilities, copy-paste with minor variation.
   - Reviewer B — **Code quality**: readability, naming, structure, convention consistency, unnecessary abstraction or missing abstraction, parameter sprawl.
   - Reviewer C — **Efficiency**: unnecessary work, missed concurrency, hot-path bloat, overly broad I/O, TOCTOU patterns, memory concerns.
   When $ARGUMENTS is provided, include it as a priority focus area in every reviewer prompt.

3. Aggregate and filter findings.
   - Keep only high-confidence, behavior-preserving improvements.
   - Skip speculative performance tweaks without evidence and stylistic nitpicks already handled by linters/formatters.
   - When reviewers disagree, prefer the conservative option.
   - Briefly note any significant findings intentionally skipped and why.

4. Apply fixes directly in the worktree, keeping functionality identical.
   Only edit files in the target diff unless a dependency fix is strictly required.
   Do not revert unrelated user changes.

5. Verify using the project's own commands. Detect them in this order:
   a. `package.json` scripts: look for `test`, `type-check`, `typecheck`, `lint` scripts and run them.
   b. Rust: `cargo test`, `cargo clippy --all-targets`.
   c. Python: `pytest` or `python -m unittest`.
   d. Go: `go test ./...`, `go vet ./...`.
   e. Makefile/Justfile: look for `test`, `check`, or `lint` targets.
   Use whichever apply to this project. Skip checks that are not available. Fix obvious regressions before reporting.

6. Report: what changed, what was validated, and any remaining follow-ups.

Constraints:
- Preserve behavior — no feature changes.
- Prefer simpler, explicit code over clever compact code.
- Do not widen scope beyond the target diff unless required for correctness.
