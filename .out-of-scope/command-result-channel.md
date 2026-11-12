# Success Feedback for Server-Side Commands

This project does not try to hide the "Failed to send command" toast that the OpenCode v2 Web UI shows after a successful server-side command, such as `/preset`.

## Why this is out of scope

On OpenCode v2 the plugin returns a command result by throwing an error. The host has no non-error channel for command output, so every call ends in an error toast, including successful ones. The behavior is deliberate and documented in `docs/opencode-v2-compatibility.md`.

A quieter fix means the plugin would need another result path. A synthetic inbox item is delivered into the model context on the next turn, which breaks the rule that `/preset` adds nothing to the context. An extra model turn costs more tokens than the toast.

The real fix belongs to the host: a success or display channel for command output. That is an upstream request, not a plugin change.

## Prior requests

- #1820: "Web UI shows 'Failed to send command' toast when server-side /preset succeeds" (closed as not planned, upstream candidate)
