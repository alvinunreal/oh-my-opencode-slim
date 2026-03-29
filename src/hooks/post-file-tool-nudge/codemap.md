# src/hooks/post-file-tool-nudge/

<!-- Explorer: Fill in this section with architectural understanding -->

## Responsibility

Provide a lightweight safety net that reminds agents to stay in the delegation workflow whenever they read or write project files. When the Read or Write tool emits output, this hook appends a standardized nudge so that follow-up work is routed to the right specialists instead of being solved immediately.

## Design

Exports a single factory (`createPostFileToolNudgeHook`) that returns a handler map for the `tool.execute.after` event. The hook keeps a shared `NUDGE` constant and enforces a policy guard for Read/Write tool names before mutating the `output`. This keeps the implementation focused and pluggable inside the broader hook registry.

## Flow

The hook is instantiated once and registered with the hook system, which invokes `tool.execute.after` after every tool call. When a Read or Write tool completes, the hook sees the input metadata, verifies the tool name, and appends the reminder text to `output.output`, thereby altering the user-facing response before it bubbles back to the agent.

## Integration

Plugged into the global hook registry, this module intercepts every tool response via the `tool.execute.after` lifecycle event. It directly touches only Read/Write tool output objects so there are no downstream dependencies, but the appended reminder influences all downstream consumers who display file-tool results.
