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
| `--companion=ask\|yes\|no` | Install and enable the desktop Companion (`ask` by default; prompt defaults to no) |
| `--preset=<name>` | Active generated config preset: `openai` or `opencode-go` (default: `openai`) |
| `--background-subagents=ask\|yes\|no` | Configure the required background-subagents environment export (`ask` by default; prompt defaults to yes) |
| `--background-subagents-target=<path>` | Write the background-subagents export to a specific shell/profile file |
| `--no-tui` | Non-interactive mode |
| `--dry-run` | Simulate install without writing files |
| `--reset` | Force overwrite of existing configuration |

### Background Subagents Environment Setup

Background orchestration is the default workflow. It depends on OpenCode's native
background subagents, which are enabled by this environment variable:

```bash
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
```

The installer asks before adding that export to your shell startup file. The
prompt defaults to `yes` because V2's default orchestration depends on it.

```bash
bunx oh-my-opencode-slim@latest install
```

For non-interactive setup, pass the choice explicitly:

```bash
bunx oh-my-opencode-slim@latest install --no-tui --background-subagents=yes
```

After the installer updates a shell startup file, restart your terminal or source
the file before launching OpenCode. Examples:

```bash
source ~/.zshrc
# or
source ~/.bashrc
```

For a one-shot manual launch without restarting your terminal:

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

The installer generates both OpenAI and OpenCode Go presets, with OpenAI active by default (using variant-aware GPT-5.6 models, including `gpt-5.6-terra (medium)` for Orchestrator, `gpt-5.6-sol (high)` for Oracle, `gpt-5.6-luna (medium)` for Fixer, and `gpt-5.6-luna` variants for other specialists). To make OpenCode Go active during install, run `bunx oh-my-opencode-slim@latest install --preset=opencode-go`. That preset uses Minimax-M3 for Orchestrator, so the installer also enables Observer with `opencode-go/mimo-v2.5` for visual analysis. To switch providers later or build a mixed setup, use **[Configuration Reference](configuration.md)** for the full option reference and the preset docs for copyable examples.

The plugin safely reconciles bundled skills on startup and after successful
auto-updates. Missing bundled skills are installed, and previously managed skills
are updated only when their local files still match a known plugin-installed
version. If you customized a skill locally, the plugin preserves your active copy
and stages the new bundled version under
`~/.config/opencode/.oh-my-opencode-slim/skill-updates/` for manual review.
Restart OpenCode after an auto-update to load the updated plugin and any changed
skills.

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
bunx oh-my-opencode-slim@latest install --no-tui --skills=yes
```

**Examples:**
```bash
# Interactive install
bunx oh-my-opencode-slim@latest install

# Non-interactive with bundled skills
bunx oh-my-opencode-slim@latest install --no-tui --skills=yes --background-subagents=yes

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

4. If shell setup was missing, rerun the installer:
   ```bash
   bunx oh-my-opencode-slim@latest install
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

### Required

1. Remove the plugin from your OpenCode config:

   Edit `~/.config/opencode/opencode.json` and remove `"oh-my-opencode-slim"` from the `plugin` array. If the installer enabled LSP (it only does so when no explicit `lsp` setting exists), set `"lsp": false` or remove the `"lsp"` key.

2. Remove the TUI badge:

   Edit `~/.config/opencode/tui.json` and remove `"oh-my-opencode-slim"` from the `plugin` array.

### Optional Cleanup

3. Re-enable default agents:

   In `~/.config/opencode/opencode.json`, remove the `disable: true` entries the installer added under `agent.explore` and `agent.general`.

4. Remove the environment variable:

   The installer may have added an export to your shell startup file. Remove the `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` line from your shell config:
   - `~/.zshrc` (Zsh)
   - `~/.bashrc` (Bash)
   - `~/.config/fish/conf.d/opencode-background-subagents.fish` (Fish) — also remove `set -gx OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS true`

   Restart your terminal or `source` the file.

5. Clear the plugin cache:
   ```bash
   rm -rf ~/.cache/opencode/packages/oh-my-opencode-slim@*
   ```

6. Remove configuration files:
   ```bash
   rm -f ~/.config/opencode/oh-my-opencode-slim.json
   rm -f ~/.config/opencode/oh-my-opencode-slim.json.bak
   ```

7. Remove skills installed by the installer:
   ```bash
   rm -rf ~/.config/opencode/skills/simplify
   rm -rf ~/.config/opencode/skills/codemap
   rm -rf ~/.config/opencode/skills/clonedeps
   rm -rf ~/.config/opencode/skills/deepwork
   rm -rf ~/.config/opencode/skills/reflect
   rm -rf ~/.config/opencode/skills/worktrees
   rm -rf ~/.config/opencode/skills/oh-my-opencode-slim
   ```

   > **Note:** The installer manages these specific skills. If you added others manually, they won't be affected.

8. Remove the desktop companion binary (if installed):

   The companion is optional and not installed by default. If you installed it:
   ```bash
   rm -rf ~/.local/share/opencode/storage/oh-my-opencode-slim
   ```

### Verify

Run `opencode auth status` and confirm oh-my-opencode-slim agents no longer appear.
