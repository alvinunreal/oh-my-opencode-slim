# CLI Module Codemap

## Responsibility

The `src/cli/` directory provides the command-line interface for installing and configuring **oh-my-opencode-slim**, an OpenCode plugin. It handles:

- **Installation orchestration**: Interactive (TUI) and non-interactive (`--no-tui`) installation flows
- **Configuration management**: Reading, parsing (JSONC support), and writing OpenCode configuration files with atomic writes
- **Skill management**: Installing recommended skills (via `npx skills add`) and custom bundled skills (copied from `src/skills/`)
- **Provider configuration**: Generating model mappings for 4 supported AI providers: OpenAI, Kimi, GitHub Copilot, ZAI Coding Plan
- **System integration**: Detecting OpenCode/tmux installation, validating environment, retrieving versions

## Design

### Architecture Pattern

The CLI module follows a **layered architecture** with clear separation of concerns:

```
┌─────────────────────────────────────────┐
│         index.ts (Entry Point)          │
│    - Shebang (#!/usr/bin/env bun)       │
│    - Argument parsing                   │
│    - Command routing                    │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│         install.ts (Orchestrator)        │
│    - Installation workflow               │
│    - Step-by-step execution              │
│    - Formatted console output            │
└─────────────────┬───────────────────────┘
                  │
     ┌────────────┼────────────┐
     │            │            │
┌───▼────┐  ┌────▼────┐  ┌────▼──────┐
│ config │  │ skills  │  │  system   │
│  -io   │  │         │  │           │
│ paths  │  │custom   │  │           │
 │providers│ │         │  │           │
└────────┘  └─────────┘  └────────────┘
```

### Key Abstractions

#### 1. **Configuration Abstraction**

**OpenCodeConfig** (`types.ts`):
```typescript
interface OpenCodeConfig {
  plugin?: string[];
  provider?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  [key: string]: unknown;
}
```

Represents the main OpenCode configuration file (`opencode.json`/`opencode.jsonc`).

**InstallConfig** (`types.ts`):
```typescript
interface InstallConfig {
  hasTmux: boolean;
  installSkills: boolean;
  installCustomSkills: boolean;
  dryRun?: boolean;
  reset: boolean;
}
```

User preferences collected during installation.

**DetectedConfig** (`types.ts`):
```typescript
interface DetectedConfig {
  isInstalled: boolean;
  hasKimi: boolean;
  hasOpenAI: boolean;
  hasAnthropic?: boolean;
  hasCopilot?: boolean;
  hasZaiPlan?: boolean;
  hasAntigravity: boolean;
  hasChutes?: boolean;
  hasOpencodeZen: boolean;
  hasTmux: boolean;
}
```

Runtime detection of installed providers and features.

#### 2. **Skill Abstractions**

**RecommendedSkill** (`skills.ts`):
```typescript
interface RecommendedSkill {
  name: string;
  repo: string;
  skillName: string;
  allowedAgents: string[];
  description: string;
  postInstallCommands?: string[];
}
```

Skills installed via `npx skills add` from external GitHub repositories.

**CustomSkill** (`custom-skills.ts`):
```typescript
interface CustomSkill {
  name: string;
  description: string;
  allowedAgents: string[];
  sourcePath: string;
}
```

Skills bundled in the repository, copied directly to `~/.config/opencode/skills/`.

**PermissionOnlySkill** (`skills.ts`):
```typescript
interface PermissionOnlySkill {
  name: string;
  allowedAgents: string[];
  description: string;
}
```

Externally-managed skills requiring permission grants but NOT installed by this CLI.

#### 3. **Result Abstraction**

**ConfigMergeResult** (`types.ts`):
```typescript
interface ConfigMergeResult {
  success: boolean;
  configPath: string;
  error?: string;
}
```

Standardized result type for configuration operations.

### Design Patterns

1. **Atomic Write Pattern** (`config-io.ts`):
   - Write to temporary file (`.tmp`)
   - Rename to target path (atomic filesystem operation)
   - Backup existing file (`.bak`) before writes

2. **JSONC Support** (`config-io.ts`):
   - Strip comments (single-line `//` and multi-line `/* */`) via regex
   - Remove trailing commas before closing braces/brackets
   - Parse as standard JSON

3. **Provider Model Mapping** (`providers.ts`):
   - Four providers: `openai`, `kimi`, `copilot`, `zai-plan`
   - Each agent receives role-specific model + variant assignments
   - Default preset always uses OpenAI

