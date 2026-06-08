# Session Management

Background job management lets the orchestrator track native background tasks,
wait for hook-driven completion, and reuse completed/reconciled child sessions
when follow-up work matches the same specialist context.

For implementation/debugging notes from hardening cancellation and pane cleanup,
see [Background Job Board Lessons](background-job-board-lessons.md).

It is enabled by default. You do not need to add anything to your config unless
you want to change how many sessions are remembered.

---

## Why It Exists

Delegation works best when specialists can continue a thread they already
understand:

- Explorer can continue investigating the same part of the codebase.
- Oracle can keep reviewing the same architecture/debugging thread.
- Fixer can continue a scoped implementation or test update.
- Librarian can continue the same documentation/API research.

Without session management, follow-up delegations usually create fresh child
sessions. That works, but the specialist may need repeated context. With session
management, the orchestrator can reuse recent child sessions when it makes sense.

---

## How It Feels in Practice

When a child task runs, the plugin tracks it under a short alias such as:

```text
exp-1
ora-1
fix-2
```

The orchestrator sees a compact reminder in its system context, for example:

```text
### Background Job Board
SENTINEL: background-job-board-v2

#### Active / Unreconciled
- exp-1 / child-1 / explorer / running
  Objective: Search routing files

#### Reusable Sessions
- ora-1 / child-2 / oracle / completed, reconciled
  Objective: Review auth architecture
```

When a child session reads files through OpenCode's `read` tool, the reminder can
include a compact list of files that session has already inspected. This helps the
orchestrator choose the right session to resume for related follow-up work.

To keep the prompt small, read context only shows files where at least 10 lines
were read, includes line counts, and caps each remembered session to the most
recent 8 files by default. Both thresholds are configurable.

On a related follow-up, the orchestrator can reuse a completed/reconciled session
instead of launching a fresh one. Running jobs must wait for hook-driven completion;
terminal jobs must be reconciled before dependent work or a final response.

---

## Scope and Safety

Session management is intentionally narrow:

- It only applies to orchestrator-managed `task` delegations.
- It is scoped to the current parent orchestrator session.
- It is in-memory only and disappears when OpenCode/plugin state restarts.
- It does not change manual `@agent` calls.
- It keeps only a small number of recent sessions per specialist type.
- Missing or deleted child sessions are cleaned up automatically.
- Read context is best-effort and tracks normal OpenCode `read` tool usage, not
  arbitrary filesystem access through shell commands or external MCP tools.

This keeps the feature useful for continuity without turning child sessions into
long-lived global state.

---

## Default Behavior

By default, the plugin keeps **2 reusable completed child sessions per specialist
type** while active/unreconciled jobs remain visible until resolved.

That means the generated starter config can stay clean:

```jsonc
{
  "preset": "openai",
  "presets": {
    "openai": {
      "orchestrator": { "model": "openai/gpt-5.5" },
      "explorer": { "model": "openai/gpt-5.4-mini" },
      "fixer": { "model": "openai/gpt-5.4-mini" }
    }
  }
}
```

Background job management still works because the runtime falls back to the built-in
default.

---

## Configuration

Only add `backgroundJobs` if you want to change the default limits:

```jsonc
{
  "backgroundJobs": {
    "maxSessionsPerAgent": 2,
    "readContextMinLines": 10,
    "readContextMaxFiles": 8
  }
}
```

### `backgroundJobs.maxSessionsPerAgent`

| Type | Default | Range | Meaning |
|------|---------|-------|---------|
| integer | `2` | `1`–`10` | Number of completed/reconciled reusable child sessions retained per specialist type in the current parent session |

### `backgroundJobs.readContextMinLines`

| Type | Default | Range | Meaning |
|------|---------|-------|---------|
| integer | `10` | `0`–`1000` | Minimum number of lines read from a file before it appears in reusable job context |

Set this lower if you want short config files to appear. Set it higher to keep
the prompt focused on substantial file reads.

### `backgroundJobs.readContextMaxFiles`

| Type | Default | Range | Meaning |
|------|---------|-------|---------|
| integer | `8` | `0`–`50` | Maximum number of recent read-context files shown per remembered child session |

Set this to `0` to keep session aliases but hide read-context file lists.

Use a higher value if you often run several parallel threads per specialist. Use
a lower value if you want fewer aliases in the orchestrator context.

---

## When To Tune It

Most users should leave the default alone.

Consider changing it when:

- You frequently run multiple independent Explorer/Oracle/Fixer threads in one
  long orchestrator session.
- You want the orchestrator prompt to stay smaller and prefer only one remembered
  thread per specialist.
- You are debugging session reuse behavior and want a predictable small window.

Example with a smaller memory window:

```jsonc
{
  "backgroundJobs": {
    "maxSessionsPerAgent": 1,
    "readContextMaxFiles": 4
  }
}
```

Example with a larger memory window:

```jsonc
{
  "backgroundJobs": {
    "maxSessionsPerAgent": 4,
    "readContextMinLines": 5
  }
}
```
