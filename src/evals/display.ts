import type { EvalSuiteResult } from './schema';

export function formatResult(result: EvalSuiteResult): string {
  const lines: string[] = [
    `═══ ${result.suiteName} ═══`,
    `${result.passed}/${result.totalEvals} passed (${result.failed} failed, ${result.skipped} skipped)`,
    `pass@k: ${(result.passAtK * 100).toFixed(0)}%, pass^k: ${(result.passK * 100).toFixed(0)}%`,
    `partial score: ${((result.avgPartialScore ?? 0) * 100).toFixed(0)}%`,
    `Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    '',
  ];

  for (const r of result.results) {
    const icon = r.passed ? '\u2713' : r.runs === 0 ? '?' : '\u2717';
    const rate =
      r.runs > 0
        ? ` [${(r.passRate * 100).toFixed(0)}% across ${r.runs} runs]`
        : '';
    lines.push(`  ${icon} ${r.evalId}: ${r.prompt.slice(0, 60)}...${rate}`);

    if (!r.passed) {
      for (const a of r.assertions.filter((a) => !a.passed)) {
        lines.push(`    \u2717 ${a.assertion.description}`);
        if (a.evidence) lines.push(`      ${a.evidence}`);
      }
    }
  }

  return lines.join('\n');
}

export function diffResults(
  baseline: EvalSuiteResult,
  current: EvalSuiteResult,
): string {
  const lines: string[] = [
    `═══ Delta: ${baseline.suiteName} ═══`,
    `Baseline: ${baseline.passed}/${baseline.totalEvals} passed`,
    `Current:  ${current.passed}/${current.totalEvals} passed`,
    '',
  ];

  const delta = current.passed - baseline.passed;
  if (delta > 0) lines.push(`\u2191 ${delta} more passing`);
  else if (delta < 0) lines.push(`\u2193 ${Math.abs(delta)} fewer passing`);
  else lines.push('\u2192 No change');

  for (const base of baseline.results) {
    const curr = current.results.find((r) => r.evalId === base.evalId);
    if (!curr) continue;

    if (base.passed && !curr.passed) {
      lines.push(`  REGRESSION: ${base.evalId}`);
    } else if (!base.passed && curr.passed) {
      lines.push(`  IMPROVED: ${base.evalId}`);
    }
  }

  return lines.join('\n');
}
