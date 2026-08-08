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
| `setup.ts` | `createV2Setup()` → the `setup(ctx)` orchestrator v2 calls. |
| `types.ts` | v2 plugin context surface (`V2Context` + draft/event types), mirrored locally (v2 plugin package is not a build-time dependency). |
| `client-shim.ts` | `buildPluginInput`: constructs a v1-shaped `PluginInput` (shimmed `client`, `process.cwd()` directory) for the v1 factory. |
| `adapters.ts` | Shape adapters: `parseModelRef`, `adaptPermissions` (v1 map → v2 Rule[] + v2 permissive base + `task`→`subagent`/`bash`→`execute` mapping), `rewritePromptForV2` (`task(`→`subagent(`), `adaptTool`, `applyAgentToDraft`. |

## Data Flow

1. v2 supervisor decodes `default` as `{ id, setup }` and calls `setup(ctx)`.
2. `setup` builds a v1 `PluginInput` (`client-shim`) and invokes the v1 factory
   `OhMyOpenCodeLite` → receives v1 `Hooks`.
3. Runs the v1 `config()` hook against a synthesized config to resolve agent
   models and slash commands.
4. Registers into v2 domains:
   - `agent` → `ctx.agent.transform` (via `applyAgentToDraft`)
   - `tool` → `ctx.tool.transform` (via `adaptTool`, zod shape → JSON schema)
   - `command` → `ctx.command.transform`
   - system/message transforms → `ctx.session.hook("context")` (SystemPart[]/
     Message.content ↔ v1 `{info,parts}` conversion + `rewritePromptForV2`)
   - `tool.execute.before/after` → `ctx.tool.hook`
   - `event` → `ctx.event.subscribe()` loop
5. Returns a cleanup that disposes every v2 registration + the v1 `dispose`.

Each bridge in step 4 is independently try/catch-guarded so one failure cannot
disable the rest.

## Key Decisions

- **No v2 type imports.** The v2 plugin package is not a build-time dependency
  (v1 host must load the main build). `types.ts` mirrors the consumed subset.
- **Wrap, don't reimplement.** The v1 factory owns all subsystem wiring
  (agents, hooks, job board, multiplexer, companion); the adapter only
  translates at the boundary.
- **Permission base.** v1 permission maps list only explicit entries (unlisted
  → implicit default-allow); v2 has no implicit default, so `adaptPermissions`
  prepends v2's standard permissive base before overlaying v1 entries.

## Integration Points

- `src/index.ts`: imports `createV2Setup` for the dual `default` export and
  exports `OhMyOpenCodeLite` (named) for the adapter to wrap.
- Build: `build:v2` bundles `src/index.ts` (which pulls in `src/v2/`) into
  `dist/server.js` (self-contained except `@ast-grep/napi` + `jsdom`).

## Limitations (see `docs/opencode-v2-compatibility.md`)

Built-in MCPs are config-only on v2 (no programmatic MCP hook); runtime
`/preset` live-reload, multiplexer, companion, and foreground-fallback run
best-effort via the shimmed client; `directory` comes from `process.cwd()`.
