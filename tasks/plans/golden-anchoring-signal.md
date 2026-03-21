# Code Quality Audit — opencode-discipline

> Done when every finding is documented with severity, location, and suggested fix, and all verify commands pass clean.

## Context
- **Current state**: 3 source files (`src/index.ts`, `src/wave-state.ts`, `src/name-generator.ts`), 9 test files, 8 agent markdown files. Package is `opencode-discipline@0.1.1`, TypeScript with Bun runtime, ESM output.
- **Target state**: A documented list of code quality findings with severity ratings, plus any quick fixes applied.
- **Patterns to follow**: Bun test runner, strict TypeScript, `@opencode-ai/plugin` API conventions.

## Decisions
- **Audit-only, no refactors**: This plan documents findings. Fixes are separate work unless trivial (< 5 lines).
- **Severity scale**: CRITICAL (bugs, security), WARNING (code smell, missing coverage), NIT (style, naming).

## Phases

### Phase 1: Static analysis and test verification
- [x] Run `bun run type-check` — confirm zero TypeScript errors
- [x] Run `bun test` — confirm all 9 test files pass (37 tests, 0 failures)
- [x] Run `bun run build` — confirm build succeeds and `dist/index.js` is produced (0.47 MB)
- **Verify**: `bun run type-check && bun test && bun run build` — expected: all pass with zero errors/warnings
- **Rollback**: N/A (read-only phase)

### Phase 2: Code quality review and findings report
Review each source file against the checklist below and produce a findings summary.

**Review checklist for `src/index.ts` (456 lines):**
- [x] Check: `extractSessionID` (line 35-54) — uses `as Record<string, unknown>` casts. NIT: safe due to runtime guards, Zod optional.
- [x] Check: `DisciplinePlugin` function (line 214-455) — single 240-line function. WARNING: should extract hook handlers.
- [x] Check: `readSessionTodos` (line 191-212) — catches all errors silently (`catch {}`). WARNING: should log at warn level.
- [x] Check: `hasPlanKickoffTodo` (line 183-189) — uses `.includes(planNameLower)`. NIT: false-match risk negligible.
- [x] Check: `tool.execute.before` hook (line 273-296) — confirmed `?.` is present on line 274. No issue.

- **Verify**: Produce a markdown summary of findings with severity, file, line, and suggested fix for each item.
- **Rollback**: N/A (read-only phase)

### Phase 3: Test coverage gap analysis
- [x] Check: No test covers `session.create` success + `session.prompt` throw. WARNING: gap confirmed, test recommended.
- [x] Check: No test covers `loadStateFromDisk` with malformed JSON. WARNING: gap confirmed, test recommended.
- [x] Check: `Math.random() === 1.0` boundary. NIT: impossible per spec, code is correct. Comment recommended.
- [x] Check: `isBlockedEnvRead` case-insensitive variants. NIT: `.toLowerCase()` is correct, more test cases recommended.

- **Verify**: List each coverage gap with a recommended test case description.
- **Rollback**: N/A (read-only phase)

## Dependencies
- Phase 2 and Phase 3 can run in parallel after Phase 1 passes.

## Risks
- **False positives**: likelihood medium, impact low → mitigation: each finding must cite specific line numbers and explain why it matters.

## Out of scope
- Implementing fixes (separate plan if needed)
- Agent markdown content review (those are prose, not code)
- Performance profiling
- Dependency audit (`@opencode-ai/plugin`, `zod` versions)

## Acceptance criteria
- [x] `bun run type-check` passes with zero errors
- [x] `bun test` passes all test files (37 tests, 9 files)
- [x] `bun run build` produces `dist/index.js` (0.47 MB)
- [x] Findings report exists at `tasks/audit-findings.md` with severity, file path, line number, and suggested fix for each item
- [x] Test coverage gaps are documented with recommended test descriptions
