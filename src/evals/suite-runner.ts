#!/usr/bin/env bun
/**
 * Run a single eval suite through the full pipeline: stash git, collect
 * outputs, score, save results, restore git.
 *
 * Extracted from eval.ts's internal runSuite closure so the module is
 * independently callable (no implicit parseArgs values).
 */

import { execFileSync } from 'node:child_process';
import { collectSuite } from '../cli/auto-collect';
import { restoreAfterEvals, stashChanges } from '../cli/git-lifecycle';
import { formatResult } from './display';
import type { EvalSessionClient } from './eval-client';
import { saveResults } from './results';
import type { EvalSuiteResult, Transcript } from './schema';
import { executeSuite } from './scoring';
import { loadEvalSuite } from './suites';

// ── Options ─────────────────────────────────────────────────────────

export interface RunSuiteOptions {
  suiteName: string;
  client: EvalSessionClient;
  smoke: boolean;
  outputsFile?: string;
  excludeStr?: string;
}

// ── Execution ───────────────────────────────────────────────────────

/** Run a single eval suite: collect, score, save, return exit code. */
export async function runSuite(opts: RunSuiteOptions): Promise<number> {
  const {
    suiteName,
    client,
    smoke,
    outputsFile: outputsFileOpt,
    excludeStr,
  } = opts;
  const exclude = buildExcludeSet(excludeStr);
  const runs = smoke ? 1 : 3;
  const concurrency = Number(process.env.EVAL_CONCURRENCY ?? 3);
  const cwd = process.cwd();
  const timeoutMs = 300_000;

  let outputs: Record<string, string | string[]> = {};
  let outputsFile = outputsFileOpt;
  let stashed = false;

  if (!outputsFile) {
    const out = `/tmp/${suiteName}.json`;
    console.log('Stashing working tree for clean eval run...');
    stashed = stashChanges(`${suiteName}-eval-prestash`);

    const suite = loadEvalSuite(suiteName);
    if (!suite) {
      console.error(`Suite "${suiteName}" not found`);
      return 1;
    }

    const effectiveRuns = smoke ? 1 : runs;
    const effectiveExclude = new Set(exclude);
    if (smoke) {
      for (const c of suite.evals) {
        if (!c.smoke) effectiveExclude.add(c.id);
      }
    }

    if (effectiveExclude.size > 0) {
      suite.evals = suite.evals.filter((e) => !effectiveExclude.has(e.id));
    }

    try {
      console.log(`Collecting fresh eval outputs for ${suiteName}...`);
      const collected = await collectSuite({
        suite,
        client,
        runs: effectiveRuns,
        concurrency,
        directory: cwd,
        outPath: out,
        timeoutMs,
      });
      outputs = collected.outputs;
      outputsFile = out;
      console.log(
        `\nLoaded ${Object.keys(outputs).length} eval outputs from ${out}`,
      );
    } catch (err) {
      console.log('Restoring working tree after collection failure...');
      restoreAfterEvals(stashed);
      throw err;
    }
  }

  let result: EvalSuiteResult | undefined;

  try {
    let transcripts: Record<string, Transcript[]> | undefined;
    if (outputsFile) {
      const transcriptPath = outputsFile.replace(
        /\.json$/,
        '-transcripts.json',
      );
      try {
        const raw = await Bun.file(transcriptPath).text();
        transcripts = JSON.parse(raw);
        console.log(`Loaded transcripts from ${transcriptPath}`);
      } catch {
        // doesn't exist
      }
    }

    result = await executeSuite(
      suiteName,
      outputs,
      transcripts,
      exclude ?? new Set(),
    );

    try {
      result.gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd })
        .toString()
        .trim();
      result.gitBranch = execFileSync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd },
      )
        .toString()
        .trim();
    } catch {
      // git unavailable
    }

    console.log(formatResult(result));

    if (transcripts) {
      const agentUsage = new Map<
        string,
        { input: number; output: number; cost: number }
      >();
      for (const tList of Object.values(transcripts)) {
        for (const t of tList) {
          for (const [agent, usage] of Object.entries(t.agentTokens ?? {})) {
            const cur = agentUsage.get(agent) ?? {
              input: 0,
              output: 0,
              cost: 0,
            };
            cur.input += usage.input ?? 0;
            cur.output += usage.output ?? 0;
            cur.cost += usage.cost ?? 0;
            agentUsage.set(agent, cur);
          }
        }
      }
      if (agentUsage.size > 0) {
        console.log('\nToken/cost usage per agent (all runs):');
        for (const [agent, usage] of agentUsage) {
          console.log(
            `  ${agent}: in=${usage.input.toLocaleString()} out=${usage.output.toLocaleString()} cost=$${usage.cost.toFixed(4)}`,
          );
        }
      }
    }

    if (result.totalEvals > 0) {
      const resultsFile = saveResults(suiteName, result);
      console.log(`\nResults saved to ${resultsFile}`);
    }
  } finally {
    if (stashed) {
      console.log('Cleaning eval artifacts and restoring working tree...');
      restoreAfterEvals(stashed);
    }
  }

  if (!result) return 1;

  let exitCode = result.failed > 0 ? 1 : 0;
  const flaky = result.results.filter(
    (r) => r.passAtK === 1 && r.passKk === 0 && r.runs >= 3,
  );
  if (flaky.length > 0) {
    console.log(
      `\n\u26a0 ${flaky.length} flaky eval(s) detected (pass@k=1 but pass^k=0):`,
    );
    for (const f of flaky) {
      console.log(
        `  - ${f.evalId}: ${f.runs} runs, ${(f.passRate * 100).toFixed(0)}% pass rate`,
      );
    }
    exitCode = 2;
  }

  console.log(
    `\u2550\u2550\u2550 [done] ${suiteName} (exit ${exitCode}) \u2550\u2550\u2550`,
  );
  return exitCode;
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildExcludeSet(excludeStr?: string): Set<string> | undefined {
  const ids = (excludeStr ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : undefined;
}
