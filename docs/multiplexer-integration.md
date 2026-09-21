# Multiplexer Integration Guide

Use tmux, Zellij, Herdr, cmux, or kitty to watch subagents work in live panes
while OpenCode keeps running in your main session.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Layouts](#layouts)
- [Troubleshooting](#troubleshooting)
- [Advanced Usage](#advanced-usage)

---

## Overview

When OpenCode launches child agent sessions, oh-my-opencode-slim can open panes for those sessions automatically.

- **Real-time visibility** into agent activity
- **Automatic pane management** while tasks run
- **Easy debugging** by jumping into live sessions
- **Support for multiple projects** on different sessions or ports

![Tmux multiplexer view](../img/tmux.png)

*OpenCode running in tmux with live subagent panes.*

OpenCode 1.17.18's normal default (`port 0`) does not expose a TCP listener that
another `opencode attach` process can use from a multiplexer pane. Start
OpenCode with an explicit `--port`, but do not hard-code `4096` when running
multiple instances. The plugin now reads `ctx.serverUrl` only when checking,
spawning, or polling, which avoids snapshotting the temporary startup URL; it
cannot create a listener that OpenCode did not start.

For cmux, a session status that remains missing for more than the 30-second
grace period is treated as an idle candidate. Closing still requires the pane
to have been attached for at least 10 seconds, three stable idle-candidate
checks, and a final status recheck.

If all bounded close attempts and both cooldown retries are exhausted, the pane
remains tracked as an orphan without a running timer. A later lifecycle for the
same directory claims it with a fresh, bounded close-attempt budget.

This zsh helper preserves an explicit `--port` and exports the matching
`OPENCODE_PORT`. Otherwise, it asks Python to select an available loopback port
and starts OpenCode with that port explicitly:

```zsh
omos() {
  local port arg

  for arg in "$@"; do
    if [[ "$arg" == --port=* ]]; then
      port="${arg#--port=}"
      break
    fi
  done

  if [[ -z "$port" ]]; then
    local -a args=("$@")
    local -i index
    for ((index = 1; index <= ${#args}; index++)); do
      if [[ "${args[index]}" == --port ]]; then
        port="${args[index + 1]}"
        break
      fi
    done
  fi

  if [[ -n "$port" ]]; then
    OPENCODE_PORT="$port" command opencode "$@"
    return
  fi

  port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()') || return
  OPENCODE_PORT="$port" command opencode --port "$port" "$@"
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

**Herdr only:**

```jsonc
{
  "multiplexer": {
    "type": "herdr"
  }
}
```

The Herdr adapter works with Herdr **0.8.0+**. Install Herdr's official
OpenCode lifecycle integration separately:

```bash
herdr integration install opencode
```

For Marketplace discoverability, publish this repository with the required
`herdr-plugin` repository topic, then install it with:

```bash
herdr plugin install alvinunreal/oh-my-opencode-slim
```

The Marketplace entry describes this OpenCode plugin's Herdr adapter. It does
not install a standalone native Herdr runtime plugin or lifecycle reporter.

**cmux only:**

```jsonc
{
  "multiplexer": {
    "type": "cmux"
  }
}
```

cmux 0.64.14 or newer is required; 0.64.17 or newer is recommended.

**Kitty only:**

```jsonc
{
  "multiplexer": {
    "type": "kitty"
  }
}
```

Kitty requires `allow_remote_control` **and** `listen_on` in `kitty.conf`.
`listen_on` opens a UNIX socket and kitty exports `KITTY_LISTEN_ON` to its
child processes (including OpenCode). The plugin passes that env through to
every `kitten @` invocation automatically — no extra plugin config is needed.
This is required because OpenCode spawns subagent commands in a process
detached from the kitty window's controlling terminal, where the tty-based
remote-control path does not work.

```conf
allow_remote_control yes
listen_on unix:/tmp/kitty-rc-$(USER)
```

After editing `kitty.conf`, **restart kitty** (quit and relaunch) so the socket
is created. Verify with `kitten @ ls` from a normal shell — it should print JSON
instead of timing out.

### 2. Start OpenCode inside tmux, Zellij, Herdr, cmux, or kitty

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

**Herdr:**

```bash
herdr
opencode --port 4096
```

**cmux:** Start OpenCode in a cmux surface. Auto-detection requires cmux to
provide `CMUX_SOCKET_PATH`, `CMUX_WORKSPACE_ID`, and `CMUX_SURFACE_ID`.

**Kitty:**

```bash
kitty
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
| `type` | string | `"none"` | `"auto"`, `"tmux"`, `"zellij"`, `"herdr"`, `"cmux"`, `"kitty"`, or `"none"` |
| `layout` | string | `"main-vertical"` | Layout preset for tmux; mapped to Zellij/Herdr pane directions where possible; ignored by cmux |
| `main_pane_size` | number | `60` | Main pane size percentage for tmux only (`20`-`80`); ignored by Zellij, Herdr, and cmux |
| `zellij_pane_mode` | string | `"agent-tab"` | Zellij pane placement: `"agent-tab"` creates/reuses a dedicated tab; `"current-tab"` opens panes in the tab containing the parent OpenCode pane |

### Supported Multiplexers

| Multiplexer | Status | Notes |
|-------------|--------|-------|
| **Tmux** | ✅ Supported | Full layout control with `main-vertical`, `main-horizontal`, `tiled`, and more |
| **Zellij** | ✅ Supported | Requires Zellij **0.44.1 or newer** (the adapter gates on `zellij --version` and skips itself on older releases; 0.44.0 lacks `new-pane --tab-id`). Creates a dedicated `opencode-agents` tab by default; can open panes in the parent OpenCode tab with `zellij_pane_mode: "current-tab"`; maps `main-*` layouts to pane directions |
| **Herdr** | ✅ Supported | Splits panes in the current Herdr workspace; maps `main-vertical`/`even-horizontal`/`tiled` layouts to right splits and `main-horizontal`/`even-vertical` to down splits; no layout rebalancing (like Zellij) |
| **cmux** | ✅ Supported | Requires cmux 0.64.14+ (0.64.17+ recommended); creates the agent column to the right and stacks subsequent agents downward without moving focus |
| **Kitty** | ✅ Supported | Uses `kitten @ launch` to open new windows; requires `allow_remote_control` **and** `listen_on` in kitty.conf (OpenCode must run inside a kitty window; kitty exports `KITTY_LISTEN_ON` which the plugin passes through to reach kitty from detached subagent processes). No layout rebalancing (like Zellij/Herdr) |

The cmux adapter equalizes vertical splits after each successful add and close.
It always creates the first agent to the right and subsequent agents downward;
both `layout` and `main_pane_size` are ignored by cmux.
cmux's workspace-level vertical equalization can affect other vertical
subtrees, so the adapter assumes its managed right-hand agent column is the
only vertical subtree in the workspace that should be automatically
equalized. `layout` and `main_pane_size` do not alter cmux's left/right width.

cmux follows the OpenCode/OMO lifecycle rather than using a placeholder pane.
Attach commands require an existing absolute OpenCode executable, resolved in
the order explicit setting, `OPENCODE_BIN`, `process.execPath`, and
`process.argv[0]`. If none is valid, no surface is created and a bare
`opencode` command is never emitted.

Activity cancels an idle close, while deletion upgrades it and retries
immediately. Failed closes and failed startup cleanup retain the encoded pane
handle and enter a 30-second then 60-second orphan cooldown. Tracking is only
removed after cmux reports `closed` or `not_found`; bounded disposal cleanup
retains unresolved orphan records.

Recovery is bounded per lifecycle instance: after its finite close-attempt
budget is exhausted, the orphan remains in the process-global registry without
an infinite retry timer. A later cmux lifecycle for the same directory takes
ownership and receives a fresh finite budget. This registry survives plugin
hot reloads in the same process, but is not persistent storage and cannot
recover state after a hard process crash.
cmux also pins pane attachment to the host OpenCode executable (or a valid
absolute `OPENCODE_BIN` override) instead of resolving `opencode` from the new
pane's `PATH`. All pane backends (tmux, zellij, herdr, kitty, cmux) share this
behavior, so a `PATH`-less pane shell can no longer fail to find `opencode`
(#514). This prevents a different installed OpenCode version from
starting and immediately exiting during attach.
It polls the configured server's `/session/status` endpoint and creates the
pane only after the child is reported as `idle`, `running`, `busy`, or `retry`.
Transient network errors, missing statuses, and server startup races are
bounded waits and therefore do not flash an empty pane. A readiness timeout or
a recoverable cmux split-capacity/layout error is retried about two seconds
later, deduplicated by session, for up to five minutes. Deleting the session or
shutting down the plugin cancels that deferred work.

To avoid closing a pane during transient idle notifications, cmux keeps it for
at least ten seconds after attachment and requires three consecutive idle
polls plus a final idle recheck with no intervening activity. Missing status is
treated as a grace condition. This stability policy is cmux-specific; existing
tmux, Zellij, and Herdr close behavior is unchanged. Native cmux support does
not create placeholder panes while waiting and does not currently expose a
configurable cmux column width.

**Example: open Zellij subagents in the parent OpenCode tab**

```jsonc
{
  "multiplexer": {
    "type": "zellij",
    "zellij_pane_mode": "current-tab"
  }
}
```

In `current-tab` mode, panes are targeted to the tab that contains the parent
OpenCode pane (resolved from the parent pane's `ZELLIJ_PANE_ID` via
`list-panes`), even if another Zellij tab is focused when a subagent starts.
If the parent pane cannot be resolved, the tab target is omitted and Zellij
places the pane in whatever tab it has focused — no tab id is guessed.

### Tmux attached-session targeting

When multiple local TUI clients attach to one OpenCode server from different
tmux sessions, each TUI records its active OpenCode session and `TMUX_PANE`.
Child panes and layout updates target the tmux pane registered by their parent
session, so each attached root session keeps its subagents beside itself.

Registrations are session-scoped, refreshed while the TUI is active, and expire
after 30 seconds without a heartbeat. If no fresh registration exists,
or tmux rejects a registered target, pane creation falls back to the server
process's original `TMUX_PANE`. This preserves direct/local TUI behavior and
avoids losing subagent visibility after an attached pane closes unexpectedly.

### Zellij details

The Zellij adapter requires **Zellij 0.44.1 or newer**. Older releases are
rejected at availability check time: `isAvailable()` parses `zellij
--version` and returns `false` for anything below 0.44.1, so the Zellij
backend is silently skipped rather than failing at pane-creation time.
Version 0.44.0 in particular lacks `new-pane --tab-id`, which the
`current-tab` mode needs to target the parent OpenCode tab directly.

All pane mutations use **direct pane-id targeting** (no `focus-pane`, which is
not a valid Zellij CLI action, and no `current-tab-info`, which is
client-bound and fails from pane child processes):

- `rename-pane <name> -p <paneId>` — best-effort pane title; a rename failure
  never masks a failing attach write
- `write-chars <chars> -p <paneId>` — writes the `opencode attach` command and
  a trailing newline directly into the target pane; if either write fails the
  pane reuse is reported as a failure
- `list-panes --json --tab --all` — stable `tab_id` per pane, used to map the
  parent `ZELLIJ_PANE_ID` to its tab
- `new-pane --tab-id <id> --direction <dir>` — creates a pane in a specific
  tab; if Zellij silently drops a `--direction` split (a crowded tab — up to
  ~4 stacked panes — returns exit 0 but no pane id), the create is retried
  once without the direction hint, letting Zellij place the pane in the
  largest free space

In `agent-tab` mode the parent tab (from `ZELLIJ_PANE_ID`) is restored after a
pane is created in the `opencode-agents` tab, and also immediately after the
tab is first created (`new-tab` moves client focus to the new tab). If the
parent tab cannot be located, focus stays in the agent tab rather than
guessing a tab id.

Pane creation sequences are serialized per session: concurrent sub-agent
starts are queued so tab/focus-mutating actions (new-tab, go-to-tab-by-id,
new-pane) never interleave — a cross-tab create cannot race another create's
focus restore.

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

Tmux supports full layout control and main pane sizing. Zellij and Herdr map
only the `main-*` layout settings to pane creation directions; exact
`main_pane_size` rebalancing is tmux-only.

| Layout | Description |
|--------|-------------|
| `main-vertical` | Your session on the left, agents stacked on the right |
| `main-horizontal` | Your session on top, agents stacked below |
| `tiled` | All panes in an equal-sized grid |
| `even-horizontal` | All panes side by side |
| `even-vertical` | All panes stacked vertically |

For Zellij:

| Layout | Zellij behavior |
|--------|-----------------|
| `main-vertical` | Opens new subagent panes to the right |
| `main-horizontal` | Opens new subagent panes down |
| `even-horizontal` | Uses Zellij's native pane placement |
| `even-vertical` | Uses Zellij's native pane placement |
| `tiled` | Uses Zellij's native pane placement |

For kitty:

| Layout | Kitty behavior |
|--------|----------------|
| `main-vertical` | Uses `tall` layout (full-height main pane on left, side panes stacked on right) |
| `main-horizontal` | Uses `fat` layout (full-width main pane on top, side panes tiled below) |
| `even-horizontal` | Uses `horizontal` layout (all panes side-by-side, equal width) |
| `even-vertical` | Uses `vertical` layout (all panes stacked, equal height) |
| `tiled` | Uses `grid` layout (all panes in equal-sized grid) |

> **Note:** kitty has no layout rebalancing API like tmux's `select-layout`, and no per-window layout — so the multiplexer applies the mapped kitty layout (`tall`, `fat`, `grid`, `horizontal`, or `vertical`) as a **global change to the active tab**, overriding whatever layout you had there. The `main_pane_size` config is ignored. The layout is only re-applied when it differs from the currently applied one (e.g., via `applyLayout`).

For Herdr:

| Layout | Herdr behavior |
|--------|-----------------|
| `main-vertical` | Parent OpenCode pane stays on the left. First subagent opens in a right-side pane; subsequent subagents stack vertically in that right column. Parent pane remains dominant. |
| `main-horizontal` | Each subagent splits below the parent (down). |
| `even-horizontal` | Each subagent splits to the right of the parent. |
| `even-vertical` | Each subagent splits below the parent. |
| `tiled` | Each subagent splits to the right of the parent. |

**Note:** Herdr has no layout rebalancing API like tmux's `select-layout`.
The `main_pane_size` config is ignored. The `main-vertical` layout approximates
tmux's behavior by tracking the first right-side pane and stacking later agents
vertically within it. If the agent-area pane is closed, the next spawn
re-creates it from the parent.

> **Note:** `main_pane_size` is ignored by herdr. All layouts split from the parent pane.

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
