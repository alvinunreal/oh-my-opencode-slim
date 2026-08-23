# Apply-patch model caveats in preset docs

This project does not add per-model `apply_patch` reliability caveats to the
preset docs, and does not move preset defaults based on single-environment
failure-rate reports.

## Why this is out of scope

Failure rates reported from one user's session history are hard to
generalize: request volume, task mix, plugin and OpenCode versions, provider
transport, whitespace handling, and the effort variant all confound the
numbers. The #918 audit (44% Luna vs 10% Terra `apply_patch` failure rate in
the fixer lane) was measured while the fixer still ran at `xhigh`, a setting
later removed across the board in 0c2dea34, so the effort level may have been
the real variable. Putting a warning against a specific model into canonical
docs on that basis risks recording a causal claim nobody has verified.

Users who hit a misbehaving model already have an escape hatch: model-level
fallback chains via `ForegroundFallbackManager` (see
`.out-of-scope/preset-fallback.md`). Variant choices get revisited
periodically for cost-performance balance, which is how fixer landed on Luna
`high`.

## Prior requests

- #918: "Reconsider Luna defaults for Fixer and Designer after repeated apply_patch failures"
