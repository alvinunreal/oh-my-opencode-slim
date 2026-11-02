// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  mutate: ['src/utils/background-job-board.ts'],
  // Our tsconfig has no extends/references to rewrite; pointing at no file
  // skips Stryker's tsconfig preprocessor, which calls
  // ts.parseConfigFileTextToJson (removed in TypeScript 7).
  tsconfigFile: 'tsconfig.stryker-unused.json',
  // Sandbox copies every crawled file; .slim holds worktrees + cloned deps.
  ignorePatterns: ['/.slim', '/dist'],
  reporters: ['clear-text', 'json'],
  concurrency: 2,
  bun: {
    bunPath: 'bun',
    timeout: 30000,
    testFiles: ['src/utils/background-job-board.test.ts'],
  },
};
