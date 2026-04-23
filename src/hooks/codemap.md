# src/hooks/

This directory is the plugin-level hook composition surface. It exports factories
and managers for all hook-based runtime behaviors used by
`src/index.ts` (tool transforms, event listeners, and command hooks).

## Responsibility

- Own the stable exports for hook modules so `src/index.ts` can register features
  without depending on subfolder internals.
- Describe lifecycle boundaries between OpenCode hook surfaces and internal state
  machines that coordinate retries, timers, and session tracking.
- Centralize all hook feature entry points used by orchestrator tooling,
  delegation/task workflows, and session lifecycle handlers.

## Design

- `src/hooks/index.ts` re-exports per-feature factories and managers.
- Most features implement the `create*Hook(ctx, config?)` factory pattern and
  return lifecycle callbacks.
- Foreground fallback is provided as a manager class (`ForegroundFallbackManager`)
  with an explicit `handleEvent` method.
- `task-session-manager` persists resumable task sessions per parent session and
  per agent, with bounded history and aliasing.
- Side effects are limited to exported handlers and dedicated utility functions
  to keep hook behavior deterministic.
- Runtime integration depends on `PluginInput.client` for session APIs and shared
  utilities (`log`, marker constants, prompt helpers).

## Flow

1. `src/index.ts` imports each hook symbol from this folder.
2. The plugin creates hook instances during startup and registers callbacks in
   these surfaces:
   - `tool.execute.before`
   - `tool.execute.after`
   - `experimental.chat.messages.transform`
   - `experimental.chat.system.transform`
   - `chat.headers`
   - `chat.message`
   - `command.execute.before`
   - `event`
3. Implementations either mutate OpenCode payloads (for in-band guidance or
   prompt/system injection) or call session APIs (`todo`, `messages`, `prompt`,
   `promptAsync`, `abort`, and event/status flows).

## Hook Points

| Hook Point | Purpose | Implementations |
|---|---|---|
| `tool.execute.before` | Pre-process tool inputs | `apply-patch`, `task-session-manager` |
| `tool.execute.after` | Post-process tool outputs | `delegate-task-retry`, `json-error-recovery`, `post-file-tool-nudge`, `task-session-manager` |
| `experimental.chat.messages.transform` | Rewrite outbound user content | `filter-available-skills`, `phase-reminder` |
| `experimental.chat.system.transform` | Inject system-level directives | `todo-continuation`, `post-file-tool-nudge`, `task-session-manager` |
| `chat.headers` | Mutate request headers | `chat-headers` |
| `chat.message` | Track runtime session/agent mapping | `todo-continuation` |
| `command.execute.before` | Handle slash-command UX | `todo-continuation` (`auto-continue`) |
| `event` | React to session lifecycle and runtime failures | `foreground-fallback`, `todo-continuation`, `post-file-tool-nudge`, `auto-update-checker`, multiplexer managers, `task-session-manager` |

## Implementation Notes

- `createDelegateTaskRetryHook` (`tool.execute.after`) is a narrow guard around
  `task` tool failure strings and appends structured retry guidance inline.
- `ForegroundFallbackManager` listens to event traffic and remediates
  foreground rate-limit failures by aborting the current prompt and re-queuing the
  latest user message on the next model in a per-agent chain.
- `createTodoContinuationHook` spans multiple surfaces: message transform,
  system transform, command interception, tool-after, and events. It owns
  auto-injection state, cooldown, suppress windows, and orchestration session
  tracking.
- `createTaskSessionManagerHook` tracks task sessions for resumability: generates
  user-facing aliases, resolves alias/task IDs before delegation, remembers fresh
  task IDs after completion, and drops stale entries on missing-session failure,
  renamed task IDs, or session deletion.

## Integration

- `src/index.ts` is the sole runtime consumer and determines final registration
  order so composed transforms (system joins, reminder insertion, hygiene) stay
  deterministic.
- `taskSessionManager` is registered in `tool.execute.before`, `tool.execute.after`,
  `experimental.chat.system.transform`, and `event`, with parent/child cleanup.
- The `src/hooks/*/codemap.md` files document each feature internals.
