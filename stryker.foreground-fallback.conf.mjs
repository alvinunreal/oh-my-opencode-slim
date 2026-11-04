// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  mutate: [
    'src/hooks/foreground-fallback/index.ts:326-336',
    'src/hooks/foreground-fallback/index.ts:1412',
    'src/hooks/foreground-fallback/index.ts:1444',
    'src/hooks/foreground-fallback/index.ts:1499',
    'src/hooks/foreground-fallback/index.ts:1930',
    'src/hooks/foreground-fallback/index.ts:2175',
    'src/hooks/foreground-fallback/index.ts:2994',
    'src/hooks/foreground-fallback/index.ts:3674',
  ],
  // Non-file path skips Stryker's TS 7-incompatible tsconfig preprocessor.
  tsconfigFile: 'tsconfig.stryker-unused.json',
  ignorePatterns: ['/.slim', '/dist'],
  // Hotspot sweep scored 94.59% across 37 mutants; thresholds leave headroom.
  thresholds: { high: 90, low: 85, break: 80 },
  reporters: ['clear-text', 'json'],
  concurrency: 2,
  bun: {
    bunPath: 'bun',
    timeout: 30000,
    testFiles: ['src/hooks/foreground-fallback/index.test.ts'],
  },
};
