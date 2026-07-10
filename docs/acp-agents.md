# ACP Agents

Expose external [Agent Client Protocol](https://agentclientprotocol.com/) agents
as optional OpenCode subagents.

Use this when you want the orchestrator to delegate to software-connected tools
such as Claude Code ACP, Gemini ACP, or another ACP-compatible coding agent.

## How it works

Each `acpAgents` entry creates a lightweight wrapper subagent. The wrapper can
only call `acp_run`, which:

1. Starts the configured ACP subprocess over stdio.
2. Sends `initialize`.
3. Creates a session with `session/new`.
4. Sends the task with `session/prompt`.
5. Collects `session/update` `agent_message_chunk` text.
6. Returns the external agent's final output to OpenCode.

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
      "wrapperModel": "openai/gpt-5.6-luna",
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
