# OpenCode v2 (`opencode2`) Compatibility

oh-my-opencode-slim installs and runs on **both** OpenCode v1 (`opencode`)
and OpenCode v2 (`opencode2`) from a single published package. This document
describes how each host loads the plugin, what is supported where, and how to
register it.

## How it works

The package's default export is an object:

```ts
export default {
  id: 'oh-my-opencode-slim',
  server: OhMyOpenCodeLite, // v1 plugin function (PluginInput) => Promise<Hooks>
  setup: createV2Setup(),   // v2 promise-plugin setup (ctx) => Promise<cleanup>
};
```

There is deliberately **no `tui` key** on this export: hosts validate a
server plugin module's `tui` field (it must be a function and must not
coexist with `server`), so a boolean `tui: true` marker gets the whole
plugin rejected with "invalid tui export".

- **v1 loader** (`readV1Plugin` in `packages/opencode/src/plugin/shared.ts`)
  detects an object with a `server` field and calls `plugin.server(input)`
  with the full v1 `PluginInput`. Extra keys (such as `setup`) are ignored on
  this path.
- **Embedded v2 pass on v1 hosts.** Every v1 host (≥ v1.17.10) also boots
  the v2 core, which reads the same config (migrating `plugin:` entries to
  `plugins:`) and calls `setup(ctx)` with a registration-only context
  (agent/aisdk/catalog/command/integration/plugin/reference/skill — no
  tool/session/event/mcp/generate). A dual-export plugin registered via the
  v1 `plugin:` key therefore gets **both** invocations: full v1
  functionality flows through `server()`, while the parallel pass produces
  the expected `[v2] … failed` / `bridges: 4` log noise (see
  [Environment caveats](#environment-caveats)). A v2 `plugins:` entry yields
  the setup pass alone — v1 does not convert v2 plugin declarations into v1
  hooks.
- **v2 loader** (`PluginModule` schema in
  `packages/core/src/plugin/supervisor.ts`) decodes `default` as
  `{ id, setup }` (Effect Schema 4 rejects function defaults) and calls
  `setup(ctx)` via the promise-plugin bridge.
- **v2 TUI** loads the `./tui` entry unconditionally: the TUI runtime runs
  its own `kind: "tui"` loader pass over the same plugin list and resolves
  the entry through the package's `exports["./tui"]` map — the server-side
  export plays no role in that discovery.

Three builds are produced:

| Export | File | Build | Externals |
|---|---|---|---|
| `.` (main) | `dist/index.js` | `build:plugin` | zod, jsdom, @opencode-ai/*, @opentui/* (shared with v1 host) |
| `./server` | `dist/server/index.js` | `build:v2` | jsdom only (self-contained for v2) |
| `./tui` | `dist/tui2.js` | `build:tui` | same external set as `build:plugin` (composes the v1 TUI entry; inlines zod) |

v2's plugin resolver tries the `server` subpath first
(`subpaths: ["server", ""]`), which the exports map resolves directly to
`dist/server/index.js` — the self-contained v2 server bundle, and also the
entrypoint v2 loads when the `dist/server` directory is registered directly
(see [Installing on v2](#installing-on-v2)); the release artifact check
requires it. v1 uses the main entry.

Verified against opencode2 `beta-18743` (all bridges green — health check
`bridges:10`). Every v2 API the adapter touches is capability-probed at
runtime (`typeof ctx.mcp?.transform === 'function'`, `s.switchModel`,
`ctx.generate`, …), so a host lacking one capability degrades that single
feature with a log line instead of breaking the load.

## The v2 adapter (`src/v2/setup.ts`)

`setup(ctx)` wraps the existing v1 factory rather than reimplementing it:

1. Builds a v1-shaped `PluginInput` from the v2 context
   (`src/v2/client-shim.ts`): the project directory from `ctx.location`,
   and a shim `client` that **really delegates** the v1 SDK call shapes to
   v2 flat session calls — `session.get`, `session.abort`→`interrupt`,
   `session.messages`→`context`, `session.prompt` (as `delivery: "steer"`),
   and `session.update`→`rename`. The shim marks the input
   `hostFlavor: 'v2'` and never fakes success shapes: methods the host
   lacks degrade with an honest log (or are omitted entirely, as with
   `session.get`, so capability probes see the truth).
2. Invokes `OhMyOpenCodeLite(pluginInput)` to reuse **all** existing build
   logic (config, agents, tools, hooks, job board, multiplexer, companion).
3. Runs the v1 `config()` hook against a synthesized config to resolve agent
   models and the slash commands.
4. Bridges the returned v1 `Hooks` into v2 registrations:
   - `agent` → `ctx.agent.transform` (model/prompt/permission adaptation +
     `subagent`/`execute` permission mapping + prompt rewrite `task`→`subagent`
     + `draft.default("orchestrator")`)
   - `tool` → `ctx.tool.transform` (zod shape → JSON schema; execute shimmed)
   - `mcp` → `ctx.mcp.transform` (`draft.set(name, adaptMcpServer(cfg))` for
     the built-in MCPs)
   - `command` → `ctx.command.transform` — v2 command drafts are add-only:
     `draft.add({name, description, execute})`. `execute` submits a
     `<omos-cmd-command data-name="...">` marker as a user prompt; the
     session context hook recovers it and dispatches to the v1
     `command.execute.before` hook (deepwork/reflect/loop)
   - a single `ctx.session.hook("context")` handles the system/messages
     transforms (SystemPart[]/Message.content shape conversion),
     `chat.message` agent tracking, and interview + generic command marker
     dispatch — mutating only the trailing message so earlier content stays
     byte-identical (provider prompt-cache prefix reuse)
   - `tool.execute.before/after` → `ctx.tool.hook` via
     `createToolExecuteBridges` (`src/v2/setup.ts`): the host `subagent`
     tool is normalized to v1 `task` semantics (name mapping, `agent`→
     `subagent_type`, `sessionID`→`task_id`, and back after the hook so v2
     executes the repaired input). A throwing `execute.before`
     **rethrows** — v2 rejects the tool call, which is how the v1
     anti-duplicate / relaunch-lease guards enforce on v2
   - `event` → `ctx.event.subscribe()` loop feeding `mapV2EventToV1`
     (`src/v2/event-adapter.ts`): additive synthesis only — the raw v2 event
     is always dispatched first (the interview bridge depends on it), then
     synthesized v1 shapes: idle `session.status` → `session.idle`, flat
     child `session.created` → v1 early-registration
     `{info: {id, parentID, agent?}}`, and usage telemetry
     (`session.usage.updated`/`session.step.ended`) → a deduplicated
     completed-assistant `message.updated` for the cache monitor
   - `generate.text` → one-shot generation channel probed on `ctx.generate`
     and threaded as `experimental_v2.generateText`, powering the webfetch
     secondary-model summaries without a temp session
   - `dispose` → returned cleanup

Each bridge is independently try/catch-guarded so one failure cannot disable
the rest, and a zero-registration load logs a loud health-check warning.

## Feature matrix

| Capability | v1 (`opencode`) | v2 (`opencode2`) | Notes |
|---|---|---|---|
| Orchestrator + specialist agents, prompts & permission mapping | ✅ | ✅ `ctx.agent.transform` | — |
| Delegation + background job board + `task_*` tools | ✅ `task` tool | ✅ host `subagent` (auto-bridged: name/args normalization in `src/v2/delegation.ts`, output parsing in the execute bridges) | — |
| Tools (ast-grep, webfetch, task_message/task_cancel/task_revive, wait_for_user, acp_run) | ✅ | ✅ `ctx.tool.transform` | ast-grep needs its CLI binary (package, system, or lazy download); webfetch needs `jsdom` resolvable |
| Slash commands `/deepwork` `/reflect` `/loop` | ✅ | ✅ marker round-trip | — |
| `/interview` | ✅ | ✅ marker command + trailing-message context bridge | — |
| Message transforms (phase reminder, skills filter, image routing, display-name rewrite) | ✅ | ✅ via the single context hook | — |
| Event handling (session tracking, lifecycle, cache telemetry) | ✅ | ✅ event pump + additive v2→v1 synthesis | — |
| Tool execute hooks (apply-patch recovery, task-session, json-recovery) | ✅ | ✅ `createToolExecuteBridges` with subagent→task normalization | — |
| Built-in MCPs (context7, gh_grep) auto-registered | ✅ | ✅ `ctx.mcp.transform` | — |
| webfetch secondary-model summaries | ✅ | ✅ via `ctx.generate.text` | host without `ctx.generate` → summaries unavailable (logged) |
| Foreground model fallback (rate-limit failover) | ✅ | ✅ shim translates re-prompt into `session.switchModel` + `delivery:"steer"` prompt | — |
| `/preset` (interactive switcher) | ✅ | ✅ TUI plugin entry (`./tui` → `dist/tui2.js`): sidebar + `/preset` dialog or `/preset <name>` fast path | TUI host needs `keymap.layer` + `ui.dialog.select`; config-file `preset` still applies at load |
| TUI default agent | ✅ orchestrator | ✅ orchestrator — `draft.default("orchestrator")`; the v2 TUI honors `default_agent` and hoists the default to the head of the agent list | — |
| Multiplexer (tmux/zellij/herdr/cmux panes) | ✅ | ❌ host-gated off (`hostFlavor: 'v2'` → `shouldEnableMultiplexer` returns false and the session manager is forced to `type: "none"`) | by design — v2 renders subagents natively |
| Orchestrator-wake scheduler | ✅ | ❌ intentionally not ported | v2's built-in `subagent` tool posts completion notifications to the parent natively, covering the scheduler's job |
| `chat.headers` (custom request headers) | ✅ | ❌ unbridged | low value: v2 exposes an HTTP request hook (`session.hook("http.request")`) — will bridge only if asked for |
| Companion app | ✅ | ⚠️ unverified | independent desktop app; test separately against v2 |

## Upstream behaviors to know

Behaviors of v2 itself that plugin authors should know about — none
currently break this plugin:

- **Duplicate idle delivery.** v2 favors `session.status` over
  `session.idle`; the adapter synthesizes `session.idle` additively, so a
  consumer watching both events sees idle twice per session. Current
  consumers are idempotent per session (idle-reconciliation's per-session
  timer guards); new idle consumers must tolerate duplicate delivery.
- **MCP tool-name namespaces are host-generated.** This plugin never
  matches raw MCP tool names: MCP access is granted per server name
  (`"mcps": ["context7", "!gh_grep"]` in agent config), and registration
  uses its own server names via `draft.set(name, ...)`.

## Installing on v2

Add the npm package, **pinned to an exact version** — v2 auto-refreshes
unpinned npm plugins on every startup, so `@latest` effectively means
"silently upgrade whenever a new version ships". The global config root is
`~/.config/opencode/opencode.json`, shared with v1 (`~/.config/opencode2/`
is not read for plugin config):

```json
{
  "plugin": ["oh-my-opencode-slim@2.2.17"]
}
```

For local development, point the config at the built `dist/server`
**directory**:

```json
{
  "plugin": ["/path/to/oh-my-opencode-slim/dist/server"]
}
```

Then build:

```bash
bun install
bun run build   # produces dist/index.js (v1), dist/server/index.js (v2
                # server bundle, also served via the ./server subpath),
                # dist/tui2.js (v2 TUI), dist/cli/
```

Verify with `opencode2 run "list your specialist agents" --standalone` — the
orchestrator should name explorer, librarian, oracle, designer, fixer.

### Registration rules

- **Directory or package entries only.** File-path entries (e.g.
  `…/dist/server.js`) are rejected with the WARN
  `configured plugin path must be a directory`. A directory entry's
  `index.js` is the entrypoint — hence `dist/server` above.
- **Single-file plugins need a wrapper dir** whose `index.js` re-exports the
  original file, e.g. `~/.config/opencode/plugins-dev/<name>/index.js`
  containing `export { default } from "/abs/path/to/plugin.js";`. Do not
  use the auto-scanned dir names `plugin`/`plugins` for wrapper dirs — a
  scanned duplicate next to an explicit registration hard-dies on duplicate
  plugin ID.

## Configuring models on v2

Agent models are resolved the same way as v1 (per-agent `model` in
`oh-my-opencode-slim.json`, or inherited from the session/host default). On
v2, set a working provider+model in your config or the plugin's config file
so delegated subagents can run.

When the foreground model hits a rate limit, the plugin switches the
session's model (`session.switchModel`) and steers the re-prompt through
`delivery: "steer"`.

## Limitations

### Interview

`/interview` is supported on v2 through a marker command and a
trailing-message context bridge. The bridge keeps an in-memory transcript
projection from v2 context and streamed text events, and uses the v2 session
methods for prompts, notifications, and renames. The markdown document
remains the durable source of truth; completion responses without
`<interview_state>` rewrite the current spec while retaining frontmatter and
Q&A history.

### v1-only, by design

- **Multiplexer panes.** tmux/zellij/herdr integration is a v1-TUI feature;
  v2 renders subagents natively, so the multiplexer is host-gated off on v2
  (`shouldEnableMultiplexer` / `sessionManagerMultiplexerConfig` in
  `src/index.ts`).
- **Orchestrator-wake scheduler** (`backgroundJobs.orchestratorWake`).
  Intentionally not ported: v2's built-in `subagent` tool already nudges an
  idle parent with unfinished work by posting completion notifications
  natively. The capability also depends on host `todo`/`children` surfaces
  the v2 shim does not provide.
- **`chat.headers`.** Not bridged (low value on v2 — an HTTP request hook
  exists if demand appears).

### Known gap: the shim drops `body.agent`

The v2 flat host `PromptInput` (`{ sessionID, text, files?, delivery? }`) has
no `agent` field; on v2 the agent is chosen by a separate
`session.switchAgent({ sessionID, agent })` call. When `src/v2/client-shim.ts`
adapts a v1 `session.prompt` / `session.promptAsync` into that flat shape it
therefore **silently discards `body.agent`**, exactly as it already handles
`body.model` by routing it through `session.switchModel` first.

That matters because on v1 an agent-less prompt body makes OpenCode resolve
its default primary and *durably rewrite the session's agent*
(`docs/agents/build-agent-empty-input-diagnosis.md`, probe A2). Every plugin
prompt site now names its agent (`src/utils/prompt-agent.ts`, enforced
repo-wide by `prompt-agent.test.ts`), so the field is always present and
always thrown away on v2.

**Follow-up:** mirror the `switchModel` treatment — when the adapted body
carries an `agent`, call `session.switchAgent` before `s.prompt(...)` (and log
when the host does not expose it). Until then `v2/client-shim.ts` is
allowlisted in the prompt-agent scanner as a v2 flat-host prompt site.

### Environment caveats

- **Reduced/TUI-side hosts.** Some host processes load the plugin's `setup`
  with a reduced, TUI-side context that lacks `agent.transform` (and other
  domains). The adapter capability-guards `setup` and skips registration
  gracefully for those hosts instead of crashing or retry-storming. The
  same applies to the embedded v2 pass inside every v1 host: it invokes
  `setup` with registration-only domains, so a v1 session's plugin log
  shows `[v2] tool.transform failed`-style lines and
  `health check passed {"bridges":4}` — expected noise from that parallel
  pass, not breakage. The classic `server()` path (a separate plugin-log
  instance a few seconds apart) carries the full v1 functionality.
- **Local-checkout loading.** When the plugin is registered from a local
  build, the externalized `jsdom` import must resolve from the plugin's
  `node_modules` (webfetch imports it lazily, so the plugin still loads
  without it — install as a package or ensure `jsdom` is resolvable to
  enable webfetch locally). AST-grep resolves its CLI independently and
  lazily downloads a binary when no package or system binary is available.
- **Companion app unverified on v2.** The companion is an independent
  desktop app; test it separately against v2 hosts.
- **Prompt-cache rules unchanged.** The v2 bridges reuse the v1 transform
  pipeline under the same cache-safety contract: only trailing messages are
  mutated, earlier content stays byte-identical, and the v1 enforcement
  suite (`src/hooks/cache-safety.property.test.ts` and friends) covers the
  shared transform code the v2 context hook invokes.
