import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
