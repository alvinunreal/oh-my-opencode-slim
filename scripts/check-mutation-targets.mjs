// Fails when the scoped mutation run silently lost a target.
// Stryker only warns on unmatched globs and reports NaN for zero mutants,
// which passes the threshold check.
import { readFileSync } from 'node:fs';

const REPORT = 'reports/mutation/mutation.json';
const DEDUP = 'src/hooks/foreground-fallback/dedup.ts';
const LEDGER = 'docs/mutation-testing.md';

const report = JSON.parse(readFileSync(REPORT, 'utf8'));

const problems = [];

// Verify each hand-maintained ledger row against this run's report.
const ledger = readFileSync(LEDGER, 'utf8');
const testNames = new Map(
  Object.values(report.testFiles ?? {})
    .flatMap((file) => file.tests ?? [])
    .map(({ id, name }) => [String(id), name.split(' > ').at(-1)]),
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
  const { line, sl, sc, el, ec } = row.groups;
  const rangeCell = `${row.groups.range}:${sl}:${sc}-${el}:${ec}`;
  const mutants = (mutantsByFile.get(row.groups.range) ?? []).filter(
    (mutant) => {
      const s = mutant.location.start;
      const e = mutant.location.end;
      return (
        s.line === Number(sl) &&
        s.column === Number(sc) &&
        e.line === Number(el) &&
        e.column === Number(ec)
      );
    },
  );
  if (mutants.length === 0) {
    problems.push(`ledger row ${rangeCell} holds no mutant`);
    continue;
  }
  if (/\| Killed \|/.test(line)) {
    const named = line.match(/`(contract: [^`]+)`/)?.[1];
    const killers = new Set(
      mutants
        .filter((mutant) => mutant.status === 'Killed')
        .flatMap((mutant) =>
          (mutant.killedBy ?? []).map((id) => testNames.get(String(id))),
        )
        .filter(Boolean),
    );
    if (!named || !killers.has(named)) {
      problems.push(
        `ledger row ${rangeCell} claims ${named ?? 'a kill without a contract test'}; this run's killers are: ${[...killers].join(' | ') || 'none'}`,
      );
    }
  } else if (/Equivalent \(not killed\)/.test(line)) {
    // The equivalence claim survives only while the mutant itself does: a
    // kill or a coverage change silently invalidates the documented proof.
    if (!mutants.some((mutant) => mutant.status === 'Survived')) {
      const statuses = mutants.map((mutant) => mutant.status).join(', ');
      problems.push(
        `ledger row ${rangeCell} claims Equivalent (not killed) but this run reports: ${statuses}`,
      );
    }
  }
}

if (!report.files[DEDUP]?.mutants?.length) {
  problems.push('dedup.ts has no mutants');
}
if (problems.length > 0) {
  console.error(`mutation targets drifted:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('mutation targets ok: dedup.ts covered');
