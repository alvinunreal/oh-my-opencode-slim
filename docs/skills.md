# Skills

Skills are specialized capabilities you can assign to agents. Unlike MCPs (which are running servers), skills are **prompt-based tool configurations** — instructions injected into an agent's system prompt that describe how to use a particular tool.

Skills are installed via the `oh-my-opencode-slim` installer or manually with `npx skills add`.

---

## Available Skills

### Recommended (via installer)

| Skill | Description | Assigned to by default |
|-------|-------------|----------------------|
| [`agent-browser`](#agent-browser) | High-performance browser automation | `designer` |

### Bundled in repo

| Skill | Description | Assigned to by default |
|-------|-------------|----------------------|
| [`simplify`](#simplify) | Behavior-preserving code simplification | `oracle` |
| [`codemap`](#codemap) | Repository codemap generation | `orchestrator` |
| [`clonedeps`](#clonedeps) | Local dependency source cloning | `orchestrator` |

---

## simplify

**Behavior-preserving simplification for readability and maintainability.**

`simplify` is a bundled skill for clarity-focused refactoring without behavior changes. It helps `oracle` reduce unnecessary complexity, improve naming and structure, and keep simplification work scoped and reviewable.

By default, this skill is assigned to `oracle`, which owns code review, maintainability review, and simplification guidance. The `orchestrator` should route simplification requests to `oracle` instead of handling them as a top-level specialty itself.

Source: adapted from Addy Osmani's `code-simplification` skill and bundled locally as `simplify`.

---

## agent-browser

**External browser automation for visual verification and testing.**

`agent-browser` provides full high-performance browser automation. It allows agents to browse the web, interact with page elements, take screenshots, and verify visual state — useful for UI/UX work, end-to-end testing, and researching live documentation.

---

## codemap

**Automated repository mapping through hierarchical codemaps.**

`codemap` empowers the Orchestrator to build and maintain a deep architectural understanding of any codebase. Instead of reading thousands of lines of code on every task, agents refer to hierarchical `codemap.md` files describing the *why* and *how* of each directory.

**How to use:** Ask the Orchestrator to `run codemap`. It automatically detects whether to initialize a new map or update an existing one.

**Why it's useful:**
- **Instant onboarding** — understand unfamiliar codebases in seconds
- **Efficient context** — agents read architectural summaries, saving tokens and improving accuracy
- **Change detection** — only modified folders are re-analyzed
- **Timeless documentation** — focuses on high-level design, not implementation details

See **[Codemap Skill](codemap.md)** for full documentation including manual commands and technical details.

---

## clonedeps

**Local source mirroring for important project dependencies.**

`clonedeps` helps the Orchestrator clone a small, approved set of dependency
source repositories into `.slim/clonedeps/repos/` so OpenCode can inspect library
internals while keeping cloned code out of git.

The skill is assigned to `orchestrator`. The orchestrator may ask `@librarian`
to identify important dependencies and resolve official repository URLs/tags,
then asks for approval before cloning with direct git/filesystem operations.
There is intentionally no helper script; dependency discovery and ref validation
are handled by the orchestrator/librarian workflow so the skill works across
languages and repository types.

Before planning, the orchestrator checks `.slim/clonedeps.json` and reuses
existing clones when possible. After cloning, it adds or updates a concise
`## Cloned Dependency Source` section in root `AGENTS.md` that lists each
read-only cloned repo path directly with a one-sentence purpose.

Safety defaults:

- direct, important dependencies only;
- max 3-5 clones by default;
- HTTPS repositories only;
- pinned tags/commits only;
- no dependency scripts are executed;
- ignore-file edits are limited to managed marker blocks.

See **[Clonedeps](clonedeps.md)** for the full workflow and file layout.

---

## Skills Assignment

Control which skills each agent can use in `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`):

| Syntax | Meaning |
|--------|---------|
| `["*"]` | All installed skills |
| `["*", "!agent-browser"]` | All skills except `agent-browser` |
| `["simplify"]` | Only `simplify` |
| `[]` | No skills |
| `["!*"]` | Deny all skills |

**Rules:**
- `*` expands to all available installed skills
- `!item` excludes a specific skill
- Conflicts (e.g. `["a", "!a"]`) → deny wins (principle of least privilege)

**Example:**

```json
{
  "presets": {
    "my-preset": {
      "orchestrator": {
        "skills": ["codemap"]
      },
      "oracle": {
        "skills": ["simplify"]
      },
      "designer": {
        "skills": ["agent-browser"]
      },
      "fixer": {
        "skills": []
      }
    }
  }
}
```
