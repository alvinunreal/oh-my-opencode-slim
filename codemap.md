# Repository Atlas: oh-my-opencode-slim

## Project Responsibility

`oh-my-opencode-slim` is an OpenCode plugin that adds a specialist-agent operating model on top of the host runtime. Its core job is to:

- define orchestrator and specialist agents,
- load layered plugin configuration and per-agent permissions,
- expose additional tools and MCP integrations,
- manage delegated/background work and terminal multiplexer visualization,
- inject workflow-enforcement hooks,
- ship install-time skills and a bootstrap CLI.

This codemap intentionally covers the plugin repository itself and excludes the nested `opencode/` upstream checkout.

## System Entry Points

| Path | Role |
|---|---|
| `package.json` | Package manifest, dependency graph, release scripts, published file list. |
| `src/index.ts` | Main plugin bootstrap: wires agents, tools, MCPs, hooks, background managers, interview manager, and config merge behavior. |
| `src/cli/index.ts` | CLI entrypoint for installation/bootstrap workflows. |
| `src/config/schema.ts` | Source-of-truth runtime config schema used by validation and schema generation. |
| `scripts/generate-schema.ts` | Generates `oh-my-opencode-slim.schema.json` from the Zod config schema. |

## Repository Directory Map

| Directory | Responsibility Summary | Detailed Map |
|---|---|---|
| `src/` | Main application surface that composes plugin bootstrap, runtime modules, and installer-facing code. | [View Map](src/codemap.md) |
| `src/agents/` | Agent factory layer for orchestrator, specialists, council agents, and config/permission shaping. | [View Map](src/agents/codemap.md) |
| `src/cli/` | Installer, config editing, provider preset generation, and built-in skill installation. | [View Map](src/cli/codemap.md) |
| `src/config/` | Configuration schema, defaults, loaders, constant tables, and agent/MCP policy helpers. | [View Map](src/config/codemap.md) |
| `src/council/` | Multi-model council orchestration and synthesis fallback flow. | [View Map](src/council/codemap.md) |
| `src/hooks/` | Aggregated runtime hook surface for prompt transforms, recovery logic, nudges, and lifecycle policies. | [View Map](src/hooks/codemap.md) |
| `src/hooks/apply-patch/` | Structured `apply_patch` parsing, matching, recovery, and rewrite pipeline. | [View Map](src/hooks/apply-patch/codemap.md) |
| `src/hooks/auto-update-checker/` | Startup update detection, cache handling, and optional install prompt flow. | [View Map](src/hooks/auto-update-checker/codemap.md) |
| `src/hooks/delegate-task-retry/` | Post-tool retry guidance for failed delegation attempts. | [View Map](src/hooks/delegate-task-retry/codemap.md) |
| `src/hooks/filter-available-skills/` | Skill-visibility filtering based on agent permission policy. | [View Map](src/hooks/filter-available-skills/codemap.md) |
| `src/hooks/foreground-fallback/` | Interactive-session fallback control path for rate-limit or degraded foreground execution. | [View Map](src/hooks/foreground-fallback/codemap.md) |
| `src/hooks/json-error-recovery/` | JSON/tool-output recovery helpers for malformed model responses. | [View Map](src/hooks/json-error-recovery/codemap.md) |
| `src/hooks/phase-reminder/` | Message-transform reminder enforcing orchestrator workflow phases. | [View Map](src/hooks/phase-reminder/codemap.md) |
| `src/hooks/post-file-tool-nudge/` | Post-read/write reminder path that nudges delegation-aware next steps. | [View Map](src/hooks/post-file-tool-nudge/codemap.md) |
| `src/hooks/todo-continuation/` | Auto-continue behavior for outstanding todo execution. | [View Map](src/hooks/todo-continuation/codemap.md) |
| `src/interview/` | `/interview` feature: prompt/state orchestration, persistence, local UI, and dashboard mode. | [View Map](src/interview/codemap.md) |
| `src/mcp/` | Built-in MCP registry and per-provider MCP definitions. | [View Map](src/mcp/codemap.md) |
| `src/multiplexer/` | Terminal multiplexer abstraction layer with backend selection and health helpers. | [View Map](src/multiplexer/codemap.md) |
| `src/multiplexer/tmux/` | tmux backend implementation for pane lifecycle and layout management. | [View Map](src/multiplexer/tmux/codemap.md) |
| `src/multiplexer/zellij/` | zellij backend implementation for tab/pane lifecycle. | [View Map](src/multiplexer/zellij/codemap.md) |
| `src/skills/` | Bundled install-time OpenCode skills shipped as static payloads. | [View Map](src/skills/codemap.md) |
| `src/skills/codemap/` | Repository-mapping skill package and codemap state-management script. | [View Map](src/skills/codemap/codemap.md) |
| `src/skills/simplify/` | Behavior-preserving simplification skill package. | [View Map](src/skills/simplify/codemap.md) |
| `src/tools/` | Tool export surface and orchestration helpers for AST-grep, smartfetch, council, and background tools. | [View Map](src/tools/codemap.md) |
| `src/tools/ast-grep/` | AST-grep binary management and AST-aware search/replace tool flow. | [View Map](src/tools/ast-grep/codemap.md) |
| `src/tools/smartfetch/` | Fetch/extract/cache pipeline for web content and secondary-model summarization. | [View Map](src/tools/smartfetch/codemap.md) |
| `src/utils/` | Cross-cutting helpers for logging, sessions, compatibility, zip extraction, and runtime metadata. | [View Map](src/utils/codemap.md) |
| `scripts/` | Build/release validation and generated-artifact maintenance scripts. | [View Map](scripts/codemap.md) |

