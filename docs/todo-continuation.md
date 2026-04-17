# Todo Continuation

Auto-continue the orchestrator when it stops with incomplete todos. Opt-in only — nothing resumes automatically unless you enable it.

## Controls

| Tool / Command | Description |
|----------------|-------------|
| `auto_continue` | Toggle auto-continuation. Call with `{ enabled: true }` to activate, `{ enabled: false }` to disable |
| `/auto-continue` | Slash command shortcut. Accepts `on`, `off`, or toggles with no argument |

## How It Works

1. When the orchestrator goes idle with incomplete todos, a countdown notification appears
2. After the cooldown (default 3s), a continuation prompt is injected and the orchestrator resumes work
3. Press Esc×2 during the cooldown or after injection to stop it

## Safety Gates

All of these must pass before continuation happens:

- Auto-continue is enabled
- The session is the orchestrator
- Incomplete todos exist
- The last assistant message is not a question
- The consecutive continuation count is under the limit
- The session is not in the post-abort suppress window (5s)
- No pending injection is already in flight

## Configuration

Configure it in `~/.config/opencode/oh-my-opencode-slim.json` or `~/.config/opencode/oh-my-opencode-slim.jsonc`:

```jsonc
{
  "todoContinuation": {
    "maxContinuations": 5,      // Max consecutive auto-continuations (1–50)
    "cooldownMs": 3000,         // Delay before each continuation (0–30000)
    "autoEnable": false,        // Auto-enable when session has enough todos
    "autoEnableThreshold": 4    // Number of todos to trigger auto-enable
  }
}
```

> See [Configuration](configuration.md) for the full option reference.
