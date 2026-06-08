# Skills

Skills are specialized capabilities you can assign to agents. Unlike MCPs (which are running servers), skills are **prompt-based tool configurations** — instructions injected into an agent's system prompt that describe how to use a particular tool.

Bundled skills are installed by the `oh-my-opencode-slim` installer.

---

## Available Skills

### Bundled in repo

| Skill | Description | Assigned to by default |
|-------|-------------|----------------------|
| [`simplify`](#simplify) | Behavior-preserving code simplification | `oracle` |
| [`codemap`](#codemap) | Repository codemap generation | `orchestrator` |
| [`clonedeps`](#clonedeps) | Local dependency source cloning | `orchestrator` |
| [`deepwork`](#deepwork) | Heavy/complex coding sessions workflow | `orchestrator` |
| [`oh-my-opencode-slim`](#oh-my-opencode-slim) | Plugin configuration and self-improvement guidance | `orchestrator` |

---

## simplify

**Behavior-preserving simplification for readability and maintainability.**

`simplify` is a bundled skill for clarity-focused refactoring without behavior changes. It helps `oracle` reduce unnecessary complexity, improve naming and structure, and keep simplification work scoped and reviewable.

By default, this skill is assigned to `oracle`, which owns code review, maintainability review, and simplification guidance. The `orchestrator` should route simplification requests to `oracle` instead of handling them as a top-level specialty itself.

Source: adapted from Addy Osmani's `code-simplification` skill and bundled locally as `simplify`.

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

## deepwork

**Heavy/complex coding sessions and large modifications workflow.**

`deepwork` is an orchestrator-only workflow skill for managing deep architectural work, multi-phase implementations, and complex refactoring. It provides a structured approach with mandatory review gates while maintaining flexibility in planning.

Start it directly with:

```text
/deepwork <heavy coding task>
```

**How it works:**
1. Orchestrator creates a session artifact at `.slim/deepwork/<task>.md`
2. Draft plan → Oracle review → Revise until acceptable
3. Create phased implementation plan → Oracle review
4. Execute phase by phase with validation
5. After each phase: validate → Oracle review → fix issues → continue

**Key features:**
- Persistent session state in markdown files
- Mandatory oracle reviews at plan and phase boundaries
- Oracle phase reviews include simplify/readability feedback alongside regular correctness and risk review
- V2 scheduler integration (dispatch specialists, wait for hook-driven completion, reconcile)
- OpenCode todo lists for progress tracking
- Flexible structure - orchestrator adapts format to task needs

**When to use:** Large-scale refactoring, multi-file architectural changes, complex feature development spanning modules.

**When NOT to use:** Simple single-file edits, trivial bug fixes, quick one-off changes.

---

## oh-my-opencode-slim

**Configure, customize, and safely improve this plugin setup.**

`oh-my-opencode-slim` is an orchestrator-only skill that teaches agents how to
configure the plugin itself: model presets, custom agents, agent prompts,
`orchestratorPrompt` delegation hints, skills, MCP permissions, optional agents,
and related OpenCode config files.

It is installed by default with the bundled skills and is available to the
Orchestrator through the default `skills: ["*"]` configuration.

The skill also tells the Orchestrator to notice repeatable workflow friction and
suggest safe config or prompt improvements. It must ask before changing config or
prompts unless the user explicitly requested the exact edit, and it reminds users
that OpenCode may need a restart for config, prompt, agent, skill, MCP, or plugin
changes to take effect.

Typical requests:

```text
Tune my oh-my-opencode-slim models for lower cost.
Add a custom API reviewer agent.
Make the Orchestrator more conservative about parallel writer agents.
Help me configure MCP access for Librarian only.
```

After config changes, expect guidance like:

```text
This should apply on the next OpenCode run; restart OpenCode if you need it immediately.
```

---

## Skills Assignment

Control which skills each agent can use in `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`):

| Syntax | Meaning |
|--------|---------|
| `["*"]` | All installed skills |
| `["*", "!codemap"]` | All skills except `codemap` |
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
        "skills": []
      },
      "fixer": {
        "skills": []
      }
    }
  }
}
```
