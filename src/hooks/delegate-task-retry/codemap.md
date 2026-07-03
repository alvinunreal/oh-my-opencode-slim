# src/hooks/delegate-task-retry/

## Responsibility
Orchestrates automatic retry guidance for failed task delegation attempts by detecting specific error patterns and injecting contextual retry suggestions into tool output.

## Design

### Core Components
- **Error Detection**: Pattern-based error classifier (`detectDelegateTaskError`) that identifies known delegate-task failure modes from tool output
- **Retry Guidance Builder**: Constructs actionable retry suggestions with context-specific fix hints
- **Available Agents Extractor**: Parses tool output to discover currently permitted agents for targeted retries

### Architecture Pattern
Uses the **Observer** pattern via OpenCode's plugin hook system:
- Subscribes to `tool.execute.after` lifecycle hook
- Intercepts output from the `task` tool (delegate-task)
- Mutates output in-place to append retry guidance without breaking existing workflows

### Error Classification
Leverages a predefined set of error patterns (`DELEGATE_TASK_ERROR_PATTERNS`) that map:
- Error type identifiers (e.g., "invalid-category", "missing-required-field")
- Human-readable fix hints
- Regex patterns for detection

## Flow

### Execution Sequence
1. **Hook Registration**: Plugin loads `createDelegateTaskRetryHook` during initialization
2. **Event Subscription**: Hook subscribes to `tool.execute.after` lifecycle event
3. **Tool Filtering**: Only processes output from the `task` tool (delegate-task delegation)
4. **Error Detection**: Runs `detectDelegateTaskError()` on tool output string
5. **Guidance Generation**: If error detected:
   - Looks up error pattern to get fix hint
   - Extracts available agent list from output
   - Constructs multi-line retry suggestion with:
     - Detected error type
     - Pattern-specific fix hint
     - Available agent list (if present)
     - Example retry invocation
6. **Output Mutation**: Appends generated retry guidance to tool output string
7. **Propagation**: Modified output returned to caller for display/user action

### Error Handling
- **No-op on success**: If no delegate-task error detected, hook exits early without modifying output
- **Type safety**: Validates output is a string before processing
- **Graceful degradation**: Falls back to generic retry suggestion if error pattern not recognized

## Integration

### Dependencies
- **OpenCode Plugin System**: Consumes `tool.execute.after` lifecycle hook
- **Error Patterns Module**: Imports `DELEGATE_TASK_ERROR_PATTERNS` and `detectDelegateTaskError` from `./patterns.ts`
- **Task Tool**: Specifically targets the `task` tool used for delegate-task operations

### Consumers
- **OpenCode Core**: Receives enhanced tool output with retry guidance
- **User Workflow**: Displays actionable error context and retry examples in OpenCode UI

### Configuration
- **No user configuration required**: Pattern matching and guidance generation are hardcoded for reliability
- **Extensible patterns**: New error types can be added by extending `DELEGATE_TASK_ERROR_PATTERNS` array

### Lifecycle Hook
```typescript
'tool.execute.after': async (input, output) => { ... }
```
- Triggered after every tool execution in OpenCode
- Runs asynchronously but synchronously with respect to tool output processing
- Mutates output object in-place (standard OpenCode plugin hook contract)
