import { checkAssertion } from './assertions';
import type {
  EvalCase,
  EvalResult,
  EvalSuiteResult,
  Transcript,
} from './schema';
import { loadEvalSuite } from './suites';

/**
 * Sentinel written by auto-collect into a trial's output slot when the
 * agent process crashed/timed out. NUL-wrapped so it can never
 * collide with real agent output; survives the empty-filter so the trial
 * keeps its slot in the k denominator. Scored as a hard trial failure.
 */
export const FAILED_TRIAL_MARKER = '\u0000EVAL_TRIAL_FAILED\u0000';

/**
 * Run a single eval case with multiple output samples.
 * Returns pass rate across runs and per-assertion rates.
 */
export async function executeEvalCase(
  evalCase: EvalCase,
  outputs: string[],
  transcripts: Transcript[],
): Promise<EvalResult> {
  if (outputs.length === 0) {
    return {
      evalId: evalCase.id,
      prompt: evalCase.prompt,
      passed: false,
      runs: 0,
      passRate: 0,
      passAtK: 0,
      passKk: 0,
      assertions: evalCase.assertions.map((a) => ({
        assertion: a,
        passed: false,
        evidence: 'no outputs provided',
      })),
      error: 'no outputs provided',
    };
  }

  const trialResults = await Promise.all(
    outputs.map(async (out, trialIdx) => {
      if (out.startsWith(FAILED_TRIAL_MARKER)) {
        return {
          passed: false,
          checks: evalCase.assertions.map((assertion) => ({
            assertion,
            passed: false,
            evidence: `trial failed before producing output: ${
              out.slice(FAILED_TRIAL_MARKER.length).trim() || 'unknown error'
            }`,
          })),
        };
      }
      const checks = await Promise.all(
        evalCase.assertions.map((assertion) =>
          checkAssertion(assertion, out, transcripts[trialIdx]),
        ),
      );
      return { passed: checks.every((c) => c.passed), checks };
    }),
  );

  const trialPassCount = trialResults.filter((t) => t.passed).length;
  const passAtK = trialResults.length > 0 && trialPassCount > 0 ? 1 : 0;
  const passKk =
    trialResults.length > 0 && trialPassCount === trialResults.length ? 1 : 0;
  const allPassed = passKk === 1;

  const assertionResults = evalCase.assertions.map((assertion, ai) => {
    const runResults = trialResults.map((t) => t.checks[ai]);
    const passCount = runResults.filter((r) => r.passed).length;
    const passRate =
      trialResults.length > 0 ? passCount / trialResults.length : 0;
    return {
      assertion,
      passed: passRate > 0.5,
      passRate,
      evidence:
        passCount < trialResults.length
          ? runResults.find((r) => !r.passed)?.evidence
          : undefined,
      score: passRate,
    };
  });

  const isEmptyOutput = outputs.every(
    (out) =>
      out.trim().length === 0 ||
      out.includes('(early-exit: delegation observed)'),
  );

  const GUARDRAIL_ASSERTIONS = new Set([
    'subagent_count',
    'tool_not_used',
    'agent_not_routed',
    'not_contains',
  ]);

  const totalWeight = assertionResults.reduce((s, a) => {
    const baseWeight = a.assertion.weight ?? 1;
    if (isEmptyOutput && GUARDRAIL_ASSERTIONS.has(a.assertion.type)) {
      return s;
    }
    return s + baseWeight;
  }, 0);

  const partialScore =
    totalWeight > 0
      ? assertionResults.reduce((s, a) => {
          const baseWeight = a.assertion.weight ?? 1;
          if (isEmptyOutput && GUARDRAIL_ASSERTIONS.has(a.assertion.type)) {
            return s;
          }
          return s + (a.score ?? 0) * baseWeight;
        }, 0) / totalWeight
      : 0;

  const transcript =
    transcripts.length > 0 ? transcripts[transcripts.length - 1] : undefined;

  return {
    evalId: evalCase.id,
    prompt: evalCase.prompt,
    passed: allPassed,
    runs: trialResults.length,
    passRate:
      assertionResults.reduce((s, a) => s + a.passRate, 0) /
      assertionResults.length,
    passAtK,
    passKk,
    partialScore,
    assertions: assertionResults,
    output: outputs[outputs.length - 1],
    transcript,
  };
}

/**
 * Execute an entire eval suite.
 *
 * @param suiteName - name of the suite to run
 * @param outputs - map of evalId → output text (or array of texts for multi-run)
 * @param transcripts - optional map of evalId → transcript array
 * @returns EvalSuiteResult with per-case pass rates
 */
export async function executeSuite(
  suiteName: string,
  outputs: Record<string, string | string[]>,
  transcripts?: Record<string, Transcript[]>,
  excludeIds: Set<string> = new Set(),
): Promise<EvalSuiteResult> {
  const suite = loadEvalSuite(suiteName);
  if (!suite) {
    return {
      suiteName,
      totalEvals: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      passAtK: 0,
      passK: 0,
      results: [],
      durationMs: 0,
      timestamp: new Date().toISOString(),
    };
  }

  const startTime = Date.now();
  const results: EvalResult[] = [];
  const evals =
    excludeIds.size > 0
      ? suite.evals.filter((c) => !excludeIds.has(c.id))
      : suite.evals;

  for (const evalCase of evals) {
    const raw = outputs[evalCase.id];
    const outputList = (
      raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
    ).filter((output) => output.trim().length > 0);

    if (outputList.length === 0) {
      results.push({
        evalId: evalCase.id,
        prompt: evalCase.prompt,
        passed: false,
        runs: 0,
        passRate: 0,
        passAtK: 0,
        passKk: 0,
        assertions: evalCase.assertions.map((a) => ({
          assertion: a,
          passed: false,
          evidence: `no output for eval "${evalCase.id}"`,
        })),
        error: `no output for eval "${evalCase.id}"`,
      });
    } else {
      const evalTranscripts = transcripts?.[evalCase.id] ?? [];
      results.push(
        await executeEvalCase(evalCase, outputList, evalTranscripts),
      );
    }
  }

  const durationMs = Date.now() - startTime;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed && r.runs > 0).length;
  const skipped = results.filter((r) => r.runs === 0).length;

  const passAtKSuite =
    results.length > 0
      ? results.filter((r) => r.passAtK === 1).length / results.length
      : 0;
  const passKSuite =
    results.length > 0
      ? results.filter((r) => r.passKk === 1).length / results.length
      : 0;

  const evalsWithRuns = results.filter((r) => r.runs > 0);
  const avgPartialScore =
    evalsWithRuns.length > 0
      ? evalsWithRuns.reduce((s, r) => s + (r.partialScore ?? 0), 0) /
        evalsWithRuns.length
      : 0;

  return {
    suiteName,
    totalEvals: evals.length,
    passed,
    failed,
    skipped,
    passAtK: passAtKSuite,
    passK: passKSuite,
    avgPartialScore,
    results,
    durationMs,
    timestamp: new Date().toISOString(),
  };
}
