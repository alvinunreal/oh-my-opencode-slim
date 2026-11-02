# src/cli/

## Responsibility

CLI entry point and command-line interface for the oh-my-opencode-slim plugin. Provides installation, configuration, and diagnostic commands for setting up and managing the OpenCode plugin. Manages agent skill installation, configuration generation, and shell integration for background subagents.

## Design

The CLI follows a command pattern with two primary commands:
- `install`: Sets up the plugin with OpenCode (adds plugin to config, configures background subagents, writes configuration)
- `doctor`: Diagnoses plugin configuration issues and validates setup
- `companion install`: Standalone desktop companion install (downloads the binary, enables `companion` in the existing config)

### Architecture Pattern: Command Router

- **index.ts**: Routes CLI arguments to appropriate command handlers (install/doctor)
- **install.ts**: Orchestrates multi-step installation workflow
- **doctor.ts**: Validates configuration and environment (includes multiplexer validation)
- **types.ts**: Shared CLI argument and configuration types
- **eval.ts**: Source-checkout eval entry point (run, offline scoring, diff,
  precheck, manual collection). Uses `src/evals/suite-runner.ts`,
  `auto-collect.ts`, `eval-server.ts`, and `git-lifecycle.ts`; not an installed
  plugin runtime command. See `docs/evals.md`.

### Configuration Management Pattern

- **config-io.ts**: Installer/config generation workflows; shared JSONC parsing and locked atomic writes are imported from `src/config/`
- **../config/paths.ts**: Canonical user/project config path lookup used by both CLI and runtime; no CLI forwarding path Module
- **providers.ts**: Generates configuration presets and manages model mappings for different providers
- **system.ts**: Resolves the `opencode` binary path (Windows-aware `where`/`which` + shell handling) and related system checks

### Permission and Skill Management

- **custom-skills.ts**: Bundled skill discovery and safe cleanup of legacy copies
- **skills.ts**: Agent permission management for skills (allow/ask/deny rules, includes PERMISSION_ONLY_SKILLS for externally managed skills)

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
1. Parse install arguments (preset, background subagents, etc.)
2. Check OpenCode installation
3. Add plugin and default LSP setting to OpenCode configuration
4. On v1, add the TUI badge (tui.json/tui.jsonc)
5. On v1, warm the plugin cache for package manager installations
6. On v1, configure background subagents (shell integration)
7. Write oh-my-opencode-slim configuration
```

OpenCode's built-in `general`/`explore` subagents are disabled at runtime by
the plugin itself (#1582); the installer no longer writes config entries.

### Configuration Resolution Flow (../config/paths.ts)

```
1. Determine config directory:
   - OPENCODE_CONFIG_DIR environment variable (highest priority)
   - XDG_CONFIG_HOME/opencode
   - ~/.config/opencode (default)
2. Resolve file paths:
   - Last opencode.jsonc/opencode.json defining `plugin`; otherwise prefer .jsonc
   - oh-my-opencode-slim.jsonc → oh-my-opencode-slim.json (fallback)
   - tui.jsonc → tui.json (fallback)
```

### Configuration Generation Flow (providers.ts)

```
1. Generate configuration presets for supported providers:
   - openai (default)
   - opencode-go
2. Map agents to models with variants:
   - orchestrator → high-capacity model
   - oracle → high variant
   - explorer → low variant
   - designer → medium variant
   - fixer → low variant
3. Apply skill permissions based on agent role
4. Generate final configuration with schema URL
```

### Background Subagents Integration (background-subagents.ts)

```
1. Detect shell type (bash/zsh/fish)
2. Determine target file:
   - bash/zsh: ~/.bashrc or ${ZDOTDIR:-$HOME}/.zshrc
   - fish: ~/.config/fish/conf.d/opencode-background-subagents.fish
3. Write environment variable export:
   - export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
4. Persist across shell sessions
```

### Doctor Diagnostics Flow (doctor.ts)

```
1. Parse command line arguments
2. Check user and project configuration files exist and are valid JSON/JSONC
3. Load and validate agent preset configurations
4. Validate schema compliance for all configuration files
5. Perform multiplexer-specific validation (collectMultiplexerIssues)
6. Generate human-readable or JSON-formatted diagnostic reports
```

### Skill Permissions Flow (skills.ts)

```
1. Resolve agent skill permissions based on:
   - Default granted skills per agent type (getDefaultGrantedSkillNames)
   - User-configured skill lists (skillList parameter)
   - Disabled skills (disabledSkillNames parameter)
2. Build effective permissions using skill directives:
   - Base skills + added skills - removed skills (resolveEffectiveSkills)
3. Return permission grants as 'allow' | 'ask' | 'deny' for each skill
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
- **External skills**: Permission-only entries for skills not installed by CLI (`PERMISSION_ONLY_SKILLS` array)

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
- `--preset=<name>`: Select configuration preset (default: openai)
- `--background-subagents=ask|yes|no`: Configure background subagents (default: ask)
- `--background-subagents-target=<path>`: Specify shell startup file
- `--no-tui`: Non-interactive mode
- `--dry-run`: Simulate installation
- `--reset`: Force overwrite existing configuration
- `-h, --help`: Show help

**Available presets:** openai, opencode-go

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
- Multiplexer block validation
- Agent skill permissions
