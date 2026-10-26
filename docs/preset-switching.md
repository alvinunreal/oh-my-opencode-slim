# Preset Switching

Use `/preset` to choose a session's subagent inference configuration or change
the default for future sessions.

> **Storage compatibility:** New bindings and explicit updates write v2 records,
> which the previous v1-only reader rejects. See
> [Testing and downgrading](#testing-and-downgrading) before trying a prerelease
> with your existing sessions.

## Controls

`/preset` opens a **three-level preset manager** in the TUI — pure TUI, like
the built-in `/models`, so it triggers no LLM turn.

| Level | What you do |
|-------|-------------|
| 1. Preset list | Apply / Edit / Delete an existing preset, or create a new one |
| 2. Agent arrangement | Choose a Base preset, add / remove / edit local agents, then Save (or Save & Apply) |
| 3. Edit agent | Pick model → variant (thinking strength) → temperature → options (JSON) |

> `/preset` is a TUI-only slash command (like `/models`). On v1 hosts invoke
> it via autocomplete selection or a keybind — typing `/preset` + Enter does
> not open the manager (same design as `/models`), and it takes no name
> argument.
>
> On v2 hosts, typing `/preset` + Enter opens the same three-level manager,
> and the sidebar's preset row opens it on click. Applying a preset asks you
> to choose **Current session** or **Global default**. `/preset <name>` keeps
> its configuration-writing fast path: it changes the global default, not
> the current session's binding.

The manager shows the effective **Default** and the current **Session** binding
separately. Inspect the session's saved team to see its models and variants;
editing a preset with the same name does not change that saved view. Project
and environment overrides can make the effective default differ from the
user configuration's selection.

The v2 sidebar's **Current model** is the committed host model. In a root
orchestrator session, **Next prompt** shows a different picker selection
immediately, before submission. **Team · next delegation** remains the saved
team projection.

## Scope and when changes take effect

On v2, a root work session captures its subagent inference configuration before
its first managed prompt is admitted. Its new native subagents inherit their
direct parent's snapshot, including model variants, inference options and fallback
chains. Changing the default does not change that snapshot, even for children
the existing session creates later.

| Action | What is saved | Who uses the change |
|--------|---------------|---------------------|
| Manager → Current session | The session's inference snapshot in OpenCode's plugin storage | New and explicitly resumed delegations from that session |
| Manager → New empty session with this preset | A new empty session and its initial binding | Delegations from its first turn onward; the configuration default is unchanged |
| Manager → Global default, or `/preset <name>` | The selected preset in the user configuration | Sessions that first bind after the configuration refresh, subject to project and environment overrides |
| Edit the user configuration's `preset` | The global default | Future bindings that inherit the global default |
| Edit a project configuration's `preset` | That project's default | Future bindings in that project |
| Edit a preset definition or its `extends` base; manager → Save | The shared preset definition | Future bindings, or a session that explicitly reapplies the preset |

**Manual configuration edits do not update existing session snapshots.**
This includes edits to the same preset name. To use its updated definition in
an existing work session, open `/preset`, select that preset, and apply it to
**Current session**. Reloading OpenCode does not reset a saved binding.

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
   delegations, including explicit continuations of existing children.

Apply saves the team target; it does not immediately rewrite existing children.
A subsequent native `subagent` continuation keeps the child's session ID and
history, and adopts the team captured from its direct parent. The child then
uses that team for its own delegations. Parent Apply alone leaves the child's
execution and team unchanged. A grandchild inherits its direct parent's team,
not a later selection on the root.

An explicit model or variant supplied to a delegation takes precedence over
the preset default. An explicit model selection disables that execution's
preset fallback chain. A later team change can select a new preset model;
an ordinary continuation with unchanged settings preserves the current model
and fallback state.

For a managed same-agent continuation, the native tool authorizes the delegation
first. Slim then validates any explicit model or variant and installs the
inference configuration before the tool submits its prompt. A rejected
authorization or unavailable explicit selection leaves the child's configuration
unchanged. Unbound historical children retain native model validation.

Concurrent continuations of a running child can reach this step in approval
order, rather than invocation order. Each configuration change uses the team
captured by that invocation. Avoid changing the child's agent manually while a
continuation is waiting: the host does not provide an atomic boundary between
that external change and the continuation.

### Start a session with a preset

From the home screen, open the preset manager through the command palette and
choose **New empty session with this preset**. Select an initial agent and confirm the
native model and directory. The plugin creates an empty session with the chosen
team already bound. It sends no message and makes no model request.

After creation, enter the session or stay on the home screen. The original home
screen's next ordinary submission does not use this new session. To move an
existing draft, use OpenCode's Stash and restore actions or copy it yourself;
the plugin does not transfer it. Prefer the command palette when preserving a
draft, since executing a slash command clears the home input.

The new-session action uses the primary agent you select explicitly; it cannot
read the home screen's current agent selection. Check OpenCode's native agent
and model controls after entering, particularly when starting with `--agent`.

If creation or binding times out, retry the same operation. It reuses the same
session ID rather than creating another session. An unfinished initialization
blocks messages until binding succeeds. A failed navigation does not undo a
successful creation; open the recorded session from the session list.

Creation retries must use the original directory and workspace, even when two
workspaces share a directory. Older prerelease creation records that lack this
workspace information cannot be retried by this version; completed sessions
remain usable. The workspace check preserves the original creation target. It
cannot detect a later move to another workspace at the same directory, because
the host's public session lookup does not expose that identity.

To stop retrying that creation, choose **Forget local retry record** and confirm.
This releases the window for a new creation, including in another workspace.
It leaves server state unchanged: the earlier request may still finish, so
creating again can leave two empty sessions. The original directory, session
ID and operation ID remain in the plugin log.

### Persistence and failures

Snapshots contain resolved inference settings, not a live reference to a
preset name. They survive plugin and host restarts through OpenCode's
`ctx.storage`; no separate snapshot directory or database is created. The
plugin binds a new native child from a bound parent before its first prompt.
A failed binding prevents that invocation from submitting the prompt.

Changing an existing child's execution is a persisted transition. While it is
in progress, new managed requests and tool calls are rejected. A provider
request or tool invocation that has already passed its own admission check can
finish. The next request or tool invocation is checked again, even within the
same host run, and can use the new configuration once the transition completes.
This can reject a request whose context was prepared under the previous revision
but which has not yet passed model-request admission. Such a request is not sent
with mixed settings or automatically retried.

If a transition fails, retry the recorded target explicitly. A restart does not
clear the pending state, and retry does not substitute the latest default or
replay the failed prompt. Configuration may already be committed when a
continuation fails; check the saved state before sending another continuation.
Apply never silently replaces a supplied child session ID with a new session.

Retry requires the saved target's dependencies to work. Restore a missing
provider or agent configuration, or use another work session. Clearing pending
would not undo a model change that already reached the host, so there is no
discard-to-old-configuration action. If a native model change never finishes,
stop the OpenCode server executing it before restarting and retrying. This
interrupts that server's running sessions; closing a connected TUI or timing out
a request does not cancel the server's operation.
Plugin reload or unload also waits for an in-flight native model change.

### Testing and downgrading

New bindings and explicit updates use storage format v2. Existing v1 bindings
remain readable; ordinary reads and unchanged continuations do not migrate
them. Apply or an execution change writes the new format.

The previous v1-only reader rejects v2 records. Earlier prerelease builds of this
feature also reject new creation records containing workspace scope. There is
no automatic downgrade.
For a reversible trial, use separate OpenCode configuration and data directories,
or stop the host and back up its data before testing with your usual sessions.
Restoring the previous plugin reference alone does not convert records back or
undo saved native model selections. If you test with your usual data, restoring
its pre-test state requires the previous plugin and the matching data backup.

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

Session isolation requires the host's plugin storage and session identity APIs.
Reduced hosts without these APIs retain the previous execution behavior and
cannot apply a session-only preset; they do not report a persistent binding.
Managed continuations with an explicit model or variant also require the host's
model-list API. Bound empty-session creation requires its full location context.
Reduced hosts lacking these APIs reject the corresponding operation; they do
not bypass validation or infer a workspace from its directory.

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

These examples configure subagents. Presets can also configure `orchestrator`
at startup, but applying a team to Current session does not change the main
session's native model selection.

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
registry. The sidebar's team models come from the saved binding and describe
future delegations. They are not a live model reading for every existing child:
explicit overrides and fallback may select another model.

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

> See [Configuration](configuration.md) for the full preset option reference.
