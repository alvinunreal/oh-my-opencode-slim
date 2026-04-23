# Config Module Codemap

## Responsibility

`src/config/` owns plugin configuration schema, load/merge pipeline, prompt
resolution, and helper APIs used by agents, council, and runtime subsystems.

## Architecture

### Core entry points

- `loadPluginConfig(directory)` is the top-level loader used by `src/index.ts`.
- `PluginConfigSchema` validates and normalizes raw config, including:
  - legacy council field deprecation capture
  - strict guard that `prompt` / `orchestratorPrompt` are only for custom
    agents.
- `getAgentPrompt`/`loadAgentPrompt` and related helpers are consumed by
  agent registry.

### Merge and load pipeline

`loadPluginConfig(directory)`:

1. Locate user config (prefer `.jsonc`, then `.json`) from:
   - `OPENCODE_CONFIG_DIR`
   - `XDG_CONFIG_HOME/opencode`
   - `~/.config/opencode`
2. Locate project config at
   `<directory>/.opencode/oh-my-opencode-slim.(jsonc|json)`.
3. Validate with schema. Invalid/malformed files are warned and ignored by
   returning `null` for that file.
4. Merge user+project configs where project takes precedence:
   nested merges for `agents`, `tmux`, `multiplexer`, `interview`, `sessionManager`,
   `fallback`, `council`.
   top-level arrays/values are overridden.
5. If `tmux` is enabled and no explicit `multiplexer` is configured,
   migrate to `multiplexer` (`tmux` compatibility path).
6. Apply env override `OH_MY_OPENCODE_SLIM_PRESET` over config file preset.
7. If preset exists, merge preset agents into `agents` so explicit root agents
   still win (`deepMerge(preset, config.agents)`).
8. Return merged config object.

### Prompt discovery

`loadAgentPrompt(agentName, preset?)`:

- Searches config directories for `oh-my-opencode-slim/` prompt roots.
- Supports optional preset subdirectory lookup when `preset` is alphanumeric/
  hyphen/underscore-safe.
- For each agent:
  - `<agent>.md` replacement prompt
  - `<agent>_append.md` appended prompt
- Read errors are warned and do not fail config load.

### Schema surface and compatibility

- Agent override schema supports:
  - `model` string or ordered fallback array (string or `{id, variant}`)
  - `temperature`, `variant`, `options`, `skills`, `mcps`, `displayName`
  - custom agent prompts (`prompt`, `orchestratorPrompt`) only.
- Multiplexer:
  - new unified `multiplexer` schema (`auto|tmux|zellij|none`)
  - legacy `tmux` schema retained and migrated at load time.
- Council:
  - `CouncilConfigSchema` now normalizes deprecated `master*` fields into
    `_legacyMasterModel` metadata for compatibility
  - supports presets + timeout/retry/execution mode.
- Fallback config supports per-agent chain arrays and retry/backoff values.

## Control flow and dependencies

```text
src/index.ts
  └─> loadPluginConfig(directory)
      ├─> Agent override application in src/agents/index.ts
      ├─> MCP defaults/filters in src/config/agent-mcps.ts
      ├─> Council session behavior in src/council/*
      ├─> Fallback/session behavior in runtime hooks
      └─> Multiplexer behavior in src/multiplexer/*
```

### Key collaborators

- `constants.ts`
  - names/aliases, orchestratable lists, default models/timeouts/modes.
- `agent-mcps.ts`
  - `getAgentMcpList`, `parseList`, `getAvailableMcpNames`.
- `utils.ts`
  - alias resolution and custom-agent key discovery.
- `loader.ts`
  - config IO, deep merge, preset composition, env override, prompt loading.
- `schema.ts`, `council-schema.ts`
  - type/shape validation + transformation.

## File structure

- `index.ts` — exported config surface
- `loader.ts` — load, merge, prompt resolution, tmux migration
- `schema.ts` — plugin config + agent override schemas
- `council-schema.ts` — council-specific and legacy compatibility schema
- `constants.ts` — defaults, names, delegation rules, timeouts
- `agent-mcps.ts` — MCP defaults and allow-list parsing
- `utils.ts` — config helper methods
