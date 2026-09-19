# src/

## Responsibility

Core plugin implementation for **oh-my-opencode-slim**, providing:
- Main plugin initialization and OpenCode integration (`index.ts`)
- Dual v1/v2 host export: `default.server` (v1) + `default.setup` (v2 adapter via `src/v2/`)
- Terminal User Interface (TUI) sidebar plugin for agent status display (`tui.ts`)
- Client-side multiplexer pane lifecycle, wired only from the TUI entry (`src/multiplexer/client/`)
- TUI state persistence and synchronization across sessions (`tui-state.ts`)
- Three-level TUI `/preset` manager (`tui-preset.ts`)
- Installer-managed plugin-entry marker (`plugin-entry.ts`)
- Plugin init health-check thresholds and helpers (`health-check.ts`)

This directory serves as the primary entry point for the plugin's runtime behavior, configuration system, and user-facing UI components.

## Design

### Architectural Patterns

- **Plugin Pattern**: The plugin follows OpenCode's plugin architecture with a single exported plugin function that returns agent, tool, and MCP registrations
- **Facade Pattern**: `index.ts` acts as a facade that composes multiple subsystems (agents, tools, MCPs, hooks)
- **Observer Pattern**: Event-driven architecture using OpenCode's event system for session lifecycle, message updates, and tool execution
- **Strategy Pattern**: Runtime model selection and fallback via `ForegroundFallbackManager`
- **Client-local pane lifecycle**: `src/multiplexer/client/` runs only in the TUI entry's dependency graph (per-client pane map, in-process uniqueness, stable-idle close); the server entry never reaches it (invariant I1, enforced by `dependency-contract.test.ts`)
- **Admission runtime lease**: `admission-runtime.ts` scopes the background
  scheduler and pending-call tracker per directory, retaining them across
  immediate plugin-generation replacement and disposing them after the last
  owner is gone.

### Data Flow

```
OpenCode Core → Plugin Initialization (index.ts)
  → Agent Registration (createAgents/getAgentConfigs)
  → Tool Registration (createCancelTaskTool, etc.)
  → MCP Registration (createBuiltinMcps)
  → Hook Registration (auto-update, phase reminders, cache monitor, etc.)
  → Event Subscription (session lifecycle, message updates, tool execution)
  → Runtime State Tracking (tui-state.ts)
  → TUI Rendering (tui.ts → sidebar_content slot)
  → TUI Client Pane Lifecycle (multiplexer/client/tui-wiring.ts)
  → TUI /preset Management (tui-preset.ts → preset-switch.ts)
```

### Key Components

| File | Role | Dependencies |
|------|------|--------------|
| `index.ts` | Main plugin entry, orchestrates all server-side subsystems; exports dual `server`/`setup` default | Config system, agent factories, tool creators, hooks, v2 adapter |
| `admission-runtime.ts` | Per-directory scheduler/pending-call runtime lease | Background task concurrency, task-session pending calls |
| `tui.ts` | TUI sidebar plugin for agent model display; wires the client-side multiplexer pane lifecycle | tui-state.ts, config constants, multiplexer/client |
| `tui-state.ts` | Persistent state management for TUI | Node.js fs/promises, os module |
| `tui-preset.ts` | Three-level `/preset` manager (preset list → agents → agent edit) using `api.ui` dialogs | preset-switch.ts, config loader/constants |
| `plugin-entry.ts` | Installer-managed plugin entry marker and `PluginEntry` type | none |
| `health-check.ts` | Init health-check thresholds and disabled-tool-aware minimum tool count | none (kept internal, not re-exported) |

## Flow

### Plugin Initialization Flow (index.ts)

1. **Config Loading**: `loadPluginConfig()` reads and validates plugin configuration; `RuntimeConfig` singleton seeded and host config captured
2. **Agent Creation**: `createAgents()` instantiates agent definitions (incl. dynamic councillors) with prompts and permissions
3. **Agent Configuration**: `getAgentConfigs()` merges defaults with user overrides and runtime presets
4. **Tool Registration**: Tools are created conditionally based on config (task_cancel, task_message, task_revive, task_status, task_result, wait_for_user, webfetch, AST-grep, acp_run)
5. **MCP Registration**: Built-in MCPs are created (context7, gh_grep)
6. **Hook Initialization**: Auto-update checker, phase reminders, skill filters, task-session manager, cache monitor, orchestrator-wake scheduler, etc.
7. **Runtime Model Resolution**: Resolves model arrays to single models for startup
8. **TUI State Sync**: `recordTuiAgentModels()` captures resolved models/variants for TUI display
9. **Health Check**: Validates agent/tool/MCP counts against `HEALTH_CHECK` thresholds, adjusted for disabled baseline tools via `minimumExpectedToolCount`
10. **Companion Management**: Ensures companion version compatibility

The server entry does not initialize any multiplexer/pane subsystem: pane
lifecycle lives in the TUI entry's dependency graph (`multiplexer/client/`).

### TUI Rendering Flow (tui.ts)

1. **Plugin Registration**: TUI plugin registered with OpenCode's TUI system via `tui` export
2. **Version Detection**: Reads plugin version from package.json or uses 'dev'
3. **Config Validation**: Checks if current directory has valid plugin config
4. **Snapshot Loading**: Reads agent models, variants, and per-session activity
   from `tui-state.ts`
5. **Live Updates**: Refreshes persisted state every 1000ms and reactively
   advances 100ms animation frames only while agents are active
