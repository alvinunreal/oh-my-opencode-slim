# src/

## Responsibility
- `src/index.ts` delivers the oh-my-opencode-slim plugin by merging configuration, instantiating orchestrator/subagent definitions, wiring multiplexer helpers, built-in tools, MCPs, and lifecycle hooks so OpenCode sees a single cohesive module.
- `config/`, `agents/`, `tools/`, `multiplexer/`, `hooks/`, and `utils/` contain the reusable building blocks (loader/schema/constants, agent factories/permission helpers, tool factories, child-session pane managers, hook implementations, and tmux/variant/log helpers) that power that entry point.
- `cli/` exposes the install/update script (argument parsing + interactive prompts) that edits OpenCode config, installs recommended/custom skills, and updates provider credentials to bootstrap this plugin on a host machine.

## Design
- Agent creation follows explicit factories (`agents/index.ts`, per-agent creators under `agents/`) with override/permission helpers (`config/utils.ts`, `cli/skills.ts`) so defaults live in `config/constants.ts`, prompts can be swapped via `config/loader.ts`, and variant labels propagate through `utils/agent-variant.ts`.
- Multiplexer tooling composes `MultiplexerSessionManager` with `utils/tmux.ts`/`multiplexer/*` so child agent sessions automatically open and close panes while the main session keeps running.
- Hooks are isolated (`hooks/auto-update-checker`, `phase-reminder`, `post-file-tool-nudge`) and exported via `hooks/index.ts`, so the plugin simply registers them via the `event`, `experimental.chat.system.transform`, `experimental.chat.messages.transform`, and `tool.execute.after` hooks defined in `index.ts`.
- Supplemental tools (`tools/grep`, `tools/lsp`, `tools/quota`) bundle ripgrep, LSP helpers, and Antigravity quota calls behind the OpenCode `tool` interface and are mounted in `index.ts` alongside council/webfetch helpers.

## Flow
- Startup: `index.ts` calls `loadPluginConfig` (user + project JSON + presets) to build a `PluginConfig`, passes it to `getAgentConfigs` (which uses `createAgents`, agent factories, `loadAgentPrompt`, and `getAgentMcpList`) and to `MultiplexerSessionManager`/`CouncilManager` so the in-memory state matches user overrides.
- Plugin registration: `index.ts` registers agents, the tool map (`task`, council, `webfetch`, `ast_grep_*`, `lsp_*`), MCP definitions (`createBuiltinMcps`), and hooks (`createAutoUpdateCheckerHook`, `createPhaseReminderHook`, `createPostReadNudgeHook`); configuration hook merges those values back into the OpenCode config (default agent, permission rules parsed from `config/agent-mcps`, and MCP access policies).
- Runtime: `MultiplexerSessionManager` observes `session.created` events to spawn panes via `utils/tmux` and closes them when sessions idle or are deleted, while `CouncilManager` manages parallel child sessions for council runs.
- CLI flow: `cli/install.ts` parses flags, optionally asks interactive prompts, checks OpenCode installation, adds plugin entries via `cli/config-manager.ts`, disables default agents, writes the lite config (`cli/config-io.ts`), and installs skills (`cli/skills.ts`, `cli/custom-skills.ts`).

## Integration
- Connects directly to the OpenCode plugin API (`@opencode-ai/plugin`): registers agents/tools/mcps, responds to `session.created` and `tool.execute.after` events, injects `experimental.chat.messages.transform`, and makes RPC calls via `ctx.client`/`ctx.client.session` throughout the council, multiplexer, and hook systems.
- Integrates with the host environment: `utils/tmux.ts` checks for tmux and server availability, `startTmuxCheck` pre-seeds the binary path, and `MultiplexerSessionManager` coordinates child-session panes via shared multiplexer configuration.
- Hooks and helpers tie into external behavior: `hooks/auto-update-checker` reads `package.json` metadata, runs safe `bun install`, and posts toasts; `hooks/phase-reminder/post-file-tool-nudge` enforce workflow reminders without mutating file tool output; `utils/logger.ts` centralizes structured logging used across modules.
- CLI utilities modify OpenCode CLI/user config files (`cli/config-manager.ts`) and install additional skills/ providers, ensuring the plugin lands with the expected agents, provider auth helpers, and custom skill definitions.
