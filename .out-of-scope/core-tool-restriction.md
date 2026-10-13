# Restricting or Wrapping OpenCode Core Tools

This project does not globally wrap, hide, or disable OpenCode core tools, such as preventing agents from disabling autocontinue. Per-agent deny rules (e.g. the council agent's synthesis-only permissions) remain supported.

## Why this is out of scope

Feature request #483 (and its follow-up discussion #757) proposed restricting the agent's ability to disable `auto_continue`, or removing `auto_continue` from the bundled toolset so it could only be invoked as a user command. A related request, #509, asked for configuring tool priority or disabling specific core tools such as `grep` and `read`.

Discussion #757 was closed during triage on 2026-10-11 as out of scope for this plugin. Autocontinue is an OpenCode-core feature with no references anywhere in this plugin's source, so there is nothing here to configure or hide — if the ask moves forward, it belongs upstream on opencode-ai/opencode as a host-level setting, or as the optional mode @ReqX suggested during the discussion rather than removing the tool. (That close also acknowledges the thread's disagreement: @ReqX had argued the restriction is strongly opinionated and that being trapped in a loop is the bigger annoyance.) The plugin-side reasoning behind the decision:

- `auto_continue` is a native OpenCode core tool, not a plugin-defined tool. The plugin does not wrap, hide, or globally disable upstream tools, and cannot reorder tool priority — that scope (removing or wrapping host tools globally, or changing `auto_continue` behavior) belongs upstream. Restricting individual tools per agent is already supported: the `council` agent ships deny-all synthesis-only permissions (`read`/`grep` deny via `createSynthesisOnlyPermission()`), and per-agent deny rules (e.g. `grep: "deny"` on a specific agent) are the supported workaround.
- Stripping or restricting an agent's control over continuation tools risks trapping sessions in runaway, uncontrollable execution loops—a known point of failure in earlier orchestration experiments.
- Plugin policy is to let OpenCode core tools retain their native behavior and permissions, allowing the user to configure tool permissions via OpenCode's native permission configuration (`opencode.json`) rather than hardcoding opinions in the plugin. Per-agent deny rules (e.g. `grep: "deny"` on a specific agent) are the supported workaround for restricting individual tools.

## Prior requests

- #483 — "[Feat]: the agent should not be able to disable autocontinue" (closed; moved to discussion)
- Discussion #757 — "[Feat]: the agent should not be able to disable autocontinue" (closed as resolved 2026-10-11; out of scope for this plugin — host-level OpenCode feature, venue is opencode-ai/opencode)
- #509 — "[Feature]: Allow configuring tool priority or disabling specific tools (e.g., grep, read) to favor codegraph" (closed; the plugin cannot globally disable core tools or reorder tool priority — per-agent deny rules are the workaround). alvinunreal on that thread: *"Mine uses codegraph and grep when it needs to, works fine without any changes"*.
