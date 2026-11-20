import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Step = {
  name?: string;
  uses?: string;
  if?: string;
  'continue-on-error'?: boolean;
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  needs?: string | string[];
  'continue-on-error'?: boolean;
  steps?: Step[];
};
type Workflow = { jobs?: Record<string, Job> };

const WORKFLOW = join(import.meta.dir, '..', '.github/workflows/ci.yml');

test('converts line hits and function ranges from LCOV', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slim-lcov-'));
  try {
    const source = join(dir, 'fixture.ts');
    const lcov = join(dir, 'lcov.info');
    const output = join(dir, 'coverage-final.json');
    writeFileSync(
      source,
      'function hit() {\n  return 1;\n}\nfunction missed() {\n  return 2;\n}\n',
    );
    writeFileSync(
      lcov,
      `SF:${source}\nDA:2,1\nDA:5,0\nend_of_record\nSF:${source}\nDA:2,2\nend_of_record\n`,
    );

    const result = Bun.spawnSync([
      process.execPath,
      'tools/coverage/lcov-to-istanbul.ts',
      lcov,
      output,
    ]);
    expect(result.stderr.toString()).not.toContain('ast-grep failed');
    expect(result.exitCode).toBe(0);

    const [coverage] = Object.values(JSON.parse(readFileSync(output, 'utf8')));
    expect(coverage).toMatchObject({
      s: { 0: 3, 1: 0 },
      f: { 0: 1, 1: 0 },
      fnMap: {
        0: { name: 'hit', loc: { start: { line: 1 }, end: { line: 3 } } },
        1: { name: 'missed', loc: { start: { line: 4 }, end: { line: 6 } } },
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fallow audit consumes the pinned coverage artifact', () => {
  const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as Workflow;
  const testJob = workflow.jobs?.test;
  const fallowJob = workflow.jobs?.fallow;
  expect(testJob).toBeDefined();
  expect(fallowJob).toBeDefined();

  const upload = testJob?.steps?.find(
    (step) => step.uses === 'actions/upload-artifact@v4',
  );
  expect(upload?.with?.name).toBe('test-results-bun-pinned');
  expect(String(upload?.with?.path)).toContain('coverage/coverage-final.json');
  expect(String(upload?.with?.path)).toContain('reports/junit.xml');

  const needs = [fallowJob?.needs ?? []].flat();
  expect(needs).toContain('test');

  const steps = fallowJob?.steps ?? [];
  const download = steps.find(
    (step) => step.uses === 'actions/download-artifact@v4',
  );
  expect(download?.with?.name).toBe('test-results-bun-pinned');
  expect(download?.with?.path).toBe('.');
  expect(download?.['continue-on-error']).toBeUndefined();
  expect(download).toBeDefined();

  const auditIndex = steps.findIndex((step) =>
    step.uses?.startsWith('fallow-rs/fallow@'),
  );
  expect(auditIndex).toBeGreaterThan(steps.indexOf(download as Step));
  expect(steps[auditIndex]?.with?.['fail-on-issues']).toBe(false);

  expect(fallowJob?.if).toBe("github.event_name == 'pull_request'");
  expect(fallowJob?.['continue-on-error']).toBe(true);
});
