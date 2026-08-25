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

Verified live on OpenCode v2 (all bridges green — health check
`bridges:11`; the event stream, bridges, and orchestrator-wake
children-driven degraded mode are exercised end-to-end on the stable host,
including a queued wake firing after 60 s of parent idle with a stalled
background child). Every v2 API the adapter touches is
capability-probed at runtime (`typeof ctx.mcp?.transform === 'function'`,
`s.switchModel`, `ctx.generate`, …), so a host lacking one capability
degrades that single feature with a log line instead of breaking the load.

## The v2 adapter (`src/v2/setup.ts`)

`setup(ctx)` wraps the existing v1 factory rather than reimplementing it:

1. Builds a v1-shaped `PluginInput` from the v2 context
   (`src/v2/client-shim.ts`): the project directory from `ctx.location`,
   and a shim `client` that **really delegates** the v1 SDK call shapes to
   v2 flat session calls — `session.get`, `session.abort`→`interrupt`,
   `session.messages`→`context`, `session.prompt` (as `delivery: "steer"`),
   `session.update`→`rename`, `session.delete`→`remove` (same
   `DELETE /api/session/:id`; stops the smartfetch secondary-model temp
   sessions leaking), and `session.list` (v2 `Session.Info` page → the v1
   `{data}` envelope with `directory` derived from `location` and `outcome`
   mapped, used by the interview dashboard's session scan and the
   orchestrator-wake children enumeration). The shim marks the input
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
    - `tool` → `ctx.tool.transform` (zod shape → JSON schema; execute
      shimmed; every registration carries `options: {codemode: false}` —
      see the feature matrix note below)
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
      byte-identical (provider prompt-cache prefix reuse). While the
      bridged messages transform runs, parts injected through
      `cache-safe-injection` carry a v2 `ContentPart.cache`
      `{type: "ephemeral"}` hint (CacheHint tagging) so providers that
      honor manual breakpoints cap the injected zone's cache contribution;
      the hint is scoped per request (an `AsyncLocalStorage` scope around
      the bridged transform) so concurrent sessions' transforms cannot
      interleave their set/restore, and the v1 pipeline never enters the
      scope, so v1 payload bytes never change.
    - a native `ctx.session.hook("prompt")` registration (capability-
      guarded): the v2 prompt hook fires **once per admitted input** with
      the eventual inbox User `messageID`, giving the v1 `chat.message`
      consumers (task-session-manager / orchestrator-wake
      `observeChatMessage`, `toolLoopGuard.observeNewUserMessage`) true
      once-per-admission fidelity with prompt parts. The FIRST admitted
      prompt per session is deferred until the first agent-bearing
      context event arrives, then delivered once with parts + agent
      together — the v1 `chat.message` handler only registers the session
      agent when a delivery carries one, and its consumers gate on that
      registration, so an agent-less first forward would be dropped (lost
      input-wait latch clearing / wake-progress rearm). Bounded fallbacks
      (next admission, or a context event whose trailing user message has
      moved past the pending one) flush a still-pending prompt best-known
      when no agent is ever learned. When the prompt hook registers, the
      context hook's per-request `chat.message` emulation narrows to
      agent/model discovery; hosts that reject the hook name keep the
      full emulation as fallback.
    - `tool.execute.before/after` → `ctx.tool.hook` via
      `createToolExecuteBridges` (`src/v2/setup.ts`): the host `subagent`
      tool is normalized to v1 `task` semantics (name mapping, `agent`→
      `subagent_type`, `sessionID`→`task_id`, and back after the hook so
      v2 executes the repaired input). A throwing `execute.before`
      **rethrows** — v2 rejects the tool call, which is how the v1
      anti-duplicate / relaunch-lease guards enforce on v2. The after
      bridge honors v2's status discrimination: `error` events synthesize
      the v1 after-hook output from the error text (so json-error-recovery
      still appends its reminder to a failed call's output), and an
      errored call never presents its result content as a success.
    - `event` → `ctx.event.subscribe()` loop feeding `mapV2EventToV1`
      (`src/v2/event-adapter.ts`): additive synthesis only — the raw v2 event
      is always dispatched first (the interview bridge depends on it), then
      synthesized v1 shapes: flat child `session.created` → v1
      early-registration `{info: {id, parentID, agent?}}`, usage telemetry
      (`session.usage.updated`/`session.step.ended`) → a deduplicated
      completed-assistant `message.updated` for the cache monitor, the Form
      flow (`form.created`/`form.replied`/`form.cancelled`) → v1
      `question.asked`/`question.replied`/`question.rejected`
      (`form.id` → the question request id; forms owned by the `"global"`
      sentinel are skipped), and `permission.asked` field mapping to the v1
      names (`permission` ← `action`, `patterns` ← `resources`;
      `permission.replied` passes through raw — v2's shape already matches
      the v1 event). V2 hosts publish durable `session.execution.started/
      succeeded/failed/interrupted` and emit no busy/idle `session.status`
      and no `session.idle` on the event stream — the observed payloads
      always ride under `data` (verified live, 80-event capture). The
      adapter synthesizes the v1 lifecycle shapes from those execution
      events (`started` → busy `session.status`; terminal subtypes → idle
      `session.status` + `session.idle`; `failed` → a v1 `session.error`
      with the host error payload before the idle pair), and no
      `session.status`-based fallback remains. The execution-event
      synthesis keeps orchestrator-wake suppression/arm scheduling and the
      foreground fallback working on v2 hosts, while the Form and
      permission bridges above feed the companion's waiting-input
      indicator and the task-session-manager input-wait gate.
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
| Tools (ast-grep, webfetch, task_message/task_cancel/task_revive, wait_for_user, acp_run) | ✅ | ✅ `ctx.tool.transform` | v2 requires `options: {codemode: false}` on each registration (CodeMode split): without it a tool registers cleanly but is confined to the `execute` tool's JS runtime and session catalogs yield `Unknown tool: <name>`. The plugin stamps it on every adapted tool (`adaptTool` in `src/v2/adapters.ts`; additive field, older hosts ignore it). ast-grep needs its CLI binary (package, system, or lazy download); webfetch needs `jsdom` resolvable |
| Slash commands `/deepwork` `/reflect` `/loop` | ✅ | ✅ marker round-trip | — |
| `/interview` | ✅ | ✅ marker command + trailing-message context bridge | — |
| Message transforms (phase reminder, skills filter, image routing, display-name rewrite) | ✅ | ✅ via the single context hook | — |
| Event handling (session tracking, lifecycle, cache telemetry) | ✅ | ✅ event pump + additive v2→v1 synthesis | — |
| Tool execute hooks (apply-patch recovery, task-session, json-recovery) | ✅ | ✅ `createToolExecuteBridges` with subagent→task normalization | — |
| Built-in MCPs (context7, gh_grep) auto-registered | ✅ | ✅ `ctx.mcp.transform` | — |
| webfetch secondary-model summaries | ✅ | ✅ via `ctx.generate.text` | host without `ctx.generate` → summaries unavailable (logged) |
| Foreground model fallback (rate-limit failover) | ✅ | ✅ shim translates re-prompt into `session.switchModel` + `delivery:"steer"` prompt | — |
| `/preset` (interactive switcher) | ✅ | ✅ TUI plugin entry (`./tui` → `dist/tui2.js`): sidebar + `/preset` dialog or `/preset <name>` fast path | The layer registers from an `append: "app"` slot render because the host's `keymap.layer` is provider-scoped (calling it from plugin `setup` throws `Keymap.Provider is missing`); the command carries an `id` and `slash.arguments`; host needs `ui.slot` + `keymap.layer`; the interactive picker needs `ui.dialog.select` while `/preset <name>` works without it; feedback uses `ui.toast.show`; config-file `preset` still applies at load |
| TUI default agent | ✅ orchestrator | ✅ orchestrator — `draft.default("orchestrator")`; the v2 TUI honors `default_agent` and hoists the default to the head of the agent list | — |
| Multiplexer (tmux/zellij/herdr/cmux panes) | ✅ | ❌ host-gated off (`hostFlavor: 'v2'` → `shouldEnableMultiplexer` returns false and the session manager is forced to `type: "none"`) | by design — v2 renders subagents natively |
| Orchestrator-wake scheduler | ✅ todo-gated (host `todo`/`children`/`status` APIs) | ✅ children-driven degraded mode (`backgroundJobs.orchestratorWake.mode`) | v2 wake enumerates children via `session.list({parentID})` with an event-tracked fallback, gates on children without a terminal `outcome` (staleness-bounded), and delivers with `queue`; v2's native subagent completion nudges still cover the happy path — the port adds a periodic watchdog for stuck children and unreconciled jobs |
| `chat.headers` (custom request headers) | ✅ | ❌ unbridged | low value: v2 exposes a model request hook (`session.hook("model.request")`, with mutable `headers`) — will bridge only if asked for |
| Companion app | ✅ | ⚠️ unverified | independent desktop app; test separately against v2 |

## Upstream behaviors to know

Behaviors of v2 itself that plugin authors should know about — none
currently break this plugin:

- **Event payloads ride under `data`, not `properties`.** The v2
  event stream (SSE and `ctx.event.subscribe()`) frames each event as
  `{id, created, type, location?, durable?, metadata?, data}` — the payload
  is the `data` record, unlike the v1 SDK's `properties` (verified live:
  every observed event keyed `["id","created","type","durable","data"]`,
  with the optional `metadata?` key observed on some events).
  The adapter reads `data` first with `properties` as a legacy fallback and
  always writes `properties` on the synthesized v1 shapes, because that is
  the key the v1 consumers read.
