import { execFileSync } from 'node:child_process';

/**
 * Git lifecycle management for eval runs.
 *
 * Eval suites edit files and create untracked artifacts. The working tree
 * must be restored after each run. This module provides snapshot/restore
 * so callers don't duplicate the dangerous git reset + clean sequence.
 */

/**
 * Stash all tracked and untracked changes.
 * Returns true if anything was stashed.
 */
export function stashChanges(msg = 'eval-prestash'): boolean {
  const result = execFileSync(
    'git',
    ['stash', 'push', '--include-untracked', '--message', msg],
    { encoding: 'utf-8' },
  );
  return !result.includes('No local changes to save');
}

/**
 * Reset hard, clean untracked files, then pop the stash if it was set.
 * @param stashed - true if stashChanges() returned true; caller tracks this.
 */
export function restoreAfterEvals(stashed: boolean): void {
  execFileSync('git', ['reset', '--hard', 'HEAD'], { stdio: 'inherit' });
  execFileSync('git', ['clean', '-fd'], { stdio: 'inherit' });
  if (stashed) {
    execFileSync('git', ['stash', 'pop'], { stdio: 'inherit' });
  }
}

/**
 * Reset/clean without popping — for use between consecutive passes where
 * the stash remains alive (auto-collect.ts between-run cleanup).
 * No state dependency — always safe to call.
 */
export function cleanEvalArtifacts(): void {
  execFileSync('git', ['reset', '--hard', 'HEAD'], { stdio: 'inherit' });
  execFileSync('git', ['clean', '-fd'], { stdio: 'inherit' });
}
