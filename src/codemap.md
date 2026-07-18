# src/

## Responsibility

Core plugin implementation for **oh-my-opencode-slim**, providing:
- Main plugin initialization and OpenCode integration (`index.ts`)
- Terminal User Interface (TUI) sidebar plugin for agent status display (`tui.ts`)
- TUI state persistence and synchronization across sessions (`tui-state.ts`)

This directory serves as the primary entry point for the plugin's runtime behavior, configuration system, and user-facing UI components.

## Design

### Architectural Patterns

- **Plugin Pattern**: The plugin follows OpenCode's plugin architecture with a single exported plugin function that returns agent, tool, and MCP registrations
- **Facade Pattern**: `index.ts` acts as a facade that composes multiple subsystems (agents, tools, MCPs, hooks, multiplexer)
- **Observer Pattern**: Event-driven architecture using OpenCode's event system for session lifecycle, message updates, and tool execution
- **Strategy Pattern**: Runtime model selection and fallback via `ForegroundFallbackManager`
- **Singleton Pattern**: `MultiplexerSessionManager` maintains single instance for task session management

### Data Flow

```
OpenCode Core → Plugin Initialization (index.ts)
  → Agent Registration (createAgents/getAgentConfigs)
  → Tool Registration (createCancelTaskTool, etc.)
  → MCP Registration (createBuiltinMcps)
  → Hook Registration (auto-update, phase reminders, etc.)
  → Event Subscription (session lifecycle, message updates, tool execution)
  → Runtime State Tracking (tui-state.ts)
  → TUI Rendering (tui.ts → sidebar_content slot)
```

### Key Components

| File | Role | Dependencies |
|------|------|--------------|
| `index.ts` | Main plugin entry, orchestrates all subsystems | Config system, agent factories, tool creators, multiplexer |
| `tui.ts` | TUI sidebar plugin for agent model display | tui-state.ts, config constants |
| `tui-state.ts` | Persistent state management for TUI | Node.js fs/promises, os module |

## Flow

### Plugin Initialization Flow (index.ts)

1. **Config Loading**: `loadPluginConfig()` reads and validates plugin configuration
2. **Agent Creation**: `createAgents()` instantiates agent definitions with prompts and permissions
3. **Agent Configuration**: `getAgentConfigs()` merges defaults with user overrides and runtime presets
4. **Tool Registration**: Tools are created conditionally based on config (council, cancel_task, webfetch, AST-grep)
5. **MCP Registration**: Built-in MCPs are created (filesystem, resource, tools, etc.)
6. **Multiplexer Setup**: Multiplexer session manager initialized for task tool sessions
7. **Hook Initialization**: Auto-update checker, phase reminders, skill filters, etc.
8. **Runtime Model Resolution**: Resolves model arrays to single models for startup
9. **TUI State Sync**: `recordTuiAgentModels()` captures resolved models/variants for TUI display
10. **Health Check**: Validates minimum agent/tool/MCP registrations
11. **Companion Management**: Ensures companion version compatibility

### TUI Rendering Flow (tui.ts)

1. **Plugin Registration**: TUI plugin registered with OpenCode's TUI system via `tui` export
2. **Version Detection**: Reads plugin version from package.json or uses 'dev'
3. **Config Validation**: Checks if current directory has valid plugin config
4. **Snapshot Loading**: Reads agent models/variants from `tui-state.ts`
5. **Live Updates**: Sets up interval to refresh snapshot every 1000ms
6. **Sidebar Rendering**: Renders sidebar with:
   - Plugin header (OMO-Slim + version)
   - Config status warning (if invalid)
   - Agent list with model/variant details
7. **Lifecycle Management**: Cleans up interval on dispose

### State Persistence Flow (tui-state.ts)

1. **State Path Resolution**: Determines XDG-compliant state directory (`~/.local/share/opencode/storage/oh-my-opencode-slim/tui-state.json`)
2. **Snapshot Operations**:
   - `readTuiSnapshot()`: Reads and parses state file (returns empty snapshot on error)
   - `readTuiSnapshotAsync()`: Async variant for TUI rendering
   - `recordTuiAgentModels()`: Updates both agent models and variants atomically
   - `recordTuiAgentModel()`: Updates single agent's model/variant
