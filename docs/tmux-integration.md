# Tmux Integration Guide

Complete guide for using tmux integration with oh-my-opencode-slim to watch agents work in real-time through automatic pane spawning.

## Table of Contents

- [Overview](#overview)
- [Quick Setup](#quick-setup)
- [Configuration](#configuration)
- [Layout Options](#layout-options)
- [Usage Examples](#usage-examples)
- [Troubleshooting](#troubleshooting)
- [Advanced Usage](#advanced-usage)

---

## Overview

**Watch your agents work in real-time.** When the Orchestrator launches sub-agents or initiates background tasks, new tmux panes automatically spawn showing each agent's live progress. No more waiting in the dark.

### Key Benefits

- **Real-time visibility** into agent activities
- **Automatic pane management** - panes spawn and organize automatically
- **Interactive debugging** - you can jump into any agent's session
- **Background task monitoring** - see long-running work as it happens
- **Multi-session support** - different projects can have separate tmux environments

> ⚠️ **Temporary workaround:** Start OpenCode with `--port` to enable tmux integration. The port must match the `OPENCODE_PORT` environment variable (default: 4096). This is required until the upstream issue is resolved. [opencode#9099](https://github.com/anomalyco/opencode/issues/9099).

---

## Quick Setup

### Step 1: Enable Tmux Integration

Edit `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`):

```json
{
  "tmux": {
    "enabled": true,
    "layout": "main-vertical",
    "main_pane_size": 60
  }
}
```

### Step 2: Run OpenCode Inside Tmux

```bash
# Start a new tmux session
tmux

# Start OpenCode with the default port (4096)
opencode --port 4096
```

That's it! Your agents will now spawn panes automatically.

---

## Configuration

### Tmux Settings

Configure tmux behavior in `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`):

```json
{
  "tmux": {
    "enabled": true,
    "layout": "main-vertical",
    "main_pane_size": 60
  }
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable/disable tmux pane spawning |
| `layout` | string | `"main-vertical"` | Layout preset (see [Layout Options](#layout-options)) |
| `main_pane_size` | number | `60` | Main pane size as percentage (20-80) |

### Layout Options

Choose how panes are arranged:

| Layout | Description |
|--------|-------------|
| `main-vertical` | Your session on the left (60%), agents stacked on the right |
| `main-horizontal` | Your session on top (60%), agents stacked below |
| `tiled` | All panes in equal-sized grid |
| `even-horizontal` | All panes side by side |
| `even-vertical` | All panes stacked vertically |

**Example: Horizontal layout for wide screens:**
```json
{
  "tmux": {
    "enabled": true,
    "layout": "main-horizontal",
    "main_pane_size": 50
  }
}
```

**Example: Tiled layout for maximum parallelism:**
```json
{
  "tmux": {
    "enabled": true,
    "layout": "tiled",
    "main_pane_size": 50
  }
}
```

---

## Usage Examples

### Basic Usage

1. **Start tmux and OpenCode:**
   ```bash
   tmux
   opencode --port 4096
   ```

2. **Ask the Orchestrator to delegate work:**
   ```
   Please analyze this codebase and create a documentation structure.
   ```

3. **Watch panes spawn automatically:**
   - The main OpenCode session stays visible
   - New panes appear showing agent activities
   - You can switch between panes to monitor progress

### Navigating Panes

```bash
# List all panes (in another terminal)
tmux list-panes -a

# Switch to specific pane (in tmux)
Ctrl+B Arrow Keys    # Navigate between panes
Ctrl+B %             # Split pane horizontally
Ctrl+B "             # Split pane vertically
Ctrl+B z             # Zoom/unzoom pane
Ctrl+B c             # Create new window
Ctrl+B n/p           # Next/previous window
```

### Detaching and Reattaching

```bash
# Detach from tmux session (keep it running)
Ctrl+B d

# Reattach to your session later
tmux attach

# Or specify which session
tmux attach -t 0
```

### Monitoring Multiple Projects

For different projects on different ports:

```bash
# Project 1
tmux new -s project1
opencode --port 4096

# Detach and create Project 2
Ctrl+B d
tmux new -s project2
opencode --port 4097

# Switch between projects
tmux switch -t project1
tmux switch -t project2
```

---

## Troubleshooting

### Tmux Integration Not Working

**Problem:** No panes are spawning

**Solutions:**
1. **Verify tmux integration is enabled:**
   ```bash
    cat ~/.config/opencode/oh-my-opencode-slim.json | grep tmux # (or .jsonc)
   ```

2. **Check port configuration:**
   ```bash
   # Ensure port matches
   echo $OPENCODE_PORT  # Should be 4096 by default
   opencode --port 4096 # Should match
   ```

3. **Verify you're running inside tmux:**
   ```bash
   echo $TMUX  # Should show something, not empty
   ```

4. **Check OpenCode logs:**
   ```bash
   tail -f ~/.config/opencode/logs/opencode.log
   ```

### Ghost Panes and Orphaned Processes

**Problem:** Tmux panes remain open after tasks complete, or `opencode attach` processes accumulate

**This issue is fixed in the latest version.** The session lifecycle now properly closes panes and terminates processes.

**To verify the fix is working:**
```bash
# After running some background tasks, check for orphans
ps aux | grep "opencode attach" | grep -v grep
# Should return no results

# Check active tmux panes
tmux list-panes
# Should only show your main session pane(s)
```

**If you still see orphaned processes:**
1. **Kill all orphaned processes:**
   ```bash
   pkill -f "opencode attach"
   ```

2. **Close all ghost panes:**
   ```bash
   # In tmux, close panes manually
   tmux kill-pane -t <pane-id>
   ```

3. **Restart OpenCode** with the updated plugin

**Technical Details:**
The fix implements proper session lifecycle management:
- `session.abort()` is called after task completion
- Graceful shutdown with Ctrl+C before killing panes
- Event handlers for `session.deleted` events
- Automatic cleanup of tmux panes and processes

See [AGENTS.md](../AGENTS.md) for implementation details.

### Port Conflicts

**Problem:** "Port already in use" or agents not connecting

**Solutions:**
1. **Use a different port:**
   ```bash
   export OPENCODE_PORT=5000
   opencode --port 5000
   ```

2. **Kill existing OpenCode processes:**
   ```bash
   pkill -f "opencode"
   ```

3. **Check for conflicting services:**
   ```bash
   netstat -tulpn | grep 4096
   ```

### Tmux Session Issues

**Problem:** Can't create or attach to tmux sessions

**Solutions:**
1. **Install tmux:**
   ```bash
   # Ubuntu/Debian
   sudo apt install tmux

   # macOS
   brew install tmux

   # Or use the package manager that comes with your distribution
   ```

2. **Check tmux version:**
   ```bash
   tmux -V  # Should be 1.8 or higher
   ```

3. **Reset tmux configuration:**
   ```bash
   rm -f ~/.tmux.conf
   tmux kill-server
   tmux
   ```

### Layout Problems

**Problem:** Panes don't arrange as expected

**Solutions:**
1. **Try different layouts:**
   ```json
   {
     "tmux": {
       "enabled": true,
       "layout": "tiled",
       "main_pane_size": 40
     }
   }
   ```

2. **Manual layout adjustment:**
   ```bash
   # In tmux, resize panes
   Ctrl+B Alt+Arrow Keys
   ```

3. **Clear all panes and restart:**
   ```bash
   tmux kill-pane -a
   # Restart OpenCode
   ```

### Performance Issues

**Problem:** Too many panes or slow performance

**Solutions:**
1. **Reduce pane size for main window:**
   ```json
   {
     "tmux": {
       "enabled": true,
       "layout": "main-vertical",
       "main_pane_size": 40
     }
   }
   ```

2. **Limit background tasks:**
   ```bash
   # In OpenCode, use fewer parallel operations
   # Or configure agents to be more sequential
   ```

3. **Clean up old panes:**
   ```bash
   # Kill all panes except current
   tmux kill-pane -a
   ```

---

## Advanced Usage

### Custom Tmux Configuration

Create `~/.tmux.conf` for custom behavior:

```bash
# Enable mouse support
set -g mouse on

# Custom key bindings
bind-key r source-file ~/.tmux.conf

# Better colors
set -g default-terminal "screen-256color"

# Status bar customization
set -g status-right "#H %Y-%m-%d %H:%M"

# Pane navigation
bind h select-pane -L
bind j select-pane -D
bind k select-pane -U
bind l select-pane -R
```

### Monitoring Multiple Agents

Watch specific agents more closely:

```bash
# Monitor all agent panes
watch -n 1 'tmux list-panes -a -F "#{pane_current_command} (#{pane_index})"'

# Watch OpenCode output specifically
tmux list-panes -a | grep opencode

# Monitor background tasks
tmux list-panes -a | grep background
```

### Integration with Background Tasks

The plugin provides background task tools that work seamlessly with tmux:

| Tool | Description | Tmux Integration |
|------|-------------|------------------|
| `background_task` | Launch agents asynchronously | Spawns panes for monitoring |
| `background_output` | Check task results | Output appears in panes |
| `background_cancel` | Stop running tasks | Cleans up panes |

### Scripting and Automation

```bash
#!/bin/bash
# Auto-start script for OpenCode with tmux

# Create dedicated session
tmux new -d -s opencode

# Start OpenCode in the session
tmux send-keys -t opencode:0 'opencode --port 4096' Enter

# Wait and attach
sleep 2
tmux attach -t opencode
```

### Log Monitoring

```bash
# Monitor OpenCode logs in real-time
tmux split-window -h
tmux send-keys 'tail -f ~/.config/opencode/logs/opencode.log' Enter

# Switch back to main pane
tmux select-pane -L
```

### Custom Layouts

Create custom pane arrangements:

```bash
# In tmux, create a 3-pane layout
tmux split-window -h
tmux split-window -v
tmux select-pane -L

# Save the layout
tmux save-buffer ~/my-layout.txt

# Restore later
tmux load-buffer ~/my-layout.txt
```

---

## Best Practices

### Session Management
- Use named sessions for different projects
- Detach when not actively monitoring
- Clean up unused sessions periodically

### Performance
- Use `main-vertical` or `main-horizontal` layouts for better focus
- Adjust `main_pane_size` based on your screen resolution
- Limit parallel agent operations for complex tasks

### Development Workflow
1. Start tmux session for your project
2. Launch OpenCode with tmux integration enabled
3. Monitor agent activities as they work
4. Detach when done, reattach to check progress
5. Clean up panes after completing work

### Debugging
- Use `Ctrl+B z` to zoom into specific panes
- Check logs when agents aren't responding
- Verify port configuration when switching between projects

---

## Additional Resources

- **Official Tmux Documentation:** https://github.com/tmux/tmux/wiki
- **Quick Reference:** [docs/quick-reference.md#tmux-integration](quick-reference.md#tmux-integration)
- **Background Tasks:** [docs/quick-reference.md#background-tasks](quick-reference.md#background-tasks)
- **OpenCode Documentation:** https://opencode.ai/docs