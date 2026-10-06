# ACP Agents

Expose external [Agent Client Protocol](https://agentclientprotocol.com/) agents
as optional OpenCode subagents.

Use this when you want the orchestrator to delegate to software-connected tools
such as Claude Code ACP, Gemini ACP, or another ACP-compatible coding agent.

## How it works

Each `acpAgents` entry creates a lightweight wrapper subagent. The wrapper can
only call `acp_run`, which:

1. Checks the calling agent and requests launch permission.
2. If `modelMap` is configured, reads and maps the child session's current model.
3. Starts the configured ACP subprocess over stdio and sends `initialize`.
4. Creates a session with `session/new`; when following models, selects and
   confirms the mapped model with `session/set_config_option`.
5. Sends the task with `session/prompt`.
6. Collects `session/update` `agent_message_chunk` text and returns the output.

The wrapper is sandboxed from normal local tools such as `bash`, `edit`,
`task`, `webfetch`, `grep`, and `glob`.

## Configuration

Add `acpAgents` to `~/.config/opencode/oh-my-opencode-slim.jsonc` or a
project-local `.opencode/oh-my-opencode-slim.jsonc` file:

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

Restart OpenCode after changing config. Then call the generated agent directly:

```text
@claude-research investigate this bug and summarize the likely cause
```

Or let the orchestrator delegate to it when its routing prompt matches the task.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `command` | string | - | ACP executable. Put flags in `args`, not here. |
| `args` | string[] | `[]` | Arguments for the ACP command. |
| `env` | object | `{}` | Extra environment variables for the subprocess. |
| `cwd` | string | current session directory | Working directory override. ACP paths should be absolute. |
| `description` | string | generated | Role text shown to OpenCode and the orchestrator. |
| `prompt` | string | generated | Full prompt for the wrapper subagent. Usually unnecessary. |
| `orchestratorPrompt` | string | generated | Exact routing block injected into the orchestrator prompt. |
| `wrapperModel` | string | fixer default | Cheap OpenCode model used by the wrapper. |
| `modelMap` | record of strings | unset (following disabled) | Full OpenCode `provider/model` references mapped to ACP model config option values. Keys and values must be nonempty; unmatched models fail closed. |
| `permissionMode` | `ask` \| `allow` \| `reject` | `ask` | How ACP permission requests are answered. |
| `timeoutMs` | integer | `300000` | Timeout for one ACP run. |

> **`permission` vs `permissionMode`:** These are separate concepts.
> - **`permission`** (on normal custom, built-in, and preset agents) provides SDK-enforced, expressive per-tool rules with pattern support, accepting `ask`/`allow`/`deny`. See [Agent Permissions](configuration.md#agent-permissions).
> - **`permissionMode`** (ACP agents only) controls how the plugin answers the external ACP subprocess's permission requests, with simpler `ask`/`allow`/`reject` options.

## Following the child session model

Model following is **off by default**. Without `modelMap`, the bridge does not
read the OpenCode session model or send a model setter; the external agent
keeps its existing default behavior. Providing `modelMap` explicitly enables
following, including an empty map (which cannot match any model).

Example for an ACP server advertising model value `fable`, named `Fable 5.1`:

```jsonc
{
  "acpAgents": {
    "claude-code": {
      "command": "claude-agent-acp",
      "modelMap": {
        "anthropic/claude-fable-5-1": "fable"
      }
    }
  }
}
```

Then delegate with
`subagent(agent: 'claude-code', model: 'anthropic/claude-fable-5-1')`.
No `model` argument is added to `acp_run`; the bridge uses the tool context's
child `sessionID`, not an LLM-supplied model name.

After launch permission, the host client's
`session.get({ path: { id: sessionID } })` must return
`data.model: { providerID: "anthropic", id: "claude-fable-5-1" }` (the V2 shape).
Missing/invalid fields or a failed lookup stop execution before spawning ACP.
No agent defaults, message history, or alternate model fields are guessed.

This is the **child session's current selection at ACP startup**, not a
historical assistant-turn snapshot. It is read exactly once per call. A model
change during that call does not affect it; the next call reads the selection
again. Concurrent sessions keep independent snapshots without shared model
state or environment changes. This option does not change `wrapperModel`,
agent defaults, or global defaults.

The map uses exact, own keys: there are no built-in model aliases or version
guesses. If the child inherits an OpenAI default, or selects any model not in
the map, the bridge **refuses to start Claude**, rather than using its global
Opus default. Add other mappings only for values explicitly supported by your
server.

The ACP `session/new` response must advertise exactly one model select config
option (ID or category `model`), containing the mapped value in its flat or
grouped options. Before prompting, `session/set_config_option` must return that
option with exactly the requested `currentValue`. Missing/ambiguous options,
unsupported values, setter errors, or mismatched confirmations stop the run
without sending a prompt. Older protocols are not emulated with
`session/set_model`, and there is no silent default fallback.

On success, the bridge makes a best-effort call to the provided metadata sink
with `requestedModel` (OpenCode reference) and `acpModel` (confirmed ACP value).
The current V2 adapter only writes these fields to plugin logs; their presence
in the UI or returned result is not guaranteed. This observes protocol selection,
not proof of the provider's final routing; the backend output and prompt are
unchanged, even if the metadata callback throws.

## Authentication

ACP agents may advertise `authMethods` during initialization and may require
authentication before `session/new`. The bridge attempts the first advertised
auth method if the agent reports an auth-required error.

Some agents still require manual setup first. For example, run the external
agent's login command in your terminal before using the wrapper:

```bash
claude /login
```

Use the command required by your ACP server.

## Progress visibility

While the external agent works, `acp_run` streams ACP progress into the
parent TUI as live tool metadata: tool calls (`tool_call` /
`tool_call_update`) render as `▸ Title` / `✓ Title` lines, and plan updates
render as plan blocks. The tool result itself stays the agent's final
message.

## Safety notes

- The plugin asks before launching the configured subprocess.
- The wrapper agent can only call `acp_run`.
- `acp_run` can only be called by the matching wrapper agent.
- External ACP agents may still run their own tools depending on their own
  implementation and permission flow.
- Keep secrets in environment variables and pass only the minimum needed via
  `env`.

## Troubleshooting

- **Agent not available:** restart OpenCode after editing config.
- **Unknown ACP agent:** check that the `acpAgents` key name matches your
  `@agent` name.
- **Auth required:** run the ACP agent's login/auth setup command directly.
- **No output:** verify the command works as an ACP server in a terminal or ACP
  client.
