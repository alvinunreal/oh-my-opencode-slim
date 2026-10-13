# New Default Agents in the Core Roster

The project does not add new default/built-in agents to the core agent roster.
Agent growth happens through marketplace packages and community-contributed
agents instead.

## Why this is out of scope

On PR #1206 (a built-in `reviewer` agent with a multi-step review protocol),
alvinunreal stated the roster ceiling directly:

> Overall I think agents numbers is max, don't think we should add any more
> new default agent. [...] currently i'm targeting releasing v3.0 with just
> marketplace and additional community contributed agents.

The stance repeats across the tracker: #281 — *"I'd say we can't add more new
agents, will get overwhelmed - but for this kind of case we can think a
different solution"*; #423 — *"We support dynamic agents, I think this can be
achieved with custom configs - adding more agents isn't planned for now."*

Every default agent adds prompt load and cognitive complexity to every
session and locks in workflow opinions that don't fit every project or task
size. The supported extension paths are:

- Marketplace agent packages — the intended home for opinionated roles. On PR
  #1347 alvinunreal proposed exactly this for JEV-style classifiers: "make
  optional, agent on new marketplace".
- Custom agents in `oh-my-opencode-slim.jsonc`.

Specific instances of this ceiling are recorded in
`.out-of-scope/bundled-reviewer-agent.md` (reviewer agent + review protocol)
and `.out-of-scope/bundled-decision-models.md` (bundled decision/classifier
models in core routing).

## Prior requests

- PR #1206 — "feat(workflows): add bounded reviewer protocol" (closed; roster
  ceiling stated)
- PR #1347 — "feat: add optional Jev delegation routing and enforcement"
  (closed; marketplace path)
- PR #120 — "feat: implement granular fixer agents for parallel execution"
  (closed; alvinunreal: "I'm not sure tbh if we should by default include 2
  types of fixers")
- #1015 ("sentinel" security agent) and the v3.0 idea collections (#524,
  discussion #970: review panel, janitor, manager-of-orchestrators) —
  collected by alvinunreal as marketplace/community pack candidates, not
  default roster additions.