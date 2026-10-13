# Smart Routing & Endpoint-Driven Provider Policies

This project does not bundle provider routing policies — layers that pick
providers or endpoints per request (e.g. "smart routing v3", endpoint-driven
NanoGPT policies).

## Why this is out of scope

On PR #144 ("feat: add smart routing v3 and endpoint-driven NanoGPT policy"),
alvinunreal declined:

> I think this is a bit out of scope of this project - maybe something to
> build as an additional plugin?

Routing/provider-selection policy is a product surface of its own: health
scoring, endpoint semantics, and per-provider cost policy, and it competes
with OpenCode's own provider/model selection (`/model`, presets, config). The
plugin's scope is orchestration on top of whatever model the user selected —
not a second routing layer. Users who want routing can express it via OpenCode
provider configuration or a dedicated plugin.

## Prior requests

- PR #144 — "feat: add smart routing v3 and endpoint-driven NanoGPT policy"
  (closed)