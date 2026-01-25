---
name: cartography
description: Repository understanding and hierarchical codemap generation
---

# Cartography Skill

You help users understand and map repositories by creating hierarchical codemaps.

## When to Use

- User asks to understand/map a repository
- User wants codebase documentation
- Starting work on an unfamiliar codebase

## Workflow

### Step 1: Check for Existing State

**First, check if `.slim/cartography.json` exists in the repo root.**

If it **exists**: Skip to Step 3 (Detect Changes) - no need to re-initialize.

If it **doesn't exist**: Continue to Step 2 (Initialize).

### Step 2: Initialize (Only if no state exists)

1. **Analyze the repository structure** - List files, understand directories
2. **Infer patterns** for **core code/config files ONLY** to include:
   - **Include**: `src/**/*.ts`, `package.json`, etc.
   - **Exclude (MANDATORY)**: Do NOT include tests, documentation, or translations.
     - Tests: `**/*.test.ts`, `**/*.spec.ts`, `tests/**`, `__tests__/**`
     - Docs: `docs/**`, `*.md` (except root `README.md` if needed), `LICENSE`
     - Build/Deps: `node_modules/**`, `dist/**`, `build/**`, `*.min.js`
   - Respect `.gitignore` automatically
3. **Run cartographer.py init**:

```bash
python3 ~/.config/opencode/skills/cartography/scripts/cartographer.py init \
  --root ./ \
  --include "src/**/*.ts" \
  --exclude "**/*.test.ts" --exclude "dist/**" --exclude "node_modules/**"
```

This creates:
- `.slim/cartography.json` - File and folder hashes for change detection
- Empty `codemap.md` files in all relevant subdirectories

4. **Delegate to Explorer agents** - Spawn one explorer per folder to read code and fill in its specific `codemap.md` file.

### Step 3: Detect Changes (If state already exists)

1. **Run cartographer.py changes** to see what changed:

```bash
python3 ~/.config/opencode/skills/cartography/scripts/cartographer.py changes \
  --root ./
```

2. **Review the output** - It shows:
   - Added files
   - Removed files
   - Modified files
   - Affected folders

3. **Only update affected codemaps** - Spawn one explorer per affected folder to update its `codemap.md`.
4. **Run update** to save new state:

```bash
python3 ~/.config/opencode/skills/cartography/scripts/cartographer.py update \
  --root ./
```

### Step 4: Finalize Repository Atlas (Root Codemap)

Once all specific directories are mapped, the Orchestrator must create or update the root `codemap.md`. This file serves as the **Master Entry Point** for any agent or human entering the repository.

1.  **Map Root Assets**: Document the root-level files (e.g., `package.json`, `index.ts`, `plugin.json`) and the project's overall purpose.
2.  **Aggregate Sub-Maps**: Create a "Repository Directory Map" section. For every folder that has a `codemap.md`, extract its **Responsibility** summary and include it in a table or list in the root map.
3.  **Cross-Reference**: Ensure that the root map contains the absolute or relative paths to the sub-maps so agents can jump directly to the relevant details.


## Codemap Content

Explorers are granted write permissions for `codemap.md` files during this workflow. Use precise technical terminology to document the implementation:

- **Responsibility** - Define the specific role of this directory using standard software engineering terms (e.g., "Service Layer", "Data Access Object", "Middleware").
- **Design Patterns** - Identify and name specific patterns used (e.g., "Observer", "Singleton", "Factory", "Strategy"). Detail the abstractions and interfaces.
- **Data & Control Flow** - Explicitly trace how data enters and leaves the module. Mention specific function call sequences and state transitions.
- **Integration Points** - List dependencies and consumer modules. Use technical names for hooks, events, or API endpoints.

Example codemap:

```markdown
# src/agents/

## Responsibility
Defines agent personalities and manages their configuration lifecycle.

## Design
Each agent is a prompt + permission set. Config system uses:
- Default prompts (orchestrator.ts, explorer.ts, etc.)
- User overrides from ~/.config/opencode/oh-my-opencode-slim.json
- Permission wildcards for skill/MCP access control

## Flow
1. Plugin loads → calls getAgentConfigs()
2. Reads user config preset
3. Merges defaults with overrides
4. Applies permission rules (wildcard expansion)
5. Returns agent configs to OpenCode

## Integration
- Consumed by: Main plugin (src/index.ts)
- Depends on: Config loader, skills registry
```

Example **Root Codemap (Atlas)**:

```markdown
# Repository Atlas: oh-my-opencode-slim

## Project Responsibility
A high-performance, low-latency agent orchestration plugin for OpenCode, focusing on specialized sub-agent delegation and background task management.

## System Entry Points
- `src/index.ts`: Plugin initialization and OpenCode integration.
- `package.json`: Dependency manifest and build scripts.
- `oh-my-opencode-slim.json`: User configuration schema.

## Directory Map (Aggregated)
| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `src/agents/` | Defines agent personalities (Orchestrator, Explorer) and manages model routing. | [View Map](src/agents/codemap.md) |
| `src/features/` | Core logic for tmux integration, background task spawning, and session state. | [View Map](src/features/codemap.md) |
| `src/config/` | Implements the configuration loading pipeline and environment variable injection. | [View Map](src/config/codemap.md) |
```