## Runtime Control Flow

1. **Plugin startup**
   - OpenCode loads `src/index.ts`.
   - Config is loaded and normalized through `src/config/`.
   - Agent definitions are produced by `src/agents/`.
   - Tool factories from `src/tools/` and MCP definitions from `src/mcp/` are registered.
   - Hooks from `src/hooks/` are attached.
   - Background execution, multiplexer support, and interview support are initialized.

2. **Interactive request handling**
   - The orchestrator prompt drives routing decisions.
   - Tool calls resolve through `src/tools/` or built-in OpenCode tools.
   - Hooks can transform prompts/messages or repair tool failures before/after execution.

3. **Delegated execution**
   - OpenCode child sessions are created by task/council flows and tracked by plugin utilities.
   - `src/multiplexer/` optionally mirrors those sessions into tmux/zellij panes.
   - Results flow back into the parent session through notifications/output polling.

4. **Install/release path**
   - `src/cli/` configures host OpenCode instances.
   - `src/skills/` is copied into the user skill directory.
   - `scripts/` validates generated schema, package completeness, and host-load behavior.

## Key Cross-Module Integration Points

- `src/index.ts` is the central composition root for nearly every runtime subsystem.
- `src/config/` feeds `src/agents/`, session/delegation utilities, and MCP registration.
- `src/cli/skills.ts` and `src/cli/custom-skills.ts` bridge install-time skill packaging with runtime permission policy.
- Session/delegation utilities depend on `src/multiplexer/` and cooperate with helpers in `src/utils/`.
- `src/tools/council.ts` delegates into `src/council/`.
- `src/hooks/filter-available-skills/` and agent permission logic rely on shared skill names from the CLI/config layer.
- `src/interview/` hooks into plugin command/event surfaces exposed by `src/index.ts`.

## Root Assets

- `README.md`: user-facing product overview, install docs, and agent descriptions.
- `AGENTS.md`: agent operating conventions for this repository.
- `biome.json`: formatting/lint policy.
- `tsconfig.json`: TypeScript compiler settings.
- `.slim/codemap.json`: codemap change-detection state for this repository.

## Recommended Reading Order

1. `codemap.md`
2. `src/codemap.md`
3. One of:
   - `src/agents/codemap.md`
   - `src/multiplexer/codemap.md`
   - `src/tools/codemap.md`
   - `src/hooks/codemap.md`
4. Relevant subsystem sub-map for the task at hand
