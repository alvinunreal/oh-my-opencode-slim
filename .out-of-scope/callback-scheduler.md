# Plugin Clock Scheduler & Recurring Background Callbacks

This project does not implement a clock-based interval scheduler or cron system for recurring agent callbacks, and a request for one was closed as out of scope during triage.

## Why this is out of scope

- Issue #470 requested the ability for the orchestrator or plugin to schedule minute- or hour-based callbacks (e.g. recurring status checks or timed follow-ups). It was moved to Discussion #971, which was closed as resolved during triage on 2026-10-11, noting that the plugin has no user-configurable scheduler to hang callbacks on — OpenCode hooks fire on user actions, not on a clock.

The plugin architecture is strictly reactive and event-driven:

- OpenCode plugin hooks fire on explicit lifecycle events: user input, model response chunks, tool executions, and subagent state transitions. The one exception is the bounded internal `orchestrator-wake` scheduler (default 5-minute interval), which nudges idle orchestrator sessions via `sessionSdk.promptAsync` while todos or child sessions remain unfinished — not a general user-configurable cron system.
- The plugin does not run a persistent background daemon outside of active OpenCode sessions.
- Adding a time-based scheduler introduces significant lifecycle and resource challenges: persisting scheduled jobs across restarts, waking idle sessions, racing with user prompts, and busting prompt cache prefixes on unexpected wake events.

Autonomous scheduling over long time horizons belongs at the host runtime level (OpenCode scheduler features) or via external system automation (cron jobs, CI pipelines, or CLI scripts invoking `opencode run`).

The discussion's settling questions — what triggers the callback (a timer, a condition, or a manual command), whether jobs would survive a process restart, and the concrete use case — went unanswered, so there was nothing to build against.

## Prior requests

- #470 — "[Feature]: Callbacks" (closed; moved to discussion)
- Discussion #971 — "[Feature]: Callbacks" (closed as resolved 2026-10-11; no scheduler in the plugin — reopen with a concrete use case)
