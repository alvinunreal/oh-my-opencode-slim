# OpenCode beta v2 capability-gap report

This report is the detailed companion to the [v2 compatibility guide](opencode-v2-compatibility.md).
It describes the gap between this plugin's v1 behavior and a native OpenCode
v2 Promise plugin. It does **not** claim that native v2 support has shipped.

## Scope and authority

- **Target:** OpenCode beta v2, commit
  `d6deb62379c54dc60468b80c498bd6a5899797cf`.
- **Current implementation:** the adapter in
  [`src/v2/setup.ts`](../src/v2/setup.ts), which invokes the v1 factory and
  translates selected hooks.
- **Matrix authority:** the verified Oracle migration review, not the earlier
  optimistic compatibility inventory. The source citations below point to the
  pinned beta checkout and to the current adapter; they do not imply that the
  adapter has native v2 parity.
- **Boundary rule:** an HTTP endpoint in OpenCode's Protocol or Client package
  is not automatically a Promise plugin API. This report cites the Promise
  plugin context and domain types where plugin support is claimed.

## Classifications

- **Direct official mapping** — the beta Promise plugin exposes a domain or
  hook that can own the behavior. Native code still needs implementation and
  verification; the current adapter is not proof of parity.
- **Supported only with behavior change** — v2 exposes useful primitives, but
  not the v1 lifecycle, atomicity, persistence, or UI semantics. The behavior
  must be redesigned and documented.
- **Unavailable** — the supported Promise plugin surface has no equivalent;
  do not preserve the behavior with a fake client or inferred protocol calls.

## At-a-glance matrix

| Capability | Classification | Disposition |
| --- | --- | --- |
| Session context and prompt transforms | Direct official mapping | Implement with `session.hook("context")`; remove v1 payload conversion. |
| Tools and lifecycle | Direct mapping; v1-only hooks change | Port registration and compatible hooks; redesign cancellation/permission-dependent hooks. |
| Command definitions | Direct official mapping | Add executable Promise commands. |
| Global command interception | Unavailable | Retire the v1 interception contract. |
| Current adapter `draft.update` | Unverified/incompatible | Do not treat it as Promise command parity; replace with `draft.add`. |
| MCP registration | Direct official mapping | Register through `ctx.mcp.transform` and reload. |
| Events and live Companion signals | Direct official mapping | Consume volatile `{ type, data }` events; redesign reconnect/reload reconstruction. |
| Cache telemetry | Direct official mapping | Read `session.step.ended` `data.tokens.cache.read/write`. |
| Atomic model failover | Unavailable | Retire the exact atomic contract. |
| Non-atomic model retry | Supported only with behavior change | Redesign retry and transcript semantics explicitly. |
| Explicit reusable session IDs | Direct official mapping | Use `session.create({ id })`; keep it separate from scheduler semantics. |
| Background scheduler, child/todo/status reads | Unavailable | Retire or separately redesign the legacy job-board contract. |
| External multiplexer panes | Unavailable | Retire external pane parity or design a separate TUI replacement. |
| Tool cancellation and permissions | Unavailable | Use host-managed controls; retire v1 interception. |
| Interview recovery | Supported only with behavior change | Persist and reconcile history explicitly. |
| TUI controls | Direct official mapping | Implement a native `tui: true` surface. |
| `/preset` semantics | Supported only with behavior change | Rebuild selection and session/configuration updates explicitly. |

## Capability matrix

### Session context and prompt transforms

**Classification: Direct official mapping.**

- **v1 behavior:** system and message transforms inject the orchestrator
  prompt, phase reminders, skill filtering, display-name rewrites, image
  routing, and background-job context. The adapter converts v2 messages to v1
  `{ info, parts }` values before running those transforms.
- **Exact v2 surface:** `session.hook("context")` receives `sessionID`,
  `agent`, `model`, mutable `system`, `messages`, and `tools`. This is the
  supported replacement for raw v1 message transforms.
- **What changes:** native code must mutate the v2 context directly. It must
  preserve prompt-cache prefix rules and explicitly decide which injections
  remain valid when v1 message ordering and part shapes disappear.
- **Disposition:** implement natively; remove the v1 conversion and verify
  cache-safe output with a pinned host.

