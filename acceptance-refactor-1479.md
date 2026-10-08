# refactor-1479 Acceptance Tests — background-job lifecycle refactor behavior preservation

PROVENANCE: First revision. Branch `omos/refactor-1479-background-job-lifecycle` is a behavior-preserving refactor: 7 `src/utils/background-job-*` modules moved into `src/background-jobs/` behind a `createBackgroundJobLifecycle` facade (commit `d14118a9` + prior work). A 4-dimension Oracle quad reviewed it; this spec verifies the observable lifecycle still behaves exactly like master after the move. Because this is a preservation RC, FAIL means deviation from master-observable behavior or a stale-build signature. One scenario (C) is genuinely discriminating: it is red on master and green here.

Field-test history (cold-start `opencode run --auto`, 2026-10-08): 4 PASS + 1 NOT RUN (E: host never tore down the child session, by design). Two spec defects found and fixed in this revision: (1) scenario A originally demanded the boot line's full directory, but the log redactor masks it to `/home…im`-style fragments — verification moved to the filesystem; (2) the original `ls -t | head -1` log heuristic grabbed a concurrent orchestrator session's log (old build, `[job-coordinator]` lines) — setup now pins `$L` by the executor's own pid and positively identifies it via the spawn's taskID.

## Directive — run it live, no questions

You are the orchestrator. Execute live, now, in this session. Do not ask the
user anything; every decision you need is in this file. If a step is blocked,
record INCONCLUSIVE (with the reason) or NOT RUN (precondition absent by
design) for that scenario and continue to the next one. When all scenarios are
done, emit this table and stop:

```
Scenario | PASS/FAIL/INCONCLUSIVE/NOT RUN | evidence (log line numbers)
```

Evidence rules: a verdict is only valid when it cites `grep -n` line numbers
from the plugin log file `$L` defined under One-time setup. Your own
expectations, tool outputs from `task_status`, or anything outside `$L` are
corroborating context, never evidence.

## Who you are and what you run

You ARE the session under test. The oh-my-opencode-slim plugin loaded into
YOUR session manages YOUR background jobs. You exercise it by spawning your
own real background subagents and by reading the plugin log. Do not drive any
external CLI, TUI, or second OpenCode instance. Do not fabricate board state.

## How to perform each step

| Action | How |
|--------|-----|
| SPAWN | `task` tool, background: true, subagent_type "explorer", prompt exactly as given in the scenario |
| WAIT n | `bash` `sleep n` |
| STATUS | `task_status` tool with the task id returned by SPAWN |
| LOG CHECK | `bash` `grep -n '<literal>' "$L"` where `$L` was set in One-time setup |

## Expected lifecycle

So correct behavior is never misread as failure: a spawned background
subagent creates a session (`session.created`), runs, and when it finishes the
terminal gate publishes the terminal state
(`[terminal-gate] terminal published`), the lifecycle dispatches it
(`[job-lifecycle] terminal state dispatch`, state completed), and the
orchestrator-wake hook records that no wake is needed
(`[orchestrator-wake] terminal publication wake skipped`). Completion is NOT
deletion: `session.deleted observed` only appears if the host tears the child
session down, which may happen much later or never. A completed task shows
`state: completed` in `task_status`.

## Preconditions

Verify each; if one fails, fix it before starting and note the fix:

1. You are running inside `/home/mhenke/Projects/oh-my-opencode-slim/.slim/worktrees/refactor-1479-background-job-lifecycle` (or a session launched with that worktree as cwd).
2. The plugin build is current: `bash` `stat -c %Y /home/mhenke/Projects/oh-my-opencode-slim/.slim/worktrees/refactor-1479-background-job-lifecycle/dist/index.js` returns a timestamp newer than today 00:00 UTC. If not, rebuild: `bash` `cd /home/mhenke/Projects/oh-my-opencode-slim/.slim/worktrees/refactor-1479-background-job-lifecycle && bun run build` (if `opencode.json` in `~/.config/opencode/` points at `file:///home/mhenke/Projects/oh-my-opencode-slim/.slim/worktrees/refactor-1479-background-job-lifecycle`, a NEW session picks it up; if you are already in this session and the boot line in Scenario A fails, record A as FAIL with the mismatch and continue — do not restart anything yourself).
3. Config default referenced for scenario D: `backgroundJobs.orchestratorWake.enabled` defaults to true (source: `src/config/constants.ts`, key `backgroundJobs.orchestratorWake`).

## One-time setup

Pin `$L` to YOUR OWN session's plugin log — never `ls -t | head -1`, which
grabs the most recently written log, usually a concurrent OpenCode session's
(v1 hazard: that file belonged to another instance running the old build and
nearly false-failed every scenario). Your log filename ends in
`-<your process pid>.log`:

```bash
L=$(ls ~/.local/share/opencode/log/oh-my-opencode-slim.*-$PPID.log 2>/dev/null | head -1)
if [ -z "$L" ]; then
  L=$(ls -t ~/.local/share/opencode/log/oh-my-opencode-slim.*.log | head -1)
fi
echo "$L"
```

Positive identification before grading: `$L` must contain your spawn's taskID
(after Scenario B) and a `[plugin] instance scope` boot line. Note the boot
line's directory value is redacted by the log redactor to `/home…im`-style
fragments — that is by design (`src/utils/redact.ts`); verify the loaded
tree from the filesystem (Preconditions), never from the log.

## Scenario A — correct build loaded from the refactor worktree

Note: the log redactor masks the boot line's directory value to
`"/home…im"`, so directory identity is verified from the FILESYSTEM, not the
log. The log is used only for the health-check line's existence.

