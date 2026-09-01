/**
 * Judge module — runs a council evaluation on completed eval suite results.
 *
 * Uses the SDK client directly (no CLI spawn, no file I/O for prompt/output)
 * — same pattern as collectSuite in auto-collect.ts. The caller injects the
 * client and receives structured results in-memory.
 */

import type { EvalSessionClient } from './eval-client';
import { runWithSession } from './session-manager';

// ── Types ────────────────────────────────────────────────────────────

export interface RunJudgeOptions {
  /** Suite name (for logging) */
  suite: string;
  /** Path to the judge-rubric.md file on disk */
  rubricPath: string;
  /** Path to the results JSON file on disk */
  resultsFile: string;
  /** Working directory for SDK queries */
  directory: string;
  /** SDK client connected to an opencode serve instance */
  client: EvalSessionClient;
}

export interface RunJudgeResult {
  /** Judge output text (Markdown per rubric format) */
  text: string;
  /** Whether the judge session completed successfully */
  success: boolean;
  /** Error message on failure */
  error?: string;
}

// ── Judge execution ─────────────────────────────────────────────────

/**
 * Run a council judge for a completed eval suite via the SDK.
 * Delegates session creation, @agent routing, and polling to runWithSession.
 */
export async function runJudge(
  options: RunJudgeOptions,
): Promise<RunJudgeResult> {
  const { suite, rubricPath, resultsFile, directory, client } = options;

  let rubric: string;
  let results: string;
  try {
    rubric = await Bun.file(rubricPath).text();
    results = await Bun.file(resultsFile).text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to read judge inputs (${suite}): ${msg}`);
    return { text: '', success: false, error: msg };
  }

  const prompt = `@council Review the eval results below and the rubric scorecard below. Grade the agent orchestration system's performance using the scorecard evaluation criteria. Most eval suites test routing decisions (which agent is invoked), not task delivery (whether the work is completed). For routing-only evals, mark Task Completion as N/A (out of scope), not Unknown. Provide a scored rubric assessment with per-councillor details and a synthesized council summary. If the results provide insufficient evidence to grade a dimension that IS in scope, mark it Unknown rather than guessing; say what evidence is missing.

## Results
${results}

## Rubric
${rubric}`;

  const t0 = Date.now();
  const ts = () => `[t=${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s]`;
  console.log(`${ts()} Judge ${suite} — starting council session`);

  try {
    const sessionResult = await runWithSession(
      client,
      'orchestrator',
      prompt,
      `judge-${suite}`,
      1,
      directory,
      // 10 min: a council run (3 councillors + synthesis) on free-tier
      // models regularly exceeds the old 5-min cap; judge timeouts are
      // silent losses.
      600_000,
      ts,
    );

    console.log(
      `${ts()} Judge ${suite} — ${sessionResult.success ? 'done' : 'failed'} (${sessionResult.durationSecs}s)`,
    );

    return {
      text: sessionResult.response,
      success: sessionResult.success,
      error: sessionResult.error,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Judge session error (${suite}): ${msg}`);
    return { text: '', success: false, error: msg };
  }
}
