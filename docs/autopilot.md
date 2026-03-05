# Autopilot Todo Continuation

Autopilot is a session-scoped mode that keeps working through todos in the
same session after the assistant goes idle.

## How It Works

1. Type `autopilot` in a user message to enable the mode for the current
   session.
2. When the session becomes idle, the plugin checks session todos.
3. If any todo is still active (`pending` or `in_progress`), the plugin sends a
   continuation prompt in the same session.
4. If all todos are terminal (`completed`, `cancelled`, `done`), autopilot
   turns off automatically for that session.

Use `manual` to disable autopilot immediately for the current session.

## Defaults

- Keyword on: `autopilot`
- Keyword off: `manual`
- Cooldown between auto-continue kicks: `8000ms`
- Maximum auto-continues per activation: `10`

## Configuration

Add this to `~/.config/opencode/oh-my-opencode-slim.jsonc` or
`.opencode/oh-my-opencode-slim.jsonc`:

```jsonc
{
  "autopilot": {
    "enabled": true,
    "keyword": "autopilot",
    "disableKeyword": "manual",
    "cooldownMs": 8000,
    "maxAutoContinues": 10
  }
}
```

## Notes

- Scope is per `sessionID` (not global across all sessions).
- Autopilot only reacts on idle transitions, not every token/tool step.
- If todo APIs are unavailable in the running OpenCode build, autopilot fails
  safely and does nothing.
