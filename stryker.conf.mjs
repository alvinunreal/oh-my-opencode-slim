// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  // Step 1 of the hotspot loop: foreground-fallback decision paths.
  mutate: ['src/hooks/foreground-fallback/index.ts'],
  // Mutation-score thresholds are configured for this scoped PoC. They
  // become a CI-enforced gate only after a workflow invokes this
  // configuration. Floor measured 2026-10-16 across 3 sweeps:
  // 64.51 -> 65.13 -> 65.17, run-to-run deltas traceable to named tests,
  // zero unexplained drift. Below break fails the Stryker run; revisit
  // as the loop closes clusters.
  thresholds: { high: 65, low: 62, break: 60 },
  reporters: ['clear-text', 'json'],
  concurrency: 2,
  bun: {
    // shortcut: pins npm-distributed bun 1.4 for the runner (system bun
    // 1.3.14 is below the runner's >=1.4.0 engine floor); switch back to
    // "bun" once the system bun is >= 1.4
    bunPath: 'node_modules/.bin/bun',
    timeout: 30000,
    testFiles: ['src/hooks/foreground-fallback/index.test.ts'],
  },
};
