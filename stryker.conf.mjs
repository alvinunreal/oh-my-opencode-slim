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
    // shortcut: the runner floor is bun >= 1.4.0; the npm bun devDep was
    // removed (bun ci skips its postinstall, which breaks prepare in CI),
    // so `bun add -d bun@1.4.3` locally when the system bun is older
    bunPath: 'bun',
    timeout: 30000,
    testFiles: ['src/hooks/foreground-fallback/index.test.ts'],
  },
};
