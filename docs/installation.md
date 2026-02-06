# Installation Guide

Complete installation instructions for oh-my-opencode-slim.

## Table of Contents

- [For Humans](#for-humans)
- [For LLM Agents](#for-llm-agents)
- [Troubleshooting](#troubleshooting)
- [Uninstallation](#uninstallation)

---

## For Humans

### Quick Install

Run the interactive installer:

```bash
bunx oh-my-opencode-slim@latest install
```

Or use non-interactive mode:

```bash
bunx oh-my-opencode-slim@latest install --no-tui --kimi=yes --openai=yes --antigravity=yes --chutes=yes --opencode-free=yes --opencode-free-model=auto --tmux=no --skills=yes
```

### Provider Options

The installer supports multiple providers:
- **OpenCode Free Models**: Live-refreshed free `opencode/*` models
- **Kimi For Coding**: High-performance coding models
- **OpenAI**: GPT-4 and GPT-3.5 models
- **Antigravity (Google)**: Claude 4.5 and Gemini 3 models via Google's infrastructure
- **Chutes**: Free daily-capped models (`chutes/*`) with dynamic role-aware selection

When OpenCode free mode is enabled, the installer runs:

```bash
opencode models --refresh --verbose
```

It then filters to free `opencode/*` models only, picks a coding-first primary model, and picks a support model for search/implementation agents.

Enable during installation:
```bash
bunx oh-my-opencode-slim install --kimi=yes --openai=yes --antigravity=yes --chutes=yes --opencode-free=yes --opencode-free-model=auto
```

### After Installation

Authenticate with your providers:

```bash
opencode auth login
# Select your provider → Complete OAuth flow
# Repeat for each provider you enabled
```

Once authenticated, run opencode and `ping all agents` to verify all agents respond.

> **💡 Tip: Models are fully customizable.** The installer sets sensible defaults, but you can assign *any* model to *any* agent. Edit `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc` for comments support) to override models, adjust reasoning effort, or disable agents entirely. See [Configuration](quick-reference.md#configuration) for details.

### Alternative: Ask Any Coding Agent

Paste this into Claude Code, AmpCode, Cursor, or any coding agent:

```
Install and configure by following the instructions here:
https://raw.githubusercontent.com/alvinunreal/oh-my-opencode-slim/refs/heads/master/README.md
```

---

## For LLM Agents

If you're an LLM Agent helping set up oh-my-opencode-slim, follow these steps.

### Step 1: Check OpenCode Installation

```bash
opencode --version
```

If not installed, direct the user to https://opencode.ai/docs first.

### Step 2: Ask About Provider Access

Ask these questions **one at a time**, waiting for responses:

1. "Do you have access to **Kimi For Coding**?" *(Provides Kimi k1.5 models)*
2. "Do you have access to **OpenAI** API?" *(Enables `openai/` models)*
3. "Do you have access to **Antigravity (Google)**?" *(Enables `google/` models via Antigravity)*
4. "Do you want to use **Chutes**?" *(Enables `chutes/` models with daily-cap aware selection)*
5. "Do you want to use **OpenCode free models**?" *(Refreshes and selects from free `opencode/*` models)*

Help the user understand the tradeoffs:
- OpenCode free mode discovers the latest free `opencode/*` models using `opencode models --refresh --verbose`.
- OpenCode-only mode can assign more than one OpenCode model across agents.
- Hybrid mode can combine OpenCode free models with OpenAI, Kimi, and/or Antigravity.
- In hybrid mode, `designer` remains on the external provider mapping.
- Chutes selection prioritizes stronger models for orchestrator/oracle and higher-cap models for support agents.
- Kimi For Coding provides powerful coding models.
- OpenAI enables `openai/` models.
- Antigravity (Google) provides Claude and Gemini models via Google infrastructure.
- Chutes provides free daily-capped models and requires `CHUTES_API_KEY`.

### Step 3: Run the Installer

Based on answers, run:

```bash
bunx oh-my-opencode-slim@latest install --no-tui --kimi=<yes|no> --openai=<yes|no> --antigravity=<yes|no> --chutes=<yes|no> --opencode-free=<yes|no> --opencode-free-model=<id|auto> --tmux=<yes|no> --skills=<yes|no>
```

**Examples:**
```bash
# Kimi + OpenAI + Antigravity
bunx oh-my-opencode-slim@latest install --no-tui --kimi=yes --openai=yes --antigravity=yes --chutes=yes --opencode-free=yes --opencode-free-model=auto --tmux=no --skills=yes

# OpenAI only
bunx oh-my-opencode-slim@latest install --no-tui --kimi=no --openai=yes --antigravity=no --chutes=no --opencode-free=no --tmux=no --skills=yes

# OpenCode free models only (auto-select)
bunx oh-my-opencode-slim@latest install --no-tui --kimi=no --openai=no --antigravity=no --chutes=no --opencode-free=yes --opencode-free-model=auto --tmux=no --skills=yes

# OpenCode free models + OpenAI (manual primary model)
bunx oh-my-opencode-slim@latest install --no-tui --kimi=no --openai=yes --antigravity=no --chutes=no --opencode-free=yes --opencode-free-model=opencode/gpt-5-nano --tmux=no --skills=yes
```

The installer automatically:
- Adds the plugin to `~/.config/opencode/opencode.json`
- Generates agent model mappings in `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`)

**Crucial Advice for the User:**
- They can easily assign **different models to different agents** by editing `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`).
- If they add a new provider later, they just need to update this file.
- Read generated `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`) file and report the model configuration.

### Step 4: Authenticate with Providers

**For Kimi (if enabled):**
Ask user to run the following command.
Don't run it yourself, it requires user interaction.
```bash
opencode auth login
# Select "Kimi For Coding" provider and complete OAuth flow
```

**For OpenAI (if enabled):**
Ask user to run the following command.
Don't run it yourself, it requires user interaction.
```bash
opencode auth login
# Select your provider and complete OAuth flow
```

**For Antigravity (if enabled):**
Ask user to run the following command.
Don't run it yourself, it requires user interaction.
```bash
opencode auth login
# Select "Antigravity (Google)" provider and complete OAuth flow
```

---

## Troubleshooting

### Installer Fails

Check the expected config format:
```bash
bunx oh-my-opencode-slim@latest install --help
```

Then manually create the config files at:
- `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`)

