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
  `session.deleted` cleanup-callback registration. Stateful hooks register
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
  shared by command-style hooks (deepwork, reflect).
- **Message types** (`types.ts`): `MessageInfo`, `MessagePart`,
  `MessageWithParts`, plus replay helpers used by foreground-fallback.

### Hook Categories

| Category | Factories | Hook points |
|---|---|---|
| Prompt transforms | `createPhaseReminderHook`, `createCouncilInjectHook`, `createChatHeadersHook`, task-session-manager delivery observation, `processImageAttachments` | `experimental.chat.messages.transform`, `chat.headers` |
| Tool interception | `createApplyPatchHook` (tool), `createSearchPathGuardHook`, `createCouncilSeatHook`, task-session-manager | `tool.execute.before` / `tool.execute.after` |
| Error recovery | `createJsonErrorRecoveryHook`, `createAutoUpdateCheckerHook` | message transform, tool-execute after |
| Lifecycle/event | task-session-manager, `createCacheMonitorHook`, `createOrchestratorWakeScheduler` | `event` |
| Runtime commands | `createDeepworkCommandHook`, `createReflectCommandHook` | `command.execute.before` |
| Model fallback | `ForegroundFallbackManager` | event-driven (message.updated/session.error/session.status) |

## Flow

### Message Processing Pipeline

```
1. OpenCode receives chat messages
2. Plugin's experimental.chat.messages.transform hook is invoked (src/index.ts
   composes: task-session-manager → phase-reminder → council-inject, in that
   order)
3. Task-session-manager first repairs session mappings and observes terminal
   deliveries already present in the parent's history (the job board itself is
   never rendered); phase-reminder then injects the scheduler reminder
   (per-message eligibility); council-inject then injects the Council Mode
   block once per transcript, on the first keyword-triggered orchestrator turn
   (gated)
4. Transformed messages are sent to the model
5. chat.headers is forwarded to OpenCode's header slot (v1 hosts; on v2
   hosts the adapter bridges the same decision to
   `session.hook("model.request")` — see src/v2/codemap.md)
6. Model responses/events are observed by the cache monitor (telemetry) and
   orchestrator-wake scheduler (idle nudge timing)
```

Skill discovery and visibility are handled by native v1/v2 host behavior from
the finalized agent/session permissions: hidden skills are denied and
discoverable skills require permission approval. The plugin does not rewrite
`<available_skills>` in conversation text.

### Request-local Message View

`message-transform-view.ts` collects valid/user message references and source
indices once per request. Parts remain live and image extraction is memoized
only within that view. Root wiring shares it with task, phase and council
transforms, then rebuilds after structural Interview/board edits. Goal placement
remains trailing-most. `stripTaggedContents` removes multiple compaction tags
with one equivalent pass; the cache-safety harness mirrors this wiring.

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
- **Council seats** (`council-seats/`): owns `Seats:`-line seat-result
  assembly. The managed resolver reads the parent-side job board only;
  the native resolver reads the host sessions and is selected when
  `backgroundJobs.enabled` is false. Neither depends on the other.
- **Task-session-manager**: depends on `cache-safe-injection.ts` for all prompt
  injection and on `session-lifecycle.ts` for delete coordination.
- **Orchestrator-wake**: gates on the task-session-manager's `hasInputWait`
  and continuation-model seams.
- **Foreground-fallback**: uses `types.ts` `isReplayableUserMessage` to locate the
  user turn before a replay and reports
  retryable/deferred errors to the task-session-manager event router.

### Subdirectories

| Directory | Responsibility |
|---|---|
| `absolute-path-rescue/` | Rewrites misguessed absolute tool paths by re-anchoring the longest workspace-suffix match (ENOENT-only, unambiguous candidates only) |
| `apply-patch/` | Structured `apply_patch` parsing, matching, recovery, rewrite pipeline |
| `auto-update-checker/` | Startup update detection, cache handling, optional install prompt |
| `cache-monitor/` | Observation-only prompt-cache telemetry watchdog |
| `council-seats/` | Council seat-result assembly seam: `Seats:`-line rewrite hook + managed (job board) and native (host session) resolvers |
| `deepwork/` | `/deepwork` runtime command |
| `foreground-fallback/` | Interactive-session model fallback on rate-limit/errors |
| `json-error-recovery/` | Malformed JSON/tool-output recovery helpers |
| `orchestrator-wake/` | Periodic orchestrator wake scheduler + process-global gate |
| `phase-reminder/` | Message-transform reminder enforcing orchestrator workflow phases |
| `reflect/` | `/reflect` runtime command |
| `search-path-guard/` | Pre-checks `grep`/`glob` `args.path` validity in `tool.execute.before`, using each host tool's path resolution semantics, and fails fast with an actionable error instead of upstream "ripgrep execution failed" noise or silent parent-directory searches |
| `task-session-manager/` | Resumable task session tracking, terminal-delivery observation, reconciliation |
| `tool-loop-guard/` | Detects byte-identical repeated tool calls: warns at 3, blocks at 5, with task-lifecycle exemptions and per-turn wait-tool counting |

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
- **Image assets**: auto-routed attachments persist under `.opencode/images/`
  until the user removes them explicitly; no cleanup timer deletes them.
- **Runtime status**: reconciliation runs on timers, not per-event.
- **Bounded state**: cache monitor and wake gate cap tracked sessions; idle
  reconciliation uses per-session tokens to invalidate stale timers.
