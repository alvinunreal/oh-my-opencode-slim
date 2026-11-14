# GLOSSARY.md — Domain Glossary

A glossary of the terms used in this project's domain. Definitions describe what a term means, not how it is implemented.

## Agents

- **Agent** — A named LLM role with a defined lane (permissions, tools, prompt); the unit of work delegation in the system.
- **Orchestrator** — The canonical primary agent. Plans work, delegates to subagents, monitors them, and reconciles their results. One per session; cannot be disabled.
- **Primary agent** — An agent with SDK mode `primary` that can run a foreground session. Slim registers the built-in orchestrator in this mode.
- **Subagent** — A specialist agent a primary agent delegates bounded work to.
- **Delegation scope** — The orchestrator's `agents.orchestrator.subagents` allowlist: the specialists it may delegate to, compiled into the `task` permission stance and rendered as its scoped `<Agents>` catalog.
- **Explorer** — Subagent for fast codebase search, pattern matching, and external documentation/library research.
- **Oracle** — Subagent for architecture, debugging strategy, and code review.
- **Designer** — Subagent for UI/UX design and visual polish.
- **Fixer** — Subagent for bounded implementation and execution.
- **Observer** — Subagent for visual/media analysis (images, PDFs, diagrams). Disabled by default.
- **Council** — A multi-LLM agent that runs several councillors and synthesizes their views.
- **Councillor** — A read-only LLM advisor dispatched as a subagent by the orchestrator. Each councillor is registered as `councillor-<name>` from the council preset. Hidden from the @-mention menu; visible as panes when dispatched.
- **Agent mode** — SDK classification of an agent: `primary` (the built-in orchestrator in Slim) or `subagent` (specialist, including council — the synthesizer is dispatched by the orchestrator, never switched to as a primary).
- **Protected agent** — An agent that cannot be disabled (orchestrator).
- **Custom agent** — A user-defined agent supplied via config, distinct from the built-ins.
- **ACP agent** — An external agent defined via the Agent Communication Protocol, run through `acp_run`.
- **Display name** — A user-assignable name shown in @-mentions; may differ from the internal agent name.
- **Agent alias** — A legacy or alternate name that maps to a built-in agent. Rejected synonyms: `explore` (use `explorer`), `frontend-ui-ux-engineer` (use `designer`).

## Council

- **Consensus** — The synthesized conclusion of a council run, rated `unanimous`, `majority`, or `split`.
- **Council preset** — A named lineup of councillor configurations used for a council run. Plugin config uses `preset` for the selected agent-override set; council config uses `default_preset` for the selected councillor lineup — the `default_` prefix disambiguates the active selection from the preset list within the council sub-object.

## Multiplexer & Sessions

