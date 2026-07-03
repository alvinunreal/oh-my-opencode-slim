# src/skills/clonedeps/

## Responsibility
Manages the cloning and management of read-only dependency source repositories into `.slim/clonedeps/repos/` for offline inspection. This skill provides a workflow (not a command wrapper) that guides the orchestrator and `@librarian` through cloning dependency sources so agents can inspect library internals without requiring network access.

## Design
- **Workflow skill, not a command wrapper**: No helper scripts or TypeScript utility functions. The orchestrator owns the decision-making; `@librarian` recommends sources; the orchestrator performs filesystem/git operations directly.
- **Read-only clones**: Dependencies are cloned into `.slim/clonedeps/repos/` and should not be modified.
- **Cache strategy**: Existing clones are reused when they satisfy the task. Only fetch when the manifest entry is missing or stale.
- **Agent-driven**: No runtime TS helpers (no `getClonedDepPath` utility). Agents resolve paths from `.slim/clonedeps.json` if needed.
- **Configuration**: Uses `.slim/clonedeps.json` in the project root to define which repositories are cloned and their checked-out refs.

## Flow
1. **Check existing state**: Read `.slim/clonedeps.json` (if it exists). Check whether each listed `path` exists under `.slim/clonedeps/repos/`.
2. **Ask librarian for plan**: Delegate dependency discovery and source resolution to `@librarian`, who returns a small plan (dependency name, repo URL, ref, package subdirectory, reason).
3. **Verify and confirm**: Orchestrator verifies refs with `git ls-remote`, avoids unsafe URLs, presents plan to user, and gets approval before cloning.
4. **Clone sources**: Orchestrator runs git commands directly. Creates one folder per source under `.slim/clonedeps/repos/<safe-repo-name>/`. Prefers shallow clones, pinned tags, HTTPS URLs.
5. **Write local state**: Writes `.slim/clonedeps.json` with structured manifest (version, updatedAt, dependencies array).
6. **Update ignore files**: Adds idempotent marker blocks to `.gitignore` and `.ignore`.
7. **Register in AGENTS.md**: Appends a `## Cloned Dependency Source` section so future agents know what exists.

## Integration
- **Consumed by**: Agents that need to inspect dependency internals (e.g., `@librarian`, `@explorer`) via the registered paths in AGENTS.md.
- **Depends on**: Git CLI (for `git clone`, `git ls-remote`), `.slim/clonedeps.json` manifest.
- **Outputs**: Local filesystem paths under `.slim/clonedeps/repos/` for agent inspection.

## Notes
- Cloned repositories are read-only and should not be edited.
- The cache directory (`.slim/clonedeps/repos/`) is in the **project directory**, not the user's home directory.
- This skill is for development and debugging; it does not affect runtime behavior.
- `.slim/clonedeps.json` is small structured metadata that can be committed.
- Only `.slim/clonedeps/repos/` is gitignored.
