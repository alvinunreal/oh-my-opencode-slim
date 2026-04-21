# Config Module Codemap

## Responsibility

The `src/config/` module is responsible for:

1. **Schema Definition**: Type-safe configuration validation using Zod schemas
2. **Configuration Loading**: Loading, validating, and merging plugin configuration from multiple sources (user config, project config, environment variables)
3. **Constants Management**: Centralizing agent names, default models, delegation rules, polling intervals, and timeouts

## Design

### Key Patterns

**Multi-Source Configuration Merging**
- User config: `~/.config/opencode/oh-my-opencode-slim.jsonc` (preferred) or `.json`
- Project config: `<directory>/.opencode/oh-my-opencode-slim.jsonc` (preferred) or `.json`
- Environment override: `OH_MY_OPENCODE_SLIM_PRESET`
- Project config takes precedence over user config
- Nested objects (`agents`, `tmux`, `fallback`) are deep-merged; arrays and primitives are replaced

**Preset System**
- Named presets contain agent configuration templates
- Presets are merged with root-level agent config (root overrides)
- Supports preset selection via config file or environment variable

**Subagent Delegation Rules**
- Explicitly defines which agents can spawn which subagents
- `orchestrator`: can spawn all subagents (full delegation)
- `fixer`: leaf node — prompt forbids delegation
- `designer`: leaf node (cannot spawn subagents)
- `explorer`, `librarian`, `oracle`: leaf nodes (cannot spawn subagents)

### Core Abstractions

**Configuration Schema Hierarchy**
```
PluginConfig
├── preset?: string
├── setDefaultAgent?: boolean
├── scoringEngineVersion?: 'v1' | 'v2-shadow' | 'v2'
├── balanceProviderUsage?: boolean
├── manualPlan?: ManualPlan
├── presets?: Record<string, Preset>
├── agents?: Record<string, AgentOverrideConfig>
├── disabled_mcps?: string[]
├── tmux?: TmuxConfig
├── background?: BackgroundTaskConfig
└── fallback?: FailoverConfig

AgentOverrideConfig
├── model?: string | ModelEntry[]
├── temperature?: number
├── variant?: string
├── skills?: string[]  // "*" = all, "!item" = exclude
└── mcps?: string[]     // "*" = all, "!item" = exclude

TmuxConfig
├── enabled: boolean
├── layout: TmuxLayout
└── main_pane_size: number

FailoverConfig
├── enabled: boolean
├── timeoutMs: number
├── retryDelayMs: number
└── chains: Record<string, string[]>
```

**Agent Names**
- `ORCHESTRATOR_NAME`: `'orchestrator'`
- `SUBAGENT_NAMES`: `['explorer', 'librarian', 'oracle', 'designer', 'fixer']`
- `ALL_AGENT_NAMES`: `['orchestrator', 'explorer', 'librarian', 'oracle', 'designer', 'fixer']`
- `AGENT_ALIASES`: Legacy name mappings (`{ explore: 'explorer' }`)

**TypeScript Types**
- `PluginConfig`: Main configuration object
- `AgentOverrideConfig`: Per-agent configuration overrides
- `TmuxConfig`: Tmux integration settings
- `TmuxLayout`: Layout enum (`main-horizontal`, `main-vertical`, `tiled`, `even-horizontal`, `even-vertical`)
- `Preset`: Named agent configuration presets
- `AgentName`: Union type of all agent names
- `McpName`: Union type of available MCPs (`'websearch'`, `'context7'`, `'grep_app'`)
- `BackgroundTaskConfig`: Background task concurrency settings
- `FailoverConfig`: Failover behavior configuration
- `ModelEntry`: Normalized model entry with optional per-model variant (`{ id: string; variant?: string }`)
- `ManualAgentName`: Union type for manual agent configuration
- `ManualPlan`: Full manual planning configuration

## Flow

### Configuration Loading Flow

```
loadPluginConfig(directory)
│
├─→ Find user config path
│   └─→ findConfigPath(~/.config/opencode/oh-my-opencode-slim)
│       └─→ Prefers .jsonc over .json
│
├─→ Load user config with loadConfigFromPath()
│   └─→ stripJsonComments() → JSON.parse()
│   └─→ PluginConfigSchema.safeParse()
│       └─→ Returns null if invalid/missing
│
├─→ Find project config path
│   └─→ findConfigPath(<directory>/.opencode/oh-my-opencode-slim)
│
├─→ Load project config (same validation)
│
├─→ Deep merge configs (project overrides user)
│   ├─→ Top-level: project replaces user
│   └─→ Nested (agents, tmux, fallback): deepMerge()
│
├─→ Apply environment preset override
│   └─→ OH_MY_OPENCODE_SLIM_PRESET takes precedence
│
└─→ Resolve and merge preset
    ├─→ Find preset in config.presets[preset]
    ├─→ Deep merge preset agents with root agents
    └─→ Warn if preset not found
```

