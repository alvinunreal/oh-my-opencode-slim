# src/hooks/todo-continuation/

## Responsibility

Implements orchestrator-only auto-continuation for incomplete todo lists with
strict safety controls so automation does not loop or fight the user. It also
hosts todo-state hygiene reminders after relevant tool actions.

## Design

- `index.ts` exports `createTodoContinuationHook(ctx, config?)`, returning:
  - `handleMessagesTransform`
  - `handleChatSystemTransform`
  - `handleToolExecuteAfter`
  - `handleEvent`
  - `handleChatMessage`
  - `handleCommandExecuteBefore`
  - `tool` map containing `auto_continue`
- State model (`ContinuationState`) tracks:
  - enabled flag, consecutive continuation count, cooldown timer
  - suppression window after abort, orchestrator session IDs
  - in-flight notification and injection guards
- `todo-hygiene.ts` owns lightweight reminder arming/injection using
  todo-queue transitions and message-context signals.
- Request signatures are used in `handleMessagesTransform` to avoid duplicate
  per-request work.

## Flow

### Auto-continuation path

1. `handleMessagesTransform` identifies the latest external user message,
   infers session/agent, and starts a new continuation cycle for orchestrator
   sessions.
2. On `session.idle`/idle `session.status`, if enabled, the hook validates:
   incomplete todos, non-question last assistant message, max-continuation limit,
   suppress/notification guard, and timer/injection state.
3. If all guards pass, it schedules a cooldown timer and sends a lightweight
   no-reply notification via `session.prompt`.
4. After cooldown, it injects `CONTINUATION_PROMPT` via `session.prompt`, updates
   `consecutiveContinuations`, and logs progress.
5. Event handling resets counters, clears pending timers, or applies a short
   suppression window on abort-like errors.
6. On `session.deleted`, orchestrator session state is torn down and notification
   state is cleared.

### Command path

1. `handleCommandExecuteBefore` intercepts `/auto-continue` before runtime
   execution.
2. It toggles enabled state (`on`, `off`, or flip), clears timers as needed,
   and injects a direct status response into output parts.
3. When enabling and todos are pending, it appends continuation-ready status
   text; when no todos remain, it reports that state.

### Todo hygiene path

1. `createTodoHygiene.handleToolExecuteAfter` arms reminders after supported
   tooling activity, with reset/ignore rules for specific tools.
2. `createTodoHygiene.handleChatSystemTransform` injects one reminder per request
   when open todos remain (`TODO_HYGIENE_REMINDER` or
   `TODO_FINAL_ACTIVE_REMINDER`).
3. `handleEvent` clears hygiene state on `session.deleted`.

## Integration

- Registered in `src/index.ts` across:
  - `experimental.chat.messages.transform`
  - `experimental.chat.system.transform`
  - `chat.message`
  - `command.execute.before`
  - `event`
  - `tool.execute.after`
- Uses shared utilities: `log`, `createInternalAgentTextPart`, and
  `SLIM_INTERNAL_INITIATOR_MARKER`.
- Session/agent identity is coordinated with `session.message` events and
  maintained in the plugin for serve-mode routing consistency.