3. **Atomic Writes**: State updates are atomic (read → mutate → write with timestamp)
4. **Error Handling**: All operations are best-effort; failures don't crash plugin

### Event Handling Flow (index.ts)

Key event flows:

1. **Session Lifecycle**:
   - `session.created` → register child session
   - `session.status` → multiplexer session management and companion updates
   - `session.deleted` → cleanup session agent map and companion state

2. **Message Updates**:
   - `message.updated` → record agent/model usage in TUI state

3. **Tool Execution**:
   - `tool.execute.before` → apply patch and task session hooks
   - `tool.execute.after` → post-tool hooks (retry guidance, JSON error recovery, file-tool nudges)

4. **Chat Integration**:
   - `chat.message` → track session → agent mapping
   - `experimental.chat.system.transform` → inject orchestrator prompt for serve mode
   - `experimental.chat.messages.transform` → phase reminders, skill filtering, image attachment processing

5. **Command Execution**:
   - `command.execute.before` → interview, preset, deepwork, and reflect command hooks

## Integration

### Consumers

- **OpenCode Core**: Main plugin entry point consumed by OpenCode's plugin system
- **TUI System**: `tui.ts` slot registration consumed by OpenCode's TUI renderer
- **Agents**: Agent configurations consumed by OpenCode's agent registry
- **Tools**: Tool definitions consumed by OpenCode's tool system
- **MCPs**: MCP definitions consumed by OpenCode's MCP registry

### Dependencies

- **Config System** (`src/config/`): Configuration loading, validation, and runtime presets
- **Agents** (`src/agents/`): Agent personalities and permission sets
- **Tools** (`src/tools/`): Tool implementations (council, webfetch, AST operations)
- **Hooks** (`src/hooks/`): Lifecycle hooks for auto-update, phase reminders, etc.
- **Multiplexer** (`src/multiplexer/`): Tmux/Zellij session management for child sessions
- **Council** (`src/agents/council.ts`, `src/agents/council-agents.ts`): Multi-LLM council orchestration
- **Companion** (`src/companion/`): Companion version management
- **Utils** (`src/utils/`): Logger, environment checks

### Cross-Directory Flow

1. **Plugin Initialization**: `src/index.ts` imports and composes all subsystems
2. **State Synchronization**: TUI state in `src/tui-state.ts` is updated during plugin init and message events
3. **UI Integration**: TUI plugin in `src/tui.ts` reads state and renders sidebar
4. **Event Propagation**: Events flow from OpenCode → plugin handlers → subsystems → state updates

### Configuration Integration

- Plugin config loaded via `loadPluginConfig()` with support for:
  - User overrides from `~/.config/opencode/oh-my-opencode-slim.json`
  - Runtime presets via `/preset` command
  - Environment-based disablement via `OH_MY_OPENCODE_SLIM_DISABLE`
- Agent configurations merged with user settings from OpenCode config
- Model resolution supports both string models and array-based fallback chains

### Error Handling & Resilience

- **Config Errors**: Non-fatal; plugin continues with defaults and logs warnings
- **State Errors**: Non-fatal; TUI falls back to empty state
- **Event Errors**: Wrapped in try/catch; plugin continues operation
- **Dependency Failures**: Health checks detect missing dependencies (e.g., jsdom for webfetch)

## Testing & Validation

- **Type Safety**: TypeScript strict mode ensures type correctness
- **Health Checks**: Validates minimum agent/tool/MCP registrations on init
- **Config Validation**: Schema-based validation via Zod in config system
- **TUI State**: Best-effort persistence; failures don't affect core functionality

## Performance Considerations

- **Live Updates**: TUI refreshes every 1000ms (configurable via interval)
- **Atomic State**: State writes are atomic to prevent corruption
- **Lazy Initialization**: Some subsystems (e.g., webfetch probe) run async without blocking init
- **Event-Driven**: Minimal polling; relies on OpenCode's event system

## Future Extensions

- **Dynamic Agent Registration**: Support runtime agent addition/removal
- **State Migration**: Versioned state format for breaking changes
- **TUI Customization**: Allow user-defined sidebar layouts
- **Performance Metrics**: Track and display plugin performance in TUI