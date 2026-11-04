# src/hooks/json-error-recovery/

## Responsibility

Provides automatic JSON error detection and recovery for OpenCode plugin tool execution. This hook monitors tool output for JSON parse errors and injects a standardized error reminder to guide users toward correcting their JSON syntax.

## Design

### Core Components

- **JSON_ERROR_PATTERNS**: Array of regex patterns for detecting various JSON error messages
- **JSON_ERROR_REMINDER**: Standardized error message template instructing users on JSON correction
- **createJsonErrorRecoveryHook()**: Factory function that returns the OpenCode plugin hook

### Hook Architecture

The hook implements the OpenCode plugin's `tool.execute.after` lifecycle hook:
- Triggered after every tool execution
- Validates output is a string
- Checks for JSON error patterns in output
- Appends error reminder when JSON errors are detected

### Error Detection Logic

1. **Failure Check**: Only v1 `invalid` tool outputs are eligible; v2 handles malformed argument JSON before the after-hook
2. **Output Type Check**: Verifies output is a string before processing
3. **Marker Check**: Skips output already containing the error reminder marker
4. **Pattern Matching**: Tests output against multiple JSON error regex patterns
5. **Reminder Injection**: Appends standardized error reminder to output

## Flow

```
Tool Execution → tool.execute.after Hook Trigger → 
  [Check Failure] → [Validate Output Type] → [Check Marker] →
  [Pattern Matching] → [Inject Reminder if JSON Error Detected] → Return Output
```

### Detailed Execution Sequence

1. **Hook Registration**: `createJsonErrorRecoveryHook()` is called during plugin initialization
2. **Event Subscription**: Hook subscribes to `tool.execute.after` lifecycle event
3. **Filtering**: Calls other than the v1 `invalid` tool are skipped
4. **Validation**: Output type is verified to be a string
5. **Duplicate Prevention**: Outputs already containing the error marker are skipped
6. **Pattern Testing**: Output is tested against all JSON error patterns
7. **Reminder Injection**: If any pattern matches, the standardized error reminder is appended to the output
8. **Result Return**: Modified output is returned to the OpenCode plugin system

## Integration

### Consumers

- **Primary Consumer**: OpenCode plugin system via the `tool.execute.after` lifecycle hook
- **Error Path**: JSON errors in tool arguments are detected and surfaced to users

### Dependencies

- **OpenCode Plugin SDK**: `@opencode-ai/plugin` for PluginInput type definitions
- **Lifecycle Events**: Relies on the `tool.execute.after` event being emitted by OpenCode

### Integration Points

- **Plugin Initialization**: Hook is created during plugin startup via `createJsonErrorRecoveryHook()`
- **Tool Execution Pipeline**: Integrates into the post-execution phase of all tool calls
- **User Feedback Loop**: Provides immediate, actionable feedback when JSON errors occur

### Configuration

The hook uses hardcoded constants for:
- JSON error patterns
- Error reminder message

These can be extended or modified by updating the hook implementation.