4. **Skill Permission Model** (`skills.ts`):
   - Orchestrator receives `*` (all skills allowed)
   - Other agents receive role-specific skill permissions
   - Wildcard support: `*` (allow all), `!skill` (explicit deny)

5. **Path Resolution Priority** (`paths.ts`):
   - `OPENCODE_CONFIG_DIR` env var (custom directory)
   - `XDG_CONFIG_HOME` env var
   - Fallback: `~/.config/opencode`

## Flow

### Installation Flow

```
User runs: bunx oh-my-opencode-slim install [--no-tui] [--tmux=yes|no] [--skills=yes|no] [--dry-run] [--reset]
          │
          ▼
┌─────────────────────────────────────────┐
│ index.ts: parseArgs()                   │
│ - Parse CLI arguments                   │
│ - Route to install()                    │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│ install.ts: install()                   │
│ - Convert InstallArgs to InstallConfig  │
│ - Call runInstall(config)               │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│ install.ts: runInstall()                │
│                                         │
│ Step 1: Check OpenCode installation     │
│   └─> system.ts: isOpenCodeInstalled() │
│                                         │
│ Step 2: Add plugin to config            │
│   └─> config-io.ts:                     │
│      addPluginToOpenCodeConfig()       │
│      - Parse existing config (JSONC)   │
│      - Add 'oh-my-opencode-slim'       │
│      - Remove old versions              │
│      - Atomic write                     │
│                                         │
│ Step 3: Disable default agents          │
│   └─> config-io.ts:                     │
│      disableDefaultAgents()             │
│      - Set agent.explore.disable=true   │
│      - Set agent.general.disable=true   │
│                                         │
│ Step 4: Write lite config               │
│   └─> config-io.ts: writeLiteConfig()   │
│      └─> providers.ts:                  │
│         generateLiteConfig()            │
│         - Use OpenAI preset by default │
│         - Build agent configs           │
│         - Map models to agents          │
│         - Assign skills per agent       │
│         - Add MCPs per agent            │
│         - Add tmux config if enabled    │
│                                         │
│ Step 5: Install recommended skills     │
│   └─> skills.ts: installSkill()        │
│      - npx skills add <repo>           │
│      - Run post-install commands       │
│                                         │
│ Step 6: Install custom skills           │
│   └─> custom-skills.ts:                 │
│      installCustomSkill()               │
│      - Copy from src/skills/           │
│      - To ~/.config/opencode/skills/   │
│                                         │
│ Step 7: Print summary & next steps      │
└─────────────────────────────────────────┘
```

### Configuration Detection Flow

```
detectCurrentConfig() [config-io.ts]
         │
         ▼
┌─────────────────────────────────────────┐
│ Parse opencode.json/jsonc               │
│ - Check for plugin entry                │
│ - Check for provider entries            │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│ Parse oh-my-opencode-slim.json/jsonc   │
│ - Extract preset name                   │
│ - Check agent models for providers     │
│ - Check tmux.enabled flag               │
└─────────────────────────────────────────┘
```

### Config Generation Flow

```
generateLiteConfig() [providers.ts]
         │
         ▼
┌─────────────────────────────────────────┐
│ Always use 'openai' as default preset   │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│ For each agent (orchestrator, oracle,  │
│ librarian, explorer, designer, fixer):  │
│                                         │
│ 1. Get model + variant from MAPPING     │
│ 2. Assign skills:                      │
│    - Orchestrator: '*'                  │
│    - Designer: include agent-browser   │
│    - Others: role-specific skills       │
│ 3. Add MCPs from DEFAULT_AGENT_MCPS    │
└─────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│ If hasTmux: add tmux config object     │
│   - enabled: true                       │
│   - layout: 'main-vertical'             │
│   - main_pane_size: 60                  │
└─────────────────────────────────────────┘
```

## Integration

### External Dependencies

| Module | Dependency | Purpose |
|--------|-----------|---------|
| `system.ts` | `opencode` CLI | Check installation, get version |
| `skills.ts` | `npx skills` | Install recommended skills |
| `skills.ts` | `npm` | Install agent-browser globally |
| `skills.ts` | `agent-browser` CLI | Install browser automation |
| `system.ts` | `tmux` CLI | Check tmux installation |
| `providers.ts` | `DEFAULT_AGENT_MCPS` | MCP configurations per agent |

### Internal Dependencies

