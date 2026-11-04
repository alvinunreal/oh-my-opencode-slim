// Fails when the scoped mutation run silently lost its targets.
// Stryker only warns on unmatched globs and reports NaN for zero mutants,
// which passes the threshold check. Assert every expected file is present.
import { readFileSync } from 'node:fs';

const REPORT = 'reports/mutation/mutation.json';
const EXPECTED = [
  'src/hooks/foreground-fallback/dedup.ts',
  'src/hooks/foreground-fallback/index.ts',
];

const report = JSON.parse(readFileSync(REPORT, 'utf8'));
const files = Object.keys(report.files ?? {});
const missing = EXPECTED.filter((f) => !files.includes(f));
const mutants = files.reduce(
  (n, f) => n + (report.files[f].mutants?.length ?? 0),
  0,
);

if (missing.length > 0 || mutants === 0) {
  console.error(
    `mutation targets drifted: missing=[${missing.join(', ')}] mutants=${mutants}`,
  );
  process.exit(1);
}
console.log(`mutation targets ok: ${files.length} files, ${mutants} mutants`);
