# Configuration Reference

Core settings, feature switches, and configuration precedence for the current
OpenCode 2.3+ plugin. The generated
[`oh-my-opencode-slim.schema.json`](../oh-my-opencode-slim.schema.json) lists
accepted fields and types. Feature-specific settings live in the guides linked
below; they are not separate configuration systems.

## Config Files

| Location | Purpose |
|---|---|
| `<user-config>/opencode.json[c]` | Native OpenCode providers, permissions and `plugins` registration |
| `<user-config>/oh-my-opencode-slim.json[c]` | User-wide Slim agents, presets and optional features |
| `<directory>/.opencode/oh-my-opencode-slim.json[c]` | Project and ancestor overrides |

Slim looks first in `OPENCODE_CONFIG_DIR` when set, then in
`$XDG_CONFIG_HOME/opencode` (or `~/.config/opencode`). It reads the first user
file found, not both. Writes target the configured user directory. JSONC accepts
comments and trailing commas; `.jsonc` wins within a directory. Use
`{env:NAME}` for environment substitution; an unset value is empty.

Loading order is user configuration, then ancestor project configurations from
the filesystem root down to the current directory. Closer layers override
matching values, preserving unrelated settings. Objects merge; ordinary arrays
replace inherited arrays. Presets and permission objects have the rules below.
Only ancestors are inherited, not siblings. Projects under `$HOME` also inherit
`~/.opencode`, which can override matching user-wide settings.

**Trust every inherited directory.** Project configurations and prompt files can
change agents, permissions and executable ACP commands. Set
`OPENCODE_DISABLE_PROJECT_CONFIG=true` or `1` to disable project configuration,
prompt and local-skill discovery while retaining user configuration.

Configuration writes preserve symlinks and update their resolved targets.
Dangling or unresolvable links make the write fail. Backups are written beside
the configuration path. Marketplace project-scoped writes target the current
project, never an ancestor.

| Environment variable | Effect |
|---|---|
| `OPENCODE_CONFIG_DIR` | Preferred user configuration directory |
| `XDG_CONFIG_HOME` | Base of the default user configuration directory |
| `OH_MY_OPENCODE_SLIM_PRESET` | Override the configured preset selection |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | Skip project configuration, prompts and local-skill discovery |
| `OH_MY_OPENCODE_SLIM_DISABLE` | `1`, `true`, `yes` or `on` skips all Slim setup; OpenCode still loads the package |

