# Session Goal

`/goal` pins a session-scoped objective so long work keeps a clear north star.

Use it when the task is bigger than one prompt and has a clear success condition,
but you do not want a separate project-management system.

## Commands

| Command | Description |
|---------|-------------|
| `/goal <objective>` | Set the current session goal |
| `/goal` | Show the active goal and how it relates to todos and auto-continuation |
| `/goal clear` | Clear the current session goal |
| `/goal from <interview>` | Set the goal from an existing interview markdown spec |

Examples:

```text
/goal Add lightweight session goals. Done when UX, docs, and tests are complete.
/goal from kanban-design-tool
/goal clear
```

## How it fits with other features

```text
Interview → Goal → Todos → Auto-continuation → Delegation → Verify
```

- **Goal** is the why and definition of done.
- **Todos** are the execution ledger.
- **Auto-continuation** keeps executing unfinished todos when enabled.
- **Interview** turns a rough idea into a markdown spec that can become a goal.
- **Task/Subtask delegation** inherits the parent goal as context, while each
  delegated prompt remains the bounded task.

## Important behavior

Goal does not run anything by itself. It only reminds the orchestrator and child
sessions what the session is trying to achieve.

Auto-continuation remains todo-driven:

```text
Goal alone never causes continuation.
Only incomplete todos trigger auto-continuation.
```

This keeps the feature slim: one pinned objective, no dashboard, no second todo
system, and no project-global state.
