# Bundling Specialized Decision Models into Core Routing

This project does not bundle specialized decision, classifier, or routing models into the core plugin agent routing engine.

## Why this is out of scope

A core design principle of oh-my-opencode-slim is giving developers complete control over their model configuration without forcing specific models, providers, or opinionated external classifiers into default delegation flows.

Baking specialized decision or classifier models (such as JEV or external routing models) directly into the core orchestrator routing layer would:

- Impose provider and API dependencies on users who may not have access to or want to use those models.
- Add an extra model call and latency step ahead of every delegation decision.
- Compete with the orchestrator's native reasoning, which already holds the full conversation context.

Users who want to use specialized models for task classification or routing decisions can configure a custom agent in `oh-my-opencode-slim.jsonc` pointing to their preferred provider and model. The orchestrator can then delegate specific tagging, triage, or classification tasks to that agent without altering default routing behavior for everyone else. An optional marketplace add-on is the intended path if an automated integration is explored in the future — alvinunreal on PR #1347: *"initial idea how we can start with Jev is to make optional, agent on new marketplace"*.

## Prior requests

- #1337 — "[Feature]: JEV type decision models integration" (closed as wontfix)
- PR #1347 — "feat: add optional Jev delegation routing and enforcement" (closed)
