# src/cli/

## Responsibility

CLI entry point and command-line interface for the oh-my-opencode-slim plugin. Provides installation, configuration, and diagnostic commands for setting up and managing the OpenCode plugin.

## Design

The CLI follows a command pattern with two primary commands:
- `install`: Sets up the plugin with OpenCode (adds plugin to config, configures background subagents, installs companion, writes configuration)
- `doctor`: Diagnoses plugin configuration issues and validates setup

### Architecture Pattern: Command Router
- **index.ts**: Routes CLI arguments to appropriate command handlers
- **install.ts**: Orchestrates multi-step installation workflow
- **doctor.ts**: Validates configuration and environment

### Configuration Management Pattern
- **config-io.ts**: Handles reading, parsing, and writing configuration files (supports both .json and .jsonc)
- **paths.ts**: Resolves configuration file paths across different environments (XDG_CONFIG_HOME, custom paths, defaults)
- **providers.ts**: Generates configuration presets and manages model mappings for different providers

### Permission and Skill Management
- **custom-skills.ts**: Registry of custom skills bundled with the plugin and their installation logic
- **skills.ts**: Agent permission management for skills (allow/ask/deny rules)

### Integration Management
- **background-subagents.ts**: Shell integration for OpenCode background subagents (persistent agent processes)
- **companion.ts**: Desktop companion binary installation and management

## Flow

### Command Flow: CLI Entry Point
```
1. CLI invoked (bunx oh-my-opencode-slim install/doctor)
2. index.ts parses arguments and routes to command handler
3. Command handler executes workflow
   - install: Runs multi-step installation process
   - doctor: Runs diagnostic checks
```

### Installation Workflow (install.ts)
```
1. Parse install arguments (preset, companion mode, background subagents, etc.)
2. Check OpenCode installation
3. Add plugin to OpenCode configuration (opencode.json/opencode.jsonc)
4. Add TUI version badge (tui.json/tui.jsonc)
5. Warm OpenCode plugin cache (for package manager installations)
6. Disable OpenCode default agents (explore, general)
7. Enable LSP integration by default
8. Configure background subagents (shell integration)
9. Install desktop companion (optional)
10. Write oh-my-opencode-slim configuration (oh-my-opencode-slim.json)
11. Install custom skills (if requested)
```

### Configuration Resolution Flow (paths.ts)
```
1. Determine config directory:
   - OPENCODE_CONFIG_DIR environment variable (highest priority)
   - XDG_CONFIG_HOME/opencode
   - ~/.config/opencode (default)
2. Resolve file paths:
   - opencode.json → opencode.jsonc → fallback to opencode.json
   - oh-my-opencode-slim.json → oh-my-opencode-slim.jsonc → fallback
   - tui.json → tui.jsonc → fallback
```

### Configuration Generation Flow (providers.ts)
```
1. Generate configuration presets for supported providers:
   - openai (default)
   - opencode-go
   - kimi
   - copilot
   - zai-plan
2. Map agents to models with variants:
   - orchestrator → high-capacity model
   - oracle → high variant
   - librarian/explorer → low variant
   - designer → medium variant
   - fixer → low variant
3. Apply skill permissions based on agent role
4. Generate final configuration with schema URL
```

### Background Subagents Integration (background-subagents.ts)
```
1. Detect shell type (bash/zsh/fish)
2. Determine target file:
   - bash/zsh: ~/.bashrc or ~/.zshrc
   - fish: ~/.config/fish/conf.d/opencode-background-subagents.fish
3. Write environment variable export:
   - export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
4. Persist across shell sessions
```

## Integration

### Consumed By
- **Main plugin**: src/index.ts loads CLI entry point via plugin initialization
- **OpenCode**: CLI commands are invoked by OpenCode's plugin system

### Dependencies
- **Config system**: src/config/ - Configuration loading and validation
- **Skills**: src/skills/ - Bundled custom skills registry
- **Companion**: src/companion/ - Desktop companion binary management
- **Utils**: src/utils/ - Cross-platform compatibility utilities

### Integration Points
- **OpenCode plugin system**: CLI commands integrate via OpenCode's command execution
- **Shell environment**: Background subagents modify shell startup files
- **Configuration files**: Atomic writes to user config directory (~/.config/opencode/)
- **Desktop companion**: Optional binary installation and configuration

### Permission Model
- **Orchestrator agent**: Granted all skills by default
- **Other agents**: Restricted permissions, explicit allow rules from custom skills registry
- **External skills**: Permission-only entries for skills not installed by CLI


### Configuration Files
| File | Purpose | Written By |
|------|---------|------------|
| opencode.json/opencode.jsonc | OpenCode main config | config-io.ts |
| tui.json/tui.jsonc | OpenCode TUI config | config-io.ts |
| oh-my-opencode-slim.json | Plugin-specific config | providers.ts |

## Commands

### `install` Command
Sets up oh-my-opencode-slim plugin with OpenCode.

**Usage:**
```bash
bunx oh-my-opencode-slim install [OPTIONS]
```

**Options:**
- `--skills=yes|no`: Install bundled skills (default: yes)
- `--companion=ask|yes|no`: Install desktop companion (default: ask)
- `--preset=<name>`: Select configuration preset (default: openai)
- `--background-subagents=ask|yes|no`: Configure background subagents (default: ask)
- `--background-subagents-target=<path>`: Specify shell startup file
- `--no-tui`: Non-interactive mode
- `--dry-run`: Simulate installation
- `--reset`: Force overwrite existing configuration
- `-h, --help`: Show help

**Available presets:** openai, opencode-go, kimi, copilot, zai-plan

### `doctor` Command
Diagnoses plugin configuration and environment.

**Usage:**
```bash
bunx oh-my-opencode-slim doctor [OPTIONS]
```

**Options:**
- `--json`: Print diagnostics as JSON
- `-h, --help`: Show help

**Checks:**
- Configuration file validity (user and project scopes)
- Preset existence and configuration
- JSON schema validation
- File existence and permissions
