# src/hooks/

## Responsibility

Implements the plugin's OpenCode lifecycle hooks: message/prompt transforms,
tool-execute interception, event handling, cache-safe prompt injection, and
runtime command interception. Each hook is a factory function, imported directly
from its owning module, that returns the hook points OpenCode invokes.

## Design

### Core Architecture

- **Factory leaves**: Optional implementations load inside the feature gate that
  uses them. `src/index.ts` imports leaves directly; there is no hooks barrel.
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
- **Volatile messages** (`volatile-message.ts`): shared marker used by the goal pointer and the cache breakpoint selector.

### Hook Categories

| Category | Factories | Hook points |
|---|---|---|
| Prompt transforms | `createPhaseReminderHook`, `createCouncilInjectHook`, `createChatHeadersHook`, `processImageAttachments` | `experimental.chat.messages.transform`, `chat.headers` |
| Tool interception | `createApplyPatchHook` (tool), `createSearchPathGuardHook`, `createCouncilSeatHook` | `tool.execute.before` / `tool.execute.after` |
| Error recovery | `createJsonErrorRecoveryHook` | message transform, tool-execute after |
| Lifecycle/event | `createCacheMonitorHook` | `event` |
| Runtime commands | `createDeepworkCommandHook`, `createReflectCommandHook` | `command.execute.before` |
| Model fallback | `ForegroundFallbackManager` | event-driven (message.updated/session.error/session.status) |

## Flow

### Message Processing Pipeline

```
1. OpenCode hands the context to Slim's message transform.
2. Slim collapses interview history and applies image, phase and council transforms.
3. The Deepwork goal pointer is appended as a trailing volatile message.
4. The cache monitor observes completed model requests.
```

### Request-local Message View

`message-transform-view.ts` collects valid/user message references and source
indices once per request. Parts remain live; image identity uses signature
prefixes before full extraction, which is memoized only within that view.
Root wiring shares it with phase and council transforms. Goal placement
remains trailing-most. `stripTaggedContents` removes multiple compaction tags
with one equivalent pass; the cache-safety harness mirrors this wiring.

### Hook Registration

```
1. Plugin initializes (src/index.ts)
2. Hook factories load inside their feature/disabled_hooks gates and return
   handler objects
3. src/index.ts wires them directly into the plugin's hook object
   (no central registry; factories are composed at the call site)
4. Stateful hooks register session.deleted cleanup with SessionLifecycle
5. OpenCode invokes hooks during the message/tool/event lifecycle
```

### Event Observation (event hook)

- `createCacheMonitorHook` observes completed-request cache counters.
- `question-timeout/core.ts` owns the timer used by the OpenCode 2 TUI.
- OpenCode owns background subagent status and completion delivery.

## Integration

### Consumers

- **Main Plugin** (`src/index.ts`): imports every factory from its owning module and
  wires the returned handlers into the plugin's hook object.
- **Council seats** (`council-seats/`): reads host transcript results for selected council sessions.
- **Model fallback**: steers OpenCode retry decisions and handles refusal continuations.

### Subdirectories

| Directory | Responsibility |
|---|---|
| `absolute-path-rescue/` | Rewrites misguessed absolute tool paths by re-anchoring the longest workspace-suffix match (ENOENT-only, unambiguous candidates only) |
| `apply-patch/` | Structured `apply_patch` parsing, matching, recovery, rewrite pipeline |
| `cache-monitor/` | Observation-only prompt-cache telemetry watchdog |
| `council-seats/` | Council seat-result assembly seam: `Seats:`-line rewrite hook + managed (job board) and native (host session) resolvers |
| `deepwork/` | `/deepwork` runtime command |
| `foreground-fallback/` | Interactive-session model fallback on rate-limit/errors |
| `json-error-recovery/` | Malformed JSON/tool-output recovery helpers |
| `phase-reminder/` | Message-transform reminder enforcing orchestrator workflow phases |
| `reflect/` | `/reflect` runtime command |
| `search-path-guard/` | Pre-checks `grep`/`glob` `args.path` validity in `tool.execute.before`, using each host tool's path resolution semantics, and fails fast with an actionable error instead of upstream "ripgrep execution failed" noise or silent parent-directory searches |
| `tool-loop-guard/` | Detects byte-identical repeated tool calls: warns at 3, blocks at 5, with task-lifecycle exemptions and per-turn wait-tool counting |

### Dependencies

- **OpenCode SDK**: `MessageWithParts`, `MessageInfo`, and hook signature types
- **Node.js**: `fs`, `crypto` (image attachments, tagged-part hashing)
- **Utils**: `logger`, `guards`, task parsing, internal-initiator parts

### Error Handling

- Hooks are best-effort: file-system/transform failures are logged and the
  hook continues with remaining messages.
- The cache monitor fails open on any unexpected event shape.
### Performance Considerations

- **Cache safety**: all injection goes through the tagged/volatile helpers to
  preserve provider prompt-cache prefixes.
- **Image assets**: auto-routed attachments persist under `.opencode/images/`
  until the user removes them explicitly; no cleanup timer deletes them.
- **Runtime status**: reconciliation runs on timers, not per-event.
- **Bounded state**: cache monitor and wake gate cap tracked sessions; idle
  reconciliation uses per-session tokens to invalidate stale timers.
