import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunOptions } from './cli';
import type { SgResult } from './types';

const SOURCE = 'function add(a, b) {\n  console.log("add", a, b);\n}\n';

// The real binary from @ast-grep/cli. Its `sg` entry is only a shim that
// looks `ast-grep` up on PATH.
const astGrepBin = join(
  dirname(createRequire(import.meta.url).resolve('@ast-grep/cli/package.json')),
  process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep',
);

// runSg spawns through utils/compat, which other test files mock
// process-wide. Run it in a fresh bun process so ast-grep really runs.
async function runSgInChild(options: RunOptions): Promise<SgResult> {
  const source = `
    const { runSg } = await import(process.env.CLI_URL);
    const { setSgCliPath } = await import(process.env.CONSTANTS_URL);
    setSgCliPath(process.env.SG_PATH);
    const result = await runSg(JSON.parse(process.env.SG_OPTIONS));
    console.log(JSON.stringify(result));
  `;
  const proc = Bun.spawn([process.execPath, '-e', source], {
    env: {
      ...process.env,
      CLI_URL: pathToFileURL(join(import.meta.dir, 'cli.ts')).href,
      CONSTANTS_URL: pathToFileURL(join(import.meta.dir, 'constants.ts')).href,
      SG_PATH: astGrepBin,
      SG_OPTIONS: JSON.stringify(options),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`runSg child exited with ${exitCode}: ${stderr}`);
  }
  return JSON.parse(stdout) as SgResult;
}

describe('runSg rewrite', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omos-ast-grep-'));
    file = join(dir, 'repro.js');
    writeFileSync(file, SOURCE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes the rewrite to disk when updateAll is set', async () => {
    const result = await runSgInChild({
      pattern: 'console.log($$$ARGS)',
      rewrite: 'console.error($$$ARGS)',
      lang: 'javascript',
      paths: [file],
      updateAll: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0].replacement).toBe('console.error("add", a, b)');
    expect(readFileSync(file, 'utf8')).toBe(
      SOURCE.replace('console.log', 'console.error'),
    );
  });

  test('leaves the file alone without updateAll', async () => {
    const result = await runSgInChild({
      pattern: 'console.log($$$ARGS)',
      rewrite: 'console.error($$$ARGS)',
      lang: 'javascript',
      paths: [file],
    });

    expect(result.totalMatches).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(SOURCE);
  });
});