- **Lifecycle keys on `session.execution.*`.** V2 hosts publish durable
  `session.execution.started/succeeded/failed/interrupted` events
  (`{sessionID}`, plus `error` on `.failed` and `reason` on
  `.interrupted`) and emit no busy/idle `session.status` and no
  `session.idle` on the event stream (`session.status` remains only in the
  schema). The adapter synthesizes the v1 lifecycle shapes from the
  execution events (`started` → busy `session.status`; terminal subtypes →
  idle `session.status` + `session.idle`; `failed` → a v1 `session.error`
  with the host error payload passed through best-effort, emitted before
  the idle pair so the error-then-idle flow the event-router expects is
  preserved). Without this synthesis the orchestrator-wake scheduler never
  arms on live v2 hosts.
- **Transcript user messages carry no identity.** Context-hook
  transcript user messages on live v2 hosts carry `{id, time, text,
  type}` only — no `agent`, no `sessionID`. The v1 injection gates
  (phase-reminder, background-job-board, post-file-tool-nudge) key on
  user-message `info.agent`/`info.sessionID`, so every injection would
  skip. The v2 context bridge stamps the context event's `sessionID` and
  the session's known agent (from the event, falling back to the
  session-prompt bridge's learned state) onto transcript user messages
  before the bridged messages transform runs — metadata-only envelope
  enrichment, strictly absence-gated (host-provided values never
  overwritten), parts/content bytes untouched, idempotent across
  context events. This also makes the CacheHint-tagged injected parts
  observable on live v2 hosts.
