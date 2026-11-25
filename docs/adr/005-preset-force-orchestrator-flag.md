# ADR-005: Root-model application is a `--force-orchestrator` flag on `/preset`, not a new command

**Date:** 2026-11-22
**Status:** Accepted
**Deciders:** User + Agent

## Context

`/preset <name>` deliberately binds only a session's subagent inference
snapshot; the root session's model follows OpenCode's native model picker
(`session-preset-apply.ts` states "the root model ... untouched", and the
preset docs promise it). Users want one command that switches the whole
team, orchestrator included, for the session on screen.

The design started as a new command `force-preset` and settled on a flag.

## Decision

Add `--force-orchestrator` to the existing `/preset` command on both
surfaces (TUI fast path and server command); `-f` is its shorthand.
`/preset <name>
--force-orchestrator` binds the session team exactly like today AND applies
the preset's `orchestrator` entry to the live session through
`ctx.session.switchModel` plus the runtime-profile options bridge. The
flag is the only path to the root model; bare `/preset`, the TUI manager,
and the global default stay untouched.

A new command was rejected because `/preset`'s documented promise is
"never touches the main model" — breaking that promise on the same surface
under a new name keeps both promises clean, avoids a second command to
gate and document, and reuses the existing command registration, error
channel, and `disabled_commands: ["preset"]` gate.

Semantic decisions carried with it:

1. All-or-nothing: if the orchestrator force fails (host lacks
   `switchModel`, model not in the host registry), the command applies
   nothing, team binding included, and suggests the plain form.
2. Native pick wins: once the session model differs from the forced value,
   the force is consumed. It survives restart only when no native pick
   intervened.
3. Root sessions only: invoked in a child session, the flag reports
   "not a root session" and applies nothing.
4. A preset without an `orchestrator` entry is not an error: team binding
   applies, and the notice says the main model is unchanged. The gate is the
   preset's own resolved entry — orchestrator settings merged in from
   root-level config or the host never trigger a force.

## Consequences

- `/preset`'s core promise holds; the flag is the documented exception.
- Session bindings and the forced orchestrator model stay separate states
  with separate lifetimes; neither writes the global default.
- `inheritModelFrom: 'orchestrator'` agents follow the forced model on
  their next delegation, since they follow the live orchestrator model.
- Bare `/preset` gains one root-model line so the flag's effect is
  verifiable without a model turn.
