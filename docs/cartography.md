# Cartography Skill

Cartography is a **custom skill** bundled with this repo.

It helps agents quickly build a high-quality mental model of an unfamiliar codebase by generating a structured *codemap* and tracking changes over time.

## What it does

Cartography is designed for repository understanding and hierarchical codemap generation:

1. Selects relevant code/config files using LLM judgment
2. Creates `.slim/cartography.json` for change tracking
3. Generates `codemap.md` templates (per folder) for explorers to fill in

## How to use

Cartography is installed automatically by the `oh-my-opencode-slim` installer when custom skills are enabled.

### Run it (manual / local)

From a repo root (or with an explicit `--root`):

```bash
# Initialize mapping
python3 cartographer.py init --root /repo --include "src/**/*.ts" --exclude "node_modules/**"

# Check what changed
python3 cartographer.py changes --root /repo

# Update hashes
python3 cartographer.py update --root /repo
```

## Outputs

### `.slim/cartography.json`

A change-tracking file with hashes for files/folders.

### `codemap.md` (per folder)

Empty templates created in each folder so an Explorer-style agent can fill in:

- Responsibility
- Design patterns
- Data/control flow
- Integration points

## Screenshot

The existing screenshot lives in `img/cartography.png`.

![Cartography screenshot](../img/cartography.png)

## Related

- `src/skills/cartography/README.md` and `src/skills/cartography/SKILL.md` contain the skill’s internal docs.
- `codemap.md` at the repo root is an example output/starting point.