- **Runtime status reconciliation is capability-gated.** v2 has no
  equivalent of the v1 live session-status map (`client.session.status`
  is not a function on v2 hosts), so the task-session-manager's
  runtime-status reconciliation poll is disabled entirely on hosts
  without the method — a single per-instance log line notes the
  disabled reconciliation instead of logging uncertainty every ~5s poll.
  v1 hosts expose the method and keep the exact historical polling
  behavior. Background job stop-confirmation was never obtainable from
  the v2 poll anyway (the lookup failed every time).
- **Duplicate idle delivery.** The adapter synthesizes both an idle
  `session.status` and a `session.idle` from each terminal execution event,
  so a consumer watching both sees idle twice per terminal transition.
  Current consumers are idempotent per session (idle-reconciliation's
  per-session timer guards); new idle consumers must tolerate duplicate
  delivery.
- **Duplicate `permission.asked` delivery.** The adapter appends a
  v1-field-mapped copy after the raw v2 `permission.asked` event (raw
  first is a load-bearing invariant for v2-native handlers). Consumers
  watching both see the ask twice with the same request id — safe because
  every ask consumer is idempotent per request id (the input-wait
  tracker's Set, the companion's status setters, wake suppression); new
  ask consumers must tolerate it, like idle.
- **Question flow is Form-based.** v2 replaced `question.*` with the Form
  flow; the adapter synthesizes `question.asked/replied/rejected` from
  `form.created/replied/cancelled` so v1 consumers keep working. Forms
  owned by the `"global"` sentinel session (MCP elicitation) are not
  synthesized — v1 question events are session-scoped.
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
`delivery: "steer"`. A failing `switchModel` call degrades honestly: the
re-prompt is still delivered (on the current model) and the plugin's logs
record that no switch happened — the fallback chain is not aborted. On
hosts without `session.switchModel`, the fallback replay is rejected with
a clear error instead of silently replaying on the model that just failed
(other prompt callers, like the orchestrator-wake scheduler, only pin the
current model and keep steering).

