# src/hooks/tool-loop-guard/

## Responsibility

Prevents infinite tool call loops by detecting repeated identical tool calls within a session. The guard identifies when a model re-issues the exact same tool call (same tool, same arguments) consecutively with no progress and responds with:

- **Warning at N=3**: Appends corrective text to tool output, instructing the model to stop and change approach
- **Block at M=5**: Refuses the next identical call after confirmation, terminating the loop permanently

The guard operates per session and distinguishes between different types of tools:

- **Read-only file tools** (read, grep, glob): Hard-block after M confirmations to prevent infinite loops
- **Task supervision** (task_status): Warn-only to avoid deadlocking result retrieval
- **Task lifecycle tools** (task, task_cancel, task_message, task_revive): Exempt entirely (managed by task-session-manager)
- **Wait tools** (wait_for_user, wait_for_background_tasks): Dedicated per-turn counter that blocks on third consecutive call

The run counter only advances in `tool.execute.after` when arguments and output are byte-identical to the previous call. Any new information resets the counter, allowing legitimate re-reads after file changes.

## Design

### Core Architecture
- **Hook Factory**: `createToolLoopGuardHook()` returns `ToolLoopGuardHook` interface
- **Session Tracking**: `Map<string, SessionState>` tracks per-session call history
- **State Management**: 
  - `SessionState`: `last`, `runs`, `lastOutput` fingerprints
  - `CallState`: Associates `after` calls with `before` calls
  - `TaskSupervisionState`: Separate tracking for task supervision tools
- **Global State**: Closure-scoped per-factory Maps (`sessions`, `callKeys`, `taskSupervision`, `waitRuns`, `userMessageIdentities`), bounded at `MAX_TRACKED_SESSIONS = 512` with FIFO (oldest-inserted) eviction via `keepSessionsBounded()`

### Key Components
- **fingerprint()**: Deterministic tool+args hash insensitive to key order
- **stableStringify()**: Recursive deterministic JSON stringifier
- **Exemption Lists**: Hard-coded tool categories with different protection levels
- **Wait Tool Logic**: Separate per-turn counter for wait tools (end-turn semantics)
- **Task Supervision Logic**: Separate tracking for task_status result reads

### Algorithms
- **Loop Detection**: Counter advances only when args AND output match previous call exactly
- **Wait Tool Counting**: per-turn counter incremented on each wait-tool call in `tool.execute.after`; cleared by `observeNewUserMessage()` and `resetTurn()` (`waitRuns.delete`)
- **Task Supervision**: Separate stream tracking lifecycle state
- **Session Cleanup**: `resetSession()` clears all per-session state

## Flow

### Hook Execution Flow
```
tool.execute.before (input: tool, sessionID, callID)
    ↓
Check if tool is exempt (task lifecycle, etc.)
    ↓
If hard-blocking tool:
    - Verify identical consecutive run (check last fingerprint/output)
    - If run >= BLOCK_AT: throw error
    ├─ else: continue
    └─ (warn case handled in after-hook)
    ↓
Proceed with normal tool execution
    ↓
tool.execute.after (input: tool, sessionID, callID, output)
    ↓
Correlate with matching before-call via CallState
    ↓
Check if tool is exempt
    ↓
If warning-only tool:
    - If args/output match last: increment run
    - Log warning when run reaches WARN_AT
    - Append warning text to output
    ↓
If hard-blocking tool:
    - If args/output match last: increment run
    - If run >= BLOCK_AT: throw error (next call blocked)
    ↓
Update session fingerprints (last, lastOutput)
    ↓
Check if wait tool (tool name only, ignore args/output)
    ↓
If wait tool: increment per-turn counter
    ↓
Handle task supervision tools separately
```

### Session Management Flow
```
New user message → observeNewUserMessage(sessionID, messageID)
    ↓
Reset per-turn wait tool counter for affected sessions
    ↓
External user activity → resetTurn(sessionID) 
    ↓
Session deletion → resetSession(sessionID)
    ↓
Plugin recreation → resetForTests()
```

### Task Supervision Flow
```
task_status calls
    ↓
Track lifecycle state from output
    ↓
Maintain separate run counter per taskID/lifecycle
    ↓
Warn at N=3, never block
    ↓
Reset on parent turn boundary or meaningful action
```

## Integration

### Consumers
- **Main Plugin** (`src/index.ts`): Registers the guard via `createToolLoopGuardHook()`
- **All tool calls**: Intercepts `tool.execute.before` and `tool.execute.after` events
- **Session lifecycle**: Integrates with OpenCode session management for cleanup

### Dependencies
- **Logger**: Structured logging for detection and warning events
- **No external APIs**: Pure Node.js implementation with no runtime dependencies
- **No globalThis coordination**: all state lives in closure-scoped Maps inside the hook factory

### Configuration
- **Hard-coded thresholds**: LOOP_GUARD_WARN_AT=3, LOOP_GUARD_BLOCK_AT=5
- **Tool classifications**: Hard-coded exemption and block lists
- **No runtime configuration**: All behavior determined by code constants

### Performance Considerations
- **Bounded tracking**: Max 512 sessions per Map with FIFO (oldest-inserted) eviction
- **Fingerprinting**: deterministic `stableStringify()` for arguments and SHA-256 for retained output fingerprints
- **Minimal overhead**: Only runs for non-exempt tools
- **Selective updates**: Session state updates only on relevant tool calls

### Observability
- **Structured logging**: Tracks loop detection events and warning issuance
- **Error messages**: Clear instructions for stopping loops
- **State monitoring**: Session count and behavior tracking

## Testing Considerations

Key test scenarios:
- **Exact call repetition**: Identical tool+args+output detection
- **Argument variations**: Different args reset counter
- **Output changes**: Different outputs reset counter
- **Exemption verification**: Task lifecycle tools never tracked
- **Wait tool handling**: Per-turn counter logic
- **Task supervision**: Separate tracking for task_status result reads
- **Session isolation**: No cross-session contamination
- **Edge cases**: Empty args, null outputs, special characters
- **Concurrent calls**: Parallel call handling
- **Session boundaries**: Cleanup and reset scenarios
