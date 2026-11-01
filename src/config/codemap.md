# src/config/

## Responsibility

Centralizes configuration loading, validation, schema definitions, and runtime state management for the oh-my-opencode-slim plugin. This folder implements the configuration pipeline that merges user preferences, project overrides, and preset-based agent configurations, providing validated runtime configuration objects to the rest of the plugin.

## Design

The config system follows a layered architecture:

- **Schema Layer**: Defines Zod schemas for all configuration objects (PluginConfig, AgentOverrideConfig, CouncilConfig, etc.) ensuring runtime validation and type safety
- **Loader Layer**: Implements configuration discovery, merging, and environment variable interpolation across user and project scopes
- **Utility Layer**: Provides helper functions for agent-specific configuration lookup and MCP permission resolution
- **Runtime State**: Manages active preset state and derived runtime configuration across plugin re-initializations

### Design Patterns

- **Factory Pattern**: `loadPluginConfig()` creates the merged configuration object
- **Strategy Pattern**: Presets allow swapping entire agent configurations via `preset` field
- **Decorator Pattern**: Agent overrides decorate default agent behavior with per-model, skill, and MCP restrictions
- **Singleton Pattern**: Runtime config and active preset state persist per project directory via the `RuntimeConfig` registry (`runtime.ts`)

### Key Abstractions

| Abstraction | Purpose | Location |
|-------------|---------|----------|
| `PluginConfig` | Root configuration object with agents, presets, and feature flags | schema.ts |
| `AgentOverrideConfig` | Per-agent configuration (model, temperature, skills, MCPs) | schema.ts |
| `CouncilConfig` | Multi-LLM council configuration with councillor presets and a default preset | council-schema.ts |
| `MultiplexerConfig` | Unified pane management configuration (tmux/zellij) | schema.ts |
| `AgentMcpPolicy` | Per-agent default MCP lists and wildcard/exclusion parsing | agent-mcps.ts |
| `ProviderModelIdSchema` | Zod schema enforcing `provider/model` ID format (provider segment excludes slashes/whitespace) | model-id-schema.ts |
| Preset resolver | Preset normalization, layered merge (`mergePresetMaps`), and depth-first named-preset resolution (`resolvePresets` atomic, `PresetResolutionError` on unresolvable refs) | presets.ts |
| `discoverProjectLocalSkillNames` | Current and ancestor `.opencode/skills` discovery from `SKILL.md` frontmatter names, symlink-confined to each location | project-skills.ts |
| `getProjectConfigDirectories` | Shared host-aware `.opencode` walk: worktree-bounded on v1, root-bounded on v2, disabled by the host's project-config flag | loader.ts |
| `isProjectConfigDisabled` | Shared host flag parsing for discovery and project preset actions | loader.ts |
| `loadRawPluginConfigFromPath` | Shared layer validation for runtime and preset management, preserving editable preset syntax | loader.ts |
| `RuntimeConfig` | Per-directory runtime config singleton with derived getters, host-config snapshot, and preset/model overrides | runtime.ts |

## Shared Runtime Reads

`snapshot.ts` owns a bounded merged-config cache keyed by the selected source
paths, their device/inode/mtime/ctime/size fields and referenced `{env:NAME}`
values. Setup and TUI readers reuse `{config,warnings,paths,fingerprint}`;
`fresh` covers a known write that timestamp granularity cannot distinguish.
Read failures are not cached. Preset editors keep their own raw/validated
reads; uncached `loadPluginConfig` stays available.

Shared JSONC parsing, locked atomic editing and path lookup live in `jsonc.ts`,
`json-file.ts` and `paths.ts`, not the CLI. The full Marketplace manifest is not
an eager config dependency: package-ID validation comes from `id-schema.ts`.

## Flow

### Configuration Loading Pipeline

```
1. Discovery Phase
   ├─ User config: $OPENCODE_CONFIG_DIR/oh-my-opencode-slim.{jsonc,json}
    ├─ Project configs: every ancestor's .opencode/oh-my-opencode-slim.{jsonc,json}, filesystem root to directory
   └─ Environment variable: OH_MY_OPENCODE_SLIM_PRESET (overrides preset field)

2. Parsing Phase
   ├─ JSONC support (comments, trailing commas) via stripJsonComments
   ├─ Environment variable interpolation: {env:VAR_NAME} → process.env.VAR_NAME
   └─ Zod validation with detailed error reporting

3. Merging Phase
    ├─ User config (base) + ancestor project configs (farthest to closest) → deep merge
   ├─ Preset resolution: preset → merge preset.agents with root agents
   └─ Normalization: companion defaults, ACP agent defaults

4. Runtime Phase
   ├─ RuntimeConfig seeded with deep-frozen plugin config snapshot
   ├─ captureHostConfig() snapshots the host opencode.json BEFORE the config hook mutates it
   └─ Derived getters (agents, modelArrays, disabled*, presets) computed on demand
```

