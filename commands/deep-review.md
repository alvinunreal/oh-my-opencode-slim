---
description: "Deep 3-agent parallel code review: correctness, security, tests, and scope."
agent: build
---

Do not restate these instructions. Execute the following workflow immediately, starting at step 1.

Goal: run a thorough code review on the current branch's changes before merge.
Optional focus or PR reference: $ARGUMENTS

Steps:

1. Determine the review target.
   - If $ARGUMENTS contains a PR number or URL:
     a. Run `gh pr view $ARGUMENTS` to get PR title, body, base branch, and metadata.
     b. Run `gh pr diff $ARGUMENTS` to get the diff.
   - Otherwise, review the current branch against its base:
     a. Detect the base branch (`main` or `master`) and collect `git diff <base>...HEAD` for committed changes.
     b. Also check `git diff` and `git diff --cached` for uncommitted work — include these in the review if present, clearly labeling them as uncommitted.
   - If there are no changes to review, explain that and stop.

2. Gather context.
   Read the changed files fully (not just the diff hunks) so the review understands surrounding code. Check for related tests, types, and documentation that may need updating.

3. Spawn three parallel reviewer subtasks (Task with subagent_type="reviewer"), each receiving the full diff and changed-file context.
   - Reviewer A — **Correctness and logic**: trace the happy path and at least two edge cases per changed function. Flag off-by-one errors, nil/undefined access, race conditions, incorrect error propagation, and logic that doesn't match stated intent.
   - Reviewer B — **Security and data safety**: hardcoded secrets, missing input validation, injection vectors (SQL, XSS, command), auth/authz gaps, unsafe deserialization, sensitive data in logs, TOCTOU issues.
   - Reviewer C — **Tests, scope, and maintainability**: are new code paths tested? Are edge cases covered? Did scope creep beyond the stated task? Are there dead code, unused imports, inconsistent patterns, or missing type annotations?
   When $ARGUMENTS contains a focus area, include it as a priority concern in every reviewer prompt.

4. Aggregate findings and classify severity.
   - **CRITICAL** — must fix before merge: bugs, security issues, data loss risk, broken tests.
   - **WARNING** — should fix: missing edge-case coverage, code smells, weak error handling.
   - **NIT** — consider fixing: naming, style, minor simplifications.
   Deduplicate overlapping findings. Drop speculative concerns without evidence.

5. Verify independently using the project's own commands. Detect them in this order:
   a. `package.json` scripts: look for `test`, `type-check`, `typecheck`, `lint` scripts and run them.
   b. Rust: `cargo test`, `cargo clippy --all-targets`.
   c. Python: `pytest` or `python -m unittest`.
   d. Go: `go test ./...`, `go vet ./...`.
   e. Makefile/Justfile: look for `test`, `check`, or `lint` targets.
   Use whichever apply to this project. Skip checks that are not available. Report any failures as CRITICAL findings.

6. Produce the review report.
   - Lead with verdict: **APPROVE**, **REVISE** (list required changes), or **REJECT** (fundamental issue).
   - Group findings by severity, quoting the exact code for each.
   - End with a checklist of required actions before merge (if any).

   Do NOT edit or fix code. This command only reviews — the author fixes.

Constraints:
- Read-only — produce findings, never apply edits.
- Be specific — quote exact lines and explain *why* something is wrong, not just *what*.
- If everything genuinely passes, say APPROVE and nothing else. Don't pad approvals.