Source: [Promise session domain](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/plugin/src/promise/session.ts#L9-L16),
[current adapter context bridge](../src/v2/setup.ts#L220-L300).

### Tools and lifecycle hooks

**Classification: Direct official mapping for registration and execution
observation; supported only with behavior change for v1 hook semantics.**

- **v1 behavior:** registers custom tools and runs before/after hooks for
  apply-patch recovery, JSON recovery, task-session bookkeeping, loop guards,
  and post-tool nudges.
- **Exact v2 surface:** `tool.transform` adds a tool; `tool.hook` exposes
  `execute.before` with mutable input and `execute.after` with completed/error
  results. `shell.hook("create.before")` is the shell-specific lifecycle hook.
- **What changes:** native tools use v2 tool definitions and result types.
  Before/after hooks can validate or rewrite input and observe results, but
  they are not a general cancellation, permission, or arbitrary lifecycle
  interception mechanism.
- **Disposition:** map registration and compatible hooks natively; redesign or
  retire hooks that depend on v1-only output, cancellation, or permission
  timing.

Source: [Promise tool domain](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/plugin/src/promise/tool.ts#L25-L63),
[Promise shell domain](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/plugin/src/promise/shell.ts#L3-L17).

### Commands and global interception

**Classification: Direct official mapping for command definitions; unavailable
for the v1 global pre-execution interception contract.**

- **v1 behavior:** supplies `/deepwork`, `/reflect`, `/loop`, and `/interview`
  commands, and uses `command.execute.before` to rewrite or intercept command
  execution globally.
- **Exact v2 surface:** `command.transform` adds executable
  `{ name, description, execute }` definitions and provides `reload()`. The
  Promise command domain does not expose a global `command.execute.before`
  hook.
- **What changes:** native commands must own their execution callback. A
  command definition is not evidence that every v1 pre-execution transform is
  preserved.
- **Disposition:** port command behavior into explicit executable definitions;
  redesign or retire global interception. **The current adapter's
  `draft.update` translation is unverified and incompatible with the native
  Promise `CommandDraft`, so it must not be treated as command parity.**

Source: [Promise command domain](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/plugin/src/promise/command.ts#L13-L25),
[current command adapter](../src/v2/setup.ts#L169-L218).

### MCP registration

**Classification: Direct official mapping.**

- **v1 behavior:** creates built-in MCP definitions and merges them through the
  v1 config hook.
- **Exact v2 surface:** `mcp.transform` can list/get/set/update/remove server
  configurations and `mcp.reload()` applies the result.
- **What changes:** native setup must register built-in MCP configurations
  through `ctx.mcp`; it must not rely on the v1 config mutation or describe MCP
  support as config-only because the adapter currently omits this bridge.
- **Disposition:** add native MCP registration and verify connection/status
  behavior independently.

Source: [Promise MCP domain](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/plugin/src/promise/mcp.ts#L6-L17),
[current v1 config bridge](../src/v2/setup.ts#L65-L98).

### Events

**Classification: Direct official mapping for observation; supported only with
behavior change for v1 lifecycle semantics.**

- **v1 behavior:** observes host events for session tracking, task lifecycle,
  companion state, cache monitoring, pane cleanup, and model fallback.
- **Exact v2 surface:** `ctx.event.subscribe()` returns a live, volatile
  stream of events shaped as `{ type, data }` (with transport metadata on some
  events). It is an observation stream, not a replay/history API, pane-control
  API, task scheduler, or atomic execution transaction.
- **What changes:** native consumers must read the v2 `data` field and map the
  published event schema. **The current adapter forwards each event unchanged
  to the v1 hook and interview bridge; its handlers still read `properties`,
  so this forward path is unchanged and incompatible.** An event stream cannot
  create, mirror, or control tmux/zellij panes.
- **Disposition:** implement explicitly mapped live-event projections and a
  separate recovery/replay design where needed. Do not treat the current
  adapter's event support as parity.

Source: [Promise event domain](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/plugin/src/promise/event.ts#L1-L3),
[Promise event subscription](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/client/src/promise/generated/client.ts#L1532-L1538),
[v2 event shape](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/client/src/promise/generated/types.ts#L1183-L1200),
[current unchanged forwarder](../src/v2/setup.ts#L375-L408),
[current `properties` reader](../src/v2/interview-bridge.ts#L213-L240).

### Cache telemetry

**Classification: Direct official mapping.**

- **v1 behavior:** the cache monitor observes host lifecycle/message signals and
  reports cache diagnostics without rewriting the prompt.
- **Exact v2 surface:** `session.step.ended` is a durable v2 event whose
  `data.tokens` contains `cache.read` and `cache.write`. A native subscriber
  can read those counters directly from the event.
- **What changes:** replace the v1 lifecycle/message monitor with a projection
  over `session.step.ended` and its `{ type, data }` payload. The current
  adapter does not translate this payload shape, so its cache handling is not
  native telemetry parity.
- **Disposition:** implement the direct event projection and preserve the
  host/provider-reported values without inferring additional cache state.

Source: [session step event](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/schema/src/session-event.ts#L307-L322),
[generated v2 event payload](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/client/src/promise/generated/types.ts#L1183-L1200),
[current unchanged event forwarder](../src/v2/setup.ts#L375-L408).

### Companion signals

**Classification: Direct official mapping for live signals; supported only with
behavior change for reconnect/reload reconstruction.**

- **v1 behavior:** the companion manager receives session status and
  permission/question waiting/resolution signals and presents companion-side
  state.
- **Exact v2 surface:** `ctx.event.subscribe()` carries live `session.status`
  and permission events, including `permission.asked` and
  `permission.replied`. These are the direct source for live Companion
  signals. This does not infer a current question event from the separate v1
  question contract.
- **What changes:** reconnect and plugin reload cannot assume that a volatile
  subscription replays prior signals. Reconstructing Companion state after a
  reconnect/reload requires an explicit status/history reconciliation design.
- **Disposition:** map live signals directly; redesign reconnect/reload state
  reconstruction separately.

Source: [session status event](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/schema/src/session-status-event.ts#L35-L43),
[permission events](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/schema/src/permission.ts#L43-L52),
[Promise event domain](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/plugin/src/promise/event.ts#L1-L3).

### Model failover and small-model selection

**Classification: Unavailable for atomic failover; supported only with behavior
change for non-atomic retry. Small-model selection remains an inventory
decision.**

- **v1 behavior:** `ForegroundFallbackManager` reacts to provider/rate-limit
  failures, aborts, selects the next model, and re-prompts. The current code
  also uses `runtime.smallModel()` for SmartFetch secondary-model selection.
- **Exact v2 surface:** `session.switchModel`, `session.interrupt`, and session
  hooks for `model.request`, `http.request`, and `http.response` exist. None
  defines an atomic failure-detection, model-switch, retry, and transcript
  transaction.
- **What changes:** exact atomic failover is unavailable. A non-atomic retry
  can be redesigned around explicit retry and transcript semantics, but
  **`switchModel` must not be described as atomic failover**.
- **Disposition:** retire the exact atomic contract and separately redesign
  non-atomic retry. Treat small-model selection as an inventory decision:
  determine the native SmartFetch equivalent before deciding its fate.

Source: [Promise session domain](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/plugin/src/promise/session.ts#L41-L63),
[current model selection](../src/index.ts#L261-L287),
[current fallback manager](../src/index.ts#L351-L360).

### Background scheduler, child reads, status, and reusable IDs

**Classification: Direct official mapping for explicit reusable session IDs;
unavailable for the legacy scheduler and child/todo/status semantics.**

- **v1 behavior:** the background job board and scheduler own reusable child
  sessions, wake orchestration, task cancellation/revival, child/todo/status
  reads, and task identity reconciliation.
- **Exact v2 surface:** Promise `session` exposes `create`, and the official
  `session.create` input accepts an explicit `id`. This is a direct mapping for
  reusable session identity. It does not expose the v1 child/todo/status/
  prompt-async read model or a background-job scheduler.
- **What changes:** explicit session IDs must remain distinct from task-board
  ownership and reconciliation. The legacy scheduler replacement would still
  need to define wake, status certainty, cancellation, revival, and ID conflict
  behavior.
- **Disposition:** use explicit IDs where session identity is sufficient;
  retire or separately redesign the legacy scheduler/board contract. Do not
  infer scheduler capabilities from Protocol session endpoints.

Source: [Promise session domain](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/plugin/src/promise/session.ts#L48-L63),
[explicit session ID input](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/protocol/src/groups/session.ts#L170-L184),
[current scheduler/board](../src/hooks/task-session-manager/index.ts#L1-L49),
[current supervisor](../src/utils/background-job-supervisor.ts#L23-L29).

### Multiplexer and child panes

**Classification: Unavailable for external multiplexer parity; supported only
with behavior change through native TUI controls.**

- **v1 behavior:** tmux, zellij, herdr, and cmux panes mirror child task
  sessions and are cleaned up from lifecycle events.
- **Exact v2 surface:** the TUI context provides data, tabs, slots, keymaps,
  dialogs, and UI controls. It does not provide the external multiplexer
  process/pane API.
- **What changes:** native v2 can render a redesigned TUI experience, but an
  event subscription cannot create or mirror external panes.
- **Disposition:** retire external pane parity for native v2 or replace it with
  a separately specified TUI design.

Source: [TUI context UI surface](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/plugin/src/tui/context.ts#L414-L468),
[current multiplexer session manager](../src/multiplexer/session-manager.ts#L1-L49).

### Tool cancellation and permissions

**Classification: Unavailable for exact v1 interception; supported only with
behavior change through host-managed controls.**

- **v1 behavior:** tool hooks participate in task cancellation and permission
  prompting/recovery.
- **Exact v2 surface:** Promise tool hooks cover `execute.before` and
  `execute.after`; Session provides whole-session interrupt. The Promise plugin
  context does not expose a v1-equivalent permission-prompt interception or
  per-tool cancellation hook.
- **What changes:** native tools must rely on official host permission policy
  and session interruption semantics. Before/after hooks cannot be treated as
  cancellation or permission ownership.
- **Disposition:** retire exact v1 interception and document the host-managed
  behavior.

Source: [Promise tool hooks](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/plugin/src/promise/tool.ts#L31-L63),
[Promise session operations](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/plugin/src/promise/session.ts#L48-L63),
[current tool lifecycle hooks](../src/hooks/task-session-manager/tool-execute-hooks.ts#L1-L7).

### Interview recovery

**Classification: Supported only with behavior change.**

- **v1 behavior:** the current adapter keeps a per-session transcript in an
  in-memory `Map`, repopulates it from the v2 context hook, and updates it from
  streamed text events. The interview service separately persists Q/A history
  and final documents to markdown; the tests assert that history is appended
  and preserved across writes.
- **Exact v2 surface:** Session context hooks can inject or transform current
  context; Promise storage provides JSON get/set/remove/scan; event subscription
  observes public events. No API automatically restores a plugin-owned
  interview transcript into a reloaded session.
- **What changes:** native code must define durable state, versioning, reload
  reconciliation, and prompt injection itself. In-memory projections are not
  recovery.
- **Disposition:** redesign with explicit storage and recovery tests, or retire
  reload reconstruction.

Source: [Promise storage domain](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/plugin/src/promise/storage.ts#L4-L9),
[current in-memory/context reconstruction](../src/v2/interview-bridge.ts#L56-L66),
[current markdown persistence](../src/interview/document.ts#L400-L491),
[history preservation tests](../src/interview/interview.test.ts#L283-L356).

### TUI and preset controls

**Classification: Direct official mapping for TUI controls; supported only with
behavior change for preset semantics.**

- **v1 behavior:** `/preset` has an interactive switcher, and v1 uses TUI
  notifications/toasts for user feedback.
- **Exact v2 surface:** the Promise plugin definition may set `tui: true`; the
  TUI context exposes `ui.toast`, dialogs including `select`, keymap commands,
  slots, tabs, data, attention, and durable storage. Promise command
  definitions and `session.switchModel` are also available, but do not by
  themselves recreate the v1 preset semantics.
- **What changes:** native migration must implement a TUI plugin/control path
  and decide how preset selection updates configuration and sessions. The
  current Promise adapter does not bridge these controls.
- **Disposition:** map TUI controls directly in a native TUI plugin; rebuild
  `/preset` selection and its configuration/session effects explicitly. Do not
  claim current adapter parity.

Source: [Promise plugin definition](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/plugin/src/promise/plugin.ts#L19-L49),
[TUI controls](https://github.com/anomalyco/opencode/blob/d6deb62379c54dc60468b80c498bd6a5899797cf/packages/plugin/src/tui/context.ts#L241-L468),
[current v2 setup](../src/v2/setup.ts#L194-L218).

## Migration disposition

The native implementation should proceed in this order:

1. Extract host-neutral agent, prompt, tool, and configuration logic without
   carrying v1 hook payloads across the boundary.
2. Implement direct mappings: session context, tools, executable commands,
   MCPs, event observation, and the explicitly chosen TUI surface.
3. Specify behavior changes for failover, telemetry, companion signals,
   interview recovery, and session-based background work.
4. Retire unavailable v1 contracts: global command interception, legacy task
   scheduler/child reads, external multiplexer panes, and tool permission or
   cancellation interception.
5. Verify native registration, cleanup, context transformation, tool lifecycle,
   MCP registration, event mapping, TUI controls, and both host cutover paths
   before removing the adapter.