### Agents Not Responding

1. Check your authentication:
   ```bash
   opencode auth status
   ```

2. Verify your config file exists and is valid:
   ```bash
   cat ~/.config/opencode/oh-my-opencode-slim.json
   ```

3. Check that your provider is configured in `~/.config/opencode/opencode.json`

### Authentication Issues

If providers are not working:

1. Check your authentication status:
   ```bash
   opencode auth status
   ```

2. Re-authenticate if needed:
   ```bash
   opencode auth login
   ```

3. Verify your config file has the correct provider configuration:
   ```bash
   cat ~/.config/opencode/oh-my-opencode-slim.json
   ```

### Tmux Integration Not Working

Make sure you're running OpenCode with the `--port` flag and the port matches your `OPENCODE_PORT` environment variable:

```bash
tmux
export OPENCODE_PORT=4096
opencode --port 4096
```

See the [Quick Reference](quick-reference.md#tmux-integration) for more details.

---

## Uninstallation

1. **Remove the plugin from your OpenCode config**:

   Edit `~/.config/opencode/opencode.json` and remove `"oh-my-opencode-slim"` from the `plugin` array.

2. **Remove configuration files (optional)**:
   ```bash
   rm -f ~/.config/opencode/oh-my-opencode-slim.json
   rm -f .opencode/oh-my-opencode-slim.json
   ```

3. **Remove skills (optional)**:
   ```bash
   npx skills remove simplify
   npx skills remove agent-browser
   ```
