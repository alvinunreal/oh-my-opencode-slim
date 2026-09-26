# src/skills/codemap/

## Responsibility

- Provide a command-style skill package that standardizes repository mapping workflows for unfamiliar codebases.
- Define the task contract used by Orchestrator/fixer agents via `SKILL.md` and operational guidance via `README.md`.
- Generate and evolve change-aware codemap state artifacts (`.slim/codemap.json`) and scaffold placeholders (`codemap.md`).

## Design

- Contract layer: `SKILL.md` (machine prompt contract) + `README.md` (human-facing operation notes).
- Execution layer: `scripts/codemap.mjs` exports deterministic helper functions:
  - `parseArgs(argv)`
  - `cmdInit`, `cmdChanges`, `cmdUpdate`
  - `selectFiles`, `computeFileHash`, `computeFolderHash`, `createEmptyCodemap`
  - `loadState`, `saveState`, `migrateLegacyState`
- Persistence model: JSON state at `.slim/codemap.json` with `metadata`, `file_hashes`, and `folder_hashes`.
- Testing layer: `scripts/codemap.test.ts` validates pattern matching, hash determinism, and migration behavior.
- The script intentionally avoids network and mutates only filesystem-local state and codemap templates.

## Flow

- Entry point `main(argv)` parses command and arguments (`init|changes|update`, `--root`, `--include`, `--exclude`, `--exception`) and dispatches via strict branches.
- `cmdInit()` computes include/exclude candidate sets using `selectFiles()` and writes:
  1) `.slim/codemap.json` via `saveState()`
  2) one `codemap.md` per discovered folder via `createEmptyCodemap()`.
- `cmdChanges()` reloads state (`loadState()` + `migrateLegacyState()`), recomputes current hashes, emits added/removed/modified diffs and affected folder list, and exits non-zero if state is absent.
- `cmdUpdate()` recomputes full state from existing metadata and persists it, used after targeted fixers finish updates.
- `codemap` skill invocation path in SKILL workflow is explicit: Step 1 checks `.slim/codemap.json` or `.slim/cartography.json`, then Step 2/3 selects init or incremental path.

## Integration

- Installed under OpenCode through `src/cli/custom-skills.ts` as `name: 'codemap'`, `sourcePath: 'src/skills/codemap'`.
- `src/cli/install.ts` copies this directory into the user skill directory; OpenCode executes `scripts/codemap.mjs` from that context.
- Skill visibility is handled by native v1/v2 host discovery from finalized agent/session permissions; hidden skills are denied and discoverable skills require permission approval. The plugin does not rewrite `<available_skills>` in conversation text.
- `scripts/verify-release-artifact.ts` includes codemap skill metadata and runtime checks as required packaged files.