## Limitations

### Interview

`/interview` is supported on v2 through a marker command and a
trailing-message context bridge. The bridge keeps an in-memory transcript
projection from v2 context and streamed text events, and uses the v2 session
methods for prompts, notifications, and renames. Interview notifications
admit the synthetic input with `resume: false` — the interview URL lands in
the session without waking an agent turn (the v1 `noReply` prompt
equivalent). The markdown document
remains the durable source of truth; completion responses without
`<interview_state>` rewrite the current spec while retaining frontmatter and
Q&A history.

### v1-only, by design

- **Multiplexer panes.** tmux/zellij/herdr integration is a v1-TUI feature;
  v2 renders subagents natively, so the multiplexer is host-gated off on v2
  (`shouldEnableMultiplexer` / `sessionManagerMultiplexerConfig` in
  `src/index.ts`).
- **`chat.headers`.** Not bridged (low value on v2 — a model request hook
  exists, `session.hook("model.request")` with mutable `headers`, if
  demand appears).

### Orchestrator-wake on v2 (children-driven degraded mode)

The wake scheduler is **active on v2** in a degraded mode, configured with
`backgroundJobs.orchestratorWake.mode` (`"auto"` | `"todo"` | `"children"`,
default `"auto"`: todo-gating on v1, children-driven on v2; an explicit
`"todo"` degrades to children because v2 has no todo surface — logged once).

How it differs from the v1 path:

- **Gate:** v2 requires only the shim's `session.list` + `promptAsync`
  (`session.get` is optional model enrichment). v1 keeps its exact
  historical probe set (`get`/`todo`/`children`/`status`/`promptAsync`).
- **Children enumeration:** `session.list({ parentID })` through the shim
  (v2 `Session.Info` → v1 envelope; `outcome` and `time.updated` mapped).
  The in-process session surface of current v2 hosts does not expose
  `list`, so the empty page falls back to an event-tracked view — the
  adapter-synthesized `session.created` parentID links plus tracked
  busy/idle statuses — refreshed on every evaluation with the host's
  authoritative `outcome`/`time.updated` via `session.get` (fail-soft per
  child). A finished child is therefore terminal immediately instead of
  reading active for the whole staleness window, and a live child stays
  visible on its host evidence rather than dropping out on stale local
  evidence. Results are scoped to the session's directory when the host
  reports one.
- **Wake condition:** children with `outcome === undefined` (v2 records an
  outcome only on terminal transition: succeeded|failed|interrupted) that
  still have fresh update evidence — host `time.updated` or a tracked status
  change newer than 3× the wake interval (staleness bound for children that
  crash mid-run without recording an outcome). Stopped-job recovery wakes
  bypass the condition, as on v1.
- **Wake delivery:** `delivery: "queue"` — v1 `prompt_async` queued, and a
  v2 `steer` would hijack an in-flight run. The shim's `promptAsync` keeps
  `steer` as the default so the foreground-fallback replay is unchanged.
  The wake model pin carries the session model's variant as the v2-only
  `modelVariant` argument, so `switchModel` preserves the reasoning-effort
  setting instead of resetting it to the host default.
- **Fingerprint:** children-only (id + outcome + tracked status + update
  evidence); the two-wake no-progress cap still bounds cost.

