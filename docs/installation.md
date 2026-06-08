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
bunx oh-my-opencode-slim@latest install --no-tui --skills=yes --background-subagents=yes
```

### Configuration Options

The installer supports the following options:

| Option | Description |
|--------|-------------|
| `--skills=yes|no` | Install bundled skills (default: yes) |
| `--preset=<name>` | Active generated config preset: `openai` or `opencode-go` (default: `openai`) |
| `--no-tui` | Non-interactive mode |
| `--dry-run` | Simulate install without writing files |
| `--reset` | Force overwrite of existing configuration |
| `--background-subagents=ask\|yes\|no` | Configure `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` in your shell startup file (`ask` by default only in an interactive TTY; otherwise `no`) |
| `--background-subagents-target=<path>` | Write the background-subagents export to a specific shell/profile file |

### Background Subagents Environment Setup

Background orchestration is the default workflow. It depends on OpenCode's native
background subagents, which are enabled by this environment variable:

```bash
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
```

The installer can add that export to your shell startup file. Use one of:

```bash
# Ask before editing a shell startup file (default in interactive TTY only)
bunx oh-my-opencode-slim@latest install --background-subagents=ask

# Always configure the export when possible
bunx oh-my-opencode-slim@latest install --background-subagents=yes

# Do not modify shell startup files
bunx oh-my-opencode-slim@latest install --background-subagents=no

# Write to an explicit target file
bunx oh-my-opencode-slim@latest install \
  --background-subagents=yes \
  --background-subagents-target="$HOME/.zshrc"
```

After the installer updates a shell startup file, restart your terminal or source
the file before launching OpenCode. Examples:

```bash
source ~/.zshrc
# or
source ~/.bashrc
```

For a one-shot manual launch without changing shell files:

```bash
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode
```

### Non-Destructive Behavior

By default, the installer is non-destructive. If an `oh-my-opencode-slim.json` configuration file already exists, the installer will **not** overwrite it. Instead, it will display a message:

```
[i] Configuration already exists at ~/.config/opencode/oh-my-opencode-slim.json. Use --reset to overwrite.
```

To force overwrite of your existing configuration, use the `--reset` flag:

```bash
bunx oh-my-opencode-slim@latest install --reset
```

**Note:** When using `--reset`, the installer creates a `.bak` backup file before overwriting, so your previous configuration is preserved.

### After Installation

The installer generates both OpenAI and OpenCode Go presets, with OpenAI active by default (using `gpt-5.5` and `gpt-5.4-mini` models). To make OpenCode Go active during install, run `bunx oh-my-opencode-slim@latest install --preset=opencode-go`. That preset uses GLM-5.1 for Orchestrator, so the installer also enables Observer with `opencode-go/kimi-k2.6` for visual analysis. To switch providers later or build a mixed setup, use **[Configuration Reference](configuration.md)** for the full option reference and the preset docs for copyable examples.

Then:

```bash
opencode auth login
# Select your provider and complete OAuth flow
```

```bash
opencode models --refresh
```

Open your generated config at `~/.config/opencode/oh-my-opencode-slim.json`
and adjust models if needed.

Then run OpenCode and verify the agents:

```text
ping all agents
```

> **💡 Tip: Models are fully customizable.** The installer sets sensible defaults, but you can assign *any* model to *any* agent. Edit `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc` for comments support) to override models, adjust reasoning effort, or disable agents entirely.

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

### Step 2: Run the Installer

The installer generates OpenAI and OpenCode Go presets, with OpenAI active by default:

```bash
bunx oh-my-opencode-slim@latest install --no-tui --skills=yes --background-subagents=yes
```

**Examples:**
```bash
# Interactive install
bunx oh-my-opencode-slim@latest install

# Non-interactive with bundled skills
bunx oh-my-opencode-slim@latest install --no-tui --skills=yes --background-subagents=yes

# Non-interactive and configure background subagents env setup
bunx oh-my-opencode-slim@latest install --no-tui --background-subagents=yes

# Make the generated OpenCode Go preset active
bunx oh-my-opencode-slim@latest install --preset=opencode-go

# Non-interactive without skills
bunx oh-my-opencode-slim@latest install --no-tui --skills=no

