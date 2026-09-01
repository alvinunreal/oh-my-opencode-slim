import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type EvalSuite, EvalSuiteSchema } from './schema';

const EVALS_DIR = import.meta.dir;
export const REPO_ROOT = resolve(EVALS_DIR, '..', '..');

export function loadEvalSuites(): EvalSuite[] {
  const suites: EvalSuite[] = [];
  const entries = readdirSync(EVALS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name === 'results' ||
      entry.name === '__tests__'
    )
      continue;

    const suitePath = join(EVALS_DIR, entry.name, 'eval.json');
    try {
      const raw = readFileSync(suitePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const suite = EvalSuiteSchema.parse(parsed);
      suites.push(suite);
    } catch {
      // skip
    }
  }

  return suites;
}

export function loadEvalSuite(name: string): EvalSuite | null {
  const suitePath = join(EVALS_DIR, name, 'eval.json');
  try {
    const raw = readFileSync(suitePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return EvalSuiteSchema.parse(parsed);
  } catch {
    return null;
  }
}
