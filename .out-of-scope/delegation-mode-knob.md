# Delegation Mode Config Knob

This project does not add a `delegation.mode` setting (for example `"standard"` / `"aggressive"`) that changes how eagerly the orchestrator delegates to subagents.

## Why this is out of scope

The orchestrator already delegates non-trivial work. Its default posture lives in `src/agents/orchestrator.ts`: it acts directly only when it already holds the needed context and the change is small and clear.

A mode switch would need its own prompt text for each variant. That text is paid on every request in every preset, and it adds cache-snapshot variants. The project treats model-facing bytes as a budget, so a knob that only rewrites the delegation paragraph is a poor trade.

Users who want a stronger push have a path that needs no plugin change: an `{agent}_append.md` file (see `docs/configuration.md`) can add project-specific delegation rules to the orchestrator prompt.

## Prior requests

- #1845: "Add delegation.mode config option ("standard" / "aggressive") to force proactive delegation" (closed as not planned)
