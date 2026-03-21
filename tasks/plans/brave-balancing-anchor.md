# Rename `name-generator` module to `plan-name-generator`

> Done when `src/name-generator.ts` no longer exists, `src/plan-name-generator.ts` contains the same code, all imports resolve, all tests pass, and docs reflect the new name.

## Context
- **Current state**: `src/name-generator.ts` exports `generatePlanName()`. Imported by `src/wave-state.ts` (line 4) and tested by `src/__tests__/name-generator.test.ts` (line 3). Referenced in `docs/PROJECT_OVERVIEW_COMPACT.md` (lines 6, 19, 41).
- **Target state**: File renamed to `src/plan-name-generator.ts`, test renamed to `src/__tests__/plan-name-generator.test.ts`, all imports updated, docs updated. No functional changes.
- **Patterns to follow**: Kebab-case filenames (existing convention). ESM imports with `./` relative paths. Tests mirror source filenames in `src/__tests__/`.

## Decisions
- **File rename only, not function rename**: `generatePlanName()` is already descriptive. Renaming the function would touch more call sites for no clarity gain.
- **Leave old plan files untouched**: `tasks/plans/vigilant-gating-sentinel.md` and `tasks/plans/golden-anchoring-signal.md` are historical records of past work. Updating them would rewrite history.
- **Update `tasks/audit-findings.md`**: Skip — it's a historical audit snapshot, same reasoning as old plans.
- **Use `git mv` for rename**: Preserves git history tracking for the file.

## Phases

### Phase 1: Rename source file and update imports
- [ ] `git mv src/name-generator.ts src/plan-name-generator.ts`
- [ ] In `src/wave-state.ts` line 4: change `from "./name-generator"` → `from "./plan-name-generator"`
- **Verify**: `bun run type-check` — expected: no TypeScript errors
- **Rollback**: `git mv src/plan-name-generator.ts src/name-generator.ts` and revert `src/wave-state.ts` line 4

### Phase 2: Rename test file and update test imports
- [ ] `git mv src/__tests__/name-generator.test.ts src/__tests__/plan-name-generator.test.ts`
- [ ] In `src/__tests__/plan-name-generator.test.ts` line 3: change `from "../name-generator"` → `from "../plan-name-generator"`
- **Verify**: `bun test src/__tests__/plan-name-generator.test.ts` — expected: all 3 tests pass
- **Rollback**: `git mv src/__tests__/plan-name-generator.test.ts src/__tests__/name-generator.test.ts` and revert import

### Phase 3: Update documentation
- [ ] In `docs/PROJECT_OVERVIEW_COMPACT.md` line 6: change `src/name-generator.ts` → `src/plan-name-generator.ts`
- [ ] In `docs/PROJECT_OVERVIEW_COMPACT.md` line 19: change `src/name-generator.ts` → `src/plan-name-generator.ts`
- [ ] In `docs/PROJECT_OVERVIEW_COMPACT.md` line 41: change `src/name-generator.ts` → `src/plan-name-generator.ts`
- **Verify**: `grep -c "name-generator" docs/PROJECT_OVERVIEW_COMPACT.md` — expected: 0 matches

### Phase 4: Full validation
- [ ] Run full test suite: `bun test` — expected: all tests pass (no regressions)
- [ ] Run type check: `bun run type-check` — expected: no errors
- [ ] Run build: `bun run build` — expected: `dist/` output includes `plan-name-generator.js`
- **Verify**: all three commands exit 0

## Dependencies
- Phase 2 depends on Phase 1 (test imports reference the source module)
- Phase 3 can run in parallel with Phase 2 (docs are independent of code)
- Phase 4 depends on Phases 1, 2, and 3 (full validation after all changes)

## Risks
- **Stale import in an unscanned file**: likelihood low, impact medium → mitigation: `grep -r "name-generator" src/` after Phase 2 to catch stragglers
- **Build output path change breaks downstream**: likelihood low, impact low → mitigation: `package.json` exports only `./dist/index.js`, internal modules aren't exposed

## Out of scope
- Renaming the `generatePlanName()` function (decided: name is already clear)
- Updating historical plan files in `tasks/plans/` (they document past state)
- Updating `tasks/audit-findings.md` (historical audit snapshot)

## Acceptance criteria
- [ ] `src/name-generator.ts` does not exist
- [ ] `src/plan-name-generator.ts` exists with identical content
- [ ] `src/__tests__/plan-name-generator.test.ts` exists and passes
- [ ] `bun test` — all tests pass
- [ ] `bun run type-check` — no errors
- [ ] `bun run build` — succeeds
- [ ] `grep -r "name-generator" src/` returns zero matches
- [ ] `docs/PROJECT_OVERVIEW_COMPACT.md` references `plan-name-generator` (not `name-generator`)
