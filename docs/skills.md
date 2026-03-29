# Skills

Skills are specialized capabilities you can assign to agents. Unlike MCPs (which are running servers), skills are **prompt-based tool configurations** — instructions injected into an agent's system prompt that describe how to use a particular tool.

Skills are installed via the `oh-my-opencode-slim` installer or manually with `npx skills add`.

---

## Available Skills

### Recommended (via installer)

| Skill | Description | Assigned to by default |
|-------|-------------|----------------------|
| [`simplify`](#simplify) | YAGNI code simplification expert | `orchestrator` |
| [`agent-browser`](#agent-browser) | High-performance browser automation | `designer` |

### Bundled in repo

| Skill | Description | Assigned to by default |
|-------|-------------|----------------------|
| [`cartography`](#cartography) | Repository codemap generation | `orchestrator` |

---

## simplify

**The Minimalist's sacred truth: every line of code is a liability.**

`simplify` is a specialized skill for complexity analysis and YAGNI enforcement. It identifies unnecessary abstractions, over-engineered patterns, and redundant code — and suggests minimal, direct implementations instead.

---

## agent-browser

**External browser automation for visual verification and testing.**

`agent-browser` provides full high-performance browser automation. It allows agents to browse the web, interact with page elements, take screenshots, and verify visual state — useful for UI/UX work, end-to-end testing, and researching live documentation.

---

## cartography

**Automated repository mapping through hierarchical codemaps.**

`cartography` empowers the Orchestrator to build and maintain a deep architectural understanding of any codebase. Instead of reading thousands of lines of code on every task, agents refer to hierarchical `codemap.md` files describing the *why* and *how* of each directory.

**How to use:** Ask the Orchestrator to `run cartography`. It automatically detects whether to initialize a new map or update an existing one.

**Why it's useful:**
- **Instant onboarding** — understand unfamiliar codebases in seconds
- **Efficient context** — agents read architectural summaries, saving tokens and improving accuracy
- **Change detection** — only modified folders are re-analyzed
- **Timeless documentation** — focuses on high-level design, not implementation details

See **[Cartography Skill](cartography.md)** for full documentation including manual commands and technical details.

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
        "skills": ["*", "!agent-browser"]
      },
      "designer": {
        "skills": ["agent-browser", "simplify"]
      },
      "fixer": {
        "skills": []
      }
    }
  }
}
```
