# ADR-002: Consolidate Eval CLI into a Single Entry Point

**Date:** 2026-08-29
**Status:** Accepted
**Deciders:** User + Agent

## Context

The eval CLI had four separate entry points, each with overlapping responsibilities:

- `eval.ts` (single-suite runner)
- `eval-all.ts` (multi-suite orchestrator with judge/oracle/synthesis)
- `eval-diff.ts` (result comparison)
- `precheck.ts` (suite validation)

Plus a library module `run-eval-suite.ts` that was extracted to share the "run a single suite" logic between `eval.ts` and `eval-all.ts`.

Over three architecture-review sessions, the eval subsystem was deepened: per-case execution, polling engine, judge, session manager, git lifecycle, and shared client types were all extracted into dedicated modules. The CLI layer, meanwhile, accumulated more layers than it needed.

## Decision Drivers

- **One adapter → hypothetical seam.** `run-eval-suite.ts` had one caller after `eval.ts` was deleted. A module with one caller is a pass-through, not a seam worth preserving.
- **Server lifecycle had one caller.** `server-lifecycle.ts` was 55 lines, imported only by `eval.ts`. The deletion test: deleting it moves its logic into `eval.ts` — nothing lost.
- **Four entry points, same runtime.** `eval.ts`, `eval-diff.ts`, `precheck.ts`, and `collect.ts` all import the same evals core, parse args, and exit. They differ only in which mode they invoke.
- **Flag-based dispatch is simpler.** A single `--diff`, `--precheck`, or `--collect` flag on `eval.ts` replaces three separate files with zero duplication.

## Considered Options

### Option 1: One File, Flag-Based Dispatch

Merge all four entry points into `eval.ts`. Add `--diff`, `--precheck`, `--collect` flags. The file is larger (541 lines) but contains no duplication — each mode is an early-exit branch.

- **Pros**: Single entry point, no duplication, no shallow modules, delete 4 files
- **Cons**: Larger file, branches must be kept independent

### Option 2: Keep Separate Entry Points

Leave `eval.ts` as the runner, `eval-diff.ts` for diffs, `precheck.ts` for validation, `collect.ts` for manual collection. Keep `run-eval-suite.ts` as the shared library.

- **Pros**: Each file is small, single responsibility
- **Cons**: 4 files × 2-3 imports each, `run-eval-suite.ts` has one caller, `server-lifecycle.ts` has one caller, each file duplicates import lists and parseArgs

### Option 3: Library + Thin CLI Wrappers

Keep `run-eval-suite.ts` as a library, make each CLI entry point a 10-line import + call.

- **Pros**: Clean separation of CLI from library
- **Cons**: `run-eval-suite.ts` still has one caller (the CLI), library is a pass-through. The `import.meta.main` guard makes the library a CLI itself.

## Decision

Consolidate to **one file, flag-based dispatch** (Option 1).

## Rationale

1. **Deletion test.** `run-eval-suite.ts` passes the deletion test into `eval.ts` — its logic concentrates in the only caller. `server-lifecycle.ts` passes the same test. Both were deleted.
2. **No test penalty.** The runner logic is tested through `src/evals/`. The CLI layer is a thin shell around library calls — no value in testing it in isolation.
3. **Flag-based dispatch is proven.** `--suite`, `--smoke`, `--judge`, `--outputs-file` already worked. Adding `--diff`, `--precheck`, `--collect` is the same pattern.
4. **Future modes are free.** Adding `--watch` or `--ci` or `--json` is one more option in parseArgs and one more early-exit branch.

## Consequences

### Positive

- Single `eval.ts` entry point. `bun run eval` works for all modes.
- 4 files deleted: `eval-diff.ts`, `precheck.ts`, `run-eval-suite.ts`, `server-lifecycle.ts`
- No duplicate import lists, no duplicate parseArgs blocks
- Server lifecycle is private to eval.ts, not exported

### Negative

- `eval.ts` is 541 lines. A single file this large can tempt future authors to add unrelated logic.
- Mitigation: the file is structurally a switchboard — each mode is a standalone early-exit block. No shared mutable state between modes.

### Risk

- The `--collect` mode inlines interactive stdin reading. If this mode grows significantly, it should be extracted. For now (64 lines), the deletion test still says "leave it."
- Mitigation: trivial — extract when the interactive collection logic exceeds ~100 lines.

## Implementation Notes

- `startServe`/`stopServe` are private functions in `eval.ts`, not exported.
- `--diff` reads result files with `loadLatestResultPath` + `loadAllResults` from the runner.
- `--precheck` validates all suites against `EvalSuiteSchema` then exits.
- `--collect` reads stdin interactively and writes an outputs JSON, then exits.
- `--suite` is required for `--diff` and `--collect`; optional for `--precheck` and the default run mode.

## Related Decisions

- ADR-001: Session Reflection Mode — unrelated, same docs/adr directory
- Eval architecture deepenings (no ADR): polling engine, per-case extraction, judge module, session-manager, eval-client, withTimeout utility

## References

- `src/cli/eval.ts` — the consolidated entry point
- `src/evals/` — all runner and assertion modules