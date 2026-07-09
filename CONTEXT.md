# CONTEXT.md — Domain Glossary

A glossary of the terms used in this project's domain. Definitions describe what a term means, not how it is implemented.

## Agents

- **Agent** — A named LLM role with a defined lane (permissions, tools, prompt); the unit of work delegation in the system.
- **Orchestrator** — The primary agent. Plans work, delegates to subagents, monitors them, and reconciles their results. One per session; cannot be disabled.
- **Subagent** — A specialist agent the orchestrator delegates bounded work to.
- **Explorer** — Subagent for fast codebase search and pattern matching.
- **Librarian** — Subagent for external documentation and library research.
- **Oracle** — Subagent for architecture, debugging strategy, and code review.
- **Designer** — Subagent for UI/UX design and visual polish.
- **Fixer** — Subagent for bounded implementation and execution.
- **Observer** — Subagent for visual/media analysis (images, PDFs, diagrams). Disabled by default.
- **Council** — A multi-LLM agent that runs several councillors and synthesizes their views.
- **Councillor** — A read-only LLM advisor spawned by the council; hidden from @-mention autocomplete. Cannot be disabled.
- **Agent mode** — SDK classification of an agent: `primary` (orchestrator), `subagent` (specialist), or `all` (council, both user-facing and delegatable).
- **Protected agent** — An agent that cannot be disabled (orchestrator, councillor).
- **Custom agent** — A user-defined agent supplied via config, distinct from the built-ins.
- **ACP agent** — An external agent defined via the Agent Communication Protocol, run through `acp_run`.
- **Display name** — A user-assignable name shown in @-mentions; may differ from the internal agent name.
- **Agent alias** — A legacy or alternate name that maps to a built-in agent. Rejected synonyms: `explore` (use `explorer`), `frontend-ui-ux-engineer` (use `designer`).

## Council

- **Consensus** — The synthesized conclusion of a council run, rated `unanimous`, `majority`, or `split`.
- **Council preset** — A named lineup of councillor configurations used for a council run. Plugin config uses `preset` for the selected agent-override set; council config uses `default_preset` for the selected councillor lineup — the `default_` prefix disambiguates the active selection from the preset list within the council sub-object.
- **Councillor execution mode** — Whether councillors run `parallel` (default) or `serial`.
- **Councillor retries** — The number of retries for a councillor that returns an empty response.

## Multiplexer & Sessions

- **Multiplexer** — A terminal backend (tmux, zellij, or herdr) that hosts child agent panes. Set via \`multiplexer.type\`, which also accepts \`auto\` (auto-detect) and \`none\` (disabled).
- **Multiplexer type** — The selected backend: `auto`, `tmux`, `zellij`, `herdr`, or `none`.
- **Pane** — A terminal region spawned by the multiplexer to run a child agent session.
- **Child session** — A background agent session hosted in a multiplexer pane and tracked by the session manager.
- **Session manager** — Tracks child sessions, spawns and closes multiplexer panes, and reacts to session lifecycle events. Note: `TmuxSessionManager` is a deprecated alias — use `MultiplexerSessionManager`.
- **Close reason** — Why a pane is closed: `idle` or `deleted`.

## Background Jobs

- **Background job** — A delegated specialist task that runs asynchronously; tracked until its result is reconciled into the orchestrator's response.
- **Background Job Board** — The store of background job state and metadata.
- **Background Job Coordinator** — The layer that owns background-job lifecycle policy and deferred-close state, writing through the board.
- **Job state** — A background job's status: `running`, `completed`, `error`, `cancelled`, or `reconciled`. `reconciled` is a distinct post-consumption phase marking that a terminal job's result has been folded into the orchestrator's response; it is not a terminal outcome itself.
- **Job alias** — A short human-readable identifier for a background job (e.g., `fix-1`, `exp-2`).
- **Terminal state** — A job state from which no further transition occurs (`completed`, `error`, `cancelled`).

## Skills

- **Skill** — A bundled, self-contained workflow or capability shipped with the plugin. Bundled skills: codemap, clonedeps, simplify, deepwork, reflect, worktrees, oh-my-opencode-slim, release-smoke-test. Note: `loop-engineering` exists on disk but is not registered as a bundled skill.

## Hooks

- **Hook** — A plugin extension point that reacts to OpenCode lifecycle events (e.g., apply-patch, filter-available-skills, loop-command, session-lifecycle).

## Loop

- **Loop** — An auto-iterative run that executes work with an agent, verifies it against success criteria, and repeats until done or escalated.
- **Loop session** — The state of one loop run (goal, current phase, attempts, history).
- **Loop phase** — A stage of a loop: `executing`, `verifying`, `done`, `escalated`, or `cancelled`.
- **Execute agent** — The agent that performs loop work (`fixer`, `designer`, `explorer`, or `librarian`).
- **Verify agent** — The agent or strategy that verifies loop output (`oracle`, `observer`, or `test`).
- **Success criterion** — A check that decides whether a loop iteration passed (test, build, lint, fileExists, command, oracle, observer, or manual).

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
- **Variant** — An optional model qualifier (e.g., a preview build) used in fallback resolution.
- **Fallback / failover** — The mechanism that switches models when a call is rate-limited or returns empty.
- **Disabled agents** — Agents turned off via config; `observer` is disabled by default.

## Flagged

Terms with genuine but non-blocking collisions or historical drift. Noted for awareness; no change required:

- **"Presets" means two things** — A plugin *preset* is a set of agent overrides; a council *preset* is a lineup of councillor models. Same word, different JSON paths and types; no structural conflict, but easy to confuse.
- **Config naming convention** — Config keys mix snake_case (`disabled_agents`, `main_pane_size`) with camelCase (`autoUpdate`, `backgroundJobs`) with no documented rule. Historical drift; `disabled_*` keys are uniformly snake_case while the rest is mixed even within sub-objects.