### Deep Merge Algorithm

```
deepMerge(base?, override?)
│
├─→ If base is undefined → return override
├─→ If override is undefined → return base
│
└─→ For each key in override
    ├─→ If both values are non-null, non-array objects
    │   └─→ Recursively deepMerge
    └─→ Otherwise → override replaces base
```

### Prompt Loading Flow

```
loadAgentPrompt(agentName, preset?)
│
├─→ Validate preset name (alphanumeric + underscore/dash)
│
├─→ Build prompt search dirs
│   ├─→ If preset is safe:
│   │   1) ~/.config/opencode/oh-my-opencode-slim/{preset}
│   │   2) ~/.config/opencode/oh-my-opencode-slim
│   └─→ Otherwise:
│       1) ~/.config/opencode/oh-my-opencode-slim
│
├─→ Read first existing {agentName}.md from search dirs
│   └─→ If found → replacement prompt
│
└─→ Read first existing {agentName}_append.md from search dirs
    └─→ If found → append prompt
```

## Integration

### Dependencies

**External Dependencies**
- `zod`: Runtime schema validation
- `node:fs`, `node:path`: File system operations

**Internal Dependencies**
- `src/cli/config-io.ts` - JSONC comment stripping utility (`stripJsonComments`)
- `src/cli/paths.ts` - Config directory resolution (`getConfigDir`)

### Consumers

**Direct Consumers**
- `src/index.ts` - Main plugin entry point (imports configuration)
- `src/agents/index.ts` - Agent configuration and initialization
- `src/cli/providers.ts` - CLI provider resolution

## File Organization

```
src/config/
├── loader.ts        # Config loading, merging, and prompt loading
├── schema.ts        # Zod schemas and TypeScript types
└── constants.ts    # Agent names, defaults, timeouts, delegation rules
```

## Constants Reference

### Polling Configuration
- `POLL_INTERVAL_MS` (500ms): Standard polling interval
- `POLL_INTERVAL_SLOW_MS` (1000ms): Slower polling interval for less latency-sensitive checks
- `POLL_INTERVAL_BACKGROUND_MS` (2000ms): Multiplexer child-session polling

### Timeouts
- `DEFAULT_TIMEOUT_MS` (2 minutes): Default operation timeout
- `MAX_POLL_TIME_MS` (5 minutes): Maximum polling duration
- `FALLBACK_FAILOVER_TIMEOUT_MS` (15 seconds): Failover timeout

### Stability
- `STABLE_POLLS_THRESHOLD` (3): Number of stable polls before considering state settled

### Default Models
| Agent      | Default Model           |
|------------|-------------------------|
| orchestrator | runtime-resolved     |
| oracle      | openai/gpt-5.4        |
| librarian   | openai/gpt-5.4-mini   |
| explorer    | openai/gpt-5.4-mini   |
| designer    | openai/gpt-5.4-mini   |
| fixer       | openai/gpt-5.4-mini   |

### Delegation Rules
| Parent Agent | Can Spawn                     |
|--------------|-------------------------------|
| orchestrator | explorer, librarian, oracle, designer, fixer |
| fixer        | (none - leaf node)            |
| designer     | (none - leaf node)            |
| explorer     | (none - leaf node)            |
| librarian    | (none - leaf node)            |
| oracle       | (none - leaf node)            |

## Error Handling

**Configuration Loading**
- Missing config files: Returns empty config (expected behavior)
- Invalid JSON/JSONC: Logs warning, returns null
- Schema validation failure: Logs detailed Zod error format, returns null
- File read errors (non-ENOENT): Logs warning, returns null

**Prompt Loading**
- Missing prompt files: Returns empty object (expected behavior)
- File read errors: Logs warning, continues to next search path

**Preset Resolution**
- Invalid preset name (contains unsafe characters): Ignored, uses root config
- Missing preset: Logs warning with available presets, continues without preset

## Extension Points

**Adding New Agents**
1. Add to `SUBAGENT_NAMES` in `constants.ts`
2. Add default model to `DEFAULT_MODELS`
3. Add to `SUBAGENT_DELEGATION_RULES`
4. Add to schema in `schema.ts` if needed (ManualPlanSchema, FallbackChainsSchema)

**Adding New MCPs**
1. Add to `McpNameSchema` enum in `schema.ts`

**Adding New Configuration Options**
1. Add to `PluginConfigSchema` in `schema.ts`
2. Update deep merge logic in `loader.ts` if nested object
