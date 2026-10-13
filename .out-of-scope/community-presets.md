# Bundling Community Presets into the Shipped Preset Catalog

The project does not bundle community-submitted preset configs into the
shipped, project-maintained preset catalog. Submissions have their own home:
the `community-preset` intake process and GitHub Discussions, where the
preset's own owner keeps it updated.

## Why this is out of scope

A bundled preset is a snapshot of model choices that goes stale fast:
providers rename or deprecate models, variants disappear, and prices shift.
Each bundled preset is an implicit promise to keep a third-party lineup valid
across that churn, and a preset that resolves to dead models is worse than no
preset. alvinunreal on PR #618: *"we can't maintain many presets, for now
keeping 2 ; opencode-go already hard to keep updated"*, and on discussion
#558: *"it hard for me to makntain it since i dont use it - if someone owns
who uses this oreset and updates"* — a bundled preset needs a maintainer who
uses it, which the project cannot be for third-party lineups.

## What is supported instead

- **`community-preset` intake**: submissions arrive through the
  `preset_submission.yml` form and are reviewed for clarity and validity
  (`docs/maintainers.md`). The form's text promises inclusion in a "Community
  Presets gallery"; as of 2026-10 no gallery artifact exists in the repo, and
  the three labeled submissions to date (#890, #1014, #1017) were closed in
  favor of Discussions. Either way this record covers only the bundled
  catalog.
- **GitHub Discussions**: sharing and tuning community configs (e.g. the
  OpenCode Go preset thread, #558).

Do not close a `community-preset` submission citing this record: it rejects
only bundling into the shipped catalog.

## Prior requests

- #1014 — "[Preset] opencode-slim hybrid fallback" (routed to Discussions)
- #890 — "[Preset] <gpt&go>" (routed to Discussions)
- #1017 — "[Preset] best-price-opencode-go" (routed to Discussions)