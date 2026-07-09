# Hashline (content-hash line anchors for LLM edits)

This project does not implement hashline / content-hash line anchoring for LLM edits.

## Why this is out of scope

Hashline is a technique where each line returned by the `read` tool is prefixed
with a short content-hash anchor (e.g. `9#KT:  console.log(...)`), and the LLM
references edits by `LINE#HASH` anchor instead of quoting raw text. The system
validates the hash before applying an edit, so if the file changed between read
and edit the hash mismatches and the edit is rejected before it can corrupt
anything. Hashes are context-based (`xxh32(prev + curr + next)` over a 16-char
alphabet), so editing line N only invalidates N-1/N/N+1.

Implementing it requires wrapping OpenCode's core `read` and `edit` tools to
inject and validate anchors and track file snapshots for stale-anchor recovery.
That is a deep, behavior-changing modification to the fundamental edit loop —
fragile to bolt onto a slim plugin that intentionally avoids reimplementing tool
plumbing. It belongs in OpenCode core itself or a dedicated standalone plugin,
not in oh-my-opencode-slim.

Token savings are real (reported ~61% fewer output tokens on Grok 4 Fast, ~8%
better on Gemini), but the integration cost and architectural fit put it
outside this project's scope.

## Prior requests

- #141 — "Discussion about hashline" (feature proposal / discussion; closed as wontfix)
