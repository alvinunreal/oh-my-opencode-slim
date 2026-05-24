<!-- proposal: document plugin-source verification, council.gamma, and interaction discipline -->

## REQ-016: Installation guide must front-load the fork-vs-upstream verification gate

Blind installs by an LLM agent will often land on the upstream NPM package
of the same name (`oh-my-opencode-slim`) and silently miss the fork's
SDD/TDD code. The installation guide MUST give the agent a single,
mechanical verification step (grep `spec_propose` in `dist/index.js`)
that decides whether the active plugin source is the fork or upstream,
and a local-checkout fallback to use when the GitHub plugin spec fails
with `git dep preparation failed`.

The verification step MUST appear before any preset / memex / spec-dir
configuration, because none of those have meaning if the loaded plugin
is upstream.

## REQ-017: Preset documentation must specify all council edges, not only the median

The fork's council agent is a three-edge structure (alpha / beta / gamma).
The installation guide currently shows only the top-level `council.model`
and leaves `gamma` implicit, which causes downstream presets to ship a
two-edge council that silently falls back at runtime. The guide MUST
include a concrete `council.gamma` example (with a real model id) and
state that omitting `gamma` is a configuration error, not a default.

## REQ-018: Workflow documentation must define when the agent may stop to ask the user

Without an explicit interaction discipline, the orchestrator and grill
skill tend to escalate decisions the agent could make itself. The
installation guide MUST define a short, enumerated list of cases that
warrant a human-decision stop, and state that everything outside that
list is the agent's call. The grill skill's phase-4 anti-patterns MUST
be hardened to refuse escalations that grep / file-read / doc-fetch
could have resolved in phase 3.
