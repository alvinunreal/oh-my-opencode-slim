# clonedeps

`clonedeps` is a bundled OpenCode workflow skill for cloning a small set of
important dependency source repositories into a local ignored workspace so agents
can read library internals.

It is orchestrator-owned. The orchestrator delegates source discovery and URL/ref
resolution to `@librarian`, asks for approval, then performs the git and
filesystem operations directly.

There is intentionally no helper script. Dependency discovery, ref validation,
and cloning are repo-specific enough that the orchestrator/librarian workflow is
safer than a brittle cross-ecosystem script.

Cloned repositories live under `.slim/clonedeps/repos/<safe-name>/` and are
ignored by git. After syncing, the orchestrator should add or update a concise
`## Cloned Dependency Source` section in root `AGENTS.md` pointing future agents
to `.slim/clonedeps.json` and `.slim/clonedeps/repos/`.
