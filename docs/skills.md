# Skills

Skills are specialized capabilities and workflows you can assign to agents.
Unlike MCPs (which are running servers), skills are **prompt-based instructions**
injected into an agent's system prompt to guide decisions, workflows, and, when
relevant, tool use.

Bundled skills are installed by the `oh-my-opencode-slim` installer and safely
reconciled on plugin startup/auto-update. Local customizations are preserved;
new bundled versions for customized skills are staged under
`~/.config/opencode/.oh-my-opencode-slim/skill-updates/` for manual review.

---

## Available Skills

### Bundled in repo

| Skill | Description | Assigned to by default |
|-------|-------------|----------------------|
| [`simplify`](#simplify) | Behavior-preserving code simplification | `oracle` |
| [`codemap`](#codemap) | Repository codemap generation | `orchestrator` |
| [`clonedeps`](#clonedeps) | Local dependency source cloning | `orchestrator` |
| [`deepwork`](#deepwork) | Heavy/complex coding sessions workflow | `orchestrator` |
| [`verification-planning`](#verification-planning) | Design project-specific evidence before implementation | `orchestrator` |
| [`reflect`](#reflect) | Review repeated work and suggest reusable workflow improvements | `orchestrator` |
| [`worktrees`](#worktrees) | Safe Git worktree lane management | `orchestrator` |
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
- **Instant onboarding** - understand unfamiliar codebases in seconds
- **Efficient context** - agents read architectural summaries, saving tokens and improving accuracy
- **Change detection** - only modified folders are re-analyzed
- **Timeless documentation** - focuses on high-level design, not implementation details

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

`deepwork` is an orchestrator-only workflow skill for managing deep architectural work, multi-phase implementations, and complex refactoring. It provides a structured approach with risk-based review gates while maintaining flexibility in planning.

Start it directly with:

```text
/deepwork <heavy coding task>
```

**How it works:**
1. Before planning, delegation, or state creation, inspect `.gitignore` and
   `.ignore`; add only missing entries (without duplicates) for
   `.slim/deepwork/` in `.gitignore` and `!.slim/deepwork/` plus
   `!.slim/deepwork/**` in `.ignore`. This keeps state git-local while making it
   readable to OpenCode.
2. Orchestrator creates a session artifact at `.slim/deepwork/<task>.md`
3. Draft a phased implementation plan with a small number of coherent phases
   based on dependencies and natural delivery boundaries. Do not split work
   merely to make an Oracle review smaller.
4. Before execution, show a compact overview of phase order, specialist
   ownership/scope, the Oracle review total, the review after each phase, and a
   short reason for each gate.
5. Execute phase by phase: validate, update session state, then get an Oracle
   review before advancing.
6. Batch material findings into one bounded remediation pass with focused
   validation. Re-review only when needed to assess a changed decision/risk or
   an otherwise unverifiable concern.

**Key features:**
- Persistent session state in markdown files
- Predictable Oracle reviews after each planned phase, declared before execution
- V2 scheduler integration (dispatch specialists, wait for hook-driven completion, reconcile)
- OpenCode todo lists for progress tracking
- Flexible structure - orchestrator adapts format to task needs

**When to use:** Large-scale refactoring, multi-file architectural changes, complex feature development spanning modules.

**When NOT to use:** Simple single-file edits, trivial bug fixes, quick one-off changes.

---

## verification-planning

**Design project-specific evidence before non-trivial implementation.**

`verification-planning` is an orchestrator-only skill for planning how a
non-trivial implementation, bug fix, refactor, multi-layer change, or externally
visible behavior will be proven before work begins. It starts with the claim to
establish, its uncertainty and failure modes, then generates evidence paths from
the system's controllable inputs, state transitions, boundaries, artifacts,
invariants, reversibility, and repeatability rather than defaulting to familiar
methods.

When the system cannot expose decisive truth clearly enough, the skill may add a
verification affordance: the smallest temporary or durable capability that makes
the relevant state controllable, observable, repeatable, and diagnosable for an
agent. This lets the agent improve the system's legibility instead of accepting
weak, indirect evidence.

It selects the narrowest path by credibility, signal quality, cost, safety, and
independent inspectability or repeatability. When relevant project facilities or
constraints are unfamiliar or rapidly changing, it asks `@librarian` for focused
official and project-specific research before deciding; it does not seek generic
testing advice or research when current evidence is already decisive.

**When NOT to use:** tiny mechanical edits. It complements ordinary verification
and deepwork, does not prescribe a default mechanism, and requires approval for
verification-only dependencies, persistent instrumentation, production debug
surfaces, or structural changes. Temporary support is removed; durable support
needs a clear justification. Completed work reports what was established and its
limitations.

---

## reflect

**Learn from repeated work and suggest practical workflow improvements.**

`reflect` is an orchestrator-only workflow skill for reviewing recent work,
finding repeated workflow friction, and recommending the smallest useful reusable
asset. It may suggest a skill, custom agent, command, config rule, prompt rule,
MCP permission change, or project playbook - but only when there is enough
evidence.

Use it directly with:

```text
/reflect
/reflect release workflow and checks
```

You can also use natural prompts such as:

```text
reflect on my recent workflows
find repeated work worth turning into reusable instructions
suggest skills or agent config improvements from what I keep doing
```

Reflect is intentionally conservative. If no repeated workflow is strong enough,
it should recommend creating nothing instead of manufacturing new assets.

**When to use:** recurring workflow friction, repeated manual processes, repeated
agent-routing preferences, or prompts/config rules that you keep re-explaining.

**When NOT to use:** one-off implementation tasks, speculative agent creation,
or broad self-improvement ideas with no usage evidence.

---

## worktrees

**Safe Git worktree lane management for isolated coding.**

`worktrees` is an orchestrator-only skill for managing Git worktrees as safe,
isolated coding lanes. Instead of polluting your current branch or juggling stash
state, the Orchestrator can set up lanes under `.slim/worktrees/<slug>/` and
track them in `.slim/worktrees.json`.

Other agents can be delegated tasks inside the worktree lane, but the Orchestrator coordinates the lifecycle, validation, and final integration.

Safety defaults:
- Pre-flight check on Git repo status and dirty worktrees.
- Strict confirmation gates for all git modifications (`worktree add/remove`, `merge`, `rebase`, `cherry-pick`, `reset --hard`, branch operations).
- Branch names default to `omo/<slug>` but respect custom user patterns.
- Automated diff validation and compilation/test check before final integration.

See **[Worktrees](worktrees.md)** for the detailed safety protocol.

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
