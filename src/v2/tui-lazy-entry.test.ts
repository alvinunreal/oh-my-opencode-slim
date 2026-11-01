/**
 * Entry-graph contract: the published v2 TUI entry (`./tui`) must not
 * statically reach the render stack. It has to decide from the light gate
 * read (`../tui-gates`) and load `./tui-impl` only when the gate passes, so
 * `tui: false` never evaluates `src/tui.ts`, `@opentui/*`, or `solid-js`.
 *
 * The behavioral short-circuit (`tui: false` registers nothing) is covered
 * in `./tui.test.ts`; this file pins the import graph that makes the
 * deferral real. A source tripwire is used instead of a module mock because
 * Bun's module mocks are process-global and would poison every other test
 * file that imports the real composition.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import tuiPlugin from './tui';

const ENTRY_SOURCE = readFileSync(path.join(import.meta.dir, 'tui.ts'), 'utf8');

const HEAVY_MODULES = [
  '../tui',
  '../tui-kill',
  '../tui-preset',
  '@opentui/core',
  '@opentui/solid',
  'solid-js',
];

/** Module specifiers of the entry's top-level static imports. */
function staticImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/^import\s[\s\S]*?from\s+'([^']+)';/gm)) {
    specifiers.push(match[1] as string);
  }
  return specifiers;
}

describe('v2 TUI entry graph', () => {
  test('has no static import of the render stack', () => {
    const specifiers = staticImports(ENTRY_SOURCE);
    for (const heavy of HEAVY_MODULES) {
      expect(specifiers).not.toContain(heavy);
    }
  });

  test('reads the gates from the light module and defers the implementation', () => {
    const specifiers = staticImports(ENTRY_SOURCE);
    expect(specifiers).toContain('../tui-gates');
    // Both contracts (v1 factory, v2 setup) load the implementation lazily.
    expect(ENTRY_SOURCE.match(/await import\('\.\/tui-impl'\)/g)).toHaveLength(
      2,
    );
  });

  test('keeps the dual contract shape', () => {
    expect(tuiPlugin.id).toBe('oh-my-opencode-slim:tui');
    expect(typeof tuiPlugin.tui).toBe('function');
    expect(typeof tuiPlugin.setup).toBe('function');
  });
});
