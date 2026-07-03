# src/hooks/post-file-tool-nudge/

## Responsibility
Implements a post-tool execution hook that automatically appends delegation reminders to file operation outputs, preventing the "inspect/edit files → implement myself" anti-pattern where agents attempt to implement functionality themselves instead of delegating to specialized tools.

## Design

### Hook Structure
- **Factory Pattern**: `createPostFileToolNudgeHook()` returns a hook object with a `tool.execute.after` handler
- **Conditional Injection**: Uses `shouldInject` option to filter sessions where the reminder should be applied
- **Set-based Tool Filtering**: Maintains a Set of file tool names for O(1) lookup

### Core Logic
```typescript
const FILE_TOOLS = new Set(['Read', 'read', 'Write', 'write']);

function appendReminder(output: ToolExecuteAfterOutput): void {
  if (typeof output.output !== 'string') return;
  if (output.output.includes(PHASE_REMINDER)) return;
  output.output = `${output.output}\n\n${PHASE_REMINDER}`;
}
```

### Integration Points
- **Config Dependency**: Imports `PHASE_REMINDER` constant from `../../config/constants`
- **Hook Registration**: Hooks into OpenCode's `tool.execute.after` lifecycle phase
- **Session Context**: Receives `sessionID` to support session-specific filtering

## Flow

1. **Trigger**: File tool (Read/Write) completes execution
2. **Validation**:
   - Check if tool is a file tool (Read/read/Write/write)
   - Verify sessionID exists
   - Apply shouldInject filter if provided
3. **Reminder Injection**:
   - Extract output string
   - Check if PHASE_REMINDER already present (idempotent)
   - Append PHASE_REMINDER to output
4. **Result**: Agent receives output with delegation reminder prepended

## Integration

- **Consumed by**: OpenCode plugin lifecycle hooks (src/index.ts)
- **Depends on**: 
  - Config system (PHASE_REMINDER constant)
  - Tool execution framework (tool.execute.after phase)
  - Session management (sessionID for filtering)

## Usage Example

```typescript
const hook = createPostFileToolNudgeHook({
  shouldInject: (sessionID) => sessionID.includes('user-requested')
});

// In plugin initialization:
hooks.register('tool.execute.after', hook['tool.execute.after']);
```

## Anti-Pattern Prevention

This hook addresses the common failure mode where agents:
- Read file contents to understand implementation
- Attempt to implement changes themselves instead of delegating to specialized tools
- Violate the delegation principle of the OpenCode architecture

The reminder reinforces the expected workflow: inspect → delegate → implement via specialized agents.