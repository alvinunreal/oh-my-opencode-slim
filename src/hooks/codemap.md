# src/hooks/

This directory exposes the public hook entry points that feature code imports to tap into behavior such as workflow reminders, error recovery, rate-limit fallback, and delegation guidance.

## Responsibility

Acts as a single entry point that re-exports the factory functions and types for every hook implementation underneath `src/hooks/`, so other modules can import from a flat namespace without needing to know subpaths.

## Design

- **Aggregator/re-export pattern**: `index.ts` consolidates all hook factories and types for the entire hooks subsystem.
- **Factory-based design**: Each hook is a factory function that returns a hook object with specific hook points (e.g., `'tool.execute.after'`, `'experimental.chat.messages.transform'`, `'chat.headers'`).
- **Modular architecture**: Each hook lives in its own subdirectory with internal components (hook implementation, patterns, guidance, etc.).
- **Event-driven hooks**: Hooks respond to OpenCode plugin events and modify output before it reaches the LLM or UI.

## Flow

1. **Import**: Feature modules import factories from `src/hooks/index.ts` (e.g., `createPhaseReminderHook`, `createJsonErrorRecoveryHook`).
2. **Configure**: Call factory with any required context (e.g., `PluginInput` for client access).
3. **Register**: Hook objects are registered with OpenCode's plugin system via the feature layer.
4. **Execute**: At runtime, OpenCode invokes hook functions at specific points (tool execution, message transformation, event handling).
5. **Modify**: Hooks inspect input/output and apply side-effects (inject text, modify headers, append guidance).

## Integration

### Hook Points

| Hook Point | Purpose | Hooks |
|------------|---------|-------|
| `'tool.execute.after'` | Modify tool output after execution | `post-read-nudge`, `delegate-task-retry`, `json-error-recovery` |
| `'experimental.chat.messages.transform'` | Transform messages before API call | `phase-reminder` |
| `'chat.headers'` | Add custom headers to API requests | `chat-headers` |
| Event handlers | React to OpenCode events | `foreground-fallback` |

### Hook Implementations

#### **phase-reminder**
- **Location**: `src/hooks/phase-reminder/index.ts`
- **Purpose**: Injects workflow reminder before each user message for the orchestrator agent to combat instruction-following degradation.
- **Hook Point**: `'experimental.chat.messages.transform'`
- **Behavior**: Prepend reminder text to the last user message if agent is 'orchestrator' and message doesn't contain internal initiator marker.
- **Research**: Based on "LLMs Get Lost In Multi-Turn Conversation" (arXiv:2505.06120) showing ~40% compliance drop after 2-3 turns without reminders.

#### **post-read-nudge**
- **Location**: `src/hooks/post-read-nudge/index.ts`
- **Purpose**: Appends delegation reminder after file reads to catch the "read files → implement myself" anti-pattern.
- **Hook Point**: `'tool.execute.after'`
- **Behavior**: Appends nudge text to output when tool is 'Read' or 'read'.

#### **chat-headers**
- **Location**: `src/hooks/chat-headers.ts`
- **Purpose**: Adds `x-initiator: agent` header for GitHub Copilot provider when internal initiator marker is detected.
- **Hook Point**: `'chat.headers'`
- **Behavior**: Checks for internal marker via API call, only applies to Copilot provider and non-Copilot npm model.
- **Caching**: Uses in-memory cache (max 1000 entries) to reduce API calls.

#### **delegate-task-retry**
- **Location**: `src/hooks/delegate-task-retry/`
- **Purpose**: Detects delegate task errors and provides actionable retry guidance.
- **Components**:
  - `hook.ts`: Main hook that detects errors and appends guidance.
  - `patterns.ts`: Defines error patterns and detection logic.
  - `guidance.ts`: Builds retry guidance messages with available options.
- **Hook Point**: `'tool.execute.after'`
- **Behavior**: Detects errors like missing `run_in_background`, invalid category/agent, unknown skills, and appends structured guidance.
- **Patterns**: 8 error types with specific fix hints and available options extraction.

#### **foreground-fallback**
- **Location**: `src/hooks/foreground-fallback/index.ts`
- **Purpose**: Runtime model fallback for foreground (interactive) agent sessions experiencing rate limits.
- **Hook Point**: Event-driven (not a standard hook point)
- **Behavior**:
  - Monitors `message.updated`, `session.error`, `session.status`, and `subagent.session.created` events.
  - Detects rate-limit signals via regex patterns.
  - Aborts rate-limited prompt via `client.session.abort()`.
  - Re-queues last user message via `client.session.promptAsync()` with fallback model.
  - Tracks tried models per session to avoid infinite loops.
  - Deduplicates triggers within 5-second window.
- **Fallback Chains**: Configurable per agent (e.g., `{ orchestrator: ['anthropic/claude-opus-4-5', 'openai/gpt-4o'] }`).
- **Cleanup**: Removes session state on `session.deleted` events.

#### **json-error-recovery**
- **Location**: `src/hooks/json-error-recovery/`
- **Purpose**: Detects JSON parse errors and provides immediate recovery guidance.
- **Components**:
  - `hook.ts`: Main hook that detects JSON errors and appends guidance.
  - `index.ts`: Re-exports hook and constants.
- **Hook Point**: `'tool.execute.after'`
- **Behavior**: Appends structured reminder when JSON parse errors are detected in tool output (excluding bash, read, glob, webfetch, etc.).
- **Patterns**: 8 regex patterns covering common JSON syntax errors.

### Dependencies

- **OpenCode SDK**: `@opencode-ai/plugin` (PluginInput type, client access)
- **OpenCode SDK**: `@opencode-ai/sdk` (Model, UserMessage types)
- **Internal Utils**: `hasInternalInitiatorMarker`, `SLIM_INTERNAL_INITIATOR_MARKER`
- **Internal Logger**: `utils/logger`

### Consumers

- Feature modules in `src/` import hook factories from `src/hooks/index.ts`.
- Plugin initialization in `src/index.ts` registers hooks with OpenCode's plugin system.
- No direct relations to deeper hook files from consumers (implementation details hidden).
