# src/

## Responsibility

- `src/index.ts` delivers the plugin assembly layer: it loads configuration, resolves agent definitions, precomputes runtime model fallback chains, wires multiplexer/session orchestration, registers tools/MCPs/hooks, and returns the OpenCode plugin registration object.
- `config/`, `agents/`, `tools/`, `multiplexer/`, `hooks/`, and `utils/` contain the reusable building blocks (loader/schema/constants, agent factories/permission helpers, tool factories, session mirroring managers, hook implementations, and runtime utilities) that power that entry point.
- `hooks/task-session-manager` is now part of the core plugin flow to support resumable child task sessions with concise aliases and reminder injection for orchestrator calls.
- `cli/` remains the installer surface (argument parsing, interactive prompts, config edits, skill/provider installation).

## Design

- Agent creation follows explicit factories (`agents/index.ts`, per-agent creators under `agents/`) with override/permission helpers (`config/schema.ts`, `cli/skills.ts`, `config/agent-mcps.ts`) so defaults live in `config/constants.ts`, prompts can be swapped via `config/loader.ts`, and variant labels propagate through `utils/agent-variant.ts`.
- Session orchestration combines `SubagentDepthTracker`, `MultiplexerSessionManager`, `CouncilManager`, and `ForegroundFallbackManager`; these coordinate subagent depth limits, pane lifecycle, council session creation, and foreground model failover.
- Hook composition is centralized in `src/index.ts`: lifecycle event handlers and tool transform handlers fan out to specialized hooks, then some hooks post-process system messages in-place for provider compatibility.
- Supplemental tools bundle AST-grep search/replace, council orchestration, and web fetching behind the OpenCode `tool` interface and are mounted in `index.ts` alongside hooks and MCP helpers.

## Flow

- Startup:
  - `loadPluginConfig` builds effective config from user/project presets.
  - `createAgents` + `getAgentConfigs` construct final agent registry and resolved prompts.
  - Runtime model chains are built from configured arrays plus fallback chains.
  - `SubagentDepthTracker`, `MultiplexerSessionManager`, `CouncilManager`, `ForegroundFallbackManager`, and hook factories are initialized before registration.
- Plugin registration: `index.ts` merges/overlays agent configs into OpenCode's config, registers tools (`council`, `webfetch`, `ast_grep_*`, todo tools), MCPs (`createBuiltinMcps`), and all hook handlers (`event`, `tool.execute.before/after`, `experimental.chat.system/messages.transform`, `command.execute.before`, etc.).
- Runtime event flow (`event`): updates depth tree, multiplexer pane state, auto-update checks, interview/preset state, and task-session cleanup for deleted sessions.
- `experimental.chat.system.transform` pipeline:
  - injects orchestrator/system-level reminders when required,
  - applies task/session prompt enrichment from `task-session-manager`,
  - collapses all system entries into one message via `collapseSystemInPlace` for providers that reject multi-message system arrays.
- `tool.execute.before/after` (`task`): records pending task calls, resolves short aliases to canonical IDs, parses outputs for new task IDs, and updates/removes remembered sessions.
- CLI flow: `cli/install.ts` parses flags, optionally prompts, checks OpenCode installation, updates config via `cli/config-io.ts` and `cli/paths.ts`, disables default agents, writes lite config, and installs skills (`cli/skills.ts`, `cli/custom-skills.ts`).

## Integration

- Connects directly to `@opencode-ai/plugin`: returns the plugin object, mutates runtime agent configuration, handles event hooks, and routes RPC via `ctx.client`/`ctx.client.session`.
- Integrates with host multiplexer backends through `src/multiplexer`, and with session lifecycle constraints through `SubagentDepthTracker`.
- Hooks/handoff integration points now include:
  - `createTaskSessionManagerHook` for resumable Task sessions,
  - `createTodoContinuationHook`, `createPhaseReminderHook`, `createFilterAvailableSkillsHook`, and `createPostFileToolNudgeHook` for chat/tool behavior,
  - `createInterviewManager` / `createPresetManager` command handlers.
- Utility integration is visible at runtime through `utils/session-manager.ts` + `utils/task.ts` (task resume support), `utils/system-collapse.ts` (system message normalization), and legacy utility support (`logger`, `env`, `polling`, `session`, etc.).
