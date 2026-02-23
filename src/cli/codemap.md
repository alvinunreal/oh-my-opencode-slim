# CLI Module Codemap

## Responsibility

The `src/cli/` directory provides the command-line interface for installing and configuring **omoslim**, an OpenCode plugin. It handles:

- **Installation orchestration**: Interactive and non-interactive installation flows
- **Configuration management**: Reading, parsing, and writing OpenCode configuration files
- **Skill management**: Installing recommended skills (via npx) and custom skills (bundled)
- **Provider configuration**: Setting up model mappings for different AI providers (Kimi, OpenAI, Zen)
- **System integration**: Detecting OpenCode installation, validating environment

## Design

### Architecture Pattern

The CLI module follows a **layered architecture** with clear separation of concerns:

```
┌─────────────────────────────────────────┐
│         index.ts (Entry Point)          │
│    - Argument parsing                    │
│    - Command routing                     │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│         install.ts (Orchestrator)       │
│    - Interactive TUI                     │
│    - Installation workflow               │
│    - Step-by-step execution              │
└─────────────────┬───────────────────────┘
                  │
    ┌─────────────┼─────────────┐
    │             │             │
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
  [key: string];
}
```

Represents the main OpenCode configuration file (`opencode.json`/`opencode.jsonc`).

**InstallConfig** (`types.ts`):
```typescript
interface InstallConfig {
  hasKimi: boolean;
  hasOpenAI: boolean;
  hasOpencodeZen: boolean;
  hasTmux: boolean;
  installSkills: boolean;
  installCustomSkills: boolean;
}
```

User preferences collected during installation.

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

Skills installed via `npx skills add` from external repositories.

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
   - Rename to target path (atomic operation)
   - Backup existing file (`.bak`) before writes

2. **JSONC Support** (`config-io.ts`):
   - Strip comments (single-line `//` and multi-line `/* */`)
   - Remove trailing commas
   - Parse as standard JSON

3. **Provider Priority** (`providers.ts`):
   - Kimi > OpenAI > Zen-free (fallback)
   - Hybrid mode: Kimi for orchestrator/designer, OpenAI for oracle

4. **Skill Permission Model** (`skills.ts`):
   - Orchestrator gets `*` (all skills)
   - Other agents get role-specific skills
   - Wildcard support (`*`, `!skill`)

## Flow

### Installation Flow

```
User runs: bunx omoslim install
         │
         ▼
┌─────────────────────────────────────────┐
│ index.ts: parseArgs()                   │
│ - Parse CLI arguments                   │
│ - Validate --no-tui mode requirements   │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│ install.ts: install()                   │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ Interactive Mode (--tui, default)   │ │
│ │ 1. Check OpenCode installed         │ │
│ │ 2. Ask user questions (TUI)         │ │
│ │    - Kimi access?                   │ │
│ │    - OpenAI access?                 │ │
│ │    - Install recommended skills?    │ │
│ │    - Install custom skills?         │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ Non-Interactive Mode (--no-tui)     │ │
│ │ - Validate all required flags       │ │
│ │ - Convert args to InstallConfig     │ │
│ └─────────────────────────────────────┘ │
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
│      addPluginToOpenCodeConfig()        │
│      - Parse existing config            │
│      - Add 'omoslim'        │
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
│         - Determine active preset       │
│         - Build agent configurations    │
│         - Map models to agents          │
│         - Assign skills per agent       │
│         - Add MCPs per agent            │
│                                         │
│ Step 5: Install recommended skills      │
│   └─> skills.ts: installSkill()        │
│      - npx skills add <repo>            │
│      - Run post-install commands        │
│                                         │
│ Step 6: Install custom skills           │
│   └─> custom-skills.ts:                 │
│      installCustomSkill()               │
│      - Copy from src/skills/            │
│      - To ~/.config/opencode/skills/    │
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
│ - Check for kimi provider               │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│ Parse omoslim.json          │
│ - Extract preset name                   │
│ - Check agent models for OpenAI/Zen     │
│ - Check tmux.enabled flag               │
└─────────────────────────────────────────┘
```

### Model Mapping Flow

```
generateLiteConfig() [providers.ts]
         │
         ▼
┌─────────────────────────────────────────┐
│ Determine active preset                 │
│ - hasKimi → 'kimi'                      │
│ - hasOpenAI → 'openai'                  │
│ - else → 'zen-free'                     │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│ For each agent (orchestrator, oracle,   │
│ librarian, explorer, designer, fixer):  │
│                                         │
│ 1. Get model from MODEL_MAPPINGS        │
│ 2. Apply hybrid logic (if needed)       │
│ 3. Assign skills:                       │
│    - Orchestrator: '*'                  │
│    - Others: role-specific skills       │
│ 4. Add MCPs from DEFAULT_AGENT_MCPS     │
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

### Internal Dependencies

```
index.ts
  └─> install.ts
       ├─> config-io.ts
       │    ├─> paths.ts
       │    └─> providers.ts
       ├─> custom-skills.ts
       ├─> skills.ts
       └─> system.ts

config-manager.ts (barrel)
  ├─> config-io.ts
  ├─> paths.ts
  ├─> providers.ts
  └─> system.ts
```

### Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| `opencode.json` | `~/.config/opencode/` | Main OpenCode config |
| `opencode.jsonc` | `~/.config/opencode/` | Main config with comments |
| `omoslim.json` | `~/.config/opencode/` | Plugin-specific config |

### Consumers

1. **End Users**: Via `bunx omoslim install`
2. **OpenCode**: Reads generated configs to load plugin and agents
3. **CI/CD**: Via `--no-tui` flag for automated installations

### Data Flow Summary

```
User Input (CLI args or TUI)
         │
         ▼
InstallConfig (preferences)
         │
         ├─> OpenCodeConfig (main config)
         │    - Plugin registration
         │    - Agent disabling
         │
         └─> LiteConfig (plugin config)
              - Preset selection
              - Model mappings
              - Skill assignments
              - MCP configurations
              - Tmux settings
```

## Key Files Reference

| File | Lines | Purpose |
|------|-------|---------|
| `index.ts` | 68 | CLI entry point, argument parsing |
| `install.ts` | 402 | Installation orchestration, TUI |
| `config-io.ts` | 251 | Config file I/O, JSONC parsing |
| `providers.ts` | 110 | Model mappings, config generation |
| `skills.ts` | 132 | Recommended skills management |
| `custom-skills.ts` | 99 | Bundled skills management |
| `paths.ts` | 48 | Path resolution utilities |
| `system.ts` | 53 | System checks (OpenCode, tmux) |
| `types.ts` | 40 | TypeScript type definitions |
| `config-manager.ts` | 5 | Barrel exports |