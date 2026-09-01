/**
 * Tests for suite-runner.ts — the extracted runSuite pipeline.
 *
 * External deps (collectSuite, git-lifecycle, loadEvalSuite, executeSuite)
 * are mocked via mock.module. Specifiers match the paths suite-runner.ts
 * resolves from src/evals/.
 */

import { describe, expect, mock, test } from 'bun:test';

// Must be called before any imports of the modules under test.
// Specifiers match suite-runner.ts resolution from src/evals/:
//   '../cli/auto-collect'   → mock.module('../../cli/auto-collect')
//   '../cli/git-lifecycle'  → mock.module('../../cli/git-lifecycle')
//   './suites'              → mock.module('../suites')
//   './scoring'             → mock.module('../scoring')

mock.module('../../cli/auto-collect', () => ({
  collectSuite: mock(async () => ({
    outputs: { 'test-1': ['hello world'] },
    transcripts: {},
    errors: [],
  })),
}));

mock.module('../../cli/git-lifecycle', () => ({
  stashChanges: mock(() => true),
  restoreAfterEvals: mock(() => {}),
}));

mock.module('../suites', () => ({
  loadEvalSuite: mock((name: string) => {
    if (name === 'not-found') return null;
    return {
      name,
      description: '',
      evals: [
        {
          id: 'test-1',
          prompt: 'Do something',
          agent: 'orchestrator',
          assertions: [
            { type: 'contains', value: 'hello', description: 'say hello' },
          ],
        },
      ],
    };
  }),
  loadEvalSuites: mock(() => []),
}));

mock.module('../results', () => ({
  saveResults: mock(() => '/tmp/results/test-suite.json'),
}));

mock.module('../display', () => ({
  formatResult: mock(() => 'formatted result'),
}));

mock.module('../scoring', () => ({
  executeSuite: mock(async () => ({
    suiteName: 'test-suite',
    totalEvals: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    passAtK: 1,
    passK: 1,
    avgPartialScore: 1,
    results: [
      {
        evalId: 'test-1',
        prompt: 'Do something',
        passed: true,
        runs: 3,
        passRate: 1,
        passAtK: 1,
        passKk: 1,
        assertions: [],
        partialScore: 1,
      },
    ],
    durationMs: 100,
    timestamp: new Date().toISOString(),
  })),
}));

describe('suite-runner', () => {
  test('suite not found returns 1', async () => {
    const { runSuite } = await import('../suite-runner');
    const code = await runSuite({
      suiteName: 'not-found',
      client: {} as any,
      smoke: true,
    });
    expect(code).toBe(1);
  });

  test('run passes with success', async () => {
    const { runSuite } = await import('../suite-runner');
    const code = await runSuite({
      suiteName: 'test-suite',
      client: {} as any,
      smoke: true,
    });
    expect(code).toBe(0);
  });

  test('flaky detection returns exit code 2', async () => {
    // Re-mock scoring to produce flaky results
    mock.module('../scoring', () => ({
      executeSuite: mock(async () => ({
        suiteName: 'flaky-suite',
        totalEvals: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        passAtK: 1,
        passK: 0,
        avgPartialScore: 0.33,
        results: [
          {
            evalId: 'flaky-1',
            prompt: 'Do flaky thing',
            passed: false,
            runs: 3,
            passRate: 0.33,
            passAtK: 1,
            passKk: 0,
            assertions: [],
            partialScore: 0.33,
          },
        ],
        durationMs: 200,
        timestamp: new Date().toISOString(),
      })),
    }));

    const { runSuite } = await import('../suite-runner');
    const code = await runSuite({
      suiteName: 'flaky-suite',
      client: {} as any,
      smoke: false,
    });
    expect(code).toBe(2);
  });
});
