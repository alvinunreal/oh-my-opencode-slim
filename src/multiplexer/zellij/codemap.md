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
- Manages Zellij binary discovery, availability checks, and version gating
- Handles two operational modes via `paneMode`:
  - `'agent-tab'` (default): Creates dedicated "opencode-agents" tab
  - `'current-tab'`: Creates panes in user's current tab

#### Version Gating
- `isAvailable()` runs `zellij --version` and requires Zellij >= 0.44.1
- Older releases (or unparsable version output) make `isAvailable()` return
  `false`, so the backend is silently skipped
- Required because the adapter relies on stable pane-id targeting that only
  exists in 0.44.1+: `rename-pane <name> -p <paneId>`,
  `write-chars <chars> -p <paneId>`, `list-panes --json --tab --all` with
  stable `tab_id`, and `new-pane --tab-id` for cross-tab creation

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
- **Command Construction**: Builds `opencode attach` commands with session, server URL, directory, and the resolved absolute host executable (falls back to bare `opencode`; `OPENCODE_BIN` override honored) — pane shells may lack `opencode` on `PATH` (#514)
- **Pane Naming**: Truncates description to 30 chars for pane titles
- **Shell Safety**: Uses `quoteShellArg()` to properly escape shell arguments

## Flow

### Agent-Tab Mode (Default)
```
1. Plugin loads → ZellijMultiplexer instantiated with layout='main-vertical'
2. First sub-agent session:
   - ensureAgentTab() creates "opencode-agents" tab if not exists; `new-tab`
     moves client focus to the new tab, so a freshly created agent tab is
     immediately followed by go-to-tab-by-id back to the parent tab
   - runInPane() renames the default pane and writes the OpenCode attach
     command via direct pane-id targeting (rename-pane/write-chars with
     `-p <paneId>`; no focus-pane, which is invalid CLI syntax)
   - firstPaneUsed flag set to true
3. Subsequent sub-agent sessions:
   - createPaneInAgentTab() creates new pane in agent tab
   - Switches to agent tab, creates pane, switches back to the parent tab
     (resolved from the parent pane's ZELLIJ_PANE_ID)
   - If `--direction` new-pane is silently dropped (crowded tab), the create
     is retried once without the direction hint
4. All spawnPane creation sequences are serialized through a promise chain
   (`paneOpsChain`): concurrent sub-agent starts cannot interleave
   tab/focus-mutating actions (new-tab, go-to-tab-by-id, new-pane), so a
   cross-tab create cannot race another create's focus restore
5. Session completion:
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
2. isAvailable() gates on `zellij --version` >= 0.44.1
3. getParentTabId() resolves the parent tab from ZELLIJ_PANE_ID via
   findTabIdForPane(); only successful lookups are cached — a failed query is
   re-tried on the next spawn so a transient list-panes failure is not
   permanently treated as "no parent tab". current-tab-info is NOT used: it is
   client-bound and fails from pane child processes
4. getFirstPaneInTab() / findTabIdForPane() use listPanesJson()
   (list-panes --json --tab --all) filtered by tab_id
5. findTabIdForPane() correlates pane IDs with tab IDs for parent tab tracking
```

## Integration Points

### Dependencies
- **Zellij**: External terminal multiplexer (binary must be in PATH)
- **Multiplexer Interface**: Implements `src/multiplexer/types.ts::Multiplexer`
- **Config Schema**: Uses `src/config/schema.ts::MultiplexerLayout` and `ZellijPaneMode`
- **Utils**: Uses `src/utils/compat.ts::crossSpawn` for cross-platform process spawning

### Consumers
- **Main Plugin**: `src/index.ts` instantiates ZellijMultiplexer via multiplexer factory
- **Council Agents**: `src/agents/council.ts` and `src/agents/council-agents.ts` use multiplexer for session pane management
- **Session Lifecycle**: MultiplexerSessionManager coordinates pane creation/cleanup with session events

### Environment
- **ZELLIJ_PANE_ID**: Used to locate the parent OpenCode pane's tab; drives
  `current-tab` targeting and the `agent-tab` restore step
- **Zellij Actions**: All communication via Zellij's CLI action system
  (new-tab, new-pane, rename-pane, write-chars, close-pane, etc.); pane
  mutations use direct pane-id targeting (`-p <paneId>`) instead of focus
  switching

### Error Handling
- Graceful degradation: Returns `{ success: false }` on failures
- Crowded-split fallback: a `--direction` new-pane that is silently dropped
  (exit 0, no `terminal_*` id) is retried once without the direction hint,
  letting Zellij place the pane in the largest free space
- Write failures in runInPane() return `false` — never a silent success
- Rename failures are best-effort and do not mask attach write failures
- Tab/pane discovery falls back to text parsing if JSON unavailable
- Unresolvable parent tab → safe degradation, never a guessed tab id
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
- `parentTabId` / `parentTabResolved`: Caches the parent tab ID after a
  successful lookup only; failed lookups are retried on the next spawn
- `paneOpsChain`: Promise chain serializing spawnPane creation sequences
  (tab/focus-mutating actions) so concurrent spawns cannot race

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
- Requires Zellij >= 0.44.1 (older versions make `isAvailable()` return false;
  0.44.0 lacks `new-pane --tab-id`)
- Zellij silently drops `--direction` splits beyond ~4 stacked panes; the
  adapter falls back to an undirected create, which still succeeds but uses
  Zellij's own largest-free-space placement
- Zellij doesn't support exact main pane sizing like tmux
- Layout configuration only affects future pane creation directions
- Requires Zellij to be installed and in PATH
- Pane naming limited to 30 characters due to Zellij constraints
- No dynamic layout rebalancing after initial pane creation