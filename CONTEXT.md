# CONTEXT.md — Domain Glossary

A glossary of the terms used in this project's domain. Definitions describe what a term means, not how it is implemented.

## Agents

Core agent roles and classifications:

The agent system defines the fundamental building blocks for AI-powered work delegation. Each agent type serves a specific purpose in the orchestration ecosystem. Agents are the unit of work — the orchestrator delegates bounded tasks to specialists rather than doing everything itself, which keeps prompts short and costs predictable.

**When to use which agent:** Explorer for codebase search, Librarian for external docs, Oracle for architecture/review, Designer for UI/UX, Fixer for implementation, Observer for visual analysis.

**Core agent types:**

- **Agent** — A named LLM role with a defined lane (permissions, tools, prompt); the unit of work delegation in the system.
- **Orchestrator** — The primary agent. Plans work, delegates to subagents, monitors them, and reconciles their results. One per session; cannot be disabled.
- **Subagent** — A specialist agent the orchestrator delegates bounded work to.

**Specialist subagents:**

- **Explorer** — Subagent for fast codebase search and pattern matching.
- **Librarian** — Subagent for external documentation and library research.
- **Oracle** — Subagent for architecture, debugging strategy, and code review.
- **Designer** — Subagent for UI/UX design and visual polish.
- **Fixer** — Subagent for bounded implementation and execution.
- **Observer** — Subagent for visual/media analysis (images, PDFs, diagrams). Disabled by default because it requires a vision-capable model and adds cost; enable it with `"disabled_agents": []` when working with screenshots or diagrams.

**Multi-LLM systems:**

- **Council** — A multi-LLM agent that runs several councillors and synthesizes their views.
- **Councillor** — A read-only LLM advisor dispatched as a subagent by the orchestrator. Each councillor is registered as `councillor-<name>` from the council preset. Not hidden; visible in the TUI as panes.

**Agent classification and configuration:**

- **Agent mode** — SDK classification of an agent: `primary` (orchestrator), `subagent` (specialist), or `all` (council, both user-facing and delegatable).
- **Protected agent** — An agent that cannot be disabled (orchestrator).
- **Custom agent** — A user-defined agent supplied via config, distinct from the built-ins.

**Naming and identification:**

- **Display name** — A user-assignable name shown in @-mentions; may differ from the internal agent name.
- **Agent alias** — A legacy or alternate name that maps to a built-in agent. Rejected synonyms: `explore` (use `explorer`), `frontend-ui-ux-engineer` (use `designer`).
- **Agent permission** — A per-agent `permission` field that sets deterministic, tool-level rules (`ask` / `allow` / `deny`, with pattern support) enforced by the OpenCode SDK. Distinct from prompt instructions, which the model can ignore.

## Council

Council-specific concepts:

The council system enables multi-LLM consensus and collaborative decision-making. Use council when a single model's judgment is insufficient — architectural decisions, code review, or any question where multiple perspectives reduce risk. Each councillor runs as an independent subagent; the orchestrator synthesizes their responses into a consensus rating.

**When to use:** High-stakes decisions, conflicting requirements, or when you need a second opinion on architecture/code. **When not to use:** Simple tasks that a single specialist can handle — council adds latency and cost.

- **Consensus** — The synthesized conclusion of a council run, rated `unanimous`, `majority`, or `split`.
- **Council preset** — A named lineup of councillor configurations used for a council run. Plugin config uses `preset` for the selected agent-override set; council config uses `default_preset` for the selected councillor lineup — the `default_` prefix disambiguates the active selection from the preset list within the council sub-object.
- **Council timeouts / execution mode / retries** — No longer config keys. Per-councillor timeout, serial-vs-parallel execution, and empty-response retries are now handled by the orchestrator's council-mode prompt instructions (see `src/agents/council.ts`).

## Multiplexer & Sessions

Terminal and session management:

The multiplexer system manages terminal backends and agent session lifecycle. When enabled, each child agent gets its own terminal pane so you can see and interact with running work in real time. Disabled by default (`multiplexer.type: "none"`) — enable it when you want visibility into parallel work.

