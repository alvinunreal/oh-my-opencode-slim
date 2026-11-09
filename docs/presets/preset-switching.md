# Preset Switching

Use `/preset` to choose a session's subagent inference configuration or change
the default for future sessions.

## Controls

`/preset` opens a **three-level preset manager** in the TUI — pure TUI, like
the built-in `/models`, so it triggers no LLM turn.

| Level | What you do |
|-------|-------------|
| 1. Preset list | Apply / Edit / Delete a preset, start a bound session (v2), or create a preset |
| 2. Agent arrangement | Choose a Base preset, add / remove / edit local agents, then Save (or Save & Apply) |
| 3. Edit agent | Pick model → variant (thinking strength) → temperature → options (JSON) |

> `/preset` is a TUI-only slash command (like `/models`). On v1 hosts invoke
> it via autocomplete selection or a keybind — typing `/preset` + Enter does
> not open the manager (same design as `/models`), and it takes no name
> argument.
>
> On v2 hosts, typing `/preset` + Enter opens the same three-level manager,
> and the sidebar's preset row opens it on click. Applying a preset from the
> manager asks you to choose **Current session** or **Global default**.
> `/preset <name>` is the fast path for the first choice: it binds the preset
> to the session on screen, so it is equivalent to Manager → Current session
> without the dialogs. It never writes the global default.
>
> Non-TUI clients (OpenChamber, SDK consumers, ACP hosts) get a server-side
> `/preset <name>` command with the same meaning. No argument lists the
> available presets; a name binds the invoking session; an unknown name reports
> the valid options. It is apply-only — create, edit and delete stay in the TUI
> manager — and the client reports the result without a model turn, so no turn
> or context is spent and the binding applies to that session's next
> delegation. Listing `preset` in `disabled_commands` removes both the TUI
> entry and the server command.

## Start a session from a preset

On v2, open `/preset`, select a preset, and choose **New session**. It opens
an empty session in the current directory and workspace, with the selected
team already bound. Creation sends no message and leaves the global default
unchanged.

The binding covers subagent inference settings: models, variants, temperature,
provider options and fallback chains. The main-agent model uses OpenCode's
native selection; prompts, tools, skills and MCPs follow normal host configuration.

> **`backgroundJobs.mode: "off"` disables session bindings.** Session bindings
> remain available in the V2 `native` default; `off` leaves
> native delegation untouched: no session `/preset` command, RPC, or child
> snapshot. Children use the registered agent configuration, and the `preset`
> global default still selects those settings at startup.

If creation succeeds but binding fails, the error includes the new session ID.
Open that session and use **Apply preset → Current session**. A host shutdown
between creation and binding can also leave an unbound empty session.

## Reading the current team

On v2, the sidebar's team models and variants come from the displayed
session's saved preset. Switching sessions shows each session's own team.
Inherited models retain their saved variant, and each agent appears once
under its display name. In root sessions, the main-agent model row follows
the native model picker.

The sidebar's single `Preset` row shows the preset the displayed session
uses. When the session is bound to a different preset than the global
default, the default follows in muted text: `Preset cheap · default
balanced`. Unbound sessions, and sessions whose binding is still loading,
show the default alone.

The `/preset` list marks the current session's bound preset separately from
the global default. A preset can carry both markers. The bound name remains
visible even if its preset definition has since been removed.

## Scope and when changes take effect

On v2, a root work session captures its subagent inference configuration before
its first prompt is admitted. Its new native subagents inherit their
direct parent's snapshot, including model variants, inference options and fallback
chains. Changing the default does not change that snapshot, even for children
the existing session creates later.

| Action | What is saved | Who uses the change |
|--------|---------------|---------------------|
| Manager → Current session | The session's inference snapshot in OpenCode's plugin storage | New children and explicit same-agent continuations of bound children |
| `/preset <name>` (TUI fast path or server-side) | The same session snapshot, for the session the command runs in | New children and explicit same-agent continuations of bound children |
| Manager → New session | The selected inference snapshot on a new empty session | Subagents delegated from the new session |
| Manager → Global default | The selected preset in the user configuration | Sessions that first bind after the configuration refresh, subject to project and environment overrides |
| Edit the user configuration's `preset` | The global default | Future bindings that inherit the global default |
| Edit a project configuration's `preset` | That project's default | Future bindings in that project |
| Edit a preset definition or its `extends` base; manager → Save | The shared preset definition | Future bindings, or a session that explicitly reapplies the preset |

**Manual configuration edits do not update existing session snapshots.**
This includes edits to the same preset name. To use its updated definition in
an existing work session, open `/preset`, select that preset, and apply it to
**Current session** — or run `/preset <name>` in that session. Reloading
OpenCode does not reset a saved binding.

**Save & Apply** asks for the application scope before saving the definition
and applying it. A session-only application does not change the selected
configuration default. A project override still takes precedence over the
global default; the existing writer reports conflicting overrides rather than
pretending a global selection changed that project's effective default.

### Two concurrent work sessions

1. Session A starts with `cheap` and captures its team configuration.
2. You change the global default to `powerful`, then start session B.
3. A's new subagents still use its `cheap` snapshot; B's use `powerful`.
4. Changing the global default back to `cheap` does not change B.
5. Applying `powerful` to A's **Current session** changes A's future
   delegations. An existing child keeps its current settings until A explicitly
   continues that bound child with the same agent.

### Continuing an existing child

