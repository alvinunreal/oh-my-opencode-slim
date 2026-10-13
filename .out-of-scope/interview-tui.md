# TUI Frontend for /interview

This project keeps `/interview` web-only and does not build or maintain a TUI interview flow.

## Why this is out of scope

`/interview` runs as a web-only flow today (a per-session interview server with an optional dashboard). A request to drive the existing TUI instead — reusing the terminal interface rather than opening a browser — was declined as `wontfix` (issue #670).

The reasoning: the web UI already carries the full interview experience — questions, block comments, chat, and nudges. Rebuilding all of that inside the TUI would mean maintaining two separate interview frontends for the same feature, with all the drift and double-maintenance that implies. Since the browser opens automatically when an interview starts, the flow should already feel seamless.

If the web flow ever becomes a real friction point, this can be revisited.

## Prior requests

- #670 — "[Feature]: Option to use the existing TUI for /interview" (closed as wontfix)
