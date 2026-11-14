# Mutation testing

The foreground fallback mutation gate checks whether tests detect changes to
retry deduplication. It uses [Stryker](https://stryker-mutator.io/).

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
  this project's `tsconfig.json` has none, so `stryker.foreground-fallback.conf.mjs` points
  `tsconfigFile` at a non-file and the machinery never runs. The bun
  runner's `typescript: '<7'` peer describes its dormant
  `checkers: ['typescript']` hook (not enabled here; it degrades with a log
  line).
- **If you add `extends` or `references` to `tsconfig.json`:** point
  `tsconfigFile` back at it in `stryker.foreground-fallback.conf.mjs`. The TypeScript 7 skip only
  holds while nothing needs the tsconfig rewrite, and that rewrite needs
  Stryker's upstream fix on TypeScript 7.
- Requires Bun >= 1.4.0 (the runner refuses older) and Node >= 22
  (`@stryker-mutator/core` engines). The repo's `packageManager` pin
  (`bun@1.3.14`) is below that floor, so run sweeps with a newer Bun.
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

CI runs the same sweep via `bun run mutation:foreground-fallback`. It targets
`dedup.ts` and locates the seven `DEDUP_WINDOW_MS` comparisons in
`index.ts` from the source. The report check requires mutants for every
comparison. The score must reach 80%.

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

## Survivor ledger: foreground-fallback (#1850)

Master sweep baseline: 76 mutants, 72 killed, 4 survived. Outcomes:

| File:range | Mutant | Outcome | Killed by / proof |
| --- | --- | --- | --- |
| `dedup.ts:4:7-4:32` | `typeof value === 'number'` → `true` | Equivalent (not killed) | Under the mutant the branch has the same result for every input: `Number.isInteger` already rejects every non-number, so the disjunct can never decide it. The guard is still not deletable — `value` is `unknown` and it narrows the type — which is why no test can observe the difference. |
| `dedup.ts:7:7-7:32` | string-type guard → `true` | Killed | `contract: non-string values that stringify to a status are rejected` (`index.property.test.ts`). |
| `index.ts:1543:11-1543:33` | `previous.turn !== turn` → `false` | Killed | `contract: decision trace: a no-chain retry from a new turn charges the budget` (`index.decision-trace.test.ts`). |
| `index.ts:3837:13-3837:35` | `previous.turn !== turn` → `false` | Killed | `contract: decision trace: a same-ID error from a new turn replays` (`index.decision-trace.test.ts`). |

Ranges are recorded at sweep time. The gate config locates its targets in the
source, so after a refactor re-read `reports/mutation/mutation.json` rather
than trusting a range here.

Fresh scoped sweep (`bun run mutation:foreground-fallback`): 98.68%, 75 killed,
1 survived (`dedup.ts:4:7`, the equivalent mutant above), 0 no-coverage.
