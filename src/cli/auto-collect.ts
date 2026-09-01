#!/usr/bin/env bun
// Runs a suite against a shared `opencode serve` via the SDK (session.create
// → promptAsync → poll messages). Not the `opencode run` CLI: run exits as
// soon as the session idles, before plugin event handlers (foreground-fallback
// replay) finish — upstream bug #23380, fix PR auto-closed/unmerged. The
// server path keeps the process alive so the replay resolves and the poll
// sees the answer.

import type { EvalSessionClient } from '../evals/eval-client';
import { runCase } from '../evals/run-case';
import type { EvalSuite, Transcript } from '../evals/schema';
import { FAILED_TRIAL_MARKER } from '../evals/scoring';
import { runWithSession } from '../evals/session-manager';
import { cleanEvalArtifacts } from './git-lifecycle';

// ── Library entry point ─────────────────────────────────────────────

export interface CollectSuiteOptions {
  /** Pre-loaded eval suite */
  suite: EvalSuite;
  /** SDK client connected to an opencode serve instance */
  client: EvalSessionClient;
  /** Number of runs per case */
  runs: number;
  /** Max concurrent cases */
  concurrency: number;
  /** Working directory for SDK queries */
  directory: string;
  /** File path for JSON output (side effect) */
  outPath: string /** Hard timeout per prompt, ms */;
  timeoutMs: number;
}

export interface CollectSuiteResult {
  outputs: Record<string, string | string[]>;
  transcripts: Record<string, Transcript[]>;
  errors: Array<{ evalId: string; run: number; error: string }>;
}

/**
 * Collect eval outputs for a suite by running each case through OpenCode.
 * Returns outputs and transcripts in-memory; writes JSON files as a side
 * effect for the judge/cache path.
 */
export async function collectSuite(
  options: CollectSuiteOptions,
): Promise<CollectSuiteResult> {
  const { suite, client, runs, concurrency, directory, outPath, timeoutMs } =
    options;
  const suiteTotalCases = suite.evals.length;

  const outputs: Record<string, string | string[]> = {};
  const allTranscripts: Record<string, Transcript[]> = {};
  const errors: Array<{ evalId: string; run: number; error: string }> = [];

  type Task = {
    evalId: string;
    prompt: string;
    agent: string;
    runIndex: number;
  };

  const passes: Task[][] = Array.from({ length: runs }, () => []);
  for (const evalCase of suite.evals) {
    const base = {
      evalId: evalCase.id,
      prompt: evalCase.prompt,
      agent: evalCase.agent ?? 'orchestrator',
    };
    for (let r = 0; r < runs; r++) {
      passes[r].push({ ...base, runIndex: r });
    }
  }
  const totalTrials = suite.evals.length * runs;
  const excludedCount = suiteTotalCases - suite.evals.length;
  const countPart =
    excludedCount > 0
      ? `${suite.evals.length} of ${suite.evals.length} cases (${excludedCount} excluded from suite of ${suiteTotalCases})`
      : `${suiteTotalCases} cases`;
  console.log(
    `Starting ${countPart} \u2014 ${suite.name}, ${runs} run${runs > 1 ? 's' : ''} each, concurrency ${concurrency}`,
  );
  let nextIndex = 0;
  let completedCount = 0;
  const t0 = Date.now();
  const ts = () => `[t=${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s]`;

  async function worker(pass: Task[]) {
    while (true) {
      const index = nextIndex++;
      if (index >= pass.length) return;
      const task = pass[index];
      const runViaServer = (
        agent: string,
        prompt: string,
        label: string,
        attempt: number,
      ) =>
        runWithSession(
          client,
          agent,
          prompt,
          label,
          attempt,
          directory,
          timeoutMs,
          ts,
        );
      const result = await runCase({
        evalId: task.evalId,
        prompt: task.prompt,
        agent: task.agent,
        runIndex: task.runIndex,
        caseIndex: index + 1,
        runs,
        runViaServer,
        ts,
      });

      if (!allTranscripts[task.evalId]) {
        allTranscripts[task.evalId] = [];
      }

      const isEmptySuccess =
        result.success &&
        result.response.length === 0 &&
        (result.transcript?.toolCallCount ?? 0) === 0;
      if (result.success && !isEmptySuccess) {
        if (!outputs[task.evalId]) outputs[task.evalId] = [];
        (outputs[task.evalId] as string[]).push(result.response);
      } else {
        if (!outputs[task.evalId]) outputs[task.evalId] = [];
        const reason = isEmptySuccess
          ? 'session returned no output (empty success)'
          : (result.error ?? 'eval failed');
        (outputs[task.evalId] as string[]).push(
          `${FAILED_TRIAL_MARKER} ${reason}`,
        );
      }

      allTranscripts[task.evalId].push(result.transcript ?? { messages: [] });

      if ((!result.success || isEmptySuccess) && result.error) {
        errors.push({
          evalId: task.evalId,
          run: task.runIndex,
          error: result.error ?? 'session returned no output',
        });
      }

      completedCount++;
      const toolCalls = result.transcript?.toolCallCount ?? 0;
      const agents = result.transcript?.agentInvocations?.length ?? 0;
      const metrics = `${toolCalls > 0 ? `${toolCalls} calls` : ''}${toolCalls > 0 && agents > 0 ? ', ' : ''}${agents > 0 ? `${agents} agents` : ''}`;
      const status = result.success && !isEmptySuccess ? '\u2713' : '\u2717';
      const detail = isEmptySuccess
        ? 'EMPTY (0 tokens)'
        : `${result.response.length} chars${metrics ? `, ${metrics}` : ''}`;
      console.log(
        `${ts()} ${status} Case ${index + 1} [${task.evalId}] done (${completedCount}/${totalTrials}) \u2014 ${detail} (${result.durationSecs}s)`,
      );
    }
  }

  for (let p = 0; p < passes.length; p++) {
    const pass = passes[p];
    nextIndex = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, pass.length) }, () =>
        worker(pass),
      ),
    );
    if (p < passes.length - 1) {
      console.log(
        `\n[t=${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] Pass ${p + 1}/${passes.length} done \u2014 reverting eval edits for pass ${p + 2}...`,
      );
      cleanEvalArtifacts();
    }
  }

  // Write outputs and transcripts as side effect
  await Bun.write(outPath, JSON.stringify(outputs, null, 2));
  const transcriptPath = outPath.replace(/\.json$/, '-transcripts.json');
  await Bun.write(transcriptPath, JSON.stringify(allTranscripts, null, 2));

  return { outputs, transcripts: allTranscripts, errors };
}
