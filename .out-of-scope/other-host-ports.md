# Ports to Other Agent Hosts (oh-my-codex-slim)

This project does not port or maintain versions of the plugin for other agent
hosts (e.g. a Codex "oh-my-codex-slim"). Forking and reusing the ideas,
agents, and prompts elsewhere is explicitly welcome.

## Why this is out of scope

#507 requested a Codex port. alvinunreal declined while encouraging reuse:

> Even though I'm liking the idea, with v2 we are even more opencode
> dependent since background tasks are becoming major part of this plugin.
>
> Besides codex pi is also interesting, just I won't be able to maintain
> another version of this plugin.
> If others are willing, feel free to copy the idea, agents, prompts etc.

The plugin is coupled to OpenCode's runtime surface (session hooks, background
task boards, v1/v2 adapters), so a port is a separate project with its own
maintenance cost — not a feature of this repository.

## Prior requests

- #507 — "[Feature]: oh-my-codex-slim" (closed)