6. **Pane Lifecycle Wiring**: `createTuiPaneWiring()` resolves admission from
   the client's own environment, initializes plugin logging, reflects the
   server URL, subscribes to session events, and drives per-client pane
   create/close/rebuild plus the periodic reconcile sweep
7. **Sidebar Rendering**: Renders sidebar with:
   - Plugin header (OMO-Slim + version)
   - Config status warning (if invalid)
   - Agent list with model/variant details and Braille activity indicators
8. **Lifecycle Management**: Cleans up refresh/animation timers, unsubscribes
   pane events, stops timers, and best-effort closes this client's panes on
   dispose

### State Persistence Flow (tui-state.ts)

1. **State Path Resolution**: Determines XDG-compliant state directory (`~/.local/share/opencode/storage/oh-my-opencode-slim/tui-state.json`)
2. **Snapshot Operations**:
   - `readTuiSnapshot()`: Reads and parses state file (returns empty snapshot on error)
   - `readTuiSnapshotAsync()`: Async variant for TUI rendering
   - `recordTuiAgentModels()`: Updates both agent models and variants atomically
   - `recordTuiAgentModel()`: Updates single agent's model/variant
   - `recordTuiAgentActivity()`: Tracks active agents by session so concurrent
     runs of the same agent remain visible until all runs finish
   - `clearTuiAgentActivities()`: Removes stale activity during startup
3. **Atomic Writes**: Cross-process file locking serializes each read → mutate →
   atomic rename transaction, with dead-owner and aged-lock recovery
4. **Error Handling**: All operations are best-effort; failures don't crash plugin
5. **Instance Cleanup**: On shutdown, each plugin instance removes only sessions
   it marked active, preserving activity owned by other running instances

### Event Handling Flow (index.ts)

Key event flows:

1. **Session Lifecycle**:
   - `session.created` → register child session
   - `session.status` → Companion updates and TUI activity state (pane
     lifecycle is handled separately by the TUI client wiring)
   - `session.deleted` → cleanup session agent map, Companion state, and TUI
     activity state

2. **Message Updates**:
   - `message.updated` → record agent/model usage in TUI state

3. **Tool Execution**:
   - `tool.execute.before` → apply patch and task session hooks
   - `tool.execute.after` → post-tool hooks (retry guidance, JSON error recovery, file-tool nudges)

4. **Chat Integration**:
   - `chat.message` → track session → agent mapping and mark TUI activity
   - `experimental.chat.system.transform` → inject orchestrator prompt for serve mode
   - `experimental.chat.messages.transform` → phase reminders, skill filtering, image attachment processing

5. **Command Execution**:
   - `command.execute.before` → interview, deepwork, reflect, and loop command hooks (preset switching moved to the TUI)

6. **Cache Telemetry**:
   - `message.updated` (completed assistant requests) → cache monitor observes `tokens.cache.read/write` and logs prompt-cache bust/plateau warnings

## Integration

### Consumers

- **OpenCode Core**: Main plugin entry point consumed by OpenCode's plugin system
- **TUI System**: `tui.ts` slot registration consumed by OpenCode's TUI renderer
- **Agents**: Agent configurations consumed by OpenCode's agent registry
- **Tools**: Tool definitions consumed by OpenCode's tool system
- **MCPs**: MCP definitions consumed by OpenCode's MCP registry

### Dependencies

- **Config System** (`src/config/`): Configuration loading, validation, the `RuntimeConfig` runtime-state singleton, and runtime presets
- **Agents** (`src/agents/`): Agent personalities and permission sets
- **Tools** (`src/tools/`): Tool implementations (task lifecycle controls, webfetch, AST operations, ACP)
- **Hooks** (`src/hooks/`): Lifecycle hooks for auto-update, phase reminders, cache monitor, orchestrator wake, etc.
- **Multiplexer** (`src/multiplexer/`): Client-side pane lifecycle (`client/`) plus tmux/Zellij/Herdr/cmux/kitty adapters; wired only from the TUI entry
- **Council** (`src/agents/council.ts`, `src/agents/council-agents.ts`): Multi-LLM council orchestration
- **Companion** (`src/companion/`): Companion version management
- **Utils** (`src/utils/`): Logger, environment checks, background job board/supervisor, session status
- **V2 Adapter** (`src/v2/`): Wraps the v1 factory for the v2 host via `default.setup`

### Cross-Directory Flow

1. **Plugin Initialization**: `src/index.ts` imports and composes the server-side subsystems; the TUI entry composes its own sidebar and pane-lifecycle wiring
2. **State Synchronization**: TUI state in `src/tui-state.ts` is updated during plugin init and message events
3. **UI Integration**: TUI plugin in `src/tui.ts` reads state and renders sidebar
4. **Event Propagation**: Events flow from OpenCode → plugin handlers → subsystems → state updates

### Configuration Integration

- Plugin config loaded via `loadPluginConfig()` with support for:
  - User overrides from `~/.config/opencode/oh-my-opencode-slim.json`
  - Preset switching via the TUI `/preset` manager (persisted to the config file, applied on next reload)
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

- **Live Updates**: TUI reads state every 1000ms and animates active Braille
  indicators every 100ms without extra disk reads
- **Atomic State**: State writes are atomic to prevent corruption
- **Lazy Initialization**: Some subsystems (e.g., webfetch probe) run async without blocking init
- **Event-Driven**: Minimal polling; relies on OpenCode's event system

## Future Extensions

- **Dynamic Agent Registration**: Support runtime agent addition/removal
- **State Migration**: Versioned state format for breaking changes
- **TUI Customization**: Allow user-defined sidebar layouts
- **Performance Metrics**: Track and display plugin performance in TUI
