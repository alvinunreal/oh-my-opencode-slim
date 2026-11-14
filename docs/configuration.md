# Configuration Reference

Complete reference for all configuration files and options in oh-my-opencode-slim. For repository-specific configurations, custom agents, and prompt directory lookups, see the [Project-local Customization Guide](project-local-customization.md).

---

## Config Files

| File | Purpose |
|------|---------|
| `~/.config/opencode/opencode.json` | OpenCode core settings (plugin registration, providers) |
| `~/.config/opencode/oh-my-opencode-slim.json` | Plugin settings - agents, multiplexer, MCPs, council |
| `~/.config/opencode/oh-my-opencode-slim.jsonc` | Same, but with JSONC (comments + trailing commas). Takes precedence over `.json` if both exist |
| `.opencode/oh-my-opencode-slim.json` | Project-local overrides (optional, higher precedence than user config) |

> **💡 JSONC recommended:** Use the `.jsonc` extension to add comments and trailing commas. If both `.jsonc` and `.json` exist, `.jsonc` takes precedence.

Config edits follow existing symbolic links and update their targets while
preserving the links. A dangling or unresolvable link causes the write to fail;
repair the link before retrying. Backups are written beside the config path.

Project configuration discovery searches the current directory and every
ancestor within the host's discovery boundary. V2 walks through the filesystem
root, including above Git repository and worktree roots. V1 stops at the Git
worktree boundary, including that directory; without a Git boundary it walks to
the filesystem root. Set `OPENCODE_DISABLE_PROJECT_CONFIG=true` (or `1`, with
case-insensitive `true`) to skip project config, prompt, and local skill
discovery while retaining user configuration. Settings merge in this order:

1. User configuration.
2. Each ancestor's `.opencode/oh-my-opencode-slim.json[c]`, from the
   host's discovery boundary down to the current directory.

Closer configurations override matching settings while preserving unrelated
inherited settings. JSONC preference applies independently in each directory;
top-level arrays retain their existing replacement behavior. This keeps shared
custom agents and presets available when a session moves into a nested worktree.
An unreadable or invalid configuration layer is skipped without discarding the
other layers. Explicit retired V2 lifecycle settings instead refuse startup
with their source path before layers are merged; a nearer override does not
hide them. See the [V2 native lifecycle upgrade](v2-native-upgrade.md).
Preset lookup uses the same agent-aware merge rules as runtime loading, and
preset warnings identify the file supplying the broken inheritance directive
or selected preset.
Only ancestor configurations are inherited, not sibling configurations. Trust
the ancestor configurations as well as the current project before running
OpenCode. Prompt files and `skills_include_local` also search ancestor
`.opencode` directories within that host-specific boundary. Nearer prompt files win;
local skill grants combine names from the discovered trees. See
[Project-local Customization](project-local-customization.md) for precedence
and the retained skill-format and symlink restrictions.

On v2, projects under `$HOME` also inherit `~/.opencode` as a project layer,
so it overrides matching settings from `~/.config/opencode` (or the selected
user config directory). On v1 this applies only when `~/.opencode` is within
the eligible worktree walk. Review and trust this layer too.

The v2 configuration watcher observes ancestor candidates, including files
created later, and `doctor` reports every discovered project layer. Project-scoped
marketplace edits still write to the current directory's configuration, not an
ancestor's file.

Set `OPENCODE_CONFIG_DIR` to use a custom user config directory instead of
`~/.config/opencode`; install and runtime config discovery both honor it.

Runtime readers share source snapshots and revalidate file identities and
referenced environment values before reuse. Unchanged polling does not parse
configuration again; invalid input retains the existing warning and last-good
refresh behavior. See [Runtime Efficiency](runtime-efficiency.md).

Set `OH_MY_OPENCODE_SLIM_DISABLE` to `1`, `true`, `yes`, or `on` to make
oh-my-opencode-slim exit setup without registering agents, tools, MCPs, hooks,
Companion, or the TUI sidebar. OpenCode still loads the package and calls its
setup entrypoint, but the plugin returns cleanly without activating its
features. This is a temporary escape hatch:

```bash
OH_MY_OPENCODE_SLIM_DISABLE=1 opencode
```

Set `OH_MY_OPENCODE_SLIM_TUI_REFRESH_MS` to override the TUI config re-read
interval, in milliseconds. The default is 1s while the sidebar is on (the
poll drives rendering) and 5s while the sidebar is off (config-only; it still
detects external `multiplexer.type` edits). Non-numeric values and values
below 10 fall back to the default. This knob exists mainly to speed up the
test suite; leave it unset for normal use.

If OmO-slim detects an invalid plugin config for the current project, the TUI sidebar shows a warning. Run `oh-my-opencode-slim doctor` from your project root for full diagnostics.

Marketplace agent packages are selected through the active preset's
`marketplace` configuration. The CLI and orchestrator tools update desired
disk state only; they do not mutate the current session's agent registry. See
the [Marketplace guide](marketplace.md) for activation, status, and reload
commands.

Set `questionTimeoutMs` to opt in to an automatic response when an eligible
question is unanswered. The value is in milliseconds: `0` or an omitted value
disables it; enabled values range from `60000` to `2147483647`.

```jsonc
{
  "questionTimeoutMs": 1200000
}
```

The reply tells the model how long it waited and asks it to decide and continue.
Permission requests and questions that disallow custom answers remain pending. On v1 the
server owns the timer. On v2 an OMOS TUI must be attached and `tui` must be
enabled; a server without that TUI does not auto-answer. Restart the TUI after
changing the setting. A TUI restarted while a question is already open does not
re-arm that question.

The TUI sidebar uses the compact layout by default. Set `compactSidebar` to
`false` in `oh-my-opencode-slim.jsonc` to use the expanded layout:

```jsonc
{
  "compactSidebar": false
}
```

Internal Council agents (`council`, `councillor`, and the dynamic
`councillor-<seat>` agents) stay out of the sidebar because their seats are
internal orchestration surfaces. Set `sidebarShowHiddenAgents` to `true` to
render them as ordinary rows — model, variant, status dot, and session
expansion behave exactly as they do for any other agent. The default is
`false`; the switch affects the sidebar only, not agent registration or the
host agent picker:

```jsonc
{
  "sidebarShowHiddenAgents": true
}
```

Click the `OMO-Slim` heading to collapse or expand its sidebar section. It
starts expanded; the choice lasts for the current TUI window only. An idle
agent has a `•` before its name. While an agent session reports `busy` or
`retry`, an animated Braille indicator replaces the bullet in the same spot.
The bullet returns after every active session for that agent becomes idle or
is deleted.

In an expanded agent list, `⚰` marks a stopped session (no terminal result); only `task_revive` can continue it. Expanded subagent rows show the session's title, truncated to the sidebar's width, when the host knows one; before a title is generated or on hosts without title data they fall back to the numbered alias.

---

## Prompt Overriding

Customize agent prompts without modifying source code. Create markdown files in `~/.config/opencode/oh-my-opencode-slim/`:

| File | Effect |
|------|--------|
| `{agent}.md` | Replaces the agent's default prompt entirely |
| `{agent}_append.md` | Appends custom instructions to the default prompt |

When a `preset` is active, the plugin checks preset directories before falling back to root directories. Both global user prompt directories and project-local prompt directories are searched. For the complete lookup precedence order, see [Project-local Customization](project-local-customization.md).

**Example directory structure:**

```
~/.config/opencode/oh-my-opencode-slim/
  ├── best/
  │   ├── orchestrator.md        # Preset-specific override (used when preset=best)
  │   └── explorer_append.md
  ├── orchestrator.md            # Fallback override
  ├── orchestrator_append.md
  ├── explorer.md
  └── ...
```

Both `{agent}.md` and `{agent}_append.md` can coexist - the full replacement takes effect first, then the append. If neither exists, the built-in default prompt is used.

**Agent identity vs. routing in custom orchestrator prompts.** Both host
flavors append a native roster to the delegation tool's description — v2
hosts add `Available subagents:`, v1 hosts add `Available agent types and the
tools they have access to:` — with one `- name: description` line per
dispatchable agent. The plugin cannot remove these appends (they happen in
host code after plugin tool hooks). Agent `description` values are one-liners
by design: routing criteria live in the orchestrator prompt's `<Agents>`
block, descriptions only identify agents for the native roster (override
them via `agents.<name>.description`). When writing a custom
`orchestrator.md`, keep only routing deltas (when to delegate to whom) in
your agent section — identity lines duplicate the native roster and go stale
when agents are disabled (`disabled_agents` removes them from the roster
automatically, but not from your file). `routingBlock: false` applies the
same trim to the built-in prompt by removing the stock `<Agents>` block
entirely, which also removes stock routing claims that drift against
`agents.<name>.prompt` customizations (see the option reference).

