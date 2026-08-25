# Repository Atlas: oh-my-opencode-slim

## Project Responsibility

`oh-my-opencode-slim` is an OpenCode plugin that implements a specialist-agent operating model on top of the host runtime. Its core responsibilities include:

- Defining orchestrator and specialist agent factories with permission policies
- Loading layered plugin configuration and per-agent permissions
- Exposing additional tools and MCP integrations
- Managing background job-board orchestration and terminal multiplexer visualization
- Injecting workflow-enforcement hooks plus runtime command handlers
- Shipping install-time skills and a bootstrap CLI

This codemap covers the plugin repository itself and excludes the nested `opencode/` upstream checkout.

## System Entry Points

| Path | Role |
|---|---|
| `package.json` | Package manifest, dependency graph, release scripts, published file list. |
| `src/index.ts` | Main plugin bootstrap: wires agents (incl. dynamic councillors), tools, MCPs, hooks, shared background job board + supervisor, multiplexer session mirroring, interview support, cache monitor, orchestrator-wake scheduler, TUI preset switching, and health checks. Exports the dual `default.server`/`default.setup` so v1 and v2 hosts share one build. |
| `src/cli/index.ts` | CLI entrypoint for installation/bootstrap workflows. |
| `src/config/schema.ts` | Source-of-truth runtime config schema used by validation and schema generation. |
| `src/config/runtime.ts` | Per-directory `RuntimeConfig` singleton: derived getters over the frozen plugin config, pre-mutation host-config snapshot, and preset/model overrides. |
| `scripts/generate-schema.ts` | Generates `oh-my-opencode-slim.schema.json` from the Zod config schema. |

## Repository Directory Map

| Directory | Responsibility Summary | Detailed Map |
|---|---|---|
| `src/` | Main application surface that composes plugin bootstrap, runtime model chains, hook orchestration, task-session aliasing, and installer-facing code. | [View Map](src/codemap.md) |
| `src/agents/` | Agent factory layer for orchestrator and specialists (incl. dynamic `councillor-<name>` agents from council presets), including prompt/model overrides, task-rejection instruction, display-name normalization, MCP assignment, and permission shaping. | [View Map](src/agents/codemap.md) |
| `src/cli/` | Installer, config editing, provider preset generation, and built-in skill installation. | [View Map](src/cli/codemap.md) |
| `src/config/` | Configuration schema, layered loaders, preset merging, compatibility migrations, constant tables, the `RuntimeConfig` runtime-state singleton, and agent/MCP policy helpers. | [View Map](src/config/codemap.md) |

