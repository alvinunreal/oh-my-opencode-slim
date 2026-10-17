// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  // Experiment A: one decision-heavy pair, no module mocks.
  mutate: ['src/config/agent-mcps.ts'],
  reporters: ['clear-text', 'json'],
  concurrency: 2,
  bun: {
    // shortcut: pins npm-distributed bun 1.4 for the runner (system bun
    // 1.3.14 is below the runner's >=1.4.0 engine floor); switch back to
    // "bun" once the system bun is >= 1.4
    bunPath: 'node_modules/.bin/bun',
    timeout: 30000,
    testFiles: ['src/config/agent-mcps.test.ts'],
  },
};
