# Codemap Skill

Repository understanding and hierarchical codemap generation.

## Overview

Codemap helps orchestrators map and understand codebases by:

1. Selecting relevant code/config files using LLM judgment
2. Creating `.slim/codemap.json` for change tracking
3. Generating empty `codemap.md` templates for fixers to fill in

Legacy `.slim/cartography.json` state is migrated to `.slim/codemap.json` automatically.

## Commands

```bash
# Initialize mapping
node codemap.mjs init --root /repo --include "src/**/*.ts" --exclude "node_modules/**"

# Check what changed
node codemap.mjs changes --root /repo

# Update hashes
node codemap.mjs update --root /repo
```

## Outputs

### .slim/codemap.json

```json
{
  "metadata": {
    "version": "1.0.0",
    "last_run": "2026-01-25T19:00:00Z",
    "include_patterns": ["src/**/*.ts"],
    "exclude_patterns": ["node_modules/**"]
  },
  "file_hashes": {
    "src/index.ts": "abc123..."
  },
  "folder_hashes": {
    "src": "def456..."
  }
}
```

### codemap.md (per folder)

Empty templates created in each folder for fixers to fill with:
- Responsibility
- Design patterns
- Data/control flow
- Integration points

## Installation

Installed automatically via oh-my-opencode-ultraslim installer when custom skills are enabled.
