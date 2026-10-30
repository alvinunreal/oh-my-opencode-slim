# Mutation testing

Scoped mutation testing with [Stryker](https://stryker-mutator.io/) proves that
the background job board's state-machine guards have tests that actually
discriminate their branches. A surviving mutant is a contract no test can see;
the cleanup PRs that follow this workflow convert survivors into named tests.

## Toolchain

- `@stryker-mutator/core` 10.0.0 with
  [`@hughescr/stryker-bun-runner`](https://github.com/hughescr/stryker-bun-runner) 1.6.0
  and `coverageAnalysis: 'perTest'`, so every mutant is attributed to the
  tests that reach it.
- Config: `stryker.conf.mjs` — mutates `src/utils/background-job-board.ts` and
  runs `src/utils/background-job-board.test.ts`. Point `mutate` and
  `bun.testFiles` at another file pair to sweep something else.

## Run a sweep

```sh
bun add -d typescript@6.0.3   # required: the bun runner peer-depends on typescript <7
bun run mutation
git checkout -- package.json bun.lock && bun install   # restore the pinned typescript 7.0
```

The repository pins `typescript: 7.0`; the runner cannot parse TypeScript 7's
programmatic API, so the downgrade is temporary and must stay uncommitted.
Never reinstall while a sweep is running. A full background-job-board sweep is
1,515 mutants and takes roughly 6-7 minutes at `concurrency: 2`.

The JSON report lands at `reports/mutation/mutation.json` (`reports/` is
gitignored). Keep sweep output out of commits.

## Reading results

| Status | Meaning |
|---|---|
| `Killed` | A test failed under the mutant. `testFiles` maps `killedBy` ids to test names. |
| `Survived` | Every covering test passed: no test discriminates this mutation. |
| `NoCoverage` | No test reached the mutated code. This is a coverage gap, not a kill — never report it as survived. |
| `Timeout` | The mutant made a covering test hang; counts as detected, but name it. |

## Evidence bar for a mutation-cleanup PR

1. Green baseline: the target test file passes and
   `bunx stryker run --dryRunOnly` succeeds before any change.
2. At least one known mutant killed, attributed to named tests via the
   `killedBy` ids.
3. Uncovered mutants reported as `NoCoverage`, never folded into `Survived`.
4. Repeatability: two baseline sweeps produce identical per-mutant statuses
   for the same stable identity (include the mutant's full start-end range;
   several mutants can share a start position).

Report transitions as per-mutant kill lists (line, operator, replacement, and
the assertion that kills it), not only totals. Expected survivors get an
equivalence claim with a call-site proof; a Stryker status alone is not a
disposition.