1. LOG CHECK: `grep -n '\[plugin\] instance scope' "$L" | tail -1` — the line must exist (its directory value is expected to be redacted; do not fail on that).
2. LOG CHECK: `grep -n 'health check passed' "$L" | tail -1` — the line must exist.
3. FILE CHECK: `grep -o 'file://[^"]*oh-my-opencode-slim[^"]*' ~/.config/opencode/opencode.json` — the value must equal `file:///home/mhenke/Projects/oh-my-opencode-slim/.slim/worktrees/refactor-1479-background-job-lifecycle`.
4. FILE CHECK: `stat -c %Y /home/mhenke/Projects/oh-my-opencode-slim/.slim/worktrees/refactor-1479-background-job-lifecycle/dist/index.js` — must be newer than the session start time from the `[plugin] instance scope` line's timestamp.

PASS: instance-scope line exists, health-check line exists, config points at the refactor worktree, dist mtime is newer than session start.
FAIL: config points elsewhere (wrong tree), health check line missing (init failure), or dist older than session start (stale build).
This discriminates stale builds and wrong worktree configs from the refactor under test.

## Scenario B — real spawn still publishes terminal state through the refactored lifecycle

1. SPAWN with prompt exactly: `Reply with the single word READY and nothing else. Do not use any tools.`
2. WAIT 20. STATUS the task. If still running, WAIT 20 more (max 3 rounds).
3. LOG CHECK: `grep -n '\[terminal-gate\] terminal published' "$L" | tail -3`
4. LOG CHECK: `grep -n '\[job-lifecycle\] terminal state dispatch' "$L" | tail -3`
5. Cross-check: the `taskID` in the `terminal published` line for your spawn equals the `taskID` in a `terminal state dispatch` line, and that dispatch line contains `"state":"completed"`.

PASS: both greps hit and share a taskID with state completed.
FAIL: `terminal published` exists for your spawn but no matching `[job-lifecycle] terminal state dispatch` line (refactor broke dispatch), or the dispatch tag is `[job-coordinator]` (stale build — also flags A).
INCONCLUSIVE: the subagent never reached a terminal state within 60s.

## Scenario C — coordinator vocabulary is gone from production logs

1. LOG CHECK: `grep -cn 'job-coordinator' "$L"` — expect 0 matches (grep exits 1).
2. LOG CHECK: `grep -cn 'Coordinator .* listener threw' "$L"` — expect 0 matches.

PASS: both greps return nothing (exit code 1, no output).
FAIL: any match — the old build (master logs `[job-coordinator] terminal state dispatch`) is running, or a stale log string survived.
This is the discriminating negative: red on master, green on this branch.

## Scenario D — terminal publication still drives the wake chain

1. Use the spawn from Scenario B (do not spawn a second one).
2. LOG CHECK: `grep -n 'terminal publication wake skipped' "$L" | tail -3`
3. The matching line must reference your spawn's sessionID or taskID.

PASS: wake-skip line found referencing the spawned task.
NOT RUN: only if Preconditions item 3's config key is explicitly disabled in `~/.config/opencode/oh-my-opencode-slim.jsonc` (check: `grep -n 'orchestratorWake' ~/.config/opencode/oh-my-opencode-slim.jsonc`).
INCONCLUSIVE: line absent and config is default — report the reason string you searched for.

## Scenario E — session deletion cleanup (conditional)

ONLY if the host naturally tears down the spawned child session; otherwise
record NOT RUN. Do not manufacture a deletion.

1. WAIT 30 after Scenario B completes.
2. LOG CHECK: `grep -n 'session.deleted observed' "$L" | tail -5`
3. If a line references your spawn's sessionID: LOG CHECK
   `grep -n 'terminal-session prune' "$L" | tail -5` — PASS requires no
   `prune ... remove failed` line for that sessionID, and STATUS on the task
   no longer reports it as running.
4. If no deletion line references your spawn within the audit window: NOT RUN
   (precondition absent by design — completion is not deletion).

PASS: deletion observed, no prune failure, task not running.
FAIL: deletion observed AND a prune failure or the task still reports running.

## Coverage map

| Scenario | Behavior | Discriminates |
|----------|----------|---------------|
| A | Plugin boots from refactor worktree | Stale dist / wrong config target |
| B | Terminal publication + lifecycle dispatch on real spawn | Refactor breaking the dispatch chain; stale build (old tag) |
| C | Zero coordinator vocabulary in logs | Red on master, green on branch (rename landed) |
| D | Wake chain reacts to publication | Refactor breaking listener registration |
| E | session.deleted cleanup stays healthy | Supervisor fencing/drop regression (conditional) |

Deliberately excluded (unit-owned, not log-observable): dispose guard
(`backgroundJobs?.dispose()`), duplicated-drop removal, board-surface type
narrowing, docblock fixes. These have dedicated unit tests in the branch.

## Reference

- Dispatch log: `src/background-jobs/lifecycle.ts` (`[job-lifecycle] terminal state dispatch`)
- Publication log: `src/background-jobs/terminal-gate.ts:404` (`[terminal-gate] terminal published`)
- Wake skip: `src/hooks/orchestrator-wake/` (`terminal publication wake skipped`)
- Deletion cleanup: `src/hooks/task-session-manager/event-router.ts:922` (`session.deleted observed`)
- Boot line: `src/index.ts:738` (`[plugin] instance scope`)
- Prune: `src/utils/evicted-session-prune.ts` (`terminal-session prune`)
