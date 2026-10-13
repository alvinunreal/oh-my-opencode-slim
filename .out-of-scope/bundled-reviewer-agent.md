# Built-in Reviewer Agent & Protocol

This project does not bundle a built-in `reviewer` agent or hardcode multi-step plan and implementation review protocols into the core orchestrator.

## Why this is out of scope

The project intentionally keeps the core built-in agent roster slim and avoids prescribing rigid multi-step development protocols (the roster ceiling itself is recorded in `.out-of-scope/no-new-default-agents.md`). Adding a dedicated `reviewer` agent to the default roster would:

- Expand the default agent count beyond the core set, increasing prompt load and cognitive complexity on every session.
- Lock developers into an opinionated two-phase review loop (plan review and implementation review) that does not fit every project or task size.
- Duplicate capabilities that users already have through custom agents or specialist prompts.

The recommended pattern is creating a custom agent in `oh-my-opencode-slim.jsonc` (for example, `@reviewer` with read-only tool permissions and specific review guidelines). That gives developers the exact review boundary they want without forcing a new default agent or rigid workflow on the entire user base. Reusable review roles and workflow packs belong in the marketplace or community extensions rather than core plugin defaults.

## Prior requests

- PR #1206 — "feat(workflows): add bounded reviewer protocol" (closed as out of scope)
- Issue #524 / Discussion #970 — "v3.0 Ideas: Workflow Packs, Optional Agent Packs, and Agent Catalog" (open)