### Agent Configuration Resolution

```
Agent-specific configuration lookup:
1. Check config.agents[agentName]
2. Check config.agents[legacyAlias] (e.g., "explore" → "explorer")
3. Return undefined if not found (use defaults)

MCP permission resolution:
1. Check agent override: config.agents[agentName]?.mcps
2. Fall back to DEFAULT_AGENT_MCPS[agentName]
3. Parse wildcard/exclusion syntax: ["*", "!context7"] → ["context7", "gh_grep"]
```

### Preset Resolution

```
Preset resolution flow:
1. Read config.preset (e.g., "default", "minimal")
2. Look up preset in config.presets[presetName]
3. Merge preset.agents with config.agents (root overrides take precedence)
4. Apply preset-specific agent overrides
5. Resolve preset model plans for manual agents (orchestrator, oracle, etc.)
```

## Integration

### Consumers

| Module | Integration Point | Description |
|--------|-----------------|-------------|
| `src/index.ts` | `loadPluginConfig()` | Main plugin entry point loads merged config |
| `src/agents/` | Agent configuration | Agents use config for model selection and permissions |
| `src/agents/council.ts` | Council agent configuration | Council agent uses CouncilConfig for multi-LLM orchestration |
| `src/multiplexer/` | Multiplexer configuration | Uses multiplexer config for pane layout and type |
| `src/cli/` | Config file discovery | CLI tools use config paths for user/project config lookup |

### Dependencies

- **Zod**: Runtime validation and schema inference
- **Node.js fs**: Configuration file reading (JSONC support via stripJsonComments)
- **Environment**: Environment variable interpolation via {env:VAR_NAME} syntax

### Published Exports

The config folder re-exports its public API via `src/config/index.ts`:

```typescript
export * from './constants';
export * from './council-schema';
export { deepMerge, loadAgentPrompt, loadPluginConfig } from './loader';
export * from './schema';
export { getAcpAgentNames, getAgentOverride, getCustomAgentNames } from './utils';
```

This allows consumers to import directly from `src/config` rather than individual files.

## Key Functions

### Configuration Loading

- `loadPluginConfig(directory, options?)`: Main entry point for configuration loading and merging
- `loadConfigFromPath(configPath, options?)`: Load and validate single config file (JSONC or JSON)
- `findPluginConfigPaths(directory)`: Discover user config and ancestor project layers in merge order; retain a current-directory-only path for project writes
- `mergePluginConfigs(base, override)`: Deep merge two PluginConfig objects
- `deepMerge(base, override)`: Recursively merge nested configuration objects

### Agent Configuration

- `getAgentOverride(config, name)`: Get agent-specific override with alias support
- `getCustomAgentNames(config)`: List custom agents declared in config.agents
- `getAcpAgentNames(config)`: List ACP agent names from config.acpAgents
- `loadAgentPrompt(agentName, preset?)`: Load custom prompt files for agents, searching current and ancestor locations before global directories
- `stripOrchestratorModel` / `applyOrchestratorModelConfig` (strip-orchestrator-model.ts): Strip the orchestrator's single model/variant when a fallback chain is configured

### Runtime State

- `RuntimeConfig.init(directory, pluginConfig)`: Seed the per-directory singleton with a deep-frozen plugin config snapshot
- `RuntimeConfig.get(directory)`: Get (lazily creating) the singleton for a directory
- `RuntimeConfig.reset(directory)`: Clear the singleton for a directory
- `RuntimeConfig.captureHostConfig(opencodeConfig)`: Capture host-side config before the config hook mutates it
- `setRuntimePreset(name)` / `getRuntimePreset()`: Runtime preset override (stale names clear it)
- Derived getters: `plugin`, `preset`, `agents()`, `agent(name)`, `disabledAgents`, `disabledTools`, `disabledSkills`, `disabledHooks`, `disabledCommands`, `customAgentNames`, `disabledMcps`, `imageRouting`, `multiplexer`, `backgroundJobs` (incl. `orchestratorWake`), `fallback`, `webfetch`, `acpAgents`, `companion`, `council`, `autoUpdate`, `stripOrchestratorModel`, `setDefaultAgent`, `compactSidebar`, `modelArrays` (incl. councillor chains), `runtimeChains`, `primaryModel`, `smallModel()`, `hostAgent(name)`

### MCP Management

- `DEFAULT_AGENT_MCPS` + `parseList` (agent-mcps.ts): Per-agent default MCP lists and wildcard/exclusion parsing
- `getAgentMcpList(agentName, config?)`: Resolve effective MCP permissions for an agent

## Configuration Schema Overview

