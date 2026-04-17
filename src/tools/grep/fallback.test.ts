/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildGrepCommand, executeGrepFallback } from './fallback';
import { normalizeGrepInput } from './normalize';
import { createRepoContext, createTempTracker } from './test-helpers';

describe('tools/grep/fallback', () => {
  const temps = createTempTracker();

  function createNormalized(
    input: any,
    options: { directory?: string; worktree?: string } = {},
  ) {
    const repoDir = options.worktree ?? temps.createRepo();
    const directory = options.directory ?? repoDir;
    const worktree = options.worktree ?? repoDir;

    return {
      repoDir,
      normalized: normalizeGrepInput(
        input,
        createRepoContext(directory, worktree) as any,
      ),
    };
  }

  test.each([
    {
      name: 'builds lightweight GNU grep count commands without -o byte parsing',
      input: {
        pattern: 'createTool',
        path: 'src',
        output_mode: 'count',
        invert_match: true,
        sort_by: 'mtime',
      },
      assertResult(built: ReturnType<typeof buildGrepCommand>) {
        expect(built.command).toEqual(
          expect.arrayContaining(['grep', '-H', '-c', '-v']),
        );
        expect(built.command).not.toContain('-o');
        expect(built.command).not.toContain('-b');
        expect(built.warnings.join('\n')).toContain(
          'GNU grep fallback count mode reports matching lines per file',
        );
        expect(built.warnings.join('\n')).toContain(
          'GNU grep fallback ignores sort_by=mtime',
        );
      },
    },
    {
      name: 'builds GNU grep fallback warnings for path-aware globs',
      input: {
        pattern: 'createTool',
        path: 'src',
        globs: ['src/**/*.ts'],
        exclude_globs: ['dist/**'],
      },
      assertResult(built: ReturnType<typeof buildGrepCommand>) {
        expect(built.warnings.join('\n')).toContain(
          'GNU grep fallback ignores path-aware glob patterns',
        );
        expect(built.command).not.toContain('src/**/*.ts');
        expect(built.command).not.toContain('dist/**');
      },
    },
  ])('$name', ({ input, assertResult }) => {
    const { normalized } = createNormalized(input);
    assertResult(buildGrepCommand(normalized, 'grep'));
  });

  test('executeGrepFallback respects hidden=false by excluding dotfiles', async () => {
    const repoDir = temps.createRepo();
    writeFileSync(path.join(repoDir, '.hidden.txt'), 'createTool\n');

    const input = normalizeGrepInput(
      {
        pattern: 'createTool',
        path: repoDir,
        output_mode: 'files_with_matches',
        hidden: false,
        fixed_strings: true,
      },
      createRepoContext(repoDir) as any,
    );

    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    expect(
      result.files.some((file) => file.absolutePath.endsWith('.hidden.txt')),
    ).toBe(false);
  });

  test('executeGrepFallback parses content mode paths with colons correctly', async () => {
    const repoDir = temps.createRepo();
    const colonFile = path.join(repoDir, 'src', 'a:1:b.txt');
    writeFileSync(colonFile, 'needle\n');

    const input = normalizeGrepInput(
      {
        pattern: 'needle',
        path: path.join(repoDir, 'src'),
        output_mode: 'content',
        fixed_strings: true,
      },
      createRepoContext(repoDir) as any,
    );

    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    const matched = result.files.find(
      (file) => file.absolutePath === colonFile,
    );
    expect(matched).toBeDefined();
    expect(matched?.matches[0]?.lineText).toBe('needle');
  });

  test('executeGrepFallback parses files mode paths with embedded newlines correctly', async () => {
    const repoDir = temps.createRepo();
    const newlineFile = path.join(repoDir, 'src', 'odd\nname.txt');
    writeFileSync(newlineFile, 'needle\n');

    const input = normalizeGrepInput(
      {
        pattern: 'needle',
        path: path.join(repoDir, 'src'),
        output_mode: 'files_with_matches',
        fixed_strings: true,
      },
      createRepoContext(repoDir) as any,
    );

    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    expect(result.files.some((file) => file.absolutePath === newlineFile)).toBe(
      true,
    );
    expect(
      result.files.some((file) => file.absolutePath.endsWith('/odd')),
    ).toBe(false);
  });

  test('executeGrepFallback count mode with invert_match counts selected lines', async () => {
    const repoDir = temps.createRepo();
    const sample = path.join(repoDir, 'src', 'invert.txt');
    writeFileSync(sample, 'foo\nbar\nbaz\n');

    const input = normalizeGrepInput(
      {
        pattern: 'foo',
        path: sample,
        output_mode: 'count',
        fixed_strings: true,
        invert_match: true,
      },
      createRepoContext(repoDir) as any,
    );

    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    const matched = result.files.find((file) => file.absolutePath === sample);
    expect(matched?.matchCount).toBe(2);
    expect(result.totalMatches).toBe(2);
  });

  test('executeGrepFallback retries GNU grep validation after transient failures', async () => {
    const repoDir = temps.createRepo();
    const wrapperDir = temps.createDir('oh-my-opencode-grep-wrapper');
    const markerPath = path.join(wrapperDir, 'validated');
    const wrapperPath = path.join(wrapperDir, 'grep-wrapper.sh');

    writeFileSync(
      wrapperPath,
      [
        '#!/usr/bin/env bash',
        'set -eu',
        `marker=${JSON.stringify(markerPath)}`,
        'if [ "$#" -gt 0 ] && [ "$1" = "--version" ]; then',
        '  if [ ! -f "$marker" ]; then',
        '    : > "$marker"',
        "    printf 'resource temporarily unavailable\\n' >&2",
        '    exit 1',
        '  fi',
        "  printf 'grep (GNU grep) 3.11\\n'",
        '  exit 0',
        'fi',
        'exec grep "$@"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const input = normalizeGrepInput(
      {
        pattern: 'createTool',
        path: path.join(repoDir, 'src'),
        output_mode: 'files_with_matches',
        fixed_strings: true,
      },
      createRepoContext(repoDir) as any,
    );
    const cli = {
      path: wrapperPath,
      backend: 'grep' as const,
      source: 'system-gnu-grep' as const,
    };

    const first = await executeGrepFallback(
      input,
      new AbortController().signal,
      cli,
    );
    expect(first.error).toContain('resource temporarily unavailable');

    const second = await executeGrepFallback(
      input,
      new AbortController().signal,
      cli,
    );
    expect(second.error).toBeUndefined();
    expect(
      second.files.some(
        (file) => file.absolutePath === path.join(repoDir, 'src', 'example.ts'),
      ),
    ).toBe(true);
  });
});
