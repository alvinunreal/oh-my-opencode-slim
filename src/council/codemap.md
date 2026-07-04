# src/council/

## Responsibility
Orchestrates multi-LLM council sessions by spawning parallel councillor agents, collecting their results, and formatting them for synthesis by the council agent. Implements the **Council Pattern** to aggregate diverse model perspectives for higher-quality decision making and complex task resolution.

## Design

### Core Abstraction: CouncilManager
- **Singleton**: One instance per plugin session manages the entire council lifecycle
- **Strategy Pattern**: Configurable execution modes (`parallel` vs `serial`) for councillor orchestration
- **Retry Pattern**: Automatic retry on empty responses with configurable limits
- **Observer Pattern**: Tracks subagent depth to prevent infinite recursion

### Key Components

| Component | Purpose | Type |
|-----------|---------|------|
| `CouncilManager` | Main orchestrator class | Class |
| `runCouncil()` | Entry point for council sessions | Method |
| `runCouncillors()` | Parallel/serial councillor execution | Method |
| `runAgentSession()` | Single councillor lifecycle management | Method |
| `runCouncillorWithRetry()` | Retry logic for councillors | Method |

### Configuration Schema
- **Presets**: Named configurations mapping councillor names to their models and prompts
- **Timeout**: Global timeout for all councillor sessions (default: 180s)
- **Execution Mode**: Parallel (default) or serial execution of councillors
- **Retry Policy**: Number of retries for empty responses (default: 3)

### Councillor Lifecycle
1. **Spawn**: Create child session for each councillor with advisory-only tools
2. **Prompt**: Send formatted prompt with restricted tool access (no file edits, writes, etc.)
3. **Timeout**: Enforce session timeout with graceful abortion
4. **Extract**: Retrieve result from session
5. **Cleanup**: Abort session and release resources

## Flow

### Session Initiation
```
┌─────────────────────────────────────────────────────────────┐
│                    CouncilManager                       │
│  (parentSessionId, prompt, presetName)                 │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    runCouncil()                       │
│  - Resolve preset (default or named)                  │
│  - Validate councillor configuration                   │
│  - Notify parent session (immediate feedback)           │
│  - Launch councillors (parallel/serial)                 │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   runCouncillors()                     │
│  - For each councillor config:                         │
│    - Spawn child session (session.create)               │
│    - Apply depth tracking (if enabled)                 │
│    - Send prompt with restricted tools                 │
│    - Extract result (extractSessionResult)              │
│    - Cleanup session (session.abort)                  │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                 runAgentSession()                      │
│  - Create session with parentID                        │
│  - Register child in depth tracker                     │
│  - Send prompt (promptWithTimeout)                     │
│  - Extract result with reasoning disabled               │
│  - Abort session on completion/cleanup                 │
└─────────────────────────────────────────────────────────────┘
```

### Parallel Execution (Default)
- All councillors launched concurrently with staggered starts (250ms intervals)
- Results collected via `Promise.allSettled()`
- Timeout applies to entire council session, not individual councillors

### Serial Execution (Configurable)
- Councillors executed sequentially in defined order
- Each councillor inherits parent session timeout
- Useful for ordered deliberation or resource-constrained environments

### Error Handling & Retries
1. **Empty responses**: Retry up to `maxRetries` times (provider rate-limiting)
2. **Timeouts**: Immediate failure, no retry
3. **Session failures**: Mark as failed, continue with other councillors
4. **Depth violations**: Block spawn immediately, return error

## Integration

### Dependencies
- **Config**: `PluginConfig` from `../config` (council presets, timeouts)
- **Agents**: `formatCouncillorPrompt()`, `formatCouncillorResults()` from `../agents/council`
- **Session**: `extractSessionResult()`, `promptWithTimeout()` from `../utils/session`
- **Logger**: `log()` from `../utils/logger`
- **Depth Tracker**: `SubagentDepthTracker` from `../utils/subagent-depth` (optional)
- **Client**: `OpencodeClient` from `@opencode-ai/plugin` (session management)

### Consumers
- **Main Plugin**: `src/index.ts` - orchestrates council sessions for complex tasks
- **Council Agent**: Receives formatted results via `formatCouncillorResults()` for synthesis
- **Skills**: Can invoke council sessions for multi-model consensus on decisions

### Configuration Example (from `../config/plugin-config.ts`)
```typescript
council: {
  default_preset: 'default',
  timeout: 180000, // 3 minutes
  councillor_execution_mode: 'parallel',
  councillor_retries: 3,
  presets: {
    default: {
      architect: { model: 'gpt-4', prompt: 'Think like a software architect' },
      critic: { model: 'claude-3', prompt: 'Critique the architect\'s plan' },
      implementer: { model: 'gpt-4', prompt: 'Implement the solution' },
    },
  },
}
```

### Environment Variables & Fallbacks
- **Directory**: Inherited from plugin context (`ctx.directory`)
- **TMUX Enabled**: Controls pane staggering and spawn delays
- **Fallback**: `retry_on_empty` controls whether to retry empty responses

## Key Behaviors

### Tool Restrictions for Councillors
Councillors operate with **advisory-only** tool access:
- ❌ `task` - Cannot spawn new subagents
- ❌ `question` - Cannot ask user questions
- ❌ `edit`, `write`, `apply_patch` - Cannot modify files
- ❌ `ast_grep_replace`, `bash` - Cannot execute commands
- ✅ `read` - Can read files for analysis

This ensures councillors provide guidance without side effects.

### Depth Tracking
- Prevents infinite recursion by tracking subagent depth
- Configurable maximum depth (default: 3 levels)
- Logs violations and blocks spawn attempts

### Notifications
- Sends immediate feedback to parent session on council start
- Message format: `⎔ Council starting - ${count} councillors launching - ctrl+x ↓ to watch`

## Performance Considerations

- **Parallel execution**: Optimal for most cases, maximizes throughput
- **Staggered starts**: Reduces tmux pane creation contention (250ms intervals)
- **Timeout alignment**: Single timeout for entire council avoids cascading delays
- **Resource cleanup**: Guaranteed session abortion in `finally` block prevents leaks

## Error Scenarios & Recovery

| Scenario | Behavior | Recovery |
|----------|----------|----------|
| No council config | Return error immediately | User must configure council in plugin config |
| Invalid preset | Return error with available presets | User selects valid preset or uses default |
| Empty preset | Return error about no councillors | User adds councillors to preset |
| All councillors fail | Return error with all failures | Investigate model availability or prompts |
| Timeout | Mark timed_out status | Increase timeout or reduce council size |
| Depth exceeded | Block spawn, return error | Increase maxDepth or simplify task |
| Provider rate-limiting | Retry up to maxRetries | Automatic recovery |

## Testing Points

- Preset resolution (default vs named)
- Parallel vs serial execution modes
- Retry logic for empty responses
- Depth tracking and blocking
- Tool restrictions enforcement
- Session lifecycle (create → prompt → extract → abort)
- Timeout behavior
- Error propagation and formatting
- Councillor result formatting for synthesis
