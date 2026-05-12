# Subtask

![Subtask worker session](../img/subtask.png)

`/subtask` lets the current agent spin up a separate, bounded worker session for
one specific piece of work. The worker runs as an orchestrator in a real child
session, completes the requested task, and sends a structured summary back to
the original conversation.

Use it when a bounded, context-heavy task only needs to return a compact result
to the main thread.

## Usage

```text
/subtask <focused task for the worker>
```

Examples:

```text
/subtask update the subtask docs and run the relevant checks
/subtask investigate why the auth retry test is flaky and report findings
/subtask implement the small button spacing polish in the settings panel
```

Keep the request narrow. A good subtask has a clear finish line.

## What happens

1. The `/subtask` command asks the current agent to prepare a self-contained
   worker prompt.
2. The agent calls the `subtask` tool with that prompt and any clearly relevant
   files.
3. Slim creates a real child session with `parentID` pointing at the current
   session.
4. The child session runs as `orchestrator`, so it can use normal tools and
   specialist delegation when useful.
5. Referenced files are injected as synthetic Read-tool context before the
   worker starts.
6. If the worker needs missing conversation details, it can call `read_session`
   to inspect only the source session that spawned it.
7. When finished, the worker returns a `<subtask_summary>` with status, changes,
   files touched, validation, and follow-up notes.
8. Slim extracts the summary, returns it to the original session, and aborts the
   child session for cleanup.

In tmux or zellij, the subtask appears like other child-agent work because it is
a real child session. Existing depth limits and pane cleanup handling apply.

## Worker scope

The worker prompt is intentionally bounded:

- complete only the requested task,
- do not broaden scope,
- do not spawn another subtask,
- use `read_session` only when needed context is missing,
- run the most relevant validation checks when practical,
- stop when the requested task is done.

This keeps subtasks useful for focused execution rather than turning them into a
second open-ended conversation.

## Tools

| Tool | Purpose |
|------|---------|
| `subtask` | Creates a child worker session and returns its summary |
| `read_session` | Lets a subtask worker read the source session that spawned it |

`read_session` is restricted to subtask workers and only allows reading the
source session. It is not a general transcript-reading tool.

## File context

Files can be passed explicitly with the `files` argument or referenced in the
worker prompt with `@path` syntax. Slim resolves those paths inside the current
workspace and injects readable text files as synthetic context.

Safety rules:

- paths must stay inside the workspace real path,
- symlinks that resolve outside the workspace are skipped,
- binary files are skipped,
- large files are capped before injection,
- unreadable or missing files are skipped.

## Summary format

The worker is instructed to finish with:

```text
<subtask_summary>
Status: completed | blocked | partial

What changed:
- ...

Files touched:
- ...

Validation:
- ...

Risks / follow-up:
- ...
</subtask_summary>
```

The parent session receives that summary as normal tool output.
