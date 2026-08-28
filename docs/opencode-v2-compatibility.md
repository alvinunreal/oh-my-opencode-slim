# OpenCode v2 (`opencode2`) Compatibility

oh-my-opencode-slim installs and runs on **both** OpenCode v1 (`opencode`) and
OpenCode v2 (`opencode2`) from a single published package. This document
explains how the dual-compatibility works and what is supported on each host.

## How it works

The package's default export is an object:

```ts
export default {
  id: 'oh-my-opencode-slim',
  server: OhMyOpenCodeLite, // v1 plugin function (PluginInput) => Promise<Hooks>
  setup: createV2Setup(),   // v2 promise-plugin setup (ctx) => Promise<cleanup>
};
```

- **v1 loader** (`readV1Plugin` in `packages/opencode/src/plugin/shared.ts`)
  detects an object with a `server` field and calls `plugin.server(input)`.
  This is the original, unchanged v1 code path — v1 behavior is identical to
  previous releases.
- **v2 loader** (`PluginModule` schema in
  `packages/core/src/plugin/supervisor.ts`) decodes `default` as
  `{ id, setup }` (Effect Schema 4 rejects function defaults) and calls
  `setup(ctx)` via the promise-plugin bridge.

Two builds are produced:

| Export | File | Build | Externals |
|---|---|---|---|
| `.` (main) | `dist/index.js` | `build:plugin` | zod, jsdom, @opencode-ai/*, @opentui/* (shared with v1 host) |
| `./server` | `dist/server.js` | `build:v2` | jsdom only (self-contained for v2) |

v2's plugin resolver tries the `server` subpath first
(`subpaths: ["server", ""]`), so a v2 package install loads the self-contained
`dist/server.js`. v1 uses the main entry.

**Supported v2 builds:** verified on `beta-18269` and `beta-18286` (add-only
command drafts; flat session `prompt`/`synthetic`/`rename`/`switchAgent`).

## The v2 adapter (`src/v2/setup.ts`)

`setup(ctx)` wraps the existing v1 factory rather than reimplementing it:

1. Builds a v1-shaped `PluginInput` from the v2 context (`process.cwd()` for
   `directory`; a shim `client` that delegates `session.abort/prompt/messages`,
   `app.log`, and `tui.showToast` to the v2 context or graceful no-ops).
2. Invokes `OhMyOpenCodeLite(pluginInput)` to reuse **all** existing build
   logic (config, agents, tools, hooks, job board, multiplexer, companion).
3. Runs the v1 `config()` hook against a synthesized config to resolve agent
   models and the slash commands.
4. Bridges the returned v1 `Hooks` into v2 registrations:
   - `agent` → `ctx.agent.transform` (model/prompt/permission adaptation +
     `subagent`/`execute` permission mapping + prompt rewrite `task`→`subagent`)
   - `tool` → `ctx.tool.transform` (zod shape → JSON schema; execute shimmed)
   - `command` → `ctx.command.transform` — v2 command drafts are add-only:
     `draft.add({name, description, execute})`. `execute` submits a
     `<omos-cmd-command data-name="...">` marker as a user prompt; the session
     context hook recovers it and dispatches to the v1
     `command.execute.before` hook (deepwork/reflect/loop)
   - a single `ctx.session.hook("context")` handles the system/messages
     transforms (SystemPart[]/Message.content shape conversion),
     `chat.message` agent tracking, and interview + generic command marker
     dispatch
   - `tool.execute.before/after` → `ctx.tool.hook`
   - `event` → `ctx.event.subscribe()` loop
   - `dispose` → returned cleanup

Each bridge is independently try/catch-guarded so one failure cannot disable
the rest.

## Feature matrix

| Capability | v1 (`opencode`) | v2 (`opencode2`) | Notes |
|---|---|---|---|
| Orchestrator + specialist agents | ✅ | ✅ | |
| Agent prompts / system injection | ✅ | ✅ | via `session.hook("context")` |
| Delegation to subagents | ✅ `task` | ✅ `subagent` | prompts rewritten for v2 |
| Tools (ast-grep, webfetch, task_message, task_cancel, task_revive, wait_for_user, acp_run) | ✅ | ✅* | `*` ast-grep needs a CLI binary (installed package, system binary, or lazy download); webfetch needs `jsdom` resolvable |
| Slash commands `/deepwork` `/reflect` `/loop` | ✅ | ✅ | |
| Message transforms (phase reminder, skills filter, image routing, display-name rewrite) | ✅ | ✅ | |
| Event handling (session tracking, lifecycle) | ✅ | ✅ | |
| Tool execute hooks (apply-patch recovery, task-session, json-recovery) | ✅ | ✅ | |
| Built-in MCPs (context7, grep.app) | ✅ | ⚠️ config-only | v2 has no programmatic MCP hook; add 2 lines to `opencode.json` — see [below](#restoring-built-in-mcps-on-v2) |
| `/preset` (interactive switcher) | ✅ | ❌ at load only | the switcher is a v1-TUI 3-level UI; on v2 set `"preset"` in the config file (applies at load) |
| Foreground model fallback (rate-limit failover) | ✅ | ❌ | v2 locks the model at session creation; the plugin API has no per-prompt model override, session model-setter, or `/model` command, so mid-flight switching is impossible |
| Orchestrator wake scheduler (`backgroundJobs.orchestratorWake`) | ✅ | ❌ | Requires host `session.get` / `todo` / `children` / `status` / `promptAsync`; the v2 shim lacks these APIs so the capability-gated feature stays inactive |
| Multiplexer (tmux/zellij/herdr/cmux panes) | ✅ | ❌ | v1-TUI-pane integration; v2 renders subagents natively instead |
| Companion app | ✅ | ⚠️ unverified | independent desktop app; test separately against v2 |
| Default agent on new session | ✅ orchestrator | ⚠️ TUI shows `build` | v1 sets `default_agent`; v2's TUI ignores that field and defaults to the first agent in its list (`build`). `run`/API still default to orchestrator. See [limitations](#limitations) |

## Installing on v2

Add to `~/.config/opencode2/opencode.json`:

```json
{
  "plugin": ["oh-my-opencode-slim@latest"]
}
```

For local development, point at the built `dist/server.js` directly:

```json
{
  "plugin": ["/path/to/oh-my-opencode-slim/dist/server.js"]
}
```

Then build:

```bash
bun install
bun run build   # produces dist/index.js (v1) AND dist/server.js (v2)
```

Verify with `opencode2 run "list your specialist agents" --standalone` — the
orchestrator should name explorer, librarian, oracle, designer, fixer.

## Configuring models on v2

Agent models are resolved the same way as v1 (per-agent `model` in
`oh-my-opencode-slim.json`, or inherited from the session/host default). On v2,
set a working provider+model in your v2 config or the plugin's config file so
delegated subagents can run.

> **Rate-limit fallback is not available on v2.** v2 locks a session's model at
> creation; the plugin context exposes no per-prompt model override, no
> session-level model setter, and no `/model` command. If you hit a 429/rate
> limit, switch the model manually (start a new session or change the configured
> model) — the plugin cannot do this automatically on v2.

## Restoring built-in MCPs on v2

v2 has no programmatic MCP-registration hook, so the plugin's two built-in
remote MCPs are not auto-registered. They are plain remote URLs — copy this into
your `~/.config/opencode2/opencode.json` to restore them:

```json
{
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "headers": { "CONTEXT7_API_KEY": "$CONTEXT7_API_KEY" }
    },
    "gh_grep": { "type": "remote", "url": "https://mcp.grep.app" }
  }
}
```

(`context7` needs `CONTEXT7_API_KEY`; `gh_grep` needs nothing. Drop either key
if unused.) The librarian agent uses these for library-docs lookup and
GitHub-wide code search; without them it still works via `webfetch`.

## Limitations

### Interview

`/interview` is supported on v2 through a marker command and a trailing-message
context bridge. The bridge keeps an in-memory transcript projection from v2
context and streamed text events, and uses the v2 session methods for prompts,
notifications, and renames. The markdown document remains the durable source
of truth; completion responses without `<interview_state>` rewrite the current
spec while retaining frontmatter and Q&A history.

These are **v2 API constraints**, not adapter gaps — they cannot be fixed in the
plugin without v2 adding the corresponding capability:

- **Foreground model fallback impossible.** v2's `SessionPromptInput` has no
  `model` field, the plugin `SessionDomain` exposes only
  `create/get/prompt/generate/command/synthetic/interrupt` (no model setter),
  and there is no `/model` command. A session's model is fixed at creation, so
  the plugin cannot switch models on a rate-limited foreground session.
  v1-only.
- **Interactive `/preset` switcher impossible.** The switcher is a three-level
  v1-TUI UI (`@opentui/solid`). v2 slash commands have had `execute` handlers
  since beta-18269, but the plugin API offers no interactive multi-level TUI
  UI, so the switcher stays v1-only. **Workaround:** set `"preset"` in
  `oh-my-opencode-slim.json` — it applies at plugin load and resolves all agent
  models correctly.
- **No programmatic MCP registration.** v2's plugin context has no MCP domain.
  Declare MCPs in `opencode.json` (snippet above).
- **Multiplexer panes.** tmux/zellij/herdr integration is a v1-TUI feature; v2
  renders subagents natively, so this is intentionally not ported.
- **TUI default agent is `build`, not `orchestrator`.** v1 sets
  `default_agent = "orchestrator"` in its config hook and the v1 TUI honors it.
  The v2 adapter does call `ctx.agent.transform(draft => draft.default("orchestrator"))`,
  which makes `run`/API default to the orchestrator — but the v2 TUI ignores the
  `default_agent` config field entirely and instead defaults to the **first agent
  in its list** (`list()[0]`, insertion order), which is v2's built-in `build`.
  The plugin API offers no list-reorder, and `AgentDraft` has no "move to front".
  Effect: `opencode2 run` and programmatic sessions use the orchestrator; opening
  the v2 TUI / starting a new session there defaults to `build` (switch once; the
  choice is persisted per-session via `saved.session[id].agent`, but each brand-new
  session resets to `build`). Requires an upstream v2 change (TUI honoring
  `default_agent`, or a list-order/default API for plugins) to fix.

These are adapter/environment caveats that can be worked around:

- **Reduced/TUI-side hosts.** Some host processes load the plugin's `setup`
  with a reduced, TUI-side context that lacks `agent.transform` (and other
  domains). The adapter capability-guards `setup` and skips registration
  gracefully for those hosts instead of crashing or retry-storming.
- **Path-based dev loading.** When v2 loads the plugin by absolute file path it
  appends a `?mtime=` cache-busting query, which can break resolution of the
  externalized `jsdom` import from the plugin's `node_modules`. The plugin still
  loads because webfetch imports it lazily; install as a package or ensure
  `jsdom` is resolvable to enable webfetch locally. AST-grep resolves its CLI
  independently and lazily downloads a binary when no package or system binary
  is available.
- **directory source.** v2's plugin context does not expose the project
  directory, so the adapter uses `process.cwd()`. Run `opencode2` from your
  project root (or use `--standalone`, which sets cwd to the project).
