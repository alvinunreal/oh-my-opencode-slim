# Directory Map: `src/v2/`

## Responsibility

OpenCode v2 (`opencode2`) host adapter. Bridges the existing v1 plugin factory
into v2's promise-plugin transform/runtime-hook API so a single published
package runs on both hosts.

v2 loads `default.setup(ctx)` (v1 loads `default.server`). `setup` wraps the v1
factory to reuse all build logic, then translates the returned v1 `Hooks` into
v2 registrations. v1 behavior is unchanged.

`client-shim.ts` treats a named `session.prompt` agent as an owning-identity
assertion against the persisted session agent, not a selection override;
unverified identity and model/variant overrides fail before prompt admission.
Task messages also supply a local synchronous `beforeSend` guard so their
existing disposal/lease/owner checks run again after that identity read and
immediately before native admission; it is never forwarded to the host.

## Entry Points

| Path | Role |
|---|---|
| `index.ts` | Barrel: re-exports `createV2Setup` and the v2 context types. Imported by `src/index.ts` for the dual `default` export. |
| `setup.ts` | `createV2Setup()` → the `setup(ctx)` orchestrator v2 calls. Capability-guards reduced/TUI-side hosts (no `agent.transform`). Registers agents, tools, MCPs, commands, the merged context hook, the native `session.prompt` bridge (raw admission ids feed the v1 pending tracker ahead of its first-agent deferral), the chat.headers `session.model.request` bridge, the `session.compaction` bridge, tool-execute bridges, and the event pump. Session hooks register **unconditionally** on full v2 contexts: a registration failure fails setup loudly. MCP transform is registered before agent transform; setup never materializes `ctx.agent.list()`. The MCP callback captures host namespaces, then the agent callback finalizes the registry and opens prompt readiness. Deferred callbacks do not fail setup, but an agent callback before the MCP snapshot fails rather than finalizing incomplete policy. Managed prompts fail closed until agent finalization. Missing MCP transform is unsupported and fails setup. Other domain transforms remain independently try/catch-guarded with a zero-registration health check. Child-session permission rules are applied via `ctx.session.update({sessionID, permissions})` (`createPermissionRulesBridge`); missing `session.update` remains an optional degraded child bridge. Exports the pure command-marker helpers (`wrapCommandMarker`, `parseCommandMarker`, `stripCommandMarker`). Plugin CHILD sessions freeze the current runtime profile (`createSessionProfileBridge`: `session.switchModel` only while the child still runs the startup-registered selection, including variant with absence normalized to `default`, + per-session request options), captured on the AWAITED `session.prompt` hook path so a first child request cannot race the event pump ? the raw-event consumer is only a prewarm/cleanup path.
| `types.ts` | v2 plugin context surface (`V2Context` + draft/event types), mirrored locally (v2 plugin package is not a build-time dependency). Runtime-probed session methods (`get`/`interrupt`/`switchModel`/`context`/`prompt`/`synthetic`/`update`/`switchAgent`) and the optional `mcp` domain are declared optional with probe notes. |
| `session-submit.ts` | Shared `createSessionSubmit` (prompt-only user-prompt submit via `ctx.session.prompt`) + `textFromContent`; used by both the generic command bridge and the interview bridge to avoid a setup↔bridge import cycle. |
| `preset-command.ts` | Server-side, apply-only `/preset` for non-TUI clients (issues #1474, #1700): lists presets with no argument, otherwise binds the invoking session through `session-preset-apply` (the same result as the TUI fast path). It never writes the global default. A config switch must not run a turn, and v2 has no display-only message channel (a synthetic inbox item enters the context on the next turn), so the command definition rejects with its feedback — the one surface a non-TUI client renders without creating a message or waking a turn. |
| `session-preset-apply.ts` | Session-scoped preset switching shared by the TUI `/preset <name>` fast path and the server command: validates the name against the visible presets, owns the applied/refused wording, and takes a `bind` transport seam (TUI: session-preset RPC; server: the in-process store). A switch binds future subagent inference only; the root model, existing children and the global default stay unchanged. |
| `client-shim.ts` | `buildPluginInput`: constructs a v1-shaped `PluginInput` with a **real-delegation** client — v1 SDK call shapes translate to v2 flat session calls (`get`, `interrupt` — abort sends `resume: false`, `context`, `prompt` with `delivery:"steer"`, `update` for renames — `{sessionID, title}`), with honest degradation (log or omit) where the host lacks the method. A v1-shaped `noReply` prompt body maps to `delivery:"queue", resume:false` (no wake); non-noReply prompts steer. `resolveV2Directory` prefers `ctx.location.directory` (#45403+) with a `process.cwd()` fallback. `promptAsync` encapsulates v2 model switching and defaults to `"steer"` for foreground-fallback replay; chat-header metadata is derived internally from the body's internal-initiator parts. |
| `internal-admissions.ts` | Bounded tracker of internal-initiator admissions (`recordInternalAdmission`/`isInternalAdmission` + `createInternalSyntheticMessageID`): the in-band marker source for the chat-headers bridge on v2 (prompt-metadata admissions recorded by the session-prompt bridge; synthetic admissions recorded by the client shim with the client-chosen id the v2 `Session.synthetic` endpoint honors and preserves on the LLM context message). |
| `delegation.ts` | v2↔v1 delegation tool normalization: `toolNameToV1` (`subagent`→`task`), `subagentArgsToV1` (`agent`→`subagent_type`, `sessionID`→`task_id`), `v1ArgsToSubagent` (reverse). Lets the whole v1 pipeline (task-session-manager, job board, `task_*` tools) run on v2's host `subagent` tool with zero changes. |
| `event-adapter.ts` | `mapV2EventToV1`: additive-only v2→v1 event synthesis for the event pump. Raw event always first (interview bridge consumes it); payload is read from the live wire key `data` (`{id, created, type, location?, durable?, metadata?, data}` — verified live on v2 hosts) with `properties` as the legacy/test fallback, while every synthesized shape writes `properties` (what the v1 consumers read). Syntheses: `session.execution.*` → v1 busy/idle/error lifecycle shapes (every synthesized busy AND terminal idle status preserves the host envelope `created` as `activityAt` so terminal evidence keeps host-clock attribution), flat child `session.created` → v1 early-registration `{info:{id,parentID,agent?}}`, per-request `session.step.ended` telemetry → completed-assistant `message.updated` keyed by assistant message ID. Cumulative `session.usage.updated` is not subscribed. |
| `mirror-conformance.ts` | Mirror conformance guard (P1.2): type-level verification that the hand-written v2→v1 mirror matches the @opencode/plugin upstream surface exactly. Prevents drift between the v2 contract and the v1 consumption surface. |
| `tui.ts` | Thin v2 TUI plugin entry (`./tui` export → `dist/tui2.js`): reads gates from the light `../tui-gates` module and only then dynamically imports `tui-impl`; `tui: false` never evaluates the render stack. `tui-impl.ts` composes the v1 dual-contract TUI (`../tui`) and extends its v2 `setup` with the `/preset` keymap flow. The layer registers from an `append: "app"` slot render because the host's `keymap.layer` is provider-scoped (calling it from `setup` throws `Keymap.Provider is missing`), using the host's thunk + full command schema (`id`, `palette`, `slash.arguments`); feedback via `ui.toast.show`; `/preset <name>` binds the visible session through the session-preset RPC (`session-preset-apply`), while bare `/preset` opens the manager whose Global default action writes config and requests the shared config-change coordinator. Config-write success toasts say "Live refresh requested" — never "applied" and never "Reload OpenCode" (the server watcher's outcome is unobservable from the TUI process) — and a failed request shows the reload fallback. Capability-guarded: hosts without `ui.slot`/`keymap.layer` keep the sidebar and lose only `/preset`; the interactive picker additionally needs `ui.dialog.select`. |
| `update-notice.ts` | v2 "a newer release is available" notice (issue #1655): the server-side checker detects updates but its `client.tui.showToast` is a logging no-op in `client-shim.ts`, so delivery moved to the TUI. `registerUpdateNotice` schedules a check 1.5 s after setup (never the startup path), resolves the installed version from the running copy's own `package.json` (module-relative, name-checked) with `client.plugin.list` as the fallback - never a cache scan, which can read a higher leftover copy and hide the update - fetches `registry.npmjs.org/<pkg>/latest` under a 4 s bound that covers the body read, and — only for a strictly newer **same-major** version — toasts `v<installed> → v<latest> · run opencode plugin update` and registers a muted `sidebar.footer` badge (the durable trace for a missed toast). Silent and throw-free on offline/timeout/unparseable versions/new major/missing `client`/`toast`/`slot`; the disposer clears the timer and the badge claim. |
| `adapters.ts` | Shape adapters: `parseModelRef`, `adaptPermissions` (v1 map → v2 Rule[] + v2 permissive base + `task`→`subagent`/`bash`→`shell` mapping), `rewritePromptForV2` (`task(`→`subagent(`), `adaptTool`, `applyAgentToDraft`. |
| `interview-bridge.ts` | v2-only `/interview` marker command, trailing-message context bridge, v2 interview runtime, and per-session transcript projections. |
| `mirror-conformance.ts` | Compile-time conformance guard binding the hand-mirrored v2 context types in `types.ts` to the pinned `@opencode/plugin` surface; enforced by `bun run typecheck` — deliberately no `.test.ts` suffix (tsc excludes test files) and never imported at runtime. |

## Runtime Input Reuse

`setup.ts` shares one startup config snapshot with the factory, switches, skills
and initial profile seed; deliberate refreshes revalidate source identity.
`session-presets.ensureAdmission` returns the record and validated host identity
from one binding transaction. `admission-view.ts` supplies profile facts to the
existing capture seam without a second binding read. Later admissions still
check directory/parent/storage. Attributed messages skip stored-history reads.

`event-subscription.ts` freezes the native type union for enabled consumers,
including correlated `session.step.started`/`session.step.failed` refusal
signals for foreground fallback. The client shim exposes the real optional
`session.switchModel` capability for that path.
The foreground subagent wrapper rejoins a refused child after the shared fallback
outcome; the context hook presents an admitted background refusal as running
without changing the host's stored notice. The client shim treats `idle` and
`model-switched` markers as system entries when inspecting child results.
Interview receives `session.text.*` with `assistantMessageID`; its v2 bridge is
the only Interview owner on this host. Event payload extraction is shared, but
recovery/permission/profile owners remain distinct. One native-event batch
coalesces its mapped TUI projections without changing raw-first synthesis.

## Flow

The v2 runtime surface and plugin contracts are adapted through the following data flow:

1. **Capability Detection**: The v2 orchestrator calls `setup(ctx)` which probes optional capabilities like `ctx.location.directory` for directory access.

2. **V1 Plugin Input Construction**: The client shim builds a v1-shaped `PluginInput` using the v2 session surface where it exists (real delegation) with honest degradation where it doesn't. This includes:
   - Translating `subagent` tool calls to v1 `task` semantics
   - Mapping v2 model refs (`{id, providerID}`) to v1 chat.message models (`{providerID, modelID}`)
   - Handling session IDs between `sessionID` ↔ `task_id` mappings
   - Resolving directory paths from `ctx.location` or falling back to `process.cwd()`

3. **V1 Plugin Invocation**: The built `PluginInput` invokes the v1 factory `OhMyOpenCodeLite`, receiving v1 `Hooks` that encapsulate all the build logic and subsystem wiring.

4. **V2 Domain Registrations**: The setup translates v1 hooks into v2 domain registrations:

   - **Agent domain**: Uses `applyAgentToDraft` to create v2 agent drafts from v1 agent configs, with the orchestrator agent registered as default. Definitions are registered exactly once — config changes never re-register or reload them
    - **Runtime profiles**: A config-candidate watcher (`config-watch.ts`) re-resolves ONLY model/variant/temperature/options through the v1 `v2.refreshProfiles` hook, atomically swaps the profile table, republishes the fallback chains in the same generation (config + marketplace-merged; `buildChainGeneration`/`publishChainGeneration` in the v1 factory), rewrites the sidebar projection (`recordTuiAgentModels`), and freezes the current profile — pinning that chain generation via `v2.pinSessionChains` — for each plugin child (`runtime-profiles.ts`) on the AWAITED `session.prompt` path (the `session.created` event consumer is a prewarm) before its first request (`session.switchModel` unless the child already runs a per-call model/variant that still resolves in the host catalog — a provably retired pin is refreshed to the current profile (issue #1689) —, + request options). A malformed config is rejected before any swap (last-known-good state kept)
   - **Tool domain**: Uses `adaptTool` to convert v1 tool definitions to v2 JSON schemas via zod shape adaptation, passing the native cancellation signal to `abort` and tool metadata to `progress`
   - **MCP domain**: Uses `adaptMcpServer` to convert v1 McpConfig to v2 Mcp.ServerConfig (fields are nearly identical with minor cleanup)
   - **Command domain**: Uses marker-based round-trip registration where v2 command drafts are add-only, and `execute` submits whole-text-anchored `<omos-cmd-command>` markers as user prompts
   - **Session hooks**: Single `ctx.session.hook("context")` handles system/messages transforms, chat.message agent tracking, and marker dispatch with interview bridge integration. Stored synthetic delivery timestamps are projected into the observer by message ID and omitted again from the outgoing context.
   - **Runtime bridges**: Separate session hooks for `prompt`, `model.request`, and `compaction` bridges that adapt v1 chat.headers, chat.message, and session.compaction to v2
   - **Permission rules**: Uses `createPermissionRulesBridge` to apply child-session permission rules via `ctx.session.update({sessionID, permissions})`
   - **Tool execute bridges**: Uses `createToolExecuteBridges` to normalize `subagent`→`task` semantics for tool.execute.before/after hooks
   - **Event pump**: Uses `mapV2EventToV1` for additive-only v2→v1 event synthesis, preserving raw events for the interview bridge

5. **Initialization and Cleanup**: The setup returns a cleanup function that disposes every v2 registration and the v1 `dispose`.

## Key Decisions

- **No v2 type imports.** The v2 plugin package is not a build-time dependency (v1 host must load the main build). `types.ts` mirrors the consumed subset; optional domains are probed at runtime.
- **Wrap, don't reimplement.** The v1 factory owns all subsystem wiring (agents, hooks, job board, multiplexer, companion); the adapter only translates at the boundary.
- **Real delegation, honest degradation.** The client shim maps v1 SDK calls to the v2 session surface where it exists and explicitly fails/logs where it does not — capability probes (e.g. `session.get` presence) must see the truth, so no method is stubbed with a fake success shape.
- **Subagent normalization at the execute bridge.** v2's host `subagent` tool is translated to v1 `task` semantics in `createToolExecuteBridges` (names + args, both directions), reusing the v1 task pipeline unchanged; before-hook failures rethrow so v2 refuses the call like v1 does.
- **Additive event synthesis.** `mapV2EventToV1` never mutates the raw event; synthesized v1 shapes are appended for the specific fields the v1 consumers read (early registration gated on `parentID`; telemetry deduped by a deterministic fingerprint — no wall-clock or randomness).
  Shutdown interruptions remain raw-only: the native host suspends their
  execution claims instead of publishing a terminal idle transition.
- **Permission base.** v1 permission maps list only explicit entries (unlisted → implicit default-allow); v2 has no implicit default, so `adaptPermissions` prepends v2's standard permissive base before overlaying v1 entries.
- **Interview configuration.** `setup` resolves the current plugin config and passes the complete `interview` object to the v2 interview bridge. The bridge uses its `maxQuestions`, `outputFolder`, `autoOpenBrowser`, `port`, and `dashboard` values rather than rebuilding defaults at the boundary.
- **Interview cache boundary.** The interview context hook only rewrites the current trailing command message; prior messages remain unchanged for provider prompt-cache prefix reuse.
- **Commands via marker round-trip.** v2 command drafts are add-only, so `execute` submits a whole-text-anchored `<omos-cmd-command>` marker as a user prompt and the session context hook dispatches it to the v1 `command.execute.before` hook, mutating only the trailing message (same cache-preserving rule as the interview bridge).
- **Capability guard.** Hosts invoking `setup()` with a reduced/TUI-side ctx (no `agent.transform`) are skipped gracefully instead of crashing.
- **Session-frozen runtime profiles.** Config/preset changes never rebuild agent definitions or reload the host registry. Only model/variant (via `session.switchModel` before a new child's first request, unless it already runs a per-call model/variant that still resolves in the catalog — a provably retired pin is refreshed to the current profile) and temperature/provider options (per-session request options) hot-apply to NEW child sessions; capture is awaited on the `session.prompt` request path so the asynchronous event pump cannot race the first request. Existing/resumed children keep their captured profile, and system/tools/permissions/skills/MCPs/prompt content stay byte-stable (AGENTS.md prompt-cache rule). Failures are honest: malformed configs (`invalid-json`/`invalid-schema`/`read-error`) are rejected before any swap and the last-known-good profiles/sidebar stay; the TUI requests the refresh and never claims it was applied (the server watcher's outcome is unobservable from the TUI process) — no swap, no success log, no success toast on failure.
- **Shared session submit.** A single `session-submit.ts` helper submits marker text via `ctx.session.prompt` for both the generic commands and the interview bridge.

## Integration Points

- `src/index.ts`: imports `createV2Setup` for the dual `default` export (`{ id, server, setup }` — no `tui` key; hosts validate that a server module's `tui` field is a function and never coexists with `server`) and exports `OhMyOpenCodeLite` (named) for the adapter to wrap.
- Build: `build:v2` bundles `src/index.ts` (which pulls in `src/v2/`) into `dist/server/index.js` (self-contained except `jsdom`) — the directory entrypoint 2.x hosts require, also served via the
  `./server` package subpath (the exports map resolves it directly);
  `build:tui` bundles `src/v2/tui.ts` into `dist/tui2.js`.

## Limitations (see `docs/opencode-v2-compatibility.md`)

Multiplexer panes work on shared and `--server` v2 hosts; standalone and
invalid hosts ignore a configured `multiplexer.type` with one diagnostic per
process (NFR-6). The orchestrator-wake scheduler is v1-only; v2 uses the
host's native background notifier.
Finalized-registry setup captures configured MCP namespace inventory through
`ctx.mcp.transform` before the deferred agent transform callback runs. Setup
does not force host materialization with `ctx.agent.list()`. Until agent
finalization, prompt admission fails closed; a premature agent callback cannot
freeze policies without the host MCP inventory.
Namespaces already present in the host snapshot own their key: a built-in MCP
is never injected over an existing host/user entry (issue #1290).
Hosts without the MCP transform itself are unsupported and setup fails with an
actionable error.
`session.update` remains optional: hosts without it degrade only the PR7 child
permission bridge. Model switching needs
`session.switchModel` ≥ #43718; directory needs `ctx.location` ≥ #45403
(hosts without it fall back to cwd). Companion is
unverified on v2. Prompt-cache safety rules are unchanged
(trailing-message-only mutation).
