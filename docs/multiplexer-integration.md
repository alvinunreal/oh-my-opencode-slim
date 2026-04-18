# Multiplexer Integration Guide

Use tmux or Zellij to watch subagents work in live panes while OpenCode keeps running in your main session.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Layouts](#layouts)
- [Troubleshooting](#troubleshooting)
- [Advanced Usage](#advanced-usage)

---

## Overview

When the Orchestrator launches subagents or background tasks, oh-my-opencode-slim can open panes for those sessions automatically.

- **Real-time visibility** into agent activity
- **Automatic pane management** while tasks run
- **Easy debugging** by jumping into live sessions
- **Support for multiple projects** on different sessions or ports

![Tmux multiplexer view](../img/tmux.png)

*OpenCode running in tmux with live subagent panes.*

> ⚠️ **Current workaround:** Start OpenCode with `--port` to enable multiplexer integration. The port must match the `OPENCODE_PORT` environment variable. This is required until [opencode#9099](https://github.com/anomalyco/opencode/issues/9099) is resolved.

If you open multiple OpenCode sessions, use a random high port for each launch instead of hard-coding `4096`.

**Bash helper:**

```bash
omos() {
  local port
  port=$(jot -r 1 49152 65535)
  OPENCODE_PORT="$port" \
  opencode --port "$port" "$@"
}
```

---

## Quick Start

### 1. Enable the multiplexer

Edit `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`):

**Auto-detect (recommended):**

```jsonc
{
  "multiplexer": {
    "type": "auto",
    "layout": "main-vertical",
    "main_pane_size": 60
  }
}
```

**Tmux only:**

```jsonc
{
  "multiplexer": {
    "type": "tmux",
    "layout": "main-vertical",
    "main_pane_size": 60
  }
}
```

**Zellij only:**

```jsonc
{
  "multiplexer": {
    "type": "zellij"
  }
}
```

### 2. Start OpenCode inside tmux or Zellij

**Tmux:**

```bash
tmux
opencode --port 4096
```

**Zellij:**

```bash
zellij
opencode --port 4096
```

### 3. Trigger delegated work

Ask OpenCode to do something that launches subagents. New panes should appear automatically.

Example:

```text
Please analyze this codebase and create a documentation structure.
```

---

## Configuration

### Multiplexer Settings

```jsonc
{
  "multiplexer": {
    "type": "auto",
    "layout": "main-vertical",
    "main_pane_size": 60
  }
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `type` | string | `"none"` | `"auto"`, `"tmux"`, `"zellij"`, or `"none"` |
| `layout` | string | `"main-vertical"` | Layout preset for tmux only |
| `main_pane_size` | number | `60` | Main pane size percentage for tmux only (`20`-`80`) |

### Supported Multiplexers

| Multiplexer | Status | Notes |
|-------------|--------|-------|
| **Tmux** | ✅ Supported | Full layout control with `main-vertical`, `main-horizontal`, `tiled`, and more |
| **Zellij** | ✅ Supported | Creates a dedicated `opencode-agents` tab and reuses the default pane |

### Legacy tmux config

Older configs still work:

```jsonc
{
  "tmux": {
    "enabled": true,
    "layout": "main-vertical",
    "main_pane_size": 60
  }
}
```

This is converted automatically to `multiplexer.type: "tmux"`.

---

## Layouts

These layouts apply to **tmux only**:

| Layout | Description |
|--------|-------------|
| `main-vertical` | Your session on the left, agents stacked on the right |
| `main-horizontal` | Your session on top, agents stacked below |
| `tiled` | All panes in an equal-sized grid |
| `even-horizontal` | All panes side by side |
| `even-vertical` | All panes stacked vertically |

**Example: wide-screen layout**

```jsonc
{
  "multiplexer": {
    "type": "tmux",
    "layout": "main-horizontal",
    "main_pane_size": 50
  }
}
```

**Example: maximum parallel visibility**

```jsonc
{
  "multiplexer": {
    "type": "tmux",
    "layout": "tiled",
    "main_pane_size": 50
  }
}
```