**When to use:** Multi-agent work where you want to watch specialists run side-by-side. **When to leave off:** Single-threaded workflows or headless environments. See [Configuration Reference — Multiplexer](docs/configuration.md#multiplexer) for setup.

- **Multiplexer** — A terminal backend (tmux, zellij, herdr, cmux, or kitty) that hosts child agent panes. Set via `multiplexer.type`, which also accepts `auto` (auto-detect) and `none` (disabled).
- **Multiplexer type** — The selected backend: `auto`, `tmux`, `zellij`, `herdr`, `cmux`, `kitty`, or `none`.
- **Pane** — A terminal region spawned by the multiplexer to run a child agent session.
- **Child session** — A background agent session hosted in a multiplexer pane and tracked by the session manager.
- **Session manager** — Tracks child sessions, spawns and closes multiplexer panes, and reacts to session lifecycle events. Note: `TmuxSessionManager` is a deprecated alias — use `MultiplexerSessionManager`.
- **Close reason** — Why a pane is closed: `idle` or `deleted`. The cmux backend adds a third value: `cleanup`.

## Background Jobs

Asynchronous job lifecycle management:

The background job system tracks and manages delegated specialist tasks. Every subagent launch creates a job; the orchestrator references the job board when planning follow-up work. For full configuration options, see [Configuration Reference — Background Job Management](docs/configuration.md#background-job-management) and [Background Orchestration](docs/background-orchestration.md).

**Why this exists:** Without the board, the orchestrator would lose track of parallel work and re-delegate already-running tasks. The board is the single source of truth for "what's running."

- **Background job** — A delegated specialist task that runs asynchronously; tracked until its result is reconciled into the orchestrator's response.
- **Background Job Board** — The store of background job state and metadata.
- **Background Job Coordinator** — The layer that owns background-job lifecycle policy and deferred-close state, writing through the board.
- **Background Job Store** — Interface (`src/utils/background-job-store.ts`) that both `BackgroundJobBoard` and `BackgroundJobCoordinator` implement.
- **Job state** — A background job's status: `running`, `completed`, `error`, `cancelled`, or `reconciled`. `reconciled` is a distinct post-consumption phase marking that a terminal job's result has been folded into the orchestrator's response; it is not a terminal outcome itself.
- **Job alias** — A short human-readable identifier for a background job (e.g., `fix-1`, `exp-2`).
- **Terminal state** — A job state from which no further transition occurs (`completed`, `error`, `cancelled`).
- **Board snapshot** — A formatted rendering of the Background Job Board injected into the orchestrator's prompt. Retention is bounded by `backgroundJobs.maxRetainedSnapshots` per checkpoint cache epoch.
- **Checkpoint cache epoch** — A span of turns during which the same set of board snapshots is reused for prompt-cache hits. Adding a snapshot beyond the retention limit starts a new epoch with only the current snapshot, intentionally causing one cache miss.
- **Board injection strategy** — How the board is written into the prompt: `latest` (strip-and-replace every turn) or `checkpoint-compatible` (append only when the formatted board changes, retaining snapshots per epoch to preserve cache hits).
- **Incomplete-todo continuation nudge** — A beta opt-in (`backgroundJobs.continueOnIdle`) that lets idle orchestrator sessions with incomplete todos receive one automatic hidden continuation prompt. Off by default.

## Skills

Plugin capabilities and workflows:

The skills system provides bundled, self-contained workflows and capabilities for the plugin. Skills are invoked by the orchestrator when it detects a matching task pattern — they encode best practices for specific work types so the model doesn't reinvent the approach each time.

**When to use:** Invoke a skill when starting work that matches its pattern (e.g., `/codemap` for new repo exploration, `/verification-planning` before non-trivial implementation).

- **Skill** — A bundled, self-contained workflow or capability shipped with the plugin. Bundled skills: codemap, clonedeps, simplify, deepwork, reflect, worktrees, oh-my-opencode-slim, verification-planning. Note: `loop-engineering` exists on disk but is not registered as a bundled skill.
- **Verification-planning** — An orchestrator-only skill for designing project-specific evidence paths before non-trivial implementation.

## Hooks

OpenCode lifecycle extension points:

The hooks system provides extension points for OpenCode lifecycle events.

- **Hook** — A plugin extension point that reacts to OpenCode lifecycle events (e.g., apply-patch, filter-available-skills, loop-command, session-lifecycle).

## Companion

Desktop visual companion:

The companion provides a visual status overlay showing running and active agents.

- **Companion** — A native desktop mascot that reflects agent activity; launched and tracked by the companion manager.

## Cache Safety

Prompt cache infrastructure and safety:

The cache safety system ensures prompt cache hits and LLM cost optimization. Provider prompt caches are exact byte-prefix matches — any earlier change invalidates the entire suffix. Cache safety enforces stable byte prefixes so repeated orchestrator turns reuse the same cached prompt. See `AGENTS.md` "Prompt Cache Safety" for rules.

**Why this matters:** Without cache hits, every orchestrator turn re-pays the full prefix cost. A 50K-token prefix at $3/M tokens, hit once per turn vs always full, saves ~$0.15/turn at scale.

- **Cache safety** / **prompt cache safety** — Major concept with extensive infrastructure: `cache-safe-injection.ts` for deterministic content injection, `cache-monitor/` for runtime watchdog, `cache-safety.property.test.ts` for prefix-stability properties, `cache-payload.snapshot.test.ts` for golden snapshots, `cache-safety-tripwire.test.ts` for volatile-input pattern bans, and AGENTS.md "Prompt Cache Safety" section. Critical for provider prompt cache hits and LLM cost optimization.

## ACP

Agent Communication Protocol integration:

The ACP system enables external Agent Client Protocol servers as optional OpenCode subagents. Each ACP agent is wrapped in a lightweight local subagent that calls `acp_run`; the external process runs the actual work. See [ACP Agents](docs/acp-agents.md) for setup.

**When to use:** Connecting to external agent CLIs (Claude Code, Gemini, etc.) that speak ACP. **When not to use:** If the work can be done by a built-in specialist — ACP adds subprocess overhead.

- **ACP agent** — An external agent defined via the Agent Communication Protocol, run through `acp_run`.
- **ACP wrapper agent** — Lightweight local subagent that calls `acp_run` on behalf of the external ACP process. Distinct from the ACP agent itself — the wrapper handles protocol execution while the external agent provides the actual functionality.

## Multiplexer

Advanced multiplexer backend details:

The cmux multiplexer provides advanced session handling with configurable timeouts and cleanup policies.

- **cmux** — Multiplexer backend with idle-session lifecycle management, grace periods, and its own close-reason variant (`cleanup`). Supports advanced session handling with configurable timeouts and cleanup policies.

## Loop

Auto-iterative execution and verification:

The loop system enables auto-iterative work execution with verification. A loop runs an execute agent, verifies output against success criteria, and repeats until done or escalated. Use it for tasks that have a clear pass/fail check (tests, builds, lint).

**When to use:** Well-defined tasks with objective success criteria (fix a failing test, implement a function with tests). **When not to use:** Open-ended work where "done" is subjective — loops will thrash without a clear signal.

- **Loop** — An auto-iterative run that executes work with an agent, verifies it against success criteria, and repeats until done or escalated.
- **Loop session** — The state of one loop run (goal, current phase, attempts, history).
- **Loop phase** — A stage of a loop: `executing`, `verifying`, `done`, `escalated`, or `cancelled`.
- **Execute agent** — The agent that performs loop work (`fixer`, `designer`, `explorer`, or `librarian`).
- **Verify agent** — The agent or strategy that verifies loop output (`oracle`, `observer`, or `test`).
- **Success criterion** — A check that decides whether a loop iteration passed (test, build, lint, fileExists, command, oracle, observer, or manual).

## Interview

Specification document generation:

The interview system builds persistent specification documents from ideas through question/answer flows. The orchestrator asks structured questions, you answer, and the result is a persistent spec file. See [Interview](docs/interview.md) for the full workflow.

**When to use:** Starting a new project, designing a feature, or capturing requirements before implementation. **When not to use:** Trivial changes or well-defined tasks that don't need upfront design.

- **Interview** — A question/answer flow that builds a persistent specification document from an idea.
- **Spec block** — A named section within a generated specification document.
- **Interview dashboard** — The web UI for managing an interview and entering answers.

## Config

Configuration concepts and terminology:

The configuration system provides user-facing configuration for the plugin. For the complete configuration reference with all options, defaults, and examples, see [Configuration Reference](docs/configuration.md). Most users only need `preset`, `presets.<name>.<agent>.model`, and maybe `disabled_agents` — the rest is for advanced tuning.

**Layering order:** `~/.config/opencode/oh-my-opencode-slim.jsonc` is the user base; `.opencode/oh-my-opencode-slim.json` (project-local) overrides user config; CLI flags and runtime `/model` commands override config entirely. See [Project-local Customization](docs/project-local-customization.md) for precedence details.

- **Plugin config** — The user-facing configuration loaded from `oh-my-opencode-slim.jsonc`.
- **Preset** — A named set of per-agent overrides. The same word also names council councillor lineups (see Flagged).
- **Model entry** — A normalized model reference with an optional variant, used in fallback chains.
- **Variant** — An optional per-agent model qualifier that sets reasoning effort. Common values are `"low"`, `"medium"`, `"high"`, and `"max"` (provider-specific). Applied via `presets.<name>.<agent>.variant` or `council.presets.<name>.<councillor>.variant`. The string is unvalidated — any value is accepted, but the documented values are the expected ones.
- **Fallback / failover** — The mechanism that switches models when a call is rate-limited or returns empty.
- **Fallback max retries** — `fallback.maxRetries`: maximum failover attempts before giving up (default `3`).
- **Runtime override** — `fallback.runtimeOverride`: deprecated, accepted for backward compatibility but no longer affects runtime behavior. Fallback is now always disabled when a user explicitly selects a model via `/model`.
- **Strip orchestrator model** — `stripOrchestratorModel`: opt-in that preserves a runtime `/model` selection for the orchestrator after subagent dispatch by omitting its configured model from the SDK config. Exception: if the active preset defines `orchestrator.model`, stripping is skipped and the preset's model is used.
- **Image routing** — `image_routing`: optional top-level setting (`"auto"` or `"direct"`). When omitted, images are intercepted only when Observer is enabled; `"auto"` requires Observer and saves attachments to disk before nudging delegation; `"direct"` always passes images to the orchestrator.
- **Disabled agents** — Agents turned off globally via the `disabled_agents` config array; `observer` is disabled by default. This is global, not per-preset.

## Flagged

Known terminology collisions and historical drift:

These terms have genuine but non-blocking collisions or historical drift. Noted for awareness; no change required:

- **"Presets" means two things** — A plugin *preset* is a set of agent overrides; a council *preset* is a lineup of councillor models. Same word, different JSON paths and types; no structural conflict, but easy to confuse.
- **Config naming convention** — Config keys mix snake_case (`disabled_agents`, `main_pane_size`) with camelCase (`autoUpdate`, `backgroundJobs`) with no documented rule. Historical drift; `disabled_*` keys are uniformly snake_case while the rest is mixed even within sub-objects.
- **`council.master*` fields removed** — Legacy `council.master*` keys were removed; a deprecation warning is logged this release only if a config contains the exact `council.master` key. Other `master_*` variants (e.g., `council.master_timeout`, `council.master_fallback`) are silently dropped without warning. Do not use them in new configs.
- **Agent alias vs Display name** — Legacy agent aliases (`explore` → `explorer`, `frontend-ui-ux-engineer` → `designer`) provide backward compatibility at the code level, while `displayName` offers user-facing aliases (`advisor` → `oracle`). Both concepts coexist but serve different purposes.
- **Closed vs close reason terminology** — Internal `CloseReason` enum uses `idle`/`deleted`/`cleanup` (cmux), while users see simplified "idle"/"deleted" in logs. The cmux-specific `cleanup` reason is invisible to end users.
