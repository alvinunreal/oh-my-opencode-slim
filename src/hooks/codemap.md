# src/hooks/

## Responsibility

Implements the plugin's OpenCode lifecycle hooks: message/prompt transforms,
tool-execute interception, event handling, cache-safe prompt injection, and
runtime command interception. Each hook is a factory function (barrel-exported
from `index.ts`) that returns the hook points OpenCode invokes.

## Design

### Core Architecture

- **Factory barrel** (`index.ts`): Exports every hook factory plus the shared
  helpers (`cache-safe-injection`, `chat-headers`, `command-hook-utils`,
  `image-hook`, `session-lifecycle`, `types`). `src/index.ts` imports from here
  rather than individual files.
- **SessionLifecycle** (`session-lifecycle.ts`): Coordinator that owns
  `session.deleted` cleanup-callback registration and a pending-session
  signaling channel with consume-once semantics. Stateful hooks register
  cleanup callbacks instead of implementing their own `session.deleted`
  handlers.
- **Cache-safe injection** (`cache-safe-injection.ts`): The single supported
  way to add content to the outgoing prompt payload:
  - `appendTaggedSyntheticPart` — deterministic content appended to the tail of
    an existing message.
  - `stripTaggedContent` + `appendTrailingVolatileMessage` — volatile content
    (job boards, status blocks): strip previously injected occurrences, then
    re-append one synthetic trailing message so churn only costs the prompt
    tail.
  Never mutates/reorders earlier messages and never injects unmarked parts —
  enforced by the cache-safety property/snapshot/tripwire tests.
- **Command hook helper** (`command-hook-utils.ts`): `registerCommandHook`
  shared by command-style hooks (deepwork, reflect, loop).
- **Message types** (`types.ts`): `MessageInfo`, `MessagePart`,
  `MessageWithParts`, plus replay helpers used by foreground-fallback.

### Hook Categories

| Category | Factories | Hook points |
|---|---|---|
| Prompt transforms | `createPhaseReminderHook`, `createPostFileToolNudgeHook`, `createChatHeadersHook`, task-session-manager board injection, `processImageAttachments` | `experimental.chat.messages.transform`, `chat.headers` |
| Tool interception | `createApplyPatchHook` (tool), task-session-manager | `tool.execute.before` / `tool.execute.after` |
| Error recovery | `createJsonErrorRecoveryHook`, `createAutoUpdateCheckerHook` | message transform, tool-execute after |
| Lifecycle/event | task-session-manager, `createCacheMonitorHook`, `createOrchestratorWakeScheduler` | `event` |
| Runtime commands | `createDeepworkCommandHook`, `createReflectCommandHook`, `createLoopCommandHook` | `command.execute.before` |
| Skill visibility | `createFilterAvailableSkillsHook` | message transform |
| Model fallback | `ForegroundFallbackManager` | event-driven (message.updated/session.error/session.status) |

## Flow

### Message Processing Pipeline

```
1. OpenCode receives chat messages
2. Plugin's experimental.chat.messages.transform hook is invoked (src/index.ts
   composes: apply-patch → phase-reminder → filter-available-skills →
   task-session-manager board injection, in that order)
3. Task-session-manager first stabilizes still-running task tool parts, then
   rehydrates historical running tasks, then injects the Background Job Board
   via cache-safe helpers
4. Transformed messages are sent to the model
5. chat.headers is forwarded to OpenCode's header slot
6. Model responses/events are observed by the cache monitor (telemetry) and
   orchestrator-wake scheduler (idle nudge timing)
```

### Hook Registration

```
1. Plugin initializes (src/index.ts)
2. Hook factories are called, returning handler objects
3. src/index.ts wires them directly into the plugin's hook object
   (no central registry; factories are composed at the call site)
4. Stateful hooks register session.deleted cleanup with SessionLifecycle
5. OpenCode invokes hooks during the message/tool/event lifecycle
```

### Event Observation (event hook)

- task-session-manager routes session lifecycle events (created, idle, busy,
  error, deleted, server.instance.disposed) to its reconcilers.
- `createCacheMonitorHook` watches completed assistant messages for
  `tokens.cache.read/write` and logs prompt-cache bust/plateau warnings
  (observation only, fails open).
- `createOrchestratorWakeScheduler` tracks continuous parent idle and triggers
  periodic wake prompts (see its sub-map).

## Integration

### Consumers

- **Main Plugin** (`src/index.ts`): imports every factory from `index.ts` and
  wires the returned handlers into the plugin's hook object.
- **Task-session-manager**: depends on `cache-safe-injection.ts` for all prompt
  injection and on `session-lifecycle.ts` for delete coordination.
- **Orchestrator-wake**: gates on the task-session-manager's `hasInputWait`
  and continuation-model seams.
- **Foreground-fallback**: uses `types.ts` replay helpers
  (`isReplayableUserMessage`, `partsFromReplayMessage`) and reports
  retryable/deferred errors to the task-session-manager event router.

### Subdirectories

| Directory | Responsibility |
|---|---|
| `apply-patch/` | Structured `apply_patch` parsing, matching, recovery, rewrite pipeline |
| `auto-update-checker/` | Startup update detection, cache handling, optional install prompt |
| `cache-monitor/` | Observation-only prompt-cache telemetry watchdog |
| `deepwork/` | `/deepwork` runtime command |
| `filter-available-skills/` | Skill-visibility filtering by agent permission policy |
| `foreground-fallback/` | Interactive-session model fallback on rate-limit/errors |
| `json-error-recovery/` | Malformed JSON/tool-output recovery helpers |
| `loop-command/` | `/loop` iterative retry command |
| `orchestrator-wake/` | Periodic orchestrator wake scheduler + process-global gate |
| `phase-reminder/` | Message-transform reminder enforcing orchestrator workflow phases |
| `post-file-tool-nudge/` | Post-read/write reminder nudging delegation-aware next steps |
| `reflect/` | `/reflect` runtime command |
| `task-session-manager/` | Resumable task session tracking, job-board injection, reconciliation |

### Dependencies

- **OpenCode SDK**: `MessageWithParts`, `MessageInfo`, and hook signature types
- **Node.js**: `fs`, `crypto` (image attachments, tagged-part hashing)
- **Utils**: `logger`, `guards`, task parsing, internal-initiator parts

### Error Handling

- Hooks are best-effort: file-system/transform failures are logged and the
  hook continues with remaining messages.
- The cache monitor fails open on any unexpected event shape.
- The orchestrator-wake scheduler suppresses on SDK errors instead of retrying
  storming.

### Performance Considerations

- **Cache safety**: all injection goes through the tagged/volatile helpers to
  preserve provider prompt-cache prefixes.
- **Debounced cleanup**: image cleanup and runtime-status reconciliation run on
  timers, not per-event.
- **Bounded state**: cache monitor and wake gate cap tracked sessions; idle
  reconciliation uses per-session tokens to invalidate stale timers.
