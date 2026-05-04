# Configuration Reference

Complete reference for all configuration files and options in oh-my-opencode-slim.

---

## Config Files

| File | Purpose |
|------|---------|
| `~/.config/opencode/opencode.json` | OpenCode core settings (plugin registration, providers) |
| `~/.config/opencode/oh-my-opencode-slim.json` | Plugin settings — agents, multiplexer, MCPs, council |
| `~/.config/opencode/oh-my-opencode-slim.jsonc` | Same, but with JSONC (comments + trailing commas). Takes precedence over `.json` if both exist |
| `.opencode/oh-my-opencode-slim.json` | Project-local overrides (optional, checked first) |

> **💡 JSONC recommended:** Use the `.jsonc` extension to add comments and trailing commas. If both `.jsonc` and `.json` exist, `.jsonc` takes precedence.

If OmO-slim detects an invalid plugin config for the current project, the TUI sidebar shows a warning. Run `oh-my-opencode-slim doctor` from your project root for full diagnostics.

---

## Prompt Overriding

Customize agent prompts without modifying source code. Create markdown files in `~/.config/opencode/oh-my-opencode-slim/`:

| File | Effect |
|------|--------|
| `{agent}.md` | Replaces the agent's default prompt entirely |
| `{agent}_append.md` | Appends custom instructions to the default prompt |

When a `preset` is active, the plugin checks `~/.config/opencode/oh-my-opencode-slim/{preset}/` first, then falls back to the root directory.

**Example directory structure:**

```
~/.config/opencode/oh-my-opencode-slim/
  ├── best/
  │   ├── orchestrator.md        # Preset-specific override (used when preset=best)
  │   └── explorer_append.md
  ├── orchestrator.md            # Fallback override
  ├── orchestrator_append.md
  ├── explorer.md
  └── ...
```

Both `{agent}.md` and `{agent}_append.md` can coexist — the full replacement takes effect first, then the append. If neither exists, the built-in default prompt is used.

---

## JSONC Format

All config files support **JSONC** (JSON with Comments):

- Single-line comments (`//`)
- Multi-line comments (`/* */`)
- Trailing commas in arrays and objects

**Example:**

```jsonc
{
  // Active preset
  "preset": "openai",

  /* Agent model mappings */
  "presets": {
    "openai": {
      "oracle": { "model": "openai/gpt-5.5" },
      "explorer": { "model": "openai/gpt-5.4-mini" },
    },
  },

  "multiplexer": {
    "type": "tmux",
    "layout": "main-vertical",
  },
}
```

---

## Full Option Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `preset` | string | — | Active preset name (e.g. `"openai"`, `"best"`) |

### Runtime Preset Switching

Presets can also be switched at runtime without restarting using the `/preset` command. See [Preset Switching](preset-switching.md) for details.

