# src/utils/

## Responsibility

Centralized utilities and shared abstractions used across the oh-my-opencode-slim plugin. This folder provides:
- Background job lifecycle management via BackgroundJobBoard
- Environment and configuration utilities
- Type guards and validation helpers
- Session and timeout utilities for council dispatch
- Logging infrastructure with automatic rotation
- Task output parsing utilities
- System message utilities

## Design

### Core Abstractions

- **BackgroundJobBoard** (`background-job-board.ts`): Singleton registry and lifecycle manager for background tasks spawned by sub-agents. Implements a reusable session pool pattern with automatic cleanup and reconciliation hooks. Tracks task state (running, completed, error, cancelled), maintains context files, and provides prompt-ready summaries for agent coordination.

- **Logger** (`logger.ts`): File-based logging with 7-day retention, automatic directory creation, and write queuing. Logs are written to `~/.local/share/opencode/log/oh-my-opencode-slim.<sessionId>.log` and cleaned up on initialization.

- **Session Utilities** (`session.ts`): Timeout handling, session abort coordination, model reference parsing, and session content extraction. Provides `promptWithTimeout` and `extractSessionResult` for safe session operations.

- **Task Utilities** (`task.ts`): XML-inspired task output parsing for extracting task IDs, states, and results from tool output strings. Used for resumption and status tracking.

- **Type Guards** (`guards.ts`): Simple type checking utilities (`isRecord`) for runtime validation.

- **Environment Utilities** (`env.ts`): Environment variable parsing and plugin disable flag checking.

- **Internal Initiator** (`internal-initiator.ts`): Marker system for identifying internally-initiated agent messages to prevent infinite loops.

- **System Collapse** (`system-collapse.ts`): Utility for collapsing multiple system messages into a single entry by joining with double-newlines.

### Design Patterns

- **Singleton**: BackgroundJobBoard is a singleton registry with global state for all background tasks
- **Strategy**: Task parsing adapts to multiple output formats (XML tags, plain text headers)
- **Observer**: Logger uses write queuing to avoid blocking the main thread
- **Utility**: Each utility module provides focused, composable functions

## Flow

### Background Job Lifecycle
1. Agent launches a background task via BackgroundJobBoard.registerLaunch()
2. Task runs and updates status via BackgroundJobBoard.updateStatus()
3. On completion/error/cancellation, task is marked terminal and added to reusable pool
4. Subsequent tasks from same agent/session can reuse completed sessions via aliases
5. Unused reusable sessions are automatically trimmed based on maxReusablePerAgent

### Logging Flow
1. Plugin initializes logger with session ID via initLogger(sessionId)
2. Logs are appended to `~/.local/share/opencode/log/oh-my-opencode-slim.<sessionId>.log`
3. Old logs (>7 days) are automatically cleaned up on initialization
4. Log writes are queued to avoid blocking, with errors silently ignored

### Session Operations
1. Council dispatch uses `promptWithTimeout()` to send prompts with configurable timeout
2. On timeout, session is aborted and OperationTimeoutError is thrown
3. Results are extracted via `extractSessionResult()` which collects all assistant message text

## Integration

### Consumers

- **Council Agents** (`src/agents/council.ts`, `src/agents/council-agents.ts`):
  - Uses BackgroundJobBoard for background task management
  - Uses session utilities for prompt timeout and session extraction
  - Uses logger for debug and audit logging

- **Multiplexer** (`src/multiplexer/`):
  - Uses session utilities for session operations
  - Uses logger for session lifecycle events

- **Agents** (`src/agents/`):
  - BackgroundJobBoard for launching and tracking background tasks
  - Logger for agent-specific logging

- **Main Plugin** (`src/index.ts`):
  - Exports all utilities via `src/utils/index.ts`
  - Uses logger for plugin lifecycle events

### Dependencies

- **Node.js built-ins**: `fs`, `fs/promises`, `os`, `path` for logging and file operations
- **@opencode-ai/sdk**: PluginInput type for session utilities

### Export Chain

`src/utils/index.ts` re-exports all utilities, providing a single entry point:
```typescript
export * from './background-job-board';
export * from './internal-initiator';
export { getLogDir, initLogger, log } from './logger';
export * from './session';
export * from './task';
```

This allows consumers to import from `src/utils` rather than individual files.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Public API re-exporting all utilities |
| `background-job-board.ts` | Background task registry and lifecycle manager |
| `env.ts` | Environment variable utilities |
| `guards.ts` | Type guard utilities |
| `internal-initiator.ts` | Internal agent message marker system |
| `logger.ts` | File-based logging with rotation |
| `session.ts` | Session timeout, abort, and extraction utilities |
| `system-collapse.ts` | System message collapsing utility |
| `task.ts` | Task output parsing utilities |