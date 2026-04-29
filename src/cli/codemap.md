# CLI Module Codemap

## Responsibility

`src/cli/` provides the plugin installation workflow and the utilities that generate and persist runtime configuration.

Current responsibilities:

- parse/install command arguments
- install-time validation and environment checks
- OpenCode configuration mutation (atomic)
- lite config generation for provider/agent presets
- optional skill installation and bundled-skill copying

## Design

### Command surface

- `src/cli/index.ts` only dispatches:
  - `install` subcommand and flags
    - `--skills=yes|no`
    - `--preset=<name>`
    - `--no-tui`
    - `--dry-run`
    - `--reset`
    - `--help`

The CLI is intentionally non-interactive-only now; it prints usage and steps to stdout with exit codes.

### Module decomposition

- `paths.ts`: config directory and file discovery (`opencode.json`/`.jsonc`, lite config path).
- `config-io.ts`: JSON/JSONC parsing, normalize write behavior, atomic writes (`.tmp` + `.bak`), plugin registration, default-agent disabling.
- `providers.ts`: provider model mapping + `generateLiteConfig()`.
- `system.ts`: OpenCode binary/version/path checks.
- `skills.ts`: recommended and permission-only skill metadata and install behavior (`npx skills add`).
- `custom-skills.ts`: bundled skill registry and copy-to-config-directory implementation.
- `config-manager.ts`: re-export barrel for CLI config utilities.
- `install.ts`: end-to-end install orchestration and console messaging.
- `types.ts`: install/config DTOs.

## Flow

```text
CLI install command
  └─> install.ts (runInstall)
      1) check OpenCode installed
      2) add plugin entry to main OpenCode config
      3) disable legacy default agents
      4) write/preview generated lite config
      5) optional install phase:
         - installSkill(...) for each RECOMMENDED_SKILL
         - installCustomSkill(...) for each CUSTOM_SKILL
```

`generateLiteConfig(installConfig)` behavior:

- sets `$schema`, a selected `preset` that defaults to `openai`
- always materializes generated presets `openai` and `opencode-go`
- install-time `--preset` only selects between generated presets
- maps each built-in agent name to provider-specific model/variant
- injects skill list from recommended + custom skill registries and ensures `agent-browser` for designer
- injects default MCP sets from `DEFAULT_AGENT_MCPS`
- includes tmux block (`layout`, `main_pane_size`) when enabled

`writeLiteConfig()` writes target file atomically and supports `--reset`/dry-run branching in `install.ts`.

## Runtime integration

- Output file produced by install (`oh-my-opencode-slim.json`) is consumed by runtime `config/loader.ts`.
- Permission defaults for installed/available skills are shared with `agents/index.ts` via `cli/skills.ts`.
- Generated provider/multiplexer settings are consumed by OpenCode session runtime via `src/index.ts` bootstrap.

## Notes for architecture/docs accuracy

- The previous TUI references are stale; no dedicated interactive flow exists in current sources.
- `installSkills` in config covers both recommended external and bundled/custom skills as separate paths.
- Built-in preset support includes `openai`, `opencode-go`, `kimi`, `copilot`, and `zai-plan`.
