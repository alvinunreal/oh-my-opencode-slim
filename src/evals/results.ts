import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalSuiteResult } from './schema';

const EVALS_DIR = import.meta.dir;
const RESULTS_DIR = join(EVALS_DIR, 'results');

export function saveResults(
  suiteName: string,
  result: EvalSuiteResult,
): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${suiteName}-${timestamp}.json`;
  const filepath = join(RESULTS_DIR, filename);
  writeFileSync(filepath, JSON.stringify(result, null, 2));
  return filepath;
}

export function loadLatestResult(suiteName: string): EvalSuiteResult | null {
  const path = loadLatestResultPath(suiteName);
  if (!path) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as EvalSuiteResult;
  } catch {
    return null;
  }
}

export function loadAllResults(suiteName: string): EvalSuiteResult[] {
  try {
    const entries = readdirSync(RESULTS_DIR)
      .filter((f) => f.startsWith(`${suiteName}-`) && f.endsWith('.json'))
      .sort()
      .reverse();
    return entries.map((e) => {
      const raw = readFileSync(join(RESULTS_DIR, e), 'utf-8');
      return JSON.parse(raw) as EvalSuiteResult;
    });
  } catch {
    return [];
  }
}

/**
 * Returns the path to the latest result file for a suite, or null.
 * Shared by results.ts and eval-all.ts — single implementation,
 * not duplicated.
 */
export function loadLatestResultPath(
  suiteName: string,
  exclude?: Set<string>,
): string | null {
  try {
    const entries = readdirSync(RESULTS_DIR)
      .filter((f) => f.startsWith(`${suiteName}-`) && f.endsWith('.json'))
      .filter((f) => !exclude?.has(f))
      .sort()
      .reverse();
    return entries[0] ? join(RESULTS_DIR, entries[0]) : null;
  } catch {
    return null;
  }
}