| `presets` | object | — | Named preset configurations |
|-----------|--------|---|-----------------------------|
| `presets.<name>.<agent>.model` | string | — | Model ID in `provider/model` format |
| `presets.<name>.<agent>.temperature` | number | — | Temperature (0–2) |
| `presets.<name>.<agent>.variant` | string | — | Reasoning effort: `"low"`, `"medium"`, `"high"` |
| `presets.<name>.<agent>.displayName` | string | — | Custom user-facing alias for the agent (e.g. `"advisor"` for `oracle`) |
| `presets.<name>.<agent>.skills` | string[] | — | Skills the agent can use (`"*"`, `"!item"`, explicit list) |
| `presets.<name>.<agent>.mcps` | string[] | — | MCPs the agent can use (`"*"`, `"!item"`, explicit list) |
| `presets.<name>.<agent>.options` | object | — | Provider-specific model options passed to the AI SDK (e.g., `textVerbosity`, `thinking` budget) |
| `agents.<customAgent>.model` | string\|array | — | Required for custom agents inferred from unknown `agents` keys |
| `agents.<customAgent>.prompt` | string | — | Full execution prompt for a custom agent |
| `agents.<customAgent>.orchestratorPrompt` | string | — | Exact `@agent` block injected into the orchestrator prompt; must start with `@<agent-name>` |
| `agents.<agent>.displayName` | string | — | Custom user-facing alias for the agent in the active config |
| `disabled_agents` | string[] | `["observer"]` | Agent names to disable globally. Set to `[]` to enable Observer; this is global, not per-preset |
| `autoUpdate` | boolean | `true` | Automatically install plugin updates in the background; set to `false` for notification-only mode |
| `multiplexer.type` | string | `"none"` | Multiplexer mode: `auto`, `tmux`, `zellij`, or `none` |
| `multiplexer.layout` | string | `"main-vertical"` | Layout preset: `main-vertical`, `main-horizontal`, `tiled`, `even-horizontal`, `even-vertical` |
| `multiplexer.main_pane_size` | number | `60` | Main pane size as percentage (20–80) |
| `divoom.enabled` | boolean | `false` | Enable Divoom Bluetooth display status GIFs for plugin load and delegated agent calls |
| `divoom.python` | string | Divoom MiniToo bundled Python | Python executable used to run Divoom MiniToo's `divoom_send.py` helper |
| `divoom.script` | string | Divoom MiniToo `divoom_send.py` | Divoom sender script path |
| `divoom.size` | integer | `128` | Output GIF size passed to `divoom_send.py` |
| `divoom.fps` | integer | `8` | Output GIF FPS passed to `divoom_send.py` |
| `divoom.speed` | integer | `125` | Playback speed passed to `divoom_send.py` |
| `divoom.maxFrames` | integer | `24` | Maximum frames passed to `divoom_send.py` |
| `divoom.posterizeBits` | integer | `3` | Posterization bits passed to `divoom_send.py` |
| `divoom.gifs.<agent>` | string | bundled GIF | Optional per-agent GIF filename or absolute path override |
| `tmux.enabled` | boolean | `false` | Legacy alias for `multiplexer.type = "tmux"` |
| `tmux.layout` | string | `"main-vertical"` | Legacy alias for `multiplexer.layout` |
| `tmux.main_pane_size` | number | `60` | Legacy alias for `multiplexer.main_pane_size` |
| `sessionManager.maxSessionsPerAgent` | integer | `2` | Maximum remembered resumable child sessions per specialist type in the current orchestrator session (1–10). See [Session Management](session-management.md) |
| `sessionManager.readContextMinLines` | integer | `10` | Minimum number of lines read from a file before it appears in resumable-session context (0–1000) |
| `sessionManager.readContextMaxFiles` | integer | `8` | Maximum number of recent read-context files shown per remembered child session (0–50) |
| `disabled_mcps` | string[] | `[]` | MCP server IDs to disable globally |
| `fallback.enabled` | boolean | `false` | Enable model failover on timeout/error |
| `fallback.timeoutMs` | number | `15000` | Time before aborting and trying next model |
| `fallback.retryDelayMs` | number | `500` | Delay between retry attempts |
| `fallback.chains.<agent>` | string[] | — | Ordered fallback model IDs for an agent |
| `fallback.retry_on_empty` | boolean | `true` | Treat silent empty provider responses (0 tokens) as failures and retry. Set `false` to accept empty responses |
| `council.presets` | object | — | **Required if using council.** Named councillor presets |
| `council.presets.<name>.<councillor>.model` | string | — | Councillor model |
| `council.presets.<name>.<councillor>.variant` | string | — | Councillor variant |
| `council.presets.<name>.<councillor>.prompt` | string | — | Optional role guidance for the councillor |
| `council.default_preset` | string | `"default"` | Default preset when none is specified |
| `council.timeout` | number | `180000` | Per-councillor timeout (ms) |
| `council.councillor_execution_mode` | string | `"parallel"` | Run councillors in `parallel` or `serial`; use `serial` for single-model setups |
| `council.councillor_retries` | number | `3` | Max retries per councillor on empty provider response (0–5) |
| `todoContinuation.maxContinuations` | integer | `5` | Max consecutive auto-continuations before stopping (1–50) |
| `todoContinuation.cooldownMs` | integer | `3000` | Delay in ms before auto-continuing — gives user time to abort (0–30000) |
| `todoContinuation.autoEnable` | boolean | `false` | Automatically enable auto-continue when session has enough todos |
| `todoContinuation.autoEnableThreshold` | integer | `4` | Number of todos that triggers auto-enable (only used when `autoEnable` is true, 1–50) |
| `interview.maxQuestions` | integer | `2` | Max questions per interview round (1–10) |
| `interview.outputFolder` | string | `"interview"` | Directory where interview markdown files are written (relative to project root) |
| `interview.autoOpenBrowser` | boolean | `true` | Automatically open the interview UI in your default browser during interactive runs; suppressed in tests and CI |
| `interview.port` | integer | `0` | Interview server port (0–65535). `0` = OS-assigned random port (per-session mode). Any value > 0 enables [dashboard mode](interview.md#dashboard-mode) |
| `interview.dashboard` | boolean | `false` | Enable [dashboard mode](interview.md#dashboard-mode) on the default port (43211). Setting `port` > 0 also enables dashboard mode. If both are set, `port` takes precedence |

### Council configuration note

- The **Council agent model** is configured like any other agent, for example in
  `presets.<name>.council.model`.
- The **councillor models** are configured separately under
  `council.presets.<name>.<councillor>.model`.
- Deprecated `council.master*` fields should not be used in new configs.

### Manual Update Mode

Set `autoUpdate` to `false` if you want update notifications without automatic
`bun install` runs.

```jsonc
{
  "autoUpdate": false
}
```

With `autoUpdate` set to `false`, this becomes notification-only mode: you'll
see that a new version is available, but the plugin won't install it
automatically.

> Pinned plugin entries in `opencode.json` (for example
> `"oh-my-opencode-slim@1.0.1"`) are the true version lock. Those stay pinned
> regardless of `autoUpdate`.

### Divoom Display Integration

Divoom integration is disabled by default. Install and start the Divoom MiniToo
macOS daemon from
[`divoom-minitoo-osx`](https://github.com/alvinunreal/divoom-minitoo-osx)
first, then enable this plugin integration. See the full
**[Divoom guide](divoom.md)** for setup, daemon startup, and troubleshooting.

When enabled, the plugin sends bundled GIFs to the Divoom MiniToo app's bundled
CLI:

- plugin load / waiting for user input: `intro.gif`
- orchestrator busy: `orchestrator.gif`
- first active delegated agent: that agent's GIF
- parallel delegated agents: the first agent keeps the display
- all delegated agents complete while orchestrator keeps working: `orchestrator.gif`
- orchestrator idle again: `intro.gif`

```jsonc
{
  "divoom": {
    "enabled": true
  }
}
```

For a one-off run without editing config:

```bash
OH_MY_OPENCODE_SLIM_DIVOOM=1 opencode
```

If `divoom.enabled` is explicitly set in config, the config value wins over the
environment variable.

The defaults target the macOS Divoom MiniToo app bundle:

```jsonc
{
  "divoom": {
    "enabled": true,
    "python": "/Applications/Divoom MiniToo.app/Contents/Resources/.venv/bin/python",
    "script": "/Applications/Divoom MiniToo.app/Contents/Resources/tools/divoom_send.py",
    "size": 128,
    "fps": 8,
    "speed": 125,
    "maxFrames": 24,
    "posterizeBits": 3
  }
}
```

To override a GIF, use either a bundled filename or an absolute path:

```jsonc
{
  "divoom": {
    "enabled": true,
    "gifs": {
      "oracle": "/Users/me/Pictures/oracle.gif"
    }
  }
}
```

### Session Management

Session management is enabled by default and does not need to be present in the
starter config. Add `sessionManager` only if you want to tune how many resumable
child-agent sessions are remembered or how much read context is shown. See
[Session Management](session-management.md) for the concept, defaults, and
examples.

### Agent Display Names

Use `displayName` to give an agent a user-facing alias while keeping the
internal agent name unchanged.

```jsonc
{
  "agents": {
    "oracle": {
      "displayName": "advisor"
    },
    "explorer": {
      "displayName": "researcher"
    }
  }
}
```

With this config, users can refer to `@advisor` and `@researcher`, while the
plugin still routes them to `oracle` and `explorer` internally.

Notes:

- `displayName` works in both top-level `agents` overrides and inside `presets`
- `@` prefixes and surrounding whitespace are normalized automatically
- Display names must be unique
- Display names cannot conflict with internal agent names like `oracle` or `explorer`

### Custom Agents

Unknown keys under `agents` are treated as custom subagents. A custom agent needs
its own `model`, a normal `prompt`, and optionally an `orchestratorPrompt` that
teaches the orchestrator exactly when to delegate to it.

```jsonc
{
  "agents": {
    "janitor": {
      "model": "github-copilot/gpt-5.5",
      "prompt": "You are Janitor. Audit codebase entropy, dead code, docs drift, naming inconsistencies, and unnecessary complexity. Prefer analysis and plans over direct edits.",
      "orchestratorPrompt": "@janitor\n- Role: Maintenance specialist for codebase cleanup and entropy reduction\n- **Delegate when:** after large refactors • cleanup/technical-debt review • dead code or docs drift is suspected\n- **Don't delegate when:** feature implementation • urgent debugging • UI/UX work"
    }
  }
}
```

Notes:

- Custom agent names must be safe identifiers such as `janitor` or `security-reviewer`
- Custom agents without a `model` are skipped with a warning
- Disabled custom agents are not registered or injected into the orchestrator prompt
