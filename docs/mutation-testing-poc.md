# Mutation-testing PoC report (2026-10-16)

Branch `omos/stryker` (worktree `.slim/worktrees/stryker`). Goal:
trustworthy, interpretable mutation evidence for hotspot decision logic —
outcome breakdown over score, attribution over thresholds. Companion to
issue #1579 and the design spec `docs/specs/2026-10-15-hotspot-mutation-hardening-design.md`.

## Scope and commands

- Target: one decision pair at a time, never the whole suite. The
  covering-set/multi-file approach was rejected during the earlier trial
  (process-wide `mock.module` leakage; see issue #1579 findings).
- Commands used (from `.slim/worktrees/stryker`):
  - `bun test <test file>` — ordinary baseline.
  - `bunx stryker run` — reads `stryker.conf.mjs`; JSON report lands at
    `reports/mutation/mutation.json` (gitignored; regenerable).
  - The agent-mcps tables below were run with the mutate scope
    overridden (`bunx stryker run --mutate src/config/agent-mcps.ts`);
    the committed config scopes `mutate` to foreground-fallback only.

## Runner constraints (verified against @hughescr/stryker-bun-runner 1.6.0)

| Tool | Version | Runner requirement | Note |
|---|---|---|---|
| @stryker-mutator/core | 10.0.0 | `^9 || ^10` | compatible |
| typescript | 6.0.3 | `<7` | downgraded from `7.0` (tsgo) for the runner's `<7` peer; `typecheck` and `build` verified green on 6.0.3 |
| bun (npm pin in `stryker.conf.mjs`) | 1.4.3 | `>=1.4.0` | system bun 1.3.14 is below the engine floor, so `bun.bunPath` is load-bearing |
| system bun | 1.3.14 | — | normal `bun test` unaffected |

Infrastructure facts (both trial-proven, needed to run under Stryker):
- `bunfig.toml` preload must use the literal
  `./node_modules/@opentui/solid/scripts/preload.js`: Stryker's sandbox
  absolutizes bare specifiers (`@opentui/solid/preload` resolves into the
  sandbox and fails with "preload not found"). Normal `bun test` works
  with either form; the literal path is also valid outside the sandbox,
  so the change is not conditional on running Stryker.
- `bun.bunPath` pin to the npm-distributed bun 1.4.3.

## Results

Experiments on `src/config/agent-mcps.ts` (pure decision module):

| Run | Tests | Killed | Survived | No cov | Timeout | Score |
|---|---|---|---|---|---|---|
| baseline | 10 | 35 | 22 | 2 | 0 | 59.32% |
| baseline repeat | 10 | 35 | 22 | 2 | 0 | 59.32% (identical per-mutant outcome sets) |
| after gap-fix tests | 15 | 53 | 6 | 0 | 0 | — |
| shake 2 (identical rev) | 15 | 53 | 6 | 0 | 0 | 0 per-mutant status differences |

Foreground-fallback (`src/hooks/foreground-fallback/index.ts`):

| Run | Tests | Killed | Survived | No cov | Timeout | Score |
|---|---|---|---|---|---|---|
| 1 | 317 | 1,650 | 730 | 180 | 4 | 64.51% |
| 2 (+12 classifier tests) | 329 | 1,666 | 715 | 179 | 4 | 65.13% |
| 3 (+2 budget tests) | 331 | 1,667 | 714 | 179 | 4 | 65.17% |
| 4 (+4 sequence tests) | 335 | 1,701 | 693 | 166 | 4 | 66.50% |

`mock.module` interaction experiment: mutating a module that its
covering test replaces via `mock.module`
(`src/utils/package-manager.ts` + `src/cli/cache.test.ts`) left the mock
intact (dry run green) and reported all 68 mutants as NoCoverage — the
runner's documented eager-import limitation did not reproduce under
`coverageAnalysis: "perTest"`.

## Attribution methodology

Mutant-ID matched diffs between sweeps (never positional array
comparison), using each mutant's `killedBy` records mapped to test
names. Sweep 4's delta: 34 kills, every one naming exactly one of the
four falsifier-proven tests (S1=3, S1b=2, S2=17, S3=12), zero kills
where the killer was absent, zero reversals from Killed/Timeout.
Unknown-status rows were treated as attribution failures and checked
individually, not banded.

## Falsifier discipline

Every added test was first applied against hand-built mutants in a
scratch copy of the source and only kept when (a) production passed and
(b) the targeted mutant failed. Two prior drafts of S1/S1b were
discarded because their assertions coincided under mutant and original
worlds; the final discriminators (charge boundary after a v2 stop; v1
ignoring the same event) survived falsification. The 1697 regression
test was verified both ways the same session it was written.

The four sequence tests, all through existing public seams:
- S1: v2 stop finish re-arms the descent budget (raw `session.step.ended`).
- S1b: v1 host ignores the same shape (exhaustion persists;
  `willAttemptFallback` stays false).
- S2: text-only `SLIM_INTERNAL_INITIATOR` marker parts fence replays.
- S3: no-coordinator `session.deleted` clears dedup/state via the event.
Plus the 1697 regression: a deleted session's parent edge must clear so
a recreated session is not pinned to child semantics by a stale edge.

## Thresholds

`stryker.conf.mjs` scopes `mutate` to the foreground-fallback module and
configures `thresholds: { high: 65, low: 62, break: 60 }` from the
measured floor. These are configuration, not enforcement: no CI
workflow invokes this config; follow-up is tracked as the CI-wiring
issue (see "Open items").

## Limitations

- Repeatability across identical revisions is **not** established for
  the foreground-fallback file (only for the agent-mcps pair). Sweep
  deltas are attributable to named tests, which is a different claim.
- Sweep-derived evidence reflects one run per revision on this machine
  (bun-runner pooled workers, concurrency 2); no stability claim beyond
  the deltas discussed.
- The 1697 regression was human-falsifier-verified once, not re-run
  inside a sweep.
- Remaining ~693 survivors / 166 no-coverage mutants of
  foreground-fallback are untriaged beyond the bands partitioned in the
  working journal; they are not automatically defects.
- Evidence-oriented artifacts referenced by the working journal under
  `/tmp` (`handlevent-mutants.json`, `ff-*.json`) are session-local and
  not durable; the tracked artifacts are the tests themselves, this
  report, the JSON-converted `reports/mutation/mutation.json` output
  (regenerable for the foreground-fallback scope), and the full
  453-line journal kept locally.

## Artifacts disposition

Durable (tracked on this branch):
- `stryker.conf.mjs`, `bunfig.toml` preload literalization,
  `docs/mutation-testing-poc.md` (this file).
- Test additions in `src/config/agent-mcps.test.ts` and
  `src/hooks/foreground-fallback/index.test.ts`.

Working-only (local, gitignored):
- `.superpowers/sdd/2026-10-16-mutation-poc/progress.md` — 453-line
  exploratory journal (superseded drafts, corrections, probes).
- `reports/mutation/*.json` — regenerable from the committed config.

## Open items

1. CI wiring: invoke the scoped Stryker gate from a workflow job
   (tracked separately from this branch's scope).
2. `handleEvent` core band (message.updated, ~45 survivors + 17
   no-coverage + 2 timeouts at sweep 4): next candidate cluster for the
   same loop, not yet triaged against the full-records table.
3. Repeat-sweep decision only if a reproducibility claim is required.
