# `/ulw` Command Recipe

`/ulw` is an optional OpenCode custom command recipe for autonomous OMO Slim
sessions.

It is designed for long-running implementation work where you want the
Orchestrator to:

- enable Todo Continuation,
- create structured todos,
- delegate to specialists when useful,
- keep working until validation passes,
- stop only for real blockers or safety boundaries.

`/ulw` is not installed or enabled by default. It is a recipe you can copy into
OpenCode's custom command directory when you want this workflow.

## Install

Copy the example command into your OpenCode global commands directory:

```bash
mkdir -p ~/.config/opencode/commands
cp examples/commands/ulw.md ~/.config/opencode/commands/ulw.md
```

You can also install it per project:

```bash
mkdir -p .opencode/commands
cp examples/commands/ulw.md .opencode/commands/ulw.md
```

If you are not working from a clone of this repository, fetch the example from
GitHub first:

```bash
mkdir -p ~/.config/opencode/commands
curl -fsSL \
  https://raw.githubusercontent.com/alvinunreal/oh-my-opencode-slim/master/examples/commands/ulw.md \
  -o ~/.config/opencode/commands/ulw.md
```

## Usage

```text
/ulw fix the flaky checkout test and run the smallest relevant validation
```

```text
/ulw implement the new config option end-to-end, update docs, and run typecheck
```

## When to Use

Use `/ulw` for:

- multi-step coding tasks,
- bug fixing with validation,
- refactors with tests,
- implementation tasks where partial progress is not useful,
- tasks where the Orchestrator should continue through incomplete todos.

Do not use `/ulw` for:

- pure Q&A,
- plan-only requests,
- tasks requiring review after each step,
- destructive operations,
- long or expensive experiments unless explicitly intended.

## How It Works

The command routes the request to the OMO Slim Orchestrator and tells it to:

1. call `auto_continue` with `{ "enabled": true }`,
2. create a real `todowrite` task list,
3. understand the relevant codebase before editing,
4. delegate only when a specialist creates clear net value,
5. run the smallest relevant validation before claiming completion.

Todo Continuation then handles safe resumption if the Orchestrator goes idle
while incomplete todos remain. The normal Todo Continuation safety gates still
apply, including the configured continuation limit and stop behavior.

## Relationship to `/auto-continue`

`/ulw` is not a separate loop engine. It is a command recipe that asks the
Orchestrator to enable OMO Slim's existing Todo Continuation mechanism.

If you want to stop continuation manually, use:

```text
/auto-continue off
```

You can also press Esc twice during the cooldown or after injection.

## What It Does Not Do

This recipe intentionally avoids full OMO-style loop behavior. It does not add:

- hidden keyword detection,
- per-message ultrawork prompt injection,
- a separate Ralph-style loop,
- `<promise>DONE</promise>` termination logic,
- default runtime behavior changes.

The workflow remains explicit, opt-in, and reversible.
