# Mutation testing

Scoped mutation testing with [Stryker](https://stryker-mutator.io/) proves that
the background job board's state-machine guards have tests that actually
discriminate their branches. A surviving mutant is a contract no test can see;
the cleanup PRs that follow this workflow convert survivors into named tests.

## Toolchain

- `tools/mutation/` pins the toolchain beside the runner:
  `@stryker-mutator/core` 10.0.0,
  [`@hughescr/stryker-bun-runner`](https://github.com/hughescr/stryker-bun-runner) 1.6.0,
  and `typescript` 7.0 — the same as the repo's. The root `bun.lock` and the
  repo's `typescript: 7.0` are never touched. Sweeps use
  `coverageAnalysis: 'perTest'`, so every mutant is attributed to the tests
  that reach it.
- Stryker core's tsconfig preprocessor calls `ts.parseConfigFileTextToJson`,
  removed in TypeScript 7 (it fails with
  `TypeError: ts.parseConfigFileTextToJson is not a function`). It exists only
  to rewrite `extends`/`references` paths that cross the sandbox boundary, and
  this project's `tsconfig.json` has none, so `stryker.conf.mjs` points
  `tsconfigFile` at a non-file and the machinery never runs. The bun
  runner's `typescript: '<7'` peer describes its dormant
  `checkers: ['typescript']` hook (not enabled here; it degrades with a log
  line).
- **If you add `extends` or `references` to `tsconfig.json`:** point
  `tsconfigFile` back at it in `stryker.conf.mjs`. The TypeScript 7 skip only
  holds while nothing needs the tsconfig rewrite, and that rewrite needs
  Stryker's upstream fix on TypeScript 7.
- Requires Bun >= 1.4.0 (the runner refuses older) and Node >= 22
  (`@stryker-mutator/core` engines). The repo's `packageManager` pin
  (`bun@1.3.14`) is below that floor, so run sweeps with a newer Bun.
- Config: `stryker.conf.mjs` — mutates `src/utils/background-job-board.ts` and
  runs `src/utils/background-job-board.test.ts`. Point `mutate` and
  `bun.testFiles` at another file pair to sweep something else.
- `bunfig.toml` `[test].preload` lists the literal
  `./node_modules/@opentui/solid/scripts/preload.js` path because the bun
  test runner's bunfig sanitizer resolves every preload entry against the
  project root, turning the `@opentui/solid/preload` export into a
  nonexistent path inside the Stryker sandbox. Keep it literal; it is the
  same file the export's `bun` condition loads today.

## Run a sweep

```sh
bun run mutation
```

The first run installs the tool tree (`bun install --cwd tools/mutation`,
frozen lockfile). Nothing in the repo root is modified to run a sweep, but
the repo root's `node_modules` must already be installed: the sandboxed
tests resolve the project's own dependencies. A full background-job-board
sweep is 1,515 mutants and takes roughly 6-7 minutes at `concurrency: 2`.

The JSON report lands at `reports/mutation/mutation.json` (`reports/` is
gitignored). Keep sweep output out of commits.

## Reading results

| Status | Meaning |
|---|---|
| `Killed` | A test failed under the mutant. `testFiles` maps `killedBy` ids to test names. |
| `Survived` | Every covering test passed: no test discriminates this mutation. |
| `NoCoverage` | No test reached the mutated code. This is a coverage gap, not a kill — never report it as survived. |
| `Timeout` | The mutant made a covering test hang; counts as detected, but name it. |

Tests that pin a mutant carry a `contract:` title prefix, so
`bun test -t contract` selects the mutation-pin subset.

## Evidence bar for a mutation-cleanup PR

1. Green baseline: the target test file passes and
   `bun tools/mutation/node_modules/@stryker-mutator/core/bin/stryker.js run
   --dryRunOnly` succeeds before any change. Never `bunx stryker`: the bare
   `stryker` package is an unrelated, dead v0 project.
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