| `src/hooks/` | Aggregated runtime hook surface: prompt transforms, cache-safe injection, recovery logic, task-session aliasing, cache monitoring, orchestrator wake, nudges, and lifecycle policies. | [View Map](src/hooks/codemap.md) |
| `src/hooks/apply-patch/` | Structured `apply_patch` parsing, matching, recovery, and rewrite pipeline. | [View Map](src/hooks/apply-patch/codemap.md) |
| `src/hooks/auto-update-checker/` | Startup update detection, cache handling, and optional install prompt flow. | [View Map](src/hooks/auto-update-checker/codemap.md) |
| `src/hooks/filter-available-skills/` | Skill-visibility filtering based on agent permission policy. | [View Map](src/hooks/filter-available-skills/codemap.md) |
| `src/hooks/foreground-fallback/` | Interactive-session fallback control path for rate-limit or degraded foreground execution with event-driven agent mapping. | [View Map](src/hooks/foreground-fallback/codemap.md) |
| `src/hooks/json-error-recovery/` | JSON/tool-output recovery helpers for malformed model responses. | [View Map](src/hooks/json-error-recovery/codemap.md) |
| `src/hooks/phase-reminder/` | Message-transform reminder enforcing orchestrator workflow phases. | [View Map](src/hooks/phase-reminder/codemap.md) |
| `src/hooks/post-file-tool-nudge/` | Post-read/write reminder path that nudges delegation-aware next steps. | [View Map](src/hooks/post-file-tool-nudge/codemap.md) |
| `src/hooks/task-session-manager/` | Resumable `task` session tracking: job-board injection, short alias resolution, cache-safe prompt injection, idle/stop-confirmation reconciliation, live runtime-status reads, HITL wait gating, and revived-run tracking. | [View Map](src/hooks/task-session-manager/codemap.md) |
| `src/hooks/cache-monitor/` | Observation-only runtime watchdog over provider cache telemetry (`tokens.cache.read/write`) that warns on prompt-cache busts and frozen-prefix plateaus. | [View Map](src/hooks/cache-monitor/codemap.md) |
| `src/hooks/orchestrator-wake/` | Periodic orchestrator wake scheduler: after continuous parent idle, sends a static internal wake prompt when incomplete TODOs remain; process-global one-flight/no-progress gate. | [View Map](src/hooks/orchestrator-wake/codemap.md) |
| `src/hooks/loop-command/` | `/loop` runtime command: extracts goal/successCriteria/maxAttempts and drives an iterative retry loop with a per-run history directory. | [View Map](src/hooks/loop-command/codemap.md) |
| `src/interview/` | `/interview` feature: per-session and dashboard prompt/state orchestration, persistence, local UI, and cross-process coordination. | [View Map](src/interview/codemap.md) |
| `src/mcp/` | Built-in MCP registry and per-provider MCP definitions. | [View Map](src/mcp/codemap.md) |
| `src/multiplexer/` | Terminal multiplexer abstraction layer with backend selection, session mirroring, polling fallback, and shutdown lifecycle orchestration. | [View Map](src/multiplexer/codemap.md) |
| `src/multiplexer/tmux/` | tmux backend implementation for pane lifecycle and layout management. | [View Map](src/multiplexer/tmux/codemap.md) |
| `src/multiplexer/zellij/` | zellij backend implementation for tab/pane lifecycle. | [View Map](src/multiplexer/zellij/codemap.md) |
| `src/multiplexer/herdr/` | herdr backend implementation for pane lifecycle. | [View Map](src/multiplexer/herdr/codemap.md) |
| `src/multiplexer/cmux/` | cmux adapter plus dedicated lifecycle, global state registry, and close policy. | [View Map](src/multiplexer/codemap.md) |
| `src/skills/` | Bundled install-time OpenCode skills shipped as static payloads. | [View Map](src/skills/codemap.md) |
| `src/skills/codemap/` | Repository-mapping skill package and codemap state-management script. | [View Map](src/skills/codemap/codemap.md) |
| `src/skills/clonedeps/` | Workflow-only dependency source mirroring skill that routes discovery/ref resolution through librarian and direct orchestrator git operations. | [View Map](src/skills/clonedeps/codemap.md) |
| `src/skills/simplify/` | Behavior-preserving simplification skill package. | [View Map](src/skills/simplify/codemap.md) |
| `src/tools/` | Tool factory surface for AST-grep, smartfetch, ACP, and task lifecycle controls (cancel/message/status/result/revive/wait-for-user), plus shared task-status policy and activity trackers and on-disk preset-switching helpers. | [View Map](src/tools/codemap.md) |
| `src/tools/ast-grep/` | AST-grep binary management and AST-aware search/replace tool flow. | [View Map](src/tools/ast-grep/codemap.md) |
| `src/tools/smartfetch/` | Fetch/extract/cache pipeline for web content and secondary-model summarization. | [View Map](src/tools/smartfetch/codemap.md) |
| `src/utils/` | Cross-cutting helpers: logging, session metadata, background job board/store/coordinator/supervisor, live session-status reads, in-process opencode client access, task parsing, env, compat/zip, and client call-shape contracts. | [View Map](src/utils/codemap.md) |
| `src/v2/` | OpenCode v2 (`opencode2`) adapter: bridges the v1 plugin factory into v2's promise-plugin transform/runtime-hook API. Loaded via `default.setup`; v1 uses `default.server` unchanged. | [View Map](src/v2/codemap.md) |
| `scripts/` | Build/release validation and generated-artifact maintenance scripts. | [View Map](scripts/codemap.md) |

## Runtime Control Flow

1. **Plugin startup**
   - OpenCode loads `src/index.ts` (v1 via `default.server`; v2 via `default.setup` through `src/v2/`).
   - Config is loaded and normalized through `src/config/`; the `RuntimeConfig` singleton captures the pre-mutation host config.
   - Agent definitions (incl. dynamic councillors) are produced by `src/agents/`.
   - Tool factories from `src/tools/` and MCP definitions from `src/mcp/` are registered.
   - Hooks from `src/hooks/` are attached; the observation-only cache monitor is created before config loads and sees every event.
   - Delegation orchestration, multiplexer session mirroring, interview support, task-session aliasing, orchestrator-wake scheduling, TUI preset switching, and the init health check are initialized.

2. **Interactive request handling**
   - The orchestrator prompt drives routing decisions.
   - Tool calls resolve through `src/tools/` or built-in OpenCode tools.
   - Hooks can transform prompts/messages, normalize system message arrays, repair tool failures, or intercept runtime commands before/after execution.
   - Prompt content is injected only through the cache-safe helpers in `src/hooks/cache-safe-injection.ts` so provider prompt-cache prefixes stay byte-stable.

