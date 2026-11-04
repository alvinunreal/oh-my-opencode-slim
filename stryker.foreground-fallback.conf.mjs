// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  mutate: ['src/hooks/foreground-fallback/index.ts'],
  // Non-file path skips Stryker's TS 7-incompatible tsconfig preprocessor.
  tsconfigFile: 'tsconfig.stryker-unused.json',
  ignorePatterns: ['/.slim', '/dist'],
  // Floor measured 2026-10-16 (docs/mutation-testing.md); break fails CI.
  thresholds: { high: 65, low: 62, break: 60 },
  reporters: ['clear-text', 'json'],
  concurrency: 2,
  bun: {
    bunPath: 'bun',
    timeout: 30000,
    testFiles: ['src/hooks/foreground-fallback/index.test.ts'],
  },
};