# Force overwrite existing configuration
bunx oh-my-opencode-slim@latest install --reset
```

The installer automatically:
- Adds the plugin to `opencode.json` or `opencode.jsonc` in
  `$OPENCODE_CONFIG_DIR` when set, otherwise `~/.config/opencode`
- Disables default OpenCode agents
- Enables OpenCode LSP integration when no explicit `lsp` setting exists
- Configures `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` when approved
- Generates agent model mappings in the same OpenCode config directory as
  `oh-my-opencode-slim.json` (or `.jsonc`)

### Step 3: Authenticate with Providers

Ask user to run the following command. Don't run it yourself, it requires user interaction.

```bash
opencode auth login
# Select your provider and complete OAuth flow
```

### Step 4: Verify Installation

Ask the user to:

1. Authenticate: `opencode auth login`
2. Refresh models: `opencode models --refresh`
3. Restart the terminal or source the shell file updated by the installer
   (`source ~/.zshrc` or `source ~/.bashrc`), then start OpenCode: `opencode`
   - One-shot alternative: `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode`
4. Run: `ping all agents`

Verify all agents respond successfully.

**Crucial Advice for the User:**
- They can easily assign **different models to different agents** by editing `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`).
- If they want to add a different provider later (OpenCode Go, Kimi, GitHub Copilot, ZAI), they can update this file manually. See **[Configuration Reference](configuration.md)** and the preset docs for examples.
- Read the generated `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`) file to understand the current configuration.

---

## Troubleshooting

### Installer Fails

Check the expected config format:
```bash
bunx oh-my-opencode-slim@latest install --help
```

Then manually create the config files at:
- `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`)

### Configuration Already Exists

If the installer reports that the configuration already exists, you have two options:

1. **Keep existing config**: The installer will skip the configuration step and continue with other operations (like adding the plugin or installing skills).

2. **Reset configuration**: Use `--reset` to overwrite:
   ```bash
   bunx oh-my-opencode-slim@latest install --reset
   ```
   A `.bak` backup file will be created automatically.

### Agents Not Responding

1. Check your authentication:
   ```bash
   opencode auth status
   ```

2. From your project root, verify your config file exists and is valid:
   ```bash
   bunx oh-my-opencode-slim@latest doctor
   ```

3. Check that your provider is configured in `~/.config/opencode/opencode.json`

### Missing Background Task Tools

If background tasks never
return task IDs, or delegation behaves like a blocking foreground call:

1. Confirm OpenCode was launched with the environment variable:
   ```bash
   env | grep OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
   ```
   It should show `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`.

   Also use an OpenCode release that includes native background
   subagents; run `opencode --version` and update OpenCode if background tasks are missing.

2. Restart your terminal or source the shell file the installer updated, then
   start OpenCode again. Plain `opencode` is only sufficient after that
   environment is active.

3. For a quick manual test, launch OpenCode with a one-shot export:
   ```bash
   OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode
   ```

4. If you intentionally skipped shell setup, rerun the installer with:
   ```bash
   bunx oh-my-opencode-slim@latest install --background-subagents=yes
   ```

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

### Editor Validation

Add a `$schema` reference to your config for autocomplete and inline validation:

```jsonc
{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",
  // your config...
}
```

Works in VS Code, Neovim (with `jsonls`), and any editor that supports JSON Schema. Catches typos and wrong nesting immediately.

### Tmux Integration Not Working

Make sure you're running OpenCode with the `--port` flag and the port matches your `OPENCODE_PORT` environment variable:

```bash
tmux
export OPENCODE_PORT=4096
opencode --port 4096
```

See the [Multiplexer Integration Guide](multiplexer-integration.md) for more details.

---

## Uninstallation

1. **Remove the plugin from your OpenCode config**:

   Edit `~/.config/opencode/opencode.json` and remove `"oh-my-opencode-slim"` from the `plugin` array.

2. **Remove configuration files (optional)**:
   ```bash
   rm -f ~/.config/opencode/oh-my-opencode-slim.json
   rm -f ~/.config/opencode/oh-my-opencode-slim.json.bak
   ```

3. **Remove skills (optional)**:
   ```bash
   rm -rf ~/.config/opencode/skills/simplify
   rm -rf ~/.config/opencode/skills/codemap
   rm -rf ~/.config/opencode/skills/clonedeps
   ```
