# opencode-discipline Agent Suite

This package ships eleven agent definitions for disciplined plan-first execution.

| Agent | Model | Mode | Purpose |
| --- | --- | --- | --- |
| `plan` | `anthropic/claude-opus-4-6` | primary | Runs the 4-wave planning workflow and coordinates accept/revise handoff |
| `build` | `anthropic/claude-opus-4-6` | primary | Executes approved plans phase-by-phase with verification gates |
| `analyzer` | `openai/gpt-5.4` | agent | Traces control flow, data flow, and system interactions from file lists into step-by-step explanations |
| `oracle` | `openai/gpt-5.4` | subagent | Read-only architecture and tradeoff advisor |
| `librarian` | `openai/gpt-5.2` | subagent | External knowledge specialist — docs, best practices, implementation guidance |
| `reviewer` | `openai/gpt-5.4` | subagent | Read-only quality critic for plans and code |
| `designer` | `anthropic/claude-sonnet-4-6` | subagent | Read-only UI/UX and accessibility advisor |
| `deep` | `openai/gpt-5.3-codex` | subagent | Advanced implementation subagent for complex coding work |
| `explore` | `anthropic/claude-haiku-4-5` | subagent | Fast codebase search and file discovery |
| `explore-deep` | `openai/gpt-5.2` | subagent | Heavy-duty codebase search for complex, multi-step exploration |

## Installation

Enable the plugin in `opencode.json`:

```json
{
  "plugin": ["opencode-discipline"]
}
```

The plugin automatically injects all agent configurations via the `config` hook — no manual file copying required.

To override a specific field for any agent, add it to `opencode.json`:

```json
{
  "plugin": ["opencode-discipline"],
  "agent": {
    "plan": { "model": "anthropic/claude-sonnet-4-6" }
  }
}
```

User overrides take precedence per field; non-overridden fields use the plugin defaults.

## Delegation flow

```text
Explorer = codebase search ("what exists?")
Librarian = external knowledge ("what should we do?")
Golden rule: Explorer first, Librarian second.

plan -> explore/explore-deep -> analyzer -> librarian (if needed) -> oracle -> accept_plan
accept_plan -> build
build -> explore/explore-deep -> analyzer -> librarian (if needed) -> oracle -> reviewer -> done
```
