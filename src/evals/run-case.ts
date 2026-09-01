/**
 * Per-case eval execution module.
 *
 * Extracted from auto-collect.ts's internal runOneEval to create a deep
 * module: retry logic, lock detection, and trial execution behind a small
 * interface. No side effects — caller handles output/transcript dispatch.
 */

import type { Transcript } from './schema';

// ── Types ────────────────────────────────────────────────────────────

export interface RunCaseOptions {
  /** Unique eval case identifier */
  evalId: string;
  /** Prompt to send through the agent */
  prompt: string;
  /** Target agent name */
  agent: string;
  /** Zero-based run index within a multi-run pass */
  runIndex: number;
  /** One-based case index for logging */
  caseIndex: number;
  /** Total number of runs (for logging context) */
  runs: number;
  /** Callback that creates a session, sends the prompt, and polls to completion */
  runViaServer: (
    agent: string,
    prompt: string,
    label: string,
    attempt: number,
  ) => Promise<{
    success: boolean;
    response: string;
    transcript?: Transcript;
    error?: string;
    durationSecs: number;
  }>;
  /** Timestamp formatter for log lines */
  ts: () => string;
}

export interface RunCaseResult {
  success: boolean;
  response: string;
  transcript?: Transcript;
  error?: string;
  durationSecs: number;
}

// ── Execution ────────────────────────────────────────────────────────

/**
 * Run a single eval case trial.
 *
 * Sends the prompt through runViaServer and retries up to 2 additional
 * attempts on database lock errors. Returns the result for the caller to
 * dispatch into outputs/transcripts arrays.
 */
export async function runCase(options: RunCaseOptions): Promise<RunCaseResult> {
  const { evalId, prompt, agent, runIndex, runs, runViaServer, ts } = options;
  const idPart =
    runs > 1 ? ` [${evalId}] run ${runIndex + 1}/${runs}` : ` [${evalId}]`;
  const label = idPart.trim();
  const preview = prompt.length > 50 ? `${prompt.slice(0, 47)}\u2026` : prompt;
  console.log(
    `${ts()} Case ${options.caseIndex}${idPart} spawning ${agent}: ${preview}`,
  );

  const MAX_ATTEMPTS = 3;
  let result = await runViaServer(agent, prompt, label, 1);
  for (
    let attempt = 2;
    attempt <= MAX_ATTEMPTS && !result.success && isLockError(result.error);
    attempt++
  ) {
    const waitSecs = 2 * attempt;
    const lockMsg = (result.error ?? '')
      .split('\n')
      .find((l) => /database is locked/i.test(l))
      ?.slice(0, 60);
    console.log(
      `${ts()} ${label} db lock (${lockMsg ?? 'database is locked'}) — retry ${attempt}/${MAX_ATTEMPTS} in ${waitSecs}s`,
    );
    await Bun.sleep(waitSecs * 1000);
    result = await runViaServer(agent, prompt, label, attempt);
  }
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Check if an error message indicates a database lock condition.
 */
export function isLockError(error: string | undefined): boolean {
  return /database is locked|Failed query/i.test(error ?? '');
}
