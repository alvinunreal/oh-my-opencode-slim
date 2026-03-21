# Changelog

## 0.3.10

### Changed

- **`/deep-review` runs under build agent** — Changed from `plan` to `build` agent so it can delegate to `reviewer` subagents (plan agent lacks that permission).
- **Command install refactored** — Renamed `installCommandFiles` → `installProjectCommandFiles` for symmetric naming with `installGlobalCommandFiles`. Simplified options bag to positional param. Removed TOCTOU `existsSync` guard before `mkdirSync`.

## 0.3.6

### New

- **Claude-style `/simplify` command** — Added a bundled `simplify` command loaded from `commands/simplify.md`. It targets recently changed files, prompts three parallel reviewer passes (reuse, quality, efficiency), applies safe simplifications, and verifies with tests/type-check.
- **Claude-style `/batch` command** — Added a bundled `batch` command loaded from `commands/batch.md`. It plans large parallelizable migrations, requires plan approval before execution, runs isolated workers when possible, and reports per-unit status.
- **`/deep-review` command** — Added a read-only review command loaded from `commands/deep-review.md`. Runs under the plan agent, spawns three parallel reviewers (correctness, security, tests/scope), classifies findings by severity, and produces a verdict (APPROVE/REVISE/REJECT). Named `/deep-review` to avoid overriding OpenCode's native `/review`.

## 0.3.5

### Fixed

- **Startup toast on new instance** — Added bounded startup retry scheduling plus event-triggered retry so the in-app TUI startup toast appears reliably even when TUI transport initializes after plugin load.

## 0.3.4

### Fixed

- **TUI startup toast delivery** — Removed `query.directory` from TUI toast calls to match OpenCode/oh-my-opencode usage, improving startup toast visibility in the app.

## 0.3.3

### Fixed

- **Startup load hang** — Startup toast is now dispatched asynchronously so plugin initialization no longer blocks while TUI toast transport becomes ready.
- **Startup toast reliability** — If the initial startup toast attempt happens before TUI transport is ready, the plugin now retries on runtime events until the toast is shown (with bounded attempts and dedupe).

## 0.3.0

### New

- **Optional milestone notifications** — Added notification plumbing with dedupe guards for `Need your answers`, `Plan is ready`, and `OpenCode has finished` events.
- **Startup toast** — Added an in-app TUI toast on plugin load: `opencode-discipline vX is running`.

### Changed

- **Notification configuration** — Added env-based controls: `OPENCODE_DISCIPLINE_NOTIFY` (`off|metadata|os|both`) and optional `OPENCODE_DISCIPLINE_NOTIFY_COMMAND` template hook.
- **Default behavior** — Notifications now default to `os` mode when `OPENCODE_DISCIPLINE_NOTIFY` is not set.
- **Notification triggers refined** — `Need your answers` is now emitted on actual `question` tool prompts, and `OpenCode has finished` is emitted automatically from `session.idle` for Build sessions (including accepted handoff session IDs).

## 0.2.2

### Fixed

- **Handoff loop after `accept_plan`** — After accepting a plan, the Plan agent would call `advance_wave` repeatedly because no system prompt told it to stop. Now: `advance_wave` rejects post-accept calls with a clear error, a post-accept system prompt tells the agent it's done, and `accept_plan` return messages explicitly say "do NOT call advance_wave."

### Changed

- **Explorer/Librarian role separation** — Librarian is now an external knowledge specialist only. It no longer has `read`, `glob`, or `grep` tools and cannot search the codebase. Explorer is the sole codebase search agent, upgraded to return structured summaries (signatures, exports, key logic) instead of just file paths. Golden rule enforced everywhere: Explorer first, Librarian second.
- **Build reads files on-demand** — When a plan exists with specific file paths, Build reads each file as it works on it instead of pre-gathering everything via subagents.
- **Analyzer no longer delegates to Librarian** — Removed `librarian` from Analyzer's task permissions since it only needs explorers for file discovery.

## 0.2.1

### Fixed

- **Todo checklist gate was too strict** — `hasPlanningTodoChecklist` now matches on wave/step identifiers (`"wave 1"`, `"wave 2"`, etc.) instead of requiring exact hardcoded description substrings. LLMs naturally customize todo descriptions to be contextual, which caused `advance_wave` to reject valid checklists and require 3 retries. Now passes on the first call.

## 0.2.0

### New agents

- **`analyzer`** — Flow and architecture analyzer (`openai/gpt-5.4`, `mode: agent`). Takes file lists from explorers and produces step-by-step explanations of how systems work: control flow, data flow, auth flow, error paths, and component interactions. Can spawn `explore`, `explore-deep`, and `librarian` to gather context. Read-only.

- **`explore-deep`** — Heavy-duty codebase explorer (`openai/gpt-5.2`, `mode: subagent`). Backup for the fast explorer when searches require multi-step reasoning, cross-cutting dependency tracing, or synthesizing patterns across many files. Read-only.

### Changes

- **`explore`** model changed from `openai/gpt-5.2` to `anthropic/claude-haiku-4-5` — faster and cheaper for simple file lookups.
- **`build`** can now spawn `analyzer` and `explore-deep` via task permissions. Prompt updated with delegation guidance for both.
- **`plan`** can now spawn `analyzer` and `explore-deep` via task permissions. Wave 1 instructions updated.
- Agent count: 8 → 11 (including `analyzer`, `explore-deep`).

## 0.1.6

- Fix: add `toolContext.metadata()` calls to render clickable subagent box in TUI.
- Fix: use `promptAsync` for subagent sessions so TUI renders clickable box.
- Feat: render subtasks in TUI using subtask part instead of text.

## 0.1.5

- Model and delegation fixes.

## 0.1.4

- General improvements.

## 0.1.3

- Fix: disable timeout when fallback is disabled.

## 0.1.2

- Chore: align tooling with dependency upgrades.

## 0.1.1

- Fix: support variant overrides in agent config.

## 0.1.0

- Initial release. Eight agents: plan, build, oracle, librarian, reviewer, designer, deep, explore.
- 4-wave planning workflow with accept/revise handoff.
- Plugin auto-injects agent configs via `config` hook.
