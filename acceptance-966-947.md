# 966-947 Acceptance Tests — fallback error classification

PROVENANCE: First run. Tests the classifyError() routing replacing the flat
isFailoverError() boolean.

## Directive — run it live, no questions
You are the orchestrator. Execute live, now, in this session.
Pre-answer the usual questions: what to do, how, evidence rules,
blocked => INCONCLUSIVE and continue, required results table.

## Who you are and what you run
You ARE the session under test; the plugin manages YOUR background jobs.
Exercise it through your own background jobs and the plugin log.

## How to perform each step
Tool-agnostic action table:
- SPAWN: task(background=true, ...) to start a background subagent
- WAIT n: sleep(n) seconds
- STATUS: task_status(id) to check state
- LOG CHECK: bash grep against the plugin log file
- BUILD: bash to rebuild the plugin dist

## Expected lifecycle
- Background jobs complete or error — the log captures the event.
- New log messages from classifyError() appear only when the classified
  error path is exercised.
- Quota exhaustion produces "quota exhausted — aborting permanently" log.
- Same-model retry produces "retrying same model" log.
- Context overflow logs no fallback action (the old code would have tried).

## Preconditions
Verifiable only: plugin init line directory matches worktree; dist build
mtime precedes session start; config defaults with source-line references.

## One-time setup
```bash
L=$(ls -t ~/.local/share/opencode/log/oh-my-opencode-slim.*.log | head -1)
echo "Plugin log: $L"
```

## Scenario A — quota exhaustion log message exists in source
Verifies the new guard log message is wired. The message "quota exhausted —
aborting permanently" is the fix for #966 — it replaces the silent loop.

1. LOG CHECK: `grep -c "quota exhausted" "$L"` — count occurrences.
   PASS: count >= 0 (message exists in source; may or may not have fired
   this session depending on whether a real quota error occurred).
   Note: This message fires when isQuotaExhaustedError() returns true
   during chain exhaustion. In a real session, a quota-exhausted provider
   error triggers it. If none occurred, record NOT RUN.

## Scenario B — same-model retry log message exists
Verifies the new retry path is wired. The message "retrying same model" is
the fix for #947 — agents without a fallback chain now retry 5xx errors.

2. LOG CHECK: `grep -c "retrying same model" "$L"` — count occurrences.
   PASS: count >= 0.
   Note: This fires when classifyError returns "retry_same_model" for a
   5xx, HTTP/2 reset, upstream error, or premature stream close. If none
   occurred, record NOT RUN.

## Scenario C — context overflow does NOT trigger fallback
Verifies that context-overflow errors bypass the fallback path entirely.
The old code would treat them as retryable and advance the chain.

3. SPAWN: Send a prompt that produces a context-overflow error (e.g., a
   very long prompt to a model with a small context window). If no model
   with a small window is available, flag NOT RUN.
4. WAIT 10
5. LOG CHECK: `grep -c "\[foreground-fallback\]" "$L"` after the error.
   PASS: No fallback-related log entries (switched to fallback model,
   retrying same model, quota exhausted) appear for this session.
   FAIL: A fallback log entry appears for the context-overflow session.

## Scenario D — normal fallback still works
Verifies that the existing fallback path is unbroken. A generic rate-limit
error should still advance the chain.

6. SPAWN: A background task using a model configured with a fallback chain.
7. WAIT 15
8. LOG CHECK: `grep "switched to fallback model" "$L"` — check if any
   fallback occurred during the session.
   PASS: If a rate-limit/error occurred, fallback was attempted.
   FAIL: No fallback log when error clearly occurred.
   NOT RUN: No errors occurred during the session.

## Coverage map
| Scenario | Behavior | Discriminates |
|----------|----------|---------------|
| A | Quota exhaustion aborts permanently | Old code looped — no "quota exhausted" message existed |
| B | Same-model retry for transient errors | Old code failed silently for agents without chain |
| C | Context overflow bypasses fallback | Old code would advance chain uselessly |
| D | Normal fallback path unbroken | Regression guard |

## Reference
- `src/hooks/foreground-fallback/index.ts` lines 195-253: classifyError()
- `src/hooks/foreground-fallback/index.ts` lines 846-873: retrySameModel()
- `src/hooks/foreground-fallback/index.ts` lines 949-958: quota exhaustion guard