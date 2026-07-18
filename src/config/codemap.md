# src/config/

## Responsibility

Centralizes configuration loading, validation, schema definitions, and runtime state management for the oh-my-opencode-slim plugin. This folder implements the configuration pipeline that merges user preferences, project overrides, and preset-based agent configurations, providing validated runtime configuration objects to the rest of the plugin.

## Design

The config system follows a layered architecture:

- **Schema Layer**: Defines Zod schemas for all configuration objects (PluginConfig, AgentOverrideConfig, CouncilConfig, etc.) ensuring runtime validation and type safety
- **Loader Layer**: Implements configuration discovery, merging, and environment variable interpolation across user and project scopes
- **Utility Layer**: Provides helper functions for agent-specific configuration lookup and MCP permission resolution
- **Runtime State**: Manages active preset state across plugin re-initializations

### Design Patterns

- **Factory Pattern**: `loadPluginConfig()` creates the merged configuration object
- **Strategy Pattern**: Presets allow swapping entire agent configurations via `preset` field
- **Decorator Pattern**: Agent overrides decorate default agent behavior with per-model, skill, and MCP restrictions
- **Singleton Pattern**: Runtime preset state persists across plugin re-inits via module-level variables

### Key Abstractions

| Abstraction | Purpose | Location |
|-------------|---------|----------|
| `PluginConfig` | Root configuration object with agents, presets, and feature flags | schema.ts |
| `AgentOverrideConfig` | Per-agent configuration (model, temperature, skills, MCPs) | schema.ts |
| `CouncilConfig` | Multi-LLM council configuration with presets and execution modes | council-schema.ts |
| `MultiplexerConfig` | Unified pane management configuration (tmux/zellij) | schema.ts |

## Flow

### Configuration Loading Pipeline

```
1. Discovery Phase
   ├─ User config: $OPENCODE_CONFIG_DIR/oh-my-opencode-slim.{jsonc,json}
   ├─ Project config: <directory>/.opencode/oh-my-opencode-slim.{jsonc,json}
   └─ Environment variable: OH_MY_OPENCODE_SLIM_PRESET (overrides preset field)

2. Parsing Phase
   ├─ JSONC support (comments, trailing commas) via stripJsonComments
   ├─ Environment variable interpolation: {env:VAR_NAME} → process.env.VAR_NAME
   └─ Zod validation with detailed error reporting

3. Merging Phase
   ├─ User config (base) + Project config (override) → deep merge
   ├─ Preset resolution: preset → merge preset.agents with root agents
   ├─ Legacy tmux → multiplexer migration for backward compatibility
   └─ Normalization: companion defaults, ACP agent defaults

4. Runtime Phase
   ├─ Active preset state persisted across plugin re-inits
   └─ Previous preset tracked for reset diff computation
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
3. Parse wildcard/exclusion syntax: ["*", "!context7"] → ["websearch", "gh_grep"]
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
- `findPluginConfigPaths(directory)`: Discover user and project config file paths
- `mergePluginConfigs(base, override)`: Deep merge two PluginConfig objects
- `deepMerge(base, override)`: Recursively merge nested configuration objects

### Agent Configuration

- `getAgentOverride(config, name)`: Get agent-specific override with alias support
- `getCustomAgentNames(config)`: List custom agents declared in config.agents
- `getAcpAgentNames(config)`: List ACP agent names from config.acpAgents
- `loadAgentPrompt(agentName, preset?)`: Load custom prompt files for agents

### Runtime State

- `setActiveRuntimePreset(name)`: Set currently active preset
- `getActiveRuntimePreset()`: Get currently active preset
- `getPreviousRuntimePreset()`: Get previously active preset
- `setActiveRuntimePresetWithPrevious(name)`: Set active with previous tracking

### MCP Management

- `getAgentMcpList(agentName, config?)`: Resolve MCP permissions for an agent
- `parseList(items, allAvailable)`: Parse wildcard and exclusion syntax in MCP lists

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
- `multiplexer`: Unified pane management config (type, layout, sizes)
- `tmux`: Legacy tmux configuration (migrated to multiplexer)
- `websearch`: Websearch provider configuration
- `interview`: Interview feature configuration
- `backgroundJobs`: Background job configuration
- `fallback`: Failover/retry configuration
- `council`: Council configuration with presets and execution modes
- `companion`: Companion animation configuration
- `acpAgents`: ACP agent configurations

### AgentOverrideConfig
- `model`: Model ID or array of model IDs
- `temperature`: Sampling temperature (0-2)
- `variant`: Model variant identifier
- `skills`: Skill allow/deny list ("*" = all, "!item" = exclude)
- `mcps`: MCP allow/deny list ("*" = all, "!item" = exclude)
- `prompt`: Custom agent prompt override
- `orchestratorPrompt`: Custom orchestrator prompt override
- `options`: Provider-specific model options
- `displayName`: Custom display name for the agent

### CouncilConfig
- `presets`: Named council presets (map of presetName → CouncillorConfig[])
- `default_preset`: Default preset name to use

### MultiplexerConfig
- `type`: "auto", "tmux", "zellij", or "none"
- `layout`: Pane layout (main-horizontal, main-vertical, tiled, even-horizontal, even-vertical)
- `main_pane_size`: Percentage for main pane (20-80)
- `zellij_pane_mode`: "agent-tab" or "current-tab"

## Environment Variable Support

- `{env:VAR_NAME}`: Interpolated in config files during parsing
- `OH_MY_OPENCODE_SLIM_PRESET`: Overrides config.preset at runtime

## Backward Compatibility

- Legacy `tmux.enabled` is automatically migrated to `multiplexer.type = 'tmux'`
- Legacy nested `councillors` format in presets is automatically unwrapped
- Legacy `master` field in council config is accepted but ignored (council agent synthesizes directly)

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
