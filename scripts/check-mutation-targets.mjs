// Fails when the scoped mutation run silently lost a target.
// Stryker only warns on unmatched globs and reports NaN for zero mutants,
// which passes the threshold check. Each marked guard line must still hold
// DEDUP_WINDOW_MS, be a configured target, and produce at least one mutant.
import { readFileSync } from 'node:fs';
import config, { guardLines } from '../stryker.foreground-fallback.conf.mjs';

const REPORT = 'reports/mutation/mutation.json';
const INDEX = 'src/hooks/foreground-fallback/index.ts';
const DEDUP = 'src/hooks/foreground-fallback/dedup.ts';
const EXPECTED_GUARDS = 7;

const report = JSON.parse(readFileSync(REPORT, 'utf8'));
const mutantLines = (file) =>
  new Set(
    (report.files[file]?.mutants ?? []).map((m) => m.location.start.line),
  );
const indexLines = readFileSync(INDEX, 'utf8').split('\n');

const problems = [];
if (!report.files[DEDUP]?.mutants?.length) {
  problems.push('dedup.ts has no mutants');
}
const lines = mutantLines(INDEX);
// Pins come from `mutation-guard` markers; every DEDUP_WINDOW_MS use outside
// the import must carry one, and each marked line must be a mutated target.
const marked = guardLines();
const used = indexLines.flatMap((text, i) =>
  text.includes('DEDUP_WINDOW_MS') && !text.startsWith('import ')
    ? [i + 1]
    : [],
);
if (marked.length !== EXPECTED_GUARDS) {
  problems.push(`expected ${EXPECTED_GUARDS} guards, found ${marked.length}`);
}
for (const line of used) {
  if (!marked.includes(line)) problems.push(`line ${line} is unmarked`);
}
for (const line of marked) {
  if (!indexLines[line - 1].includes('DEDUP_WINDOW_MS')) {
    problems.push(`line ${line} no longer holds DEDUP_WINDOW_MS`);
  } else if (!config.mutate.includes(`${INDEX}:${line}-${line}`)) {
    problems.push(`line ${line} is not a configured target`);
  } else if (!lines.has(line)) {
    problems.push(`line ${line} produced no mutants`);
  }
}

if (problems.length > 0) {
  console.error(`mutation targets drifted:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('mutation targets ok: dedup.ts and all configured guards covered');