The next same-agent continuation adopts the direct parent's changed team:
model, variant, temperature, provider options and fallback chains. The child
keeps its session ID and history. Apply alone sends no prompt and does not
broadcast changes to children. Prompts, tools, permissions, skills and MCPs
keep their existing configuration.

An explicit model or variant supplied to the continuation takes precedence
over the preset default; an explicit model selection disables that child's
preset fallback chain. After a team is successfully adopted, further
continuations of that team keep the child's current manual or fallback model
selection.

New subagents launched by the child during that continuation also use the
adopted team. A preset separately applied inside that child takes precedence
for its future delegations; the parent's continuation changes only the child's
execution settings.

Continuation is **best-effort**. OpenCode authorizes and selects the model,
then Slim installs options and fallback at the awaited native progress step,
before the prompt. The team snapshot is saved after native execute succeeds;
a background `running` return counts as successful submission, not completed
work. A failure reports an error without rolling back native model or history
changes. After interruption or restart, repeat the operation if needed; the
plugin does not retain a pending target, and repeating a failed call may send
the prompt again.

### Persistence and failures

Snapshots contain resolved inference settings, not a live reference to a
preset name. They survive plugin and host restarts through OpenCode's
`ctx.storage`; no separate snapshot directory or database is created. The
plugin binds a new native child from a bound parent before its first prompt.
A failed binding prevents that invocation from submitting the prompt.

Sessions created before this feature have no historical snapshot to recover.
A root's first binding uses the then-current effective default. A child with
no saved binding, including an older child or one created by a host command,
keeps the previous behavior rather than being assigned its parent's current
preset. These unbound children and their delegations are outside session-preset
isolation; the manager reports no binding. Current-session application requires
a root or an already-bound child.

If the host stops after creating a child but before its binding is saved, the
plugin cannot reconstruct that child's original team after restart. It treats
that child as unbound; it does not claim to recover its prior configuration.
Unreadable or corrupt stored records are errors, not unbound-session fallbacks.

Session isolation uses the host's plugin storage and session identity APIs
(`ctx.storage`, `ctx.session.get`). Both are required members of the v2 plugin
contract, so every v2 host can apply a session-only preset; the runtime probe
remains as a guard, and a host that genuinely omitted them fails the apply with
explicit errors instead of silently writing the default.

User and project configuration files are still watched, including `.json`
and `.jsonc` candidates created after startup. A successful configuration
write requests refresh; it does not acknowledge the separate server-side
watcher's completion. Invalid configuration preserves the last-known-good
defaults. Fix the configuration before retrying the refresh or applying it
to a session.

On v1, `/preset` retains its configuration-writing behavior. **Reload
OpenCode** after applying a preset.

## Editing inherited presets

At Level 2, select **Base preset** to choose one parent preset or **(none)**.
The manager prevents self-references and inheritance cycles. Inherited agents
are shown for context but are read-only. To change one, use **+ Add agent** to
create a local override, then edit it at Level 3.

Saving an inherited preset preserves its `extends` value and writes only its
local agent overrides; it does not flatten or copy inherited agents into the
child. Editing the base preset updates derived definitions for future v2
session bindings or an explicit session reapplication; it does not rewrite
saved inference snapshots. On v1, reload to apply the edited definition.
A base preset with dependents cannot be deleted until those presets choose
another base or clear inheritance.

### Level 3 — model and variant selection

The model picker lists every model from all connected providers (fetched from
the server's provider registry). If the chosen model exposes variants (e.g.
`thinking`, `high`, `low`), a variant picker follows — this is the "thinking
strength" selector. Temperature is a numeric prompt (0–2 or blank). Options is
a raw JSON prompt for provider-specific settings (e.g.
`{"thinking":{"type":"enabled","budgetTokens":10000}}`).

## Example Configuration

```jsonc
{
  "presets": {
    "cheap": {
      "explorer": { "model": "openai/gpt-6-luna" },
      "oracle": { "model": "anthropic/claude-sonnet-4-6" }
    },
    "powerful": {
      "oracle": { "model": "anthropic/claude-opus-4-6" }
    },
    "thinking": {
      "oracle": {
        "model": "anthropic/claude-sonnet-4-6",
        "variant": "thinking",
        "options": { "thinking": { "type": "enabled", "budgetTokens": 10000 } }
      }
    }
  }
}
```

## Supported Fields

V2 session selection applies **only subagent inference settings**. It does
not change the main session's model selection or hot-reload its agent
registry. The default configuration and the current session's binding are
different states; a default label is not evidence that a running child has
changed models.

| Field | Description |
|-------|-------------|
| `model` | Model ID in `provider/model` format, or an ordered fallback chain. The selected model and its fallback chain come from the same inherited snapshot |
| `temperature` | Inference temperature (0-2) |
| `variant` | Model variant (e.g. `"thinking"`) |
| `options` | Provider-specific options (e.g. thinking budget) |

The `extends` field is resolved when the preset is applied. Presets support
one parent only; multi-parent inheritance is not supported.

Session selection does not apply `prompt`, `tools`, `permission`, `skills`,
`mcps`, `description`, `displayName`, or marketplace activation. Those remain
subject to the normal host configuration and agent-registry lifecycle.
Choose the main session's model with OpenCode's native model controls.

## Startup Preset vs Runtime Switching

The configuration selects the default for new work. A session binding selects
that work's subagent inference settings. Both persist across restarts, but
changing one does not overwrite the other. Use **Global default** to change
future work and **Current session** to change future delegations in work that
is already bound.

> See [Configuration](../configuration.md) for the full preset option reference.
