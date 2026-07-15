# src/hooks/post-file-tool-nudge/

## Responsibility
Implements a post-tool execution hook that queues delegation reminders after file operations and injects them as synthetic message parts for the next eligible orchestrator turn.

## Design

### Hook Structure
- **Factory Pattern**: `createPostFileToolNudgeHook()` returns `tool.execute.after` and `experimental.chat.messages.transform` handlers
- **Conditional Injection**: Uses `shouldInject` option to filter sessions where the reminder should be applied
- **Set-based Tool Filtering**: Maintains a Set of file tool names for O(1) lookup

### Core Logic
- Read/Write records one pending marker per session.
- The message transform finds the latest matching orchestrator user message with a non-internal text part before consuming that marker.
- It appends `PHASE_REMINDER` as a synthetic metadata-tagged text part, preserving user-authored text and allowing phase-reminder metadata deduplication.

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
   - Find a matching eligible orchestrator user message
   - Consume the session marker only after validation
   - Append one synthetic, metadata-tagged reminder part
4. **Result**: The API receives the reminder without mutating tool output or user-authored text

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
