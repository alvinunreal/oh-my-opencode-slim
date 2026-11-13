// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  mutate: [
    'src/hooks/foreground-fallback/dedup.ts',
    'src/hooks/foreground-fallback/index.ts:1586-1586',
    'src/hooks/foreground-fallback/index.ts:1618-1618',
    'src/hooks/foreground-fallback/index.ts:1673-1673',
    'src/hooks/foreground-fallback/index.ts:2294-2294',
    'src/hooks/foreground-fallback/index.ts:2543-2543',
    'src/hooks/foreground-fallback/index.ts:3404-3404',
    'src/hooks/foreground-fallback/index.ts:4084-4084',
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
