# src/multiplexer/zellij/

## Responsibility
Implements a Zellij-based multiplexer adapter that creates and manages terminal panes for sub-agent sessions within Zellij workspaces. Provides pane lifecycle management, session isolation, and graceful shutdown for OpenCode's multiplexer interface.

## Design

### Architecture Pattern
- **Adapter Pattern**: Wraps Zellij's CLI actions to implement the Multiplexer interface
- **State Machine**: Tracks pane/tab state (agentTabId, firstPaneId, firstPaneUsed, parentTabId)

### Core Components

#### ZellijMultiplexer Class
- Implements `Multiplexer` interface with `type = 'zellij'`
- Manages Zellij binary discovery and availability checks
- Handles two operational modes via `paneMode`:
  - `'agent-tab'` (default): Creates dedicated "opencode-agents" tab
  - `'current-tab'`: Creates panes in user's current tab

#### Session Management
- **Pane Creation**: Uses `spawnPane()` to create new panes with OpenCode attach commands
- **Tab Management**: Ensures "opencode-agents" tab exists, tracks tab/pane IDs
- **Lifecycle**: Implements `closePane()` with graceful Ctrl+C shutdown before pane termination

#### Layout Handling
- Maps `MultiplexerLayout` to Zellij pane directions:
  - `'main-vertical'` → `'right'` (vertical split)
  - `'main-horizontal'` → `'down'` (horizontal split)
  - `'even-horizontal'`, `'even-vertical'`, `'tiled'` → `null` (no direction, Zellij handles tiling)

### Shell Integration
- **Command Construction**: Builds `opencode attach` commands with session, server URL, and directory
- **Pane Naming**: Truncates description to 30 chars for pane titles
- **Shell Safety**: Uses `quoteShellArg()` to properly escape shell arguments

## Flow

### Agent-Tab Mode (Default)
```
1. Plugin loads → ZellijMultiplexer instantiated with layout='main-vertical'
2. First sub-agent session:
   - ensureAgentTab() creates "opencode-agents" tab if not exists
   - runInPane() focuses default pane and writes OpenCode attach command
   - firstPaneUsed flag set to true
3. Subsequent sub-agent sessions:
   - createPaneInAgentTab() creates new pane in agent tab
   - Switches to agent tab, creates pane, switches back to original tab
4. Session completion:
   - closePane() sends Ctrl+C → delay → kill-pane
   - Pane removed from Zellij workspace
```

### Current-Tab Mode
```
1. Plugin loads → ZellijMultiplexer instantiated with paneMode='current-tab'
2. spawnPane() calls createPaneInCurrentTab()
3. Creates pane directly in user's current tab using parentTabId
4. No tab switching overhead; user remains in their original tab
```

### Tab/Pane Discovery
```
1. findTabByName() uses Zellij's list-tabs action
   - Tries JSON output first (--json flag)
   - Falls back to text parsing if JSON unavailable
2. getCurrentTabId() queries current-tab-info --json
3. listPanes() parses list-panes output to track active panes
4. findTabIdForPane() correlates pane IDs with tab IDs for parent tab tracking
```

## Integration Points

### Dependencies
- **Zellij**: External terminal multiplexer (binary must be in PATH)
- **Multiplexer Interface**: Implements `src/multiplexer/types.ts::Multiplexer`
- **Config Schema**: Uses `src/config/schema.ts::MultiplexerLayout` and `ZellijPaneMode`
- **Utils**: Uses `src/utils/compat.ts::crossSpawn` for cross-platform process spawning

### Consumers
- **Main Plugin**: `src/index.ts` instantiates ZellijMultiplexer via multiplexer factory
- **Council Manager**: `src/council/council-manager.ts` uses multiplexer for session pane management
- **Session Lifecycle**: MultiplexerSessionManager coordinates pane creation/cleanup with session events

### Environment
- **ZELLIJ_PANE_ID**: Used to detect parent pane location when in current-tab mode
- **Zellij Actions**: All communication via Zellij's CLI action system (new-tab, new-pane, close-pane, etc.)

### Error Handling
- Graceful degradation: Returns `{ success: false }` on failures
- Tab/pane discovery falls back to text parsing if JSON unavailable
- Layout changes are no-op after pane creation (Zellij doesn't support dynamic layout rebalancing)

## Key Implementation Details

### Pane Identity Management
- Zellij pane IDs are strings like "terminal_0", "terminal_1"
- `normalizePaneId()` strips "terminal_" prefix for numeric comparisons
- Tab IDs are numeric strings (e.g., "1", "2")

### Shell Command Safety
- `buildOpencodeAttachCommand()` constructs safe shell commands with quoted arguments
- `buildShellLaunchCommand()` wraps commands in `sh -lc` for proper execution
- Prevents shell injection via `quoteShellArg()` with proper escaping

### State Tracking
- `agentTabId`: Caches the "opencode-agents" tab ID after creation
- `firstPaneId`: Stores the initial pane ID for first sub-agent reuse
- `firstPaneUsed`: Boolean flag prevents duplicate first pane usage
- `parentTabId`: Caches parent tab ID for current-tab mode optimization

### Graceful Shutdown Sequence
```typescript
1. send-keys C-c to pane (graceful interrupt)
2. 250ms delay for process cleanup
3. kill-pane with pane ID
```

## Testing
- Test file: `src/multiplexer/zellij/index.test.ts`
- Tests cover: availability checks, pane creation in both modes, tab management, and cleanup
- Uses mocking for Zellij binary interactions via crossSpawn

## Performance Considerations
- Binary availability cached after first check (`hasChecked` flag)
- Tab discovery optimized with JSON output when available
- Minimal state maintained; most operations are Zellij CLI calls
- No polling; relies on Zellij's event-driven pane/tab management

## Limitations
- Zellij doesn't support exact main pane sizing like tmux
- Layout configuration only affects future pane creation directions
- Requires Zellij to be installed and in PATH
- Pane naming limited to 30 characters due to Zellij constraints
- No dynamic layout rebalancing after initial pane creation