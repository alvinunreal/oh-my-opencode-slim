# Skills

Skills are prompt-based workflows, not running MCP servers. OpenCode lists
eligible skill metadata and loads the full body when invoked. Slim assigns
permissions and registers bundled skills in-process; it does not maintain a
second skill catalog or copy new skills into the user directory.

Plugin changes apply after restart/reload. `disabled_skills` omits selected
bundled registrations and grants. `autoinvoke_skills` controls whether
registered bundled skills appear in OpenCode's `<available_skills>` system
prompt list (`false`, a `"*"` / `"!name"` filter list such as
`["*", "!deepwork"]`, or a `{ "<skill>": boolean }` map) while keeping them
registered for manual invocation. A same-named user skill directory overrides
the bundled version. Legacy unedited copies are cleaned up; edited copies are
retained, or moved outside discovery to
`<user-config>/.oh-my-opencode-slim-skill-backups/` when disabled.

## Available Skills

| Skill | Purpose | Default owner |
|---|---|---|
| `simplify` | Behavior-preserving readability/complexity reduction | Oracle |
| `codemap` | Hierarchical repository maps and change tracking | Orchestrator |
| `clonedeps` | Approved, pinned dependency-source mirrors | Orchestrator |
| `deepwork` | Heavy multi-pass coding workflow | Orchestrator |
| `verification-planning` | Design project-specific evidence before implementation | Orchestrator |
| `step-back` | Reassess snowballing patches and cleaner alternatives | Orchestrator |
| `deanchor` | Derive requirements without copying incidental examples | Orchestrator |
| `ai-estimates` | Estimate human-plus-AI work and external bottlenecks | Orchestrator |
| `reflect` | Evidence-based recurring workflow improvements | Orchestrator |
| `worktrees` | Safe isolated Git writer lanes | Orchestrator |
| `oh-my-opencode-slim` | Configure and improve this plugin | Orchestrator |

The Orchestrator's default wildcard permits all registered skills subject to
global disables and native permissions. Specialist defaults are the named grants
above; grant other installed skills explicitly. Full workflow instructions have
one source: the corresponding [`src/skills/*/SKILL.md`](../src/skills/) files.

## Skills Assignment

Configure `agents.<agent>.skills`, including agent entries in a preset:

| Syntax | Grant |
|---|---|
| `["*"]` | Registered skills, subject to global disables/native permissions |
| `["*", "!codemap"]` | All except the named skill |
| `["simplify"]` | Only that skill |
| `[]` or `["!*"]` | None |

Exclusions win. OpenCode filters each agent's skill guidance and tool access
using its own permissions, not a second catalog in the Orchestrator prompt.

### Adding or removing skills on top of an inherited list

Ordinary `skills` arrays replace inherited lists. Use these fields to adjust an
existing list without copying it:

| Field | Meaning |
|---|---|
| `skills_add` | Add names after the resolved list |
| `skills_remove` | Remove names after additions; removal wins |
| `skills_include_local` | Add valid current/ancestor project skill names before removals |

```jsonc
{
  "agents": {
    "oracle": {
      "skills_add": ["project-architecture"],
      "skills_remove": ["deepwork"]
    }
  }
}
```

Directives fold into one plain `skills` list at resolution. Duplicates retain
the first occurrence. With `*`, a removal becomes `!name`; the wildcard is not
expanded. Adding a name cannot lift an inherited exclusion: remove the `!name`
token with `skills_remove: ["!name"]` to lift it. Without an explicit list,
adjustments start from the agent's default grants.

### Project-local discovery

`skills_include_local` considers `.opencode/skills/**/SKILL.md` and
`.agents/skills/**/SKILL.md` in the current directory and ancestors through the
host discovery limit. It honors `OPENCODE_DISABLE_PROJECT_CONFIG`; siblings,
global directories, URL sources and other external/compatibility roots are not
included. Duplicate names are granted once and OpenCode selects the actual
source.

Identity is read from frontmatter. On V2, keep the name equal to the directory's
path-derived native ID. Symlinked roots escaping their ancestor and symlinked
entries are skipped. Newly added files are discovered on reload. Permission and
registration remain native host responsibilities.

## codemap

Use for an unfamiliar repository or changed module layout. It creates
hierarchical `codemap.md` descriptions and `.slim/codemap.json` hashes; agents
read the maps rather than repeatedly scanning unchanged source.

Ask the Orchestrator to run codemap. Manual commands from the bundled skill
directory, or with an explicit root:

```bash
node scripts/codemap.mjs init --root /repo --include "src/**/*.ts" --exclude "node_modules/**"
node scripts/codemap.mjs changes --root /repo
node scripts/codemap.mjs update --root /repo
```

The state tracks selected files and folder changes. Folder templates contain
responsibility, design, flow and integration sections for the writer to fill.
The existing script can migrate old cartography state; it is not a runtime
plugin lifecycle. Source: [Codemap skill](../src/skills/codemap/SKILL.md).

