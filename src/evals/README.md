# Eval Development

This document is for developers working on the eval code itself: adding
suites, modifying the runner, writing assertions. For user-facing commands
and options, see [docs/evals.md](../../docs/evals.md).

**Scope:** Eval suites verify routing decisions — which agent the orchestrator delegates to, or whether it handles a task directly. They do not verify task delivery (file edits, answer correctness, subagent output quality). Assertions check routing signals like `agent_routed`, `subagent_count`, and `tool_used`, not outcome signals like `file_contains` or content correctness.

## Architecture

The eval system has several layers:

- **`schema.ts`**: Zod schemas for suites, eval cases, assertions, and
  transcripts. Every `eval.json` is validated against these at load time.
- **`run-case.ts`**: Per-case trial execution — retry logic, lock detection,
  and session dispatch behind `runCase()`.
- **`polling-session.ts`**: Session polling engine — stall detection, grace
  window, timeout enforcement.
- **`judge.ts`**: Council judge via SDK client, using `runWithSession` from
  `session-manager.ts`.
- **`runner.ts`**: Loads suites, runs assertions against agent output and
  transcripts, computes pass@k / pass^k and partial credit, writes results
  to `results/`. Barrel re-exports all submodules.
- **CLI scripts in `src/cli/`**: `eval.ts` (all-in-one — run, collect, diff,
  precheck via flags), `auto-collect.ts` (automated prompt collection),
  `session-manager.ts` (session creation + @agent routing).

Data flow: `eval.ts` runs each suite in turn (or one with `--suite`). It
stashes your working tree, runs `auto-collect` to produce an outputs JSON,
scores it against the suite's assertions, optionally runs the council judge
via `runJudge`, then restores your working tree. With `--judge`, it feeds
every suite's judge output to @oracle for a cross-suite assessment.
Results land in `src/evals/results/` with timestamps.

## File Structure

```
src/evals/
├── runner.ts              # Suite loading, assertion checks, scoring (barrel)
├── schema.ts              # Zod schemas for suites, cases, assertions
├── judge.ts               # Council judge via SDK client (no CLI spawn)
├── run-case.ts            # Per-case trial execution (retry, lock detection)
├── polling-session.ts     # Session polling engine (stall, timeout, grace)
├── eval-client.ts         # Shared eval session client type and factory
├── README.md              # This file
├── results/               # Timestamped results and transcripts
├── __tests__/             # Runner tests (eval.test.ts, polling-session.test.ts)
└── <suite-name>/          # One directory per suite
    └── eval.json          # The suite definition
```
src/cli/
├── eval.ts                # All-in-one: run, collect, diff, precheck via flags
├── auto-collect.ts        # Automated prompt collection (internal worker)
├── session-manager.ts     # Session creation, @agent routing, polling
├── git-lifecycle.ts       # Git stash/restore for eval runs
└── collect.ts             # Manual prompt collection (deprecated: use eval --collect)
```

## Adding a New Eval Suite

1. Create a directory `src/evals/<suite-name>/`.
2. Add an `eval.json` following `EvalSuiteSchema`:

```json
{
  "name": "my-suite",
  "description": "What this suite tests",
  "category": "capability",
  "evals": [
    {
      "id": "my-eval-1",
      "prompt": "The prompt to run through the agent",
      "agent": "orchestrator",
      "assertions": [
        {
          "type": "contains",
          "value": "expected text",
          "description": "What this assertion checks"
        }
      ],
      "smoke": true
    }
  ]
}
```

3. Run `bun run precheck` to validate the schema.
4. Collect and score using the commands in [docs/evals.md](../../docs/evals.md).

No registration needed. The runner scans directories under `src/evals/` for
`eval.json` and loads whatever it finds.

**Smoke tagging:** mark the case `"smoke": true` to include it in the fast
smoke run (`bun run eval:smoke`). Smoke cases should be fast (direct
execution) and cover the suite's core contract. Smoke runs
the subset at k=1 — a pass@1 tripwire that catches total regressions in
~5-10 min; flakiness detection requires the full k=3 run (`eval:all`).
Pick 2-4 representative cases per suite.

## Adding an Assertion Type

1. Add the type to the enum in `AssertionSchema` in `schema.ts`.
2. Add a `case` for it in `checkAssertion` in `runner.ts`. The case gets the
   assertion, the agent output text, and the transcript. Transcript-based
   checks (like `tool_used` and `agent_routed`) read from the transcript.
3. Add a test in `src/evals/__tests__/eval.test.ts`.
4. Update the assertion table in [docs/evals.md](../../docs/evals.md).

## Reliability Metric

The reliability contract is **pass^k (k=3)** — see
[RELIABILITY-METRIC.md](../../../RELIABILITY-METRIC.md) at the repo root.
Every agent-run case runs 3 trials; a case passes only when all 3 trials pass
(pass^k), and `pass@k` is reported as a diagnostic. `runs = 3` is hardcoded
in `auto-collect.ts`; do not lower it to hide variance.

## Eval Case Categories

Each eval case may declare an optional `category` in `eval.json`:

| Category | Meaning |
|----------|---------|
| `instruction-following` | Prompt intentionally names the agent (e.g. "use @fixer") |
| `natural-routing` | Neutral prompt; routing asserted via transcript (`agent_routed`) |
| `direct-execution` | Neutral prompt; expects no delegation (`subagent_count`) |
| `skill-trigger` | Neutral prompt; expects skill activation (`references_read`) |
| `response-quality` | Neutral prompt; asserts output substance |
| `execution` | Neutral prompt; asserts implementation results |
| `regression` | May keep explicit prompts; pins down real-issue behavior |

Policy: **capability suites use neutral prompts; regression and
instruction-following suites may be explicit; never mix.** A capability case
whose prompt names the expected `@agent` leaks the answer — `bun run precheck`
flags this with a non-fatal `[warn]` line and expects neutral routing instead.

## Notes

- Suites are validated against the schema at load time. Malformed suites are
  skipped silently, so run `precheck` after editing an `eval.json`.
- Assertions support `weight` for partial credit scoring. The `partialScore`
  is a weighted average of assertion scores.
- The suite `category` distinguishes capability evals (start at low pass
  rate) from regression evals (target ~100%).