### PluginConfig (Root Schema)
- `preset`: Active preset name
- `setDefaultAgent`: Whether to set default agent model
- `autoUpdate`: Enable automatic plugin updates
- `presets`: Named preset groupings (map of presetName → AgentOverrideConfig)
- `agents`: Per-agent overrides (map of agentName → AgentOverrideConfig)
- `disabled_agents`: List of agents to disable
- `disabled_mcps`: List of MCPs to disable
- `disabled_tools`: List of tools to disable
- `disabled_skills`: List of skills to disable
- `disabled_hooks`: List of hooks to disable (`phase-reminder`, `foreground-fallback`, `chat-headers`, `cache-monitor`, `json-error-recovery`, `tool-loop-guard`, `search-path-guard`, `absolute-path-rescue`, `apply-patch`, `council-inject`)
- `disabled_commands`: List of slash commands to disable (`interview`, `implement`, `deepwork`, `reflect`, `loop`, `preset`)
- Enum-backed disabled keys use whole-family replacement semantics: explicit `[]` overrides a lower layer, a mixed list replaces it with the valid subset, and a list containing only unknown names is treated as unset so the lower layer applies.
- `multiplexer`: Unified pane management config (type, layout, sizes, viewer surface)
- `interview`: Interview feature configuration
- `backgroundJobs`: Background job configuration
- `backgroundJobs.concurrency`: Optional default, provider, and model caps for native background task admission
- `fallback`: Failover/retry configuration
- `council`: Council configuration with councillor presets and a default preset
- `companion`: Companion animation configuration
- `acpAgents`: ACP agent configurations

### AgentOverrideConfig
- `model`: Model ID or array of model IDs
- `inheritModelFrom`: Explicitly inherit the current `session` model or the configured `orchestrator` model when `model` is omitted; supported for built-in and custom agents
- `temperature`: Sampling temperature (0-2)
- `variant`: Model variant identifier
- `skills`: Skill allow/deny list ("*" = all, "!item" = exclude)
- `mcps`: MCP allow/deny list ("*" = all, "!item" = exclude)
- `prompt`: Custom agent prompt override
- `orchestratorPrompt`: Custom orchestrator prompt override
- `options`: Provider-specific model options
- `displayName`: Custom display name for the agent
- `color`: Agent display color as a six-digit hex value or OpenCode theme color
- `primary`: Declare a custom agent as a peer primary orchestrator (SDK mode `primary`; ignored on built-in names)
- `subagents`: Primary agents only — delegation scope allowlist compiled into the `task` permission stance (`{"*": "deny", "<name>": "allow"}`); an explicit `permission.task` entry wins and skips the scoped `<Agents>` catalog. `'*'` is reserved

### CouncilConfig
- `presets`: Named council presets (map of councillor name → CouncillorConfig)
- `default_preset`: Default preset name to use

### MultiplexerConfig
- `type`: "auto", "tmux", "zellij", "herdr", "cmux", "kitty", "wezterm", "orca", or "none" (client-local admission)
- `layout`: Pane layout (main-horizontal, main-vertical, tiled, even-horizontal, even-vertical)
- `main_pane_size`: Percentage for main pane (20-80), tmux main-* layouts and the first WezTerm main-* split
- `zellij_pane_mode`: removed; stripped with a warning by the loader

## Environment Variable Support

- `{env:VAR_NAME}`: Interpolated in config files during parsing
- `OH_MY_OPENCODE_SLIM_PRESET`: Overrides config.preset at runtime

## Backward Compatibility

- Removed keys (`REMOVED_CONFIG_KEYS` in `removed-keys.ts`: top-level `tmux`, `council.master*`, council preset `master` / `councillors`, `backgroundJobs.continueOnIdle`, `fallback.timeoutMs|retry_on_empty|runtimeOverride`, `multiplexer.zellij_pane_mode`, `webfetch.model`): stripped from each raw layer before validation with a `removed-key` warning; the schema itself still rejects them
- Invalid `multiplexer` values disable pane management (`type: "none"`) with one diagnostic

## Error Handling

- Invalid JSON → warning, fallback to empty config
- Invalid schema → warning, fallback to empty config
- Missing preset → warning, continue with empty preset
- Read errors (non-ENOENT) → warning, fallback to empty config
- All warnings trigger optional `onWarning` callback for programmatic handling

## Testing Considerations

Configuration loading is tested via:
- `src/config/loader.test.ts`: Config file discovery, parsing, merging, and validation
- `src/config/schema.test.ts`: Schema validation and type inference
- `src/config/utils.test.ts`: Agent configuration utilities
- `src/config/agent-mcps.test.ts`: MCP permission resolution
- `src/config/council-schema.test.ts`: Council configuration validation
- `src/config/runtime.test.ts`: RuntimeConfig seeding, derived getters, preset state, and host capture