## clonedeps

Use when pinned dependency source answers a version-specific question better
than ordinary documentation. Read `.slim/clonedeps.json` first, propose a small
clone plan for approval, then use direct Git operations. There is no helper
script or per-request dependency scanner.

- Clones live at `.slim/clonedeps/repos/<owner>__<repo>/`, read-only and ignored.
  One repository path is shared by entries with different `packagePath` values;
  package/version suffixes do not create extra clone copies.
- The committable `.slim/clonedeps.json` records dependency name/version,
  repository URL, pinned ref/commit, path, package path and reason.
- Root `AGENTS.md` gets a concise **Cloned Dependency Source** section with
  paths and purposes.
- Prefer 0–3 recommendations and at most 3–5 core dependencies, HTTPS and pinned
  tags/commits. Never run install/build/test/lifecycle scripts from a clone.
- Ignore-file edits touch only owned marker blocks and ignore the repositories,
  not the manifest. Skip trivial utilities, transitive inventories and ordinary
  docs lookups.

Source: [Clonedeps skill](../src/skills/clonedeps/SKILL.md).

## worktrees

Use isolated writer lanes for parallel/risky work or when another branch is
unfinished. The Orchestrator proposes slug, path, branch/base, purpose and owner,
checks workspace state, and coordinates validation/integration.

Worktrees live under `.slim/worktrees/<slug>/`; the ignored
`.slim/worktrees.json` records slug, branch, path, base, purpose, owner, status,
areas and creation time. Branches default to `omos/<slug>` unless the user
chooses another pattern. Specialists write and test only within their lane.

Mutating Git operations require confirmation. Cleanup refuses dirty worktrees
or unmerged branches without explicit approval. `reset --hard`, `clean`,
force-push and branch deletion are never automatic. Ignore updates touch owned
`.gitignore` markers only; there is no `.ignore` allowlist. Avoid this workflow
for tiny edits, non-Git projects or constrained disk space.

Source: [Worktrees skill](../src/skills/worktrees/SKILL.md). Native OpenCode
worktree tools can perform host operations; the skill adds writer ownership and
safe integration policy, not a second child execution system.

## deepwork

For a whole product, subsystem or heavy refactor, work in passes: thin end-to-end
outline, structure, then detail. Security and data correctness are not deferred.
Each pass uses disjoint lanes, focused evidence, proportionate final checks and
risk-triggered Oracle review. Small or routine changes do not need this workflow.

The resident skill is independently optional. `/deepwork <task>` is
self-contained and injects the bundled body even when `deepwork` is in
`disabled_skills`; use `disabled_commands` to remove the command too.

Resume state stays small:

- `.slim/deepwork/<session-id>.md`: status/slug router head.
- `.slim/deepwork/<task-slug>/progress.md`: current pass, next step, decisions,
  lanes, ranked issues and project references; no activity log.
- Durable research/verdicts belong in existing tracked project documentation;
  generated or pinned assets stay at their producing paths.
- `.slim/deepwork/` is ignored. Obsolete receipt artifacts can be removed after
  review; do not bulk-migrate transient process notes into new archives.

Source: [Deepwork skill](../src/skills/deepwork/SKILL.md).

## reflect

`/reflect [focus]` reviews repeated work and suggests the smallest useful
workflow change: prompt/config rule, skill, command, agent, project playbook, or
nothing. `/reflect --sessions --last N` selects recent-session reflection.
Evidence beats one-off failures or speculative self-improvement. Ask before
changing user-owned configuration unless the exact edit was requested.

Disabling the `reflect` skill also removes its command. See
[Session reflection ADR](adr/001-session-reflection-mode.md) for the design
reasoning and [Reflect skill](../src/skills/reflect/SKILL.md) for the workflow.

## Other workflows

- **simplify:** behavior-preserving clarity work, normally routed to Oracle;
  not feature implementation or a visual redesign.
- **verification-planning:** start from the claim and uncertainty, select the
  narrowest credible/repeatable evidence. Temporary verification scaffolding is
  removed; new dependencies or permanent debug surfaces need approval.
- **step-back:** pause snowballing patches, state the concern and cleaner
  alternative, then let the user decide. Not a ritual for small clear edits.
- **deanchor:** separate an example's requirements from its incidental wording;
  preserve exact reproduction when that is what the user asked for.
- **ai-estimates:** price AI-capable work at human-plus-AI speed while separately
  accounting for external waits/approvals. Do not use it for non-estimate tasks.
- **oh-my-opencode-slim:** inspect existing configuration first, change only
  recurring useful behavior, preserve user settings and explain activation/cost
  effects. See [Configuration](configuration.md).

Checks should establish the final state, not duplicate a default checklist in
every skill. Run repository/release-required commands and add independent review
only when the risk or uncertainty justifies it.
