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
| `setup.ts` | `createV2Setup()` → the `setup(ctx)` orchestrator v2 calls. Capability-guards reduced/TUI-side hosts (no `agent.transform`). Exports the pure command-marker helpers (`wrapCommandMarker`/`parseCommandMarker`/`stripCommandMarker`), `createCommandRegistration`, `applyCommandMarkerToContext`, and the merged context-hook builder `createSessionContextHandler`. |
| `types.ts` | v2 plugin context surface (`V2Context` + draft/event types), mirrored locally (v2 plugin package is not a build-time dependency). |
| `session-submit.ts` | Shared `createSessionSubmit` (prompt-only user-prompt submit via `ctx.session.prompt`) + `textFromContent`; used by both the generic command bridge and the interview bridge to avoid a setup↔bridge import cycle. |
| `client-shim.ts` | `buildPluginInput`: constructs a v1-shaped `PluginInput` (shimmed `client`, `process.cwd()` directory) for the v1 factory. |
| `adapters.ts` | Shape adapters: `parseModelRef`, `adaptPermissions` (v1 map → v2 Rule[] + v2 permissive base + `task`→`subagent`/`bash`→`execute` mapping), `rewritePromptForV2` (`task(`→`subagent(`), `adaptTool`, `applyAgentToDraft`. |
| `interview-bridge.ts` | v2-only `/interview` marker command, trailing-message context bridge, v2 interview runtime, and per-session transcript projections. |
| `setup-command.test.ts` | Unit tests for the command marker helpers, add-only draft registration, the shared submit helper, and the merged context-hook seam. |

## Data Flow

1. v2 supervisor decodes `default` as `{ id, setup }` and calls `setup(ctx)`.
2. `setup` builds a v1 `PluginInput` (`client-shim`) and invokes the v1 factory
   `OhMyOpenCodeLite` → receives v1 `Hooks`.
3. Runs the v1 `config()` hook against a synthesized config to resolve agent
   models and slash commands.
4. Registers into v2 domains:
   - `agent` → `ctx.agent.transform` (via `applyAgentToDraft`)
   - `tool` → `ctx.tool.transform` (via `adaptTool`, zod shape → JSON schema)
   - `command` → `ctx.command.transform` (add-only draft; `execute` submits a
     `<omos-cmd-command>` marker as a user prompt via the shared session
     submit)
   - a single `ctx.session.hook("context")` handles the system/messages
     transforms (SystemPart[]/Message.content ↔ v1 `{info,parts}` conversion +
     `rewritePromptForV2`), `chat.message` agent tracking, and interview +
     generic command marker dispatch (whole-text-anchored markers recovered
     from the trailing user message and routed to the v1
     `command.execute.before` hook)
   - `tool.execute.before/after` → `ctx.tool.hook`
   - `event` → `ctx.event.subscribe()` loop
   - interview marker/context/events → `interview-bridge.ts` (supplies
     `registerCommand`/`handleContext`/`handleEvent` to the merged hook — no
     separate registration)
5. Returns a cleanup that disposes every v2 registration + the v1 `dispose`.

Each bridge in step 4 is independently try/catch-guarded so one failure cannot
disable the rest.

The interview bridge is intentionally separate from `client-shim.ts`: it uses
v2 session methods and in-memory context/text event projections rather than
expanding the global v2 client surface.

## Key Decisions

- **No v2 type imports.** The v2 plugin package is not a build-time dependency
  (v1 host must load the main build). `types.ts` mirrors the consumed subset.
- **Wrap, don't reimplement.** The v1 factory owns all subsystem wiring
  (agents, hooks, job board, multiplexer, companion); the adapter only
  translates at the boundary.
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

- `src/index.ts`: imports `createV2Setup` for the dual `default` export and
  exports `OhMyOpenCodeLite` (named) for the adapter to wrap.
- Build: `build:v2` bundles `src/index.ts` (which pulls in `src/v2/`) into
  `dist/server.js` (self-contained except `jsdom`).

## Limitations (see `docs/opencode-v2-compatibility.md`)

Built-in MCPs are config-only on v2 (no programmatic MCP hook); runtime
`/preset` live-reload, multiplexer, companion, and foreground-fallback run
best-effort via the shimmed client; `directory` comes from `process.cwd()`.
