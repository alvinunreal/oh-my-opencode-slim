# opencode-discipline

`opencode-discipline` is an OpenCode plugin that enforces a 4-wave planning flow before implementation:

1. Interview
2. Gap Analysis
3. Plan Generation
4. Review and Handoff

It provides:
- `advance_wave` to progress planning waves
- `accept_plan` to drive accept/revise handoff into Build
- `/simplify [focus]` custom command (Claude-style simplify workflow)
- `/batch <change>` custom command (Claude-style parallel batch workflow)
- `/deep-review [focus|PR]` custom command (read-only 3-agent parallel code review)
- write/read guards (plan file gating and `.env` read protection)
- system and compaction context injection for continuity
- bundled agent markdown files under `agents/`

## Install

```json
{
  "plugin": ["opencode-discipline"]
}
```

## Build

```bash
bun run build
```

## Notifications (optional)

On startup, the plugin shows a small in-app toast: `opencode-discipline vX is running`.

You can enable milestone notifications for key planning events:

- `Need your answers` (agent question prompts)
- `Plan is ready` (Wave 4 handoff stage)
- `OpenCode has finished` (Build agent completion)

Set one environment variable before running OpenCode:

```bash
export OPENCODE_DISCIPLINE_NOTIFY=metadata
```

Supported modes:

- `off`
- `metadata` (emit structured notification metadata)
- `os` (default; desktop notification via `osascript`/`notify-send`/PowerShell)
- `both` (metadata + OS)

Optional custom command hook:

```bash
export OPENCODE_DISCIPLINE_NOTIFY_COMMAND='terminal-notifier -title "{title}" -message "{message}"'
```

Template variables: `{event}`, `{title}`, `{message}`, `{sessionID}`.

Build completion notifications are emitted automatically when OpenCode reports the Build session as idle (`session.idle`).

## Test

```bash
bun test
```

## Custom commands

This plugin injects three commands into OpenCode config:

| Command | What it does |
|---|---|
| `/simplify [focus]` | 3-agent parallel review (reuse, quality, efficiency) → applies fixes → verifies |
| `/batch <change>` | Plans a large parallelizable migration → approval gate → isolated workers → status report |
| `/deep-review [focus\|PR]` | 3-agent parallel review (correctness, security, tests/scope) → read-only report with verdict (runs under plan agent) |

The command prompts live in `commands/*.md`, so you can edit frontmatter/templates without changing TypeScript code. On plugin load they are synced to `~/.config/opencode/commands/` (global).
