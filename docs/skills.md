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

## Verification and Review Budget

Use a proportionate final-state verification plan for each change. Run checks
required by repository and release instructions; add independent review or
broader evidence only when the change's risk or uncertainty warrants it.

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

**Tier-2 initiative planning and coordination protocol.**

`deepwork` is an orchestrator-only skill for consequential, high-stakes, or
long-horizon work. `/deepwork` is a user-entry adapter: the
parent/orchestrator is the sole lifecycle controller and coordinates the
protocol. Use it for every Tier-2 initiative (including single-unit work) and
for long-horizon Tier-1 coordination without Tier-2 gates. Risk and horizon
are separate axes; splitting a Tier-2 initiative into multiple delivery units
must not downgrade risk.

Start it directly with:

```text
/deepwork <heavy coding task>
```

**How it works:**
1. `/deepwork` directs the parent/orchestrator to load and follow the deepwork
   skill and coordinate it for the initiative. Slash commands are adapters;
   the parent coordinates the protocol. `/deepwork` is never a callable
   procedure.
2. Canonical records live in `.slim/plans/<initiative>/PLAN.md` and
   `REVIEW-LOG.md`. Do not create or use `.slim/deepwork/`.
3. **Tier-2 protocol:** surface assumptions and an implementation plan;
   `verification-planning` produces the evidence/proof specification; a
   bounded `@reviewer` `review_mode=plan` review evaluates the proposal,
   assumptions, and evidence path; explicit user authorisation gates
   implementation; delivery units run through `loop-engineering`; the
   integrated proof runs; exactly one final `@oracle` judgment gate completes
   the initiative. Reviews are prompt-level protocols enforced by the
   parent/orchestrator, not runtime enforcement. Plan review is
   pre-implementation; implementation review (in `loop-engineering`)
   evaluates the candidate spec, diff, and executed evidence after proof.
   There are no per-phase gates.
4. A delivery unit packet carries ID/plan version, scope/exclusions/
   dependencies, proof commands/prerequisites, Tier-2 authority if
   applicable, attempt count/prior failure, and factual
   local/external/uncertainty context.
5. Delivery order: Fixer delivery -> planned proof -> one implementation
   `@reviewer` review -> at most two repairs with affected proof -> parent
   acceptance.
6. **Long-horizon Tier-1 coordination:** tracks dependencies, milestones, and
   progress/resumption in `PLAN.md` and `REVIEW-LOG.md` without Tier-2 plan
   review, user authorisation, Oracle gate, or a second retry controller.

**Key features:**
- Canonical `.slim/plans/<initiative>/` records with `PLAN.md` and
  `REVIEW-LOG.md`
- Bounded `@reviewer` plan review (five rounds max) and implementation review
  (two repairs max) with fail-closed verdict handling
- Delivery unit packets with scope, proof, and Tier-2 authority
- Exactly one final `@oracle` judgment gate for Tier-2 initiatives
- Scheduler discipline and designer handoff guardrails preserved

**When to use:** Large-scale refactoring, multi-file architectural changes,
complex feature development spanning modules, consequential or irreversible
work.

**When NOT to use:** Simple single-file edits, trivial bug fixes, quick
one-off changes.

---

## loop-engineering

**Bounded delivery protocol for a prepared unit.**

`loop-engineering` is an orchestrator-only skill that executes a single
prepared delivery unit under the parent/orchestrator. The parent owns the
lifecycle and final acceptance. `/loop` is only a user-entry adapter that
directs the parent to load this protocol; it is never a callable procedure or
an independent controller. The implementation review is a prompt-level
protocol enforced by the parent, not runtime enforcement.

**How it works:**
1. The protocol accepts a prepared delivery unit packet: initiative/unit ID,
   plan version, tier classification/authority, goal/scope/exclusions/
   interfaces/dependencies, acceptance claims/proof commands/prerequisites,
   evidence brief (Local Code Facts, External Doc Facts, Unresolved
   Uncertainties), and budget/attempts/prior failure.
2. Pre-dispatch checks block on missing proof, unmet dependencies, or Tier-2
   missing/stale plan approval or user authorisation.
3. Delivery order: Fixer implements within scope -> parent runs planned proof
   against the candidate -> exactly one `@reviewer` `review_mode=implementation`
   evaluates the candidate spec, diff, and executed evidence after proof, plus
   the evidence brief -> parent arbitrates findings -> up to two repairs with
   affected validation -> parent acceptance.
4. A pass completes the prepared unit; it does not complete the initiative.
5. Replan on material scope/architecture/proof changes or repair exhaustion.
   Resumption preserves attempts and reads durable initiative records.

**Key features:**
- Prepared unit packet with identity, authority, scope, proof, evidence brief,
  and budget
- Pre-dispatch blocking checks for proof, dependencies, and Tier-2 authority
- Exactly one implementation `@reviewer` review with fail-closed verdict
- Up to two repairs with affected validation, then replan
- Delivery result recorded for the coordinator: candidate/diff identity, proof
  results, review verdict/findings/dispositions, repairs, blockers, parent
  acceptance, next action

**Prohibited:** optional/manual verification, callback API, separate history
directories, random paths, pass-means-initiative-complete, resettable budget,
substitute proof, architecture redesign, plan approval, final initiative
completion, and invoking `/loop` as a callable subprocedure.

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
- Use a proportionate final-state verification plan before final integration,
  including checks required by repository and release instructions.

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

### Adding or removing skills on top of an inherited list

`skills` is replaced wholesale when multiple config layers (user, project, preset) define it. To adjust an inherited list instead, use the `skills_add` / `skills_remove` directives. They are folded into the effective `skills` array during config resolution and stripped afterwards, so agents and hooks only ever see plain `skills`:

| Field | Type | Meaning |
|-------|------|---------|
| `skills_add` | string[] | Skill names appended to the effective list (after `skills`) |
| `skills_remove` | string[] | Skill names removed from the effective list; removal wins over addition |

```json
{
  "agents": {
    "oracle": {
      "skills_add": ["nexus-backend"],
      "skills_remove": ["deepwork"]
    }
  }
}
```

**Rules:**
- Duplicates are removed (first occurrence wins) before removals are applied
- If the result contains `"*"`, each removed name is appended as `"!<name>"` so the exclusion beats the wildcard grant
- On an agent without a `skills` list, directives resolve against that agent's default grants (orchestrator: all skills), so `skills_add` keeps the defaults and appends, and `skills_remove` prunes from them
- `skills_add` never overrides an inherited exclusion: adding a name that the effective list already excludes (as `"!<name>"`) is a no-op. To re-allow it, lift the exclusion with a `skills_remove` entry of the form `"!<name>"`
- A removal entry of the form `"!<name>"` removes the exclusion token itself (it lifts an existing exclusion); the `"*"` token is never expanded
