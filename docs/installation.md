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
bunx oh-my-opencode-slim@latest install --no-tui --background-subagents=yes
```

### Configuration Options

Run `bunx oh-my-opencode-slim@latest install --help` for the full flag list.
Common options: `--preset=<openai|opencode-go>` (default `openai`),
`--background-subagents=ask|yes|no`, `--background-subagents-target=<path>`,
`--no-tui`, `--dry-run`, `--reset`.

When invoked through `bunx` with a tag other than `latest` or an exact version,
the installer pins the resolved package version in OpenCode's configuration.
`npx` does not expose that request in its cache path, so its entry is unpinned.

### Background Subagents Environment Setup

On OpenCode v1, background orchestration is the default workflow. It depends on OpenCode's
native background subagents, enabled by two exports the installer offers to add
to your shell startup file (the prompt defaults to yes):

```bash
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
OPENCODE_ENABLE_EXA=1
```

The Exa flag enables OpenCode's built-in `websearch` tool without an API key.
Pass `--background-subagents=no` to skip the exports. `--no-tui` skips them
unless `--background-subagents=yes` or `ask` is explicitly supplied. OpenCode v2
does not need these installer-managed exports.

After the installer updates a shell startup file, restart your terminal or source
the file before launching OpenCode. Examples:

```bash
source "${ZDOTDIR:-$HOME}/.zshrc"
# or
source ~/.bashrc
```

For a one-shot manual launch without restarting your terminal:

```bash
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true OPENCODE_ENABLE_EXA=1 opencode
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

The installer generates both OpenAI and OpenCode Go presets, with OpenAI active by default (using variant-aware GPT-6 models, including `gpt-6.1-sol` at `medium` for Orchestrator, `high` for Oracle, and `low` for Fixer, and `gpt-6-luna` variants for Explorer and Designer). To make OpenCode Go active during install, run `bunx oh-my-opencode-slim@latest install --preset=opencode-go`. That preset uses Minimax-M3 for Orchestrator, so the installer also enables Observer with `opencode-go/mimo-v2.5` for visual analysis. To switch providers later or build a mixed setup, use **[Configuration Reference](configuration.md)** for the full option reference and the preset docs for copyable examples.

Bundled skills are registered at plugin load — v1 scans their package paths,
while v2 registers them in-process. Nothing is copied to the user skill directory,
and plugin updates apply on the next OpenCode restart. Skills listed in
`disabled_skills` are not registered. A same-named skill directory under
`~/.config/opencode/skills/` overrides the bundled version (directory sources
take precedence over plugin registrations).

Then:

```bash
opencode auth login
# Select your provider and complete OAuth flow
```

```bash
opencode models --refresh
```

On OpenCode v2, use `opencode models` instead.

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
bunx oh-my-opencode-slim@latest install --no-tui
```

**Examples:**
```bash
# Interactive install
bunx oh-my-opencode-slim@latest install

# Non-interactive
bunx oh-my-opencode-slim@latest install --no-tui --background-subagents=yes

# Make the generated OpenCode Go preset active
bunx oh-my-opencode-slim@latest install --preset=opencode-go

# Force overwrite existing configuration
bunx oh-my-opencode-slim@latest install --reset
```

The installer automatically:
- Adds the plugin to `opencode.json` or `opencode.jsonc` in
  `$OPENCODE_CONFIG_DIR` when set, otherwise `~/.config/opencode`
- Disables default OpenCode agents
- Enables OpenCode LSP integration when no explicit `lsp` setting exists
- On v1, configures `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` when approved
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
2. Refresh models: `opencode models --refresh` on v1, `opencode models` on v2
3. On v1, restart the terminal or source the shell file updated by the installer
   (`source "${ZDOTDIR:-$HOME}/.zshrc"` or `source ~/.bashrc`), then start OpenCode: `opencode`
   - On v1, a one-shot alternative is `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode`
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

1. **Keep existing config**: The installer will skip the configuration step and continue with other operations (like adding the plugin).

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

If background tasks never return task IDs, or delegation behaves like a
blocking foreground call, check your OpenCode version. The steps below apply to
v1; v2 does not use this environment variable.

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

   In `~/.config/opencode/opencode.json`, remove any `disable: true` entries under `agent.explore` and `agent.general` (older installers added these). The plugin disables those built-in subagents at runtime, with or without installer entries. To keep an agent enabled, declare an entry under its name — `agents.<name>` on v2, `agent.<name>` on v1/legacy — that does not itself set `disable`/`disabled: true`.

4. Remove the environment variable:

   The installer may have added an export to your shell startup file. Remove the `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` line from your shell config:
   - `${ZDOTDIR:-$HOME}/.zshrc` (Zsh)
   - `~/.bashrc` (Bash)
   - `~/.config/fish/conf.d/opencode-background-subagents.fish` (Fish) — also remove `set -gx OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS true`

   The installer also writes `OPENCODE_ENABLE_EXA=1` to the same startup files (and `set -gx OPENCODE_ENABLE_EXA 1` in the Fish conf); remove those lines too.

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

7. Bundled skills are provided by the plugin and disappear when it is removed. For legacy copies under `~/.config/opencode/skills/`, review the files and remove only those you no longer need; removing the plugin prevents its migration cleanup from running.

8. Remove the desktop companion binary (if installed):

   The companion is optional and not installed by default. If you installed it:
   ```bash
   rm -rf ~/.local/share/opencode/storage/oh-my-opencode-slim
   ```

### Verify

Run `opencode auth status` and confirm oh-my-opencode-slim agents no longer appear.
