# Session Management

Session management lets the orchestrator keep track of recent delegated child
sessions so follow-up work can continue in the right specialist context instead
of starting from scratch every time.

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

When a child task runs, the plugin remembers it under a short alias such as:

```text
exp-1
ora-1
fix-2
```

The orchestrator sees a compact reminder in its system context, for example:

```text
### Resumable Sessions
explorer: exp-1 Search routing files
oracle: ora-1 Review auth architecture
```

On a related follow-up, the orchestrator can reuse that session instead of
launching a fresh one. If the remembered child session no longer exists, the
plugin drops the stale entry and falls back to a new session automatically.

---

## Scope and Safety

Session management is intentionally narrow:

- It only applies to orchestrator-managed `task` delegations.
- It is scoped to the current parent orchestrator session.
- It is in-memory only and disappears when OpenCode/plugin state restarts.
- It does not change manual `@agent` calls.
- It keeps only a small number of recent sessions per specialist type.
- Missing or deleted child sessions are cleaned up automatically.

This keeps the feature useful for continuity without turning child sessions into
long-lived global state.

---

## Default Behavior

By default, the plugin remembers **2 recent child sessions per specialist type**.

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

Session management still works because the runtime falls back to the built-in
default.

---

## Configuration

Only add `sessionManager` if you want to change the default limit:

```jsonc
{
  "sessionManager": {
    "maxSessionsPerAgent": 2
  }
}
```

### `sessionManager.maxSessionsPerAgent`

| Type | Default | Range | Meaning |
|------|---------|-------|---------|
| integer | `2` | `1`–`10` | Number of recent resumable child sessions remembered per specialist type in the current parent session |

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
  "sessionManager": {
    "maxSessionsPerAgent": 1
  }
}
```

Example with a larger memory window:

```jsonc
{
  "sessionManager": {
    "maxSessionsPerAgent": 4
  }
}
```
