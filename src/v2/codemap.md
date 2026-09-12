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
| `setup.ts` | `createV2Setup()` → the `setup(ctx)` orchestrator v2 calls. Capability-guards reduced/TUI-side hosts (no `agent.transform`). Registers agents, tools, MCPs, commands, the merged context hook, tool-execute bridges, and the event pump — each independently try/catch-guarded with a zero-registration health check. Exports the pure command-marker helpers (`wrapCommandMarker`/`parseCommandMarker`/`stripCommandMarker`, thin wrappers over the shared `command-marker.ts` kit, whose configured instance `COMMAND_MARKER` is exported as a test seam), `createCommandRegistration`, `applyCommandMarkerToContext`, the merged context-hook builder `createSessionContextHandler`, the tool-execute bridge factory `createToolExecuteBridges`, and `adaptMcpServer`. |
| `types.ts` | v2 plugin context surface (`V2Context` + draft/event types), mirrored locally (v2 plugin package is not a build-time dependency). Runtime-probed session methods (`get`/`interrupt`/`switchModel`/`context`/`prompt`/`synthetic`/`rename`/`switchAgent`) and the optional `mcp` domain are declared optional with probe notes. |
| `session-submit.ts` | Shared `createSessionSubmit` (prompt-only user-prompt submit via `ctx.session.prompt`) + `textFromContent`/`joinTextParts` (text-part joiner with an explicit separator; byte-identical outputs pinned by `session-submit.test.ts`); used by both the generic command bridge and the interview bridge to avoid a setup↔bridge import cycle. |
| `client-shim.ts` | `buildPluginInput`: constructs a v1-shaped `PluginInput` with a **real-delegation** client — v1 SDK call shapes translate to v2 flat session calls (`get`, `interrupt`, `context`, `prompt` with `delivery:"steer"`, `rename`), with honest degradation (log or omit) where the host lacks the method. `resolveV2Directory` prefers `ctx.location.directory` (#45403+) with a `process.cwd()` fallback. `promptAsync` encapsulates the v2 model-switch semantics (`switchModel` before the prompt) and accepts an optional `delivery` argument (default `"steer"` for the foreground-fallback replay; the orchestrator-wake scheduler passes `"queue"` to match v1's queued prompt_async) plus an optional `modelSwitch: 'required'` argument (foreground-fallback: a host without `session.switchModel` rejects the replay with a typed `V2SwitchModelUnavailableError` instead of silently replaying on the failed model; pin-callers keep the logged steer). A failing `switchModel` degrades to steering on the current model — logged, with `switched: false` attached to the result so foreground-fallback can gate its switch bookkeeping on the truth (#1125); internal-initiator body parts (wake prompts) route through `session.synthetic` when the host provides it (`resume: true`, same `delivery`, metadata carried) so the wake text stays model-visible without being persisted/rendered as a user bubble — without it they map to prompt `metadata` so the session-prompt bridge can restore the v1 part marker (degraded host: visible wake message). `session.list` maps v2 `Session.Info` to the v1 `{data}` envelope including `outcome`/`time.updated`/`directory` (interview dashboard scan + orchestrator-wake children enumeration). Marks the input `hostFlavor: 'v2'` (multiplexer gating and wake-mode resolution in `src/index.ts` / `src/hooks/orchestrator-wake/`) and threads the probed `generate.text` channel as `experimental_v2`. Never fakes success shapes (no invented `serverUrl`). |
| `delegation.ts` | v2↔v1 delegation tool normalization: `toolNameToV1` (`subagent`→`task`), `subagentArgsToV1` (`agent`→`subagent_type`, `sessionID`→`task_id`), `v1ArgsToSubagent` (reverse). Lets the whole v1 pipeline (task-session-manager, job board, `task_*` tools) run on v2's host `subagent` tool with zero changes. |
| `event-adapter.ts` | `mapV2EventToV1`: additive-only v2→v1 event synthesis for the event pump. Raw event always first (interview bridge consumes it); payload is read from the live wire key `data` (`{id, created, type, location?, durable?, data}` — verified live on beta-19365) with `properties` as the legacy/test fallback, while every synthesized shape writes `properties` (what the v1 consumers read). Syntheses: idle `session.status` → `session.idle`, `session.execution.*` → v1 busy/idle/error lifecycle shapes, flat child `session.created` → v1 early-registration `{info:{id,parentID,agent?}}`, usage telemetry (`session.usage.updated`/`session.step.ended`) → deduplicated completed-assistant `message.updated` (deterministic fingerprint id; no wall-clock/randomness). |
| `tui.ts` | v2 TUI plugin entry (`./tui` export → `dist/tui2.js`): re-exports the v1 dual-contract TUI (`../tui`) and extends its v2 `setup` with the `/preset` keymap flow (`ui.dialog.select` + toast; persists via `switchPresetOnDisk`; `/preset <name>` fast path). Capability-guarded: builds without `keymap.layer`/`ui.dialog.select` keep the sidebar and lose only `/preset`. |
| `adapters.ts` | Shape adapters: `parseModelRef`, `adaptPermissions` (v1 map → v2 Rule[] + v2 permissive base + `task`→`subagent`/`bash`→`execute` mapping), `rewritePromptForV2` (`task(`→`subagent(`), `adaptTool`, `applyAgentToDraft`. |
| `interview-bridge.ts` | v2-only `/interview` marker command, trailing-message context bridge, v2 interview runtime, and per-session transcript projections (raw-event retention gated on active interviews, lazy memoized projection via `runtime.messages()`, FIFO cap 1024). |
| `command-marker.ts` | Shared whole-text-anchored command-marker kit factory (`createCommandMarkerKit`): parameterized `pattern`/`wrap`/`parse`/`strip` used by both the generic `<omos-cmd-command data-name=…>` marker (`setup.ts`) and the name-less `<omos-interview-command>` marker (`interview-bridge.ts`). Wire-format bytes are pinned by `command-marker.test.ts`; `$`-safety via wrap-side concatenation and a strip-side function replacer. |
| `setup-command.test.ts` | Unit tests for the command marker helpers, add-only draft registration, the shared submit helper, and the merged context-hook seam. |
| `command-marker.test.ts` | Kit unit tests against the REAL configured kits exported from `setup.ts` (`COMMAND_MARKER`) and `interview-bridge.ts` (`INTERVIEW_MARKER`): pinned pattern sources (config-drift guard), exact wrap shapes, wrap→parse→strip round-trips for both marker kinds, `$`-safety, whole-text anchoring, non-greedy closing-tag recovery, and the `trimArgs` raw-vs-trimmed semantics; plus synthetic-config tests for the factory's defaults and segment assembly. |

## Data Flow

1. v2 supervisor decodes `default` as `{ id, setup }` and calls `setup(ctx)`.
2. `setup` probes optional capabilities (`ctx.generate.text` for one-shot
   generation), builds a v1 `PluginInput` (`client-shim`, `hostFlavor: 'v2'`,
   directory from `ctx.location`), and invokes the v1 factory
   `OhMyOpenCodeLite` → receives v1 `Hooks`.
3. Runs the v1 `config()` hook against a synthesized config to resolve agent
   models and slash commands.
4. Registers into v2 domains:
   - `agent` → `ctx.agent.transform` (via `applyAgentToDraft`;
     `draft.default("orchestrator")`)
   - `tool` → `ctx.tool.transform` (via `adaptTool`, zod shape → JSON schema)
   - `mcp` → `ctx.mcp.transform` (`draft.set(name, adaptMcpServer(cfg))` for
     the built-in MCPs; capability-probed — hosts without the domain log
     "MCPs stay config-only")
   - `command` → `ctx.command.transform` (add-only draft; `execute` submits a
     `<omos-cmd-command>` marker as a user prompt via the shared session
     submit)
   - `/interview` command via the interview bridge's own registration
   - a single `ctx.session.hook("context")` handles the system/messages
     transforms (SystemPart[]/Message.content ↔ v1 `{info,parts}` conversion +
     `rewritePromptForV2`), `chat.message` agent tracking, and interview +
     generic command marker dispatch (whole-text-anchored markers recovered
     from the trailing user message and routed to the v1
     `command.execute.before` hook)
   - `tool.execute.before/after` → `ctx.tool.hook` via
     `createToolExecuteBridges`: subagent→task name/args normalization
     (`delegation.ts`), a mutable args view written back after the hook
     (so apply-patch repairs reach v2), and rethrow-on-before-failure so v2
     rejects the call (v1 guard enforcement)
   - `event` → `ctx.event.subscribe()` loop: raw event to the interview
     bridge first, then each `mapV2EventToV1` product to the v1 event hook
5. Returns a cleanup that disposes every v2 registration + the v1 `dispose`.

Each bridge in step 4 is independently try/catch-guarded so one failure cannot
disable the rest; a zero-registration load logs a health-check warning.

The interview bridge is intentionally separate from `client-shim.ts`: it uses
v2 session methods and in-memory context/text event projections rather than
expanding the global v2 client surface.

## Key Decisions

- **No v2 type imports.** The v2 plugin package is not a build-time dependency
  (v1 host must load the main build). `types.ts` mirrors the consumed subset;
  optional domains are probed at runtime.
- **Wrap, don't reimplement.** The v1 factory owns all subsystem wiring
  (agents, hooks, job board, multiplexer, companion); the adapter only
  translates at the boundary.
- **Real delegation, honest degradation.** The client shim maps v1 SDK calls
  to the v2 session surface where it exists and explicitly fails/logs where it
  does not — capability probes (e.g. `session.get` presence) must see the
  truth, so no method is stubbed with a fake success shape.
- **Subagent normalization at the execute bridge.** v2's host `subagent` tool
  is translated to v1 `task` semantics in `createToolExecuteBridges`
  (names + args, both directions), reusing the v1 task pipeline unchanged;
  before-hook failures rethrow so v2 refuses the call like v1 does.
- **Additive event synthesis.** `mapV2EventToV1` never mutates the raw event;
  synthesized v1 shapes are appended for the specific fields the v1 consumers
  read (early registration gated on `parentID`; telemetry deduped by a
  deterministic fingerprint — no wall-clock or randomness).
- **Permission base.** v1 permission maps list only explicit entries (unlisted
  → implicit default-allow); v2 has no implicit default, so `adaptPermissions`
  prepends v2's standard permissive base before overlaying v1 entries.
- **Interview configuration.** `setup` resolves the current plugin config and
  passes the complete `interview` object to the v2 interview bridge. The bridge
  uses its `maxQuestions`, `outputFolder`, `autoOpenBrowser`, `port`, and
  `dashboard` values rather than rebuilding defaults at the boundary.
- **Interview cache boundary.** The interview context hook only rewrites the
  current trailing command message; prior messages remain unchanged for
  provider prompt-cache prefix reuse.
- **Commands via marker round-trip.** v2 command drafts are add-only, so
  `execute` submits a whole-text-anchored `<omos-cmd-command>` marker as a
  user prompt and the session context hook dispatches it to the v1
  `command.execute.before` hook, mutating only the trailing message (same
  cache-preserving rule as the interview bridge).
- **Capability guard.** Hosts invoking `setup()` with a reduced/TUI-side ctx
  (no `agent.transform`) are skipped gracefully instead of crashing.
- **Shared session submit.** A single `session-submit.ts` helper submits
  marker text via `ctx.session.prompt` for both the generic commands and the
  interview bridge.

## Integration Points

- `src/index.ts`: imports `createV2Setup` for the dual `default` export
  (`{ id, server, setup }` — no `tui` key; hosts validate that a server
  module's `tui` field is a function and never coexists with `server`) and
  exports `OhMyOpenCodeLite` (named) for the
  adapter to wrap. The `hostFlavor: 'v2'` marker from the shim gates the
  multiplexer off (`shouldEnableMultiplexer` /
  `sessionManagerMultiplexerConfig`).
- `src/tools/smartfetch/secondary-model.ts`: consumes the
  `experimental_v2.generateText` channel threaded by `setup` for one-shot
  summaries; absent channel → secondary-model summaries are unavailable
  (logged) — the v2 shim has no `session.create`/`tool.ids`, so the v1
  session pipeline cannot substitute.
- Build: `build:v2` bundles `src/index.ts` (which pulls in `src/v2/`) into
  `dist/server/index.js` (self-contained except `jsdom`) — the directory
  entrypoint v2 hosts ≥ beta-18743 require, also served via the
  `./server` package subpath (the exports map resolves it directly);
  `build:tui` bundles `src/v2/tui.ts` into `dist/tui2.js`.

## Limitations (see `docs/opencode-v2-compatibility.md`)

Multiplexer is v1-only by design (v2 renders subagents natively). The
orchestrator-wake scheduler runs on v2 in children-driven degraded mode
(list+promptAsync gate, `session.list({parentID})` enumeration with the
event-tracked fallback, outcome-based condition with a 3×-interval staleness
bound, `queue` delivery — see `src/hooks/orchestrator-wake/codemap.md`).
MCP registration needs `ctx.mcp.transform` ≥ #45408 (older builds:
config-only snippet). Model switching needs `session.switchModel` ≥ #43718;
directory needs `ctx.location` ≥ #45403 (older builds: cwd). Companion is
unverified on v2. Prompt-cache safety rules are unchanged
(trailing-message-only mutation).
