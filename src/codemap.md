# src/

## Responsibility
- `src/index.ts` delivers the oh-my-opencode-slim plugin by merging configuration, instantiating orchestrator/subagent definitions, wiring session/delegation tracking, multiplexer helpers, built-in tools, MCPs, and lifecycle hooks so OpenCode sees a single cohesive module.
- `config/`, `agents/`, `tools/`, `multiplexer/`, `hooks/`, and `utils/` contain the reusable building blocks (loader/schema/constants, agent factories/permission helpers, tool factories, session mirroring managers, hook implementations, and logging/session/depth helpers) that power that entry point.
- `cli/` exposes installer workflows (argument parsing + interactive prompts) that edit OpenCode config, install recommended/custom skills, and generate provider presets for this plugin.

## Design
- Agent creation follows explicit factories (`agents/index.ts`, per-agent creators under `agents/`) with override/permission helpers (`config/schema.ts`, `cli/skills.ts`, `config/agent-mcps.ts`) so defaults live in `config/constants.ts`, prompts can be swapped via `config/loader.ts`, and variant labels propagate through `utils/agent-variant.ts`.
- Session orchestration combines `MultiplexerSessionManager` with `SubagentDepthTracker` and `multiplexer/*` so child sessions are depth-tracked, can surface in panes, and are cleaned up consistently.
- Hooks are isolated (`hooks/auto-update-checker`, `phase-reminder`, `post-file-tool-nudge`) and exported via `hooks/index.ts`, so the plugin simply registers them via the `event`, `experimental.chat.system.transform`, `experimental.chat.messages.transform`, and `tool.execute.after` hooks defined in `index.ts`.
- Supplemental tools bundle AST-grep search/replace, council orchestration, and web fetching behind the OpenCode `tool` interface and are mounted in `index.ts` alongside hooks and MCP helpers.

## Flow
- Startup: `index.ts` calls `loadPluginConfig` (user + project JSON + presets) to build a `PluginConfig`, passes it to `getAgentConfigs` (which uses `createAgents`, `getAgentMcpList`, and `loadAgentPrompt`), then initializes `SubagentDepthTracker`, `MultiplexerSessionManager`, `CouncilManager`, and hook/tool registrations.
- Plugin registration: `index.ts` registers agents, the tool map (`council`, `webfetch`, `ast_grep_*`), MCP definitions (`createBuiltinMcps`), and hooks (`createAutoUpdateCheckerHook`, `createPhaseReminderHook`, `createTodoContinuationHook`, etc.); config-driven permission policy and MCP filters are applied via `getDisabledAgents` and `config/agent-mcps.ts`.
- Runtime: `MultiplexerSessionManager` observes `session.created` events to spawn panes via multiplexer backends and closes them on idle, deleted, or timeout states, while `SubagentDepthTracker` constrains nested delegated session creation.
- CLI flow: `cli/install.ts` parses flags, optionally asks interactive prompts, checks OpenCode installation, appends plugin entries via `cli/config-io.ts` and `cli/paths.ts`, disables default agents, writes the lite config, and installs skills (`cli/skills.ts`, `cli/custom-skills.ts`).

## Integration
- Connects directly to the OpenCode plugin API (`@opencode-ai/plugin`): registers agents/tools/mcps, responds to `session.created` and `tool.execute.after` events, injects message/system transforms, and makes RPC calls via `ctx.client`/`ctx.client.session` throughout the council, multiplexer, and hook systems.
- Integrates with the host environment: `src/multiplexer` validates pane backend availability through startup checks, and `MultiplexerSessionManager` coordinates child-session panes via shared multiplexer configuration.
- Hooks and helpers tie into external behavior: `hooks/auto-update-checker` reads `package.json` metadata, runs safe `bun install`, and posts toasts; `hooks/phase-reminder` and `hooks/post-file-tool-nudge` enforce workflow reminders without mutating file-tool output; `utils/logger.ts` centralizes structured logging used across modules.
- CLI utilities modify OpenCode config files (`cli/config-io.ts`, `cli/paths.ts`) and install additional skills/providers, ensuring the plugin lands with configured agents, provider presets, and permission-aware skill definitions.