3. **Delegated execution**
   - Native OpenCode background tasks are parsed from `task` output and tracked in the shared background job board (board + store + coordinator + supervisor in `src/utils/`).
   - `src/hooks/task-session-manager/` updates job-board state, resolves short aliases, and injects background/reusable job context; a delayed runtime-status reconciliation and stop-confirmation grace keep board state honest against live session status.
   - `src/hooks/orchestrator-wake/` periodically nudges an idle parent orchestrator when incomplete TODOs remain and reacts to jobs that stop without a terminal result.
   - `src/multiplexer/` optionally mirrors those sessions into tmux, Zellij, Herdr, cmux, or kitty panes/surfaces (tmux routing resolves the attached parent-session pane registration).
   - Results flow back into the parent session through notifications/output polling.

4. **Install/release path**
   - `src/cli/` configures host OpenCode instances.
   - `src/skills/` is copied into the user skill directory.
   - `scripts/` validates generated schema, package completeness, and host-load behavior.

## Key Cross-Module Integration Points

- `src/index.ts` is the central composition root for nearly every runtime subsystem.
- `src/config/` feeds `src/agents/`, session/delegation utilities, and MCP registration.
- `src/cli/skills.ts` and `src/cli/custom-skills.ts` bridge install-time skill packaging with runtime permission policy.
- Session/delegation utilities depend on `src/multiplexer/` and cooperate with helpers in `src/utils/` for result extraction, task output parsing, and alias state.
- cmux-specific readiness, retry, orphan, and cleanup state lives under
  `src/multiplexer/cmux/`; the generic manager delegates cmux events so other
  multiplexer behavior remains on the upstream path.
- Council mode is implemented in `src/agents/`; `council-agents.ts` builds dynamic `councillor-<name>` subagents from council presets, the orchestrator dispatches them, and the council agent synthesizes responses.
- `src/tools/preset-switch.ts` + `src/tui-preset.ts` implement `/preset` switching: the preset name (or preset edits) is persisted to the user config file and takes effect on the next reload; the agent registry is never hot-swapped mid-session.
- `src/hooks/task-session-manager/` depends on `src/utils/background-job-board.ts`, `background-job-store.ts`, `background-job-coordinator.ts`, `background-job-supervisor.ts`, `session-runtime-status.ts`, and `task.ts`, and injects prompt content only through `src/hooks/cache-safe-injection.ts`.
- `src/hooks/cache-monitor/` watches `message.updated` cache telemetry across all sessions and logs prompt-cache-bust/plateau warnings; it is observation-only and never mutates messages.
- `src/hooks/orchestrator-wake/` reads host todo/children/status APIs, gates on the task-session-manager's `hasInputWait` and continuation-model seams, and shares one-flight/no-progress state via a process-global wake gate.
- `src/v2/` wraps the v1 factory for the v2 host: `setup(ctx)` shims a v1 `PluginInput`, runs the v1 `config()` hook, and adapts agent/tool/command/hook registrations into v2 domains.
- `src/hooks/filter-available-skills/` and agent permission logic rely on shared skill names from the CLI/config layer.
- `src/interview/` hooks into plugin command/event surfaces exposed by `src/index.ts`.

## Root Assets

- `README.md`: user-facing product overview, install docs, and agent descriptions.
- `AGENTS.md`: agent operating conventions for this repository.
- `biome.json`: formatting/lint policy.
- `tsconfig.json`: TypeScript compiler settings.
- `.slim/codemap.json`: codemap change-detection state for this repository.
- `scripts/verify-release-artifact.ts`: release artifact validation script.
- `src/health-check.ts`: plugin init health-check thresholds (`HEALTH_CHECK`) and `minimumExpectedToolCount` (accounts for disabled baseline tools); kept internal — never re-exported from the package root — so the legacy plugin loader cannot mis-invoke helpers as plugin factories (issue #894).
- `src/plugin-entry.ts`: `INSTALLER_MANAGED_PLUGIN_OPTION` marker and `PluginEntry` type for installer-managed config entries.
- `src/tui-preset.ts`: three-level TUI `/preset` manager (preset list → agents → agent edit) using `api.ui` dialogs, persisting via `src/tools/preset-switch.ts`.

## Recommended Reading Order

1. `codemap.md`
2. `src/codemap.md`
3. One of:
   - `src/agents/codemap.md`
   - `src/multiplexer/codemap.md`
   - `src/tools/codemap.md`
   - `src/hooks/codemap.md`
4. Relevant subsystem sub-map for the task at hand
