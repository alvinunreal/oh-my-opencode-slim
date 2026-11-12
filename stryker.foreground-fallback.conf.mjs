// @ts-check
import { readFileSync } from 'node:fs';

const INDEX = 'src/hooks/foreground-fallback/index.ts';
const GUARD_MARKER = 'mutation-guard: dedup-window';

/** 1-based lines directly below each marker in index.ts; resolved at load so
 *  line shifts never break the pins. check-mutation-targets.mjs verifies them. */
export function guardLines() {
  const source = readFileSync(new URL(`./${INDEX}`, import.meta.url), 'utf8');
  return source
    .split('\n')
    .flatMap((text, i) => (text.includes(GUARD_MARKER) ? [i + 2] : []));
}

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  mutate: [
    'src/hooks/foreground-fallback/dedup.ts',
    ...guardLines().map((line) => `${INDEX}:${line}-${line}`),
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
