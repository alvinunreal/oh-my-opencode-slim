# src/hooks/post-file-tool-nudge/

<!-- Explorer: Fill in this section with architectural understanding -->

## Responsibility

Provide a lightweight safety net that reminds the orchestrator to stay in the delegation workflow whenever it reads or writes project files. Read/Write tool results are treated as evidence only; the hook now queues a one-shot reminder for the next system prompt instead of modifying the persisted tool output.

## Design

Exports a single factory (`createPostFileToolNudgeHook`) that returns handlers for `tool.execute.after`, `experimental.chat.system.transform`, and session lifecycle events. The tool hook records pending session IDs for Read/Write tools, while the system transform consumes each pending ID once and appends the existing workflow reminder only when the caller allows injection for that session. The event handler clears stale pending IDs when sessions are deleted. This preserves the delegation behavior without contaminating persisted tool output.

## Flow

The hook is instantiated once and registered with the hook system. When a Read or Write tool completes, `tool.execute.after` verifies the tool name and session ID, then stores the session ID in an in-memory pending set. On the next `experimental.chat.system.transform` call for that session, the hook deletes the pending marker and appends the workflow reminder to the outgoing system prompt. Multiple Read/Write calls before the next model turn collapse into one reminder, non-orchestrator sessions can be consumed without injection, and deleted sessions are removed from the pending set.

## Integration

Plugged into the global hook registry, this module intercepts every tool response via the `tool.execute.after` lifecycle event, participates in system prompt transformation via `experimental.chat.system.transform`, and listens to session deletion events for cleanup. It intentionally does not mutate `output.output`, so file contents remain clean for persistence, replay, and compaction while the orchestrator still receives the intended delegation reminder.