Run `oh-my-opencode-slim doctor` from the project to inspect discovered layers
and warnings. Unreadable or invalid layers are normally skipped without losing
other layers. Explicit unsupported host settings instead refuse startup with
the source path before merging; a nearer override cannot hide them. See
[Upgrading](installation.md#upgrading).

Configuration snapshots revalidate file identity and referenced environment
values. See [Runtime Efficiency](runtime-efficiency.md) for cold-loading and
refresh costs.

## Minimal Setup

Merge this into an existing Council/Observer configuration. Keep your
vision-capable Observer model and `council.presets`; this example changes feature
selection, not your model lineup:

```jsonc
{
  "backgroundJobs": { "mode": "off" },
  "tui": false,
  "autoUpdate": false,
  "liveConfigRefresh": false,
  "interview": { "enabled": false },
  "marketplace": { "enabled": false },
  "companion": { "enabled": false },
  "disabled_agents": ["explorer", "oracle", "designer", "fixer"],
  "agents": {
    "orchestrator": { "skills": [] },
    "observer": { "skills": [] },
    "council": { "skills": [] },
    "councillor": { "skills": [] }
  },
  "disabled_mcps": ["context7", "gh_grep"],
  "disabled_commands": ["deepwork", "reflect"],
  "disabled_hooks": [
    "phase-reminder", "foreground-fallback", "deepwork-goal", "chat-headers",
    "cache-monitor", "tool-loop-guard", "search-path-guard",
    "absolute-path-rescue", "apply-patch"
  ],
  "disabled_tools": ["webfetch", "ast_grep_search", "ast_grep_replace", "acp_run"]
}
```

Native subagents, completion delivery, Council seat assembly and Observer remain
available. Disabled implementations are not constructed. Previously evaluated
ESM modules cannot be unloaded; restart the host to measure cold-start savings.

### Implied switches

| Switch | Additional disables normally unnecessary |
|---|---|
| `tui: false` | `sidebar: false`, `/killall`, `/subagent`, TUI `/preset`, pane settings |
| `interview.enabled: false` | `/interview`, `/implement`, `interview_submit_state` |
| `marketplace.enabled: false` | `marketplace_inspect`, `marketplace_manage` |
| `backgroundJobs.mode: "off"` | Four Slim task tools; session routing unless explicitly enabled |
| Disabled `foreground-fallback` hook | `fallback.enabled: false` |
| `disabled_skills: ["reflect"]` | Disabled `/reflect` command |

These implications are one-way. Keep a granular disable if its feature remains
active, or as an explicit veto against a nearer layer enabling that feature.

## Full Option Reference

### Core and feature switches

| Option | Default | Purpose |
|---|---|---|
| `preset` | Unset | Select startup agent configuration from `presets` |
| `presets` | Unset | Named agent configurations; optional single-parent `extends` |
| `agents` | Unset | Overrides shared across presets; unknown safe names define custom specialists |
| `setDefaultAgent` | `true` | Set the native default to Orchestrator when unset or pointing at a subagent |
| `backgroundJobs.mode` | `"native"` | `native` registers Slim task controls; `off` registers none. Both use native execution |
| `sessionPresetRouting` | Follows task mode | Independently enable persisted per-session inference bindings; `native` defaults on, `off` defaults off |
| `replaceBuiltinSubagents` | `true` | Hide undeclared native `general`/`explore`; `false` keeps their host configuration |
| `tui` | `true` | Enable all Slim TUI surfaces and server-side sidebar recording |
| `sidebar` | `true` | Sidebar and its state only; other TUI features remain enabled |
| `compactSidebar` | `true` | Compact rather than expanded sidebar layout |
| `sidebarShowHiddenAgents` | `false` | Show Council internals as sidebar rows; registration and native agent visibility are unchanged |
| `liveConfigRefresh` | `true` | Watch configuration candidates for inference-profile refresh; no watcher is created without a consumer |
| `stripOrchestratorModel` | `false` | Omit the configured Orchestrator model/variant so native session selection can win; an explicitly selected preset model is retained |
| `autoUpdate` | `true` | Enable Slim TUI update checks and notices; host package management is separate |
| `questionTimeoutMs` | Unset/`0` | Opt-in automatic answer for eligible unanswered questions; enabled range 60,000–2,147,483,647 ms |
| `image_routing` | Observer-dependent | `auto` relays supported attachments when native vision is unavailable; `direct` leaves them inline |
| `interview.enabled` | `true` | Enable the Interview subsystem |
| `marketplace.enabled` | `true` | Enable Marketplace operations and activation |
| `companion.enabled` | `false` | Enable the optional desktop Companion |
| `multiplexer.type` | `"none"` | Select an optional child-pane backend |
| `multiplexer.agents` | `["*"]` | Filter which subagents open panes, not which can run; see [Multiplexer Configuration](multiplexer-integration.md#configuration) |

`questionTimeoutMs` requires an attached Slim TUI with `tui` enabled. It answers
questions that permit custom responses, never permissions or closed-choice
requests. Restart the TUI after changing it; an already-open question is not
re-armed on restart.

Observer is disabled by default. Removing it from `disabled_agents` enables the
agent; configure a model that accepts images. When `image_routing` is omitted,
it resolves to `auto` with Observer enabled and `direct` otherwise. Explicit
`auto` requires Observer. Vision-capable request models keep their attachments
inline; `direct` leaves Observer available for manual delegation. Supported
pasted images saved under `.opencode/images/<session>/` remain until you remove
them. PDFs, remote-only images and tool-produced media are not automatically
saved by this relay.

### Disable lists

| Option | Effect |
|---|---|
| `disabled_agents` | Remove named specialists; default `["observer"]`. Orchestrator and bare Councillor are protected |
| `disabled_tools` | Skip Slim tool registration and implementation loading; native tools are unaffected |
| `disabled_hooks` | Stop the named interception/injection/observation hooks; see [Hooks](#hooks) |
| `disabled_commands` | Remove only the named Slim command; see [Slash Commands](#slash-commands) |
| `disabled_mcps` | Do not register the selected built-in MCP servers |
| `disabled_skills` | Do not register/grant selected bundled skills, even if a preset requests them |

Disabling Slim `webfetch` preserves the native tool. Disabling `acp_run` also
removes wrapper agents that cannot execute. Council is absent when unconfigured;
explicitly disabling `council` removes its seat chain too. Individual dynamic
`councillor-<seat>` agents can be disabled by exact name.

## Agent Settings and Presets

The same agent fields work under root `agents` and a preset. Put a value inside
presets when it should vary by lineup; root `agents` overrides every preset.

| Field | Meaning |
|---|---|
| `model` | Scalar `provider/model`, or a non-empty ordered chain of IDs / `{ id, variant }` entries |
| `variant` | Provider-specific variant; overrides the first chain entry's variant |
| `temperature` | Number 0–2; omission retains the host default |
| `options` | Provider-specific inference options |
| `inheritModelFrom` | `session` or `orchestrator`; follow the live model instead of a configured primary |
| `prompt` | Nonempty inline replacement; wins over a prompt file |
| `orchestratorPrompt` | Additional routing guidance for a non-Orchestrator specialist |
| `description` | Short description of when to delegate, shown in the native `subagent` roster |
| `displayName` | Unique user-facing alias, not a new canonical agent name |
| `color` | Six-digit hex or `primary`, `secondary`, `accent`, `success`, `warning`, `error`, `info` |
| `skills`, `skills_add`, `skills_remove`, `skills_include_local` | Native skill grants and inherited-list adjustments; see [Skills](skills.md#skills-assignment) |
| `mcps` | Plugin MCP selection (`*`, `!name`, explicit list); not a native agent property |
| `permission` | Ordered permission map or scalar action; see [Agent Permissions](#agent-permissions) |

### Preset inheritance

```jsonc
{
  "preset": "review",
  "presets": {
    "base": {
      "oracle": { "model": "provider/model-a" },
      "fixer": { "model": "provider/model-b" }
    },
    "review": {
      "extends": "base",
      "oracle": { "model": "provider/model-c" }
    }
  }
}
```

One parent is supported. Overlapping agent fields follow:

**ancestor preset < child preset < root `agents` < native host configuration**.

Inheritance cycles and missing parents are errors. New preset names use letters,
digits, `-` and `_`; reserved JavaScript properties and `__omo_*` are rejected.
Existing names outside that syntax remain selectable.

### Runtime Preset Switching

The configured `preset` selects startup agent settings. With session routing
enabled, `/preset <name>` applies resolved subagent inference settings to the
current session, not the global default. `/preset <name>
--force-orchestrator` (`-f`) also switches the live root session's model to
the preset's `orchestrator` entry (root sessions only, never the global
default; a native model pick overrides it — see ADR-005). The TUI manager
also offers **Global
default**, which writes configuration. Named session bindings survive restarts
and remain pinned until reapplied; default-bound roots refresh on admission.
See [Preset Switching](presets/preset-switching.md) for scope and failure rules.

`sessionPresetRouting: false` skips the binding store, session RPC and native
executor wrapper without disabling static presets or global editing. With
routing off, children use registered agent settings. `disabled_commands:
["preset"]` removes command/RPC/editor entry points but is not the internal
routing switch. Live refresh only updates inference fields, not prompts,
permissions, skills, MCPs or registration; those require a new host generation.

### Independent agent model inheritance

- A scalar `model` wins over `inheritModelFrom` in the same effective override.
- Inheritance without a model clears a lower-layer model, including a host
  model. Both sources follow the live session/Orchestrator selection.
- An array plus inheritance follows the live model while retaining the array as
  its fallback chain. The followed model is not retried as a chain candidate.
- An inline chain-head variant belongs to that model and is cleared during
  inheritance; set an agent-level variant when it should apply regardless.
- Without either field, normal precedence applies; unconfigured Fixer retains
  its Explorer-model default.
- Do not put array + `inheritModelFrom: "session"` on Orchestrator itself: there
  is no separate model to follow, and it would clear its native selection.

Independent specialists move from their primary only after a confirmed parent
fallback abandons that provider. Request/content-policy failures and manual
selections do not cause that move. Each child otherwise uses its own chain;
see [Model fallback](#model-fallback).

### Agent Display Names

Aliases are normalized by trimming whitespace and an optional `@`. They must be
unique and cannot collide with canonical agent names. Mentions in the final
Orchestrator prompt and custom routing snippets use the configured display name;
TUI history, models and click targets stay keyed by canonical identity. Aliases
and configured colors are frozen until reload. Councillor color overrides
Council color for seats.

On OpenCode v2, the sidebar uses the visible agent's explicit `#RRGGBB` color
or the host's categorical palette in its default TUI design. An agent with
`displayName` uses the color of that visible host entry. Use a hex value to
set an explicit color in both places. Explicit hex colors also survive hidden
rows and configured rows missing from the live roster. V2 does not accept agent
color tokens such as `info` or `primary`. The v2 plugin API does not expose the
legacy design setting (`experimental.new-designs: false`), so automatic shades
may differ from native colors in that mode.

## Prompt Overriding

Create replacement or append files under
`<user-config>/oh-my-opencode-slim/` or
`<directory>/.opencode/oh-my-opencode-slim/`:

| File | Effect |
|---|---|
| `<agent>.md` | Default replacement when no inline `prompt` exists |
| `<agent>_append.md` | Append after whichever base prompt wins |

### Prompt Lookup Precedence

Replacement and append files are resolved **independently**:

1. Current project's `<preset>/<agent>.md`, then `<agent>.md`.
2. Repeat that order in each ancestor, nearest first.
3. Preset files in the user search directories, in [config lookup order](#config-files).
4. Root prompt files in the same user search order.

The corresponding `_append.md` uses the same search. A nearer root file beats a
farther preset-specific file. Only the first file of each kind is used; ancestor
append files are not concatenated. A preset without an inline prompt can share
a root prompt file across lineups. Project discovery obeys the trust/disable
rules in [Config Files](#config-files).

### Prompt Composition Rules

The base is **inline `prompt` > resolved file > agent default**. When inline and
file prompts coexist, Slim warns that inline wins. Append text follows that
base, separated by two newlines. File and append inputs can come from different
locations. User-authored content is not shortened by stock prompt changes.

### Host Vocabulary in Custom Prompts

Use native `subagent`, `agent` and `sessionID` names in every supplied prompt:
inline strings, files, append files, custom/ACP routing and Council seat
guidance. Slim does not rewrite delegation vocabulary. Display-name substitution
is separate: it rewrites `@<internalName>` mentions in the final Orchestrator
prompt and routing snippets.

Put role-specific delegation criteria in the agent's `description`. OpenCode
includes it in the native `subagent` roster. Slim separately identifies hidden
Council seats, which are not in that roster.

### Custom Routing Guidance (`orchestratorPrompt`)

Non-Orchestrator agents can add routing guidance under a project-specific
section of the Orchestrator prompt. Use this for cross-agent policy rather than
repeating `description`. It is omitted for disabled agents. Start the guidance
with `@<agent-name>`; setting it on Orchestrator is rejected.

## Custom Agents

Unknown safe names under `agents` create specialist agents, not new primaries:

```jsonc
{
  "agents": {
    "reviewer": {
      "model": "provider/model",
      "prompt": "Review the named code; report evidence and risks, do not edit.",
      "description": "Use for focused code-risk reviews, not routine edits.",
      "permission": { "*": "deny", "read": "allow", "glob": "allow", "grep": "allow" }
    }
  }
}
```

Custom agents need a model and cannot collide with built-in, ACP, display or
reserved Council-seat identities. Missing models are reported and skipped.
`librarian` remains a reserved alias for Explorer: explicit Explorer fields win;
use `explorer` in new configuration. Legacy generated MCP-pair repairs are
reported by `doctor`; customized permissions are not inferred or rewritten.

## Agent Permissions

`permission` accepts `"ask"`, `"allow"`, `"deny"`, or an object mapping actions
to those values or pattern maps. On V2, Slim maps `bash` to native `shell` and
`task` to native `subagent`; `execute` is the separate Code Mode dispatcher.
Allowing it does not grant its inner tools. Unknown/MCP action keys pass through.

**Key order is precedence: last matching rule wins.** Put the wildcard base
first and specific exceptions after it:

```jsonc
"permission": {
  "*": "deny",
  "read": "allow",
  "glob": "allow",
  "grep": "allow",
  "bash": { "*": "ask", "git status*": "allow" },
  "task": "deny"
}
```

Permission objects preserve authored order across layer merging. Later-layer
entries follow inherited entries. Unmentioned inherited rules at least as
restrictive as the later wildcard remain after it (`deny > ask > allow`); to
lift an inherited deny, name the action explicitly. Such inherited pattern
maps retain their order, with looser entries raised to the later wildcard's
restriction. Nested maps use the same rule against their own `*`; the base's
wildcard stays its fallback. This is not a blanket permission-widening merge.

`read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `external_directory`,
`lsp` and `skill` support patterns. `todowrite`, `question`, `webfetch`,
`websearch`, `codesearch` and `doom_loop` accept scalar actions only.
Subagents deny questions by default; explicit per-agent configuration can
change that. Parent task controls, package ceilings and native policy still
apply at their own execution seams.

### Merge semantics

1. Explicit `permission` supplies the base.
2. Resolved `skills` grants own `permission.skill`; global disables still win.
3. MCP selections fill only missing `<mcp>_*` keys; explicit action entries win.
4. Native host rules and role/package capability ceilings can further restrict
   the resulting grants.

Use Skills/MCP arrays for those selections and permission rules for file,
shell, delegation and other actions. See [MCPs](mcps.md) and
[Marketplace](marketplace.md#customize-an-installed-agent) for their ceilings.

### Native Delegation Permissions

Set ordered `subagent` rules in **OpenCode's** `opencode.json[c]`. For example,
permit only `fixer` when the active agent is `orchestrator`:

```jsonc
{
  "agents": {
    "orchestrator": {
      "permissions": [
        { "action": "subagent", "resource": "*", "effect": "deny" },
        { "action": "subagent", "resource": "fixer", "effect": "allow" }
      ]
    }
  }
}
```

Use the exact registered IDs, including a configured visible alias where used.
To keep Council under a restrictive policy, allow its synthesis agent and the
configured `councillor-<seat>` IDs as well. OpenCode enforces the rules even for
hidden seats. Existing Slim `permission.task` maps still project to native rules.

## Model fallback

| Setting | Default | Effect |
|---|---|---|
| `fallback.enabled` | `true` | Enable automatic model-chain intervention |
| `fallback.maxRetries` | `3` | Host retries tolerated before advancing the chain; `0` advances immediately |
| `fallback.retryDelayMs` | `500` | Delay placed on the host retry decision after a model switch; `0` disables that delay |

This is not native provider retry configuration or a wall-clock deadline. Slim
switches the model in place, leaving the host to retry the same turn. Request
rejections and spent allowance skip the retry budget; a host-announced wait
over 30 minutes bypasses it too. Authentication 401 gets one same-model retry
per turn before failover.

The chain is scanned from its head, excluding tried/request-rejected models and
providers abandoned by this session or its parent. Provider marks expire after
30 minutes; another provider-level switch refreshes the age. Independent children
keep their own chain. When no candidate remains, one last-entry retry may run;
otherwise the host decision is left unchanged. Spent-allowance providers do not
get that sticky retry. Short retry/per-minute wording is treated as a rate
limit, not permanent allowance exhaustion; free-tier billing errors remain
permanent billing errors.

The retry budget remains spent across model switches and new user turns. A
successful `stop`, `tool-calls` or `length` step, successful execution, session
deletion, or fresh descent from the configured primary re-arms it. Returning
through a fallback restore or landing on an exhausted primary is not itself
fresh recovery. Request-rejected models stay excluded until the next external
prompt even if other recovery resets occur.

OpenCode 2.3 ends content-filter steps without a retry-hook call. Slim uses the
failed-step evidence to switch and continue that same session. The host reports
child periods; Slim adds no second completion notifier. A late model switch is
reconciled only if the observed selection is still its source or target; a
newer user-selected model is untouched.

`fallback.enabled: false` stops intervention but retains retry bookkeeping for
live/session-applied configuration. `disabled_hooks: ["foreground-fallback"]`
is the cold disable and removes the manager/hook entirely. Explicit retired
`continuationPolicy` or `initialRetryDelayMs` keys refuse startup with their
source path, even when the hook/task controls are off. Failed live refresh keeps
the last valid profiles. Remove the keys; see [Upgrading](installation.md#upgrading).

## Background Job Management

`backgroundJobs.mode` selects optional Slim controls, not child execution.
OpenCode owns spawn, continuation, steering, completion delivery and restart
recovery. See [Background Orchestration](background-orchestration.md) for
ownership and limits; [Tools](tools.md#background-task-control) owns tool usage.

## Hooks

| `disabled_hooks` value | What is stopped |
|---|---|
| `phase-reminder` | Fixed-anchor workflow reminder on the first eligible Orchestrator message |
| `council-inject` | First-keyword Council procedure injection; seat assembly remains active |
| `deepwork-goal` | Disk progress-pointer reminder, once per compaction epoch |
| `foreground-fallback` | Model-chain manager and retry intervention |
| `chat-headers` | Slim Copilot internal-initiator HTTP header |
| `cache-monitor` | Observation-only prompt-cache warnings |
| `tool-loop-guard` | Repeated-call warning/blocking |
| `search-path-guard` | Search path preflight |
| `absolute-path-rescue` | Unambiguous recovery of guessed absolute paths |
| `apply-patch` | Native patch input validation/recovery |

Guards are optional protections: disabling them exposes raw host behavior.
Dedicated subsystem switches are not hook names. Unknown hook/command names
are stripped with warnings; a list consisting only of unknown names is treated
as unset so a lower layer's list still applies.

## Slash Commands

`disabled_commands` accepts `interview`, `implement`, `deepwork`, `reflect`,
`preset`, `killall` and `subagent`. A disabled command is neither registered nor
intercepted, leaving a same-named user command alone. Disabling the `reflect`
skill also disables its command; disabling `deepwork` skill alone does not
remove its self-contained command.

`killall` and `subagent` are TUI commands. `tui: false` removes the entire Slim
TUI surface; granular command disables leave other TUI features active. See
[Skills](skills.md) for workflow commands and [Preset Switching](presets/preset-switching.md)
for `/preset`.

## Feature Guides

| Feature | Authoritative details |
|---|---|
| Council lineup, synthesis and failures | [Council](council.md) |
| Skills and inherited-list adjustments | [Skills](skills.md) |
| Built-in MCP selection | [MCPs](mcps.md) |
| ACP process configuration and inner models | [ACP Agents](acp-agents.md) |
| Interview server/dashboard and questions | [Interview](interview.md) |
| Marketplace activation and package restrictions | [Marketplace](marketplace.md) |
| TUI panes, layouts and deployment modes | [Multiplexer Integration](multiplexer-integration.md) |
| Companion appearance, binary and compositor rules | [Companion](companion.md) |
| Enhanced fetch and extraction | [Webfetch](webfetch.md) |
| Native integration and verification | [OpenCode 2 adapter](../src/v2/codemap.md) |

## Invalid or Retired Settings

The option tables above contain active settings only. `doctor` reports retired
keys and unsupported host limits with their source paths. The plugin does not
provide a reusable-session pool, job board, alias authority, idle TODO scheduler,
wall-clock watchdog or concurrency queue. No line-count/token budget replaces
those retired mechanisms. Positive old concurrency/wall-clock limits refuse
startup because the native host does not enforce them for Slim.

Some older keys are discarded with warnings, and `managed` task mode is read as
`native` by the existing loader. This is not an equivalent implementation of
the retired feature. Review all inherited layers and remove obsolete settings;
see [Upgrading](installation.md#upgrading). Other unknown or invalid fields make
their configuration layer invalid.
