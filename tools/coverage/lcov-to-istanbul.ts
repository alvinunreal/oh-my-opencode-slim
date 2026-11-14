#!/usr/bin/env bun

/**
 * Convert `bun test --coverage` lcov output to Istanbul `coverage-final.json`
 * so `fallow health --coverage` scores CRAP from measured coverage instead
 * of the static estimate.
 *
 * Bun's lcov carries line (`DA:`) records only — no `FN:`/`BRDA:` — so
 * function ranges come from the repo's own ast-grep binary
 * (`@ast-grep/cli`, already a devDependency) via one `scan` invocation.
 * Per-function hit counts derive from line hits: a function counts as hit
 * when any `DA:` line inside its range ran.
 *
 * Usage: bun tools/coverage/lcov-to-istanbul.ts [lcov.info] [out.json]
 * Defaults: coverage/lcov.info -> coverage/coverage-final.json.
 * All diagnostics go to STDERR; STDOUT stays empty.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type Pos = { line: number; column: number };
type Range = { start: Pos; end: Pos };
type SgMatch = { text: string; file: string; range: Range };

const FUNCTION_RULE = `id: lcov-functions
language: TypeScript
severity: info
rule:
  any:
    - kind: function_declaration
    - kind: function_expression
    - kind: generator_function_declaration
    - kind: arrow_function
    - kind: method_definition
`;

/** Best-effort display name from the match's first line; ranges do the work. */
function nameOf(text: string): string {
  const first = text.split('\n', 1)[0].trim();
  const m = first.match(
    /^(?:export\s+|async\s+|static\s+|private\s+|protected\s+|public\s+|readonly\s+|abstract\s+|override\s+)*(?:function\s*\*?\s*|get\s+|set\s+)?([A-Za-z_$][\w$]*)/,
  );
  if (m) return m[1];
  if (/^\(/.test(first) || /^[A-Za-z_$][\w$]*\s*=>/.test(first))
    return '<anonymous>';
  return '<anonymous>';
}

function parseLcov(text: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  let current: Map<number, number> | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      current = new Map();
      files.set(line.slice(3), current);
    } else if (line.startsWith('DA:') && current) {
      const [ln, hits] = line.slice(3).split(',');
      const n = Number(ln);
      current.set(n, (current.get(n) ?? 0) + Number(hits));
    } else if (line === 'end_of_record') {
      current = null;
    }
  }
  return files;
}

function scanFunctions(absPaths: string[]): SgMatch[] {
  const sg = resolve('node_modules/.bin/ast-grep');
  const result = spawnSync(
    sg,
    ['scan', '--rule', '/dev/stdin', '--json', '--', ...absPaths],
    { input: FUNCTION_RULE, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error) {
    console.error(
      `[lcov-to-istanbul] ast-grep failed: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `[lcov-to-istanbul] ast-grep exit ${result.status}: ${result.stderr}`,
    );
    process.exit(1);
  }
  // ast-grep reports 0-based lines; Istanbul expects 1-based. Columns are
  // 0-based in both.
  const matches = JSON.parse(result.stdout || '[]') as SgMatch[];
  for (const m of matches) {
    m.range.start.line += 1;
    m.range.end.line += 1;
  }
  return matches;
}

const lcovPath = resolve(process.argv[2] ?? 'coverage/lcov.info');
const outPath = resolve(process.argv[3] ?? 'coverage/coverage-final.json');

if (!existsSync(lcovPath)) {
  console.error(
    `[lcov-to-istanbul] no lcov input at ${lcovPath}; run bun test --coverage first`,
  );
  process.exit(1);
}

const records = parseLcov(readFileSync(lcovPath, 'utf8'));
const absByRel = new Map<string, string>();
for (const rel of records.keys()) {
  const abs = resolve(rel);
  if (existsSync(abs)) absByRel.set(rel, abs);
  else console.error(`[lcov-to-istanbul] skip ${rel}: not on disk`);
}

const matches = scanFunctions([...absByRel.values()]);
const fnsByFile = new Map<string, SgMatch[]>();
for (const m of matches) {
  const list = fnsByFile.get(m.file) ?? [];
  list.push(m);
  fnsByFile.set(m.file, list);
}

const out: Record<string, unknown> = {};
for (const [rel, lines] of records) {
  const abs = absByRel.get(rel);
  if (!abs) continue;
  const statementMap: Record<string, Range> = {};
  const s: Record<string, number> = {};
  let i = 0;
  for (const [ln, hits] of [...lines.entries()].sort((a, b) => a[0] - b[0])) {
    statementMap[String(i)] = {
      start: { line: ln, column: 0 },
      end: { line: ln, column: 100 },
    };
    s[String(i)] = hits;
    i += 1;
  }
  const fnMap: Record<string, { name: string; decl: Range; loc: Range }> = {};
  const f: Record<string, number> = {};
  (fnsByFile.get(abs) ?? []).forEach((m, idx) => {
    fnMap[String(idx)] = { name: nameOf(m.text), decl: m.range, loc: m.range };
    let hit = 0;
    for (const [ln, hits] of lines) {
      if (hits > 0 && ln >= m.range.start.line && ln <= m.range.end.line) {
        hit = 1;
        break;
      }
    }
    f[String(idx)] = hit;
  });
  out[abs] = { path: abs, statementMap, fnMap, branchMap: {}, s, f, b: {} };
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out));
const fns = Object.values(out).reduce(
  (n, e) => n + Object.keys((e as { fnMap: object }).fnMap).length,
  0,
);
console.error(
  `[lcov-to-istanbul] ${Object.keys(out).length} files, ${fns} functions -> ${outPath}`,
);
