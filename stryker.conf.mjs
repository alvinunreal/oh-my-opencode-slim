// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  // Step 1 of the hotspot loop: foreground-fallback decision paths.
  mutate: ['src/hooks/foreground-fallback/index.ts'],
  // Floor measured 2026-10-16 (see docs/mutation-testing-poc.md);
  // config-only until a CI workflow invokes it (issue #1593).
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