v2's built-in `subagent` tool still posts completion notifications to the
parent natively — that covers the happy path. What the port adds is a
periodic watchdog: an idle parent with a stuck or unreconciled child (or a
job that stopped without a terminal result) gets woken to assess, cancel, or
respawn, bounded by the same no-progress cap as v1.

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
- **TUI-side plugin logs are not captured.** The plugin logger initializes
  in the server process only, so TUI-side registration failures write no
  `[v2][tui]` lines anywhere. Verify TUI behavior through the host (command
  availability, on-disk effects), not via the plugin log.
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
  shared transform code the v2 context hook invokes. The one v2-only
  addition is CacheHint tagging: parts injected through
  `cache-safe-injection` while the v2 context bridge runs carry
  `cache: {type: "ephemeral"}` (v2 `ContentPart.cache`). The hint is
  applied via a per-request scoped default (AsyncLocalStorage — the v2
  host serves different sessions' requests concurrently, so the scope
  must be isolated per bridged transform) inside the v2 bridge only — v1
  callers never set it, so the v1 payload (and its snapshots) stay
  byte-identical.

## Native v2 migration plan

The current v2 implementation is a transitional v1-to-v2 adapter. It preserves
the shared plugin behavior while native migration remains a separate effort;
the adapter is not itself a native Promise-plugin implementation.

### Adapter boundaries

The adapter constructs v1-shaped input and translates v1 hook payloads, so it
cannot provide the type or lifecycle guarantees of native v2 code. Its client
shim and interview projection intentionally cover only the operations described
above, and registration failures are isolated so supported features can still
load independently. Native migration should use the official v2 domains rather
than expanding this shim.

The beta Promise-plugin API provides native opportunities for agent and tool
catalogues, executable commands, MCP registration, session context and model
hooks, tool lifecycle hooks, event subscriptions, and TUI integration. Session
`context` is the native replacement for v1 raw message transforms: native code
should mutate v2 `system`, `messages`, and `tools` directly instead of converting
through v1 `{ info, parts }` objects.

### Native target architecture

The target is a separate native Promise-plugin composition, not a more capable
adapter:

1. Keep host-neutral configuration, agent definitions, prompt construction, and
   tool definitions in shared modules.
2. Move the v1 composition behind an explicit `src/v1` boundary.
3. Implement native `define({ id, setup })` registration for agents, tools,
   commands, MCPs, session hooks, tool hooks, and events.
4. Replace the client shim, local v2 type mirror, and interview bridge with
   native context and lifecycle modules.
5. Make required native registration failures observable instead of silently
   installing a partial native plugin.

The native implementation must not invoke the v1 factory, convert v2 values to
v1 hook payloads, or retain legacy lifecycle ownership merely to preserve
parity.

### Behaviors to evaluate for retirement

Exact v1 parity is not presumed for the native v2 target. During migration,
explicitly classify these behaviors as native, adapter-only, or retired rather
than emulating them indefinitely:

- legacy background-job ownership and orchestrator wake scheduling;
- child-pane multiplexer integration (tmux, zellij, herdr, and cmux);
- runtime foreground-model failover;
- tool permission prompt/cancellation interception;
- initiator-header injection; and
- interview-history reconstruction after a plugin reload.

Compaction prompt replacement, permission-prompt interception, and synthetic
text completion also need a product-level replacement or explicit retirement
where the native API has no exact equivalent. TUI controls and small-model
selection are migration decisions, not predeclared retirements. The official
API's MCP registration, model switching, and executable command registration
are migration opportunities.

### Verification gates

Validation is required at each migration boundary:

1. **Architecture:** approve the host-neutral boundary, native domain mapping,
   parity definition, and deliberate retirements.
2. **Static/runtime:** compile, lint, and run unit tests for shared code, the v1
   host, and native registrations; required failures must be observable.
3. **v2 host smoke:** prove plugin loading, agent/tool/command/MCP registration,
   session-context transforms, tool lifecycle hooks, event handling, and cleanup
   against the target host.
4. **v1 compatibility:** retain the existing v1 load/smoke path until cutover
   is complete and verify that the v1 factory remains intact during transition.
5. **Release readiness:** verify published entry points, install paths, native
   smoke artifacts, documented retirements, and absence of adapter-only claims
   before removing the transitional path.

### Migration roadmap

1. Inventory each v1 behavior against an official v2 domain and obtain approval
   for behaviors classified as retired.
2. Separate shared logic, the v1 composition, and the native Promise-plugin
   composition with strict registration and cleanup.
3. Prove both hosts in parallel without expanding the adapter's scope.
4. Cut over v2 to the native composition only after its smoke and v1
   compatibility gates pass; retain v1 for the verified cutover period.
5. After release-readiness review, decide whether the v1 host can be retired
   and remove remaining compatibility-only code.