> **Prompt text is verbatim for delegation vocabulary.** The plugin never
> rewrites delegation calls in prompts, so any delegation calls you write must
> use the running host's vocabulary — v1 `task`/`subagent_type`/`task_id`, v2
> `subagent`/`agent`/`sessionID`. This applies to prompt files, inline
> `agents.<agent>.prompt`, and `orchestratorPrompt` snippets. Separately,
> display-name substitution rewrites `@<internalName>` mentions to the agent's
> `displayName` when one is defined, throughout the final orchestrator prompt
> (inline, file, and append orchestrator prompts) and in
> `orchestratorPrompt`/ACP routing snippets. See
> [Host Vocabulary in Custom Prompts](project-local-customization.md#host-vocabulary-in-custom-prompts).

---

## JSONC Format

All config files support **JSONC** (JSON with Comments):

- Single-line comments (`//`)
- Multi-line comments (`/* */`)
- Trailing commas in arrays and objects

**Example:**

```jsonc
{
  // Active preset
  "preset": "openai",

  /* Agent model mappings */
  "presets": {
    "openai": {
      "oracle": { "model": "openai/gpt-6-astra" },
      "explorer": { "model": "openai/gpt-6-luna" },
    },
  },

  "multiplexer": {
    "type": "tmux",
    "layout": "main-vertical",
  },
}
```

---

## Minimal Setup

Slim requires OpenCode 2.3.0 or newer. See the [upgrade guide](v2-native-upgrade.md)
for configuration changes.

Every optional subsystem has one switch, all defaulting to on. A
council-and-observer-only setup turns off the rest:

```jsonc
{
  "backgroundJobs": { "mode": "off" },
  "interview": { "enabled": false },
  "marketplace": { "enabled": false },
  "tui": false,
  "autoUpdate": false,
  "liveConfigRefresh": false,
  "fallback": { "enabled": false },
  "webfetch": { "enabled": false },
  "multiplexer": { "type": "none" },
  "companion": { "enabled": false },
  // Keep council + observer; enable observer by naming only the other
  // built-ins here, then set a vision-capable model for it.
  "disabled_agents": ["explorer", "oracle", "designer", "fixer"],
  "agents": {
    "orchestrator": { "skills": [] },
    "observer": { "skills": [] },
    "council": { "skills": [] },
    "councillor": { "skills": [] }
  },
  "disabled_mcps": ["context7", "gh_grep"],
  "disabled_commands": ["interview", "implement", "deepwork", "reflect"],
  "disabled_hooks": [
    "phase-reminder", "foreground-fallback", "deepwork-goal",
    "cache-monitor", "json-error-recovery", "tool-loop-guard",
    "search-path-guard", "absolute-path-rescue", "apply-patch"
  ],
  "disabled_tools": [
    "ast_grep_search", "ast_grep_replace", "acp_run",
    "marketplace_inspect", "marketplace_manage",
    "task_cancel", "task_message", "task_status", "task_reply"
  ]
}
```

`tui: false` gates the whole OMOS TUI surface: the client entry skips loading
the TUI render stack and the server stops writing sidebar state. The
server-side council, observer, agents, hooks, and tools keep working. Use
`sidebar: false` instead when you want the remaining TUI surface without the
sidebar. `interview.enabled: false` also disables `/implement`, because
`/implement` feeds the same interview flow.

A disabled subsystem is not constructed at all: no tools, listeners, timers,
state files, or servers. On OpenCode v2, native delegation, completion delivery,
session continuation, and council seat assembly keep working with no OMOS
lifecycle. `backgroundJobs.mode: "native"` is the V2 default: it skips every
board-shaped component but keeps the thin host-read controls a native setup
otherwise lacks — `task_status` (child state, trailing result, pending
permissions), `task_cancel` (interrupt a stuck child), permission-only
`task_reply`, and child `task_report`. On V1, `"native"` keeps only
`task_status` and `task_cancel`.

`backgroundJobs.mode: "off"` is stricter: the plugin does not wrap the host's
`subagent` executor, does not read child sessions before the host validates a
call, and does not bind session-level presets. Delegated children use the
models, variants, temperature and provider options from the registered agent
configuration (the `preset` default still selects those at startup). Session
`/preset` bindings and the related RPC are unavailable in this mode; the
manager keeps global editing and hides session-only actions. `/preset <name>`
reports that session routing is disabled. See
[Background Orchestration](background-orchestration.md)
and [Council](council.md) for what remains.

---

## Full Option Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `preset` | string | - | Active preset name (e.g. `"openai"`, `"best"`) |
| `setDefaultAgent` | boolean | `true` | When `true`, sets OpenCode's `default_agent` to the orchestrator if unset or pointing at a subagent; `false` leaves it untouched |
| `sidebar` | boolean | `true` | Master switch for the OMOS TUI sidebar surface (the agent list it renders and its state file). When `false`, the plugin never registers or renders the sidebar and writes no sidebar state; the native host sidebar is untouched, and pane management keeps following `multiplexer` config changes. `tui: false` implies this off. |
| `sidebarShowHiddenAgents` | boolean | `false` | Render internal Council agents (`council`, `councillor`, and the dynamic `councillor-<seat>` agents) as OMOS TUI sidebar rows. When `true`, each row carries the same model, variant, status dot, and session expansion as any other agent. Affects the sidebar only: agent registration, availability, and the host agent picker are unchanged. |
| `tui` | boolean | `true` | Master switch for all OMOS TUI surfaces: the sidebar and its server-side state, `/preset`, `/killall`, `/subagent`, and the update notice. When `false`, the TUI entry registers nothing and never loads the TUI render stack, and the server writes no sidebar state; server-side agents, council, observer, hooks, and tools remain active. |
| `liveConfigRefresh` | boolean | `true` | v2 only: master switch for the live config-file watcher that reloads runtime model/preset profiles when `oh-my-opencode-slim.json(c)` changes on disk. When `false`, v2 does not watch config files and file edits apply only after a restart; explicit `/preset` writes still refresh the current generation where applicable |
| `stripOrchestratorModel` | boolean | `false` | Preserve a runtime `/model` selection for the orchestrator after subagent dispatch by omitting its configured model from the SDK config. A selected preset's explicit `orchestrator.model` is retained. Without a runtime selection, this opt-in delegates the initial orchestrator choice to OpenCode's session default. |
| `routingBlock` | boolean | `true` | When false, removes the `<Agents>` routing block from the built-in orchestrator prompt. The host's native delegation-tool roster still lists every enabled agent with its one-line description, but it carries no Delegate/Don't routing criteria — the block's routing guidance (~300 tokens) has no roster equivalent, so `false` trades routing quality for tokens, or drops stock routing claims that drift against custom agent prompts (`agents.<name>.prompt`). Applies on v1 and v2 hosts. No effect when an orchestrator.md override already replaces the whole prompt. |
| `presets` | object | - | Named preset configurations. New preset names are limited to letters, digits, `-`, and `_`; `__omo_*` and JavaScript reserved property names (`__proto__`, `constructor`, `prototype`) are rejected for new presets (pre-existing entries with other names stay visible and applicable) |
| `presets.<name>.extends` | string | - | Optional single parent preset. The parent is resolved before the child; multiple parents are not supported |
| `presets.<name>.<agent>.model` | string \| array | - | Model ID in `provider/model` format, or a non-empty ordered fallback chain (array of IDs or `{ id, variant }`) |
| `marketplace.enabled` | boolean | `true` | Kill switch for the marketplace subsystem: when `false`, any selected package IDs (`presets.<name>.marketplace` activation lists) are ignored and the marketplace manager, store, and `marketplace_inspect`/`marketplace_manage` tools are not initialized. Distinct from an empty preset activation list, which simply activates no agents while the service/store and tool factories still initialize See [Marketplace](marketplace.md). |
| `presets.<name>.marketplace` | object | - | Marketplace activation: `agents`, `agents_add`, `agents_remove` (package IDs). See [Marketplace](marketplace.md) |
| `presets.<name>.<agent>.temperature` | number | - | Optional temperature (0–2); when omitted, OpenCode chooses its default |
| `presets.<name>.<agent>.variant` | string | - | Reasoning effort: `"low"`, `"medium"`, `"high"`, or `"max"` (provider-specific). Takes precedence over a `variant` carried inline by the model chain's first entry |
| `presets.<name>.<agent>.displayName` | string | - | Custom user-facing alias for the agent (e.g. `"advisor"` for `oracle`) |
| `presets.<name>.<agent>.color` | string | - | Agent display color as `#RRGGBB` or a theme color: `primary`, `secondary`, `accent`, `success`, `warning`, `error`, or `info` |
| `presets.<name>.<agent>.skills` | string[] | - | Skills the agent can use (`"*"`, `"!item"`, explicit list) |
| `presets.<name>.<agent>.skills_add` | string[] | - | Skill names added to the effective skills list at config resolution (applies to `agents.<agent>` entries too). Removal via `skills_remove` wins. Folded into `skills` and stripped; see [Skills Assignment](skills.md#adding-or-removing-skills-on-top-of-an-inherited-list) |
| `presets.<name>.<agent>.skills_remove` | string[] | - | Skill names removed from the effective skills list at config resolution (applies to `agents.<agent>` entries too). Wins over `skills_add`. Folded into `skills` and stripped; see [Skills Assignment](skills.md#adding-or-removing-skills-on-top-of-an-inherited-list) |
| `presets.<name>.<agent>.mcps` | string[] | - | MCPs the agent can use (`"*"`, `"!item"`, explicit list) |
| `presets.<name>.<agent>.options` | object | - | Provider-specific model options passed to the AI SDK (e.g., `textVerbosity`, `thinking` budget) |
| `agents.<customAgent>.model` | string\|array | - | Required for custom agents inferred from unknown `agents` keys |
| `agents.<customAgent>.prompt` | string | - | Full execution prompt for a custom agent |
| `agents.<customAgent>.orchestratorPrompt` | string | - | Exact `@agent` block injected into the orchestrator prompt; must start with `@<agent-name>` |
| `agents.<agent>.permission` | object \| string | - | Tool-level permission rules enforced by the SDK. See [Agent Permissions](#agent-permissions) |
| `agents.<agent>.mcps` | string[] | - | Plugin MCP allow-list (`"*"`, `"!item"`, explicit list); this is plugin configuration, not a host agent `mcps` field |
| `agents.<agent>.displayName` | string | - | Custom user-facing alias for the agent in the active config |
| `agents.<agent>.color` | string | - | Agent display color as `#RRGGBB` or a theme color: `primary`, `secondary`, `accent`, `success`, `warning`, `error`, or `info` |
| `agents.<agent>.description` | string | generated | Description shown to OpenCode and the orchestrator. Custom agents default to `Custom subagent '<name>'` |
| `agents.orchestrator.subagents` | string[] | - | Delegation scope allowlist of specialist names. Compiled into the `task` permission stance (`{"*": "deny", "<name>": "allow"}`); an explicit `permission.task` entry wins. Also renders as the agent's scoped `<Agents>` routing catalog (rendered into the default prompt; a custom `prompt`/prompt file replaces it, and an explicit `permission.task` entry skips the catalog). Entries accept internal names, display names, or `@`-mentions (normalized internally); configured ACP wrappers and active council seat names are valid, whereas installed marketplace agents are not (the scope normalizes against the plugin roster only); unknown entries are dropped with a warning, as are entries naming the orchestrator or a disabled agent; `'*'` is reserved. On other agents the key warns and is ignored. An absent list keeps unrestricted delegation |
| `agents.<agent>.skills_include_local` | boolean | - | Adds valid skills from the project's and ancestors' `.opencode/skills/**/SKILL.md` and `.agents/skills/**/SKILL.md` trees before `skills_remove` applies |
| `acpAgents.<name>.command` | string | - | Command for an external ACP-compatible agent; creates a wrapper subagent named `<name>` See [ACP-connected agents](#acp-connected-agents). |
| `acpAgents.<name>.args` | string[] | `[]` | Arguments for the ACP agent command See [ACP-connected agents](#acp-connected-agents). |
| `acpAgents.<name>.env` | object | `{}` | Extra environment variables for the ACP subprocess See [ACP-connected agents](#acp-connected-agents). |
| `acpAgents.<name>.cwd` | string | session directory | Working directory override for this ACP subprocess; protocol paths should be absolute See [ACP-connected agents](#acp-connected-agents). |
| `acpAgents.<name>.description` | string | - | Description shown to OpenCode and injected into the orchestrator routing prompt See [ACP-connected agents](#acp-connected-agents). |
| `acpAgents.<name>.prompt` | string | generated wrapper prompt | Optional full prompt for the lightweight wrapper subagent See [ACP-connected agents](#acp-connected-agents). |
| `acpAgents.<name>.orchestratorPrompt` | string | generated routing block | Optional exact routing block injected into the orchestrator prompt See [ACP-connected agents](#acp-connected-agents). |
| `acpAgents.<name>.wrapperModel` | string | orchestrator default | Cheap OpenCode model used by the wrapper subagent that calls `acp_run` See [ACP-connected agents](#acp-connected-agents). |
| `acpAgents.<name>.permissionMode` | string | `ask` | How ACP permission requests are handled: `ask`, `allow`, or `reject` See [ACP-connected agents](#acp-connected-agents). |
| `acpAgents.<name>.timeoutMs` | integer | `0` | Timeout for a single ACP run in milliseconds. `0` disables the timeout so external agents can run indefinitely. Finite values can be up to `2147483647`ms (~24.8 days) See [ACP-connected agents](#acp-connected-agents). |
| `disabled_agents` | string[] | `["observer"]` | Agent names to disable globally. Set to `[]` to enable Observer; this is global, not per-preset See [Custom Agents](#custom-agents). |
| `image_routing` | `"auto"` \| `"direct"` | omitted (legacy conditional) | Optional. When omitted, resolves to `"auto"` if Observer is enabled, otherwise `"direct"`. Explicit `"auto"` saves image attachments under `.opencode/images/<session>/` and nudges delegation to @observer; saved images remain until you remove them. `"direct"` always passes image parts to the orchestrator. Remove saved images with `rm -rf .opencode/images/` (or a single session subdirectory) when they are no longer needed; session-less messages save images at the top level. The automatic save covers pasted PNG/JPEG/GIF/WebP attachments only: PDFs, images produced by tools, and any image the turn model visibly accepts stay inline. |
| `autoUpdate` | boolean | `true` | Master switch for OMOS plugin updates. When `false`, no update check, notification, or automatic installation runs. Either this or `disabled_hooks: ["auto-update-checker"]` disables the same update path. |
| `multiplexer.type` | string | `"none"` | Multiplexer mode: `auto`, `tmux`, `zellij`, `herdr`, `cmux-tui`, `kitty`, `wezterm`, `orca`, or `none` See [Multiplexer Integration](multiplexer-integration.md). On OpenCode v2 hosts, panes work with the shared background service or an explicit `--server`; `--standalone` hosts ignore the setting (one diagnostic per process). |
| `multiplexer.layout` | string | `"main-vertical"` | Layout preset: `main-vertical`, `main-horizontal`, `tiled`, `even-horizontal`, `even-vertical`. Each adapter maps it to its nearest native expression (tmux full layouts; split directions for Zellij/Herdr; built-in layouts for kitty; split order for WezTerm); cmux-tui has no layout expression and ignores it. Herdr builds an agent area for both `main-*` layouts (`main-vertical` agent column, `main-horizontal` agent row) and re-equalizes only its agent panes after each spawn/close. See [Multiplexer Integration](multiplexer-integration.md#layouts). |
| `multiplexer.main_pane_size` | number | `60` | Main pane size as percentage (20–80) for tmux main layouts and the first Herdr/WezTerm agent split of the `main-*` layouts; Herdr then equalizes the agent panes in the agent column (`main-vertical`) or row (`main-horizontal`) after each spawn/close while the main pane keeps this share. Ignored by Zellij, kitty, and cmux-tui See [Multiplexer Integration](multiplexer-integration.md#layouts). |
| `multiplexer.equalize_panes` | boolean | `true` | Herdr only: after each spawn and agent-pane close, equalize the `main-*` agent panes and re-assert the main pane's `main_pane_size` share via the socket API. Set `false` to keep manual pane sizes |
| `multiplexer.cmux_tui_binary` | string | omitted | Explicit path to the cmux-tui binary. When omitted, the client resolves `cmux-tui` first, then `cmux`, on `PATH` See [Multiplexer Integration](multiplexer-integration.md). |
| `multiplexer.viewer` | string | `"tui"` on v1, `"mini"` on v2 | Subagent pane surface: `"tui"` (full interface) or `"mini"` (lightweight interface). Explicit values override the host default. On v1, `"mini"` requires OpenCode >= 1.17.10 and runs `attach ... --dir <dir> --mini`; on v2 it runs `opencode mini` without a positional directory. Changes take effect on the next opencode start. See [Multiplexer Integration](multiplexer-integration.md). |
| `multiplexer.zellij_pane_mode` | — | — | Removed: ignored with a warning. See [Removed config keys](#removed-config-keys). |
| `tmux` (top-level) | — | — | Removed: ignored with a warning. Use `multiplexer.*`. See [Removed config keys](#removed-config-keys). |
| `backgroundJobs.mode` | string | `"native"` | `"native"` enables Slim task controls and session preset binding. `"off"` disables both. OpenCode runs and reports subagents in either mode. |
| `backgroundJobs.maxRetainedSnapshots` | — | — | Removed: ignored with a warning. See [Removed config keys](#removed-config-keys). |
| `backgroundJobs.strategy` | — | — | Removed: board placement is change-only. See [Removed config keys](#removed-config-keys). |
| `disabled_mcps` | string[] | `[]` | MCP server IDs to disable globally |
| `disabled_tools` | string[] | `[]` | Slim tool names to disable globally. Disabled Slim tools are not registered and their implementations are not loaded; OpenCode built-in tools are not affected. Disabling `acp_run` also omits ACP wrapper agents that would be unusable. |
| `disabled_skills` | string[] | `[]` | Skill names to disable globally. Disabled skills are not granted to agents, and disabled bundled skills are not registered; listing `reflect` here also disables the `/reflect` command |
| `disabled_hooks` | string[] | `[]` | Hook names to disable globally: `phase-reminder`, `foreground-fallback`, `deepwork-goal`, `chat-headers`, `cache-monitor`, `json-error-recovery`, `tool-loop-guard`, `search-path-guard`, `absolute-path-rescue`, `apply-patch`, `council-inject`, `auto-update-checker`. Either `auto-update-checker` here or `autoUpdate: false` turns the whole update feature off (check, notice, install); the hook entry also keeps the hook off if the feature switch is later re-enabled. Unknown values are stripped with a warning when the config loads; a value consisting only of unknown names is treated as unset, so a lower config layer's list still applies. See [Hooks](#hooks) |
| `disabled_commands` | string[] | `[]` | Slash commands to disable globally: `interview`, `implement`, `deepwork`, `reflect`, `preset`, `killall`, `subagent`. Disabled commands are neither registered nor intercepted at execution time, so a user-defined command with the same name is left untouched. Listing `reflect` in `disabled_skills` also disables the `/reflect` command. See [Slash Commands](#slash-commands) |
| `webfetch.enabled` | boolean | `true` | When `false`, the enhanced `webfetch` is not loaded or registered and OpenCode's built-in is used. Listing `webfetch` in `disabled_tools` has the same cold behavior without changing the feature config. See [Webfetch](webfetch.md) |
| `fallback.enabled` | boolean | `true` | Enable Slim's foreground model-chain failover. It does not configure OpenCode provider/AI-SDK retries. On **v2 hosts** the replay path (abort + re-prompt) stays disabled — the v2 `switchModel` has no per-turn/atomic conditional form, so an in-flight replay could commit after a newer user turn has taken over — while the retry-hook steering path runs: host retry events are absorbed up to `fallback.maxRetries`, then the model is switched in place via the host `session.switchModel` and the host retries the current turn on the new model. The same switch disables both paths. |
| `fallback.maxRetries` | integer | `3` | Number of host retry events Slim absorbs before advancing the foreground model chain. The budget stays spent across model switches. Recovery re-arms it: a completed successful assistant response on v1, or a raw `session.step.ended` with `finish` `stop`, `tool-calls` or `length`, or `session.execution.succeeded` on v2. A confirmed new v1 user turn, an observed return to the configured primary outside our committed fallback for a fresh descent, or session deletion also re-arms it. A new v2 user turn alone does not reset the budget; an explicit model change is recorded so returning to the configured primary can re-arm the descent. Landing on the configured head through a committed fallback does not re-arm this budget, including for inherit+chain agents. Terminal `session.error` and `message.updated` failures advance immediately without charging it. On v1, three distinct consecutive completed, error-free `finish: 'unknown'` messages with verified tool-free parts also trigger request-scoped abort and replay without charging retries. `0` advances on the first retry event. This does not configure OpenCode provider or background subagent retries. |
| `fallback.initialRetryDelayMs` | number | `0` | Delay in milliseconds before triggering the first fallback on a failover-worthy error. Gives intercepting plugins time to recover the current model before the fallback chain advances. 0 disables. v1 replay only: the v2 steering path performs no replay, so it ignores this delay. When the delay is nonzero, v2 logs that it is ignored; the notice can repeat after recovery. |
| `fallback.retryDelayMs` | number | `500` | Delay in milliseconds between consecutive fallback attempts after the initial trigger. 0 disables. |
| `fallback.continuationPolicy` | `"retry-primary"` \| `"stick-to-fallback"` | `"retry-primary"` | OpenCode v1 policy for unpinned internal continuations after a confirmed fallback. `"retry-primary"` lets background-completion and lifecycle turns try the configured primary again; `"stick-to-fallback"` keeps them on the confirmed fallback until the next external user turn. |
| `council.presets` | object | - | **Required if using council.** Named councillor presets See [Council configuration note](#council-configuration-note). |
| `council.presets.<name>.<councillor>.model` | string \| array | - | Councillor model: `provider/model` string, or a non-empty ordered fallback chain (array of IDs or `{ id, variant }`) See [Council configuration note](#council-configuration-note). |
| `council.presets.<name>.<councillor>.variant` | string | - | Councillor variant See [Council configuration note](#council-configuration-note). |
| `council.presets.<name>.<councillor>.prompt` | string | - | Optional role guidance for the councillor See [Council configuration note](#council-configuration-note). |
| `council.default_preset` | string | `"default"` | Default preset when none is specified See [Council configuration note](#council-configuration-note). |
| — | — | — | *Timeouts, retries, and bounded waits are handled by the orchestrator's injected Council Mode procedure (`src/hooks/council-inject/index.ts`); execution modes are no longer configured.* |
| `interview.enabled` | boolean | `true` | Master switch for the interview subsystem. When `false`, the `/interview` command is not intercepted, the interview server and dashboard never start, and no interview state or output machinery runs; the native host is untouched See [Interview configuration](interview.md). |
| `interview.maxQuestions` | integer | `2` | Max questions per interview round (1–10) See [Interview configuration](interview.md). |
| `interview.outputFolder` | string | `"interview"` | Directory where interview markdown files are written relative to the project root; absolute paths and `..` traversal are rejected See [Interview configuration](interview.md). |
| `interview.autoOpenBrowser` | boolean | `true` | Automatically open the interview UI in your default browser during interactive runs; suppressed in tests and CI See [Interview configuration](interview.md). |
| `interview.port` | integer | `0` | Interview server port (0–65535). `0` = OS-assigned random port (per-session mode). Any value > 0 enables [dashboard mode](interview.md#dashboard-mode) See [Interview configuration](interview.md). |
| `interview.dashboard` | boolean | `false` | Enable [dashboard mode](interview.md#dashboard-mode) on the default port (43211). Setting `port` > 0 also enables dashboard mode. If both are set, `port` takes precedence See [Interview configuration](interview.md). |
| `interview.printState` | boolean | `false` | When `true`, the interview model prints the full `<interview_state>` block in the TUI instead of submitting state through the `interview_submit_state` tool. See [Interview configuration](interview.md). |
| `companion.enabled` | boolean | `false` | Enable/disable the floating window Rust companion See [Desktop Companion App](#desktop-companion-app). |
| `companion.binaryPath` | string | - | Optional path to a custom companion binary to launch instead of the default install path See [Desktop Companion App](#desktop-companion-app). |
| `companion.position` | string | `"bottom-right"` | The initial corner position of the companion window: `bottom-right`, `bottom-left`, `top-right`, or `top-left` See [Desktop Companion App](#desktop-companion-app). |
| `companion.size` | string | `"medium"` | The default size preset of the companion window: `small` (80px), `medium` (120px), or `large` (160px) See [Desktop Companion App](#desktop-companion-app). |
| `companion.gifPack` | string | `"default"` | Bundled animation pack. See [Desktop Companion App](companion.md). |
| `companion.loopStyle` | string | `"classic"` | `classic` (forward loop) or `smooth` (ping-pong). See [Desktop Companion App](companion.md). |
| `companion.speed` | number | `1` | Playback speed multiplier, `0.25`–`4`. See [Desktop Companion App](companion.md). |
| `companion.debug` | boolean | - | Verbose native companion debug logs. See [Desktop Companion App](companion.md). |

The plugin's `agents.<agent>.mcps` setting controls which configured plugin MCP
servers its policy allows. It is not a host-native `agent.mcps` property and
does not replace host permission rules: an explicit host permission denial for
an MCP tool remains authoritative.

### Removed config keys

These keys were removed. A config file that still contains one keeps loading:
the key is dropped before validation and a warning names it, for example
`Config key "fallback.timeoutMs" was removed in this version and is ignored;
see docs/configuration.md`. Values are **not** migrated (the one exception is
`backgroundJobs.enabled: false`, still applied as `mode: "off"`), so set the
replacement yourself where one exists.

| Removed key | Use instead |
|-------------|-------------|
| `agents.<agent>.primary` and preset equivalents | Custom agents are specialists. Use `/preset` to switch the built-in orchestrator’s subagent models. |
| `tmux` (top-level block) | `multiplexer.type: "tmux"` plus `multiplexer.layout` / `multiplexer.main_pane_size` |
| `council.master`, `council.master_timeout`, `council.master_fallback` | Configure the Council agent like any agent, e.g. `presets.<name>.council.model` |
| `council.presets.<name>.master` (councillor named `master`) | None; rename the councillor if you still want it |
| `council.presets.<name>.councillors` (nested wrapper) | Put councillors directly under `council.presets.<name>` (the wrapped entries are dropped) |
| `backgroundJobs.enabled` | `backgroundJobs.mode`: `true` → host default (`"managed"` on V1, `"native"` on V2), `false` → `"off"` (a stale `enabled: false` without `mode` is still applied as `"off"`, with a warning) |
| `backgroundJobs.continueOnIdle`, `backgroundJobs.orchestratorWake` | OpenCode delivers native subagent completions. The periodic idle reminder was removed. |
| `backgroundJobs.maxContextLines` | None; reusability is state-based (terminal, reconciled, status-certain). See [Background Job Management](#background-job-management) |
| `backgroundJobs.readContextMinLines` | None; the per-session read-context list is path-only with an internal display cap |
| `backgroundJobs.readContextMaxFiles` | None; the display cap is internal |
| `backgroundJobs.strategy` | None; board placement is change-only (one frozen board per state change, replayed byte-identically; nothing on unchanged turns) |
| `backgroundJobs.maxRetainedSnapshots` | None; frozen boards are retained per parent session and cleared at session end |
| `fallback.timeoutMs`, `fallback.retry_on_empty`, `fallback.runtimeOverride` | None; tune `fallback.maxRetries` / `fallback.retryDelayMs` |
| `multiplexer.zellij_pane_mode` | None; Zellij panes always open in the parent pane's tab |

Other unknown or invalid keys are not covered by this list and still make the
config file invalid.

### Runtime Preset Switching

On v2, `/preset` opens a manager with two application scopes:

- **Current session** saves that session's subagent inference configuration
  without changing the configuration file's selected preset. It affects
  future delegations, including explicit same-agent continuations of bound
  children. Applying alone does not update a child or the main session's
  native model selection.
- **Global default** writes the user configuration. It affects unbound
  sessions and refreshes default-bound roots on their next admission, subject
  to project and environment overrides.
  `/preset <name>` does not touch it: the command applies the preset to the
  session it runs in, like the manager's Current session action.

Each work session binds its resolved inference settings before its first
managed prompt. New children inherit their direct parent's snapshot,
including variants, options and fallback chains. Default-bound roots refresh
on their next admission; invalid configuration preserves their previous
snapshot. Named-preset bindings stay pinned until explicitly reapplied.
Bindings persist across restarts.

Same-ID continuation is best-effort. The host selects the model, the plugin
installs inference options before the prompt, and a successful native return
saves the adopted snapshot. Failures are reported without rolling back native
model or history changes; repeating a failed call can submit the prompt again.

Only subagent inference settings (`model`, `variant`, `temperature`,
`options`, and fallback chains) are isolated. Prompts, tools, permissions,
skills, MCPs and marketplace activation keep their normal host lifecycle.
Invalid configuration preserves the last-known-good defaults. On v1, apply
the preset to the configuration and reload OpenCode as before. See
[Preset Switching](presets/preset-switching.md) for scope, timing and concurrent-session
examples.

### Preset inheritance

Use `extends` to make a preset inherit from one base preset. The child can
override only the agents it needs to change:

```jsonc
{
  "presets": {
    "base": {
      "agents": {
        "orchestrator": { "model": "openai/gpt-6-sol" },
        "designer": { "model": "openai/gpt-6-luna" }
      }
    },
    "design": {
      "extends": "base",
      "agents": {
        "designer": { "model": "anthropic/claude-sonnet-4-6" }
      }
    }
  }
}
```

`design` keeps the base orchestrator model and replaces only the base
designer model. Presets support a single parent only; multi-parent
inheritance is not supported. For overlapping agent fields, precedence is:

**ancestor < child < root `agents` < host config**

Here, root `agents` means the plugin's top-level `agents` object, while host
config means the agent entry in OpenCode's `opencode.json`. A root `agents`
entry is global: it overrides the active preset, so do not put an agent there
if its value should vary by preset. Host config remains the final override.

These precedence rules also apply when resolving a named preset for a v2
session binding. Editing an inherited definition updates future bindings and
refreshes default-bound roots on their next admission; named-preset bindings
retain their resolved inference snapshots until explicitly reapplied. On v1,
reload after changing the active preset.

> **niri note:** `companion-v0.1.3` includes the fixed native companion release.
> To make it open as a bottom-right overlay, add a niri rule matching its stable
> `app-id`/title (`oh-my-opencode-slim-companion`), for example:
>
> ```kdl
> window-rule {
>     match app-id=r"^oh-my-opencode-slim-companion$"
>     match title=r"^oh-my-opencode-slim-companion$"
>     open-floating true
>     open-focused false
>     default-floating-position x=16 y=16 relative-to="bottom-right"
> }
> ```

### ACP-connected agents

Use `acpAgents` to expose external Agent Client Protocol servers as optional
OpenCode subagents. The plugin creates a lightweight wrapper agent for each
entry. The wrapper calls the `acp_run` tool, which starts the ACP
process, creates a session, sends the task, streams tool and plan progress to
the TUI while the agent works, and returns the final result. Listing `acp_run`
in `disabled_tools` removes the tool and every wrapper that could call it.
`command` is only the executable; put flags and subcommands in `args`.

See **[ACP Agents](acp-agents.md)** for the dedicated setup guide, auth notes,
and troubleshooting.

```jsonc
{
  "acpAgents": {
    "claude-research": {
      "command": "claude-code-acp",
      "args": [],
      "description": "Claude Code subscription agent for deep research",
      "wrapperModel": "openai/gpt-6-luna",
      "permissionMode": "ask",
      "timeoutMs": 300000
    },
    "gemini-acp": {
      "command": "gemini",
      "args": ["--experimental-acp"],
      "description": "Gemini CLI through ACP"
    }
  }
}
```

> **Tip:** Use ACP to connect local agent CLIs. For example, `ollama` or `llama.cpp`
> can be exposed as ACP agents by wrapping them in a lightweight ACP adapter.

After restart, the orchestrator can delegate to `@claude-research` or
`@gemini-acp`. Use safe names matching `^[a-z][a-z0-9_-]*$`; names cannot
conflict with built-in or custom agents. `permissionMode` controls ACP
permission requests, but the plugin still asks before launching the configured
subprocess.

Inner model selection is a **per-call tool argument**, not static configuration.
For a server advertising `fable`, the wrapper can call
`acp_run(agent: "claude-code", model: "fable", prompt: "Investigate this bug")`.
The optional `model` is an exact ACP selector, not an OpenCode `provider/model`.
`wrapperModel` and native `subagent.model` select only the outer wrapper; they
can stay fixed while each ACP invocation selects a different inner model.

The generated routing prompt delegates with task text such as:

```text
Inner ACP selector: fable
Task: Investigate this bug and summarize the likely cause.
```

The wrapper extracts the explicit selector into `acp_run.model` and forwards the
actual task, constraints, and relevant context without wrapper-routing text.
This is LLM-mediated extraction, not a new native `subagent` argument. Custom
`prompt` and `orchestratorPrompt` overrides replace the respective generated
instructions and must supply this guidance themselves.

Explicit selectors require advertisement and exact acknowledgement before any
prompt; failures do not fall back. Omission uses the external default, never a
remembered selection. An unresolved explicit request should be reported as
ambiguous, not omitted or guessed. See
[Per-invocation inner models](acp-agents.md#choosing-the-inner-model-per-invocation).

### Council configuration note

- Councillor `model` and ACP `wrapperModel` values use `provider/model`
  references. The provider must be nonempty and cannot contain whitespace or
  `/`; the nonempty model remainder is retained verbatim and may contain spaces
  and nested `/` values, such as `opencode-omniroute-live/of/MiniMax M3`.
- The **Council agent model** is configured like any other agent, for example in
  `presets.<name>.council.model`.
- The **councillor models** are configured separately under
  `council.presets.<name>.<councillor>.model`.
- `council.master*` keys were removed: ignored with a warning (see
  [Removed config keys](#removed-config-keys)).

```jsonc
{
  "council": {
    "default_preset": "balanced",
    "presets": {
      "balanced": {
        "alpha": {
          "model": "openai/gpt-6-astra",
          "variant": "high"
        },
        "beta": {
          "model": "anthropic/claude-sonnet-4-5",
          "variant": "medium"
        }
      }
    }
  }
}
```

### Manual Update Mode

Set `autoUpdate` to `false` to turn the whole OMOS plugin update feature off:
no startup check, no update notice, and no automatic package install.

```jsonc
{
  "autoUpdate": false
}
```

Alternatively, list the checker in `disabled_hooks` (on both v1 and v2,
including the v2 TUI notice). Either switch disables the same feature; the hook
entry is the per-hook form and stays effective if `autoUpdate` is re-enabled:

```jsonc
{
  "disabled_hooks": ["auto-update-checker"]
}
```

Pinned versions and unsupported install layouts retain their existing
notification behavior when update checking is enabled.

Auto-update never crosses major versions. For example, a 1.x install can
auto-update to a newer 1.x release, but it won't auto-install 2.x. When a newer
major is available, the plugin shows a migration command instead, along with the
running version and the cached copy it resolved from.

Installs are coordinated across OpenCode processes: when several windows are
open, only one installs a pending version. The others wait for that install to
finish, then skip their own install and prompt you to restart. If a window
cannot get the install lock in time, it skips quietly and retries the update
check on the next OpenCode server start (the check runs once per server
process, not once per session).

> Pinned plugin entries in `opencode.json` (for example
> `"oh-my-opencode-slim@1.0.1"`) are the true version lock. Those stay pinned
> regardless of `autoUpdate`.

### Background Job Management

OpenCode owns child execution, continuation, delivery, and restart recovery.
Slim defaults to `backgroundJobs.mode: "native"`, which enables exact-ID
`task_status`, `task_cancel`, permission-only `task_reply`, queue-only
`task_report`, and session preset binding. Use `"off"` to disable Slim's
task controls and session bindings.

Remove retired managed lifecycle settings listed in the
[upgrade guide](v2-native-upgrade.md).

### Model fallback

`fallback.maxRetries` is unrelated to the wall-clock supervisor and to
OpenCode's provider retry policy. A value of `0` allows no host retry events
before foreground failover; it does not prevent OpenCode from retrying a
provider request in a child session.

With a configured chain, a host-announced retry wait longer than 30 minutes
bypasses this budget and starts fallback. Waits up to 30 minutes, or retries
without timing metadata, still use the configured retry count. The configured
fallback delays still apply; sessions without a chain keep their existing behavior.

Both fallback paths scan the chain from its head, skipping models already tried
and providers abandoned by this session or its parent. Starting on a later entry
does not skip the untried entries before it. A provider is excluded only after a
provider-level failure switches the session away from it, so other models on the
current provider remain eligible for the immediate next pick. Each provider mark
expires 30 minutes after the provider-level switch that recorded it; another
such switch refreshes its age. Recovery on another provider does not clear the
mark. An observed turn or continuation on a different model clears the fallback
record earlier. Expiry leaves the active fallback model unchanged. When no eligible
entry remains, Slim retries the last chain entry once, ignoring provider
exclusions and retaining the tried set; another failure ends intervention
(v1 aborts once, while v2 leaves the host's retry decision unchanged).

A spent allowance (for example `The usage limit has been reached`,
`quota exceeded`, or `Weekly usage limit reached. Resets in 2 days.`) marks
the failing model's provider exhausted, so the next pick skips every
remaining entry on that provider, including the current provider's other
models and the sticky retry. When no chain entry remains on a provider with
allowance left, the error surfaces to the user: Slim neither switches models
nor aborts. A spent allowance also skips the `fallback.maxRetries` host-retry
budget, but keeps `fallback.initialRetryDelayMs`. Short-horizon wording in the
same error (`retry after 20s`, `try again`, `per minute`, `resets at 15:00`)
is treated as an ordinary rate limit, and free-tier exhaustion (`Free usage
exceeded, subscribe to Go`) stays permanent billing. Exhausted providers are
re-armed with the retry budget: a successful response, a new v1 user turn, a
fresh descent from the configured primary, or session deletion. Landing back
on a primary whose allowance is spent does not count as a fresh descent.

On v2 hosts, the two fallback paths are gated separately. The replay path
(abort + re-prompt driven by `session.error`, `message.updated` and
`session.status` retry) stays disabled: the v2 `switchModel` has no
per-turn/atomic conditional form, so an in-flight replay could commit on the
host after a newer user turn has taken over. The retry-hook steering path
runs instead: the host invokes the session `retry` hook at its own retry
decision points, Slim absorbs host retries up to `fallback.maxRetries`, then
switches the model in place via `session.switchModel` and mutates the retry
decision so the host retries the current turn on the new model — no
transcript replay, so the per-turn race cannot occur. Descent bookkeeping
stays live on v2: a raw `session.step.ended` with `finish` `stop`, `tool-calls`
or `length`, or `session.execution.succeeded`, resets tried models, exhaustion
and the retry budget. Usage telemetry, synthesized completed-assistant messages
and other step finishes do not prove recovery. A new v2 user turn alone does
not reset the descent. When its model differs from the confirmed fallback,
Slim records the selected model and clears that fallback; returning to the
configured primary lets the existing re-arm start a fresh descent.
`fallback.initialRetryDelayMs` has no effect on the steering path (there is
no replay to delay; the host's own retry backoff is the recovery window) —
a one-time log line notes the divergence. Both paths share the same user
switches: `fallback.enabled` and `disabled_hooks: ["foreground-fallback"]`
disable steering too.

#### Quota reset cooldowns on v2

When a v2 retry observation confirms quota exhaustion and includes a positive
native `retryAfterMs`, Slim remembers the reset deadline for that configured
`provider/model`. This includes confirmed quota-exhaustion 429 responses, not
ordinary rate limits. Missing reset information, authentication failures and
request-scoped errors do not create durable exclusions; native retry and
fallback behavior remains unchanged for those cases.

The deadline is shared across sessions and process restarts in
`omos-quota-cooldowns.json` under the OpenCode configuration directory
(`OPENCODE_CONFIG_DIR`, otherwise `XDG_CONFIG_HOME/opencode` or
`~/.config/opencode`). Existing fallback selection skips a cooling model while
preserving chain order and variants. A request that explicitly selects a cooling
model is refused before transport rather than silently rewritten. Eligibility
returns at the deadline; reading or restarting does not extend it.

Automatic restoration to the original model also respects its quota deadline,
even after a temporary provider-failure mark expires. The session keeps its
confirmed fallback while the origin is cooling, retaining the original model
and variant for a later eligible restoration.

The configuration directory is the sharing domain, not an account identity.
Variants of one provider/model share its deadline; other models and providers
are not excluded by that record. Credentials and endpoints are not inspected or
fingerprinted. If the provider recovers early or the account changes, quiesce
writers and remove this file to clear the records, or disable foreground
fallback with the existing controls above. Automatic early recovery is not
claimed. Missing, invalid or temporarily unavailable storage leaves ordinary
native behavior in place rather than blocking all requests.

On v2, `provider.content-filter` is a request-scoped failover error even when
the host sets `decision.retry` to `false`. Slim advances to the next eligible
model without adding the rejected request's provider to the abandoned set.
A model switch that times out but later succeeds is reconciled if the observed
model is still the failed source or already the switch target; a different
observed selection is left untouched.

Hosts up to v2.2.x end a step that finishes with `content-filter` without
calling the `retry` hook, and 2.3 still does. Slim observes `session.step.failed`
instead, switches the model in place, and continues the run with one internal
prompt; root sessions and children continue in place. OpenCode reports each
continued child period to its parent when it settles, including the
`state="error"` notice for the refused period, so Slim adds no second result
notice. `backgroundJobs.mode: "off"` leaves the native executor untouched:
a refused child is continued in place and reported by the host.

On v2, the host's `provider.transport` errors (response-header timeouts,
dropped connections) walk the chain like other provider failures. A
`provider.no-route` failure before the step starts (the session's model or
route is gone) continues on the next model the same way as a content-filter
step. A `provider.auth` 401 gets one same-model retry per turn, so an OAuth
refresh can land, before the next 401 switches models.

Models rejected for the request itself (content policy, unknown or retired
model, HTTP 410/421/451) stay excluded from the chain until the next external
prompt, even after later successful steps reset the rest of the descent. On
v2 they also skip the host-retry budget and fail over at once.

### Agent Display Names

Use `displayName` to give an agent a user-facing alias while keeping the
internal agent name unchanged.

```jsonc
{
  "agents": {
    "oracle": {
      "displayName": "advisor"
    },
    "explorer": {
      "displayName": "researcher"
    }
  }
}
```

With this config, users can refer to `@advisor` and `@researcher`, while the
plugin still routes them to `oracle` and `explorer` internally.

Notes:

- `displayName` works in both top-level `agents` overrides and inside `presets`
- `@` prefixes and surrounding whitespace are normalized automatically
- Display names must be unique
- Display names cannot conflict with internal agent names like `oracle` or `explorer`
- The TUI sidebar labels the agent with its display name, but models, activity,
  row expansion, history and click targets stay keyed by the internal name.
  Display names are frozen until a full reload, so renaming or removing one
  changes the sidebar label only after the plugin reloads

### Updating configurations after the librarian merge

`explorer` now handles codebase and external research. `librarian` remains a
reserved alias; its settings fill fields that Explorer does not explicitly set.

Old generated presets contained both `librarian.mcps: ["context7", "gh_grep"]`
and `explorer.mcps: []`. The empty Explorer list accidentally hid the research
MCPs. On load, Slim now removes that empty field **in memory** when this exact
pair occurs in one source preset (either MCP order is accepted). Existing alias
resolution then carries Librarian's list to Explorer. Loader and doctor report
which preset was repaired; neither rewrites your JSON/JSONC file.

This rule also matches a hand-written preset with the identical pair: there is
no generation marker that distinguishes them. To deliberately deny all MCPs
while retaining that legacy pair, use `explorer.mcps: ["!*"]`. Root `agents`,
non-empty Explorer lists, custom Librarian MCP lists, and entries split across
layers or inherited presets are not repaired. Higher-layer overrides still win.

| Setting | What to check when upgrading |
|---------|-----------------------------|
| MCPs | New configs omit `mcps` and use runtime defaults. Outside the exact pair above, remove a stale Explorer override to inherit defaults, or set `["context7", "gh_grep"]` explicitly. `disabled_mcps` and host permission restrictions remain authoritative. |
| Model, variant, skills, inline prompt | Explicit Explorer fields win over Librarian fields, including `skills: []`. Move custom Librarian values you want to keep into Explorer, or remove the conflicting Explorer fields. Slim does not guess which values you intended. |
| Prompt files | `librarian.md` and `librarian_append.md` remain supported with a rename notice. Within a location, Explorer files win; project files retain precedence over global files. |
| Disabled agent | `disabled_agents: ["librarian"]` disables Explorer. Remove it if you want the merged research role enabled. |
| Host and marketplace config | Host `agent.librarian` settings and marketplace `builtin: "librarian"` remain supported. Use `explorer` in new settings; the legacy name cannot be reused as a custom, ACP, or display name. |

For an explicit MCP correction that overrides presets:

```jsonc
{
  "agents": {
    "explorer": { "mcps": ["context7", "gh_grep"] }
  }
}
```

Reload OpenCode after upgrading or changing MCP/skill permissions; these are
frozen for existing sessions. Avoid installer `--reset`: it replaces customized
configuration rather than repairing the one stale field.

### Independent agent model inheritance

By default, the `fixer` agent inherits the `explorer` model when no fixer
model is configured. To decouple agents, set `inheritModelFrom` on the agent
that should follow the current session or the configured orchestrator model:

```jsonc
{
  "agents": {
    "explorer": {
      "model": "ollama/qwen3.8:27B"
    },
    "fixer": {
      "inheritModelFrom": "session"
    }
  }
}
```

Supported values are:

- `session`: omit the agent model so OpenCode uses the current session model
- `orchestrator`: follow the live orchestrator/session model, including later
  fallback switches

`orchestrator` inheritance remains live when the orchestrator changes models.
Delegated agents therefore follow the active fallback model rather than
starting on a stale primary and waiting for an avoidable provider failure.
Their own configured model array remains the ordered fallback chain after the
inherited active model.

Independent specialists move only when a confirmed parent fallback abandoned
their primary provider after a provider-level failure. Slim picks the first
entry in the child's own chain outside those providers, with no preference for
the parent's model/provider. Policy/content-filter failures, retired or unknown
models, and manual selections leave independent children unchanged; so does a
chain with no healthy provider.
On later failures, the child's own fallback scans from the head and skips
providers with unexpired marks from either the child or its parent.
OpenCode v2 uses the native per-call subagent model override. On v1, the child's
first prompt claims a delegation intention using the host's parent link and empty
transcript; a `task_id` resume instead targets that child's next prompt. Slim
recalculates the live parent selection before the host saves the prompt, without
depending on `session.created` delivery or `tool.execute.after`. Unrelated later
prompts cannot claim creation intentions. The specialist name stays canonical, so
`task` permissions and the task tool's agent list are unchanged. On v1,
`fallback.continuationPolicy` controls what happens when an unpinned native
background-completion or lifecycle turn follows a confirmed fallback. The
default, `"retry-primary"`, lets the host try the configured primary again,
which is useful after a quota or provider outage is repaired. Set it to
`"stick-to-fallback"` to keep those internal continuations on the confirmed
fallback until the next external user turn.

V2 forwards configured variants as `provider/model#variant`. The host rejects
a variant unavailable for that model; Slim does not silently drop it.
The v2 runtime-profile bridge preserves a child's per-call model and variant
when its provider, model ID, or variant differs from the startup selection.
An omitted variant and `default` identify the same default variant.
When the agent has a startup model, a differing model is kept unless the
host's model catalog proves it retired (no catalog, an empty catalog, a
provider missing from the catalog, or a failed lookup keeps the pin); a model
that a config change retired is refreshed onto the current profile, including
its temperature and provider options, instead of being replayed across
restarts.
If the agent started without a model, any child model is kept, including the
parent model v2 gives new subagents; a model added later applies after reload.
New managed children receive the inference profile bound to their parent,
not the latest global default. Default-bound roots refresh on their next
admission; named-preset bindings remain pinned until explicitly reapplied.

Model selection follows these rules:

- If the same effective agent override contains both a scalar `model` and
  `inheritModelFrom`, the explicit `model` wins.
- If `model` is omitted, `inheritModelFrom` is an explicit higher-layer
  directive: it clears a lower-layer `model` value, including a model supplied
  by the host agent configuration, and resolves the requested source.
- If the same effective agent override contains both an **array** `model`
  (an ordered fallback chain) and `inheritModelFrom`, the two combine: the
  agent follows the session/orchestrator model, and the array serves as the
  fallback chain tried when that model fails. See
  [Following the session model with a fallback chain](#following-the-session-model-with-a-fallback-chain).
- If neither field is present, the existing model precedence and the
  fixer-to-explorer fallback remain unchanged.

The setting works in both root `agents` overrides and preset agent overrides.

#### Following the session model with a fallback chain

Combine `inheritModelFrom` with an array `model` when a subagent should
prefer the main agent's current model — including manual `/model` switches —
but still survive that model dying (rate limit, quota, outage):

```jsonc
{
  "agents": {
    "oracle": {
      "model": ["anthropic/claude-sonnet-4-6", "openai/gpt-6"],
      "inheritModelFrom": "session"
    }
  }
}
```

At launch the agent inherits the session model instead of the chain head.
When a failover-worthy error hits, the runtime chain is
`[<current session model>, ...configured chain]`: the live model is never
re-picked, the first eligible configured entry takes over, and later entries
follow in order. Chain exhaustion stays bounded — after the whole chain fails once, one
re-fallback round runs on the last entry, then the session aborts instead of
looping. A `/model` pick on such an agent is its follow target; it never
disables the fallback chain.

An inline `variant` on the first chain entry belongs to that entry's model.
When inheritance makes the agent follow the session model, the inline variant
is cleared at both the agent layer and the final host config — the followed
model must not run with a variant meant for a fallback model. Set an explicit
agent-level `variant` if you want one regardless of the followed model.

Do not combine an array `model` with `inheritModelFrom: "session"` on the
`orchestrator` itself. The orchestrator *is* the session: every config pass
would clear the host-persisted model selection (including a manual `/model`
pick) with nothing to follow, leaving the orchestrator without a stable
configured model. Use a plain array `model` on the orchestrator and combined
policies on subagents.

### Agent Colors

Built-in agents ship without a default `color`, so the OpenCode TUI assigns
each one a distinct color from its own theme-aware palette. Set `color`
explicitly if you want a fixed color for a built-in or custom agent, using a
six-digit hex value or an OpenCode theme color:

```jsonc
{
  "agents": {
    "oracle": { "color": "#FF5733" },
    "reviewer": {
      "model": "openai/gpt-6",
      "color": "info"
    }
  }
}
```

Theme colors adapt to the active OpenCode theme. Dynamic councillors inherit
the configured `council` color unless `agents.councillor.color` overrides it.
`color` works in top-level `agents` overrides and inside `presets`.

The OMO-Slim sidebar uses the same setting: an agent with a configured `color`
shows its name and model in that color, and agents without one stay in muted
text. Hex values work on every host; theme colors fall back to muted text when
the active host theme does not expose that token.

### Per-preset agent configuration

To get per-preset behavior for any agent, built-in (`council`, `oracle`,
`explorer`, `fixer`, `designer`, `observer`) or custom, define
the agent override inside each preset block, not in root `agents`.

```jsonc
{
  "presets": {
    "balanced": {
      "council": { "model": ["opencode/mimo-v2.5-free", "opencode-go/minimax-m3", "opencode/minimax-m3"] },
      "oracle": { "model": "opencode/big-pickle", "variant": "high" },
      "skeptic": { "model": ["opencode/big-pickle", "opencode-go/qwen3.7-plus"], "variant": "max" }
    },
    "nvidia-free": {
      "council": { "model": ["nvidia/z-ai/glm-5.2", "nvidia/moonshotai/kimi-k2.6"] },
      "oracle": { "model": "nvidia/deepseek-ai/deepseek-v4-pro", "variant": "high" },
      "skeptic": { "model": ["nvidia/deepseek-ai/deepseek-v4-pro", "nvidia/mistralai/mistral-large-3-675b-instruct-2512"], "variant": "max" }
    }
  }
}
```

#### Agent precedence

For overlapping agent fields, the effective precedence is:

**ancestor < child < root `agents` < host config**

An ancestor supplies defaults, the child preset overrides them, the plugin's
top-level `agents` object overrides the active preset, and the agent entry in
OpenCode's `opencode.json` is the final override. A root `agents` entry is
global rather than per-preset, so put an agent inside each preset when its
value should vary by preset. This precedence applies both to configuration
defaults and to v2 session inference snapshots; choosing a session preset
does not give it higher precedence than root `agents` or host configuration.

#### Sharing a prompt across presets (custom agents)

A custom agent with a long prompt does not need the prompt duplicated into
every preset block. Put the prompt in a file and define the agent in each
preset with only `model` (and `variant` if needed):

1. Create `<projectDir>/.opencode/oh-my-opencode-slim/<agentName>.md` with
   the shared prompt.
2. In each preset block, define the agent with only the model fields (no
   `prompt`):

```jsonc
{
  "presets": {
    "balanced": {
      "skeptic": { "model": ["opencode/big-pickle", "opencode-go/qwen3.7-plus"], "variant": "max" }
    },
    "nvidia-free": {
      "skeptic": { "model": ["nvidia/deepseek-ai/deepseek-v4-pro", "nvidia/mistralai/mistral-large-3-675b-instruct-2512"], "variant": "max" }
    }
  }
}
```

`loadAgentPrompt` (`src/config/loader.ts:1006`) is preset-aware and reads
`<agentName>.md` from the `oh-my-opencode-slim/` prompts directory. Lookup
order:

1. `<projectDir>/.opencode/oh-my-opencode-slim/<preset>/<agentName>.md` (project, preset-specific)
2. `<projectDir>/.opencode/oh-my-opencode-slim/<agentName>.md` (project, preset-agnostic)
3. `~/.config/opencode/oh-my-opencode-slim/<preset>/<agentName>.md` (user, preset-specific)
4. `~/.config/opencode/oh-my-opencode-slim/<agentName>.md` (user, preset-agnostic)

A preset block without `prompt` falls back to the file prompt (if one
exists), not to a root `agents.<name>.prompt`. The project-level paths (1
and 2) work universally and are the recommended location for shared
prompts. User-level paths (3 and 4) can collide with a plugin install
symlink if `~/.config/opencode/oh-my-opencode-slim/` is symlinked to the
plugin source.

> **⚠️ Known limitation (#899):** Prompt files take precedence over inline
> prompts everywhere — not just in presets, but also in root `agents`.
> If you set an inline `prompt` in a preset or in root `agents` and a
> prompt file exists for that agent, the inline prompt is silently dropped
> in favor of the file. Until #899 is fixed, the file-based shared prompt
> pattern above is the safe path: keep the prompt in the file, and put
> only `model`/`variant` in the config. Do not mix an inline `prompt`
> with a prompt file for the same agent.

### Custom Agents

Unknown keys under `agents` define custom subagents. A custom agent needs
its own `model`, a normal `prompt`, and optionally an `orchestratorPrompt` that
teaches the orchestrator exactly when to delegate to it.

```jsonc
{
  "agents": {
    "janitor": {
      "model": "github-copilot/gpt-6",
      "prompt": "You are Janitor. Audit codebase entropy, dead code, docs drift, naming inconsistencies, and unnecessary complexity. Prefer analysis and plans over direct edits.",
      "orchestratorPrompt": "@janitor\n- Role: Maintenance specialist for codebase cleanup and entropy reduction\n- **Delegate when:** after large refactors • cleanup/technical-debt review • dead code or docs drift is suspected\n- **Don't delegate when:** feature implementation • urgent debugging • UI/UX work"
    }
  }
}
```

Notes:

- Custom agent names must be safe identifiers such as `janitor` or `security-reviewer`
- Custom agents without a `model` are skipped with a warning
- Disabled custom agents are not registered or injected into the orchestrator prompt
> **Tip:** Keep `orchestratorPrompt` concise — the orchestrator reads it every turn.
> Include: when to delegate, when NOT to delegate, and the agent's role in one paragraph.

### Agent Permissions

The `permission` field provides deterministic, tool-level permission restrictions on custom agents, built-in agent overrides, and presets. Unlike prompt instructions ("do not edit files"), these rules are enforced by the OpenCode SDK at the tool-call level.

The field accepts either:

1. **Shorthand string** — `"ask"`, `"allow"`, or `"deny"` applied to all tools
2. **Object** — keys are tool names, values are `"ask" | "allow" | "deny"` or (for rule keys) a pattern-to-action map

**Key order is precedence.** Entries compile into ordered `{action, resource, effect}` rules that opencode evaluates last-match-wins (the host parses `permission` with `propertyOrder: "original"`, and the plugin preserves your key order verbatim). Put the wildcard base first and specific rules after it: `{"*": "deny", "read": "allow"}` denies everything except `read`; the reverse order denies `read` too. The same applies inside a pattern map (`bash: {"*": "ask", "git status*": "allow"}`) and across preset inheritance: a later layer's entries keep the order the layer writes them, and base keys the layer does not mention precede them, so the layer's `"*"` shadows them and `{"*": "deny", "read": "allow"}` merged onto any base always yields `read` after the wildcard. The rule is that a later wildcard can tighten anything but can only loosen what the layer names. Unmentioned entries at least as strict as the layer's wildcard (deny > ask > allow; only denies when the layer has no wildcard) move after the layer's keys and keep winning. A pattern map holding such an entry moves whole, in its own order, with each looser entry raised to the wildcard's action, so `bash: {"*": "allow", "rm -rf /": "deny"}` under a layer's `{"*": "deny"}` denies all of bash, under `{"*": "allow"}` still denies `rm -rf /`, and `bash: {"git *": "deny", "git log *": "allow"}` under `{"*": "ask"}` asks for `git log` and denies other git commands. Nested maps follow the same rule against their own `"*"`, and the base's own `"*"` always stays the fallback. To lift an inherited deny, name that key.

**Example: read-only `planner` agent:**

```jsonc
{
  "agents": {
    "planner": {
      "model": "openai/gpt-5.5",
      "variant": "high",
      "skills": [],
      "mcps": ["context7", "gh_grep"],
      "permission": {
        // Order is precedence: the wildcard base must come first.
        "*": "deny",
        "read": "allow",
        "glob": "allow",
        "grep": "allow",
        "list": "allow",
        "bash": {
          "*": "ask",
          "git status*": "allow",
          "git diff*": "allow",
          "grep *": "allow"
        },
        "webfetch": "allow",
        "websearch": "allow", // opencode's built-in websearch tool, not a plugin MCP
        "task": "deny"
      },
      "prompt": "You are Planner. Create implementation plans only. Do not implement code."
    }
  }
}
```

**Example: `security-reviewer` agent:**

```jsonc
{
  "agents": {
    "security-reviewer": {
      "model": "anthropic/claude-sonnet-4-5",
      "permission": {
        "edit": "deny",
        "bash": "deny",
        "webfetch": "allow"
      },
      "prompt": "You are a security reviewer. Inspect code and report findings. Do not patch anything."
    }
  }
}
```

#### Permission keys

| Key | Value type | Description |
|-----|------------|-------------|
| `read` | string or object | File reading |
| `edit` | string or object | File editing |
| `glob` | string or object | File pattern matching |
| `grep` | string or object | Content search |
| `list` | string or object | Directory listing |
| `bash` | string or object | Shell command execution |
| `task` | string or object | Subagent task delegation |
| `external_directory` | string or object | Access to directories outside the workspace |
| `lsp` | string or object | Language server protocol operations |
| `skill` | string or object | Skill execution |
| `todowrite` | string only | Todo list writing |
| `question` | string only | Asking the user questions (subagents default to `deny`; explicit `allow`/`ask`/`deny` per agent is honored; only primary agents ask by default) |
| `webfetch` | string only | Web content fetching |
| `websearch` | string only | Web search |
| `codesearch` | string only | Code search |
| `doom_loop` | string only | Doom loop prevention |

Keys marked "string or object" accept pattern-based rules (e.g. `bash: { "git status*": "allow", "*": "ask" }`). Keys marked "string only" accept a single `"ask"`, `"allow"`, or `"deny"` value. Unknown tool names (including MCP-derived keys) pass through without error.

#### Merge semantics

When a user supplies `permission` and also uses the `skills` or `mcps` arrays on the same agent, the plugin merges them:

1. **User-supplied `permission` is the base layer.**
2. **Plugin-generated rules from the `skills` array override `permission.skill`** — the `skills` array is authoritative for skill gating.
3. **Plugin-generated rules from the `mcps` array fill the `permission.<mcp>_*` keys you have not set** — an explicit `<mcp>_*` entry in `permission` wins over the `mcps` array.
4. **User-supplied keys for standard tools** (`edit`, `bash`, `webfetch`, `task`, etc.) survive the merge untouched.

Use the `skills`/`mcps` arrays for skill and MCP gating. Use `permission` for everything else (file access, bash, web, task delegation).

### Hooks

Disable built-in hooks via `disabled_hooks`:

```json
{ "disabled_hooks": ["phase-reminder"] }
```

Available hooks:

- **Prompt injection**: `phase-reminder` (per-turn scheduler-workflow reminder on orchestrator messages), `deepwork-goal` (post-compaction goal pointer, delivered once per compaction epoch), `council-inject` (keyword-triggered Council Mode procedure, injected once per session at the first trigger).
- **Model failover**: `foreground-fallback` — removes the fallback manager and retry hook entirely. `fallback.enabled: false` disables intervention too, but on v2 it keeps the retry bookkeeping registered so a live per-session enable can switch it back on.
- **Tool guards**: `json-error-recovery`, `tool-loop-guard`, `search-path-guard`, `absolute-path-rescue`, `apply-patch` (v1 `apply_patch`, v2 `patch`) — each stops intercepting tool calls entirely, so malformed output, repeated identical calls, and invalid or guessed paths surface raw to the model.
- **Deepwork**: `deepwork-goal` turns the post-compaction goal pointer off (the model then relies on the skill's resume discipline alone).
- **Update checking**: `auto-update-checker` — stops the startup update check, notification, and automatic installation. `autoUpdate: false` has the same effect for the feature; this entry is the per-hook form and also stays effective if the feature switch is re-enabled.
- **Telemetry / headers**: `cache-monitor` (prompt-cache bust watchdog; warnings stop), `chat-headers` (Copilot `x-initiator` header on both the v1 `chat.headers` hook and the v2 `model.request` bridge).

Guards such as `tool-loop-guard`, `search-path-guard`, `absolute-path-rescue`, and `apply-patch` protect against model-side loops, bad paths, and malformed patches. Disable them only when you want raw upstream behavior.

Notes:

- Injection surfaces that have dedicated switches are not listed here: the interview subsystem (`interview.enabled`), the TUI surface (`tui`, `sidebar`), and image routing (`image_routing`). `autoUpdate: false` and `disabled_hooks: ["auto-update-checker"]` both stop the update feature; use whichever granularity you need.
- Invalid entries are stripped with a warning when the config loads; a value consisting only of unknown names is treated as unset, so a lower config layer's list still applies.

### Slash Commands

Disable built-in commands via `disabled_commands`:

```json
{ "disabled_commands": ["interview", "deepwork"] }
```

Available commands: `interview`, `implement`, `deepwork`, `reflect`, `preset`, `killall`, `subagent`. Disabled commands are neither registered nor intercepted at execution time, so a user-defined command with the same name is left untouched. Listing `reflect` in `disabled_skills` also disables the `/reflect` command. `/killall` and `/subagent` are TUI commands; `tui: false` removes the whole TUI surface, while `disabled_commands` removes only the named command.

Invalid entries are stripped with a warning when the config loads; a value consisting only of unknown names is treated as unset, so a lower config layer's list still applies — it is not an explicit empty override.

### Multiplexer

The multiplexer hosts child agent sessions in terminal panes. See [Multiplexer Integration](multiplexer-integration.md) for backend setup, layout configuration, and troubleshooting. On OpenCode v2 hosts, panes work when the TUI uses the shared background service or an explicit `--server` URL; `--standalone` hosts cannot host panes (`multiplexer.type` is ignored there with one diagnostic per process).

### Desktop Companion App

The desktop companion app provides a visual status overlay showing running and active agents. For quick installation instructions, binary paths, config defaults, and release information, see the full **[Desktop Companion Guide](companion.md)**.

Once installed, configure it in your `oh-my-opencode-slim` settings:

```jsonc
{
  "companion": {
    "enabled": true,
    "position": "bottom-right", // optional: bottom-right, bottom-left, top-right, top-left
    "size": "medium"            // optional: small, medium, large
  }
}
```
