# Config Module Codemap

## Responsibility

`src/config/` defines plugin schema, runtime merge behavior, config loading, and policy helpers used by every runtime subsystem.

## Architecture

### Core inputs and outputs

- `loadPluginConfig(directory)` is the primary runtime entry.
- Configuration shape validated by `PluginConfigSchema` and merged with project overrides.
- Preset selection and prompt loading are both runtime-controlled.

### Merge and load pipeline

`loadPluginConfig(directory)` currently:

1. Load user config from search dirs (prefers `.jsonc` then `.json`).
2. Load project override config from `./.opencode/oh-my-opencode-slim.*`.
3. Deep-merge nested objects (`agents`, `tmux`, `multiplexer`, `interview`, `fallback`, `council`) with project config taking precedence.
4. Migrate legacy `tmux` to `multiplexer` when needed.
5. Apply env preset (`OH_MY_OPENCODE_SLIM_PRESET`) over config value.
6. Merge preset values into root `agents` (root still wins on conflict).

### Prompt discovery and override semantics

`loadAgentPrompt(agentName, preset?)` resolves optional agent prompts:

- Checks preset-scoped prompt directory first (`<configDir>/oh-my-opencode-slim/<preset>/`).
- Checks package-wide prompt directory fallback.
- Loads optional replacement (`<agent>.md`) and append (`<agent>_append.md`) files.

### Runtime schema surface

- `agents`: per-agent overrides (`model`, `temperature`, `variant`, `options`, `skills`, `mcps`, prompts)
- `disabled_agents`, `disabled_mcps`
- `multiplexer`: runtime pane strategy (`auto|tmux|zellij|none`)
- `tmux` (legacy support) + migration into multiplexer
- `fallback`: retry/timeout policy for provider fallback and empty responses
- `interview`: dashboard/session interview behavior
- `council`: council preset/timeout/retry/execution-mode config

`Schema notes`:

- `AgentOverrideConfig` supports both string and array model formats for ordered fallback.
- Custom prompt fields (`prompt`, `orchestratorPrompt`) are validated only for custom agents (schema-level guard).
- Council config (`council-schema.ts`) tolerates deprecated `master` fields by marking them ignored and exposing warning metadata.

## Control flow and module dependencies

```text
src/index.ts
  └─> loadPluginConfig(directory)
      └─> PluginConfig
          ├─> createAgents(config)         (agents/index.ts)
          ├─> fallback chain setup          (index.ts runtime)
          ├─> interview/dashboard config    (interview/*)
          ├─> council session config        (council/*)
          ├─> multiplexer mode            (multiplexer/*)
```

### Key collaborators

- `agent-mcps.ts`
  - default MCP lists per agent
  - wildcard/deny list parser (`parseList`)
  - available MCP discovery with `disabled_mcps`
- `utils.ts`
  - `getAgentOverride` with alias compatibility (`explore` -> `explorer`, etc.)
  - `getCustomAgentNames`
- `constants.ts`
  - built-in names, aliases, delegation matrices

## File structure

- `index.ts` — export surface
- `loader.ts` — load, merge, prompt-loading helpers
- `schema.ts` — main zod schema and type exports
- `constants.ts` — names, defaults, timeouts, delegation policy, fallback constants
- `agent-mcps.ts` — MCP defaults and filtering
- `utils.ts` — config helper methods
- `council-schema.ts` — council preset/result/deprecated-field schema
