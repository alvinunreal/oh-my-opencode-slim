// Fails when the scoped mutation run silently lost a target.
// Stryker only warns on unmatched globs and reports NaN for zero mutants,
// which passes the threshold check. Targets come from the Stryker config,
// so each configured guard line must still hold DEDUP_WINDOW_MS and produce
// at least one mutant.
import { readFileSync } from 'node:fs';
import config from '../stryker.foreground-fallback.conf.mjs';

const REPORT = 'reports/mutation/mutation.json';
const INDEX = 'src/hooks/foreground-fallback/index.ts';

const report = JSON.parse(readFileSync(REPORT, 'utf8'));
const mutantLines = (file) =>
  new Set(
    (report.files[file]?.mutants ?? []).map((m) => m.location.start.line),
  );
const indexLines = readFileSync(INDEX, 'utf8').split('\n');

const problems = [];
if (!report.files['src/hooks/foreground-fallback/dedup.ts']?.mutants?.length) {
  problems.push('dedup.ts has no mutants');
}
const lines = mutantLines(INDEX);
for (const target of config.mutate) {
  const match = target.match(
    /^src\/hooks\/foreground-fallback\/index\.ts:(\d+)-(\d+)$/,
  );
  if (!match) continue;
  const line = Number(match[1]);
  if (!indexLines[line - 1]?.includes('DEDUP_WINDOW_MS')) {
    problems.push(`line ${line} no longer holds DEDUP_WINDOW_MS`);
  } else if (!lines.has(line)) {
    problems.push(`line ${line} produced no mutants`);
  }
}

if (problems.length > 0) {
  console.error(`mutation targets drifted:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('mutation targets ok: dedup.ts and all configured guards covered');
