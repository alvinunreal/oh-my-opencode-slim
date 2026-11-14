// Fails when the scoped mutation run silently lost a target.
// Stryker only warns on unmatched globs and reports NaN for zero mutants,
// which passes the threshold check. Targets come from the Stryker config,
// so each configured guard line must still hold DEDUP_WINDOW_MS and produce
// at least one mutant.
import { readFileSync } from 'node:fs';
import config from '../stryker.foreground-fallback.conf.mjs';

const REPORT = 'reports/mutation/mutation.json';
const INDEX = 'src/hooks/foreground-fallback/index.ts';
const DEDUP = 'src/hooks/foreground-fallback/dedup.ts';
const LEDGER = 'docs/mutation-testing.md';
const EXPECTED_GUARDS = 7;

const report = JSON.parse(readFileSync(REPORT, 'utf8'));
const mutantLines = (file) =>
  new Set(
    (report.files[file]?.mutants ?? []).map((m) => m.location.start.line),
  );
const indexLines = readFileSync(INDEX, 'utf8').split('\n');

const problems = [];

// The survivor ledger's ranges are hand-maintained, so every merge that
// shifts index.ts can silently strand them. Verify each row against this
// run's report: ranges must hold a mutant, `Killed` rows must be killed by
// the contract test the row names, `Equivalent` rows must not be killed.
const ledger = readFileSync(LEDGER, 'utf8');
const testFiles = report.testFiles ?? {};
const killerNames = (mutant) =>
  new Set(
    (mutant.killedBy ?? []).map(String).map((id) => {
      const name = Object.values(testFiles)
        .flatMap((f) => f.tests ?? [])
        .find((t) => t.id === id)?.name;
      return name ? name.replace(/.* > /, '') : id;
    }),
  );
// Ledger rows name files bare (`dedup.ts`); report keys are repo paths.
const mutantsByFile = new Map(
  Object.entries(report.files).map(([path, fd]) => [
    path.split('/').at(-1),
    fd.mutants ?? [],
  ]),
);
for (const row of ledger.matchAll(
  /^(?<line>\| `(?<range>[^`|]+):(?<sl>\d+):(?<sc>\d+)-(?<el>\d+):(?<ec>\d+)` \|.*$)/gm,
)) {
  const { line, range, sl, sc, el, ec } = row.groups;
  const mutants = (mutantsByFile.get(range) ?? []).filter((mutant) => {
    const s = mutant.location.start;
    const e = mutant.location.end;
    return (
      s.line === Number(sl) &&
      s.column === Number(sc) &&
      e.line === Number(el) &&
      e.column === Number(ec)
    );
  });
  if (mutants.length === 0) {
    problems.push(`ledger row ${range} holds no mutant`);
    continue;
  }
  const killers = new Set(
    mutants.flatMap((mutant) => [...killerNames(mutant)]),
  );
  if (/\| (Killed|Equivalent)/.test(line)) {
    const named = line.match(/`contract: ([^`]+)`/);
    if (named && ![...killers].some((k) => k.includes(named[1]))) {
      problems.push(
        `ledger row ${range} says Killed by \`${named[1]}\` but this run's killers are: ${[...killers].join(' | ') || 'none'}`,
      );
    }
  }
}

if (!report.files[DEDUP]?.mutants?.length) {
  problems.push('dedup.ts has no mutants');
}
const lines = mutantLines(INDEX);
const guardTargets = config.mutate.filter((t) => t.startsWith(`${INDEX}:`));
if (guardTargets.length !== EXPECTED_GUARDS) {
  problems.push(
    `expected ${EXPECTED_GUARDS} guard targets, config has ${guardTargets.length}`,
  );
}
for (const target of config.mutate) {
  if (target === DEDUP) continue;
  const match = target.match(
    /^src\/hooks\/foreground-fallback\/index\.ts:(\d+)-(\d+)$/,
  );
  if (!match) {
    problems.push(`unrecognized target: ${target}`);
    continue;
  }
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