- **Multiplexer** — A terminal backend (tmux, zellij, herdr, kitty, wezterm, orca, or cmux) that hosts child agent panes. Set via \`multiplexer.type\`, which also accepts \`auto\` (auto-detect) and \`none\` (disabled).
- **Multiplexer type** — The selected backend: `auto`, `tmux`, `zellij`, `herdr`, `kitty`, `wezterm`, `orca`, `cmux`, or `none`.
- **Pane** — A terminal region spawned by the multiplexer to run a child agent session.
- **Child session** — A delegated agent session that may be displayed in a multiplexer pane. V1 managed tracks it on the background job board; V2 leaves its execution and recovery to the host Job lifecycle.
- **Client pane lifecycle** — The TUI client's in-process pane tracking: admits child sessions of the displayed parent, spawns and closes multiplexer panes anchored to the client's own pane, and reacts to session lifecycle events. There is no server-side or cross-process pane state.
- **Close reason** — Why a pane is closed: `idle`, `deleted`, or `backfill-gone`.

## Background Jobs

- **Background job** — A delegated specialist task that runs asynchronously. V1 managed tracks it on the plugin board until its result is reconciled; on V2 the host Job owns execution, notification, and recovery.
- **Native lifecycle (V2)** — OpenCode owns the child Job, same-session continuation, completion delivery, and restart recovery. The plugin keeps only exact-ID controls (`task_status`, `task_cancel`, permission-only `task_reply`, queue-only `task_report`) and reads host sessions on demand.
- **Background Job Board (V1 managed)** — The store of background job state and metadata. It is machine-side only: it is never rendered into a prompt.
- **Background Job Coordinator (V1 managed)** — The layer that owns background-job lifecycle policy and deferred-close state, writing through the board.
- **Job state (V1 managed)** — A background job's status: `running`, `completed`, `error`, `cancelled`, or `reconciled`. `reconciled` is a distinct post-consumption phase marking that a terminal job's result has been folded into the delegating primary's response; it is not a terminal outcome itself.
- **Job alias (V1 managed)** — A short human-readable identifier for a background job (e.g., `fix-1`, `exp-2`). V2 uses exact session IDs only.
- **Terminal state** — A job state from which no further transition occurs (`completed`, `error`, `cancelled`).

## Skills

- **Skill** — A bundled, self-contained workflow or capability shipped with the plugin. Bundled skills: codemap, clonedeps, simplify, deepwork, reflect, worktrees, oh-my-opencode-slim.

## Hooks

- **Hook** — A plugin extension point that reacts to OpenCode lifecycle events (e.g., apply-patch, deepwork, session-lifecycle).

## Interview

- **Interview** — A question/answer flow that builds a persistent specification document from an idea.
- **Spec block** — A named section within a generated specification document.
- **Interview dashboard** — The web UI for managing an interview and entering answers.

## Companion

- **Companion** — A native desktop mascot that reflects agent activity; launched and tracked by the companion manager.

## Config

- **Plugin config** — The user-facing configuration loaded from `oh-my-opencode-slim.jsonc`.
- **Preset** — A named set of per-agent overrides. The same word also names council councillor lineups (see Flagged).
- **Model entry** — A normalized model reference with an optional variant, used in fallback chains.
- **Model inheritance** — An explicit agent policy selecting the current `session` model or the configured `orchestrator` model when no agent model is set.
- **Variant** — An optional model qualifier (e.g., a preview build) used in fallback resolution.
- **Fallback / failover** — The mechanism that switches models when a call is rate-limited or returns empty.
- **Disabled agents** — Agents turned off via config; `observer` is disabled by default.
- **Disabled hooks / commands** — Config keys that disable hooks or slash commands entirely: `disabled_hooks` (`phase-reminder`, `foreground-fallback`, `chat-headers`, `cache-monitor`, `json-error-recovery`, `tool-loop-guard`, `search-path-guard`, `absolute-path-rescue`, `apply-patch`, `council-inject`) and `disabled_commands` (`interview`, `deepwork`, `reflect`).

## Quality toolchain

- **knip** — The dead-code auditor. Scans the import graph for unused exports, types, files, and dependencies; configured in `knip.jsonc`. A deliberate export that the import graph cannot see carries an inline `@public knip:` tag with its reason.
- **knip liveness** — The knip rules that catch code which exists but is never reached: platform binaries, root-relative spawn targets, and dynamic-import/namespace consumers declared in `knip.jsonc`; dynamic-use symbols carry `@public` keep-tags.
- **knip strict gate** — knip run with `--max-issues=0` as a blocking CI check. Master's knip job is report-only (non-blocking) today; flipping it strict requires clearing all findings on master first, by deleting dead code rather than adding ignores.
- **Strict flip** — The transition of a report-only CI job to a blocking gate, done only after the findings that would fail it are cleared on master.
- **knip leftovers** — Findings remaining after a knip slice: unused exports/types/duplicates left by an earlier cleanup pass, tracked in the knip epic's tickets.
- **Fallow** — An analysis tool (external, Rust) watching the three code-health categories knip and Biome do not cover: import cycles, duplication, and complexity. Configured in `.fallowrc.json`; excludes `.slim/` and the mutation toolchain.
- **Fallow audit** — Fallow's per-file report over those categories. Proposed for CI as a report-only job (non-blocking), mirroring knip's pre-strict shape; not yet on master.
- **Fallow dead-code rules** — The intended division of labor: knip owns dead-code detection, so Biome's dead-code rules stay off and fallow covers only what knip cannot see (cycles, duplication, complexity).
- **CRAP score** — A risk metric combining a function's complexity with its test coverage; untested complex functions score worst. The fallow follow-up that feeds real coverage data into the score.
- **Mutation gate** — The required CI check that runs the scoped Stryker sweep and fails when the score drops below the configured floor or a configured target produces no mutants. It does not read the survivor ledger or compare survivors between runs; a previously killed mutant can survive while the gate stays green.
- **Mutation (survivor) ledger** — The hand-maintained table in `docs/mutation-testing.md` listing the equivalent mutants that are allowed to survive, with the line range and the test that proves they are equivalent. Rows are snapshots from a sweep's report and are reconciled by hand when the code moves; gate verification of ledger rows is proposed, not current behavior.
- **Foreground-fallback (mutation target)** — The scoped Stryker sweep target: the retry-deduplication and wake/fallback control path in the foreground-fallback hook. "Mutation gate" and "survivor ledger" always refer to this target, not the whole repo.
- **Sibling-only kill** — A mutant killed only because a test reached it via a sibling that happened to fail, not because the test constrains the mutated code itself. The reason a killed count alone proves nothing; killedBy attribution is the evidence.

## Session hygiene

- **Lane** — An isolated coding workspace for one issue or fix: a git worktree under `.slim/worktrees/` with its own branch, tracked in `.slim/worktrees.json` with slug, branch, path, base commit, owner, status, and purpose. Distinct from an agent *lane* (flagged below).
- **Lane registration** — The manifest entry tracking a lane's slug, branch, path, base, owner, status, and purpose in `.slim/worktrees.json`. Registration is bookkeeping, not discovery: an unregistered worktree is still visible via `git worktree list`; the manifest is what orchestration reads.
- **Watcher** — A background monitor a session arms on a remote outcome (CI checks, bot reviews on a PR) so the session can idle and resume when it settles. Re-arming after a timeout is the failure mode the watcher fixes, not the timeout itself.
- **Idle outcome** — How a session ended, as recorded by the harness: `succeeded` (turn finished), `interrupted` (cut off), or `failed`.
- **Maintainer merge bar** — The five blocking review criteria a change must meet before merge: proof (reproduces the real failure end to end), reuse (extends the existing mechanism rather than a parallel one), reversible (validated before destructive steps), bounded (repeated events cannot rescan unbounded history), no paper-over (a timeout that restores availability without the guarantee still fails). Stated in AGENTS.md; sourced from review rejections on earlier PRs.

## Flagged

Terms with genuine but non-blocking collisions or historical drift. Noted for awareness; no change required:

- **"Presets" means two things** — A plugin *preset* is a set of agent overrides; a council *preset* is a lineup of councillor models. Same word, different JSON paths and types; no structural conflict, but easy to confuse.
- **Config naming convention** — Config keys mix snake_case (`disabled_agents`, `main_pane_size`) with camelCase (`autoUpdate`, `backgroundJobs`) with no documented rule. Historical drift; `disabled_*` keys are uniformly snake_case while the rest is mixed even within sub-objects.
- **"Lane" means two things** — An agent *lane* is its permission/tool/prompt scope; a worktree *lane* (worktrees skill, `.slim/worktrees.json`) is an isolated coding workspace. Different surfaces, both live.
- **"Contract" is overloaded** — Three live senses: plugin API contracts (host interfaces), the dependency contract (import-boundary invariants enforced by tests), and `.contract.ts` registry files (module lists referenced by path string). No structural conflict; easy to confuse.
- **"Gate" means several things** — Mutation gate (required Stryker check), knip strict gate (blocking dead-code check), wake gate (the foreground-fallback hook's bound on in-flight wake evaluations), admission gate (multiplexer/child admission control), terminal gate (the v2 notification guard). All are real, distinct mechanisms; always name which one.
- **"Foreground-fallback" means two things** — The hook (rate-limit/degraded-model fallback control path) and the mutation target scoped to that hook's code. Context disambiguates: CI gate vs disabled_hooks key.