```
index.ts
   └─> install.ts
        ├─> config-io.ts (functions: addPluginToOpenCodeConfig, detectCurrentConfig, 
        │                 disableDefaultAgents, writeLiteConfig)
        ├─> providers.ts (function: generateLiteConfig)
        ├─> custom-skills.ts (CUSTOM_SKILLS, installCustomSkill)
        ├─> skills.ts (RECOMMENDED_SKILLS, installSkill)
        ├─> paths.ts (getExistingLiteConfigPath)
        └─> system.ts (isOpenCodeInstalled, getOpenCodeVersion, getOpenCodePath)

config-io.ts
   ├─> paths.ts (ensureConfigDir, ensureOpenCodeConfigDir, getExistingConfigPath, getLiteConfig)
   └─> providers.ts (generateLiteConfig)

custom-skills.ts
   └─> paths.ts (getConfigDir)

providers.ts
   ├─> ../config/agent-mcps (DEFAULT_AGENT_MCPS)
   └─> skills.ts (RECOMMENDED_SKILLS)

skills.ts
   └─> custom-skills.ts (CUSTOM_SKILLS)
```

### Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| `opencode.json` | `~/.config/opencode/` | Main OpenCode config |
| `opencode.jsonc` | `~/.config/opencode/` | Main config with comments |
| `oh-my-opencode-slim.json` | `~/.config/opencode/` | Plugin-specific lite config |

### Supported Providers (MODEL_MAPPINGS)

| Provider | Orchestrator | Oracle | Librarian | Explorer | Designer | Fixer |
|----------|--------------|--------|-----------|----------|----------|-------|
| `openai` | gpt-5.4 | gpt-5.4 (high) | gpt-5.4-mini (low) | gpt-5.4-mini (low) | gpt-5.4-mini (medium) | gpt-5.4-mini (low) |
| `kimi` | k2p5 | k2p5 (high) | k2p5 (low) | k2p5 (low) | k2p5 (medium) | k2p5 (low) |
| `copilot` | claude-opus-4.6 | claude-opus-4.6 (high) | grok-code-fast-1 (low) | grok-code-fast-1 (low) | gemini-3.1-pro-preview (medium) | claude-sonnet-4.6 (low) |
| `zai-plan` | glm-5 | glm-5 (high) | glm-5 (low) | glm-5 (low) | glm-5 (medium) | glm-5 (low) |

### Consumers

1. **End Users**: Via `bunx oh-my-opencode-slim install`
2. **OpenCode**: Reads generated configs to load plugin and agents
3. **CI/CD**: Via `--no-tui` flag for automated installations

### Data Flow Summary

```
User Input (CLI args: --tmux, --skills, --dry-run, --reset)
         │
         ▼
InstallConfig (preferences)
         │
         ├─> OpenCodeConfig (main config)
         │    - Plugin registration ('oh-my-opencode-slim')
         │    - Agent disabling (explore, general)
         │
         └─> LiteConfig (plugin config)
              - Preset: 'openai' (always)
              - Model mappings per agent
              - Skill assignments per agent
              - MCP configurations per agent
              - Tmux settings (if enabled)
```

## Key Files Reference

| File | Lines | Purpose |
|------|-------|---------|
| `index.ts` | 75 | CLI entry point, argument parsing, shebang |
| `install.ts` | 269 | Installation orchestration, console UI |
| `config-manager.ts` | 4 | Re-export barrel (config-io, paths, providers, system) |
| `config-io.ts` | 287 | Config file I/O, JSONC parsing, atomic writes |
| `providers.ts` | 101 | MODEL_MAPPINGS, config generation |
| `skills.ts` | 178 | Recommended/permission-only skills management |
| `custom-skills.ts` | 98 | Bundled skills management |
| `paths.ts` | 91 | Path resolution utilities |
| `system.ts` | 143 | System checks (OpenCode, tmux, version) |
| `types.ts` | 43 | TypeScript type definitions |

## Skill Registry

### Recommended Skills (installed via npx)

| Name | Repo | Agents | Description |
|------|------|--------|-------------|
| `simplify` | brianlovin/claude-config | oracle | YAGNI code simplification expert |
| `agent-browser` | vercel-labs/agent-browser | designer | High-performance browser automation |

### Custom Bundled Skills (copied from src/skills/)

| Name | Source | Agents | Description |
|------|--------|--------|-------------|
| `cartography` | src/skills/cartography | orchestrator, explorer | Repository understanding and hierarchical codemap generation |

### Permission-Only Skills (external, not installed)

| Name | Agents | Description |
|------|--------|-------------|
| `requesting-code-review` | oracle | Code review template for reviewer subagents |
