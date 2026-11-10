// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  mutate: [
    'src/hooks/foreground-fallback/dedup.ts',
    'src/hooks/foreground-fallback/index.ts:1547-1547',
    'src/hooks/foreground-fallback/index.ts:1579-1579',
    'src/hooks/foreground-fallback/index.ts:1634-1634',
    'src/hooks/foreground-fallback/index.ts:2043-2043',
    'src/hooks/foreground-fallback/index.ts:2288-2288',
    'src/hooks/foreground-fallback/index.ts:3121-3121',
    'src/hooks/foreground-fallback/index.ts:3801-3801',
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
    testFiles: [
      'src/hooks/foreground-fallback/index.test.ts',
      'src/hooks/foreground-fallback/index.decision-trace.test.ts',
      'src/hooks/foreground-fallback/index.property.test.ts',
    ],
  },
};
