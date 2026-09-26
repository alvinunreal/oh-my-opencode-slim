# Directory Map: `src/v2/`

## Responsibility

OpenCode v2 (`opencode2`) host adapter. Bridges the existing v1 plugin factory
into v2's promise-plugin transform/runtime-hook API so a single published
package runs on both hosts.

v2 loads `default.setup(ctx)` (v1 loads `default.server`). `setup` wraps the v1
factory to reuse all build logic, then translates the returned v1 `Hooks` into
v2 registrations. v1 behavior is unchanged.

## Entry Points

| Path | Role |
|---|---|
| `index.ts` | Barrel: re-exports `createV2Setup` and the v2 context types. Imported by `src/index.ts` for the dual `default` export. |
| `setup.ts` | `createV2Setup()` → the `setup(ctx)` orchestrator v2 calls. Capability-guards reduced/TUI-side hosts (no `agent.transform`). Registers agents, tools, MCPs, commands, the merged context hook, the native `session.prompt` bridge, the chat.headers `session.model.request` bridge, the `session.compaction` bridge, tool-execute bridges, and the event pump. Session hooks register **unconditionally** on full v2 contexts: a registration failure fails setup loudly. The configured MCP inventory must be exposed through `ctx.mcp.transform` for finalized-registry namespace policy; missing MCP transform is unsupported and fails setup. Other domain transforms (agent/tool/command) remain independently try/catch-guarded with a zero-registration health check. Child-session permission rules are applied via `ctx.session.update({sessionID, permissions})` (`createPermissionRulesBridge`); missing `session.update` remains an optional degraded child bridge. Exports the pure command-marker helpers (`wrapCommandMarker`, `parseCommandMarker`, `stripCommandMarker`). |
| `types.ts` | v2 plugin context surface (`V2Context` + draft/event types), mirrored locally (v2 plugin package is not a build-time dependency). Runtime-probed session methods (`get`/`interrupt`/`switchModel`/`context`/`prompt`/`synthetic`/`update`/`switchAgent`) and the optional `mcp` domain are declared optional with probe notes. |
| `session-submit.ts` | Shared `createSessionSubmit` (prompt-only user-prompt submit via `ctx.session.prompt`) + `textFromContent`; used by both the generic command bridge and the interview bridge to avoid a setup↔bridge import cycle. |
| `client-shim.ts` | `buildPluginInput`: constructs a v1-shaped `PluginInput` with a **real-delegation** client — v1 SDK call shapes translate to v2 flat session calls (`get`, `interrupt` — abort sends `resume: false`, `context`, `prompt` with `delivery:"steer"`, `update` for renames — `{sessionID, title}`), with honest degradation (log or omit) where the host lacks the method. `resolveV2Directory` prefers `ctx.location.directory` (#45403+) with a `process.cwd()` fallback. `promptAsync` encapsulates the v2 model-switch semantics (`switchModel` before the prompt) and accepts an optional `delivery` argument (default `"steer"` for the foreground-fallback replay; the orchestrator-wake scheduler passes `"queue"` to match v1's queued prompt_async); chat-header metadata is derived internally from the body's internal-initiator parts, not passed by callers. |
| `internal-admissions.ts` | Bounded tracker of internal-initiator admissions (`recordInternalAdmission`/`isInternalAdmission` + `createInternalSyntheticMessageID`): the in-band marker source for the chat-headers bridge on v2 (prompt-metadata admissions recorded by the session-prompt bridge; synthetic admissions recorded by the client shim with the client-chosen id the v2 `Session.synthetic` endpoint honors and preserves on the LLM context message). |
| `delegation.ts` | v2↔v1 delegation tool normalization: `toolNameToV1` (`subagent`→`task`), `subagentArgsToV1` (`agent`→`subagent_type`, `sessionID`→`task_id`), `v1ArgsToSubagent` (reverse). Lets the whole v1 pipeline (task-session-manager, job board, `task_*` tools) run on v2's host `subagent` tool with zero changes. |
| `event-adapter.ts` | `mapV2EventToV1`: additive-only v2→v1 event synthesis for the event pump. Raw event always first (interview bridge consumes it); payload is read from the live wire key `data` (`{id, created, type, location?, durable?, metadata?, data}` — verified live on v2 hosts) with `properties` as the legacy/test fallback, while every synthesized shape writes `properties` (what the v1 consumers read). Syntheses: `session.execution.*` → v1 busy/idle/error lifecycle shapes, flat child `session.created` → v1 early-registration `{info:{id,parentID,agent?}}`, usage telemetry (`session.usage.updated`/`session.step.ended`) → deduplicated completed-assistant `message.updated` (deterministic fingerprint id; no wall-clock/randomness). |
| `mirror-conformance.ts` | Mirror conformance guard (P1.2): type-level verification that the hand-written v2→v1 mirror matches the @opencode/plugin upstream surface exactly. Prevents drift between the v2 contract and the v1 consumption surface. |
| `tui.ts` | v2 TUI plugin entry (`./tui` export → `dist/tui2.js`): re-exports the v1 dual-contract TUI (`../tui`) and extends its v2 `setup` with the `/preset` keymap flow. The layer registers from an `append: "app"` slot render because the host's `keymap.layer` is provider-scoped (calling it from `setup` throws `Keymap.Provider is missing`), using the host's thunk + full command schema (`id`, `palette`, `slash.arguments`); feedback via `ui.toast.show`; persists via `switchPresetOnDisk`; `/preset <name>` fast path. Capability-guarded: hosts without `ui.slot`/`keymap.layer` keep the sidebar and lose only `/preset`; the interactive picker additionally needs `ui.dialog.select`. |
| `adapters.ts` | Shape adapters: `parseModelRef`, `adaptPermissions` (v1 map → v2 Rule[] + v2 permissive base + `task`→`subagent`/`bash`→`execute` mapping), `rewritePromptForV2` (`task(`→`subagent(`), `adaptTool`, `applyAgentToDraft`. |
| `interview-bridge.ts` | v2-only `/interview` marker command, trailing-message context bridge, v2 interview runtime, and per-session transcript projections. |
| `mirror-conformance.ts` | Compile-time conformance guard binding the hand-mirrored v2 context types in `types.ts` to the pinned `@opencode/plugin` surface; enforced by `bun run typecheck` — deliberately no `.test.ts` suffix (tsc excludes test files) and never imported at runtime. |

## Flow

The v2 runtime surface and plugin contracts are adapted through the following data flow:

1. **Capability Detection**: The v2 orchestrator calls `setup(ctx)` which probes optional capabilities like `ctx.generate.text` for one-shot generation and `ctx.location.directory` for directory access.

2. **V1 Plugin Input Construction**: The client shim builds a v1-shaped `PluginInput` using the v2 session surface where it exists (real delegation) with honest degradation where it doesn't. This includes:
   - Translating `subagent` tool calls to v1 `task` semantics
   - Mapping v2 model refs (`{id, providerID}`) to v1 chat.message models (`{providerID, modelID}`)
   - Handling session IDs between `sessionID` ↔ `task_id` mappings
   - Resolving directory paths from `ctx.location` or falling back to `process.cwd()`

3. **V1 Plugin Invocation**: The built `PluginInput` invokes the v1 factory `OhMyOpenCodeLite`, receiving v1 `Hooks` that encapsulate all the build logic and subsystem wiring.

4. **V2 Domain Registrations**: The setup translates v1 hooks into v2 domain registrations:

   - **Agent domain**: Uses `applyAgentToDraft` to create v2 agent drafts from v1 agent configs, with the orchestrator agent registered as default
   - **Tool domain**: Uses `adaptTool` to convert v1 tool definitions to v2 JSON schemas via zod shape adaptation
   - **MCP domain**: Uses `adaptMcpServer` to convert v1 McpConfig to v2 Mcp.ServerConfig (fields are nearly identical with minor cleanup)
   - **Command domain**: Uses marker-based round-trip registration where v2 command drafts are add-only, and `execute` submits whole-text-anchored `<omos-cmd-command>` markers as user prompts
   - **Session hooks**: Single `ctx.session.hook("context")` handles system/messages transforms, chat.message agent tracking, and marker dispatch with interview bridge integration
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
- **Permission base.** v1 permission maps list only explicit entries (unlisted → implicit default-allow); v2 has no implicit default, so `adaptPermissions` prepends v2's standard permissive base before overlaying v1 entries.
- **Interview configuration.** `setup` resolves the current plugin config and passes the complete `interview` object to the v2 interview bridge. The bridge uses its `maxQuestions`, `outputFolder`, `autoOpenBrowser`, `port`, and `dashboard` values rather than rebuilding defaults at the boundary.
- **Interview cache boundary.** The interview context hook only rewrites the current trailing command message; prior messages remain unchanged for provider prompt-cache prefix reuse.
- **Commands via marker round-trip.** v2 command drafts are add-only, so `execute` submits a whole-text-anchored `<omos-cmd-command>` marker as a user prompt and the session context hook dispatches it to the v1 `command.execute.before` hook, mutating only the trailing message (same cache-preserving rule as the interview bridge).
- **Capability guard.** Hosts invoking `setup()` with a reduced/TUI-side ctx (no `agent.transform`) are skipped gracefully instead of crashing.
- **Shared session submit.** A single `session-submit.ts` helper submits marker text via `ctx.session.prompt` for both the generic commands and the interview bridge.

## Integration Points

- `src/index.ts`: imports `createV2Setup` for the dual `default` export (`{ id, server, setup }` — no `tui` key; hosts validate that a server module's `tui` field is a function and never coexists with `server`) and exports `OhMyOpenCodeLite` (named) for the adapter to wrap. The `hostFlavor: 'v2'` marker from the shim gates the multiplexer off (`shouldEnableMultiplexer` /
  `sessionManagerMultiplexerConfig`).
- `src/tools/smartfetch/secondary-model.ts`: consumes the `experimental_v2.generateText` channel threaded by `setup` for one-shot summaries; absent channel → secondary-model summaries are unavailable (logged) — the v2 shim has no `session.create`/`tool.ids`, so the v1 session pipeline cannot substitute.
- Build: `build:v2` bundles `src/index.ts` (which pulls in `src/v2/`) into `dist/server/index.js` (self-contained except `jsdom`) — the directory entrypoint 2.x hosts require, also served via the
  `./server` package subpath (the exports map resolves it directly);
  `build:tui` bundles `src/v2/tui.ts` into `dist/tui2.js`.

## Limitations (see `docs/opencode-v2-compatibility.md`)

Multiplexer is v1-only by design (v2 renders subagents natively). The
orchestrator-wake scheduler runs on v2 in children-driven degraded mode
(list+promptAsync gate, `session.list({parentID})` enumeration with the
event-tracked fallback, outcome-based condition with a 3×-interval staleness
bound, `queue` delivery — see `src/hooks/orchestrator-wake/codemap.md`).
Finalized-registry setup requires `ctx.mcp.transform` to expose the configured
MCP namespace inventory; hosts without it are unsupported and setup fails
with an actionable error. `session.update` remains optional: hosts without it
degrade only the PR7 child permission bridge. Model switching needs
`session.switchModel` ≥ #43718; directory needs `ctx.location` ≥ #45403
(hosts without it fall back to cwd). Companion is
unverified on v2. Prompt-cache safety rules are unchanged
(trailing-message-only mutation).
