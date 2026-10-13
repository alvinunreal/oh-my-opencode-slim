# ACP Agents

Expose external [Agent Client Protocol](https://agentclientprotocol.com/) agents
as optional OpenCode subagents.

Use this when you want the orchestrator to delegate to software-connected tools
such as Claude Code ACP, Gemini ACP, or another ACP-compatible coding agent.

## How it works

Each `acpAgents` entry creates a lightweight wrapper subagent. The wrapper can
only call `acp_run`, which:

1. Checks the calling agent and requests launch permission.
2. Starts the configured ACP subprocess over stdio and sends `initialize`.
3. Creates a session with `session/new`; if `acp_run.model` was supplied, validates
   the advertised selector and confirms it with `session/set_config_option`.
4. Sends the task with `session/prompt` only after successful selection.
5. Collects `session/update` `agent_message_chunk` text and returns the output.

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
| `permissionMode` | `ask` \| `allow` \| `reject` | `ask` | How ACP permission requests are answered. |
| `timeoutMs` | integer | `300000` | Timeout for one ACP run. |

> **`permission` vs `permissionMode`:** These are separate concepts.
> - **`permission`** (on normal custom, built-in, and preset agents) provides SDK-enforced, expressive per-tool rules with pattern support, accepting `ask`/`allow`/`deny`. See [Agent Permissions](configuration.md#agent-permissions).
> - **`permissionMode`** (ACP agents only) controls how the plugin answers the external ACP subprocess's permission requests, with simpler `ask`/`allow`/`reject` options.

## Choosing the inner model per invocation

The two model selections are independent:

- **Outer wrapper:** `wrapperModel` (or native `subagent.model`) chooses the
  OpenCode model that calls the tool. Keep this fixed if desired.
- **Inner ACP model:** optional `acp_run.model` chooses the exact selector
  advertised by the external ACP server, for this invocation only. It is not
  an OpenCode `provider/model`, and no host session model is read or translated.

For a server advertising selector `fable`, the wrapper calls:

```text
acp_run(agent: "claude-code", model: "fable", prompt: "Investigate this bug")
```

`fable` has been observed on one server; selector availability depends on your
server/version. Do not guess aliases for other models. A later call can supply a
*different advertised selector* without changing the outer wrapper model.
Omitting `model` uses the external agent's default: there is no remembered
selection, process-global model state, or environment mutation. Each invocation
starts its own ACP subprocess/session, including parallel calls.

### Delegating through the wrapper

The generated orchestrator guidance passes an explicit inner choice in the
**delegation prompt**, for example:

```text
Inner ACP selector: fable
Task: Investigate this bug and summarize the likely cause.
Constraints: Read-only; do not change files.
```

The generated wrapper prompt instructs the wrapper to extract the selector into
`acp_run.model` and forward the actual task, constraints, and relevant context as
`acp_run.prompt`, not the wrapper-routing instructions. This extraction is
**LLM-mediated**: there is no new native `subagent` argument or deterministic
parser for delegation text. Native `subagent.model` still selects only the
outer wrapper and must not be used to choose the inner ACP model.

The wrapper must not infer a selector from its own model, a previous call, or
incidental model names in task content. If an explicit inner model request
cannot be resolved to an exact selector, it should report the ambiguity to the
caller rather than omit `model` or guess a default. Only when there is no inner
model request should it omit the argument.

Custom `acpAgents.<name>.prompt` and `orchestratorPrompt` overrides replace the
respective generated instructions. They bypass this default extraction/routing
guidance, so authors must include the same outer/inner distinction, explicit
selector forwarding, and ambiguity handling themselves. The tool cannot infer
that an override omitted a requested selection.

### Protocol and failure behavior

The ACP `session/new` response must advertise exactly one model select config
option (ID or category `model`), containing the requested exact value in its flat
or grouped options. Before prompting, `session/set_config_option` must return
that same option ID with exactly the requested `currentValue`. Missing or
ambiguous options, unsupported values, setter errors, or mismatched
confirmations stop the run without sending a prompt. Older protocols are not
emulated with `session/set_model`, and there is no silent default fallback.
Omission does not require model config options and sends no setter.

The timeout budget starts after launch permission and covers ACP startup,
selection, and prompting. Abort before spawn prevents launch; timeout or abort
during selection prevents even a late acknowledgement from triggering a prompt.
All paths await subprocess cleanup.

On success, the bridge makes a best-effort metadata call with `requestedModel`
and `acpModel`, both holding the exact requested/confirmed **ACP selector**.
These fields observe protocol acknowledgement, not proof of the provider's
final routing. UI visibility is host-dependent; the backend output is unchanged
even if the metadata callback throws.

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
