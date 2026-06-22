# src/hooks/todo-continuation/

## Responsibility

- Defer OpenCode's built-in todo auto-continue wake-up while a
  parent/orchestrator session still has non-terminal background tasks
  (issue #587). The completion of the background job will wake the
  orchestrator naturally with its result; an auto-continue injected
  before then can cause duplicate work, race conditions, or the
  orchestrator advancing past the result it was actually waiting for.

## Design

- Reuses the existing `BackgroundJobBoard` as the single source of
  truth for background-task state (it already groups jobs by
  `parentSessionID`).
- Adds a `hasActiveBackgroundTasks(parentSessionID)` predicate on the
  board that returns `true` if any job under the parent is in a
  non-terminal state — either `running`, or terminal but
  `terminalUnreconciled` (i.e. the orchestrator has not yet consumed
  the result in a prior turn). Reconciled jobs are not considered
  active; they have already been incorporated by the orchestrator.
- Maintains a small in-memory `deferredSessions: Set<string>` of parent
  sessions that should have their next auto-continue wake-up
  suppressed. The set is populated by `session.idle` (and the
  `session.status` with `type === 'idle'` variant) and cleared by
  `session.status` with `type === 'busy'` (the session has woken up on
  its own) or by `session.deleted`.
- The `experimental.chat.messages.transform` hook inspects the last
  user message in the outbound stream for a deferred session. If the
  message is synthetic (`TextPart.synthetic === true` — the flag
  OpenCode sets for auto-continue wake-ups), the message is removed
  from the array before the request reaches the LLM. Real user
  messages and internal notifications (those carrying
  `SLIM_INTERNAL_INITIATOR_MARKER`) are always preserved.
- The hook is read-only with respect to background jobs. It never
  launches, mutates, reconciles, or cancels tasks. The
  `task-session-manager` hook keeps the `BackgroundJobBoard` in sync.

## Flow

1. `task-session-manager` updates `BackgroundJobBoard` as background
   tasks are launched, finish, and are reconciled.
2. The orchestrator session goes idle (`session.idle` event). The
   `todo-continuation` hook checks
   `backgroundJobBoard.hasActiveBackgroundTasks(parentSessionID)` and,
   if true, marks the session as deferred.
3. OpenCode's auto-continue wakes the orchestrator by injecting a
   synthetic user message into the next prompt. The synthetic message
   is the last user message in the stream.
4. `experimental.chat.messages.transform` runs. The hook sees the
   synthetic wake-up, the session is deferred, and the synthetic
   message is spliced out of the outbound list.
5. The deferral is cleared (a) immediately after the synthetic message
   is removed, (b) when the session becomes busy, or (c) on
   `session.deleted`. The next idle cycle re-evaluates the
   `BackgroundJobBoard`.

## Integration

- Registered in `src/index.ts` as `todoContinuationHook`.
- The hook runs **before** `taskSessionManagerHook` in the message
  transform pipeline so the synthetic wake-up is removed before any
  other transformation. Running it earlier (rather than later) means
  downstream hooks never see the message at all and cannot mutate or
  leak it.
- Wired into both `event` and `experimental.chat.messages.transform`
  hook surfaces; no `tool.execute.*` integration.
- The hook is gated by the same `shouldManageSession` predicate used
  by `task-session-manager`, so it only acts on orchestrator
  sessions.
