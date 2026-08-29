## Acceptance test results

| Scenario | Behavior | Result | Evidence |
|----------|----------|--------|----------|
| A | Quota exhaustion aborts permanently | PASS (wiring) | `quota exhausted — aborting permanently` in source:1019 + dist/index.js; no quota error occurred live |
| B | Same-model retry for transient errors | PASS (wiring) | `retrying same model` in source:892 + dist/index.js; no 5xx error occurred live |
| C | Context overflow bypasses fallback | NOT RUN | Could not force a real context-overflow error in a plugin-managed session |
| D | Normal fallback path unbroken | PASS (live) | 3 `switched to fallback model` log lines (01:50:06–01:50:18), chain advanced correctly |

Acceptance spec: See `acceptance-966-947.md` comment.